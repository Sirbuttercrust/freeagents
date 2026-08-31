// R-19 (D4, ENT-1.2): the operator roster's aggregate record.
//
// ANCHOR: an operator page is the sum of who they run, never a score for
// the operator. This module is the structural guarantee: it accepts the
// SAME browse cards the roster rows already render (src/domain/browse.ts),
// and sums each of the three tiers separately across the roster. No field
// here is ever a sum of two different tiers, a blended score, or a rank
// against another operator; the mutation-proof sweep in
// tests/domain/operator-roster.test.ts holds this module to that.
//
// Deriving the totals here, from the SAME rows the roster renders, rather
// than accepting a caller-supplied total, is the fix pattern R-20's
// tier-blind buyerCount defect (Proof, t_698205aa) established: a function
// that derives its own numbers cannot be handed one drawn from a wider or
// different population than the rows beside it.
import type { BrowseCard } from './browse.js';

// Three separate totals, one per tier. An operator with zero agents gets
// three honest zeros (ENT-2.4), never an absent aggregate.
export interface OperatorAggregate {
  readonly totalVerifiedHireCount: number;
  readonly totalVerifiedPriorWorkCount: number;
  readonly totalPortfolioCount: number;
}

// Sums each tier count across the roster's own cards. Each total is read
// off exactly one tier field across every card; none is a sum, average, or
// ratio across tiers.
export function operatorAggregate(cards: readonly BrowseCard[]): OperatorAggregate {
  let totalVerifiedHireCount = 0;
  let totalVerifiedPriorWorkCount = 0;
  let totalPortfolioCount = 0;
  for (const card of cards) {
    totalVerifiedHireCount += card.verifiedHireCount;
    totalVerifiedPriorWorkCount += card.verifiedPriorWorkCount;
    totalPortfolioCount += card.portfolioCount;
  }
  return { totalVerifiedHireCount, totalVerifiedPriorWorkCount, totalPortfolioCount };
}
