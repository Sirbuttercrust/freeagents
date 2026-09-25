// HT1 (ruling, 2026-09-25): PUT /agents/:agentDid/negotiation. Only the
// agent's own operator may change the stored flag (mirrors AV1's caller
// gating exactly): unsigned 401, registered stranger 403, operator 200.
// The flag defaults false; once true, the agent's own signature is
// accepted on the negotiation routes too (proved in
// tests/api/job-negotiation-gate.test.ts).
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAccountRepository, MemoryAgentRepository } from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { IdentityAdapter, DidDocument } from '../../src/adapters/identity/types.js';
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

function fakeIdentity(): IdentityAdapter {
  return {
    createOperatorDid: () => Promise.reject(new NotImplementedError('identity', 'createOperatorDid')),
    createAgentDid: () => Promise.reject(new NotImplementedError('identity', 'createAgentDid')),
    resolveDid: (): Promise<DidDocument> => Promise.reject(new NotImplementedError('identity', 'resolveDid')),
    sign: () => Promise.reject(new NotImplementedError('identity', 'sign')),
    verify: () => Promise.reject(new NotImplementedError('identity', 'verify')),
    verifyDelegation: () => Promise.resolve(true),
  };
}

function delegationFor(agentDid: string, operatorDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:negotiation-flag-route-test',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-09-25T00:00:00.000Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-09-25T00:00:00.000Z',
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

interface Started {
  readonly server: Server;
  readonly baseUrl: string;
  readonly agentRepo: MemoryAgentRepository;
  readonly operator: SigningIdentity;
  readonly stranger: SigningIdentity;
  readonly agentDid: string;
}

async function startApp(): Promise<Started> {
  const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(251));
  const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(252));
  const agentDid = 'did:abt:zNegotiationFlagAgent';
  const accountRepo = new MemoryAccountRepository();
  await accountRepo.register({ did: operator.did, githubLogin: 'negotiation-flag-operator' });
  await accountRepo.register({ did: stranger.did, githubLogin: 'negotiation-flag-stranger' });
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

describe('PUT /agents/:agentDid/negotiation (HT1)', () => {
  let started: Started;

  beforeAll(async () => {
    started = await startApp();
  });

  afterAll(() => {
    started.server.close();
  });

  it('defaults to false on a freshly delegated agent', async () => {
    const res = await fetch(`${started.baseUrl}/agents/${started.agentDid}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.negotiatesOnOwnersBehalf).toBe(false);
  });

  it('an unsigned request is refused with 401', async () => {
    const res = await fetch(`${started.baseUrl}/agents/${started.agentDid}/negotiation`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ negotiatesOnOwnersBehalf: true }),
    });
    expect(res.status).toBe(401);
  });

  it('a registered stranger is refused with 403', async () => {
    const res = await putSigned(started.baseUrl, `/agents/${started.agentDid}/negotiation`, { negotiatesOnOwnersBehalf: true }, started.stranger);
    expect(res.status).toBe(403);
  });

  it('the operator turns the flag on, and the agent projection reflects it', async () => {
    const res = await putSigned(started.baseUrl, `/agents/${started.agentDid}/negotiation`, { negotiatesOnOwnersBehalf: true }, started.operator);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.negotiatesOnOwnersBehalf).toBe(true);

    const read = await fetch(`${started.baseUrl}/agents/${started.agentDid}`);
    const readBody = (await read.json()) as Record<string, unknown>;
    expect(readBody.negotiatesOnOwnersBehalf).toBe(true);
  });

  it('the operator turns the flag back off', async () => {
    await putSigned(started.baseUrl, `/agents/${started.agentDid}/negotiation`, { negotiatesOnOwnersBehalf: true }, started.operator);
    const res = await putSigned(started.baseUrl, `/agents/${started.agentDid}/negotiation`, { negotiatesOnOwnersBehalf: false }, started.operator);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.negotiatesOnOwnersBehalf).toBe(false);
  });

  it('a non-boolean value is refused with 400', async () => {
    const res = await putSigned(started.baseUrl, `/agents/${started.agentDid}/negotiation`, { negotiatesOnOwnersBehalf: 'yes' }, started.operator);
    expect(res.status).toBe(400);
  });

  it('an unregistered agent DID is refused with 404', async () => {
    const res = await putSigned(started.baseUrl, `/agents/did:abt:zNoSuchAgent/negotiation`, { negotiatesOnOwnersBehalf: true }, started.operator);
    expect(res.status).toBe(404);
  });
});

describe('POST /agents negotiatesOnOwnersBehalf (HT1)', () => {
  it('defaults to false when the body omits it', async () => {
    const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(253));
    const agentDid = 'did:abt:zNegotiationRegisterDefault';
    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: operator.did, githubLogin: 'negotiation-register-default' });
    const agentRepo = new MemoryAgentRepository();
    const app = createApp(accountRepo, agentRepo, fakeIdentity());
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('expected a port');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const bodyText = JSON.stringify({
        did: agentDid,
        delegation: delegationFor(agentDid, operator.did),
        name: 'scout',
        skills: ['triage'],
      });
      const signed = signRequest(operator, 'POST', `${baseUrl}/agents`, { body: bodyText });
      const res = await fetch(`${baseUrl}/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'signature-input': signed['signature-input'], signature: signed.signature, 'content-digest': signed['content-digest'] },
        body: bodyText,
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.negotiatesOnOwnersBehalf).toBe(false);
    } finally {
      server.close();
    }
  });

  it('honors an explicit true in the registration body', async () => {
    const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(254));
    const agentDid = 'did:abt:zNegotiationRegisterTrue';
    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: operator.did, githubLogin: 'negotiation-register-true' });
    const agentRepo = new MemoryAgentRepository();
    const app = createApp(accountRepo, agentRepo, fakeIdentity());
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('expected a port');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const bodyText = JSON.stringify({
        did: agentDid,
        delegation: delegationFor(agentDid, operator.did),
        name: 'scout',
        skills: ['triage'],
        negotiatesOnOwnersBehalf: true,
      });
      const signed = signRequest(operator, 'POST', `${baseUrl}/agents`, { body: bodyText });
      const res = await fetch(`${baseUrl}/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'signature-input': signed['signature-input'], signature: signed.signature, 'content-digest': signed['content-digest'] },
        body: bodyText,
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.negotiatesOnOwnersBehalf).toBe(true);
    } finally {
      server.close();
    }
  });

  it('a non-boolean value in the registration body is refused with 400', async () => {
    const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(255));
    const agentDid = 'did:abt:zNegotiationRegisterBad';
    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: operator.did, githubLogin: 'negotiation-register-bad' });
    const agentRepo = new MemoryAgentRepository();
    const app = createApp(accountRepo, agentRepo, fakeIdentity());
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('expected a port');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const bodyText = JSON.stringify({
        did: agentDid,
        delegation: delegationFor(agentDid, operator.did),
        name: 'scout',
        skills: ['triage'],
        negotiatesOnOwnersBehalf: 'yes',
      });
      const signed = signRequest(operator, 'POST', `${baseUrl}/agents`, { body: bodyText });
      const res = await fetch(`${baseUrl}/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'signature-input': signed['signature-input'], signature: signed.signature, 'content-digest': signed['content-digest'] },
        body: bodyText,
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });
});
