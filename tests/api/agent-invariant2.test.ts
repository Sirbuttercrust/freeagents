// Invariant 2 (MISSION.md): a third party can verify what this service
// stores without calling it. The delegation credential must be a W3C
// Verifiable Credential with Ed25519Signature2020 proof that any
// off-the-shelf verifier can check, with no call to this service and no
// custom code. This test MUST use @digitalbazaar/* for verification, never
// @arcblock/vc, because that is what proves third-party verifiability.
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import * as vc from '@digitalbazaar/vc';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import { fromRandom, type WalletObject } from '@ocap/wallet';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryOperatorRepository } from '../../src/adapters/storage/memory.js';
import { DELEGATION_TYPE } from '../../src/domain/agent.js';

// Names that would mean key material leaked into storage. Matched by
// substring. The delegation's own public keys in the proof metadata are the
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

// The ArcBlock wallet's secretKey is seed(32)||public(32) in hex.
function hexToBytes(h: string): Uint8Array {
  return Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
}

// Sign a W3C delegation credential using the operator's ArcBlock wallet key
// wrapped in Ed25519Signature2020 suite. This is what an operator would
// produce using a compliant client.
async function signW3CDelegation(operator: WalletObject, agent: WalletObject): Promise<Record<string, unknown>> {
  const operatorDid = operator.toDid();
  const agentDid = agent.toDid();

  const seed = hexToBytes(operator.secretKey).slice(0, 32);
  const key = await Ed25519VerificationKey2020.generate({ seed, controller: operatorDid });
  key.id = `${operatorDid}#${key.publicKeyMultibase}`;

  const suite = new Ed25519Signature2020({ key });

  const credential = {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
      { '@vocab': 'https://freeagents.dev/terms#' },
    ],
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: ['VerifiableCredential', DELEGATION_TYPE],
    issuer: operatorDid,
    issuanceDate: new Date().toISOString(),
    credentialSubject: { id: agentDid, delegatedBy: operatorDid },
  };

  const loader = securityLoader();
  loader.addStatic(key.id, {
    '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
    ...key.export({ publicKey: true }),
  });
  loader.addStatic(operatorDid, {
    '@context': 'https://www.w3.org/ns/did/v1',
    id: operatorDid,
    assertionMethod: [key.id],
    verificationMethod: [
      {
        '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
        ...key.export({ publicKey: true }),
      },
    ],
  });
  const documentLoader = loader.build();

  const signed = await vc.issue({ credential, suite, documentLoader });
  return signed;
}

// Verify a W3C credential using an independent verifier. This simulates what
// a third party does: given the credential and a did:abt resolver (which
// reconstructs the DID document from the DID itself, no call to our service),
// verify the signature. The operator wallet is used here to simulate a
// did:abt resolver that can derive the public key from the DID.
async function verifyIndependent(credential: Record<string, unknown>, operator: WalletObject): Promise<boolean> {
  try {
    const operatorDid = operator.toDid();
    const seed = hexToBytes(operator.secretKey).slice(0, 32);
    const key = await Ed25519VerificationKey2020.generate({ seed, controller: operatorDid });
    key.id = `${operatorDid}#${key.publicKeyMultibase}`;

    // A third party with a did:abt resolver would build this document loader
    // by extracting the public key from the DID itself (did:abt encodes it).
    const loader = securityLoader();
    loader.addStatic(key.id, {
      '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
      ...key.export({ publicKey: true }),
    });
    loader.addStatic(operatorDid, {
      '@context': 'https://www.w3.org/ns/did/v1',
      id: operatorDid,
      assertionMethod: [key.id],
      verificationMethod: [
        {
          '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
          ...key.export({ publicKey: true }),
        },
      ],
    });
    const documentLoader = loader.build();

    const suite = new Ed25519Signature2020();
    const result = await vc.verifyCredential({
      credential,
      suite,
      documentLoader,
    });
    return result.verified === true;
  } catch {
    return false;
  }
}

async function postJson(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('agent delegation, invariant 2 (R-2): W3C verifiability', () => {
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
    const reg = await postJson(baseUrl, '/operators', { did: operator.toDid(), githubLogin: 'operator-inv2' });
    expect(reg.status).toBe(201);
  });

  afterAll(() => {
    server.close();
  });

  it('stores a W3C credential that verifies with @digitalbazaar/vc, no call to this service', async () => {
    const credential = await signW3CDelegation(operator, agent);
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

    // Third-party verification: the stored credential, JSON-round-tripped,
    // verifies with @digitalbazaar/vc (not @arcblock/vc), with no HTTP call
    // to this service. This is the test that proves invariant 2. The operator
    // wallet here simulates a did:abt resolver that a third party would use.
    const stored = await agentRepo.findByDid(agent.toDid());
    expect(stored).not.toBeNull();
    const strangerCopy = JSON.parse(JSON.stringify(stored?.delegation));
    const ok = await verifyIndependent(strangerCopy, operator);
    expect(ok).toBe(true);
  });

  it('the credential uses Ed25519Signature2020 proof with proofValue', async () => {
    const stored = await agentRepo.findByDid(agent.toDid());
    expect(stored).not.toBeNull();
    if (!stored) return;
    const delegation = stored.delegation;
    const proof = delegation.proof;

    // MISSION.md:180 explicitly requires Ed25519Signature2020, not a
    // vendor-specific type like Ed25519Signature.
    expect(proof.type).toBe('Ed25519Signature2020');

    // The W3C suite requires proofValue. The ArcBlock suite had jws instead,
    // which no standard verifier recognizes.
    expect(typeof proof.proofValue).toBe('string');
    expect(proof.proofValue).toBeTruthy();
  });

  it('read-back serves the same credential, and it still verifies', async () => {
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

    // A stranger fetching from the public API can verify with no further
    // call to this service. This is the real third-party scenario.
    const wireCopy = JSON.parse(JSON.stringify(body.delegation));
    const ok = await verifyIndependent(wireCopy, operator);
    expect(ok).toBe(true);
  });

  it('a tampered credential FAILS the independent verifier', async () => {
    const stored = await agentRepo.findByDid(agent.toDid());
    expect(stored).not.toBeNull();
    const tampered = JSON.parse(JSON.stringify(stored?.delegation));

    // Change the subject: the signature no longer covers this document.
    tampered.credentialSubject.id = 'did:abt:zTamperedAgent';

    const ok = await verifyIndependent(tampered, operator);
    expect(ok).toBe(false);
  });

  it('a credential whose proof was tampered is rejected on POST', async () => {
    const intruderAgent = fromRandom();
    const credential = await signW3CDelegation(operator, intruderAgent);

    // Break the proofValue after signing: shape stays intact but signature fails.
    const broken = JSON.parse(JSON.stringify(credential));
    const proof = broken.proof as Record<string, unknown>;
    broken.proof = { ...proof, proofValue: 'zTamperedProofValue' };

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
    const credential = await signW3CDelegation(stranger, otherAgent);
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
    const credential = await signW3CDelegation(stranger, otherAgent);
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
    const credential = await signW3CDelegation(operator, agent);
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

    // The stored delegation is the full W3C credential: drop the proofValue
    // and it stops verifying off-platform (ENT-3.1).
    if (!stored) return;
    const delegation = stored.delegation;
    const proof = delegation.proof;
    expect(proof.proofValue).toBeTruthy();
    expect(delegation.type).toContain(DELEGATION_TYPE);
    expect(proof.type).toBe('Ed25519Signature2020');
  });
});
