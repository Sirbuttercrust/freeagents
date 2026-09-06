// Prisma-backed DidConnectSessionStorage (this card's scope item 5), on the
// existing storage pattern: the client is created on first use (storage.ts's
// stance, and credentials.ts's platformIssuerFromEnv follows it too), so the
// app can boot and be imported in tests without a database.
//
// Every other bookkeeping field the library writes (challenge, sharedKey,
// currentStep, did, pk, extraParams, ...) lives in the `data` Json column,
// merged onto `{ token, status }` on read so a caller sees one flat object
// exactly like the memory implementation returns, never a nested `data` key
// leaking the storage detail.
import { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import type { DidConnectSessionRow, DidConnectSessionStorage } from './session-storage-types.js';

let client: PrismaClient | null = null;
function db(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}

interface StoredRow {
  readonly token: string;
  readonly status: string;
  readonly data: unknown;
}

function toRow(row: StoredRow): DidConnectSessionRow {
  const data = typeof row.data === 'object' && row.data !== null ? (row.data as Record<string, unknown>) : {};
  return { ...data, token: row.token, status: row.status };
}

export function createPrismaDidConnectStorage(): DidConnectSessionStorage {
  return {
    async create(token: string, status = 'created'): Promise<DidConnectSessionRow> {
      const row = (await db().didConnectSession.create({
        data: { token, status, data: {} },
      })) as StoredRow;
      return toRow(row);
    },

    async read(token: string): Promise<DidConnectSessionRow | null> {
      const row = (await db().didConnectSession.findUnique({ where: { token } })) as StoredRow | null;
      return row === null ? null : toRow(row);
    },

    // Upsert, not update: the wallet-facing library may call update() on a
    // token this process never called create() for in an edge case (a
    // restart mid-flow), and the memory implementation already treats that
    // as "create it now" rather than throwing (see session-storage-memory.ts).
    async update(token: string, updates: Record<string, unknown>): Promise<DidConnectSessionRow> {
      const { status: statusUpdate, ...dataUpdates } = updates;
      const status = typeof statusUpdate === 'string' ? statusUpdate : undefined;
      const existing = (await db().didConnectSession.findUnique({ where: { token } })) as StoredRow | null;
      const existingData =
        existing !== null && typeof existing.data === 'object' && existing.data !== null
          ? (existing.data as Record<string, unknown>)
          : {};
      const mergedData = { ...existingData, ...dataUpdates };
      const row = (await db().didConnectSession.upsert({
        where: { token },
        create: { token, status: status ?? 'created', data: mergedData as unknown as Prisma.InputJsonValue },
        update: { ...(status === undefined ? {} : { status }), data: mergedData as unknown as Prisma.InputJsonValue },
      })) as StoredRow;
      return toRow(row);
    },

    async delete(token: string): Promise<void> {
      // deleteMany, not delete: an unknown token must be a no-op (the memory
      // implementation's own stance), and Prisma's delete() throws P2025 on
      // a missing row where deleteMany() simply reports zero affected.
      await db().didConnectSession.deleteMany({ where: { token } });
    },

    async exist(token: string, did?: string): Promise<boolean> {
      const row = (await db().didConnectSession.findUnique({ where: { token } })) as StoredRow | null;
      if (row === null) return false;
      if (did === undefined) return true;
      const data = typeof row.data === 'object' && row.data !== null ? (row.data as Record<string, unknown>) : {};
      return data.did === did;
    },

    on(): void {},
    emit(): void {},
  };
}
