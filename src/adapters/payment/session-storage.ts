// Factory that picks the DID Connect session storage driver from the
// environment, mirroring src/adapters/storage/storage.ts's own stance:
// Prisma when DATABASE_URL is configured, in-memory otherwise (with the
// same restart-does-not-survive warning).
import { createMemoryDidConnectStorage } from './session-storage-memory.js';
import { createPrismaDidConnectStorage } from './session-storage-prisma.js';
import type { DidConnectSessionStorage } from './session-storage-types.js';

export function createDidConnectSessionStorage(): DidConnectSessionStorage {
  if (process.env.DATABASE_URL) {
    return createPrismaDidConnectStorage();
  }
  console.warn(
    'payment: DATABASE_URL is not set; using in-memory DID Connect session storage. ' +
      'Sessions do not survive a restart. This is a dev/test mode, not production storage.',
  );
  return createMemoryDidConnectStorage();
}
