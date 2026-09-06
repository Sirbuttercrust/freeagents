// Invariant 2 (MISSION.md) for the attestation's platform signature (P5,
// design record 2026-09-01): a third party verifies the signature with an
// off-the-shelf W3C verifier and the DID, without calling this service.
// Reuses the exact Ed25519Signature2020 proof construction and the
// existing platform key (credentials.ts), never a second signing path.
//
// This also pins the refused list negatively at the wire boundary: the
// signed document must never carry the diff, source, symbol names, test
// bodies, commit messages or raw output lines, even when the fixture that
// produced the attestation carries distinctive sentinel strings nearby
// (in the job/observation inputs), because the Attestation type itself
// has nowhere to put them.
import { fromPublicKey } from '@arcblock/did';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import * as vc from '@digitalbazaar/vc';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCredentialsAdapter } from '../../../src/adapters/credentials/credentials.js';
import { buildAttestation, type Attestation } from '../../../src/domain/attestation.js';
import { createJob, stageWork, type Job } from '../../../src/domain/job.js';

function newSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

function didFromKey(key: Ed25519VerificationKey2020): string {
  const keyWithBuffer = key as unknown as { _publicKeyBuffer: Uint8Array };
  return `did:abt:${fromPublicKey(keyWithBuffer._publicKeyBuffer)}`;
}

async function generateKey(seed: Uint8Array): Promise<Ed25519VerificationKey2020> {
  const key = await Ed25519VerificationKey2020.generate({ seed, controller: 'did:abt:pending' });
  key.controller = didFromKey(key);
  return key;
}

async function verifyIndependent(credential: Record<string, unknown>): Promise<boolean> {
  try {
    const proof = credential.proof as Record<string, unknown>;
    const verificationMethod = String(proof.verificationMethod);
    const issuer = String(credential.issuer);
    const fingerprint = verificationMethod.slice(verificationMethod.indexOf('#') + 1);
    const key = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint });
    const keyWithBuffer = key as unknown as { _publicKeyBuffer: Uint8Array };
    if (fromPublicKey(keyWithBuffer._publicKeyBuffer) !== issuer.replace(/^did:abt:/, '')) {
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
        { '@context': 'https://w3id.org/security/suites/ed25519-2020/v1', ...key.export({ publicKey: true }) },
      ],
    });
    const documentLoader = loader.build();

    const result = await vc.verifyCredential({
      credential,
      suite: new Ed25519Signature2020(),
      documentLoader,
    });
    return result.verified === true;
  } catch {
    return false;
  }
}

describe('platform signature over an attestation, invariant 2', () => {
  let signed: Record<string, unknown>;
  let attestation: Attestation;
  let issuerDid: string;

  beforeAll(async () => {
    const issuerSeed = newSeed();
    const issuerKey = await generateKey(issuerSeed);
    issuerDid = issuerKey.controller;

    // A sentinel-laden job/observation, to prove the refused list never
    // reaches the wire even when a caller's inputs are packed with it.
    const now = new Date('2026-01-06T00:00:00Z');
    const draft = createJob(
      {
        id: 'job-att-inv2',
        buyerDid: 'did:abt:zBuyerForAttestationInvariantTwo',
        agentDid: 'did:abt:zAgentForAttestationInvariantTwo',
        repository: 'buyer/SENTINEL-REPO-not-a-real-field',
        brief: 'SENTINEL_BRIEF_never on the wire',
      },
      now,
    );
    const confirmed: Job = {
      ...draft,
      status: 'confirmed',
      confirmedSpecHash: 'sha256:spec',
      confirmedAt: now,
      priceUsd: '500.00',
      rail: 'abt',
      priceAcceptedByBuyer: true,
      priceAcceptedByAgent: true,
      criteria: [{ text: 'SENTINEL_CRITERION_never on the wire', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
    };
    const job = stageWork(confirmed, 'commit-sha-attestation-invariant2', now);

    attestation = buildAttestation(
      job,
      {
        diffHash: 'sha256:diffhash',
        filesChanged: 2,
        linesAdded: 30,
        linesRemoved: 5,
        changedPaths: ['src/real-path-b.ts', 'src/real-path-a.ts'],
        lineShareByCategory: { source: 0.8, test: 0.15, lockfile: 0.03, generated: 0.01, vendored: 0.01 },
        testsDeleted: [],
        testsSkipAdded: [],
        buyerTestRun: {
          command: 'npm test',
          exitCode: 1,
          passCount: 20,
          failCount: 1,
          skipCount: 0,
          failingTestNames: ['checkout flow works'],
        },
        outOfCriteriaPathCount: 1,
        commitSigners: [{ matchesAgentDid: true }],
      },
      now,
    );

    const issued = await createCredentialsAdapter({ did: issuerDid, seed: issuerSeed }).signAttestation(attestation);
    signed = issued as unknown as Record<string, unknown>;
  });

  it('a stranger holding only the JSON verifies it off-platform', async () => {
    const strangerCopy = JSON.parse(JSON.stringify(signed));
    expect(await verifyIndependent(strangerCopy)).toBe(true);
  });

  it('uses the registered Ed25519Signature2020 proof, never the jws regression', async () => {
    const proof = signed.proof as Record<string, unknown>;
    expect(proof.type).toBe('Ed25519Signature2020');
    expect(typeof proof.proofValue).toBe('string');
    expect(proof.jws).toBeUndefined();
  });

  it('a tampered fact FAILS the independent verifier', async () => {
    const tampered = JSON.parse(JSON.stringify(signed));
    const subject = tampered.credentialSubject as Record<string, unknown>;
    const wireAttestation = subject.attestation as Record<string, unknown>;
    wireAttestation.linesAdded = 999999;
    expect(await verifyIndependent(tampered)).toBe(false);
  });

  it('carries the accepted fields', async () => {
    const subject = signed.credentialSubject as Record<string, unknown>;
    const wireAttestation = subject.attestation as Record<string, unknown>;
    expect(wireAttestation.stagedCommit).toBe(attestation.stagedCommit);
    expect(wireAttestation.diffHash).toBe(attestation.diffHash);
    expect(wireAttestation.outOfCriteriaPathCount).toBe(1);
  });

  it('the refused list never reaches the signed wire bytes, even with sentinel-laden inputs', () => {
    const wire = JSON.stringify(signed);
    const sentinels = [
      'SENTINEL-REPO-not-a-real-field',
      'SENTINEL_BRIEF_never on the wire',
      'SENTINEL_CRITERION_never on the wire',
    ];
    for (const sentinel of sentinels) {
      expect(wire).not.toContain(sentinel);
    }
  });

  it('FORGERY: an attacker key claiming the platform DID is rejected by the binding check', async () => {
    const attackerKey = await Ed25519VerificationKey2020.generate({ seed: newSeed(), controller: issuerDid });
    attackerKey.id = `${issuerDid}#${attackerKey.publicKeyMultibase}`;

    const forgedCredential = {
      '@context': [
        'https://www.w3.org/ns/credentials/v2',
        'https://w3id.org/security/suites/ed25519-2020/v1',
        { '@vocab': 'https://freeagents.dev/terms#' },
      ],
      id: `urn:uuid:${crypto.randomUUID()}`,
      type: ['VerifiableCredential', 'JobAttestation'],
      issuer: issuerDid,
      validFrom: new Date().toISOString(),
      credentialSubject: { id: `urn:freeagents:staged-commit:${attestation.stagedCommit}`, attestation },
    };

    const loader = securityLoader();
    loader.addStatic(attackerKey.id, {
      '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
      ...attackerKey.export({ publicKey: true }),
    });
    loader.addStatic(issuerDid, {
      '@context': 'https://www.w3.org/ns/did/v1',
      id: issuerDid,
      assertionMethod: [attackerKey.id],
      verificationMethod: [
        { '@context': 'https://w3id.org/security/suites/ed25519-2020/v1', ...attackerKey.export({ publicKey: true }) },
      ],
    });
    const documentLoader = loader.build();

    const forged = await vc.issue({
      credential: forgedCredential,
      suite: new Ed25519Signature2020({ key: attackerKey }),
      documentLoader,
    });
    expect(await verifyIndependent(forged as unknown as Record<string, unknown>)).toBe(false);
  });
});
