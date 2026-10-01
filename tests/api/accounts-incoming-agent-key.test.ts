// SW3-12: an agent signing with its own key finds the briefs sent to it on
// GET /accounts/<agentDid>/incoming. Before this, the route's roster was the
// agents an ACCOUNT runs, so an agent's own DID matched no row and the answer
// was an empty list while a brief waited. These are the HTTP pins: a real
// listening server, real signatures through tests/helpers/sign-request.ts.
// The owner's own list is pinned in tests/api/accounts-incoming.test.ts and
// again here (f), whole, so the owner's answer cannot drift with this change.
import type { Server } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAccountRepository, MemoryAgentRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import { CAPABILITIES } from '../../src/domain/access.js';
import { resolveAvatar } from '../../src/domain/avatar-spec.js';
import { createJob, type Job } from '../../src/domain/job.js';
import { ALL_JOB_STATUSES } from '../../src/domain/job-list.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { mintSessionToken, testSessionAdapter } from '../helpers/session-fixtures.js';

// The keys GET /jobs/:jobId answered for a draft before the agent read existed.
const JOB_READ_KEYS = ['agentDid', 'brief', 'briefHash', 'buyerDid', 'createdAt', 'id', 'repository', 'status'];
const REFUSAL = { error: 'an account may only read its own incoming list' };

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

function delegationFixture(agentDid: string, operatorDid: string): Record<string, unknown> {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-incoming-agent-key',
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

interface World {
  readonly server: Server;
  readonly baseUrl: string;
  readonly agentRepo: MemoryAgentRepository;
  readonly jobRepo: MemoryJobRepository;
  readonly owner: SigningIdentity;
  readonly agent: SigningIdentity;
  readonly sibling: SigningIdentity;
  readonly buyer: SigningIdentity;
  readonly stranger: SigningIdentity;
  readonly ownerToken: string;
}

// One owner (an account, also the holder of the session), two agents of that
// owner (the one under test and a sibling), a buyer and a registered stranger.
async function buildWorld(): Promise<World> {
  const accountRepo = new MemoryAccountRepository();
  const agentRepo = new MemoryAgentRepository();
  const jobRepo = new MemoryJobRepository();
  const sessionAdapter = testSessionAdapter();
  const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(111));
  const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(112));
  const sibling = await signingIdentityFromSeed(new Uint8Array(32).fill(113));
  const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(114));
  const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(115));
  // testSessionAdapter signs in as the GitHub login 'test-session-user'.
  await accountRepo.register({ did: owner.did, githubLogin: 'test-session-user' });
  await accountRepo.register({ did: buyer.did, githubLogin: 'agent-key-buyer' });
  await accountRepo.register({ did: stranger.did, githubLogin: 'agent-key-stranger' });
  for (const [identity, name] of [[agent, 'own-key-scout'], [sibling, 'sibling-scout']] as const) {
    await agentRepo.create({
      did: identity.did,
      operatorDid: owner.did,
      delegation: delegationFixture(identity.did, owner.did) as never,
      name,
      skills: ['triage'],
      githubLogin: null,
    });
  }
  await agentRepo.setAvatarSpec(agent.did, { shape: 'triangle', face: 'mouth', colour: 'c7' });
  const app = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a port');
  const ownerToken = await mintSessionToken(sessionAdapter);
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, agentRepo, jobRepo, owner, agent, sibling, buyer, stranger, ownerToken };
}

describe('GET /accounts/<agentDid>/incoming: an agent reads the briefs sent to it with its own key (SW3-12)', () => {
  it('(a) answers { agentDid, offers } whole: a draft and a proposed brief to it, newest first, each row whole', async () => {
    const w = await buildWorld();
    try {
      await w.jobRepo.create(jobFixture({ id: 'job-older-draft', buyerDid: w.buyer.did, agentDid: w.agent.did, brief: 'First brief', repository: 'buyer/one', status: 'draft' }, new Date('2026-08-01T00:00:00Z')));
      await w.jobRepo.create(
        jobFixture(
          {
            id: 'job-newer-proposed',
            buyerDid: w.buyer.did,
            agentDid: w.agent.did,
            brief: 'Second brief',
            repository: 'buyer/two',
            status: 'proposed',
            criteria: [{ text: 'x', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: false }],
          },
          new Date('2026-08-02T00:00:00Z'),
        ),
      );
      const res = await getSigned(w.baseUrl, `/accounts/${w.agent.did}/incoming`, w.agent);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        agentDid: w.agent.did,
        offers: [
          {
            id: 'job-newer-proposed',
            brief: 'Second brief',
            repository: 'buyer/two',
            agentDid: w.agent.did,
            agentName: 'own-key-scout',
            avatarSpec: { shape: 'triangle', face: 'mouth', colour: 'c7' },
            waitingOn: 'waitingOnOperator',
            createdAt: '2026-08-02T00:00:00.000Z',
          },
          {
            id: 'job-older-draft',
            brief: 'First brief',
            repository: 'buyer/one',
            agentDid: w.agent.did,
            agentName: 'own-key-scout',
            avatarSpec: { shape: 'triangle', face: 'mouth', colour: 'c7' },
            waitingOn: 'noReply',
            createdAt: '2026-08-01T00:00:00.000Z',
          },
        ],
      });
    } finally {
      w.server.close();
    }
  });

  it('(b) over the whole JobStatus enum, only the draft and proposed rows appear', async () => {
    const w = await buildWorld();
    try {
      await Promise.all(
        ALL_JOB_STATUSES.map((status, i) =>
          w.jobRepo.create(jobFixture({ id: `job-${status}`, buyerDid: w.buyer.did, agentDid: w.agent.did, status }, new Date(2026, 7, 1 + i))),
        ),
      );
      const res = await getSigned(w.baseUrl, `/accounts/${w.agent.did}/incoming`, w.agent);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { offers: Array<{ id: string }> };
      expect(body.offers.map((o) => o.id).sort()).toEqual(['job-draft', 'job-proposed']);
    } finally {
      w.server.close();
    }
  });

  it('(c) the list is that agent alone: a brief to its owner\'s other agent is absent, and so is a job where it is the buyer', async () => {
    const w = await buildWorld();
    try {
      await w.jobRepo.create(jobFixture({ id: 'job-to-me', buyerDid: w.buyer.did, agentDid: w.agent.did, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));
      await w.jobRepo.create(jobFixture({ id: 'job-to-sibling', buyerDid: w.buyer.did, agentDid: w.sibling.did, status: 'draft' }, new Date('2026-08-02T00:00:00Z')));
      await w.jobRepo.create(jobFixture({ id: 'job-i-am-buyer', buyerDid: w.agent.did, agentDid: w.sibling.did, status: 'draft' }, new Date('2026-08-03T00:00:00Z')));
      const res = await getSigned(w.baseUrl, `/accounts/${w.agent.did}/incoming`, w.agent);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { agentDid: string; offers: Array<{ id: string }> };
      expect(body.offers.map((o) => o.id)).toEqual(['job-to-me']);
    } finally {
      w.server.close();
    }
  });

  it('(d) the answer is identical with negotiatesOnOwnersBehalf off and on', async () => {
    const w = await buildWorld();
    try {
      await w.jobRepo.create(jobFixture({ id: 'job-switch', buyerDid: w.buyer.did, agentDid: w.agent.did, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));
      const off = await getSigned(w.baseUrl, `/accounts/${w.agent.did}/incoming`, w.agent);
      const offBody = await off.text();
      await w.agentRepo.setNegotiatesOnOwnersBehalf(w.agent.did, true);
      const on = await getSigned(w.baseUrl, `/accounts/${w.agent.did}/incoming`, w.agent);
      const onBody = await on.text();
      expect(off.status).toBe(200);
      expect(on.status).toBe(200);
      expect(JSON.parse(offBody)).toEqual({
        agentDid: w.agent.did,
        offers: [
          {
            id: 'job-switch',
            brief: 'Fix the login bug',
            repository: 'buyer/target-repo',
            agentDid: w.agent.did,
            agentName: 'own-key-scout',
            avatarSpec: { shape: 'triangle', face: 'mouth', colour: 'c7' },
            waitingOn: 'noReply',
            createdAt: '2026-08-01T00:00:00.000Z',
          },
        ],
      });
      expect(onBody).toBe(offBody);
    } finally {
      w.server.close();
    }
  });

  it('a storage failure reading the agent answers 503 with the route\'s existing sentence', async () => {
    const w = await buildWorld();
    try {
      const path = `/accounts/${w.agent.did}/incoming`;
      // With no offers there is no per-row lookup, so the last findByDid of
      // one read is the route's own lookup of :did. Count the lookups of a
      // clean read, then fail exactly that one on the next read.
      const spy = vi.spyOn(w.agentRepo, 'findByDid');
      const clean = await getSigned(w.baseUrl, path, w.agent);
      expect(clean.status).toBe(200);
      const lookupsPerRead = spy.mock.calls.length;
      spy.mockClear();
      const real = MemoryAgentRepository.prototype.findByDid.bind(w.agentRepo);
      let seen = 0;
      spy.mockImplementation(async (did: string) => {
        seen += 1;
        if (seen === lookupsPerRead) throw new Error('simulated storage failure');
        return real(did);
      });
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const res = await getSigned(w.baseUrl, path, w.agent);
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: 'storage unavailable' });
        expect(errors).toHaveBeenCalledWith('GET /accounts/:did/incoming: storage failed', expect.any(Error));
      } finally {
        errors.mockRestore();
      }
    } finally {
      w.server.close();
    }
  });
});

describe('GET /accounts/<agentDid>/incoming: nobody else reads an agent\'s list (e)', () => {
  it('the owner\'s session, a second agent\'s key and a registered stranger each get the same 403; unsigned is 401', async () => {
    const w = await buildWorld();
    try {
      await w.jobRepo.create(jobFixture({ id: 'job-private', buyerDid: w.buyer.did, agentDid: w.agent.did, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));
      const path = `/accounts/${w.agent.did}/incoming`;

      const ownerSession = await fetch(`${w.baseUrl}${path}`, { headers: { Accept: 'application/json', authorization: `Bearer ${w.ownerToken}` } });
      const siblingKey = await getSigned(w.baseUrl, path, w.sibling);
      const strangerKey = await getSigned(w.baseUrl, path, w.stranger);
      const unsigned = await fetch(`${w.baseUrl}${path}`, { headers: { Accept: 'application/json' } });

      expect(ownerSession.status).toBe(403);
      expect(await ownerSession.json()).toEqual(REFUSAL);
      expect(siblingKey.status).toBe(403);
      expect(await siblingKey.json()).toEqual(REFUSAL);
      expect(strangerKey.status).toBe(403);
      expect(await strangerKey.json()).toEqual(REFUSAL);
      expect(unsigned.status).toBe(401);
    } finally {
      w.server.close();
    }
  });
});

describe('GET /accounts/<ownerDid>/incoming: the owner\'s own list is unchanged (f)', () => {
  it('answers { operatorDid, offers } whole, one row per brief to any of the owner\'s agents, newest first', async () => {
    const w = await buildWorld();
    try {
      await w.jobRepo.create(jobFixture({ id: 'job-a', buyerDid: w.buyer.did, agentDid: w.agent.did, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));
      await w.jobRepo.create(jobFixture({ id: 'job-s', buyerDid: w.buyer.did, agentDid: w.sibling.did, status: 'draft' }, new Date('2026-08-02T00:00:00Z')));
      const res = await getSigned(w.baseUrl, `/accounts/${w.owner.did}/incoming`, w.owner);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        operatorDid: w.owner.did,
        offers: [
          {
            id: 'job-s',
            brief: 'Fix the login bug',
            repository: 'buyer/target-repo',
            agentDid: w.sibling.did,
            agentName: 'sibling-scout',
            avatarSpec: resolveAvatar(null, w.sibling.did),
            waitingOn: 'noReply',
            createdAt: '2026-08-02T00:00:00.000Z',
          },
          {
            id: 'job-a',
            brief: 'Fix the login bug',
            repository: 'buyer/target-repo',
            agentDid: w.agent.did,
            agentName: 'own-key-scout',
            avatarSpec: { shape: 'triangle', face: 'mouth', colour: 'c7' },
            waitingOn: 'noReply',
            createdAt: '2026-08-01T00:00:00.000Z',
          },
        ],
      });
    } finally {
      w.server.close();
    }
  });
});

describe('GET /capabilities names the agent\'s read (g)', () => {
  it('serves the account.incoming.read entry whole', async () => {
    const w = await buildWorld();
    try {
      const res = await fetch(`${w.baseUrl}/capabilities`);
      const body = (await res.json()) as { capabilities: Array<Record<string, unknown>> };
      const entry = body.capabilities.find((c) => c.id === 'account.incoming.read');
      expect(entry).toEqual({
        id: 'account.incoming.read',
        method: 'GET',
        path: '/accounts/:did/incoming',
        access: 'identified',
        identityField: null,
        reason:
          'An owner reads the briefs offered to the agents they run, and an agent signing with its own key reads the briefs offered to it; the party comes from your session or signature, never the body.',
      });
      expect(CAPABILITIES.map((c) => c.id).indexOf('account.incoming.read')).toBe(CAPABILITIES.map((c) => c.id).indexOf('agent.listing') + 1);
    } finally {
      w.server.close();
    }
  });
});

describe('GET /jobs/:jobId keeps its keys (h, invariant 2)', () => {
  it('answers exactly the keys it answered before the agent read existed', async () => {
    const w = await buildWorld();
    try {
      await w.jobRepo.create(jobFixture({ id: 'job-keys', buyerDid: w.buyer.did, agentDid: w.agent.did, status: 'draft' }, new Date('2026-08-01T00:00:00Z')));
      const res = await fetch(`${w.baseUrl}/jobs/job-keys`, { headers: { Accept: 'application/json' } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(JOB_READ_KEYS);
    } finally {
      w.server.close();
    }
  });
});
