// R-31 (#50): the buyer withdraws an open job. The route is a body-less
// sibling of request-changes and confirm: every rule lives in the domain's
// recordWithdrawn, and the shared runExchange skeleton owns the storage legs
// (job-criteria.test.ts pins those). What this file pins is what is NEW to
// the route: the 200 projection from submitted and stale, the 409 from every
// terminal status (including a second withdraw), and the read-back.
//
// Withdrawn projects the same keyset its previous state did, with only
// status moved: no new field, and no merge facts that could read the
// walk-away as a hire (the invariant-2 absence leg lives in
// tests/api/job-invariant2.test.ts).
import type { Server } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryOperatorRepository } from '../../src/adapters/storage/memory.js';
import type { JobRepository } from '../../src/adapters/storage/types.js';
import { createJob, type Job, type JobStatus } from '../../src/domain/job.js';

const AGENT_DID = 'did:abt:agent-withdraw';
const BUYER_DID = 'did:abt:buyer-withdraw';

// The submitted keyset, exactly as tests/api/job-merge.test.ts pins it: the
// base eight plus criteria, specHash and confirmedAt, then the submission
// pair plus deadline. A withdrawn job projects it with only status moved.
const SUBMITTED_KEYS = [
  'agentDid',
  'brief',
  'briefHash',
  'buyerDid',
  'confirmedAt',
  'createdAt',
  'criteria',
  'deadline',
  'id',
  'pullRequestUrl',
  'repository',
  'specHash',
  'status',
  'submittedAt',
];

// A row in the requested status, fully confirmed and submitted so the
// projection carries the full submitted keyset. The deadline is the one
// submitPullRequest writes (R-12): submittedAt + 30 days.
function plantedJob(id: string, status: JobStatus): Job {
  const submittedAt = new Date('2026-01-02T00:00:00Z');
  return {
    ...createJob(
      { id, buyerDid: BUYER_DID, agentDid: AGENT_DID, repository: 'buyer/target-repo', brief: 'Fix the login bug' },
      new Date('2026-01-01T00:00:00Z'),
    ),
    status,
    pullRequestUrl: 'https://github.com/freeagents-platform/target-repo/pull/7',
    submittedAt,
    deadline: new Date(submittedAt.getTime() + 30 * 86_400_000),
    criteria: [
      { text: 'fixes the login bug', proposedBy: 'agent', accepted: true },
      { text: 'no new dependencies', proposedBy: 'buyer', accepted: true },
    ],
    confirmedSpecHash: 'a'.repeat(64),
    confirmedAt: new Date('2026-01-01T12:00:00Z'),
  };
}

class PlantedJobRepository implements JobRepository {
  private row: Job;
  constructor(row: Job, private readonly updateImpl: (row: Job) => Promise<Job | null>) {
    this.row = row;
  }
  async create(): Promise<never> {
    throw new Error('unreachable');
  }
  async findById(id: string): Promise<Job | null> {
    return this.row.id === id ? this.row : null;
  }
  async update(row: Job): Promise<Job | null> {
    const result = await this.updateImpl(row);
    // The row only moves when the write resolves: a write that fails left
    // nothing on record.
    if (result !== null) {
      this.row = result;
    }
    return result;
  }
  async complete(): Promise<never> {
    throw new Error('unreachable');
  }
  async findCompletedByJobId(): Promise<null> {
    return null;
  }
  async recordSettlementIntent(): Promise<null> {
    return null;
  }
  async findSettlementByJobId(): Promise<null> {
    return null;
  }
}

async function startWith(repo: JobRepository): Promise<{ server: Server; baseUrl: string }> {
  const server = createApp(
    new MemoryOperatorRepository(),
    undefined,
    undefined,
    undefined,
    repo,
  ).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function stop(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function postWithdraw(baseUrl: string, jobId: string): Promise<Response> {
  return fetch(`${baseUrl}/jobs/${jobId}/withdraw`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

describe('job withdraw (R-31)', () => {
  it('withdraws a submitted job: the submitted keyset, only status moved, and the read-back agrees', async () => {
    const row = plantedJob('j-w-submitted', 'submitted');
    const repo = new PlantedJobRepository(row, (r) => Promise.resolve(r));
    const { server, baseUrl } = await startWith(repo);
    try {
      const res = await postWithdraw(baseUrl, row.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.id).toBe(row.id);
      expect(body.status).toBe('withdrawn');
      expect(Object.keys(body).sort()).toEqual(SUBMITTED_KEYS);
      expect(typeof body.deadline).toBe('string');
      // Absence, not nulls: a walk-away must not carry merge facts.
      expect('mergeCommit' in body).toBe(false);
      expect('mergedAt' in body).toBe(false);

      // Read-back: the recorded row, not the request.
      const read = await fetch(`${baseUrl}/jobs/${row.id}`);
      expect((await read.json()) as Record<string, unknown>).toEqual(body);
    } finally {
      await stop(server);
    }
  });

  it('withdraws a stale job: the same keyset, the stale edge (R-31)', async () => {
    const row = plantedJob('j-w-stale', 'stale');
    const repo = new PlantedJobRepository(row, (r) => Promise.resolve(r));
    const { server, baseUrl } = await startWith(repo);
    try {
      const res = await postWithdraw(baseUrl, row.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.id).toBe(row.id);
      expect(body.status).toBe('withdrawn');
      expect(Object.keys(body).sort()).toEqual(SUBMITTED_KEYS);
      expect(typeof body.deadline).toBe('string');
      expect('mergeCommit' in body).toBe(false);
      expect('mergedAt' in body).toBe(false);

      const read = await fetch(`${baseUrl}/jobs/${row.id}`);
      expect((await read.json()) as Record<string, unknown>).toEqual(body);
    } finally {
      await stop(server);
    }
  });

  it('answers 409 from every terminal status, including a second withdraw', async () => {
    const terminals: JobStatus[] = ['completed', 'declined', 'closed_unmerged', 'withdrawn'];
    for (const status of terminals) {
      const row = plantedJob(`j-w-${status}`, status);
      const repo = new PlantedJobRepository(row, () => Promise.reject(new Error('unreachable')));
      const { server, baseUrl } = await startWith(repo);
      try {
        const res = await postWithdraw(baseUrl, row.id);
        expect(res.status).toBe(409);
        expect(((await res.json()) as { error: string }).error).toBe(
          `cannot transition from "${status}" a job in status "${status}"`,
        );
      } finally {
        await stop(server);
      }
    }
  });

  it('answers 404 for an unknown job id, without touching storage writes', async () => {
    const row = plantedJob('j-w-known', 'submitted');
    const repo = new PlantedJobRepository(row, () => Promise.reject(new Error('unreachable')));
    const { server, baseUrl } = await startWith(repo);
    try {
      const res = await postWithdraw(baseUrl, 'j-w-nowhere');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not found' });
    } finally {
      await stop(server);
    }
  });

  it('answers 503 when storage fails to persist the withdraw, and logs the cause', async () => {
    const row = plantedJob('j-w-503', 'submitted');
    const repo = new PlantedJobRepository(row, () => Promise.reject(new Error('connection refused')));
    const { server, baseUrl } = await startWith(repo);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await postWithdraw(baseUrl, row.id);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'storage unavailable' });
      expect(errorLog).toHaveBeenCalledWith('POST /jobs/:jobId/withdraw: storage failed', expect.any(Error));

      // Nothing was persisted: the row reads back submitted.
      const read = await fetch(`${baseUrl}/jobs/${row.id}`);
      const readBack = (await read.json()) as Record<string, unknown>;
      expect(readBack.status).toBe('submitted');
    } finally {
      errorLog.mockRestore();
      await stop(server);
    }
  });
});
