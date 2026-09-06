// In-memory DidConnectSessionStorage: the selected mode when
// FREEAGENTS_ABT_PLATFORM_SK et al are configured but no durable session
// store is wired (dev/test), mirroring src/adapters/storage/memory.ts's own
// stance. A Map keyed by token, exactly like MemStorage in the working
// reference (qr-server.mjs).
import type { DidConnectSessionRow, DidConnectSessionStorage } from './session-storage-types.js';

export function createMemoryDidConnectStorage(): DidConnectSessionStorage {
  const rows = new Map<string, DidConnectSessionRow>();

  return {
    async create(token: string, status = 'created'): Promise<DidConnectSessionRow> {
      const row: DidConnectSessionRow = { token, status };
      rows.set(token, row);
      return row;
    },

    async read(token: string): Promise<DidConnectSessionRow | null> {
      return rows.get(token) ?? null;
    },

    async update(token: string, updates: Record<string, unknown>): Promise<DidConnectSessionRow> {
      const existing = rows.get(token) ?? { token, status: 'created' };
      const updated: DidConnectSessionRow = { ...existing, ...updates, token };
      rows.set(token, updated);
      return updated;
    },

    async delete(token: string): Promise<void> {
      rows.delete(token);
    },

    async exist(token: string, did?: string): Promise<boolean> {
      const row = rows.get(token);
      if (row === undefined) return false;
      if (did === undefined) return true;
      return row.did === did;
    },

    // No-op, matching the working reference's MemStorage: nothing in this
    // rail's flow depends on these events firing.
    on(): void {},
    emit(): void {},
  };
}
