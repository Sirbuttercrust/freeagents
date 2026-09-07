// S2: durable record of every ABT transaction hash that has already
// backed a settlement leg, mirroring usdc-spent-transfer-storage-types.ts
// (S1) exactly: a single transaction can never confirm a second job, a
// second leg, or the same leg a second time. ABT has no separate price
// and fee transaction (one TransferV3Tx carries both outputs), so this
// port has no role field: the hash alone identifies the whole settlement.
export interface AbtSpentTransferRow {
  readonly hash: string;
  readonly jobId: string;
  readonly leg: 'deposit' | 'balance';
}

export interface AbtSpentTransferStorage {
  // Idempotent by hash: confirm() re-observes the chain and re-records on
  // every call (the rail's own idempotency requirement), so recording the
  // SAME (hash, jobId, leg) a second time overwrites the row with
  // identical data rather than throwing. Recording a hash already spent
  // under a DIFFERENT (jobId, leg) never happens: confirm() checks
  // findByHash first and refuses before record() is ever reached for
  // that hash again.
  record(row: AbtSpentTransferRow): Promise<void>;
  // Null when this hash has never backed a settlement leg.
  findByHash(hash: string): Promise<AbtSpentTransferRow | null>;
}
