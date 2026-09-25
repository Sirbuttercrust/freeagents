// STG2: pullRequestTemplate is the title/body a staged job's projection
// carries so the agent can open the real PR from its own fork without
// re-deriving the wording by hand. Same lines the pull-request route
// used to write itself (R-10's original shape) before this card moved
// PR-opening to the agent.
import { describe, expect, it } from 'vitest';
import { confirmSpec, createJob, pullRequestTemplate, stageWork, type Job } from '../../src/domain/job.js';

function stagedJob(): Job {
  const job = createJob(
    { id: 'job_pr_tmpl', buyerDid: 'did:example:buyer', agentDid: 'did:example:agent', repository: 'buyer/target-repo', brief: 'Fix the login bug' },
    new Date('2026-01-01T00:00:00Z'),
  );
  const proposed = {
    ...job,
    status: 'proposed' as const,
    criteria: [{ text: 'Fixes the bug', proposedBy: 'agent' as const, acceptedByBuyer: true, acceptedByAgent: true }],
    priceUsd: '500.00',
    rail: 'abt' as const,
    priceAcceptedByBuyer: true,
    priceAcceptedByAgent: true,
  };
  const confirmed = confirmSpec(proposed, new Date('2026-01-02T00:00:00Z'));
  return stageWork(confirmed, 'staged-commit-sha', new Date('2026-01-03T00:00:00Z'));
}

describe('pullRequestTemplate (STG2)', () => {
  it('the title carries the job id, where triage sees it first', () => {
    const template = pullRequestTemplate(stagedJob());
    expect(template.title).toBe('FreeAgents job job_pr_tmpl');
  });

  it('the body carries the job id, repository, brief hash and spec hash, so anyone holding the PR alone can tie it to the job', () => {
    const job = stagedJob();
    const template = pullRequestTemplate(job);
    expect(template.body).toContain(`Job: ${job.id}`);
    expect(template.body).toContain(`Repository: ${job.repository}`);
    expect(template.body).toContain(`Brief hash: ${job.briefHash}`);
    expect(template.body).toContain(`Spec hash: ${String(job.confirmedSpecHash)}`);
  });

  it('the final sentence states the new mechanism: the agent opened it from its own fork, and the platform holds no write access', () => {
    const template = pullRequestTemplate(stagedJob());
    expect(template.body).toContain('opened by the agent from its own fork');
    expect(template.body).toContain('holds no write access to the source repository');
  });
});
