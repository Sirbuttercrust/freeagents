import type { Job } from './job.js';

// ENT-9: v1 records intent and nothing else, so a Settlement is a sibling
// record keyed by job id (mirroring CompletedJob), not a field on Job. The
// fee attaches to a completed hire (ENT-9.3): moving money is irreversible,
// and the verification product has to be right before the payment product
// exists (MISSION.md).

export type SettlementState = 'recorded_intent';

export interface Settlement {
  readonly jobId: string;
  // Decimal money as a string, never a number: a JS number cannot hold a
  // decimal amount exactly, and this column is the reserved space a later
  // release fills. Null in v1, always (ENT-9.1).
  readonly amount: string | null;
  readonly currency: string | null;
  readonly platformFee: string | null;
  readonly state: SettlementState;
}

export class SettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementError';
  }
}

// The only constructor of a Settlement, and it takes no money argument, so
// no caller can supply one (ENT-9.1). Gated on completion because the fee
// attaches to a completed hire and to nothing else (ENT-9.3).
export function recordSettlementIntent(job: Job): Settlement {
  if (job.status !== 'completed') {
    throw new SettlementError(
      `cannot record a settlement intent for a job in status "${job.status}"`,
    );
  }
  return {
    jobId: job.id,
    amount: null,
    currency: null,
    platformFee: null,
    state: 'recorded_intent',
  };
}
