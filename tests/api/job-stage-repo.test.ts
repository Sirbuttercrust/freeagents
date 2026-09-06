// B14a scope item 3: POST /jobs/:jobId/stage verifies the commit against
// the staging repository BEFORE the observer or the attestation ever see
// it. Two refusals: a SHA the staging repo has never heard of (getCommit
// throws) is 409 naming the repo; a SHA the repo DOES have, but which does
// not descend from the baseCommit the platform pinned at confirm, is a
// second, distinct 409.
//
// tests/helpers/github-staging-fixtures.ts's default fixture is
// deliberately generous (any unseen sha is minted as a fresh child of
// base), which is right for tests that only care about a job reaching
// `submitted` -- but it makes both refusals in this file structurally
// unreachable. This file uses the fixture's strict mode instead: getCommit
// throws on anything nobody registered, the same shape the real adapter's
// 404 takes, so a route-level test can actually exercise the guard.
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import {
  MemoryAgentRepository,
  MemoryAccountRepository,
  MemoryJobRepository,
} from '../../src/adapters/storage/memory.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import { createStagingLifecycleGithubFake, type StagingLifecycleFixture } from '../helpers/github-staging-fixtures.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(211));
const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(212));

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

interface Started {
  readonly server: Server;
  readonly baseUrl: string;
  readonly jobRepo: MemoryJobRepository;
  readonly fixture: StagingLifecycleFixture;
}

async function startApp(): Promise<Started> {
  const operatorRepo = new MemoryAccountRepository();
  await operatorRepo.register({ did: buyer.did, githubLogin: `buyer-stage-${Math.random()}` });
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: agent.did,
    operatorDid: 'did:abt:op-stage-repo',
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: 'scout-stage-repo',
  });
  await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-stage-repo', status: 'verified' });
  const jobRepo = new MemoryJobRepository();
  // Strict: getCommit throws on anything not explicitly registered, so the
  // route's own existence check and ancestry walk are what this file pins.
  const fixture = createStagingLifecycleGithubFake({ strict: true });
  const app = createApp(
    operatorRepo,
    agentRepo,
    undefined,
    fixture.github,
    jobRepo,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
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
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, jobRepo, fixture };
}

// Walks a fresh job to `confirmed`, which is what creates the staging
// repository and pins baseCommit -- returns both the job id and the
// {owner, repo} the confirm route created, read back off the wire.
async function walkToConfirmed(baseUrl: string): Promise<{ jobId: string; owner: string; repo: string; baseCommit: string }> {
  const created = await postSigned(baseUrl, '/jobs', {
    buyerDid: buyer.did,
    agentDid: agent.did,
    repository: 'buyer/stage-target-repo',
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
  const confirmed = await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
  expect(confirmed.status).toBe(200);
  // The default source head sha this fixture answers for buyer/stage-target-repo.
  return { jobId, owner: 'freeagents-platform', repo: `staging-${jobId}`, baseCommit: 'buyer-stage-target-repo-head-sha' };
}

let active: Started | null = null;
afterEach(async () => {
  if (active !== null) {
    await new Promise<void>((resolve) => active!.server.close(() => resolve()));
    active = null;
  }
});

describe('POST /jobs/:jobId/stage: commit existence (B14a scope item 3)', () => {
  it('answers 409 naming the staging repository when the staged commit does not exist there', async () => {
    active = await startApp();
    const { jobId, owner, repo } = await walkToConfirmed(active.baseUrl);

    const stage = await postSigned(active.baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'never-registered-sha' }, agent);
    expect(stage.status).toBe(409);
    const body = (await stage.json()) as { error: string };
    expect(body.error).toContain('never-registered-sha');
    expect(body.error).toContain('does not exist in the staging repository');
    expect(body.error).toContain(`${owner}/${repo}`);

    // And the row did not budge: still confirmed, nothing staged.
    const read = await fetch(`${active.baseUrl}/jobs/${jobId}`);
    const readBack = (await read.json()) as Record<string, unknown>;
    expect(readBack.status).toBe('confirmed');
    expect(readBack.stagedCommit).toBeUndefined();
  });

  it('accepts a commit that was actually registered in the staging repository and descends from base', async () => {
    active = await startApp();
    const { jobId, owner, repo, baseCommit } = await walkToConfirmed(active.baseUrl);
    active.fixture.registerCommit(owner, repo, 'real-child-of-base', [baseCommit]);

    const stage = await postSigned(active.baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'real-child-of-base' }, agent);
    expect(stage.status).toBe(200);
    const body = (await stage.json()) as Record<string, unknown>;
    expect(body.status).toBe('staged');
    expect(body.stagedCommit).toBe('real-child-of-base');
  });
});

describe('POST /jobs/:jobId/stage: ancestry from baseCommit (B14a scope item 3)', () => {
  it('answers 409 naming both commits when the staged commit exists but does not descend from base', async () => {
    active = await startApp();
    const { jobId, owner, repo, baseCommit } = await walkToConfirmed(active.baseUrl);
    // Registered in the staging repo, so getCommit succeeds -- but its own
    // parent chain is empty, never reaching baseCommit.
    active.fixture.registerCommit(owner, repo, 'orphan-commit', []);

    const stage = await postSigned(active.baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'orphan-commit' }, agent);
    expect(stage.status).toBe(409);
    const body = (await stage.json()) as { error: string };
    expect(body.error).toContain('orphan-commit');
    expect(body.error).toContain('does not descend from base commit');
    expect(body.error).toContain(baseCommit);
    expect(body.error).toContain(`${owner}/${repo}`);

    const read = await fetch(`${active.baseUrl}/jobs/${jobId}`);
    const readBack = (await read.json()) as Record<string, unknown>;
    expect(readBack.status).toBe('confirmed');
    expect(readBack.stagedCommit).toBeUndefined();
  });

  it('walks a real multi-commit chain back to base and accepts it', async () => {
    active = await startApp();
    const { jobId, owner, repo, baseCommit } = await walkToConfirmed(active.baseUrl);
    active.fixture.registerCommit(owner, repo, 'chain-1', [baseCommit]);
    active.fixture.registerCommit(owner, repo, 'chain-2', ['chain-1']);
    active.fixture.registerCommit(owner, repo, 'chain-3', ['chain-2']);

    const stage = await postSigned(active.baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'chain-3' }, agent);
    expect(stage.status).toBe(200);
    expect(((await stage.json()) as Record<string, unknown>).status).toBe('staged');
  });

  it('the staged commit itself may equal baseCommit (staging with no work yet is legitimate)', async () => {
    active = await startApp();
    const { jobId, baseCommit } = await walkToConfirmed(active.baseUrl);

    const stage = await postSigned(active.baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: baseCommit }, agent);
    expect(stage.status).toBe(200);
  });
});
