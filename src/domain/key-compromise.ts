// R-16 (ENT-8, spec/wireframe/keys.html): reporting a key compromised marks
// work signed inside the window as disputed. Disputed is derived at read
// time by comparing a credential's own timestamps against reported windows
// -- never stored on the credential, never a verdict, never a deletion
// (keys.html:152-163, 170-180). This file is pure and total, the pattern
// evidenceTier sets in src/domain/evidence.ts: no I/O, no throws, so a
// stored report can be re-checked at any call site without a try/catch.
import { didSuffix } from './agent.js';

export interface CompromiseWindow {
  readonly key: string; // DID fragment form: did:abt:<suffix>#<fragment>
  readonly from: Date; // "Exposed from" (keys.html:132)
  readonly to: Date; // "Until"        (keys.html:137)
  readonly reportedAt: Date; // when the report was filed; the driver stamps it
}

export interface DisputableCredentialFacts {
  readonly signedBy: string | null; // credentialSubject.hire.signedBy
  readonly signedAt: Date | null; // credentialSubject.hire.mergedAt
  readonly issuedAt: Date | null; // the credential's validFrom
}

// The structural half of "this report is well formed" (R-16), mirroring
// rotationWellFormed's stance (key-rotation.ts:21). Any value in, one
// boolean out, never throws. from > to is NOT checked here -- like
// fromKey === toKey in rotationWellFormed, it is a semantic error the route
// rejects, not a shape error (app.ts's comment on that finding applies here
// too). reportedAt is not checked -- the driver stamps it, exactly as
// KeyRotationInput omits rotatedAt.
export function compromiseWindowWellFormed(report: CompromiseWindow): boolean {
  if (typeof report !== 'object' || report === null) return false;
  const { key, from, to } = report as { key?: unknown; from?: unknown; to?: unknown };
  if (typeof key !== 'string' || key.length === 0 || !key.includes('#')) {
    return false;
  }
  return isWellFormedDate(from) && isWellFormedDate(to);
}

function isWellFormedDate(value: unknown): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value === 'string') return !Number.isNaN(Date.parse(value));
  return false;
}

// Splits on the first '#' and compares fragments exactly, DID halves
// through didSuffix reconciliation (agent.ts:35-37) -- wallet tooling emits
// z... where the registry records did:abt:z.... A string with no '#' on
// either side matches nothing.
function sameKey(a: string, b: string): boolean {
  const aHash = a.indexOf('#');
  const bHash = b.indexOf('#');
  if (aHash === -1 || bHash === -1) return false;
  const aDid = a.slice(0, aHash);
  const aFragment = a.slice(aHash);
  const bDid = b.slice(0, bHash);
  const bFragment = b.slice(bHash);
  return aFragment === bFragment && didSuffix(aDid) === didSuffix(bDid);
}

function inWindow(t: Date, window: CompromiseWindow): boolean {
  return window.from.getTime() <= t.getTime() && t.getTime() <= window.to.getTime();
}

// The read-time derivation ("the window is visible"). Returns the subset of
// windows that dispute this credential, in input order -- returning the
// windows rather than a boolean is deliberate, since it is what makes the
// window visible at every call site, not just a flag.
//
// A window disputes when both hold: (1) facts.signedBy names the same key as
// window.key, and (2) a timestamp falls inside the window, inclusive, for
// EITHER facts.signedAt OR facts.issuedAt. This OR is the one judgement call
// in this file. The spec's backend note compares issuedAt (keys.html:170-180),
// while the accept line says "work signed inside the window", and the work
// is signed at mergedAt by the agent key the report names -- the credential
// itself is signed later by the platform issuer key
// (src/adapters/credentials/credentials.ts:100-126), a different key
// entirely. Disputing on either satisfies both readings, and over-inclusion
// is the safe direction: disputed is a visible annotation, never a deletion
// or a verdict, so a false positive costs a reader one look while a false
// negative silently trusts work signed by a stolen key -- the exact thing
// spec/work-history-extension-v1.md:264-266 forbids. Recorded in
// ASSUMPTIONS as disputed_timestamp_basis.
export function disputingWindows(
  facts: DisputableCredentialFacts,
  windows: readonly CompromiseWindow[],
): readonly CompromiseWindow[] {
  if (typeof facts.signedBy !== 'string' || facts.signedBy.length === 0) return [];
  const signedBy = facts.signedBy;
  return windows.filter((window) => {
    if (!sameKey(signedBy, window.key)) return false;
    if (facts.signedAt !== null && inWindow(facts.signedAt, window)) return true;
    if (facts.issuedAt !== null && inWindow(facts.issuedAt, window)) return true;
    return false;
  });
}

export function credentialDisputed(
  facts: DisputableCredentialFacts,
  windows: readonly CompromiseWindow[],
): boolean {
  return disputingWindows(facts, windows).length > 0;
}
