// R-33: the buyer-diversity label for an agent's hire record (MISSION.md
// invariant 5: distinct things are never presented as equivalent, never
// merged into one number). A hire whose buyer resolves to the agent's own
// operator is a self-hire. Self-hires are counted, never hidden, never
// subtracted: they ride beside the totals as their own fields and label
// every row they touch, so no reading of this data can present five
// self-hires as five independent buyers.

import { didSuffix } from './agent.js';

// Structural input, so a caller may pass a stored CompletedJob or a
// reconstructed one. Only the fields the rule reads.
export interface HireFacts {
  readonly jobId: string;
  readonly buyerDid: string;
  readonly agentDid: string;
  readonly mergeCommit: string;
  readonly completedAt: Date | string;
}

export interface LabelledHire {
  readonly jobId: string;
  readonly buyerDid: string;
  readonly agentDid: string;
  readonly mergeCommit: string;
  readonly completedAt: string; // ISO-8601, or '' when unparseable
  readonly selfHire: boolean; // the label, on every single row
}

export interface HireCounts {
  readonly hires: number; // total, self-hires INCLUDED
  readonly buyers: number; // distinct buyer identities, self INCLUDED
  readonly selfHires: number; // of `hires`, how many were self-hires
  readonly selfHireBuyers: number; // of `buyers`, how many were the operator
}

export interface BuyerDiversity {
  readonly counts: HireCounts;
  readonly entries: readonly LabelledHire[];
}

// Milliseconds since epoch for a Date or a parseable string, null otherwise.
// Mirrors liveness.ts parseInstant: unparseable input is swallowed, not
// thrown.
function parseInstant(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

// A self-hire is a same-key comparison, never a same-string one. Wallet form
// (`z...`) and registry form (`did:abt:z...`) name the same key
// (src/domain/agent.ts:33-37), and every other DID comparison in this
// codebase reconciles them first with `didSuffix`. A raw `===` would let one
// operator hire its own agent under the wallet form and read as an
// independent buyer - exactly the invariant-5 failure this issue exists to
// prevent. A null, empty, or non-string `agentOperatorDid` makes every hire
// not-a-self-hire: an unresolvable operator is not evidence of a self-hire,
// and inventing one would label an honest buyer.
export function isSelfHire(buyerDid: unknown, agentOperatorDid: unknown): boolean {
  if (typeof buyerDid !== 'string' || buyerDid === '') return false;
  if (typeof agentOperatorDid !== 'string' || agentOperatorDid === '') return false;
  return didSuffix(buyerDid) === didSuffix(agentOperatorDid);
}

// The full hire record: counts and labelled rows, derived at read time.
// Total over any input - a non-array `hires`, a row missing a field, an
// unparseable `completedAt` - none of these throw, the same way
// liveness.ts's parseInstant swallows bad input rather than throwing.
// `entries` preserves the caller's order: ordering is the storage layer's
// job, and a pure rule does not re-sort.
export function buyerDiversity(hires: readonly HireFacts[], agentOperatorDid: string | null): BuyerDiversity {
  const rows: HireFacts[] = Array.isArray(hires) ? [...hires] : [];

  const entries: LabelledHire[] = rows.map((hire) => {
    const completedMs = parseInstant(hire?.completedAt);
    return {
      jobId: hire?.jobId ?? '',
      buyerDid: hire?.buyerDid ?? '',
      agentDid: hire?.agentDid ?? '',
      mergeCommit: hire?.mergeCommit ?? '',
      completedAt: completedMs === null ? '' : new Date(completedMs).toISOString(),
      selfHire: isSelfHire(hire?.buyerDid, agentOperatorDid),
    };
  });

  // Distinct buyers are counted by `didSuffix(buyerDid)`, not by the raw
  // string, for the same reconciliation reason as `isSelfHire`: one buyer in
  // two forms must not read as two.
  const distinctBuyerKeys = new Set<string>();
  const selfHireBuyerKeys = new Set<string>();
  let selfHires = 0;

  for (const entry of entries) {
    if (typeof entry.buyerDid === 'string' && entry.buyerDid !== '') {
      const key = didSuffix(entry.buyerDid);
      distinctBuyerKeys.add(key);
      if (entry.selfHire) selfHireBuyerKeys.add(key);
    }
    if (entry.selfHire) selfHires += 1;
  }

  return {
    counts: {
      hires: entries.length,
      buyers: distinctBuyerKeys.size,
      selfHires,
      selfHireBuyers: selfHireBuyerKeys.size,
    },
    entries,
  };
}
