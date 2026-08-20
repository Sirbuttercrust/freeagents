import { describe, expect, it } from 'vitest';
import { isLiveFor } from '../../src/domain/delegation.js';
import type { Delegation } from '../../src/domain/delegation.js';

// Fixed fixtures: two distinct operator-issued DIDs, one fixed signature
// string. The signature is deliberately opaque — the domain never checks it
// (that is the adapter's job, invariant 9) — so any non-empty string stands
// in for it. No computed constants: nothing in this file asserts a hash, a
// UUID, or an encoding.
const OPERATOR_DID = 'did:abt:operator-fixture-one';
const SUBJECT_DID = 'did:abt:agent-fixture-one';
const OTHER_DID = 'did:abt:agent-fixture-two';
const PROOF = 'opaque-operator-signature';
const ISSUED_AT = new Date('2026-08-19T00:00:00Z');

function delegation(overrides: Partial<Delegation> = {}): Delegation {
  return {
    operator: OPERATOR_DID,
    subject: SUBJECT_DID,
    proof: PROOF,
    issuedAt: ISSUED_AT,
    revokedAt: null,
    ...overrides,
  };
}

describe('isLiveFor', () => {
  it('covers its named subject while unrevoked', () => {
    expect(isLiveFor(delegation({ revokedAt: null }), SUBJECT_DID)).toBe(true);
  });

  it('does not cover its named subject once revoked', () => {
    expect(isLiveFor(delegation({ revokedAt: new Date('2026-08-19T12:00:00Z') }), SUBJECT_DID)).toBe(
      false,
    );
  });

  it('does not cover a different subject while unrevoked', () => {
    expect(isLiveFor(delegation({ revokedAt: null }), OTHER_DID)).toBe(false);
  });

  it('vouches for exactly one subject (ENT-2.1)', () => {
    const live = delegation({ revokedAt: null });
    const covered = [SUBJECT_DID, OTHER_DID, OPERATOR_DID].filter((did) => isLiveFor(live, did));
    expect(covered).toEqual([SUBJECT_DID]);
  });

  it('is total: every case yields a boolean and nothing throws', () => {
    const cases: Array<[Delegation, string]> = [
      [delegation(), SUBJECT_DID],
      [delegation({ revokedAt: new Date('2026-08-19T12:00:00Z') }), SUBJECT_DID],
      [delegation(), OTHER_DID],
      [delegation({ operator: OTHER_DID }), SUBJECT_DID],
      [delegation({ proof: '' }), SUBJECT_DID],
    ];
    for (const [record, did] of cases) {
      expect(typeof isLiveFor(record, did)).toBe('boolean');
    }
  });
});

describe('ENT-3.1: the record is verifiable without calling FreeAgents', () => {
  // Structural half only. The full proof — a third party verifying the
  // operator's signature with an off-the-shelf W3C VC verifier — needs the
  // operator DID registration (R-1) and the identity adapter, both deferred.
  // What this pins today: the record is self-contained, so a verifier needs
  // only the record plus the operator's DID document, never an endpoint on
  // this service.
  it('carries exactly the ENT-3 fields, every one interpretable offline', () => {
    const live = delegation();
    const revoked = delegation({ revokedAt: new Date('2026-08-19T12:00:00Z') });
    for (const record of [live, revoked]) {
      // No endpoint, no internal id, no service reference: every field is a
      // DID string, a signature string, or a timestamp.
      expect(Object.keys(record).sort()).toEqual([
        'issuedAt',
        'operator',
        'proof',
        'revokedAt',
        'subject',
      ]);
      expect(typeof record.operator).toBe('string');
      expect(typeof record.subject).toBe('string');
      expect(typeof record.proof).toBe('string');
      expect(record.issuedAt instanceof Date).toBe(true);
      expect(record.revokedAt === null || record.revokedAt instanceof Date).toBe(true);
    }
    // Revocation is recorded on the record itself; checking it requires no
    // call back to the platform (ENT-3.2: it stops new attribution, it does
    // not erase what was issued).
    expect(isLiveFor(revoked, SUBJECT_DID)).toBe(false);
  });
});
