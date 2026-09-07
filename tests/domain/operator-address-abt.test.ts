import { describe, expect, it } from 'vitest';

import { isValidOperatorAddressAbt } from '../../src/domain/operator-address-abt.js';

/**
 * P8c: the ABT operator address shape is the DID suffix shape
 * (src/domain/agent.ts's didSuffix), so this reuses the exact bound
 * isValidOperatorDid already applies to a suffix rather than inventing a
 * second opinion about it. Assertions state the rule in words, never a
 * literal a convenient implementation could happen to satisfy, matching
 * tests/domain/operator-did.test.ts and tests/domain/operator-address-evm
 * .test.ts's own discipline.
 */

describe('isValidOperatorAddressAbt', () => {
  it('accepts a well-formed suffix', () => {
    expect(isValidOperatorAddressAbt('z6MkExample')).toBe(true);
  });

  it('accepts the minimal suffix, one character', () => {
    expect(isValidOperatorAddressAbt('x')).toBe(true);
  });

  it('rejects the empty string', () => {
    expect(isValidOperatorAddressAbt('')).toBe(false);
  });

  it('rejects a suffix containing whitespace', () => {
    expect(isValidOperatorAddressAbt('has space')).toBe(false);
    expect(isValidOperatorAddressAbt('tab\there')).toBe(false);
    expect(isValidOperatorAddressAbt('trail ')).toBe(false);
  });

  it('rejects a value still carrying the did:abt: prefix, which is a different shape entirely (the suffix alone)', () => {
    expect(isValidOperatorAddressAbt('did:abt:z6MkExample')).toBe(false);
  });

  it('rejects a value over the same 256-character bound isValidOperatorDid enforces on the full DID', () => {
    // isValidOperatorDid bounds the FULL did:abt:<suffix> string at 256,
    // so once the 8-character prefix is added back on, a suffix over 248
    // characters pushes the reconstructed DID past that bound.
    expect(isValidOperatorAddressAbt('a'.repeat(249))).toBe(false);
  });

  it('accepts a suffix at exactly the boundary, 248 characters', () => {
    expect(isValidOperatorAddressAbt('a'.repeat(248))).toBe(true);
  });
});
