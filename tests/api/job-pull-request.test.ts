// R-10 (#17) / B14a: create a platform-owned staging repository and open
// the pull request from it, driven end to end over HTTP.
//
// THE accept lines this issue exists to prove: the PR carries the job id
// (ENT-4.5), and no write scope on the buyer's repository is ever
// requested (ENT-4.3 / invariant 1). One job walks propose -> accept x2 ->
// confirm -> stage -> pull-request; the fake github records EVERY method's
// invocations so the tests can assert what each route asked github to do -
// and that every write targeted the platform-owned staging repository,
// never the buyer's.
//
// The repo holds no token concept beyond FREEAGENTS_GITHUB_TOKEN (the real
// adapter, src/adapters/github/github.ts, is real now; unconfigured is the
// only way it fails closed), so "the token has no write permission on the
// target" is proven at the adapter boundary: confirm creates the staging
// repo and grants push there (never on the source), stage verifies the
// staged commit against that same repo, and pull-request opens from it
// against the source. That proof lives in the "invariant 1" describe.
//
// runExchange's storage-fault legs are NOT re-covered per route:
// tests/api/job-criteria.test.ts pins each leg of the skeleton these routes
// share. The legs new to THIS route - github unavailable, storage dead on
// load, a corrupted status rethrowing - are covered here.
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createGithubAdapter } from '../../src/adapters/github/github.js';
import type {
  GithubAdapter,
  OpenStagedPullRequestInput,
  PullRequestRef,
} from '../../src/adapters/github/types.js';
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
  PLATFORM_LOGIN,
  type StagingLifecycleCalls,
} from '../helpers/github-staging-fixtures.js';

let buyer: SigningIdentity;
let agent: SigningIdentity;
const AGENT_GITHUB_LOGIN = 'scout-pr';
const proposal = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
];

function rejectingOnPullRequest(calls: StagingLifecycleCalls, github: GithubAdapter): GithubAdapter {
  return {
    ...github,
    openStagedPullRequest: (input: OpenStagedPullRequestInput) => {
      calls.openStagedPullRequest.push(input);
      return Promise.reject(new Error('connection refused by github'));
    },
  };
}

// Recorded calls are only ever read after a test asserts how many exist, but
// noUncheckedIndexedAccess cannot see those assertions; the guard here keeps
// the narrowing local instead of scattering casts through the tests.
function prCall(calls: StagingLifecycleCalls, index: number): OpenStagedPullRequestInput {
  const call = calls.openStagedPullRequest[index];
  expect(call).toBeDefined();
  return call as OpenStagedPullRequestInput;
}

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
    repository: 'buyer/target-repo',
    brief,
  }, buyer, base);
  expect(created.status).toBe(201);
  const body = (await created.json()) as Record<string, unknown>;
  return { jobId: String(body.id), briefHash: body.briefHash };
}

describe('job pull-request (R-10, B14a)', () => {
  const jobRepo = new MemoryJobRepository();
  const { github, calls } = createStagingLifecycleGithubFake();
  // Set by the happy-path walk; the lock test posts that same id again,
  // which is the point: one job id, every path tried against it.
  let happyJobId: string;
  let happyBriefHash: unknown;
  let happySpecHash: unknown;
  let stagingOwner: string;
  let stagingRepoName: string;

  beforeAll(async () => {
    buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(81));
    agent = await signingIdentityFromSeed(new Uint8Array(32).fill(82));
    ({ server, baseUrl } = await startWith(jobRepo, github));
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

    const pr = await postSigned(`/jobs/${jobId}/pull-request`, {}, agent);
    expect(pr.status).toBe(200);
    const prBody = (await pr.json()) as Record<string, unknown>;
    expect(prBody.id).toBe(jobId);
    expect(prBody.status).toBe('submitted');
    expect(calls.openStagedPullRequest.length).toBe(1);
    const call = prCall(calls, 0);
    stagingOwner = call.stagingOwner;
    stagingRepoName = call.stagingRepo;
    expect(prBody.pullRequestUrl).toBe(`https://github.com/buyer/target-repo/pull/1`);
    expect(typeof prBody.submittedAt).toBe('string');
    // A submitted job projects the confirmed eleven plus pullRequestUrl,
    // submittedAt and deadline (R-10, R-12), plus the price line (P1) once
    // one exists, and nothing else.
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

  it('created the staging repository under the platform account, granted push there, and asked github to write only to it', async () => {
    // Confirm created exactly one staging repository, owned by the
    // platform, seeded from the buyer's repo.
    expect(calls.createStagingRepository.length).toBe(1);
    const created = calls.createStagingRepository[0];
    expect(created).toBeDefined();
    expect(created?.sourceOwner).toBe('buyer');
    expect(created?.sourceRepo).toBe('target-repo');
    expect(stagingOwner).toBe(PLATFORM_LOGIN);

    // Push was granted to the agent's own verified login, on the staging
    // repository -- never on the buyer's.
    expect(calls.grantPush.length).toBe(1);
    const grant = calls.grantPush[0];
    expect(grant).toBeDefined();
    expect(grant?.owner).toBe(PLATFORM_LOGIN);
    expect(grant?.githubLogin).toBe(AGENT_GITHUB_LOGIN);

    const call = prCall(calls, 0);
    // The source is named read-only; branch, title and body are what become
    // the public PR against the source repo, opened from the staging repo.
    expect(call.stagingOwner).toBe(PLATFORM_LOGIN);
    expect(call.stagingRepo).toBe(stagingRepoName);
    expect(call.sourceOwner).toBe('buyer');
    expect(call.sourceRepo).toBe('target-repo');
    expect(call.branch).toBe(`freeagents/${happyJobId}`);
    // ENT-4.5: the job id rides the title, where triage sees it first...
    expect(call.title).toContain(happyJobId);
    // ...and the body ties PR to job and agreed spec without our service:
    // both hashes exactly as the API projected them, byte for byte.
    expect(call.body).toContain(happyJobId);
    expect(call.body).toContain(String(happyBriefHash));
    expect(call.body).toContain(String(happySpecHash));
    // Invariant 1 is part of the public claim, not just internal behaviour.
    expect(call.body).toContain('holds no write access');
  });

  it('answers 404 for an unknown id, with zero adapter calls', async () => {
    const before = calls.openStagedPullRequest.length;
    const nowhere = await postSigned('/jobs/j-nowhere/pull-request', {}, agent);
    expect(nowhere.status).toBe(404);
    expect(await nowhere.json()).toEqual({ error: 'not found' });
    expect(calls.openStagedPullRequest.length).toBe(before);
  });

  it('answers 409 for a fresh draft WITHOUT firing the adapter once', async () => {
    // Opening a PR is an external side effect; the state machine is
    // consulted first, so a draft gets its conflict and github sees nothing.
    const { jobId } = await openDraft('A draft nobody confirmed');
    const before = calls.openStagedPullRequest.length;

    const early = await postSigned(`/jobs/${jobId}/pull-request`, {}, agent);
    expect(early.status).toBe(409);
    expect(((await early.json()) as { error: string }).error).toContain('status "draft"');
    expect(calls.openStagedPullRequest.length).toBe(before);

    // And the row did not budge: still draft, no submission keys anywhere.
    const read = await get(`/jobs/${jobId}`);
    const readBack = (await read.json()) as Record<string, unknown>;
    expect(readBack.status).toBe('draft');
    expect(readBack.pullRequestUrl).toBeUndefined();
    expect(readBack.submittedAt).toBeUndefined();
  });

  it('locks the job after submit: posting again is a 409 and opens no second PR', async () => {
    const before = calls.openStagedPullRequest.length;
    const again = await postSigned(`/jobs/${happyJobId}/pull-request`, {}, agent);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toContain('status "submitted"');
    expect(calls.openStagedPullRequest.length).toBe(before);

    // The submitted row keeps exactly the PR it opened first, and the
    // deadline rides the read-back as the domain wrote it.
    const read = await get(`/jobs/${happyJobId}`);
    const readBack = (await read.json()) as Record<string, unknown>;
    expect(readBack.pullRequestUrl).toBe(`https://github.com/buyer/target-repo/pull/1`);
    expect(typeof readBack.deadline).toBe('string');
  });
});

// The github-failure and corrupted-state legs need servers whose storage or
// adapter misbehaves, so they script their own - the same pattern
// tests/api/job-confirm.test.ts uses for rows no honest API path produces.
describe('job pull-request, faulted legs (R-10)', () => {
  it('answers 503 when github fails, logs the cause, and records nothing', async () => {
    const { github, calls } = createStagingLifecycleGithubFake();
    const scripted = await startWith(new MemoryJobRepository(), rejectingOnPullRequest(calls, github));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // The helpers take an explicit base because this server is not the
      // describe's own.
      const created = await postSigned(
        '/jobs',
        {
          agentDid: agent.did,
          repository: 'buyer/target-repo',
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

      const pr = await postSigned(`/jobs/${jobId}/pull-request`, {}, agent, scripted.baseUrl);
      expect(pr.status).toBe(503);
      expect(await pr.json()).toEqual({ error: 'github unavailable' });
      // The cause goes to the log, not the body.
      expect(errorLog).toHaveBeenCalled();
      // The fake recorded the attempt, but nothing persisted: read back and
      // the job is STILL staged with no URL. A failed side effect leaves
      // no half-state behind.
      expect(calls.openStagedPullRequest.length).toBe(1);
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
    const { github, calls } = createStagingLifecycleGithubFake();
    const scripted = await startWith(new FailingJobRepository(), github);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await fetch(`${scripted.baseUrl}/jobs/j-any/pull-request`, { method: 'POST' });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'storage unavailable' });
      expect(errorLog).toHaveBeenCalled();
      // Storage died before the state machine was even consulted; github
      // never heard about it.
      expect(calls.openStagedPullRequest.length).toBe(0);
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
        { id: 'j-corrupt', buyerDid: buyer.did, agentDid: agent.did, repository: 'buyer/target-repo', brief: 'Fix the login bug' },
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
    const { github, calls } = createStagingLifecycleGithubFake();
    const scripted = await startWith(new ScriptedRow(), github);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await postSigned('/jobs/j-corrupt/pull-request', {}, agent, scripted.baseUrl);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal error' });
      expect(errorLog).toHaveBeenCalled();
      expect(calls.openStagedPullRequest.length).toBe(0);
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });
});

// Invariant 1 and Gate 2, on their own server: what the adapter surface
// offers a caller at all, and what a stranger can verify from the public PR
// artifacts without ever calling this service.
describe('pull-request, invariant 1 and Gate 2 (R-10, B14a)', () => {
  const { github, calls } = createStagingLifecycleGithubFake();
  let prJobId: string;
  let prBriefHash: unknown;
  let confirmedSpecHash: unknown;
  let call: OpenStagedPullRequestInput;

  beforeAll(async () => {
    ({ server, baseUrl } = await startWith(new MemoryJobRepository(), github));
    const { jobId, briefHash } = await openDraft('Fix the login bug');
    prJobId = jobId;
    prBriefHash = briefHash;
    const confirmedBody = await walkToConfirm(jobId);
    confirmedSpecHash = confirmedBody.specHash;
    await walkToStaged(jobId);

    const pr = await postSigned(`/jobs/${jobId}/pull-request`, {}, agent);
    expect(pr.status).toBe(200);
    expect(calls.openStagedPullRequest.length).toBe(1);
    call = prCall(calls, 0);
  });

  afterAll(() => {
    server.close();
  });

  it('the adapter surface offers reads plus the staging lifecycle, no arbitrary write', async () => {
    // The whole interface, enumerated: there is no method that pushes a
    // branch to an arbitrary target, no method that edits someone else's
    // repository - by construction of the type, not by discipline.
    const originalToken = process.env.FREEAGENTS_GITHUB_TOKEN;
    delete process.env.FREEAGENTS_GITHUB_TOKEN;
    try {
      const real = createGithubAdapter();
      expect(Object.keys(real).sort()).toEqual([
        'createStagingRepository',
        'getCommit',
        'getDefaultBranchHead',
        'getMergeCommitSignature',
        'getPublicGist',
        'getPullRequest',
        'grantPush',
        'openStagedPullRequest',
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

    // And this route used none of the plain read methods: it only worked
    // the staging lifecycle.
    expect(calls.openStagedPullRequest.length).toBe(1);
  });

  it('the pull request opens from the staging repository, never from the source', () => {
    // The accept line's "the token used has no write permission on the
    // target", in its strongest available form: the write-target field is
    // the staging repository the platform itself created, a different
    // owner than the source, which is where the job's stored URL points.
    expect(call.stagingOwner).toBe(PLATFORM_LOGIN);
    expect(call.stagingOwner).not.toBe('buyer');
    expect(call.sourceOwner).toBe('buyer');
  });

  it('a stranger ties PR to job and spec from the public artifacts alone', () => {
    // Gate 2 / ENT-4.5: holding ONLY the strings that become the public PR
    // title and body, plus the confirm response fetched over HTTP, a
    // stranger can verify the linkage - no src/ import, no call to this
    // service. The job id appears twice over; both hashes appear exactly as
    // the API projected them, byte for byte.
    expect(call.title).toContain(prJobId);
    expect(call.body).toContain(prJobId);
    expect(call.body).toContain(String(prBriefHash));
    expect(call.body).toContain(String(confirmedSpecHash));
    // The hash is in the format anyone can recompute off-platform.
    expect(String(confirmedSpecHash)).toMatch(/^sha256:[0-9a-f]{64}$/);
    // And the no-write-access claim ships with the artifact, so the
    // invariant is part of what a buyer reads, not just of our behaviour.
    expect(call.body).toContain('holds no write access');
  });
});

describe('job pull-request, who may (B7, 2026-09-01)', () => {
  const jobRepo = new MemoryJobRepository();
  const { github, calls } = createStagingLifecycleGithubFake();

  let stranger: SigningIdentity;

  beforeAll(async () => {
    buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(81));
    agent = await signingIdentityFromSeed(new Uint8Array(32).fill(82));
    stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(83));
    ({ server, baseUrl } = await startWith(jobRepo, github, [
      { did: stranger.did, githubLogin: 'stranger-pr' },
    ]));
  });

  afterAll(() => {
    server.close();
  });

  it('refuses an unsigned submit with 401, a stranger and the buyer with 403, and fires github zero times', async () => {
    const { jobId } = await openDraft('Fix the login bug on the checkout page');
    await walkToConfirm(jobId);
    const unsigned = await fetch(`${baseUrl}/jobs/${jobId}/pull-request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(unsigned.status).toBe(401);
    expect((await postSigned(`/jobs/${jobId}/pull-request`, {}, stranger)).status).toBe(403);
    expect((await postSigned(`/jobs/${jobId}/pull-request`, {}, buyer)).status).toBe(403);
    expect(calls.openStagedPullRequest).toHaveLength(0);
    const job = (await (await fetch(`${baseUrl}/jobs/${jobId}`)).json()) as { status: string };
    expect(job.status).toBe('confirmed');
  });
});
