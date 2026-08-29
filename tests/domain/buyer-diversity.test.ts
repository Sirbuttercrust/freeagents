import { describe, expect, it } from 'vitest';
import { buyerDiversity, isSelfHire } from '../../src/domain/buyer-diversity.js';
import type { HireFacts } from '../../src/domain/buyer-diversity.js';

function hire(overrides: Partial<HireFacts> = {}): HireFacts {
  return {
    jobId: 'job-1',
    buyerDid: 'did:abt:zBuyer1',
    agentDid: 'did:abt:zAgent1',
    mergeCommit: 'abc123',
    completedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('buyerDiversity', () => {
  it('twelve completed hires from four distinct buyers gives hires: 12, buyers: 4', () => {
    const hires: HireFacts[] = [];
    const buyers: readonly string[] = ['did:abt:zBuyerA', 'did:abt:zBuyerB', 'did:abt:zBuyerC', 'did:abt:zBuyerD'];
    for (let i = 0; i < 12; i += 1) {
      const buyerDid = buyers[i % 4] as string;
      hires.push(hire({ jobId: `job-${i}`, buyerDid }));
    }
    const result = buyerDiversity(hires, null);
    expect(result.counts).toEqual({ hires: 12, buyers: 4, selfHires: 0, selfHireBuyers: 0 });
  });

  it('empty input gives all-zero counts and an empty entries array (decision D1)', () => {
    const result = buyerDiversity([], null);
    expect(result.counts).toEqual({ hires: 0, buyers: 0, selfHires: 0, selfHireBuyers: 0 });
    expect(result.entries).toEqual([]);
  });

  it('five self-hires and no other buyer gives hires: 5, buyers: 1, selfHires: 5, selfHireBuyers: 1', () => {
    const hires = Array.from({ length: 5 }, (_, i) =>
      hire({ jobId: `job-${i}`, buyerDid: 'did:abt:zOperator' }),
    );
    const result = buyerDiversity(hires, 'did:abt:zOperator');
    expect(result.counts).toEqual({ hires: 5, buyers: 1, selfHires: 5, selfHireBuyers: 1 });
    for (const entry of result.entries) {
      expect(entry.selfHire).toBe(true);
    }
  });

  it('a hire whose buyerDid equals the operatorDid is selfHire: true, and is still counted', () => {
    const result = buyerDiversity([hire({ buyerDid: 'did:abt:zOperator' })], 'did:abt:zOperator');
    expect(result.entries[0]?.selfHire).toBe(true);
    expect(result.counts.hires).toBe(1);
  });

  it('the wallet/registry form case: buyerDid zOperatorKeyHash against agentOperatorDid did:abt:zOperatorKeyHash is selfHire: true (fails on a === implementation)', () => {
    expect(isSelfHire('zOperatorKeyHash', 'did:abt:zOperatorKeyHash')).toBe(true);
    const result = buyerDiversity([hire({ buyerDid: 'zOperatorKeyHash' })], 'did:abt:zOperatorKeyHash');
    expect(result.entries[0]?.selfHire).toBe(true);
    expect(result.counts.selfHires).toBe(1);
  });

  it('the same buyer appearing in both DID forms counts as one buyer, not two', () => {
    const result = buyerDiversity(
      [hire({ jobId: 'job-1', buyerDid: 'zSameBuyer' }), hire({ jobId: 'job-2', buyerDid: 'did:abt:zSameBuyer' })],
      null,
    );
    expect(result.counts.buyers).toBe(1);
    expect(result.counts.hires).toBe(2);
  });

  it('a shape-valid but unregistered buyer DID that matches no operator is selfHire: false', () => {
    const result = buyerDiversity([hire({ buyerDid: 'did:abt:zUnregistered' })], 'did:abt:zSomeoneElse');
    expect(result.entries[0]?.selfHire).toBe(false);
    expect(result.counts.selfHires).toBe(0);
  });

  it('agentOperatorDid of null or empty string: every row selfHire: false, nothing throws', () => {
    const hires = [hire({ buyerDid: 'did:abt:zBuyer1' }), hire({ buyerDid: 'did:abt:zBuyer2' })];
    expect(() => buyerDiversity(hires, null)).not.toThrow();
    expect(() => buyerDiversity(hires, '')).not.toThrow();
    expect(buyerDiversity(hires, null).entries.every((e) => e.selfHire === false)).toBe(true);
    expect(buyerDiversity(hires, '').entries.every((e) => e.selfHire === false)).toBe(true);
  });

  it('every row in entries has a boolean selfHire key, never omitted when false', () => {
    const result = buyerDiversity([hire({ buyerDid: 'did:abt:zBuyer1' })], null);
    expect(result.entries[0]).toStrictEqual({
      jobId: 'job-1',
      buyerDid: 'did:abt:zBuyer1',
      agentDid: 'did:abt:zAgent1',
      mergeCommit: 'abc123',
      completedAt: '2026-06-01T00:00:00.000Z',
      selfHire: false,
    });
    expect(Object.prototype.hasOwnProperty.call(result.entries[0], 'selfHire')).toBe(true);
  });

  it('is total: a malformed row does not throw and still counts', () => {
    const malformed = [{ completedAt: 'not a date' } as unknown as HireFacts];
    expect(() => buyerDiversity(malformed, null)).not.toThrow();
    const result = buyerDiversity(malformed, null);
    expect(result.counts.hires).toBe(1);
    expect(result.entries[0]?.completedAt).toBe('');
    expect(result.entries[0]?.selfHire).toBe(false);
  });

  it('a row missing jobId, buyerDid, agentDid and mergeCommit renders each as an empty string, not undefined', () => {
    const malformed = [{ completedAt: 'not a date' } as unknown as HireFacts];
    const result = buyerDiversity(malformed, null);
    expect(result.entries[0]).toStrictEqual({
      jobId: '',
      buyerDid: '',
      agentDid: '',
      mergeCommit: '',
      completedAt: '',
      selfHire: false,
    });
  });

  it('is total: a null or undefined row in the array does not throw and renders as an all-empty entry', () => {
    const malformed = [null, undefined] as unknown as readonly HireFacts[];
    expect(() => buyerDiversity(malformed, null)).not.toThrow();
    const result = buyerDiversity(malformed, null);
    expect(result.counts.hires).toBe(2);
    const emptyEntry = { jobId: '', buyerDid: '', agentDid: '', mergeCommit: '', completedAt: '', selfHire: false };
    expect(result.entries).toEqual([emptyEntry, emptyEntry]);
  });

  it('is total: a non-array hires argument is treated as no hires, not thrown', () => {
    const notAnArray = { length: 3 } as unknown as readonly HireFacts[];
    expect(() => buyerDiversity(notAnArray, null)).not.toThrow();
    const result = buyerDiversity(notAnArray, null);
    expect(result.counts).toEqual({ hires: 0, buyers: 0, selfHires: 0, selfHireBuyers: 0 });
    expect(result.entries).toEqual([]);
  });

  it('a Date completedAt is rendered as its ISO string, not swallowed like a string', () => {
    const result = buyerDiversity([hire({ completedAt: new Date('2026-03-04T05:06:07.000Z') })], null);
    expect(result.entries[0]?.completedAt).toBe('2026-03-04T05:06:07.000Z');
  });

  it('an invalid Date object for completedAt renders as empty, not "Invalid Date"', () => {
    const result = buyerDiversity([hire({ completedAt: new Date('not-a-real-date') })], null);
    expect(result.entries[0]?.completedAt).toBe('');
  });

  it('a completedAt that is neither a Date nor a string (missing entirely) renders as empty', () => {
    const missing = [{ jobId: 'job-1', buyerDid: 'did:abt:zBuyer1', agentDid: 'did:abt:zAgent1', mergeCommit: 'abc123' } as unknown as HireFacts];
    const result = buyerDiversity(missing, null);
    expect(result.entries[0]?.completedAt).toBe('');
  });

  it('an empty-string buyerDid is not counted as a distinct buyer', () => {
    const result = buyerDiversity([hire({ buyerDid: '' })], null);
    expect(result.counts.hires).toBe(1);
    expect(result.counts.buyers).toBe(0);
  });

  it('a non-string buyerDid is not counted as a distinct buyer', () => {
    const malformed = [{ ...hire(), buyerDid: 12345 } as unknown as HireFacts];
    const result = buyerDiversity(malformed, null);
    expect(result.counts.hires).toBe(1);
    expect(result.counts.buyers).toBe(0);
  });

  it('does not export a blended independentBuyers field', () => {
    const result = buyerDiversity([hire()], null);
    expect('independentBuyers' in result.counts).toBe(false);
  });
});

describe('isSelfHire', () => {
  it('is total: non-string inputs never throw and yield false', () => {
    expect(() => isSelfHire(undefined, undefined)).not.toThrow();
    expect(isSelfHire(undefined, undefined)).toBe(false);
    expect(isSelfHire(123, {})).toBe(false);
  });
});
