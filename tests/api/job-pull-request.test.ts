// R-10 (#17): fork and open the pull request, driven end to end over HTTP.
//
// THE accept lines this issue exists to prove: the PR carries the job id
// (ENT-4.5), and no write scope on the buyer's repository is ever requested
// (ENT-4.3 / invariant 1). One job walks propose -> accept x2 -> confirm ->
// pull-request; the fake github records EVERY method's invocations so the
// tests can assert what the route asked github to do - and that the target
// was the fork this platform created, never the buyer's repo.
//
// The repo holds no token concept yet (no credential handling exists; the
// real adapter is still a stub), so "the token has no write permission on
// the target" is proven at the adapter boundary: the interface exposes
// exactly four methods, only forkAndOpenPullRequest mutates, its input names
// no repository to write to, and the recorded calls aim at the fork. That
// proof lives in the second describe.
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
  ForkAndOpenPullRequestInput,
  GithubAdapter,
  PullRequestRef,
} from '../../src/adapters/github/types.js';
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import {
  MemoryAgentRepository,
  MemoryJobRepository,
  MemoryOperatorRepository,
} from '../../src/adapters/storage/memory.js';
import type { JobRepository } from '../../src/adapters/storage/types.js';
import { createJob, type Job, type JobStatus } from '../../src/domain/job.js';

const AGENT_DID = 'did:abt:agent-pr';
const BUYER_DID = 'did:abt:buyer-pr';
const FORK_OWNER = 'freeagents-platform';
const FORK_REPO = 'target-repo';
const proposal = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
];

// What the route asked github to do, per method. Every method records BEFORE
// rejecting or resolving, so even a failed call leaves a witness.
interface RecordedCalls {
  getPullRequest: PullRequestRef[];
  getMergeCommitSignature: PullRequestRef[];
  getPublicGist: Array<{ readonly id: string }>;
  forkAndOpenPullRequest: ForkAndOpenPullRequestInput[];
}

function emptyRecordings(): RecordedCalls {
  return {
    getPullRequest: [],
    getMergeCommitSignature: [],
    getPublicGist: [],
    forkAndOpenPullRequest: [],
  };
}

function recordingFake(recorded: RecordedCalls): GithubAdapter {
  return {
    // Only the capability under test resolves; the other three reject with
    // the same honest shape as the real adapter (see account-proof tests).
    getPullRequest: (ref) => {
      recorded.getPullRequest.push(ref);
      return Promise.reject(new NotImplementedError('github', 'getPullRequest'));
    },
    getMergeCommitSignature: (ref) => {
      recorded.getMergeCommitSignature.push(ref);
      return Promise.reject(new NotImplementedError('github', 'getMergeCommitSignature'));
    },
    getPublicGist: (ref) => {
      recorded.getPublicGist.push(ref);
      return Promise.reject(new NotImplementedError('github', 'getPublicGist'));
    },
    forkAndOpenPullRequest: (input) => {
      recorded.forkAndOpenPullRequest.push(input);
      // The ref models a fork THIS platform created of the source repo -
      // different owner, same repo name - which is what makes the
      // write-target assertions below meaningful rather than tautological.
      return Promise.resolve({ owner: FORK_OWNER, repo: FORK_REPO, number: 1 });
    },
  };
}

function rejectingFake(recorded: RecordedCalls): GithubAdapter {
  const base = recordingFake(recorded);
  return {
    ...base,
    forkAndOpenPullRequest: (input) => {
      recorded.forkAndOpenPullRequest.push(input);
      return Promise.reject(new Error('connection refused by github'));
    },
  };
}

// Recorded calls are only ever read after a test asserts how many exist, but
// noUncheckedIndexedAccess cannot see those assertions; the guard here keeps
// the narrowing local instead of scattering casts through the tests.
function forkCall(recorded: RecordedCalls, index: number): ForkAndOpenPullRequestInput {
  const call = recorded.forkAndOpenPullRequest[index];
  expect(call).toBeDefined();
  return call as ForkAndOpenPullRequestInput;
}

// Rebound by each describe's beforeAll; suites inside one file run in order,
// so handing the helpers below to whichever suite is current is safe.
let server: Server;
let baseUrl: string;

async function post(path: string, body: unknown = {}, base: string = baseUrl, callerDid?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (callerDid !== undefined) headers['x-freeagents-caller-did'] = callerDid;
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function get(path: string, base: string = baseUrl): Promise<Response> {
  return fetch(`${base}${path}`);
}

async function startWith(
  repo: JobRepository,
  github: GithubAdapter,
): Promise<{ server: Server; baseUrl: string }> {
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: AGENT_DID,
    operatorDid: 'did:abt:op-pr',
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: null,
  });
  const s = createApp(new MemoryOperatorRepository(), agentRepo, undefined, github, repo).listen(0);
  await new Promise<void>((resolve) => s.once('listening', resolve));
  const address = s.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return { server: s, baseUrl: `http://127.0.0.1:${address.port}` };
}

// One job walked draft -> confirmed over HTTP, returning the confirm body so
// the specHash a stranger sees can be compared byte for byte.
async function walkToConfirm(jobId: string, base: string = baseUrl): Promise<Record<string, unknown>> {
  expect((await post(`/jobs/${jobId}/criteria`, { criteria: proposal }, base, AGENT_DID)).status).toBe(200);
  expect((await post(`/jobs/${jobId}/criteria/0/accept`, {}, base, BUYER_DID)).status).toBe(200);
  expect((await post(`/jobs/${jobId}/criteria/0/accept`, {}, base, AGENT_DID)).status).toBe(200);
  expect((await post(`/jobs/${jobId}/criteria/1/accept`, {}, base, BUYER_DID)).status).toBe(200);
  expect((await post(`/jobs/${jobId}/criteria/1/accept`, {}, base, AGENT_DID)).status).toBe(200);
  const confirmed = await post(`/jobs/${jobId}/confirm`, {}, base, BUYER_DID);
  expect(confirmed.status).toBe(200);
  return (await confirmed.json()) as Record<string, unknown>;
}

async function openDraft(brief: string): Promise<{ jobId: string; briefHash: unknown }> {
  const created = await post('/jobs', {
    buyerDid: BUYER_DID,
    agentDid: AGENT_DID,
    repository: 'buyer/target-repo',
    brief,
  });
  expect(created.status).toBe(201);
  const body = (await created.json()) as Record<string, unknown>;
  return { jobId: String(body.id), briefHash: body.briefHash };
}

describe('job pull-request (R-10)', () => {
  const jobRepo = new MemoryJobRepository();
  const recorded = emptyRecordings();
  // Set by the happy-path walk; the lock test posts that same id again,
  // which is the point: one job id, every path tried against it.
  let happyJobId: string;
  let happyBriefHash: unknown;
  let happySpecHash: unknown;

  beforeAll(async () => {
    ({ server, baseUrl } = await startWith(jobRepo, recordingFake(recorded)));
  });

  afterAll(() => {
    server.close();
  });

  it('walks confirm -> pull-request on ONE row and projects the submitted keys', async () => {
    const { jobId, briefHash } = await openDraft('Fix the login bug on the checkout page');
    happyJobId = jobId;
    happyBriefHash = briefHash;
    const confirmedBody = await walkToConfirm(jobId);
    happySpecHash = confirmedBody.specHash;
    expect(confirmedBody.status).toBe('confirmed');

    const pr = await post(`/jobs/${jobId}/pull-request`);
    expect(pr.status).toBe(200);
    const prBody = (await pr.json()) as Record<string, unknown>;
    expect(prBody.id).toBe(jobId);
    expect(prBody.status).toBe('submitted');
    expect(prBody.pullRequestUrl).toBe(`https://github.com/${FORK_OWNER}/${FORK_REPO}/pull/1`);
    expect(typeof prBody.submittedAt).toBe('string');
    // A submitted job projects the confirmed eleven plus pullRequestUrl,
    // submittedAt and deadline (R-10, R-12), and nothing else.
    expect(Object.keys(prBody).sort()).toEqual([
      'agentDid',
      'brief',
      'briefHash',
      'buyerDid',
      'confirmedAt',
      'createdAt',
      'criteria',
      'deadline',
      'id',
      'pullRequestUrl',
      'repository',
      'specHash',
      'status',
      'submittedAt',
    ]);
    // The deadline is the one the domain wrote: 30 days out, an ISO string
    // the buyer can hold against the wall clock.
    expect(typeof prBody.deadline).toBe('string');
    // Exactly one adapter call so far: the one this walk caused.
    expect(recorded.forkAndOpenPullRequest.length).toBe(1);
  });

  it('asked github to read the BUYER repo only, and to write to the fork', async () => {
    const call = forkCall(recorded, 0);
    // The source is named read-only; branch, title and body are what become
    // the public PR on the fork.
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

    // The three read methods were never invoked by this route.
    expect(recorded.getPullRequest.length).toBe(0);
    expect(recorded.getMergeCommitSignature.length).toBe(0);
    expect(recorded.getPublicGist.length).toBe(0);
  });

  it('answers 404 for an unknown id, with zero adapter calls', async () => {
    const before = recorded.forkAndOpenPullRequest.length;
    const nowhere = await post('/jobs/j-nowhere/pull-request');
    expect(nowhere.status).toBe(404);
    expect(await nowhere.json()).toEqual({ error: 'not found' });
    expect(recorded.forkAndOpenPullRequest.length).toBe(before);
  });

  it('answers 409 for a fresh draft WITHOUT firing the adapter once', async () => {
    // Opening a PR is an external side effect; the state machine is
    // consulted first, so a draft gets its conflict and github sees nothing.
    const { jobId } = await openDraft('A draft nobody confirmed');
    const before = recorded.forkAndOpenPullRequest.length;

    const early = await post(`/jobs/${jobId}/pull-request`);
    expect(early.status).toBe(409);
    expect(((await early.json()) as { error: string }).error).toContain('status "draft"');
    expect(recorded.forkAndOpenPullRequest.length).toBe(before);

    // And the row did not budge: still draft, no submission keys anywhere.
    const read = await get(`/jobs/${jobId}`);
    const readBack = (await read.json()) as Record<string, unknown>;
    expect(readBack.status).toBe('draft');
    expect(readBack.pullRequestUrl).toBeUndefined();
    expect(readBack.submittedAt).toBeUndefined();
  });

  it('locks the job after submit: posting again is a 409 and opens no second PR', async () => {
    const before = recorded.forkAndOpenPullRequest.length;
    const again = await post(`/jobs/${happyJobId}/pull-request`);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toContain('status "submitted"');
    expect(recorded.forkAndOpenPullRequest.length).toBe(before);

    // The submitted row keeps exactly the PR it opened first, and the
    // deadline rides the read-back as the domain wrote it.
    const read = await get(`/jobs/${happyJobId}`);
    const readBack = (await read.json()) as Record<string, unknown>;
    expect(readBack.pullRequestUrl).toBe(`https://github.com/${FORK_OWNER}/${FORK_REPO}/pull/1`);
    expect(typeof readBack.deadline).toBe('string');
  });
});

// The github-failure and corrupted-state legs need servers whose storage or
// adapter misbehaves, so they script their own - the same pattern
// tests/api/job-confirm.test.ts uses for rows no honest API path produces.
describe('job pull-request, faulted legs (R-10)', () => {
  it('answers 503 when github fails, logs the cause, and records nothing', async () => {
    const faults = emptyRecordings();
    const scripted = await startWith(new MemoryJobRepository(), rejectingFake(faults));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // The helpers take an explicit base because this server is not the
      // describe's own.
      const created = await post(
        '/jobs',
        {
          buyerDid: BUYER_DID,
          agentDid: AGENT_DID,
          repository: 'buyer/target-repo',
          brief: 'A job whose PR will fail',
        },
        scripted.baseUrl,
      );
      expect(created.status).toBe(201);
      const jobId = String(((await created.json()) as Record<string, unknown>).id);
      expect((await post(`/jobs/${jobId}/criteria`, { criteria: proposal }, scripted.baseUrl, AGENT_DID)).status).toBe(200);
      expect((await post(`/jobs/${jobId}/criteria/0/accept`, {}, scripted.baseUrl, BUYER_DID)).status).toBe(200);
      expect((await post(`/jobs/${jobId}/criteria/0/accept`, {}, scripted.baseUrl, AGENT_DID)).status).toBe(200);
      expect((await post(`/jobs/${jobId}/criteria/1/accept`, {}, scripted.baseUrl, BUYER_DID)).status).toBe(200);
      expect((await post(`/jobs/${jobId}/criteria/1/accept`, {}, scripted.baseUrl, AGENT_DID)).status).toBe(200);
      expect((await post(`/jobs/${jobId}/confirm`, {}, scripted.baseUrl, BUYER_DID)).status).toBe(200);

      const pr = await post(`/jobs/${jobId}/pull-request`, {}, scripted.baseUrl);
      expect(pr.status).toBe(503);
      expect(await pr.json()).toEqual({ error: 'github unavailable' });
      // The cause goes to the log, not the body.
      expect(errorLog).toHaveBeenCalled();
      // The fake recorded the attempt, but nothing persisted: read back and
      // the job is STILL confirmed with no URL. A failed side effect leaves
      // no half-state behind.
      expect(faults.forkAndOpenPullRequest.length).toBe(1);
      const read = await get(`/jobs/${jobId}`, scripted.baseUrl);
      const readBack = (await read.json()) as Record<string, unknown>;
      expect(readBack.status).toBe('confirmed');
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
    const faults = emptyRecordings();
    const scripted = await startWith(new FailingJobRepository(), recordingFake(faults));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await fetch(`${scripted.baseUrl}/jobs/j-any/pull-request`, { method: 'POST' });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'storage unavailable' });
      expect(errorLog).toHaveBeenCalled();
      // Storage died before the state machine was even consulted; github
      // never heard about it.
      expect(faults.forkAndOpenPullRequest.length).toBe(0);
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
        { id: 'j-corrupt', buyerDid: BUYER_DID, agentDid: AGENT_DID, repository: 'buyer/target-repo', brief: 'Fix the login bug' },
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
    const faults = emptyRecordings();
    const scripted = await startWith(new ScriptedRow(), recordingFake(faults));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await fetch(`${scripted.baseUrl}/jobs/j-corrupt/pull-request`, { method: 'POST' });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal error' });
      expect(errorLog).toHaveBeenCalled();
      expect(faults.forkAndOpenPullRequest.length).toBe(0);
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });
});

// Invariant 1 and Gate 2, on their own server: what the adapter surface
// offers a caller at all, and what a stranger can verify from the public PR
// artifacts without ever calling this service.
describe('pull-request, invariant 1 and Gate 2 (R-10)', () => {
  const recorded = emptyRecordings();
  let prJobId: string;
  let prBriefHash: unknown;
  let confirmedSpecHash: unknown;
  let call: ForkAndOpenPullRequestInput;

  beforeAll(async () => {
    ({ server, baseUrl } = await startWith(new MemoryJobRepository(), recordingFake(recorded)));
    const { jobId, briefHash } = await openDraft('Fix the login bug');
    prJobId = jobId;
    prBriefHash = briefHash;
    const confirmedBody = await walkToConfirm(jobId);
    confirmedSpecHash = confirmedBody.specHash;

    const pr = await post(`/jobs/${jobId}/pull-request`);
    expect(pr.status).toBe(200);
    expect(recorded.forkAndOpenPullRequest.length).toBe(1);
    call = forkCall(recorded, 0);
  });

  afterAll(() => {
    server.close();
  });

  it('the adapter surface offers reads plus exactly one fork-and-PR action', () => {
    // The whole interface, enumerated: there is no method that pushes a
    // branch to an arbitrary target, no method that edits someone else's
    // repository - by construction of the type, not by discipline.
    const real = createGithubAdapter();
    expect(Object.keys(real).sort()).toEqual([
      'forkAndOpenPullRequest',
      'getMergeCommitSignature',
      'getPublicGist',
      'getPullRequest',
    ]);
    // Every method except forkAndOpenPullRequest is still an honest stub
    // against the real adapter. The stubs throw synchronously, so the
    // assertion wraps the call itself rather than awaiting a rejection.
    const ref: PullRequestRef = { owner: 'o', repo: 'r', number: 1 };
    expect(() => real.getPullRequest(ref)).toThrow(NotImplementedError);
    expect(() => real.getMergeCommitSignature(ref)).toThrow(NotImplementedError);
    expect(() => real.getPublicGist({ id: 'x' })).toThrow(NotImplementedError);

    // And this route used none of them: it read nothing from github, it
    // only asked for the fork.
    expect(recorded.getPullRequest.length).toBe(0);
    expect(recorded.getMergeCommitSignature.length).toBe(0);
    expect(recorded.getPublicGist.length).toBe(0);
  });

  it('no parameter anywhere names a repository to WRITE to', () => {
    // The accept line's "the token used has no write permission on the
    // target", in its strongest available form while no token subsystem
    // exists: the one mutating call carries only the source to read, so no
    // credential could aim it at buyer/target-repo. What comes back points
    // at the fork - a different owner than the source - which is where the
    // job's stored URL goes.
    expect(Object.keys(call).sort()).toEqual(['body', 'branch', 'sourceOwner', 'sourceRepo', 'title']);
    expect(call.sourceOwner).toBe('buyer');
    expect(call.sourceOwner).not.toBe(FORK_OWNER);
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



