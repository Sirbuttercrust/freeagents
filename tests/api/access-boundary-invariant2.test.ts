// R-23 + MISSION Gate 2: any change touching identity must leave invariant 2
// intact, proven by a test. This file proves the identity boundary R-23
// introduces did not move that line.
//
// Three things are shown, and only these three:
//   (a) browse and verify need no identity at all - GET /capabilities,
//       GET /operators/:did, GET /agents/:agentDid, GET /v1/credentials/:id
//       and GET /health all answer 200 with no authorization header, no
//       cookie header, and mint no session.
//   (b) a third party with no account, no session and no relationship to
//       this service fetches the anonymous credential response above and
//       verifies it with off-the-shelf @digitalbazaar/vc code alone.
//   (c) hire and list refuse a request that names no identity: POST
//       /operators, POST /agents and POST /jobs all 400 when the identity
//       field is missing. That is "an identity must be named", not "an
//       identity is authenticated" - proving the named identity belongs to
//       the caller is authentication, which is the follow-up sign-in
//       subsystem, not this file. None of these routes are authenticated.
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import * as vc from '@digitalbazaar/vc';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { accessPolicy } from '../../src/domain/access.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import type { IdentityAdapter } from '../../src/adapters/identity/types.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';
import {
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryOperatorRepository,
} from '../../src/adapters/storage/memory.js';
import { DELEGATION_TYPE, type Delegation } from '../../src/domain/agent.js';

const OPERATOR_DID = 'did:abt:op-access-boundary';
const AGENT_DID = 'did:abt:agent-access-boundary';
const ISSUER_DID = 'did:abt:platform-access-boundary';
const COMPLETED_JOB_ID = 'job-access-boundary-1';
const CREDENTIAL_PATH = `/v1/credentials/${COMPLETED_JOB_ID}`;

function delegationFixture(): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-access-boundary',
    type: ['VerifiableCredential', DELEGATION_TYPE],
    issuer: OPERATOR_DID,
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: AGENT_DID },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-01-01T00:00:00Z',
      verificationMethod: `${AGENT_DID}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zfixture-accepted-by-the-wrapped-adapter-below',
    },
  };
}

// Delegation VALIDITY has its own invariant-2 suites; wrapping the real
// adapter to accept every delegation, as tests/api/avatar-no-upload.test.ts
// does, lets registration succeed here without re-exercising that.
const acceptingIdentity: IdentityAdapter = {
  ...createIdentityAdapter(),
  verifyDelegation: () => Promise.resolve(true),
};

async function postJson(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function listen(app: Express): Promise<Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}

function portOf(srv: Server): number {
  return (srv.address() as AddressInfo).port;
}

let server: Server;
let baseUrl: string;
let keyId: string;
let key: Awaited<ReturnType<typeof Ed25519VerificationKey2020.generate>>;
let signed: VerifiableCredential;
const credentialRepo = new MemoryCredentialRepository();

function loaderWithIssuerKey(): ReturnType<typeof securityLoader> {
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
  return loader;
}

beforeAll(async () => {
  const seed = new Uint8Array(randomBytes(32));
  key = await Ed25519VerificationKey2020.generate({ seed, controller: ISSUER_DID });
  keyId = `${ISSUER_DID}#${key.publicKeyMultibase}`;

  const app = createApp(
    new MemoryOperatorRepository(),
    new MemoryAgentRepository(),
    acceptingIdentity,
    undefined,
    undefined,
    createCredentialsAdapter({ did: ISSUER_DID, seed }, credentialRepo),
  );
  server = await listen(app);
  baseUrl = `http://127.0.0.1:${portOf(server)}`;

  // Register one operator and one agent over HTTP, so there is something
  // real to browse below.
  const opRes = await postJson(baseUrl, '/operators', { did: OPERATOR_DID, githubLogin: 'access-boundary-op' });
  if (opRes.status !== 201) {
    throw new Error(`fixture setup: POST /operators failed with ${opRes.status}`);
  }
  const agentRes = await postJson(baseUrl, '/agents', {
    did: AGENT_DID,
    operator: OPERATOR_DID,
    delegation: delegationFixture(),
    name: 'access-boundary-agent',
    skills: ['triage'],
  });
  if (agentRes.status !== 201) {
    throw new Error(`fixture setup: POST /agents failed with ${agentRes.status}`);
  }

  const credential = {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
      { '@vocab': 'https://freeagents.dev/terms#' },
    ],
    id: `${baseUrl}${CREDENTIAL_PATH}`,
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: ISSUER_DID,
    issuanceDate: new Date().toISOString(),
    credentialSubject: {
      id: AGENT_DID,
      jobId: COMPLETED_JOB_ID,
      pullRequestUrl: 'https://github.com/buyer/target-repo/pull/7',
      mergeCommitSha: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
      mergedAt: '2026-08-25T12:00:00.000Z',
      diffAdditions: 3,
      diffDeletions: 1,
      specHash: 'sha256:spec-access-boundary',
      filesChanged: 1,
      repository: 'buyer/target-repo',
      signedBy: `${AGENT_DID}#${COMPLETED_JOB_ID}`,
      buyerDid: OPERATOR_DID,
    },
  };

  signed = (await vc.issue({
    credential,
    suite: new Ed25519Signature2020({ key }),
    documentLoader: loaderWithIssuerKey().build(),
  })) as unknown as VerifiableCredential;

  await credentialRepo.save({
    completedJobId: COMPLETED_JOB_ID,
    subjectDid: AGENT_DID,
    document: signed,
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('browse and verify need no identity (accept clause 1)', () => {
  const paths: readonly string[] = ['/capabilities', `/operators/${OPERATOR_DID}`, `/agents/${AGENT_DID}`, CREDENTIAL_PATH, '/health'];

  it.each(paths)('%s answers 200 with no authorization, no cookie, and mints no session', async (path) => {
    const res = await fetch(`${baseUrl}${path}`);
    expect(res.status).toBe(200);
    const bodyText = await res.text();
    expect(bodyText.length).toBeGreaterThan(0);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it("the registered operator's did round-trips on the anonymous read", async () => {
    const res = await fetch(`${baseUrl}/operators/${OPERATOR_DID}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.did).toBe(OPERATOR_DID);
  });

  it("the registered agent's did round-trips on the anonymous read", async () => {
    const res = await fetch(`${baseUrl}/agents/${AGENT_DID}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.did).toBe(AGENT_DID);
  });
});

describe('invariant 2 holds on the anonymously fetched credential', () => {
  it('a stranger fetches the credential with no account and verifies it with off-the-shelf code, no call to this service', async () => {
    const res = await fetch(`${baseUrl}${CREDENTIAL_PATH}`);
    expect(res.status).toBe(200);
    const fetched = (await res.json()) as VerifiableCredential;
    expect((fetched.proof as Record<string, unknown>).type).toBe('Ed25519Signature2020');

    const verified = await vc.verifyCredential({
      credential: fetched,
      suite: new Ed25519Signature2020(),
      documentLoader: loaderWithIssuerKey().build(),
    });
    expect(verified.verified).toBe(true);
  });
});

describe('hire and list name an identity (accept clause 2, honestly scoped)', () => {
  it('POST /operators without did is refused, and the error mentions did', async () => {
    const res = await postJson(baseUrl, '/operators', { githubLogin: 'no-did' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/did/);
  });

  it('POST /agents without operator is refused', async () => {
    const res = await postJson(baseUrl, '/agents', {
      did: 'did:abt:no-operator-agent',
      name: 'x',
      skills: [],
    });
    expect(res.status).toBe(400);
  });

  it('POST /jobs without buyerDid is refused', async () => {
    const res = await postJson(baseUrl, '/jobs', {
      agentDid: AGENT_DID,
      repository: 'a/b',
      brief: 'x',
    });
    expect(res.status).toBe(400);
  });

  it('the policy and the behaviour agree: exactly hire and list require identity', () => {
    expect(accessPolicy().filter((r) => r.identityRequired).map((r) => r.capability)).toEqual(['hire', 'list']);
  });
});
