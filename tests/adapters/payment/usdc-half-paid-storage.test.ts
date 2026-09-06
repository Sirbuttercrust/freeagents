// P3: the durable half-paid settlement record (scope item 3, "record it
// durably enough that P4's state machine can read it"). Driven against a
// stubbed generated Prisma client, the same seam
// tests/adapters/payment/session-storage-prisma.test.ts uses: no test in
// this file opens a real database.
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
      usdcHalfPaidSettlement = {
        upsert: mock.upsert,
        findUnique: mock.findUnique,
      };
    },
    Prisma: actual.Prisma,
  };
});

const { createPrismaUsdcHalfPaidStorage } = await import(
  '../../../src/adapters/payment/usdc-half-paid-storage-prisma.js'
);

function resetAll(): void {
  vi.mocked(mock.upsert).mockReset();
  vi.mocked(mock.findUnique).mockReset();
}

describe('createPrismaUsdcHalfPaidStorage', () => {
  beforeAll(resetAll);
  afterEach(resetAll);

  it('record: upserts one row per job id and leg, carrying both hashes and both statuses', async () => {
    vi.mocked(mock.upsert).mockResolvedValue({
      id: 'row_1',
      jobId: 'job_1',
      leg: 'deposit',
      priceTxHash: '0xprice',
      priceStatus: 'confirmed',
      feeTxHash: null,
      feeStatus: 'not_signed',
      recordedAt: new Date('2026-01-01T00:00:00Z'),
    });

    const storage = createPrismaUsdcHalfPaidStorage();
    await storage.record({
      jobId: 'job_1',
      leg: 'deposit',
      priceTxHash: '0xprice',
      priceStatus: 'confirmed',
      feeTxHash: null,
      feeStatus: 'not_signed',
    });

    expect(mock.upsert).toHaveBeenCalledWith({
      where: { jobId_leg: { jobId: 'job_1', leg: 'deposit' } },
      create: {
        jobId: 'job_1',
        leg: 'deposit',
        priceTxHash: '0xprice',
        priceStatus: 'confirmed',
        feeTxHash: null,
        feeStatus: 'not_signed',
      },
      update: {
        priceTxHash: '0xprice',
        priceStatus: 'confirmed',
        feeTxHash: null,
        feeStatus: 'not_signed',
      },
    });
  });

  it('read: returns the stored row for a job id and leg', async () => {
    vi.mocked(mock.findUnique).mockResolvedValue({
      id: 'row_1',
      jobId: 'job_1',
      leg: 'deposit',
      priceTxHash: '0xprice',
      priceStatus: 'confirmed',
      feeTxHash: '0xfee',
      feeStatus: 'not_confirmed',
      recordedAt: new Date('2026-01-01T00:00:00Z'),
    });

    const storage = createPrismaUsdcHalfPaidStorage();
    const row = await storage.read('job_1', 'deposit');

    expect(mock.findUnique).toHaveBeenCalledWith({ where: { jobId_leg: { jobId: 'job_1', leg: 'deposit' } } });
    expect(row).toEqual({
      jobId: 'job_1',
      leg: 'deposit',
      priceTxHash: '0xprice',
      priceStatus: 'confirmed',
      feeTxHash: '0xfee',
      feeStatus: 'not_confirmed',
    });
  });

  it('read: no stored row comes back as null', async () => {
    vi.mocked(mock.findUnique).mockResolvedValue(null);

    const storage = createPrismaUsdcHalfPaidStorage();
    const row = await storage.read('job_1', 'deposit');

    expect(row).toBeNull();
  });
});
