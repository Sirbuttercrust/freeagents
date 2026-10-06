// The late-transfer decision: does a reported ABT-on-Ethereum payment count at
// the price that was held, count because it is still worth the agreed price
// now, or is it short. Every expected value is written out as a literal; the
// price reader is a recording stub, so no test here reaches a price feed.
import { describe, expect, it } from 'vitest';
import { judgeAbtEthLateTransfer } from '../../../src/adapters/payment/abt-eth-late.js';
import type { AbtEthQuoteLock } from '../../../src/adapters/payment/abt-eth-quote-lock-types.js';
import { RateUnavailableError } from '../../../src/adapters/payment/types.js';

// The hold ran from 12:00:00 to 12:15:00 on 2026-10-01: 80 ABT for $20.00 at
// $0.25 each.
function lock(overrides: Partial<AbtEthQuoteLock> = {}): AbtEthQuoteLock {
  return {
    id: 'lock-1',
    jobId: 'job-1',
    leg: 'deposit',
    amountUsd: '20.00',
    usdPerToken: '0.25',
    rateUpdatedAt: new Date('2026-10-01T11:59:00.000Z'),
    amountToken: '80',
    feeToken: '2.4',
    lockedAt: new Date('2026-10-01T12:00:00.000Z'),
    expiresAt: new Date('2026-10-01T12:15:00.000Z'),
    ...overrides,
  };
}

function reader(answer: string | Error) {
  const calls: Array<{ priceUsd: string }> = [];
  return {
    calls,
    readPrice: async (input: { readonly priceUsd: string }) => {
      calls.push({ priceUsd: input.priceUsd });
      if (answer instanceof Error) throw answer;
      return { usdPerToken: answer };
    },
  };
}

describe('judgeAbtEthLateTransfer: a transfer the network recorded inside the hold', () => {
  it('is held at the price that was locked, however late it is reported, and no price is read', async () => {
    const price = reader('0.01');
    const judged = await judgeAbtEthLateTransfer({
      lock: lock(),
      priceRecordedAt: '2026-10-01T12:14:59.999Z',
      readPrice: price.readPrice,
    });
    expect(judged).toEqual({ kind: 'held' });
    expect(price.calls).toEqual([]);
  });

  it('is held when recorded at the first instant of the hold', async () => {
    const price = reader('0.01');
    expect(
      await judgeAbtEthLateTransfer({ lock: lock(), priceRecordedAt: '2026-10-01T12:00:00.000Z', readPrice: price.readPrice }),
    ).toEqual({ kind: 'held' });
    expect(price.calls).toEqual([]);
  });
});

describe('judgeAbtEthLateTransfer: a transfer the network recorded at or after the hold ended', () => {
  it('is not held when recorded exactly at expiresAt: the hold ends at that instant', async () => {
    const price = reader('0.25');
    const judged = await judgeAbtEthLateTransfer({
      lock: lock(),
      priceRecordedAt: '2026-10-01T12:15:00.000Z',
      readPrice: price.readPrice,
    });
    expect(judged).toEqual({ kind: 'covers', usdPerToken: '0.25' });
    expect(price.calls).toEqual([{ priceUsd: '20.00' }]);
  });

  it('covers when the price read now makes the locked amount worth more than the agreed price', async () => {
    const price = reader('0.30');
    const judged = await judgeAbtEthLateTransfer({
      lock: lock(),
      priceRecordedAt: '2026-10-01T12:40:00.000Z',
      readPrice: price.readPrice,
    });
    expect(judged).toEqual({ kind: 'covers', usdPerToken: '0.30' });
    expect(price.calls).toEqual([{ priceUsd: '20.00' }]);
  });

  it('covers when the locked amount is worth exactly the agreed price now', async () => {
    const price = reader('0.25');
    expect(
      await judgeAbtEthLateTransfer({ lock: lock(), priceRecordedAt: '2026-10-01T13:00:00.000Z', readPrice: price.readPrice }),
    ).toEqual({ kind: 'covers', usdPerToken: '0.25' });
  });

  it('is short, with what it is worth, when the locked amount is worth one smallest unit of the token less than the agreed price needs', async () => {
    const price = reader('0.25');
    const judged = await judgeAbtEthLateTransfer({
      lock: lock({ amountToken: '79.999999999999999999' }),
      priceRecordedAt: '2026-10-01T13:00:00.000Z',
      readPrice: price.readPrice,
    });
    expect(judged).toEqual({ kind: 'short', usdPerToken: '0.25', worthUsd: '19.99999999' });
  });

  it('is short when the price fell: 80 ABT at $0.20 is worth $16', async () => {
    const price = reader('0.20');
    expect(
      await judgeAbtEthLateTransfer({ lock: lock(), priceRecordedAt: '2026-10-01T12:30:00.000Z', readPrice: price.readPrice }),
    ).toEqual({ kind: 'short', usdPerToken: '0.20', worthUsd: '16' });
  });

  it('judges the locked amount, not anything else: the price reader is asked about the lock\'s dollars only', async () => {
    const price = reader('0.25');
    await judgeAbtEthLateTransfer({
      lock: lock({ amountUsd: '300.00', amountToken: '1200' }),
      priceRecordedAt: '2026-10-01T12:30:00.000Z',
      readPrice: price.readPrice,
    });
    expect(price.calls).toEqual([{ priceUsd: '300.00' }]);
  });

  it('covers 3 tokens agreed at $0.87 when the price now is $0.29, where floating point would call it short', async () => {
    const price = reader('0.29');
    expect(
      await judgeAbtEthLateTransfer({
        lock: lock({ amountUsd: '0.87', amountToken: '3' }),
        priceRecordedAt: '2026-10-01T12:30:00.000Z',
        readPrice: price.readPrice,
      }),
    ).toEqual({ kind: 'covers', usdPerToken: '0.29' });
  });

  it('is short with no price and no worth when no price can be read now', async () => {
    const price = reader(new RateUnavailableError('abt_eth'));
    expect(
      await judgeAbtEthLateTransfer({ lock: lock(), priceRecordedAt: '2026-10-01T12:30:00.000Z', readPrice: price.readPrice }),
    ).toEqual({ kind: 'short', usdPerToken: null, worthUsd: null });
    expect(price.calls).toEqual([{ priceUsd: '20.00' }]);
  });

  it('lets any other failure of the price reader surface instead of calling the transfer short', async () => {
    const price = reader(new Error('socket hang up'));
    await expect(
      judgeAbtEthLateTransfer({ lock: lock(), priceRecordedAt: '2026-10-01T12:30:00.000Z', readPrice: price.readPrice }),
    ).rejects.toThrow('socket hang up');
  });
});

describe('judgeAbtEthLateTransfer: a confirmed transfer with no recorded time', () => {
  it('is judged as recorded after the hold: covers when it is still worth the agreed price', async () => {
    const price = reader('0.25');
    expect(await judgeAbtEthLateTransfer({ lock: lock(), priceRecordedAt: null, readPrice: price.readPrice })).toEqual({
      kind: 'covers',
      usdPerToken: '0.25',
    });
    expect(price.calls).toEqual([{ priceUsd: '20.00' }]);
  });

  it('is judged as recorded after the hold: short when it is worth less', async () => {
    const price = reader('0.20');
    expect(await judgeAbtEthLateTransfer({ lock: lock(), priceRecordedAt: null, readPrice: price.readPrice })).toEqual({
      kind: 'short',
      usdPerToken: '0.20',
      worthUsd: '16',
    });
  });

  it('treats a recorded time that is not a date the same way', async () => {
    const price = reader('0.20');
    expect(await judgeAbtEthLateTransfer({ lock: lock(), priceRecordedAt: 'not a time', readPrice: price.readPrice })).toEqual({
      kind: 'short',
      usdPerToken: '0.20',
      worthUsd: '16',
    });
  });
});
