// P4: the payment settlement gate, as a narrow port (brief section 2).
// Every assertion here fails without src/adapters/payment/gate.ts.
//
// FAIL CLOSED IS THE WHOLE POINT (silent-success-on-failure is exactly the
// defect class this file exists to prevent): an unwired build must refuse
// to confirm a job and refuse to open a pull request, never silently let
// unpaid work through. The default gate answering true would be the
// failure.
import { describe, expect, it, afterEach } from 'vitest';
import {
  createSettlementGate,
  MemorySettlementGate,
  PrismaSettlementGate,
  remainderSettled,
  UnwiredSettlementGate,
  type SettlementGate,
} from '../../../src/adapters/payment/gate.js';
import { MemorySettlementRepository } from '../../../src/adapters/storage/memory.js';

describe('UnwiredSettlementGate: the fail-closed default', () => {
  it('answers false for depositSettled on any job id', async () => {
    const gate = new UnwiredSettlementGate();
    expect(await gate.depositSettled('job_1')).toBe(false);
    expect(await gate.depositSettled('job_anything')).toBe(false);
  });

  it('answers false for balanceSettled on any job id', async () => {
    const gate = new UnwiredSettlementGate();
    expect(await gate.balanceSettled('job_1')).toBe(false);
    expect(await gate.balanceSettled('job_anything')).toBe(false);
  });

  it('createSettlementGate() (the createApp default) is the fail-closed gate', async () => {
    const gate: SettlementGate = createSettlementGate();
    expect(await gate.depositSettled('job_1')).toBe(false);
    expect(await gate.balanceSettled('job_1')).toBe(false);
  });
});

describe('MemorySettlementGate: a test drives it directly', () => {
  it('answers false for a job nobody marked settled', async () => {
    const gate = new MemorySettlementGate();
    expect(await gate.depositSettled('job_1')).toBe(false);
    expect(await gate.balanceSettled('job_1')).toBe(false);
  });

  it('answers true for depositSettled only after marking it, and only for that job id', async () => {
    const gate = new MemorySettlementGate();
    gate.markDepositSettled('job_1');
    expect(await gate.depositSettled('job_1')).toBe(true);
    expect(await gate.depositSettled('job_2')).toBe(false);
    // Marking the deposit never marks the second leg: the two are
    // independent facts, exactly like the interface's two methods.
    expect(await gate.balanceSettled('job_1')).toBe(false);
  });

  it('answers true for balanceSettled only after marking it, independent of the deposit', async () => {
    const gate = new MemorySettlementGate();
    gate.markBalanceSettled('job_1');
    expect(await gate.balanceSettled('job_1')).toBe(true);
    expect(await gate.depositSettled('job_1')).toBe(false);
  });
});

describe('remainderSettled: the payment-safe wrapper the route layer calls (architecture note)', () => {
  it('delegates to gate.balanceSettled', async () => {
    const gate = new MemorySettlementGate();
    expect(await remainderSettled(gate, 'job_1')).toBe(false);
    gate.markBalanceSettled('job_1');
    expect(await remainderSettled(gate, 'job_1')).toBe(true);
  });

  it('through the fail-closed default, remainderSettled is also false', async () => {
    expect(await remainderSettled(new UnwiredSettlementGate(), 'job_1')).toBe(false);
  });
});

describe('PrismaSettlementGate: reads a confirmed row for the job and leg, and from nothing else', () => {
  it('depositSettled is true only once a deposit-leg row is recorded for that job', async () => {
    const repo = new MemorySettlementRepository();
    const gate = new PrismaSettlementGate(repo);
    expect(await gate.depositSettled('job_1')).toBe(false);
    await repo.record({
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
    expect(await gate.depositSettled('job_1')).toBe(true);
    // A different job's row never leaks in.
    expect(await gate.depositSettled('job_2')).toBe(false);
  });

  it('balanceSettled is true only once a remainder-leg row is recorded, independent of the deposit leg', async () => {
    const repo = new MemorySettlementRepository();
    const gate = new PrismaSettlementGate(repo);
    await repo.record({
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
    expect(await gate.balanceSettled('job_1')).toBe(false);
    await repo.record({
      jobId: 'job_1',
      leg: 'remainder',
      rail: 'abt',
      hash: 'hash-2',
      secondaryHash: null,
      operatorAddress: 'z1Operator',
      feeAddress: 'z1Fee',
      amountUsd: '375.00',
      observedAt: new Date('2026-01-02T00:00:00Z'),
    });
    expect(await gate.balanceSettled('job_1')).toBe(true);
  });
});

describe('createSettlementGate: branches on DATABASE_URL like every other storage factory', () => {
  const original = process.env.DATABASE_URL;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = original;
    }
  });

  it('DATABASE_URL set selects the Prisma-backed gate', () => {
    process.env.DATABASE_URL = 'postgresql://user:***@127.0.0.1:5432/freeagents';
    const gate = createSettlementGate();
    expect(gate).toBeInstanceOf(PrismaSettlementGate);
  });

  it('DATABASE_URL unset selects the fail-closed gate, never a memory gate', () => {
    delete process.env.DATABASE_URL;
    const gate = createSettlementGate();
    expect(gate).toBeInstanceOf(UnwiredSettlementGate);
    expect(gate).not.toBeInstanceOf(MemorySettlementGate);
  });

  it('DATABASE_URL empty also selects the fail-closed gate', () => {
    process.env.DATABASE_URL = '';
    const gate = createSettlementGate();
    expect(gate).toBeInstanceOf(UnwiredSettlementGate);
  });
});
