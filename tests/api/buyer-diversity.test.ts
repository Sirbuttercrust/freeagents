// R-33: the agent's hire record over HTTP. counts and entries are derived at
// read time from completed jobs; the self-hire label rides beside the counts,
// never subtracted, so a reading of this response cannot present five
// self-hires as five independent buyers (MISSION invariant 5).
import type { Express } from 'express';
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryJobRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import type { AccountRepository, AgentRepository, JobRepository } from '../../src/adapters/storage/types.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { Job } from '../../src/domain/job.js';
import type { Account } from '../../src/domain/account.js';

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
    priceUsd: null,
    rail: null,
    priceAcceptedByBuyer: false,
    priceAcceptedByAgent: false,
    depositPercent: 25,
    redoAllowance: 1,
    redoUsedCount: 0,
    redoRequestedCriterionIndex: null,
    redoRequestedAt: null,
    redoRefusedAt: null,
    stagedLapseExtensionDays: 0,
    deliveryWindowDays: null,
    pullRequestUrl: null,
    mergeCommit: null,
    mergedAt: null,
    confirmedAt: null,
    submittedAt: null,
    deadline: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    stagedAt: null,
    stagedCommit: null,
    stagingRepo: null,
    baseCommit: null,
    stagingRepoDeleteAfter: null,
    citedCloseCriterionIndex: null,
    citedCloseReasonText: null,
    citedCloseAuthorDid: null,
    citedCloseAt: null,
    deemedCompletedAt: null,
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
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
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

function buildApp(jobRepo: JobRepository, accountRepo: AccountRepository = new MemoryAccountRepository()): {
  app: Express;
  agentRepo: MemoryAgentRepository;
} {
  const agentRepo = new MemoryAgentRepository();
  const app = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo);
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

// P7 (committee synthesis, attack 2): the DID self-hire check is free for
// an attacker to defeat, so the label gains a second, independent
// comparison on verified GitHub logins. This only raises the attacker's
// cost if the HTTP surface actually resolves and threads real logins
// through to isSelfHire -- a domain unit test injecting logins no route
// ever produces would leave the comparison unreachable in production
// (review round 1, D1).
//
// Design note, pinned rather than guessed at: Account.githubLogin is
// @unique and a DID is an Account's own primary key with no rotation or
// merge route in this build, so two DIDs can never legitimately resolve
// to the same login through the exposed /accounts registration path.
// Wiring the real per-hire lookup here (rather than leaving the login
// arguments undefined) is still the correct fix: it makes the comparison
// live the moment a later card lets one verified identity span more than
// one DID (a freed-and-reused login, or an accounts-merge feature),
// without any further change at this call site. The stand-in
// AccountRepository below asserts the wiring itself, independent of
// whether today's schema can produce the matching pair in a live system.
class TwoDidsOneLoginAccountRepository implements AccountRepository {
  private readonly byDid = new Map<string, Account>();

  register(): Promise<Account> {
    return Promise.reject(new Error('unused: accounts are seeded directly for this stand-in'));
  }

  seed(did: string, githubLogin: string): void {
    this.byDid.set(did, { did, githubLogin, passkeySubject: null, createdAt: new Date('2026-01-01T00:00:00Z') });
  }

  async findByDid(did: string): Promise<Account | null> {
    return this.byDid.get(did) ?? null;
  }

  async findByGithubLogin(githubLogin: string): Promise<Account | null> {
    for (const row of this.byDid.values()) {
      if (row.githubLogin === githubLogin) return row;
    }
    return null;
  }

  async findByPasskeySubject(): Promise<Account | null> {
    return null;
  }
}

describe('GET /agents/:agentDid/hires: the GitHub login self-hire comparison (P7)', () => {
  it('a buyer whose verified GitHub login equals the operator\'s is labelled selfHire, even under a different DID', async () => {
    const jobRepo = new MemoryJobRepository();
    const accountRepo = new TwoDidsOneLoginAccountRepository();
    accountRepo.seed(OPERATOR_DID, 'scout-owner');
    const buyerDid = 'did:example:second-identity';
    accountRepo.seed(buyerDid, 'scout-owner');
    const { app, agentRepo } = buildApp(jobRepo, accountRepo);
    await registerAgent(agentRepo, OPERATOR_DID);
    await complete(jobRepo, 'job_github_self', buyerDid, 'merge-github-self', new Date('2026-01-01T00:00:00Z'));

    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents/${AGENT_DID}/hires`);
      const body = (await res.json()) as {
        counts: { selfHires: number };
        entries: Array<{ jobId: string; selfHire: boolean }>;
      };
      const entry = body.entries.find((e) => e.jobId === 'job_github_self');
      expect(entry?.selfHire).toBe(true);
      expect(body.counts.selfHires).toBe(1);
    });
  });

  it('a buyer whose verified GitHub login differs from the operator\'s, and whose DID also differs, is not labelled selfHire', async () => {
    const jobRepo = new MemoryJobRepository();
    const accountRepo = new TwoDidsOneLoginAccountRepository();
    accountRepo.seed(OPERATOR_DID, 'scout-owner');
    const buyerDid = 'did:example:independent-buyer';
    accountRepo.seed(buyerDid, 'independent-login');
    const { app, agentRepo } = buildApp(jobRepo, accountRepo);
    await registerAgent(agentRepo, OPERATOR_DID);
    await complete(jobRepo, 'job_not_self', buyerDid, 'merge-not-self', new Date('2026-01-01T00:00:00Z'));

    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents/${AGENT_DID}/hires`);
      const body = (await res.json()) as {
        counts: { selfHires: number };
        entries: Array<{ jobId: string; selfHire: boolean }>;
      };
      const entry = body.entries.find((e) => e.jobId === 'job_not_self');
      expect(entry?.selfHire).toBe(false);
      expect(body.counts.selfHires).toBe(0);
    });
  });

  it('a buyer with no registered account at all (an unresolvable login) is not labelled selfHire on login grounds alone', async () => {
    const jobRepo = new MemoryJobRepository();
    const accountRepo = new TwoDidsOneLoginAccountRepository();
    accountRepo.seed(OPERATOR_DID, 'scout-owner');
    const buyerDid = 'did:example:unregistered-buyer';
    const { app, agentRepo } = buildApp(jobRepo, accountRepo);
    await registerAgent(agentRepo, OPERATOR_DID);
    await complete(jobRepo, 'job_unregistered', buyerDid, 'merge-unregistered', new Date('2026-01-01T00:00:00Z'));

    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents/${AGENT_DID}/hires`);
      const body = (await res.json()) as {
        entries: Array<{ jobId: string; selfHire: boolean }>;
      };
      const entry = body.entries.find((e) => e.jobId === 'job_unregistered');
      expect(entry?.selfHire).toBe(false);
    });
  });
});
