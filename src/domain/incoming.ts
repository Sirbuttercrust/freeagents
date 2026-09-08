// P8p: which side an offer is waiting on, read from the job's criteria
// alone. The operator's own words on the shape of this platform: "I
// thought we were just a intermediary between the two parties" (the
// operator, 2026-09-07). This function reports a fact off the record; it
// never scores, ranks, or judges either party.
//
// Pure: no imports outside ./job.js, so a test can exercise it with
// nothing but a plain array of criteria.
import type { Criterion } from './job.js';

export type WaitingOn = 'noReply' | 'waitingOnBuyer' | 'waitingOnOperator';

// Total and mutually exclusive over every criteria array (brief scope
// item 1): no criteria at all is noReply; every line signed by the agent
// is waitingOnBuyer; any line the agent has not signed is
// waitingOnOperator. Reads acceptedByAgent only, never proposedBy: a
// line the operator has not signed is waiting on the operator whoever
// wrote it (ENT-6.2), so a buyer's own unsigned edit is never read as
// waiting on the buyer.
export function waitingOnOf(criteria: readonly Criterion[]): WaitingOn {
  if (criteria.length === 0) return 'noReply';
  const allAcceptedByAgent = criteria.every((criterion) => criterion.acceptedByAgent);
  return allAcceptedByAgent ? 'waitingOnBuyer' : 'waitingOnOperator';
}
