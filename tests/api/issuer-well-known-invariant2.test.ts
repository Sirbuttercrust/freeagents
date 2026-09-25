// ISS1 (bugs.md B30): the invariant-2 test CLAUDE.md requires for anything
// touching credentials, one level up from the existing per-credential
// invariant-2 tests. A stranger holding ONLY a credential the app actually
// issued, plus the /.well-known/freeagents-issuer.json response the same
// app publishes, verifies the credential with an off-the-shelf W3C stack
// and confirms the issuer matches the published DID -- no app code, no
// adapter, no import of anything under src/adapters/credentials or
// src/adapters/identity. This is the exact shape a real third party's
// verifier takes: fetch the credential, fetch the well-known file, check
// the two agree, check the signature.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

import { fromPublicKey } from '@arcblock/did';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import * as vc from '@digitalbazaar/vc';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import { MemoryCredentialRepository } from '../../src/adapters/storage/memory.js';

function listen(app: Express): Promise<Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
}

function portOf(srv: Server): number {
  return (srv.address() as AddressInfo).port;
}

// The did:abt check every independent verifier must run: derive the DID
// from the public key named in verificationMethod's fragment, and require
// it to equal the claimed issuer. Rebuilt inline (not imported from
// src/adapters/identity/did-abt-resolver.ts) because this file's whole
// point is that a stranger with no access to this codebase can still do
// this, using only @arcblock/did and the wire bytes.
async function didAbtFromVerificationMethod(verificationMethod: string): Promise<string | null> {
  const hashIndex = verificationMethod.indexOf('#');
  if (hashIndex === -1) return null;
  const fingerprint = verificationMethod.slice(hashIndex + 1);
  try {
    // Only used to decode the multibase fingerprint into raw key bytes;
    // no signing, no private material anywhere in this path.
    const key = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint });
    const raw = (key as unknown as { _publicKeyBuffer: Uint8Array })._publicKeyBuffer;
    return `did:abt:${fromPublicKey(raw)}`;
  } catch {
    return null;
  }
}

async function verifyIndependent(
  credential: Record<string, unknown>,
  requiredIssuer?: string,
): Promise<boolean> {
  try {
    const proof = credential.proof as Record<string, unknown> | undefined;
    if (proof === undefined) return false;
    const verificationMethod = String(proof.verificationMethod);
    const issuer = String(credential.issuer);

    if (requiredIssuer !== undefined && issuer !== requiredIssuer) return false;

    // The did:abt binding check: the key named in verificationMethod must
    // actually derive the claimed issuer DID, or a spliced
    // verificationMethod (<victim-did>#<attacker-fragment>) would verify
    // against an attacker's own key while claiming the victim's DID.
    const derivedDid = await didAbtFromVerificationMethod(verificationMethod);
    if (derivedDid === null || derivedDid !== issuer) return false;

    const fingerprint = verificationMethod.slice(verificationMethod.indexOf('#') + 1);
    const key = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint });
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

describe('independent verifier: a real credential, checked against the published well-known issuer', () => {
  let server: Server;
  let baseUrl: string;
  let credential: Record<string, unknown>;
  let wellKnownIssuer: string;
  let wellKnownVerificationMethod: string;
  const credentialRepo = new MemoryCredentialRepository();

  beforeAll(async () => {
    const credentials = createCredentialsAdapter(undefined, credentialRepo);
    const app = createApp(undefined, undefined, undefined, undefined, undefined, credentials);
    server = await listen(app);
    baseUrl = `http://127.0.0.1:${portOf(server)}`;

    // Issue a real credential through the app's own signing adapter, the
    // same one the merge route uses -- not hand-assembled.
    const issued = await credentials.issueWorkHistoryCredential('did:abt:agent-under-test', {
      jobId: 'job-iss1-independent-verifier',
      pullRequestUrl: 'https://github.com/buyer/target-repo/pull/9',
      mergeCommitSha: '3f8a2c1d9e7b4a5f6c8d0e1f2a3b4c5d6e7f8a9b',
      mergedAt: '2026-01-03T00:00:00.000Z',
      diffAdditions: 5,
      diffDeletions: 1,
      diffFiles: 2,
      briefHash: 'sha256:brief',
      specHash: 'sha256:spec',
      repository: 'buyer/target-repo',
      signedBy: 'did:abt:agent-under-test#job-iss1-independent-verifier',
      buyerDid: 'did:example:buyer',
    });
    credential = issued as unknown as Record<string, unknown>;

    const wellKnownRes = await fetch(`${baseUrl}/.well-known/freeagents-issuer.json`);
    const wellKnown = (await wellKnownRes.json()) as {
      issuer: string;
      verificationMethod: string;
      publicKeyMultibase: string;
    };
    wellKnownIssuer = wellKnown.issuer;
    wellKnownVerificationMethod = wellKnown.verificationMethod;
  });

  afterAll(() => {
    server.close();
  });

  it('the credential issuer equals what /.well-known/freeagents-issuer.json publishes', () => {
    expect(credential.issuer).toBe(wellKnownIssuer);
  });

  it('the credential proof.verificationMethod equals the published verificationMethod', () => {
    const proof = credential.proof as Record<string, unknown>;
    expect(proof.verificationMethod).toBe(wellKnownVerificationMethod);
  });

  it('a stranger holding only the credential JSON verifies it, using only the did:abt check plus an off-the-shelf W3C verifier', async () => {
    const strangerCopy = JSON.parse(JSON.stringify(credential));
    expect(await verifyIndependent(strangerCopy)).toBe(true);
    // The stronger form: also required to match the published well-known
    // issuer, exactly as a verifier who fetched both would check.
    expect(await verifyIndependent(strangerCopy, wellKnownIssuer)).toBe(true);
  });

  it('NEGATIVE CONTROL: the same credential re-signed by a different key under the original issuer string FAILS', async () => {
    const attackerSeed = new Uint8Array(32).fill(77);
    const attackerKey = await Ed25519VerificationKey2020.generate({
      seed: attackerSeed,
      controller: String(credential.issuer),
    });
    // The splice: the attacker's own fingerprint, under the victim's DID.
    attackerKey.id = `${String(credential.issuer)}#${attackerKey.publicKeyMultibase}`;

    const bareCredential = { ...credential };
    delete (bareCredential as Record<string, unknown>).proof;

    const loader = securityLoader();
    loader.addStatic(attackerKey.id, {
      '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
      ...attackerKey.export({ publicKey: true }),
    });
    loader.addStatic(String(credential.issuer), {
      '@context': 'https://www.w3.org/ns/did/v1',
      id: String(credential.issuer),
      assertionMethod: [attackerKey.id],
      verificationMethod: [
        { '@context': 'https://w3id.org/security/suites/ed25519-2020/v1', ...attackerKey.export({ publicKey: true }) },
      ],
    });

    const forged = await vc.issue({
      credential: bareCredential,
      suite: new Ed25519Signature2020({ key: attackerKey }),
      documentLoader: loader.build(),
    });

    expect(await verifyIndependent(forged as unknown as Record<string, unknown>)).toBe(false);
    expect(await verifyIndependent(forged as unknown as Record<string, unknown>, wellKnownIssuer)).toBe(false);
  });

  it('NEGATIVE CONTROL: issuer edited to another DID FAILS', async () => {
    const tampered = JSON.parse(JSON.stringify(credential));
    tampered.issuer = 'did:abt:zSomeUnrelatedDid';
    expect(await verifyIndependent(tampered)).toBe(false);
    expect(await verifyIndependent(tampered, wellKnownIssuer)).toBe(false);
  });

  it('NEGATIVE CONTROL: a verificationMethod whose fragment is some other key FAILS', async () => {
    const tampered = JSON.parse(JSON.stringify(credential));
    const otherKey = await Ed25519VerificationKey2020.generate({
      seed: new Uint8Array(32).fill(88),
      controller: String(credential.issuer),
    });
    (tampered.proof as Record<string, unknown>).verificationMethod =
      `${String(credential.issuer)}#${otherKey.publicKeyMultibase}`;
    expect(await verifyIndependent(tampered)).toBe(false);
  });
});
