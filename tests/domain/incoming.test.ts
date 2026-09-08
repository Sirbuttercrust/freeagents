// P8p: the pure rule behind which side an offer is waiting on. Total and
// mutually exclusive over every criteria shape (brief scope item 1), so a
// job's offer state is one fact computed from the criteria array alone,
// never a guess and never a default.
import { describe, expect, it } from 'vitest';
import { waitingOnOf } from '../../src/domain/incoming.js';
import type { Criterion } from '../../src/domain/job.js';

function criterion(overrides: Partial<Criterion> = {}): Criterion {
  return {
    text: 'a line of the exchange',
    proposedBy: 'agent',
    acceptedByBuyer: false,
    acceptedByAgent: false,
    ...overrides,
  };
}

describe('waitingOnOf: total and mutually exclusive over every criteria shape', () => {
  it('is noReply when the job has no criteria at all', () => {
    expect(waitingOnOf([])).toBe('noReply');
  });

  it('is waitingOnBuyer when every criterion carries acceptedByAgent: true', () => {
    const criteria = [
      criterion({ acceptedByAgent: true }),
      criterion({ acceptedByAgent: true }),
    ];
    expect(waitingOnOf(criteria)).toBe('waitingOnBuyer');
  });

  it('is waitingOnOperator when at least one criterion carries acceptedByAgent: false', () => {
    const criteria = [
      criterion({ acceptedByAgent: true }),
      criterion({ acceptedByAgent: false }),
    ];
    expect(waitingOnOf(criteria)).toBe('waitingOnOperator');
  });

  it('reads acceptedByAgent, never proposedBy: a buyer-authored unsigned line still waits on the operator', () => {
    const criteria = [criterion({ proposedBy: 'buyer', acceptedByAgent: false })];
    expect(waitingOnOf(criteria)).toBe('waitingOnOperator');
  });

  it('reads acceptedByAgent, never proposedBy: an agent-authored unsigned line still waits on the operator', () => {
    const criteria = [criterion({ proposedBy: 'agent', acceptedByAgent: false })];
    expect(waitingOnOf(criteria)).toBe('waitingOnOperator');
  });

  it('is total and mutually exclusive: every criteria shape produces exactly one of the three values', () => {
    const shapes: Criterion[][] = [
      [],
      [criterion({ acceptedByAgent: true })],
      [criterion({ acceptedByAgent: false })],
      [criterion({ acceptedByAgent: true }), criterion({ acceptedByAgent: false })],
      [criterion({ acceptedByAgent: false }), criterion({ acceptedByAgent: false })],
      [criterion({ acceptedByAgent: true }), criterion({ acceptedByAgent: true }), criterion({ acceptedByAgent: true })],
    ];
    const values: readonly string[] = ['noReply', 'waitingOnBuyer', 'waitingOnOperator'];
    shapes.forEach((criteria) => {
      const result = waitingOnOf(criteria);
      expect(values).toContain(result);
    });
  });
});
