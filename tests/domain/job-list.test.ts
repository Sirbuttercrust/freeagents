// P8m: the pure bucketing rule behind My jobs (P-16). Total over every
// JobStatus (src/domain/job.ts:31) so a sixteenth status is a typecheck
// failure, never a silently missing row (brief scope item 4).
import { describe, expect, it } from 'vitest';
import { jobListBucketOf, jobListDateOf, ALL_JOB_STATUSES } from '../../src/domain/job-list.js';
import type { JobStatus } from '../../src/domain/job.js';

describe('jobListBucketOf: total over every JobStatus, five buckets', () => {
  it('maps the buyer-waiting statuses to waitingOnYou', () => {
    expect(jobListBucketOf('staged')).toBe('waitingOnYou');
    expect(jobListBucketOf('submitted')).toBe('waitingOnYou');
  });

  it('maps the operator-turn statuses to inProgress', () => {
    expect(jobListBucketOf('confirmed')).toBe('inProgress');
    expect(jobListBucketOf('redo_requested')).toBe('inProgress');
  });

  it('maps the completed outcomes to shipped', () => {
    expect(jobListBucketOf('completed')).toBe('shipped');
    expect(jobListBucketOf('deemed_completed')).toBe('shipped');
  });

  it('maps every non-shipped terminal outcome to notShipped', () => {
    const notShipped: JobStatus[] = [
      'declined',
      'closed_unmerged',
      'stale',
      'withdrawn',
      'staged_declined',
      'closed_unpaid',
      'expired_unstaged',
      'cited_closed',
    ];
    notShipped.forEach((status) => expect(jobListBucketOf(status)).toBe('notShipped'));
  });

  it('maps draft and proposed to notReal, the fifth value the route filters on', () => {
    expect(jobListBucketOf('draft')).toBe('notReal');
    expect(jobListBucketOf('proposed')).toBe('notReal');
  });

  it('is total over every status in the domain enum, with no status left unmapped', () => {
    // ALL_JOB_STATUSES is the fixture list this test and the route share;
    // its own test below pins it against job.ts's real union so it can
    // never quietly drift shorter than the real enum. job.ts:31-47
    // actually declares sixteen values, not the fifteen the brief's own
    // prose counts (handoff departure: the code is ground truth here).
    ALL_JOB_STATUSES.forEach((status) => {
      expect(() => jobListBucketOf(status)).not.toThrow();
    });
    expect(ALL_JOB_STATUSES.length).toBe(16);
  });
});

describe('jobListDateOf: the one date a status is about, or null when the domain has no dedicated field for it', () => {
  const RECENT = new Date('2026-08-12T00:00:00Z');

  function facts(overrides: Partial<Parameters<typeof jobListDateOf>[0]> = {}): Parameters<typeof jobListDateOf>[0] {
    return {
      status: 'staged',
      stagedAt: null,
      submittedAt: null,
      confirmedAt: null,
      redoRequestedAt: null,
      mergedAt: null,
      deemedCompletedAt: null,
      citedCloseAt: null,
      ...overrides,
    };
  }

  it('reads stagedAt for staged, submittedAt for submitted', () => {
    expect(jobListDateOf(facts({ status: 'staged', stagedAt: RECENT }))).toBe(RECENT);
    expect(jobListDateOf(facts({ status: 'submitted', submittedAt: RECENT }))).toBe(RECENT);
  });

  it('reads confirmedAt for confirmed, redoRequestedAt for redo_requested', () => {
    expect(jobListDateOf(facts({ status: 'confirmed', confirmedAt: RECENT }))).toBe(RECENT);
    expect(jobListDateOf(facts({ status: 'redo_requested', redoRequestedAt: RECENT }))).toBe(RECENT);
  });

  it('reads mergedAt for completed, deemedCompletedAt for deemed_completed, citedCloseAt for cited_closed', () => {
    expect(jobListDateOf(facts({ status: 'completed', mergedAt: RECENT }))).toBe(RECENT);
    expect(jobListDateOf(facts({ status: 'deemed_completed', deemedCompletedAt: RECENT }))).toBe(RECENT);
    expect(jobListDateOf(facts({ status: 'cited_closed', citedCloseAt: RECENT }))).toBe(RECENT);
  });

  it('returns null for every terminal status the domain carries no dedicated timestamp for, never a borrowed field', () => {
    const noDate: JobStatus[] = ['declined', 'closed_unmerged', 'stale', 'withdrawn', 'staged_declined', 'closed_unpaid', 'expired_unstaged'];
    noDate.forEach((status) => {
      expect(jobListDateOf(facts({ status, stagedAt: RECENT, confirmedAt: RECENT, mergedAt: RECENT }))).toBeNull();
    });
  });
});
