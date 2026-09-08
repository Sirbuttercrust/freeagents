// P8m: GET /accounts/:did/jobs, the buyer's own list of everything they
// have hired (P-16). The pure bucketing rule is pinned in
// tests/domain/job-list.test.ts; this is the HTTP acceptance test,
// following the same signed-request discipline every other acting-party
// route test in this directory uses.
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAccountRepository, MemoryAgentRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import { createJob, type Job, type JobStatus } from '../../src/domain/job.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

async function getSigned(baseUrl: string, path: string, identity: SigningIdentity): Promise<Response> {
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, 'GET', targetUri, { components: ['@method', '@target-uri', 'content-digest'] });
  return fetch(targetUri, {
    headers: {
      Accept: 'application/json',
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
  });
}

async function listen(app: ReturnType<typeof createApp>): Promise<{ server: Server; baseUrl: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a port');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function delegationFixture(agentDid: string, operatorDid: string): Record<string, unknown> {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-myjobs',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: agentDid },
    proof: { type: 'Ed25519Signature2020', created: '2026-01-01T00:00:00Z', verificationMethod: `${agentDid}#key-1`, proofPurpose: 'assertionMethod', proofValue: 'zfixture-not-verified-here' },
  };
}

function jobFixture(overrides: Partial<Job> & { id: string; buyerDid: string; agentDid: string }, createdAt: Date): Job {
  const base = createJob(
    { id: overrides.id, buyerDid: overrides.buyerDid, agentDid: overrides.agentDid, repository: overrides.repository ?? 'buyer/target-repo', brief: overrides.brief ?? 'Fix the login bug' },
    createdAt,
  );
  return { ...base, ...overrides };
}

interface Built {
  readonly server: Server;
  readonly baseUrl: string;
  readonly accountRepo: MemoryAccountRepository;
  readonly agentRepo: MemoryAgentRepository;
  readonly jobRepo: MemoryJobRepository;
}

async function buildApp(jobRepoOverride?: unknown): Promise<Built> {
  const accountRepo = new MemoryAccountRepository();
  const agentRepo = new MemoryAgentRepository();
  const jobRepo = (jobRepoOverride ?? new MemoryJobRepository()) as MemoryJobRepository;
  const app = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo);
  const { server, baseUrl } = await listen(app);
  return { server, baseUrl, accountRepo, agentRepo, jobRepo };
}

describe('GET /accounts/:did/jobs: authentication (done-means 2)', () => {
  it('no proof at all is refused with 401 and the shared session-or-signature wording', async () => {
    const { server, baseUrl } = await buildApp();
    try {
      const res = await fetch(`${baseUrl}/accounts/did:abt:zsomeone/jobs`, { headers: { Accept: 'application/json' } });
      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body.error)).toContain('session');
      expect(String(body.error)).toContain('R-34');
    } finally {
      server.close();
    }
  });

  it('a resolved party that is not the named account is refused with 403, and the body reveals neither the account nor its jobs (guard-without-a-test: the refusing branch)', async () => {
    const { server, baseUrl, accountRepo } = await buildApp();
    try {
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(41));
      const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(42));
      await accountRepo.register({ did: owner.did, githubLogin: 'myjobs-owner' });
      await accountRepo.register({ did: stranger.did, githubLogin: 'myjobs-stranger-caller' });
      const res = await getSigned(baseUrl, `/accounts/${owner.did}/jobs`, stranger);
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body.error)).not.toContain('exist');
      expect(JSON.stringify(body)).not.toContain('myjobs-owner');
    } finally {
      server.close();
    }
  });

  it('a resolved party naming an UNREGISTERED account path is still refused with 403, never a 404 that would confirm absence', async () => {
    const { server, baseUrl, accountRepo } = await buildApp();
    try {
      const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(43));
      await accountRepo.register({ did: stranger.did, githubLogin: 'myjobs-stranger-only' });
      const res = await getSigned(baseUrl, '/accounts/did:abt:never-registered-anywhere/jobs', stranger);
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('the account reading its own list succeeds with 200 (guard-without-a-test: the permitting branch)', async () => {
    const { server, baseUrl, accountRepo } = await buildApp();
    try {
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(44));
      await accountRepo.register({ did: owner.did, githubLogin: 'myjobs-owner-self' });
      const res = await getSigned(baseUrl, `/accounts/${owner.did}/jobs`, owner);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(Array.isArray(body.jobs)).toBe(true);
    } finally {
      server.close();
    }
  });
});

describe('GET /accounts/:did/jobs: storage capability (done-means 3)', () => {
  it('a driver with no findByBuyerDid is 503, never a silent empty list (guard-without-a-test: removing the guard reddens this)', async () => {
    const failingJobRepo = {
      create: () => Promise.reject(new Error('unused')),
      update: () => Promise.reject(new Error('unused')),
      findById: () => Promise.reject(new Error('unused')),
      complete: () => Promise.reject(new Error('unused')),
      findCompletedByJobId: () => Promise.reject(new Error('unused')),
      // findByBuyerDid deliberately omitted.
    };
    const { server, baseUrl, accountRepo } = await buildApp(failingJobRepo);
    try {
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(45));
      await accountRepo.register({ did: owner.did, githubLogin: 'myjobs-503-owner' });
      const res = await getSigned(baseUrl, `/accounts/${owner.did}/jobs`, owner);
      expect(res.status).toBe(503);
    } finally {
      server.close();
    }
  });
});

describe('GET /accounts/:did/jobs: only real jobs, newest first, one row per hire (done-means 1, 4)', () => {
  async function seededOwner(): Promise<{ built: Built; owner: SigningIdentity; agentDid: string }> {
    const built = await buildApp();
    const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(46));
    const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(47));
    const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(48));
    await built.accountRepo.register({ did: owner.did, githubLogin: 'myjobs-lister' });
    await built.accountRepo.register({ did: operator.did, githubLogin: 'myjobs-operator' });
    await built.agentRepo.create({
      did: agent.did,
      operatorDid: operator.did,
      delegation: delegationFixture(agent.did, operator.did) as never,
      name: 'myjobs-scout',
      skills: ['triage'],
      githubLogin: null,
    });
    return { built, owner, agentDid: agent.did };
  }

  it('draft and proposed rows never appear, even though they belong to this buyer (mutation proof 2)', async () => {
    const { built, owner, agentDid } = await seededOwner();
    try {
      await built.jobRepo.create(jobFixture({ id: 'job-draft', buyerDid: owner.did, agentDid, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-proposed', buyerDid: owner.did, agentDid, status: 'proposed', criteria: [{ text: 'x', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: false }] }, new Date('2026-08-02T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-confirmed', buyerDid: owner.did, agentDid, status: 'confirmed', confirmedAt: new Date('2026-08-03T00:00:00Z') }, new Date('2026-08-03T00:00:00Z')));

      const res = await getSigned(built.baseUrl, `/accounts/${owner.did}/jobs`, owner);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { jobs: Array<{ id: string }> };
      const ids = body.jobs.map((j) => j.id);
      expect(ids).not.toContain('job-draft');
      expect(ids).not.toContain('job-proposed');
      expect(ids).toContain('job-confirmed');
    } finally {
      built.server.close();
    }
  });

  it('rows are newest first by creation time', async () => {
    const { built, owner, agentDid } = await seededOwner();
    try {
      await built.jobRepo.create(jobFixture({ id: 'job-oldest', buyerDid: owner.did, agentDid, status: 'confirmed', confirmedAt: new Date('2026-08-01T00:00:00Z') }, new Date('2026-08-01T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-newest', buyerDid: owner.did, agentDid, status: 'confirmed', confirmedAt: new Date('2026-08-05T00:00:00Z') }, new Date('2026-08-05T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-middle', buyerDid: owner.did, agentDid, status: 'confirmed', confirmedAt: new Date('2026-08-03T00:00:00Z') }, new Date('2026-08-03T00:00:00Z')));

      const res = await getSigned(built.baseUrl, `/accounts/${owner.did}/jobs`, owner);
      const body = (await res.json()) as { jobs: Array<{ id: string }> };
      expect(body.jobs.map((j) => j.id)).toEqual(['job-newest', 'job-middle', 'job-oldest']);
    } finally {
      built.server.close();
    }
  });

  it('a confirmed job row carries id, brief, agent name, repository, status, bucket and the confirmedAt date, with no other account\'s job mixed in', async () => {
    const { built, owner, agentDid } = await seededOwner();
    try {
      const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(49));
      await built.accountRepo.register({ did: stranger.did, githubLogin: 'myjobs-stranger' });
      await built.jobRepo.create(jobFixture({ id: 'job-strangers', buyerDid: stranger.did, agentDid, status: 'confirmed', confirmedAt: new Date('2026-08-01T00:00:00Z') }, new Date('2026-08-01T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-mine', buyerDid: owner.did, agentDid, repository: 'buyer/my-repo', brief: 'My own brief', status: 'confirmed', confirmedAt: new Date('2026-08-02T00:00:00Z') }, new Date('2026-08-02T00:00:00Z')));

      const res = await getSigned(built.baseUrl, `/accounts/${owner.did}/jobs`, owner);
      const body = (await res.json()) as { jobs: Array<Record<string, unknown>> };
      expect(body.jobs.length).toBe(1);
      const row = body.jobs[0]!;
      expect(row.id).toBe('job-mine');
      expect(row.brief).toBe('My own brief');
      expect(row.agentName).toBe('myjobs-scout');
      expect(row.repository).toBe('buyer/my-repo');
      expect(row.status).toBe('confirmed');
      expect(row.bucket).toBe('inProgress');
      expect(row.date).toBe(new Date('2026-08-02T00:00:00Z').toISOString());
    } finally {
      built.server.close();
    }
  });

  it('the four buckets across a mixed set sum to the All count by construction (mutation proof: the domain function stays total)', async () => {
    const { built, owner, agentDid } = await seededOwner();
    try {
      const rows: Array<{ id: string; status: JobStatus; extra?: Partial<Job> }> = [
        { id: 'b-staged', status: 'staged', extra: { stagedAt: new Date('2026-08-01T00:00:00Z') } },
        { id: 'b-submitted', status: 'submitted', extra: { submittedAt: new Date('2026-08-02T00:00:00Z') } },
        { id: 'b-confirmed', status: 'confirmed', extra: { confirmedAt: new Date('2026-08-03T00:00:00Z') } },
        { id: 'b-completed', status: 'completed', extra: { mergedAt: new Date('2026-08-04T00:00:00Z') } },
        { id: 'b-declined', status: 'declined' },
      ];
      for (const r of rows) {
        await built.jobRepo.create(jobFixture({ id: r.id, buyerDid: owner.did, agentDid, status: r.status, ...r.extra }, new Date('2026-08-01T00:00:00Z')));
      }
      const res = await getSigned(built.baseUrl, `/accounts/${owner.did}/jobs`, owner);
      const body = (await res.json()) as { jobs: Array<{ bucket: string }> };
      expect(body.jobs.length).toBe(5);
      const counts: Record<string, number> = {};
      body.jobs.forEach((j) => { counts[j.bucket] = (counts[j.bucket] ?? 0) + 1; });
      const sum = Object.values(counts).reduce((a, b) => a + b, 0);
      expect(sum).toBe(body.jobs.length);
      expect(counts.waitingOnYou).toBe(2);
      expect(counts.inProgress).toBe(1);
      expect(counts.shipped).toBe(1);
      expect(counts.notShipped).toBe(1);
    } finally {
      built.server.close();
    }
  });

  it('an account with no hires reads back an empty array, not an error', async () => {
    const { built, owner } = await seededOwner();
    try {
      const res = await getSigned(built.baseUrl, `/accounts/${owner.did}/jobs`, owner);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { jobs: unknown[] };
      expect(body.jobs).toEqual([]);
    } finally {
      built.server.close();
    }
  });
});
