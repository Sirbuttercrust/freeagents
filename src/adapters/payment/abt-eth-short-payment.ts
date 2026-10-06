// The short payments of the ABT-on-Ethereum rail: a price transfer the
// network recorded after its price hold that was worth less than the agreed
// price when the platform read it (abt-eth-late.ts). One row per transfer.
// Nothing reads this yet besides its tests.
//
// Storage layout follows the quote lock's: types, a Prisma driver, a memory
// driver, and this file for the factory.
import { createMemoryAbtEthShortPaymentStorage } from './abt-eth-short-payment-memory.js';
import { createPrismaAbtEthShortPaymentStorage } from './abt-eth-short-payment-prisma.js';
import type { AbtEthShortPaymentStorage } from './abt-eth-short-payment-types.js';

export type { AbtEthShortPayment, AbtEthShortPaymentStorage } from './abt-eth-short-payment-types.js';

// Prisma when DATABASE_URL is configured, in-memory otherwise, with the
// same restart-does-not-survive warning as the quote lock's factory.
export function createAbtEthShortPaymentStorage(): AbtEthShortPaymentStorage {
  if (process.env.DATABASE_URL) {
    return createPrismaAbtEthShortPaymentStorage();
  }
  console.warn(
    'payment: DATABASE_URL is not set; using in-memory ABT-on-Ethereum short payment storage. ' +
      'Short payments do not survive a restart. This is a dev/test mode, not production storage.',
  );
  return createMemoryAbtEthShortPaymentStorage();
}
