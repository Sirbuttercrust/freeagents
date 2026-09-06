// P7: the buyer conduct record. Counts only, derived from stored job rows
// at read time (no counter anywhere): the record reports which of a small
// set of publicly checkable things happened, and refuses to rule on why.
import { describe, expect, it } from 'vitest';
import {
  ABSENT_BUYER_COUNTS,
  buyerConductRecord,
  buyerConductThresholdFailure,
  type BuyerJobFacts,
} from '../../src/domain/buyer-conduct.js';

function job(overrides: Partial<BuyerJobFacts> = {}): BuyerJobFacts {
  return {
    status: 'completed',
    confirmedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('buyerConductRecord', () => {
  it('a job that reached completed counts confirmed: 1 and merged: 1', () => {
    const result = buyerConductRecord([job({ status: 'completed' })]);
    expect(result.confirmed).toBe(1);
    expect(result.merged).toBe(1);
  });

  it('empty input gives all-zero counts', () => {
    expect(buyerConductRecord([])).toEqual({
      confirmed: 0,
      walkedAfterConfirm: 0,
      stagedDeclined: 0,
      closedUnpaid: 0,
      merged: 0,
      deemed: 0,
      closedUnmerged: 0,
    });
  });

  it('a job withdrawn from confirmed counts confirmed and walkedAfterConfirm, both', () => {
    const result = buyerConductRecord([job({ status: 'withdrawn', confirmedAt: '2026-06-01T00:00:00.000Z' })]);
    expect(result.confirmed).toBe(1);
    expect(result.walkedAfterConfirm).toBe(1);
  });

  it('a job withdrawn before confirm (confirmedAt null) counts neither confirmed nor walkedAfterConfirm', () => {
    const result = buyerConductRecord([job({ status: 'withdrawn', confirmedAt: null })]);
    expect(result.confirmed).toBe(0);
    expect(result.walkedAfterConfirm).toBe(0);
  });

  it('expired_unstaged counts as both confirmed and walkedAfterConfirm', () => {
    const result = buyerConductRecord([job({ status: 'expired_unstaged', confirmedAt: '2026-06-01T00:00:00.000Z' })]);
    expect(result.confirmed).toBe(1);
    expect(result.walkedAfterConfirm).toBe(1);
  });

  it('staged_declined counts confirmed and stagedDeclined, not walkedAfterConfirm', () => {
    const result = buyerConductRecord([job({ status: 'staged_declined' })]);
    expect(result.confirmed).toBe(1);
    expect(result.stagedDeclined).toBe(1);
    expect(result.walkedAfterConfirm).toBe(0);
  });

  it('closed_unpaid counts confirmed and closedUnpaid', () => {
    const result = buyerConductRecord([job({ status: 'closed_unpaid' })]);
    expect(result.confirmed).toBe(1);
    expect(result.closedUnpaid).toBe(1);
  });

  it('deemed_completed counts confirmed and deemed, never merged', () => {
    const result = buyerConductRecord([job({ status: 'deemed_completed' })]);
    expect(result.confirmed).toBe(1);
    expect(result.deemed).toBe(1);
    expect(result.merged).toBe(0);
  });

  it('closed_unmerged counts confirmed and closedUnmerged, never merged', () => {
    const result = buyerConductRecord([job({ status: 'closed_unmerged' })]);
    expect(result.confirmed).toBe(1);
    expect(result.closedUnmerged).toBe(1);
    expect(result.merged).toBe(0);
  });

  it('a draft (confirmedAt null) contributes nothing but is not thrown on', () => {
    const result = buyerConductRecord([job({ status: 'draft', confirmedAt: null })]);
    expect(result.confirmed).toBe(0);
    expect(Object.values(result).every((n) => n === 0)).toBe(true);
  });

  it('a declined job with no confirmedAt (declined pre-confirm) counts nothing', () => {
    const result = buyerConductRecord([job({ status: 'declined', confirmedAt: null })]);
    expect(result.confirmed).toBe(0);
    expect(result.walkedAfterConfirm).toBe(0);
  });

  it('ten confirmed walk-aways show ten walk-aways, nothing derived, nothing blended', () => {
    const rows = Array.from({ length: 10 }, () => job({ status: 'withdrawn', confirmedAt: '2026-01-01T00:00:00.000Z' }));
    const result = buyerConductRecord(rows);
    expect(result.walkedAfterConfirm).toBe(10);
    expect(result.merged).toBe(0);
  });

  it('is total: a non-array input is treated as no jobs, not thrown', () => {
    const notAnArray = { length: 3 } as unknown as readonly BuyerJobFacts[];
    expect(() => buyerConductRecord(notAnArray)).not.toThrow();
    expect(buyerConductRecord(notAnArray).confirmed).toBe(0);
  });

  it('is total: a null or undefined row does not throw and contributes nothing', () => {
    const malformed = [null, undefined] as unknown as readonly BuyerJobFacts[];
    expect(() => buyerConductRecord(malformed)).not.toThrow();
    const result = buyerConductRecord(malformed);
    expect(Object.values(result).every((n) => n === 0)).toBe(true);
  });

  it('is total: a row with a missing status contributes nothing, never throws', () => {
    const malformed = [{ confirmedAt: '2026-01-01T00:00:00.000Z' } as unknown as BuyerJobFacts];
    expect(() => buyerConductRecord(malformed)).not.toThrow();
    const result = buyerConductRecord(malformed);
    expect(result.confirmed).toBe(1);
    expect(result.merged).toBe(0);
  });

  it('does not export a blended or derived field: exactly the seven documented counts', () => {
    const result = buyerConductRecord([job()]);
    expect(Object.keys(result).sort()).toEqual(
      ['confirmed', 'walkedAfterConfirm', 'stagedDeclined', 'closedUnpaid', 'merged', 'deemed', 'closedUnmerged'].sort(),
    );
  });
});

// Scope item 2: paid, cited closes and redos requested are absent, never
// zeroes, because no fact in this build can produce them. This test fails
// if a future edit adds one of the named fields back onto BuyerConduct
// without deliberately removing it from ABSENT_BUYER_COUNTS.
describe('ABSENT_BUYER_COUNTS', () => {
  it('names paid, citedCloses and redosRequested, each with a reason', () => {
    const fields = ABSENT_BUYER_COUNTS.map((entry) => entry.field).sort();
    expect(fields).toEqual(['citedCloses', 'paid', 'redosRequested'].sort());
    for (const entry of ABSENT_BUYER_COUNTS) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it('mutation proof: none of the named absent fields ever appears as a key on a buyerConductRecord result', () => {
    const result = buyerConductRecord([job()]) as unknown as Record<string, unknown>;
    for (const entry of ABSENT_BUYER_COUNTS) {
      expect(Object.prototype.hasOwnProperty.call(result, entry.field), `${entry.field} must be absent`).toBe(false);
    }
  });
});

describe('buyerConductThresholdFailure', () => {
  const counts = buyerConductRecord([
    job({ status: 'completed' }),
    job({ status: 'completed' }),
    job({ status: 'withdrawn', confirmedAt: '2026-01-01T00:00:00.000Z' }),
  ]);

  it('null means no filter: both thresholds null, keyed buyer, no failure', () => {
    expect(buyerConductThresholdFailure(counts, { minBuyerMerges: null, maxWalkedAfterConfirm: null })).toBeNull();
  });

  it('null means no filter: an operator who set nothing refuses nobody, even an unkeyed buyer', () => {
    expect(buyerConductThresholdFailure(null, { minBuyerMerges: null, maxWalkedAfterConfirm: null })).toBeNull();
  });

  it('a buyer meeting minBuyerMerges passes', () => {
    expect(buyerConductThresholdFailure(counts, { minBuyerMerges: 2, maxWalkedAfterConfirm: null })).toBeNull();
  });

  it('a buyer below minBuyerMerges fails, naming the threshold and the actual count', () => {
    const failure = buyerConductThresholdFailure(counts, { minBuyerMerges: 5, maxWalkedAfterConfirm: null });
    expect(failure).toEqual({ kind: 'below-minimum', threshold: 'minBuyerMerges', required: 5, actual: 2 });
  });

  it('a buyer at or under maxWalkedAfterConfirm passes', () => {
    expect(buyerConductThresholdFailure(counts, { minBuyerMerges: null, maxWalkedAfterConfirm: 1 })).toBeNull();
  });

  it('a buyer over maxWalkedAfterConfirm fails, naming the threshold and the actual count', () => {
    const failure = buyerConductThresholdFailure(counts, { minBuyerMerges: null, maxWalkedAfterConfirm: 0 });
    expect(failure).toEqual({ kind: 'above-maximum', threshold: 'maxWalkedAfterConfirm', required: 0, actual: 1 });
  });

  it('a buyer with no verified GitHub account fails a set minBuyerMerges: not an exemption, not a pass', () => {
    const failure = buyerConductThresholdFailure(null, { minBuyerMerges: 1, maxWalkedAfterConfirm: null });
    expect(failure).toEqual({ kind: 'not-keyed', threshold: 'minBuyerMerges', required: 1 });
  });

  it('a buyer with no verified GitHub account fails a set maxWalkedAfterConfirm', () => {
    const failure = buyerConductThresholdFailure(null, { minBuyerMerges: null, maxWalkedAfterConfirm: 0 });
    expect(failure).toEqual({ kind: 'not-keyed', threshold: 'maxWalkedAfterConfirm', required: 0 });
  });

  it('an unkeyed buyer against both thresholds reports minBuyerMerges first, the earlier one in the agreement', () => {
    const failure = buyerConductThresholdFailure(null, { minBuyerMerges: 1, maxWalkedAfterConfirm: 0 });
    expect(failure?.threshold).toBe('minBuyerMerges');
  });

  it('is total: never throws on any input combination exercised above', () => {
    expect(() => buyerConductThresholdFailure(null, { minBuyerMerges: null, maxWalkedAfterConfirm: null })).not.toThrow();
  });
});
