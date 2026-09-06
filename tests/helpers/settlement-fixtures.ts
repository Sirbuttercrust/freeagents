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

export function unsettledGate(): MemorySettlementGate {
  return new MemorySettlementGate();
}
