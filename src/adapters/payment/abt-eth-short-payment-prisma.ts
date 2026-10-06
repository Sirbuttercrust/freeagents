// Prisma-backed AbtEthShortPaymentStorage over the AbtEthShortPayment table,
// with the same lazily created client as this rail's other drivers
// (abt-eth-storage-prisma.ts): nothing connects until the first call.
import { PrismaClient } from '../../generated/prisma/index.js';
import { normalizeTxHash } from './erc20.js';
import type { AbtEthShortPayment, AbtEthShortPaymentStorage } from './abt-eth-short-payment-types.js';
import type { RouteLeg } from './route-support.js';

let client: PrismaClient | null = null;
function db(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}

interface AbtEthShortPaymentRow {
  readonly priceTxHash: string;
  readonly jobId: string;
  readonly leg: string;
  readonly lockId: string;
  readonly feeTxHash: string | null;
  readonly amountToken: string;
  readonly amountUsd: string;
  readonly usdPerTokenAtRead: string | null;
  readonly worthUsd: string | null;
  readonly recordedAt: Date | null;
  readonly readAt: Date;
}

function shortPaymentOf(row: AbtEthShortPaymentRow): AbtEthShortPayment {
  return {
    priceTxHash: row.priceTxHash,
    jobId: row.jobId,
    leg: row.leg as RouteLeg,
    lockId: row.lockId,
    feeTxHash: row.feeTxHash,
    amountToken: row.amountToken,
    amountUsd: row.amountUsd,
    usdPerTokenAtRead: row.usdPerTokenAtRead,
    worthUsd: row.worthUsd,
    recordedAt: row.recordedAt,
    readAt: row.readAt,
  };
}

export function createPrismaAbtEthShortPaymentStorage(): AbtEthShortPaymentStorage {
  return {
    async record(row: AbtEthShortPayment): Promise<void> {
      const priceTxHash = normalizeTxHash(row.priceTxHash);
      const data = {
        jobId: row.jobId,
        leg: row.leg,
        lockId: row.lockId,
        feeTxHash: row.feeTxHash,
        amountToken: row.amountToken,
        amountUsd: row.amountUsd,
        usdPerTokenAtRead: row.usdPerTokenAtRead,
        worthUsd: row.worthUsd,
        recordedAt: row.recordedAt,
        readAt: row.readAt,
      };
      await db().abtEthShortPayment.upsert({
        where: { priceTxHash },
        create: { priceTxHash, ...data },
        update: data,
      });
    },

    async findByHash(hash: string): Promise<AbtEthShortPayment | null> {
      const row = await db().abtEthShortPayment.findUnique({ where: { priceTxHash: normalizeTxHash(hash) } });
      return row === null ? null : shortPaymentOf(row);
    },

    async findByJobAndLeg(jobId: string, leg: RouteLeg): Promise<readonly AbtEthShortPayment[]> {
      const rows = await db().abtEthShortPayment.findMany({
        where: { jobId, leg },
        orderBy: [{ readAt: 'asc' }, { priceTxHash: 'asc' }],
      });
      return rows.map(shortPaymentOf);
    },
  };
}
