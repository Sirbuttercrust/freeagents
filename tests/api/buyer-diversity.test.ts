// R-33: the agent's hire record over HTTP. counts and entries are derived at
// read time from completed jobs; the self-hire label rides beside the counts,
// never subtracted, so a reading of this response cannot present five
// self-hires as five independent buyers (MISSION invariant 5).
import type { Express } from 'express';
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryJobRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import type { AgentRepository, JobRepository } from '../../src/adapters/storage/types.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { Job } from '../../src/domain/job.js';

const AGENT_DID = 'did:abt:zHiresAgent';
const OPERATOR_DID = 'did:abt:zHiresOperator';

const delegation: Delegation = {
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  id: 'urn:uuid:buyer-diversity-test',
  type: ['VerifiableCredential', 'AgentDelegation'],
  issuer: OPERATOR_DID,
  issuanceDate: '2026-08-21T05:00:00.000Z',
  credentialSubject: { id: AGENT_DID },
  proof: {
    type: 'Ed25519Signature2020',
    created: '2026-08-21T05:00:00.000Z',
    verificationMethod: `${OPERATOR_DID}#zOperatorKeyHash`,
    proofPurpose: 'assertionMethod',
    proofValue: 'zMockProofValue',
  },
};

function jobFixture(overrides: Partial<Job> & { id: string }): Job {
  return {
    buyerDid: 'did:example:buyer',
    agentDid: AGENT_DID,
    repository: 'buyer/target-repo',
    brief: 'Fix the login bug on the checkout page',
    briefHash: 'sha256:brief',
    confirmedSpecHash: null,
    status: 'draft',
    criteria: [],
    pullRequestUrl: null,
    mergeCommit: null,
    mergedAt: null,
    confirmedAt: null,
    submittedAt: null,
    deadline: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

async function complete(
  jobRepo: MemoryJobRepository,
  id: string,
  buyerDid: string,
  mergeCommit: string,
  completedAt: Date,
): Promise<void> {
  const draft = jobFixture({ id, buyerDid });
  await jobRepo.create(draft);
  const completedJob: Job = { ...draft, status: 'completed', mergeCommit, mergedAt: completedAt };
  await jobRepo.complete(completedJob, { jobId: id, buyerDid, agentDid: AGENT_DID, mergeCommit, completedAt });
}

function listen(app: Express): Promise<Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return address.port;
}

async function withApp(app: Express, run: (url: string) => Promise<void>): Promise<void> {
  const server = await listen(app);
  try {
    await run(`http://127.0.0.1:${portOf(server)}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function buildApp(jobRepo: JobRepository): { app: Express; agentRepo: MemoryAgentRepository } {
  const agentRepo = new MemoryAgentRepository();
  const app = createApp(new MemoryAccountRepository(), agentRepo, undefined, undefined, jobRepo);
  return { app, agentRepo };
}

async function registerAgent(agentRepo: MemoryAgentRepository, operatorDid: string): Promise<void> {
  await agentRepo.create({
    did: AGENT_DID,
    operatorDid,
    delegation,
    name: 'scout',
    skills: ['triage'],
    githubLogin: null,
  });
}

describe('GET /agents/:agentDid/hires (R-33)', () => {
  it('404 for an unregistered agent', async () => {
    const { app } = buildApp(new MemoryJobRepository());
    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents/did:abt:znobody/hires`);
      expect(res.status).toBe(404);
    });
  });

  it('200 with all-zero counts and entries: [] for a registered agent with no hires', async () => {
    const jobRepo = new MemoryJobRepository();
    const { app, agentRepo } = buildApp(jobRepo);
    await registerAgent(agentRepo, OPERATOR_DID);
    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents/${AGENT_DID}/hires`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        agentDid: AGENT_DID,
        counts: { hires: 0, buyers: 0, selfHires: 0, selfHireBuyers: 0 },
        entries: [],
      });
    });
  });

  it('200 with counts.hires and counts.buyers correct across several completed jobs from distinct buyers', async () => {
    const jobRepo = new MemoryJobRepository();
    const { app, agentRepo } = buildApp(jobRepo);
    await registerAgent(agentRepo, OPERATOR_DID);
    await complete(jobRepo, 'job_1', 'did:example:buyer-a', 'merge-1', new Date('2026-01-01T00:00:00Z'));
    await complete(jobRepo, 'job_2', 'did:example:buyer-b', 'merge-2', new Date('2026-01-02T00:00:00Z'));
    await complete(jobRepo, 'job_3', 'did:example:buyer-a', 'merge-3', new Date('2026-01-03T00:00:00Z'));

    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents/${AGENT_DID}/hires`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { counts: { hires: number; buyers: number } };
      expect(body.counts.hires).toBe(3);
      expect(body.counts.buyers).toBe(2);
    });
  });

  it('an unmerged job for the same agent is absent from entries and from the counts', async () => {
    const jobRepo = new MemoryJobRepository();
    const { app, agentRepo } = buildApp(jobRepo);
    await registerAgent(agentRepo, OPERATOR_DID);
    await jobRepo.create(jobFixture({ id: 'job_unmerged', buyerDid: 'did:example:buyer-a' }));
    await complete(jobRepo, 'job_1', 'did:example:buyer-a', 'merge-1', new Date('2026-01-01T00:00:00Z'));

    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents/${AGENT_DID}/hires`);
      const body = (await res.json()) as { counts: { hires: number }; entries: Array<{ jobId: string }> };
      expect(body.counts.hires).toBe(1);
      expect(body.entries.map((e) => e.jobId)).toEqual(['job_1']);
    });
  });

  it('a job whose buyerDid is the agent operator is labelled selfHire on the entry and counted in counts', async () => {
    const jobRepo = new MemoryJobRepository();
    const { app, agentRepo } = buildApp(jobRepo);
    await registerAgent(agentRepo, OPERATOR_DID);
    await complete(jobRepo, 'job_self', OPERATOR_DID, 'merge-self', new Date('2026-01-01T00:00:00Z'));
    await complete(jobRepo, 'job_other', 'did:example:buyer-b', 'merge-other', new Date('2026-01-02T00:00:00Z'));

    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents/${AGENT_DID}/hires`);
      const body = (await res.json()) as {
        counts: { hires: number; buyers: number; selfHires: number; selfHireBuyers: number };
        entries: Array<{ jobId: string; selfHire: boolean }>;
      };
      const selfEntry = body.entries.find((e) => e.jobId === 'job_self');
      expect(selfEntry?.selfHire).toBe(true);
      expect(body.counts.selfHires).toBeGreaterThan(0);
      expect(body.counts.selfHireBuyers).toBeGreaterThan(0);
    });
  });

  it('every entry has a selfHire key, asserted over the whole array', async () => {
    const jobRepo = new MemoryJobRepository();
    const { app, agentRepo } = buildApp(jobRepo);
    await registerAgent(agentRepo, OPERATOR_DID);
    await complete(jobRepo, 'job_1', 'did:example:buyer-a', 'merge-1', new Date('2026-01-01T00:00:00Z'));
    await complete(jobRepo, 'job_2', OPERATOR_DID, 'merge-2', new Date('2026-01-02T00:00:00Z'));

    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents/${AGENT_DID}/hires`);
      const body = (await res.json()) as { entries: Array<Record<string, unknown>> };
      expect(body.entries).toHaveLength(2);
      for (const entry of body.entries) {
        expect(typeof entry.selfHire).toBe('boolean');
      }
    });
  });

  it('the exact key set of the response and of one entry is pinned', async () => {
    const jobRepo = new MemoryJobRepository();
    const { app, agentRepo } = buildApp(jobRepo);
    await registerAgent(agentRepo, OPERATOR_DID);
    await complete(jobRepo, 'job_1', 'did:example:buyer-a', 'merge-1', new Date('2026-01-01T00:00:00Z'));

    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents/${AGENT_DID}/hires`);
      const body = (await res.json()) as { entries: Array<Record<string, unknown>> };
      expect(Object.keys(body).sort()).toEqual(['agentDid', 'counts', 'entries']);
      expect(Object.keys(body.entries[0] as Record<string, unknown>).sort()).toEqual(
        ['agentDid', 'buyerDid', 'completedAt', 'jobId', 'mergeCommit', 'selfHire'].sort(),
      );
    });
  });

  it('503 when the job repository throws', async () => {
    const failing: JobRepository = {
      create: () => Promise.reject(new Error('unused')),
      update: () => Promise.reject(new Error('unused')),
      findById: () => Promise.reject(new Error('unused')),
      complete: () => Promise.reject(new Error('unused')),
      findCompletedByJobId: () => Promise.reject(new Error('unused')),
      findCompletedByAgent: () => Promise.reject(new Error('db down')),
    };
    const { app, agentRepo } = buildApp(failing);
    await registerAgent(agentRepo, OPERATOR_DID);
    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents/${AGENT_DID}/hires`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'storage unavailable' });
    });
  });

  it('503 when the agent repository throws', async () => {
    const failing: AgentRepository = {
      create: () => Promise.reject(new Error('unused')),
      findByDid: () => Promise.reject(new Error('db down')),
      updateGithubBinding: () => Promise.reject(new Error('unused')),
      recordKeyRotation: () => Promise.reject(new Error('unused')),
    };
    const app = createApp(new MemoryAccountRepository(), failing, undefined, undefined, new MemoryJobRepository());
    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents/${AGENT_DID}/hires`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'storage unavailable' });
    });
  });

  it('503 when the job repository does not implement findCompletedByAgent', async () => {
    const stub: JobRepository = {
      create: () => Promise.reject(new Error('unused')),
      update: () => Promise.reject(new Error('unused')),
      findById: () => Promise.reject(new Error('unused')),
      complete: () => Promise.reject(new Error('unused')),
      findCompletedByJobId: () => Promise.reject(new Error('unused')),
      // findCompletedByAgent intentionally omitted: it is optional on
      // JobRepository so older stand-ins are not forced to grow it.
    };
    const { app, agentRepo } = buildApp(stub);
    await registerAgent(agentRepo, OPERATOR_DID);
    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents/${AGENT_DID}/hires`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'storage unavailable' });
    });
  });
});
