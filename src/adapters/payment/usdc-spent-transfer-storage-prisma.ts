// S1: Prisma-backed UsdcSpentTransferStorage, mirroring
// usdc-half-paid-storage-prisma.ts's own lazy-client pattern: the client is
// created on first use, so the app can boot and be imported in tests
// without a database.
import { PrismaClient } from '../../generated/prisma/index.js';
import type { UsdcSpentTransferRow, UsdcSpentTransferStorage } from './usdc-spent-transfer-storage-types.js';

let client: PrismaClient | null = null;
function db(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}

export function createPrismaUsdcSpentTransferStorage(): UsdcSpentTransferStorage {
  return {
    async record(row: UsdcSpentTransferRow): Promise<void> {
      const data = { jobId: row.jobId, leg: row.leg, role: row.role };
      await db().usdcSpentTransfer.upsert({
        where: { hash: row.hash },
        create: { hash: row.hash, ...data },
        update: data,
      });
    },

    async findByHash(hash: string): Promise<UsdcSpentTransferRow | null> {
      const row = await db().usdcSpentTransfer.findUnique({ where: { hash } });
      if (row === null) return null;
      return {
        hash: row.hash,
        jobId: row.jobId,
        leg: row.leg as 'deposit' | 'balance',
        role: row.role as UsdcSpentTransferRow['role'],
      };
    },
  };
}
