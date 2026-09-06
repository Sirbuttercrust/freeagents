// S1: durable record of every hash that has already backed a USDC
// settlement leg, so one confirmed transfer can never be presented a
// second time to confirm a different job, a different leg, or the other
// role (the anchor's Case C: "one receipt confirms unlimited jobs").
// Storage interface only, mirroring usdc-half-paid-storage-types.ts's own
// split of interface from driver so tests inject a memory implementation
// without touching this shape.
export type UsdcTransferRole = 'price' | 'fee';

export interface UsdcSpentTransferRow {
  readonly hash: string;
  readonly jobId: string;
  readonly leg: 'deposit' | 'balance';
  readonly role: UsdcTransferRole;
}

export interface UsdcSpentTransferStorage {
  // Idempotent by hash: confirm() re-observes the chain and re-records on
  // every call (the rail's own idempotency requirement), so recording the
  // SAME (hash, jobId, leg, role) a second time overwrites the row with
  // identical data rather than throwing. Recording a hash already spent
  // under a DIFFERENT (jobId, leg, role) never happens: legStatus checks
  // findByHash first and refuses before record() is ever reached for
  // that hash again.
  record(row: UsdcSpentTransferRow): Promise<void>;
  // Null when this hash has never backed a settlement leg.
  findByHash(hash: string): Promise<UsdcSpentTransferRow | null>;
}
