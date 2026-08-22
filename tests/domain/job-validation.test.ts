import { describe, expect, it } from 'vitest';
import {
  completeJob,
  confirmSpec,
  decline,
  JobTransitionError,
  submitPullRequest,
  validateJobTransition,
} from '../../src/domain/job.js';
import type { Job } from '../../src/domain/job.js';

function proposedJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job_1',
    buyerDid: 'did:example:buyer',
    agentDid: 'did:example:agent',
    repository: 'buyer/target-repo',
    brief: 'Fix the login bug on the checkout page',
    briefHash: 'sha256:brief',
    confirmedSpecHash: null,
    status: 'proposed',
    criteria: [],
    pullRequestUrl: null,
    confirmedAt: null,
    submittedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('job transition validation', () => {
  it('validates all valid transitions correctly', () => {
    // Test draft -> proposed (the edge R-8's criteria exchange will walk)
    expect(validateJobTransition('draft', 'proposed')).toBe('proposed');

    // Test proposed -> confirmed
    expect(validateJobTransition('proposed', 'confirmed')).toBe('confirmed');
    
    // Test proposed -> declined
    expect(validateJobTransition('proposed', 'declined')).toBe('declined');
    
    // Test confirmed -> submitted
    expect(validateJobTransition('confirmed', 'submitted')).toBe('submitted');
    
    // Test confirmed -> declined
    expect(validateJobTransition('confirmed', 'declined')).toBe('declined');
    
    // Test submitted -> completed
    expect(validateJobTransition('submitted', 'completed')).toBe('completed');
    
    // Test submitted -> declined
    expect(validateJobTransition('submitted', 'declined')).toBe('declined');
    
    // Test declining from any non-terminal state
    expect(validateJobTransition('proposed', 'declined')).toBe('declined');
    expect(validateJobTransition('confirmed', 'declined')).toBe('declined');
    expect(validateJobTransition('submitted', 'declined')).toBe('declined');
  });

  it('throws errors for invalid transitions', () => {
    // Test invalid transitions from draft: a draft can only be proposed or
    // declined, nothing else
    expect(() => validateJobTransition('draft', 'confirmed')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('draft', 'submitted')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('draft', 'completed')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('draft', 'draft')).toThrow(JobTransitionError);

    // Test invalid transitions from proposed
    expect(() => validateJobTransition('proposed', 'submitted')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('proposed', 'completed')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('proposed', 'proposed')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('proposed', 'draft')).toThrow(JobTransitionError);
    
    // Test invalid transitions from confirmed
    expect(() => validateJobTransition('confirmed', 'confirmed')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('confirmed', 'completed')).toThrow(JobTransitionError);
    
    // Test invalid transitions from submitted
    expect(() => validateJobTransition('submitted', 'confirmed')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('submitted', 'submitted')).toThrow(JobTransitionError);
    
    // Test invalid transitions from completed
    expect(() => validateJobTransition('completed', 'proposed')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('completed', 'confirmed')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('completed', 'submitted')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('completed', 'completed')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('completed', 'declined')).toThrow(JobTransitionError);
    
    // Test invalid transitions from declined
    expect(() => validateJobTransition('declined', 'proposed')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('declined', 'confirmed')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('declined', 'submitted')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('declined', 'completed')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('declined', 'declined')).toThrow(JobTransitionError);
  });

  it('throws errors when trying to transition from terminal states', () => {
    // Test that terminal states cannot be transitioned from
    expect(() => validateJobTransition('completed', 'declined')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('declined', 'proposed')).toThrow(JobTransitionError);
  });

  it('works with all existing functions that use transitions', () => {
    const now = new Date('2026-01-02T00:00:00Z');
    
    // Test that confirmSpec works correctly
    const confirmed = confirmSpec(proposedJob(), 'sha256:spec', now);
    expect(confirmed.status).toBe('confirmed');
    
    // Test that submitPullRequest works correctly
    const submitted = submitPullRequest(confirmed, 'https://github.com/buyer/target-repo/pull/1', now);
    expect(submitted.status).toBe('submitted');
    
    // Test that completeJob works correctly
    const { job: completed } = completeJob(submitted, {
      mergeCommit: 'abc123',
      completedAt: now,
    });
    expect(completed.status).toBe('completed');
    
    // Test that decline works correctly
    const declined = decline(proposedJob({ status: 'confirmed' }));
    expect(declined.status).toBe('declined');
  });

  it('rejects invalid transitions in existing functions', () => {
    const now = new Date('2026-01-02T00:00:00Z');
    
    // Test that confirmSpec rejects invalid transitions
    expect(() => confirmSpec(proposedJob({ status: 'confirmed' }), 'sha256:spec', now)).toThrow(JobTransitionError);
    
    // Test that submitPullRequest rejects invalid transitions
    expect(() => submitPullRequest(proposedJob(), 'https://example.com/pr/1', now)).toThrow(JobTransitionError);
    
    // Test that completeJob rejects invalid transitions
    const job = proposedJob({ status: 'confirmed' });
    expect(() => completeJob(job, { mergeCommit: 'abc123', completedAt: now })).toThrow(JobTransitionError);
    
    // Test that decline rejects transitions from terminal states
    expect(() => decline(proposedJob({ status: 'completed' }))).toThrow(JobTransitionError);
  });
});