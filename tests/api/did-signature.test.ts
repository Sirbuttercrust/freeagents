// R-34 acceptance for src/adapters/identity/http-signature.ts. Fixtures
// generate a real ed25519 keypair and did:abt DID the same way
// tests/e2e/smoke.test.ts and tests/api/agent-invariant2.test.ts already do,
// then sign a real RFC 9421 message over it -- no fabricated constants.
import { describe, it, expect, vi } from 'vitest';
import { sign } from 'node:crypto';
import {
  verify,
  SIGNATURE_MAX_AGE_SECONDS,
  SIGNATURE_CLOCK_SKEW_TOLERANCE_SECONDS,
  type SignedRequestLike,
  type SigningKeyResolver,
} from '../../src/adapters/identity/http-signature.js';
import { createDidAbtSigningKeyResolver, createKnownKeyStore } from '../../src/adapters/identity/did-abt-resolver.js';
import { MemoryObservedKeyRepository } from '../../src/adapters/storage/memory.js';
import type { ObservedKeyRepository } from '../../src/adapters/storage/types.js';
import { createMemorySignatureSpendStorage } from '../../src/adapters/identity/signature-spend-storage-memory.js';
import type { SignatureSpendStorage } from '../../src/adapters/identity/signature-spend-storage-types.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

describe('DID-signed requests (RFC 9421)', () => {
  it('accepts a request whose Signature-Input and Signature verify against the resolved key', async () => {
    const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(7));
    const resolver = createDidAbtSigningKeyResolver(async () => true);
    const targetUri = 'http://127.0.0.1:41234/jobs';
    const headers = signRequest(identity, 'POST', targetUri, { components: ['@method', '@target-uri'] });
    const req: SignedRequestLike = { method: 'POST', targetUri, headers };

    const result = await verify(req, resolver);

    expect(result).not.toBeNull();
    expect(result?.did).toBe(identity.did);
  });

  it('rejects a signature whose covered components omit @method or @target-uri', async () => {
    const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(7));
    const resolver = createDidAbtSigningKeyResolver(async () => true);
    const targetUri = 'http://127.0.0.1:41234/jobs';

    const onlyTarget = signRequest(identity, 'POST', targetUri, { components: ['@target-uri'] });
    const onlyMethod = signRequest(identity, 'POST', targetUri, { components: ['@method'] });

    expect(await verify({ method: 'POST', targetUri, headers: onlyTarget }, resolver)).toBeNull();
    expect(await verify({ method: 'POST', targetUri, headers: onlyMethod }, resolver)).toBeNull();
  });

  it('rejects when keyResolver returns null for the claimed did', async () => {
    const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(7));
    const resolver: SigningKeyResolver = async () => null;
    const targetUri = 'http://127.0.0.1:41234/jobs';
    const headers = signRequest(identity, 'POST', targetUri, { components: ['@method', '@target-uri'] });

    const result = await verify({ method: 'POST', targetUri, headers }, resolver);

    expect(result).toBeNull();
  });

  it('rejects a signature whose base was signed over a different target-uri', async () => {
    const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(7));
    const resolver = createDidAbtSigningKeyResolver(async () => true);
    const signedUri = 'http://127.0.0.1:41234/jobs';
    const presentedUri = 'http://127.0.0.1:41234/jobs/j-1/confirm';
    const headers = signRequest(identity, 'POST', signedUri, { components: ['@method', '@target-uri'] });

    const result = await verify({ method: 'POST', targetUri: presentedUri, headers }, resolver);

    expect(result).toBeNull();
  });

  it('rejects a created timestamp outside the freshness window', async () => {
    const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(7));
    const resolver = createDidAbtSigningKeyResolver(async () => true);
    const targetUri = 'http://127.0.0.1:41234/jobs';
    const now = new Date();
    const stale = Math.floor(now.getTime() / 1000) - (SIGNATURE_MAX_AGE_SECONDS + 60);
    const staleHeaders = signRequest(identity, 'POST', targetUri, {
      components: ['@method', '@target-uri'],
      created: stale,
    });
    const freshCreated = Math.floor(now.getTime() / 1000);
    const freshHeaders = signRequest(identity, 'POST', targetUri, {
      components: ['@method', '@target-uri'],
      created: freshCreated,
    });

    const staleResult = await verify({ method: 'POST', targetUri, headers: staleHeaders }, resolver, { now });
    const freshResult = await verify({ method: 'POST', targetUri, headers: freshHeaders }, resolver, { now });

    expect(staleResult).toBeNull();
    expect(freshResult).toEqual({ did: identity.did });
  });

  it('rejects a created timestamp from the future, outside the freshness window', async () => {
    // now - created is negative here; without Math.abs this clause would
    // never reject a future-dated created, no matter how far ahead it is.
    const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(7));
    const resolver = createDidAbtSigningKeyResolver(async () => true);
    const targetUri = 'http://127.0.0.1:41234/jobs';
    const now = new Date();
    const future = Math.floor(now.getTime() / 1000) + (SIGNATURE_MAX_AGE_SECONDS + 60);
    const futureHeaders = signRequest(identity, 'POST', targetUri, {
      components: ['@method', '@target-uri'],
      created: future,
    });

    const futureResult = await verify({ method: 'POST', targetUri, headers: futureHeaders }, resolver, { now });

    expect(futureResult).toBeNull();
  });

  // S6: the freshness check used to be Math.abs(now - created) > MAX_AGE, so
  // a signature claiming it was made in the future was accepted exactly as
  // readily as one made in the past, doubling the real replay window. A
  // signature 280 seconds ahead is inside the OLD symmetric window
  // (300 seconds) but must now be refused: the future gets its own, much
  // smaller, named tolerance rather than reusing SIGNATURE_MAX_AGE_SECONDS.
  it('rejects a signature created 280 seconds in the future (S6: future is not the same allowance as the past)', async () => {
    const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(7));
    const resolver = createDidAbtSigningKeyResolver(async () => true);
    const targetUri = 'http://127.0.0.1:41234/jobs';
    const now = new Date();
    const created = Math.floor(now.getTime() / 1000) + 280;
    const headers = signRequest(identity, 'POST', targetUri, {
      components: ['@method', '@target-uri'],
      created,
    });

    const result = await verify({ method: 'POST', targetUri, headers }, resolver, { now });

    expect(result).toBeNull();
  });

  // S6: clocks differ by a few seconds between two ordinary machines, and a
  // signer whose clock is a little fast is not an attacker. The tolerance is
  // named for what it is (a skew allowance) and has its own small value, not
  // SIGNATURE_MAX_AGE_SECONDS reused.
  it('accepts a signature created a few seconds in the future, inside the named clock-skew tolerance', async () => {
    const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(7));
    const resolver = createDidAbtSigningKeyResolver(async () => true);
    const targetUri = 'http://127.0.0.1:41234/jobs';
    const now = new Date();
    const created = Math.floor(now.getTime() / 1000) + SIGNATURE_CLOCK_SKEW_TOLERANCE_SECONDS;
    const headers = signRequest(identity, 'POST', targetUri, {
      components: ['@method', '@target-uri'],
      created,
    });

    const result = await verify({ method: 'POST', targetUri, headers }, resolver, { now });

    expect(result).toEqual({ did: identity.did });
  });

  // S6 done-means: the backward-looking boundary is unchanged. 299 seconds
  // in the past still verifies; 301 does not. This is the same
  // SIGNATURE_MAX_AGE_SECONDS check as before, now on its own one-sided
  // comparison rather than folded into Math.abs.
  it('a signature created 299 seconds in the past still verifies; 301 seconds does not', async () => {
    const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(7));
    const resolver = createDidAbtSigningKeyResolver(async () => true);
    const targetUri = 'http://127.0.0.1:41234/jobs';
    const now = new Date();
    const nowSeconds = Math.floor(now.getTime() / 1000);

    const justInsideHeaders = signRequest(identity, 'POST', targetUri, {
      components: ['@method', '@target-uri'],
      created: nowSeconds - 299,
    });
    const justOutsideHeaders = signRequest(identity, 'POST', targetUri, {
      components: ['@method', '@target-uri'],
      created: nowSeconds - 301,
    });

    const justInside = await verify({ method: 'POST', targetUri, headers: justInsideHeaders }, resolver, { now });
    const justOutside = await verify({ method: 'POST', targetUri, headers: justOutsideHeaders }, resolver, { now });

    expect(justInside).toEqual({ did: identity.did });
    expect(justOutside).toBeNull();
  });

  it('rejects a signature whose declared alg is not ed25519, even though the bytes verify', async () => {
    const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(7));
    const resolver = createDidAbtSigningKeyResolver(async () => true);
    const targetUri = 'http://127.0.0.1:41234/jobs';
    // The signature itself is genuinely valid ed25519 over this exact base
    // (Node signs whatever bytes it is given, regardless of the alg label),
    // so only the alg guard can be the reason this is refused.
    const headers = signRequest(identity, 'POST', targetUri, { components: ['@method', '@target-uri'], alg: 'rsa-pss-sha512' });

    const result = await verify({ method: 'POST', targetUri, headers }, resolver);

    expect(result).toBeNull();
  });

  it('accepts a signature whose Signature-Input omits the alg parameter entirely', async () => {
    const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(7));
    const resolver = createDidAbtSigningKeyResolver(async () => true);
    const targetUri = 'http://127.0.0.1:41234/jobs';
    const headers = signRequest(identity, 'POST', targetUri, { components: ['@method', '@target-uri'], alg: null });

    const result = await verify({ method: 'POST', targetUri, headers }, resolver);

    expect(result).toEqual({ did: identity.did });
  });

  it('picks the first Signature-Input value when the header is duplicated', async () => {
    const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(7));
    const resolver = createDidAbtSigningKeyResolver(async () => true);
    const targetUri = 'http://127.0.0.1:41234/jobs';
    const headers = signRequest(identity, 'POST', targetUri, { components: ['@method', '@target-uri'] });
    const duplicated = { ...headers, 'signature-input': [headers['signature-input'], 'sig2=("@method");keyid="bogus";created=0'] };

    const result = await verify({ method: 'POST', targetUri, headers: duplicated }, resolver);

    expect(result).toEqual({ did: identity.did });
  });

  it('picks the first Signature value when the header is duplicated', async () => {
    const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(7));
    const resolver = createDidAbtSigningKeyResolver(async () => true);
    const targetUri = 'http://127.0.0.1:41234/jobs';
    const headers = signRequest(identity, 'POST', targetUri, { components: ['@method', '@target-uri'] });
    const duplicated = { ...headers, signature: [headers.signature, 'sig1=:AAAA:'] };

    const result = await verify({ method: 'POST', targetUri, headers: duplicated }, resolver);

    expect(result).toEqual({ did: identity.did });
  });

  it('joins a duplicated covered header with ", " when computing the signature base', async () => {
    const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(7));
    const resolver = createDidAbtSigningKeyResolver(async () => true);
    const targetUri = 'http://127.0.0.1:41234/jobs';
    const method = 'POST';
    const created = Math.floor(Date.now() / 1000);
    const paramsText = `("@method" "@target-uri" "x-trace");keyid="${identity.keyid}";alg="ed25519";created=${created}`;
    // The header arrives duplicated; RFC 9421 requires the verifier to fold
    // repeated field values with ", " before hashing them into the base.
    const base = [
      `"@method": ${method}`,
      `"@target-uri": ${targetUri}`,
      '"x-trace": first, second',
      `"@signature-params": ${paramsText}`,
    ].join('\n');
    const sig = sign(null, Buffer.from(base, 'utf8'), identity.privateKey);
    const headers = {
      'signature-input': `sig1=${paramsText}`,
      signature: `sig1=:${sig.toString('base64')}:`,
      'x-trace': ['first', 'second'],
    };

    const result = await verify({ method, targetUri, headers }, resolver);

    expect(result).toEqual({ did: identity.did });
  });

  it('createDidAbtSigningKeyResolver rejects a keyid whose key does not derive to the claimed DID', async () => {
    const victim = await signingIdentityFromSeed(new Uint8Array(32).fill(7));
    const attacker = await signingIdentityFromSeed(new Uint8Array(32).fill(9));
    const resolver = createDidAbtSigningKeyResolver(async () => true);

    // Attacker's key material, presented under the victim's DID.
    const attackerFragment = attacker.keyid.slice(attacker.keyid.indexOf('#') + 1);
    const forgedKeyid = `${victim.did}#${attackerFragment}`;

    const resolved = await resolver(victim.did, forgedKeyid);

    expect(resolved).toBeNull();
  });

  // D5 (Review finding, round 2, task t_8a82c865): recording is now deferred to an
  // onVerified callback the resolver hands back, invoked by http-signature
  // verify() only once the request's own signature bytes have checked out
  // -- not merely once the keyid's binding check (public data) passes. A
  // direct call to the resolver proves the key resolved but records
  // nothing until the caller confirms the signature verified.
  it('records the observed verification method in a KnownKeyStore once the caller confirms the signature verified', async () => {
    const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(7));
    const knownKeys = createKnownKeyStore();
    const resolver = createDidAbtSigningKeyResolver(async () => true, knownKeys);

    expect(knownKeys.get(identity.did)).toBeNull();

    const resolved = await resolver(identity.did, identity.keyid);

    expect(resolved).not.toBeNull();
    expect(knownKeys.get(identity.did)).toBeNull();

    await resolved?.onVerified?.();

    expect(knownKeys.get(identity.did)).toBe(identity.keyid);
  });

  it('does not record anything when the binding check fails (a forged keyid)', async () => {
    const victim = await signingIdentityFromSeed(new Uint8Array(32).fill(7));
    const attacker = await signingIdentityFromSeed(new Uint8Array(32).fill(9));
    const knownKeys = createKnownKeyStore();
    const resolver = createDidAbtSigningKeyResolver(async () => true, knownKeys);
    const attackerFragment = attacker.keyid.slice(attacker.keyid.indexOf('#') + 1);
    const forgedKeyid = `${victim.did}#${attackerFragment}`;

    await resolver(victim.did, forgedKeyid);

    expect(knownKeys.get(victim.did)).toBeNull();
  });

  // D4 (Review finding, round 2, task t_8a82c865): a durable-write failure must not
  // change the answer to "did this signature verify". The signature has
  // already checked out by the time onVerified runs; the durable write
  // inside it is bookkeeping, not part of the verdict. A throwing
  // ObservedKeyRepository used to be caught by the resolver's own
  // try/catch before onVerified existed, and turned the whole resolution
  // into null -- which every SigningKeyResolver caller reads as "this
  // signature does not verify" -- so a Postgres blip reported a genuine
  // signature as forged.
  it('a genuine signature still verifies when the durable ObservedKeyRepository write throws (D4)', async () => {
    const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(7));
    const throwingObservedKeys: ObservedKeyRepository = {
      record: () => Promise.reject(new Error('durable store unavailable')),
      get: () => Promise.resolve(null),
    };
    const resolver = createDidAbtSigningKeyResolver(async () => true, undefined, throwingObservedKeys);
    const targetUri = 'http://127.0.0.1:41234/jobs';
    const headers = signRequest(identity, 'POST', targetUri, { components: ['@method', '@target-uri'] });

    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await verify({ method: 'POST', targetUri, headers }, resolver);
      expect(result).toEqual({ did: identity.did });
      // The swallowed failure leaves a trace an operator can find
      // (t_84d1a099): the verdict is unchanged and the cause is logged.
      expect(errorLog).toHaveBeenCalledWith(
        'http-signature: onVerified durable write failed after a verified signature',
        expect.objectContaining({ message: 'durable store unavailable' }),
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it('still records into the in-process KnownKeyStore when the durable write throws (D4)', async () => {
    const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(7));
    const knownKeys = createKnownKeyStore();
    const throwingObservedKeys: ObservedKeyRepository = {
      record: () => Promise.reject(new Error('durable store unavailable')),
      get: () => Promise.resolve(null),
    };
    const resolver = createDidAbtSigningKeyResolver(async () => true, knownKeys, throwingObservedKeys);
    const targetUri = 'http://127.0.0.1:41234/jobs';
    const headers = signRequest(identity, 'POST', targetUri, { components: ['@method', '@target-uri'] });

    await verify({ method: 'POST', targetUri, headers }, resolver);

    expect(knownKeys.get(identity.did)).toBe(identity.keyid);
  });

  // D5 (Review finding, round 2, task t_8a82c865): the durable write must not happen
  // before the request's own signature bytes are confirmed to verify.
  // Before this fix, the resolver recorded as soon as the keyid's binding
  // check passed (a check over PUBLIC data: the fingerprint re-deriving
  // the claimed DID, both of which ride on the wire in every signed
  // request and every issued credential). An attacker who knows a
  // registered victim's DID and real keyid can sign a request with their
  // OWN private key while presenting the victim's genuine keyid: the
  // binding check passes (it is the victim's real fingerprint), so the
  // old code recorded the victim's own correct verification method,
  // before ever checking whether the BYTES of this particular request
  // were actually signed by that key. The route still 401s (the ed25519
  // check itself fails), but the durable write already happened.
  it('does not durably record before the request signature itself has actually verified (D5)', async () => {
    const victim = await signingIdentityFromSeed(new Uint8Array(32).fill(7));
    const attacker = await signingIdentityFromSeed(new Uint8Array(32).fill(9));
    const observedKeys = new MemoryObservedKeyRepository();
    const resolver = createDidAbtSigningKeyResolver(async () => true, undefined, observedKeys);
    const targetUri = 'http://127.0.0.1:41234/jobs';

    // The victim's genuine keyid (public), signed with the attacker's
    // private key: the binding check alone cannot catch this, only the
    // actual ed25519 verification over the request bytes can.
    const forgedIdentity: SigningIdentity = {
      did: victim.did,
      keyid: victim.keyid,
      privateKey: attacker.privateKey,
    };
    const headers = signRequest(forgedIdentity, 'POST', targetUri, { components: ['@method', '@target-uri'] });

    const result = await verify({ method: 'POST', targetUri, headers }, resolver);

    expect(result).toBeNull();
    expect(await observedKeys.get(victim.did)).toBeNull();
  });

  // S5 (this card): a captured header set replayed a second time used to
  // verify again, with no nonce, no seen-signature store, and no one-shot
  // marker anywhere. The positive control comes first: a legitimate
  // signature verifies once. The refusal is the point: the exact same
  // signature bytes presented a second time must be refused, not accepted
  // again.
  it('S5: a legitimate signature verifies once; the same signature presented again is refused (replay)', async () => {
    const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(7));
    const resolver = createDidAbtSigningKeyResolver(async () => true);
    const targetUri = 'http://127.0.0.1:41234/jobs';
    const headers = signRequest(identity, 'POST', targetUri, { components: ['@method', '@target-uri'] });
    const spendStorage: SignatureSpendStorage = createMemorySignatureSpendStorage();

    const first = await verify({ method: 'POST', targetUri, headers }, resolver, { spendStorage });
    const second = await verify({ method: 'POST', targetUri, headers }, resolver, { spendStorage });

    expect(first).toEqual({ did: identity.did });
    expect(second).toBeNull();
  });

  // S5 mutation proof 6: the spend key is scoped by keyid, so two different
  // signers each presenting their own (different) signature both verify --
  // one signer's spend record can never collide with another's. Pinned by
  // asserting the storage actually recorded each signer's OWN keyid, not
  // merely that both requests happened to verify (two different signatures
  // hash differently regardless of keyid, so a weaker assertion here would
  // not catch a spend key that silently dropped keyid from its key).
  it('S5: two different signers presenting different signatures both verify (the spend key does not collide across signers)', async () => {
    const first = await signingIdentityFromSeed(new Uint8Array(32).fill(7));
    const second = await signingIdentityFromSeed(new Uint8Array(32).fill(9));
    const resolver = createDidAbtSigningKeyResolver(async () => true);
    const targetUri = 'http://127.0.0.1:41234/jobs';
    const spendStorage: SignatureSpendStorage = createMemorySignatureSpendStorage();
    const recordSpy = vi.spyOn(spendStorage, 'record');

    const firstHeaders = signRequest(first, 'POST', targetUri, { components: ['@method', '@target-uri'] });
    const secondHeaders = signRequest(second, 'POST', targetUri, { components: ['@method', '@target-uri'] });

    const firstResult = await verify({ method: 'POST', targetUri, headers: firstHeaders }, resolver, { spendStorage });
    const secondResult = await verify({ method: 'POST', targetUri, headers: secondHeaders }, resolver, { spendStorage });

    expect(firstResult).toEqual({ did: first.did });
    expect(secondResult).toEqual({ did: second.did });
    expect(recordSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({ keyid: first.keyid }));
    expect(recordSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ keyid: second.keyid }));
  });

  // S5 mutation proof 2: the spend check must run AFTER the ed25519 bytes
  // verify, never before -- the same rule onVerified already follows (D5
  // above). An attacker presenting a victim's real keyid under a forged
  // signature (their own private key) must not cause any durable write to
  // the spend store: the signature never verified, so there is nothing to
  // record. If the check ran before ed25519 verification, the forged
  // attempt's own signature hash would land in the store regardless of
  // whether the bytes ever checked out.
  it('S5: a forged signature under a victim keyid causes no durable write to the spend store', async () => {
    const victim = await signingIdentityFromSeed(new Uint8Array(32).fill(7));
    const attacker = await signingIdentityFromSeed(new Uint8Array(32).fill(9));
    const resolver = createDidAbtSigningKeyResolver(async () => true);
    const targetUri = 'http://127.0.0.1:41234/jobs';
    const spendStorage: SignatureSpendStorage = createMemorySignatureSpendStorage();
    const recordSpy = vi.spyOn(spendStorage, 'record');

    const forgedIdentity: SigningIdentity = {
      did: victim.did,
      keyid: victim.keyid,
      privateKey: attacker.privateKey,
    };
    const headers = signRequest(forgedIdentity, 'POST', targetUri, { components: ['@method', '@target-uri'] });

    const result = await verify({ method: 'POST', targetUri, headers }, resolver, { spendStorage });

    expect(result).toBeNull();
    expect(recordSpy).not.toHaveBeenCalled();
  });

  // S5 mutation proof 3: onVerified's own failure is swallowed (bookkeeping,
  // D4 above) because the signature already verified by the time it runs.
  // The spend check is the opposite: it IS the control, so a storage
  // failure there must refuse the request rather than silently pass it
  // through as if no replay protection existed at all.
  it('S5: a spend-store failure refuses the request (fail closed), unlike onVerified\'s own swallowed failure', async () => {
    const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(7));
    const resolver = createDidAbtSigningKeyResolver(async () => true);
    const targetUri = 'http://127.0.0.1:41234/jobs';
    const headers = signRequest(identity, 'POST', targetUri, { components: ['@method', '@target-uri'] });
    const throwingSpendStorage: SignatureSpendStorage = {
      findByKeyidAndHash: () => Promise.reject(new Error('spend store unavailable')),
      record: () => Promise.reject(new Error('spend store unavailable')),
    };

    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await verify({ method: 'POST', targetUri, headers }, resolver, { spendStorage: throwingSpendStorage });
      expect(result).toBeNull();
    } finally {
      errorLog.mockRestore();
    }
  });
});

