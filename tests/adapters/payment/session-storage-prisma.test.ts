// Prisma-backed DidConnectSessionStorage (this card's scope item 5). Driven
// against a stubbed generated Prisma client, the same seam
// tests/adapters/prisma.test.ts uses for every other Prisma-backed
// repository: no test in this file opens a real database.
import { describe, expect, it, vi, afterEach, beforeAll } from 'vitest';

const mock = vi.hoisted(() => ({
  create: vi.fn(),
  findUnique: vi.fn(),
  upsert: vi.fn(),
  delete: vi.fn(),
  deleteMany: vi.fn(),
}));

vi.mock('../../../src/generated/prisma/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/generated/prisma/index.js')>(
    '../../../src/generated/prisma/index.js',
  );
  return {
    PrismaClient: class {
      didConnectSession = {
        create: mock.create,
        findUnique: mock.findUnique,
        upsert: mock.upsert,
        delete: mock.delete,
        deleteMany: mock.deleteMany,
      };
    },
    Prisma: actual.Prisma,
  };
});

const { createPrismaDidConnectStorage } = await import('../../../src/adapters/payment/session-storage-prisma.js');

function resetAll(): void {
  vi.mocked(mock.create).mockReset();
  vi.mocked(mock.findUnique).mockReset();
  vi.mocked(mock.upsert).mockReset();
  vi.mocked(mock.delete).mockReset();
  vi.mocked(mock.deleteMany).mockReset();
}

describe('createPrismaDidConnectStorage', () => {
  beforeAll(resetAll);
  afterEach(resetAll);

  it('create: stores the token and status, and the returned row carries both', async () => {
    vi.mocked(mock.create).mockResolvedValue({ token: 'tok1', status: 'created', data: {} });

    const storage = createPrismaDidConnectStorage();
    const row = await storage.create('tok1', 'created');

    expect(mock.create).toHaveBeenCalledWith({
      data: { token: 'tok1', status: 'created', data: {} },
    });
    expect(row).toEqual({ token: 'tok1', status: 'created' });
  });

  it('read: a stored row comes back merged with its data payload', async () => {
    vi.mocked(mock.findUnique).mockResolvedValue({ token: 'tok1', status: 'scanned', data: { did: 'did:abt:zBuyer' } });

    const storage = createPrismaDidConnectStorage();
    const row = await storage.read('tok1');

    expect(mock.findUnique).toHaveBeenCalledWith({ where: { token: 'tok1' } });
    expect(row).toEqual({ token: 'tok1', status: 'scanned', did: 'did:abt:zBuyer' });
  });

  it('read: no stored row comes back as null, not an empty session', async () => {
    vi.mocked(mock.findUnique).mockResolvedValue(null);

    const storage = createPrismaDidConnectStorage();
    const row = await storage.read('nope');

    expect(row).toBeNull();
  });

  it('update: merges the update onto whatever is already stored (upsert, since the wallet may update before create in edge cases)', async () => {
    vi.mocked(mock.findUnique).mockResolvedValue(null);
    vi.mocked(mock.upsert).mockResolvedValue({ token: 'tok1', status: 'scanned', data: { did: 'did:abt:zBuyer' } });

    const storage = createPrismaDidConnectStorage();
    const row = await storage.update('tok1', { status: 'scanned', did: 'did:abt:zBuyer' });

    expect(mock.upsert).toHaveBeenCalled();
    expect(row).toEqual({ token: 'tok1', status: 'scanned', did: 'did:abt:zBuyer' });
  });

  it('update: merges new keys onto the EXISTING data payload rather than replacing it', async () => {
    vi.mocked(mock.findUnique).mockResolvedValue({
      token: 'tok1',
      status: 'created',
      data: { challenge: 'abc' },
    });
    vi.mocked(mock.upsert).mockImplementation(async (args: { update: { data: Record<string, unknown> } }) => ({
      token: 'tok1',
      status: 'scanned',
      data: args.update.data,
    }));

    const storage = createPrismaDidConnectStorage();
    await storage.update('tok1', { status: 'scanned', did: 'did:abt:zBuyer' });

    const upsertCall = vi.mocked(mock.upsert).mock.calls[0]?.[0] as { update: { data: Record<string, unknown> } };
    // The challenge from the existing row survives; it was never in this
    // update's own argument.
    expect(upsertCall.update.data).toEqual({ challenge: 'abc', did: 'did:abt:zBuyer' });
  });

  it('delete: removes the row (deleteMany, so an unknown token does not throw)', async () => {
    vi.mocked(mock.deleteMany).mockResolvedValue({ count: 1 });

    const storage = createPrismaDidConnectStorage();
    await storage.delete('tok1');

    expect(mock.deleteMany).toHaveBeenCalledWith({ where: { token: 'tok1' } });
  });

  it('exist: true for a known token with no did filter', async () => {
    vi.mocked(mock.findUnique).mockResolvedValue({ token: 'tok1', status: 'created', data: {} });

    const storage = createPrismaDidConnectStorage();
    expect(await storage.exist('tok1')).toBe(true);
  });

  it('exist: with a did filter, matches only when the stored data.did equals it', async () => {
    vi.mocked(mock.findUnique).mockResolvedValue({ token: 'tok1', status: 'created', data: { did: 'did:abt:zBuyer' } });

    const storage = createPrismaDidConnectStorage();
    expect(await storage.exist('tok1', 'did:abt:zBuyer')).toBe(true);
    expect(await storage.exist('tok1', 'did:abt:zSomeoneElse')).toBe(false);
  });

  it('exist: false for an unknown token', async () => {
    vi.mocked(mock.findUnique).mockResolvedValue(null);

    const storage = createPrismaDidConnectStorage();
    expect(await storage.exist('nope')).toBe(false);
  });

  it('on/emit exist as callable no-ops (BaseHandler wires to them at construction)', () => {
    const storage = createPrismaDidConnectStorage();
    expect(() => storage.on('create', () => {})).not.toThrow();
    expect(() => storage.emit('create', { token: 'tok1' })).not.toThrow();
  });
});
