// P4, review round 1 (D2/D3, t_cb5d35cd): the two clocks (expireUnstaged,
// lapseAtStaged) were only applied on GET, so a job that lapsed while
// nobody was looking could still be ACTED ON by a mutation route -- the
// exact "unpaid work reaches a buyer's repository" failure this card
// exists to prevent, and an outcome (200 vs 409) that depended purely on
// whether some unrelated caller had issued a GET first. Every assertion
// here fails without applyLapses (or an equivalent live settlement check)
// running in front of every mutation route's own logic, not only GET's.
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { MemorySettlementGate } from '../../src/adapters/payment/gate.js';
import {
  MemoryAgentRepository,
  MemoryJobRepository,
  MemoryAccountRepository,
} from '../../src/adapters/storage/memory.js';
import { createJob, requestRedo, stageWork, type Job } from '../../src/domain/job.js';
import type { GithubAdapter, ForkAndOpenPullRequestInput, PullRequestRef } from '../../src/adapters/github/types.js';
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

function fakeGithub(recorded: ForkAndOpenPullRequestInput[], mergeCalls: PullRequestRef[] = []): GithubAdapter {
  return {
    getPullRequest: (ref) => {
      mergeCalls.push(ref);
      return Promise.reject(new NotImplementedError('github', 'getPullRequest'));
    },
    getMergeCommitSignature: () => Promise.reject(new NotImplementedError('github', 'getMergeCommitSignature')),
    getPublicGist: () => Promise.reject(new NotImplementedError('github', 'getPublicGist')),
    forkAndOpenPullRequest: (input) => {
      recorded.push(input);
      const ref: PullRequestRef = { owner: 'freeagents-platform', repo: 'target-repo', number: 1 };
      return Promise.resolve(ref);
    },
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

const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(111));
const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(112));

function confirmedJob(id: string, confirmedAt: Date): Job {
  return {
    ...createJob(
      { id, buyerDid: buyer.did, agentDid: agent.did, repository: 'buyer/target-repo', brief: 'Fix the login bug' },
      new Date(confirmedAt.getTime() - 86_400_000),
    ),
    status: 'confirmed',
    confirmedSpecHash: 'sha256:spec',
    confirmedAt,
    priceUsd: '500.00',
    rail: 'abt',
    priceAcceptedByBuyer: true,
    priceAcceptedByAgent: true,
    criteria: [{ text: 'Login works', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
  };
}

describe('lapse enforcement binds to mutation routes, not only GET (P4, anchor)', () => {
  let server: Server;
  let baseUrl: string;
  let jobRepo: MemoryJobRepository;
  let agentRepo: MemoryAgentRepository;
  let accounts: MemoryAccountRepository;
  let gate: MemorySettlementGate;
  let forkCalls: ForkAndOpenPullRequestInput[];

  beforeAll(async () => {
    accounts = new MemoryAccountRepository();
    await accounts.register({ did: buyer.did, githubLogin: 'buyer-lapse' });
    agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: 'did:abt:op-lapse',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    jobRepo = new MemoryJobRepository();
    gate = new MemorySettlementGate();
    forkCalls = [];
    const app = createApp(
      accounts,
      agentRepo,
      undefined,
      fakeGithub(forkCalls),
      jobRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      gate,
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => server.close());

  it('refuses to stage a confirmed job that expired 40 days ago, with no prior GET', async () => {
    const expiredConfirmedAt = new Date(Date.now() - 40 * 86_400_000);
    const job = confirmedJob('j-lapse-stage', expiredConfirmedAt);
    await jobRepo.create(job);

    const stage = await postSigned(baseUrl, `/jobs/${job.id}/stage`, { stagedCommit: 'commit-sha-1' }, agent);
    expect(stage.status).toBe(409);

    const stored = await jobRepo.findById(job.id);
    expect(stored?.status).toBe('expired_unstaged');
  });

  it('refuses pull-request on a staged job 8 days unpaid, firing github zero times, with no prior GET', async () => {
    const stagedAt = new Date(Date.now() - 8 * 86_400_000);
    const job = stageWork(confirmedJob('j-lapse-pr', new Date(stagedAt.getTime() - 86_400_000)), 'commit-sha-2', stagedAt);
    await jobRepo.create(job);

    const before = forkCalls.length;
    const pr = await postSigned(baseUrl, `/jobs/${job.id}/pull-request`, {}, agent);
    // The route's own money gate (402, unsettled) or the transition gate
    // (409, already closed_unpaid) may answer first depending on check
    // order -- either is a legitimate refusal. What must hold regardless:
    // no fork fires, and the stored row honestly reports the lapse.
    expect([402, 409]).toContain(pr.status);
    expect(forkCalls.length).toBe(before);

    const stored = await jobRepo.findById(job.id);
    expect(stored?.status).toBe('closed_unpaid');
  });

  it('the outcome of staging an expired job does not depend on whether a GET happened first', async () => {
    const expiredConfirmedAt = new Date(Date.now() - 40 * 86_400_000);

    // No GET first.
    const noGetJob = confirmedJob('j-lapse-order-no-get', expiredConfirmedAt);
    await jobRepo.create(noGetJob);
    const stageNoGet = await postSigned(baseUrl, `/jobs/${noGetJob.id}/stage`, { stagedCommit: 'commit-sha-3' }, agent);

    // A GET first, by an unrelated caller.
    const getFirstJob = confirmedJob('j-lapse-order-get-first', expiredConfirmedAt);
    await jobRepo.create(getFirstJob);
    await fetch(`${baseUrl}/jobs/${getFirstJob.id}`);
    const stageGetFirst = await postSigned(baseUrl, `/jobs/${getFirstJob.id}/stage`, { stagedCommit: 'commit-sha-4' }, agent);

    expect(stageNoGet.status).toBe(stageGetFirst.status);
    expect(stageNoGet.status).toBe(409);
  });

  it('a staged job whose balance HAS settled can still open a pull request past the 7-day mark', async () => {
    const stagedAt = new Date(Date.now() - 8 * 86_400_000);
    const job = stageWork(confirmedJob('j-lapse-paid', new Date(stagedAt.getTime() - 86_400_000)), 'commit-sha-5', stagedAt);
    await jobRepo.create(job);
    gate.markBalanceSettled(job.id);

    const pr = await postSigned(baseUrl, `/jobs/${job.id}/pull-request`, {}, agent);
    expect(pr.status).toBe(200);
    const body = (await pr.json()) as Record<string, unknown>;
    expect(body.status).toBe('submitted');
  });

  // P6 review round 2 (D3, t_604e3f2a): the round-1 fix widened
  // lapseAtStaged to also run at redo_requested, but applyLiveLapses only
  // ever asked the settlement gate `if (job.status === 'staged')`. A paid
  // buyer whose redo the operator has not yet answered was fed a
  // fabricated "not settled" answer on every read, so a job that had
  // already collected the remainder could still be terminated
  // closed_unpaid -- rewriting a fact that already happened. Both
  // branches must read the same live gate the staged branch already does.
  it('a redo_requested job whose balance HAS settled is NOT lapsed past the extended deadline', async () => {
    const stagedAt = new Date(Date.now() - 20 * 86_400_000);
    const requestedAt = new Date(Date.now() - 15 * 86_400_000);
    const job = requestRedo(
      stageWork(confirmedJob('j-lapse-redo-paid', new Date(stagedAt.getTime() - 86_400_000)), 'commit-sha-6', stagedAt),
      0,
      requestedAt,
    );
    await jobRepo.create(job);
    gate.markBalanceSettled(job.id);

    const read = await fetch(`${baseUrl}/jobs/${job.id}`);
    expect(read.status).toBe(200);
    const body = (await read.json()) as Record<string, unknown>;
    expect(body.status).toBe('redo_requested');

    const stored = await jobRepo.findById(job.id);
    expect(stored?.status).toBe('redo_requested');
  });
});

// D7 (review round 2, t_cb5d35cd): the merge route's nonObservationStatuses
// guard predated P4 and never learned the five statuses this card adds. A
// caller mistake (asking to merge a job that was never submitted) turned
// into a 500 platform fault instead of an honest 409, because the route
// fell through to the submitted-only pullRequestUrl parse for statuses
// that never carry one. Each of these must answer 409 before github is
// ever asked, the same way draft/proposed/confirmed/withdrawn/declined
// already do.
describe('merge refuses every P4 non-observable status with 409, not 500 (D7, t_cb5d35cd)', () => {
  let server: Server;
  let baseUrl: string;
  let jobRepo: MemoryJobRepository;
  let mergeCalls: PullRequestRef[];

  beforeAll(async () => {
    const accounts = new MemoryAccountRepository();
    await accounts.register({ did: buyer.did, githubLogin: 'buyer-merge-guard' });
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: 'did:abt:op-merge-guard',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    jobRepo = new MemoryJobRepository();
    mergeCalls = [];
    const app = createApp(
      accounts,
      agentRepo,
      undefined,
      fakeGithub([], mergeCalls),
      jobRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new MemorySettlementGate(),
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => server.close());

  const cases: readonly { readonly id: string; readonly status: Job['status'] }[] = [
    { id: 'j-merge-guard-staged', status: 'staged' },
    { id: 'j-merge-guard-expired-unstaged', status: 'expired_unstaged' },
    { id: 'j-merge-guard-staged-declined', status: 'staged_declined' },
    { id: 'j-merge-guard-closed-unpaid', status: 'closed_unpaid' },
    { id: 'j-merge-guard-deemed-completed', status: 'deemed_completed' },
  ];

  for (const { id, status } of cases) {
    it(`answers 409 for a job in status "${status}", asking github zero times`, async () => {
      const job: Job = { ...confirmedJob(id, new Date()), status, confirmedAt: null };
      await jobRepo.create(job);

      const before = mergeCalls.length;
      const merge = await postSigned(baseUrl, `/jobs/${job.id}/merge`, {}, buyer);
      expect(merge.status).toBe(409);
      expect(mergeCalls.length).toBe(before);

      const stored = await jobRepo.findById(job.id);
      expect(stored?.status).toBe(status);
    });
  }
});
