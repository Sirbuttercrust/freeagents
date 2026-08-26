// R-34 acceptance for src/adapters/identity/http-signature.ts. Fixtures
// generate a real ed25519 keypair and did:abt DID the same way
// tests/e2e/smoke.test.ts and tests/api/agent-invariant2.test.ts already do,
// then sign a real RFC 9421 message over it -- no fabricated constants.
import { describe, it, expect } from 'vitest';
import { createPrivateKey, sign } from 'node:crypto';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { fromPublicKey } from '@arcblock/did';
import {
  verify,
  SIGNATURE_MAX_AGE_SECONDS,
  type SignedRequestLike,
  type SigningKeyResolver,
} from '../../src/adapters/identity/http-signature.js';
import { createDidAbtSigningKeyResolver } from '../../src/adapters/identity/did-abt-resolver.js';

// PKCS8 DER for an ed25519 private key is a fixed 16-byte prefix followed by
// the raw 32-byte seed (RFC 8410).
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

interface Identity {
  did: string;
  keyid: string;
  privateKey: ReturnType<typeof createPrivateKey>;
}

// Every case in this file resolves keys through createDidAbtSigningKeyResolver
// (Task A2), so fixtures only need the did:abt DID, its keyid and the raw
// private key -- the resolver derives the PEM itself from the fingerprint.
async function identityFromSeed(seed: Uint8Array): Promise<Identity> {
  const key = await Ed25519VerificationKey2020.generate({ seed, controller: 'did:abt:pending' });
  const raw = (key as unknown as { _publicKeyBuffer: Uint8Array })._publicKeyBuffer;
  const did = `did:abt:${fromPublicKey(raw)}`;
  const keyid = `${did}#${key.publicKeyMultibase}`;
  const pkcs8 = Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]);
  const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  return { did, keyid, privateKey };
}

function buildBase(
  method: string,
  targetUri: string,
  components: readonly string[],
  headers: Record<string, string | string[] | undefined>,
  paramsText: string,
): string {
  const lines: string[] = [];
  for (const component of components) {
    if (component === '@method') {
      lines.push(`"@method": ${method.toUpperCase()}`);
    } else if (component === '@target-uri') {
      lines.push(`"@target-uri": ${targetUri}`);
    } else {
      const headerName = component.toLowerCase();
      const value = headers[headerName];
      const valueStr = (Array.isArray(value) ? value.join(', ') : (value ?? '')).trim();
      lines.push(`"${headerName}": ${valueStr}`);
    }
  }
  lines.push(`"@signature-params": ${paramsText}`);
  return lines.join('\n');
}

function signRequest(
  identity: Identity,
  method: string,
  targetUri: string,
  components: readonly string[],
  headers: Record<string, string | string[] | undefined> = {},
  created: number = Math.floor(Date.now() / 1000),
): { 'signature-input': string; signature: string } {
  const covered = components.map((c) => `"${c}"`).join(' ');
  const paramsText = `(${covered});keyid="${identity.keyid}";alg="ed25519";created=${created}`;
  const base = buildBase(method, targetUri, components, headers, paramsText);
  const sig = sign(null, Buffer.from(base, 'utf8'), identity.privateKey);
  return {
    'signature-input': `sig1=${paramsText}`,
    signature: `sig1=:${sig.toString('base64')}:`,
  };
}

describe('DID-signed requests (RFC 9421)', () => {
  it('accepts a request whose Signature-Input and Signature verify against the resolved key', async () => {
    const identity = await identityFromSeed(new Uint8Array(32).fill(7));
    const resolver = createDidAbtSigningKeyResolver(async () => true);
    const targetUri = 'http://127.0.0.1:41234/jobs';
    const headers = signRequest(identity, 'POST', targetUri, ['@method', '@target-uri']);
    const req: SignedRequestLike = { method: 'POST', targetUri, headers };

    const result = await verify(req, resolver);

    expect(result).not.toBeNull();
    expect(result?.did).toBe(identity.did);
  });

  it('rejects a signature whose covered components omit @method or @target-uri', async () => {
    const identity = await identityFromSeed(new Uint8Array(32).fill(7));
    const resolver = createDidAbtSigningKeyResolver(async () => true);
    const targetUri = 'http://127.0.0.1:41234/jobs';

    const onlyTarget = signRequest(identity, 'POST', targetUri, ['@target-uri']);
    const onlyMethod = signRequest(identity, 'POST', targetUri, ['@method']);

    expect(await verify({ method: 'POST', targetUri, headers: onlyTarget }, resolver)).toBeNull();
    expect(await verify({ method: 'POST', targetUri, headers: onlyMethod }, resolver)).toBeNull();
  });

  it('rejects when keyResolver returns null for the claimed did', async () => {
    const identity = await identityFromSeed(new Uint8Array(32).fill(7));
    const resolver: SigningKeyResolver = async () => null;
    const targetUri = 'http://127.0.0.1:41234/jobs';
    const headers = signRequest(identity, 'POST', targetUri, ['@method', '@target-uri']);

    const result = await verify({ method: 'POST', targetUri, headers }, resolver);

    expect(result).toBeNull();
  });

  it('rejects a signature whose base was signed over a different target-uri', async () => {
    const identity = await identityFromSeed(new Uint8Array(32).fill(7));
    const resolver = createDidAbtSigningKeyResolver(async () => true);
    const signedUri = 'http://127.0.0.1:41234/jobs';
    const presentedUri = 'http://127.0.0.1:41234/jobs/j-1/confirm';
    const headers = signRequest(identity, 'POST', signedUri, ['@method', '@target-uri']);

    const result = await verify({ method: 'POST', targetUri: presentedUri, headers }, resolver);

    expect(result).toBeNull();
  });

  it('rejects a created timestamp outside the freshness window', async () => {
    const identity = await identityFromSeed(new Uint8Array(32).fill(7));
    const resolver = createDidAbtSigningKeyResolver(async () => true);
    const targetUri = 'http://127.0.0.1:41234/jobs';
    const now = new Date();
    const stale = Math.floor(now.getTime() / 1000) - (SIGNATURE_MAX_AGE_SECONDS + 60);
    const staleHeaders = signRequest(identity, 'POST', targetUri, ['@method', '@target-uri'], {}, stale);
    const freshCreated = Math.floor(now.getTime() / 1000);
    const freshHeaders = signRequest(identity, 'POST', targetUri, ['@method', '@target-uri'], {}, freshCreated);

    const staleResult = await verify({ method: 'POST', targetUri, headers: staleHeaders }, resolver, { now });
    const freshResult = await verify({ method: 'POST', targetUri, headers: freshHeaders }, resolver, { now });

    expect(staleResult).toBeNull();
    expect(freshResult).toEqual({ did: identity.did });
  });

  it('createDidAbtSigningKeyResolver rejects a keyid whose key does not derive to the claimed DID', async () => {
    const victim = await identityFromSeed(new Uint8Array(32).fill(7));
    const attacker = await identityFromSeed(new Uint8Array(32).fill(9));
    const resolver = createDidAbtSigningKeyResolver(async () => true);

    // Attacker's key material, presented under the victim's DID.
    const attackerFragment = attacker.keyid.slice(attacker.keyid.indexOf('#') + 1);
    const forgedKeyid = `${victim.did}#${attackerFragment}`;

    const resolved = await resolver(victim.did, forgedKeyid);

    expect(resolved).toBeNull();
  });
});
