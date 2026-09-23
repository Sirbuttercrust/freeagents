// AV1 (ENT-2.3 ruling, 2026-09-22): PUT/DELETE /agents/:agentDid/avatar.
// Only the agent's own operator may change the stored override
// (P8v, "operator acts for their own agent"). Modelled on
// tests/api/operator-address.test.ts and tests/api/key-rotation.test.ts's
// own caller-gating block: unsigned 401, registered stranger 403,
// operator 200. Reject a value outside the fixed sets with 400. DELETE
// clears the override back to the DID-derived default.
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAccountRepository, MemoryAgentRepository } from '../../src/adapters/storage/memory.js';
import type { AgentRepository } from '../../src/adapters/storage/types.js';
import type { Delegation } from '../../src/domain/agent.js';
import { defaultAvatar } from '../../src/domain/avatar-spec.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

function delegationFor(agentDid: string, operatorDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:avatar-route-test',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-09-22T00:00:00.000Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-09-22T00:00:00.000Z',
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

async function deleteSigned(baseUrl: string, path: string, identity: SigningIdentity): Promise<Response> {
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, 'DELETE', targetUri, {});
  return fetch(targetUri, {
    method: 'DELETE',
    headers: {
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
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
  const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(241));
  const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(242));
  const agentDid = 'did:abt:zAvatarRouteAgent';
  const accountRepo = new MemoryAccountRepository();
  await accountRepo.register({ did: operator.did, githubLogin: 'avatar-route-operator' });
  await accountRepo.register({ did: stranger.did, githubLogin: 'avatar-route-stranger' });
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

describe('PUT /agents/:agentDid/avatar (AV1)', () => {
  let started: Started;

  beforeAll(async () => {
    started = await startApp();
  });

  afterAll(() => started.server.close());

  it('an unsigned request is refused with 401, and stores nothing', async () => {
    const res = await fetch(`${started.baseUrl}/agents/${started.agentDid}/avatar`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shape: 'triangle', face: 'mouth', colour: 'c7' }),
    });
    expect(res.status).toBe(401);
    const stored = await started.agentRepo.findByDid(started.agentDid);
    expect(stored?.avatarSpec).toBeNull();
  });

  it('a registered stranger (not this agent\'s operator) is refused with 403, and stores nothing', async () => {
    const res = await putSigned(
      started.baseUrl,
      `/agents/${started.agentDid}/avatar`,
      { shape: 'triangle', face: 'mouth', colour: 'c7' },
      started.stranger,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    // The refusal never names the real operator (the same stance
    // requireCallerIsAgentOperator already takes for every sibling route).
    expect(String(body.error)).not.toContain(started.operator.did);
    const stored = await started.agentRepo.findByDid(started.agentDid);
    expect(stored?.avatarSpec).toBeNull();
  });

  it('the operator setting a valid override succeeds with 200 and the row reads it back', async () => {
    const res = await putSigned(
      started.baseUrl,
      `/agents/${started.agentDid}/avatar`,
      { shape: 'triangle', face: 'mouth', colour: 'c7' },
      started.operator,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.avatarSpec).toEqual({ shape: 'triangle', face: 'mouth', colour: 'c7' });

    const stored = await started.agentRepo.findByDid(started.agentDid);
    expect(stored?.avatarSpec).toEqual({ shape: 'triangle', face: 'mouth', colour: 'c7' });
  });

  it('an unknown shape is refused with 400, and does not overwrite what is on record', async () => {
    await putSigned(started.baseUrl, `/agents/${started.agentDid}/avatar`, { shape: 'triangle', face: 'mouth', colour: 'c7' }, started.operator);

    const res = await putSigned(
      started.baseUrl,
      `/agents/${started.agentDid}/avatar`,
      { shape: 'robot', face: 'mouth', colour: 'c7' },
      started.operator,
    );
    expect(res.status).toBe(400);
    const stored = await started.agentRepo.findByDid(started.agentDid);
    expect(stored?.avatarSpec).toEqual({ shape: 'triangle', face: 'mouth', colour: 'c7' });
  });

  it('an unknown face is refused with 400', async () => {
    const res = await putSigned(
      started.baseUrl,
      `/agents/${started.agentDid}/avatar`,
      { shape: 'triangle', face: 'nose', colour: 'c7' },
      started.operator,
    );
    expect(res.status).toBe(400);
  });

  it('an unknown colour key is refused with 400', async () => {
    const res = await putSigned(
      started.baseUrl,
      `/agents/${started.agentDid}/avatar`,
      { shape: 'triangle', face: 'mouth', colour: 'c13' },
      started.operator,
    );
    expect(res.status).toBe(400);
  });

  it('a raw hex colour is refused with 400 -- validation accepts a key, never a raw hex', async () => {
    const res = await putSigned(
      started.baseUrl,
      `/agents/${started.agentDid}/avatar`,
      { shape: 'triangle', face: 'mouth', colour: '#E0A24E' },
      started.operator,
    );
    expect(res.status).toBe(400);
  });

  it('an unknown agent is refused with 404 for an authenticated, well-formed request', async () => {
    const res = await putSigned(
      started.baseUrl,
      '/agents/did:abt:zNobody/avatar',
      { shape: 'triangle', face: 'mouth', colour: 'c7' },
      started.operator,
    );
    expect(res.status).toBe(404);
  });
});

describe('DELETE /agents/:agentDid/avatar (AV1)', () => {
  let started: Started;

  beforeAll(async () => {
    started = await startApp();
    await putSigned(started.baseUrl, `/agents/${started.agentDid}/avatar`, { shape: 'triangle', face: 'mouth', colour: 'c7' }, started.operator);
  });

  afterAll(() => started.server.close());

  it('an unsigned request is refused with 401, and clears nothing', async () => {
    const res = await fetch(`${started.baseUrl}/agents/${started.agentDid}/avatar`, { method: 'DELETE' });
    expect(res.status).toBe(401);
    const stored = await started.agentRepo.findByDid(started.agentDid);
    expect(stored?.avatarSpec).toEqual({ shape: 'triangle', face: 'mouth', colour: 'c7' });
  });

  it('a registered stranger is refused with 403, and clears nothing', async () => {
    const res = await deleteSigned(started.baseUrl, `/agents/${started.agentDid}/avatar`, started.stranger);
    expect(res.status).toBe(403);
    const stored = await started.agentRepo.findByDid(started.agentDid);
    expect(stored?.avatarSpec).toEqual({ shape: 'triangle', face: 'mouth', colour: 'c7' });
  });

  it('the operator clearing the override succeeds with 200 and the response carries the DID-derived default', async () => {
    const res = await deleteSigned(started.baseUrl, `/agents/${started.agentDid}/avatar`, started.operator);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.avatarSpec).toEqual(defaultAvatar(started.agentDid));

    const stored = await started.agentRepo.findByDid(started.agentDid);
    expect(stored?.avatarSpec).toBeNull();
  });

  it('an unknown agent is refused with 404', async () => {
    const res = await deleteSigned(started.baseUrl, '/agents/did:abt:zNobody/avatar', started.operator);
    expect(res.status).toBe(404);
  });
});

// Mutation coverage (brief's own requirement): removing the operator check
// must turn the stranger-refusal test red. Asserted here structurally,
// against a stand-in AgentRepository whose setAvatarSpec is a spy, so a
// regression that lets ANY authenticated caller write is caught even if
// the wording of the 403 test above were weakened.
describe('PUT /agents/:agentDid/avatar, side-effect spy on every refusal (AV1)', () => {
  it('the storage write is never reached for an unsigned, a stranger, or a malformed request', async () => {
    const base = new MemoryAgentRepository();
    const accountRepo = new MemoryAccountRepository();
    const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(243));
    const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(244));
    await accountRepo.register({ did: operator.did, githubLogin: 'avatar-spy-operator' });
    await accountRepo.register({ did: stranger.did, githubLogin: 'avatar-spy-stranger' });
    const agentDid = 'did:abt:zAvatarSpyAgent';
    await base.create({
      did: agentDid,
      operatorDid: operator.did,
      delegation: delegationFor(agentDid, operator.did),
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });

    const setAvatarSpec = vi.fn(base.setAvatarSpec.bind(base));
    const spyRepo: AgentRepository = {
      create: (input) => base.create(input),
      findByDid: (did) => base.findByDid(did),
      updateGithubBinding: (did, input) => base.updateGithubBinding(did, input),
      recordKeyRotation: (did, input) => base.recordKeyRotation(did, input),
      setAvatarSpec,
    };

    const app = createApp(accountRepo, spyRepo);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      await fetch(`${baseUrl}/agents/${agentDid}/avatar`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shape: 'triangle', face: 'mouth', colour: 'c7' }),
      });
      await putSigned(baseUrl, `/agents/${agentDid}/avatar`, { shape: 'triangle', face: 'mouth', colour: 'c7' }, stranger);
      await putSigned(baseUrl, `/agents/${agentDid}/avatar`, { shape: 'robot', face: 'mouth', colour: 'c7' }, operator);

      expect(setAvatarSpec).not.toHaveBeenCalled();

      const ok = await putSigned(baseUrl, `/agents/${agentDid}/avatar`, { shape: 'triangle', face: 'mouth', colour: 'c7' }, operator);
      expect(ok.status).toBe(200);
      expect(setAvatarSpec).toHaveBeenCalledTimes(1);
    } finally {
      server.close();
    }
  });
});
