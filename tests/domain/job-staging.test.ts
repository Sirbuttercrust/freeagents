// P4: the staging route's domain function, and the buyer's staged-time
// exit that costs nothing. Every assertion here fails without stageWork
// and recordStagedDeclined in src/domain/job.ts.
import { describe, expect, it } from 'vitest';
import {
  createJob,
  JobTransitionError,
  recordStagedDeclined,
  stageWork,
  validateJobTransition,
  type Job,
} from '../../src/domain/job.js';

function confirmedJob(overrides: Partial<Job> = {}): Job {
  return {
    ...createJob(
      { id: 'job_1', buyerDid: 'did:example:buyer', agentDid: 'did:example:agent', repository: 'buyer/target-repo', brief: 'Fix the login bug' },
      new Date('2026-01-01T00:00:00Z'),
    ),
    status: 'confirmed',
    confirmedSpecHash: 'sha256:spec',
    confirmedAt: new Date('2026-01-02T00:00:00Z'),
    priceUsd: '500.00',
    rail: 'abt',
    priceAcceptedByBuyer: true,
    priceAcceptedByAgent: true,
    criteria: [{ text: 'Login works', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
    ...overrides,
  };
}

describe('stageWork: confirmed -> staged, stamping the commit and the instant', () => {
  it('moves a confirmed job to staged, stamping stagedCommit and stagedAt', () => {
    const now = new Date('2026-01-05T00:00:00Z');
    const staged = stageWork(confirmedJob(), 'abc123def', now);
    expect(staged.status).toBe('staged');
    expect(staged.stagedCommit).toBe('abc123def');
    expect(staged.stagedAt).toBe(now);
  });

  it('refuses to stage a job in any status other than confirmed', () => {
    expect(() => stageWork(confirmedJob({ status: 'draft' }), 'abc', new Date())).toThrow(JobTransitionError);
    expect(() => stageWork(confirmedJob({ status: 'proposed' }), 'abc', new Date())).toThrow(JobTransitionError);
    expect(() => stageWork(confirmedJob({ status: 'staged' }), 'abc', new Date())).toThrow(JobTransitionError);
    expect(() => stageWork(confirmedJob({ status: 'submitted' }), 'abc', new Date())).toThrow(JobTransitionError);
  });

  it('leaves every other field untouched', () => {
    const job = confirmedJob();
    const staged = stageWork(job, 'abc123def', new Date('2026-01-05T00:00:00Z'));
    expect(staged.priceUsd).toBe(job.priceUsd);
    expect(staged.confirmedSpecHash).toBe(job.confirmedSpecHash);
    expect(staged.criteria).toEqual(job.criteria);
  });
});

describe('recordStagedDeclined: staged -> staged_declined, free, terminal, unowed', () => {
  it('moves a staged job to staged_declined', () => {
    const staged = stageWork(confirmedJob(), 'abc123def', new Date('2026-01-05T00:00:00Z'));
    const declined = recordStagedDeclined(staged);
    expect(declined.status).toBe('staged_declined');
  });

  it('refuses from any status other than staged', () => {
    expect(() => recordStagedDeclined(confirmedJob({ status: 'confirmed' }))).toThrow(JobTransitionError);
    expect(() => recordStagedDeclined(confirmedJob({ status: 'submitted' }))).toThrow(JobTransitionError);
  });

  it('a staged job cannot instead be withdrawn (the absent edge, card acceptance)', () => {
    // recordWithdrawn is validateJobTransition-gated the same way; a staged
    // job is not in withdrawn's reachable set, so this refuses even though
    // withdrawn is normally reachable from "every non-terminal state".
    const staged = stageWork(confirmedJob(), 'abc123def', new Date('2026-01-05T00:00:00Z'));
    expect(() => validateJobTransition(staged.status, 'withdrawn')).toThrow(JobTransitionError);
  });
});
