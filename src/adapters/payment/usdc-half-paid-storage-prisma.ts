// Prisma-backed UsdcHalfPaidStorage (P3, scope item 3), on the existing
// storage pattern: the client is created on first use, matching
// session-storage-prisma.ts and storage.ts's own stance so the app can boot
// and be imported in tests without a database.
import { PrismaClient } from '../../generated/prisma/index.js';
import type { UsdcHalfPaidRow, UsdcHalfPaidStorage } from './usdc-half-paid-storage-types.js';

let client: PrismaClient | null = null;
function db(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}

export function createPrismaUsdcHalfPaidStorage(): UsdcHalfPaidStorage {
  return {
    async record(row: UsdcHalfPaidRow): Promise<void> {
      const data = {
        priceTxHash: row.priceTxHash,
        priceStatus: row.priceStatus,
        feeTxHash: row.feeTxHash,
        feeStatus: row.feeStatus,
      };
      await db().usdcHalfPaidSettlement.upsert({
        where: { jobId_leg: { jobId: row.jobId, leg: row.leg } },
        create: { jobId: row.jobId, leg: row.leg, ...data },
        update: data,
      });
    },

    async read(jobId: string, leg: 'deposit' | 'balance'): Promise<UsdcHalfPaidRow | null> {
      const row = await db().usdcHalfPaidSettlement.findUnique({ where: { jobId_leg: { jobId, leg } } });
      if (row === null) return null;
      return {
        jobId: row.jobId,
        leg: row.leg as 'deposit' | 'balance',
        priceTxHash: row.priceTxHash,
        priceStatus: row.priceStatus as UsdcHalfPaidRow['priceStatus'],
        feeTxHash: row.feeTxHash,
        feeStatus: row.feeStatus as UsdcHalfPaidRow['feeStatus'],
      };
    },
  };
}
