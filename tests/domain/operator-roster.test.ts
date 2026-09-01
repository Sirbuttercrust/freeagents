// R-19 (ENT-2.2, D4): the operator roster's aggregate record. The anchor:
// an operator page is the sum of who they run, never a score for the
// operator. This module derives the aggregate from the roster's own browse
// cards, one tier at a time, the same structural pattern toBrowseCard uses
// for buyerCount (src/domain/browse.ts): no caller may hand this function a
// total drawn from a wider population than the tier it names.
import { describe, expect, it } from 'vitest';
import { operatorAggregate } from '../../src/domain/operator-roster.js';
import { toBrowseCard, type BrowseCard } from '../../src/domain/browse.js';
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

function agentCard(
  did: string,
  verifiedHireCount: number,
  portfolioCount: number,
): BrowseCard {
  return toBrowseCard(
    { did, name: did, skills: [], createdAt: new Date('2026-01-01T00:00:00.000Z') },
    workRecord({
      verifiedHires: Array.from({ length: verifiedHireCount }, (_, i) => hireItem({ mergeCommit: `${did}-hire-${i}` })),
      portfolio: Array.from({ length: portfolioCount }, (_, i) => hireItem({ mergeCommit: `${did}-portfolio-${i}` })),
    }),
  );
}

describe('operatorAggregate', () => {
  it('sums each tier separately across every agent in the roster, never blended', () => {
    const cards = [agentCard('did:abt:zOne', 2, 1), agentCard('did:abt:zTwo', 3, 4)];

    const aggregate = operatorAggregate(cards);

    expect(aggregate.totalVerifiedHireCount).toBe(5);
    expect(aggregate.totalVerifiedPriorWorkCount).toBe(0);
    expect(aggregate.totalPortfolioCount).toBe(5);
  });

  it('an operator with zero agents gets three honest zeros, not an absent aggregate (ENT-2.4)', () => {
    const aggregate = operatorAggregate([]);

    expect(aggregate).toEqual({
      totalVerifiedHireCount: 0,
      totalVerifiedPriorWorkCount: 0,
      totalPortfolioCount: 0,
    });
  });

  it('a single-agent operator aggregates to exactly that agent\'s own counts', () => {
    const cards = [agentCard('did:abt:zSolo', 4, 2)];

    const aggregate = operatorAggregate(cards);

    expect(aggregate.totalVerifiedHireCount).toBe(4);
    expect(aggregate.totalPortfolioCount).toBe(2);
  });
});

// R-17/R-20's structural no-blend pattern, restated for the operator
// aggregate (mutation-proof requirement on the card): a walk of every
// numeric field on the aggregate must never equal a sum of two DIFFERENT
// tier totals. This is the automated check standing behind operatorAggregate's
// own comment promising no field mixes tiers.
describe('operatorAggregate: structural no-blend sweep', () => {
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

  function forbiddenSumsFor(tierTotals: readonly number[]): Set<number> {
    const forbiddenSums = new Set<number>();
    for (let i = 0; i < tierTotals.length; i += 1) {
      for (let j = i + 1; j < tierTotals.length; j += 1) {
        forbiddenSums.add((tierTotals[i] ?? 0) + (tierTotals[j] ?? 0));
      }
    }
    forbiddenSums.add(tierTotals.reduce((a, b) => a + b, 0));
    forbiddenSums.delete(0);
    return forbiddenSums;
  }

  it('no field on the aggregate equals a sum of two tier totals', () => {
    // Chosen so the three per-tier totals (3, 0, 5) and their pairwise sums
    // {3, 5, 8} do not coincidentally collide with either individual total,
    // the same care browse's own sweep fixture takes.
    const cards = [agentCard('did:abt:zSweepA', 1, 2), agentCard('did:abt:zSweepB', 2, 3)];
    const aggregate = operatorAggregate(cards);

    expect(aggregate.totalVerifiedHireCount).toBe(3);
    expect(aggregate.totalVerifiedPriorWorkCount).toBe(0);
    expect(aggregate.totalPortfolioCount).toBe(5);

    const tierTotals = [aggregate.totalVerifiedHireCount, aggregate.totalVerifiedPriorWorkCount, aggregate.totalPortfolioCount];
    const forbiddenSums = forbiddenSumsFor(tierTotals);
    expect(forbiddenSums).toEqual(new Set([3, 5, 8]));

    const namedFields = ['totalVerifiedHireCount', 'totalVerifiedPriorWorkCount', 'totalPortfolioCount'];
    for (const { path, value } of numericFields(aggregate, '')) {
      if (namedFields.includes(path)) continue;
      expect(forbiddenSums.has(value), `field '${path}' = ${value} equals a sum of two tiers' totals`).toBe(false);
    }
  });

  // Mutation proof (card requirement): make the aggregate a sum across two
  // tiers, confirm the sweep catches it. This is the positive control that
  // proves the sweep instrument itself bites on a genuinely blended field,
  // run against the SAME fixture and forbidden-sum set as the test above.
  it('mutation proof: injecting a field that sums two tier totals is caught by the sweep', () => {
    const cards = [agentCard('did:abt:zMutantA', 1, 2), agentCard('did:abt:zMutantB', 2, 3)];
    const aggregate = operatorAggregate(cards);
    const tierTotals = [aggregate.totalVerifiedHireCount, aggregate.totalVerifiedPriorWorkCount, aggregate.totalPortfolioCount];
    const forbiddenSums = forbiddenSumsFor(tierTotals);

    const mutated = { ...aggregate, combinedRecord: aggregate.totalVerifiedHireCount + aggregate.totalPortfolioCount };
    const offenders: string[] = [];
    for (const { path, value } of numericFields(mutated, '')) {
      if (['totalVerifiedHireCount', 'totalVerifiedPriorWorkCount', 'totalPortfolioCount'].includes(path)) continue;
      if (forbiddenSums.has(value)) offenders.push(path);
    }
    expect(offenders).toContain('combinedRecord');
  });
});
