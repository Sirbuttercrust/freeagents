// R-3 + R-4 completion (B5, launch blocker): resolveDid and verify are real,
// local-only implementations, the same discipline verifyDelegation already
// uses (did-abt-resolver.ts's fromPublicKey binding check). Neither method
// calls this service or any other service (invariant 2): a DID's key is
// derivable only once it has been OBSERVED through a binding check
// elsewhere (the R-34 signing-key resolver records it into a KnownKeyStore),
// never fabricated and never fetched over the network. An unobserved DID is
// an honest failure, not a guessed document.
import * as nodeCrypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { fromRandom } from '@ocap/wallet';

import { createIdentityAdapter } from '../../../src/adapters/identity/identity.js';
import { createKnownKeyStore } from '../../../src/adapters/identity/did-abt-resolver.js';
import { signingIdentityFromWallet } from '../../helpers/sign-request.js';

describe('createIdentityAdapter, resolveDid (real, local-only)', () => {
  it('throws for a DID whose key has never been observed, rather than fabricating a document', async () => {
    const knownKeys = createKnownKeyStore();
    const identity = createIdentityAdapter(knownKeys);

    await expect(identity.resolveDid('did:abt:zNeverObserved')).rejects.toThrow();
  });

  it('returns a document whose verificationMethod verifies a signature the wallet actually produced, once the key has been observed', async () => {
    const knownKeys = createKnownKeyStore();
    const identity = createIdentityAdapter(knownKeys);
    const wallet = fromRandom();
    const signing = await signingIdentityFromWallet(wallet);
    // The binding this DID document rests on: the same check the R-34
    // signing-key resolver performs before ever recording an entry.
    knownKeys.record(signing.did, signing.keyid);

    const doc = await identity.resolveDid(signing.did);

    expect(doc.id).toBe(signing.did);
    expect(doc.controller).toBeNull();
    expect(doc.verificationMethod).toEqual([signing.keyid]);

    // The document's verificationMethod is not just present, it actually
    // verifies a signature the wallet's own key produced: resolve the
    // fragment independently with @digitalbazaar/* alone (invariant 2 in
    // miniature) and check a real signature against it.
    const fragment = doc.verificationMethod[0]!.slice(doc.verificationMethod[0]!.indexOf('#') + 1);
    const key = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint: fragment });
    const raw = (key as unknown as { _publicKeyBuffer: Uint8Array })._publicKeyBuffer;
    const publicKey = nodeCrypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') },
      format: 'jwk',
    });
    const payload = Buffer.from('resolveDid mutation-proof payload', 'utf8');
    const signature = nodeCrypto.sign(null, payload, signing.privateKey);
    expect(nodeCrypto.verify(null, payload, publicKey, signature)).toBe(true);
  });

  it('MUTATION PROOF: a document naming a key the wallet never held fails the same independent check', async () => {
    // The negative control for the test above: swapping in an unrelated
    // wallet's key must fail verification against the ORIGINAL wallet's
    // signature, proving the prior test was checking the right thing.
    const wallet = fromRandom();
    const signing = await signingIdentityFromWallet(wallet);
    const otherWallet = fromRandom();
    const otherSigning = await signingIdentityFromWallet(otherWallet);

    const wrongFragment = otherSigning.keyid.slice(otherSigning.keyid.indexOf('#') + 1);
    const wrongKey = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint: wrongFragment });
    const wrongRaw = (wrongKey as unknown as { _publicKeyBuffer: Uint8Array })._publicKeyBuffer;
    const wrongPublicKey = nodeCrypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(wrongRaw).toString('base64url') },
      format: 'jwk',
    });
    const payload = Buffer.from('resolveDid mutation-proof payload', 'utf8');
    const signature = nodeCrypto.sign(null, payload, signing.privateKey);

    expect(nodeCrypto.verify(null, payload, wrongPublicKey, signature)).toBe(false);
  });
});

describe('createIdentityAdapter, verify (real, local-only)', () => {
  it('throws for a signerDid whose key has never been observed, rather than fabricating an answer', async () => {
    const knownKeys = createKnownKeyStore();
    const identity = createIdentityAdapter(knownKeys);

    await expect(
      identity.verify({ payload: 'x', signature: 'AAAA', signerDid: 'did:abt:zNeverObserved' }),
    ).rejects.toThrow();
  });

  it('accepts a genuine signature and rejects a tampered payload, once the signer key has been observed (both directions)', async () => {
    const knownKeys = createKnownKeyStore();
    const identity = createIdentityAdapter(knownKeys);
    const wallet = fromRandom();
    const signing = await signingIdentityFromWallet(wallet);
    knownKeys.record(signing.did, signing.keyid);

    const payload = 'freeagents identity verify test payload';
    const signature = nodeCrypto.sign(null, Buffer.from(payload, 'utf8'), signing.privateKey).toString('base64');

    await expect(identity.verify({ payload, signature, signerDid: signing.did })).resolves.toBe(true);
    // The negative control: the same signature over a different payload
    // must not verify.
    await expect(
      identity.verify({ payload: 'a different payload entirely', signature, signerDid: signing.did }),
    ).resolves.toBe(false);
  });

  it('rejects a signature made by a different key, even though the claimed signerDid was observed', async () => {
    const knownKeys = createKnownKeyStore();
    const identity = createIdentityAdapter(knownKeys);
    const wallet = fromRandom();
    const signing = await signingIdentityFromWallet(wallet);
    knownKeys.record(signing.did, signing.keyid);

    const impostor = fromRandom();
    const impostorSigning = await signingIdentityFromWallet(impostor);
    const payload = 'freeagents identity verify test payload';
    const signature = nodeCrypto.sign(null, Buffer.from(payload, 'utf8'), impostorSigning.privateKey).toString('base64');

    await expect(identity.verify({ payload, signature, signerDid: signing.did })).resolves.toBe(false);
  });
});
