// The record of a short ABT-on-Ethereum payment, kept so the owner can answer
// it later. Storage interface and row shape only, in the layout of
// abt-eth-quote-lock-types.ts.
import type { RouteLeg } from './route-support.js';

// A price transfer the network recorded after its price hold that was worth
// less than the agreed price when the platform read it, or could not be
// priced at all (judgeAbtEthLateTransfer, abt-eth-late.ts). `leg` is the
// route-level spelling, as the quote lock stores it.
export interface AbtEthShortPayment {
  // The price transfer's hash, lower-case: the key. A second report of the
  // same transfer is the same row.
  readonly priceTxHash: string;
  readonly jobId: string;
  readonly leg: RouteLeg;
  // The quote lock this transfer was judged against.
  readonly lockId: string;
  // null when the wallet never signed the fee transfer.
  readonly feeTxHash: string | null;
  // The locked token amount that was judged, and the dollars it was agreed at.
  readonly amountToken: string;
  readonly amountUsd: string;
  // The price read when it was judged and what the amount was worth at it;
  // both null when no price could be read.
  readonly usdPerTokenAtRead: string | null;
  readonly worthUsd: string | null;
  // When the network recorded the price transfer; null when the chain gave
  // no block time.
  readonly recordedAt: Date | null;
  readonly readAt: Date;
}

export interface AbtEthShortPaymentStorage {
  // Upserts by the normalised hash: the same transfer reported twice is one
  // row, holding the later read. A different transfer for the same job and
  // leg is another row.
  record(row: AbtEthShortPayment): Promise<void>;
  findByHash(hash: string): Promise<AbtEthShortPayment | null>;
  // Every short transfer of one leg, oldest read first.
  findByJobAndLeg(jobId: string, leg: RouteLeg): Promise<readonly AbtEthShortPayment[]>;
}
