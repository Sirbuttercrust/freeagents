// R-20 (ENT-2.2, D1): the browse surface's pure rules. D1 governs default
// order (verified hires, descending, a query parameter) and the closed sort
// set Q1 named (recently listed, recently verified); nothing here may ever
// rank on a crowd-inflatable signal or blend two tiers into one number.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BROWSE_SORT,
  filterBySkill,
  resolveBrowseSort,
  sortBrowseCards,
  toBrowseCard,
  type BrowseCard,
} from '../../src/domain/browse.js';
import type { AgentWorkRecord, VerifiedHireItem } from '../../src/domain/agent-work-record.js';

function hireItem(overrides: Partial<VerifiedHireItem> = {}): VerifiedHireItem {
  return {
    credentialId: 'https://platform.example/v1/credentials/job-1',
    repository: 'buyer/target-repo',
    pullRequest: 'https://github.com/buyer/target-repo/pull/1',
    mergedAt: '2026-01-03T00:00:00.000Z',
    mergeCommit: 'deadbeef',
    buyerDid: 'did:example:buyer',
    ...overrides,
  };
}

function workRecord(overrides: Partial<AgentWorkRecord> = {}): AgentWorkRecord {
  return { verifiedHires: [], verifiedPriorWork: [], portfolio: [], ...overrides };
}

describe('resolveBrowseSort', () => {
  it('accepts the three named sort keys, unchanged', () => {
    expect(resolveBrowseSort('verified-hires')).toBe('verified-hires');
    expect(resolveBrowseSort('recently-listed')).toBe('recently-listed');
    expect(resolveBrowseSort('recently-verified')).toBe('recently-verified');
  });

  it('falls back to the default rather than erroring or inventing one, for any unknown value', () => {
    expect(resolveBrowseSort('most-popular')).toBe(DEFAULT_BROWSE_SORT);
    expect(resolveBrowseSort('upvotes')).toBe(DEFAULT_BROWSE_SORT);
    expect(resolveBrowseSort(undefined)).toBe(DEFAULT_BROWSE_SORT);
    expect(resolveBrowseSort(null)).toBe(DEFAULT_BROWSE_SORT);
    expect(resolveBrowseSort(42)).toBe(DEFAULT_BROWSE_SORT);
    expect(resolveBrowseSort([])).toBe(DEFAULT_BROWSE_SORT);
    expect(resolveBrowseSort('')).toBe(DEFAULT_BROWSE_SORT);
  });

  it('the default is verified-hires (D1)', () => {
    expect(DEFAULT_BROWSE_SORT).toBe('verified-hires');
  });
});

describe('toBrowseCard', () => {
  it('carries the three tier counts separately, never a sum, plus the buyer count riding beside the verified tier', () => {
    const card = toBrowseCard(
      {
        did: 'did:abt:zAgentOne',
        name: 'scout',
        skills: ['triage', 'typescript'],
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      workRecord({
        verifiedHires: [
          hireItem({ credentialId: 'x1', mergeCommit: 'c1', buyerDid: 'did:example:buyer-a' }),
          hireItem({ credentialId: 'x2', mergeCommit: 'c2', buyerDid: 'did:example:buyer-b' }),
        ],
      }),
    );

    expect(card.verifiedHireCount).toBe(2);
    expect(card.verifiedPriorWorkCount).toBe(0);
    expect(card.portfolioCount).toBe(0);
    expect(card.buyerCount).toBe(2);
    expect(card.did).toBe('did:abt:zAgentOne');
    expect(card.skills).toEqual(['triage', 'typescript']);
    expect(card.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('a cold-start agent (no credentials at all) renders honest zeros, not an absence', () => {
    const card = toBrowseCard(
      { did: 'did:abt:zColdAgent', name: 'blank', skills: [], createdAt: new Date('2026-02-01T00:00:00.000Z') },
      workRecord(),
    );

    expect(card.verifiedHireCount).toBe(0);
    expect(card.verifiedPriorWorkCount).toBe(0);
    expect(card.portfolioCount).toBe(0);
    expect(card.buyerCount).toBe(0);
    expect(card.lastVerifiedAt).toBeNull();
  });

  it('lastVerifiedAt is the latest verified-hire mergedAt, never derived from prior-work or portfolio', () => {
    const card = toBrowseCard(
      { did: 'did:abt:zAgentDates', name: 'scout', skills: [], createdAt: new Date('2026-01-01T00:00:00.000Z') },
      workRecord({
        verifiedHires: [
          hireItem({ mergedAt: '2026-01-05T00:00:00.000Z', mergeCommit: 'a' }),
          hireItem({ mergedAt: '2026-03-09T00:00:00.000Z', mergeCommit: 'b' }),
          hireItem({ mergedAt: '2026-02-02T00:00:00.000Z', mergeCommit: 'c' }),
        ],
        portfolio: [hireItem({ mergedAt: '2026-12-31T00:00:00.000Z', mergeCommit: 'd' })],
      }),
    );

    expect(card.lastVerifiedAt).toBe('2026-03-09T00:00:00.000Z');
  });

  // Proof (t_698205aa, defect summary-contradicts-tier): buyerCount used to
  // be handed in from a tier-blind buyerDiversity() call over EVERY
  // completed job, so an agent with one public and two private merges
  // rendered "1 verified hire, 3 buyers" while its own profile page said
  // "1 verified hire, from 1 buyer." toBrowseCard now derives buyerCount
  // itself, from record.verifiedHires alone, so a caller can no longer hand
  // it a number drawn from a wider population than the tier it rides beside.
  it('buyerCount is the distinct-buyer count over verified hires ONLY, never a wider population', () => {
    const card = toBrowseCard(
      { did: 'did:abt:zDivergent', name: 'divergent', skills: [], createdAt: new Date('2026-01-01T00:00:00.000Z') },
      workRecord({
        // One verified hire, buyer-a.
        verifiedHires: [hireItem({ mergeCommit: 'public-1', buyerDid: 'did:example:buyer-a' })],
        // Two portfolio items (private-repo merges), buyers b and c. These
        // are real hires this platform brokered, just not verified-tier
        // ones, and their buyers must never inflate the card's buyer count.
        portfolio: [
          hireItem({ mergeCommit: 'private-1', buyerDid: 'did:example:buyer-b' }),
          hireItem({ mergeCommit: 'private-2', buyerDid: 'did:example:buyer-c' }),
        ],
      }),
    );

    expect(card.verifiedHireCount).toBe(1);
    // The exact reproduction Proof used: 1 verified hire must ride beside
    // 1 buyer, never 3.
    expect(card.buyerCount).toBe(1);
  });

  it('buyerCount reconciles wallet-form and registry-form DIDs as one buyer, matching the profile page', () => {
    const card = toBrowseCard(
      { did: 'did:abt:zSameBuyerForms', name: 'same-buyer', skills: [], createdAt: new Date('2026-01-01T00:00:00.000Z') },
      workRecord({
        verifiedHires: [
          hireItem({ mergeCommit: 'a', buyerDid: 'zSameBuyer' }),
          hireItem({ mergeCommit: 'b', buyerDid: 'did:abt:zSameBuyer' }),
        ],
      }),
    );

    expect(card.verifiedHireCount).toBe(2);
    expect(card.buyerCount).toBe(1);
  });

  it('an empty-string or non-string buyerDid on a verified hire is not counted as a distinct buyer', () => {
    const card = toBrowseCard(
      { did: 'did:abt:zNoBuyer', name: 'no-buyer', skills: [], createdAt: new Date('2026-01-01T00:00:00.000Z') },
      workRecord({ verifiedHires: [hireItem({ mergeCommit: 'a', buyerDid: '' })] }),
    );

    expect(card.verifiedHireCount).toBe(1);
    expect(card.buyerCount).toBe(0);
  });
});

describe('filterBySkill', () => {
  const cards: BrowseCard[] = [
    toBrowseCard({ did: 'did:abt:a', name: 'a', skills: ['triage'], createdAt: new Date() }, workRecord()),
    toBrowseCard({ did: 'did:abt:b', name: 'b', skills: ['TypeScript'], createdAt: new Date() }, workRecord()),
    toBrowseCard({ did: 'did:abt:c', name: 'c', skills: ['triage', 'refactoring'], createdAt: new Date() }, workRecord()),
  ];

  it('keeps only cards carrying the skill, case-insensitively', () => {
    const filtered = filterBySkill(cards, 'typescript');
    expect(filtered.map((c) => c.did)).toEqual(['did:abt:b']);
  });

  it('returns every card, unfiltered, when no skill is named', () => {
    expect(filterBySkill(cards, null).map((c) => c.did)).toEqual(['did:abt:a', 'did:abt:b', 'did:abt:c']);
    expect(filterBySkill(cards, '').map((c) => c.did)).toEqual(['did:abt:a', 'did:abt:b', 'did:abt:c']);
    expect(filterBySkill(cards, '   ').map((c) => c.did)).toEqual(['did:abt:a', 'did:abt:b', 'did:abt:c']);
  });

  it('never reorders: the filtered set keeps its input order', () => {
    const filtered = filterBySkill(cards, 'triage');
    expect(filtered.map((c) => c.did)).toEqual(['did:abt:a', 'did:abt:c']);
  });
});

describe('sortBrowseCards', () => {
  function card(
    did: string,
    verifiedHireCount: number,
    createdAt: string,
    lastVerifiedAt: string | null,
    verifiedPriorWorkCount = 0,
    portfolioCount = 0,
  ): BrowseCard {
    return {
      did,
      name: did,
      skills: [],
      createdAt,
      lastVerifiedAt,
      verifiedHireCount,
      verifiedPriorWorkCount,
      portfolioCount,
      buyerCount: 0,
    };
  }

  it('default order (verified-hires): descending by verified hire count (D1)', () => {
    const cards = [
      card('did:abt:low', 1, '2026-01-01T00:00:00.000Z', null),
      card('did:abt:high', 9, '2026-01-01T00:00:00.000Z', null),
      card('did:abt:mid', 4, '2026-01-01T00:00:00.000Z', null),
    ];
    const sorted = sortBrowseCards(cards, 'verified-hires');
    expect(sorted.map((c) => c.did)).toEqual(['did:abt:high', 'did:abt:mid', 'did:abt:low']);
  });

  it('default order ranks on verifiedHireCount alone, not a blend with portfolioCount (mutation guard)', () => {
    // 'fewerHiresMorePortfolio' has fewer verified hires than 'moreHires'
    // but enough extra portfolioCount that a blended sum
    // (verifiedHireCount + portfolioCount) would rank it FIRST. A correct,
    // never-blended sort ranks it second: only the witnessed tier counts.
    const cards: BrowseCard[] = [
      { ...card('did:abt:moreHires', 5, '2026-01-01T00:00:00.000Z', null), portfolioCount: 0 },
      { ...card('did:abt:fewerHiresMorePortfolio', 2, '2026-01-01T00:00:00.000Z', null), portfolioCount: 10 },
    ];
    const sorted = sortBrowseCards(cards, 'verified-hires');
    expect(sorted.map((c) => c.did)).toEqual(['did:abt:moreHires', 'did:abt:fewerHiresMorePortfolio']);
  });

  // Proof (t_698205aa, defect sort-mutation-guard-too-weak): the guard above
  // only exercises a hire+portfolio blend, and its fixture pins
  // verifiedPriorWorkCount to 0 on every card, so a comparator blended with
  // verifiedPriorWorkCount instead (Proof's own mutation:
  // (b.verifiedHireCount + b.verifiedPriorWorkCount) - (a...)) was invisible
  // to it -- the full suite stayed green. This fixture makes
  // verifiedPriorWorkCount the one that would flip the order under that
  // exact blend, so sortBrowseCards's real comparator (verifiedHireCount
  // alone) is what this test actually exercises.
  it('default order ranks on verifiedHireCount alone, not a blend with verifiedPriorWorkCount (mutation guard)', () => {
    const cards: BrowseCard[] = [
      card('did:abt:moreHires', 5, '2026-01-01T00:00:00.000Z', null, 0),
      card('did:abt:fewerHiresMorePriorWork', 2, '2026-01-01T00:00:00.000Z', null, 10),
    ];
    const sorted = sortBrowseCards(cards, 'verified-hires');
    expect(sorted.map((c) => c.did)).toEqual(['did:abt:moreHires', 'did:abt:fewerHiresMorePriorWork']);
  });

  it('recently-listed: descending by createdAt', () => {
    const cards = [
      card('did:abt:old', 0, '2026-01-01T00:00:00.000Z', null),
      card('did:abt:new', 0, '2026-03-01T00:00:00.000Z', null),
      card('did:abt:mid', 0, '2026-02-01T00:00:00.000Z', null),
    ];
    const sorted = sortBrowseCards(cards, 'recently-listed');
    expect(sorted.map((c) => c.did)).toEqual(['did:abt:new', 'did:abt:mid', 'did:abt:old']);
  });

  it('recently-verified: descending by lastVerifiedAt, agents with none sink to the end', () => {
    const cards = [
      card('did:abt:never', 0, '2026-01-01T00:00:00.000Z', null),
      card('did:abt:recent', 3, '2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
      card('did:abt:older', 5, '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
    ];
    const sorted = sortBrowseCards(cards, 'recently-verified');
    expect(sorted.map((c) => c.did)).toEqual(['did:abt:recent', 'did:abt:older', 'did:abt:never']);
  });

  it('a cold-start agent (all zeros) is ordered by the active sort like everyone else, never buried or boosted', () => {
    const cards = [
      card('did:abt:established', 5, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
      card('did:abt:cold', 0, '2026-06-01T00:00:00.000Z', null),
    ];
    // Under recently-listed, the cold-start agent is genuinely the newer
    // listing and must rank first: no reordering exists to bury a zero.
    expect(sortBrowseCards(cards, 'recently-listed').map((c) => c.did)).toEqual(['did:abt:cold', 'did:abt:established']);
    // Under verified-hires, the zero genuinely sorts last: no boost either.
    expect(sortBrowseCards(cards, 'verified-hires').map((c) => c.did)).toEqual(['did:abt:established', 'did:abt:cold']);
  });

  it('does not mutate the input array', () => {
    const cards = [card('did:abt:a', 1, '2026-01-01T00:00:00.000Z', null), card('did:abt:b', 5, '2026-01-01T00:00:00.000Z', null)];
    const original = [...cards];
    sortBrowseCards(cards, 'verified-hires');
    expect(cards).toEqual(original);
  });
});

// R-17's structural no-blend pattern, restated for the browse payload
// (mutation-proof requirement on the card): a walk of every numeric field
// on a card must never equal a sum of two of the three tier counts. This
// is the automated check that stands behind toBrowseCard's own comment
// promising no field is derived from more than one tier.
describe('toBrowseCard: structural no-blend sweep', () => {
  function numericFields(value: unknown, path: string): Array<{ path: string; value: number }> {
    if (typeof value === 'number') return [{ path, value }];
    if (Array.isArray(value)) return value.flatMap((entry, i) => numericFields(entry, `${path}[${i}]`));
    if (value !== null && typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
        numericFields(entry, path === '' ? key : `${path}.${key}`),
      );
    }
    return [];
  }

  function forbiddenSumsFor(tierCounts: readonly number[]): Set<number> {
    const forbiddenSums = new Set<number>();
    for (let i = 0; i < tierCounts.length; i += 1) {
      for (let j = i + 1; j < tierCounts.length; j += 1) {
        forbiddenSums.add((tierCounts[i] ?? 0) + (tierCounts[j] ?? 0));
      }
    }
    forbiddenSums.add(tierCounts.reduce((a, b) => a + b, 0));
    forbiddenSums.delete(0);
    return forbiddenSums;
  }

  // Proof (t_698205aa, defect no-blend-sweep-vacuous) reproduced the sweep
  // code verbatim against a reachable state (1 public, 2 private, 3
  // distinct buyers) and it reported offenders ["buyerCount=3"], because
  // the shipped fixture picked a buyerCount value (7) that was deliberately
  // outside the forbidden set. This fixture's buyerCount is no longer a
  // caller-supplied value at all -- toBrowseCard derives it -- so the
  // reachable state IS the fixture: three verified hires from a single
  // buyer (buyerCount 1) plus two portfolio items, chosen so 1 does not
  // coincidentally collide with a forbidden sum of {3, 5, 2}, which is what
  // makes this a real check rather than a fixture picked to dodge one.
  it('no field on the card equals a sum of two tier counts', () => {
    const card = toBrowseCard(
      { did: 'did:abt:zSweep', name: 'sweep', skills: [], createdAt: new Date('2026-01-01T00:00:00.000Z') },
      workRecord({
        verifiedHires: [
          hireItem({ mergeCommit: 'a', buyerDid: 'did:example:buyer-shared' }),
          hireItem({ mergeCommit: 'b', buyerDid: 'did:example:buyer-shared' }),
          hireItem({ mergeCommit: 'c', buyerDid: 'did:example:buyer-shared' }),
        ],
        portfolio: [hireItem({ mergeCommit: 'd' }), hireItem({ mergeCommit: 'e' })],
      }),
    );

    expect(card.verifiedHireCount).toBe(3);
    expect(card.portfolioCount).toBe(2);
    expect(card.buyerCount).toBe(1);

    const tierCounts = [card.verifiedHireCount, card.verifiedPriorWorkCount, card.portfolioCount];
    const forbiddenSums = forbiddenSumsFor(tierCounts);
    expect(forbiddenSums).toEqual(new Set([3, 5, 2]));

    for (const { path, value } of numericFields(card, '')) {
      if (['verifiedHireCount', 'verifiedPriorWorkCount', 'portfolioCount'].includes(path)) continue;
      expect(forbiddenSums.has(value), `field '${path}' = ${value} equals a sum of two tiers' counts`).toBe(false);
    }
  });

  // Positive control (mirrors Proof's reproduction with an injected
  // combinedEvidence field): the sweep instrument itself must catch a
  // genuinely blended field. Run against the SAME card and forbidden-sum
  // set as the test above, so this proves the sweep bites on the resident
  // shape, not only on a fixture built to be caught.
  it('mutation proof: injecting a field that sums two tier counts is caught by the sweep', () => {
    const card = toBrowseCard(
      { did: 'did:abt:zSweepMutant', name: 'sweep-mutant', skills: [], createdAt: new Date('2026-01-01T00:00:00.000Z') },
      workRecord({
        verifiedHires: [
          hireItem({ mergeCommit: 'a', buyerDid: 'did:example:buyer-shared' }),
          hireItem({ mergeCommit: 'b', buyerDid: 'did:example:buyer-shared' }),
          hireItem({ mergeCommit: 'c', buyerDid: 'did:example:buyer-shared' }),
        ],
        portfolio: [hireItem({ mergeCommit: 'd' }), hireItem({ mergeCommit: 'e' })],
      }),
    );
    const tierCounts = [card.verifiedHireCount, card.verifiedPriorWorkCount, card.portfolioCount];
    const forbiddenSums = forbiddenSumsFor(tierCounts);

    const mutated = { ...card, combinedEvidence: card.verifiedHireCount + card.portfolioCount };
    const offenders: string[] = [];
    for (const { path, value } of numericFields(mutated, '')) {
      if (['verifiedHireCount', 'verifiedPriorWorkCount', 'portfolioCount'].includes(path)) continue;
      if (forbiddenSums.has(value)) offenders.push(path);
    }
    expect(offenders).toContain('combinedEvidence');
  });
});
