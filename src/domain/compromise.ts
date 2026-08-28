// R-16 (ENT-8.4): reporting a key compromised does not amend a signed
// credential (ENT-8.3 forbids a judgement inside the signature envelope). It
// creates a side record, the same shape KeyRotation takes beside Agent, and
// "disputed" is derived at read time by checking whether the key that signed
// a credential was reported compromised during a window that covers the
// signing instant.
import { didSuffix } from './agent.js';

export interface CompromiseReport {
  readonly key: string; // DID fragment form, did:abt:<suffix>#<fragment>
  readonly since: Date; // window opens
  readonly reportedAt: Date; // window closes, stamped by the driver
}

// The structural half of "this report is well formed" (R-16). Total: any
// value in, one boolean out, never throws, the same totality
// rotationWellFormed and delegationConsistent hold to. Unlike
// rotationWellFormed (which defers fromKey === toKey to the route), an
// inverted window is rejected here rather than at the route: every
// downstream containment check (windowContains) would otherwise just
// silently return false, which hides the shape error instead of surfacing it.
export function reportWellFormed(report: CompromiseReport): boolean {
  if (typeof report !== 'object' || report === null) return false;
  const { key, since, reportedAt } = report as {
    key?: unknown;
    since?: unknown;
    reportedAt?: unknown;
  };
  if (typeof key !== 'string' || key.length === 0 || !key.includes('#')) {
    return false;
  }
  const sinceMs = parseInstant(since);
  if (sinceMs === null) return false;
  const reportedAtMs = parseInstant(reportedAt);
  if (reportedAtMs === null) return false;
  if (sinceMs > reportedAtMs) return false;
  return true;
}

// Wallet tooling emits the short form (z...) while the registry records the
// full DID (did:abt:z...). Both name the same key, so every key comparison
// in this file goes through this reconciliation; a false negative here means
// compromised work silently fails to be marked disputed. Total.
export function sameKey(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aHash = a.indexOf('#');
  const bHash = b.indexOf('#');
  if (aHash === -1 || bHash === -1) return false;
  const aDid = a.slice(0, aHash);
  const aFragment = a.slice(aHash + 1);
  const bDid = b.slice(0, bHash);
  const bFragment = b.slice(bHash + 1);
  return didSuffix(aDid) === didSuffix(bDid) && aFragment === bFragment;
}

// True when signedAt falls inside the report's window, closed at both ends.
// False on any unparseable input, and false when the report is not well
// formed: a malformed window contains nothing. Total.
export function windowContains(report: CompromiseReport, signedAt: Date): boolean {
  // reportWellFormed already establishes that report.since and
  // report.reportedAt parse (it runs the same parseInstant over the same
  // fields), so re-checking them here for null would be dead code.
  if (!reportWellFormed(report)) return false;
  const signedAtMs = parseInstant(signedAt);
  if (signedAtMs === null) return false;
  const sinceMs = parseInstant(report.since) as number;
  const reportedAtMs = parseInstant(report.reportedAt) as number;
  return sinceMs <= signedAtMs && signedAtMs <= reportedAtMs;
}

// Every report that disputes work signed by signedBy at signedAt: the key
// matches (through sameKey's short/long form reconciliation) and the
// instant falls inside the report's window. [] on any malformed input,
// never throws, so a route can call this with no try/catch.
export function disputedBy(
  reports: readonly CompromiseReport[],
  signedBy: string,
  signedAt: Date,
): readonly CompromiseReport[] {
  if (!Array.isArray(reports)) return [];
  if (typeof signedBy !== 'string') return [];
  const signedAtMs = parseInstant(signedAt);
  if (signedAtMs === null) return [];
  return reports.filter(
    (report) => sameKey(report.key, signedBy) && windowContains(report, signedAt),
  );
}

// Milliseconds since epoch for a Date or a parseable string, null otherwise.
// The single parsing rule every function above shares.
function parseInstant(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}
