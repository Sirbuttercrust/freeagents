// In-memory SignatureSpendStorage: the selected mode when DATABASE_URL is
// not configured (dev/test), mirroring session-storage-memory.ts's own
// stance. A Map keyed by "keyid#signatureHash", exactly the compound key
// the interface's own header comment names.
import type { SignatureSpendRow, SignatureSpendStorage } from './signature-spend-storage-types.js';

function compoundKey(keyid: string, signatureHash: string): string {
  return `${keyid}#${signatureHash}`;
}

export function createMemorySignatureSpendStorage(): SignatureSpendStorage {
  const rows = new Map<string, SignatureSpendRow>();
  return {
    async findByKeyidAndHash(keyid: string, signatureHash: string): Promise<SignatureSpendRow | null> {
      return rows.get(compoundKey(keyid, signatureHash)) ?? null;
    },
    async record(row: SignatureSpendRow): Promise<void> {
      rows.set(compoundKey(row.keyid, row.signatureHash), row);
    },
  };
}
