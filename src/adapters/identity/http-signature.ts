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
// B29 (bug ledger, C1 rehearsal s2): a well-formed request whose signature
// bytes genuinely verify but names a DID keyResolver has never heard of
// (unregistered, or the fingerprint-to-DID binding check fails) is a
// DIFFERENT fact from a signature that does not verify at all -- the caller
// held a real key and produced a real signature, this service simply does
// not know that key. Collapsing both into one "invalid signature" message
// told a caller with a perfectly good signature that their cryptography was
// wrong, when the real defect was that nothing had registered yet. 'unknown-
// key' names the resolver-returned-null case; every other failure (a
// malformed request, a stale timestamp, a wrong algorithm, bytes that do
// not verify against a resolved key) stays 'invalid', unchanged.
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
    // D4/D5 (task t_8a82c865): recording an observation is deferred to
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

// B29: the full result shape. A structured failure carries WHICH refusal
// this was, so a route layer that wants to answer "unknown key" instead of
// "invalid signature" can, without re-deriving the distinction itself.
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

export async function verify(
  req: SignedRequestLike,
  keyResolver: SigningKeyResolver,
  options?: VerifyOptions,
): Promise<VerifyResult> {
  try {
    const rawSigInput = lookupHeader(req.headers, 'signature-input');
    const rawSig = lookupHeader(req.headers, 'signature');
    const sigInputValue = Array.isArray(rawSigInput) ? rawSigInput[0] : rawSigInput;
    const sigValue = Array.isArray(rawSig) ? rawSig[0] : rawSig;
    if (!sigInputValue || !sigValue) return 'invalid';

    const inputMatch = sigInputValue.trim().match(/^([A-Za-z0-9_-]+)=\((.*?)\)(.*)$/);
    if (!inputMatch) return 'invalid';
    const label = inputMatch[1] ?? '';
    const inner = inputMatch[2] ?? '';
    const rawParams = inputMatch[3] ?? '';
    const paramsText = `(${inner})${rawParams}`;

    const components = [...inner.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');
    if (components.length === 0) return 'invalid';

    const required = options?.requiredComponents ?? REQUIRED_COVERED_COMPONENTS;
    if (!required.every((component) => components.includes(component))) return 'invalid';

    const keyidMatch = rawParams.match(/;keyid="([^"]*)"/);
    const keyid = keyidMatch?.[1] ?? '';
    if (!keyidMatch || !keyid.includes('#')) return 'invalid';

    const algMatch = rawParams.match(/;alg="([^"]*)"/);
    if (algMatch && algMatch[1] !== 'ed25519') return 'invalid';

    const createdMatch = rawParams.match(/;created=(\d+)/);
    if (!createdMatch) return 'invalid';
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
    if (age > SIGNATURE_MAX_AGE_SECONDS) return 'invalid';
    if (age < -SIGNATURE_CLOCK_SKEW_TOLERANCE_SECONDS) return 'invalid';

    const did = keyid.slice(0, keyid.indexOf('#'));
    if (!did) return 'invalid';

    const sigMatch = sigValue.match(new RegExp(`(?:^|,)\\s*${label}=:([A-Za-z0-9+/=]+):`));
    if (!sigMatch) return 'invalid';
    const sig = Buffer.from(sigMatch[1] ?? '', 'base64');
    if (sig.length !== 64) return 'invalid';

    const lines: string[] = [];
    for (const component of components) {
      if (component === '@method') {
        lines.push(`"@method": ${req.method.toUpperCase()}`);
      } else if (component === '@target-uri') {
        lines.push(`"@target-uri": ${req.targetUri}`);
      } else if (component.startsWith('@')) {
        return 'invalid';
      } else {
        const headerName = component.toLowerCase();
        const value = lookupHeader(req.headers, headerName);
        if (value === undefined) return 'invalid';
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
    if (resolved === null) return 'unknown-key';

    const key = createPublicKey(resolved.publicKeyPem);
    if (!nodeVerify(null, Buffer.from(base, 'utf8'), key, sig)) return 'invalid';

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
        if (spent !== null) return 'invalid';
        await options.spendStorage.record({ keyid, signatureHash, created });
      } catch (err) {
        // Fail closed. Unlike onVerified's own swallowed failure (bookkeeping
        // after an already-decided verdict), the spend check IS the control:
        // a replay check that cannot reach its store must refuse the request,
        // not silently behave as if no replay protection existed at all.
        console.error('http-signature: spend-store check failed for a signature that otherwise verified', err);
        return 'invalid';
      }
    }

    // D4 (task t_8a82c865): the signature has now genuinely verified, so
    // recording the observation is safe to attempt -- but a failure here
    // is a storage-layer fact, not a verdict on this signature. Swallow
    // it rather than let it flip an already-decided "yes" back to a failure.
    try {
      await resolved.onVerified?.();
    } catch (err) {
      // Durable bookkeeping failed; the signature still verified. The
      // failure is logged (Review residue, t_84d1a099): a fault nobody
      // records is a fault nobody fixes, and this one silently loses the
      // observed-key record that the outage-window liveness read relies on.
      console.error('http-signature: onVerified durable write failed after a verified signature', err);
    }

    return { did };
  } catch {
    return 'invalid';
  }
}
