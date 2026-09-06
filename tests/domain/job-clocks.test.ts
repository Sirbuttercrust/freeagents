// P4: the three pure clocks and applyLapses (brief section 4). Every
// assertion here fails without expireUnstaged, lapseAtStaged,
// deemCompleted and applyLapses in src/domain/job.ts. Each clock is a
// pure function of stored timestamps and an injected `now` -- no timers,
// no cron, nothing that wakes up on its own. Boundary-tested at one
// second before and one second after, and each pinned idempotent.
import { describe, expect, it } from 'vitest';
import {
  applyLapses,
  createJob,
  deemCompleted,
  expireUnstaged,
  JobTransitionError,
  lapseAtStaged,
  stageWork,
  type Job,
} from '../../src/domain/job.js';

const CONFIRMED_AT = new Date('2026-01-01T00:00:00Z');
const THIRTY_DAYS_MS = 30 * 86_400_000;
const SEVEN_DAYS_MS = 7 * 86_400_000;

function baseJob(overrides: Partial<Job> = {}): Job {
  return {
    ...createJob(
      { id: 'job_1', buyerDid: 'did:example:buyer', agentDid: 'did:example:agent', repository: 'buyer/target-repo', brief: 'Fix the login bug' },
      new Date('2025-12-01T00:00:00Z'),
    ),
    status: 'confirmed',
    confirmedAt: CONFIRMED_AT,
    priceUsd: '500.00',
    rail: 'abt',
    priceAcceptedByBuyer: true,
    priceAcceptedByAgent: true,
    criteria: [{ text: 'Login works', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
    ...overrides,
  };
}

describe('expireUnstaged: confirmed with no staging, 30 days after confirmedAt', () => {
  it('one second before the deadline, the job is unchanged', () => {
    const now = new Date(CONFIRMED_AT.getTime() + THIRTY_DAYS_MS - 1000);
    const job = baseJob();
    expect(expireUnstaged(job, now)).toEqual(job);
  });

  it('one second after the deadline, the job becomes expired_unstaged', () => {
    const now = new Date(CONFIRMED_AT.getTime() + THIRTY_DAYS_MS + 1000);
    const result = expireUnstaged(baseJob(), now);
    expect(result.status).toBe('expired_unstaged');
  });

  it('exactly at the deadline, the job is not yet expired (strictly after)', () => {
    const now = new Date(CONFIRMED_AT.getTime() + THIRTY_DAYS_MS);
    const result = expireUnstaged(baseJob(), now);
    expect(result.status).toBe('confirmed');
  });

  it('refuses on any status other than confirmed: returns the job unchanged', () => {
    const proposed = baseJob({ status: 'proposed', confirmedAt: null });
    const now = new Date(CONFIRMED_AT.getTime() + THIRTY_DAYS_MS + 1000);
    expect(expireUnstaged(proposed, now)).toEqual(proposed);
  });

  it('is idempotent: applying it twice past the deadline gives the same result', () => {
    const now = new Date(CONFIRMED_AT.getTime() + THIRTY_DAYS_MS + 1000);
    const once = expireUnstaged(baseJob(), now);
    const twice = expireUnstaged(once, now);
    expect(twice).toEqual(once);
  });
});

describe('lapseAtStaged: staged with no balance settled, 7 days after stagedAt', () => {
  const stagedAt = new Date('2026-01-10T00:00:00Z');
  const stagedJob = (): Job => stageWork(baseJob(), 'abc123def', stagedAt);

  it('one second before the deadline, the job is unchanged', () => {
    const now = new Date(stagedAt.getTime() + SEVEN_DAYS_MS - 1000);
    const job = stagedJob();
    expect(lapseAtStaged(job, now)).toEqual(job);
  });

  it('one second after the deadline, the job becomes closed_unpaid', () => {
    const now = new Date(stagedAt.getTime() + SEVEN_DAYS_MS + 1000);
    const result = lapseAtStaged(stagedJob(), now);
    expect(result.status).toBe('closed_unpaid');
  });

  it('exactly at the deadline, the job has not yet lapsed', () => {
    const now = new Date(stagedAt.getTime() + SEVEN_DAYS_MS);
    const result = lapseAtStaged(stagedJob(), now);
    expect(result.status).toBe('staged');
  });

  it('refuses on any status other than staged: returns the job unchanged', () => {
    const confirmed = baseJob();
    const now = new Date(stagedAt.getTime() + SEVEN_DAYS_MS + 1000);
    expect(lapseAtStaged(confirmed, now)).toEqual(confirmed);
  });

  it('is idempotent: applying it twice past the deadline gives the same result', () => {
    const now = new Date(stagedAt.getTime() + SEVEN_DAYS_MS + 1000);
    const once = lapseAtStaged(stagedJob(), now);
    const twice = lapseAtStaged(once, now);
    expect(twice).toEqual(once);
  });

  it('the code never leaves staging: closed_unpaid carries the same stagedCommit', () => {
    const now = new Date(stagedAt.getTime() + SEVEN_DAYS_MS + 1000);
    const result = lapseAtStaged(stagedJob(), now);
    expect(result.stagedCommit).toBe('abc123def');
  });
});

describe('deemCompleted: submitted neither merged nor closed, 7 days after submittedAt', () => {
  const submittedAt = new Date('2026-01-10T00:00:00Z');
  const submittedJob = (): Job =>
    baseJob({
      status: 'submitted',
      pullRequestUrl: 'https://github.com/freeagents-platform/target-repo/pull/1',
      submittedAt,
      deadline: new Date(submittedAt.getTime() + 30 * 86_400_000),
    });

  it('one second before the deadline, the job is unchanged', () => {
    const now = new Date(submittedAt.getTime() + SEVEN_DAYS_MS - 1000);
    const job = submittedJob();
    expect(deemCompleted(job, now)).toEqual(job);
  });

  it('one second after the deadline, the job becomes deemed_completed', () => {
    const now = new Date(submittedAt.getTime() + SEVEN_DAYS_MS + 1000);
    const result = deemCompleted(submittedJob(), now);
    expect(result.status).toBe('deemed_completed');
  });

  it('exactly at the deadline, the job has not yet been deemed complete', () => {
    const now = new Date(submittedAt.getTime() + SEVEN_DAYS_MS);
    const result = deemCompleted(submittedJob(), now);
    expect(result.status).toBe('submitted');
  });

  it('refuses on any status other than submitted: returns the job unchanged', () => {
    const staged = stageWork(baseJob(), 'abc123def', new Date('2026-01-05T00:00:00Z'));
    const now = new Date(submittedAt.getTime() + SEVEN_DAYS_MS + 1000);
    expect(deemCompleted(staged, now)).toEqual(staged);
  });

  it('is idempotent: applying it twice past the deadline gives the same result', () => {
    const now = new Date(submittedAt.getTime() + SEVEN_DAYS_MS + 1000);
    const once = deemCompleted(submittedJob(), now);
    const twice = deemCompleted(once, now);
    expect(twice).toEqual(once);
  });

  it('never issues a credential: deemed completion carries no mergeCommit or mergedAt (later card\'s job)', () => {
    const now = new Date(submittedAt.getTime() + SEVEN_DAYS_MS + 1000);
    const result = deemCompleted(submittedJob(), now);
    expect(result.mergeCommit).toBeNull();
    expect(result.mergedAt).toBeNull();
  });
});

describe('applyLapses: runs all three clocks in order, unchanged when none applies', () => {
  it('returns the job unchanged (a fresh object, but equal) when nothing has lapsed', () => {
    const job = baseJob();
    const now = new Date(CONFIRMED_AT.getTime() + 1000);
    expect(applyLapses(job, now)).toEqual(job);
  });

  it('reports expireUnstaged truthfully on a confirmed job past 30 days', () => {
    const now = new Date(CONFIRMED_AT.getTime() + THIRTY_DAYS_MS + 1000);
    expect(applyLapses(baseJob(), now).status).toBe('expired_unstaged');
  });

  it('reports lapseAtStaged truthfully on a staged job past 7 days', () => {
    const stagedAt = new Date('2026-01-10T00:00:00Z');
    const staged = stageWork(baseJob(), 'abc123def', stagedAt);
    const now = new Date(stagedAt.getTime() + SEVEN_DAYS_MS + 1000);
    expect(applyLapses(staged, now).status).toBe('closed_unpaid');
  });

  it('reports deemCompleted truthfully on a submitted job past 7 days', () => {
    const submittedAt = new Date('2026-01-10T00:00:00Z');
    const submitted = baseJob({
      status: 'submitted',
      pullRequestUrl: 'https://github.com/freeagents-platform/target-repo/pull/1',
      submittedAt,
      deadline: new Date(submittedAt.getTime() + 30 * 86_400_000),
    });
    const now = new Date(submittedAt.getTime() + SEVEN_DAYS_MS + 1000);
    expect(applyLapses(submitted, now).status).toBe('deemed_completed');
  });

  it('is idempotent end to end', () => {
    const now = new Date(CONFIRMED_AT.getTime() + THIRTY_DAYS_MS + 1000);
    const once = applyLapses(baseJob(), now);
    const twice = applyLapses(once, now);
    expect(twice).toEqual(once);
  });

  it('never throws JobTransitionError: a job in an unaffected status passes through silently', () => {
    const declined = baseJob({ status: 'declined' });
    expect(() => applyLapses(declined, new Date())).not.toThrow(JobTransitionError);
    expect(applyLapses(declined, new Date())).toEqual(declined);
  });
});
