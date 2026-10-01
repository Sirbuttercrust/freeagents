// The stored ABT-on-Ethereum price a checkout showed: one row per start,
// read back by its own id and checked against the job, the leg and the
// agreed price. The Prisma driver is driven against a stubbed generated
// client (the seam usdc-half-paid-storage.test.ts uses), so no test here
// opens a real database. Every expected value is written out as literals.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
      abtEthQuoteLock = {
        create: mock.create,
        findUnique: mock.findUnique,
      };
    },
    Prisma: actual.Prisma,
  };
});

const {
  abtEthQuoteLockExpired,
  checkAbtEthQuoteLock,
  createAbtEthQuoteLockStorage,
  lockAbtEthQuote,
} = await import('../../../src/adapters/payment/abt-eth-quote-lock.js');
const { createMemoryAbtEthQuoteLockStorage } = await import(
  '../../../src/adapters/payment/abt-eth-quote-lock-memory.js'
);
const { createPrismaAbtEthQuoteLockStorage } = await import(
  '../../../src/adapters/payment/abt-eth-quote-lock-prisma.js'
);
const { ABT_QUOTE_LOCK_LIFETIME_MS, LOCK_EXPIRED_MESSAGE, NO_LOCK_MESSAGE, PRICE_CHANGED_MESSAGE } = await import(
  '../../../src/adapters/payment/quote-lock.js'
);

const NO_LOCK_SENTENCE = 'This payment has no locked ABT price. Start the payment again.';
const PRICE_CHANGED_SENTENCE = 'The agreed price changed after this payment started. Start the payment again.';

function quote(overrides: Record<string, unknown> = {}) {
  return {
    rail: 'abt_eth' as const,
    priceUsd: '100.00',
    amountToken: '294.11764705',
    feeToken: '8.82352941',
    rateSource: 'CoinGecko (dollars per ABT: 0.34, updated 2026-10-01T11:59:00.000Z)',
    usdPerToken: '0.34',
    rateUpdatedAt: new Date('2026-10-01T11:59:00.000Z'),
    ...overrides,
  };
}

const NOW = new Date('2026-10-01T12:00:00.000Z');

afterEach(() => {
  vi.unstubAllEnvs();
  mock.create.mockReset();
  mock.findUnique.mockReset();
});

describe('lockAbtEthQuote and read', () => {
  it('stores the whole lock and reads it back by id, expiring exactly 15 minutes after now', async () => {
    const storage = createMemoryAbtEthQuoteLockStorage();
    const lock = await lockAbtEthQuote(storage, {
      jobId: 'job-1',
      leg: 'deposit',
      amountUsd: '100.00',
      quote: quote(),
      now: NOW,
    });
    expect(typeof lock.id).toBe('string');
    expect(lock.id).not.toBe('');
    expect(await storage.read(lock.id)).toEqual({
      id: lock.id,
      jobId: 'job-1',
      leg: 'deposit',
      amountUsd: '100.00',
      usdPerToken: '0.34',
      rateUpdatedAt: new Date('2026-10-01T11:59:00.000Z'),
      amountToken: '294.11764705',
      feeToken: '8.82352941',
      lockedAt: new Date('2026-10-01T12:00:00.000Z'),
      expiresAt: new Date('2026-10-01T12:15:00.000Z'),
    });
    expect(lock).toEqual(await storage.read(lock.id));
  });

  it('keeps a null rateUpdatedAt as null', async () => {
    const storage = createMemoryAbtEthQuoteLockStorage();
    const created = await storage.create({
      jobId: 'job-1',
      leg: 'remainder',
      amountUsd: '300.00',
      usdPerToken: '0.34',
      rateUpdatedAt: null,
      amountToken: '882.35294117',
      feeToken: '26.47058823',
      lockedAt: new Date('2026-10-01T12:00:00.000Z'),
      expiresAt: new Date('2026-10-01T12:15:00.000Z'),
    });
    expect(await storage.read(created.id)).toEqual({
      id: created.id,
      jobId: 'job-1',
      leg: 'remainder',
      amountUsd: '300.00',
      usdPerToken: '0.34',
      rateUpdatedAt: null,
      amountToken: '882.35294117',
      feeToken: '26.47058823',
      lockedAt: new Date('2026-10-01T12:00:00.000Z'),
      expiresAt: new Date('2026-10-01T12:15:00.000Z'),
    });
  });

  it('answers null for an id nothing was stored under', async () => {
    expect(await createMemoryAbtEthQuoteLockStorage().read('no-such-id')).toBeNull();
  });

  it('two locks for one job and leg with different quotes keep two ids, each with its own amounts', async () => {
    const storage = createMemoryAbtEthQuoteLockStorage();
    const first = await lockAbtEthQuote(storage, {
      jobId: 'job-1',
      leg: 'deposit',
      amountUsd: '100.00',
      quote: quote(),
      now: NOW,
    });
    const second = await lockAbtEthQuote(storage, {
      jobId: 'job-1',
      leg: 'deposit',
      amountUsd: '100.00',
      quote: quote({
        amountToken: '250',
        feeToken: '7.5',
        usdPerToken: '0.4',
        rateUpdatedAt: new Date('2026-10-01T12:04:00.000Z'),
      }),
      now: new Date('2026-10-01T12:05:00.000Z'),
    });
    expect(second.id).not.toBe(first.id);
    expect(await storage.read(first.id)).toEqual({
      id: first.id,
      jobId: 'job-1',
      leg: 'deposit',
      amountUsd: '100.00',
      usdPerToken: '0.34',
      rateUpdatedAt: new Date('2026-10-01T11:59:00.000Z'),
      amountToken: '294.11764705',
      feeToken: '8.82352941',
      lockedAt: new Date('2026-10-01T12:00:00.000Z'),
      expiresAt: new Date('2026-10-01T12:15:00.000Z'),
    });
    expect(await storage.read(second.id)).toEqual({
      id: second.id,
      jobId: 'job-1',
      leg: 'deposit',
      amountUsd: '100.00',
      usdPerToken: '0.4',
      rateUpdatedAt: new Date('2026-10-01T12:04:00.000Z'),
      amountToken: '250',
      feeToken: '7.5',
      lockedAt: new Date('2026-10-01T12:05:00.000Z'),
      expiresAt: new Date('2026-10-01T12:20:00.000Z'),
    });
  });
});

describe('checkAbtEthQuoteLock', () => {
  async function stored() {
    const storage = createMemoryAbtEthQuoteLockStorage();
    const lock = await lockAbtEthQuote(storage, {
      jobId: 'job-1',
      leg: 'deposit',
      amountUsd: '100.00',
      quote: quote(),
      now: NOW,
    });
    return { storage, lock };
  }

  it('refuses an unknown id with the no-lock sentence', async () => {
    const { storage } = await stored();
    expect(
      await checkAbtEthQuoteLock(storage, { lockId: 'no-such-id', jobId: 'job-1', leg: 'deposit', amountUsd: '100.00' }),
    ).toEqual({ ok: false, message: 'This payment has no locked ABT price. Start the payment again.' });
  });

  it('refuses an unknown id with the no-lock sentence even when the agreed price is missing', async () => {
    const { storage } = await stored();
    expect(
      await checkAbtEthQuoteLock(storage, { lockId: 'no-such-id', jobId: 'job-1', leg: 'deposit', amountUsd: null }),
    ).toEqual({ ok: false, message: 'This payment has no locked ABT price. Start the payment again.' });
  });

  it('refuses a lock that names another job with the no-lock sentence', async () => {
    const { storage, lock } = await stored();
    expect(
      await checkAbtEthQuoteLock(storage, { lockId: lock.id, jobId: 'job-2', leg: 'deposit', amountUsd: '100.00' }),
    ).toEqual({ ok: false, message: 'This payment has no locked ABT price. Start the payment again.' });
  });

  it('refuses a lock for the other leg with the no-lock sentence', async () => {
    const { storage, lock } = await stored();
    expect(
      await checkAbtEthQuoteLock(storage, { lockId: lock.id, jobId: 'job-1', leg: 'remainder', amountUsd: '100.00' }),
    ).toEqual({ ok: false, message: 'This payment has no locked ABT price. Start the payment again.' });
  });

  it('refuses a null agreed price with the no-agreed-price sentence', async () => {
    const { storage, lock } = await stored();
    expect(
      await checkAbtEthQuoteLock(storage, { lockId: lock.id, jobId: 'job-1', leg: 'deposit', amountUsd: null }),
    ).toEqual({ ok: false, message: 'this job has no agreed price to pay against' });
  });

  it('refuses an agreed price that differs from the lock with the price-changed sentence', async () => {
    const { storage, lock } = await stored();
    expect(
      await checkAbtEthQuoteLock(storage, { lockId: lock.id, jobId: 'job-1', leg: 'deposit', amountUsd: '120.00' }),
    ).toEqual({ ok: false, message: 'The agreed price changed after this payment started. Start the payment again.' });
  });

  it('answers ok with the whole lock when id, job, leg and price all match', async () => {
    const { storage, lock } = await stored();
    expect(
      await checkAbtEthQuoteLock(storage, { lockId: lock.id, jobId: 'job-1', leg: 'deposit', amountUsd: '100.00' }),
    ).toEqual({
      ok: true,
      lock: {
        id: lock.id,
        jobId: 'job-1',
        leg: 'deposit',
        amountUsd: '100.00',
        usdPerToken: '0.34',
        rateUpdatedAt: new Date('2026-10-01T11:59:00.000Z'),
        amountToken: '294.11764705',
        feeToken: '8.82352941',
        lockedAt: new Date('2026-10-01T12:00:00.000Z'),
        expiresAt: new Date('2026-10-01T12:15:00.000Z'),
      },
    });
  });
});

describe('abtEthQuoteLockExpired', () => {
  const lock = {
    id: 'lock-1',
    jobId: 'job-1',
    leg: 'deposit' as const,
    amountUsd: '100.00',
    usdPerToken: '0.34',
    rateUpdatedAt: null,
    amountToken: '294.11764705',
    feeToken: '8.82352941',
    lockedAt: new Date('2026-10-01T12:00:00.000Z'),
    expiresAt: new Date('2026-10-01T12:15:00.000Z'),
  };

  it('is false one millisecond before expiresAt', () => {
    expect(abtEthQuoteLockExpired(lock, new Date('2026-10-01T12:14:59.999Z'))).toBe(false);
  });

  it('is true at expiresAt', () => {
    expect(abtEthQuoteLockExpired(lock, new Date('2026-10-01T12:15:00.000Z'))).toBe(true);
  });

  it('is true after expiresAt', () => {
    expect(abtEthQuoteLockExpired(lock, new Date('2026-10-01T12:15:00.001Z'))).toBe(true);
  });
});

describe('the memory driver stores and answers copies', () => {
  const input = () => ({
    jobId: 'job-1',
    leg: 'deposit' as const,
    amountUsd: '100.00',
    usdPerToken: '0.34',
    rateUpdatedAt: new Date('2026-10-01T11:59:00.000Z'),
    amountToken: '294.11764705',
    feeToken: '8.82352941',
    lockedAt: new Date('2026-10-01T12:00:00.000Z'),
    expiresAt: new Date('2026-10-01T12:15:00.000Z'),
  });

  it('changing the lock create returned does not change the next read', async () => {
    const storage = createMemoryAbtEthQuoteLockStorage();
    const created = await storage.create(input());
    const writable = created as { amountToken: string; expiresAt: Date };
    writable.amountToken = '1';
    writable.expiresAt.setTime(0);
    expect(await storage.read(created.id)).toEqual({ id: created.id, ...input() });
  });

  it('changing a lock read returned does not change the next read', async () => {
    const storage = createMemoryAbtEthQuoteLockStorage();
    const created = await storage.create(input());
    const first = (await storage.read(created.id)) as { amountToken: string; lockedAt: Date };
    first.amountToken = '1';
    first.lockedAt.setTime(0);
    expect(await storage.read(created.id)).toEqual({ id: created.id, ...input() });
  });

  it('changing the object passed to create afterwards does not change the next read', async () => {
    const storage = createMemoryAbtEthQuoteLockStorage();
    const passed = input();
    const created = await storage.create(passed);
    (passed as { amountToken: string }).amountToken = '1';
    passed.expiresAt.setTime(0);
    expect(await storage.read(created.id)).toEqual({ id: created.id, ...input() });
  });
});

describe('the Prisma driver, against a stubbed generated client', () => {
  const row = {
    id: 'cl-lock-1',
    jobId: 'job-1',
    leg: 'remainder',
    amountUsd: '300.00',
    usdPerToken: '0.34',
    rateUpdatedAt: new Date('2026-10-01T11:59:00.000Z'),
    amountToken: '882.35294117',
    feeToken: '26.47058823',
    lockedAt: new Date('2026-10-01T12:00:00.000Z'),
    expiresAt: new Date('2026-10-01T12:15:00.000Z'),
  };

  it('create writes every column except the id and answers the stored row with its id', async () => {
    mock.create.mockResolvedValue({ ...row });
    const created = await createPrismaAbtEthQuoteLockStorage().create({
      jobId: 'job-1',
      leg: 'remainder',
      amountUsd: '300.00',
      usdPerToken: '0.34',
      rateUpdatedAt: new Date('2026-10-01T11:59:00.000Z'),
      amountToken: '882.35294117',
      feeToken: '26.47058823',
      lockedAt: new Date('2026-10-01T12:00:00.000Z'),
      expiresAt: new Date('2026-10-01T12:15:00.000Z'),
    });
    expect(mock.create).toHaveBeenCalledTimes(1);
    expect(mock.create.mock.calls[0]).toEqual([
      {
        data: {
          jobId: 'job-1',
          leg: 'remainder',
          amountUsd: '300.00',
          usdPerToken: '0.34',
          rateUpdatedAt: new Date('2026-10-01T11:59:00.000Z'),
          amountToken: '882.35294117',
          feeToken: '26.47058823',
          lockedAt: new Date('2026-10-01T12:00:00.000Z'),
          expiresAt: new Date('2026-10-01T12:15:00.000Z'),
        },
      },
    ]);
    expect(created).toEqual({
      id: 'cl-lock-1',
      jobId: 'job-1',
      leg: 'remainder',
      amountUsd: '300.00',
      usdPerToken: '0.34',
      rateUpdatedAt: new Date('2026-10-01T11:59:00.000Z'),
      amountToken: '882.35294117',
      feeToken: '26.47058823',
      lockedAt: new Date('2026-10-01T12:00:00.000Z'),
      expiresAt: new Date('2026-10-01T12:15:00.000Z'),
    });
  });

  it('read calls findUnique by id and maps the row back', async () => {
    mock.findUnique.mockResolvedValue({ ...row, rateUpdatedAt: null });
    const lock = await createPrismaAbtEthQuoteLockStorage().read('cl-lock-1');
    expect(mock.findUnique.mock.calls).toEqual([[{ where: { id: 'cl-lock-1' } }]]);
    expect(lock).toEqual({
      id: 'cl-lock-1',
      jobId: 'job-1',
      leg: 'remainder',
      amountUsd: '300.00',
      usdPerToken: '0.34',
      rateUpdatedAt: null,
      amountToken: '882.35294117',
      feeToken: '26.47058823',
      lockedAt: new Date('2026-10-01T12:00:00.000Z'),
      expiresAt: new Date('2026-10-01T12:15:00.000Z'),
    });
  });

  it('read answers null when there is no row', async () => {
    mock.findUnique.mockResolvedValue(null);
    expect(await createPrismaAbtEthQuoteLockStorage().read('no-such-id')).toBeNull();
  });
});

describe('createAbtEthQuoteLockStorage', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  const input = {
    jobId: 'job-1',
    leg: 'deposit' as const,
    amountUsd: '100.00',
    usdPerToken: '0.34',
    rateUpdatedAt: null,
    amountToken: '294.11764705',
    feeToken: '8.82352941',
    lockedAt: new Date('2026-10-01T12:00:00.000Z'),
    expiresAt: new Date('2026-10-01T12:15:00.000Z'),
  };

  it('writes through the Prisma client when DATABASE_URL is set, and does not warn', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://stub/none');
    mock.create.mockResolvedValue({ id: 'cl-lock-9', ...input });
    const created = await createAbtEthQuoteLockStorage().create(input);
    expect(mock.create).toHaveBeenCalledTimes(1);
    expect(created.id).toBe('cl-lock-9');
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the lock in memory when DATABASE_URL is empty, and warns that it does not survive a restart', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const storage = createAbtEthQuoteLockStorage();
    const created = await storage.create(input);
    expect(mock.create).not.toHaveBeenCalled();
    expect(await storage.read(created.id)).toEqual({ id: created.id, ...input });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('in-memory ABT-on-Ethereum quote lock storage');
  });
});

describe('the shared meaning of a locked ABT price (quote-lock.ts)', () => {
  // The same literals tests/api/job-payment-abt.test.ts pins for the
  // ArcBlock rail, so the two rails cannot drift apart.
  it('the lifetime is 15 minutes', () => {
    expect(ABT_QUOTE_LOCK_LIFETIME_MS).toBe(900000);
  });

  it('the three sentences are the ones the ArcBlock rail answers with', () => {
    expect({ NO_LOCK_MESSAGE, LOCK_EXPIRED_MESSAGE, PRICE_CHANGED_MESSAGE }).toEqual({
      NO_LOCK_MESSAGE: NO_LOCK_SENTENCE,
      LOCK_EXPIRED_MESSAGE: 'The ABT price for this payment expired. Start the payment again for a fresh price.',
      PRICE_CHANGED_MESSAGE: PRICE_CHANGED_SENTENCE,
    });
  });

  it('the ArcBlock rail test pins those same literals', () => {
    const source = readFileSync(new URL('../../api/job-payment-abt.test.ts', import.meta.url), 'utf8');
    for (const literal of [
      "const LOCK_LIFETIME_MS = 15 * 60 * 1000;",
      `const NO_LOCK_SENTENCE = '${NO_LOCK_SENTENCE}';`,
      "const EXPIRED_SENTENCE = 'The ABT price for this payment expired. Start the payment again for a fresh price.';",
      `const PRICE_CHANGED_SENTENCE = '${PRICE_CHANGED_SENTENCE}';`,
    ]) {
      expect(source).toContain(literal);
    }
  });
});
