// S5+S6: the durable signature-spend record (one-shot replay refusal).
// Driven against a stubbed generated Prisma client, the same seam
// tests/adapters/payment/usdc-half-paid-storage.test.ts uses: no test in
// this file opens a real database.
import { describe, expect, it, vi, afterEach, beforeAll } from 'vitest';

const mock = vi.hoisted(() => ({
  create: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock('../../../src/generated/prisma/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/generated/prisma/index.js')>(
    '../../../src/generated/prisma/index.js',
  );
  return {
    PrismaClient: class {
      signatureSpend = {
        create: mock.create,
        findUnique: mock.findUnique,
      };
    },
    Prisma: actual.Prisma,
  };
});

const { createPrismaSignatureSpendStorage } = await import(
  '../../../src/adapters/identity/signature-spend-storage-prisma.js'
);

function resetAll(): void {
  vi.mocked(mock.create).mockReset();
  vi.mocked(mock.findUnique).mockReset();
}

describe('createPrismaSignatureSpendStorage', () => {
  beforeAll(resetAll);
  afterEach(resetAll);

  it('record: creates one row per (keyid, signatureHash), carrying created', async () => {
    vi.mocked(mock.create).mockResolvedValue({ keyid: 'keyid-1', signatureHash: 'hash-1', created: 1700000000 });

    const storage = createPrismaSignatureSpendStorage();
    await storage.record({ keyid: 'keyid-1', signatureHash: 'hash-1', created: 1700000000 });

    expect(mock.create).toHaveBeenCalledWith({
      data: { keyid: 'keyid-1', signatureHash: 'hash-1', created: 1700000000 },
    });
  });

  it('findByKeyidAndHash: returns the stored row for a keyid and signature hash', async () => {
    vi.mocked(mock.findUnique).mockResolvedValue({ keyid: 'keyid-1', signatureHash: 'hash-1', created: 1700000000 });

    const storage = createPrismaSignatureSpendStorage();
    const row = await storage.findByKeyidAndHash('keyid-1', 'hash-1');

    expect(mock.findUnique).toHaveBeenCalledWith({
      where: { keyid_signatureHash: { keyid: 'keyid-1', signatureHash: 'hash-1' } },
    });
    expect(row).toEqual({ keyid: 'keyid-1', signatureHash: 'hash-1', created: 1700000000 });
  });

  it('findByKeyidAndHash: no stored row comes back as null', async () => {
    vi.mocked(mock.findUnique).mockResolvedValue(null);

    const storage = createPrismaSignatureSpendStorage();
    const row = await storage.findByKeyidAndHash('keyid-1', 'hash-1');

    expect(row).toBeNull();
  });
});
