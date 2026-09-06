// P1: the price line of the acceptance-criteria exchange, driven end to end
// over HTTP. tests/api/job-criteria.test.ts and tests/api/job-confirm.test.ts
// already exercise the propose->accept->confirm walk with a price attached;
// this file is the price line's own acceptance test -- the floor rejection,
// the price/accept route's party-aware flip, and confirm's 409 mapping when
// the price is missing or only half-accepted.
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryJobRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { testSessionAdapter } from '../helpers/session-fixtures.js';

function delegationFixture(agentDid: string): Record<string, unknown> {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-price',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: 'did:abt:op-price',
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-01-01T00:00:00Z',
      verificationMethod: `${agentDid}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zfixture-not-verified-here',
    },
  };
}

async function postSigned(path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
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

async function openDraft(agentDid: string, buyerIdentity: SigningIdentity): Promise<string> {
  const draft = await postSigned('/jobs', {
    agentDid,
    repository: 'buyer/target-repo',
    brief: 'Fix the login bug',
  }, buyerIdentity);
  const body = (await draft.json()) as Record<string, unknown>;
  return String(body.id);
}

let server: Server;
let baseUrl: string;
let buyer: SigningIdentity;
let agent: SigningIdentity;
let flooredAgent: SigningIdentity;
let stranger: SigningIdentity;

describe('job price exchange (P1)', () => {
  beforeAll(async () => {
    buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(71));
    agent = await signingIdentityFromSeed(new Uint8Array(32).fill(72));
    flooredAgent = await signingIdentityFromSeed(new Uint8Array(32).fill(73));
    stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(74));

    const operatorRepo = new MemoryAccountRepository();
    await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-price' });

    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: 'did:abt:op-price',
      delegation: delegationFixture(agent.did) as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    await agentRepo.create({
      did: flooredAgent.did,
      operatorDid: 'did:abt:op-price',
      delegation: delegationFixture(flooredAgent.did) as never,
      name: 'scout-with-a-floor',
      skills: ['triage'],
      githubLogin: null,
      floorPriceUsd: '100.00',
    });
    // Registered so its signature verifies (R-34), but never named a party
    // on any job this file creates: the fixture for the 403 leg.
    await agentRepo.create({
      did: stranger.did,
      operatorDid: 'did:abt:op-price',
      delegation: delegationFixture(stranger.did) as never,
      name: 'stranger',
      skills: ['triage'],
      githubLogin: null,
    });
    const jobRepo = new MemoryJobRepository();
    const sessionAdapter = testSessionAdapter();
    server = createApp(
      operatorRepo,
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
      sessionAdapter,
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('carries the proposed price in the projection, unaccepted by both parties', async () => {
    const jobId = await openDraft(agent.did, buyer);

    const proposed = await postSigned(
      `/jobs/${jobId}/criteria`,
      { criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent' }], priceUsd: '500.00', rail: 'abt' },
      agent,
    );
    expect(proposed.status).toBe(200);
    const body = (await proposed.json()) as Record<string, unknown>;
    expect(body.price).toEqual({
      priceUsd: '500.00',
      rail: 'abt',
      depositPercent: 25,
      redoAllowance: 1,
      deliveryWindowDays: 14,
      acceptedByBuyer: false,
      acceptedByAgent: false,
    });
  });

  it('refuses a price below the agent\'s floor with 400, naming the floor', async () => {
    const jobId = await openDraft(flooredAgent.did, buyer);

    const proposed = await postSigned(
      `/jobs/${jobId}/criteria`,
      { criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent' }], priceUsd: '50.00', rail: 'abt' },
      flooredAgent,
    );
    expect(proposed.status).toBe(400);
    const errorBody = (await proposed.json()) as { error: string };
    expect(errorBody.error).toContain('100.00');

    // The rejected proposal never reached storage: the job is still a draft
    // with no price attached.
    const read = await fetch(`${baseUrl}/jobs/${jobId}`);
    const readBack = (await read.json()) as Record<string, unknown>;
    expect(readBack.status).toBe('draft');
    expect(readBack.price).toBeUndefined();
  });

  it('accepts a price at or above the floor', async () => {
    const jobId = await openDraft(flooredAgent.did, buyer);

    const proposed = await postSigned(
      `/jobs/${jobId}/criteria`,
      { criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent' }], priceUsd: '100.00', rail: 'abt' },
      flooredAgent,
    );
    expect(proposed.status).toBe(200);
  });

  it('price/accept flips only the calling party\'s own flag, party-aware like criteria accept', async () => {
    const jobId = await openDraft(agent.did, buyer);
    await postSigned(
      `/jobs/${jobId}/criteria`,
      { criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent' }], priceUsd: '500.00', rail: 'abt' },
      agent,
    );

    const acceptedByBuyer = await postSigned(`/jobs/${jobId}/price/accept`, {}, buyer);
    expect(acceptedByBuyer.status).toBe(200);
    const afterBuyer = (await acceptedByBuyer.json()) as Record<string, unknown>;
    expect((afterBuyer.price as Record<string, unknown>).acceptedByBuyer).toBe(true);
    expect((afterBuyer.price as Record<string, unknown>).acceptedByAgent).toBe(false);

    const acceptedByAgent = await postSigned(`/jobs/${jobId}/price/accept`, {}, agent);
    expect(acceptedByAgent.status).toBe(200);
    const afterAgent = (await acceptedByAgent.json()) as Record<string, unknown>;
    expect((afterAgent.price as Record<string, unknown>).acceptedByBuyer).toBe(true);
    expect((afterAgent.price as Record<string, unknown>).acceptedByAgent).toBe(true);
  });

  it('price/accept refuses a signer who is not a party to the job with 403', async () => {
    const jobId = await openDraft(agent.did, buyer);
    await postSigned(
      `/jobs/${jobId}/criteria`,
      { criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent' }], priceUsd: '500.00', rail: 'abt' },
      agent,
    );

    const res = await postSigned(`/jobs/${jobId}/price/accept`, {}, stranger);
    expect(res.status).toBe(403);
  });

  it('confirm answers 409 when no price has been proposed at all, even with criteria fully agreed', async () => {
    const jobId = await openDraft(agent.did, buyer);
    await postSigned(`/jobs/${jobId}/criteria`, { criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent' }] }, agent);
    await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, buyer);
    await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, agent);

    const confirmed = await postSigned(`/jobs/${jobId}/confirm`, {}, buyer);
    expect(confirmed.status).toBe(409);
    const body = (await confirmed.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain('price');
  });

  it('confirm answers 409 when the price is proposed but only one party accepted it', async () => {
    const jobId = await openDraft(agent.did, buyer);
    await postSigned(
      `/jobs/${jobId}/criteria`,
      { criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent' }], priceUsd: '500.00', rail: 'abt' },
      agent,
    );
    await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, buyer);
    await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, agent);
    await postSigned(`/jobs/${jobId}/price/accept`, {}, buyer);

    const confirmed = await postSigned(`/jobs/${jobId}/confirm`, {}, buyer);
    expect(confirmed.status).toBe(409);
  });
});
