// The token-agnostic ERC-20 mechanism the USDC rail calls: the hash
// normaliser, the chain-id shape check, the per-leg binding (`legStatus`)
// and the two-leg confirm that records and clears a half-paid leg. Every
// check is pinned here once, against fakes, with the token contract and chain
// id passed in, so a second rail that calls erc20.ts needs no copy of these
// pins. No test reaches a network.
import { describe, expect, it } from 'vitest';
import {
  confirmLegs,
  isValidChainId,
  legStatus,
  normalizeTxHash,
  type Erc20ChainClient,
  type Erc20LegRef,
  type Erc20ObservedTransfer,
} from '../../../src/adapters/payment/erc20.js';
import type { UsdcHalfPaidRow, UsdcHalfPaidStorage } from '../../../src/adapters/payment/usdc-half-paid-storage-types.js';
import type {
  UsdcSpentTransferRow,
  UsdcSpentTransferStorage,
} from '../../../src/adapters/payment/usdc-spent-transfer-storage-types.js';

const TOKEN = '0xB98d4C97425d9908E66E53A6fDf673ACcA0BE986';
const OTHER_TOKEN = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const RECIPIENT = '0x1111111111111111111111111111111111111111';
const STRANGER = '0x3333333333333333333333333333333333333333';
const FEE_ADDRESS = '0x2222222222222222222222222222222222222222';
const CHAIN_ID = 1;
const PRICE_HASH = '0xaaaa000000000000000000000000000000000000000000000000000000000001';
const FEE_HASH = '0xbbbb000000000000000000000000000000000000000000000000000000000002';

function transfer(overrides: Partial<Erc20ObservedTransfer> = {}): Erc20ObservedTransfer {
  return { to: RECIPIENT, value: '15000000000000000000', tokenContract: TOKEN, chainId: CHAIN_ID, ...overrides };
}

function clientByHash(
  byHash: Record<string, { readonly status: number | null; readonly transfer: Erc20ObservedTransfer | null } | null>,
): Erc20ChainClient {
  const normalized = new Map(Object.entries(byHash).map(([hash, receipt]) => [hash.toLowerCase(), receipt]));
  return {
    decimals: async () => 18,
    getTransactionReceipt: async (hash) => normalized.get(hash.toLowerCase()) ?? null,
  };
}

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

const expected = {
  recipient: RECIPIENT,
  amountBaseUnits: '15000000000000000000',
  tokenContract: TOKEN,
  chainId: CHAIN_ID,
  jobId: 'job_1',
  leg: 'deposit' as const,
  role: 'price' as const,
};

describe('normalizeTxHash and isValidChainId', () => {
  it('lower-cases a hash, the one spelling every comparison uses', () => {
    expect(normalizeTxHash('0xABCDEF')).toBe('0xabcdef');
  });

  it.each([
    ['1', true],
    ['42161', true],
    ['0', false],
    ['-1', false],
    ['01', false],
    [' 1', false],
    ['1e3', false],
    ['abc', false],
    ['', false],
  ])('chain id %j is valid: %s', (raw, valid) => {
    expect(isValidChainId(raw)).toBe(valid);
  });
});

describe('legStatus binds a leg to the transfer it expects', () => {
  it('confirms a transfer of the right recipient, amount, token and chain, and records the hash as spent', async () => {
    const spent = memorySpent();
    const client = clientByHash({ [PRICE_HASH]: { status: 1, transfer: transfer() } });
    expect(await legStatus(client, spent, PRICE_HASH, expected)).toEqual({ status: 'confirmed', hash: PRICE_HASH });
    expect(spent.rows.get(PRICE_HASH)).toEqual({ hash: PRICE_HASH, jobId: 'job_1', leg: 'deposit', role: 'price' });
  });

  it('answers mismatched for a transfer to a different recipient', async () => {
    const client = clientByHash({ [PRICE_HASH]: { status: 1, transfer: transfer({ to: STRANGER }) } });
    expect(await legStatus(client, memorySpent(), PRICE_HASH, expected)).toEqual({ status: 'mismatched', hash: PRICE_HASH });
  });

  it('compares the recipient without case', async () => {
    const client = clientByHash({ [PRICE_HASH]: { status: 1, transfer: transfer({ to: RECIPIENT.toUpperCase().replace('0X', '0x') }) } });
    expect(await legStatus(client, memorySpent(), PRICE_HASH, expected)).toEqual({ status: 'confirmed', hash: PRICE_HASH });
  });

  it.each([['less', '14999999999999999999'], ['more', '15000000000000000001']])(
    'answers mismatched when the transfer pays %s than expected',
    async (_direction, value) => {
      const client = clientByHash({ [PRICE_HASH]: { status: 1, transfer: transfer({ value }) } });
      expect(await legStatus(client, memorySpent(), PRICE_HASH, expected)).toEqual({ status: 'mismatched', hash: PRICE_HASH });
    },
  );

  it('answers mismatched for a different token contract', async () => {
    const client = clientByHash({ [PRICE_HASH]: { status: 1, transfer: transfer({ tokenContract: OTHER_TOKEN }) } });
    expect(await legStatus(client, memorySpent(), PRICE_HASH, expected)).toEqual({ status: 'mismatched', hash: PRICE_HASH });
  });

  it('compares the token contract without case', async () => {
    const client = clientByHash({ [PRICE_HASH]: { status: 1, transfer: transfer({ tokenContract: TOKEN.toLowerCase() }) } });
    expect(await legStatus(client, memorySpent(), PRICE_HASH, expected)).toEqual({ status: 'confirmed', hash: PRICE_HASH });
  });

  it('answers mismatched for a receipt read on a different chain', async () => {
    const client = clientByHash({ [PRICE_HASH]: { status: 1, transfer: transfer({ chainId: 42161 }) } });
    expect(await legStatus(client, memorySpent(), PRICE_HASH, expected)).toEqual({ status: 'mismatched', hash: PRICE_HASH });
  });

  it('answers mismatched for a receipt with no Transfer log from the token', async () => {
    const client = clientByHash({ [PRICE_HASH]: { status: 1, transfer: null } });
    expect(await legStatus(client, memorySpent(), PRICE_HASH, expected)).toEqual({ status: 'mismatched', hash: PRICE_HASH });
  });

  it.each([
    ['no receipt yet', null],
    ['a reverted receipt', { status: 0, transfer: transfer() }],
    ['a receipt with no status', { status: null, transfer: transfer() }],
  ])('answers not_confirmed for %s', async (_label, receipt) => {
    const client = clientByHash({ [PRICE_HASH]: receipt });
    expect(await legStatus(client, memorySpent(), PRICE_HASH, expected)).toEqual({ status: 'not_confirmed', hash: PRICE_HASH });
  });

  it.each([
    ['another job', { jobId: 'job_2', leg: 'deposit' as const, role: 'price' as const }],
    ['another leg', { jobId: 'job_1', leg: 'balance' as const, role: 'price' as const }],
    ['the other role', { jobId: 'job_1', leg: 'deposit' as const, role: 'fee' as const }],
  ])('answers mismatched for a hash already spent on %s', async (_label, spentOn) => {
    const spent = memorySpent();
    await spent.record({ hash: PRICE_HASH, ...spentOn });
    const client = clientByHash({ [PRICE_HASH]: { status: 1, transfer: transfer() } });
    expect(await legStatus(client, spent, PRICE_HASH, expected)).toEqual({ status: 'mismatched', hash: PRICE_HASH });
  });

  it('refuses a spent hash presented again with different letter case', async () => {
    const spent = memorySpent();
    await spent.record({ hash: PRICE_HASH, jobId: 'job_2', leg: 'deposit', role: 'price' });
    const shouted = PRICE_HASH.toUpperCase().replace('0X', '0x');
    const client = clientByHash({ [PRICE_HASH]: { status: 1, transfer: transfer() } });
    expect(await legStatus(client, spent, shouted, expected)).toEqual({ status: 'mismatched', hash: PRICE_HASH });
  });

  it('re-confirming the same job, leg and role is idempotent', async () => {
    const spent = memorySpent();
    const client = clientByHash({ [PRICE_HASH]: { status: 1, transfer: transfer() } });
    await legStatus(client, spent, PRICE_HASH, expected);
    expect(await legStatus(client, spent, PRICE_HASH, expected)).toEqual({ status: 'confirmed', hash: PRICE_HASH });
  });
});

describe('confirmLegs: two transfers, one leg, half-paid recorded and cleared', () => {
  const ref: Erc20LegRef = {
    jobId: 'job_1',
    leg: 'deposit',
    chainId: CHAIN_ID,
    tokenContract: TOKEN,
    operatorAddress: RECIPIENT,
    feeAddress: FEE_ADDRESS,
    priceTxHash: PRICE_HASH,
    feeTxHash: FEE_HASH,
    expectedPriceBaseUnits: '15000000000000000000',
    expectedFeeBaseUnits: '450000000000000000',
  };
  const feeTransfer = transfer({ to: FEE_ADDRESS, value: '450000000000000000' });

  it('confirms when both transfers pay what the ref expects and leaves no half-paid row', async () => {
    const halfPaid = memoryHalfPaid();
    const client = clientByHash({
      [PRICE_HASH]: { status: 1, transfer: transfer() },
      [FEE_HASH]: { status: 1, transfer: feeTransfer },
    });
    expect(await confirmLegs(ref, client, memorySpent(), halfPaid)).toEqual({
      hash: PRICE_HASH,
      confirmed: true,
      legs: { price: { status: 'confirmed', hash: PRICE_HASH }, fee: { status: 'confirmed', hash: FEE_HASH } },
      halfPaid: false,
    });
    expect(halfPaid.rows.size).toBe(0);
  });

  it('records a half-paid row when only the price landed, then clears it when the fee lands', async () => {
    const halfPaid = memoryHalfPaid();
    const spent = memorySpent();
    const priceOnly = clientByHash({ [PRICE_HASH]: { status: 1, transfer: transfer() }, [FEE_HASH]: null });
    const first = await confirmLegs(ref, priceOnly, spent, halfPaid);
    expect(first.confirmed).toBe(false);
    expect(first.halfPaid).toBe(true);
    expect(halfPaid.rows.get('job_1:deposit')).toEqual({
      jobId: 'job_1',
      leg: 'deposit',
      priceTxHash: PRICE_HASH,
      priceStatus: 'confirmed',
      feeTxHash: FEE_HASH,
      feeStatus: 'not_confirmed',
    });

    const both = clientByHash({
      [PRICE_HASH]: { status: 1, transfer: transfer() },
      [FEE_HASH]: { status: 1, transfer: feeTransfer },
    });
    const second = await confirmLegs(ref, both, spent, halfPaid);
    expect(second.confirmed).toBe(true);
    expect(halfPaid.rows.size).toBe(0);
  });

  it('answers not_signed for a fee the wallet never signed, and counts the leg half-paid when the price landed', async () => {
    const halfPaid = memoryHalfPaid();
    const client = clientByHash({ [PRICE_HASH]: { status: 1, transfer: transfer() } });
    const answer = await confirmLegs({ ...ref, feeTxHash: null }, client, memorySpent(), halfPaid);
    expect(answer.legs.fee).toEqual({ status: 'not_signed' });
    expect(answer.halfPaid).toBe(true);
    expect(halfPaid.rows.get('job_1:deposit')?.feeTxHash).toBeNull();
  });

  it('checks the fee transfer against the fee address, not the owner', async () => {
    const client = clientByHash({
      [PRICE_HASH]: { status: 1, transfer: transfer() },
      [FEE_HASH]: { status: 1, transfer: transfer({ to: RECIPIENT, value: '450000000000000000' }) },
    });
    const answer = await confirmLegs(ref, client, memorySpent(), memoryHalfPaid());
    expect(answer.legs.fee).toEqual({ status: 'mismatched', hash: FEE_HASH });
    expect(answer.confirmed).toBe(false);
  });
});
