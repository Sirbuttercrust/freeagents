import { describe, expect, it } from 'vitest';

import { isValidOperatorAddressEvm } from '../../src/domain/operator-address-evm.js';

/**
 * S3, Ruling 4: the shape check for an EVM operator address, the same
 * total-and-never-throws stance src/domain/operator-did.ts's
 * isValidOperatorDid already takes. Assertions state the rule in words,
 * never a literal a convenient implementation could happen to satisfy.
 */

describe('isValidOperatorAddressEvm', () => {
  it('accepts a well-formed 0x-prefixed 40 hex-digit address', () => {
    expect(isValidOperatorAddressEvm('0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d')).toBe(true);
  });

  it('rejects the empty string', () => {
    expect(isValidOperatorAddressEvm('')).toBe(false);
  });

  it('rejects a value missing the 0x prefix', () => {
    expect(isValidOperatorAddressEvm('75faf114eafb1BDbe2F0316DF893fd58CE46AA4d')).toBe(false);
  });

  it('rejects a value with too few hex digits', () => {
    expect(isValidOperatorAddressEvm('0x75faf114eafb1BDbe2F0316DF893fd58CE46AA')).toBe(false);
  });

  it('rejects a value with too many hex digits', () => {
    expect(isValidOperatorAddressEvm('0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d00')).toBe(false);
  });

  it('rejects a value containing a non-hex character', () => {
    expect(isValidOperatorAddressEvm('0xZZfaf114eafb1BDbe2F0316DF893fd58CE46AA4d')).toBe(false);
  });

  it('accepts mixed-case hex digits (no checksum enforcement)', () => {
    expect(isValidOperatorAddressEvm('0xABCDEF0123456789abcdef0123456789ABCDEF01')).toBe(true);
  });

  it('rejects a did:abt DID, which is a different address shape entirely', () => {
    expect(isValidOperatorAddressEvm('did:abt:z1Kp9nWt3aBc5Df7Gh2Jk4Lm6Np8Qr0St')).toBe(false);
  });
});
