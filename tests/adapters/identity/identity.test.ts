// R-3 + R-4 completion (B5, launch blocker): resolveDid and verify are real,
// local-only implementations, the same discipline verifyDelegation already
// uses (did-abt-resolver.ts's fromPublicKey binding check). Neither method
// calls this service or any other service (invariant 2): a DID's key is
// derivable only once it has been OBSERVED through a binding check
// elsewhere (the R-34 signing-key resolver records it into a KnownKeyStore),
// never fabricated and never fetched over the network. An unobserved DID is
// an honest failure, not a guessed document.
import * as nodeCrypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { fromRandom } from '@ocap/wallet';
import { fromPublicKey } from '@arcblock/did';

import { createIdentityAdapter } from '../../../src/adapters/identity/identity.js';
import { createKnownKeyStore } from '../../../src/adapters/identity/did-abt-resolver.js';
import { MemoryObservedKeyRepository } from '../../../src/adapters/storage/memory.js';
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

// D2 (Review finding, round 1, task t_8a82c865): identity resolution must not depend
// on process warmth. The anchor: "a stranger derives the same
// verificationMethod from the keyid whether or not this process happened
// to be running when the agent last signed" -- so this process must not
// either. A durable ObservedKeyRepository, injected alongside the
// in-process KnownKeyStore, is what makes that true across a restart: the
// tests below simulate one by handing resolveDid/verify a FRESH KnownKeyStore
// (never taught anything) alongside a durable store that already carries
// the observation "from before the restart".
describe('createIdentityAdapter, durable fallback (D2, task t_8a82c865)', () => {
  it('resolveDid falls back to the ObservedKeyRepository when the in-process KnownKeyStore has no entry, simulating a restart', async () => {
    const wallet = fromRandom();
    const signing = await signingIdentityFromWallet(wallet);

    const observedKeys = new MemoryObservedKeyRepository();
    await observedKeys.record(signing.did, signing.keyid);

    const freshKnownKeys = createKnownKeyStore();
    const identity = createIdentityAdapter(freshKnownKeys, observedKeys);

    const doc = await identity.resolveDid(signing.did);
    expect(doc.verificationMethod).toEqual([signing.keyid]);
  });

  it('verify falls back to the ObservedKeyRepository the same way, and still checks the real signature', async () => {
    const wallet = fromRandom();
    const signing = await signingIdentityFromWallet(wallet);
    const observedKeys = new MemoryObservedKeyRepository();
    await observedKeys.record(signing.did, signing.keyid);

    const freshKnownKeys = createKnownKeyStore();
    const identity = createIdentityAdapter(freshKnownKeys, observedKeys);

    const payload = 'freeagents identity verify durable-fallback payload';
    const signature = nodeCrypto.sign(null, Buffer.from(payload, 'utf8'), signing.privateKey).toString('base64');

    await expect(identity.verify({ payload, signature, signerDid: signing.did })).resolves.toBe(true);
    // The negative control still holds through the durable path.
    await expect(
      identity.verify({ payload: 'a tampered payload', signature, signerDid: signing.did }),
    ).resolves.toBe(false);
  });

  it('still throws when NEITHER the in-process store NOR the durable repository has observed the DID', async () => {
    const observedKeys = new MemoryObservedKeyRepository();
    const identity = createIdentityAdapter(createKnownKeyStore(), observedKeys);

    await expect(identity.resolveDid('did:abt:zNeverObservedAnywhere')).rejects.toThrow();
    await expect(
      identity.verify({ payload: 'x', signature: 'AAAA', signerDid: 'did:abt:zNeverObservedAnywhere' }),
    ).rejects.toThrow();
  });
});

// P8d: createOperatorDid is the real derivation the auto-provisioning card
// (t_dcbf6a5e) needs: deterministic from FREEAGENTS_PLATFORM_SEED and the
// sign-in subject, so signing in twice as the same subject can never mint
// a second DID, and the platform never stores a private key.
describe('createIdentityAdapter, createOperatorDid (P8d)', () => {
  const ORIGINAL_SEED = process.env.FREEAGENTS_PLATFORM_SEED;

  afterEach(() => {
    if (ORIGINAL_SEED === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
    else process.env.FREEAGENTS_PLATFORM_SEED = ORIGINAL_SEED;
  });

  it('is deterministic: the same subject derives the identical DID every call', async () => {
    process.env.FREEAGENTS_PLATFORM_SEED = 'a'.repeat(64);
    const identity = createIdentityAdapter(createKnownKeyStore());

    const first = await identity.createOperatorDid('subject-repeat-me');
    const second = await identity.createOperatorDid('subject-repeat-me');

    expect(first.did).toBe(second.did);
    expect(first.publicKeyMultibase).toBe(second.publicKeyMultibase);
    expect(first.did.startsWith('did:abt:')).toBe(true);
  });

  it('two different subjects derive two different DIDs, from the identical seed', async () => {
    process.env.FREEAGENTS_PLATFORM_SEED = 'b'.repeat(64);
    const identity = createIdentityAdapter(createKnownKeyStore());

    const a = await identity.createOperatorDid('subject-a');
    const b = await identity.createOperatorDid('subject-b');

    expect(a.did).not.toBe(b.did);
  });

  it('the derived DID actually verifies real signature material through @arcblock/did fromPublicKey, not a hand-rolled encoding', async () => {
    process.env.FREEAGENTS_PLATFORM_SEED = 'c'.repeat(64);
    const identity = createIdentityAdapter(createKnownKeyStore());

    const { did, publicKeyMultibase } = await identity.createOperatorDid('subject-verify-me');
    const key = await Ed25519VerificationKey2020.fromFingerprint({
      fingerprint: publicKeyMultibase,
    });
    const raw = (key as unknown as { _publicKeyBuffer: Uint8Array })._publicKeyBuffer;
    expect(did).toBe(`did:abt:${fromPublicKey(raw)}`);
  });

  // MUTATION PROOF 1 (card's own list, item 1): a random rather than
  // seed-derived key must be rejected by this exact test, since the same
  // subject would then mint two different DIDs across two calls.
  it('MUTATION PROOF: derivation must not be random -- calling twice with a fresh in-process adapter still agrees', async () => {
    process.env.FREEAGENTS_PLATFORM_SEED = 'd'.repeat(64);
    const first = await createIdentityAdapter(createKnownKeyStore()).createOperatorDid('subject-mutation-proof');
    const second = await createIdentityAdapter(createKnownKeyStore()).createOperatorDid('subject-mutation-proof');
    expect(first.did).toBe(second.did);
  });

  // MUTATION PROOF 5 (card's own list, item 5): a missing seed must fail
  // closed, never fall back to a random key that would mint a different
  // DID after every restart.
  it('fails closed, naming FREEAGENTS_PLATFORM_SEED, when the seed is unset', async () => {
    delete process.env.FREEAGENTS_PLATFORM_SEED;
    const identity = createIdentityAdapter(createKnownKeyStore());

    await expect(identity.createOperatorDid('subject-no-seed')).rejects.toThrow(/FREEAGENTS_PLATFORM_SEED/);
  });

  it('fails closed, naming FREEAGENTS_PLATFORM_SEED, when the seed is malformed (not 64 hex chars)', async () => {
    process.env.FREEAGENTS_PLATFORM_SEED = 'not-hex-and-too-short';
    const identity = createIdentityAdapter(createKnownKeyStore());

    await expect(identity.createOperatorDid('subject-bad-seed')).rejects.toThrow(/FREEAGENTS_PLATFORM_SEED/);
  });

  it('never stores or returns a private key: the projection carries only did and publicKeyMultibase', async () => {
    process.env.FREEAGENTS_PLATFORM_SEED = 'e'.repeat(64);
    const identity = createIdentityAdapter(createKnownKeyStore());

    const pair = await identity.createOperatorDid('subject-no-secret');
    expect(Object.keys(pair).sort()).toEqual(['did', 'publicKeyMultibase']);
  });
});
