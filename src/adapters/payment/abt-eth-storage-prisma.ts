// Prisma-backed spent-hash and half-paid records for the ABT-on-Ethereum
// rail: the same shapes and lazy-client stance as the USDC rail's two
// drivers, over this rail's own tables (AbtEthSpentTransfer,
// AbtEthHalfPaidSettlement). A hash is only unique within one chain, so this
// rail does not share the USDC rail's tables. The spent-hash row type is the
// USDC one, since the columns are identical; the half-paid row adds the lock
// id (abt-eth.ts).
import { PrismaClient } from '../../generated/prisma/index.js';
import type { AbtEthHalfPaidRow, AbtEthHalfPaidStorage } from './abt-eth.js';
import type { UsdcHalfPaidRow } from './usdc-half-paid-storage-types.js';
import type { UsdcSpentTransferRow, UsdcSpentTransferStorage } from './usdc-spent-transfer-storage-types.js';

let client: PrismaClient | null = null;
function db(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}

export function createPrismaAbtEthHalfPaidStorage(): AbtEthHalfPaidStorage {
  return {
    async record(row: AbtEthHalfPaidRow): Promise<void> {
      const data = {
        priceTxHash: row.priceTxHash,
        priceStatus: row.priceStatus,
        feeTxHash: row.feeTxHash,
        feeStatus: row.feeStatus,
        lockId: row.lockId ?? null,
      };
      await db().abtEthHalfPaidSettlement.upsert({
        where: { jobId_leg: { jobId: row.jobId, leg: row.leg } },
        create: { jobId: row.jobId, leg: row.leg, ...data },
        update: data,
      });
    },

    async read(jobId: string, leg: 'deposit' | 'balance'): Promise<AbtEthHalfPaidRow | null> {
      const row = await db().abtEthHalfPaidSettlement.findUnique({ where: { jobId_leg: { jobId, leg } } });
      if (row === null) return null;
      return {
        jobId: row.jobId,
        leg: row.leg as 'deposit' | 'balance',
        priceTxHash: row.priceTxHash,
        priceStatus: row.priceStatus as UsdcHalfPaidRow['priceStatus'],
        feeTxHash: row.feeTxHash,
        feeStatus: row.feeStatus as UsdcHalfPaidRow['feeStatus'],
        lockId: row.lockId,
      };
    },

    async clear(jobId: string, leg: 'deposit' | 'balance'): Promise<void> {
      // deleteMany, not delete: delete throws when the row does not exist,
      // and most confirm() calls are on legs that were never half-paid.
      await db().abtEthHalfPaidSettlement.deleteMany({ where: { jobId, leg } });
    },
  };
}

export function createPrismaAbtEthSpentTransferStorage(): UsdcSpentTransferStorage {
  return {
    async record(row: UsdcSpentTransferRow): Promise<void> {
      const data = { jobId: row.jobId, leg: row.leg, role: row.role };
      await db().abtEthSpentTransfer.upsert({
        where: { hash: row.hash },
        create: { hash: row.hash, ...data },
        update: data,
      });
    },

    async findByHash(hash: string): Promise<UsdcSpentTransferRow | null> {
      const row = await db().abtEthSpentTransfer.findUnique({ where: { hash } });
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
