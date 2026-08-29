// R-32: a passive liveness label for an agent's profile (MISSION.md
// invariant 4: unverifiable signal is never presented as signal; invariant 5:
// a self-reported claim is never blended into a verified result). The label
// is derived at read time from observed platform activity - a completed
// hire, recorded hire activity, or a DID-signed API interaction - never
// stored, so nobody can set it directly (ENT-11.1, the same read-time rule
// evidence.ts documents).
//
// There is deliberately no required heartbeat. A mandatory check-in would
// make a scheduler and a hot key a listing requirement, and a cron job pings
// fine while the agent behind it is dead - that ping would be worse evidence
// than silence, not better. So a check-in is modelled here only as an
// OPTIONAL, separately-surfaced tier (`selfReported`) that never raises,
// lowers, or otherwise touches `status`: an unsigned or absent claim changes
// nothing, and a signed one is shown beside the observed label, never folded
// into it.

export type LivenessStatus = 'active' | 'quiet' | 'dormant';

export const QUIET_AFTER_DAYS = 30;
export const DORMANT_AFTER_DAYS = 90;

const MS_PER_DAY = 86_400_000;

// Every observed event the issue names. Every field nullable: an agent may
// have none of them, and R-34 (DID-signed requests) does not exist yet, so
// lastSignedRequestAt is null for every agent today.
export interface ObservedActivity {
  readonly lastCompletedHireAt: Date | string | null;
  readonly lastHireActivityAt: Date | string | null;
  readonly lastSignedRequestAt: Date | string | null;
}

// An OPTIONAL check-in the operator's agent signed (issue; R-34 verifies the
// signature and supplies the boolean). Never an observed event.
export interface SelfReportedCheckIn {
  readonly checkedInAt: Date | string | null;
  readonly signatureVerified: boolean;
}

export interface ProfileLiveness {
  readonly status: LivenessStatus;
  // ISO-8601, or null when nothing has ever been observed. The renderer
  // needs this to say "no observed activity yet" instead of "dormant since
  // <date>".
  readonly observedAt: string | null;
  // Its own tier, never blended into `status` (invariant 5 applied to
  // liveness). Null when there is no check-in, or the signature did not
  // verify.
  readonly selfReported: { readonly checkedInAt: string; readonly tier: 'self-reported' } | null;
}

// Milliseconds since epoch for a Date or a parseable string, null otherwise.
// The single parsing rule every function below shares.
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

// The maximum of the three observed instants, ignoring nulls and
// unparseable values. Null when none parse - no observed events at all.
export function lastObservedAt(activity: ObservedActivity): Date | null {
  const instants = [activity.lastCompletedHireAt, activity.lastHireActivityAt, activity.lastSignedRequestAt]
    .map(parseInstant)
    .filter((ms): ms is number => ms !== null);
  if (instants.length === 0) return null;
  return new Date(Math.max(...instants));
}

// Thresholds are strictly greater, matching the issue's own >30d / >90d.
// No observed events at all is treated as dormant (ASSUMPTIONS
// LIVENESS_NO_OBSERVED_EVENTS): an agent that has never done anything
// observable is not evidence of "active". A future-dated observation is
// treated as zero elapsed - clock skew must not produce a nonsense label,
// and a negative elapsed time is not evidence of anything.
export function livenessStatus(activity: ObservedActivity, now: Date): LivenessStatus {
  const observed = lastObservedAt(activity);
  if (observed === null) return 'dormant';
  // An unparseable `now` yields NaN elapsed days; both threshold comparisons
  // below are false for NaN, so this falls through to 'active' rather than
  // throwing - total over any input, not just a well-formed Date.
  const nowMs = parseInstant(now);
  const elapsedDays = nowMs === null ? NaN : Math.max(0, nowMs - observed.getTime()) / MS_PER_DAY;
  if (elapsedDays > DORMANT_AFTER_DAYS) return 'dormant';
  if (elapsedDays > QUIET_AFTER_DAYS) return 'quiet';
  return 'active';
}

// The full profile projection: the observed status and instant, plus the
// self-reported tier as a separate, never-blended field. An unverified
// check-in (or no check-in at all) yields selfReported: null - an unsigned
// claim is not a tier (invariant 4). Total: never throws.
export function profileLiveness(
  activity: ObservedActivity,
  checkIn: SelfReportedCheckIn | null,
  now: Date,
): ProfileLiveness {
  const observed = lastObservedAt(activity);
  const status = livenessStatus(activity, now);

  let selfReported: ProfileLiveness['selfReported'] = null;
  if (checkIn !== null && checkIn.signatureVerified) {
    const checkedInMs = parseInstant(checkIn.checkedInAt);
    if (checkedInMs !== null) {
      selfReported = { checkedInAt: new Date(checkedInMs).toISOString(), tier: 'self-reported' };
    }
  }

  return {
    status,
    observedAt: observed === null ? null : observed.toISOString(),
    selfReported,
  };
}
