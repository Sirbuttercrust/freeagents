// R-29: rotationWellFormed is the structural half of "this rotation record
// is well formed". Total: any value in, one boolean out, never throws -
// the same totality delegationConsistent is held to in agent.ts.
import { describe, expect, it } from 'vitest';
import { rotationWellFormed, type KeyRotation } from '../../src/domain/key-rotation.js';

function rotation(overrides: Partial<KeyRotation> = {}): KeyRotation {
  return {
    fromKey: 'did:abt:zOldKey#zOldFingerprint',
    toKey: 'did:abt:zNewKey#zNewFingerprint',
    rotatedAt: new Date('2026-08-21T05:00:00.000Z'),
    ...overrides,
  };
}

describe('rotationWellFormed', () => {
  it('a well-formed rotation returns true', () => {
    expect(rotationWellFormed(rotation())).toBe(true);
  });

  it('an empty fromKey or toKey returns false', () => {
    expect(rotationWellFormed(rotation({ fromKey: '' }))).toBe(false);
    expect(rotationWellFormed(rotation({ toKey: '' }))).toBe(false);
  });

  it('a key without # is not DID fragment form, so it returns false', () => {
    expect(rotationWellFormed(rotation({ fromKey: 'did:abt:zOldKey' }))).toBe(false);
    expect(rotationWellFormed(rotation({ toKey: 'did:abt:zNewKey' }))).toBe(false);
  });

  it('an unparseable rotatedAt returns false', () => {
    expect(rotationWellFormed(rotation({ rotatedAt: new Date('not a date') }))).toBe(false);
  });

  it('a parseable string rotatedAt returns true: stored records may come back as strings', () => {
    expect(
      rotationWellFormed(rotation({ rotatedAt: '2026-08-21T05:00:00.000Z' as unknown as Date })),
    ).toBe(true);
  });

  it('an unparseable string rotatedAt returns false', () => {
    expect(
      rotationWellFormed(rotation({ rotatedAt: 'not a date' as unknown as Date })),
    ).toBe(false);
  });

  it('a rotatedAt that is neither a Date nor a string returns false', () => {
    expect(rotationWellFormed(rotation({ rotatedAt: 1724226000000 as unknown as Date }))).toBe(false);
    expect(rotationWellFormed(rotation({ rotatedAt: undefined as unknown as Date }))).toBe(false);
  });

  it('fromKey === toKey returns true: equality is a semantic error the API rejects in R-30, not a shape error', () => {
    expect(rotationWellFormed(rotation({ toKey: rotation().fromKey }))).toBe(true);
  });

  it('is total on garbage: throws nothing, returns false', () => {
    for (const garbage of [null, 'did:abt:z#z', 42, true, ['did:abt:z#z'], {}]) {
      expect(() => rotationWellFormed(garbage as unknown as KeyRotation)).not.toThrow();
      expect(rotationWellFormed(garbage as unknown as KeyRotation)).toBe(false);
    }
  });
});
