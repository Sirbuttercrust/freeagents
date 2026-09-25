// R-17 (ENT-8, invariant 4), proof gate round 1 finding: verifiedHires must
// be reachable from a REAL merge, not only from a test fixture that calls
// credentialRepo.save({..., repositoryPublic: true}) by hand. Every other
// R-17 test builds its verified-hire fixture that way, which is exactly how
// the gap survived: production's only credential writer (POST
// /jobs/:jobId/merge) never passed repositoryPublic at all, so every real
// hire defaulted to false and landed in portfolio regardless of the actual
// repository.
//
// This file drives the whole hire loop over HTTP - draft, criteria, confirm,
// pull request, merge - then reads GET /agents/:agentDid, the same path a
// buyer takes. No hand-built CredentialEvidence, no direct credentialRepo
// call.
//
// STG2: the agent opens its own PR (registerAgentForkPullRequest on the
// shared fixture) and reports the URL; the merge route re-reads the same
// ref later with the merged facts substituted in via setPullRequest.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import type { DidDocument, IdentityAdapter } from '../../src/adapters/identity/types.js';
import {
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
  MemoryAccountRepository,
} from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { mintSessionToken, testSessionAdapter } from '../helpers/session-fixtures.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import {
  createStagingLifecycleGithubFake,
  registerAgentForkPullRequest,
  type StagingLifecycleFixture,
} from '../helpers/github-staging-fixtures.js';

const ISSUER_DID = 'did:abt:test-platform-issuer-reachability';
const ISSUER_SEED = new Uint8Array(32).fill(3);
const MERGE_SHA = 'reachability-merge-sha';
const MERGED_AT = new Date('2026-08-27T10:00:00Z');
const AGENT_GITHUB_LOGIN = 'scout-reachability';
const REPOSITORY = 'buyer/target-repo';

function fakeIdentity(): IdentityAdapter {
  return {
    ...createIdentityAdapter(),
    resolveDid: (did: string): Promise<DidDocument> =>
      Promise.resolve({ id: did, controller: null, verificationMethod: [`${did}#key-1`], alsoKnownAs: null }),
  };
}

async function startWith(
  fixture: StagingLifecycleFixture,
  agentDid: string,
  buyerDid: string,
): Promise<{ server: Server; baseUrl: string; authHeader: Record<string, string> }> {
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: agentDid,
    operatorDid: 'did:abt:op-reachability',
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: AGENT_GITHUB_LOGIN,
    negotiatesOnOwnersBehalf: true,
  });
  // B14a: confirm grants push to the agent's VERIFIED GitHub login; a
  // create() alone leaves proofStatus 'unverified' (memory.ts's own
  // stance), so this fixture verifies it the same way a real account
  // proof would (updateGithubBinding).
  await agentRepo.updateGithubBinding(agentDid, { handle: AGENT_GITHUB_LOGIN, status: 'verified' });
  const operatorRepo = new MemoryAccountRepository();
  await operatorRepo.register({ did: buyerDid, githubLogin: 'buyer-reachability' });
  const credentialRepo = new MemoryCredentialRepository();
  const credentials = createCredentialsAdapter({ did: ISSUER_DID, seed: ISSUER_SEED }, credentialRepo);
  const sessionAdapter = testSessionAdapter();
  const app = createApp(
    operatorRepo,
    agentRepo,
    fakeIdentity(),
    fixture.github,
    new MemoryJobRepository(),
    credentials,
    undefined,
    credentialRepo,
    undefined,
    undefined,
    undefined,
    sessionAdapter,
    undefined,
    alwaysSettledGate(),
    anyCommitStagingObserver(),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    authHeader: { authorization: `Bearer ${await mintSessionToken(sessionAdapter)}` },
  };
}

async function postSigned(baseUrl: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, 'POST', targetUri, { body: bodyText });
  return fetch(targetUri, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
    body: bodyText,
  });
}

// Walks one job all the way to a merged credential, over HTTP, exactly as a
// real buyer and agent would. Returns the merge response body.
//
// STG2: repositoryPublic is the one variable under test (whether GitHub
// reports the base repository as public); everything else about the merge
// is identical between the two tests below, so a difference in the
// resulting tier can only come from this one fact.
async function walkToMerge(
  baseUrl: string,
  fixture: StagingLifecycleFixture,
  agent: SigningIdentity,
  buyer: SigningIdentity,
  repositoryPublic: boolean,
): Promise<Record<string, unknown>> {
  const draft = await postSigned(baseUrl, '/jobs', {
    agentDid: agent.did,
    repository: REPOSITORY,
    brief: 'Fix the checkout timeout',
  }, buyer);
  expect(draft.status).toBe(201);
  const jobId = String(((await draft.json()) as Record<string, unknown>).id);

  expect(
    (
      await postSigned(
        baseUrl,
        `/jobs/${jobId}/criteria`,
        { criteria: [
          { text: 'The checkout no longer times out', proposedBy: 'agent' },
          { text: 'Load test passes', proposedBy: 'buyer' },
        ], priceUsd: '500.00', rail: 'abt' },
        agent,
      )
    ).status,
  ).toBe(200);
  expect((await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, buyer)).status).toBe(200);
  expect((await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agent)).status).toBe(200);
  expect((await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, buyer)).status).toBe(200);
  expect((await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agent)).status).toBe(200);
  expect((await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, buyer)).status).toBe(200);
  expect((await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, agent)).status).toBe(200);
  expect((await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyer)).status).toBe(200);
  expect((await postSigned(baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-sha-1' }, agent)).status).toBe(200);

  const { url, ref } = registerAgentForkPullRequest(fixture, {
    repository: REPOSITORY,
    jobId,
    stagedCommit: 'commit-sha-1',
    agentLogin: AGENT_GITHUB_LOGIN,
  });
  const pr = await postSigned(baseUrl, `/jobs/${jobId}/pull-request`, { pullRequestUrl: url }, agent);
  expect(pr.status).toBe(200);
  const prBody = (await pr.json()) as Record<string, unknown>;

  // The PR merges: same ref, same head sha, now reported merged with the
  // repositoryPublic fact under test.
  fixture.setPullRequest(ref, {
    state: 'merged',
    mergeCommitSha: MERGE_SHA,
    mergedAt: MERGED_AT,
    headSha: 'commit-sha-1',
    additions: 20,
    deletions: 4,
    filesChanged: 2,
    repositoryPublic,
    headRepoOwner: AGENT_GITHUB_LOGIN,
    headRepoFullName: `${AGENT_GITHUB_LOGIN}/target-repo`,
    headRepoIsFork: true,
    baseRepoFullName: REPOSITORY,
    authorLogin: AGENT_GITHUB_LOGIN,
    body: `Job: ${jobId}\n`,
  });

  const merge = await postSigned(baseUrl, `/jobs/${jobId}/merge`, {}, buyer);
  expect(merge.status).toBe(200);
  return { ...((await merge.json()) as Record<string, unknown>), pullRequestUrl: prBody.pullRequestUrl };
}

describe('GET /agents/:agentDid, verified-hire reachability from a REAL merge (R-17 proof gate finding)', () => {
  it('a platform-brokered merge into a PUBLIC repository reaches verifiedHires, driven through the real merge route', async () => {
    const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(101));
    const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(102));
    const fixture = createStagingLifecycleGithubFake();
    const { server, baseUrl } = await startWith(fixture, agent.did, buyer.did);
    try {
      const mergeBody = await walkToMerge(baseUrl, fixture, agent, buyer, true);
      const credential = mergeBody.credential as Record<string, unknown>;

      const profile = await fetch(`${baseUrl}/agents/${agent.did}`);
      expect(profile.status).toBe(200);
      const body = (await profile.json()) as Record<string, unknown>;

      expect(body.verifiedHires).toEqual([
        {
          credentialId: credential.id,
          repository: REPOSITORY,
          pullRequest: mergeBody.pullRequestUrl,
          mergedAt: MERGED_AT.toISOString(),
          mergeCommit: MERGE_SHA,
          buyerDid: buyer.did,
          additions: 20,
          deletions: 4,
          filesChanged: 2,
        },
      ]);
      expect(body.portfolio).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('a platform-brokered merge into a PRIVATE repository does not reach verifiedHires, driven through the real merge route', async () => {
    const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(103));
    const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(104));
    const fixture = createStagingLifecycleGithubFake();
    const { server, baseUrl } = await startWith(fixture, agent.did, buyer.did);
    try {
      await walkToMerge(baseUrl, fixture, agent, buyer, false);

      const profile = await fetch(`${baseUrl}/agents/${agent.did}`);
      expect(profile.status).toBe(200);
      const body = (await profile.json()) as Record<string, unknown>;

      expect(body.verifiedHires).toEqual([]);
      expect((body.portfolio as unknown[]).length).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
