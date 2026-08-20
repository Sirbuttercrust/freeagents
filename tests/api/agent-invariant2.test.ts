// Invariant 2 (MISSION.md): a third party can verify what this service
// stores without calling it. R-2 stores the delegation proof the operator's
// wallet signed (ENT-3); the proof carries the operator's public key, so
// @arcblock/vc verifies it offline, with no DID resolution and no call to
// this service. The strongest honest evidence: read the stored row straight
// from the repository, hand it to @arcblock/vc.verify, and get a pass; a
// tampered copy must fail the same check. Fixtures use real random wallets:
// a hand-rolled did:abt:<short> that no key could have signed would prove
// nothing about the cryptographic path.
import {
  create as createCredential,
  verify as verifyCredential,
} from '@arcblock/vc';

// @arcblock/vc does not export its credential type, only its functions;
// create's return type is the very thing verify expects.
type Credential = NonNullable<Awaited<ReturnType<typeof createCredential>>>;
import { fromRandom, type WalletObject } from '@ocap/wallet';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryOperatorRepository } from '../../src/adapters/storage/memory.js';
import { DELEGATION_TYPE } from '../../src/domain/agent.js';

// Names that would mean key material leaked into storage. Matched by
// substring. The delegation's own public keys (issuer.pk, proof.pk) are the
// point of the record, not a leak, so they are not in this list.
const KEY_MATERIAL_STEMS = ['privateKey', 'secretKey', 'secret', 'keyPair', 'mnemonic'];
function findKeyMaterialFields(obj: unknown, path = ''): string[] {
  const hits: string[] = [];
  if (obj === null || typeof obj !== 'object') return hits;
  for (const [key, value] of Object.entries(obj)) {
    const here = path === '' ? key : `${path}.${key}`;
    if (KEY_MATERIAL_STEMS.some((stem) => key.toLowerCase().includes(stem.toLowerCase()))) {
      hits.push(here);
    }
    if (value !== null && typeof value === 'object') {
      hits.push(...findKeyMaterialFields(value, here));
    }
  }
  return hits;
}

// The delegation exactly as an operator would produce it: signed by the
// operator wallet, subject the agent wallet's key hash. The vendor sets
// issuer.id to the wallet's short form (z...); the registry records the full
// DID (did:abt:z...), and the service must reconcile the two.
async function signDelegation(operator: WalletObject, agent: WalletObject): Promise<Credential> {
  const credential = await createCredential({
    type: DELEGATION_TYPE,
    subject: { id: agent.address },
    issuer: { wallet: operator, name: operator.toDid() },
  });
  if (credential === null) throw new Error('credential creation failed');
  return credential;
}

async function postJson(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('agent delegation, invariant 2 (R-2)', () => {
  let server: Server;
  let baseUrl: string;
  const repo = new MemoryOperatorRepository();
  const agentRepo = new MemoryAgentRepository();
  const operator = fromRandom();
  const agent = fromRandom();

  beforeAll(async () => {
    server = createApp(repo, agentRepo).listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    // The operator registers first: a delegation vouches with its standing.
    const reg = await postJson(baseUrl, '/operators', { did: operator.toDid(), githubLogin: 'operator-inv2' });
    expect(reg.status).toBe(201);
  });

  afterAll(() => {
    server.close();
  });

  it('stores a delegation that verifies with @arcblock/vc without calling the service', async () => {
    const credential = await signDelegation(operator, agent);
    const res = await postJson(baseUrl, '/agents', {
      did: agent.toDid(),
      operator: operator.toDid(),
      delegation: credential,
      name: 'scout',
      skills: ['triage'],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.did).toBe(agent.toDid());
    expect(body.operatorDid).toBe(operator.toDid());

    // Third-party verification, with no HTTP request to this service in
    // between: the stored row's delegation, JSON-round-tripped into a
    // stranger's copy, verifies offline against the operator's key hash.
    const stored = await agentRepo.findByDid(agent.toDid());
    expect(stored).not.toBeNull();
    const strangerCopy = JSON.parse(JSON.stringify(stored?.delegation)) as Credential;
    const ok = await verifyCredential({
      vc: strangerCopy,
      ownerDid: strangerCopy.credentialSubject.id,
      trustedIssuers: [operator.address],
    });
    expect(ok).toBe(true);
  });

  it('read-back serves the same delegation, and it still verifies', async () => {
    const readBack = await fetch(`${baseUrl}/agents/${agent.toDid()}`);
    expect(readBack.status).toBe(200);
    const body = (await readBack.json()) as Record<string, unknown>;

    const stored = await agentRepo.findByDid(agent.toDid());
    expect(stored).not.toBeNull();
    expect(body).toEqual({
      did: stored?.did,
      operatorDid: stored?.operatorDid,
      delegation: stored?.delegation,
      name: stored?.name,
      skills: [...(stored?.skills ?? [])],
      githubLogin: stored?.githubLogin,
      proofStatus: stored?.proofStatus,
      createdAt: stored?.createdAt.toISOString(),
    });

    // A stranger who fetched the delegation from the public API can verify
    // it just as well: same offline check, nothing else from this service.
    const wireCopy = JSON.parse(JSON.stringify(body.delegation)) as Credential;
    const ok = await verifyCredential({
      vc: wireCopy,
      ownerDid: wireCopy.credentialSubject.id,
      trustedIssuers: [operator.address],
    });
    expect(ok).toBe(true);
  });

  it('a tampered copy fails the same check', async () => {
    const stored = await agentRepo.findByDid(agent.toDid());
    expect(stored).not.toBeNull();
    const tampered = JSON.parse(JSON.stringify(stored?.delegation)) as Credential;
    const proof = tampered.proof as { jws: string };
    tampered.proof = { ...proof, jws: `AAAA${proof.jws.slice(4)}` } as Credential['proof'];
    await expect(
      verifyCredential({
        vc: tampered,
        ownerDid: tampered.credentialSubject.id,
        trustedIssuers: [operator.address],
      }),
    ).rejects.toThrow();
  });

  it('a credential whose proof no longer matches its signer is rejected with 400', async () => {
    const intruderAgent = fromRandom();
    const credential = await signDelegation(operator, intruderAgent);
    // Break the proof after signing: shape stays intact (so the structural
    // checks pass) but the signature no longer checks out.
    const broken = { ...credential, proof: { ...(credential.proof as object), pk: 'zTamperedProofKey' } };
    const res = await postJson(baseUrl, '/agents', {
      did: intruderAgent.toDid(),
      operator: operator.toDid(),
      delegation: broken,
      name: 'impostor',
      skills: ['triage'],
    });
    expect(res.status).toBe(400);
  });

  it('a credential signed by a different key is rejected with 400', async () => {
    const stranger = fromRandom();
    const otherAgent = fromRandom();
    const credential = await signDelegation(stranger, otherAgent);
    const res = await postJson(baseUrl, '/agents', {
      did: otherAgent.toDid(),
      operator: operator.toDid(),
      delegation: credential,
      name: 'forged',
      skills: ['triage'],
    });
    expect(res.status).toBe(400);
  });

  it('delegating from an unregistered operator is 404', async () => {
    const stranger = fromRandom();
    const otherAgent = fromRandom();
    const credential = await signDelegation(stranger, otherAgent);
    const res = await postJson(baseUrl, '/agents', {
      did: otherAgent.toDid(),
      operator: stranger.toDid(),
      delegation: credential,
      name: 'orphan',
      skills: ['triage'],
    });
    expect(res.status).toBe(404);
  });

  it('delegating the same agent DID twice is 409', async () => {
    const credential = await signDelegation(operator, agent);
    const res = await postJson(baseUrl, '/agents', {
      did: agent.toDid(),
      operator: operator.toDid(),
      delegation: credential,
      name: 'scout again',
      skills: ['triage'],
    });
    expect(res.status).toBe(409);
  });

  it('malformed bodies are 400', async () => {
    const missingDelegation = await postJson(baseUrl, '/agents', {
      did: agent.toDid(),
      operator: operator.toDid(),
      name: 'no proof',
      skills: ['triage'],
    });
    expect(missingDelegation.status).toBe(400);

    const badSkills = await postJson(baseUrl, '/agents', {
      did: agent.toDid(),
      operator: operator.toDid(),
      delegation: 'not an object',
      name: 'bad skills',
      skills: [],
    });
    expect(badSkills.status).toBe(400);
  });

  it('an unknown agent is 404 on read', async () => {
    const res = await fetch(`${baseUrl}/agents/did:abt:nobody`);
    expect(res.status).toBe(404);
  });

  it('stores the credential verbatim and no key material', async () => {
    const stored = await agentRepo.findByDid(agent.toDid());
    expect(stored).not.toBeNull();
    expect(findKeyMaterialFields(stored)).toEqual([]);
    // The stored delegation is the full credential, not a projection of it:
    // drop the issuer's public key or the signature and it stops verifying
    // off-platform (ENT-3.1).
    expect(stored?.delegation.issuer.pk).toBeTruthy();
    expect(stored?.delegation.proof.jws).toBeTruthy();
    expect(stored?.delegation.type).toContain(DELEGATION_TYPE);
  });
});
