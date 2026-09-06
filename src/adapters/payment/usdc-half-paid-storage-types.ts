// P3: the durable half-paid settlement record (scope item 3). Storage
// interface only, mirroring session-storage-types.ts's own split of
// interface from driver so tests can substitute a memory implementation
// without touching this shape.
export type UsdcTransferStatus = 'confirmed' | 'not_confirmed' | 'not_signed';

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
}
