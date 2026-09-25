// HT1 (ruling, 2026-09-25): owner-first negotiation, enforced at the route
// layer. "By default we should have all hiring requests go to the owner to
// negotiate work and price points and everything. The agent should not be
// allowed to negotiate on behalf of its owner unless they explicitly
// provide instructions for their agent to do so." The operator is always
// accepted; the agent's own signed request is refused with 403 on every
// negotiation route until the owner turns negotiatesOnOwnersBehalf on
// (PUT /agents/:agentDid/negotiation), and accepted once it is.
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryJobRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { testSessionAdapter } from '../helpers/session-fixtures.js';
import { MemorySettlementGate } from '../../src/adapters/payment/gate.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';

function delegationFixture(agentDid: string, operatorDid: string): Record<string, unknown> {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-negotiation-gate',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
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

let server: Server;
let baseUrl: string;
let buyer: SigningIdentity;
let agent: SigningIdentity;
let operator: SigningIdentity;
let agentRepo: MemoryAgentRepository;
let settlementGate: MemorySettlementGate;
const AGENT_DID_OPERATOR_PLACEHOLDER = 'operator-placeholder';

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

async function putSigned(path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
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

async function openDraft(): Promise<string> {
  const draft = await postSigned('/jobs', {
    agentDid: agent.did,
    repository: 'buyer/target-repo',
    brief: 'Fix the login bug',
  }, buyer);
  const body = (await draft.json()) as Record<string, unknown>;
  return String(body.id);
}

describe('owner-first negotiation gate (HT1)', () => {
  beforeAll(async () => {
    buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(151));
    agent = await signingIdentityFromSeed(new Uint8Array(32).fill(152));
    operator = await signingIdentityFromSeed(new Uint8Array(32).fill(153));

    const operatorRepo = new MemoryAccountRepository();
    await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-negotiation-gate' });
    await operatorRepo.register({ did: operator.did, githubLogin: 'operator-negotiation-gate' });

    agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: operator.did,
      delegation: delegationFixture(agent.did, operator.did) as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: 'scout-negotiation-gate',
    });
    await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-negotiation-gate', status: 'verified' });
    void AGENT_DID_OPERATOR_PLACEHOLDER;

    const jobRepo = new MemoryJobRepository();
    const sessionAdapter = testSessionAdapter();
    settlementGate = new MemorySettlementGate();
    const { github } = createStagingLifecycleGithubFake();
    server = createApp(
      operatorRepo,
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
      settlementGate,
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

  it("the agent's own signature is refused (403) proposing criteria while the flag is off", async () => {
    const jobId = await openDraft();
    const res = await postSigned(
      `/jobs/${jobId}/criteria`,
      { criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent' }], priceUsd: '500.00', rail: 'abt' },
      agent,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain('owner');
  });

  it("the operator's signature proposes criteria and price while the flag is off", async () => {
    const jobId = await openDraft();
    const res = await postSigned(
      `/jobs/${jobId}/criteria`,
      { criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent' }], priceUsd: '500.00', rail: 'abt' },
      operator,
    );
    expect(res.status).toBe(200);
  });

  it("the agent's own signature is refused (403) accepting a criterion while the flag is off", async () => {
    const jobId = await openDraft();
    await postSigned(
      `/jobs/${jobId}/criteria`,
      { criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent' }], priceUsd: '500.00', rail: 'abt' },
      operator,
    );
    const res = await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, agent);
    expect(res.status).toBe(403);
  });

  it("the agent's own signature is refused (403) accepting the price while the flag is off", async () => {
    const jobId = await openDraft();
    await postSigned(
      `/jobs/${jobId}/criteria`,
      { criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent' }], priceUsd: '500.00', rail: 'abt' },
      operator,
    );
    const res = await postSigned(`/jobs/${jobId}/price/accept`, {}, agent);
    expect(res.status).toBe(403);
  });

  it("the agent's own signature is refused (403) on request-changes while the flag is off", async () => {
    const jobId = await openDraft();
    await postSigned(
      `/jobs/${jobId}/criteria`,
      { criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent' }], priceUsd: '500.00', rail: 'abt' },
      operator,
    );
    const res = await postSigned(`/jobs/${jobId}/request-changes`, {}, agent);
    expect(res.status).toBe(403);
  });

  it("the agent's own signature is refused (403) on confirm while the flag is off", async () => {
    const jobId = await openDraft();
    settlementGate.markDepositSettled(jobId);
    await postSigned(
      `/jobs/${jobId}/criteria`,
      { criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent' }], priceUsd: '500.00', rail: 'abt' },
      operator,
    );
    await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, buyer);
    await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, operator);
    await postSigned(`/jobs/${jobId}/price/accept`, {}, buyer);
    await postSigned(`/jobs/${jobId}/price/accept`, {}, operator);
    const res = await postSigned(`/jobs/${jobId}/confirm`, {}, agent);
    expect(res.status).toBe(403);
  });

  it("the agent's own signature is refused (403) declining before confirm while the flag is off", async () => {
    const jobId = await openDraft();
    const res = await postSigned(`/jobs/${jobId}/decline`, {}, agent);
    expect(res.status).toBe(403);
  });

  it("the agent's own signature is accepted on every negotiation route once the owner turns the flag on", async () => {
    const on = await putSigned(`/agents/${agent.did}/negotiation`, { negotiatesOnOwnersBehalf: true }, operator);
    expect(on.status).toBe(200);

    const jobId = await openDraft();
    settlementGate.markDepositSettled(jobId);
    const propose = await postSigned(
      `/jobs/${jobId}/criteria`,
      { criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent' }], priceUsd: '500.00', rail: 'abt' },
      agent,
    );
    expect(propose.status).toBe(200);

    const acceptCrit = await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, agent);
    expect(acceptCrit.status).toBe(200);

    const acceptPrice = await postSigned(`/jobs/${jobId}/price/accept`, {}, agent);
    expect(acceptPrice.status).toBe(200);

    await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, buyer);
    await postSigned(`/jobs/${jobId}/price/accept`, {}, buyer);

    const confirm = await postSigned(`/jobs/${jobId}/confirm`, {}, agent);
    expect(confirm.status).toBe(200);

    // Turn it back off for the next test's isolation.
    await putSigned(`/agents/${agent.did}/negotiation`, { negotiatesOnOwnersBehalf: false }, operator);
  });

  it("the agent's own signature is accepted declining before confirm once the flag is on", async () => {
    await putSigned(`/agents/${agent.did}/negotiation`, { negotiatesOnOwnersBehalf: true }, operator);
    const jobId = await openDraft();
    const res = await postSigned(`/jobs/${jobId}/decline`, {}, agent);
    expect(res.status).toBe(200);
    await putSigned(`/agents/${agent.did}/negotiation`, { negotiatesOnOwnersBehalf: false }, operator);
  });
});
