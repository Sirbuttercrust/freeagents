import { describe, expect, it } from 'vitest';

import { accessPolicy, identityRequirement, isCapability, requiresIdentity, CAPABILITIES } from '../../src/domain/access.js';

describe('accessPolicy', () => {
  it('has exactly 4 entries, in CAPABILITIES order', () => {
    const policy = accessPolicy();
    expect(policy).toHaveLength(4);
    expect(policy.map((r) => r.capability)).toEqual(['browse', 'verify', 'hire', 'list']);
  });

  it('every capability round-trips to itself with no copy-paste row mismatch', () => {
    for (const capability of CAPABILITIES) {
      expect(identityRequirement(capability).capability).toBe(capability);
    }
  });
});

describe('requiresIdentity', () => {
  it('browse and verify need no identity (accept clause 1)', () => {
    expect(requiresIdentity('browse')).toBe(false);
    expect(requiresIdentity('verify')).toBe(false);
  });

  it('hire and list require an identity (accept clause 2)', () => {
    expect(requiresIdentity('hire')).toBe(true);
    expect(requiresIdentity('list')).toBe(true);
  });
});

describe('invariant 7: no wallet is ever required', () => {
  it('walletRequired is false on every row of the policy', () => {
    expect(accessPolicy().every((r) => r.walletRequired === false)).toBe(true);
  });

  it('no statement implies a wallet requirement, even for a capability that requires identity', () => {
    // A negative lookbehind excludes the negated form ("no wallet is
    // required") that this exact copy uses on purpose: a naive substring
    // match on "wallet is required" would flag the very sentence that
    // states invariant 7, since "no wallet is required" contains it.
    for (const row of accessPolicy()) {
      if (row.identityRequired) {
        expect(row.statement.toLowerCase()).not.toMatch(/(?<!no )wallet is required|seed phrase|connect your wallet/);
      }
    }
  });
});

describe('invariant 8: sign-in is GitHub OAuth or a passkey, nothing else', () => {
  it('an identity-required row offers exactly both methods; an identity-free row offers none', () => {
    for (const row of accessPolicy()) {
      if (row.identityRequired) {
        expect(row.signInMethods).toEqual(['github-oauth', 'passkey']);
      } else {
        expect(row.signInMethods).toEqual([]);
      }
    }
  });
});

describe('statement', () => {
  it('every entry has a non-empty statement', () => {
    for (const row of accessPolicy()) {
      expect(typeof row.statement).toBe('string');
      expect(row.statement.length).toBeGreaterThan(0);
    }
  });
});

describe('identityRequirement returns a fresh array each call', () => {
  it('mutating a returned signInMethods array does not change the next call', () => {
    const first = identityRequirement('hire');
    first.signInMethods.push('github-oauth');
    expect(identityRequirement('hire').signInMethods).toHaveLength(2);
  });
});

describe('isCapability', () => {
  it('is true for each declared capability', () => {
    for (const capability of CAPABILITIES) {
      expect(isCapability(capability)).toBe(true);
    }
  });

  it('is false for anything else, and never throws', () => {
    const notCapabilities: unknown[] = ['admin', '', null, undefined, 42, {}, ['hire']];
    for (const value of notCapabilities) {
      expect(() => isCapability(value)).not.toThrow();
      expect(isCapability(value)).toBe(false);
    }
  });
});
