// The decision for a payment the wallet sent before the platform heard of it
// (abt-eth-quote-lock.ts says why the lock check leaves expiry out). The
// network recorded the price transfer at some time; the price was held until
// the lock's expiresAt. Three answers:
//
//   held    recorded before expiresAt. It counts at the held price however
//           late the report arrives: the time that matters is the block's,
//           never the time the platform was told.
//   covers  recorded at or after expiresAt, and the locked token amount is
//           still worth at least the agreed dollars at a price read now.
//   short   recorded at or after expiresAt and worth less, or no price can
//           be read now. The owner decides what happens to a short payment.
//
// The amount judged is the lock's amountToken, which is what the buyer was
// asked to sign and what the rail's confirmation matched on chain. Nothing a
// request carries is read.
import { coversAgreedUsd, tokenAmountWorthUsd } from '../../domain/payment.js';
import { abtEthQuoteLockExpired } from './abt-eth-quote-lock.js';
import type { AbtEthQuoteLock } from './abt-eth-quote-lock-types.js';
import { RateUnavailableError } from './types.js';

export type AbtEthLateJudgement =
  | { readonly kind: 'held' }
  | { readonly kind: 'covers'; readonly usdPerToken: string }
  | { readonly kind: 'short'; readonly usdPerToken: string | null; readonly worthUsd: string | null };

// The rail's own quote fits this: it reads the price feed and throws
// RateUnavailableError when there is no reading.
export type AbtEthPriceReader = (input: { readonly priceUsd: string }) => Promise<{ readonly usdPerToken: string }>;

export async function judgeAbtEthLateTransfer(input: {
  readonly lock: AbtEthQuoteLock;
  // The rail's priceRecordedAt: ISO, or null.
  readonly priceRecordedAt: string | null;
  readonly readPrice: AbtEthPriceReader;
}): Promise<AbtEthLateJudgement> {
  const { lock, readPrice } = input;
  const recordedAt = input.priceRecordedAt === null ? null : new Date(input.priceRecordedAt);
  // A confirmed transfer whose time is unknown (no block time from the
  // chain, or a value that is not a date) cannot be placed before or after
  // the hold. It is judged as recorded after it: calling it held would
  // count it at a price nobody can show the transfer was inside, while
  // judging it by the price now can only ask the owner to look at it.
  const placed = recordedAt !== null && !Number.isNaN(recordedAt.getTime());
  if (placed && !abtEthQuoteLockExpired(lock, recordedAt)) {
    return { kind: 'held' };
  }

  let usdPerToken: string;
  try {
    usdPerToken = (await readPrice({ priceUsd: lock.amountUsd })).usdPerToken;
  } catch (error) {
    if (error instanceof RateUnavailableError) {
      return { kind: 'short', usdPerToken: null, worthUsd: null };
    }
    throw error;
  }
  if (coversAgreedUsd(lock.amountToken, usdPerToken, lock.amountUsd)) {
    return { kind: 'covers', usdPerToken };
  }
  return { kind: 'short', usdPerToken, worthUsd: tokenAmountWorthUsd(lock.amountToken, usdPerToken) };
}
