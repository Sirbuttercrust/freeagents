// B14a: the domain-layer fields the staging repository half of the hire
// loop needs -- stagingRepo (owner/repo under the platform account),
// baseCommit (the base the platform pinned), and stagingRepoDeleteAfter
// (the cleanup policy, recorded not built: a later card's sweep reads
// this field; this card only computes it). No code execution, no clone --
// this file proves the pure functions only.
import { describe, expect, it } from 'vitest';
import {
  computeStagingRepoDeleteAfter,
  createJob,
  STAGING_REPO_CLEANUP_AFTER_DAYS,
} from '../../src/domain/job.js';

describe('Job.stagingRepo and Job.baseCommit: null until the repository exists', () => {
  it('createJob starts with stagingRepo and baseCommit both null', () => {
    const job = createJob(
      { id: 'job_1', buyerDid: 'did:example:buyer', agentDid: 'did:example:agent', repository: 'buyer/target-repo', brief: 'Fix the login bug' },
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(job.stagingRepo).toBeNull();
    expect(job.baseCommit).toBeNull();
    expect(job.stagingRepoDeleteAfter).toBeNull();
  });
});

describe('computeStagingRepoDeleteAfter: 30 days after a terminal state (B14a scope item 5, recorded not built)', () => {
  it('returns a date STAGING_REPO_CLEANUP_AFTER_DAYS after the instant a job became terminal', () => {
    const terminalAt = new Date('2026-02-01T00:00:00Z');
    const deleteAfter = computeStagingRepoDeleteAfter(terminalAt);
    expect(deleteAfter.getTime()).toBe(terminalAt.getTime() + STAGING_REPO_CLEANUP_AFTER_DAYS * 86_400_000);
  });

  it('the constant is 30 days, matching the brief', () => {
    expect(STAGING_REPO_CLEANUP_AFTER_DAYS).toBe(30);
  });
});
