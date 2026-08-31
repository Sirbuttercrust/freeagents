// R-20 (ENT-2.2, D1): browse assembly, the pure rules only. Sorting and
// filtering never touch storage; the API route (src/api/app.ts) supplies the
// rows and calls straight into this module, the same separation
// agent-work-record.ts keeps from the credential storage it reads.
//
// D1 governs: default sort is verified hires, descending, expressed as a
// query parameter rather than a hardcoded rule. `spec/roadmap.md` R-20 and
// MISSION Q1 forbid inventing a ranking or sorting on anything a crowd can
// inflate (views, stars, upvotes, favourites); the only sort keys this card
// ships are the three D1/Q1 named. An unknown value falls back to the
// default rather than erroring or inventing a fourth.
import type { AgentWorkRecord } from './agent-work-record.js';
import { didSuffix } from './agent.js';

export type BrowseSort = 'verified-hires' | 'recently-listed' | 'recently-verified';

const BROWSE_SORTS: readonly BrowseSort[] = ['verified-hires', 'recently-listed', 'recently-verified'];

export const DEFAULT_BROWSE_SORT: BrowseSort = 'verified-hires';

// Total: any value in (a query string, undefined, a stray array from a
// duplicated query param), one valid BrowseSort out. An unrecognised value
// is not an error and is never passed through as a fourth, invented key.
export function resolveBrowseSort(value: unknown): BrowseSort {
  if (typeof value === 'string' && (BROWSE_SORTS as readonly string[]).includes(value)) {
    return value as BrowseSort;
  }
  return DEFAULT_BROWSE_SORT;
}

// The minimal agent projection the card needs. Deliberately narrower than
// the full Agent row (src/domain/agent.ts): a browse card never carries
// operatorDid, delegation, proofStatus, or githubLogin, none of which item 2
// of the issue (the evidence row) or item 4 (skill filtering) needs.
export interface BrowseAgentFacts {
  readonly did: string;
  readonly name: string;
  readonly skills: readonly string[];
  readonly createdAt: Date;
}

// One row on the browse surface. Three tier counts, always separate, never
// summed (R-17's no-blend rule, restated for this payload): a client reading
// this shape cannot recover a combined score from any single field, only
// from doing the addition itself, which the mutation-proof test below holds
// this module to never doing on its own.
export interface BrowseCard {
  readonly did: string;
  readonly name: string;
  readonly skills: readonly string[];
  readonly createdAt: string; // ISO-8601
  // Latest verified-hire mergedAt, or null when there is none. Read only
  // from the verified-hire tier: a portfolio or prior-work date must never
  // read as "last verified" (MISSION invariant 5, ENT-8.3's separation of
  // observed fact from unverifiable claim).
  readonly lastVerifiedAt: string | null;
  readonly verifiedHireCount: number;
  readonly verifiedPriorWorkCount: number;
  readonly portfolioCount: number;
  // PR 89's buyer-diversity count, riding beside the verified count where it
  // exists (R-20 item 3): "12 verified hires, 9 buyers" never implies a
  // breadth the record does not have, because it is computed from the SAME
  // verifiedHires array as verifiedHireCount, below, never from a wider
  // population (Proof's summary-contradicts-tier finding: a caller-supplied
  // buyerCount drawn from every completed job, tier-blind).
  readonly buyerCount: number;
}

// Distinct buyers, counted over the verified-hire tier ONLY. This is the
// same computation the agent profile page makes over its own
// agent.verifiedHires array (src/web/public/js/pages/agent.js,
// renderSummary): a buyerDid is reconciled to its registry key with
// didSuffix (the wallet-form/registry-form split, same reconciliation
// buyer-diversity.ts uses), so one buyer in two forms never counts as two.
// Reading only the verified-hire array, never a wider job-history read, is
// what keeps this number equal to what the profile page's own summary
// sentence says for the same agent.
function verifiedHireBuyerCount(record: AgentWorkRecord): number {
  const distinctBuyerKeys = new Set<string>();
  for (const hire of record.verifiedHires) {
    if (typeof hire.buyerDid === 'string' && hire.buyerDid !== '') {
      distinctBuyerKeys.add(didSuffix(hire.buyerDid));
    }
  }
  return distinctBuyerKeys.size;
}

// Assembles one card from two independently-sourced facts: the agent row,
// and its R-17 work record (agent-work-record.ts, itself never blended).
// buyerCount is derived here, from record.verifiedHires alone, rather than
// accepted as a caller-supplied number: that is what makes it impossible
// for a caller to hand this function a buyer count drawn from a wider
// population than the verified-hire count it rides beside. No field here
// is a sum, average, or ratio across tiers; each count is read off exactly
// one array.
export function toBrowseCard(agent: BrowseAgentFacts, record: AgentWorkRecord): BrowseCard {
  const lastVerifiedAt = record.verifiedHires.reduce<string | null>((latest, hire) => {
    const ms = Date.parse(hire.mergedAt);
    if (Number.isNaN(ms)) return latest;
    if (latest === null || ms > Date.parse(latest)) return hire.mergedAt;
    return latest;
  }, null);

  return {
    did: agent.did,
    name: agent.name,
    skills: [...agent.skills],
    createdAt: agent.createdAt.toISOString(),
    lastVerifiedAt,
    verifiedHireCount: record.verifiedHires.length,
    verifiedPriorWorkCount: record.verifiedPriorWork.length,
    portfolioCount: record.portfolio.length,
    buyerCount: verifiedHireBuyerCount(record),
  };
}

// Top-bar filtering by skill tag (ENT-2.2). Skills are self-asserted, so
// this filter narrows the list; it never reorders, and it is never used to
// rank. Case-insensitive because the vocabulary is free text (ENT-13.2
// notes disciplines are the curated facet; skills stay free text), so
// 'TypeScript' and 'typescript' must not read as two different filters at
// the one point this card actually filters on them.
export function filterBySkill<T extends { readonly skills: readonly string[] }>(
  cards: readonly T[],
  skill: string | null | undefined,
): T[] {
  const wanted = typeof skill === 'string' ? skill.trim().toLowerCase() : '';
  if (wanted === '') return [...cards];
  return cards.filter((card) => card.skills.some((s) => s.toLowerCase() === wanted));
}

// Sorts a copy of the array; never mutates the caller's. The active sort is
// the ONLY thing that reorders (R-20 item 4: filtering by skill never
// reorders by anything except the active sort), so this is the single
// ordering function the route calls, after filterBySkill.
export function sortBrowseCards(cards: readonly BrowseCard[], sort: BrowseSort): BrowseCard[] {
  const copy = [...cards];
  switch (sort) {
    case 'recently-listed':
      copy.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      return copy;
    case 'recently-verified':
      copy.sort((a, b) => {
        const bMs = b.lastVerifiedAt === null ? -Infinity : Date.parse(b.lastVerifiedAt);
        const aMs = a.lastVerifiedAt === null ? -Infinity : Date.parse(a.lastVerifiedAt);
        return bMs - aMs;
      });
      return copy;
    case 'verified-hires':
    default:
      // D1: the default. Descending by the one tier this platform actually
      // witnessed; a cold-start agent's zero sorts last on its own honest
      // merit, never buried further and never boosted (ENT-2.4).
      copy.sort((a, b) => b.verifiedHireCount - a.verifiedHireCount);
      return copy;
  }
}
