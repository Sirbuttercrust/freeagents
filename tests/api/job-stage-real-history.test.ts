// B14a scope item 3 / STG2 card item 2 ("Stage... It now works on real
// SHAs. The staging observer... keeps working. Confirm it with a test on
// real-history fixtures"). Every other stage test drives baseCommit as a
// synthetic ROOT commit (parents: [], the default
// createStagingRepository fixture plants) -- unlike a real staging
// repository, which the agent seeds by cloning the buyer's ACTUAL repo,
// so baseCommit is typically hundreds of commits deep into real buyer
// history, not commit zero.
//
// This file registers baseCommit with a non-empty parent chain (real
// buyer ancestry the agent's clone brought along) and stages a commit
// that sits directly on top of it, then proves two things together:
// the route's ancestry walk (descendsFrom) still finds baseCommit
// without ever needing to fetch further back than it, and the real
// GitHub-backed staging observer (createGithubStagingObserver, not the
// anyCommitStagingObserver test convenience every other stage test
// uses) still reaches compareCommits with the correct base/head refs.
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createGithubStagingObserver } from '../../src/adapters/staging/github.js';
import type { CompareCommitsInput, CompareCommitsResult } from '../../src/adapters/github/types.js';
import {
  MemoryAgentRepository,
  MemoryAccountRepository,
  MemoryJobRepository,
} from '../../src/adapters/storage/memory.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { createStagingLifecycleGithubFake, type StagingLifecycleFixture } from '../helpers/github-staging-fixtures.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(231));
const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(232));

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
  server: Server;
  baseUrl: string;
  readonly fixture: StagingLifecycleFixture;
  compareCalls: number;
  seenInput: CompareCommitsInput | null;
}

async function startApp(): Promise<Started> {
  const operatorRepo = new MemoryAccountRepository();
  await operatorRepo.register({ did: buyer.did, githubLogin: `buyer-real-history-${Math.random()}` });
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: agent.did,
    operatorDid: 'did:abt:op-real-history',
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: 'scout-real-history',
  });
  await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-real-history', status: 'verified' });
  const jobRepo = new MemoryJobRepository();
  // Strict: getCommit throws on anything not explicitly registered, so the
  // route's own ancestry walk only ever succeeds by actually reaching
  // baseCommit -- exactly like job-stage-repo.test.ts.
  const fixture = createStagingLifecycleGithubFake({ strict: true });

  const started: Started = { server: null as unknown as Server, baseUrl: '', fixture, compareCalls: 0, seenInput: null };
  const observableGithub = {
    ...fixture.github,
    compareCommits: (input: CompareCommitsInput): Promise<CompareCommitsResult> => {
      started.compareCalls += 1;
      started.seenInput = input;
      return Promise.resolve({
        files: [{ path: 'src/fix.ts', status: 'modified', additions: 3, deletions: 1, patch: '@@ -1 +1,3 @@\n+x' }],
        commits: [{ sha: 'staged-on-real-history', authorLogin: 'scout-real-history', verified: true }],
      });
    },
  };

  const app = createApp(
    operatorRepo,
    agentRepo,
    undefined,
    observableGithub,
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
    createGithubStagingObserver(observableGithub),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  started.server = server;
  started.baseUrl = `http://127.0.0.1:${address.port}`;
  return started;
}

async function walkToConfirmed(baseUrl: string): Promise<{ jobId: string; owner: string; repo: string; baseCommit: string }> {
  const created = await postSigned(baseUrl, '/jobs', {
    buyerDid: buyer.did,
    agentDid: agent.did,
    repository: 'buyer/real-history-repo',
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
  return { jobId, owner: 'freeagents-platform', repo: `staging-${jobId}`, baseCommit: 'buyer-real-history-repo-head-sha' };
}

let active: Started | null = null;
afterEach(async () => {
  if (active !== null) {
    await new Promise<void>((resolve) => active!.server.close(() => resolve()));
    active = null;
  }
});

describe('POST /jobs/:jobId/stage: real-history fixtures (STG2 card item 2)', () => {
  it('walks the ancestry to a baseCommit that itself has real buyer ancestry, and the real observer still reports the diff', async () => {
    active = await startApp();
    const { jobId, owner, repo, baseCommit } = await walkToConfirmed(active.baseUrl);

    // Overwrites the default fixture root: baseCommit now carries a real
    // parent chain (the buyer commits that came before it), the same
    // shape a genuine clone-and-push seed would produce. descendsFrom
    // must never need to fetch these -- it stops the instant it reaches
    // baseCommit itself.
    active.fixture.registerCommit(owner, repo, baseCommit, ['buyer-ancestor-2']);
    active.fixture.registerCommit(owner, repo, 'buyer-ancestor-2', ['buyer-ancestor-1']);
    // buyer-ancestor-1 is deliberately left unregistered: in strict mode,
    // fetching it would throw. Reaching it would prove the walk over-fetched
    // past the target, which is the failure this test exists to catch.

    // The staged commit sits directly on top of base, exactly the "agent
    // pushes its work on top of the seeded history" shape the card
    // describes.
    active.fixture.registerCommit(owner, repo, 'staged-on-real-history', [baseCommit]);

    const stage = await postSigned(active.baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'staged-on-real-history' }, agent);
    expect(stage.status).toBe(200);
    const body = (await stage.json()) as Record<string, unknown>;
    expect(body.status).toBe('staged');
    expect(body.stagedCommit).toBe('staged-on-real-history');

    // The real GitHub-backed observer reached compareCommits with the
    // staging repo's own base/head, unaffected by base's real ancestry.
    expect(active.compareCalls).toBe(1);
    expect(active.seenInput).toEqual({ owner, repo, base: baseCommit, head: 'staged-on-real-history' });
  });
});
