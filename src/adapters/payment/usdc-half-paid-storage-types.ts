// P3: the durable half-paid settlement record (scope item 3). Storage
// interface only, mirroring session-storage-types.ts's own split of
// interface from driver so tests can substitute a memory implementation
// without touching this shape.
// S1: 'mismatched' names a transfer that landed on chain but did not pay
// what this leg expected (wrong recipient, amount, token, or chain), a
// different fact from 'not_confirmed' (nothing has landed yet).
export type UsdcTransferStatus = 'confirmed' | 'not_confirmed' | 'not_signed' | 'mismatched';

export interface UsdcHalfPaidRow {
  readonly jobId: string;
  readonly leg: 'deposit' | 'balance';
  readonly priceTxHash: string;
  readonly priceStatus: UsdcTransferStatus;
  readonly feeTxHash: string | null;
  readonly feeStatus: UsdcTransferStatus;
}

export interface UsdcHalfPaidStorage {
  // Idempotent by (jobId, leg): a repeat confirm() on the same ref
  // overwrites the prior record rather than accumulating a second one, so
  // confirm() stays idempotent as the interface requires.
  record(row: UsdcHalfPaidRow): Promise<void>;
  read(jobId: string, leg: 'deposit' | 'balance'): Promise<UsdcHalfPaidRow | null>;
  // Removes a settlement's half-paid row once confirm() observes it is no
  // longer half-paid (both legs confirmed, review round 1, D2): a
  // late-landing second signature is the ordinary case on a two-transaction
  // rail, and a stale half-paid row left behind would tell P4's state
  // machine a settlement is half-paid after it has actually completed. A
  // clear() on a row that does not exist is a no-op, not an error, since
  // most confirm() calls are on settlements that were never half-paid.
  clear(jobId: string, leg: 'deposit' | 'balance'): Promise<void>;
}
