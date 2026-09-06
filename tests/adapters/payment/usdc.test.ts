// P3: the USDC payment rail (MISSION.md invariant 12). Driven against a
// fake chain client and a fake rate source; no test in this file ever
// reaches a real RPC (that happens once, live, outside `npm test`, per the
// card).
//
// The reference this rail is built to: the operator's wallet-test rig's
// usdc.cjs, verified 2026-09-04 on Arbitrum Sepolia against Circle test
// USDC. ERC-20 has no multi-output transfer: one payment leg is TWO
// separate `transfer` calls, price to the operator then fee to the
// platform, in that order.
import { describe, expect, it } from 'vitest';
import { createUsdcPaymentRail } from '../../../src/adapters/payment/usdc.js';
import type { UsdcChainClient } from '../../../src/adapters/payment/usdc.js';
import type { UsdcHalfPaidStorage } from '../../../src/adapters/payment/usdc-half-paid-storage-types.js';
import { PaymentConfigError } from '../../../src/adapters/payment/types.js';
import { RateUnavailableError } from '../../../src/adapters/payment/types.js';

const TOKEN = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const feeAddress = '0xFeeAddress000000000000000000000000000';

function envConfig(): Record<string, string> {
  return {
    FREEAGENTS_USDC_RPC_URL: 'https://sepolia-rollup.arbitrum.io/rpc',
    FREEAGENTS_USDC_TOKEN_CONTRACT: TOKEN,
    FREEAGENTS_USDC_CHAIN_ID: '421614',
    FREEAGENTS_USDC_FEE_ADDRESS: feeAddress,
  };
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    original[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

const ALL_USDC_ENV_KEYS = [
  'FREEAGENTS_USDC_RPC_URL',
  'FREEAGENTS_USDC_TOKEN_CONTRACT',
  'FREEAGENTS_USDC_CHAIN_ID',
  'FREEAGENTS_USDC_FEE_ADDRESS',
];

describe('createUsdcPaymentRail: fails closed on missing env', () => {
  it.each(ALL_USDC_ENV_KEYS)('rejects at construction when %s is absent', (missingKey) => {
    const config = envConfig();
    delete config[missingKey];
    withEnv({ ...Object.fromEntries(ALL_USDC_ENV_KEYS.map((k) => [k, undefined])), ...config }, () => {
      expect(() => createUsdcPaymentRail()).toThrow(PaymentConfigError);
    });
  });

  it('an explicit empty-string env var also fails closed (Blocklet Server materialises unset vars as \'\')', () => {
    withEnv({ ...envConfig(), FREEAGENTS_USDC_TOKEN_CONTRACT: '' }, () => {
      expect(() => createUsdcPaymentRail()).toThrow(PaymentConfigError);
    });
  });

  it('a non-numeric chain id fails closed rather than constructing with NaN', () => {
    withEnv({ ...envConfig(), FREEAGENTS_USDC_CHAIN_ID: 'not-a-number' }, () => {
      expect(() => createUsdcPaymentRail()).toThrow(PaymentConfigError);
    });
  });

  it('constructs successfully once every env var is present', () => {
    withEnv(envConfig(), () => {
      expect(() => createUsdcPaymentRail()).not.toThrow();
    });
  });
});

describe('createUsdcPaymentRail: quote (injected rate source, no network)', () => {
  it('converts priceUsd to USDC at the injected rate and computes the 6 percent fee on top', async () => {
    const rail = withEnv(envConfig(), () => createUsdcPaymentRail({ rateSource: async () => '1' }));
    const quote = await rail.quote({ priceUsd: '20.00' });
    expect(quote.rail).toBe('usdc');
    expect(quote.amountToken).toBe('20');
    expect(quote.feeToken).toBe('1.2');
    expect(quote.rateSource.length).toBeGreaterThan(0);
  });

  it('the honest default rate is 1 (USDC is a dollar stablecoin) when no rateSource is injected', async () => {
    const rail = withEnv(envConfig(), () => createUsdcPaymentRail());
    const quote = await rail.quote({ priceUsd: '20.00' });
    expect(quote.amountToken).toBe('20');
  });

  it('rejects with RateUnavailableError when the rate source answers null, rather than quoting a stale number', async () => {
    const rail = withEnv(envConfig(), () => createUsdcPaymentRail({ rateSource: async () => null }));
    await expect(rail.quote({ priceUsd: '20.00' })).rejects.toBeInstanceOf(RateUnavailableError);
  });
});

// A fake of the one chain call createRequest/confirm need for decimals and
// receipts, so no test here ever constructs a real ethers Provider.
function fakeChainClient(overrides: Partial<UsdcChainClient> = {}): UsdcChainClient {
  return {
    decimals: overrides.decimals ?? (async () => 6),
    getTransactionReceipt: overrides.getTransactionReceipt ?? (async () => ({ status: 1 })),
  };
}

describe('createUsdcPaymentRail: createRequest (two transfer intents, base units)', () => {
  it('builds two transfer intents in order: price to the operator, then fee to the platform', async () => {
    const chainClient = fakeChainClient();
    const rail = withEnv(envConfig(), () => createUsdcPaymentRail({ chainClient }));
    const request = await rail.createRequest({
      jobId: 'job_1',
      leg: 'deposit',
      operatorAddress: '0xOperator000000000000000000000000000000',
      amountToken: '15',
      feeToken: '1.2',
    });

    expect(request.rail).toBe('usdc');
    expect(request.jobId).toBe('job_1');
    expect(request.leg).toBe('deposit');
    expect(request.chainId).toBe(421614);
    expect(request.transfers).toEqual([
      { recipient: '0xOperator000000000000000000000000000000', amountBaseUnits: '15000000', tokenContract: TOKEN },
      { recipient: feeAddress, amountBaseUnits: '1200000', tokenContract: TOKEN },
    ]);
  });

  it('reads decimals from the contract rather than assuming 6 (mutation proof: a token at a different precision converts differently)', async () => {
    const chainClient = fakeChainClient({ decimals: async () => 18 });
    const rail = withEnv(envConfig(), () => createUsdcPaymentRail({ chainClient }));
    const request = await rail.createRequest({
      jobId: 'job_1',
      leg: 'deposit',
      operatorAddress: '0xOperator000000000000000000000000000000',
      amountToken: '15',
      feeToken: '1.2',
    });
    expect(request.transfers[0].amountBaseUnits).toBe('15000000000000000000');
    expect(request.transfers[1].amountBaseUnits).toBe('1200000000000000000');
  });
});

describe('createUsdcPaymentRail: onWalletResponse (builds the ref from what the wallet signed)', () => {
  it('carries the price hash and the fee hash through when both transfers were signed', async () => {
    const rail = withEnv(envConfig(), () => createUsdcPaymentRail({ chainClient: fakeChainClient() }));
    const ref = await rail.onWalletResponse({
      rail: 'usdc',
      jobId: 'job_1',
      leg: 'deposit',
      operatorAddress: '0xOperator000000000000000000000000000000',
      priceTxHash: '0xprice',
      feeTx: { signed: true, hash: '0xfee' },
    });
    expect(ref.rail).toBe('usdc');
    expect(ref.jobId).toBe('job_1');
    expect(ref.leg).toBe('deposit');
    expect(ref.chainId).toBe(421614);
    expect(ref.tokenContract).toBe(TOKEN);
    expect(ref.operatorAddress).toBe('0xOperator000000000000000000000000000000');
    expect(ref.feeAddress).toBe(feeAddress);
    expect(ref.priceTxHash).toBe('0xprice');
    expect(ref.feeTxHash).toBe('0xfee');
  });

  it('carries a null fee hash through, never inventing one, when the wallet never signed the fee transfer', async () => {
    const rail = withEnv(envConfig(), () => createUsdcPaymentRail({ chainClient: fakeChainClient() }));
    const ref = await rail.onWalletResponse({
      rail: 'usdc',
      jobId: 'job_1',
      leg: 'deposit',
      operatorAddress: '0xOperator000000000000000000000000000000',
      priceTxHash: '0xprice',
      feeTx: { signed: false },
    });
    expect(ref.priceTxHash).toBe('0xprice');
    expect(ref.feeTxHash).toBeNull();
  });
});

// A fake of the half-paid storage, so confirm()'s tests never touch Prisma.
function fakeHalfPaidStorage(): { storage: UsdcHalfPaidStorage; records: unknown[] } {
  const records: unknown[] = [];
  return {
    records,
    storage: {
      async record(row) {
        records.push(row);
      },
      async read() {
        return null;
      },
      async clear() {
        // no-op: these tests only assert on what record() received.
      },
    },
  };
}

// A stateful fake keyed by (jobId, leg), mirroring the Prisma driver's own
// upsert-by-key semantics closely enough to prove a later clear() call
// actually removes a row a prior record() call wrote, not just that both
// calls happened (fakeHalfPaidStorage above only ever appends, so it cannot
// tell a stale row from a cleared one).
function statefulHalfPaidStorage(): {
  storage: UsdcHalfPaidStorage;
  read: (jobId: string, leg: 'deposit' | 'balance') => unknown;
} {
  const rows = new Map<string, unknown>();
  const key = (jobId: string, leg: string) => `${jobId}:${leg}`;
  return {
    read: (jobId, leg) => rows.get(key(jobId, leg)) ?? null,
    storage: {
      async record(row) {
        rows.set(key(row.jobId, row.leg), row);
      },
      async clear(jobId, leg) {
        rows.delete(key(jobId, leg));
      },
      async read(jobId, leg) {
        return (rows.get(key(jobId, leg)) as never) ?? null;
      },
    },
  };
}

function usdcRef(overrides: Partial<Parameters<ReturnType<typeof createUsdcPaymentRail>['confirm']>[0]> = {}) {
  return {
    rail: 'usdc' as const,
    jobId: 'job_1',
    leg: 'deposit' as const,
    chainId: 421614,
    tokenContract: TOKEN,
    operatorAddress: '0xOperator000000000000000000000000000000',
    feeAddress,
    priceTxHash: '0xprice',
    feeTxHash: '0xfee',
    ...overrides,
  };
}

describe('createUsdcPaymentRail: confirm (both legs land)', () => {
  it('reports confirmed true, with each leg individually confirmed, when both receipts have status 1', async () => {
    const chainClient = fakeChainClient({ getTransactionReceipt: async () => ({ status: 1 }) });
    const { storage } = fakeHalfPaidStorage();
    const rail = withEnv(envConfig(), () => createUsdcPaymentRail({ chainClient, halfPaidStorage: storage }));

    const confirmation = await rail.confirm(usdcRef());

    expect(confirmation.rail).toBe('usdc');
    expect(confirmation.confirmed).toBe(true);
    expect(confirmation.halfPaid).toBe(false);
    expect(confirmation.legs?.price).toEqual({ status: 'confirmed', hash: '0xprice' });
    expect(confirmation.legs?.fee).toEqual({ status: 'confirmed', hash: '0xfee' });
  });

  it('reports confirmed false, not half-paid, when neither transfer has landed yet', async () => {
    const chainClient = fakeChainClient({ getTransactionReceipt: async () => null });
    const { storage } = fakeHalfPaidStorage();
    const rail = withEnv(envConfig(), () => createUsdcPaymentRail({ chainClient, halfPaidStorage: storage }));

    const confirmation = await rail.confirm(usdcRef());

    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.halfPaid).toBe(false);
    expect(confirmation.legs?.price).toEqual({ status: 'not_confirmed', hash: '0xprice' });
    expect(confirmation.legs?.fee).toEqual({ status: 'not_confirmed', hash: '0xfee' });
  });

  it('confirm is idempotent: calling it twice on the same ref answers identically both times', async () => {
    const chainClient = fakeChainClient({ getTransactionReceipt: async () => ({ status: 1 }) });
    const { storage } = fakeHalfPaidStorage();
    const rail = withEnv(envConfig(), () => createUsdcPaymentRail({ chainClient, halfPaidStorage: storage }));

    const first = await rail.confirm(usdcRef());
    const second = await rail.confirm(usdcRef());
    expect(first).toEqual(second);
  });
});

describe('createUsdcPaymentRail: confirm fails closed on the half-paid state (the card\'s centre)', () => {
  it('price lands, fee does not: confirmed is false, both legs individually named, and the half-paid record is written', async () => {
    const chainClient = fakeChainClient({
      getTransactionReceipt: async (hash) => (hash === '0xprice' ? { status: 1 } : null),
    });
    const { storage, records } = fakeHalfPaidStorage();
    const rail = withEnv(envConfig(), () => createUsdcPaymentRail({ chainClient, halfPaidStorage: storage }));

    const confirmation = await rail.confirm(usdcRef());

    // MUTATION PROOF (P3 brief, "fail closed on the half-paid state"): a
    // half-paid settlement must never report `confirmed: true`.
    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.halfPaid).toBe(true);
    expect(confirmation.legs?.price).toEqual({ status: 'confirmed', hash: '0xprice' });
    expect(confirmation.legs?.fee).toEqual({ status: 'not_confirmed', hash: '0xfee' });
    expect(records).toEqual([
      {
        jobId: 'job_1',
        leg: 'deposit',
        priceTxHash: '0xprice',
        priceStatus: 'confirmed',
        feeTxHash: '0xfee',
        feeStatus: 'not_confirmed',
      },
    ]);
  });

  it('the inverse: fee lands, price does not, same treatment (never confirmed, both legs named, recorded)', async () => {
    const chainClient = fakeChainClient({
      getTransactionReceipt: async (hash) => (hash === '0xfee' ? { status: 1 } : null),
    });
    const { storage, records } = fakeHalfPaidStorage();
    const rail = withEnv(envConfig(), () => createUsdcPaymentRail({ chainClient, halfPaidStorage: storage }));

    const confirmation = await rail.confirm(usdcRef());

    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.halfPaid).toBe(true);
    expect(confirmation.legs?.price).toEqual({ status: 'not_confirmed', hash: '0xprice' });
    expect(confirmation.legs?.fee).toEqual({ status: 'confirmed', hash: '0xfee' });
    expect(records).toEqual([
      {
        jobId: 'job_1',
        leg: 'deposit',
        priceTxHash: '0xprice',
        priceStatus: 'not_confirmed',
        feeTxHash: '0xfee',
        feeStatus: 'confirmed',
      },
    ]);
  });

  it('the wallet never signed the fee transfer at all: not_signed, not not_confirmed, and this still counts as half-paid when price lands', async () => {
    const chainClient = fakeChainClient({
      getTransactionReceipt: async (hash) => (hash === '0xprice' ? { status: 1 } : null),
    });
    const { storage, records } = fakeHalfPaidStorage();
    const rail = withEnv(envConfig(), () => createUsdcPaymentRail({ chainClient, halfPaidStorage: storage }));

    const confirmation = await rail.confirm(usdcRef({ feeTxHash: null }));

    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.halfPaid).toBe(true);
    expect(confirmation.legs?.fee).toEqual({ status: 'not_signed' });
    expect(records[0]).toMatchObject({ feeTxHash: null, feeStatus: 'not_signed' });
  });

  it('a late-landing fee transfer clears the stale half-paid record once both legs confirm (the ordinary case on a two-transaction rail)', async () => {
    let feeCalls = 0;
    const chainClient = fakeChainClient({
      getTransactionReceipt: async (hash) => {
        if (hash === '0xprice') return { status: 1 };
        feeCalls += 1;
        // First poll: the wallet has not yet signed/landed the fee
        // transfer. Second poll: the buyer's second signature lands.
        return feeCalls === 1 ? null : { status: 1 };
      },
    });
    const { storage, read } = statefulHalfPaidStorage();
    const rail = withEnv(envConfig(), () => createUsdcPaymentRail({ chainClient, halfPaidStorage: storage }));

    const first = await rail.confirm(usdcRef());
    expect(first.confirmed).toBe(false);
    expect(first.halfPaid).toBe(true);
    expect(read('job_1', 'deposit')).toMatchObject({ priceStatus: 'confirmed', feeStatus: 'not_confirmed' });

    const second = await rail.confirm(usdcRef());
    expect(second.confirmed).toBe(true);
    expect(second.halfPaid).toBe(false);
    // The stale half-paid row must not survive a settlement that has since
    // fully confirmed: P4's state machine would otherwise read a half-paid
    // record for a job that is actually fully paid.
    expect(read('job_1', 'deposit')).toBeNull();
  });
});
