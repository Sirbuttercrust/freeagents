// S2: the durable ABT spent-transfer record (brief section 4, "a
// transaction is spent once"). Driven against a stubbed generated Prisma
// client, the same seam tests/adapters/payment/usdc-half-paid-storage.test.ts
// uses: no test in this file opens a real database.
import { describe, expect, it, vi, afterEach, beforeAll } from 'vitest';

const mock = vi.hoisted(() => ({
  upsert: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock('../../../src/generated/prisma/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/generated/prisma/index.js')>(
    '../../../src/generated/prisma/index.js',
  );
  return {
    PrismaClient: class {
      abtSpentTransfer = {
        upsert: mock.upsert,
        findUnique: mock.findUnique,
      };
    },
    Prisma: actual.Prisma,
  };
});

const { createPrismaAbtSpentTransferStorage } = await import(
  '../../../src/adapters/payment/abt-spent-transfer-storage-prisma.js'
);

function resetAll(): void {
  vi.mocked(mock.upsert).mockReset();
  vi.mocked(mock.findUnique).mockReset();
}

describe('createPrismaAbtSpentTransferStorage', () => {
  beforeAll(resetAll);
  afterEach(resetAll);

  it('record: upserts one row per hash, carrying jobId and leg', async () => {
    vi.mocked(mock.upsert).mockResolvedValue({
      hash: 'broadcast-hash-1',
      jobId: 'job_1',
      leg: 'deposit',
      recordedAt: new Date('2026-01-01T00:00:00Z'),
    });

    const storage = createPrismaAbtSpentTransferStorage();
    await storage.record({ hash: 'broadcast-hash-1', jobId: 'job_1', leg: 'deposit' });

    expect(mock.upsert).toHaveBeenCalledWith({
      where: { hash: 'broadcast-hash-1' },
      create: { hash: 'broadcast-hash-1', jobId: 'job_1', leg: 'deposit' },
      update: { jobId: 'job_1', leg: 'deposit' },
    });
  });

  it('findByHash: returns the stored row for a hash', async () => {
    vi.mocked(mock.findUnique).mockResolvedValue({
      hash: 'broadcast-hash-1',
      jobId: 'job_1',
      leg: 'deposit',
      recordedAt: new Date('2026-01-01T00:00:00Z'),
    });

    const storage = createPrismaAbtSpentTransferStorage();
    const row = await storage.findByHash('broadcast-hash-1');

    expect(mock.findUnique).toHaveBeenCalledWith({ where: { hash: 'broadcast-hash-1' } });
    expect(row).toEqual({ hash: 'broadcast-hash-1', jobId: 'job_1', leg: 'deposit' });
  });

  it('findByHash: a hash that never backed a settlement comes back as null', async () => {
    vi.mocked(mock.findUnique).mockResolvedValue(null);

    const storage = createPrismaAbtSpentTransferStorage();
    const row = await storage.findByHash('unseen-hash');

    expect(row).toBeNull();
  });
});
