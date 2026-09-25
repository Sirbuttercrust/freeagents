// The one derivation both createOperatorDid (identity.ts) and
// platformIssuerFromEnv (credentials.ts) must share, so an operator DID
// and the platform's own issuer DID can never drift onto two different
// encodings of the same key. did:abt is derived from the raw ed25519
// public key via @arcblock/did's own fromPublicKey, never a hand-rolled
// address encoding.
import { fromPublicKey } from '@arcblock/did';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { describe, expect, it } from 'vitest';

import { deriveDidFromSeed } from '../../../src/adapters/identity/did-from-seed.js';

describe('deriveDidFromSeed', () => {
  it('derives a did:abt value from the public key, matching fromPublicKey directly', async () => {
    const seed = new Uint8Array(32).fill(7);

    const derived = await deriveDidFromSeed(seed);

    const key = await Ed25519VerificationKey2020.fromFingerprint({
      fingerprint: derived.publicKeyMultibase,
    });
    const raw = (key as unknown as { _publicKeyBuffer: Uint8Array })._publicKeyBuffer;
    expect(derived.did).toBe(`did:abt:${fromPublicKey(raw)}`);
    expect(derived.did.startsWith('did:abt:')).toBe(true);
  });

  it('is deterministic: the same seed always derives the same did and key', async () => {
    const seed = new Uint8Array(32).fill(11);

    const first = await deriveDidFromSeed(seed);
    const second = await deriveDidFromSeed(seed);

    expect(first.did).toBe(second.did);
    expect(first.publicKeyMultibase).toBe(second.publicKeyMultibase);
  });

  it('two different seeds derive two different DIDs', async () => {
    const a = await deriveDidFromSeed(new Uint8Array(32).fill(1));
    const b = await deriveDidFromSeed(new Uint8Array(32).fill(2));

    expect(a.did).not.toBe(b.did);
  });
});
