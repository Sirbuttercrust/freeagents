// P8t: GET /accounts/:did/pending, the buyer's own read of the hires they
// have started that are not real yet (a brief with no reply, an agreement
// waiting on a signature). The mirror of P8p's
// tests/api/accounts-incoming.test.ts, over the same waitingOnOf rule
// pinned in tests/domain/incoming.test.ts, following the same
// signed-request discipline every acting-party route test here uses.
import type { Server } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAccountRepository, MemoryAgentRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import { createJob, type Job, type Criterion } from '../../src/domain/job.js';
import { ALL_JOB_STATUSES } from '../../src/domain/job-list.js';
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
    id: 'urn:uuid:delegation-for-pending',
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

describe('GET /accounts/:did/pending: authentication (done-means 9)', () => {
  it('no proof at all is refused with 401 and the shared session-or-signature wording', async () => {
    const { server, baseUrl } = await buildApp();
    try {
      const res = await fetch(`${baseUrl}/accounts/did:abt:zsomeone/pending`, { headers: { Accept: 'application/json' } });
      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body.error)).toContain('session');
      expect(String(body.error)).toContain('R-34');
    } finally {
      server.close();
    }
  });

  it('a resolved party that is not the named account is refused with 403, and the body reveals neither the account nor its rows (guard-without-a-test: the refusing branch)', async () => {
    const { server, baseUrl, accountRepo } = await buildApp();
    try {
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(81));
      const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(82));
      await accountRepo.register({ did: owner.did, githubLogin: 'pending-owner' });
      await accountRepo.register({ did: stranger.did, githubLogin: 'pending-stranger-caller' });
      const res = await getSigned(baseUrl, `/accounts/${owner.did}/pending`, stranger);
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body.error)).not.toContain('exist');
      expect(JSON.stringify(body)).not.toContain('pending-owner');
    } finally {
      server.close();
    }
  });

  it('a resolved party naming an UNREGISTERED account path is still refused with 403, never a 404 that would confirm absence', async () => {
    const { server, baseUrl, accountRepo } = await buildApp();
    try {
      const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(83));
      await accountRepo.register({ did: stranger.did, githubLogin: 'pending-stranger-only' });
      const res = await getSigned(baseUrl, '/accounts/did:abt:never-registered-anywhere/pending', stranger);
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('the account reading its own pending list succeeds with 200 (guard-without-a-test: the permitting branch)', async () => {
    const { server, baseUrl, accountRepo } = await buildApp();
    try {
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(84));
      await accountRepo.register({ did: owner.did, githubLogin: 'pending-owner-self' });
      const res = await getSigned(baseUrl, `/accounts/${owner.did}/pending`, owner);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(Array.isArray(body.pending)).toBe(true);
      expect(body.buyerDid).toBe(owner.did);
    } finally {
      server.close();
    }
  });
});

describe('GET /accounts/:did/pending: storage capability (done-means 10)', () => {
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
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(85));
      await accountRepo.register({ did: owner.did, githubLogin: 'pending-503-owner' });
      const res = await getSigned(baseUrl, `/accounts/${owner.did}/pending`, owner);
      expect(res.status).toBe(503);
    } finally {
      server.close();
    }
  });

  it('a storage throw from findByBuyerDid is 503, never a silent empty list', async () => {
    const throwingJobRepo = {
      create: () => Promise.reject(new Error('unused')),
      update: () => Promise.reject(new Error('unused')),
      findById: () => Promise.reject(new Error('unused')),
      complete: () => Promise.reject(new Error('unused')),
      findCompletedByJobId: () => Promise.reject(new Error('unused')),
      findByBuyerDid: () => Promise.reject(new Error('db down')),
    };
    const { server, baseUrl, accountRepo } = await buildApp(throwingJobRepo);
    try {
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(86));
      await accountRepo.register({ did: owner.did, githubLogin: 'pending-503-throw-owner' });
      const res = await getSigned(baseUrl, `/accounts/${owner.did}/pending`, owner);
      expect(res.status).toBe(503);
    } finally {
      server.close();
    }
  });
});

describe('GET /accounts/:did/pending: only draft and proposed rows for this buyer (done-means 2, 3, 8)', () => {
  async function seededBuyer(): Promise<{ built: Built; owner: SigningIdentity; agentDid: string }> {
    const built = await buildApp();
    const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(87));
    const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(88));
    const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(89));
    await built.accountRepo.register({ did: owner.did, githubLogin: 'pending-buyer' });
    await built.accountRepo.register({ did: operator.did, githubLogin: 'pending-operator' });
    await built.agentRepo.create({
      did: agent.did,
      operatorDid: operator.did,
      delegation: delegationFixture(agent.did, operator.did) as never,
      name: 'pending-scout',
      skills: ['triage'],
      githubLogin: null,
    });
    return { built, owner, agentDid: agent.did };
  }

  it('draft and proposed rows appear; every other JobStatus is absent, proved over the whole enum (mutation proof 1, 2, done-means 2)', async () => {
    const { built, owner, agentDid } = await seededBuyer();
    try {
      await Promise.all(
        ALL_JOB_STATUSES.map((status, i) =>
          built.jobRepo.create(jobFixture({ id: `job-${status}`, buyerDid: owner.did, agentDid, status }, new Date(2026, 7, 1 + i))),
        ),
      );

      const res = await getSigned(built.baseUrl, `/accounts/${owner.did}/pending`, owner);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { pending: Array<{ id: string }> };
      const ids = body.pending.map((p) => p.id).sort();
      expect(ids).toEqual(['job-draft', 'job-proposed']);
    } finally {
      built.server.close();
    }
  });

  it('rows are newest first by creation time (mutation proof 8)', async () => {
    const { built, owner, agentDid } = await seededBuyer();
    try {
      await built.jobRepo.create(jobFixture({ id: 'job-oldest', buyerDid: owner.did, agentDid, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-newest', buyerDid: owner.did, agentDid, status: 'draft' }, new Date('2026-08-05T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-middle', buyerDid: owner.did, agentDid, status: 'draft' }, new Date('2026-08-03T00:00:00Z')));

      const res = await getSigned(built.baseUrl, `/accounts/${owner.did}/pending`, owner);
      const body = (await res.json()) as { pending: Array<{ id: string }> };
      expect(body.pending.map((p) => p.id)).toEqual(['job-newest', 'job-middle', 'job-oldest']);
    } finally {
      built.server.close();
    }
  });

  it('a row carries id, brief verbatim, repository, agentDid, agentName, status, waitingOn and createdAt, with no other buyer\'s row mixed in, and no ranking field (done-means 4, 5, 6, 12)', async () => {
    const { built, owner, agentDid } = await seededBuyer();
    try {
      const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(90));
      await built.accountRepo.register({ did: stranger.did, githubLogin: 'pending-stranger-buyer' });
      await built.jobRepo.create(jobFixture({ id: 'job-strangers', buyerDid: stranger.did, agentDid, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-mine', buyerDid: owner.did, agentDid, repository: 'buyer/my-repo', brief: 'My own verbatim brief', status: 'proposed', criteria: [{ text: 'x', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: true }] }, new Date('2026-08-02T00:00:00Z')));

      const res = await getSigned(built.baseUrl, `/accounts/${owner.did}/pending`, owner);
      const body = (await res.json()) as { pending: Array<Record<string, unknown>> };
      expect(body.pending.length).toBe(1);
      const row = body.pending[0]!;
      expect(row.id).toBe('job-mine');
      expect(row.brief).toBe('My own verbatim brief');
      expect(row.repository).toBe('buyer/my-repo');
      expect(row.agentDid).toBe(agentDid);
      expect(row.agentName).toBe('pending-scout');
      expect(row.status).toBe('proposed');
      expect(row.waitingOn).toBe('waitingOnBuyer');
      expect(row.createdAt).toBe(new Date('2026-08-02T00:00:00Z').toISOString());
      expect(row).not.toHaveProperty('bucket');
      expect(row).not.toHaveProperty('priority');
      expect(row).not.toHaveProperty('recommended');
      expect(row).not.toHaveProperty('urgent');
      expect(row).not.toHaveProperty('stale');
      expect(row).not.toHaveProperty('overdue');
    } finally {
      built.server.close();
    }
  });

  it('the agentName falls back to the agent DID when no agent row resolves (done-means 6)', async () => {
    const built = await buildApp();
    try {
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(91));
      const unknownAgentDid = 'did:abt:zUnknownAgentNeverRegistered';
      await built.accountRepo.register({ did: owner.did, githubLogin: 'pending-unknown-agent-buyer' });
      await built.jobRepo.create(jobFixture({ id: 'job-unknown-agent', buyerDid: owner.did, agentDid: unknownAgentDid, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));

      const res = await getSigned(built.baseUrl, `/accounts/${owner.did}/pending`, owner);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { pending: Array<{ agentName: string }> };
      expect(body.pending[0]!.agentName).toBe(unknownAgentDid);
    } finally {
      built.server.close();
    }
  });

  it('an account with no unconfirmed hires gets a 200 with an empty pending array, not a 404 (done-means 11, mutation proof 9)', async () => {
    const { built, owner } = await seededBuyer();
    try {
      const res = await getSigned(built.baseUrl, `/accounts/${owner.did}/pending`, owner);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { pending: unknown[] };
      expect(body.pending).toEqual([]);
    } finally {
      built.server.close();
    }
  });

  it('a buyer with several briefs to one agent pays one agent lookup per distinct agent DID, not per row (done-means 7)', async () => {
    const { built, owner, agentDid } = await seededBuyer();
    try {
      await built.jobRepo.create(jobFixture({ id: 'job-1a', buyerDid: owner.did, agentDid, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-1b', buyerDid: owner.did, agentDid, status: 'draft' }, new Date('2026-08-02T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-1c', buyerDid: owner.did, agentDid, status: 'draft' }, new Date('2026-08-03T00:00:00Z')));

      const findByDidSpy = vi.spyOn(built.agentRepo, 'findByDid');
      const res = await getSigned(built.baseUrl, `/accounts/${owner.did}/pending`, owner);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { pending: unknown[] };
      expect(body.pending.length).toBe(3);
      const agentLookupCalls = findByDidSpy.mock.calls.filter(([lookedUp]) => lookedUp === agentDid);
      expect(agentLookupCalls.length).toBe(1);
    } finally {
      built.server.close();
    }
  });
});

describe('GET /accounts/:did/pending: waitingOn is waitingOnOf unchanged (done-means 5, mutation proof 7)', () => {
  it('reflects all three values of waitingOnOf over a fixture holding one job of each kind', async () => {
    const built = await buildApp();
    try {
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(92));
      const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(93));
      const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(94));
      await built.accountRepo.register({ did: owner.did, githubLogin: 'waitingon-pending-buyer' });
      await built.accountRepo.register({ did: operator.did, githubLogin: 'waitingon-pending-operator' });
      await built.agentRepo.create({
        did: agent.did,
        operatorDid: operator.did,
        delegation: delegationFixture(agent.did, operator.did) as never,
        name: 'waitingon-pending-scout',
        skills: ['triage'],
        githubLogin: null,
      });

      // noReply: no criteria at all.
      await built.jobRepo.create(jobFixture({ id: 'job-no-reply', buyerDid: owner.did, agentDid: agent.did, status: 'draft', criteria: [] }, new Date('2026-08-01T00:00:00Z')));
      // waitingOnBuyer: every line accepted by the agent.
      const acceptedCriteria: Criterion[] = [{ text: 'agent proposed', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: true }];
      await built.jobRepo.create(jobFixture({ id: 'job-waiting-buyer', buyerDid: owner.did, agentDid: agent.did, status: 'proposed', criteria: acceptedCriteria }, new Date('2026-08-02T00:00:00Z')));
      // waitingOnOperator: a buyer's own unsigned edit still reads
      // waitingOnOperator (incoming.ts:14-19), because acceptedByAgent
      // is false regardless of who proposed it.
      const buyerEditedCriteria: Criterion[] = [{ text: 'buyer edited this', proposedBy: 'buyer', acceptedByBuyer: true, acceptedByAgent: false }];
      await built.jobRepo.create(jobFixture({ id: 'job-waiting-operator', buyerDid: owner.did, agentDid: agent.did, status: 'proposed', criteria: buyerEditedCriteria }, new Date('2026-08-03T00:00:00Z')));

      const res = await getSigned(built.baseUrl, `/accounts/${owner.did}/pending`, owner);
      const body = (await res.json()) as { pending: Array<{ id: string; waitingOn: string }> };
      const waitingOnById = Object.fromEntries(body.pending.map((p) => [p.id, p.waitingOn]));
      expect(waitingOnById['job-no-reply']).toBe('noReply');
      expect(waitingOnById['job-waiting-buyer']).toBe('waitingOnBuyer');
      expect(waitingOnById['job-waiting-operator']).toBe('waitingOnOperator');
    } finally {
      built.server.close();
    }
  });
});
