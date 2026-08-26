// R-26 (ENT-9): v1 records a settlement intent and nothing else. Every
// assertion here fails without src/domain/settlement.ts and passes with it.
import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/job.js';
import {
  recordSettlementIntent,
  settlementWellFormed,
  SettlementError,
  type Settlement,
} from '../../src/domain/settlement.js';

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job_1',
    buyerDid: 'did:example:buyer',
    agentDid: 'did:example:agent',
    repository: 'buyer/target-repo',
    brief: 'Fix the login bug on the checkout page',
    briefHash: 'sha256:brief',
    confirmedSpecHash: 'sha256:spec',
    status: 'completed',
    criteria: [],
    pullRequestUrl: 'https://github.com/buyer/target-repo/pull/1',
    mergeCommit: 'abc123',
    mergedAt: new Date('2026-01-02T00:00:00Z'),
    confirmedAt: new Date('2026-01-01T12:00:00Z'),
    submittedAt: new Date('2026-01-01T18:00:00Z'),
    deadline: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('recordSettlementIntent', () => {
  const completedJob = job();

  it('returns a jobId equal to the job id', () => {
    expect(recordSettlementIntent(completedJob).jobId).toBe(completedJob.id);
  });

  it('returns amount, currency and platformFee all null', () => {
    const settlement = recordSettlementIntent(completedJob);
    expect(settlement.amount).toBeNull();
    expect(settlement.currency).toBeNull();
    expect(settlement.platformFee).toBeNull();
  });

  it('returns state "recorded_intent"', () => {
    expect(recordSettlementIntent(completedJob).state).toBe('recorded_intent');
  });

  it.each([
    'draft',
    'proposed',
    'confirmed',
    'submitted',
    'stale',
    'declined',
    'closed_unmerged',
    'withdrawn',
  ] as const)('throws SettlementError when the job status is "%s" (ENT-9.3)', (status) => {
    expect(() => recordSettlementIntent(job({ status }))).toThrow(SettlementError);
    expect(() => recordSettlementIntent(job({ status }))).toThrow(new RegExp(status));
  });

  it('takes exactly one argument: no overload can accept an amount', () => {
    expect(recordSettlementIntent.length).toBe(1);
  });
});

function settlement(overrides: Partial<Settlement> = {}): Settlement {
  return {
    jobId: 'job_1',
    amount: null,
    currency: null,
    platformFee: null,
    state: 'recorded_intent',
    ...overrides,
  };
}

describe('settlementWellFormed', () => {
  it('a well-formed recorded intent returns true', () => {
    expect(settlementWellFormed(recordSettlementIntent(job()))).toBe(true);
  });

  it('a missing jobId returns false', () => {
    const full = settlement() as unknown as Record<string, unknown>;
    delete full.jobId;
    expect(settlementWellFormed(full as unknown as Settlement)).toBe(false);
  });

  it('an empty jobId returns false', () => {
    expect(settlementWellFormed(settlement({ jobId: '' }))).toBe(false);
  });

  it('a state other than "recorded_intent" returns false', () => {
    expect(
      settlementWellFormed(settlement({ state: 'transferred' as unknown as Settlement['state'] })),
    ).toBe(false);
  });

  it('an empty-string money field returns false', () => {
    expect(settlementWellFormed(settlement({ amount: '' }))).toBe(false);
  });

  it('a non-null, non-string money field returns false', () => {
    expect(settlementWellFormed(settlement({ amount: 42 as unknown as string }))).toBe(false);
  });

  it('is total on garbage: throws nothing, returns false', () => {
    for (const garbage of [null, 42, true, ['job_1'], {}]) {
      expect(() => settlementWellFormed(garbage as unknown as Settlement)).not.toThrow();
      expect(settlementWellFormed(garbage as unknown as Settlement)).toBe(false);
    }
  });
});
