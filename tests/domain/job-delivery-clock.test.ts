// The delivery clock: a hire paid in full whose pull request never opens
// ends paid_undelivered, 7 days after the remainder settles. Every
// assertion here fails without lapseUndelivered, the status, its
// transitions, its place in applyLapses, its owner-side count and its job
// list entries. Expected values are built from literals, never from the
// object under test.
import { describe, expect, it } from 'vitest';
import {
  applyLapses,
  createJob,
  isTerminal,
  lapseAtStaged,
  lapseUndelivered,
  requestRedo,
  stageWork,
  UNDELIVERED_AFTER_PAID_DAYS,
  validateJobTransition,
  type Job,
  type JobStatus,
} from '../../src/domain/job.js';
import { buyerConductRecord, operatorConductRecord } from '../../src/domain/buyer-conduct.js';
import { ALL_JOB_STATUSES, jobListBucketOf, jobListDateOf } from '../../src/domain/job-list.js';

const DAY_MS = 86_400_000;
const STAGED_AT = new Date('2026-01-10T00:00:00Z');
const SETTLED_AT = new Date('2026-01-12T00:00:00Z');
const WINDOW_END = new Date(SETTLED_AT.getTime() + 7 * DAY_MS);

function confirmedJob(overrides: Partial<Job> = {}): Job {
  return {
    ...createJob(
      { id: 'job_1', buyerDid: 'did:example:buyer', agentDid: 'did:example:agent', repository: 'buyer/target-repo', brief: 'Fix the login bug' },
      new Date('2025-12-01T00:00:00Z'),
    ),
    status: 'confirmed',
    confirmedAt: new Date('2026-01-01T00:00:00Z'),
    priceUsd: '500.00',
    rail: 'abt',
    priceAcceptedByBuyer: true,
    priceAcceptedByAgent: true,
    criteria: [{ text: 'Login works', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
    ...overrides,
  };
}

const stagedJob = (overrides: Partial<Job> = {}): Job => ({
  ...stageWork(confirmedJob(), 'abc123def', STAGED_AT),
  ...overrides,
});

const redoJob = (): Job =>
  requestRedo(stageWork(confirmedJob(), 'abc123def', STAGED_AT), 0, new Date('2026-01-11T00:00:00Z'));

const submittedJob = (): Job => ({ ...stagedJob(), status: 'submitted', submittedAt: new Date('2026-01-11T00:00:00Z') });

// A job in `status` that has been through the whole staged path, built by
// copying the staged job and changing only the status.
const inStatus = (status: JobStatus): Job => ({ ...stagedJob(), status });

const msAfterEnd = (ms: number): Date => new Date(WINDOW_END.getTime() + ms);

describe('UNDELIVERED_AFTER_PAID_DAYS', () => {
  it('is 7', () => {
    expect(UNDELIVERED_AFTER_PAID_DAYS).toBe(7);
  });
});

describe('lapseUndelivered: 7 days after the remainder settles, a staged or redo_requested job ends paid_undelivered', () => {
  it('a staged job settled 7 days and 1 ms ago becomes paid_undelivered, with nothing else changed', () => {
    const job = stagedJob();
    const before = structuredClone(job);
    const result = lapseUndelivered(job, msAfterEnd(1), SETTLED_AT);
    expect(result).toEqual({ ...before, status: 'paid_undelivered' });
    expect(job).toEqual(before);
  });

  it('a staged job settled exactly 7 days ago is unchanged', () => {
    const job = stagedJob();
    const before = structuredClone(job);
    expect(lapseUndelivered(job, WINDOW_END, SETTLED_AT)).toEqual(before);
  });

  it('a redo_requested job settled 7 days and 1 ms ago becomes paid_undelivered', () => {
    const job = redoJob();
    const before = structuredClone(job);
    expect(lapseUndelivered(job, msAfterEnd(1), SETTLED_AT)).toEqual({ ...before, status: 'paid_undelivered' });
  });

  it('a redo_requested job settled exactly 7 days ago is unchanged', () => {
    const job = redoJob();
    const before = structuredClone(job);
    expect(lapseUndelivered(job, WINDOW_END, SETTLED_AT)).toEqual(before);
  });

  it('a job already paid_undelivered is unchanged when the clock runs again', () => {
    const once = lapseUndelivered(stagedJob(), msAfterEnd(1), SETTLED_AT);
    const before = structuredClone(once);
    expect(lapseUndelivered(once, msAfterEnd(DAY_MS), SETTLED_AT)).toEqual(before);
  });
});

describe('lapseUndelivered: no settled time means no clock', () => {
  it('a staged job with no settled time is unchanged however old', () => {
    const job = stagedJob();
    const before = structuredClone(job);
    expect(lapseUndelivered(job, new Date('2030-01-01T00:00:00Z'), null)).toEqual(before);
  });

  it('a redo_requested job with no settled time is unchanged however old', () => {
    const job = redoJob();
    const before = structuredClone(job);
    expect(lapseUndelivered(job, new Date('2030-01-01T00:00:00Z'), null)).toEqual(before);
  });

  it('control: the unpaid closing still fires when the remainder is unsettled', () => {
    const job = stagedJob();
    const before = structuredClone(job);
    const now = new Date(STAGED_AT.getTime() + 7 * DAY_MS + 1);
    expect(lapseAtStaged(job, now, false)).toEqual({ ...before, status: 'closed_unpaid' });
  });
});

describe('lapseUndelivered: only a job waiting on its pull request is touched', () => {
  const late = msAfterEnd(DAY_MS);

  it('a submitted job is unchanged', () => {
    const job = submittedJob();
    const before = structuredClone(job);
    expect(lapseUndelivered(job, late, SETTLED_AT)).toEqual(before);
  });

  it('a confirmed job is unchanged', () => {
    const job = confirmedJob();
    const before = structuredClone(job);
    expect(lapseUndelivered(job, late, SETTLED_AT)).toEqual(before);
  });

  it('a completed job is unchanged', () => {
    const job = inStatus('completed');
    const before = structuredClone(job);
    expect(lapseUndelivered(job, late, SETTLED_AT)).toEqual(before);
  });
});

describe('lapseUndelivered: the redo extension does not move the deadline', () => {
  it('with stagedLapseExtensionDays of 3, 7 days and 1 ms after settling still ends paid_undelivered', () => {
    const job = stagedJob({ stagedLapseExtensionDays: 3 });
    const before = structuredClone(job);
    expect(lapseUndelivered(job, msAfterEnd(1), SETTLED_AT)).toEqual({ ...before, status: 'paid_undelivered' });
  });

  it('with stagedLapseExtensionDays of 3, exactly 7 days after settling is still inside', () => {
    const job = stagedJob({ stagedLapseExtensionDays: 3 });
    const before = structuredClone(job);
    expect(lapseUndelivered(job, WINDOW_END, SETTLED_AT)).toEqual(before);
  });
});

describe('applyLapses with the settled time', () => {
  // Staged 40 days before the check, settled 1 day before it: the unpaid
  // clock would have closed this job long ago if it were consulted.
  const NOW = new Date('2026-03-01T00:00:00Z');
  const longStaged = (): Job => stagedJob({ stagedAt: new Date(NOW.getTime() - 40 * DAY_MS) });

  it('a settled time with remainderIsSettled false never closes the job unpaid', () => {
    const job = longStaged();
    const before = structuredClone(job);
    const settledAt = new Date(NOW.getTime() - DAY_MS);
    expect(applyLapses(job, NOW, false, settledAt)).toEqual(before);
  });

  it('a settled time more than 7 days old ends the job paid_undelivered, not closed_unpaid', () => {
    const job = longStaged();
    const before = structuredClone(job);
    const settledAt = new Date(NOW.getTime() - 7 * DAY_MS - 1);
    expect(applyLapses(job, NOW, false, settledAt)).toEqual({ ...before, status: 'paid_undelivered' });
  });

  it('the same settled time with remainderIsSettled true gives the same ending', () => {
    const job = longStaged();
    const before = structuredClone(job);
    const settledAt = new Date(NOW.getTime() - 7 * DAY_MS - 1);
    expect(applyLapses(job, NOW, true, settledAt)).toEqual({ ...before, status: 'paid_undelivered' });
  });

  it('with both defaults a staged job past its unpaid deadline closes unpaid, as before', () => {
    const job = longStaged();
    const before = structuredClone(job);
    expect(applyLapses(job, NOW)).toEqual({ ...before, status: 'closed_unpaid' });
  });

  it('with both defaults a settled staged job is left alone, as before', () => {
    const job = longStaged();
    const before = structuredClone(job);
    expect(applyLapses(job, NOW, true)).toEqual(before);
  });

  it('with both defaults a submitted job inside its review window is unchanged', () => {
    const job = submittedJob();
    const before = structuredClone(job);
    expect(applyLapses(job, new Date('2026-01-12T00:00:00Z'))).toEqual(before);
  });

  it('with both defaults a submitted job past its review window is deemed completed, as before', () => {
    const job = submittedJob();
    const before = structuredClone(job);
    const now = new Date(before.submittedAt!.getTime() + 7 * DAY_MS + 1000);
    expect(applyLapses(job, now)).toEqual({ ...before, status: 'deemed_completed', deemedCompletedAt: now });
  });

  it('a submitted job is never touched by the delivery clock, whatever settled time is passed', () => {
    const job = submittedJob();
    const before = structuredClone(job);
    const now = new Date('2026-01-12T00:00:00Z');
    expect(applyLapses(job, now, true, new Date('2025-01-01T00:00:00Z'))).toEqual(before);
  });
});

describe('paid_undelivered is a final status', () => {
  it('isTerminal is true', () => {
    expect(isTerminal('paid_undelivered')).toBe(true);
  });

  it('every move out of it is refused with the final-status sentence', () => {
    for (const target of ALL_JOB_STATUSES) {
      expect(() => validateJobTransition('paid_undelivered', target)).toThrow(
        'this job is "paid_undelivered", a final status, so it cannot change',
      );
    }
  });

  it('staged and redo_requested may move to it', () => {
    expect(validateJobTransition('staged', 'paid_undelivered')).toBe('paid_undelivered');
    expect(validateJobTransition('redo_requested', 'paid_undelivered')).toBe('paid_undelivered');
  });

  it('confirmed and submitted may not', () => {
    expect(() => validateJobTransition('confirmed', 'paid_undelivered')).toThrow(
      'a job in status "confirmed" cannot move to "paid_undelivered"',
    );
    expect(() => validateJobTransition('submitted', 'paid_undelivered')).toThrow(
      'a job in status "submitted" cannot move to "paid_undelivered"',
    );
  });
});

describe('the conduct records for a paid_undelivered job', () => {
  it('the owner side counts it once, as paidNeverDelivered and nowhere else', () => {
    expect(operatorConductRecord([{ status: 'paid_undelivered', redoRefusedAt: null }])).toEqual({
      deliveredNeverPaid: 0,
      redosRefused: 0,
      walkedAfterDeposit: 0,
      paidNeverDelivered: 1,
    });
  });

  it('the owner side counts none for any other status', () => {
    const others = ALL_JOB_STATUSES.filter((s) => s !== 'paid_undelivered').map((status) => ({ status, redoRefusedAt: null }));
    expect(operatorConductRecord(others).paidNeverDelivered).toBe(0);
  });

  it('the buyer side counts it as confirmed and adds nothing that weighs against the buyer', () => {
    expect(buyerConductRecord([{ status: 'paid_undelivered', confirmedAt: '2026-01-01T00:00:00.000Z' }])).toEqual({
      confirmed: 1,
      walkedAfterConfirm: 0,
      stagedDeclined: 0,
      closedUnpaid: 0,
      merged: 0,
      deemed: 0,
      closedUnmerged: 0,
      citedCloses: 0,
      redosRequested: 0,
      walkedAway: 0,
    });
  });

  it('the buyer side counts it as confirmed from the status alone, with no confirmedAt', () => {
    expect(buyerConductRecord([{ status: 'paid_undelivered', confirmedAt: null }]).confirmed).toBe(1);
  });
});

describe('the job list for paid_undelivered', () => {
  it('lists the status', () => {
    expect(ALL_JOB_STATUSES).toContain('paid_undelivered');
  });

  it('buckets it as notShipped', () => {
    expect(jobListBucketOf('paid_undelivered')).toBe('notShipped');
  });

  it('draws no date for it, even when the job carries every date', () => {
    const at = new Date('2026-01-01T00:00:00Z');
    expect(
      jobListDateOf({
        status: 'paid_undelivered',
        stagedAt: at,
        submittedAt: at,
        confirmedAt: at,
        redoRequestedAt: at,
        mergedAt: at,
        deemedCompletedAt: at,
        citedCloseAt: at,
      }),
    ).toBeNull();
  });
});
