// R-34 acceptance for src/adapters/identity/http-signature.ts. Fixtures
// generate a real ed25519 keypair and did:abt DID the same way
// tests/e2e/smoke.test.ts and tests/api/agent-invariant2.test.ts already do,
// then sign a real RFC 9421 message over it -- no fabricated constants.
import { describe, it, expect } from 'vitest';
import { sign } from 'node:crypto';
import {
  verify,
  SIGNATURE_MAX_AGE_SECONDS,
  type SignedRequestLike,
  type SigningKeyResolver,
} from '../../src/adapters/identity/http-signature.js';
import { createDidAbtSigningKeyResolver, createKnownKeyStore } from '../../src/adapters/identity/did-abt-resolver.js';
import { signingIdentityFromSeed, signRequest } from '../helpers/sign-request.js';

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

  it('records the observed verification method in a KnownKeyStore when the binding check passes', async () => {
    const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(7));
    const knownKeys = createKnownKeyStore();
    const resolver = createDidAbtSigningKeyResolver(async () => true, knownKeys);

    expect(knownKeys.get(identity.did)).toBeNull();

    const resolved = await resolver(identity.did, identity.keyid);

    expect(resolved).not.toBeNull();
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
});
