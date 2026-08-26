// RFC 9421 signing helper for DID-signed request fixtures (R-34): builds a
// real ed25519 keypair bound to a did:abt DID, then signs a genuine request
// signature base over it -- no fabricated constants, every value here is
// produced by running the same primitives src/adapters/identity/http-signature.ts
// verifies against. Shared by tests/api/did-signature.test.ts,
// tests/api/did-signed-routes.test.ts and the e2e signed block in
// tests/e2e/smoke.test.ts, so the base is built by one function, not copies
// that can quietly diverge.
import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { fromPublicKey } from '@arcblock/did';

// PKCS8 DER for an ed25519 private key is a fixed 16-byte prefix followed by
// the raw 32-byte seed (RFC 8410).
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface SigningIdentity {
  readonly did: string;
  readonly keyid: string;
  readonly privateKey: KeyObject;
}

export async function signingIdentityFromSeed(seed: Uint8Array): Promise<SigningIdentity> {
  const key = await Ed25519VerificationKey2020.generate({ seed, controller: 'did:abt:pending' });
  const raw = (key as unknown as { _publicKeyBuffer: Uint8Array })._publicKeyBuffer;
  const did = `did:abt:${fromPublicKey(raw)}`;
  const keyid = `${did}#${key.publicKeyMultibase}`;
  const pkcs8 = Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]);
  const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  return { did, keyid, privateKey };
}

// The set src/api/app.ts's didSignature middleware requires: binding the
// method, the exact URI and the body (via content-digest) into one signature.
export const DEFAULT_COVERED_COMPONENTS: readonly string[] = ['@method', '@target-uri', 'content-digest'];

export interface SignedHeaders {
  readonly [header: string]: string;
  readonly 'signature-input': string;
  readonly signature: string;
  readonly 'content-digest': string;
}

export interface SignRequestOptions {
  /** JSON body the signature must bind, via content-digest. Defaults to no body. */
  readonly body?: string;
  /** Covered component identifiers. Defaults to the set the route middleware requires. */
  readonly components?: readonly string[];
  /** Overrides the `created` parameter, for testing the freshness window. */
  readonly created?: number;
  /** Overrides the `alg` parameter text, for testing the algorithm guard. The bytes are still signed with ed25519 -- this only changes what the signature-input header claims. Pass `null` to omit the `alg` parameter entirely. */
  readonly alg?: string | null;
}

// Signs a real RFC 9421 request signature. content-digest is always computed
// from `body` (empty body still hashes to a real digest), whether or not it
// is a covered component, so a caller can always attach it as a header.
export function signRequest(
  id: SigningIdentity,
  method: string,
  targetUri: string,
  options: SignRequestOptions = {},
): SignedHeaders {
  const body = options.body ?? '';
  const components = options.components ?? DEFAULT_COVERED_COMPONENTS;
  const created = options.created ?? Math.floor(Date.now() / 1000);
  const alg = options.alg === undefined ? 'ed25519' : options.alg;
  const digest = `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;

  const covered = components.map((c) => `"${c}"`).join(' ');
  const algSegment = alg === null ? '' : `;alg="${alg}"`;
  const paramsText = `(${covered});keyid="${id.keyid}"${algSegment};created=${created}`;
  const lines: string[] = [];
  for (const component of components) {
    if (component === '@method') {
      lines.push(`"@method": ${method.toUpperCase()}`);
    } else if (component === '@target-uri') {
      lines.push(`"@target-uri": ${targetUri}`);
    } else if (component === 'content-digest') {
      lines.push(`"content-digest": ${digest}`);
    } else {
      throw new Error(`signRequest: unsupported covered component "${component}"`);
    }
  }
  lines.push(`"@signature-params": ${paramsText}`);

  const sig = sign(null, Buffer.from(lines.join('\n'), 'utf8'), id.privateKey);
  return {
    'signature-input': `sig1=${paramsText}`,
    signature: `sig1=:${sig.toString('base64')}:`,
    'content-digest': digest,
  };
}
