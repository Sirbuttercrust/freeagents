// R-11 (#18): observe the pull request's merge from GitHub's API and
// complete the job, driven end to end over HTTP.
//
// THE accept line this issue exists to prove (ENT-7.1): the completion fact
// - mergeCommit and mergedAt - comes from what GitHub reports, never from
// either party's claim. Every test scripts what the fake github adapter
// reports and checks that the job only ever completes when that report says
// merged.
//
// runExchange's storage-fault legs are NOT re-covered per route:
// tests/api/job-criteria.test.ts pins each leg of that shared skeleton. The
// legs new to THIS route - the state pre-check, github's three answers,
// storage faults on complete, and the corrupted-status leg - are covered
// here, mirroring tests/api/job-pull-request.test.ts's structure.
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import type { GithubAdapter, PullRequestRef, PullRequestSummary } from '../../src/adapters/github/types.js';
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import {
  MemoryAgentRepository,
  MemoryJobRepository,
  MemoryOperatorRepository,
} from '../../src/adapters/storage/memory.js';
import type { JobRepository } from '../../src/adapters/storage/types.js';
import { createJob, type Job, type JobStatus } from '../../src/domain/job.js';

const AGENT_DID = 'did:abt:agent-merge';
const BUYER_DID = 'did:abt:buyer-merge';
const FORK_OWNER = 'freeagents-platform';
const FORK_REPO = 'target-repo';
const PR_NUMBER = 7;
const MERGE_SHA = 'merge-commit-sha-abc123';
const MERGED_AT = new Date('2026-08-20T12:00:00Z');
const proposal = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
];

interface RecordedCalls {
  getPullRequest: PullRequestRef[];
}

function emptyRecordings(): RecordedCalls {
  return { getPullRequest: [] };
}

// Only getPullRequest and forkAndOpenPullRequest ever resolve; the other two
// reject with the same honest shape as the real adapter, matching
// tests/api/job-pull-request.test.ts's fake.
function fakeGithub(
  recorded: RecordedCalls,
  script: (ref: PullRequestRef) => Promise<PullRequestSummary>,
): GithubAdapter {
  return {
    getPullRequest: (ref) => {
      recorded.getPullRequest.push(ref);
      return script(ref);
    },
    getMergeCommitSignature: () => Promise.reject(new NotImplementedError('github', 'getMergeCommitSignature')),
    getPublicGist: () => Promise.reject(new NotImplementedError('github', 'getPublicGist')),
    // Every job in this file walks through the same fork, so the fake merge
    // route can always parse the ref straight back out of pullRequestUrl.
    forkAndOpenPullRequest: () => Promise.resolve({ owner: FORK_OWNER, repo: FORK_REPO, number: PR_NUMBER }),
  };
}

function mergedGithub(recorded: RecordedCalls): GithubAdapter {
  return fakeGithub(recorded, (ref) =>
    Promise.resolve({ ref, state: 'merged', mergeCommitSha: MERGE_SHA, mergedAt: MERGED_AT, headSha: 'head-sha-1' }),
  );
}

function openGithub(recorded: RecordedCalls): GithubAdapter {
  return fakeGithub(recorded, (ref) =>
    Promise.resolve({ ref, state: 'open', mergeCommitSha: null, mergedAt: null, headSha: 'head-sha-1' }),
  );
}

function closedGithub(recorded: RecordedCalls): GithubAdapter {
  return fakeGithub(recorded, (ref) =>
    Promise.resolve({ ref, state: 'closed', mergeCommitSha: null, mergedAt: null, headSha: 'head-sha-1' }),
  );
}

function rejectingGithub(recorded: RecordedCalls): GithubAdapter {
  return fakeGithub(recorded, () => Promise.reject(new Error('connection refused by github')));
}

// A row already in submitted, with a URL in the exact shape submitPullRequest
// itself writes, so the route's own regex parses it. Used by the scripted
// legs below, which script storage or the row directly rather than walking
// the whole HTTP exchange.
function submittedJob(id: string): Job {
  return {
    ...createJob(
      { id, buyerDid: BUYER_DID, agentDid: AGENT_DID, repository: 'buyer/target-repo', brief: 'Fix the login bug' },
      new Date('2026-01-01T00:00:00Z'),
    ),
    status: 'submitted',
    pullRequestUrl: `https://github.com/${FORK_OWNER}/${FORK_REPO}/pull/${PR_NUMBER}`,
    submittedAt: new Date('2026-01-02T00:00:00Z'),
  };
}

let server: Server;
let baseUrl: string;

async function post(path: string, body: unknown = {}, base: string = baseUrl): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function get(path: string, base: string = baseUrl): Promise<Response> {
  return fetch(`${base}${path}`);
}

async function startWith(repo: JobRepository, github: GithubAdapter): Promise<{ server: Server; baseUrl: string }> {
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: AGENT_DID,
    operatorDid: 'did:abt:op-merge',
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

async function openDraft(brief: string, base: string = baseUrl): Promise<string> {
  const created = await post(
    '/jobs',
    { buyerDid: BUYER_DID, agentDid: AGENT_DID, repository: 'buyer/target-repo', brief },
    base,
  );
  expect(created.status).toBe(201);
  const body = (await created.json()) as Record<string, unknown>;
  return String(body.id);
}

// One job walked draft -> submitted over HTTP: propose, accept both, confirm,
// open the pull request. Returns the submitted body so the merge tests can
// compare against it.
async function walkToSubmitted(jobId: string, base: string = baseUrl): Promise<Record<string, unknown>> {
  expect((await post(`/jobs/${jobId}/criteria`, { criteria: proposal }, base)).status).toBe(200);
  expect((await post(`/jobs/${jobId}/criteria/0/accept`, {}, base)).status).toBe(200);
  expect((await post(`/jobs/${jobId}/criteria/1/accept`, {}, base)).status).toBe(200);
  expect((await post(`/jobs/${jobId}/confirm`, {}, base)).status).toBe(200);
  const pr = await post(`/jobs/${jobId}/pull-request`, {}, base);
  expect(pr.status).toBe(200);
  return (await pr.json()) as Record<string, unknown>;
}

// A completed job projects the submitted keyset plus exactly mergeCommit and
// mergedAt (app.ts's jobProjection comment pins the same claim).
const COMPLETED_KEYS = [
  'agentDid',
  'brief',
  'briefHash',
  'buyerDid',
  'confirmedAt',
  'createdAt',
  'criteria',
  'id',
  'mergeCommit',
  'mergedAt',
  'pullRequestUrl',
  'repository',
  'specHash',
  'status',
  'submittedAt',
];

describe('job merge (R-11)', () => {
  const jobRepo = new MemoryJobRepository();
  const recorded = emptyRecordings();
  // Set by the happy-path walk; the lock test posts that same id again.
  let happyJobId: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startWith(jobRepo, mergedGithub(recorded)));
  });

  afterAll(() => {
    server.close();
  });

  it('walks submitted -> merge on ONE row and projects the completed keys', async () => {
    happyJobId = await openDraft('Fix the login bug on the checkout page');
    const submittedBody = await walkToSubmitted(happyJobId);
    expect(submittedBody.status).toBe('submitted');

    const merge = await post(`/jobs/${happyJobId}/merge`);
    expect(merge.status).toBe(200);
    const mergedBody = (await merge.json()) as Record<string, unknown>;
    expect(mergedBody.id).toBe(happyJobId);
    expect(mergedBody.status).toBe('completed');
    // The values came from github, not this service's clock.
    expect(mergedBody.mergeCommit).toBe(MERGE_SHA);
    expect(mergedBody.mergedAt).toBe(MERGED_AT.toISOString());
    expect(Object.keys(mergedBody).sort()).toEqual(COMPLETED_KEYS);

    const read = await get(`/jobs/${happyJobId}`);
    expect(await read.json()).toEqual(mergedBody);
    expect(recorded.getPullRequest.length).toBe(1);
  });

  it('answers 409 on an already-completed job, without observing github a second time', async () => {
    const again = await post(`/jobs/${happyJobId}/merge`);
    expect(again.status).toBe(409);
    // The terminal state is checked before github is asked again: the count
    // stays at the one call the happy-path walk made.
    expect(recorded.getPullRequest.length).toBe(1);
  });

  it('answers 404 for an unknown id, with zero adapter or storage-complete calls', async () => {
    const before = recorded.getPullRequest.length;
    const completeSpy = vi.spyOn(jobRepo, 'complete');
    const nowhere = await post('/jobs/j-nowhere/merge');
    expect(nowhere.status).toBe(404);
    expect(await nowhere.json()).toEqual({ error: 'not found' });
    expect(recorded.getPullRequest.length).toBe(before);
    expect(completeSpy).not.toHaveBeenCalled();
    completeSpy.mockRestore();
  });

  it('answers 409 for a fresh draft, without asking github once', async () => {
    const draftId = await openDraft('A draft nobody confirmed');
    const before = recorded.getPullRequest.length;

    const early = await post(`/jobs/${draftId}/merge`);
    expect(early.status).toBe(409);
    expect(((await early.json()) as { error: string }).error).toContain('status "draft"');
    expect(recorded.getPullRequest.length).toBe(before);
  });
});

// The github-answer and storage-fault legs each need a server whose adapter
// or repository misbehaves in one specific way, so they script their own -
// the same pattern tests/api/job-pull-request.test.ts uses.
describe('job merge, faulted legs (R-11)', () => {
  it('answers 409 with the open wording when github reports the PR still open, and records nothing', async () => {
    const faults = emptyRecordings();
    const scripted = await startWith(new MemoryJobRepository(), openGithub(faults));
    try {
      const jobId = await openDraft('A PR still under review', scripted.baseUrl);
      const submittedBody = await walkToSubmitted(jobId, scripted.baseUrl);
      expect(submittedBody.status).toBe('submitted');

      const merge = await post(`/jobs/${jobId}/merge`, {}, scripted.baseUrl);
      expect(merge.status).toBe(409);
      expect(((await merge.json()) as { error: string }).error).toBe('pull request is open; it has not merged yet');

      const read = await get(`/jobs/${jobId}`, scripted.baseUrl);
      const readBack = (await read.json()) as Record<string, unknown>;
      expect(readBack.status).toBe('submitted');
      expect(readBack.mergeCommit).toBeUndefined();
      expect(readBack.mergedAt).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('answers 409 with the closed wording when github reports the PR closed unmerged', async () => {
    const faults = emptyRecordings();
    const scripted = await startWith(new MemoryJobRepository(), closedGithub(faults));
    try {
      const jobId = await openDraft('A PR that was closed unmerged', scripted.baseUrl);
      await walkToSubmitted(jobId, scripted.baseUrl);

      const merge = await post(`/jobs/${jobId}/merge`, {}, scripted.baseUrl);
      expect(merge.status).toBe(409);
      expect(((await merge.json()) as { error: string }).error).toBe(
        'pull request is closed without merging; it cannot merge',
      );

      const read = await get(`/jobs/${jobId}`, scripted.baseUrl);
      const readBack = (await read.json()) as Record<string, unknown>;
      expect(readBack.status).toBe('submitted');
    } finally {
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('answers 503 when github fails, and logs the cause', async () => {
    const faults = emptyRecordings();
    const scripted = await startWith(new MemoryJobRepository(), rejectingGithub(faults));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const jobId = await openDraft('A PR github cannot be reached for', scripted.baseUrl);
      await walkToSubmitted(jobId, scripted.baseUrl);

      const merge = await post(`/jobs/${jobId}/merge`, {}, scripted.baseUrl);
      expect(merge.status).toBe(503);
      expect(await merge.json()).toEqual({ error: 'github unavailable' });
      expect(errorLog).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('answers 404 when the row vanishes between the read and the write', async () => {
    const faults = emptyRecordings();
    const row = submittedJob('j-vanish');
    class VanishingCompleteRepository implements JobRepository {
      async create(): Promise<never> {
        throw new Error('unreachable');
      }
      async update(): Promise<never> {
        throw new Error('unreachable');
      }
      async findById(): Promise<Job> {
        return row;
      }
      async complete(): Promise<null> {
        return null;
      }
      async findCompletedByJobId(): Promise<null> {
        return null;
      }
    }
    const scripted = await startWith(new VanishingCompleteRepository(), mergedGithub(faults));
    try {
      const merge = await post(`/jobs/${row.id}/merge`, {}, scripted.baseUrl);
      expect(merge.status).toBe(404);
      expect(await merge.json()).toEqual({ error: 'not found' });
    } finally {
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('answers 503 when storage fails to persist the completion, and logs the cause', async () => {
    const faults = emptyRecordings();
    const row = submittedJob('j-throw');
    const failure = new Error('connection refused');
    class ThrowingCompleteRepository implements JobRepository {
      async create(): Promise<never> {
        throw new Error('unreachable');
      }
      async update(): Promise<never> {
        throw new Error('unreachable');
      }
      async findById(): Promise<Job> {
        return row;
      }
      async complete(): Promise<never> {
        throw failure;
      }
      async findCompletedByJobId(): Promise<null> {
        return null;
      }
    }
    const scripted = await startWith(new ThrowingCompleteRepository(), mergedGithub(faults));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const merge = await post(`/jobs/${row.id}/merge`, {}, scripted.baseUrl);
      expect(merge.status).toBe(503);
      expect(await merge.json()).toEqual({ error: 'storage unavailable' });
      expect(errorLog).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('fails closed on a corrupted status instead of completing', async () => {
    // No honest API path produces a status outside the state machine's own
    // enum, so the only witness is a planted row - the well-formed URL
    // proves the 500 comes from completeJob's validator, not the URL guard.
    const row: Job = { ...submittedJob('j-corrupt-merge'), status: 'corrupted' as JobStatus };
    class ScriptedRow implements JobRepository {
      async create(): Promise<never> {
        throw new Error('unreachable');
      }
      async update(): Promise<never> {
        throw new Error('unreachable');
      }
      async findById(): Promise<Job> {
        return row;
      }
      async complete(): Promise<never> {
        throw new Error('unreachable');
      }
      async findCompletedByJobId(): Promise<null> {
        return null;
      }
    }
    const faults = emptyRecordings();
    const scripted = await startWith(new ScriptedRow(), mergedGithub(faults));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const merge = await post(`/jobs/${row.id}/merge`, {}, scripted.baseUrl);
      expect(merge.status).toBe(500);
      expect(await merge.json()).toEqual({ error: 'internal error' });
      expect(errorLog).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });
});
