// FIX-B39 (bugs.md B39), rule 5: ONE shared function every payment door
// calls in place of B25's job-rail-only check. Refuses (409) for exactly
// three causes, checked in this order: the job is pinned to the other
// currency, the deposit already settled in the other currency, or the
// hired agent's operator has no payout address for this currency.
import { describe, expect, it } from 'vitest';
import { MemorySettlementRepository } from '../../../src/adapters/storage/memory.js';
import { checkRailDoorEligible, depositRailMismatchMessage, operatorAddressNotSetMessage } from '../../../src/adapters/payment/route-support.js';

describe('checkRailDoorEligible: an open quote with an address on record starts on either door', () => {
  it('answers ok when nothing pins the job, nothing settled, and the address is set', async () => {
    const settlementRepo = new MemorySettlementRepository();
    const result = await checkRailDoorEligible({
      jobId: 'job_1',
      routeRail: 'abt',
      jobRail: null,
      settlementRepo,
      operatorAddressOk: true,
    });
    expect(result).toEqual({ ok: true });
  });
});

describe('checkRailDoorEligible: the job is pinned to the other currency', () => {
  it('refuses naming the pin, before ever reading settlement or address', async () => {
    const settlementRepo = new MemorySettlementRepository();
    const result = await checkRailDoorEligible({
      jobId: 'job_1',
      routeRail: 'abt',
      jobRail: 'usdc',
      settlementRepo,
      operatorAddressOk: false, // even wrong here, the pin fires first
    });
    expect(result).toEqual({ ok: false, status: 409, message: expect.stringContaining('usdc') });
  });

  it('matches the pin exactly (abt pinned refuses the usdc door)', async () => {
    const settlementRepo = new MemorySettlementRepository();
    const result = await checkRailDoorEligible({
      jobId: 'job_1',
      routeRail: 'usdc',
      jobRail: 'abt',
      settlementRepo,
      operatorAddressOk: true,
    });
    expect(result.ok).toBe(false);
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
      routeRail: 'abt',
      jobRail: null,
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
      routeRail: 'abt',
      jobRail: 'abt',
      settlementRepo,
      operatorAddressOk: true,
    });
    expect(result).toEqual({ ok: true });
  });
});

describe('checkRailDoorEligible: no payout address on record for this currency', () => {
  it('refuses naming the missing operator address, once rail and deposit both check out', async () => {
    const settlementRepo = new MemorySettlementRepository();
    const result = await checkRailDoorEligible({
      jobId: 'job_1',
      routeRail: 'usdc',
      jobRail: null,
      settlementRepo,
      operatorAddressOk: false,
    });
    expect(result).toEqual({ ok: false, status: 409, message: operatorAddressNotSetMessage('usdc') });
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
});
