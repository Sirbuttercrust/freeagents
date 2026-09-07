// B14b, review round 1 D1 (inert-declared-control, src/api/app.ts:680): the
// production default for createApp's stagingObserver argument must be the
// real GitHub-backed observer, not the fail-closed unwired stub -- and
// that must be provable by OMITTING the argument, not by reading the
// default expression in source. Every other stage test in this suite
// injects an observer explicitly (job-attestation.test.ts's startApp
// always supplies one), which never exercises the omitted-argument path
// at all: reverting the production default back to
// createUnwiredStagingObserver() left the whole 146-file suite green
// before this file existed (review round 1, t_20bf8e3f).
//
// This file constructs createApp with EVERY argument through
// stagingObserver supplied positionally and stagingObserver itself
// omitted, then proves the default reaches the real GitHub-backed
// observer by making compareCommits observable: a fake GithubAdapter
// whose compareCommits resolves records that it was called. The unwired
// default never calls compareCommits at all (it rejects synchronously
// with NotImplementedError before touching the adapter), so seeing the
// call happen is the same shape of proof job-pull-request.test.ts already
// uses for "the adapter surface offers reads plus the staging lifecycle".
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import {
  MemoryAgentRepository,
  MemoryAccountRepository,
  MemoryJobRepository,
  MemoryCredentialRepository,
} from '../../src/adapters/storage/memory.js';
import type { CompareCommitsInput, CompareCommitsResult } from '../../src/adapters/github/types.js';

const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(221));
const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(222));

const proposal = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
];

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

async function walkToConfirmed(baseUrl: string): Promise<string> {
  const created = await postSigned(baseUrl, '/jobs', {
    buyerDid: buyer.did,
    agentDid: agent.did,
    repository: 'buyer/target-repo',
    brief: 'Fix the login bug',
  }, buyer);
  const jobId = String(((await created.json()) as Record<string, unknown>).id);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria`, { criteria: proposal, priceUsd: '500.00', rail: 'abt' }, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
  return jobId;
}

let server: Server | null = null;
afterEach(async () => {
  if (server !== null) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

describe('createApp defaults stagingObserver to the real GitHub-backed observer (review round 1, D1)', () => {
  it('stage reaches compareCommits through the omitted-argument default, not the unwired refusal', async () => {
    const operatorRepo = new MemoryAccountRepository();
    await operatorRepo.register({ did: buyer.did, githubLogin: `buyer-default-obs-${Math.random()}` });
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: 'did:abt:op-default-obs',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: 'scout-default-obs',
    });
    await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-default-obs', status: 'verified' });
    const jobRepo = new MemoryJobRepository();
    const credentialRepo = new MemoryCredentialRepository();
    const credentials = createCredentialsAdapter(undefined, credentialRepo);

    let compareCalls = 0;
    let seenInput: CompareCommitsInput | null = null;
    const { github } = createStagingLifecycleGithubFake();
    const observableGithub = {
      ...github,
      compareCommits: (input: CompareCommitsInput): Promise<CompareCommitsResult> => {
        compareCalls += 1;
        seenInput = input;
        return Promise.resolve({ files: [], commits: [] });
      },
    };

    // Every positional argument through stagingObserver (index 14, the
    // 15th parameter) is supplied; stagingObserver itself is OMITTED so
    // this call exercises createApp's own default expression rather than
    // a test double standing in for it.
    const app = createApp(
      operatorRepo,
      agentRepo,
      undefined,
      observableGithub,
      jobRepo,
      credentials,
      undefined,
      credentialRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      alwaysSettledGate(),
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const jobId = await walkToConfirmed(baseUrl);
    const stage = await postSigned(baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-default-obs' }, agent);

    // The unwired default rejects synchronously with NotImplementedError
    // before ever calling compareCommits, which would surface here as a
    // 503 with compareCalls still 0. Reaching compareCommits at all is
    // proof the omitted-argument path resolved to the real observer.
    expect(compareCalls).toBe(1);
    expect(seenInput).toEqual({
      owner: 'freeagents-platform',
      repo: `staging-${jobId}`,
      base: 'buyer-target-repo-head-sha',
      head: 'commit-default-obs',
    });
    expect(stage.status).toBe(200);
  });
});
