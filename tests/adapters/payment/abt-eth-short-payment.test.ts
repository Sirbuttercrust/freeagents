// The record of a short ABT-on-Ethereum payment: one row per price transfer,
// keyed by the transfer's normalised hash, read back by hash or by job and
// leg. The Prisma driver is driven against a stubbed generated client (the
// seam abt-eth-quote-lock.test.ts uses), so no test here opens a database.
// Every expected value is written out as a literal.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  upsert: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock('../../../src/generated/prisma/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/generated/prisma/index.js')>(
    '../../../src/generated/prisma/index.js',
  );
  return {
    PrismaClient: class {
      abtEthShortPayment = {
        upsert: mock.upsert,
        findUnique: mock.findUnique,
        findMany: mock.findMany,
      };
    },
    Prisma: actual.Prisma,
  };
});

const { createAbtEthShortPaymentStorage } = await import('../../../src/adapters/payment/abt-eth-short-payment.js');
const { createMemoryAbtEthShortPaymentStorage } = await import(
  '../../../src/adapters/payment/abt-eth-short-payment-memory.js'
);
const { createPrismaAbtEthShortPaymentStorage } = await import(
  '../../../src/adapters/payment/abt-eth-short-payment-prisma.js'
);

const HASH_A = '0xaaaa000000000000000000000000000000000000000000000000000000000001';
const HASH_B = '0xbbbb000000000000000000000000000000000000000000000000000000000002';
const FEE_HASH = '0xcccc000000000000000000000000000000000000000000000000000000000003';

function record(overrides: Record<string, unknown> = {}) {
  return {
    priceTxHash: HASH_A,
    jobId: 'job-1',
    leg: 'deposit' as const,
    lockId: 'lock-1',
    feeTxHash: FEE_HASH as string | null,
    amountToken: '80',
    amountUsd: '20.00',
    usdPerTokenAtRead: '0.20' as string | null,
    worthUsd: '16' as string | null,
    recordedAt: new Date('2026-10-01T12:20:00.000Z') as Date | null,
    readAt: new Date('2026-10-01T12:30:00.000Z'),
    ...overrides,
  };
}

describe('the memory driver', () => {
  it('records a short payment and reads it back by its hash and by its job and leg', async () => {
    const storage = createMemoryAbtEthShortPaymentStorage();
    await storage.record(record());
    expect(await storage.findByHash(HASH_A)).toEqual({
      priceTxHash: HASH_A,
      jobId: 'job-1',
      leg: 'deposit',
      lockId: 'lock-1',
      feeTxHash: FEE_HASH,
      amountToken: '80',
      amountUsd: '20.00',
      usdPerTokenAtRead: '0.20',
      worthUsd: '16',
      recordedAt: new Date('2026-10-01T12:20:00.000Z'),
      readAt: new Date('2026-10-01T12:30:00.000Z'),
    });
    expect(await storage.findByJobAndLeg('job-1', 'deposit')).toEqual([
      {
        priceTxHash: HASH_A,
        jobId: 'job-1',
        leg: 'deposit',
        lockId: 'lock-1',
        feeTxHash: FEE_HASH,
        amountToken: '80',
        amountUsd: '20.00',
        usdPerTokenAtRead: '0.20',
        worthUsd: '16',
        recordedAt: new Date('2026-10-01T12:20:00.000Z'),
        readAt: new Date('2026-10-01T12:30:00.000Z'),
      },
    ]);
  });

  it('keeps the nullable fields as null: no fee transfer, no price readable, no recorded time', async () => {
    const storage = createMemoryAbtEthShortPaymentStorage();
    await storage.record(record({ feeTxHash: null, usdPerTokenAtRead: null, worthUsd: null, recordedAt: null }));
    expect(await storage.findByHash(HASH_A)).toEqual({
      priceTxHash: HASH_A,
      jobId: 'job-1',
      leg: 'deposit',
      lockId: 'lock-1',
      feeTxHash: null,
      amountToken: '80',
      amountUsd: '20.00',
      usdPerTokenAtRead: null,
      worthUsd: null,
      recordedAt: null,
      readAt: new Date('2026-10-01T12:30:00.000Z'),
    });
  });

  it('answers null for a hash nothing was recorded under, and an empty list for a job and leg with none', async () => {
    const storage = createMemoryAbtEthShortPaymentStorage();
    await storage.record(record());
    expect(await storage.findByHash(HASH_B)).toBeNull();
    expect(await storage.findByJobAndLeg('job-1', 'remainder')).toEqual([]);
    expect(await storage.findByJobAndLeg('job-2', 'deposit')).toEqual([]);
  });

  it('a second report of the same transfer keeps one row, with the later read', async () => {
    const storage = createMemoryAbtEthShortPaymentStorage();
    await storage.record(record());
    await storage.record(
      record({ usdPerTokenAtRead: '0.22', worthUsd: '17.6', readAt: new Date('2026-10-01T12:45:00.000Z') }),
    );
    expect(await storage.findByJobAndLeg('job-1', 'deposit')).toEqual([
      {
        priceTxHash: HASH_A,
        jobId: 'job-1',
        leg: 'deposit',
        lockId: 'lock-1',
        feeTxHash: FEE_HASH,
        amountToken: '80',
        amountUsd: '20.00',
        usdPerTokenAtRead: '0.22',
        worthUsd: '17.6',
        recordedAt: new Date('2026-10-01T12:20:00.000Z'),
        readAt: new Date('2026-10-01T12:45:00.000Z'),
      },
    ]);
  });

  it('two different transfers for one job and leg are two rows: the second does not overwrite the first', async () => {
    const storage = createMemoryAbtEthShortPaymentStorage();
    await storage.record(record());
    await storage.record(record({ priceTxHash: HASH_B, lockId: 'lock-2', readAt: new Date('2026-10-01T13:00:00.000Z') }));
    expect((await storage.findByJobAndLeg('job-1', 'deposit')).map((row) => [row.priceTxHash, row.lockId])).toEqual([
      [HASH_A, 'lock-1'],
      [HASH_B, 'lock-2'],
    ]);
    expect((await storage.findByHash(HASH_A))?.lockId).toBe('lock-1');
    expect((await storage.findByHash(HASH_B))?.lockId).toBe('lock-2');
  });

  it('keys the row by the normalised hash: a respelled hash is the same transfer, and the row carries the lower-case spelling', async () => {
    const storage = createMemoryAbtEthShortPaymentStorage();
    await storage.record(record({ priceTxHash: HASH_A.toUpperCase().replace('0X', '0x') }));
    await storage.record(record({ priceTxHash: HASH_A, worthUsd: '15' }));
    const rows = await storage.findByJobAndLeg('job-1', 'deposit');
    expect(rows.map((row) => [row.priceTxHash, row.worthUsd])).toEqual([[HASH_A, '15']]);
    expect((await storage.findByHash(HASH_A.toUpperCase().replace('0X', '0x')))?.priceTxHash).toBe(HASH_A);
  });

  it('answers copies: changing a row it returned, or the object passed in, changes nothing it stored', async () => {
    const storage = createMemoryAbtEthShortPaymentStorage();
    const passed = record();
    await storage.record(passed);
    (passed as { worthUsd: string }).worthUsd = '1';
    (passed.readAt as Date).setTime(0);
    const first = (await storage.findByHash(HASH_A)) as { worthUsd: string; readAt: Date; recordedAt: Date };
    first.worthUsd = '2';
    first.readAt.setTime(0);
    first.recordedAt.setTime(0);
    const listed = await storage.findByJobAndLeg('job-1', 'deposit');
    (listed[0] as { worthUsd: string }).worthUsd = '3';
    expect(await storage.findByHash(HASH_A)).toEqual({
      priceTxHash: HASH_A,
      jobId: 'job-1',
      leg: 'deposit',
      lockId: 'lock-1',
      feeTxHash: FEE_HASH,
      amountToken: '80',
      amountUsd: '20.00',
      usdPerTokenAtRead: '0.20',
      worthUsd: '16',
      recordedAt: new Date('2026-10-01T12:20:00.000Z'),
      readAt: new Date('2026-10-01T12:30:00.000Z'),
    });
  });
});

describe('the Prisma driver, against a stubbed generated client', () => {
  beforeEach(() => {
    mock.upsert.mockReset();
    mock.findUnique.mockReset();
    mock.findMany.mockReset();
  });

  const stored = {
    priceTxHash: HASH_A,
    jobId: 'job-1',
    leg: 'remainder',
    lockId: 'lock-1',
    feeTxHash: null,
    amountToken: '80',
    amountUsd: '20.00',
    usdPerTokenAtRead: null,
    worthUsd: null,
    recordedAt: null,
    readAt: new Date('2026-10-01T12:30:00.000Z'),
  };

  it('record upserts by the normalised hash, writing every column on create and every column but the hash on update', async () => {
    mock.upsert.mockResolvedValue({});
    await createPrismaAbtEthShortPaymentStorage().record(
      record({ priceTxHash: HASH_A.toUpperCase().replace('0X', '0x'), leg: 'remainder' }),
    );
    const data = {
      jobId: 'job-1',
      leg: 'remainder',
      lockId: 'lock-1',
      feeTxHash: FEE_HASH,
      amountToken: '80',
      amountUsd: '20.00',
      usdPerTokenAtRead: '0.20',
      worthUsd: '16',
      recordedAt: new Date('2026-10-01T12:20:00.000Z'),
      readAt: new Date('2026-10-01T12:30:00.000Z'),
    };
    expect(mock.upsert.mock.calls).toEqual([
      [{ where: { priceTxHash: HASH_A }, create: { priceTxHash: HASH_A, ...data }, update: data }],
    ]);
  });

  it('findByHash calls findUnique by the normalised hash and maps the row back, nulls kept', async () => {
    mock.findUnique.mockResolvedValue({ ...stored });
    const found = await createPrismaAbtEthShortPaymentStorage().findByHash(HASH_A.toUpperCase().replace('0X', '0x'));
    expect(mock.findUnique.mock.calls).toEqual([[{ where: { priceTxHash: HASH_A } }]]);
    expect(found).toEqual({
      priceTxHash: HASH_A,
      jobId: 'job-1',
      leg: 'remainder',
      lockId: 'lock-1',
      feeTxHash: null,
      amountToken: '80',
      amountUsd: '20.00',
      usdPerTokenAtRead: null,
      worthUsd: null,
      recordedAt: null,
      readAt: new Date('2026-10-01T12:30:00.000Z'),
    });
  });

  it('findByHash answers null when there is no row', async () => {
    mock.findUnique.mockResolvedValue(null);
    expect(await createPrismaAbtEthShortPaymentStorage().findByHash(HASH_B)).toBeNull();
  });

  it('findByJobAndLeg calls findMany for the job and leg, oldest read first, and maps every row', async () => {
    mock.findMany.mockResolvedValue([{ ...stored }, { ...stored, priceTxHash: HASH_B, lockId: 'lock-2' }]);
    const found = await createPrismaAbtEthShortPaymentStorage().findByJobAndLeg('job-1', 'remainder');
    expect(mock.findMany.mock.calls).toEqual([
      [{ where: { jobId: 'job-1', leg: 'remainder' }, orderBy: [{ readAt: 'asc' }, { priceTxHash: 'asc' }] }],
    ]);
    expect(found.map((row) => [row.priceTxHash, row.lockId, row.leg])).toEqual([
      [HASH_A, 'lock-1', 'remainder'],
      [HASH_B, 'lock-2', 'remainder'],
    ]);
  });

  it('findByJobAndLeg answers an empty list when there is no row', async () => {
    mock.findMany.mockResolvedValue([]);
    expect(await createPrismaAbtEthShortPaymentStorage().findByJobAndLeg('job-9', 'deposit')).toEqual([]);
  });
});

describe('createAbtEthShortPaymentStorage', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    mock.upsert.mockReset();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    vi.unstubAllEnvs();
  });

  it('writes through the Prisma client when DATABASE_URL is set, and does not warn', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://stub/none');
    mock.upsert.mockResolvedValue({});
    await createAbtEthShortPaymentStorage().record(record());
    expect(mock.upsert).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the record in memory when DATABASE_URL is empty, and warns that it does not survive a restart', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const storage = createAbtEthShortPaymentStorage();
    await storage.record(record());
    expect(mock.upsert).not.toHaveBeenCalled();
    expect((await storage.findByHash(HASH_A))?.jobId).toBe('job-1');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('in-memory ABT-on-Ethereum short payment storage');
  });
});
