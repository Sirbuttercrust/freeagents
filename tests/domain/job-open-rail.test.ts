// FIX-B39 (bugs.md B39): rule 1, the price proposal may leave the currency
// open. A proposal that names a rail still pins the job to it exactly as
// before (tests/domain/job-price.test.ts, untouched); this file pins the
// NEW case: a proposal that omits rail entirely.
import { describe, expect, it } from 'vitest';
import {
  acceptCriterion,
  acceptPrice,
  confirmSpec,
  createJob,
  JobError,
  JobPriceError,
  proposeCriteria,
  type Job,
} from '../../src/domain/job.js';

function draftJob(overrides: Partial<Job> = {}): Job {
  return {
    ...createJob(
      { id: 'job_1', buyerDid: 'did:example:buyer', agentDid: 'did:example:agent', repository: 'buyer/target-repo', brief: 'Fix the login bug' },
      new Date('2026-01-01T00:00:00Z'),
    ),
    ...overrides,
  };
}

const criteriaProposal = [{ text: 'The login bug is fixed', proposedBy: 'agent' }];

describe('proposeCriteria: rule 1, rail is optional on a price proposal', () => {
  it('a price with no rail is accepted, leaving job.rail null', () => {
    const proposed = proposeCriteria(draftJob(), criteriaProposal, { priceUsd: '500.00' });
    expect(proposed.priceUsd).toBe('500.00');
    expect(proposed.rail).toBeNull();
    expect(proposed.priceAcceptedByBuyer).toBe(false);
    expect(proposed.priceAcceptedByAgent).toBe(false);
  });

  it('naming a rail still pins the job to it, exactly as before', () => {
    const proposed = proposeCriteria(draftJob(), criteriaProposal, { priceUsd: '500.00', rail: 'usdc' });
    expect(proposed.rail).toBe('usdc');
  });

  it('re-proposing the same price with no rail leaves an already-pinned rail untouched', () => {
    let job = proposeCriteria(draftJob(), criteriaProposal, { priceUsd: '500.00', rail: 'abt' });
    job = acceptPrice(acceptPrice(job, 'buyer'), 'agent');
    const again = proposeCriteria(job, criteriaProposal, { priceUsd: '500.00' });
    expect(again.rail).toBe('abt');
    // Omitting rail on an otherwise-identical price is not a price change:
    // both acceptances survive.
    expect(again.priceAcceptedByBuyer).toBe(true);
    expect(again.priceAcceptedByAgent).toBe(true);
  });

  it('still rejects a rail value that is neither abt nor usdc when one is provided', () => {
    expect(() =>
      proposeCriteria(draftJob(), criteriaProposal, { priceUsd: '500.00', rail: 'usd' as never }),
    ).toThrow(JobError);
  });
});

describe('acceptPrice: rule 4, accepting a price with no rail is not refused', () => {
  it('both parties can accept an open-rail price', () => {
    let job = proposeCriteria(draftJob(), criteriaProposal, { priceUsd: '500.00' });
    job = acceptPrice(job, 'buyer');
    job = acceptPrice(job, 'agent');
    expect(job.priceAcceptedByBuyer).toBe(true);
    expect(job.priceAcceptedByAgent).toBe(true);
    expect(job.rail).toBeNull();
  });
});

describe('confirmSpec: still refuses a null rail (untouched rule, rechecked here for this file\'s own fixtures)', () => {
  it('refuses confirm on an open-rail job even with price and criteria fully agreed', () => {
    let job = proposeCriteria(draftJob(), criteriaProposal, { priceUsd: '500.00' });
    job = acceptCriterion(acceptCriterion(job, 0, 'buyer'), 0, 'agent');
    job = acceptPrice(acceptPrice(job, 'buyer'), 'agent');
    expect(job.rail).toBeNull();
    expect(() => confirmSpec(job, new Date())).toThrow(JobPriceError);
  });

  it('confirms once a rail is set directly on the job (simulating confirm\'s own settlement-backfill), without touching acceptance flags', () => {
    let job = proposeCriteria(draftJob(), criteriaProposal, { priceUsd: '500.00' });
    job = acceptCriterion(acceptCriterion(job, 0, 'buyer'), 0, 'agent');
    job = acceptPrice(acceptPrice(job, 'buyer'), 'agent');
    // Rule 4: recording the currency is not a price change. A raw spread
    // (what confirm's own settlement-backfill does) must never clear
    // acceptance.
    const withRail: Job = { ...job, rail: 'usdc' };
    expect(withRail.priceAcceptedByBuyer).toBe(true);
    expect(withRail.priceAcceptedByAgent).toBe(true);
    const confirmed = confirmSpec(withRail, new Date('2026-01-02T00:00:00Z'));
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.confirmedSpecHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
