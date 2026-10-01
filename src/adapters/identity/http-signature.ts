// HTTP Message Signature (RFC 9421) verification for DID-authenticated
// requests. R-34, seeded by hand 2026-08-23 (Phase-0 rule: auth is on the
// irreversible list, so a human writes this stub and its failing test; the
// factory implements verify() against @arcblock/did).
//
// Contract:
//   verify(req, keyResolver, options) -> { did } | 'unknown-key' | 'invalid'
//   - reads Signature-Input / Signature headers (RFC 9421 field names)
//   - covers @method, @target-uri, content-digest when present
//   - resolves the signing key through keyResolver(did, keyid) and verifies
//     the ed25519 signature WITHOUT calling any vendor package from src/api/
//
// verify() is total: every failure path returns a value, never throws. This
// mirrors verifyDelegation (src/adapters/identity/identity.ts) so callers
// never need a try/catch to tell "not signed" from "signed wrong".
//
// B29: a well-formed request whose signature
// bytes genuinely verify but names a DID keyResolver has never heard of
// (unregistered, or the fingerprint-to-DID binding check fails) is a
// DIFFERENT fact from a signature that does not verify at all -- the caller
// held a real key and produced a real signature, this service simply does
// not know that key. Collapsing both into one "invalid signature" message
// told a caller with a perfectly good signature that their cryptography was
// wrong, when the real defect was that nothing had registered yet. 'unknown-
// key' names the resolver-returned-null case; every other failure (a
// malformed request, a stale timestamp, a wrong algorithm, bytes that do
// not verify against a resolved key) stays 'invalid' in verify().
//
// SW1-08: 'invalid' used to be one answer for every failed check, so a caller
// whose only fault was a stale created was told the same two words as one
// whose bytes were forged. verifyWithReason() below runs the checks once and
// returns the sentence for the check that failed; verify() is a thin call to
// it and keeps the three values above. The route layer in src/api/app.ts
// writes the sentence after "invalid signature: ". 'unknown-key' has no
// sentence: it already says what is true.
import { createHash, createPublicKey, verify as nodeVerify } from 'node:crypto';
import type { SignatureSpendStorage } from './signature-spend-storage-types.js';

export interface SignedRequestLike {
  readonly method: string;
  readonly targetUri: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

export interface SigningKeyResolver {
  (did: string, keyid: string): Promise<{
    readonly publicKeyPem: string;
    // Recording an observation is deferred to
    // this optional callback, invoked by verify() below ONLY after the
    // request's own ed25519 signature bytes have checked out -- never at
    // resolution time, when only the keyid's binding check (public data:
    // the fingerprint re-deriving the claimed DID) has passed. This closes
    // two defects at once: a durable-write failure can no longer turn a
    // genuine signature into a 401 (the verdict is already decided by the
    // time this runs), and an attacker presenting a victim's real keyid
    // under their own forged signature can no longer cause a durable
    // write for a signature that never actually verified.
    readonly onVerified?: () => Promise<void>;
  } | null>;
}

export interface VerifyOptions {
  /** Component identifiers that MUST appear in the covered list. */
  readonly requiredComponents?: readonly string[];
  /** Injected clock, for testing the freshness window. */
  readonly now?: Date;
  // S5: the one-shot spend store (this card). Optional so every existing
  // caller that never supplies one is unaffected -- a request signature is
  // then verified exactly as before, with no replay protection, the same
  // stance onVerified already takes on its own optional callback. When
  // supplied, a signature that has already verified once under the same
  // keyid is refused on a second presentation.
  readonly spendStorage?: SignatureSpendStorage;
}

export const SIGNATURE_MAX_AGE_SECONDS = 300;
// S6: clocks between two machines are never perfectly synchronised, and a
// signer whose clock runs a few seconds fast is not an attacker. This is a
// SEPARATE, much smaller allowance from SIGNATURE_MAX_AGE_SECONDS: the past
// gets five minutes because a request can sit in flight or in a queue; the
// future gets only enough room for ordinary clock drift, because nothing
// legitimate explains a request claiming to have been made minutes from now.
export const SIGNATURE_CLOCK_SKEW_TOLERANCE_SECONDS = 5;
export const REQUIRED_COVERED_COMPONENTS: readonly string[] = ['@method', '@target-uri'];
// SW1-08: the profile the API's routes require of a caller, named once. The
// route layer passes it as requiredComponents, the refusal sentences name it,
// and GET /capabilities describes it, so the three cannot disagree.
export const REQUEST_SIGNATURE_COMPONENTS: readonly string[] = ['@method', '@target-uri', 'content-digest'];

// B29: the full result shape. A structured failure carries WHICH refusal
// this was, so a route layer that wants to answer "unknown key" instead of
// "invalid signature" can, without re-deriving the distinction itself.
// SW1-08: verify() still answers only these three values; the sentence for an
// 'invalid' comes from verifyWithReason() (VerifyOutcome below).
export type VerifyResult = { readonly did: string } | 'unknown-key' | 'invalid';

function lookupHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | string[] | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      return headers[key];
    }
  }
  return undefined;
}

// SW1-08: the result of the checks together with WHICH check refused. Every
// 'invalid' carries one sentence a caller can act on; 'unknown-key' keeps its
// B29 meaning and needs no sentence of its own.
export type VerifyOutcome =
  | { readonly kind: 'verified'; readonly did: string }
  | { readonly kind: 'unknown-key' }
  | { readonly kind: 'invalid'; readonly reason: string };

// "a", "a and b", "a, b and c".
function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

const invalid = (reason: string): VerifyOutcome => ({ kind: 'invalid', reason });

// Every sentence a refusal can carry. Checks that run before the key lookup
// answer the same sentence for a registered and an unregistered DID, so none of
// these says anything about whether a DID or key is known.
const REASONS = {
  headers: 'send both the Signature-Input and Signature headers',
  unreadableInput: () =>
    'Signature-Input is not readable; write it as ' +
    `sig1=(${REQUEST_SIGNATURE_COMPONENTS.map((c) => `"${c}"`).join(' ')});keyid="<your DID>#<key id>";alg="ed25519";created=<Unix seconds>`,
  notCovered: (required: readonly string[], missing: readonly string[]) =>
    `the signature must cover ${joinAnd(required)}; yours does not cover ${joinAnd(missing)}`,
  keyid: 'keyid must be <your DID>#<key id>',
  alg: 'the only supported alg is ed25519',
  noCreated: 'Signature-Input must carry created, the Unix time in seconds when you signed',
  stale: `created is more than ${SIGNATURE_MAX_AGE_SECONDS} seconds old; created must be within the last ${SIGNATURE_MAX_AGE_SECONDS} seconds, so sign the request again`,
  future: `created is more than ${SIGNATURE_CLOCK_SKEW_TOLERANCE_SECONDS} seconds in the future; set created to the current Unix time in seconds and sign the request again`,
  signatureHeader: 'the Signature header must hold your signature as <label>=:<base64>: under the same label Signature-Input uses',
  signatureLength: 'an ed25519 signature is 64 bytes and the one sent is not',
  derived: (component: string) =>
    `this service cannot build the covered component "${component}"; cover @method, @target-uri and header fields only`,
  headerMissing: (name: string) =>
    `the signature covers the header "${name}" but the request does not carry it; send that header with the request`,
  mismatch: 'the signature does not match this request; sign the exact method and URL you send, scheme included',
  spent: 'this signature was already used; sign each request once',
  // The spend store and any thrown check are our side of the wire: neither
  // may read as a fault in the signature, and neither may read as "already used".
  unchecked: 'the signature could not be checked just now; sign a fresh request and try again',
  thrown: 'the signature could not be checked just now because of an error on our side; sign a fresh request and try again',
} as const;

// The service's whole signing profile for a caller, as one short paragraph built
// from the constants verify() enforces, so GET /capabilities cannot drift from them.
export function describeSigningProfile(): string {
  return (
    'A request that proves who sent it carries an RFC 9421 HTTP Message Signature. ' +
    `Send Signature-Input and Signature headers that cover ${joinAnd(REQUEST_SIGNATURE_COMPONENTS)}, ` +
    'with alg "ed25519", a keyid of <your DID>#<key id>, and created set to the Unix time in seconds when you signed, ' +
    `no more than ${SIGNATURE_MAX_AGE_SECONDS} seconds ago. ` +
    'content-digest is sha-256=:<base64 of the SHA-256 of the exact body you send>:. ' +
    'Each signature is accepted once, so sign every request again.'
  );
}

// The checks, written once. verify() below is the thin call that keeps the
// original three-value contract.
export async function verifyWithReason(
  req: SignedRequestLike,
  keyResolver: SigningKeyResolver,
  options?: VerifyOptions,
): Promise<VerifyOutcome> {
  try {
    const rawSigInput = lookupHeader(req.headers, 'signature-input');
    const rawSig = lookupHeader(req.headers, 'signature');
    const sigInputValue = Array.isArray(rawSigInput) ? rawSigInput[0] : rawSigInput;
    const sigValue = Array.isArray(rawSig) ? rawSig[0] : rawSig;
    if (!sigInputValue || !sigValue) return invalid(REASONS.headers);

    const inputMatch = sigInputValue.trim().match(/^([A-Za-z0-9_-]+)=\((.*?)\)(.*)$/);
    if (!inputMatch) return invalid(REASONS.unreadableInput());
    const label = inputMatch[1] ?? '';
    const inner = inputMatch[2] ?? '';
    const rawParams = inputMatch[3] ?? '';
    const paramsText = `(${inner})${rawParams}`;

    const components = [...inner.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');
    if (components.length === 0) return invalid(REASONS.unreadableInput());

    const required = options?.requiredComponents ?? REQUIRED_COVERED_COMPONENTS;
    const missing = required.filter((component) => !components.includes(component));
    if (missing.length > 0) return invalid(REASONS.notCovered(required, missing));

    const keyidMatch = rawParams.match(/;keyid="([^"]*)"/);
    const keyid = keyidMatch?.[1] ?? '';
    if (!keyidMatch || !keyid.includes('#')) return invalid(REASONS.keyid);

    const algMatch = rawParams.match(/;alg="([^"]*)"/);
    if (algMatch && algMatch[1] !== 'ed25519') return invalid(REASONS.alg);

    const createdMatch = rawParams.match(/;created=(\d+)/);
    if (!createdMatch) return invalid(REASONS.noCreated);
    const created = Number(createdMatch[1] ?? '');
    const now = options?.now ?? new Date();
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const age = nowSeconds - created;
    // S6: one-sided on purpose. A signature older than SIGNATURE_MAX_AGE_SECONDS
    // is refused (age too large and positive); a signature claiming to be from
    // the future is refused past a much smaller, separately named skew
    // tolerance (age negative and its magnitude too large). Math.abs used to
    // fold both directions into one comparison, which accepted a future-dated
    // signature exactly as readily as a stale one and doubled the real replay
    // window (the anchor: "the real replay window is ten minutes").
    // SW1-08: each side of the window answers its own sentence, so a caller
    // whose clock runs ahead is not told its signature is old.
    if (age > SIGNATURE_MAX_AGE_SECONDS) return invalid(REASONS.stale);
    if (age < -SIGNATURE_CLOCK_SKEW_TOLERANCE_SECONDS) return invalid(REASONS.future);

    const did = keyid.slice(0, keyid.indexOf('#'));
    if (!did) return invalid(REASONS.keyid);

    const sigMatch = sigValue.match(new RegExp(`(?:^|,)\\s*${label}=:([A-Za-z0-9+/=]+):`));
    if (!sigMatch) return invalid(REASONS.signatureHeader);
    const sig = Buffer.from(sigMatch[1] ?? '', 'base64');
    if (sig.length !== 64) return invalid(REASONS.signatureLength);

    const lines: string[] = [];
    for (const component of components) {
      if (component === '@method') {
        lines.push(`"@method": ${req.method.toUpperCase()}`);
      } else if (component === '@target-uri') {
        lines.push(`"@target-uri": ${req.targetUri}`);
      } else if (component.startsWith('@')) {
        return invalid(REASONS.derived(component));
      } else {
        const headerName = component.toLowerCase();
        const value = lookupHeader(req.headers, headerName);
        if (value === undefined) return invalid(REASONS.headerMissing(headerName));
        const valueStr = (Array.isArray(value) ? value.join(', ') : value).trim();
        lines.push(`"${headerName}": ${valueStr}`);
      }
    }
    lines.push(`"@signature-params": ${paramsText}`);
    const base = lines.join('\n');

    // B29: the key resolver answering null is "this service does not know
    // this DID/keyid", not "the bytes are wrong" -- the bytes are never
    // even checked yet. Reported distinctly from every check below, which
    // all concern a key the resolver DID recognise.
    const resolved = await keyResolver(did, keyid);
    if (resolved === null) return { kind: 'unknown-key' };

    const key = createPublicKey(resolved.publicKeyPem);
    if (!nodeVerify(null, Buffer.from(base, 'utf8'), key, sig)) return invalid(REASONS.mismatch);

    // S5 (this card): the spend check runs AFTER the ed25519 bytes verify,
    // never before -- the same rule onVerified already follows (D4/D5
    // above), and for the same reason: an attacker presenting a victim's
    // keyid under a forged signature must not be able to burn a signature
    // the victim has not yet spent, and must not be able to cause a
    // durable write for a signature that never actually verified.
    if (options?.spendStorage) {
      const signatureHash = createHash('sha256').update(sig).digest('hex');
      try {
        const spent = await options.spendStorage.findByKeyidAndHash(keyid, signatureHash);
        if (spent !== null) return invalid(REASONS.spent);
        await options.spendStorage.record({ keyid, signatureHash, created });
      } catch (err) {
        // Fail closed. Unlike onVerified's own swallowed failure (bookkeeping
        // after an already-decided verdict), the spend check IS the control:
        // a replay check that cannot reach its store must refuse the request,
        // not silently behave as if no replay protection existed at all.
        // SW1-08: the store being down is our fault, never "already used".
        console.error('http-signature: spend-store check failed for a signature that otherwise verified', err);
        return invalid(REASONS.unchecked);
      }
    }

    // The signature has now genuinely verified, so
    // recording the observation is safe to attempt -- but a failure here
    // is a storage-layer fact, not a verdict on this signature. Swallow
    // it rather than let it flip an already-decided "yes" back to a failure.
    try {
      await resolved.onVerified?.();
    } catch (err) {
      // Durable bookkeeping failed; the signature still verified. The
      // failure is logged: a fault nobody
      // records is a fault nobody fixes, and this one silently loses the
      // observed-key record that the outage-window liveness read relies on.
      console.error('http-signature: onVerified durable write failed after a verified signature', err);
    }

    return { kind: 'verified', did };
  } catch {
    return invalid(REASONS.thrown);
  }
}

// The original three-value contract, kept for every caller and test that does
// not need the reason. It runs no check of its own: it reads the answer of
// verifyWithReason above.
export async function verify(
  req: SignedRequestLike,
  keyResolver: SigningKeyResolver,
  options?: VerifyOptions,
): Promise<VerifyResult> {
  const outcome = await verifyWithReason(req, keyResolver, options);
  if (outcome.kind === 'verified') return { did: outcome.did };
  return outcome.kind === 'unknown-key' ? 'unknown-key' : 'invalid';
}
