// Prisma-backed SignatureSpendStorage (S5), on the existing storage
// pattern: the client is created on first use, matching
// usdc-half-paid-storage-prisma.ts's own lazy-client stance so the app can
// boot and be imported in tests without a database.
import { PrismaClient } from '../../generated/prisma/index.js';
import type { SignatureSpendRow, SignatureSpendStorage } from './signature-spend-storage-types.js';

let client: PrismaClient | null = null;
function db(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}

export function createPrismaSignatureSpendStorage(): SignatureSpendStorage {
  return {
    async findByKeyidAndHash(keyid: string, signatureHash: string): Promise<SignatureSpendRow | null> {
      const row = await db().signatureSpend.findUnique({
        where: { keyid_signatureHash: { keyid, signatureHash } },
      });
      if (row === null) return null;
      return { keyid: row.keyid, signatureHash: row.signatureHash, created: row.created };
    },

    async record(row: SignatureSpendRow): Promise<void> {
      await db().signatureSpend.create({
        data: { keyid: row.keyid, signatureHash: row.signatureHash, created: row.created },
      });
    },
  };
}
