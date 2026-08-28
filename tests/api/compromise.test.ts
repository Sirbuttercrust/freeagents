// R-16 (ENT-8.4): reporting a key compromised marks work signed inside the
// window as disputed, without amending the signed credential (ENT-8.3). Block
// 1 covers the write and read-back routes. Block 2 covers the derived dispute
// status. Block 3 is the invariant-2 proof (MISSION invariant 2): a third
// party still verifies the credential unaided after a report is filed, and
// the dispute never enters the signature envelope.
import type { Express } from 'express';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { fromPublicKey } from '@arcblock/did';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import * as vc from '@digitalbazaar/vc';

import { createApp } from '../../src/api/app.js';
import { createCredentialResolver, createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import type { CredentialsAdapter, VerifiableCredential, WorkHistoryClaim } from '../../src/adapters/credentials/types.js';
import {
  MemoryAgentRepository,
  MemoryCompromiseRepository,
  MemoryCredentialRepository,
  MemoryOperatorRepository,
} from '../../src/adapters/storage/memory.js';
import type { AgentRepository, CompromiseRepository } from '../../src/adapters/storage/types.js';
import type { Agent, Delegation } from '../../src/domain/agent.js';

const AGENT_DID = 'did:abt:zAgentKeyHash';

const delegation: Delegation = {
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  id: 'urn:uuid:compromise-test',
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

function listen(app: Express): Promise<Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return address.port;
}

// A storage failure is a logged operator concern, not output the test needs;
// silence it so the branch under test is the response, not the log.
async function withApp(app: Express, run: (url: string) => Promise<void>): Promise<void> {
  const server = await listen(app);
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await run(`http://127.0.0.1:${portOf(server)}`);
  } finally {
    errSpy.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

type CompromiseReportProjection = { key: string; since: string; reportedAt: string };

describe('POST /agents/:agentDid/compromise-report (R-16, ENT-8.4)', () => {
  let server: Server;
  let baseUrl: string;
  const agentRepo = new MemoryAgentRepository();
  const compromiseRepo = new MemoryCompromiseRepository();

  beforeAll(async () => {
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:zOperatorKeyHash',
      delegation,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const app = createApp(
      new MemoryOperatorRepository(),
      agentRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      compromiseRepo,
    );
    server = await listen(app);
    baseUrl = `http://127.0.0.1:${portOf(server)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('201: a well-formed report is recorded, body is exactly { key, since, reportedAt }', async () => {
    const key = `${AGENT_DID}#zKey`;
    const since = '2026-08-10T00:00:00.000Z';
    const res = await postJson(baseUrl, `/agents/${AGENT_DID}/compromise-report`, { key, since });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ key, since, reportedAt: expect.any(String) });
  });

  it('the report reads back through GET /agents/:agentDid/compromise-reports', async () => {
    const res = await fetch(`${baseUrl}/agents/${AGENT_DID}/compromise-reports`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentDid: string; reports: CompromiseReportProjection[] };
    expect(body.agentDid).toBe(AGENT_DID);
    const expected = { key: `${AGENT_DID}#zKey`, since: '2026-08-10T00:00:00.000Z', reportedAt: expect.any(String) };
    expect(body.reports).toEqual([expected]);
  });

  it('two reports for one agent both persist, oldest first: append-only, nothing replaced', async () => {
    const res = await postJson(baseUrl, `/agents/${AGENT_DID}/compromise-report`, { key: `${AGENT_DID}#zSecond`, since: '2026-08-11T00:00:00.000Z' });
    expect(res.status).toBe(201);

    const read = await fetch(`${baseUrl}/agents/${AGENT_DID}/compromise-reports`);
    const body = (await read.json()) as { reports: CompromiseReportProjection[] };
    expect(body.reports).toHaveLength(2);
    expect(body.reports[0]?.key).toBe(`${AGENT_DID}#zKey`);
    expect(body.reports[1]?.key).toBe(`${AGENT_DID}#zSecond`);
  });

  it.each([
    ['a missing key', { since: '2026-08-10T00:00:00.000Z' }],
    ['a key with no #', { key: AGENT_DID, since: '2026-08-10T00:00:00.000Z' }],
    ['a missing since', { key: `${AGENT_DID}#zBad` }],
    ['an unparseable since', { key: `${AGENT_DID}#zBad`, since: 'not a date' }],
  ])('400: a malformed body (%s) records nothing', async (_label, body) => {
    const before = (await compromiseRepo.listByAgentDid(AGENT_DID)).length;
    const res = await postJson(baseUrl, `/agents/${AGENT_DID}/compromise-report`, body);
    expect(res.status).toBe(400);
    const after = (await compromiseRepo.listByAgentDid(AGENT_DID)).length;
    expect(after).toBe(before);
  });

  it('400: a since in the future records nothing', async () => {
    const before = (await compromiseRepo.listByAgentDid(AGENT_DID)).length;
    const future = new Date(Date.now() + 60_000).toISOString();
    const res = await postJson(baseUrl, `/agents/${AGENT_DID}/compromise-report`, { key: `${AGENT_DID}#zBad`, since: future });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain('future');
    const after = (await compromiseRepo.listByAgentDid(AGENT_DID)).length;
    expect(after).toBe(before);
  });

  it('404: a well-formed body for an unregistered agent', async () => {
    const res = await postJson(baseUrl, '/agents/did:abt:nobody/compromise-report', { key: 'did:abt:nobody#zKey', since: '2026-08-10T00:00:00.000Z' });
    expect(res.status).toBe(404);
  });

  it('404: GET compromise-reports for an unregistered agent', async () => {
    const res = await fetch(`${baseUrl}/agents/did:abt:nobody/compromise-reports`);
    expect(res.status).toBe(404);
  });
});

// The storage branches the real repositories never exercise, the same way
// tests/api/key-rotation.test.ts drives them with wrapped repositories.
describe('POST /agents/:agentDid/compromise-report and GET .../compromise-reports, storage branches', () => {
  function makeApp(overrides: {
    findByDid?: (did: string) => Promise<Agent | null>;
    compromiseRepo?: CompromiseRepository;
  }): Express {
    const baseAgents = new MemoryAgentRepository();
    const agentRepo: AgentRepository = {
      create: (input) => baseAgents.create(input),
      findByDid: overrides.findByDid ?? ((did) => baseAgents.findByDid(did)),
      updateGithubBinding: (did, input) => baseAgents.updateGithubBinding(did, input),
      recordKeyRotation: (did, input) => baseAgents.recordKeyRotation(did, input),
    };
    return createApp(
      new MemoryOperatorRepository(),
      agentRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      overrides.compromiseRepo ?? new MemoryCompromiseRepository(),
    );
  }

  it('POST 503: the agent lookup throws', async () => {
    const app = makeApp({ findByDid: () => Promise.reject(new Error('db down')) });
    await withApp(app, async (url) => {
      const res = await postJson(url, `/agents/${AGENT_DID}/compromise-report`, { key: `${AGENT_DID}#zKey`, since: '2026-08-10T00:00:00.000Z' });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'storage unavailable' });
    });
  });

  it('POST 503: the write throws', async () => {
    const failing: CompromiseRepository = {
      record: () => Promise.reject(new Error('db down')),
      listByAgentDid: () => Promise.resolve([]),
    };
    const app = makeApp({ findByDid: () => Promise.resolve({ did: AGENT_DID } as Agent), compromiseRepo: failing });
    await withApp(app, async (url) => {
      const res = await postJson(url, `/agents/${AGENT_DID}/compromise-report`, { key: `${AGENT_DID}#zKey`, since: '2026-08-10T00:00:00.000Z' });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'storage unavailable' });
    });
  });

  it('GET 503: the agent lookup throws', async () => {
    const app = makeApp({ findByDid: () => Promise.reject(new Error('db down')) });
    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents/${AGENT_DID}/compromise-reports`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'storage unavailable' });
    });
  });

  it('GET 200: an agent with no reports returns { agentDid, reports: [] }, not a 404', async () => {
    const app = makeApp({ findByDid: () => Promise.resolve({ did: AGENT_DID } as Agent) });
    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents/${AGENT_DID}/compromise-reports`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ agentDid: AGENT_DID, reports: [] });
    });
  });

  it('GET 503: listByAgentDid throws', async () => {
    const failing: CompromiseRepository = {
      record: () => Promise.reject(new Error('unused')),
      listByAgentDid: () => Promise.reject(new Error('db down')),
    };
    const app = makeApp({ findByDid: () => Promise.resolve({ did: AGENT_DID } as Agent), compromiseRepo: failing });
    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents/${AGENT_DID}/compromise-reports`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'storage unavailable' });
    });
  });
});

// A shaped fixture credential document is enough for this block, the same
// stance tests/adapters/prisma.test.ts and credential-resolve.test.ts take:
// it needs credentialSubject.id and credentialSubject.hire.signedBy/.mergedAt.
function shapedCredential(subjectDid: string, signedBy: string, mergedAt: string): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: 'did:abt:platform',
    validFrom: mergedAt,
    credentialSubject: {
      id: subjectDid,
      hire: {
        brief: 'sha256:brief',
        repository: 'buyer/target-repo',
        pullRequest: 'https://github.com/buyer/target-repo/pull/1',
        mergedAt,
        mergeCommit: '3f8a2c1d9e7b4a5f6c8d0e1f2a3b4c5d6e7f8a9b',
        signedBy,
        buyer: 'did:example:buyer',
        additions: 1,
        deletions: 1,
        filesChanged: 1,
      },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zProof' },
  };
}

describe('GET /v1/credentials/:credentialId/status (R-16)', () => {
  let server: Server;
  let baseUrl: string;
  const agentRepo = new MemoryAgentRepository();
  const compromiseRepo = new MemoryCompromiseRepository();
  const credentialRepo = new MemoryCredentialRepository();

  async function saveCredential(completedJobId: string, subjectDid: string, signedBy: string, mergedAt: string): Promise<void> {
    await credentialRepo.save({ completedJobId, subjectDid, document: shapedCredential(subjectDid, signedBy, mergedAt) });
  }

  // Registers the agent (the POST route requires it) and files the report.
  async function fileReport(subjectDid: string, key: string, since: string): Promise<void> {
    await agentRepo.create({
      did: subjectDid,
      operatorDid: 'did:abt:zOperatorKeyHash',
      delegation: { ...delegation, credentialSubject: { id: subjectDid } },
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    await postJson(baseUrl, `/agents/${subjectDid}/compromise-report`, { key, since });
  }

  beforeAll(async () => {
    const app = createApp(
      new MemoryOperatorRepository(),
      agentRepo,
      undefined,
      undefined,
      undefined,
      createCredentialResolver(credentialRepo),
      compromiseRepo,
    );
    server = await listen(app);
    baseUrl = `http://127.0.0.1:${portOf(server)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('with no reports filed: disputed is false and windows is empty', async () => {
    const subjectDid = 'did:abt:zStatusNoReports';
    const signedBy = `${subjectDid}#zJobKey`;
    const mergedAt = '2026-08-12T00:00:00.000Z';
    await saveCredential('job-status-1', subjectDid, signedBy, mergedAt);

    const res = await fetch(`${baseUrl}/v1/credentials/job-status-1/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.disputed).toBe(false);
    expect(body.windows).toEqual([]);
    expect(body.subject).toBe(subjectDid);
    expect(body.signedBy).toBe(signedBy);
    expect(body.signedAt).toBe(mergedAt);
  });

  it('after reporting the exact key that signed it, with since before mergedAt: disputed is true and windows carries the report', async () => {
    const subjectDid = 'did:abt:zStatusDisputed';
    const signedBy = `${subjectDid}#zJobKey`;
    const mergedAt = '2026-08-12T00:00:00.000Z';
    await saveCredential('job-status-2', subjectDid, signedBy, mergedAt);
    await fileReport(subjectDid, signedBy, '2026-08-10T00:00:00.000Z');

    const res = await fetch(`${baseUrl}/v1/credentials/job-status-2/status`);
    const body = (await res.json()) as { disputed: boolean; windows: CompromiseReportProjection[] };
    expect(body.disputed).toBe(true);
    expect(body.windows).toEqual([{ key: signedBy, since: '2026-08-10T00:00:00.000Z', reportedAt: expect.any(String) }]);
  });

  it('reporting a different key covering the same instant leaves disputed false', async () => {
    const subjectDid = 'did:abt:zStatusDifferentKey';
    const signedBy = `${subjectDid}#zJobKey`;
    const mergedAt = '2026-08-12T00:00:00.000Z';
    await saveCredential('job-status-3', subjectDid, signedBy, mergedAt);
    await fileReport(subjectDid, `${subjectDid}#zOtherKey`, '2026-08-10T00:00:00.000Z');

    const res = await fetch(`${baseUrl}/v1/credentials/job-status-3/status`);
    const body = (await res.json()) as { disputed: boolean; windows: unknown[] };
    expect(body.disputed).toBe(false);
    expect(body.windows).toEqual([]);
  });

  it('reporting the same key with a window that closes before mergedAt leaves disputed false', async () => {
    const subjectDid = 'did:abt:zStatusWindowClosed';
    const signedBy = `${subjectDid}#zJobKey`;
    // mergedAt is set well in the future: reportedAt is stamped "now" by the
    // driver, so a window ending "now" necessarily closes before it.
    const mergedAt = '2099-01-01T00:00:00.000Z';
    await saveCredential('job-status-4', subjectDid, signedBy, mergedAt);
    await fileReport(subjectDid, signedBy, '2026-01-01T00:00:00.000Z');

    const res = await fetch(`${baseUrl}/v1/credentials/job-status-4/status`);
    const body = (await res.json()) as { disputed: boolean; windows: unknown[] };
    expect(body.disputed).toBe(false);
    expect(body.windows).toEqual([]);
  });

  it('the DID short/long form reconciles both ways: a short-form report disputes a long-form signature, and vice versa', async () => {
    const mergedAt = '2026-08-12T00:00:00.000Z';

    const shortSubject = 'did:abt:zStatusShortForm';
    await saveCredential('job-status-5', shortSubject, `${shortSubject}#zJobKey`, mergedAt);
    // Filed in short form (no did:abt: prefix) against a long-form signature.
    await fileReport(shortSubject, 'zStatusShortForm#zJobKey', '2026-08-10T00:00:00.000Z');
    const shortRes = await fetch(`${baseUrl}/v1/credentials/job-status-5/status`);
    expect(((await shortRes.json()) as { disputed: boolean }).disputed).toBe(true);

    const longSubject = 'did:abt:zStatusLongForm';
    await saveCredential('job-status-6', longSubject, 'zStatusLongForm#zJobKey', mergedAt);
    // Filed in long form against a short-form signature.
    await fileReport(longSubject, `${longSubject}#zJobKey`, '2026-08-10T00:00:00.000Z');
    const longRes = await fetch(`${baseUrl}/v1/credentials/job-status-6/status`);
    expect(((await longRes.json()) as { disputed: boolean }).disputed).toBe(true);
  });

  it('404 for an unknown credential id', async () => {
    const res = await fetch(`${baseUrl}/v1/credentials/never-issued/status`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });
});

describe('GET /v1/credentials/:credentialId/status, storage branches', () => {
  it('503: credential resolution fails for a reason other than not-found', async () => {
    const failing: CredentialsAdapter = {
      issueWorkHistoryCredential: () => Promise.reject(new Error('unused')),
      verifyCredential: () => Promise.reject(new Error('unused')),
      getCredential: () => Promise.reject(new Error('db down')),
    };
    const app = createApp(undefined, undefined, undefined, undefined, undefined, failing, new MemoryCompromiseRepository());
    await withApp(app, async (url) => {
      const res = await fetch(`${url}/v1/credentials/anything/status`);
      expect(res.status).toBe(503);
    });
  });

  it('503: the compromise-report lookup fails', async () => {
    const credentialRepo = new MemoryCredentialRepository();
    await credentialRepo.save({
      completedJobId: 'job-status-fail',
      subjectDid: 'did:abt:zStatusStorage',
      document: shapedCredential('did:abt:zStatusStorage', 'did:abt:zStatusStorage#zJobKey', '2026-08-12T00:00:00.000Z'),
    });
    const failing: CompromiseRepository = {
      record: () => Promise.reject(new Error('unused')),
      listByAgentDid: () => Promise.reject(new Error('db down')),
    };
    const app = createApp(undefined, undefined, undefined, undefined, undefined, createCredentialResolver(credentialRepo), failing);
    await withApp(app, async (url) => {
      const res = await fetch(`${url}/v1/credentials/job-status-fail/status`);
      expect(res.status).toBe(503);
    });
  });
});

// MISSION invariant 2, made executable for R-16: a third party must still be
// able to verify a work-history credential with an off-the-shelf W3C
// verifier and nothing else, after a compromise report is filed against the
// key that signed it. The credential under test is produced by the
// PRODUCTION issuance path; verification uses only @digitalbazaar/vc and the
// issuer's publicly registered key, no import of this service's
// (nonexistent) verification code beyond the issuance call below.
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
  const proof = credential.proof as Record<string, unknown>;
  const verificationMethod = String(proof.verificationMethod);
  const issuer = String(credential.issuer);
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

  const result = await vc.verifyCredential({
    credential,
    suite: new Ed25519Signature2020(),
    documentLoader: loader.build(),
  });
  return result.verified === true;
}

// Recursively check no key anywhere in the object matches the given pattern:
// ENT-8.3 made executable, the dispute never enters the signature envelope.
function containsKeyMatching(value: unknown, pattern: RegExp): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsKeyMatching(entry, pattern));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, nested]) => pattern.test(key) || containsKeyMatching(nested, pattern),
    );
  }
  return false;
}

describe('invariant 2: a third party still verifies, unaided (R-16)', () => {
  let server: Server;
  let baseUrl: string;
  const agentRepo = new MemoryAgentRepository();
  const compromiseRepo = new MemoryCompromiseRepository();
  const credentialRepo = new MemoryCredentialRepository();
  const COMPLETED_JOB_ID = 'job-invariant2-compromise';

  beforeAll(async () => {
    const app = createApp(
      new MemoryOperatorRepository(),
      agentRepo,
      undefined,
      undefined,
      undefined,
      createCredentialResolver(credentialRepo),
      compromiseRepo,
    );
    server = await listen(app);
    baseUrl = `http://127.0.0.1:${portOf(server)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('the bytes that verified are the bytes still served, and the dispute is discoverable beside the credential, not inside it', async () => {
    // Step 1: issue a real credential through the production issuance path.
    const issuerSeed = new Uint8Array(randomBytes(32));
    const issuerKey = await generateKey(issuerSeed);
    const issuerDid = issuerKey.controller;

    const agentKey = await generateKey(new Uint8Array(randomBytes(32)));
    const agentDid = agentKey.controller;
    const signedBy = `${agentDid}#${agentKey.publicKeyMultibase}`;
    const mergedAt = '2026-08-12T00:00:00.000Z';

    await agentRepo.create({
      did: agentDid,
      operatorDid: 'did:abt:zOperatorKeyHash',
      delegation: { ...delegation, credentialSubject: { id: agentDid } },
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });

    const claim: WorkHistoryClaim = {
      jobId: COMPLETED_JOB_ID,
      pullRequestUrl: 'https://github.com/buyer/target-repo/pull/1',
      mergeCommitSha: '3f8a2c1d9e7b4a5f6c8d0e1f2a3b4c5d6e7f8a9b',
      mergedAt,
      diffAdditions: 1,
      diffDeletions: 1,
      diffFiles: 1,
      briefHash: 'sha256:brief',
      specHash: null,
      repository: 'buyer/target-repo',
      signedBy,
      buyerDid: 'did:example:buyer',
    };

    const issued = await createCredentialsAdapter(
      { did: issuerDid, seed: issuerSeed },
      credentialRepo,
    ).issueWorkHistoryCredential(agentDid, claim);
    await credentialRepo.save({ completedJobId: COMPLETED_JOB_ID, subjectDid: agentDid, document: issued });

    // Step 2: GET the credential and keep the response as beforeReport.
    const beforeRes = await fetch(`${baseUrl}/v1/credentials/${COMPLETED_JOB_ID}`);
    expect(beforeRes.status).toBe(200);
    const beforeText = await beforeRes.text();
    const beforeReport = JSON.parse(beforeText) as Record<string, unknown>;

    // Step 3: report the key compromised, in a window that covers mergedAt.
    const reportRes = await postJson(baseUrl, `/agents/${agentDid}/compromise-report`, {
      key: signedBy,
      since: '2026-08-10T00:00:00.000Z',
    });
    expect(reportRes.status).toBe(201);

    // Step 4: GET the credential again. Byte-identical, deep-equal.
    const afterRes = await fetch(`${baseUrl}/v1/credentials/${COMPLETED_JOB_ID}`);
    const afterText = await afterRes.text();
    const afterReport = JSON.parse(afterText) as Record<string, unknown>;
    expect(afterReport).toEqual(beforeReport);
    expect(afterText).toBe(beforeText);

    // Step 5: ENT-8.3 made executable: no dispute-shaped key anywhere.
    expect(containsKeyMatching(afterReport, /disputed|status|revoked|compromise/i)).toBe(false);

    // Step 6: an independent W3C verifier, resolving the issuer's key from
    // the credential's own proof.verificationMethod, still verifies it.
    expect(await verifyIndependent(afterReport)).toBe(true);

    // Step 7: the dispute is discoverable beside the credential.
    const statusRes = await fetch(`${baseUrl}/v1/credentials/${COMPLETED_JOB_ID}/status`);
    expect(statusRes.status).toBe(200);
    const statusBody = (await statusRes.json()) as { disputed: boolean; windows: CompromiseReportProjection[] };
    expect(statusBody.disputed).toBe(true);
    expect(statusBody.windows).toHaveLength(1);
    expect(statusBody.windows[0]?.key).toBe(signedBy);
  });
});
