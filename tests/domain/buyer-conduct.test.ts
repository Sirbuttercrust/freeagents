// P7: the buyer conduct record. Counts only, derived from stored job rows
// at read time (no counter anywhere): the record reports which of a small
// set of publicly checkable things happened, and refuses to rule on why.
import { describe, expect, it } from 'vitest';
import {
  ABSENT_BUYER_COUNTS,
  buyerConductRecord,
  buyerConductThresholdFailure,
  operatorConductRecord,
  type BuyerJobFacts,
  type OperatorJobFacts,
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
      citedCloses: 0,
      redosRequested: 0,
      walkedAway: 0,
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

  it('does not export a blended or derived field: exactly the ten documented counts', () => {
    const result = buyerConductRecord([job()]);
    expect(Object.keys(result).sort()).toEqual(
      [
        'confirmed',
        'walkedAfterConfirm',
        'stagedDeclined',
        'closedUnpaid',
        'merged',
        'deemed',
        'closedUnmerged',
        'citedCloses',
        'redosRequested',
        'walkedAway',
      ].sort(),
    );
  });

  // P8r: citedCloses is a status equality, the same shape stagedDeclined
  // and closedUnpaid already take.
  it('cited_closed counts confirmed and citedCloses', () => {
    const result = buyerConductRecord([job({ status: 'cited_closed' })]);
    expect(result.confirmed).toBe(1);
    expect(result.citedCloses).toBe(1);
  });

  // Review round 1, defect 2: cited_closed is the buyer's close AFTER
  // paying (src/domain/job.ts), so it is downstream of confirmed by
  // definition, the same way every other terminal status in
  // DOWNSTREAM_OF_CONFIRMED is. confirmedAt: null here forces the check
  // through the status-set branch rather than the confirmedAt branch, so
  // this reddens if cited_closed is ever dropped from that set.
  it('cited_closed counts confirmed even with a null confirmedAt: it is downstream of confirmed by definition', () => {
    const result = buyerConductRecord([job({ status: 'cited_closed', confirmedAt: null })]);
    expect(result.confirmed).toBe(1);
  });

  // P8r, done-means item 2, mutation proof 1: redosRequested must count the
  // durable redoRequestedAt fact, not the transient redo_requested status.
  // A job that passed through redo_requested and was then REFUSED (so it
  // now sits at a terminal status with redoRequestedAt still set) proves
  // the durable fact survives a refusal.
  it('a redo requested and then refused still counts redosRequested, even though the status has moved on', () => {
    const result = buyerConductRecord([
      job({ status: 'staged_declined', redoRequestedAt: '2026-06-01T00:00:00.000Z' }),
    ]);
    expect(result.redosRequested).toBe(1);
  });

  // The other half of the same mutation proof: a redo requested and then
  // ACCEPTED (restaged) also survives, proving the count is not the
  // transient status either way. Built by passing through redo_requested
  // and landing back at staged, per the card's own instruction.
  it('a redo requested and then accepted and restaged still counts redosRequested', () => {
    const result = buyerConductRecord([
      job({ status: 'staged', redoRequestedAt: '2026-06-01T00:00:00.000Z' }),
    ]);
    expect(result.redosRequested).toBe(1);
  });

  it('a job with no redo requested at all does not count redosRequested', () => {
    const result = buyerConductRecord([job({ status: 'staged', redoRequestedAt: null })]);
    expect(result.redosRequested).toBe(0);
  });

  // Mutation proof 1's negative control: counting the transient status
  // itself would report zero here, because this row never sits AT
  // redo_requested at read time.
  it('counting the redo_requested status itself would be wrong: a resolved redo is not still at that status', () => {
    const result = buyerConductRecord([
      job({ status: 'staged_declined', redoRequestedAt: '2026-06-01T00:00:00.000Z' }),
    ]);
    expect(result.redosRequested).not.toBe(0);
  });

  it('is total: a row omitting redoRequestedAt counts as no redo, never a throw', () => {
    const malformed = [{ status: 'staged' } as unknown as BuyerJobFacts];
    expect(() => buyerConductRecord(malformed)).not.toThrow();
    expect(buyerConductRecord(malformed).redosRequested).toBe(0);
  });

  // Ruling 2 (P8s): walkedAway is DATA-CONTRACT.md:405's "staged_declined
  // plus closed_unpaid" -- work that was delivered and then declined or
  // gone quiet on. It is a DIFFERENT count from walkedAfterConfirm, which
  // is expired_unstaged plus withdrawn-after-confirm: walking away with
  // NOTHING delivered. This fixture makes the two counts differ (one
  // stagedDeclined, one closedUnpaid, one expired_unstaged) so a version
  // of the code that bound "walked away" to walkedAfterConfirm reddens
  // here (mutation proof 1).
  it('walkedAway equals stagedDeclined plus closedUnpaid, and differs from walkedAfterConfirm', () => {
    const result = buyerConductRecord([
      job({ status: 'staged_declined' }),
      job({ status: 'closed_unpaid' }),
      job({ status: 'expired_unstaged' }),
    ]);
    expect(result.stagedDeclined).toBe(1);
    expect(result.closedUnpaid).toBe(1);
    expect(result.walkedAfterConfirm).toBe(1);
    expect(result.walkedAway).toBe(2);
    expect(result.walkedAway).not.toBe(result.walkedAfterConfirm);
  });

  it('walkedAway is zero when neither staged_declined nor closed_unpaid ever happened', () => {
    const result = buyerConductRecord([job({ status: 'completed' })]);
    expect(result.walkedAway).toBe(0);
  });
});

// Scope item 2: paid alone is absent, never a zero, because no fact in
// this build can produce it. citedCloses and redosRequested join
// BuyerConduct now that P6 has merged. This test fails if a future edit
// adds paid back onto BuyerConduct without deliberately removing it from
// ABSENT_BUYER_COUNTS, or removes citedCloses/redosRequested from the
// record without adding them back here.
describe('ABSENT_BUYER_COUNTS', () => {
  it('names only paid, with a reason naming the missing settlement fact', () => {
    const fields = ABSENT_BUYER_COUNTS.map((entry) => entry.field);
    expect(fields).toEqual(['paid']);
    for (const entry of ABSENT_BUYER_COUNTS) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it("paid's reason names BuyerJobFacts carrying no settlement fact, not the stale invariant-12 wording", () => {
    const paidEntry = ABSENT_BUYER_COUNTS.find((entry) => entry.field === 'paid');
    expect(paidEntry).toBeDefined();
    expect(paidEntry?.reason).toContain('BuyerJobFacts');
    expect(paidEntry?.reason).not.toContain('P6');
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

// P8r scope item 2: the operator side, a different population over the
// same account. Its own structural facts type, mirroring BuyerJobFacts,
// never merged into BuyerConduct.
function operatorJob(overrides: Partial<OperatorJobFacts> = {}): OperatorJobFacts {
  return {
    status: 'completed',
    redoRefusedAt: null,
    ...overrides,
  };
}

describe('operatorConductRecord', () => {
  it('a staged_declined job counts deliveredNeverPaid', () => {
    const result = operatorConductRecord([operatorJob({ status: 'staged_declined' })]);
    expect(result.deliveredNeverPaid).toBe(1);
  });

  it('a closed_unpaid job also counts deliveredNeverPaid, the wireframe draws no distinction', () => {
    const result = operatorConductRecord([operatorJob({ status: 'closed_unpaid' })]);
    expect(result.deliveredNeverPaid).toBe(1);
  });

  // Done-means item 5: proved against one of each rather than one of
  // either.
  it('one staged_declined and one closed_unpaid both count toward deliveredNeverPaid: 2, not 1', () => {
    const result = operatorConductRecord([
      operatorJob({ status: 'staged_declined' }),
      operatorJob({ status: 'closed_unpaid' }),
    ]);
    expect(result.deliveredNeverPaid).toBe(2);
  });

  it('a completed job does not count deliveredNeverPaid', () => {
    const result = operatorConductRecord([operatorJob({ status: 'completed' })]);
    expect(result.deliveredNeverPaid).toBe(0);
  });

  it('a job carrying redoRefusedAt counts redosRefused', () => {
    const result = operatorConductRecord([operatorJob({ redoRefusedAt: '2026-06-01T00:00:00.000Z' })]);
    expect(result.redosRefused).toBe(1);
  });

  // Done-means item 6: a redo requested and never answered (still sitting
  // at redo_requested, redoRefusedAt null) must not count.
  it('a redo requested and never answered does not count redosRefused', () => {
    const result = operatorConductRecord([operatorJob({ status: 'redo_requested', redoRefusedAt: null })]);
    expect(result.redosRefused).toBe(0);
  });

  it('empty input gives all-zero counts', () => {
    expect(operatorConductRecord([])).toEqual({ deliveredNeverPaid: 0, redosRefused: 0 });
  });

  it('exports exactly the two documented counts, never merged with a buyer field', () => {
    const result = operatorConductRecord([operatorJob()]);
    expect(Object.keys(result).sort()).toEqual(['deliveredNeverPaid', 'redosRefused'].sort());
  });

  it('is total: a non-array input is treated as no jobs, not thrown', () => {
    const notAnArray = { length: 3 } as unknown as readonly OperatorJobFacts[];
    expect(() => operatorConductRecord(notAnArray)).not.toThrow();
    expect(operatorConductRecord(notAnArray)).toEqual({ deliveredNeverPaid: 0, redosRefused: 0 });
  });

  it('is total: a null or undefined row does not throw and contributes nothing', () => {
    const malformed = [null, undefined] as unknown as readonly OperatorJobFacts[];
    expect(() => operatorConductRecord(malformed)).not.toThrow();
    expect(operatorConductRecord(malformed)).toEqual({ deliveredNeverPaid: 0, redosRefused: 0 });
  });

  it('is total: a row missing status contributes nothing to deliveredNeverPaid, never throws', () => {
    const malformed = [{ redoRefusedAt: null } as unknown as OperatorJobFacts];
    expect(() => operatorConductRecord(malformed)).not.toThrow();
    expect(operatorConductRecord(malformed).deliveredNeverPaid).toBe(0);
  });
});
