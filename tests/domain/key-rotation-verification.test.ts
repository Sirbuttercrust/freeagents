// ENT-8.4 + MISSION.md invariant 2 (R-29): a credential signed by an agent
// key that has since been rotated must still verify off-platform. The
// rotation record is the link: a third party who holds the credential and
// the agent's public record (not a call to this service) can resolve the
// old key and verify the signature. Verification uses @digitalbazaar/*,
// never @arcblock/vc: that is what proves third-party verifiability.
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import * as vc from '@digitalbazaar/vc';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import { fromRandom, type WalletObject } from '@ocap/wallet';
import { describe, expect, it } from 'vitest';
import { MemoryAgentRepository } from '../../src/adapters/storage/memory.js';
import { DELEGATION_TYPE, type Delegation } from '../../src/domain/agent.js';

// Names that would mean key material leaked into storage. Matched by
// substring (same list as tests/api/agent-invariant2.test.ts).
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

// The operator-signed delegation credential used to REGISTER the agent
// (R-2 shape, the same recipe tests/api/agent-invariant2.test.ts uses).
async function signDelegation(operator: WalletObject, agent: WalletObject): Promise<Delegation> {
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
  return signed as unknown as Delegation;
}

// A credential signed by the agent's OWN key, with the agent DID as issuer:
// this is the rotation-era credential ENT-8.4 must keep verifiable. The
// proof names the signing key in DID fragment form, which is the fragment
// the rotation record's fromKey must match.
async function signWithAgentKey(
  agent: WalletObject,
  key: Ed25519VerificationKey2020,
  operatorDid: string,
): Promise<Record<string, unknown>> {
  const agentDid = agent.toDid();
  key.id = `${agentDid}#${key.publicKeyMultibase}`;

  const suite = new Ed25519Signature2020({ key });

  const credential = {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
      { '@vocab': 'https://freeagents.dev/terms#' },
    ],
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: ['VerifiableCredential', DELEGATION_TYPE],
    issuer: agentDid,
    issuanceDate: new Date().toISOString(),
    credentialSubject: { id: agentDid, delegatedBy: operatorDid },
  };

  const loader = securityLoader();
  loader.addStatic(key.id, {
    '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
    ...key.export({ publicKey: true }),
  });
  loader.addStatic(agentDid, {
    '@context': 'https://www.w3.org/ns/did/v1',
    id: agentDid,
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

// Verify with an independent verifier: given ONLY the credential, resolve
// the key from proof.verificationMethod and check the signature, including
// the binding check that the key belongs to the claimed issuer DID. No
// access to any private key, no call to this service.
async function verifyIndependent(credential: Record<string, unknown>): Promise<boolean> {
  try {
    const proof = credential.proof as Record<string, unknown>;
    const verificationMethod = String(proof.verificationMethod);
    const issuer = String(credential.issuer);

    const hashIndex = verificationMethod.indexOf('#');
    if (hashIndex === -1) return false;
    const fingerprint = verificationMethod.slice(hashIndex + 1);

    const key = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint });

    // BINDING CHECK: the key must actually belong to the claimed issuer DID,
    // exactly as the recipe in tests/api/agent-invariant2.test.ts does it.
    const { fromPublicKey } = await import('@arcblock/did');
    const keyWithBuffer = key as unknown as { _publicKeyBuffer: Uint8Array };
    const derivedDidSuffix = fromPublicKey(keyWithBuffer._publicKeyBuffer);
    const issuerSuffix = issuer.replace(/^did:abt:/, '');

    if (derivedDidSuffix !== issuerSuffix) {
      return false;
    }

    key.controller = issuer;
    key.id = verificationMethod;

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

describe('key rotation, invariant 2 (R-29, ENT-8.4): verifiability after rotation', () => {
  it('a credential signed by a rotated key still verifies off-platform, and the rotation record links it', async () => {
    const operator = fromRandom();
    const oldAgent = fromRandom();
    const newAgent = fromRandom();
    const oldDid = oldAgent.toDid();
    const newDid = newAgent.toDid();

    // The public halves of the old and new keys; the fragments are what a
    // rotation record stores.
    const oldKey = await Ed25519VerificationKey2020.generate({
      seed: hexToBytes(oldAgent.secretKey).slice(0, 32),
      controller: oldDid,
    });
    const oldKeyId = `${oldDid}#${oldKey.publicKeyMultibase}`;
    const newKey = await Ed25519VerificationKey2020.generate({
      seed: hexToBytes(newAgent.secretKey).slice(0, 32),
      controller: newDid,
    });
    const newKeyId = `${newDid}#${newKey.publicKeyMultibase}`;

    // Sanity: the fixture verifies at all, before any rotation exists.
    const credential = await signWithAgentKey(oldAgent, oldKey, operator.toDid());
    expect(await verifyIndependent(credential)).toBe(true);

    // Register the agent (operator-signed delegation, R-2), then record the
    // rotation: the old key is superseded by the new one.
    const repo = new MemoryAgentRepository();
    const delegation = await signDelegation(operator, oldAgent);
    await repo.create({
      did: oldDid,
      operatorDid: operator.toDid(),
      delegation,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const rotated = await repo.recordKeyRotation(oldDid, {
      fromKey: oldKeyId,
      toKey: newKeyId,
    });
    expect(rotated).not.toBeNull();

    // The link ENT-8.4 rests on: the rotation record names exactly the key
    // the credential's proof uses, so a stranger resolves the old key from
    // the record alone.
    const proof = credential.proof as Record<string, unknown>;
    expect(rotated?.keyRotations[0]?.fromKey).toBe(String(proof.verificationMethod));
    expect(rotated?.keyRotations[0]?.toKey).toBe(newKeyId);

    // Rotation did not orphan the history: a third party holding ONLY the
    // credential still verifies it.
    expect(await verifyIndependent(credential)).toBe(true);

    // Leak check: the stored agent, rotation record included, carries no
    // key material, only public identifiers.
    expect(findKeyMaterialFields(rotated)).toEqual([]);
  });
});
