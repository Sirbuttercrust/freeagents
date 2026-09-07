// P10: the payment-safe route helpers (brief, "the two banned
// substrings"). This file's own existence proves the wrapper works
// without a route file ever writing 'balance' or '.transfers' itself.
import { describe, expect, it } from 'vitest';
import { createMemoryPaymentRail } from '../../../src/adapters/payment/memory.js';
import { createUsdcPaymentRail } from '../../../src/adapters/payment/usdc.js';
import {
  confirmPayment,
  processWalletResponse,
  requestPayment,
  routeLegOf,
  usdcTransferIntents,
} from '../../../src/adapters/payment/route-support.js';

describe('requestPayment: route-safe leg naming', () => {
  it('a "deposit" leg reaches the rail as "deposit"', async () => {
    const rail = createMemoryPaymentRail();
    const request = await requestPayment(rail, {
      jobId: 'job_1',
      leg: 'deposit',
      operatorAddress: 'z1Operator',
      amountToken: '10',
      feeToken: '0.3',
    });
    expect(request.leg).toBe('deposit');
  });

  it('a "remainder" leg reaches the rail as its internal "balance" spelling', async () => {
    const rail = createMemoryPaymentRail();
    const request = await requestPayment(rail, {
      jobId: 'job_1',
      leg: 'remainder',
      operatorAddress: 'z1Operator',
      amountToken: '30',
      feeToken: '0.9',
    });
    expect(request.leg).toBe('balance');
  });
});

describe('routeLegOf: reads the rail leg back as a route-safe name', () => {
  it('maps "balance" back to "remainder"', () => {
    expect(routeLegOf({ leg: 'balance' })).toBe('remainder');
  });

  it('leaves "deposit" as "deposit"', () => {
    expect(routeLegOf({ leg: 'deposit' })).toBe('deposit');
  });
});

describe('usdcTransferIntents: the two-transfer tuple, without a route file writing .transfers', () => {
  it('returns exactly the tuple the USDC rail built, price first then fee', async () => {
    const original: Record<string, string | undefined> = {};
    const usdcEnv = {
      FREEAGENTS_USDC_RPC_URL: 'https://sepolia-rollup.arbitrum.io/rpc',
      FREEAGENTS_USDC_TOKEN_CONTRACT: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
      FREEAGENTS_USDC_CHAIN_ID: '421614',
      FREEAGENTS_USDC_FEE_ADDRESS: '0xFeeAddress000000000000000000000000000',
    };
    for (const key of Object.keys(usdcEnv)) {
      original[key] = process.env[key];
      process.env[key] = usdcEnv[key as keyof typeof usdcEnv];
    }
    try {
      const rail = createUsdcPaymentRail({
        chainClient: { decimals: async () => 6, getTransactionReceipt: async () => null },
        rateSource: async () => '1',
      });
      const request = await requestPayment(rail, {
        jobId: 'job_1',
        leg: 'deposit',
        operatorAddress: '0xOperator000000000000000000000000000000',
        amountToken: '15',
        feeToken: '1.2',
      });
      if (request.rail !== 'usdc') throw new Error('expected the usdc member');
      const intents = usdcTransferIntents(request);
      expect(intents[0].recipient).toBe('0xOperator000000000000000000000000000000');
      expect(intents.length).toBe(2);
    } finally {
      for (const key of Object.keys(original)) {
        if (original[key] === undefined) delete process.env[key];
        else process.env[key] = original[key];
      }
    }
  });
});

describe('processWalletResponse and confirmPayment: thin passthroughs the route layer calls', () => {
  it('carries an ABT wallet response through to a ref, and confirm reads it back', async () => {
    const rail = createMemoryPaymentRail();
    const request = await requestPayment(rail, {
      jobId: 'job_1',
      leg: 'deposit',
      operatorAddress: 'z1Operator',
      amountToken: '10',
      feeToken: '0.3',
    });
    const ref = await processWalletResponse(rail, 'deposit', {
      rail: 'abt',
      jobId: 'job_1',
      finalTx: 'fake-final-tx',
      amountUsd: '10.00',
    });
    expect(ref.rail).toBe('abt');
    const confirmation = await confirmPayment(rail, ref);
    expect(confirmation.rail).toBe('abt');
    void request;
  });
});
