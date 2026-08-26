// R-17 (ENT-2.4, ENT-8, MISSION invariants 4 and 5): the agent profile as
// three separately labelled, separately counted evidence tiers, and the
// structural proof that no combined score rides along. verifiedPriorWork
// (ENT-11) and portfolio (ENT-12) have no storage or domain surface yet, so
// this suite pins them as present-and-empty rather than absent.
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
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';
import { MemoryAgentRepository, MemoryCredentialRepository } from '../../src/adapters/storage/memory.js';
import type { AgentRepository, CredentialRepository } from '../../src/adapters/storage/types.js';
import type { Delegation } from '../../src/domain/agent.js';

const ISSUER_DID = 'did:abt:platform';
const AGENT_DID = 'did:abt:agent-under-test';
const AGENT_NO_HIRES_DID = 'did:abt:agent-no-hires';
const OTHER_AGENT_DID = 'did:abt:other-agent';
const PROFILE_KEYS = ['did', 'name', 'portfolio', 'verifiedHires', 'verifiedPriorWork'];

// The stored delegation only needs its shape: create() does not re-verify
// (tests/adapters/storage-memory.test.ts:10-24).
const delegation: Delegation = {
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  id: 'urn:uuid:agent-profile-test',
  type: ['VerifiableCredential', 'AgentDelegation'],
  issuer: 'did:abt:zOperatorKeyHash',
  issuanceDate: '2026-08-20T05:00:00.000Z',
  credentialSubject: { id: 'did:abt:zAgentKeyHash' },
  proof: {
    type: 'Ed25519Signature2020',
    created: '2026-08-20T05:00:00.000Z',
    verificationMethod: 'did:abt:zOperatorKeyHash#zOperatorKeyHash',
    proofPurpose: 'assertionMethod',
    proofValue: 'zMockProofValue',
  },
};

function credentialFixture(subjectDid: string, mergeCommit: string, id: string): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id,
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: ISSUER_DID,
    validFrom: '2026-01-03T00:00:00.000Z',
    credentialSubject: {
      id: subjectDid,
      hire: {
        brief: 'sha256:brief',
        repository: 'buyer/target-repo',
        pullRequest: 'https://github.com/buyer/target-repo/pull/1',
        mergedAt: '2026-01-03T00:00:00.000Z',
        mergeCommit,
        signedBy: `${subjectDid}#job`,
        buyer: 'did:abt:buyer',
        additions: 1,
        deletions: 1,
        filesChanged: 1,
        specHash: 'sha256:spec',
      },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zProof' },
  };
}

function listen(app: Express): Promise<Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}

function portOf(srv: Server): number {
  return (srv.address() as AddressInfo).port;
}

// Every key at every depth, so a nested "helpful" total cannot hide from the
// top-level key check in the invariant-5 test.
function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, out));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      out.push(key);
      collectKeys(nested, out);
    }
  }
  return out;
}

function collectNumbers(value: unknown, out: number[] = []): number[] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectNumbers(item, out));
  } else if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      collectNumbers(nested, out);
    }
  } else if (typeof value === 'number') {
    out.push(value);
  }
  return out;
}

let server: Server;
let baseUrl: string;
const firstHire = credentialFixture(AGENT_DID, '1'.repeat(40), 'urn:uuid:profile-test-1');
const secondHire = credentialFixture(AGENT_DID, '2'.repeat(40), 'urn:uuid:profile-test-2');

beforeAll(async () => {
  const agentRepo = new MemoryAgentRepository();
  const credentialRepo = new MemoryCredentialRepository();
  await agentRepo.create({
    did: AGENT_DID,
    operatorDid: 'did:abt:zOperatorKeyHash',
    delegation,
    name: 'Scout',
    skills: ['triage'],
    githubLogin: null,
  });
  await agentRepo.create({
    did: AGENT_NO_HIRES_DID,
    operatorDid: 'did:abt:zOperatorKeyHash',
    delegation,
    name: 'Idle',
    skills: [],
    githubLogin: null,
  });
  await credentialRepo.save({ completedJobId: 'job_1', subjectDid: AGENT_DID, document: firstHire });
  await credentialRepo.save({ completedJobId: 'job_2', subjectDid: AGENT_DID, document: secondHire });
  await credentialRepo.save({
    completedJobId: 'job_3',
    subjectDid: OTHER_AGENT_DID,
    document: credentialFixture(OTHER_AGENT_DID, '3'.repeat(40), 'urn:uuid:profile-test-3'),
  });

  const app = createApp(undefined, agentRepo, undefined, undefined, undefined, undefined, credentialRepo);
  server = await listen(app);
  baseUrl = `http://127.0.0.1:${portOf(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GET /agents/:agentDid/profile', () => {
  it('renders three tiers, each labelled and counted separately, in save order', async () => {
    const res = await fetch(`${baseUrl}/agents/${AGENT_DID}/profile`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.verifiedHires).toEqual({
      label: 'Verified hire',
      count: 2,
      items: [
        {
          credentialId: firstHire.id,
          repository: firstHire.credentialSubject.hire.repository,
          pullRequest: firstHire.credentialSubject.hire.pullRequest,
          mergedAt: firstHire.credentialSubject.hire.mergedAt,
          mergeCommit: firstHire.credentialSubject.hire.mergeCommit,
        },
        {
          credentialId: secondHire.id,
          repository: secondHire.credentialSubject.hire.repository,
          pullRequest: secondHire.credentialSubject.hire.pullRequest,
          mergedAt: secondHire.credentialSubject.hire.mergedAt,
          mergeCommit: secondHire.credentialSubject.hire.mergeCommit,
        },
      ],
    });
    expect(body.verifiedPriorWork).toEqual({ label: 'Verified prior work', count: 0, items: [] });
    expect(body.portfolio).toEqual({ label: 'Portfolio claim', count: 0, items: [] });
  });

  it('has no combined score anywhere, structurally (MISSION invariant 5)', async () => {
    const res = await fetch(`${baseUrl}/agents/${AGENT_DID}/profile`);
    const body = (await res.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(PROFILE_KEYS);

    for (const key of collectKeys(body)) {
      expect(key).not.toMatch(/score|rating|trust|badge|overall|aggregate|total|rank|stars|level/i);
    }

    // The three tier counts sum to 2 (0 + 0 + 2). No numeric value anywhere
    // in the body may equal that sum except verifiedHires.count itself -
    // this is the assertion a future "helpful" total would fail.
    const verifiedHires = body.verifiedHires as { count: number };
    const sum = verifiedHires.count + 0 + 0;
    const matches = collectNumbers(body).filter((n) => n === sum);
    expect(matches).toEqual([sum]);
  });

  it('a zero-record agent renders zeros in every tier, same shape (ENT-2.4)', async () => {
    const res = await fetch(`${baseUrl}/agents/${AGENT_NO_HIRES_DID}/profile`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.verifiedHires).toEqual({ label: 'Verified hire', count: 0, items: [] });
    expect(body.verifiedPriorWork).toEqual({ label: 'Verified prior work', count: 0, items: [] });
    expect(body.portfolio).toEqual({ label: 'Portfolio claim', count: 0, items: [] });
    // The shape does not change with state: same key set as an agent with
    // hires, and no new/isNew/badge key marking it as fresh.
    expect(Object.keys(body).sort()).toEqual(PROFILE_KEYS);
  });

  it('404 for a DID no agent holds', async () => {
    const res = await fetch(`${baseUrl}/agents/did:abt:zNever/profile`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });
});

describe('GET /agents/:agentDid/profile, storage branches', () => {
  it('503 when the agent lookup throws', async () => {
    const base = new MemoryAgentRepository();
    const failingAgentRepo: AgentRepository = {
      create: (input) => base.create(input),
      findByDid: () => Promise.reject(new Error('storage down')),
      updateGithubBinding: (did, input) => base.updateGithubBinding(did, input),
      recordKeyRotation: (did, input) => base.recordKeyRotation(did, input),
    };
    const app = createApp(
      undefined,
      failingAgentRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      new MemoryCredentialRepository(),
    );
    const srv = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${portOf(srv)}/agents/${AGENT_DID}/profile`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'storage unavailable' });
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it('503 when the credential lookup throws', async () => {
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:zOperatorKeyHash',
      delegation,
      name: 'Scout',
      skills: [],
      githubLogin: null,
    });
    const base = new MemoryCredentialRepository();
    const failingCredentialRepo: CredentialRepository = {
      save: (input) => base.save(input),
      findByDocumentId: (documentId) => base.findByDocumentId(documentId),
      findBySubjectDid: () => Promise.reject(new Error('storage down')),
    };
    const app = createApp(
      undefined,
      agentRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      failingCredentialRepo,
    );
    const srv = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${portOf(srv)}/agents/${AGENT_DID}/profile`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'storage unavailable' });
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});

describe('GET /agents/:agentDid/profile, pre-R-35 credential shape', () => {
  it('a stored credential with no hire nesting does not 500 - it renders nulls', async () => {
    const oldShapeDid = 'did:abt:agent-old-shape';
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: oldShapeDid,
      operatorDid: 'did:abt:zOperatorKeyHash',
      delegation,
      name: 'Legacy',
      skills: [],
      githubLogin: null,
    });
    const credentialRepo = new MemoryCredentialRepository();
    // Pre-R-35 rows store the merge facts flat on credentialSubject, with no
    // nested `hire` object - the shape verifiedHireItem's optional chaining
    // exists for, and must not crash on. The current type pins `hire` as
    // required, so this is cast the way storage.test.ts casts Json-column
    // fixtures.
    const oldShape = {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      id: 'urn:uuid:profile-test-old-shape',
      type: ['VerifiableCredential', 'CompletedHireCredential'],
      issuer: ISSUER_DID,
      validFrom: '2026-01-03T00:00:00.000Z',
      credentialSubject: { id: oldShapeDid },
      proof: { type: 'Ed25519Signature2020', proofValue: 'zProof' },
    } as unknown as VerifiableCredential;
    await credentialRepo.save({ completedJobId: 'job_old', subjectDid: oldShapeDid, document: oldShape });

    const app = createApp(undefined, agentRepo, undefined, undefined, undefined, undefined, credentialRepo);
    const srv = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${portOf(srv)}/agents/${oldShapeDid}/profile`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      const verifiedHires = body.verifiedHires as { count: number; items: readonly Record<string, unknown>[] };
      expect(verifiedHires.count).toBe(1);
      expect(verifiedHires.items[0]).toEqual({
        credentialId: oldShape.id,
        repository: null,
        pullRequest: null,
        mergedAt: null,
        mergeCommit: null,
      });
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});

describe('GET /agents/:agentDid/profile, invariant 2', () => {
  let invServer: Server;
  let invBaseUrl: string;
  let keyId: string;
  let key: Awaited<ReturnType<typeof Ed25519VerificationKey2020.generate>>;
  let profileBody: Record<string, unknown>;

  beforeAll(async () => {
    const seed = new Uint8Array(randomBytes(32));
    key = await Ed25519VerificationKey2020.generate({ seed, controller: ISSUER_DID });
    keyId = `${ISSUER_DID}#${key.publicKeyMultibase}`;

    const agentRepo = new MemoryAgentRepository();
    const credentialRepo = new MemoryCredentialRepository();
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:zOperatorKeyHash',
      delegation,
      name: 'Scout',
      skills: [],
      githubLogin: null,
    });

    // The same repository backs both the resolvable-credential route (arg 6)
    // and the profile route (arg 7): a third party must resolve the exact
    // credential the profile advertises.
    const app = createApp(
      undefined,
      agentRepo,
      undefined,
      undefined,
      undefined,
      createCredentialsAdapter({ did: ISSUER_DID, seed }, credentialRepo),
      credentialRepo,
    );
    invServer = await listen(app);
    invBaseUrl = `http://127.0.0.1:${portOf(invServer)}`;

    const completedJobId = 'job-profile-invariant2';
    const credential = {
      '@context': [
        'https://www.w3.org/2018/credentials/v1',
        'https://w3id.org/security/suites/ed25519-2020/v1',
        { '@vocab': 'https://freeagents.dev/terms#' },
      ],
      // ENT-8: the resolvable id is this server's own URL plus the completed
      // job id, exactly as tests/api/credential-resolve.test.ts pins it.
      id: `${invBaseUrl}/v1/credentials/${completedJobId}`,
      type: ['VerifiableCredential', 'CompletedHireCredential'],
      issuer: ISSUER_DID,
      issuanceDate: new Date().toISOString(),
      credentialSubject: {
        id: AGENT_DID,
        jobId: completedJobId,
        pullRequestUrl: 'https://github.com/buyer/target-repo/pull/42',
        mergeCommitSha: '3f8a2c1d9e7b4a5f6c8d0e1f2a3b4c5d6e7f8a9b',
        mergedAt: '2026-08-21T12:00:00.000Z',
        diffAdditions: 12,
        diffDeletions: 4,
        specHash: 'sha256:spec',
        filesChanged: 1,
        repository: 'buyer/target-repo',
        signedBy: `${AGENT_DID}#${completedJobId}`,
        buyerDid: 'did:abt:buyer-under-test',
      },
    };

    // The issuer's key and DID document are registered statically: nothing
    // in this test learns the key from the platform's storage.
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

    const signed = (await vc.issue({
      credential,
      suite: new Ed25519Signature2020({ key }),
      documentLoader: loader.build(),
    })) as unknown as VerifiableCredential;

    await credentialRepo.save({
      completedJobId,
      subjectDid: AGENT_DID,
      document: signed,
    });

    const res = await fetch(`${invBaseUrl}/agents/${AGENT_DID}/profile`);
    profileBody = (await res.json()) as Record<string, unknown>;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => invServer.close(() => resolve()));
  });

  it('verifies the credential the profile advertises with an off-the-shelf verifier, without calling this service', async () => {
    const verifiedHires = profileBody.verifiedHires as { items: readonly { credentialId: string }[] };
    const credentialId = verifiedHires.items[0]?.credentialId;
    expect(typeof credentialId).toBe('string');

    // A plain URL fetch, not an API call the verifier had to be told about.
    const res = await fetch(credentialId as string);
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
