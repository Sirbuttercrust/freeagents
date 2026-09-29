// P4: a settlement gate fixture for API tests that don't exercise payment
// gating themselves (confirm, criteria, pull-request happy paths written
// before this card) but now sit behind the fail-closed default. Marking
// every job settled up front keeps those tests' existing assertions
// (200s, projected fields) valid without touching what they assert -- only
// the new required dependency is supplied. Tests that specifically pin
// the payment gate's refusal behaviour construct their own
// MemorySettlementGate directly instead, so they can leave a leg
// unsettled on purpose.
import { MemorySettlementGate, type SettlementGate } from '../../src/adapters/payment/gate.js';

// A gate that answers true for every job id on both legs, without the
// caller having to mark each job by id up front. Not exported from
// src/: this is a test-only convenience the real fail-closed default
// deliberately does not offer (see gate.ts's header comment on why the
// default must answer false).
class AlwaysSettledGate implements SettlementGate {
  async depositSettled(_jobId: string): Promise<boolean> {
    return true;
  }
  async balanceSettled(_jobId: string): Promise<boolean> {
    return true;
  }
}

export function alwaysSettledGate(): SettlementGate {
  return new AlwaysSettledGate();
}

// The gate a hire has between its deposit and its second payment: every
// deposit reads settled, and a job's second payment reads settled only after
// the test marks it (markBalanceSettled). Tests that walk a hire to staged and
// then decline it or ask for a redo use this, since both moves belong to a
// hire that is not yet paid in full (SW3-07). A test that goes on to open the
// pull request marks the job settled right before that step.
class DepositSettledGate extends MemorySettlementGate {
  override async depositSettled(_jobId: string): Promise<boolean> {
    return true;
  }
}

export function depositSettledGate(): MemorySettlementGate {
  return new DepositSettledGate();
}

export function unsettledGate(): MemorySettlementGate {
  return new MemorySettlementGate();
}
