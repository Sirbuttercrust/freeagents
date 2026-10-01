// In-memory AbtEthQuoteLockStorage: the dev and test mode when no database
// is configured. It stores and answers copies, so a caller that changes the
// object it passed in, or the one it got back, never changes what the next
// read answers.
import { randomUUID } from 'node:crypto';
import type { AbtEthQuoteLock, AbtEthQuoteLockStorage, NewAbtEthQuoteLock } from './abt-eth-quote-lock-types.js';

function copyOf(lock: AbtEthQuoteLock): AbtEthQuoteLock {
  return {
    ...lock,
    rateUpdatedAt: lock.rateUpdatedAt === null ? null : new Date(lock.rateUpdatedAt.getTime()),
    lockedAt: new Date(lock.lockedAt.getTime()),
    expiresAt: new Date(lock.expiresAt.getTime()),
  };
}

export function createMemoryAbtEthQuoteLockStorage(): AbtEthQuoteLockStorage {
  const rows = new Map<string, AbtEthQuoteLock>();

  return {
    async create(lock: NewAbtEthQuoteLock): Promise<AbtEthQuoteLock> {
      const stored = copyOf({ ...lock, id: randomUUID() });
      rows.set(stored.id, stored);
      return copyOf(stored);
    },

    async read(id: string): Promise<AbtEthQuoteLock | null> {
      const stored = rows.get(id);
      return stored === undefined ? null : copyOf(stored);
    },
  };
}
