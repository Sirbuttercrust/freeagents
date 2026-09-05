// P1: the agreement carries a price (priceUsd, rail, deposit 25, redo 1).
//
// THE anchor this card exists to hold: a hire cannot confirm without a
// price both parties signed, and the price is one number in dollars
// whatever token settles it. This file pins the domain rules: proposing a
// price alongside criteria, each party accepting it independently
// (ENT-6.2's own pattern, applied to the price line), confirm refusing
// without an agreed price and rail, the confirmed hash covering the price
// fields, and a proposal below the agent's floor being refused.
import { describe, expect, it } from 'vitest';
import {
  acceptCriterion,
  acceptPrice,
  assertPriceAboveFloor,
  confirmSpec,
  createJob,
  JobError,
  JobPriceError,
  JobTransitionError,
  proposeCriteria,
  requestChanges,
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

describe('createJob: price fields default null, deposit and redo fixed', () => {
  it('opens with priceUsd, rail and deliveryWindowDays null, price unaccepted by both parties', () => {
    const job = draftJob();
    expect(job.priceUsd).toBeNull();
    expect(job.rail).toBeNull();
    expect(job.deliveryWindowDays).toBeNull();
    expect(job.priceAcceptedByBuyer).toBe(false);
    expect(job.priceAcceptedByAgent).toBe(false);
  });

  it('fixes depositPercent at 25 and redoAllowance at 1, not caller-settable', () => {
    const job = draftJob();
    expect(job.depositPercent).toBe(25);
    expect(job.redoAllowance).toBe(1);
  });
});

describe('proposeCriteria: the price line rides beside criteria', () => {
  it('a proposal carrying priceUsd and rail sets them, unaccepted by both parties, deliveryWindowDays defaults to 14', () => {
    const proposed = proposeCriteria(draftJob(), criteriaProposal, { priceUsd: '500.00', rail: 'abt' });
    expect(proposed.priceUsd).toBe('500.00');
    expect(proposed.rail).toBe('abt');
    expect(proposed.deliveryWindowDays).toBe(14);
    expect(proposed.priceAcceptedByBuyer).toBe(false);
    expect(proposed.priceAcceptedByAgent).toBe(false);
  });

  it('an explicit deliveryWindowDays overrides the default', () => {
    const proposed = proposeCriteria(draftJob(), criteriaProposal, { priceUsd: '500.00', rail: 'usdc', deliveryWindowDays: 21 });
    expect(proposed.deliveryWindowDays).toBe(21);
  });

  it('a proposal with no price argument leaves an existing price untouched', () => {
    let job = proposeCriteria(draftJob(), criteriaProposal, { priceUsd: '500.00', rail: 'abt' });
    job = acceptCriterion(job, 0, 'buyer');
    job = proposeCriteria(job, criteriaProposal);
    expect(job.priceUsd).toBe('500.00');
    expect(job.rail).toBe('abt');
  });

  it('re-proposing the SAME price leaves both acceptances intact', () => {
    let job = proposeCriteria(draftJob(), criteriaProposal, { priceUsd: '500.00', rail: 'abt', deliveryWindowDays: 14 });
    job = acceptPrice(acceptPrice(job, 'buyer'), 'agent');
    expect(job.priceAcceptedByBuyer).toBe(true);
    expect(job.priceAcceptedByAgent).toBe(true);

    const again = proposeCriteria(job, criteriaProposal, { priceUsd: '500.00', rail: 'abt', deliveryWindowDays: 14 });
    expect(again.priceAcceptedByBuyer).toBe(true);
    expect(again.priceAcceptedByAgent).toBe(true);
  });

  it('re-proposing a DIFFERENT price resets both acceptances (request-changes then re-propose resets price acceptance)', () => {
    let job = proposeCriteria(draftJob(), criteriaProposal, { priceUsd: '500.00', rail: 'abt' });
    job = acceptPrice(acceptPrice(job, 'buyer'), 'agent');
    expect(job.priceAcceptedByBuyer).toBe(true);
    expect(job.priceAcceptedByAgent).toBe(true);

    // The buyer pushes back (a bodyless signal, changes nothing itself).
    job = requestChanges(job);
    expect(job.priceAcceptedByBuyer).toBe(true);
    expect(job.priceAcceptedByAgent).toBe(true);

    // The agent revises the price: the line changed, so both reset, exactly
    // as editing a criterion's text resets that criterion's acceptance.
    const revised = proposeCriteria(job, criteriaProposal, { priceUsd: '550.00', rail: 'abt' });
    expect(revised.priceUsd).toBe('550.00');
    expect(revised.priceAcceptedByBuyer).toBe(false);
    expect(revised.priceAcceptedByAgent).toBe(false);
  });

  it('rejects a priceUsd that is not a two-decimal-place string', () => {
    expect(() => proposeCriteria(draftJob(), criteriaProposal, { priceUsd: '500', rail: 'abt' })).toThrow(JobError);
    expect(() => proposeCriteria(draftJob(), criteriaProposal, { priceUsd: '500.0', rail: 'abt' })).toThrow(JobError);
    expect(() => proposeCriteria(draftJob(), criteriaProposal, { priceUsd: 'abc', rail: 'abt' })).toThrow(JobError);
  });

  it('rejects a rail that is not abt or usdc', () => {
    expect(() =>
      proposeCriteria(draftJob(), criteriaProposal, { priceUsd: '500.00', rail: 'usd' as never }),
    ).toThrow(JobError);
  });
});

describe('acceptPrice: each party accepts independently, like a criterion', () => {
  it('flips only the calling party\'s own flag, idempotently', () => {
    let job = proposeCriteria(draftJob(), criteriaProposal, { priceUsd: '500.00', rail: 'abt' });
    job = acceptPrice(job, 'buyer');
    expect(job.priceAcceptedByBuyer).toBe(true);
    expect(job.priceAcceptedByAgent).toBe(false);

    job = acceptPrice(job, 'buyer');
    expect(job.priceAcceptedByBuyer).toBe(true);
    expect(job.priceAcceptedByAgent).toBe(false);

    job = acceptPrice(job, 'agent');
    expect(job.priceAcceptedByBuyer).toBe(true);
    expect(job.priceAcceptedByAgent).toBe(true);
  });

  it('refuses when no price has been proposed yet', () => {
    expect(() => acceptPrice(draftJob({ status: 'proposed' }), 'buyer')).toThrow(JobError);
  });

  it('refuses on a job not in proposed', () => {
    const job = proposeCriteria(draftJob(), criteriaProposal, { priceUsd: '500.00', rail: 'abt' });
    expect(() => acceptPrice({ ...job, status: 'draft' }, 'buyer')).toThrow(JobTransitionError);
  });
});

// confirmSpec's price gate. THE anchor: a hire cannot confirm without a
// price both parties signed. Refusal is a typed JobPriceError, distinct
// from the plain JobError the criteria-outstanding gate throws, because the
// route maps it to 409 (a state conflict), not 400 (a caller input error).
describe('confirmSpec: refuses without an agreed price and rail (409-mapped)', () => {
  function agreedCriteria(job: Job): Job {
    let proposed = proposeCriteria(job, criteriaProposal);
    proposed = acceptCriterion(acceptCriterion(proposed, 0, 'buyer'), 0, 'agent');
    return proposed;
  }

  it('refuses when no price was ever proposed, naming the price', () => {
    const job = agreedCriteria(draftJob());
    expect(() => confirmSpec(job, new Date())).toThrow(JobPriceError);
    try {
      confirmSpec(job, new Date());
      throw new Error('expected confirmSpec to throw');
    } catch (err) {
      expect((err as Error).message.toLowerCase()).toContain('price');
    }
  });

  it('refuses when only one party accepted the price', () => {
    let job = agreedCriteria(draftJob());
    job = proposeCriteria(job, criteriaProposal, { priceUsd: '500.00', rail: 'abt' });
    job = acceptPrice(job, 'buyer');
    expect(() => confirmSpec(job, new Date())).toThrow(JobPriceError);
  });

  it('refuses when the price is agreed but no rail was set (structurally impossible via proposeCriteria, so scripted)', () => {
    let job = agreedCriteria(draftJob());
    job = proposeCriteria(job, criteriaProposal, { priceUsd: '500.00', rail: 'abt' });
    job = acceptPrice(acceptPrice(job, 'buyer'), 'agent');
    const noRail: Job = { ...job, rail: null };
    expect(() => confirmSpec(noRail, new Date())).toThrow(JobPriceError);
  });

  it('confirms once criteria AND price are both fully agreed', () => {
    let job = agreedCriteria(draftJob());
    job = proposeCriteria(job, criteriaProposal, { priceUsd: '500.00', rail: 'abt' });
    job = acceptPrice(acceptPrice(job, 'buyer'), 'agent');
    const confirmed = confirmSpec(job, new Date('2026-01-02T00:00:00Z'));
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.confirmedSpecHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

// ENT-4.2: the hash covers price, rail, deposit, redo and window, in the
// documented order, newline-joined after the criteria texts. A stranger
// holding only the confirmed response must be able to recompute it with
// node:crypto alone -- this is the domain-side half; the HTTP-response half
// lives in tests/api/job-confirm.test.ts.
describe('confirmedSpecHash covers the price fields (ENT-4.2)', () => {
  function confirmedJob(priceUsd: string, rail: 'abt' | 'usdc', deliveryWindowDays: number): Job {
    let job = proposeCriteria(draftJob(), criteriaProposal, { priceUsd, rail, deliveryWindowDays });
    job = acceptCriterion(acceptCriterion(job, 0, 'buyer'), 0, 'agent');
    job = acceptPrice(acceptPrice(job, 'buyer'), 'agent');
    return confirmSpec(job, new Date('2026-01-02T00:00:00Z'));
  }

  it('a different price produces a different hash (mutation proof: dropping price from the hash would make this pass wrongly)', () => {
    const a = confirmedJob('500.00', 'abt', 14);
    const b = confirmedJob('600.00', 'abt', 14);
    expect(a.confirmedSpecHash).not.toBe(b.confirmedSpecHash);
  });

  it('a different rail produces a different hash', () => {
    const a = confirmedJob('500.00', 'abt', 14);
    const b = confirmedJob('500.00', 'usdc', 14);
    expect(a.confirmedSpecHash).not.toBe(b.confirmedSpecHash);
  });

  it('a different deliveryWindowDays produces a different hash', () => {
    const a = confirmedJob('500.00', 'abt', 14);
    const b = confirmedJob('500.00', 'abt', 21);
    expect(a.confirmedSpecHash).not.toBe(b.confirmedSpecHash);
  });
});

// The optional agent floor (MAP.md): a proposal below it is refused at
// propose time, naming the floor. This is the domain half; the route calls
// this function once it has read the agent's floorPriceUsd from storage.
describe('assertPriceAboveFloor', () => {
  it('does nothing when there is no floor', () => {
    expect(() => assertPriceAboveFloor('10.00', null)).not.toThrow();
  });

  it('does nothing when the price meets or exceeds the floor', () => {
    expect(() => assertPriceAboveFloor('100.00', '100.00')).not.toThrow();
    expect(() => assertPriceAboveFloor('150.00', '100.00')).not.toThrow();
  });

  it('refuses a price below the floor, naming the floor', () => {
    expect(() => assertPriceAboveFloor('50.00', '100.00')).toThrow(JobError);
    try {
      assertPriceAboveFloor('50.00', '100.00');
      throw new Error('expected assertPriceAboveFloor to throw');
    } catch (err) {
      expect((err as Error).message).toContain('100.00');
    }
  });
});
