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
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import type { GithubAdapter, PullRequestRef, PullRequestSummary } from '../../src/adapters/github/types.js';
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
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';

const ISSUER_DID = 'did:abt:test-platform-issuer-reachability';
const ISSUER_SEED = new Uint8Array(32).fill(3);
const MERGE_SHA = 'reachability-merge-sha';
const MERGED_AT = new Date('2026-08-27T10:00:00Z');
const AGENT_GITHUB_LOGIN = 'scout-reachability';

function fakeIdentity(): IdentityAdapter {
  return {
    ...createIdentityAdapter(),
    resolveDid: (did: string): Promise<DidDocument> =>
      Promise.resolve({ id: did, controller: null, verificationMethod: [`${did}#key-1`], alsoKnownAs: null }),
  };
}

// The one variable under test: whether GitHub reports the base repository as
// public. Everything else about the merge is identical between the two
// tests below, so a difference in the resulting tier can only come from this
// one fact. Layers getPullRequest (for the merge route's own observation)
// on top of the shared staging-lifecycle fake (for confirm/stage/pull-request).
function scriptedGithub(repositoryPublic: boolean): GithubAdapter {
  const { github: staging } = createStagingLifecycleGithubFake();
  return {
    ...staging,
    getPullRequest: (ref: PullRequestRef): Promise<PullRequestSummary> =>
      Promise.resolve({
        ref,
        state: 'merged',
        mergeCommitSha: MERGE_SHA,
        mergedAt: MERGED_AT,
        headSha: 'reachability-head-sha',
        additions: 20,
        deletions: 4,
        filesChanged: 2,
        repositoryPublic,
      }),
  };
}

async function startWith(
  github: GithubAdapter,
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
    github,
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
async function walkToMerge(
  baseUrl: string,
  agent: SigningIdentity,
  buyer: SigningIdentity,
): Promise<Record<string, unknown>> {
  const draft = await postSigned(baseUrl, '/jobs', {
    agentDid: agent.did,
    repository: 'buyer/target-repo',
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
  const pr = await postSigned(baseUrl, `/jobs/${jobId}/pull-request`, {}, agent);
  expect(pr.status).toBe(200);
  const prBody = (await pr.json()) as Record<string, unknown>;

  const merge = await postSigned(baseUrl, `/jobs/${jobId}/merge`, {}, buyer);
  expect(merge.status).toBe(200);
  return { ...((await merge.json()) as Record<string, unknown>), pullRequestUrl: prBody.pullRequestUrl };
}

describe('GET /agents/:agentDid, verified-hire reachability from a REAL merge (R-17 proof gate finding)', () => {
  it('a platform-brokered merge into a PUBLIC repository reaches verifiedHires, driven through the real merge route', async () => {
    const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(101));
    const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(102));
    const { server, baseUrl } = await startWith(scriptedGithub(true), agent.did, buyer.did);
    try {
      const mergeBody = await walkToMerge(baseUrl, agent, buyer);
      const credential = mergeBody.credential as Record<string, unknown>;

      const profile = await fetch(`${baseUrl}/agents/${agent.did}`);
      expect(profile.status).toBe(200);
      const body = (await profile.json()) as Record<string, unknown>;

      expect(body.verifiedHires).toEqual([
        {
          credentialId: credential.id,
          repository: 'buyer/target-repo',
          pullRequest: mergeBody.pullRequestUrl,
          mergedAt: MERGED_AT.toISOString(),
          mergeCommit: MERGE_SHA,
          buyerDid: buyer.did,
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
    const { server, baseUrl } = await startWith(scriptedGithub(false), agent.did, buyer.did);
    try {
      await walkToMerge(baseUrl, agent, buyer);

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
