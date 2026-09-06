// P4: the payment state machine's new lifecycle states and transition
// table (design record, 2026-09-01). Every assertion here fails without
// the five new JobStatus members and the widened validateJobTransition
// table in src/domain/job.ts.
import { describe, expect, it } from 'vitest';
import {
  isTerminal,
  JobTransitionError,
  validateJobTransition,
} from '../../src/domain/job.js';

describe('the widened transition table (P4)', () => {
  it('confirmed now walks to staged, not directly to submitted', () => {
    expect(validateJobTransition('confirmed', 'staged')).toBe('staged');
    // The old direct edge is gone: staging is now mandatory between an
    // agreed price and an opened pull request.
    expect(() => validateJobTransition('confirmed', 'submitted')).toThrow(JobTransitionError);
  });

  it('confirmed also walks to expired_unstaged, declined or withdrawn', () => {
    expect(validateJobTransition('confirmed', 'expired_unstaged')).toBe('expired_unstaged');
    expect(validateJobTransition('confirmed', 'declined')).toBe('declined');
    expect(validateJobTransition('confirmed', 'withdrawn')).toBe('withdrawn');
  });

  it('staged walks to submitted, staged_declined or closed_unpaid, and nowhere else', () => {
    expect(validateJobTransition('staged', 'submitted')).toBe('submitted');
    expect(validateJobTransition('staged', 'staged_declined')).toBe('staged_declined');
    expect(validateJobTransition('staged', 'closed_unpaid')).toBe('closed_unpaid');
  });

  // The two deliberately absent edges (brief, section 1): staged_declined
  // is a distinct fact from withdrawn (the buyer SAW the staged work and
  // passed, rather than walking before delivery), and the agent has
  // already delivered at staged, so there is nothing left for it to
  // decline.
  it('staged cannot be withdrawn: staged_declined is the distinct fact for a buyer walking away after delivery', () => {
    expect(() => validateJobTransition('staged', 'withdrawn')).toThrow(JobTransitionError);
  });

  it('staged is not reachable from an agent decline: the agent has already delivered', () => {
    expect(() => validateJobTransition('staged', 'declined')).toThrow(JobTransitionError);
  });

  it('submitted now also reaches deemed_completed, beside completed and closed_unmerged', () => {
    expect(validateJobTransition('submitted', 'completed')).toBe('completed');
    expect(validateJobTransition('submitted', 'closed_unmerged')).toBe('closed_unmerged');
    expect(validateJobTransition('submitted', 'deemed_completed')).toBe('deemed_completed');
  });

  it('the five new statuses are terminal: staged_declined, closed_unpaid, expired_unstaged, deemed_completed', () => {
    expect(isTerminal('staged_declined')).toBe(true);
    expect(isTerminal('closed_unpaid')).toBe(true);
    expect(isTerminal('expired_unstaged')).toBe(true);
    expect(isTerminal('deemed_completed')).toBe(true);
  });

  it('staged itself is not terminal: submitted, staged_declined and closed_unpaid all still lead out of it', () => {
    expect(isTerminal('staged')).toBe(false);
  });

  it('every new terminal status refuses every transition out of it', () => {
    for (const terminal of ['staged_declined', 'closed_unpaid', 'expired_unstaged', 'deemed_completed'] as const) {
      expect(() => validateJobTransition(terminal, 'completed')).toThrow(JobTransitionError);
      expect(() => validateJobTransition(terminal, 'declined')).toThrow(JobTransitionError);
      expect(() => validateJobTransition(terminal, 'withdrawn')).toThrow(JobTransitionError);
    }
  });
});
