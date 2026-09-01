// R-37 (spec/roadmap.md, ENT-2, ENT-4): freshness as a visible fact about
// the record, never a judgement of the agent (the card's anchor). Both
// dates are derived at read time from stored facts, mirroring
// agent-work-record.ts's own stance: never a stored denormalised column
// that could drift from what it summarises.

// The minimal shape a hire needs to carry a completion date. Structural,
// matching CompletedJob's own field name (src/domain/job.ts, ENT-7.1's
// observed outcome fact) so a caller can pass jobRepo.findCompletedByAgent's
// rows directly, with no field renaming at the call site.
export interface HireCompletionFact {
  readonly completedAt: Date | string;
}

// The minimal shape a rotation needs to carry a change date. Structural,
// mirroring HireCompletionFact, so this module stays free of a dependency
// on key-rotation.ts's own type.
export interface RotationFact {
  readonly rotatedAt: Date | string;
}

// The minimal shape an agent needs for recordLastChangedAt: when it was
// created, plus its rotation history. Structural for the same reason as
// the two facts above.
export interface RecordFacts {
  readonly createdAt: Date | string;
  readonly keyRotations: readonly RotationFact[];
}

// Milliseconds since epoch for a Date or a parseable string, null
// otherwise. Mirrors buyer-diversity.ts's parseInstant: unparseable input
// is skipped, never thrown.
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

// The most recent completed hire's completion date, or null when there is
// none (R-37 item 1). Read only from the hires the caller supplies: this
// module does not decide which hires count, the caller
// (jobRepo.findCompletedByAgent, the same source R-33's /hires route
// already reads) does. Total: an unparseable completedAt is skipped, not
// thrown, matching the same stance buyer-diversity.ts takes on bad input.
export function lastHireCompletedAt(hires: readonly HireCompletionFact[]): string | null {
  let latestMs: number | null = null;
  for (const hire of hires) {
    const ms = parseInstant(hire?.completedAt);
    if (ms === null) continue;
    if (latestMs === null || ms > latestMs) latestMs = ms;
  }
  return latestMs === null ? null : new Date(latestMs).toISOString();
}

// When anything in this agent's record last changed (R-37 item 2): the
// latest of createdAt, every completed hire's completedAt, and every key
// rotation's rotatedAt. Never null (a record's creation is itself a
// change), and never earlier than createdAt: a hire or rotation dated
// before the agent was created is not evidence the record changed then,
// only bad input the caller should not have supplied, and this function
// stays total rather than trusting it.
export function recordLastChangedAt(agent: RecordFacts, hires: readonly HireCompletionFact[]): string {
  const createdMs = parseInstant(agent.createdAt) ?? 0;
  let latestMs = createdMs;

  for (const hire of hires) {
    const ms = parseInstant(hire?.completedAt);
    if (ms !== null && ms > latestMs) latestMs = ms;
  }
  for (const rotation of agent.keyRotations) {
    const ms = parseInstant(rotation?.rotatedAt);
    if (ms !== null && ms > latestMs) latestMs = ms;
  }

  return new Date(latestMs).toISOString();
}
