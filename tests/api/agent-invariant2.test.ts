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
import { renderAvatar } from '../../src/api/avatar.js';
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
// a third party does: given ONLY the credential itself, resolve the key from
// the credential's proof.verificationMethod (exactly as did-abt-resolver.ts
// does), and verify the signature. No access to the operator's private key.
async function verifyIndependent(credential: Record<string, unknown>): Promise<boolean> {
  try {
    const proof = credential.proof as Record<string, unknown>;
    const verificationMethod = String(proof.verificationMethod);
    const issuer = String(credential.issuer);

    // Extract the fingerprint from verificationMethod (e.g., did:abt:z1...#z6Mk...)
    const hashIndex = verificationMethod.indexOf('#');
    if (hashIndex === -1) return false;
    const fingerprint = verificationMethod.slice(hashIndex + 1);

    // Reconstruct the key from the fingerprint alone, exactly as a stranger would.
    const key = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint });

    // BINDING CHECK: verify the key actually belongs to the claimed issuer DID.
    // This is what prevents forgery: an attacker can sign with their own key
    // and write <victim-did>#<attacker-fingerprint> into verificationMethod,
    // but the derived DID from the attacker's key will not match the victim's DID.
    const { fromPublicKey } = await import('@arcblock/did');
    const keyWithBuffer = key as unknown as { _publicKeyBuffer: Uint8Array };
    const derivedDidSuffix = fromPublicKey(keyWithBuffer._publicKeyBuffer);
    const issuerSuffix = issuer.replace(/^did:abt:/, '');

    if (derivedDidSuffix !== issuerSuffix) {
      return false; // key does not belong to claimed issuer
    }

    key.controller = issuer;
    key.id = verificationMethod;

    // Build the document loader with only the reconstructed key.
    const loader = securityLoader();
    loader.addStatic(key.id, {
      '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
      ...key.export({ publicKey: true }),
    });
    loader.addStatic(issuer, {
      '@context': 'https://www.w3.org/ns/did/v1',
      id: issuer,
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
    // to this service, and with NO ACCESS to the operator's private key.
    // This is the test that proves invariant 2.
    const stored = await agentRepo.findByDid(agent.toDid());
    expect(stored).not.toBeNull();
    const strangerCopy = JSON.parse(JSON.stringify(stored?.delegation));
    const ok = await verifyIndependent(strangerCopy);
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
      // R-21: the avatar joined the contract, derived from the DID at
      // projection time. This expectation is the pinned key set being
      // updated as part of the contract change, not a test bent to pass -
      // the new key is asserted against the same derivation the route uses.
      avatar: renderAvatar(String(stored?.did)),
    });

    // A stranger fetching from the public API can verify with no further
    // call to this service. This is the real third-party scenario.
    const wireCopy = JSON.parse(JSON.stringify(body.delegation));
    const ok = await verifyIndependent(wireCopy);
    expect(ok).toBe(true);
  });

  it('a tampered credential FAILS the independent verifier', async () => {
    const stored = await agentRepo.findByDid(agent.toDid());
    expect(stored).not.toBeNull();
    const tampered = JSON.parse(JSON.stringify(stored?.delegation));

    // Change the subject: the signature no longer covers this document.
    tampered.credentialSubject.id = 'did:abt:zTamperedAgent';

    const ok = await verifyIndependent(tampered);
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

  it('issuer field mismatch (plain string, caught pre-crypto) is rejected with 400', async () => {
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

  it('FORGERY: a credential claiming victim DID, signed by attacker key, is rejected', async () => {
    // The attacker controls their own wallet, never registered.
    const attacker = fromRandom();
    const forgedAgent = fromRandom();

    // The attacker derives a key from THEIR OWN wallet seed.
    const attackerSeed = hexToBytes(attacker.secretKey).slice(0, 32);
    const attackerKey = await Ed25519VerificationKey2020.generate({
      seed: attackerSeed,
      controller: operator.toDid(), // LIE: claim controller is the victim
    });
    // THE SPLICE: prefix the key id with the VICTIM's DID, but the fragment
    // is the attacker's own key fingerprint.
    attackerKey.id = `${operator.toDid()}#${attackerKey.publicKeyMultibase}`;

    const forgedCredential = {
      '@context': [
        'https://www.w3.org/2018/credentials/v1',
        'https://w3id.org/security/suites/ed25519-2020/v1',
        { '@vocab': 'https://freeagents.dev/terms#' },
      ],
      id: `urn:uuid:${crypto.randomUUID()}`,
      type: ['VerifiableCredential', DELEGATION_TYPE],
      issuer: operator.toDid(), // claims the VICTIM issued this
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: forgedAgent.toDid(), delegatedBy: operator.toDid() },
    };

    // The attacker signs with THEIR OWN private key.
    const suite = new Ed25519Signature2020({ key: attackerKey });
    const signLoader = securityLoader();
    signLoader.addStatic(attackerKey.id, {
      '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
      ...attackerKey.export({ publicKey: true }),
    });
    signLoader.addStatic(operator.toDid(), {
      '@context': 'https://www.w3.org/ns/did/v1',
      id: operator.toDid(),
      assertionMethod: [attackerKey.id],
      verificationMethod: [
        {
          '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
          ...attackerKey.export({ publicKey: true }),
        },
      ],
    });
    const signDocumentLoader = signLoader.build();

    const forged = await vc.issue({
      credential: forgedCredential,
      suite,
      documentLoader: signDocumentLoader,
    });

    // POST this forged delegation to the service.
    const res = await postJson(baseUrl, '/agents', {
      did: forgedAgent.toDid(),
      operator: operator.toDid(),
      delegation: forged,
      name: 'totally-legit',
      skills: ['triage'],
    });

    // The service MUST reject this with 400 (not 201).
    expect(res.status).toBe(400);

    // An independent verifier resolving the key from the credential alone
    // (exactly as did-abt-resolver.ts does) MUST also reject it.
    // The signature WILL verify against the attacker's key, but the binding
    // check (key does not belong to claimed issuer) MUST fail.
    const ok = await verifyIndependent(forged);
    expect(ok).toBe(false);
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
