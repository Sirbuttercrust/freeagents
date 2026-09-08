// P8p: GET /accounts/:did/incoming, the operator's own read of what work
// has been offered to the agents they run. The pure waiting-on rule is
// pinned in tests/domain/incoming.test.ts; this is the HTTP acceptance
// test, following the same signed-request discipline
// tests/api/accounts-jobs.test.ts already uses for the buyer's mirror.
import type { Server } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { MemoryAccountRepository, MemoryAgentRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import { createJob, type Job, type Criterion } from '../../src/domain/job.js';
import { ALL_JOB_STATUSES } from '../../src/domain/job-list.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSessionToken } from '../helpers/session-fixtures.js';

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
    id: 'urn:uuid:delegation-for-incoming',
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

async function buildApp(jobRepoOverride?: unknown, agentRepoOverride?: unknown): Promise<Built> {
  const accountRepo = new MemoryAccountRepository();
  const agentRepo = (agentRepoOverride ?? new MemoryAgentRepository()) as MemoryAgentRepository;
  const jobRepo = (jobRepoOverride ?? new MemoryJobRepository()) as MemoryJobRepository;
  const app = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo);
  const { server, baseUrl } = await listen(app);
  return { server, baseUrl, accountRepo, agentRepo, jobRepo };
}

describe('GET /accounts/:did/incoming: authentication (done-means 6, 7)', () => {
  it('no proof at all is refused with 401 and the shared session-or-signature wording', async () => {
    const { server, baseUrl } = await buildApp();
    try {
      const res = await fetch(`${baseUrl}/accounts/did:abt:zsomeone/incoming`, { headers: { Accept: 'application/json' } });
      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body.error)).toContain('session');
      expect(String(body.error)).toContain('R-34');
    } finally {
      server.close();
    }
  });

  it('a resolved party that is not the named account is refused with 403, and the body reveals neither the account nor its offers (guard-without-a-test: the refusing branch)', async () => {
    const { server, baseUrl, accountRepo } = await buildApp();
    try {
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(51));
      const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(52));
      await accountRepo.register({ did: owner.did, githubLogin: 'incoming-owner' });
      await accountRepo.register({ did: stranger.did, githubLogin: 'incoming-stranger-caller' });
      const res = await getSigned(baseUrl, `/accounts/${owner.did}/incoming`, stranger);
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body.error)).not.toContain('exist');
      expect(JSON.stringify(body)).not.toContain('incoming-owner');
    } finally {
      server.close();
    }
  });

  it('a resolved party naming an UNREGISTERED account path is still refused with 403, never a 404 that would confirm absence, and byte-identical to the registered-but-not-owner refusal (done-means 6)', async () => {
    const { server, baseUrl, accountRepo } = await buildApp();
    try {
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(53));
      const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(54));
      await accountRepo.register({ did: owner.did, githubLogin: 'incoming-owner-2' });
      await accountRepo.register({ did: stranger.did, githubLogin: 'incoming-stranger-only' });

      const registeredRes = await getSigned(baseUrl, `/accounts/${owner.did}/incoming`, stranger);
      const unregisteredRes = await getSigned(baseUrl, '/accounts/did:abt:never-registered-anywhere/incoming', stranger);

      expect(registeredRes.status).toBe(403);
      expect(unregisteredRes.status).toBe(403);
      const registeredBody = await registeredRes.text();
      const unregisteredBody = await unregisteredRes.text();
      expect(registeredBody).toBe(unregisteredBody);
    } finally {
      server.close();
    }
  });

  it('the account reading its own incoming list succeeds with 200 (guard-without-a-test: the permitting branch)', async () => {
    const { server, baseUrl, accountRepo } = await buildApp();
    try {
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(55));
      await accountRepo.register({ did: owner.did, githubLogin: 'incoming-owner-self' });
      const res = await getSigned(baseUrl, `/accounts/${owner.did}/incoming`, owner);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(Array.isArray(body.offers)).toBe(true);
      expect(body.operatorDid).toBe(owner.did);
    } finally {
      server.close();
    }
  });
});

describe('GET /accounts/:did/incoming: storage capability (done-means 8)', () => {
  it('a driver with no findByAgentDid is 503, never a silent empty list (guard-without-a-test: removing the guard reddens this)', async () => {
    const failingJobRepo = {
      create: () => Promise.reject(new Error('unused')),
      update: () => Promise.reject(new Error('unused')),
      findById: () => Promise.reject(new Error('unused')),
      complete: () => Promise.reject(new Error('unused')),
      findCompletedByJobId: () => Promise.reject(new Error('unused')),
      // findByAgentDid deliberately omitted.
    };
    const { server, baseUrl, accountRepo } = await buildApp(failingJobRepo);
    try {
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(56));
      await accountRepo.register({ did: owner.did, githubLogin: 'incoming-503-owner' });
      const res = await getSigned(baseUrl, `/accounts/${owner.did}/incoming`, owner);
      expect(res.status).toBe(503);
    } finally {
      server.close();
    }
  });

  it('a driver with no listAll is 503, never a silent empty list (guard-without-a-test: removing the guard reddens this)', async () => {
    const failingAgentRepo = {
      create: () => Promise.reject(new Error('unused')),
      findByDid: () => Promise.resolve(null),
      updateGithubBinding: () => Promise.reject(new Error('unused')),
      recordKeyRotation: () => Promise.reject(new Error('unused')),
      // listAll deliberately omitted.
    };
    const { server, baseUrl, accountRepo } = await buildApp(undefined, failingAgentRepo);
    try {
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(57));
      await accountRepo.register({ did: owner.did, githubLogin: 'incoming-503-owner-2' });
      const res = await getSigned(baseUrl, `/accounts/${owner.did}/incoming`, owner);
      expect(res.status).toBe(503);
    } finally {
      server.close();
    }
  });
});

describe('GET /accounts/:did/incoming: only draft and proposed offers to this operator\'s agents (done-means 4, 5)', () => {
  async function seededOperator(): Promise<{ built: Built; owner: SigningIdentity; agentDid: string; buyerDid: string }> {
    const built = await buildApp();
    const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(58));
    const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(59));
    const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(60));
    await built.accountRepo.register({ did: owner.did, githubLogin: 'incoming-operator' });
    await built.accountRepo.register({ did: buyer.did, githubLogin: 'incoming-buyer' });
    await built.agentRepo.create({
      did: agent.did,
      operatorDid: owner.did,
      delegation: delegationFixture(agent.did, owner.did) as never,
      name: 'incoming-scout',
      skills: ['triage'],
      githubLogin: null,
    });
    return { built, owner, agentDid: agent.did, buyerDid: buyer.did };
  }

  it('draft and proposed rows appear; every other JobStatus is absent, proved over the whole enum (mutation proof 1, done-means 5)', async () => {
    // QA D1 (review round 1): five hand-picked statuses reach only three
    // of jobListBucketOf's five buckets, so waitingOnYou (staged,
    // submitted) went unpinned and a filter widened to include it left
    // the whole suite green. Seed one job per status in
    // ALL_JOB_STATUSES, the same enum-derived fixture list
    // tests/domain/job-list.test.ts:25-32 already uses, so a status
    // added to the union later is exercised here automatically instead
    // of waiting on a hand-picked list to be extended.
    const { built, owner, agentDid, buyerDid } = await seededOperator();
    try {
      await Promise.all(
        ALL_JOB_STATUSES.map((status, i) =>
          built.jobRepo.create(jobFixture({ id: `job-${status}`, buyerDid, agentDid, status }, new Date(2026, 7, 1 + i))),
        ),
      );

      const res = await getSigned(built.baseUrl, `/accounts/${owner.did}/incoming`, owner);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { offers: Array<{ id: string }> };
      const ids = body.offers.map((o) => o.id).sort();
      expect(ids).toEqual(['job-draft', 'job-proposed']);
    } finally {
      built.server.close();
    }
  });

  it('rows are newest first by creation time (mutation proof 6)', async () => {
    const { built, owner, agentDid, buyerDid } = await seededOperator();
    try {
      await built.jobRepo.create(jobFixture({ id: 'job-oldest', buyerDid, agentDid, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-newest', buyerDid, agentDid, status: 'draft' }, new Date('2026-08-05T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-middle', buyerDid, agentDid, status: 'draft' }, new Date('2026-08-03T00:00:00Z')));

      const res = await getSigned(built.baseUrl, `/accounts/${owner.did}/incoming`, owner);
      const body = (await res.json()) as { offers: Array<{ id: string }> };
      expect(body.offers.map((o) => o.id)).toEqual(['job-newest', 'job-middle', 'job-oldest']);
    } finally {
      built.server.close();
    }
  });

  it('a row carries id, brief verbatim, repository, agentDid, agentName, waitingOn and createdAt, with no other operator\'s offer mixed in', async () => {
    const { built, owner, agentDid, buyerDid } = await seededOperator();
    try {
      const otherOwner = await signingIdentityFromSeed(new Uint8Array(32).fill(61));
      const otherAgent = await signingIdentityFromSeed(new Uint8Array(32).fill(62));
      await built.accountRepo.register({ did: otherOwner.did, githubLogin: 'incoming-other-operator' });
      await built.agentRepo.create({
        did: otherAgent.did,
        operatorDid: otherOwner.did,
        delegation: delegationFixture(otherAgent.did, otherOwner.did) as never,
        name: 'other-scout',
        skills: ['triage'],
        githubLogin: null,
      });
      await built.jobRepo.create(jobFixture({ id: 'job-other', buyerDid, agentDid: otherAgent.did, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-mine', buyerDid, agentDid, repository: 'buyer/my-repo', brief: 'My own verbatim brief', status: 'proposed', criteria: [{ text: 'x', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: false }] }, new Date('2026-08-02T00:00:00Z')));

      const res = await getSigned(built.baseUrl, `/accounts/${owner.did}/incoming`, owner);
      const body = (await res.json()) as { offers: Array<Record<string, unknown>> };
      expect(body.offers.length).toBe(1);
      const row = body.offers[0]!;
      expect(row.id).toBe('job-mine');
      expect(row.brief).toBe('My own verbatim brief');
      expect(row.repository).toBe('buyer/my-repo');
      expect(row.agentDid).toBe(agentDid);
      expect(row.agentName).toBe('incoming-scout');
      expect(row.waitingOn).toBe('waitingOnOperator');
      expect(row.createdAt).toBe(new Date('2026-08-02T00:00:00Z').toISOString());
      expect(row).not.toHaveProperty('priority');
      expect(row).not.toHaveProperty('recommended');
      expect(row).not.toHaveProperty('urgent');
    } finally {
      built.server.close();
    }
  });

  it('an operator with agents and no offers gets a 200 with an empty offers array, not a 404 (done-means 9)', async () => {
    const { built, owner } = await seededOperator();
    try {
      const res = await getSigned(built.baseUrl, `/accounts/${owner.did}/incoming`, owner);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { offers: unknown[] };
      expect(body.offers).toEqual([]);
    } finally {
      built.server.close();
    }
  });

  it('an operator running several agents pays one agent lookup per distinct agent (done-means 10)', async () => {
    const { built, owner, buyerDid } = await seededOperator();
    try {
      const agentTwo = await signingIdentityFromSeed(new Uint8Array(32).fill(63));
      await built.agentRepo.create({
        did: agentTwo.did,
        operatorDid: owner.did,
        delegation: delegationFixture(agentTwo.did, owner.did) as never,
        name: 'second-scout',
        skills: ['triage'],
        githubLogin: null,
      });
      const firstAgentDid = (await built.agentRepo.listAll()).find((a) => a.operatorDid === owner.did && a.did !== agentTwo.did)!.did;

      await built.jobRepo.create(jobFixture({ id: 'job-1a', buyerDid, agentDid: firstAgentDid, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-1b', buyerDid, agentDid: firstAgentDid, status: 'draft' }, new Date('2026-08-02T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-2a', buyerDid, agentDid: agentTwo.did, status: 'draft' }, new Date('2026-08-03T00:00:00Z')));

      const findByDidSpy = vi.spyOn(built.agentRepo, 'findByDid');
      const res = await getSigned(built.baseUrl, `/accounts/${owner.did}/incoming`, owner);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { offers: unknown[] };
      expect(body.offers.length).toBe(3);
      // Auth itself may resolve the caller's own DID through agentRepo
      // as part of the signing-key check, so the assertion counts only
      // lookups of the two AGENT DIDs this route caches, not the raw
      // call total.
      const agentLookupCalls = findByDidSpy.mock.calls.filter(
        ([lookedUp]) => lookedUp === firstAgentDid || lookedUp === agentTwo.did,
      );
      expect(agentLookupCalls.length).toBe(2);
    } finally {
      built.server.close();
    }
  });

  it('the roster filter uses the exact operatorDid comparison, not isAgentOperator suffix matching (mutation proof 5)', async () => {
    const built = await buildApp();
    try {
      // Two DID strings that share a suffix under didSuffix's own
      // reconciliation (agent.ts:35-37: the did:abt: prefix is
      // stripped before comparing) but are NOT the same registered
      // account. The exact-comparison roster must tell them apart even
      // though isAgentOperator would not.
      const suffix = 'zRosterCollisionSuffix';
      const realOperatorDid = `did:abt:${suffix}`;
      const collidingCallerDid = suffix;
      const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(66));
      const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(67));
      await built.accountRepo.register({ did: realOperatorDid, githubLogin: 'exact-owner' });
      await built.accountRepo.register({ did: collidingCallerDid, githubLogin: 'roster-collision-caller' });
      await built.accountRepo.register({ did: buyer.did, githubLogin: 'exact-buyer' });
      await built.agentRepo.create({
        did: agent.did,
        operatorDid: realOperatorDid,
        delegation: delegationFixture(agent.did, realOperatorDid) as never,
        name: 'exact-scout',
        skills: ['triage'],
        githubLogin: null,
      });
      await built.jobRepo.create(jobFixture({ id: 'job-exact', buyerDid: buyer.did, agentDid: agent.did, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));

      // The colliding caller authenticates as ITSELF (a session naming
      // its own account, whose did string has no did:abt: prefix) and
      // reads its OWN incoming list at that same did string. It must
      // see none of the real operator's agents or offers, even though
      // isAgentOperator would call the two DIDs equal.
      const sessionAdapter = createSessionAdapter({
        github: fakeGitHubConfig(),
        fetchImpl: fakeGitHubFetch({ login: 'roster-collision-caller', id: 909090 }),
      });
      const appWithSession = createApp(built.accountRepo, built.agentRepo, undefined, undefined, built.jobRepo, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter);
      const { server: sessionServer, baseUrl: sessionBaseUrl } = await listen(appWithSession);
      try {
        const token = await mintSessionToken(sessionAdapter);
        const res = await fetch(`${sessionBaseUrl}/accounts/${collidingCallerDid}/incoming`, {
          headers: { Accept: 'application/json', authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { offers: unknown[] };
        expect(body.offers).toEqual([]);
      } finally {
        sessionServer.close();
      }
    } finally {
      built.server.close();
    }
  });
});

describe('GET /accounts/:did/incoming: waitingOn reflects the criteria, not the proposer (done-means 2)', () => {
  it('a buyer-authored unsigned criterion still reads waitingOnOperator', async () => {
    const built = await buildApp();
    try {
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(68));
      const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(69));
      const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(70));
      await built.accountRepo.register({ did: owner.did, githubLogin: 'waitingon-owner' });
      await built.accountRepo.register({ did: buyer.did, githubLogin: 'waitingon-buyer' });
      await built.agentRepo.create({
        did: agent.did,
        operatorDid: owner.did,
        delegation: delegationFixture(agent.did, owner.did) as never,
        name: 'waitingon-scout',
        skills: ['triage'],
        githubLogin: null,
      });
      const criteria: Criterion[] = [{ text: 'buyer wrote this', proposedBy: 'buyer', acceptedByBuyer: true, acceptedByAgent: false }];
      await built.jobRepo.create(jobFixture({ id: 'job-buyer-authored', buyerDid: buyer.did, agentDid: agent.did, status: 'proposed', criteria }, new Date('2026-08-01T00:00:00Z')));

      const res = await getSigned(built.baseUrl, `/accounts/${owner.did}/incoming`, owner);
      const body = (await res.json()) as { offers: Array<{ waitingOn: string }> };
      expect(body.offers[0]!.waitingOn).toBe('waitingOnOperator');
    } finally {
      built.server.close();
    }
  });
});
