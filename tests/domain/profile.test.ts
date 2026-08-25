import { describe, expect, it } from 'vitest';
import { evidenceRecord, type EvidenceItem } from '../../src/domain/profile.js';
import type { EvidenceFacts } from '../../src/domain/evidence.js';

function facts(overrides: Partial<EvidenceFacts> = {}): EvidenceFacts {
  return {
    platformBrokered: false,
    pullRequestMerged: false,
    signedCommit: false,
    repositoryPublic: false,
    ownerSubmitted: false,
    ...overrides,
  };
}

const HIRE_FACTS: EvidenceFacts = facts({
  platformBrokered: true,
  pullRequestMerged: true,
  repositoryPublic: true,
});

const PRIOR_WORK_FACTS: EvidenceFacts = facts({
  signedCommit: true,
  repositoryPublic: true,
});

const PORTFOLIO_FACTS: EvidenceFacts = facts({ ownerSubmitted: true });

function item<T>(facts: EvidenceFacts, item: T): EvidenceItem<T> {
  return { facts, item };
}

// Every numeric value found anywhere in an object, walked recursively, so a
// blended total hiding at any depth cannot escape the sweep.
function collectNumbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === 'number') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectNumbers(entry, out);
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) collectNumbers((value as Record<string, unknown>)[key], out);
  }
  return out;
}

describe('evidenceRecord', () => {
  it('buckets items into three tiers with independent counts', () => {
    // 2 verified-hire, 3 verified-prior-work, 4 portfolio: chosen so that no
    // count collides with any pairwise or three-way sum (5, 6, 7, 9), which
    // is what the next test relies on.
    const items = [
      ...Array.from({ length: 2 }, (_, i) => item(HIRE_FACTS, `hire-${i}`)),
      ...Array.from({ length: 3 }, (_, i) => item(PRIOR_WORK_FACTS, `prior-${i}`)),
      ...Array.from({ length: 4 }, (_, i) => item(PORTFOLIO_FACTS, `portfolio-${i}`)),
    ];
    const record = evidenceRecord(items);
    expect(record.verifiedHire.count).toBe(2);
    expect(record.verifiedPriorWork.count).toBe(3);
    expect(record.portfolio.count).toBe(4);
  });

  it('never produces a blended number anywhere in the record', () => {
    const items = [
      ...Array.from({ length: 2 }, (_, i) => item(HIRE_FACTS, `hire-${i}`)),
      ...Array.from({ length: 3 }, (_, i) => item(PRIOR_WORK_FACTS, `prior-${i}`)),
      ...Array.from({ length: 4 }, (_, i) => item(PORTFOLIO_FACTS, `portfolio-${i}`)),
    ];
    const record = evidenceRecord(items);
    const numbers = collectNumbers(record);
    const forbidden = [9, 5, 6, 7]; // total, and every pairwise sum of 2, 3, 4
    for (const value of forbidden) {
      expect(numbers).not.toContain(value);
    }
  });

  it('pins the key set: three tiers, no fourth key, and each bucket has exactly count/items/label/tier', () => {
    const record = evidenceRecord([]);
    expect(Object.keys(record).sort()).toEqual(['portfolio', 'verifiedHire', 'verifiedPriorWork']);
    for (const bucket of [record.verifiedHire, record.verifiedPriorWork, record.portfolio]) {
      expect(Object.keys(bucket).sort()).toEqual(['count', 'items', 'label', 'tier']);
    }
  });

  it('is total: empty input yields three zeroed buckets and never throws', () => {
    const record = evidenceRecord([]);
    expect(record.verifiedHire).toEqual({
      tier: 'verified-hire',
      label: 'Verified hire',
      count: 0,
      items: [],
    });
    expect(record.verifiedPriorWork).toEqual({
      tier: 'verified-prior-work',
      label: 'Verified prior work',
      count: 0,
      items: [],
    });
    expect(record.portfolio).toEqual({
      tier: 'portfolio',
      label: 'Portfolio claim',
      count: 0,
      items: [],
    });
  });

  it('labels are present and pairwise distinct', () => {
    const record = evidenceRecord([]);
    const labels = [record.verifiedHire.label, record.verifiedPriorWork.label, record.portfolio.label];
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(0);
    }
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('preserves input order within a bucket and routes each item by its facts', () => {
    const record = evidenceRecord([
      item(HIRE_FACTS, 'hire-a'),
      item(PRIOR_WORK_FACTS, 'prior-a'),
      item(HIRE_FACTS, 'hire-b'),
      item(PORTFOLIO_FACTS, 'portfolio-a'),
    ]);
    expect(record.verifiedHire.items).toEqual(['hire-a', 'hire-b']);
    expect(record.verifiedPriorWork.items).toEqual(['prior-a']);
    expect(record.portfolio.items).toEqual(['portfolio-a']);
  });

  it('never promotes an owner-submitted claim into a verified bucket', () => {
    const record = evidenceRecord([item(PORTFOLIO_FACTS, 'claimed')]);
    expect(record.portfolio.items).toEqual(['claimed']);
    expect(record.verifiedHire.items).toEqual([]);
    expect(record.verifiedPriorWork.items).toEqual([]);
  });
});
