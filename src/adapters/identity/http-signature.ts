// HTTP Message Signature (RFC 9421) verification for DID-authenticated
// requests. R-34, seeded by hand 2026-08-23 (Phase-0 rule: auth is on the
// irreversible list, so a human writes this stub and its failing test; the
// factory implements verify() against @arcblock/did).
//
// Contract:
//   verify(req, keyResolver, options) -> { did } | null
//   - reads Signature-Input / Signature headers (RFC 9421 field names)
//   - covers @method, @target-uri, content-digest when present
//   - resolves the signing key through keyResolver(did, keyid) and verifies
//     the ed25519 signature WITHOUT calling any vendor package from src/api/
//
// verify() is total: every failure path returns null, never throws. This
// mirrors verifyDelegation (src/adapters/identity/identity.ts) so callers
// never need a try/catch to tell "not signed" from "signed wrong".
import { createPublicKey, verify as nodeVerify } from 'node:crypto';

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
}

export const SIGNATURE_MAX_AGE_SECONDS = 300;
export const REQUIRED_COVERED_COMPONENTS: readonly string[] = ['@method', '@target-uri'];

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
): Promise<{ did: string } | null> {
  try {
    const rawSigInput = lookupHeader(req.headers, 'signature-input');
    const rawSig = lookupHeader(req.headers, 'signature');
    const sigInputValue = Array.isArray(rawSigInput) ? rawSigInput[0] : rawSigInput;
    const sigValue = Array.isArray(rawSig) ? rawSig[0] : rawSig;
    if (!sigInputValue || !sigValue) return null;

    const inputMatch = sigInputValue.trim().match(/^([A-Za-z0-9_-]+)=\((.*?)\)(.*)$/);
    if (!inputMatch) return null;
    const label = inputMatch[1] ?? '';
    const inner = inputMatch[2] ?? '';
    const rawParams = inputMatch[3] ?? '';
    const paramsText = `(${inner})${rawParams}`;

    const components = [...inner.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');
    if (components.length === 0) return null;

    const required = options?.requiredComponents ?? REQUIRED_COVERED_COMPONENTS;
    if (!required.every((component) => components.includes(component))) return null;

    const keyidMatch = rawParams.match(/;keyid="([^"]*)"/);
    const keyid = keyidMatch?.[1] ?? '';
    if (!keyidMatch || !keyid.includes('#')) return null;

    const algMatch = rawParams.match(/;alg="([^"]*)"/);
    if (algMatch && algMatch[1] !== 'ed25519') return null;

    const createdMatch = rawParams.match(/;created=(\d+)/);
    if (!createdMatch) return null;
    const created = Number(createdMatch[1] ?? '');
    const now = options?.now ?? new Date();
    if (Math.abs(Math.floor(now.getTime() / 1000) - created) > SIGNATURE_MAX_AGE_SECONDS) return null;

    const did = keyid.slice(0, keyid.indexOf('#'));
    if (!did) return null;

    const sigMatch = sigValue.match(new RegExp(`(?:^|,)\\s*${label}=:([A-Za-z0-9+/=]+):`));
    if (!sigMatch) return null;
    const sig = Buffer.from(sigMatch[1] ?? '', 'base64');
    if (sig.length !== 64) return null;

    const lines: string[] = [];
    for (const component of components) {
      if (component === '@method') {
        lines.push(`"@method": ${req.method.toUpperCase()}`);
      } else if (component === '@target-uri') {
        lines.push(`"@target-uri": ${req.targetUri}`);
      } else if (component.startsWith('@')) {
        return null;
      } else {
        const headerName = component.toLowerCase();
        const value = lookupHeader(req.headers, headerName);
        if (value === undefined) return null;
        const valueStr = (Array.isArray(value) ? value.join(', ') : value).trim();
        lines.push(`"${headerName}": ${valueStr}`);
      }
    }
    lines.push(`"@signature-params": ${paramsText}`);
    const base = lines.join('\n');

    const resolved = await keyResolver(did, keyid);
    if (resolved === null) return null;

    const key = createPublicKey(resolved.publicKeyPem);
    if (!nodeVerify(null, Buffer.from(base, 'utf8'), key, sig)) return null;

    // D4 (task t_8a82c865): the signature has now genuinely verified, so
    // recording the observation is safe to attempt -- but a failure here
    // is a storage-layer fact, not a verdict on this signature. Swallow
    // it rather than let it flip an already-decided "yes" back to null.
    try {
      await resolved.onVerified?.();
    } catch (err) {
      // Durable bookkeeping failed; the signature still verified. The
      // failure is logged (Proof residue, t_84d1a099): a fault nobody
      // records is a fault nobody fixes, and this one silently loses the
      // observed-key record that the outage-window liveness read relies on.
      console.error('http-signature: onVerified durable write failed after a verified signature', err);
    }

    return { did };
  } catch {
    return null;
  }
}
