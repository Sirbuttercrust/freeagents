// The locked ABT-on-Ethereum price, kept per checkout. The rail itself
// never stores a lock and never re-quotes (abt-eth.ts); this is where a
// start writes the amounts it quoted and where the later steps read them
// back and check them against the job, the leg and the agreed price.
//
// Storage layout follows the half-paid storage: types, a Prisma driver, a
// memory driver, and this file for the factory and the three operations.
import { createMemoryAbtEthQuoteLockStorage } from './abt-eth-quote-lock-memory.js';
import { createPrismaAbtEthQuoteLockStorage } from './abt-eth-quote-lock-prisma.js';
import type { AbtEthQuoteLock, AbtEthQuoteLockStorage } from './abt-eth-quote-lock-types.js';
import type { AbtEthQuote } from './abt-eth.js';
import { ABT_QUOTE_LOCK_LIFETIME_MS, NO_LOCK_MESSAGE, PRICE_CHANGED_MESSAGE } from './quote-lock.js';
import type { RouteLeg } from './route-support.js';

export type { AbtEthQuoteLock, AbtEthQuoteLockStorage, NewAbtEthQuoteLock } from './abt-eth-quote-lock-types.js';

// Prisma when DATABASE_URL is configured, in-memory otherwise, with the
// same restart-does-not-survive warning as session-storage.ts.
export function createAbtEthQuoteLockStorage(): AbtEthQuoteLockStorage {
  if (process.env.DATABASE_URL) {
    return createPrismaAbtEthQuoteLockStorage();
  }
  console.warn(
    'payment: DATABASE_URL is not set; using in-memory ABT-on-Ethereum quote lock storage. ' +
      'Locks do not survive a restart. This is a dev/test mode, not production storage.',
  );
  return createMemoryAbtEthQuoteLockStorage();
}

// Writes a new row for this start, from the rail's own quote, and answers
// it with its id. Two starts of the same leg are two rows.
export async function lockAbtEthQuote(
  storage: AbtEthQuoteLockStorage,
  input: {
    readonly jobId: string;
    readonly leg: RouteLeg;
    readonly amountUsd: string;
    readonly quote: AbtEthQuote;
    readonly now: Date;
  },
): Promise<AbtEthQuoteLock> {
  return storage.create({
    jobId: input.jobId,
    leg: input.leg,
    amountUsd: input.amountUsd,
    usdPerToken: input.quote.usdPerToken,
    rateUpdatedAt: input.quote.rateUpdatedAt,
    amountToken: input.quote.amountToken,
    feeToken: input.quote.feeToken,
    lockedAt: input.now,
    expiresAt: new Date(input.now.getTime() + ABT_QUOTE_LOCK_LIFETIME_MS),
  });
}

export type AbtEthQuoteLockCheck =
  | { readonly ok: true; readonly lock: AbtEthQuoteLock }
  | { readonly ok: false; readonly message: string };

// The ArcBlock rail's check, in its order, without the expiry step (see
// abtEthQuoteLockExpired): an unknown id, or a lock that names another job
// or another leg, is "no lock"; then no agreed price; then an agreed price
// that is not the one the lock was computed from.
export async function checkAbtEthQuoteLock(
  storage: AbtEthQuoteLockStorage,
  input: {
    readonly lockId: string;
    readonly jobId: string;
    readonly leg: RouteLeg;
    readonly amountUsd: string | null;
  },
): Promise<AbtEthQuoteLockCheck> {
  const lock = await storage.read(input.lockId);
  if (lock === null || lock.jobId !== input.jobId || lock.leg !== input.leg) {
    return { ok: false, message: NO_LOCK_MESSAGE };
  }
  if (input.amountUsd === null) {
    return { ok: false, message: 'this job has no agreed price to pay against' };
  }
  if (input.amountUsd !== lock.amountUsd) {
    return { ok: false, message: PRICE_CHANGED_MESSAGE };
  }
  return { ok: true, lock };
}

// True from expiresAt on. This is a predicate and not a step of the check
// above on purpose. On the ArcBlock rail the platform sees the signed
// transaction before it is broadcast, so refusing an expired lock moves no
// money. Here the buyer's wallet broadcasts the transfers itself and the
// platform hears of them afterwards, so a lock that expired before the
// report arrived says nothing about the transfer: what counts is when the
// network recorded it. judgeAbtEthLateTransfer (abt-eth-late.ts) asks this
// predicate with the transfer's block time, never with the time of the
// report.
export function abtEthQuoteLockExpired(lock: AbtEthQuoteLock, now: Date): boolean {
  return !(now.getTime() < lock.expiresAt.getTime());
}
