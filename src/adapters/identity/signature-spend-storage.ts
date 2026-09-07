// Factory that picks the signature-spend storage driver from the
// environment, mirroring src/adapters/payment/session-storage.ts's own
// stance: Prisma when DATABASE_URL is configured, in-memory otherwise (with
// the same restart-does-not-survive warning every other storage capability
// in this codebase prints).
import { createMemorySignatureSpendStorage } from './signature-spend-storage-memory.js';
import { createPrismaSignatureSpendStorage } from './signature-spend-storage-prisma.js';
import type { SignatureSpendStorage } from './signature-spend-storage-types.js';

export function createSignatureSpendStorage(): SignatureSpendStorage {
  if (process.env.DATABASE_URL) {
    return createPrismaSignatureSpendStorage();
  }
  console.warn(
    'identity: DATABASE_URL is not set; using in-memory signature-spend storage. ' +
      'Data does not survive a restart. This is a dev/test mode, not production storage.',
  );
  return createMemorySignatureSpendStorage();
}
