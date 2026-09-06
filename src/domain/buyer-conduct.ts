// P7: the buyer conduct record, keyed to the buyer's verified GitHub
// account (never the DID). Record the outcome, never adjudicate it: this
// module reports which of a small set of publicly checkable things
// happened and refuses to rule on why. No score, no rating, no verdict,
// no adjective, no derived ratio, no ordering of buyers against each
// other. Mirrors src/domain/buyer-diversity.ts's shape: a pure,
// synchronous function over job facts, structural input, no I/O, no
// clock, no vendor import.
//
// Every count here is derived from stored job rows at read time. There is
// no stored counter anywhere in this module: a counter is a second source
// of truth that drifts from the rows the moment one write path forgets
// it, and a record whose whole value is being checkable cannot afford to
// be uncheckable itself.

// Structural input, only the fields the rule reads, so a caller may pass
// stored rows or reconstructed ones. status is read as a plain string,
// not JobStatus, so this file needs no import from job.ts (and stays
// importable with only the statuses this rule actually branches on).
export interface BuyerJobFacts {
  readonly status: string;
  // Null exactly when the job never reached confirmed (draft, proposed,
  // or declined before confirm). Every terminal status this record counts
  // downstream of confirmed always carries a non-null confirmedAt, the
  // same one-writer pairing confirmSpec already keeps in src/domain/job.ts.
  readonly confirmedAt: string | Date | null;
}

// Counts to ship (committee synthesis row 7, minus the three underivable
// ones - see ABSENT_BUYER_COUNTS below). Every field is a plain count:
// no ratio, no percentage, no letter grade.
export interface BuyerConduct {
  readonly confirmed: number;
  readonly walkedAfterConfirm: number;
  readonly stagedDeclined: number;
  readonly closedUnpaid: number;
  readonly merged: number;
  readonly deemed: number;
  readonly closedUnmerged: number;
}

// Statuses reachable only downstream of confirmed (P4's transition table,
// src/domain/job.ts): staged, submitted, stale and every terminal outcome
// that follows. A job at any of these was confirmed, so `confirmed` counts
// current status plus every state downstream of it, not a status equality.
// withdrawn and declined are NOT here: both are reachable from every
// non-terminal status including draft and proposed, so reaching one of
// them proves nothing about whether the job was ever confirmed - that is
// exactly what the confirmedAt fact (not the status) settles for those two.
const DOWNSTREAM_OF_CONFIRMED = new Set([
  'confirmed',
  'staged',
  'submitted',
  'stale',
  'staged_declined',
  'closed_unpaid',
  'expired_unstaged',
  'deemed_completed',
  'completed',
  'closed_unmerged',
]);

function wasConfirmed(job: BuyerJobFacts): boolean {
  if (job.confirmedAt !== null && job.confirmedAt !== undefined) return true;
  return typeof job.status === 'string' && DOWNSTREAM_OF_CONFIRMED.has(job.status);
}

// The three counts the committee synthesis names that no fact in this
// build can produce: settlement is a fail-closed port with no durable
// record wired to it (paid), and the cited close and the redo are P6,
// which has not been built (citedCloses, redosRequested). Shipping any of
// these as a zero field would be silent-success-on-failure: a buyer with
// three cited closes would read as a buyer with none. Each is named here,
// with the reason it is absent, instead of appearing as a key on
// BuyerConduct - see the mutation-proof test in
// tests/domain/buyer-conduct.test.ts that fails if one is added back
// without this list being updated deliberately.
export const ABSENT_BUYER_COUNTS: readonly { readonly field: string; readonly reason: string }[] = [
  {
    field: 'paid',
    reason: 'settlement is a fail-closed port with no durable record wired to it (invariant 12); nothing in this codebase can observe a payment fact yet.',
  },
  {
    field: 'citedCloses',
    reason: 'the cited close is P6, which has not been built.',
  },
  {
    field: 'redosRequested',
    reason: 'the redo mechanic is P6, which has not been built.',
  },
];

// Total: any input in, one BuyerConduct out. A non-array `jobs`, a row
// missing a field, a null or undefined row - none of these throw, the
// same totality stance buyerDiversity already takes over hire rows.
export function buyerConductRecord(jobs: readonly BuyerJobFacts[]): BuyerConduct {
  const rows: BuyerJobFacts[] = Array.isArray(jobs) ? [...jobs] : [];

  let confirmed = 0;
  let walkedAfterConfirm = 0;
  let stagedDeclined = 0;
  let closedUnpaid = 0;
  let merged = 0;
  let deemed = 0;
  let closedUnmerged = 0;

  for (const raw of rows) {
    const job: BuyerJobFacts = raw ?? { status: '', confirmedAt: null };
    const status = typeof job.status === 'string' ? job.status : '';
    const confirmedReached = wasConfirmed(job);

    if (confirmedReached) confirmed += 1;

    // walkedAfterConfirm: withdrawn from confirmed, plus expired_unstaged.
    // Both are the buyer leaving a confirmed job with nothing delivered.
    // A withdrawn row with no confirmedAt (draft or proposed walk-away)
    // is neither confirmed nor a walk-away-AFTER-confirm.
    if (status === 'expired_unstaged') {
      walkedAfterConfirm += 1;
    } else if (status === 'withdrawn' && confirmedReached) {
      walkedAfterConfirm += 1;
    }

    if (status === 'staged_declined') stagedDeclined += 1;
    if (status === 'closed_unpaid') closedUnpaid += 1;
    if (status === 'completed') merged += 1;
    if (status === 'deemed_completed') deemed += 1;
    if (status === 'closed_unmerged') closedUnmerged += 1;
  }

  return { confirmed, walkedAfterConfirm, stagedDeclined, closedUnpaid, merged, deemed, closedUnmerged };
}

// The two operator-set listing filters (scope item 4): both optional,
// both null by default. Null means no filter - an operator who set
// nothing refuses nobody.
export interface BuyerConductThresholds {
  readonly minBuyerMerges: number | null;
  readonly maxWalkedAfterConfirm: number | null;
}

// One threshold failure, naming which threshold and the buyer's own
// count (or, for an unkeyed buyer, that no count exists at all - 'actual'
// is intentionally absent for 'not-keyed', because there is no count to
// report, only the fact that none exists). The buyer is entitled to know
// why they were refused, because the counts are theirs.
export type BuyerConductThresholdFailure =
  | { readonly kind: 'below-minimum'; readonly threshold: 'minBuyerMerges'; readonly required: number; readonly actual: number }
  | { readonly kind: 'above-maximum'; readonly threshold: 'maxWalkedAfterConfirm'; readonly required: number; readonly actual: number }
  | { readonly kind: 'not-keyed'; readonly threshold: 'minBuyerMerges' | 'maxWalkedAfterConfirm'; readonly required: number };

// Total: given the buyer's conduct record (null when the buyer has no
// verified GitHub account - a distinct answer from a record of zeroes,
// never conflated with one) and the operator's thresholds, returns the
// first threshold the buyer fails, or null when every set threshold is
// met. Checks minBuyerMerges before maxWalkedAfterConfirm - the earlier
// one named in the agreement first, mirroring confirmSpec's own ordering
// stance (src/domain/job.ts: "one failure at a time, the earlier one in
// the agreement first").
//
// A buyer with no verified GitHub account fails ANY set threshold: not an
// exemption, not a pass, and not a crash. An unkeyed buyer is precisely
// what a threshold is protecting against.
export function buyerConductThresholdFailure(
  counts: BuyerConduct | null,
  thresholds: BuyerConductThresholds,
): BuyerConductThresholdFailure | null {
  if (thresholds.minBuyerMerges !== null) {
    if (counts === null) {
      return { kind: 'not-keyed', threshold: 'minBuyerMerges', required: thresholds.minBuyerMerges };
    }
    if (counts.merged < thresholds.minBuyerMerges) {
      return { kind: 'below-minimum', threshold: 'minBuyerMerges', required: thresholds.minBuyerMerges, actual: counts.merged };
    }
  }
  if (thresholds.maxWalkedAfterConfirm !== null) {
    if (counts === null) {
      return { kind: 'not-keyed', threshold: 'maxWalkedAfterConfirm', required: thresholds.maxWalkedAfterConfirm };
    }
    if (counts.walkedAfterConfirm > thresholds.maxWalkedAfterConfirm) {
      return {
        kind: 'above-maximum',
        threshold: 'maxWalkedAfterConfirm',
        required: thresholds.maxWalkedAfterConfirm,
        actual: counts.walkedAfterConfirm,
      };
    }
  }
  return null;
}
