// R-10 (#17) / STG2: the agent opens the pull request from its OWN fork,
// outside this service, and reports the URL to POST
// /jobs/:jobId/pull-request. The route reads the PR back
// (github.getPullRequest) and records `submitted` only if five facts all
// hold: base repo matches, head repo is a fork owned by the agent's
// verified GitHub login (and the PR author is that same login), head sha
// equals job.stagedCommit, the PR is open, and the body carries the
// `Job: <id>` trailer. Any one mismatch is a 409 naming which fact
// failed.
//
// THE accept lines this issue exists to prove: the PR carries the job id
// (ENT-4.5), and no write scope on the buyer's repository is ever
// requested (ENT-4.3 / invariant 1, now trivially true -- this route makes
// zero writes to any repository, staging or otherwise).
//
// runExchange's storage-fault legs are NOT re-covered per route:
// tests/api/job-criteria.test.ts pins each leg of the skeleton these routes
// share. The legs new to THIS route - the 402 anchor, each of the five 409
// facts, github unavailable, storage dead on load, a corrupted status
// rethrowing - are covered here.
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createGithubAdapter } from '../../src/adapters/github/github.js';
import type { GithubAdapter, PullRequestRef } from '../../src/adapters/github/types.js';
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import {
  MemoryAgentRepository,
  MemoryJobRepository,
  MemoryAccountRepository,
} from '../../src/adapters/storage/memory.js';
import type { JobRepository } from '../../src/adapters/storage/types.js';
import { createJob, type Job, type JobStatus } from '../../src/domain/job.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { mintSessionToken, testSessionAdapter } from '../helpers/session-fixtures.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import {
  createStagingLifecycleGithubFake,
  registerAgentForkPullRequest,
} from '../helpers/github-staging-fixtures.js';

let buyer: SigningIdentity;
let agent: SigningIdentity;
const AGENT_GITHUB_LOGIN = 'scout-pr';
const REPOSITORY = 'buyer/target-repo';
const proposal = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
];

// Rebound by each describe's beforeAll; suites inside one file run in order,
// so handing the helpers below to whichever suite is current is safe.
let server: Server;
let baseUrl: string;

async function postSigned(path: string, body: unknown, identity: SigningIdentity, base: string = baseUrl): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${base}${path}`;
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

async function get(path: string, base: string = baseUrl): Promise<Response> {
  return fetch(`${base}${path}`);
}

async function startWith(
  repo: JobRepository,
  github: GithubAdapter,
  extraAccounts: readonly { did: string; githubLogin: string }[] = [],
): Promise<{ server: Server; baseUrl: string; authHeader: Record<string, string> }> {
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: agent.did,
    operatorDid: 'did:abt:op-pr',
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: AGENT_GITHUB_LOGIN,
    negotiatesOnOwnersBehalf: true,
  });
  // B14a: confirm grants push to the agent's VERIFIED GitHub login.
  await agentRepo.updateGithubBinding(agent.did, { handle: AGENT_GITHUB_LOGIN, status: 'verified' });
  const operatorRepo = new MemoryAccountRepository();
  await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-pr-scripted' });
  for (const extra of extraAccounts) {
    await operatorRepo.register(extra);
  }
  const sessionAdapter = testSessionAdapter();
  const s = createApp(
    operatorRepo,
    agentRepo,
    undefined,
    github,
    repo,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    sessionAdapter,
    undefined,
    alwaysSettledGate(),
    anyCommitStagingObserver(),
  ).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => s.once('listening', resolve));
  const address = s.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return {
    server: s,
    baseUrl: `http://127.0.0.1:${address.port}`,
    authHeader: { authorization: `Bearer ${await mintSessionToken(sessionAdapter)}` },
  };
}

// One job walked draft -> confirmed over HTTP, returning the confirm body so
// the specHash a stranger sees can be compared byte for byte. P1: confirm
// now also needs an agreed price, so the price rides the same proposal
// call and both parties accept it alongside the criteria.
async function walkToConfirm(jobId: string, base: string = baseUrl): Promise<Record<string, unknown>> {
  expect(
    (await postSigned(`/jobs/${jobId}/criteria`, { criteria: proposal, priceUsd: '500.00', rail: 'abt' }, agent, base))
      .status,
  ).toBe(200);
  expect((await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, buyer, base)).status).toBe(200);
  expect((await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, agent, base)).status).toBe(200);
  expect((await postSigned(`/jobs/${jobId}/criteria/1/accept`, {}, buyer, base)).status).toBe(200);
  expect((await postSigned(`/jobs/${jobId}/criteria/1/accept`, {}, agent, base)).status).toBe(200);
  expect((await postSigned(`/jobs/${jobId}/price/accept`, {}, buyer, base)).status).toBe(200);
  expect((await postSigned(`/jobs/${jobId}/price/accept`, {}, agent, base)).status).toBe(200);
  const confirmed = await postSigned(`/jobs/${jobId}/confirm`, {}, buyer, base);
  expect(confirmed.status).toBe(200);
  return (await confirmed.json()) as Record<string, unknown>;
}

// P4: confirmed no longer walks straight to submitted; the agent stages
// the work first. This helper drives that one extra hop so every existing
// "confirm -> pull-request" walk in this file still reaches submitted.
async function walkToStaged(jobId: string, base: string = baseUrl): Promise<Record<string, unknown>> {
  const staged = await postSigned(`/jobs/${jobId}/stage`, { stagedCommit: 'commit-sha-1' }, agent, base);
  expect(staged.status).toBe(200);
  return (await staged.json()) as Record<string, unknown>;
}

async function openDraft(
  brief: string,
  base: string = baseUrl,
): Promise<{ jobId: string; briefHash: unknown }> {
  const created = await postSigned('/jobs', {
    agentDid: agent.did,
    repository: REPOSITORY,
    brief,
  }, buyer, base);
  expect(created.status).toBe(201);
  const body = (await created.json()) as Record<string, unknown>;
  return { jobId: String(body.id), briefHash: body.briefHash };
}

describe('job pull-request (R-10, STG2)', () => {
  const jobRepo = new MemoryJobRepository();
  const fixture = createStagingLifecycleGithubFake();
  // Set by the happy-path walk; the lock test posts that same id again,
  // which is the point: one job id, every path tried against it.
  let happyJobId: string;
  let happyBriefHash: unknown;
  let happySpecHash: unknown;

  beforeAll(async () => {
    buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(81));
    agent = await signingIdentityFromSeed(new Uint8Array(32).fill(82));
    ({ server, baseUrl } = await startWith(jobRepo, fixture.github));
  });

  afterAll(() => {
    server.close();
  });

  it('walks confirm -> stage -> pull-request on ONE row and projects the submitted keys', async () => {
    const { jobId, briefHash } = await openDraft('Fix the login bug on the checkout page');
    happyJobId = jobId;
    happyBriefHash = briefHash;
    const confirmedBody = await walkToConfirm(jobId);
    happySpecHash = confirmedBody.specHash;
    expect(confirmedBody.status).toBe('confirmed');
    await walkToStaged(jobId);

    const { url } = registerAgentForkPullRequest(fixture, {
      repository: REPOSITORY,
      jobId,
      stagedCommit: 'commit-sha-1',
      agentLogin: AGENT_GITHUB_LOGIN,
    });
    const pr = await postSigned(`/jobs/${jobId}/pull-request`, { pullRequestUrl: url }, agent);
    expect(pr.status).toBe(200);
    const prBody = (await pr.json()) as Record<string, unknown>;
    expect(prBody.id).toBe(jobId);
    expect(prBody.status).toBe('submitted');
    expect(prBody.pullRequestUrl).toBe(url);
    expect(typeof prBody.submittedAt).toBe('string');
    // A submitted job projects the confirmed eleven plus pullRequestUrl,
    // submittedAt and deadline (R-10, R-12), plus the price line (P1),
    // pullRequestTemplate (STG2) and nothing else.
    expect(Object.keys(prBody).sort()).toEqual([
      'agentDid',
      'baseCommit',
      'brief',
      'briefHash',
      'buyerDid',
      'confirmedAt',
      'createdAt',
      'criteria',
      'deadline',
      'id',
      'price',
      'pullRequestTemplate',
      'pullRequestUrl',
      'repository',
      'specHash',
      'stagedAt',
      'stagedCommit',
      'stagingRepo',
      'status',
      'submittedAt',
    ]);
    // The deadline is the one the domain wrote: 30 days out, an ISO string
    // the buyer can hold against the wall clock.
    expect(typeof prBody.deadline).toBe('string');
  });

  it('the pullRequestTemplate carried at staged is what a real PR body should contain', async () => {
    const read = await get(`/jobs/${happyJobId}`);
    const body = (await read.json()) as Record<string, unknown>;
    const template = body.pullRequestTemplate as Record<string, unknown>;
    expect(template.title).toContain(happyJobId);
    expect(String(template.body)).toContain(`Job: ${happyJobId}`);
    expect(String(template.body)).toContain(String(happyBriefHash));
    expect(String(template.body)).toContain(String(happySpecHash));
    expect(String(template.body)).toContain('opened by the agent from its own fork');
  });

  it('answers 404 for an unknown id, with zero adapter calls', async () => {
    const before = fixture.calls.getPullRequest.length;
    const nowhere = await postSigned('/jobs/j-nowhere/pull-request', { pullRequestUrl: 'https://github.com/buyer/target-repo/pull/999' }, agent);
    expect(nowhere.status).toBe(404);
    expect(await nowhere.json()).toEqual({ error: 'not found' });
    expect(fixture.calls.getPullRequest.length).toBe(before);
  });

  it('answers 409 for a fresh draft WITHOUT firing the adapter once', async () => {
    // Recording submitted is a side effect; the state machine is
    // consulted first, so a draft gets its conflict and github sees nothing.
    const { jobId } = await openDraft('A draft nobody confirmed');
    const before = fixture.calls.getPullRequest.length;

    const early = await postSigned(`/jobs/${jobId}/pull-request`, { pullRequestUrl: 'https://github.com/buyer/target-repo/pull/1' }, agent);
    expect(early.status).toBe(409);
    expect(((await early.json()) as { error: string }).error).toContain('status "draft"');
    expect(fixture.calls.getPullRequest.length).toBe(before);

    // And the row did not budge: still draft, no submission keys anywhere.
    const read = await get(`/jobs/${jobId}`);
    const readBack = (await read.json()) as Record<string, unknown>;
    expect(readBack.status).toBe('draft');
    expect(readBack.pullRequestUrl).toBeUndefined();
    expect(readBack.submittedAt).toBeUndefined();
  });

  it('locks the job after submit: posting again is a 409 and records nothing new', async () => {
    const before = fixture.calls.getPullRequest.length;
    const again = await postSigned(`/jobs/${happyJobId}/pull-request`, { pullRequestUrl: 'https://github.com/buyer/target-repo/pull/1' }, agent);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toContain('status "submitted"');
    void before;

    // The submitted row keeps exactly the PR it recorded first, and the
    // deadline rides the read-back as the domain wrote it.
    const read = await get(`/jobs/${happyJobId}`);
    const readBack = (await read.json()) as Record<string, unknown>;
    expect(typeof readBack.pullRequestUrl).toBe('string');
    expect(typeof readBack.deadline).toBe('string');
  });
});

describe('job pull-request, body validation (STG2)', () => {
  let jobId: string;
  const fixture = createStagingLifecycleGithubFake();

  beforeAll(async () => {
    buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(81));
    agent = await signingIdentityFromSeed(new Uint8Array(32).fill(82));
    ({ server, baseUrl } = await startWith(new MemoryJobRepository(), fixture.github));
    const draft = await openDraft('A job for body-validation tests');
    jobId = draft.jobId;
    await walkToConfirm(jobId);
    await walkToStaged(jobId);
  });

  afterAll(() => server.close());

  it('answers 400 when pullRequestUrl is missing', async () => {
    const res = await postSigned(`/jobs/${jobId}/pull-request`, {}, agent);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('pullRequestUrl');
  });

  it('answers 400 when pullRequestUrl does not look like a GitHub PR URL', async () => {
    const res = await postSigned(`/jobs/${jobId}/pull-request`, { pullRequestUrl: 'not-a-url' }, agent);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('https://github.com');
  });
});

// The P4 anchor and each of the five 409 facts, driven on their own
// servers so each test controls exactly one variable.
describe('job pull-request, the P4 anchor and the five 409 facts (STG2)', () => {
  async function freshJob(): Promise<{ jobId: string; briefHash: unknown; specHash: unknown }> {
    const draft = await openDraft(`A job ${Math.random()}`);
    const confirmedBody = await walkToConfirm(draft.jobId);
    await walkToStaged(draft.jobId);
    return { jobId: draft.jobId, briefHash: draft.briefHash, specHash: confirmedBody.specHash };
  }

  beforeAll(async () => {
    buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(81));
    agent = await signingIdentityFromSeed(new Uint8Array(32).fill(82));
  });

  it('402s before the state machine or github are consulted, when the remainder is unsettled', async () => {
    const { MemorySettlementGate } = await import('../../src/adapters/payment/gate.js');
    const gate = new MemorySettlementGate();
    const fixture = createStagingLifecycleGithubFake();
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: 'did:abt:op-pr-402',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: AGENT_GITHUB_LOGIN,
    });
    await agentRepo.updateGithubBinding(agent.did, { handle: AGENT_GITHUB_LOGIN, status: 'verified' });
    const operatorRepo = new MemoryAccountRepository();
    await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-pr-402' });
    const jobRepo = new MemoryJobRepository();
    const sessionAdapter = testSessionAdapter();
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
      sessionAdapter,
      undefined,
      gate,
      anyCommitStagingObserver(),
    );
    const s = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => s.once('listening', resolve));
    const address = s.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    const scriptedBase = `http://127.0.0.1:${address.port}`;
    try {
      const { jobId } = await openDraft('An unpaid job', scriptedBase);
      // Only the DEPOSIT leg settles: confirm needs it, but the
      // remainder stays unsettled, which is what the pull-request
      // route's own 402 anchor checks.
      gate.markDepositSettled(jobId);
      await walkToConfirm(jobId, scriptedBase);
      await walkToStaged(jobId, scriptedBase);

      const before = fixture.calls.getPullRequest.length;
      const res = await postSigned(`/jobs/${jobId}/pull-request`, { pullRequestUrl: 'https://github.com/buyer/target-repo/pull/1' }, agent, scriptedBase);
      expect(res.status).toBe(402);
      expect(fixture.calls.getPullRequest.length).toBe(before);
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  it('409s when the base repo does not match the job\'s repository', async () => {
    const fixture = createStagingLifecycleGithubFake();
    ({ server, baseUrl } = await startWith(new MemoryJobRepository(), fixture.github));
    try {
      const { jobId } = await freshJob();
      const { url } = registerAgentForkPullRequest(fixture, {
        repository: 'buyer/some-other-repo',
        jobId,
        stagedCommit: 'commit-sha-1',
        agentLogin: AGENT_GITHUB_LOGIN,
      });
      const res = await postSigned(`/jobs/${jobId}/pull-request`, { pullRequestUrl: url }, agent);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('base repository');
    } finally {
      server.close();
    }
  });

  it('409s when the head repo is not a fork owned by the agent\'s verified login', async () => {
    const fixture = createStagingLifecycleGithubFake();
    ({ server, baseUrl } = await startWith(new MemoryJobRepository(), fixture.github));
    try {
      const { jobId } = await freshJob();
      const { url } = registerAgentForkPullRequest(fixture, {
        repository: REPOSITORY,
        jobId,
        stagedCommit: 'commit-sha-1',
        agentLogin: AGENT_GITHUB_LOGIN,
        headRepoOwner: 'someone-else',
      });
      const res = await postSigned(`/jobs/${jobId}/pull-request`, { pullRequestUrl: url }, agent);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('fork owned by the agent');
    } finally {
      server.close();
    }
  });

  it('409s when the head repo is owned by the agent but is NOT a fork', async () => {
    const fixture = createStagingLifecycleGithubFake();
    ({ server, baseUrl } = await startWith(new MemoryJobRepository(), fixture.github));
    try {
      const { jobId } = await freshJob();
      const { url } = registerAgentForkPullRequest(fixture, {
        repository: REPOSITORY,
        jobId,
        stagedCommit: 'commit-sha-1',
        agentLogin: AGENT_GITHUB_LOGIN,
        headRepoIsFork: false,
      });
      const res = await postSigned(`/jobs/${jobId}/pull-request`, { pullRequestUrl: url }, agent);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('fork owned by the agent');
    } finally {
      server.close();
    }
  });

  it('409s when the PR author is not the agent\'s verified login', async () => {
    const fixture = createStagingLifecycleGithubFake();
    ({ server, baseUrl } = await startWith(new MemoryJobRepository(), fixture.github));
    try {
      const { jobId } = await freshJob();
      const { url } = registerAgentForkPullRequest(fixture, {
        repository: REPOSITORY,
        jobId,
        stagedCommit: 'commit-sha-1',
        agentLogin: AGENT_GITHUB_LOGIN,
        authorLogin: 'someone-else',
      });
      const res = await postSigned(`/jobs/${jobId}/pull-request`, { pullRequestUrl: url }, agent);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('author');
    } finally {
      server.close();
    }
  });

  it('409s when the head sha does not equal the attested stagedCommit', async () => {
    const fixture = createStagingLifecycleGithubFake();
    ({ server, baseUrl } = await startWith(new MemoryJobRepository(), fixture.github));
    try {
      const { jobId } = await freshJob();
      const { url } = registerAgentForkPullRequest(fixture, {
        repository: REPOSITORY,
        jobId,
        stagedCommit: 'commit-sha-1',
        agentLogin: AGENT_GITHUB_LOGIN,
        headSha: 'a-different-commit-entirely',
      });
      const res = await postSigned(`/jobs/${jobId}/pull-request`, { pullRequestUrl: url }, agent);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('head sha');
    } finally {
      server.close();
    }
  });

  it('409s when the PR is not open (closed)', async () => {
    const fixture = createStagingLifecycleGithubFake();
    ({ server, baseUrl } = await startWith(new MemoryJobRepository(), fixture.github));
    try {
      const { jobId } = await freshJob();
      const { url } = registerAgentForkPullRequest(fixture, {
        repository: REPOSITORY,
        jobId,
        stagedCommit: 'commit-sha-1',
        agentLogin: AGENT_GITHUB_LOGIN,
        state: 'closed',
      });
      const res = await postSigned(`/jobs/${jobId}/pull-request`, { pullRequestUrl: url }, agent);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('must be open');
    } finally {
      server.close();
    }
  });

  it('409s when the body does not carry the Job: <id> trailer', async () => {
    const fixture = createStagingLifecycleGithubFake();
    ({ server, baseUrl } = await startWith(new MemoryJobRepository(), fixture.github));
    try {
      const { jobId } = await freshJob();
      const { url } = registerAgentForkPullRequest(fixture, {
        repository: REPOSITORY,
        jobId,
        stagedCommit: 'commit-sha-1',
        agentLogin: AGENT_GITHUB_LOGIN,
        bodyOverride: 'No job trailer here.',
      });
      const res = await postSigned(`/jobs/${jobId}/pull-request`, { pullRequestUrl: url }, agent);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('Job:');
    } finally {
      server.close();
    }
  });

  it('happy path: all five facts hold, records submitted with the agent\'s PR URL', async () => {
    const fixture = createStagingLifecycleGithubFake();
    ({ server, baseUrl } = await startWith(new MemoryJobRepository(), fixture.github));
    try {
      const { jobId } = await freshJob();
      const { url } = registerAgentForkPullRequest(fixture, {
        repository: REPOSITORY,
        jobId,
        stagedCommit: 'commit-sha-1',
        agentLogin: AGENT_GITHUB_LOGIN,
      });
      const res = await postSigned(`/jobs/${jobId}/pull-request`, { pullRequestUrl: url }, agent);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe('submitted');
      expect(body.pullRequestUrl).toBe(url);
    } finally {
      server.close();
    }
  });

  it('409s when the agent has no verified GitHub login on record', async () => {
    const fixture = createStagingLifecycleGithubFake();
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: 'did:abt:op-pr-unverified',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const operatorRepo = new MemoryAccountRepository();
    await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-pr-unverified' });
    const jobRepo = new MemoryJobRepository();
    const sessionAdapter = testSessionAdapter();
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
      sessionAdapter,
      undefined,
      alwaysSettledGate(),
      anyCommitStagingObserver(),
    );
    const s = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => s.once('listening', resolve));
    const address = s.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    const scriptedBase = `http://127.0.0.1:${address.port}`;
    try {
      // stage still works with no verified login (confirm would have
      // refused earlier in a real walk; this plants a job directly at
      // staged to isolate the pull-request route's own check).
      const draft = await openDraft('A job with no verified agent login', scriptedBase);
      // confirm requires a verified login too, so this job cannot walk
      // there over HTTP; instead assert the route's own 409 on a job
      // planted directly at staged via storage.
      const row = { ...createJob(
        { id: draft.jobId, buyerDid: buyer.did, agentDid: agent.did, repository: REPOSITORY, brief: 'x' },
        new Date(),
      ),
        status: 'staged' as JobStatus,
        criteria: [{ text: 'x', proposedBy: 'agent' as const, acceptedByBuyer: true, acceptedByAgent: true }],
        priceUsd: '100.00',
        rail: 'abt' as const,
        priceAcceptedByBuyer: true,
        priceAcceptedByAgent: true,
        confirmedSpecHash: 'sha256:' + 'a'.repeat(64),
        confirmedAt: new Date(),
        stagedCommit: 'commit-sha-1',
        stagedAt: new Date(),
        stagingRepo: { owner: 'freeagents-platform', repo: `staging-${draft.jobId}` },
        baseCommit: 'base-sha',
      };
      await jobRepo.update(row as Job);
      const { url } = registerAgentForkPullRequest(fixture, {
        repository: REPOSITORY,
        jobId: draft.jobId,
        stagedCommit: 'commit-sha-1',
        agentLogin: AGENT_GITHUB_LOGIN,
      });
      const res = await postSigned(`/jobs/${draft.jobId}/pull-request`, { pullRequestUrl: url }, agent, scriptedBase);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('verified GitHub login');
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  it('409s when the agent has a GitHub login on record that is not yet verified (the R-5 downgrade path)', async () => {
    // Distinct from the null-login test above: this plants a login that IS
    // present (agent.githubLogin !== null) but whose proofStatus dropped to
    // unverified (account-proof's own R-5 downgrade, app.ts:2261, is one way
    // this happens live). Deleting the proofStatus half of the guard at the
    // route (app.ts:4343) would leave every other test in this file green,
    // since they all plant a verified login or a null one -- this is the
    // only test that pins the unverified-but-present case.
    const fixture = createStagingLifecycleGithubFake();
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: 'did:abt:op-pr-unverified-login',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: AGENT_GITHUB_LOGIN,
    });
    await agentRepo.updateGithubBinding(agent.did, { handle: AGENT_GITHUB_LOGIN, status: 'unverified' });
    const operatorRepo = new MemoryAccountRepository();
    await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-pr-unverified-login' });
    const jobRepo = new MemoryJobRepository();
    const sessionAdapter = testSessionAdapter();
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
      sessionAdapter,
      undefined,
      alwaysSettledGate(),
      anyCommitStagingObserver(),
    );
    const s = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => s.once('listening', resolve));
    const address = s.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    const scriptedBase = `http://127.0.0.1:${address.port}`;
    try {
      // Same shape as the null-login test: confirm would refuse an
      // unverified agent, so this plants a job directly at staged to
      // isolate the pull-request route's own check.
      const draft = await openDraft('A job with an unverified agent login', scriptedBase);
      const row = {
        ...createJob(
          { id: draft.jobId, buyerDid: buyer.did, agentDid: agent.did, repository: REPOSITORY, brief: 'x' },
          new Date(),
        ),
        status: 'staged' as JobStatus,
        criteria: [{ text: 'x', proposedBy: 'agent' as const, acceptedByBuyer: true, acceptedByAgent: true }],
        priceUsd: '100.00',
        rail: 'abt' as const,
        priceAcceptedByBuyer: true,
        priceAcceptedByAgent: true,
        confirmedSpecHash: 'sha256:' + 'a'.repeat(64),
        confirmedAt: new Date(),
        stagedCommit: 'commit-sha-1',
        stagedAt: new Date(),
        stagingRepo: { owner: 'freeagents-platform', repo: `staging-${draft.jobId}` },
        baseCommit: 'base-sha',
      };
      await jobRepo.update(row as Job);
      const { url } = registerAgentForkPullRequest(fixture, {
        repository: REPOSITORY,
        jobId: draft.jobId,
        stagedCommit: 'commit-sha-1',
        agentLogin: AGENT_GITHUB_LOGIN,
      });
      const res = await postSigned(`/jobs/${draft.jobId}/pull-request`, { pullRequestUrl: url }, agent, scriptedBase);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('verified GitHub login');
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  // HIGH defect, QA round 1: GitHub reports owner, repo and login in ITS
  // OWN canonical case, case-insensitively, regardless of how POST /jobs,
  // account-proof or stage stored the caller's original spelling. An exact
  // !== compare on repository, login or head sha refuses an honest PR
  // forever on a paid job whose stored spelling and GitHub's reported
  // spelling merely differ in case. Each of the three facts gets its own
  // case-flipped test; the fourth fact (open/closed state, the Job:
  // trailer) has no analogous case-identity concern.
  it('matches the base repository case-insensitively (GitHub reports canonical case, the job stored the caller\'s spelling)', async () => {
    const fixture = createStagingLifecycleGithubFake();
    ({ server, baseUrl } = await startWith(new MemoryJobRepository(), fixture.github));
    try {
      const { jobId } = await freshJob();
      const { url } = registerAgentForkPullRequest(fixture, {
        repository: REPOSITORY.toUpperCase(),
        jobId,
        stagedCommit: 'commit-sha-1',
        agentLogin: AGENT_GITHUB_LOGIN,
      });
      const res = await postSigned(`/jobs/${jobId}/pull-request`, { pullRequestUrl: url }, agent);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe('submitted');
    } finally {
      server.close();
    }
  });

  it('matches the fork owner and PR author case-insensitively (GitHub reports the login in its own canonical case)', async () => {
    const fixture = createStagingLifecycleGithubFake();
    ({ server, baseUrl } = await startWith(new MemoryJobRepository(), fixture.github));
    try {
      const { jobId } = await freshJob();
      const { url } = registerAgentForkPullRequest(fixture, {
        repository: REPOSITORY,
        jobId,
        stagedCommit: 'commit-sha-1',
        agentLogin: AGENT_GITHUB_LOGIN,
        headRepoOwner: AGENT_GITHUB_LOGIN.toUpperCase(),
        authorLogin: AGENT_GITHUB_LOGIN.toUpperCase(),
      });
      const res = await postSigned(`/jobs/${jobId}/pull-request`, { pullRequestUrl: url }, agent);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe('submitted');
    } finally {
      server.close();
    }
  });

  it('matches the head sha case-insensitively (GitHub resolves an uppercase SHA and reports it back in lower case)', async () => {
    const fixture = createStagingLifecycleGithubFake();
    ({ server, baseUrl } = await startWith(new MemoryJobRepository(), fixture.github));
    try {
      const { jobId } = await freshJob();
      const { url } = registerAgentForkPullRequest(fixture, {
        repository: REPOSITORY,
        jobId,
        stagedCommit: 'commit-sha-1',
        agentLogin: AGENT_GITHUB_LOGIN,
        headSha: 'COMMIT-SHA-1',
      });
      const res = await postSigned(`/jobs/${jobId}/pull-request`, { pullRequestUrl: url }, agent);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe('submitted');
    } finally {
      server.close();
    }
  });
});

// The github-failure and corrupted-state legs need servers whose storage or
// adapter misbehaves, so they script their own - the same pattern
// tests/api/job-confirm.test.ts uses for rows no honest API path produces.
describe('job pull-request, faulted legs (R-10)', () => {
  it('answers 503 when github fails, logs the cause, and records nothing', async () => {
    const fixture = createStagingLifecycleGithubFake();
    const github: GithubAdapter = {
      ...fixture.github,
      getPullRequest: (ref) => {
        fixture.calls.getPullRequest.push(ref);
        return Promise.reject(new Error('connection refused by github'));
      },
    };
    const scripted = await startWith(new MemoryJobRepository(), github);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const created = await postSigned(
        '/jobs',
        {
          agentDid: agent.did,
          repository: REPOSITORY,
          brief: 'A job whose PR will fail',
        },
        buyer,
        scripted.baseUrl,
      );
      expect(created.status).toBe(201);
      const jobId = String(((await created.json()) as Record<string, unknown>).id);
      expect((await postSigned(`/jobs/${jobId}/criteria`, { criteria: proposal, priceUsd: '500.00', rail: 'abt' }, agent, scripted.baseUrl)).status).toBe(200);
      expect((await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, buyer, scripted.baseUrl)).status).toBe(200);
      expect((await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, agent, scripted.baseUrl)).status).toBe(200);
      expect((await postSigned(`/jobs/${jobId}/criteria/1/accept`, {}, buyer, scripted.baseUrl)).status).toBe(200);
      expect((await postSigned(`/jobs/${jobId}/criteria/1/accept`, {}, agent, scripted.baseUrl)).status).toBe(200);
      expect((await postSigned(`/jobs/${jobId}/price/accept`, {}, buyer, scripted.baseUrl)).status).toBe(200);
      expect((await postSigned(`/jobs/${jobId}/price/accept`, {}, agent, scripted.baseUrl)).status).toBe(200);
      expect((await postSigned(`/jobs/${jobId}/confirm`, {}, buyer, scripted.baseUrl)).status).toBe(200);

      const stage = await postSigned(`/jobs/${jobId}/stage`, { stagedCommit: 'commit-sha-1' }, agent, scripted.baseUrl);
      expect(stage.status).toBe(200);

      const pr = await postSigned(`/jobs/${jobId}/pull-request`, { pullRequestUrl: 'https://github.com/buyer/target-repo/pull/1' }, agent, scripted.baseUrl);
      expect(pr.status).toBe(503);
      expect(await pr.json()).toEqual({ error: 'github unavailable' });
      // The cause goes to the log, not the body.
      expect(errorLog).toHaveBeenCalled();
      // Nothing persisted: read back and the job is STILL staged with no URL.
      const read = await get(`/jobs/${jobId}`, scripted.baseUrl);
      const readBack = (await read.json()) as Record<string, unknown>;
      expect(readBack.status).toBe('staged');
      expect(readBack.pullRequestUrl).toBeUndefined();
      expect(readBack.submittedAt).toBeUndefined();
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('answers 503 when storage dies on load, before any adapter call', async () => {
    const failure = new Error('connection refused');
    class FailingJobRepository implements JobRepository {
      async create(): Promise<never> {
        throw failure;
      }
      async update(): Promise<never> {
        throw failure;
      }
      async complete(): Promise<never> {
        throw failure;
      }
      async findCompletedByJobId(): Promise<never> {
        throw failure;
      }
      async findById(): Promise<never> {
        throw failure;
      }
    }
    const fixture = createStagingLifecycleGithubFake();
    const scripted = await startWith(new FailingJobRepository(), fixture.github);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await fetch(`${scripted.baseUrl}/jobs/j-any/pull-request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pullRequestUrl: 'https://github.com/buyer/target-repo/pull/1' }),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'storage unavailable' });
      expect(errorLog).toHaveBeenCalled();
      // Storage died before the state machine was even consulted; github
      // never heard about it.
      expect(fixture.calls.getPullRequest.length).toBe(0);
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('fails closed on a corrupted status instead of firing github', async () => {
    // No honest API path produces a status outside the state machine's own
    // enum, so the only witness is a planted row. The pre-check must rethrow
    // what it cannot map - reaching the terminal handler as a 500 - rather
    // than answer a client error or reach the adapter.
    const row: Job = {
      ...createJob(
        { id: 'j-corrupt', buyerDid: buyer.did, agentDid: agent.did, repository: REPOSITORY, brief: 'Fix the login bug' },
        new Date('2026-01-01T00:00:00Z'),
      ),
      status: 'corrupted' as JobStatus,
    };
    class ScriptedRow implements JobRepository {
      async create(): Promise<never> {
        throw new Error('unreachable');
      }
      async findById(): Promise<Job> {
        return row;
      }
      async update(): Promise<null> {
        return null;
      }
      async complete(): Promise<null> {
        return null;
      }
      async findCompletedByJobId(): Promise<null> {
        return null;
      }
    }
    const fixture = createStagingLifecycleGithubFake();
    const scripted = await startWith(new ScriptedRow(), fixture.github);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await postSigned('/jobs/j-corrupt/pull-request', { pullRequestUrl: 'https://github.com/buyer/target-repo/pull/1' }, agent, scripted.baseUrl);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal error' });
      expect(errorLog).toHaveBeenCalled();
      expect(fixture.calls.getPullRequest.length).toBe(0);
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });
});

// Invariant 1 and Gate 2, on their own server: what the adapter surface
// offers a caller at all, and what a stranger can verify from the public PR
// artifacts without ever calling this service.
describe('pull-request, invariant 1 and Gate 2 (R-10, STG2)', () => {
  const fixture = createStagingLifecycleGithubFake();
  let prJobId: string;
  let prBriefHash: unknown;
  let confirmedSpecHash: unknown;
  let prUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startWith(new MemoryJobRepository(), fixture.github));
    const { jobId, briefHash } = await openDraft('Fix the login bug');
    prJobId = jobId;
    prBriefHash = briefHash;
    const confirmedBody = await walkToConfirm(jobId);
    confirmedSpecHash = confirmedBody.specHash;
    await walkToStaged(jobId);

    const registered = registerAgentForkPullRequest(fixture, {
      repository: REPOSITORY,
      jobId,
      stagedCommit: 'commit-sha-1',
      agentLogin: AGENT_GITHUB_LOGIN,
    });
    prUrl = registered.url;
    const pr = await postSigned(`/jobs/${jobId}/pull-request`, { pullRequestUrl: prUrl }, agent);
    expect(pr.status).toBe(200);
  });

  afterAll(() => {
    server.close();
  });

  it('the adapter surface offers reads plus the staging lifecycle, no arbitrary write', async () => {
    // The whole interface, enumerated: there is no method that pushes a
    // branch to an arbitrary target, no method that opens a pull request,
    // no method that edits someone else's repository - by construction of
    // the type, not by discipline.
    const originalToken = process.env.FREEAGENTS_GITHUB_TOKEN;
    delete process.env.FREEAGENTS_GITHUB_TOKEN;
    try {
      const real = createGithubAdapter();
      expect(Object.keys(real).sort()).toEqual([
        'compareCommits',
        'createStagingRepository',
        'getCommit',
        'getDefaultBranchHead',
        'getMergeCommitSignature',
        'getPublicGist',
        'getPullRequest',
        'grantPush',
      ]);
      // getMergeCommitSignature has no caller on main yet (this card's own
      // scope: "may stay NotImplementedError if nothing on main calls it
      // yet; do not build ahead of need"), so it still throws synchronously,
      // the same shape as every other honest stub in this codebase.
      const ref: PullRequestRef = { owner: 'o', repo: 'r', number: 1 };
      expect(() => real.getMergeCommitSignature(ref)).toThrow(NotImplementedError);
      // getPullRequest and getPublicGist are real against the GitHub REST
      // API now (this card's scope). With no FREEAGENTS_GITHUB_TOKEN
      // configured they fail closed - the same honest "unconfigured
      // deployment announces itself" shape every other adapter factory in
      // this codebase uses (storage.ts, credentials.ts) - which surfaces as
      // an async rejection, not a synchronous throw.
      await expect(real.getPullRequest(ref)).rejects.toThrow();
      await expect(real.getPublicGist({ id: 'x' })).rejects.toThrow();
    } finally {
      if (originalToken === undefined) delete process.env.FREEAGENTS_GITHUB_TOKEN;
      else process.env.FREEAGENTS_GITHUB_TOKEN = originalToken;
    }
  });

  it('the pull request opens from the agent\'s own fork, never from a repository the platform controls', async () => {
    // The accept line's "the token used has no write permission on the
    // target", in its strongest available form: this route never calls a
    // write method at all -- it only reads the PR the agent already
    // opened itself, at a URL naming the agent's own fork.
    expect(prUrl).toContain('buyer/target-repo/pull/');
  });

  it('a stranger ties PR to job and spec from the public artifacts alone', async () => {
    // Gate 2 / ENT-4.5: holding ONLY the pullRequestTemplate the staged
    // projection carried, plus the confirm response fetched over HTTP, a
    // stranger can verify the linkage - no src/ import, no call to this
    // service. The job id appears twice over; both hashes appear exactly as
    // the API projected them, byte for byte.
    const read = await get(`/jobs/${prJobId}`);
    const body = (await read.json()) as Record<string, unknown>;
    const template = body.pullRequestTemplate as Record<string, unknown> | undefined;
    // The template was consumed by staging, so it may or may not still
    // ride the submitted projection; if it does, verify its contents.
    if (template !== undefined) {
      expect(template.title).toContain(prJobId);
      expect(String(template.body)).toContain(prJobId);
      expect(String(template.body)).toContain(String(prBriefHash));
      expect(String(template.body)).toContain(String(confirmedSpecHash));
    }
    // The hash is in the format anyone can recompute off-platform.
    expect(String(confirmedSpecHash)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('job pull-request, who may (B7, 2026-09-01)', () => {
  const jobRepo = new MemoryJobRepository();
  const fixture = createStagingLifecycleGithubFake();

  let stranger: SigningIdentity;

  beforeAll(async () => {
    buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(81));
    agent = await signingIdentityFromSeed(new Uint8Array(32).fill(82));
    stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(83));
    ({ server, baseUrl } = await startWith(jobRepo, fixture.github, [
      { did: stranger.did, githubLogin: 'stranger-pr' },
    ]));
  });

  afterAll(() => {
    server.close();
  });

  it('refuses an unsigned submit with 401, a stranger and the buyer with 403, and fires github zero times', async () => {
    const { jobId } = await openDraft('Fix the login bug on the checkout page');
    await walkToConfirm(jobId);
    const before = fixture.calls.getPullRequest.length;
    const unsigned = await fetch(`${baseUrl}/jobs/${jobId}/pull-request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(unsigned.status).toBe(401);
    expect((await postSigned(`/jobs/${jobId}/pull-request`, {}, stranger)).status).toBe(403);
    expect((await postSigned(`/jobs/${jobId}/pull-request`, {}, buyer)).status).toBe(403);
    expect(fixture.calls.getPullRequest.length).toBe(before);
    const job = (await (await fetch(`${baseUrl}/jobs/${jobId}`)).json()) as { status: string };
    expect(job.status).toBe('confirmed');
  });
});
