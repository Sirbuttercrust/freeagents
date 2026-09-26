// MSG1a (Make item 1): GET /accounts/:did/threads, the conversation list
// for both seats (buyer and owner). Follows the same signed-request
// discipline tests/api/accounts-jobs.test.ts and
// tests/api/accounts-incoming.test.ts already use.
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryJobRepository,
  MemoryMessageRepository,
  MemoryThreadReadStateRepository,
} from '../../src/adapters/storage/memory.js';
import { createJob, type Job } from '../../src/domain/job.js';
import { createMessage, createSystemMessage, advanceReadState, type Message } from '../../src/domain/message.js';
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
    id: 'urn:uuid:delegation-for-threads',
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
  readonly messageRepo: MemoryMessageRepository;
  readonly threadReadStateRepo: MemoryThreadReadStateRepository;
}

async function buildApp(jobRepoOverride?: unknown, agentRepoOverride?: unknown): Promise<Built> {
  const accountRepo = new MemoryAccountRepository();
  const agentRepo = (agentRepoOverride ?? new MemoryAgentRepository()) as MemoryAgentRepository;
  const jobRepo = (jobRepoOverride ?? new MemoryJobRepository()) as MemoryJobRepository;
  const messageRepo = new MemoryMessageRepository();
  const threadReadStateRepo = new MemoryThreadReadStateRepository();
  const app = createApp(
    accountRepo,
    agentRepo,
    undefined,
    undefined,
    jobRepo,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    messageRepo,
    threadReadStateRepo,
  );
  const { server, baseUrl } = await listen(app);
  return { server, baseUrl, accountRepo, agentRepo, jobRepo, messageRepo, threadReadStateRepo };
}

describe('GET /accounts/:did/threads: authentication', () => {
  it('no proof at all is refused with 401 and the shared session-or-signature wording', async () => {
    const { server, baseUrl } = await buildApp();
    try {
      const res = await fetch(`${baseUrl}/accounts/did:abt:zsomeone/threads`, { headers: { Accept: 'application/json' } });
      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body.error)).toContain('session');
      expect(String(body.error)).toContain('R-34');
    } finally {
      server.close();
    }
  });

  it('a resolved party that is not the named account is refused with 403, revealing neither the account nor its threads', async () => {
    const { server, baseUrl, accountRepo } = await buildApp();
    try {
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(201));
      const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(202));
      await accountRepo.register({ did: owner.did, githubLogin: 'threads-owner' });
      await accountRepo.register({ did: stranger.did, githubLogin: 'threads-stranger-caller' });
      const res = await getSigned(baseUrl, `/accounts/${owner.did}/threads`, stranger);
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body.error)).not.toContain('exist');
      expect(JSON.stringify(body)).not.toContain('threads-owner');
    } finally {
      server.close();
    }
  });

  it('a resolved party naming an UNREGISTERED account is still refused with 403, never a 404', async () => {
    const { server, baseUrl, accountRepo } = await buildApp();
    try {
      const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(203));
      await accountRepo.register({ did: stranger.did, githubLogin: 'threads-stranger-only' });
      const res = await getSigned(baseUrl, '/accounts/did:abt:never-registered-anywhere/threads', stranger);
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('the account reading its own thread list succeeds with 200, a DID-signed request', async () => {
    const { server, baseUrl, accountRepo } = await buildApp();
    try {
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(204));
      await accountRepo.register({ did: owner.did, githubLogin: 'threads-owner-self' });
      const res = await getSigned(baseUrl, `/accounts/${owner.did}/threads`, owner);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(Array.isArray(body.threads)).toBe(true);
      expect(body.unreadTotal).toBe(0);
    } finally {
      server.close();
    }
  });
});

describe('GET /accounts/:did/threads: storage capability', () => {
  it('a driver with no findByBuyerDid is 503, never a silent empty list', async () => {
    const failingJobRepo = {
      create: () => Promise.reject(new Error('unused')),
      update: () => Promise.reject(new Error('unused')),
      findById: () => Promise.reject(new Error('unused')),
      complete: () => Promise.reject(new Error('unused')),
      findCompletedByJobId: () => Promise.reject(new Error('unused')),
      findByAgentDid: () => Promise.resolve([]),
      // findByBuyerDid deliberately omitted.
    };
    const { server, baseUrl, accountRepo } = await buildApp(failingJobRepo);
    try {
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(205));
      await accountRepo.register({ did: owner.did, githubLogin: 'threads-503-owner-1' });
      const res = await getSigned(baseUrl, `/accounts/${owner.did}/threads`, owner);
      expect(res.status).toBe(503);
    } finally {
      server.close();
    }
  });

  it('a driver with no findByAgentDid is 503, never a silent empty list', async () => {
    const failingJobRepo = {
      create: () => Promise.reject(new Error('unused')),
      update: () => Promise.reject(new Error('unused')),
      findById: () => Promise.reject(new Error('unused')),
      complete: () => Promise.reject(new Error('unused')),
      findCompletedByJobId: () => Promise.reject(new Error('unused')),
      findByBuyerDid: () => Promise.resolve([]),
      // findByAgentDid deliberately omitted.
    };
    const { server, baseUrl, accountRepo } = await buildApp(failingJobRepo);
    try {
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(206));
      await accountRepo.register({ did: owner.did, githubLogin: 'threads-503-owner-2' });
      const res = await getSigned(baseUrl, `/accounts/${owner.did}/threads`, owner);
      expect(res.status).toBe(503);
    } finally {
      server.close();
    }
  });

  it('a driver with no listAll on the agent repository is 503, never a silent empty list', async () => {
    const failingAgentRepo = {
      create: () => Promise.reject(new Error('unused')),
      findByDid: () => Promise.resolve(null),
      updateGithubBinding: () => Promise.reject(new Error('unused')),
      recordKeyRotation: () => Promise.reject(new Error('unused')),
      // listAll deliberately omitted.
    };
    const { server, baseUrl, accountRepo } = await buildApp(undefined, failingAgentRepo);
    try {
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(207));
      await accountRepo.register({ did: owner.did, githubLogin: 'threads-503-owner-3' });
      const res = await getSigned(baseUrl, `/accounts/${owner.did}/threads`, owner);
      expect(res.status).toBe(503);
    } finally {
      server.close();
    }
  });
});

describe('GET /accounts/:did/threads: privacy', () => {
  it('a stranger with no jobs at all gets an empty list, never another account\'s job', async () => {
    const built = await buildApp();
    try {
      const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(208));
      const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(209));
      const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(210));
      await built.accountRepo.register({ did: stranger.did, githubLogin: 'threads-priv-stranger' });
      await built.accountRepo.register({ did: buyer.did, githubLogin: 'threads-priv-buyer' });
      await built.agentRepo.create({
        did: agent.did,
        operatorDid: buyer.did,
        delegation: delegationFixture(agent.did, buyer.did) as never,
        name: 'threads-priv-scout',
        skills: ['triage'],
        githubLogin: null,
      });
      await built.jobRepo.create(jobFixture({ id: 'job-not-strangers', buyerDid: buyer.did, agentDid: agent.did, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));

      const res = await getSigned(built.baseUrl, `/accounts/${stranger.did}/threads`, stranger);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { threads: unknown[] };
      expect(body.threads).toEqual([]);
    } finally {
      built.server.close();
    }
  });

  it('a sibling job on a DIFFERENT owner\'s agent (same requestId) never appears in that other owner\'s list', async () => {
    const built = await buildApp();
    try {
      const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(211));
      const ownerA = await signingIdentityFromSeed(new Uint8Array(32).fill(212));
      const ownerB = await signingIdentityFromSeed(new Uint8Array(32).fill(213));
      const agentA = await signingIdentityFromSeed(new Uint8Array(32).fill(214));
      const agentB = await signingIdentityFromSeed(new Uint8Array(32).fill(215));
      await built.accountRepo.register({ did: buyer.did, githubLogin: 'threads-sibling-buyer' });
      await built.accountRepo.register({ did: ownerA.did, githubLogin: 'threads-sibling-owner-a' });
      await built.accountRepo.register({ did: ownerB.did, githubLogin: 'threads-sibling-owner-b' });
      await built.agentRepo.create({ did: agentA.did, operatorDid: ownerA.did, delegation: delegationFixture(agentA.did, ownerA.did) as never, name: 'scout-a', skills: ['triage'], githubLogin: null });
      await built.agentRepo.create({ did: agentB.did, operatorDid: ownerB.did, delegation: delegationFixture(agentB.did, ownerB.did) as never, name: 'scout-b', skills: ['triage'], githubLogin: null });
      await built.jobRepo.create(jobFixture({ id: 'job-sibling-a', buyerDid: buyer.did, agentDid: agentA.did, requestId: 'req-1', status: 'draft' }, new Date('2026-08-01T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-sibling-b', buyerDid: buyer.did, agentDid: agentB.did, requestId: 'req-1', status: 'draft' }, new Date('2026-08-01T00:00:00Z')));

      const res = await getSigned(built.baseUrl, `/accounts/${ownerA.did}/threads`, ownerA);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { threads: Array<{ jobId: string }> };
      expect(body.threads.map((t) => t.jobId)).toEqual(['job-sibling-a']);
    } finally {
      built.server.close();
    }
  });

  it('the roster filter uses the exact operatorDid comparison, not isAgentOperator suffix matching (mutation proof: a dropped or loosened operatorDid filter turns this red)', async () => {
    const built = await buildApp();
    try {
      // Two DID strings that share a suffix under didSuffix's own
      // reconciliation (agent.ts: the did:abt: prefix is stripped
      // before comparing) but are NOT the same registered account. The
      // exact-comparison roster must tell them apart even though
      // isAgentOperator would call the two DIDs equal.
      const suffix = 'zThreadsRosterCollisionSuffix';
      const realOperatorDid = `did:abt:${suffix}`;
      const collidingCallerDid = suffix;
      const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(220));
      const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(221));
      await built.accountRepo.register({ did: realOperatorDid, githubLogin: 'threads-exact-owner' });
      await built.accountRepo.register({ did: collidingCallerDid, githubLogin: 'threads-roster-collision-caller' });
      await built.accountRepo.register({ did: buyer.did, githubLogin: 'threads-exact-buyer' });
      await built.agentRepo.create({
        did: agent.did,
        operatorDid: realOperatorDid,
        delegation: delegationFixture(agent.did, realOperatorDid) as never,
        name: 'threads-exact-scout',
        skills: ['triage'],
        githubLogin: null,
      });
      await built.jobRepo.create(jobFixture({ id: 'job-exact', buyerDid: buyer.did, agentDid: agent.did, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));

      const sessionAdapter = createSessionAdapter({
        github: fakeGitHubConfig(),
        fetchImpl: fakeGitHubFetch({ login: 'threads-roster-collision-caller', id: 919191 }),
      });
      const appWithSession = createApp(
        built.accountRepo,
        built.agentRepo,
        undefined,
        undefined,
        built.jobRepo,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        sessionAdapter,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        built.messageRepo,
        built.threadReadStateRepo,
      );
      const { server: sessionServer, baseUrl: sessionBaseUrl } = await listen(appWithSession);
      try {
        const token = await mintSessionToken(sessionAdapter);
        const res = await fetch(`${sessionBaseUrl}/accounts/${collidingCallerDid}/threads`, {
          headers: { Accept: 'application/json', authorization: 'Bearer ' + token },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { threads: unknown[] };
        expect(body.threads).toEqual([]);
      } finally {
        sessionServer.close();
      }
    } finally {
      built.server.close();
    }
  });
});

describe('GET /accounts/:did/threads: both seats, all statuses, shape', () => {
  it('a buyer sees every status (including terminal), seat buyer, writable false on a terminal job', async () => {
    const built = await buildApp();
    try {
      const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(220));
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(221));
      const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(222));
      await built.accountRepo.register({ did: buyer.did, githubLogin: 'threads-shape-buyer' });
      await built.accountRepo.register({ did: owner.did, githubLogin: 'threads-shape-owner' });
      await built.agentRepo.create({ did: agent.did, operatorDid: owner.did, delegation: delegationFixture(agent.did, owner.did) as never, name: 'shape-scout', skills: ['triage'], githubLogin: null });
      await built.jobRepo.create(jobFixture({ id: 'job-draft', buyerDid: buyer.did, agentDid: agent.did, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-proposed', buyerDid: buyer.did, agentDid: agent.did, status: 'proposed', criteria: [{ text: 'x', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: false }] }, new Date('2026-08-02T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-confirmed', buyerDid: buyer.did, agentDid: agent.did, status: 'confirmed', confirmedAt: new Date('2026-08-03T00:00:00Z') }, new Date('2026-08-03T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-declined', buyerDid: buyer.did, agentDid: agent.did, status: 'declined' }, new Date('2026-08-04T00:00:00Z')));

      const res = await getSigned(built.baseUrl, `/accounts/${buyer.did}/threads`, buyer);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { threads: Array<Record<string, unknown>> };
      const ids = body.threads.map((t) => t.jobId);
      expect(ids.sort()).toEqual(['job-confirmed', 'job-declined', 'job-draft', 'job-proposed']);
      for (const t of body.threads) expect(t.seat).toBe('buyer');
      const declined = body.threads.find((t) => t.jobId === 'job-declined')!;
      expect(declined.writable).toBe(false);
      const draft = body.threads.find((t) => t.jobId === 'job-draft')!;
      expect(draft.writable).toBe(true);
      expect(draft.agentDid).toBe(agent.did);
      expect(draft.agentName).toBe('shape-scout');
      expect(draft.counterpartDid).toBe(owner.did);
      expect(draft.counterpartGithubLogin).toBe('threads-shape-owner');
      expect(draft.brief).toBe('Fix the login bug');
      expect(typeof draft.createdAt).toBe('string');
      expect(draft.avatarSpec).toBeTruthy();
    } finally {
      built.server.close();
    }
  });

  it('an owner sees every status offered to their agents, seat agent', async () => {
    const built = await buildApp();
    try {
      const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(223));
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(224));
      const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(225));
      await built.accountRepo.register({ did: buyer.did, githubLogin: 'threads-owner-seat-buyer' });
      await built.accountRepo.register({ did: owner.did, githubLogin: 'threads-owner-seat-owner' });
      await built.agentRepo.create({ did: agent.did, operatorDid: owner.did, delegation: delegationFixture(agent.did, owner.did) as never, name: 'owner-seat-scout', skills: ['triage'], githubLogin: null });
      await built.jobRepo.create(jobFixture({ id: 'job-owner-draft', buyerDid: buyer.did, agentDid: agent.did, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-owner-confirmed', buyerDid: buyer.did, agentDid: agent.did, status: 'confirmed', confirmedAt: new Date('2026-08-02T00:00:00Z') }, new Date('2026-08-02T00:00:00Z')));

      const res = await getSigned(built.baseUrl, `/accounts/${owner.did}/threads`, owner);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { threads: Array<Record<string, unknown>> };
      const ids = body.threads.map((t) => t.jobId);
      expect(ids.sort()).toEqual(['job-owner-confirmed', 'job-owner-draft']);
      for (const t of body.threads) {
        expect(t.seat).toBe('agent');
        expect(t.counterpartDid).toBe(buyer.did);
        expect(t.counterpartGithubLogin).toBe('threads-owner-seat-buyer');
      }
    } finally {
      built.server.close();
    }
  });

  it('a self-hire (account is both buyer and owner) is listed once, as the buyer', async () => {
    const built = await buildApp();
    try {
      const selfHirer = await signingIdentityFromSeed(new Uint8Array(32).fill(226));
      const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(227));
      await built.accountRepo.register({ did: selfHirer.did, githubLogin: 'threads-self-hirer' });
      await built.agentRepo.create({ did: agent.did, operatorDid: selfHirer.did, delegation: delegationFixture(agent.did, selfHirer.did) as never, name: 'self-scout', skills: ['triage'], githubLogin: null });
      await built.jobRepo.create(jobFixture({ id: 'job-self-hire', buyerDid: selfHirer.did, agentDid: agent.did, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));

      const res = await getSigned(built.baseUrl, `/accounts/${selfHirer.did}/threads`, selfHirer);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { threads: Array<Record<string, unknown>> };
      expect(body.threads.length).toBe(1);
      expect(body.threads[0]!.jobId).toBe('job-self-hire');
      expect(body.threads[0]!.seat).toBe('buyer');
    } finally {
      built.server.close();
    }
  });

  it('threads sort newest activity first, ties by jobId', async () => {
    const built = await buildApp();
    try {
      const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(228));
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(229));
      const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(230));
      await built.accountRepo.register({ did: buyer.did, githubLogin: 'threads-sort-buyer' });
      await built.accountRepo.register({ did: owner.did, githubLogin: 'threads-sort-owner' });
      await built.agentRepo.create({ did: agent.did, operatorDid: owner.did, delegation: delegationFixture(agent.did, owner.did) as never, name: 'sort-scout', skills: ['triage'], githubLogin: null });
      await built.jobRepo.create(jobFixture({ id: 'job-oldest', buyerDid: buyer.did, agentDid: agent.did, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-newest', buyerDid: buyer.did, agentDid: agent.did, status: 'draft' }, new Date('2026-08-05T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-middle', buyerDid: buyer.did, agentDid: agent.did, status: 'draft' }, new Date('2026-08-03T00:00:00Z')));

      const res = await getSigned(built.baseUrl, `/accounts/${buyer.did}/threads`, buyer);
      const body = (await res.json()) as { threads: Array<{ jobId: string }> };
      expect(body.threads.map((t) => t.jobId)).toEqual(['job-newest', 'job-middle', 'job-oldest']);
    } finally {
      built.server.close();
    }
  });

  it('lastActivityAt reflects the newest MESSAGE, not just the job createdAt, and moves the thread to the top', async () => {
    const built = await buildApp();
    try {
      const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(231));
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(232));
      const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(233));
      await built.accountRepo.register({ did: buyer.did, githubLogin: 'threads-activity-buyer' });
      await built.accountRepo.register({ did: owner.did, githubLogin: 'threads-activity-owner' });
      await built.agentRepo.create({ did: agent.did, operatorDid: owner.did, delegation: delegationFixture(agent.did, owner.did) as never, name: 'activity-scout', skills: ['triage'], githubLogin: null });
      await built.jobRepo.create(jobFixture({ id: 'job-activity-old-brief-new-message', buyerDid: buyer.did, agentDid: agent.did, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-activity-newer-brief-no-messages', buyerDid: buyer.did, agentDid: agent.did, status: 'draft' }, new Date('2026-08-02T00:00:00Z')));

      const message = createMessage(
        { id: 'm1', jobId: 'job-activity-old-brief-new-message', authorDid: buyer.did, authorParty: 'buyer', authorKind: 'buyer', body: 'bump', existingMessageIds: new Set() },
        new Date('2026-08-10T00:00:00Z'),
      );
      await built.messageRepo.create(message);

      const res = await getSigned(built.baseUrl, `/accounts/${buyer.did}/threads`, buyer);
      const body = (await res.json()) as { threads: Array<{ jobId: string; lastActivityAt: string }> };
      expect(body.threads.map((t) => t.jobId)).toEqual(['job-activity-old-brief-new-message', 'job-activity-newer-brief-no-messages']);
      expect(body.threads[0]!.lastActivityAt).toBe(new Date('2026-08-10T00:00:00Z').toISOString());
    } finally {
      built.server.close();
    }
  });

  it('lastMessage is null with no rows, and carries authorParty/bodyPreview/attachmentCount/systemEventType/createdAt', async () => {
    const built = await buildApp();
    try {
      const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(234));
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(235));
      const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(236));
      await built.accountRepo.register({ did: buyer.did, githubLogin: 'threads-lastmsg-buyer' });
      await built.accountRepo.register({ did: owner.did, githubLogin: 'threads-lastmsg-owner' });
      await built.agentRepo.create({ did: agent.did, operatorDid: owner.did, delegation: delegationFixture(agent.did, owner.did) as never, name: 'lastmsg-scout', skills: ['triage'], githubLogin: null });

      await built.jobRepo.create(jobFixture({ id: 'job-no-messages', buyerDid: buyer.did, agentDid: agent.did, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-party-message', buyerDid: buyer.did, agentDid: agent.did, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-system-message', buyerDid: buyer.did, agentDid: agent.did, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-attachment-only', buyerDid: buyer.did, agentDid: agent.did, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));

      await built.messageRepo.create(
        createMessage({ id: 'pm1', jobId: 'job-party-message', authorDid: buyer.did, authorParty: 'buyer', authorKind: 'buyer', body: 'hello there', existingMessageIds: new Set() }, new Date('2026-08-02T00:00:00Z')),
      );
      await built.messageRepo.create(
        createSystemMessage({ id: 'sm1', jobId: 'job-system-message', body: 'Quote sent', systemEvent: { type: 'quote_sent', priceUsd: '500.00', rail: 'abt', deliveryWindowDays: null, criteriaCount: 1 } }, new Date('2026-08-02T00:00:00Z')),
      );
      await built.messageRepo.create(
        createMessage({ id: 'am1', jobId: 'job-attachment-only', authorDid: buyer.did, authorParty: 'buyer', authorKind: 'buyer', body: '', existingMessageIds: new Set(), attachments: [{ attachmentId: 'a1' }] }, new Date('2026-08-02T00:00:00Z')),
      );

      const res = await getSigned(built.baseUrl, `/accounts/${buyer.did}/threads`, buyer);
      const body = (await res.json()) as { threads: Array<Record<string, unknown>> };
      const byId = new Map(body.threads.map((t) => [t.jobId as string, t]));

      expect(byId.get('job-no-messages')!.lastMessage).toBeNull();

      const partyLast = byId.get('job-party-message')!.lastMessage as Record<string, unknown>;
      expect(partyLast.authorParty).toBe('buyer');
      expect(partyLast.bodyPreview).toBe('hello there');
      expect(partyLast.attachmentCount).toBe(0);
      expect(partyLast.systemEventType).toBeNull();
      expect(typeof partyLast.createdAt).toBe('string');

      const systemLast = byId.get('job-system-message')!.lastMessage as Record<string, unknown>;
      expect(systemLast.authorParty).toBe('system');
      expect(systemLast.systemEventType).toBe('quote_sent');

      const attachmentLast = byId.get('job-attachment-only')!.lastMessage as Record<string, unknown>;
      expect(attachmentLast.bodyPreview).toBe('');
      expect(attachmentLast.attachmentCount).toBe(1);
    } finally {
      built.server.close();
    }
  });

  it('a 250-code-point emoji body previews at exactly 200 code points, never a broken pair', async () => {
    const built = await buildApp();
    try {
      const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(237));
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(238));
      const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(239));
      await built.accountRepo.register({ did: buyer.did, githubLogin: 'threads-emoji-buyer' });
      await built.accountRepo.register({ did: owner.did, githubLogin: 'threads-emoji-owner' });
      await built.agentRepo.create({ did: agent.did, operatorDid: owner.did, delegation: delegationFixture(agent.did, owner.did) as never, name: 'emoji-scout', skills: ['triage'], githubLogin: null });
      await built.jobRepo.create(jobFixture({ id: 'job-emoji', buyerDid: buyer.did, agentDid: agent.did, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));

      const emojiBody = '\u{1F600}'.repeat(250);
      await built.messageRepo.create(
        createMessage({ id: 'em1', jobId: 'job-emoji', authorDid: buyer.did, authorParty: 'buyer', authorKind: 'buyer', body: emojiBody, existingMessageIds: new Set() }, new Date('2026-08-02T00:00:00Z')),
      );

      const res = await getSigned(built.baseUrl, `/accounts/${buyer.did}/threads`, buyer);
      const body = (await res.json()) as { threads: Array<{ jobId: string; lastMessage: { bodyPreview: string } }> };
      const row = body.threads.find((t) => t.jobId === 'job-emoji')!;
      expect(Array.from(row.lastMessage.bodyPreview).length).toBe(200);
      expect(row.lastMessage.bodyPreview).toBe('\u{1F600}'.repeat(200));
    } finally {
      built.server.close();
    }
  });
});

describe('GET /accounts/:did/threads: unreadCount and unreadTotal', () => {
  it('the owner\'s brief-only thread counts 1 unread until the owner reads it (the "first line of communication" ruling)', async () => {
    const built = await buildApp();
    try {
      const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(240));
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(241));
      const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(242));
      await built.accountRepo.register({ did: buyer.did, githubLogin: 'threads-unread-buyer' });
      await built.accountRepo.register({ did: owner.did, githubLogin: 'threads-unread-owner' });
      await built.agentRepo.create({ did: agent.did, operatorDid: owner.did, delegation: delegationFixture(agent.did, owner.did) as never, name: 'unread-scout', skills: ['triage'], githubLogin: null });
      await built.jobRepo.create(jobFixture({ id: 'job-unread-brief', buyerDid: buyer.did, agentDid: agent.did, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));

      const beforeRead = await getSigned(built.baseUrl, `/accounts/${owner.did}/threads`, owner);
      const beforeBody = (await beforeRead.json()) as { threads: Array<{ unreadCount: number }>; unreadTotal: number };
      expect(beforeBody.threads[0]!.unreadCount).toBe(1);
      expect(beforeBody.unreadTotal).toBe(1);

      // A buyer's own brief never counts as unread for the buyer.
      const buyerView = await getSigned(built.baseUrl, `/accounts/${buyer.did}/threads`, buyer);
      const buyerBody = (await buyerView.json()) as { threads: Array<{ unreadCount: number }> };
      expect(buyerBody.threads[0]!.unreadCount).toBe(0);

      await built.threadReadStateRepo.record(advanceReadState(null, 'job-unread-brief', 'agent', new Date('2026-08-05T00:00:00Z')));

      const afterRead = await getSigned(built.baseUrl, `/accounts/${owner.did}/threads`, owner);
      const afterBody = (await afterRead.json()) as { threads: Array<{ unreadCount: number }> };
      expect(afterBody.threads[0]!.unreadCount).toBe(0);
    } finally {
      built.server.close();
    }
  });

  it('unreadCount counts the other party\'s messages after lastReadAt, and unreadTotal sums every row', async () => {
    const built = await buildApp();
    try {
      const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(243));
      const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(244));
      const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(245));
      await built.accountRepo.register({ did: buyer.did, githubLogin: 'threads-unread2-buyer' });
      await built.accountRepo.register({ did: owner.did, githubLogin: 'threads-unread2-owner' });
      await built.agentRepo.create({ did: agent.did, operatorDid: owner.did, delegation: delegationFixture(agent.did, owner.did) as never, name: 'unread2-scout', skills: ['triage'], githubLogin: null });
      await built.jobRepo.create(jobFixture({ id: 'job-unread2-a', buyerDid: buyer.did, agentDid: agent.did, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));
      await built.jobRepo.create(jobFixture({ id: 'job-unread2-b', buyerDid: buyer.did, agentDid: agent.did, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));

      // The buyer has already read job-unread2-a as of a point in time;
      // a message from the agent side AFTER that point counts.
      await built.threadReadStateRepo.record(advanceReadState(null, 'job-unread2-a', 'buyer', new Date('2026-08-02T00:00:00Z')));
      await built.messageRepo.create(
        createMessage({ id: 'u1', jobId: 'job-unread2-a', authorDid: owner.did, authorParty: 'agent', authorKind: 'owner', body: 'after read', existingMessageIds: new Set() }, new Date('2026-08-03T00:00:00Z')),
      );
      // job-unread2-b: the buyer has never read it, and it has no
      // messages yet, so the buyer's own count is 0 (buyer seat gets no
      // brief bonus).
      const messages: Message[] = [];
      void messages;

      const res = await getSigned(built.baseUrl, `/accounts/${buyer.did}/threads`, buyer);
      const body = (await res.json()) as { threads: Array<{ jobId: string; unreadCount: number }>; unreadTotal: number };
      const byId = new Map(body.threads.map((t) => [t.jobId, t.unreadCount]));
      expect(byId.get('job-unread2-a')).toBe(1);
      expect(byId.get('job-unread2-b')).toBe(0);
      expect(body.unreadTotal).toBe(1);
    } finally {
      built.server.close();
    }
  });
});
