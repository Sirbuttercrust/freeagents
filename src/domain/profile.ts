// R-17: the three evidence tiers, assembled and labelled, never combined
// into one number (MISSION invariant 5, ENT-11.5, decision D1: a sort option
// "may never become a blended score"). This module is a pure, total fold: it
// classifies each item with the existing evidenceTier and buckets it, and it
// exports no total, no sum, no score, and no function that could produce one.
import { evidenceTier, type EvidenceFacts, type EvidenceTier } from './evidence.js';

// One evidence-bearing thing plus the facts that decide its tier. The caller
// owns what T is (a credential reference at the API layer, a prior-work row
// later); the domain only ever sees the facts.
export interface EvidenceItem<T> {
  readonly facts: EvidenceFacts;
  readonly item: T;
}

export interface EvidenceBucket<T> {
  readonly tier: EvidenceTier;
  readonly label: string;
  readonly count: number;
  readonly items: readonly T[];
}

export interface EvidenceRecord<T> {
  readonly verifiedHire: EvidenceBucket<T>;
  readonly verifiedPriorWork: EvidenceBucket<T>;
  readonly portfolio: EvidenceBucket<T>;
}

// Tier and label live beside each other so the label can never drift from
// the tier it names.
const VERIFIED_HIRE_LABEL = 'Verified hire';
const VERIFIED_PRIOR_WORK_LABEL = 'Verified prior work';
const PORTFOLIO_LABEL = 'Portfolio claim';

export function evidenceRecord<T>(items: readonly EvidenceItem<T>[]): EvidenceRecord<T> {
  const verifiedHire: T[] = [];
  const verifiedPriorWork: T[] = [];
  const portfolio: T[] = [];

  for (const evidenceItem of items) {
    const tier = evidenceTier(evidenceItem.facts);
    if (tier === 'verified-hire') {
      verifiedHire.push(evidenceItem.item);
    } else if (tier === 'verified-prior-work') {
      verifiedPriorWork.push(evidenceItem.item);
    } else {
      portfolio.push(evidenceItem.item);
    }
  }

  return {
    verifiedHire: {
      tier: 'verified-hire',
      label: VERIFIED_HIRE_LABEL,
      count: verifiedHire.length,
      items: verifiedHire,
    },
    verifiedPriorWork: {
      tier: 'verified-prior-work',
      label: VERIFIED_PRIOR_WORK_LABEL,
      count: verifiedPriorWork.length,
      items: verifiedPriorWork,
    },
    portfolio: {
      tier: 'portfolio',
      label: PORTFOLIO_LABEL,
      count: portfolio.length,
      items: portfolio,
    },
  };
}
