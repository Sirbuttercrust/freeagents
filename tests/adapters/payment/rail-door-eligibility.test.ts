// FIX-B39 (B39), rule 5: ONE shared function every payment door
// calls in place of B25's job-rail-only check. Refuses (409) for exactly
// four causes, checked in this order: the job is pinned to the other
// currency, the deposit already settled in the other currency, part of the
// leg was already paid in the other currency (its price transfer reached the
// owner), or the hired agent's operator has no payout address for this
// currency. railHoldingLeg is the one read that names the second-to-last
// rail.
import { describe, expect, it } from 'vitest';
import { MemorySettlementRepository } from '../../../src/adapters/storage/memory.js';
import {
  checkRailDoorEligible,
  depositRailMismatchMessage,
  heldRailMismatchMessage,
  operatorAddressNotSetMessage,
  railHoldingLeg,
} from '../../../src/adapters/payment/route-support.js';
import type { AbtEthStoredHalfPaidRecord } from '../../../src/adapters/payment/abt-eth.js';
import type { UsdcHalfPaidRecord } from '../../../src/adapters/payment/usdc.js';

describe('checkRailDoorEligible: an open quote with an address on record starts on either door', () => {
  it('answers ok when nothing pins the job, nothing settled, nothing is half paid, and the address is set', async () => {
    const settlementRepo = new MemorySettlementRepository();
    const result = await checkRailDoorEligible({
      jobId: 'job_1',
      leg: 'deposit',
      routeRail: 'abt',
      jobRail: null,
      heldRail: null,
      settlementRepo,
      operatorAddressOk: true,
    });
    expect(result).toEqual({ ok: true });
  });
});

describe('checkRailDoorEligible: the job is pinned to the other currency', () => {
  it.each([
    ['abt', 'usdc', false],
    ['usdc', 'abt', true],
  ] as const)('routeRail %s vs jobRail %s refuses naming the pin', async (routeRail, jobRail, operatorAddressOk) => {
    const settlementRepo = new MemorySettlementRepository();
    const result = await checkRailDoorEligible({
      jobId: 'job_1',
      leg: 'deposit',
      routeRail,
      jobRail,
      heldRail: null,
      settlementRepo,
      operatorAddressOk, // even wrong (false) here, the pin fires first
    });
    expect(result).toEqual({ ok: false, status: 409, message: expect.stringContaining(jobRail) });
  });
});

describe('checkRailDoorEligible: the deposit already settled in the other currency', () => {
  it('refuses the deposit-settled currency mismatch even while the job itself is still open (rail null)', async () => {
    const settlementRepo = new MemorySettlementRepository();
    await settlementRepo.record({
      jobId: 'job_1',
      leg: 'deposit',
      rail: 'usdc',
      hash: 'hash-1',
      secondaryHash: null,
      operatorAddress: '0xOperator',
      feeAddress: '0xFee',
      amountUsd: '125.00',
      observedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const result = await checkRailDoorEligible({
      jobId: 'job_1',
      leg: 'deposit',
      routeRail: 'abt',
      jobRail: null,
      heldRail: null,
      settlementRepo,
      operatorAddressOk: true,
    });
    expect(result).toEqual({ ok: false, status: 409, message: depositRailMismatchMessage('abt', 'usdc') });
  });

  it('answers ok when the settled deposit matches the route rail', async () => {
    const settlementRepo = new MemorySettlementRepository();
    await settlementRepo.record({
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
    const result = await checkRailDoorEligible({
      jobId: 'job_1',
      leg: 'deposit',
      routeRail: 'abt',
      jobRail: 'abt',
      heldRail: null,
      settlementRepo,
      operatorAddressOk: true,
    });
    expect(result).toEqual({ ok: true });
  });
});

describe('checkRailDoorEligible: part of the leg was already paid in a currency', () => {
  it.each([
    ['abt', 'usdc', 'deposit'],
    ['abt_eth', 'usdc', 'deposit'],
    ['usdc', 'abt_eth', 'deposit'],
    ['usdc', 'abt_eth', 'remainder'],
  ] as const)('the %s door refuses a leg held on %s (%s), whole sentence, even with no address on record', async (routeRail, heldRail, leg) => {
    const result = await checkRailDoorEligible({
      jobId: 'job_1',
      leg,
      routeRail,
      jobRail: null,
      heldRail,
      settlementRepo: new MemorySettlementRepository(),
      operatorAddressOk: false, // the held rail is checked before the address
    });
    expect(result).toEqual({
      ok: false,
      status: 409,
      message: `part of the ${leg} for this job was paid in "${heldRail}"; finish it there, the "${routeRail}" payment routes refuse it`,
    });
    expect(heldRailMismatchMessage(leg, routeRail, heldRail)).toBe(
      `part of the ${leg} for this job was paid in "${heldRail}"; finish it there, the "${routeRail}" payment routes refuse it`,
    );
  });

  it('passes the held rail its own door', async () => {
    const result = await checkRailDoorEligible({
      jobId: 'job_1',
      leg: 'deposit',
      routeRail: 'usdc',
      jobRail: null,
      heldRail: 'usdc',
      settlementRepo: new MemorySettlementRepository(),
      operatorAddressOk: true,
    });
    expect(result).toEqual({ ok: true });
  });

  it('answers the settled-deposit sentence, not the held one, when both disagree with the door', async () => {
    const settlementRepo = new MemorySettlementRepository();
    await settlementRepo.record({
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
    const result = await checkRailDoorEligible({
      jobId: 'job_1',
      leg: 'remainder',
      routeRail: 'usdc',
      jobRail: null,
      heldRail: 'abt_eth',
      settlementRepo,
      operatorAddressOk: true,
    });
    expect(result).toEqual({ ok: false, status: 409, message: depositRailMismatchMessage('usdc', 'abt') });
  });
});

describe('checkRailDoorEligible: no payout address on record for this currency', () => {
  it('refuses naming the missing operator address, once rail and deposit both check out', async () => {
    const settlementRepo = new MemorySettlementRepository();
    const result = await checkRailDoorEligible({
      jobId: 'job_1',
      leg: 'deposit',
      routeRail: 'usdc',
      jobRail: null,
      heldRail: null,
      settlementRepo,
      operatorAddressOk: false,
    });
    expect(result).toEqual({ ok: false, status: 409, message: operatorAddressNotSetMessage('usdc') });
  });
});

describe('railHoldingLeg: the rail whose price transfer is confirmed on an unsettled leg', () => {
  const confirmedPrice = { priceTxHash: '0xp', priceStatus: 'confirmed', feeTxHash: '0xf', feeStatus: 'not_confirmed' } as const;
  const feeOnly = { priceTxHash: '0xp', priceStatus: 'not_confirmed', feeTxHash: '0xf', feeStatus: 'confirmed' } as const;
  const mismatched = { priceTxHash: '0xp', priceStatus: 'mismatched', feeTxHash: '0xf', feeStatus: 'mismatched' } as const;
  const pending = { priceTxHash: '0xp', priceStatus: 'not_confirmed', feeTxHash: null, feeStatus: 'not_signed' } as const;

  function usdc(record: UsdcHalfPaidRecord | null, asked: string[] = []) {
    return {
      readHalfPaidRecord: async (jobId: string, leg: 'deposit' | 'balance') => {
        asked.push(`${jobId}:${leg}`);
        return record;
      },
    };
  }
  function abtEth(record: AbtEthStoredHalfPaidRecord | null) {
    return { readHalfPaidRecord: async () => record };
  }

  it('answers usdc when the USDC record has the price confirmed', async () => {
    const answer = await railHoldingLeg({ jobId: 'job_1', leg: 'deposit', usdcRail: usdc(confirmedPrice), abtEthRail: abtEth(null) });
    expect(answer).toBe('usdc');
  });

  it('answers abt_eth when the ABT-on-Ethereum record has the price confirmed', async () => {
    const answer = await railHoldingLeg({ jobId: 'job_1', leg: 'deposit', usdcRail: usdc(null), abtEthRail: abtEth({ ...confirmedPrice, lockId: 'lock-1' }) });
    expect(answer).toBe('abt_eth');
  });

  it('answers null when neither rail has a record', async () => {
    const answer = await railHoldingLeg({ jobId: 'job_1', leg: 'deposit', usdcRail: usdc(null), abtEthRail: abtEth(null) });
    expect(answer).toBeNull();
  });

  it.each([
    ['fee only', feeOnly],
    ['mismatched', mismatched],
    ['no price confirmed yet', pending],
  ] as const)('answers null for a record with %s, on either rail', async (_name, record) => {
    expect(await railHoldingLeg({ jobId: 'job_1', leg: 'deposit', usdcRail: usdc(record), abtEthRail: null })).toBeNull();
    expect(await railHoldingLeg({ jobId: 'job_1', leg: 'deposit', usdcRail: null, abtEthRail: abtEth({ ...record, lockId: null }) })).toBeNull();
  });

  it('skips a rail that is not configured', async () => {
    expect(await railHoldingLeg({ jobId: 'job_1', leg: 'deposit', usdcRail: null, abtEthRail: abtEth({ ...confirmedPrice, lockId: null }) })).toBe('abt_eth');
    expect(await railHoldingLeg({ jobId: 'job_1', leg: 'deposit', usdcRail: usdc(confirmedPrice), abtEthRail: null })).toBe('usdc');
    expect(await railHoldingLeg({ jobId: 'job_1', leg: 'deposit', usdcRail: null, abtEthRail: null })).toBeNull();
  });

  it('reads the leg it was asked about, under the rail\'s own leg name', async () => {
    const asked: string[] = [];
    await railHoldingLeg({ jobId: 'job_1', leg: 'remainder', usdcRail: usdc(null, asked), abtEthRail: null });
    await railHoldingLeg({ jobId: 'job_2', leg: 'deposit', usdcRail: usdc(null, asked), abtEthRail: null });
    expect(asked).toEqual(['job_1:balance', 'job_2:deposit']);
  });

  it('throws when the USDC read fails', async () => {
    const failing = { readHalfPaidRecord: async () => { throw new Error('storage down'); } };
    await expect(railHoldingLeg({ jobId: 'job_1', leg: 'deposit', usdcRail: failing, abtEthRail: null })).rejects.toThrow('storage down');
  });

  it('throws when the ABT-on-Ethereum read fails', async () => {
    const failing = { readHalfPaidRecord: async () => { throw new Error('storage down'); } };
    await expect(railHoldingLeg({ jobId: 'job_1', leg: 'deposit', usdcRail: null, abtEthRail: failing })).rejects.toThrow('storage down');
  });
});

describe('operatorAddressNotSetMessage: byte-identical to the pre-existing per-rail wording', () => {
  it('names "an ABT" for the abt rail', () => {
    expect(operatorAddressNotSetMessage('abt')).toBe(
      "the hired agent's operator has not set an ABT operator address; PATCH /accounts/:did/operator-address first",
    );
  });
  it('names "a USDC" for the usdc rail', () => {
    expect(operatorAddressNotSetMessage('usdc')).toBe(
      "the hired agent's operator has not set a USDC operator address; PATCH /accounts/:did/operator-address first",
    );
  });
  it('names "an ABT-on-Ethereum" for the abt_eth rail, and not the USDC sentence', () => {
    expect(operatorAddressNotSetMessage('abt_eth')).toBe(
      "the hired agent's operator has not set an ABT-on-Ethereum operator address; PATCH /accounts/:did/operator-address first",
    );
  });
});
