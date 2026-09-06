// Invariant 2 (MISSION.md) for the deemed-completion credential (P6,
// design record 2026-09-01, row 3): a third party verifies the platform
// signature with an off-the-shelf W3C verifier and the DID, without
// calling this service. Reuses the exact Ed25519Signature2020 proof
// construction and platform key issueDeemedCompletionCredential's own
// header comment names -- never a second signing path.
import { fromPublicKey } from '@arcblock/did';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import * as vc from '@digitalbazaar/vc';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCredentialsAdapter } from '../../../src/adapters/credentials/credentials.js';
import { isCompletedHireCredential, type DeemedCompletionCredential } from '../../../src/adapters/credentials/types.js';

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

describe('platform signature over a deemed-completion credential, invariant 2', () => {
  let signed: DeemedCompletionCredential;
  let issuerDid: string;

  beforeAll(async () => {
    const issuerSeed = newSeed();
    const issuerKey = await generateKey(issuerSeed);
    issuerDid = issuerKey.controller;

    const adapter = createCredentialsAdapter({ did: issuerDid, seed: issuerSeed });
    signed = await adapter.issueDeemedCompletionCredential('did:example:agent', {
      jobId: 'job-deemed-inv2',
      stagedCommit: 'commit-sha-deemed-inv2',
      buyerDid: 'did:example:buyer',
    });
  });

  it('a stranger holding only the JSON verifies it off-platform', async () => {
    const strangerCopy = JSON.parse(JSON.stringify(signed));
    expect(await verifyIndependent(strangerCopy)).toBe(true);
  });

  it('uses the registered Ed25519Signature2020 proof, never the jws regression', () => {
    const proof = signed.proof;
    expect(proof.type).toBe('Ed25519Signature2020');
    expect(typeof proof.proofValue).toBe('string');
    expect(proof.jws).toBeUndefined();
  });

  it('a tampered fact FAILS the independent verifier', async () => {
    const tampered = JSON.parse(JSON.stringify(signed));
    tampered.credentialSubject.deemedCompletion.noMerge = false;
    expect(await verifyIndependent(tampered)).toBe(false);
  });

  it('carries type DeemedCompletionCredential and is distinguishable from a completed hire credential', () => {
    expect(signed.type).toContain('DeemedCompletionCredential');
    expect(signed.type).not.toContain('CompletedHireCredential');
    expect(isCompletedHireCredential(signed)).toBe(false);
    expect(signed.credentialSubject.deemedCompletion.noMerge).toBe(true);
  });
});
