// R-15 (ENT-8): the resolvable credential endpoint, as a contract. The
// credential is a linked-data document, so the endpoint must serve the
// stored bytes verbatim as application/ld+json, and a third party must be
// able to verify what the server sent with an off-the-shelf W3C verifier
// (invariant 2) using only the response and the issuer's key, nothing the
// platform fetches for us. The 404 and 503 branches are the same contract
// every other route on this surface follows.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { Express } from 'express';

import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import * as vc from '@digitalbazaar/vc';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createCredentialResolver, createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';
import { MemoryCredentialRepository } from '../../src/adapters/storage/memory.js';
import type { CredentialRepository } from '../../src/adapters/storage/types.js';

// Generic identifiers only (public repository): the issuer is the platform,
// not a person.
const ISSUER_DID = 'did:abt:platform';
const SUBJECT_DID = 'did:abt:agent-under-test';
const COMPLETED_JOB_ID = 'job-cred-1';
const CREDENTIAL_PATH = `/v1/credentials/${COMPLETED_JOB_ID}`;

let server: Server;
let baseUrl: string;
let keyId: string;
let key: Awaited<ReturnType<typeof Ed25519VerificationKey2020.generate>>;
let signed: VerifiableCredential;
const credentialRepo = new MemoryCredentialRepository();

function listen(app: Express): Promise<Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}

function portOf(srv: Server): number {
  return (srv.address() as AddressInfo).port;
}

beforeAll(async () => {
  const seed = new Uint8Array(randomBytes(32));
  key = await Ed25519VerificationKey2020.generate({ seed, controller: ISSUER_DID });
  keyId = `${ISSUER_DID}#${key.publicKeyMultibase}`;

  // The full adapter is used here (not the app's default resolver) because
  // it resolves from the same repository the app is handed, and it is the
  // factory R-13's issuance will produce once the issuer is wired in.
  const app = createApp(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    createCredentialsAdapter({ did: ISSUER_DID, seed }, credentialRepo),
  );
  server = await listen(app);
  baseUrl = `http://127.0.0.1:${portOf(server)}`;

  const credential = {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
      { '@vocab': 'https://freeagents.dev/terms#' },
    ],
    // ENT-8: the stable resolvable id is this server's own URL plus the
    // completed job id, so the endpoint resolves what it was handed.
    id: `${baseUrl}${CREDENTIAL_PATH}`,
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: ISSUER_DID,
    issuanceDate: new Date().toISOString(),
    credentialSubject: {
      id: SUBJECT_DID,
      jobId: COMPLETED_JOB_ID,
      pullRequestUrl: 'https://github.com/buyer/target-repo/pull/42',
      mergeCommitSha: '3f8a2c1d9e7b4a5f6c8d0e1f2a3b4c5d6e7f8a9b',
      mergedAt: '2026-08-21T12:00:00.000Z',
      diffAdditions: 12,
      diffDeletions: 4,
      specHash: 'sha256:spec',
      filesChanged: 1,
      repository: 'buyer/target-repo',
      signedBy: `${SUBJECT_DID}#${COMPLETED_JOB_ID}`,
      buyerDid: 'did:abt:buyer-under-test',
    },
  };

  // The issuer's key and DID document are registered statically, the same
  // way the adapter's issuance registers them: nothing in this test learns
  // the key from the platform's storage.
  const loader = securityLoader();
  loader.addStatic(keyId, {
    '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
    ...key.export({ publicKey: true }),
  });
  loader.addStatic(ISSUER_DID, {
    '@context': 'https://www.w3.org/ns/did/v1',
    id: ISSUER_DID,
    assertionMethod: [keyId],
    verificationMethod: [
      { '@context': 'https://w3id.org/security/suites/ed25519-2020/v1', ...key.export({ publicKey: true }) },
    ],
  });

  signed = (await vc.issue({
    credential,
    suite: new Ed25519Signature2020({ key }),
    documentLoader: loader.build(),
  })) as unknown as VerifiableCredential;

  await credentialRepo.save({
    completedJobId: COMPLETED_JOB_ID,
    subjectDid: SUBJECT_DID,
    document: signed,
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GET /v1/credentials/:credentialId', () => {
  it('serves the stored credential verbatim as application/ld+json, with no authentication', async () => {
    const res = await fetch(`${baseUrl}${CREDENTIAL_PATH}`);

    expect(res.status).toBe(200);
    // The credential is a linked-data document, not an API object: a JSON
    // content type here would be a contract change for linked-data clients.
    expect(String(res.headers.get('content-type')).startsWith('application/ld+json')).toBe(true);

    // Verbatim: the exact stored document, no projection and no
    // re-serialization that would change the proof's covered data.
    expect(await res.json()).toEqual(signed);
  });

  it('returns 404 for a credential id no credential carries', async () => {
    const res = await fetch(`${baseUrl}/v1/credentials/never-issued`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('returns 503 when storage is unavailable', async () => {
    // A repository whose queries fail: the route must fail closed with 503,
    // the same branch every other route on this surface takes on a dead
    // database (invariant 9).
    const failing: CredentialRepository = {
      save: () => {
        throw new Error('storage down');
      },
      findByDocumentId: () => {
        throw new Error('storage down');
      },
    };
    const app = createApp(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createCredentialResolver(failing),
    );
    const srv = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${portOf(srv)}${CREDENTIAL_PATH}`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'storage unavailable' });
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});

describe('invariant 2, at the wire boundary', () => {
  it('verifies the bytes the server sent with an off-the-shelf W3C verifier, without calling this service', async () => {
    // A stranger's whole input is the HTTP response plus the issuer's
    // publicly registered key. No call into the platform, no adapter, no
    // storage: vc.verifyCredential on the fetched bytes must hold.
    const res = await fetch(`${baseUrl}${CREDENTIAL_PATH}`);
    const fetched = (await res.json()) as VerifiableCredential;

    const loader = securityLoader();
    loader.addStatic(keyId, {
      '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
      ...key.export({ publicKey: true }),
    });
    loader.addStatic(ISSUER_DID, {
      '@context': 'https://www.w3.org/ns/did/v1',
      id: ISSUER_DID,
      assertionMethod: [keyId],
      verificationMethod: [
        { '@context': 'https://w3id.org/security/suites/ed25519-2020/v1', ...key.export({ publicKey: true }) },
      ],
    });

    const verified = await vc.verifyCredential({
      credential: fetched,
      suite: new Ed25519Signature2020(),
      documentLoader: loader.build(),
    });

    expect(verified.verified).toBe(true);
  });
});
