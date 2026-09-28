// FIX-B43a (bugs.md B43, ruling 2026-09-27): "an owner can stop listing an
// agent at any time and list it again at any time, from the agent settings
// page. Unlisted, the agent leaves browse and refuses new hires; its
// finished work and records stay public. Jobs already open when it is
// unlisted finish normally... Unlisting is a listing state the owner can
// flip back, so it does not revoke the agent's delegation." This file pins
// PUT /agents/:agentDid/listing (the negotiation route's own shape and
// gate, tests/api/agent-negotiation-flag.test.ts is the fixture pattern),
// the browse filter, the owner's roster, the hire-door 409, and that
// everything already open, every credential and the delegation itself are
// untouched by a listing flip.
import type { Server } from 'node:http';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import * as vc from '@digitalbazaar/vc';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAccountRepository, MemoryAgentRepository, MemoryCredentialRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import { createKnownKeyStore } from '../../src/adapters/identity/did-abt-resolver.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { testSessionAdapter, mintSessionToken } from '../helpers/session-fixtures.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';

function delegationFor(agentDid: string, operatorDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:listing-route-test',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-09-27T00:00:00.000Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-09-27T00:00:00.000Z',
      verificationMethod: `${operatorDid}#zOperatorKeyHash`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zMockProofValue',
    },
  };
}

async function putSigned(baseUrl: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, 'PUT', targetUri, { body: bodyText });
  return fetch(targetUri, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
    body: bodyText,
  });
}

async function postSigned(baseUrl: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, 'POST', targetUri, { body: bodyText });
  return fetch(targetUri, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
    body: bodyText,
  });
}

interface Started {
  readonly server: Server;
  readonly baseUrl: string;
  readonly agentRepo: MemoryAgentRepository;
  readonly operator: SigningIdentity;
  readonly stranger: SigningIdentity;
  readonly agentDid: string;
}

async function startApp(): Promise<Started> {
  const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(211));
  const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(212));
  const agentDid = 'did:abt:zListingFlagAgent';
  const accountRepo = new MemoryAccountRepository();
  await accountRepo.register({ did: operator.did, githubLogin: 'listing-flag-operator' });
  await accountRepo.register({ did: stranger.did, githubLogin: 'listing-flag-stranger' });
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: agentDid,
    operatorDid: operator.did,
    delegation: delegationFor(agentDid, operator.did),
    name: 'scout',
    skills: ['triage'],
    githubLogin: null,
  });
  const app = createApp(accountRepo, agentRepo);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, baseUrl, agentRepo, operator, stranger, agentDid };
}

describe('PUT /agents/:agentDid/listing (FIX-B43a)', () => {
  let started: Started;

  beforeAll(async () => {
    started = await startApp();
  });

  afterAll(() => {
    started.server.close();
  });

  // (a) A freshly listed agent reads listed: true.
  it('a freshly listed agent (site path) reads listed: true', async () => {
    const res = await fetch(`${started.baseUrl}/agents/${started.agentDid}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.listed).toBe(true);
  });

  // (b) The owner unlists and lists again.
  it('the owner unlists the agent: 200, listed: false on the reply and on GET', async () => {
    const res = await putSigned(started.baseUrl, `/agents/${started.agentDid}/listing`, { listed: false }, started.operator);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.listed).toBe(false);

    const read = await fetch(`${started.baseUrl}/agents/${started.agentDid}`);
    const readBody = (await read.json()) as Record<string, unknown>;
    expect(readBody.listed).toBe(false);
  });

  it('the owner lists it again: listed: true', async () => {
    await putSigned(started.baseUrl, `/agents/${started.agentDid}/listing`, { listed: false }, started.operator);
    const res = await putSigned(started.baseUrl, `/agents/${started.agentDid}/listing`, { listed: true }, started.operator);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.listed).toBe(true);

    const read = await fetch(`${started.baseUrl}/agents/${started.agentDid}`);
    const readBody = (await read.json()) as Record<string, unknown>;
    expect(readBody.listed).toBe(true);
  });

  it('setting the value it already has is a 200 that changes nothing', async () => {
    const res = await putSigned(started.baseUrl, `/agents/${started.agentDid}/listing`, { listed: true }, started.operator);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.listed).toBe(true);
  });

  // (c) Refusals, each proving the write was never called.
  it('an unsigned request is refused with 401, and the write is never called', async () => {
    const spy = vi.spyOn(started.agentRepo, 'setListed');
    const res = await fetch(`${started.baseUrl}/agents/${started.agentDid}/listing`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listed: false }),
    });
    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a REGISTERED stranger is refused with 403, and the write is never called', async () => {
    const spy = vi.spyOn(started.agentRepo, 'setListed');
    const res = await putSigned(started.baseUrl, `/agents/${started.agentDid}/listing`, { listed: false }, started.stranger);
    expect(res.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('an unknown agent DID is refused with 404, and the write is never called', async () => {
    const spy = vi.spyOn(started.agentRepo, 'setListed');
    const res = await putSigned(started.baseUrl, '/agents/did:abt:zNoSuchListingAgent/listing', { listed: false }, started.operator);
    expect(res.status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a missing listed field is refused with 400, and the write is never called', async () => {
    const spy = vi.spyOn(started.agentRepo, 'setListed');
    const res = await putSigned(started.baseUrl, `/agents/${started.agentDid}/listing`, {}, started.operator);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('body must be { listed }, a boolean');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a non-boolean listed value is refused with 400, and the write is never called', async () => {
    const spy = vi.spyOn(started.agentRepo, 'setListed');
    const res = await putSigned(started.baseUrl, `/agents/${started.agentDid}/listing`, { listed: 'no' }, started.operator);
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// (d) Browse: unlisting removes exactly that agent, with and without
// ?skill= and ?sort=; listing it again brings it back.
describe('GET /agents (FIX-B43a): an unlisted agent leaves browse', () => {
  let server: Server;
  let baseUrl: string;
  let agentRepo: MemoryAgentRepository;
  let operator: SigningIdentity;
  const AGENT_ONE = 'did:abt:zBrowseListingOne';
  const AGENT_TWO = 'did:abt:zBrowseListingTwo';

  beforeAll(async () => {
    operator = await signingIdentityFromSeed(new Uint8Array(32).fill(213));
    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: operator.did, githubLogin: 'browse-listing-operator' });
    agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: AGENT_ONE,
      operatorDid: operator.did,
      delegation: delegationFor(AGENT_ONE, operator.did),
      name: 'scout-one',
      skills: ['triage'],
      githubLogin: null,
    });
    await agentRepo.create({
      did: AGENT_TWO,
      operatorDid: operator.did,
      delegation: delegationFor(AGENT_TWO, operator.did),
      name: 'scout-two',
      skills: ['triage'],
      githubLogin: null,
    });
    const app = createApp(accountRepo, agentRepo);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('both agents are on browse before either is unlisted', async () => {
    const res = await fetch(`${baseUrl}/agents`);
    const body = (await res.json()) as { agents: Array<{ did: string }> };
    expect(body.agents.map((a) => a.did).sort()).toEqual([AGENT_ONE, AGENT_TWO].sort());
  });

  it('unlisting one agent removes exactly it from GET /agents (plain, ?skill=, ?sort=)', async () => {
    const put = await putSigned(baseUrl, `/agents/${AGENT_ONE}/listing`, { listed: false }, operator);
    expect(put.status).toBe(200);

    const plain = await fetch(`${baseUrl}/agents`);
    const plainBody = (await plain.json()) as { agents: Array<{ did: string }> };
    expect(plainBody.agents.map((a) => a.did)).toEqual([AGENT_TWO]);

    const skilled = await fetch(`${baseUrl}/agents?skill=triage`);
    const skilledBody = (await skilled.json()) as { agents: Array<{ did: string }> };
    expect(skilledBody.agents.map((a) => a.did)).toEqual([AGENT_TWO]);

    const sorted = await fetch(`${baseUrl}/agents?sort=recently-listed`);
    const sortedBody = (await sorted.json()) as { agents: Array<{ did: string }> };
    expect(sortedBody.agents.map((a) => a.did)).toEqual([AGENT_TWO]);
  });

  it('listing it again brings it back onto GET /agents', async () => {
    const put = await putSigned(baseUrl, `/agents/${AGENT_ONE}/listing`, { listed: true }, operator);
    expect(put.status).toBe(200);

    const res = await fetch(`${baseUrl}/agents`);
    const body = (await res.json()) as { agents: Array<{ did: string }> };
    expect(body.agents.map((a) => a.did).sort()).toEqual([AGENT_ONE, AGENT_TWO].sort());
  });
});

// (e) The owner's roster keeps the unlisted agent, marked.
describe("GET /accounts/:did/agents (FIX-B43a): the owner's roster keeps an unlisted agent", () => {
  let server: Server;
  let baseUrl: string;
  let operator: SigningIdentity;
  const AGENT_LISTED = 'did:abt:zRosterListingListed';
  const AGENT_UNLISTED = 'did:abt:zRosterListingUnlisted';

  beforeAll(async () => {
    operator = await signingIdentityFromSeed(new Uint8Array(32).fill(214));
    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: operator.did, githubLogin: 'roster-listing-operator' });
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: AGENT_LISTED,
      operatorDid: operator.did,
      delegation: delegationFor(AGENT_LISTED, operator.did),
      name: 'scout-listed',
      skills: ['triage'],
      githubLogin: null,
    });
    await agentRepo.create({
      did: AGENT_UNLISTED,
      operatorDid: operator.did,
      delegation: delegationFor(AGENT_UNLISTED, operator.did),
      name: 'scout-unlisted',
      skills: ['triage'],
      githubLogin: null,
    });
    const app = createApp(accountRepo, agentRepo);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    baseUrl = `http://127.0.0.1:${address.port}`;
    const unlist = await putSigned(baseUrl, `/agents/${AGENT_UNLISTED}/listing`, { listed: false }, operator);
    if (unlist.status !== 200) throw new Error(`expected 200, got ${unlist.status}`);
  });

  afterAll(() => {
    server.close();
  });

  it('the roster still returns the unlisted agent, marked listed: false, and the listed one as listed: true', async () => {
    const res = await fetch(`${baseUrl}/accounts/${operator.did}/agents`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<{ did: string; listed: boolean }> };
    const byDid = new Map(body.agents.map((a) => [a.did, a.listed]));
    expect(byDid.get(AGENT_LISTED)).toBe(true);
    expect(byDid.get(AGENT_UNLISTED)).toBe(false);
    expect(body.agents).toHaveLength(2);
  });
});

// (f) The hire door: POST /jobs naming an unlisted agent is 409 and writes
// no job. Naming several where one is unlisted refuses the whole request.
// After listing it again, the same request succeeds.
describe('POST /jobs (FIX-B43a): the hire door refuses an unlisted agent', () => {
  let server: Server;
  let baseUrl: string;
  let buyer: SigningIdentity;
  let listedAgent: SigningIdentity;
  let unlistedAgent: SigningIdentity;
  let thirdAgent: SigningIdentity;
  let owner: SigningIdentity;

  beforeAll(async () => {
    buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(221));
    listedAgent = await signingIdentityFromSeed(new Uint8Array(32).fill(222));
    unlistedAgent = await signingIdentityFromSeed(new Uint8Array(32).fill(223));
    thirdAgent = await signingIdentityFromSeed(new Uint8Array(32).fill(224));
    owner = await signingIdentityFromSeed(new Uint8Array(32).fill(225));

    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: buyer.did, githubLogin: 'hire-door-buyer' });
    await accountRepo.register({ did: owner.did, githubLogin: 'hire-door-owner' });

    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: listedAgent.did,
      operatorDid: owner.did,
      delegation: delegationFor(listedAgent.did, owner.did),
      name: 'scout-listed',
      skills: ['triage'],
      githubLogin: null,
    });
    await agentRepo.create({
      did: unlistedAgent.did,
      operatorDid: owner.did,
      delegation: delegationFor(unlistedAgent.did, owner.did),
      name: 'scout-unlisted',
      skills: ['triage'],
      githubLogin: null,
    });
    await agentRepo.create({
      did: thirdAgent.did,
      operatorDid: owner.did,
      delegation: delegationFor(thirdAgent.did, owner.did),
      name: 'scout-third',
      skills: ['triage'],
      githubLogin: null,
    });

    const unlist = await (async () => {
      const app0 = createApp(accountRepo, agentRepo);
      const s0 = app0.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => s0.once('listening', resolve));
      const addr0 = s0.address();
      if (addr0 === null || typeof addr0 === 'string') throw new Error('expected a port');
      const url0 = `http://127.0.0.1:${addr0.port}`;
      const res = await putSigned(url0, `/agents/${unlistedAgent.did}/listing`, { listed: false }, owner);
      await new Promise<void>((resolve) => s0.close(() => resolve()));
      return res;
    })();
    if (unlist.status !== 200) throw new Error(`expected 200 unlisting, got ${unlist.status}`);

    const jobRepo = new MemoryJobRepository();
    const sessionAdapter = testSessionAdapter();
    const { github } = createStagingLifecycleGithubFake();
    server = createApp(
      accountRepo,
      agentRepo,
      undefined,
      github,
      jobRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sessionAdapter,
      undefined,
      alwaysSettledGate(),
      anyCommitStagingObserver(),
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('naming the unlisted agent alone is 409 with the exact sentence, and writes no job', async () => {
    const res = await postSigned(baseUrl, '/jobs', {
      agentDid: unlistedAgent.did,
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug',
    }, buyer);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('this agent is not taking new hires right now; its owner has stopped listing it');

    const jobsRes = await fetch(`${baseUrl}/accounts/${buyer.did}/jobs`, {
      headers: (() => {
        const targetUri = `${baseUrl}/accounts/${buyer.did}/jobs`;
        const signed = signRequest(buyer, 'GET', targetUri, {});
        return {
          'signature-input': signed['signature-input'],
          signature: signed.signature,
          'content-digest': signed['content-digest'],
        };
      })(),
    });
    expect(jobsRes.status).toBe(200);
    const jobsBody = (await jobsRes.json()) as { jobs: unknown[] };
    expect(jobsBody.jobs).toHaveLength(0);
  });

  it('naming three agents where one is unlisted is 409 and writes zero jobs', async () => {
    const res = await postSigned(baseUrl, '/jobs', {
      agentDids: [listedAgent.did, unlistedAgent.did, thirdAgent.did],
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug',
    }, buyer);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('this agent is not taking new hires right now; its owner has stopped listing it');

    const jobsRes = await fetch(`${baseUrl}/accounts/${buyer.did}/jobs`, {
      headers: (() => {
        const targetUri = `${baseUrl}/accounts/${buyer.did}/jobs`;
        const signed = signRequest(buyer, 'GET', targetUri, {});
        return {
          'signature-input': signed['signature-input'],
          signature: signed.signature,
          'content-digest': signed['content-digest'],
        };
      })(),
    });
    const jobsBody = (await jobsRes.json()) as { jobs: unknown[] };
    expect(jobsBody.jobs).toHaveLength(0);
  });

  it('after listing it again, naming the same agent succeeds with 201', async () => {
    const relist = await putSigned(baseUrl, `/agents/${unlistedAgent.did}/listing`, { listed: true }, owner);
    expect(relist.status).toBe(200);

    const res = await postSigned(baseUrl, '/jobs', {
      agentDid: unlistedAgent.did,
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug, again',
    }, buyer);
    expect(res.status).toBe(201);
  });
});

// (g) Already-open work finishes: unlisting mid-job does not stop it.
describe('FIX-B43a: a job already open when its agent is unlisted keeps working', () => {
  let server: Server;
  let baseUrl: string;
  let buyer: SigningIdentity;
  let agent: SigningIdentity;
  let owner: SigningIdentity;

  beforeAll(async () => {
    buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(231));
    agent = await signingIdentityFromSeed(new Uint8Array(32).fill(232));
    owner = await signingIdentityFromSeed(new Uint8Array(32).fill(233));

    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: buyer.did, githubLogin: 'open-job-buyer' });
    await accountRepo.register({ did: owner.did, githubLogin: 'open-job-owner' });

    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: owner.did,
      delegation: delegationFor(agent.did, owner.did),
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });

    const jobRepo = new MemoryJobRepository();
    const sessionAdapter = testSessionAdapter();
    const { github } = createStagingLifecycleGithubFake();
    server = createApp(
      accountRepo,
      agentRepo,
      undefined,
      github,
      jobRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sessionAdapter,
      undefined,
      alwaysSettledGate(),
      anyCommitStagingObserver(),
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('a job opened before unlisting still reads back, accepts a message, and moves through the negotiation route', async () => {
    const draft = await postSigned(baseUrl, '/jobs', {
      agentDid: agent.did,
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug',
    }, buyer);
    expect(draft.status).toBe(201);
    const jobId = ((await draft.json()) as Record<string, unknown>).id as string;

    const unlist = await putSigned(baseUrl, `/agents/${agent.did}/listing`, { listed: false }, owner);
    expect(unlist.status).toBe(200);

    // The job still reads back.
    const read = await fetch(`${baseUrl}/jobs/${jobId}`);
    expect(read.status).toBe(200);
    expect(((await read.json()) as Record<string, unknown>).id).toBe(jobId);

    // It accepts a message from the buyer.
    const messageRes = await postSigned(baseUrl, `/jobs/${jobId}/messages`, { body: 'still working on this?' }, buyer);
    expect(messageRes.status).toBe(201);

    // It moves one more step through the existing negotiation route: the
    // owner proposes criteria and a price.
    const criteriaRes = await postSigned(
      baseUrl,
      `/jobs/${jobId}/criteria`,
      { criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent' }], priceUsd: '500.00', rail: 'abt' },
      owner,
    );
    expect(criteriaRes.status).toBe(200);
  });
});

// (h) Records stay public: an unlisted agent's stored credentials are
// unchanged and still readable.
describe('GET /agents/:agentDid/credentials (FIX-B43a): unaffected by unlisting', () => {
  let server: Server;
  let baseUrl: string;
  let owner: SigningIdentity;
  const AGENT_DID = 'did:abt:zCredentialsListingAgent';

  function shapedHireCredential(subjectDid: string, jobId: string): VerifiableCredential {
    return {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      id: `urn:uuid:hire-${jobId}`,
      type: ['VerifiableCredential', 'CompletedHireCredential'],
      issuer: 'did:abt:platform',
      validFrom: '2026-08-12T00:00:00.000Z',
      credentialSubject: {
        id: subjectDid,
        hire: {
          brief: 'sha256:brief',
          repository: 'buyer/target-repo',
          pullRequest: `https://github.com/buyer/target-repo/pull/${jobId}`,
          mergedAt: '2026-08-12T00:00:00.000Z',
          mergeCommit: '3f8a2c1d9e7b4a5f6c8d0e1f2a3b4c5d6e7f8a9b',
          signedBy: `${subjectDid}#zJobKey`,
          buyer: 'did:example:buyer',
          additions: 1,
          deletions: 1,
          filesChanged: 1,
        },
      },
      proof: { type: 'Ed25519Signature2020', proofValue: 'zProof' },
    } as unknown as VerifiableCredential;
  }

  beforeAll(async () => {
    owner = await signingIdentityFromSeed(new Uint8Array(32).fill(241));
    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: owner.did, githubLogin: 'credentials-listing-owner' });
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: owner.did,
      delegation: delegationFor(AGENT_DID, owner.did),
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const credentialRepo = new MemoryCredentialRepository();
    await credentialRepo.save({
      completedJobId: 'job-listing-credentials-1',
      subjectDid: AGENT_DID,
      document: shapedHireCredential(AGENT_DID, 'job-listing-credentials-1'),
      repositoryPublic: true,
    });
    const app = createApp(
      accountRepo,
      agentRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      credentialRepo,
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('returns the same credential unchanged after the agent is unlisted', async () => {
    const before = await fetch(`${baseUrl}/agents/${AGENT_DID}/credentials`);
    const beforeBody = await before.json();

    const unlist = await putSigned(baseUrl, `/agents/${AGENT_DID}/listing`, { listed: false }, owner);
    expect(unlist.status).toBe(200);

    const after = await fetch(`${baseUrl}/agents/${AGENT_DID}/credentials`);
    expect(after.status).toBe(200);
    const afterBody = await after.json();
    expect(afterBody).toEqual(beforeBody);
  });
});

// (i) Invariant 2: after unlisting and re-listing, the stored delegation is
// byte-identical and still verifies with @digitalbazaar/vc and the did:abt
// loader alone. Pattern from tests/api/agents-edit-listing.test.ts :507.
describe('PUT /agents/:agentDid/listing (FIX-B43a): invariant 2 still holds after a flip', () => {
  const ORIGINAL_SEED = process.env.FREEAGENTS_PLATFORM_SEED;
  let seedCounter = 900;

  async function verifyIndependent(credential: Record<string, unknown>): Promise<boolean> {
    try {
      const proof = credential.proof as Record<string, unknown>;
      const verificationMethod = String(proof.verificationMethod);
      const issuer = String(credential.issuer);
      const hashIndex = verificationMethod.indexOf('#');
      if (hashIndex === -1) return false;
      const fingerprint = verificationMethod.slice(hashIndex + 1);
      const key = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint });
      const { fromPublicKey } = await import('@arcblock/did');
      const keyWithBuffer = key as unknown as { _publicKeyBuffer: Uint8Array };
      if (fromPublicKey(keyWithBuffer._publicKeyBuffer) !== issuer.replace(/^did:abt:/, '')) return false;
      key.controller = issuer;
      key.id = verificationMethod;
      const loader = securityLoader();
      loader.addStatic(key.id, { '@context': 'https://w3id.org/security/suites/ed25519-2020/v1', ...key.export({ publicKey: true }) });
      loader.addStatic(issuer, {
        '@context': 'https://www.w3.org/ns/did/v1',
        id: issuer,
        assertionMethod: [key.id],
        verificationMethod: [{ '@context': 'https://w3id.org/security/suites/ed25519-2020/v1', ...key.export({ publicKey: true }) }],
      });
      const result = await vc.verifyCredential({ credential, suite: new Ed25519Signature2020(), documentLoader: loader.build() });
      return result.verified === true;
    } catch {
      return false;
    }
  }

  async function postJson(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  }

  afterAll(() => {
    if (ORIGINAL_SEED === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
    else process.env.FREEAGENTS_PLATFORM_SEED = ORIGINAL_SEED;
  });

  it('the delegation is byte-identical and still independently verifies after unlisting and re-listing', async () => {
    seedCounter += 1;
    process.env.FREEAGENTS_PLATFORM_SEED = `b43a${seedCounter}`.padEnd(64, '0');
    const accountRepo = new MemoryAccountRepository();
    const agentRepo = new MemoryAgentRepository();
    const sessionAdapter = testSessionAdapter();
    const identity = createIdentityAdapter(createKnownKeyStore());
    const app = createApp(accountRepo, agentRepo, identity, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const sessionToken = await mintSessionToken(sessionAdapter);
      const auth = { authorization: `Bearer ${sessionToken}` };
      const listRes = await postJson(baseUrl, '/agents', { name: 'scout', skills: ['triage'] }, auth);
      const listBody = (await listRes.json()) as Record<string, unknown>;
      const did = listBody.did as string;

      const beforeStored = await agentRepo.findByDid(did);
      expect(beforeStored).not.toBeNull();
      expect(await verifyIndependent(JSON.parse(JSON.stringify(beforeStored?.delegation)) as Record<string, unknown>)).toBe(true);

      const unlist = await fetch(`${baseUrl}/agents/${did}/listing`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ listed: false }),
      });
      expect(unlist.status).toBe(200);
      const relist = await fetch(`${baseUrl}/agents/${did}/listing`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ listed: true }),
      });
      expect(relist.status).toBe(200);

      const afterStored = await agentRepo.findByDid(did);
      expect(afterStored).not.toBeNull();
      expect(afterStored?.delegation).toEqual(beforeStored?.delegation);
      expect(await verifyIndependent(JSON.parse(JSON.stringify(afterStored?.delegation)) as Record<string, unknown>)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
