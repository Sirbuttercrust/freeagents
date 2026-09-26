// FIX-B41a item 6: PATCH /agents/:agentDid, editing an existing listing.
// Gated by requireCallerIsAgentOperator (the same gate avatar, negotiation
// and webhook already use): unsigned 401, registered stranger 403, unknown
// agent 404. Never touches did, delegation, githubLogin or proofStatus.
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAccountRepository, MemoryAgentRepository } from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

function delegationFor(agentDid: string, operatorDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:patch-listing-route-test',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-09-26T00:00:00.000Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-09-26T00:00:00.000Z',
      verificationMethod: `${operatorDid}#zOperatorKeyHash`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zMockProofValue',
    },
  };
}

async function patchSigned(baseUrl: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, 'PATCH', targetUri, { body: bodyText });
  return fetch(targetUri, {
    method: 'PATCH',
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
  const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(231));
  const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(232));
  const agentDid = 'did:abt:zPatchListingAgent';
  const accountRepo = new MemoryAccountRepository();
  await accountRepo.register({ did: operator.did, githubLogin: 'patch-listing-operator' });
  await accountRepo.register({ did: stranger.did, githubLogin: 'patch-listing-stranger' });
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: agentDid,
    operatorDid: operator.did,
    delegation: delegationFor(agentDid, operator.did),
    name: 'scout',
    description: 'a careful triage scout',
    skills: ['triage'],
    githubLogin: 'never-touched-login',
    floorPriceUsd: '10.00',
  });
  const app = createApp(accountRepo, agentRepo);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, baseUrl, agentRepo, operator, stranger, agentDid };
}

describe('PATCH /agents/:agentDid (FIX-B41a item 6)', () => {
  let started: Started;

  beforeAll(async () => {
    started = await startApp();
  });

  afterAll(() => {
    started.server.close();
  });

  it('an unsigned request is refused with 401', async () => {
    const res = await fetch(`${started.baseUrl}/agents/${started.agentDid}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'new name' }),
    });
    expect(res.status).toBe(401);
  });

  it('a registered stranger is refused with 403', async () => {
    const res = await patchSigned(started.baseUrl, `/agents/${started.agentDid}`, { name: 'stolen name' }, started.stranger);
    expect(res.status).toBe(403);
  });

  it('an unknown agent is 404', async () => {
    const res = await patchSigned(started.baseUrl, '/agents/did:abt:zNeverListed', { name: 'ghost' }, started.operator);
    expect(res.status).toBe(404);
  });

  it('the operator edits name, description, skills and floorPriceUsd, each field independently', async () => {
    const nameRes = await patchSigned(started.baseUrl, `/agents/${started.agentDid}`, { name: 'renamed scout' }, started.operator);
    expect(nameRes.status).toBe(200);
    expect(((await nameRes.json()) as Record<string, unknown>).name).toBe('renamed scout');

    const descRes = await patchSigned(started.baseUrl, `/agents/${started.agentDid}`, { description: 'a new one-liner' }, started.operator);
    expect(descRes.status).toBe(200);
    expect(((await descRes.json()) as Record<string, unknown>).description).toBe('a new one-liner');

    const skillsRes = await patchSigned(started.baseUrl, `/agents/${started.agentDid}`, { skills: ['backend', 'infra'] }, started.operator);
    expect(skillsRes.status).toBe(200);
    expect(((await skillsRes.json()) as Record<string, unknown>).skills).toEqual(['backend', 'infra']);

    const floorRes = await patchSigned(started.baseUrl, `/agents/${started.agentDid}`, { floorPriceUsd: '25.00' }, started.operator);
    expect(floorRes.status).toBe(200);
    expect(((await floorRes.json()) as Record<string, unknown>).floorPriceUsd).toBe('25.00');

    // floorPriceUsd may be null to clear it.
    const clearRes = await patchSigned(started.baseUrl, `/agents/${started.agentDid}`, { floorPriceUsd: null }, started.operator);
    expect(clearRes.status).toBe(200);
    expect(((await clearRes.json()) as Record<string, unknown>).floorPriceUsd).toBeNull();

    const read = await fetch(`${started.baseUrl}/agents/${started.agentDid}`);
    const readBody = (await read.json()) as Record<string, unknown>;
    expect(readBody.name).toBe('renamed scout');
    expect(readBody.description).toBe('a new one-liner');
    expect(readBody.skills).toEqual(['backend', 'infra']);
    expect(readBody.floorPriceUsd).toBeNull();
  });

  it('a body naming did, delegation, githubLogin or proofStatus changes none of them', async () => {
    const before = await (await fetch(`${started.baseUrl}/agents/${started.agentDid}`)).json() as Record<string, unknown>;
    const res = await patchSigned(
      started.baseUrl,
      `/agents/${started.agentDid}`,
      {
        did: 'did:abt:zHijacked',
        delegation: { fake: true },
        githubLogin: 'hijacked-login',
        proofStatus: 'verified',
      },
      started.operator,
    );
    expect(res.status).toBe(200);
    const after = (await res.json()) as Record<string, unknown>;
    expect(after.did).toBe(before.did);
    expect(after.delegation).toEqual(before.delegation);
    expect(after.githubLogin).toBe(before.githubLogin);
    expect(after.proofStatus).toBe(before.proofStatus);
  });

  it('a malformed body (empty name) is 400', async () => {
    const res = await patchSigned(started.baseUrl, `/agents/${started.agentDid}`, { name: '' }, started.operator);
    expect(res.status).toBe(400);
  });

  it('a malformed description (too long) is 400', async () => {
    const res = await patchSigned(started.baseUrl, `/agents/${started.agentDid}`, { description: 'x'.repeat(161) }, started.operator);
    expect(res.status).toBe(400);
  });
});

describe('PATCH /agents/:agentDid, storage without updateListing (FIX-B41a item 6)', () => {
  it('answers 503 storage unavailable when the driver lacks updateListing, the same stance browse takes', async () => {
    const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(233));
    const agentDid = 'did:abt:zNoUpdateListingAgent';
    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: operator.did, githubLogin: 'no-update-listing-operator' });

    // A hand-rolled AgentRepository stand-in with no updateListing at all,
    // the same pattern the nine existing hand-rolled repositories in other
    // test files use -- proving that pattern still compiles and behaves.
    const agentRow = {
      did: agentDid,
      operatorDid: operator.did,
      delegation: delegationFor(agentDid, operator.did),
      name: 'scout',
      description: null,
      skills: ['triage'],
      githubLogin: null,
      proofStatus: 'unverified' as const,
      createdAt: new Date(),
      keyRotations: [],
      floorPriceUsd: null,
      minBuyerMerges: null,
      maxWalkedAfterConfirm: null,
      avatarSpec: null,
      negotiatesOnOwnersBehalf: false,
      notifyWebhookUrl: null,
    };
    const standIn = {
      async create() {
        return agentRow;
      },
      async findByDid() {
        return agentRow;
      },
      async updateGithubBinding() {
        return agentRow;
      },
      async recordKeyRotation() {
        return agentRow;
      },
      async setAvatarSpec() {
        return agentRow;
      },
      async setNegotiatesOnOwnersBehalf() {
        return agentRow;
      },
      async setNotifyWebhookUrl() {
        return agentRow;
      },
      // updateListing deliberately omitted.
    };
    const app = createApp(accountRepo, standIn as unknown as MemoryAgentRepository);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const res = await patchSigned(baseUrl, `/agents/${agentDid}`, { name: 'renamed' }, operator);
      expect(res.status).toBe(503);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
