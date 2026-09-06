// P3 / S1: the USDC payment rail (MISSION.md invariant 12). Driven against
// a fake chain client and a fake rate source; no test in this file ever
// reaches a real RPC (that happens once, live, outside `npm test`, per the
// card).
//
// S1 (this card): a settlement now binds to the transfer it claims, not to
// any confirmed hash. `getTransactionReceipt` carries the observed ERC-20
// Transfer log's own facts (recipient, value, token contract, chain id)
// alongside status, and `legStatus` checks all of them against what the
// job's leg actually expects before ever answering `confirmed`.
//
// The reference this rail is built to: the operator's wallet-test rig's
// usdc.cjs, verified 2026-09-04 on Arbitrum Sepolia against Circle test
// USDC. ERC-20 has no multi-output transfer: one payment leg is TWO
// separate `transfer` calls, price to the operator then fee to the
// platform, in that order.
import { describe, expect, it } from 'vitest';
import { createUsdcPaymentRail } from '../../../src/adapters/payment/usdc.js';
import type { UsdcChainClient, UsdcObservedTransfer } from '../../../src/adapters/payment/usdc.js';
import type { UsdcHalfPaidStorage } from '../../../src/adapters/payment/usdc-half-paid-storage-types.js';
import type { UsdcSpentTransferRow, UsdcSpentTransferStorage } from '../../../src/adapters/payment/usdc-spent-transfer-storage-types.js';
import { PaymentConfigError } from '../../../src/adapters/payment/types.js';
import { RateUnavailableError } from '../../../src/adapters/payment/types.js';

const TOKEN = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const OTHER_TOKEN = '0x99faf114eafb1BDbe2F0316DF893fd58CE46AA99';
const feeAddress = '0xFeeAddress000000000000000000000000000';
const operatorAddress = '0xOperator000000000000000000000000000000';
const strangerAddress = '0x3333333333333333333333333333333333333333';
const CHAIN_ID = 421614;
const OTHER_CHAIN_ID = 1;

// Amounts matching an onWalletResponse call with amountUsd '15.00' at a
// 1:1 rate and the 6 percent USDC fee: price 15 USDC, fee 0.90 USDC
// (6-decimal base units). Used by confirm()'s tests, which build refs
// through onWalletResponse's own math.
const PRICE_BASE_UNITS = '15000000';
const FEE_BASE_UNITS = '900000';
// createRequest takes amountToken/feeToken directly (no rate/fee
// derivation of its own): 15 USDC price, 1.2 USDC fee, at 6 decimals.
const CREATE_REQUEST_PRICE_BASE_UNITS = '15000000';
const CREATE_REQUEST_FEE_BASE_UNITS = '1200000';

function envConfig(): Record<string, string> {
  return {
    FREEAGENTS_USDC_RPC_URL: 'https://sepolia-rollup.arbitrum.io/rpc',
    FREEAGENTS_USDC_TOKEN_CONTRACT: TOKEN,
    FREEAGENTS_USDC_CHAIN_ID: String(CHAIN_ID),
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

  it("an explicit empty-string env var also fails closed (Blocklet Server materialises unset vars as '')", () => {
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
// receipts, so no test here ever constructs a real ethers Provider. The
// default receipt answers a landed transaction with no matching Transfer
// log, since the createRequest/onWalletResponse tests below only read
// decimals and never call confirm.
function fakeChainClient(overrides: Partial<UsdcChainClient> = {}): UsdcChainClient {
  return {
    decimals: overrides.decimals ?? (async () => 6),
    getTransactionReceipt: overrides.getTransactionReceipt ?? (async () => ({ status: 1, transfer: null })),
  };
}

// Builds a fake chain client keyed by hash, so a confirm() test can give
// each of the two legs' hashes its own observed receipt.
function chainClientByHash(
  byHash: Record<string, { readonly status: number | null; readonly transfer: UsdcObservedTransfer | null } | null>,
): UsdcChainClient {
  return {
    decimals: async () => 6,
    getTransactionReceipt: async (hash) => byHash[hash] ?? null,
  };
}

function transferPayingPrice(overrides: Partial<UsdcObservedTransfer> = {}): UsdcObservedTransfer {
  return { to: operatorAddress, value: PRICE_BASE_UNITS, tokenContract: TOKEN, chainId: CHAIN_ID, ...overrides };
}

function transferPayingFee(overrides: Partial<UsdcObservedTransfer> = {}): UsdcObservedTransfer {
  return { to: feeAddress, value: FEE_BASE_UNITS, tokenContract: TOKEN, chainId: CHAIN_ID, ...overrides };
}

describe('createUsdcPaymentRail: createRequest (two transfer intents, base units)', () => {
  it('builds two transfer intents in order: price to the operator, then fee to the platform', async () => {
    const chainClient = fakeChainClient();
    const rail = withEnv(envConfig(), () => createUsdcPaymentRail({ chainClient }));
    const request = await rail.createRequest({
      jobId: 'job_1',
      leg: 'deposit',
      operatorAddress,
      amountToken: '15',
      feeToken: '1.2',
    });

    expect(request.rail).toBe('usdc');
    expect(request.jobId).toBe('job_1');
    expect(request.leg).toBe('deposit');
    expect(request.chainId).toBe(CHAIN_ID);
    expect(request.transfers).toEqual([
      { recipient: operatorAddress, amountBaseUnits: CREATE_REQUEST_PRICE_BASE_UNITS, tokenContract: TOKEN },
      { recipient: feeAddress, amountBaseUnits: CREATE_REQUEST_FEE_BASE_UNITS, tokenContract: TOKEN },
    ]);
  });

  it('reads decimals from the contract rather than assuming 6 (mutation proof: a token at a different precision converts differently)', async () => {
    const chainClient = fakeChainClient({ decimals: async () => 18 });
    const rail = withEnv(envConfig(), () => createUsdcPaymentRail({ chainClient }));
    const request = await rail.createRequest({
      jobId: 'job_1',
      leg: 'deposit',
      operatorAddress,
      amountToken: '15',
      feeToken: '1.2',
    });
    expect(request.transfers[0].amountBaseUnits).toBe('15000000000000000000');
    expect(request.transfers[1].amountBaseUnits).toBe('1200000000000000000');
  });
});

describe('createUsdcPaymentRail: onWalletResponse (builds the ref from what the wallet signed and the job\'s own price)', () => {
  it('carries the price hash and the fee hash through when both transfers were signed, and computes the expected base units from amountUsd', async () => {
    const rail = withEnv(envConfig(), () => createUsdcPaymentRail({ chainClient: fakeChainClient(), rateSource: async () => '1' }));
    const ref = await rail.onWalletResponse({
      rail: 'usdc',
      jobId: 'job_1',
      leg: 'deposit',
      operatorAddress,
      priceTxHash: '0xprice',
      feeTx: { signed: true, hash: '0xfee' },
      amountUsd: '15.00',
    });
    expect(ref.rail).toBe('usdc');
    expect(ref.jobId).toBe('job_1');
    expect(ref.leg).toBe('deposit');
    expect(ref.chainId).toBe(CHAIN_ID);
    expect(ref.tokenContract).toBe(TOKEN);
    expect(ref.operatorAddress).toBe(operatorAddress);
    expect(ref.feeAddress).toBe(feeAddress);
    expect(ref.priceTxHash).toBe('0xprice');
    expect(ref.feeTxHash).toBe('0xfee');
    expect(ref.expectedPriceBaseUnits).toBe(PRICE_BASE_UNITS);
    expect(ref.expectedFeeBaseUnits).toBe(FEE_BASE_UNITS);
  });

  it('carries a null fee hash through, never inventing one, when the wallet never signed the fee transfer', async () => {
    const rail = withEnv(envConfig(), () => createUsdcPaymentRail({ chainClient: fakeChainClient(), rateSource: async () => '1' }));
    const ref = await rail.onWalletResponse({
      rail: 'usdc',
      jobId: 'job_1',
      leg: 'deposit',
      operatorAddress,
      priceTxHash: '0xprice',
      feeTx: { signed: false },
      amountUsd: '15.00',
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

// A fake of the spent-transfer storage, stateful by hash: this is the S1
// mechanism under test, so it must actually remember what record() wrote
// (a fake that always answers null could never catch a reused hash).
function fakeSpentTransferStorage(): UsdcSpentTransferStorage {
  const rows = new Map<string, UsdcSpentTransferRow>();
  return {
    async record(row) {
      rows.set(row.hash, { ...row });
    },
    async findByHash(hash) {
      return rows.get(hash) ?? null;
    },
  };
}

function usdcRef(overrides: Partial<Parameters<ReturnType<typeof createUsdcPaymentRail>['confirm']>[0]> = {}) {
  return {
    rail: 'usdc' as const,
    jobId: 'job_1',
    leg: 'deposit' as const,
    chainId: CHAIN_ID,
    tokenContract: TOKEN,
    operatorAddress,
    feeAddress,
    priceTxHash: '0xprice',
    feeTxHash: '0xfee',
    expectedPriceBaseUnits: PRICE_BASE_UNITS,
    expectedFeeBaseUnits: FEE_BASE_UNITS,
    ...overrides,
  };
}

describe('createUsdcPaymentRail: confirm (both legs land, paying exactly what was expected)', () => {
  it('reports confirmed true, with each leg individually confirmed, when both receipts pay the expected recipient/amount/token/chain', async () => {
    const chainClient = chainClientByHash({
      '0xprice': { status: 1, transfer: transferPayingPrice() },
      '0xfee': { status: 1, transfer: transferPayingFee() },
    });
    const { storage } = fakeHalfPaidStorage();
    const rail = withEnv(envConfig(), () =>
      createUsdcPaymentRail({ chainClient, halfPaidStorage: storage, spentTransferStorage: fakeSpentTransferStorage() }),
    );

    const confirmation = await rail.confirm(usdcRef());

    expect(confirmation.rail).toBe('usdc');
    expect(confirmation.confirmed).toBe(true);
    expect(confirmation.halfPaid).toBe(false);
    expect(confirmation.legs?.price).toEqual({ status: 'confirmed', hash: '0xprice' });
    expect(confirmation.legs?.fee).toEqual({ status: 'confirmed', hash: '0xfee' });
  });

  it('reports confirmed false, not half-paid, when neither transfer has landed yet', async () => {
    const chainClient = chainClientByHash({ '0xprice': null, '0xfee': null });
    const { storage } = fakeHalfPaidStorage();
    const rail = withEnv(envConfig(), () =>
      createUsdcPaymentRail({ chainClient, halfPaidStorage: storage, spentTransferStorage: fakeSpentTransferStorage() }),
    );

    const confirmation = await rail.confirm(usdcRef());

    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.halfPaid).toBe(false);
    expect(confirmation.legs?.price).toEqual({ status: 'not_confirmed', hash: '0xprice' });
    expect(confirmation.legs?.fee).toEqual({ status: 'not_confirmed', hash: '0xfee' });
  });

  it('confirm is idempotent: calling it twice on the same ref answers identically both times', async () => {
    const chainClient = chainClientByHash({
      '0xprice': { status: 1, transfer: transferPayingPrice() },
      '0xfee': { status: 1, transfer: transferPayingFee() },
    });
    const { storage } = fakeHalfPaidStorage();
    const rail = withEnv(envConfig(), () =>
      createUsdcPaymentRail({ chainClient, halfPaidStorage: storage, spentTransferStorage: fakeSpentTransferStorage() }),
    );

    const first = await rail.confirm(usdcRef());
    const second = await rail.confirm(usdcRef());
    expect(first).toEqual(second);
  });
});

// S1: the anchor's four reproduced cases, each pinned as a mutation proof.
// Case A (wrong recipient/wrong job) is covered by the recipient test and
// the spent-hash tests below; Case B (wrong amount) by the amount tests;
// Case C (one receipt, many jobs) by the spent-hash tests; Case D (one
// hash, both legs) is refused at the route (tests/api/job-payment-usdc.test.ts),
// since it is a malformed request, not a chain observation.
describe('S1: legStatus binds a leg to the transfer it claims, not to any confirmed hash', () => {
  it('the positive control: a transfer paying the expected recipient, amount, token and chain confirms', async () => {
    const chainClient = chainClientByHash({ '0xprice': { status: 1, transfer: transferPayingPrice() } });
    const { storage } = fakeHalfPaidStorage();
    const rail = withEnv(envConfig(), () =>
      createUsdcPaymentRail({ chainClient, halfPaidStorage: storage, spentTransferStorage: fakeSpentTransferStorage() }),
    );
    const confirmation = await rail.confirm(usdcRef({ feeTxHash: null }));
    expect(confirmation.legs?.price).toEqual({ status: 'confirmed', hash: '0xprice' });
  });

  it('mutation proof: a transfer paying a DIFFERENT recipient does not confirm (Case A)', async () => {
    const chainClient = chainClientByHash({
      '0xprice': { status: 1, transfer: transferPayingPrice({ to: strangerAddress }) },
    });
    const { storage } = fakeHalfPaidStorage();
    const rail = withEnv(envConfig(), () =>
      createUsdcPaymentRail({ chainClient, halfPaidStorage: storage, spentTransferStorage: fakeSpentTransferStorage() }),
    );
    const confirmation = await rail.confirm(usdcRef({ feeTxHash: null }));
    expect(confirmation.legs?.price).toEqual({ status: 'mismatched', hash: '0xprice' });
    expect(confirmation.confirmed).toBe(false);
  });

  it('mutation proof: a transfer paying LESS than expected does not confirm (Case B, the underpayment direction a >= comparison would let through)', async () => {
    const chainClient = chainClientByHash({
      '0xprice': { status: 1, transfer: transferPayingPrice({ value: '10' }) },
    });
    const { storage } = fakeHalfPaidStorage();
    const rail = withEnv(envConfig(), () =>
      createUsdcPaymentRail({ chainClient, halfPaidStorage: storage, spentTransferStorage: fakeSpentTransferStorage() }),
    );
    const confirmation = await rail.confirm(usdcRef({ feeTxHash: null }));
    expect(confirmation.legs?.price).toEqual({ status: 'mismatched', hash: '0xprice' });
  });

  it('a transfer paying MORE than expected also does not confirm (the other direction of the amount check)', async () => {
    const chainClient = chainClientByHash({
      '0xprice': { status: 1, transfer: transferPayingPrice({ value: '999999999' }) },
    });
    const { storage } = fakeHalfPaidStorage();
    const rail = withEnv(envConfig(), () =>
      createUsdcPaymentRail({ chainClient, halfPaidStorage: storage, spentTransferStorage: fakeSpentTransferStorage() }),
    );
    const confirmation = await rail.confirm(usdcRef({ feeTxHash: null }));
    expect(confirmation.legs?.price).toEqual({ status: 'mismatched', hash: '0xprice' });
  });

  it('mutation proof: a transfer of a DIFFERENT token contract does not confirm', async () => {
    const chainClient = chainClientByHash({
      '0xprice': { status: 1, transfer: transferPayingPrice({ tokenContract: OTHER_TOKEN }) },
    });
    const { storage } = fakeHalfPaidStorage();
    const rail = withEnv(envConfig(), () =>
      createUsdcPaymentRail({ chainClient, halfPaidStorage: storage, spentTransferStorage: fakeSpentTransferStorage() }),
    );
    const confirmation = await rail.confirm(usdcRef({ feeTxHash: null }));
    expect(confirmation.legs?.price).toEqual({ status: 'mismatched', hash: '0xprice' });
  });

  it('mutation proof: a receipt read on a DIFFERENT chain id does not confirm', async () => {
    const chainClient = chainClientByHash({
      '0xprice': { status: 1, transfer: transferPayingPrice({ chainId: OTHER_CHAIN_ID }) },
    });
    const { storage } = fakeHalfPaidStorage();
    const rail = withEnv(envConfig(), () =>
      createUsdcPaymentRail({ chainClient, halfPaidStorage: storage, spentTransferStorage: fakeSpentTransferStorage() }),
    );
    const confirmation = await rail.confirm(usdcRef({ feeTxHash: null }));
    expect(confirmation.legs?.price).toEqual({ status: 'mismatched', hash: '0xprice' });
  });

  it('a receipt with no ERC-20 Transfer log at all does not confirm', async () => {
    const chainClient = chainClientByHash({ '0xprice': { status: 1, transfer: null } });
    const { storage } = fakeHalfPaidStorage();
    const rail = withEnv(envConfig(), () =>
      createUsdcPaymentRail({ chainClient, halfPaidStorage: storage, spentTransferStorage: fakeSpentTransferStorage() }),
    );
    const confirmation = await rail.confirm(usdcRef({ feeTxHash: null }));
    expect(confirmation.legs?.price).toEqual({ status: 'mismatched', hash: '0xprice' });
  });

  it('mutation proof: a hash already spent on another job does not confirm a second time (Case C)', async () => {
    const chainClient = chainClientByHash({ '0xprice': { status: 1, transfer: transferPayingPrice() } });
    const spentTransferStorage = fakeSpentTransferStorage();
    // Job 2 already spent this exact hash for its own deposit price leg.
    await spentTransferStorage.record({ hash: '0xprice', jobId: 'job_2', leg: 'deposit', role: 'price' });
    const { storage } = fakeHalfPaidStorage();
    const rail = withEnv(envConfig(), () =>
      createUsdcPaymentRail({ chainClient, halfPaidStorage: storage, spentTransferStorage }),
    );
    const confirmation = await rail.confirm(usdcRef({ jobId: 'job_1', feeTxHash: null }));
    expect(confirmation.legs?.price).toEqual({ status: 'mismatched', hash: '0xprice' });
  });

  it('a hash already spent on a DIFFERENT LEG of the same job does not confirm the other leg', async () => {
    const chainClient = chainClientByHash({ '0xprice': { status: 1, transfer: transferPayingPrice() } });
    const spentTransferStorage = fakeSpentTransferStorage();
    await spentTransferStorage.record({ hash: '0xprice', jobId: 'job_1', leg: 'balance', role: 'price' });
    const { storage } = fakeHalfPaidStorage();
    const rail = withEnv(envConfig(), () =>
      createUsdcPaymentRail({ chainClient, halfPaidStorage: storage, spentTransferStorage }),
    );
    const confirmation = await rail.confirm(usdcRef({ jobId: 'job_1', leg: 'deposit', feeTxHash: null }));
    expect(confirmation.legs?.price).toEqual({ status: 'mismatched', hash: '0xprice' });
  });

  it('a hash already spent under the OTHER ROLE (fee) does not confirm as a price leg', async () => {
    const chainClient = chainClientByHash({ '0xprice': { status: 1, transfer: transferPayingPrice() } });
    const spentTransferStorage = fakeSpentTransferStorage();
    await spentTransferStorage.record({ hash: '0xprice', jobId: 'job_1', leg: 'deposit', role: 'fee' });
    const { storage } = fakeHalfPaidStorage();
    const rail = withEnv(envConfig(), () =>
      createUsdcPaymentRail({ chainClient, halfPaidStorage: storage, spentTransferStorage }),
    );
    const confirmation = await rail.confirm(usdcRef({ jobId: 'job_1', leg: 'deposit', feeTxHash: null }));
    expect(confirmation.legs?.price).toEqual({ status: 'mismatched', hash: '0xprice' });
  });

  it('re-confirming the SAME (job, leg, role) is idempotent and still confirms', async () => {
    const chainClient = chainClientByHash({ '0xprice': { status: 1, transfer: transferPayingPrice() } });
    const spentTransferStorage = fakeSpentTransferStorage();
    const { storage } = fakeHalfPaidStorage();
    const rail = withEnv(envConfig(), () =>
      createUsdcPaymentRail({ chainClient, halfPaidStorage: storage, spentTransferStorage }),
    );
    const first = await rail.confirm(usdcRef({ feeTxHash: null }));
    const second = await rail.confirm(usdcRef({ feeTxHash: null }));
    expect(first.legs?.price).toEqual({ status: 'confirmed', hash: '0xprice' });
    expect(second.legs?.price).toEqual({ status: 'confirmed', hash: '0xprice' });
  });

  it('mismatched is reported distinctly from not_confirmed, never collapsed into the same word', async () => {
    const chainClient = chainClientByHash({
      '0xprice': { status: 1, transfer: transferPayingPrice({ to: strangerAddress }) },
    });
    const { storage } = fakeHalfPaidStorage();
    const rail = withEnv(envConfig(), () =>
      createUsdcPaymentRail({ chainClient, halfPaidStorage: storage, spentTransferStorage: fakeSpentTransferStorage() }),
    );
    const confirmation = await rail.confirm(usdcRef({ feeTxHash: null }));
    expect(confirmation.legs?.price?.status).toBe('mismatched');
    expect(confirmation.legs?.price?.status).not.toBe('not_confirmed');
  });
});

describe('createUsdcPaymentRail: confirm fails closed on the half-paid state (the card\'s centre)', () => {
  it('price lands, fee does not: confirmed is false, both legs individually named, and the half-paid record is written', async () => {
    const chainClient = chainClientByHash({
      '0xprice': { status: 1, transfer: transferPayingPrice() },
      '0xfee': null,
    });
    const { storage, records } = fakeHalfPaidStorage();
    const rail = withEnv(envConfig(), () =>
      createUsdcPaymentRail({ chainClient, halfPaidStorage: storage, spentTransferStorage: fakeSpentTransferStorage() }),
    );

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
    const chainClient = chainClientByHash({
      '0xprice': null,
      '0xfee': { status: 1, transfer: transferPayingFee() },
    });
    const { storage, records } = fakeHalfPaidStorage();
    const rail = withEnv(envConfig(), () =>
      createUsdcPaymentRail({ chainClient, halfPaidStorage: storage, spentTransferStorage: fakeSpentTransferStorage() }),
    );

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
    const chainClient = chainClientByHash({ '0xprice': { status: 1, transfer: transferPayingPrice() } });
    const { storage, records } = fakeHalfPaidStorage();
    const rail = withEnv(envConfig(), () =>
      createUsdcPaymentRail({ chainClient, halfPaidStorage: storage, spentTransferStorage: fakeSpentTransferStorage() }),
    );

    const confirmation = await rail.confirm(usdcRef({ feeTxHash: null }));

    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.halfPaid).toBe(true);
    expect(confirmation.legs?.fee).toEqual({ status: 'not_signed' });
    expect(records[0]).toMatchObject({ feeTxHash: null, feeStatus: 'not_signed' });
  });

  it('a mismatched leg is not treated as confirmed by the half-paid comparison: a mismatched price with a confirmed fee is still not fully paid', async () => {
    const chainClient = chainClientByHash({
      '0xprice': { status: 1, transfer: transferPayingPrice({ to: strangerAddress }) },
      '0xfee': { status: 1, transfer: transferPayingFee() },
    });
    const { storage } = fakeHalfPaidStorage();
    const rail = withEnv(envConfig(), () =>
      createUsdcPaymentRail({ chainClient, halfPaidStorage: storage, spentTransferStorage: fakeSpentTransferStorage() }),
    );

    const confirmation = await rail.confirm(usdcRef());

    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.legs?.price?.status).toBe('mismatched');
    expect(confirmation.legs?.fee?.status).toBe('confirmed');
  });

  it('a late-landing fee transfer clears the stale half-paid record once both legs confirm (the ordinary case on a two-transaction rail)', async () => {
    let feeCalls = 0;
    const chainClient: UsdcChainClient = {
      decimals: async () => 6,
      getTransactionReceipt: async (hash) => {
        if (hash === '0xprice') return { status: 1, transfer: transferPayingPrice() };
        feeCalls += 1;
        // First poll: the wallet has not yet signed/landed the fee
        // transfer. Second poll: the buyer's second signature lands.
        return feeCalls === 1 ? null : { status: 1, transfer: transferPayingFee() };
      },
    };
    const { storage, read } = statefulHalfPaidStorage();
    const rail = withEnv(envConfig(), () =>
      createUsdcPaymentRail({ chainClient, halfPaidStorage: storage, spentTransferStorage: fakeSpentTransferStorage() }),
    );

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
