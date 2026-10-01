// Prisma-backed AbtEthQuoteLockStorage over the AbtEthQuoteLock table, with
// the same lazily created client as this rail's other drivers
// (abt-eth-storage-prisma.ts): nothing connects until the first call.
import { PrismaClient } from '../../generated/prisma/index.js';
import type { AbtEthQuoteLock, AbtEthQuoteLockStorage, NewAbtEthQuoteLock } from './abt-eth-quote-lock-types.js';
import type { RouteLeg } from './route-support.js';

let client: PrismaClient | null = null;
function db(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}

interface AbtEthQuoteLockRow {
  readonly id: string;
  readonly jobId: string;
  readonly leg: string;
  readonly amountUsd: string;
  readonly usdPerToken: string;
  readonly rateUpdatedAt: Date | null;
  readonly amountToken: string;
  readonly feeToken: string;
  readonly lockedAt: Date;
  readonly expiresAt: Date;
}

function lockOf(row: AbtEthQuoteLockRow): AbtEthQuoteLock {
  return {
    id: row.id,
    jobId: row.jobId,
    leg: row.leg as RouteLeg,
    amountUsd: row.amountUsd,
    usdPerToken: row.usdPerToken,
    rateUpdatedAt: row.rateUpdatedAt,
    amountToken: row.amountToken,
    feeToken: row.feeToken,
    lockedAt: row.lockedAt,
    expiresAt: row.expiresAt,
  };
}

export function createPrismaAbtEthQuoteLockStorage(): AbtEthQuoteLockStorage {
  return {
    async create(lock: NewAbtEthQuoteLock): Promise<AbtEthQuoteLock> {
      const row = await db().abtEthQuoteLock.create({
        data: {
          jobId: lock.jobId,
          leg: lock.leg,
          amountUsd: lock.amountUsd,
          usdPerToken: lock.usdPerToken,
          rateUpdatedAt: lock.rateUpdatedAt,
          amountToken: lock.amountToken,
          feeToken: lock.feeToken,
          lockedAt: lock.lockedAt,
          expiresAt: lock.expiresAt,
        },
      });
      return lockOf(row);
    },

    async read(id: string): Promise<AbtEthQuoteLock | null> {
      const row = await db().abtEthQuoteLock.findUnique({ where: { id } });
      return row === null ? null : lockOf(row);
    },
  };
}
