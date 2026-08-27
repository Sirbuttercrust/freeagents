// MISSION Gate 2: any change touching identity, credentials, or the hire
// loop must leave invariant 2 intact -- a third party can still confirm
// every verified claim without calling our service. This change (R-16)
// touches both, so this is its own mandatory test, matching the repo
// convention (tests/adapters/credentials/work-history-invariant2.test.ts).
// The credential is issued through the production path
// (createCredentialsAdapter().issueWorkHistoryCredential) and verified with
// the off-the-shelf @digitalbazaar/vc stack, never this service's own code.
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import * as vc from '@digitalbazaar/vc';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import {
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryOperatorRepository,
} from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { VerifiableCredential, WorkHistoryClaim } from '../../src/adapters/credentials/types.js';

const ISSUER_DID = 'did:abt:zPlatformInvariant2';
const AGENT_DID = 'did:abt:zAgentInvariant2';
const COMPLETED_JOB_ID = 'job-invariant2-1';
const SIGNED_BY = `${AGENT_DID}#zSigningKeyInvariant2`;
const MERGED_AT = '2026-08-05T00:00:00.000Z';

const delegation: Delegation = {
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  id: 'urn:uuid:key-compromise-invariant2-test',
  type: ['VerifiableCredential', 'AgentDelegation'],
  issuer: 'did:abt:zOperatorKeyHash',
  issuanceDate: '2026-08-21T05:00:00.000Z',
  credentialSubject: { id: AGENT_DID },
  proof: {
    type: 'Ed25519Signature2020',
    created: '2026-08-21T05:00:00.000Z',
    verificationMethod: 'did:abt:zOperatorKeyHash#zOperatorKeyHash',
    proofPurpose: 'assertionMethod',
    proofValue: 'zMockProofValue',
  },
};

async function postJson(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// A stranger's whole input: the issuer's publicly registered key plus the
// credential bytes. No access to the issuer's seed, no call to this service.
function buildDocumentLoader(key: Ed25519VerificationKey2020, keyId: string, issuerDid: string): ReturnType<ReturnType<typeof securityLoader>['build']> {
  const loader = securityLoader();
  loader.addStatic(keyId, {
    '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
    ...key.export({ publicKey: true }),
  });
  loader.addStatic(issuerDid, {
    '@context': 'https://www.w3.org/ns/did/v1',
    id: issuerDid,
    assertionMethod: [keyId],
    verificationMethod: [
      { '@context': 'https://w3id.org/security/suites/ed25519-2020/v1', ...key.export({ publicKey: true }) },
    ],
  });
  return loader.build();
}

function walkForForbiddenKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkForForbiddenKeys(item, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      expect(key.toLowerCase(), `forbidden key at ${path}.${key}`).not.toMatch(/disputed|dispute|compromise/);
      walkForForbiddenKeys(child, `${path}.${key}`);
    }
  }
}

describe('key compromise, invariant 2 (MISSION Gate 2)', () => {
  let server: Server;
  let baseUrl: string;
  let issuerKey: Ed25519VerificationKey2020;
  let keyId: string;
  let snapshot: VerifiableCredential;
  const credentialRepo = new MemoryCredentialRepository();
  const agentRepo = new MemoryAgentRepository();

  beforeAll(async () => {
    const seed = new Uint8Array(randomBytes(32));
    issuerKey = await Ed25519VerificationKey2020.generate({ seed, controller: ISSUER_DID });
    keyId = `${ISSUER_DID}#${issuerKey.publicKeyMultibase}`;

    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:zOperatorKeyHash',
      delegation,
      name: 'invariant2-scout',
      skills: [],
      githubLogin: null,
    });

    const app = createApp(
      new MemoryOperatorRepository(),
      agentRepo,
      undefined,
      undefined,
      undefined,
      createCredentialsAdapter({ did: ISSUER_DID, seed }, credentialRepo),
    );
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    // Step 1: issue a real work-history credential through the production
    // path, with signedBy a known agent verification method.
    const claim: WorkHistoryClaim = {
      jobId: COMPLETED_JOB_ID,
      pullRequestUrl: 'https://github.com/buyer/repo/pull/42',
      mergeCommitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      mergedAt: MERGED_AT,
      diffAdditions: 5,
      diffDeletions: 2,
      diffFiles: 1,
      briefHash: 'sha256:brief-invariant2',
      specHash: null,
      repository: 'buyer/repo',
      signedBy: SIGNED_BY,
      buyerDid: 'did:abt:zBuyerInvariant2',
    };
    const issued = await createCredentialsAdapter(
      { did: ISSUER_DID, seed },
      credentialRepo,
    ).issueWorkHistoryCredential(AGENT_DID, claim);

    // Step 2: save it, and snapshot the exact document object.
    await credentialRepo.save({ completedJobId: COMPLETED_JOB_ID, subjectDid: AGENT_DID, document: issued });
    snapshot = issued;
  });

  afterAll(() => {
    server.close();
  });

  it('step 2: the freshly issued credential verifies with the off-the-shelf verifier, before any report', async () => {
    const documentLoader = buildDocumentLoader(issuerKey, keyId, ISSUER_DID);
    const verified = await vc.verifyCredential({
      credential: snapshot,
      suite: new Ed25519Signature2020(),
      documentLoader,
    });
    expect(verified.verified).toBe(true);
  });

  it('step 3-4: after a covering compromise report, the served bytes are deep-equal to the snapshot and still verify', async () => {
    const report = await postJson(baseUrl, `/agents/${AGENT_DID}/key-compromise`, {
      key: SIGNED_BY,
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-10T00:00:00.000Z',
    });
    expect(report.status).toBe(201);

    const res = await fetch(`${baseUrl}/v1/credentials/${COMPLETED_JOB_ID}`);
    expect(res.status).toBe(200);
    const fetched = (await res.json()) as VerifiableCredential;

    // Every @context entry, every credentialSubject field, and the whole
    // proof object, unchanged.
    expect(fetched).toEqual(snapshot);

    const documentLoader = buildDocumentLoader(issuerKey, keyId, ISSUER_DID);
    const verified = await vc.verifyCredential({
      credential: fetched,
      suite: new Ed25519Signature2020(),
      documentLoader,
    });
    expect(verified.verified).toBe(true);
  });

  it('step 5: the served document carries no disputed/dispute/compromise key at any depth', async () => {
    const res = await fetch(`${baseUrl}/v1/credentials/${COMPLETED_JOB_ID}`);
    const parsed: unknown = JSON.parse(await res.text());
    walkForForbiddenKeys(parsed, '$');
  });

  it('step 6: GET /v1/credentials/:credentialId/disputed reports disputed true for this credential', async () => {
    const res = await fetch(`${baseUrl}/v1/credentials/${COMPLETED_JOB_ID}/disputed`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disputed: boolean };
    expect(body.disputed).toBe(true);
  });
});
