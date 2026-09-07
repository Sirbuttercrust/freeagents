// S2: Prisma-backed AbtSpentTransferStorage, mirroring
// usdc-spent-transfer-storage-prisma.ts's own lazy-client pattern: the
// client is created on first use, so the app can boot and be imported in
// tests without a database.
import { PrismaClient } from '../../generated/prisma/index.js';
import type { AbtSpentTransferRow, AbtSpentTransferStorage } from './abt-spent-transfer-storage-types.js';

let client: PrismaClient | null = null;
function db(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}

export function createPrismaAbtSpentTransferStorage(): AbtSpentTransferStorage {
  return {
    async record(row: AbtSpentTransferRow): Promise<void> {
      const data = { jobId: row.jobId, leg: row.leg };
      await db().abtSpentTransfer.upsert({
        where: { hash: row.hash },
        create: { hash: row.hash, ...data },
        update: data,
      });
    },

    async findByHash(hash: string): Promise<AbtSpentTransferRow | null> {
      const row = await db().abtSpentTransfer.findUnique({ where: { hash } });
      if (row === null) return null;
      return { hash: row.hash, jobId: row.jobId, leg: row.leg as 'deposit' | 'balance' };
    },
  };
}
