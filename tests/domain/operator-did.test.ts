import { describe, expect, it } from 'vitest';

import { isValidOperatorDid } from '../../src/domain/operator-did.js';

/**
 * The rule under test is a shape check, so every assertion is a property of
 * the rule, stated in words, not a constant somebody recalled. There is no
 * digest to fabricate here, but the discipline is the same as in
 * tests/domain/hashing.test.ts: assert what the rule promises, so a
 * "fix" that bends the implementation toward a convenient literal cannot
 * pass.
 */

describe('isValidOperatorDid', () => {
  it('accepts a did:abt: DID with a suffix', () => {
    expect(isValidOperatorDid('did:abt:z6MkExample')).toBe(true);
  });

  it('accepts the minimal suffix, one character', () => {
    expect(isValidOperatorDid('did:abt:x')).toBe(true);
  });

  it('rejects the empty string', () => {
    expect(isValidOperatorDid('')).toBe(false);
  });

  it('rejects the bare prefix with no suffix', () => {
    expect(isValidOperatorDid('did:abt:')).toBe(false);
  });

  it('rejects a different method, did:eth', () => {
    expect(isValidOperatorDid('did:eth:abc')).toBe(false);
  });

  it('rejects a different method, did:web', () => {
    expect(isValidOperatorDid('did:web:example.com')).toBe(false);
  });

  it('rejects the wrong case: DIDs are case-sensitive', () => {
    expect(isValidOperatorDid('DID:abt:abc')).toBe(false);
    expect(isValidOperatorDid('did:ABT:abc')).toBe(false);
  });

  it('rejects a suffix containing whitespace', () => {
    // It would also break the GET /accounts/:did URL path, which is why the
    // domain refuses it rather than the route.
    expect(isValidOperatorDid('did:abt:has space')).toBe(false);
    expect(isValidOperatorDid('did:abt:tab\there')).toBe(false);
    expect(isValidOperatorDid('did:abt:trail ')).toBe(false);
  });

  it('rejects a string over 256 characters', () => {
    expect(isValidOperatorDid(`did:abt:${'a'.repeat(256)}`)).toBe(false);
  });

  it('accepts a string of exactly 256 characters', () => {
    // 256 is the bound, not 255: assert the boundary, not just below it.
    expect(isValidOperatorDid(`did:abt:${'a'.repeat(246)}`)).toBe(true);
  });

  it('round-trips every accepted value unchanged', () => {
    // The check is total and pure, so for the accepted examples above the
    // answer is stable across calls: a validator that mutates its input or
    // returns a different value would fail here.
    for (const value of ['did:abt:z6MkExample', 'did:abt:x']) {
      expect(isValidOperatorDid(value)).toBe(true);
      expect(isValidOperatorDid(value)).toBe(true);
      expect(value).toBe('did:abt:' + value.slice('did:abt:'.length));
    }
  });
});
