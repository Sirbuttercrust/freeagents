// Mirrors src/domain/sign-in-methods.ts (CLAUDE.md: tests mirror the src/
// path they cover). Pure, no server: this file checks the declared data and
// the total lookup, not the route that serves it
// (tests/api/sign-in-methods.test.ts covers that boundary).
import { describe, expect, it } from 'vitest';

import { SIGN_IN_METHODS, signInMethodFor } from '../../src/domain/sign-in-methods.js';

describe('SIGN_IN_METHODS', () => {
  it('every entry has a non-empty id, label and reason, and boolean required/walletBased', () => {
    for (const method of SIGN_IN_METHODS) {
      expect(method.id.length).toBeGreaterThan(0);
      expect(method.label.length).toBeGreaterThan(0);
      expect(method.reason.length).toBeGreaterThan(0);
      expect(typeof method.required).toBe('boolean');
      expect(typeof method.walletBased).toBe('boolean');
    }
  });

  it('has unique ids', () => {
    const ids = SIGN_IN_METHODS.map((m) => m.id);
    expect(new Set(ids).size).toBe(SIGN_IN_METHODS.length);
  });

  it('pins every declared method exactly: id, label, required, walletBased, reason', () => {
    // Unlike the shape check above, this pins the literal published values,
    // the same way tests/domain/access.test.ts pins CAPABILITIES: a wrong
    // required or walletBased value would otherwise fail no test.
    expect(SIGN_IN_METHODS).toEqual([
      {
        id: 'github',
        label: 'Continue with GitHub',
        required: true,
        walletBased: false,
        reason: 'One of the two sign-in paths named in MISSION.md invariant 8: GitHub OAuth or a passkey.',
      },
      {
        id: 'passkey',
        label: 'Use a passkey',
        required: true,
        walletBased: false,
        reason: 'One of the two sign-in paths named in MISSION.md invariant 8: GitHub OAuth or a passkey.',
      },
      {
        id: 'wallet',
        label: 'Sign in with a DID Wallet',
        required: false,
        walletBased: true,
        reason: 'Optional. Your identity is yours from the first click.',
      },
    ]);
  });
});

describe('signInMethodFor', () => {
  it('finds a declared method by id', () => {
    expect(signInMethodFor('github')?.label).toBe('Continue with GitHub');
  });

  it('is total: returns null rather than throwing for an unknown id', () => {
    expect(signInMethodFor('nope')).toBeNull();
  });
});
