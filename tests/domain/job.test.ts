import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  completeJob,
  confirmSpec,
  createJob,
  decline,
  isTerminal,
  JobError,
  JobTransitionError,
  submitPullRequest,
  validateJobTransition,
} from '../../src/domain/job.js';
import type { Job } from '../../src/domain/job.js';

function proposedJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job_1',
    buyerDid: 'did:example:buyer',
    agentDid: 'did:example:agent',
    repository: 'buyer/target-repo',
    brief: 'Fix the login bug on the checkout page',
    briefHash: 'sha256:brief',
    confirmedSpecHash: null,
    status: 'proposed',
    pullRequestUrl: null,
    confirmedAt: null,
    submittedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('job state machine', () => {
  it('walks proposed -> confirmed -> submitted -> completed', () => {
    const now = new Date('2026-01-02T00:00:00Z');

    const confirmed = confirmSpec(proposedJob(), 'sha256:spec', now);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.confirmedSpecHash).toBe('sha256:spec');
    expect(confirmed.confirmedAt).toBe(now);

    const submitted = submitPullRequest(confirmed, 'https://github.com/buyer/target-repo/pull/1', now);
    expect(submitted.status).toBe('submitted');
    expect(submitted.pullRequestUrl).toBe('https://github.com/buyer/target-repo/pull/1');

    const { job: completed, completedJob } = completeJob(submitted, {
      mergeCommit: 'abc123',
      completedAt: now,
    });
    expect(completed.status).toBe('completed');
    expect(completedJob).toEqual({
      jobId: 'job_1',
      buyerDid: 'did:example:buyer',
      agentDid: 'did:example:agent',
      mergeCommit: 'abc123',
      completedAt: now,
    });
  });

  it('declines from any non-terminal status', () => {
    expect(decline(proposedJob()).status).toBe('declined');
    expect(decline(proposedJob({ status: 'confirmed' })).status).toBe('declined');
    expect(decline(proposedJob({ status: 'submitted' })).status).toBe('declined');
  });

  it('rejects confirming a job that is not proposed', () => {
    const job = proposedJob({ status: 'confirmed' });
    expect(() => confirmSpec(job, 'sha256:spec', new Date())).toThrow(JobTransitionError);
  });

  it('rejects submitting a pull request before the spec is confirmed', () => {
    expect(() => submitPullRequest(proposedJob(), 'https://example.com/pr/1', new Date())).toThrow(
      JobTransitionError,
    );
  });

  it('rejects completing a job that has no open pull request', () => {
    const job = proposedJob({ status: 'confirmed' });
    expect(() => completeJob(job, { mergeCommit: 'abc123', completedAt: new Date() })).toThrow(
      JobTransitionError,
    );
  });

  it('rejects declining a job that already reached a terminal status', () => {
    const completed = proposedJob({ status: 'completed' });
    expect(() => decline(completed)).toThrow(JobTransitionError);
  });

  it('treats completed and declined as terminal, nothing else', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('declined')).toBe(true);
    expect(isTerminal('draft')).toBe(false);
    expect(isTerminal('proposed')).toBe(false);
    expect(isTerminal('confirmed')).toBe(false);
    expect(isTerminal('submitted')).toBe(false);
  });
});

describe('createJob', () => {
  const now = new Date('2026-01-01T00:00:00Z');

  it('opens a draft carrying the brief, with the brief hash of that brief', () => {
    const brief = 'Fix the login bug on the checkout page';
    const job = createJob(
      {
        id: 'job_1',
        buyerDid: 'did:example:buyer',
        agentDid: 'did:example:agent',
        repository: 'buyer/target-repo',
        brief,
      },
      now,
    );

    expect(job.status).toBe('draft');
    expect(job.brief).toBe(brief);
    // Property, not a memorised constant: the hash is recomputed here by the
    // same primitive the implementation calls (see invariant 2 test below
    // for the full normalisation check).
    expect(job.briefHash).toBe('sha256:' + createHash('sha256').update(brief).digest('hex'));
    expect(job.briefHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(job.confirmedSpecHash).toBeNull();
    expect(job.pullRequestUrl).toBeNull();
    expect(job.confirmedAt).toBeNull();
    expect(job.submittedAt).toBeNull();
    expect(job.createdAt).toBe(now);
  });

  it('rejects an empty or whitespace-only brief', () => {
    expect(() =>
      createJob({ id: 'job_1', buyerDid: 'did:example:buyer', agentDid: 'did:example:agent', repository: 'buyer/target-repo', brief: '' }, now),
    ).toThrow(JobError);
    expect(() =>
      createJob({ id: 'job_1', buyerDid: 'did:example:buyer', agentDid: 'did:example:agent', repository: 'buyer/target-repo', brief: '   \n\t ' }, now),
    ).toThrow(JobError);
  });

  it('walks draft -> proposed -> confirmed -> submitted -> completed', () => {
    expect(validateJobTransition('draft', 'proposed')).toBe('proposed');
    expect(validateJobTransition('proposed', 'confirmed')).toBe('confirmed');
    expect(validateJobTransition('confirmed', 'submitted')).toBe('submitted');
    expect(validateJobTransition('submitted', 'completed')).toBe('completed');
  });

  it('rejects skipping ahead from a draft', () => {
    expect(() => validateJobTransition('draft', 'confirmed')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('draft', 'submitted')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('draft', 'completed')).toThrow(JobTransitionError);
  });

  it('declines a draft, and a draft brief is not mutated by any transition function', () => {
    const job = createJob(
      { id: 'job_1', buyerDid: 'did:example:buyer', agentDid: 'did:example:agent', repository: 'buyer/target-repo', brief: 'Fix the login bug on the checkout page' },
      now,
    );

    expect(decline(job).status).toBe('declined');

    // No proposeCriteria exists yet (R-8 owns the criteria exchange), so the
    // first transition that returns a new job object is confirmSpec, walked
    // from the proposed state.
    const confirmed = confirmSpec({ ...job, status: 'proposed' }, 'sha256:spec', now);
    expect(confirmed.brief).toBe(job.brief);
    expect(submitPullRequest(confirmed, 'https://github.com/buyer/target-repo/pull/1', now).brief).toBe(job.brief);
    expect(completeJob(submitPullRequest(confirmed, 'https://github.com/buyer/target-repo/pull/1', now), { mergeCommit: 'abc123', completedAt: now }).job.brief).toBe(job.brief);
    expect(decline(confirmed).brief).toBe(job.brief);
  });
});

// MISSION.md invariant 2, as far as it reaches in R-27: the service issues no
// credential for a job yet, so the verifiable fact it introduces is the brief
// hash. A third party holding the brief must be able to recompute it with
// off-the-shelf tools (node:crypto, openssl, a W3C verifier), without calling
// this service. The digest below is derived inside the test from the same
// documented normalisation the implementation applies; nothing is memorised.
describe('invariant 2: the brief hash is re-computable off-platform', () => {
  it('briefHash is the sha256 of the normalised brief', () => {
    // CRLF endings and trailing line whitespace: what a pasted buyer message
    // most plausibly has.
    const brief = 'Fix the login bug on the checkout page\r\n  ';
    const job = createJob(
      { id: 'job_1', buyerDid: 'did:example:buyer', agentDid: 'did:example:agent', repository: 'buyer/target-repo', brief },
      new Date('2026-01-01T00:00:00Z'),
    );

    // The documented normalisation, applied here independently:
    // \n endings, trailing whitespace stripped per line, no final newline.
    let normalised = brief
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n');
    if (normalised.endsWith('\n')) {
      normalised = normalised.slice(0, -1);
    }
    const expected = 'sha256:' + createHash('sha256').update(normalised).digest('hex');

    expect(job.briefHash).toBe(expected);

    // confirmSpec carries the confirmed spec hash through unchanged, and both
    // digests are plain sha256:<hex> strings: a GitHub API consumer or W3C
    // verifier checks them against the text it holds, no round-trip here.
    const now = new Date('2026-01-02T00:00:00Z');
    const confirmed = confirmSpec({ ...job, status: 'proposed' }, 'sha256:' + createHash('sha256').update('spec').digest('hex'), now);
    expect(confirmed.briefHash).toBe(expected);
    expect(confirmed.briefHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(confirmed.confirmedSpecHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
