// P10: the observed settlement record (brief scope item 1). A row exists
// only because confirm() read a receipt off a chain, never because a
// caller claimed a payment happened. One row per (jobId, leg), written
// once and idempotent under a repeated confirm on the same ref.
//
// The Prisma half follows tests/adapters/attestation-storage.test.ts's own
// pattern: the generated client module is stubbed so no test here opens a
// real database.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObservedSettlementRecord } from '../../src/adapters/storage/types.js';

const mock = vi.hoisted(() => ({
  upsert: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock('../../src/generated/prisma/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/generated/prisma/index.js')>(
    '../../src/generated/prisma/index.js',
  );
  return {
    PrismaClient: class {
      observedSettlement = { upsert: mock.upsert, findUnique: mock.findUnique };
    },
    Prisma: actual.Prisma,
  };
});

const { MemorySettlementRepository } = await import('../../src/adapters/storage/memory.js');
const { PrismaSettlementRepository } = await import('../../src/adapters/storage/prisma.js');

function record(overrides: Partial<ObservedSettlementRecord> = {}): ObservedSettlementRecord {
  return {
    jobId: 'job_1',
    leg: 'deposit',
    rail: 'abt',
    hash: 'hash-1',
    secondaryHash: null,
    operatorAddress: 'z1Operator',
    feeAddress: 'z1Fee',
    amountUsd: '125.00',
    observedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('MemorySettlementRepository', () => {
  it('findByJobAndLeg is null before anything is recorded', async () => {
    const repo = new MemorySettlementRepository();
    expect(await repo.findByJobAndLeg('job_1', 'deposit')).toBeNull();
  });

  it('record() then findByJobAndLeg() round-trips the row', async () => {
    const repo = new MemorySettlementRepository();
    await repo.record(record());
    expect(await repo.findByJobAndLeg('job_1', 'deposit')).toEqual(record());
  });

  it('the deposit and remainder legs of the same job are independent rows', async () => {
    const repo = new MemorySettlementRepository();
    await repo.record(record({ leg: 'deposit', amountUsd: '125.00' }));
    await repo.record(record({ leg: 'remainder', amountUsd: '375.00' }));
    expect((await repo.findByJobAndLeg('job_1', 'deposit'))?.amountUsd).toBe('125.00');
    expect((await repo.findByJobAndLeg('job_1', 'remainder'))?.amountUsd).toBe('375.00');
  });

  it('recording the same job and leg twice is idempotent: one row, the latest write wins', async () => {
    const repo = new MemorySettlementRepository();
    await repo.record(record({ hash: 'hash-first' }));
    await repo.record(record({ hash: 'hash-second' }));
    const row = await repo.findByJobAndLeg('job_1', 'deposit');
    expect(row?.hash).toBe('hash-second');
  });

  it('two different jobs never collide', async () => {
    const repo = new MemorySettlementRepository();
    await repo.record(record({ jobId: 'job_1' }));
    await repo.record(record({ jobId: 'job_2' }));
    expect((await repo.findByJobAndLeg('job_1', 'deposit'))?.jobId).toBe('job_1');
    expect((await repo.findByJobAndLeg('job_2', 'deposit'))?.jobId).toBe('job_2');
  });
});

describe('PrismaSettlementRepository', () => {
  beforeEach(() => {
    vi.mocked(mock.upsert).mockReset();
    vi.mocked(mock.findUnique).mockReset();
  });

  it('record() upserts on the (jobId, leg) unique key, never a plain insert', async () => {
    vi.mocked(mock.upsert).mockResolvedValue({});
    const repo = new PrismaSettlementRepository();
    await repo.record(record());
    expect(mock.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { jobId_leg: { jobId: 'job_1', leg: 'deposit' } },
      }),
    );
  });

  it('findByJobAndLeg reads back the stored row, mapped to the domain shape', async () => {
    vi.mocked(mock.findUnique).mockResolvedValue({
      jobId: 'job_1',
      leg: 'deposit',
      rail: 'abt',
      hash: 'hash-1',
      secondaryHash: null,
      operatorAddress: 'z1Operator',
      feeAddress: 'z1Fee',
      amountUsd: '125.00',
      observedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const repo = new PrismaSettlementRepository();
    const row = await repo.findByJobAndLeg('job_1', 'deposit');
    expect(row).toEqual(record());
  });

  it('findByJobAndLeg answers null when no row matches', async () => {
    vi.mocked(mock.findUnique).mockResolvedValue(null);
    const repo = new PrismaSettlementRepository();
    expect(await repo.findByJobAndLeg('job_missing', 'deposit')).toBeNull();
  });
});
