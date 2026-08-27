// R-16: reportWellFormed, sameKey, windowContains and disputedBy are the
// domain rule that lets "disputed" be derived at read time instead of
// written into a signed credential (ENT-8.3). All four are total: any value
// in, one value out, never throws.
import { describe, expect, it } from 'vitest';
import {
  disputedBy,
  reportWellFormed,
  sameKey,
  windowContains,
  type CompromiseReport,
} from '../../src/domain/compromise.js';

function report(overrides: Partial<CompromiseReport> = {}): CompromiseReport {
  return {
    key: 'did:abt:zAbc#zKey',
    since: new Date('2026-08-01T00:00:00.000Z'),
    reportedAt: new Date('2026-08-20T00:00:00.000Z'),
    ...overrides,
  };
}

describe('reportWellFormed', () => {
  it('a well-formed report returns true', () => {
    expect(reportWellFormed(report())).toBe(true);
  });

  it('a missing or empty key returns false', () => {
    expect(reportWellFormed(report({ key: undefined as unknown as string }))).toBe(false);
    expect(reportWellFormed(report({ key: '' }))).toBe(false);
  });

  it('a key with no # is not DID fragment form, so it returns false', () => {
    expect(reportWellFormed(report({ key: 'did:abt:zAbc' }))).toBe(false);
  });

  it('a non-Date, unparseable since returns false', () => {
    expect(reportWellFormed(report({ since: 'not a date' as unknown as Date }))).toBe(false);
  });

  it('an unparseable reportedAt returns false', () => {
    expect(reportWellFormed(report({ reportedAt: 'not a date' as unknown as Date }))).toBe(false);
  });

  it('since after reportedAt returns false: a window cannot close before it opens', () => {
    expect(
      reportWellFormed(
        report({
          since: new Date('2026-08-20T00:00:00.001Z'),
          reportedAt: new Date('2026-08-20T00:00:00.000Z'),
        }),
      ),
    ).toBe(false);
  });

  it('is total on garbage: throws nothing, returns false', () => {
    for (const garbage of [
      null,
      undefined,
      42,
      'string',
      {},
      { key: 1, since: {}, reportedAt: [] },
    ]) {
      expect(() => reportWellFormed(garbage as unknown as CompromiseReport)).not.toThrow();
      expect(reportWellFormed(garbage as unknown as CompromiseReport)).toBe(false);
    }
  });
});

describe('sameKey', () => {
  it('the short form matches the long form of the same key', () => {
    expect(sameKey('did:abt:zAbc#zKey', 'zAbc#zKey')).toBe(true);
    expect(sameKey('zAbc#zKey', 'did:abt:zAbc#zKey')).toBe(true);
  });

  it('a different fragment on the same DID does not match', () => {
    expect(sameKey('did:abt:zAbc#zKey', 'did:abt:zAbc#zOther')).toBe(false);
  });

  it('a different DID on the same fragment does not match', () => {
    expect(sameKey('did:abt:zAbc#zKey', 'did:abt:zOther#zKey')).toBe(false);
  });

  it('a string with no # on either side returns false', () => {
    expect(sameKey('did:abt:zAbc', 'did:abt:zAbc#zKey')).toBe(false);
    expect(sameKey('did:abt:zAbc#zKey', 'did:abt:zAbc')).toBe(false);
  });

  it('non-string input returns false', () => {
    expect(sameKey(1 as unknown as string, 'did:abt:zAbc#zKey')).toBe(false);
    expect(sameKey('did:abt:zAbc#zKey', null as unknown as string)).toBe(false);
  });
});

describe('windowContains', () => {
  const r = report({
    since: new Date('2026-08-10T00:00:00.000Z'),
    reportedAt: new Date('2026-08-15T00:00:00.000Z'),
  });

  it('a signature strictly inside the window is true', () => {
    expect(windowContains(r, new Date('2026-08-12T00:00:00.000Z'))).toBe(true);
  });

  it('exactly at since is true: closed at both ends', () => {
    expect(windowContains(r, new Date('2026-08-10T00:00:00.000Z'))).toBe(true);
  });

  it('exactly at reportedAt is true: closed at both ends', () => {
    expect(windowContains(r, new Date('2026-08-15T00:00:00.000Z'))).toBe(true);
  });

  it('one millisecond before since is false', () => {
    expect(windowContains(r, new Date('2026-08-09T23:59:59.999Z'))).toBe(false);
  });

  it('one millisecond after reportedAt is false', () => {
    expect(windowContains(r, new Date('2026-08-15T00:00:00.001Z'))).toBe(false);
  });

  it('an unparseable signedAt returns false', () => {
    expect(windowContains(r, new Date('not a date'))).toBe(false);
  });

  it('a malformed report returns false', () => {
    const inverted = report({
      since: new Date('2026-08-20T00:00:00.000Z'),
      reportedAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    expect(windowContains(inverted, new Date('2026-08-10T00:00:00.000Z'))).toBe(false);
  });
});

describe('disputedBy', () => {
  const r = report({
    key: 'did:abt:zAbc#zKey',
    since: new Date('2026-08-10T00:00:00.000Z'),
    reportedAt: new Date('2026-08-15T00:00:00.000Z'),
  });

  it('returns the matching report for work signed by the reported key inside the window', () => {
    expect(disputedBy([r], 'did:abt:zAbc#zKey', new Date('2026-08-12T00:00:00.000Z'))).toEqual([r]);
  });

  it('returns [] for the same key signed outside the window', () => {
    expect(disputedBy([r], 'did:abt:zAbc#zKey', new Date('2026-08-20T00:00:00.000Z'))).toEqual([]);
  });

  it('returns [] for a different key signed inside the window', () => {
    expect(disputedBy([r], 'did:abt:zOther#zKey', new Date('2026-08-12T00:00:00.000Z'))).toEqual([]);
  });

  it('returns both when two overlapping windows cover the same signature', () => {
    const other = report({
      key: 'did:abt:zAbc#zKey',
      since: new Date('2026-08-11T00:00:00.000Z'),
      reportedAt: new Date('2026-08-16T00:00:00.000Z'),
    });
    expect(disputedBy([r, other], 'did:abt:zAbc#zKey', new Date('2026-08-12T00:00:00.000Z'))).toEqual([r, other]);
  });

  it('returns [] for a non-array reports, with no throw', () => {
    const bad = 'not an array' as unknown as CompromiseReport[];
    expect(() => disputedBy(bad, 'did:abt:zAbc#zKey', new Date())).not.toThrow();
    expect(disputedBy(bad, 'did:abt:zAbc#zKey', new Date())).toEqual([]);
  });

  it('returns [] for a non-string signedBy, with no throw', () => {
    expect(() => disputedBy([r], 42 as unknown as string, new Date())).not.toThrow();
    expect(disputedBy([r], 42 as unknown as string, new Date())).toEqual([]);
  });

  it('returns [] for an invalid signedAt, with no throw', () => {
    expect(() => disputedBy([r], 'did:abt:zAbc#zKey', new Date('not a date'))).not.toThrow();
    expect(disputedBy([r], 'did:abt:zAbc#zKey', new Date('not a date'))).toEqual([]);
  });
});
