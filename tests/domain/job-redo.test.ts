// P6: the redo at staged (design record, 2026-09-01, row 2). Buyer only,
// once, cites a confirmed criterion index, no price change, extends
// delivery 7 days, operator refusal returns to staged and is recorded.
// Party enforcement (buyer requests, agent refuses) lives at the route
// layer (tests/api/job-redo.test.ts), matching stage/staged-decline's own
// split between a pure domain function and a signed-party gate.
import { describe, expect, it } from 'vitest';
import {
  createJob,
  JobTransitionError,
  JobError,
  RedoAllowanceExhaustedError,
  lapseAtStaged,
  recordStagedDeclined,
  refuseRedo,
  requestRedo,
  stageWork,
  submitPullRequest,
  REDO_LAPSE_EXTENSION_DAYS,
  LAPSE_AT_STAGED_AFTER_DAYS,
  type Job,
} from '../../src/domain/job.js';

function stagedJob(overrides: Partial<Job> = {}): Job {
  const draft = createJob(
    { id: 'job_1', buyerDid: 'did:example:buyer', agentDid: 'did:example:agent', repository: 'buyer/target-repo', brief: 'Fix the login bug' },
    new Date('2026-01-01T00:00:00Z'),
  );
  const confirmed: Job = {
    ...draft,
    status: 'confirmed',
    confirmedSpecHash: 'sha256:spec',
    confirmedAt: new Date('2026-01-02T00:00:00Z'),
    priceUsd: '500.00',
    rail: 'abt',
    priceAcceptedByBuyer: true,
    priceAcceptedByAgent: true,
    criteria: [
      { text: 'Login works', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
      { text: 'Checkout works', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
    ],
  };
  const staged = stageWork(confirmed, 'commit-original', new Date('2026-01-05T00:00:00Z'));
  return { ...staged, ...overrides };
}

describe('requestRedo: staged -> redo_requested, once, cited, no price change', () => {
  it('refuses at any status other than staged', () => {
    const draft = createJob(
      { id: 'job_2', buyerDid: 'did:example:buyer', agentDid: 'did:example:agent', repository: 'buyer/target-repo', brief: 'Fix it' },
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(() => requestRedo(draft, 0, new Date())).toThrow(JobTransitionError);
    expect(() => requestRedo({ ...draft, status: 'confirmed' }, 0, new Date())).toThrow(JobTransitionError);
    expect(() => requestRedo({ ...stagedJob(), status: 'submitted' }, 0, new Date())).toThrow(JobTransitionError);
  });

  it('refuses an index outside the confirmed criteria (a caller error, not a shrug)', () => {
    const job = stagedJob();
    expect(() => requestRedo(job, -1, new Date())).toThrow(JobError);
    expect(() => requestRedo(job, 2, new Date())).toThrow(JobError);
    expect(() => requestRedo(job, 1.5, new Date())).toThrow(JobError);
  });

  it('moves the job to redo_requested, citing the index, consuming the allowance once', () => {
    const job = stagedJob();
    const now = new Date('2026-01-06T00:00:00Z');
    const redone = requestRedo(job, 1, now);
    expect(redone.status).toBe('redo_requested');
    expect(redone.redoRequestedCriterionIndex).toBe(1);
    expect(redone.redoRequestedAt).toBe(now);
    expect(redone.redoUsedCount).toBe(1);
  });

  it('changes no price field: priceUsd, rail, depositPercent and redoAllowance are untouched', () => {
    const job = stagedJob();
    const redone = requestRedo(job, 0, new Date());
    expect(redone.priceUsd).toBe(job.priceUsd);
    expect(redone.rail).toBe(job.rail);
    expect(redone.depositPercent).toBe(job.depositPercent);
    expect(redone.redoAllowance).toBe(job.redoAllowance);
    expect(redone.confirmedSpecHash).toBe(job.confirmedSpecHash);
  });

  it('extends the staged lapse window by REDO_LAPSE_EXTENSION_DAYS, as a stored fact', () => {
    const job = stagedJob();
    const redone = requestRedo(job, 0, new Date());
    expect(redone.stagedLapseExtensionDays).toBe(REDO_LAPSE_EXTENSION_DAYS);
  });

  it('a second request on a job with no allowance left refuses, and does not consume twice', () => {
    const job = stagedJob();
    const once = requestRedo(job, 0, new Date('2026-01-06T00:00:00Z'));
    const backToStaged = refuseRedo(once, new Date('2026-01-07T00:00:00Z'));
    expect(() => requestRedo(backToStaged, 0, new Date('2026-01-08T00:00:00Z'))).toThrow(RedoAllowanceExhaustedError);
    // The refused attempt is not silently accepted: redoUsedCount stays 1.
    expect(backToStaged.redoUsedCount).toBe(1);
  });
});

describe('refuseRedo: redo_requested -> staged, recorded, allowance not restored', () => {
  it('refuses at any status other than redo_requested', () => {
    const job = stagedJob();
    expect(() => refuseRedo(job, new Date())).toThrow(JobTransitionError);
  });

  it('returns the job to staged and records the refusal instant', () => {
    const job = stagedJob();
    const requested = requestRedo(job, 0, new Date('2026-01-06T00:00:00Z'));
    const now = new Date('2026-01-07T00:00:00Z');
    const refused = refuseRedo(requested, now);
    expect(refused.status).toBe('staged');
    expect(refused.redoRefusedAt).toBe(now);
  });

  it('does not restore the allowance: redoUsedCount survives the refusal unchanged', () => {
    const job = stagedJob();
    const requested = requestRedo(job, 0, new Date());
    const refused = refuseRedo(requested, new Date());
    expect(refused.redoUsedCount).toBe(requested.redoUsedCount);
  });

  it('the buyer can still pay or decline from staged after a refusal (the transition table has both edges)', () => {
    const job = stagedJob();
    const requested = requestRedo(job, 0, new Date());
    const refused = refuseRedo(requested, new Date());
    expect(() => submitPullRequest(refused, 'https://github.com/o/r/pull/1', new Date())).not.toThrow();
    expect(() => recordStagedDeclined(refused)).not.toThrow();
  });
});

describe('acceptance: stageWork repeats its own edge from redo_requested, producing a fresh stage', () => {
  it('stages again from redo_requested, stamping a new commit and instant', () => {
    const job = stagedJob();
    const requested = requestRedo(job, 0, new Date('2026-01-06T00:00:00Z'));
    const restagedAt = new Date('2026-01-10T00:00:00Z');
    const restaged = stageWork(requested, 'commit-redo-1', restagedAt);
    expect(restaged.status).toBe('staged');
    expect(restaged.stagedCommit).toBe('commit-redo-1');
    expect(restaged.stagedAt).toBe(restagedAt);
  });

  it('the extension survives the restage: it is not silently un-extended', () => {
    const job = stagedJob();
    const requested = requestRedo(job, 0, new Date('2026-01-06T00:00:00Z'));
    const restaged = stageWork(requested, 'commit-redo-1', new Date('2026-01-10T00:00:00Z'));
    expect(restaged.stagedLapseExtensionDays).toBe(REDO_LAPSE_EXTENSION_DAYS);
  });

  it('the extended deadline actually moves lapseAtStaged: past the base 7 days but within the extended 14, the job has not lapsed', () => {
    const job = stagedJob();
    const requested = requestRedo(job, 0, new Date('2026-01-06T00:00:00Z'));
    const restagedAt = new Date('2026-01-10T00:00:00Z');
    const restaged = stageWork(requested, 'commit-redo-1', restagedAt);
    const pastBaseWindow = new Date(restagedAt.getTime() + (LAPSE_AT_STAGED_AFTER_DAYS + 1) * 86_400_000);
    expect(lapseAtStaged(restaged, pastBaseWindow).status).toBe('staged');
    const pastExtendedWindow = new Date(
      restagedAt.getTime() + (LAPSE_AT_STAGED_AFTER_DAYS + REDO_LAPSE_EXTENSION_DAYS + 1) * 86_400_000,
    );
    expect(lapseAtStaged(restaged, pastExtendedWindow).status).toBe('closed_unpaid');
  });

  it('a job never redone still lapses at the base window, unaffected (regression pin)', () => {
    const job = stagedJob();
    const pastBaseWindow = new Date(job.stagedAt!.getTime() + (LAPSE_AT_STAGED_AFTER_DAYS + 1) * 86_400_000);
    expect(lapseAtStaged(job, pastBaseWindow).status).toBe('closed_unpaid');
  });
});
