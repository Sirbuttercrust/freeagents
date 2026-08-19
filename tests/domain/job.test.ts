import { describe, expect, it } from 'vitest';
import { completeJob, confirmSpec, decline, isTerminal, JobTransitionError, submitPullRequest } from '../../src/domain/job.js';
import type { Job } from '../../src/domain/job.js';

function proposedJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job_1',
    buyerDid: 'did:example:buyer',
    agentDid: 'did:example:agent',
    repository: 'buyer/target-repo',
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
    expect(isTerminal('proposed')).toBe(false);
    expect(isTerminal('confirmed')).toBe(false);
    expect(isTerminal('submitted')).toBe(false);
  });
});
