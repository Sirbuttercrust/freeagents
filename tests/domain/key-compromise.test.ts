// R-16: compromiseWindowWellFormed is the structural half of "this report is
// well formed", the same totality rotationWellFormed is held to. disputingWindows
// and credentialDisputed are the read-time derivation.
import { describe, expect, it } from 'vitest';
import {
  compromiseWindowWellFormed,
  disputingWindows,
  credentialDisputed,
  type CompromiseWindow,
  type DisputableCredentialFacts,
} from '../../src/domain/key-compromise.js';

function window(overrides: Partial<CompromiseWindow> = {}): CompromiseWindow {
  return {
    key: 'did:abt:zAbc#key-1',
    from: new Date('2026-08-01T00:00:00.000Z'),
    to: new Date('2026-08-10T00:00:00.000Z'),
    reportedAt: new Date('2026-08-11T00:00:00.000Z'),
    ...overrides,
  };
}

function facts(overrides: Partial<DisputableCredentialFacts> = {}): DisputableCredentialFacts {
  return {
    signedBy: null,
    signedAt: null,
    issuedAt: null,
    ...overrides,
  };
}

describe('compromiseWindowWellFormed', () => {
  it('a well-formed report returns true', () => {
    expect(compromiseWindowWellFormed(window())).toBe(true);
  });

  it('accepts ISO strings for from and to', () => {
    expect(
      compromiseWindowWellFormed(
        window({
          from: '2026-08-01T00:00:00.000Z' as unknown as Date,
          to: '2026-08-10T00:00:00.000Z' as unknown as Date,
        }),
      ),
    ).toBe(true);
  });

  it('rejects non-object and null', () => {
    expect(compromiseWindowWellFormed(null as unknown as CompromiseWindow)).toBe(false);
    expect(compromiseWindowWellFormed(42 as unknown as CompromiseWindow)).toBe(false);
  });

  it('rejects an empty key', () => {
    expect(compromiseWindowWellFormed(window({ key: '' }))).toBe(false);
  });

  it('rejects a key with no #', () => {
    expect(compromiseWindowWellFormed(window({ key: 'did:abt:zAbc' }))).toBe(false);
  });

  it('rejects a non-string key', () => {
    expect(compromiseWindowWellFormed(window({ key: 42 as unknown as string }))).toBe(false);
  });

  it('rejects an invalid date string', () => {
    expect(
      compromiseWindowWellFormed(window({ from: 'not a date' as unknown as Date })),
    ).toBe(false);
    expect(compromiseWindowWellFormed(window({ to: 'not a date' as unknown as Date }))).toBe(
      false,
    );
  });

  it('rejects a NaN Date', () => {
    expect(compromiseWindowWellFormed(window({ from: new Date('not a date') }))).toBe(false);
  });

  it('accepts from > to: the deferred semantic rule the route rejects, mirroring rotationWellFormed on fromKey === toKey', () => {
    expect(
      compromiseWindowWellFormed(
        window({
          from: new Date('2026-08-10T00:00:00.000Z'),
          to: new Date('2026-08-01T00:00:00.000Z'),
        }),
      ),
    ).toBe(true);
  });

  it('is total: throws nothing on any garbage', () => {
    for (const garbage of [null, undefined, 42, true, ['x'], {}, 'x']) {
      expect(() => compromiseWindowWellFormed(garbage as unknown as CompromiseWindow)).not.toThrow();
    }
  });

  it("rejects a number for from/to (isWellFormedDate's fallthrough: neither a Date nor a string)", () => {
    expect(compromiseWindowWellFormed(window({ from: 42 as unknown as Date }))).toBe(false);
    expect(compromiseWindowWellFormed(window({ to: 42 as unknown as Date }))).toBe(false);
  });

  it("rejects undefined for from/to (isWellFormedDate's fallthrough)", () => {
    expect(compromiseWindowWellFormed(window({ from: undefined as unknown as Date }))).toBe(false);
    expect(compromiseWindowWellFormed(window({ to: undefined as unknown as Date }))).toBe(false);
  });
});

describe('disputingWindows / credentialDisputed', () => {
  it('signedAt inside the window and matching signedBy: disputed, and the returned array is exactly that window', () => {
    const w = window();
    const f = facts({ signedBy: w.key, signedAt: new Date('2026-08-05T00:00:00.000Z') });
    expect(disputingWindows(f, [w])).toEqual([w]);
    expect(credentialDisputed(f, [w])).toBe(true);
  });

  it('issuedAt inside the window but signedAt outside: disputed (the OR rule)', () => {
    const w = window();
    const f = facts({
      signedBy: w.key,
      signedAt: new Date('2026-09-01T00:00:00.000Z'),
      issuedAt: new Date('2026-08-05T00:00:00.000Z'),
    });
    expect(credentialDisputed(f, [w])).toBe(true);
  });

  it('both timestamps outside the window: not disputed', () => {
    const w = window();
    const f = facts({
      signedBy: w.key,
      signedAt: new Date('2026-09-01T00:00:00.000Z'),
      issuedAt: new Date('2026-09-02T00:00:00.000Z'),
    });
    expect(credentialDisputed(f, [w])).toBe(false);
    expect(disputingWindows(f, [w])).toEqual([]);
  });

  it('boundary: signedAt exactly equal to from and exactly equal to to are both disputed (inclusive)', () => {
    const w = window();
    const atFrom = facts({ signedBy: w.key, signedAt: w.from });
    const atTo = facts({ signedBy: w.key, signedAt: w.to });
    expect(credentialDisputed(atFrom, [w])).toBe(true);
    expect(credentialDisputed(atTo, [w])).toBe(true);
  });

  it('a matching timestamp but a different key: not disputed', () => {
    const w = window({ key: 'did:abt:zOther#key-1' });
    const f = facts({ signedBy: 'did:abt:zAbc#key-1', signedAt: new Date('2026-08-05T00:00:00.000Z') });
    expect(credentialDisputed(f, [w])).toBe(false);
  });

  it("signedBy 'zAbc#key-1' against window.key 'did:abt:zAbc#key-1': disputed (the didSuffix reconciliation)", () => {
    const w = window({ key: 'did:abt:zAbc#key-1' });
    const f = facts({ signedBy: 'zAbc#key-1', signedAt: new Date('2026-08-05T00:00:00.000Z') });
    expect(credentialDisputed(f, [w])).toBe(true);
  });

  it('same DID, different fragment: not disputed', () => {
    const w = window({ key: 'did:abt:zAbc#key-1' });
    const f = facts({ signedBy: 'did:abt:zAbc#key-2', signedAt: new Date('2026-08-05T00:00:00.000Z') });
    expect(credentialDisputed(f, [w])).toBe(false);
  });

  it('signedBy null: not disputed', () => {
    const w = window();
    const f = facts({ signedBy: null, signedAt: new Date('2026-08-05T00:00:00.000Z') });
    expect(credentialDisputed(f, [w])).toBe(false);
  });

  it('both timestamps null: not disputed', () => {
    const w = window();
    const f = facts({ signedBy: w.key, signedAt: null, issuedAt: null });
    expect(credentialDisputed(f, [w])).toBe(false);
  });

  it('empty windows array: not disputed', () => {
    const f = facts({ signedBy: 'did:abt:zAbc#key-1', signedAt: new Date('2026-08-05T00:00:00.000Z') });
    expect(credentialDisputed(f, [])).toBe(false);
    expect(disputingWindows(f, [])).toEqual([]);
  });

  it('two overlapping windows both covering the credential: both returned, in input order', () => {
    const w1 = window({ key: 'did:abt:zAbc#key-1', from: new Date('2026-08-01T00:00:00.000Z'), to: new Date('2026-08-15T00:00:00.000Z') });
    const w2 = window({ key: 'did:abt:zAbc#key-1', from: new Date('2026-08-03T00:00:00.000Z'), to: new Date('2026-08-20T00:00:00.000Z') });
    const f = facts({ signedBy: 'did:abt:zAbc#key-1', signedAt: new Date('2026-08-05T00:00:00.000Z') });
    expect(disputingWindows(f, [w1, w2])).toEqual([w1, w2]);
  });

  it('the input arrays are not mutated', () => {
    const w = window();
    const windows = [w];
    const frozenWindows = Object.freeze([...windows]);
    const f = facts({ signedBy: w.key, signedAt: new Date('2026-08-05T00:00:00.000Z') });
    expect(() => disputingWindows(f, frozenWindows)).not.toThrow();
    expect(frozenWindows).toEqual([w]);
  });

  it("signedBy with no '#': not disputed (sameKey's aHash === -1 guard)", () => {
    const w = window();
    const f = facts({ signedBy: 'zNoHashAtAll', signedAt: new Date('2026-08-05T00:00:00.000Z') });
    expect(credentialDisputed(f, [w])).toBe(false);
  });

  it("window.key with no '#': not disputed (sameKey's bHash === -1 guard)", () => {
    const w = window({ key: 'did:abt:zAbcNoHash' });
    const f = facts({ signedBy: 'did:abt:zAbc#key-1', signedAt: new Date('2026-08-05T00:00:00.000Z') });
    expect(credentialDisputed(f, [w])).toBe(false);
  });

  it("signedBy is an empty string: not disputed (disputingWindows' facts.signedBy.length === 0 clause)", () => {
    const w = window();
    const f = facts({ signedBy: '', signedAt: new Date('2026-08-05T00:00:00.000Z') });
    expect(credentialDisputed(f, [w])).toBe(false);
    expect(disputingWindows(f, [w])).toEqual([]);
  });

  it("a timestamp before window.from: not disputed (inWindow's lower bound)", () => {
    const w = window();
    const f = facts({ signedBy: w.key, signedAt: new Date('2026-07-01T00:00:00.000Z') });
    expect(credentialDisputed(f, [w])).toBe(false);
    expect(disputingWindows(f, [w])).toEqual([]);
  });
});
