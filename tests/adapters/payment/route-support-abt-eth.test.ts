// The ABT-on-Ethereum rail's two route helpers. They are the one place a
// route-safe leg ('remainder') becomes the rail's internal spelling.
import { describe, expect, it } from 'vitest';
import { createAbtEthPaymentRail } from '../../../src/adapters/payment/abt-eth.js';
import { abtEthHalfPaidRecordFor, processWalletResponse } from '../../../src/adapters/payment/route-support.js';
import type { UsdcHalfPaidRow, UsdcHalfPaidStorage } from '../../../src/adapters/payment/usdc-half-paid-storage-types.js';

const OWNER = '0x1111111111111111111111111111111111111111';
const FEE_ADDRESS = '0x2222222222222222222222222222222222222222';
const TOKEN = '0xB98d4C97425d9908E66E53A6fDf673ACcA0BE986';
const PRICE_HASH = '0xaaaa000000000000000000000000000000000000000000000000000000000001';
const FEE_HASH = '0xbbbb000000000000000000000000000000000000000000000000000000000002';

function halfPaidRows(): UsdcHalfPaidStorage {
  const rows = new Map<string, UsdcHalfPaidRow>();
  return {
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

function abtEthRail(halfPaidStorage: UsdcHalfPaidStorage = halfPaidRows()) {
  const env = {
    FREEAGENTS_ABT_ETH_RPC_URL: 'https://rpc.example.test',
    FREEAGENTS_ABT_ETH_TOKEN_CONTRACT: TOKEN,
    FREEAGENTS_ABT_ETH_CHAIN_ID: '1',
    FREEAGENTS_ABT_ETH_FEE_ADDRESS: FEE_ADDRESS,
  };
  const original: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    original[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return createAbtEthPaymentRail({
      chainClient: { decimals: async () => 18, getTransactionReceipt: async () => null, recordedAt: async () => null },
      rateSource: async () => ({ usdPerToken: '0.25', updatedAt: new Date('2026-10-01T12:00:00.000Z') }),
      halfPaidStorage,
      spentTransferStorage: { record: async () => {}, findByHash: async () => null },
    });
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const response = {
  rail: 'abt_eth' as const,
  jobId: 'job_1',
  operatorAddress: OWNER,
  priceTxHash: PRICE_HASH,
  feeTx: { signed: true as const, hash: FEE_HASH },
  amountToken: '80',
  feeToken: '2.4',
  quoteLockId: 'lock_1',
};

describe('the ABT-on-Ethereum route helpers: route-safe legs in, the rail internal spelling underneath', () => {
  it('processWalletResponse hands a remainder-leg response to the rail as its internal balance leg', async () => {
    expect(await processWalletResponse(abtEthRail(), 'remainder', response)).toEqual({
      rail: 'abt_eth',
      jobId: 'job_1',
      leg: 'balance',
      chainId: 1,
      tokenContract: TOKEN,
      operatorAddress: OWNER,
      feeAddress: FEE_ADDRESS,
      priceTxHash: PRICE_HASH,
      feeTxHash: FEE_HASH,
      expectedPriceBaseUnits: '80000000000000000000',
      expectedFeeBaseUnits: '2400000000000000000',
      quoteLockId: 'lock_1',
    });
  });

  it('processWalletResponse hands a deposit-leg response to the rail as deposit', async () => {
    expect(await processWalletResponse(abtEthRail(), 'deposit', response)).toEqual({
      rail: 'abt_eth',
      jobId: 'job_1',
      leg: 'deposit',
      chainId: 1,
      tokenContract: TOKEN,
      operatorAddress: OWNER,
      feeAddress: FEE_ADDRESS,
      priceTxHash: PRICE_HASH,
      feeTxHash: FEE_HASH,
      expectedPriceBaseUnits: '80000000000000000000',
      expectedFeeBaseUnits: '2400000000000000000',
      quoteLockId: 'lock_1',
    });
  });

  it('abtEthHalfPaidRecordFor reads the row of the internal balance leg when asked for the remainder', async () => {
    const storage = halfPaidRows();
    await storage.record({
      jobId: 'job_1',
      leg: 'balance',
      priceTxHash: PRICE_HASH,
      priceStatus: 'confirmed',
      feeTxHash: FEE_HASH,
      feeStatus: 'not_confirmed',
    });
    expect(await abtEthHalfPaidRecordFor(abtEthRail(storage), 'job_1', 'remainder')).toEqual({
      priceTxHash: PRICE_HASH,
      priceStatus: 'confirmed',
      feeTxHash: FEE_HASH,
      feeStatus: 'not_confirmed',
      lockId: null,
    });
    expect(await abtEthHalfPaidRecordFor(abtEthRail(storage), 'job_1', 'deposit')).toBeNull();
  });

  it('abtEthHalfPaidRecordFor answers null for a leg that was never half-paid', async () => {
    expect(await abtEthHalfPaidRecordFor(abtEthRail(), 'job_9', 'deposit')).toBeNull();
  });
});
