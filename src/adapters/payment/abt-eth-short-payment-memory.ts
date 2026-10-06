// In-memory AbtEthShortPaymentStorage: the dev and test mode when no
// database is configured. It stores and answers copies, so a caller that
// changes the object it passed in, or one it got back, never changes what
// the next read answers.
import { normalizeTxHash } from './erc20.js';
import type { AbtEthShortPayment, AbtEthShortPaymentStorage } from './abt-eth-short-payment-types.js';
import type { RouteLeg } from './route-support.js';

function copyOf(row: AbtEthShortPayment): AbtEthShortPayment {
  return {
    ...row,
    priceTxHash: normalizeTxHash(row.priceTxHash),
    recordedAt: row.recordedAt === null ? null : new Date(row.recordedAt.getTime()),
    readAt: new Date(row.readAt.getTime()),
  };
}

export function createMemoryAbtEthShortPaymentStorage(): AbtEthShortPaymentStorage {
  const rows = new Map<string, AbtEthShortPayment>();

  return {
    async record(row: AbtEthShortPayment): Promise<void> {
      const stored = copyOf(row);
      rows.set(stored.priceTxHash, stored);
    },

    async findByHash(hash: string): Promise<AbtEthShortPayment | null> {
      const stored = rows.get(normalizeTxHash(hash));
      return stored === undefined ? null : copyOf(stored);
    },

    async findByJobAndLeg(jobId: string, leg: RouteLeg): Promise<readonly AbtEthShortPayment[]> {
      return [...rows.values()]
        .filter((row) => row.jobId === jobId && row.leg === leg)
        .sort(
          (a, b) =>
            a.readAt.getTime() - b.readAt.getTime() || (a.priceTxHash < b.priceTxHash ? -1 : a.priceTxHash > b.priceTxHash ? 1 : 0),
        )
        .map(copyOf);
    },
  };
}
