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

// An ArcBlock wallet already carries its own DID (operator and agent DIDs
// throughout the suite are wallet DIDs, not derived from a seed the same
// way did:abt agent DIDs are). Its secretKey is seed(32)||public(32) in
// hex, so the first 32 bytes are the same seed signingIdentityFromSeed
// would take, but the DID here comes from the wallet itself rather than
// being re-derived, since @ocap/wallet's DID encoding is not guaranteed to
// match @arcblock/did's fromPublicKey for every wallet type.
export async function signingIdentityFromWallet(wallet: {
  readonly secretKey: string;
  toDid(): string;
}): Promise<SigningIdentity> {
  const did = wallet.toDid();
  const seed = Uint8Array.from(Buffer.from(wallet.secretKey.replace(/^0x/, ''), 'hex')).slice(0, 32);
  const key = await Ed25519VerificationKey2020.generate({ seed, controller: did });
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
//
// S5: the default `created` (when the caller does not pin one) is drawn
// from a tracker that remembers every value it has issued and never hands
// one out twice, searching backward from the real wall clock only as far
// as it needs to find a free one. Two calls to signRequest for the same
// identity, method, URI and body used to produce byte-identical signatures
// when they landed on the same `created`, whether or not they happened in
// the same wall-clock second -- which S5's own replay refusal now
// correctly reads as the same signature presented twice, even when two
// DIFFERENT test cases each intended a fresh, independent request (fast
// test suites routinely fire far more than one signed request per real
// second, and can straddle a second boundary between calls). Searching
// backward stays inside SIGNATURE_MAX_AGE_SECONDS's generous five-minute
// allowance, so hundreds of calls in one real second each get a distinct,
// still-fresh `created` with no risk of ever crossing into the future and
// tripping the much smaller clock-skew tolerance (the mistake an earlier,
// forward-counting version of this fixture made).
// Never overrides an explicitly-passed `created` (the freshness-window
// tests in tests/api/did-signature.test.ts all pin their own).
// D3 (QA review round 1, task t_05b14bcc): the tracker has a real ceiling.
// Once the search has walked back SIGNATURE_MAX_AGE_SECONDS - 1 seconds
// from the current wall clock without finding a free value, the next
// `created` it would hand out is already stale, and a caller relying on
// the default would see a real, but unexplained, "signature rejected"
// failure with nothing pointing at the fixture. Fail loudly and by name
// instead, so an exhausted bucket reads as "fixture exhausted", never as
// "signature rejected".
// D5 (QA review round 2, task t_05b14bcc): an earlier version tracked only
// the single smallest value issued so far and searched from
// `min(now, lastIssued) - 1`. That collapses to always decrementing by one
// from the last call once the wall clock has caught up, which can walk
// straight past a `now` that was never actually issued, and can still
// reissue a value from an earlier second once the search crosses back over
// it. Tracking every issued value in a set, and searching down from the
// CURRENT wall clock each time rather than from the last issued value,
// closes both holes: a value is checked for a real collision, not assumed
// stale, and a call whose wall-clock second has moved on gets that fresh
// second back rather than continuing to crawl backward. Issued values
// older than the ceiling are pruned each call so the set cannot grow
// without bound over a long test run; a value that old could not be
// reissued anyway, since using it would immediately trip the ceiling.
const BUCKET_CEILING = 300;
const issued = new Set<number>();
function nextCreated(): number {
  const now = Math.floor(Date.now() / 1000);
  for (const value of issued) {
    if (value <= now - BUCKET_CEILING) issued.delete(value);
  }
  let candidate = now;
  while (issued.has(candidate)) {
    candidate -= 1;
  }
  if (now - candidate >= BUCKET_CEILING) {
    throw new Error(
      `signRequest: fixture bucket exhausted (${now - candidate} seconds back from now). ` +
        'Pin an explicit `created` for this call instead of relying on the default.',
    );
  }
  issued.add(candidate);
  return candidate;
}

export function signRequest(
  id: SigningIdentity,
  method: string,
  targetUri: string,
  options: SignRequestOptions = {},
): SignedHeaders {
  const body = options.body ?? '';
  const components = options.components ?? DEFAULT_COVERED_COMPONENTS;
  const created = options.created ?? nextCreated();
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
