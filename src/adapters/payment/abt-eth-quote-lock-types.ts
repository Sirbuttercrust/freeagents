// The ABT-on-Ethereum price a checkout quoted and showed, kept so the
// payment that follows is checked against it. Storage interface and row
// shape only, mirroring usdc-half-paid-storage-types.ts's split of
// interface from driver.
import type { RouteLeg } from './route-support.js';

// A quoted price, not a record of any payment. `leg` is the route-level
// spelling ('remainder', never the rail's internal 'balance'), as the
// ArcBlock rail's lock stores it.
export interface AbtEthQuoteLock {
  readonly id: string;
  readonly jobId: string;
  readonly leg: RouteLeg;
  // The agreed USD amount for this leg when the lock was made.
  readonly amountUsd: string;
  readonly usdPerToken: string;
  // The rate feed's own update time; null when the feed gave none.
  readonly rateUpdatedAt: Date | null;
  readonly amountToken: string;
  readonly feeToken: string;
  readonly lockedAt: Date;
  readonly expiresAt: Date;
}

export type NewAbtEthQuoteLock = Omit<AbtEthQuoteLock, 'id'>;

export interface AbtEthQuoteLockStorage {
  // Every call writes a new row with its own id, even for a job and leg
  // that already have one: two checkouts each keep the price they showed.
  create(lock: NewAbtEthQuoteLock): Promise<AbtEthQuoteLock>;
  read(id: string): Promise<AbtEthQuoteLock | null>;
}
