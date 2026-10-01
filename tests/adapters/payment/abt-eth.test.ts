// The ABT-on-Ethereum payment rail: ABT as the ERC-20 token on Ethereum
// mainnet, paid from a browser wallet as two transfers (price to the owner,
// fee to the platform). Driven against a fake chain client, a fake price
// feed and in-memory storage; no test in this file reaches a network.
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The generated Prisma client is stubbed for the one block at the bottom
// that runs the rail on its default storage: it records which table each
// call reached. Every other test injects in-memory storage and never
// touches this.
const db = vi.hoisted(() => {
  const delegate = () => ({ upsert: vi.fn(), findUnique: vi.fn(), deleteMany: vi.fn() });
  return {
    abtEthSpentTransfer: delegate(),
    abtEthHalfPaidSettlement: delegate(),
    usdcSpentTransfer: delegate(),
    usdcHalfPaidSettlement: delegate(),
  };
});
vi.mock('../../../src/generated/prisma/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/generated/prisma/index.js')>(
    '../../../src/generated/prisma/index.js',
  );
  return {
    PrismaClient: class {
      abtEthSpentTransfer = db.abtEthSpentTransfer;
      abtEthHalfPaidSettlement = db.abtEthHalfPaidSettlement;
      usdcSpentTransfer = db.usdcSpentTransfer;
      usdcHalfPaidSettlement = db.usdcHalfPaidSettlement;
    },
    Prisma: actual.Prisma,
  };
});
import { createAbtEthPaymentRail, readAbtEthEnvConfig } from '../../../src/adapters/payment/abt-eth.js';
import type { Erc20ChainClient, Erc20ObservedTransfer } from '../../../src/adapters/payment/erc20.js';
import { PaymentConfigError, RateUnavailableError } from '../../../src/adapters/payment/types.js';
import type { RateReading } from '../../../src/adapters/payment/types.js';
import type { UsdcHalfPaidRow, UsdcHalfPaidStorage } from '../../../src/adapters/payment/usdc-half-paid-storage-types.js';
import type {
  UsdcSpentTransferRow,
  UsdcSpentTransferStorage,
} from '../../../src/adapters/payment/usdc-spent-transfer-storage-types.js';
import { createUsdcPaymentRail } from '../../../src/adapters/payment/usdc.js';

const ABT_TOKEN = '0xB98d4C97425d9908E66E53A6fDf673ACcA0BE986';
const USDC_TOKEN = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const FEE_ADDRESS = '0x2222222222222222222222222222222222222222';
const OWNER = '0x1111111111111111111111111111111111111111';
const STRANGER = '0x3333333333333333333333333333333333333333';
const CHAIN_ID = 1;
const ARBITRUM_CHAIN_ID = 42161;
const PRICE_HASH = '0xaaaa000000000000000000000000000000000000000000000000000000000001';
const FEE_HASH = '0xbbbb000000000000000000000000000000000000000000000000000000000002';

const ALL_KEYS = [
  'FREEAGENTS_ABT_ETH_RPC_URL',
  'FREEAGENTS_ABT_ETH_TOKEN_CONTRACT',
  'FREEAGENTS_ABT_ETH_CHAIN_ID',
  'FREEAGENTS_ABT_ETH_FEE_ADDRESS',
];

function envConfig(): Record<string, string> {
  return {
    FREEAGENTS_ABT_ETH_RPC_URL: 'https://rpc.example.test',
    FREEAGENTS_ABT_ETH_TOKEN_CONTRACT: ABT_TOKEN,
    FREEAGENTS_ABT_ETH_CHAIN_ID: String(CHAIN_ID),
    FREEAGENTS_ABT_ETH_FEE_ADDRESS: FEE_ADDRESS,
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

const NO_ENV = Object.fromEntries(ALL_KEYS.map((key) => [key, undefined]));

const FEED_TIME = new Date('2026-10-01T12:00:00.000Z');
const READING: RateReading = { usdPerToken: '0.25', updatedAt: FEED_TIME };

function memorySpent(): UsdcSpentTransferStorage & { rows: Map<string, UsdcSpentTransferRow> } {
  const rows = new Map<string, UsdcSpentTransferRow>();
  return {
    rows,
    async record(row) {
      rows.set(row.hash, row);
    },
    async findByHash(hash) {
      return rows.get(hash) ?? null;
    },
  };
}

function memoryHalfPaid(): UsdcHalfPaidStorage & { rows: Map<string, UsdcHalfPaidRow> } {
  const rows = new Map<string, UsdcHalfPaidRow>();
  return {
    rows,
    async record(row) {
      rows.set(`${row.jobId}:${row.leg}`, row);
    },
    async read(jobId, leg) {
      return rows.get(`${jobId}:${leg}`) ?? null;
    },
    async clear(jobId, leg) {
      rows.delete(`${jobId}:${leg}`);
    },
  };
}

type Receipt = { readonly status: number | null; readonly transfer: Erc20ObservedTransfer | null } | null;

function chainClient(byHash: Record<string, Receipt> = {}, decimals = 18): Erc20ChainClient {
  const normalized = new Map(Object.entries(byHash).map(([hash, receipt]) => [hash.toLowerCase(), receipt]));
  return {
    decimals: async () => decimals,
    getTransactionReceipt: async (hash) => normalized.get(hash.toLowerCase()) ?? null,
  };
}

interface Built {
  readonly rail: ReturnType<typeof createAbtEthPaymentRail>;
  readonly spent: ReturnType<typeof memorySpent>;
  readonly halfPaid: ReturnType<typeof memoryHalfPaid>;
}

function build(
  options: {
    readonly client?: Erc20ChainClient;
    readonly rateSource?: () => Promise<RateReading | null>;
    readonly spent?: ReturnType<typeof memorySpent>;
    readonly halfPaid?: ReturnType<typeof memoryHalfPaid>;
  } = {},
): Built {
  const spent = options.spent ?? memorySpent();
  const halfPaid = options.halfPaid ?? memoryHalfPaid();
  const rail = withEnv(envConfig(), () =>
    createAbtEthPaymentRail({
      chainClient: options.client ?? chainClient(),
      rateSource: options.rateSource ?? (async () => READING),
      spentTransferStorage: spent,
      halfPaidStorage: halfPaid,
    }),
  );
  return { rail, spent, halfPaid };
}

// Locked amounts for a leg: 80 ABT to the owner and 2.4 ABT of fee (3
// percent of $20.00 at $0.25 per ABT), 18-decimal base units.
const LOCKED_AMOUNT = '80';
const LOCKED_FEE = '2.4';
const PRICE_UNITS = '80000000000000000000';
const FEE_UNITS = '2400000000000000000';

function priceTransfer(overrides: Partial<Erc20ObservedTransfer> = {}): Erc20ObservedTransfer {
  return { to: OWNER, value: PRICE_UNITS, tokenContract: ABT_TOKEN, chainId: CHAIN_ID, ...overrides };
}

function feeTransfer(overrides: Partial<Erc20ObservedTransfer> = {}): Erc20ObservedTransfer {
  return { to: FEE_ADDRESS, value: FEE_UNITS, tokenContract: ABT_TOKEN, chainId: CHAIN_ID, ...overrides };
}

const walletInput = {
  rail: 'abt_eth' as const,
  jobId: 'job_1',
  leg: 'deposit' as const,
  operatorAddress: OWNER,
  priceTxHash: PRICE_HASH,
  feeTx: { signed: true as const, hash: FEE_HASH },
  amountToken: LOCKED_AMOUNT,
  feeToken: LOCKED_FEE,
};

describe('readAbtEthEnvConfig: fails closed before any network call', () => {
  it('names every missing variable in one PaymentConfigError', () => {
    withEnv(NO_ENV, () => {
      expect(() => readAbtEthEnvConfig()).toThrow(
        new PaymentConfigError(
          'abt_eth payment rail: missing env var(s): FREEAGENTS_ABT_ETH_RPC_URL, FREEAGENTS_ABT_ETH_TOKEN_CONTRACT, FREEAGENTS_ABT_ETH_CHAIN_ID, FREEAGENTS_ABT_ETH_FEE_ADDRESS',
        ),
      );
    });
  });

  it.each(ALL_KEYS)('names %s alone when it is the only one missing', (missingKey) => {
    const config = envConfig();
    delete config[missingKey];
    withEnv({ ...NO_ENV, ...config }, () => {
      expect(() => readAbtEthEnvConfig()).toThrow(
        new PaymentConfigError(`abt_eth payment rail: missing env var(s): ${missingKey}`),
      );
    });
  });

  it("treats an explicit empty string as missing (a deployment delivers unset variables as '')", () => {
    withEnv({ ...envConfig(), FREEAGENTS_ABT_ETH_TOKEN_CONTRACT: '' }, () => {
      expect(() => readAbtEthEnvConfig()).toThrow(
        new PaymentConfigError('abt_eth payment rail: missing env var(s): FREEAGENTS_ABT_ETH_TOKEN_CONTRACT'),
      );
    });
  });

  it('refuses a chain id that is not a positive integer', () => {
    withEnv({ ...envConfig(), FREEAGENTS_ABT_ETH_CHAIN_ID: 'mainnet' }, () => {
      expect(() => readAbtEthEnvConfig()).toThrow(
        new PaymentConfigError('abt_eth payment rail: FREEAGENTS_ABT_ETH_CHAIN_ID must be a positive integer, got "mainnet"'),
      );
    });
  });

  it('answers the four values once all are set', () => {
    withEnv(envConfig(), () => {
      expect(readAbtEthEnvConfig()).toEqual({
        rpcUrl: 'https://rpc.example.test',
        tokenContract: ABT_TOKEN,
        chainId: CHAIN_ID,
        feeAddress: FEE_ADDRESS,
      });
    });
  });

  it('createAbtEthPaymentRail throws the same error before it builds a chain client', () => {
    withEnv(NO_ENV, () => {
      expect(() => createAbtEthPaymentRail()).toThrow(PaymentConfigError);
    });
  });
});

describe('quote: the CoinGecko price, with the fee at 3 percent', () => {
  it('converts the price at the injected reading and adds a 3 percent fee, not the 6 percent USDC pays', async () => {
    const { rail } = build();
    expect(await rail.quote({ priceUsd: '20.00' })).toEqual({
      rail: 'abt_eth',
      priceUsd: '20.00',
      amountToken: LOCKED_AMOUNT,
      feeToken: LOCKED_FEE,
      rateSource: 'CoinGecko (dollars per ABT: 0.25, updated 2026-10-01T12:00:00.000Z)',
      usdPerToken: '0.25',
      rateUpdatedAt: FEED_TIME,
    });
  });

  it('throws RateUnavailableError naming abt_eth when the feed answers nothing', async () => {
    const { rail } = build({ rateSource: async () => null });
    await expect(rail.quote({ priceUsd: '20.00' })).rejects.toThrow(
      new RateUnavailableError('abt_eth'),
    );
    await expect(rail.quote({ priceUsd: '20.00' })).rejects.toThrow('no rate is available for rail "abt_eth"');
  });
});

describe('createRequest: two transfers in base units read from the contract', () => {
  it('builds the price transfer to the owner, then the fee transfer to the platform, on chain 1 and the ABT contract', async () => {
    const { rail } = build();
    expect(
      await rail.createRequest({
        jobId: 'job_1',
        leg: 'deposit',
        operatorAddress: OWNER,
        amountToken: LOCKED_AMOUNT,
        feeToken: LOCKED_FEE,
      }),
    ).toEqual({
      rail: 'abt_eth',
      jobId: 'job_1',
      leg: 'deposit',
      chainId: CHAIN_ID,
      transfers: [
        { recipient: OWNER, amountBaseUnits: PRICE_UNITS, tokenContract: ABT_TOKEN },
        { recipient: FEE_ADDRESS, amountBaseUnits: FEE_UNITS, tokenContract: ABT_TOKEN },
      ],
    });
  });

  it('converts with the decimals the contract reports: a token at 6 decimals gives different base units than at 18', async () => {
    const { rail } = build({ client: chainClient({}, 6) });
    const request = await rail.createRequest({
      jobId: 'job_1',
      leg: 'deposit',
      operatorAddress: OWNER,
      amountToken: LOCKED_AMOUNT,
      feeToken: LOCKED_FEE,
    });
    expect(request.transfers).toEqual([
      { recipient: OWNER, amountBaseUnits: '80000000', tokenContract: ABT_TOKEN },
      { recipient: FEE_ADDRESS, amountBaseUnits: '2400000', tokenContract: ABT_TOKEN },
    ]);
  });
});

describe('decimals are read off the contract on every call, not once per rail', () => {
  it('createRequest and onWalletResponse each answer with the decimals the contract reports at that moment', async () => {
    let decimals = 18;
    const { rail } = build({
      client: { decimals: async () => decimals, getTransactionReceipt: async () => null },
    });
    const requestInput = {
      jobId: 'job_1',
      leg: 'deposit' as const,
      operatorAddress: OWNER,
      amountToken: LOCKED_AMOUNT,
      feeToken: LOCKED_FEE,
    };

    const requestAtEighteen = await rail.createRequest(requestInput);
    const refAtEighteen = await rail.onWalletResponse(walletInput);
    decimals = 6;
    const requestAtSix = await rail.createRequest(requestInput);
    const refAtSix = await rail.onWalletResponse(walletInput);

    expect(requestAtEighteen.transfers.map((t) => t.amountBaseUnits)).toEqual([PRICE_UNITS, FEE_UNITS]);
    expect(requestAtSix.transfers.map((t) => t.amountBaseUnits)).toEqual(['80000000', '2400000']);
    expect([refAtEighteen.expectedPriceBaseUnits, refAtEighteen.expectedFeeBaseUnits]).toEqual([PRICE_UNITS, FEE_UNITS]);
    expect([refAtSix.expectedPriceBaseUnits, refAtSix.expectedFeeBaseUnits]).toEqual(['80000000', '2400000']);
  });
});

describe('onWalletResponse: binds confirm to the amounts that were locked, never a re-quote', () => {
  it('turns the locked token amounts into the base units confirm checks, and reads no rate', async () => {
    let rateReads = 0;
    const { rail } = build({
      rateSource: async () => {
        rateReads += 1;
        return READING;
      },
    });
    const ref = await rail.onWalletResponse(walletInput);
    expect(rateReads).toBe(0);
    expect(ref).toEqual({
      rail: 'abt_eth',
      jobId: 'job_1',
      leg: 'deposit',
      chainId: CHAIN_ID,
      tokenContract: ABT_TOKEN,
      operatorAddress: OWNER,
      feeAddress: FEE_ADDRESS,
      priceTxHash: PRICE_HASH,
      feeTxHash: FEE_HASH,
      expectedPriceBaseUnits: PRICE_UNITS,
      expectedFeeBaseUnits: FEE_UNITS,
    });
  });

  it('keeps the locked amounts when the feed would now answer a different price', async () => {
    let usdPerToken = '0.25';
    let rateReads = 0;
    const { rail } = build({
      client: chainClient({
        [PRICE_HASH]: { status: 1, transfer: priceTransfer() },
        [FEE_HASH]: { status: 1, transfer: feeTransfer() },
      }),
      rateSource: async () => {
        rateReads += 1;
        return { usdPerToken, updatedAt: FEED_TIME };
      },
    });
    const quote = await rail.quote({ priceUsd: '20.00' });
    expect(rateReads).toBe(1);
    usdPerToken = '0.50';
    const ref = await rail.onWalletResponse({ ...walletInput, amountToken: quote.amountToken, feeToken: quote.feeToken });
    const confirmation = await rail.confirm(ref);
    expect(rateReads).toBe(1);
    expect(ref.expectedPriceBaseUnits).toBe(PRICE_UNITS);
    expect(ref.expectedFeeBaseUnits).toBe(FEE_UNITS);
    expect(confirmation.confirmed).toBe(true);
  });

  it('converts the locked amounts with the decimals the contract reports, not an assumed 18', async () => {
    const { rail } = build({ client: chainClient({}, 6) });
    const ref = await rail.onWalletResponse(walletInput);
    expect(ref.expectedPriceBaseUnits).toBe('80000000');
    expect(ref.expectedFeeBaseUnits).toBe('2400000');
  });

  it('carries a null fee hash when the wallet never signed the fee transfer, and lower-cases both hashes', async () => {
    const { rail } = build();
    const unsigned = await rail.onWalletResponse({ ...walletInput, feeTx: { signed: false } });
    expect(unsigned.feeTxHash).toBeNull();
    const shouted = await rail.onWalletResponse({
      ...walletInput,
      priceTxHash: PRICE_HASH.toUpperCase().replace('0X', '0x'),
      feeTx: { signed: true, hash: FEE_HASH.toUpperCase().replace('0X', '0x') },
    });
    expect(shouted.priceTxHash).toBe(PRICE_HASH);
    expect(shouted.feeTxHash).toBe(FEE_HASH);
  });
});

describe('confirm: only an ABT transfer on chain 1 to the right recipient', () => {
  async function confirmWith(receipts: Record<string, Receipt>, options: { spent?: ReturnType<typeof memorySpent>; halfPaid?: ReturnType<typeof memoryHalfPaid> } = {}) {
    const built = build({ client: chainClient(receipts), ...options });
    const ref = await built.rail.onWalletResponse(walletInput);
    return { ...built, ref, confirmation: await built.rail.confirm(ref) };
  }

  it('confirms two matching transfers and answers the whole confirmation', async () => {
    const { confirmation } = await confirmWith({
      [PRICE_HASH]: { status: 1, transfer: priceTransfer() },
      [FEE_HASH]: { status: 1, transfer: feeTransfer() },
    });
    expect(confirmation).toEqual({
      rail: 'abt_eth',
      hash: PRICE_HASH,
      confirmed: true,
      legs: { price: { status: 'confirmed', hash: PRICE_HASH }, fee: { status: 'confirmed', hash: FEE_HASH } },
      halfPaid: false,
    });
  });

  it('answers mismatched for the right amount read on Arbitrum (chain 42161)', async () => {
    const { confirmation } = await confirmWith({
      [PRICE_HASH]: { status: 1, transfer: priceTransfer({ chainId: ARBITRUM_CHAIN_ID }) },
      [FEE_HASH]: { status: 1, transfer: feeTransfer() },
    });
    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.legs?.price).toEqual({ status: 'mismatched', hash: PRICE_HASH });
  });

  it('answers mismatched for a transfer of the USDC contract', async () => {
    const { confirmation } = await confirmWith({
      [PRICE_HASH]: { status: 1, transfer: priceTransfer({ tokenContract: USDC_TOKEN }) },
      [FEE_HASH]: { status: 1, transfer: feeTransfer() },
    });
    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.legs?.price).toEqual({ status: 'mismatched', hash: PRICE_HASH });
  });

  it('answers mismatched for the right amount sent to the wrong recipient', async () => {
    const { confirmation } = await confirmWith({
      [PRICE_HASH]: { status: 1, transfer: priceTransfer({ to: STRANGER }) },
      [FEE_HASH]: { status: 1, transfer: feeTransfer() },
    });
    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.legs?.price).toEqual({ status: 'mismatched', hash: PRICE_HASH });
  });

  it('answers mismatched for a fee transfer to the owner instead of the platform fee address', async () => {
    const { confirmation } = await confirmWith({
      [PRICE_HASH]: { status: 1, transfer: priceTransfer() },
      [FEE_HASH]: { status: 1, transfer: feeTransfer({ to: OWNER }) },
    });
    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.legs?.fee).toEqual({ status: 'mismatched', hash: FEE_HASH });
  });

  it('answers mismatched when the price transfer pays one base unit less than the locked amount', async () => {
    const { confirmation } = await confirmWith({
      [PRICE_HASH]: { status: 1, transfer: priceTransfer({ value: '79999999999999999999' }) },
      [FEE_HASH]: { status: 1, transfer: feeTransfer() },
    });
    expect(confirmation.legs?.price).toEqual({ status: 'mismatched', hash: PRICE_HASH });
  });

  it('refuses a hash already spent on another job', async () => {
    const spent = memorySpent();
    await spent.record({ hash: PRICE_HASH, jobId: 'job_other', leg: 'deposit', role: 'price' });
    const { confirmation } = await confirmWith(
      {
        [PRICE_HASH]: { status: 1, transfer: priceTransfer() },
        [FEE_HASH]: { status: 1, transfer: feeTransfer() },
      },
      { spent },
    );
    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.legs?.price).toEqual({ status: 'mismatched', hash: PRICE_HASH });
    expect(spent.rows.get(PRICE_HASH)).toEqual({ hash: PRICE_HASH, jobId: 'job_other', leg: 'deposit', role: 'price' });
  });

  it('a hash recorded as a USDC leg on Arbitrum does not stop the same hash string confirming on this rail (the wiring to separate tables is pinned in the default storage test below)', async () => {
    const usdcSpent = memorySpent();
    const usdcRail = withEnv(
      {
        FREEAGENTS_USDC_RPC_URL: 'https://arb.example.test',
        FREEAGENTS_USDC_TOKEN_CONTRACT: USDC_TOKEN,
        FREEAGENTS_USDC_CHAIN_ID: String(ARBITRUM_CHAIN_ID),
        FREEAGENTS_USDC_FEE_ADDRESS: FEE_ADDRESS,
      },
      () =>
        createUsdcPaymentRail({
          chainClient: {
            decimals: async () => 6,
            getTransactionReceipt: async () => ({
              status: 1,
              transfer: { to: OWNER, value: '20000000', tokenContract: USDC_TOKEN, chainId: ARBITRUM_CHAIN_ID },
            }),
          },
          spentTransferStorage: usdcSpent,
          halfPaidStorage: memoryHalfPaid(),
        }),
    );
    const usdcRef = await usdcRail.onWalletResponse({
      rail: 'usdc',
      jobId: 'job_usdc',
      leg: 'deposit',
      operatorAddress: OWNER,
      priceTxHash: PRICE_HASH,
      feeTx: { signed: false },
      amountUsd: '20.00',
    });
    await usdcRail.confirm(usdcRef);
    expect(usdcSpent.rows.get(PRICE_HASH)).toEqual({ hash: PRICE_HASH, jobId: 'job_usdc', leg: 'deposit', role: 'price' });

    const { confirmation, spent } = await confirmWith({
      [PRICE_HASH]: { status: 1, transfer: priceTransfer() },
      [FEE_HASH]: { status: 1, transfer: feeTransfer() },
    });
    expect(confirmation.confirmed).toBe(true);
    expect(spent.rows.get(PRICE_HASH)).toEqual({ hash: PRICE_HASH, jobId: 'job_1', leg: 'deposit', role: 'price' });
  });

  it('records a half-paid row when only the price landed, then clears it when the fee transfer lands', async () => {
    const halfPaid = memoryHalfPaid();
    const spent = memorySpent();
    const priceOnly = build({
      client: chainClient({ [PRICE_HASH]: { status: 1, transfer: priceTransfer() } }),
      spent,
      halfPaid,
    });
    const ref = await priceOnly.rail.onWalletResponse(walletInput);
    const first = await priceOnly.rail.confirm(ref);
    expect(first.confirmed).toBe(false);
    expect(first.halfPaid).toBe(true);
    expect(await priceOnly.rail.readHalfPaidRecord('job_1', 'deposit')).toEqual({
      priceTxHash: PRICE_HASH,
      priceStatus: 'confirmed',
      feeTxHash: FEE_HASH,
      feeStatus: 'not_confirmed',
    });

    const both = build({
      client: chainClient({
        [PRICE_HASH]: { status: 1, transfer: priceTransfer() },
        [FEE_HASH]: { status: 1, transfer: feeTransfer() },
      }),
      spent,
      halfPaid,
    });
    const second = await both.rail.confirm(ref);
    expect(second.confirmed).toBe(true);
    expect(second.halfPaid).toBe(false);
    expect(await both.rail.readHalfPaidRecord('job_1', 'deposit')).toBeNull();
  });

  it('answers not_signed for a fee the wallet never signed', async () => {
    const built = build({ client: chainClient({ [PRICE_HASH]: { status: 1, transfer: priceTransfer() } }) });
    const ref = await built.rail.onWalletResponse({ ...walletInput, feeTx: { signed: false } });
    const confirmation = await built.rail.confirm(ref);
    expect(confirmation.legs?.fee).toEqual({ status: 'not_signed' });
    expect(confirmation.halfPaid).toBe(true);
  });
});

describe('default storage: this rail writes its own tables and never the USDC ones', () => {
  beforeEach(() => {
    for (const table of Object.values(db)) {
      table.upsert.mockReset();
      table.findUnique.mockReset();
      table.deleteMany.mockReset();
    }
  });

  function expectNoUsdcTableTouched(): void {
    for (const usdcTable of [db.usdcSpentTransfer, db.usdcHalfPaidSettlement]) {
      expect(usdcTable.upsert).not.toHaveBeenCalled();
      expect(usdcTable.findUnique).not.toHaveBeenCalled();
      expect(usdcTable.deleteMany).not.toHaveBeenCalled();
    }
  }

  function defaultRail(receipts: Record<string, Receipt>) {
    return withEnv(envConfig(), () =>
      createAbtEthPaymentRail({ chainClient: chainClient(receipts), rateSource: async () => READING }),
    );
  }

  it('a half-paid confirm reads and writes AbtEthSpentTransfer and AbtEthHalfPaidSettlement, and touches no USDC table', async () => {
    db.abtEthSpentTransfer.findUnique.mockResolvedValue(null);
    const rail = defaultRail({ [PRICE_HASH]: { status: 1, transfer: priceTransfer() } });
    const ref = await rail.onWalletResponse(walletInput);
    const confirmation = await rail.confirm(ref);
    expect(confirmation.halfPaid).toBe(true);

    expect(db.abtEthSpentTransfer.findUnique).toHaveBeenCalledWith({ where: { hash: PRICE_HASH } });
    expect(db.abtEthSpentTransfer.upsert).toHaveBeenCalledWith({
      where: { hash: PRICE_HASH },
      create: { hash: PRICE_HASH, jobId: 'job_1', leg: 'deposit', role: 'price' },
      update: { jobId: 'job_1', leg: 'deposit', role: 'price' },
    });
    expect(db.abtEthHalfPaidSettlement.upsert).toHaveBeenCalledWith({
      where: { jobId_leg: { jobId: 'job_1', leg: 'deposit' } },
      create: { jobId: 'job_1', leg: 'deposit', priceTxHash: PRICE_HASH, priceStatus: 'confirmed', feeTxHash: FEE_HASH, feeStatus: 'not_confirmed' },
      update: { priceTxHash: PRICE_HASH, priceStatus: 'confirmed', feeTxHash: FEE_HASH, feeStatus: 'not_confirmed' },
    });
    expectNoUsdcTableTouched();
  });

  it('a fully confirmed leg clears its row in AbtEthHalfPaidSettlement and deletes nothing in the USDC table', async () => {
    db.abtEthSpentTransfer.findUnique.mockResolvedValue(null);
    const rail = defaultRail({
      [PRICE_HASH]: { status: 1, transfer: priceTransfer() },
      [FEE_HASH]: { status: 1, transfer: feeTransfer() },
    });
    const ref = await rail.onWalletResponse(walletInput);
    const confirmation = await rail.confirm(ref);
    expect(confirmation.confirmed).toBe(true);

    expect(db.abtEthHalfPaidSettlement.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.abtEthHalfPaidSettlement.deleteMany).toHaveBeenCalledWith({ where: { jobId: 'job_1', leg: 'deposit' } });
    expectNoUsdcTableTouched();
  });

  it('readHalfPaidRecord reads AbtEthHalfPaidSettlement by job and leg and returns the stored row', async () => {
    db.abtEthHalfPaidSettlement.findUnique.mockResolvedValue({
      jobId: 'job_1',
      leg: 'deposit',
      priceTxHash: PRICE_HASH,
      priceStatus: 'confirmed',
      feeTxHash: FEE_HASH,
      feeStatus: 'not_confirmed',
    });
    const record = await defaultRail({}).readHalfPaidRecord('job_1', 'deposit');

    expect(db.abtEthHalfPaidSettlement.findUnique).toHaveBeenCalledTimes(1);
    expect(db.abtEthHalfPaidSettlement.findUnique).toHaveBeenCalledWith({
      where: { jobId_leg: { jobId: 'job_1', leg: 'deposit' } },
    });
    expect(record).toEqual({
      priceTxHash: PRICE_HASH,
      priceStatus: 'confirmed',
      feeTxHash: FEE_HASH,
      feeStatus: 'not_confirmed',
    });
    expectNoUsdcTableTouched();
  });

  it('readHalfPaidRecord answers null when AbtEthHalfPaidSettlement has no row, and reads no USDC table', async () => {
    db.abtEthHalfPaidSettlement.findUnique.mockResolvedValue(null);
    expect(await defaultRail({}).readHalfPaidRecord('job_9', 'balance')).toBeNull();
    expect(db.abtEthHalfPaidSettlement.findUnique).toHaveBeenCalledWith({
      where: { jobId_leg: { jobId: 'job_9', leg: 'balance' } },
    });
    expectNoUsdcTableTouched();
  });
});
