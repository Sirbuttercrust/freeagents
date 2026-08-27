// R-16 (ENT-8, spec/wireframe/keys.html): reporting a key compromised marks
// work signed inside the window as disputed; nothing is deleted or hidden;
// the window is visible. Structural coverage mirrors
// tests/api/key-rotation.test.ts; the disputed-credential coverage issues a
// real credential through createCredentialsAdapter, the same fixture stance
// tests/api/credential-resolve.test.ts and the invariant-2 suite take.
import { randomBytes } from 'node:crypto';
import type { Express } from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createCredentialResolver, createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import { MemoryAgentRepository, MemoryCredentialRepository, MemoryOperatorRepository } from '../../src/adapters/storage/memory.js';
import type { AgentRepository, CredentialRepository } from '../../src/adapters/storage/types.js';
import type { Agent, Delegation } from '../../src/domain/agent.js';
import type { VerifiableCredential, WorkHistoryClaim } from '../../src/adapters/credentials/types.js';

const AGENT_DID = 'did:abt:zAgentKeyHash';
const ISSUER_DID = 'did:abt:zPlatformKeyHash';

const delegation: Delegation = {
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  id: 'urn:uuid:key-compromise-test',
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

type WindowProjection = { key: string; from: string; to: string; reportedAt: string };

describe('key compromise reporting and disputed visibility (R-16)', () => {
  let server: Server;
  let baseUrl: string;
  const agentRepo = new MemoryAgentRepository();
  const credentialRepo = new MemoryCredentialRepository();

  beforeAll(async () => {
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:zOperatorKeyHash',
      delegation,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const seed = new Uint8Array(randomBytes(32));
    const app: Express = createApp(
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
  });

  afterAll(() => {
    server.close();
  });

  describe('POST /agents/:agentDid/key-compromise', () => {
    it.each([
      ['a missing body', {}],
      ['a missing key', { from: '2026-08-01T00:00:00.000Z', to: '2026-08-10T00:00:00.000Z' }],
      ['a key with no #', { key: AGENT_DID, from: '2026-08-01T00:00:00.000Z', to: '2026-08-10T00:00:00.000Z' }],
      ['an unparseable from', { key: `${AGENT_DID}#zK`, from: 'not a date', to: '2026-08-10T00:00:00.000Z' }],
      ['an unparseable to', { key: `${AGENT_DID}#zK`, from: '2026-08-01T00:00:00.000Z', to: 'not a date' }],
    ])('400: %s', async (_label, body) => {
      const res = await postJson(baseUrl, `/agents/${AGENT_DID}/key-compromise`, body);
      expect(res.status).toBe(400);
    });

    it('400: from after to, with the forward-window message', async () => {
      const res = await postJson(baseUrl, `/agents/${AGENT_DID}/key-compromise`, {
        key: `${AGENT_DID}#zK`,
        from: '2026-08-10T00:00:00.000Z',
        to: '2026-08-01T00:00:00.000Z',
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body.error)).toContain('from is after to');
    });

    it('404: a DID that was never registered', async () => {
      const res = await postJson(baseUrl, '/agents/did:abt:nobody/key-compromise', {
        key: 'did:abt:nobody#zK',
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-10T00:00:00.000Z',
      });
      expect(res.status).toBe(404);
    });

    it('201: the happy path returns { agentDid, windows: [one window] } with ISO strings and a server-stamped reportedAt', async () => {
      const res = await postJson(baseUrl, `/agents/${AGENT_DID}/key-compromise`, {
        key: `${AGENT_DID}#zHappyPath`,
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-10T00:00:00.000Z',
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { agentDid: string; windows: WindowProjection[] };
      expect(body.agentDid).toBe(AGENT_DID);
      expect(body.windows).toHaveLength(1);
      const w = body.windows[0] as WindowProjection;
      expect(w.key).toBe(`${AGENT_DID}#zHappyPath`);
      expect(w.from).toBe('2026-08-01T00:00:00.000Z');
      expect(w.to).toBe('2026-08-10T00:00:00.000Z');
      expect(Number.isNaN(Date.parse(w.reportedAt))).toBe(false);
    });

    it('two reports append, they do not replace: posting twice yields two windows, oldest first', async () => {
      const did = 'did:abt:zAppendAgent';
      await agentRepo.create({
        did,
        operatorDid: 'did:abt:zOperatorKeyHash',
        delegation: { ...delegation, credentialSubject: { id: did } },
        name: 'append-scout',
        skills: [],
        githubLogin: null,
      });
      const first = await postJson(baseUrl, `/agents/${did}/key-compromise`, {
        key: `${did}#zFirst`,
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-05T00:00:00.000Z',
      });
      expect(first.status).toBe(201);
      const second = await postJson(baseUrl, `/agents/${did}/key-compromise`, {
        key: `${did}#zSecond`,
        from: '2026-08-06T00:00:00.000Z',
        to: '2026-08-09T00:00:00.000Z',
      });
      expect(second.status).toBe(201);
      const body = (await second.json()) as { windows: WindowProjection[] };
      expect(body.windows).toHaveLength(2);
      expect((body.windows[0] as WindowProjection).key).toBe(`${did}#zFirst`);
      expect((body.windows[1] as WindowProjection).key).toBe(`${did}#zSecond`);
    });
  });

  describe('GET /agents/:agentDid/key-compromise', () => {
    it('404: an unknown agent', async () => {
      const res = await fetch(`${baseUrl}/agents/did:abt:nobody/key-compromise`);
      expect(res.status).toBe(404);
    });

    it('200: windows: [] for a registered agent that has never reported', async () => {
      const did = 'did:abt:zNeverReportedAgent';
      await agentRepo.create({
        did,
        operatorDid: 'did:abt:zOperatorKeyHash',
        delegation: { ...delegation, credentialSubject: { id: did } },
        name: 'quiet-scout',
        skills: [],
        githubLogin: null,
      });
      const res = await fetch(`${baseUrl}/agents/${did}/key-compromise`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { agentDid: string; windows: WindowProjection[] };
      expect(body.windows).toEqual([]);
    });

    it('200: lists every reported window after two reports', async () => {
      const res = await fetch(`${baseUrl}/agents/${AGENT_DID}/key-compromise`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { windows: WindowProjection[] };
      expect(body.windows.length).toBeGreaterThanOrEqual(1);
      expect(body.windows.some((w) => w.key === `${AGENT_DID}#zHappyPath`)).toBe(true);
    });
  });

  describe('disputed visibility on a real credential', () => {
    const DISPUTE_AGENT_DID = 'did:abt:zDisputeAgent';
    const COMPLETED_JOB_ID = 'job-dispute-1';
    const SIGNED_BY = `${DISPUTE_AGENT_DID}#zSigningKey`;
    const MERGED_AT = '2026-08-05T00:00:00.000Z';

    beforeAll(async () => {
      await agentRepo.create({
        did: DISPUTE_AGENT_DID,
        operatorDid: 'did:abt:zOperatorKeyHash',
        delegation: { ...delegation, credentialSubject: { id: DISPUTE_AGENT_DID } },
        name: 'dispute-scout',
        skills: [],
        githubLogin: null,
      });
      const claim: WorkHistoryClaim = {
        jobId: COMPLETED_JOB_ID,
        pullRequestUrl: 'https://github.com/buyer/repo/pull/9',
        mergeCommitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        mergedAt: MERGED_AT,
        diffAdditions: 3,
        diffDeletions: 1,
        diffFiles: 1,
        briefHash: 'sha256:brief',
        specHash: null,
        repository: 'buyer/repo',
        signedBy: SIGNED_BY,
        buyerDid: 'did:abt:zBuyer',
      };
      const seed = new Uint8Array(randomBytes(32));
      const issued = await createCredentialsAdapter(
        { did: ISSUER_DID, seed },
        credentialRepo,
      ).issueWorkHistoryCredential(DISPUTE_AGENT_DID, claim);
      await credentialRepo.save({
        completedJobId: COMPLETED_JOB_ID,
        subjectDid: DISPUTE_AGENT_DID,
        document: issued,
      });
    });

    it('before any report: disputed false, windows []', async () => {
      const res = await fetch(`${baseUrl}/v1/credentials/${COMPLETED_JOB_ID}/disputed`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { disputed: boolean; windows: WindowProjection[] };
      expect(body.disputed).toBe(false);
      expect(body.windows).toEqual([]);
    });

    it('the header is clear before any report, and the body is deep-equal to the stored document', async () => {
      const res = await fetch(`${baseUrl}/v1/credentials/${COMPLETED_JOB_ID}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-freeagents-dispute-status')).toBe('clear');
      expect(String(res.headers.get('content-type')).startsWith('application/ld+json')).toBe(true);
      const stored = await credentialRepo.findByDocumentId(COMPLETED_JOB_ID);
      expect(await res.json()).toEqual(stored);
    });

    it('after reporting a window covering mergedAt with the same key as signedBy: disputed true, and the window is visible', async () => {
      const report = await postJson(baseUrl, `/agents/${DISPUTE_AGENT_DID}/key-compromise`, {
        key: SIGNED_BY,
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-10T00:00:00.000Z',
      });
      expect(report.status).toBe(201);

      const res = await fetch(`${baseUrl}/v1/credentials/${COMPLETED_JOB_ID}/disputed`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { disputed: boolean; windows: WindowProjection[] };
      expect(body.disputed).toBe(true);
      expect(body.windows).toHaveLength(1);
      expect((body.windows[0] as WindowProjection).from).toBe('2026-08-01T00:00:00.000Z');
      expect((body.windows[0] as WindowProjection).to).toBe('2026-08-10T00:00:00.000Z');
    });

    it('the header is disputed after the covering report, and the body is still deep-equal to the stored document', async () => {
      const res = await fetch(`${baseUrl}/v1/credentials/${COMPLETED_JOB_ID}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-freeagents-dispute-status')).toBe('disputed');
      expect(String(res.headers.get('content-type')).startsWith('application/ld+json')).toBe(true);
      const stored = await credentialRepo.findByDocumentId(COMPLETED_JOB_ID);
      expect(await res.json()).toEqual(stored);
    });

    it('after reporting a window for a different key: still disputed false for the earlier lookup subject, a fresh credential stays clear', async () => {
      const otherJobId = 'job-dispute-2';
      const claim: WorkHistoryClaim = {
        jobId: otherJobId,
        pullRequestUrl: 'https://github.com/buyer/repo/pull/10',
        mergeCommitSha: 'cafebabecafebabecafebabecafebabecafebabe',
        mergedAt: MERGED_AT,
        diffAdditions: 1,
        diffDeletions: 1,
        diffFiles: 1,
        briefHash: 'sha256:brief2',
        specHash: null,
        repository: 'buyer/repo',
        signedBy: `${DISPUTE_AGENT_DID}#zUnrelatedKey`,
        buyerDid: 'did:abt:zBuyer',
      };
      const seed = new Uint8Array(randomBytes(32));
      const issued = await createCredentialsAdapter(
        { did: ISSUER_DID, seed },
        credentialRepo,
      ).issueWorkHistoryCredential(DISPUTE_AGENT_DID, claim);
      await credentialRepo.save({ completedJobId: otherJobId, subjectDid: DISPUTE_AGENT_DID, document: issued });

      const res = await fetch(`${baseUrl}/v1/credentials/${otherJobId}/disputed`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { disputed: boolean };
      expect(body.disputed).toBe(false);
    });

    it('404: an unknown credential id', async () => {
      const res = await fetch(`${baseUrl}/v1/credentials/never-issued/disputed`);
      expect(res.status).toBe(404);
    });
  });

  // The storage branches the real repository never exercises: a failing
  // lookup, a failing write, and a write that reports the agent as not
  // stored after the lookup succeeded, on both the report and list routes,
  // plus a non-not-found failure on the disputed route and the header's own
  // 'unknown' fallback. Each gets its own app with a wrapped repository, the
  // same way tests/api/key-rotation.test.ts's storage-branches block does.
  describe('storage branches', () => {
    const BRANCH_AGENT_DID = 'did:abt:zStorageBranchAgent';

    function wrapAgentRepo(base: MemoryAgentRepository, overrides: Partial<AgentRepository>): AgentRepository {
      return {
        create: (input) => base.create(input),
        findByDid: overrides.findByDid ?? ((did) => base.findByDid(did)),
        updateGithubBinding: (did, input) => base.updateGithubBinding(did, input),
        recordKeyRotation: (did, input) => base.recordKeyRotation(did, input),
        reportKeyCompromise:
          overrides.reportKeyCompromise ?? ((did, input) => base.reportKeyCompromise(did, input)),
        listCompromiseWindows: overrides.listCompromiseWindows ?? ((did) => base.listCompromiseWindows(did)),
      };
    }

    async function withApp(app: Express, run: (url: string) => Promise<void>): Promise<void> {
      const srv = app.listen(0);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await new Promise<void>((resolve) => srv.once('listening', resolve));
        const address = srv.address();
        if (address === null || typeof address === 'string') {
          throw new Error('expected server to listen on a port');
        }
        await run(`http://127.0.0.1:${address.port}`);
      } finally {
        errSpy.mockRestore();
        srv.close();
      }
    }

    it('503: POST key-compromise, the agent lookup throws', async () => {
      const repo = wrapAgentRepo(new MemoryAgentRepository(), {
        findByDid: () => Promise.reject(new Error('db down')),
      });
      const app = createApp(new MemoryOperatorRepository(), repo);
      await withApp(app, async (url) => {
        const res = await postJson(url, `/agents/${BRANCH_AGENT_DID}/key-compromise`, {
          key: `${BRANCH_AGENT_DID}#zK`,
          from: '2026-08-01T00:00:00.000Z',
          to: '2026-08-10T00:00:00.000Z',
        });
        expect(res.status).toBe(503);
      });
    });

    it('503: POST key-compromise, the write throws', async () => {
      const base = new MemoryAgentRepository();
      await base.create({
        did: BRANCH_AGENT_DID,
        operatorDid: 'did:abt:zOperatorKeyHash',
        delegation: { ...delegation, credentialSubject: { id: BRANCH_AGENT_DID } },
        name: 'branch-scout',
        skills: [],
        githubLogin: null,
      });
      const repo = wrapAgentRepo(base, { reportKeyCompromise: () => Promise.reject(new Error('db down')) });
      const app = createApp(new MemoryOperatorRepository(), repo);
      await withApp(app, async (url) => {
        const res = await postJson(url, `/agents/${BRANCH_AGENT_DID}/key-compromise`, {
          key: `${BRANCH_AGENT_DID}#zK`,
          from: '2026-08-01T00:00:00.000Z',
          to: '2026-08-10T00:00:00.000Z',
        });
        expect(res.status).toBe(503);
      });
    });

    it('404: POST key-compromise, the write reports the agent as not stored, after the lookup succeeded', async () => {
      const stored: Agent = {
        did: BRANCH_AGENT_DID,
        operatorDid: 'did:abt:zOperatorKeyHash',
        delegation,
        name: 'branch-scout',
        skills: [],
        githubLogin: null,
        proofStatus: 'unverified',
        createdAt: new Date(),
        keyRotations: [],
      };
      const repo = wrapAgentRepo(new MemoryAgentRepository(), {
        findByDid: () => Promise.resolve(stored),
        reportKeyCompromise: () => Promise.resolve(null),
      });
      const app = createApp(new MemoryOperatorRepository(), repo);
      await withApp(app, async (url) => {
        const res = await postJson(url, `/agents/${BRANCH_AGENT_DID}/key-compromise`, {
          key: `${BRANCH_AGENT_DID}#zK`,
          from: '2026-08-01T00:00:00.000Z',
          to: '2026-08-10T00:00:00.000Z',
        });
        expect(res.status).toBe(404);
      });
    });

    it('503: GET key-compromise, the list lookup throws', async () => {
      const repo = wrapAgentRepo(new MemoryAgentRepository(), {
        listCompromiseWindows: () => Promise.reject(new Error('db down')),
      });
      const app = createApp(new MemoryOperatorRepository(), repo);
      await withApp(app, async (url) => {
        const res = await fetch(`${url}/agents/${BRANCH_AGENT_DID}/key-compromise`);
        expect(res.status).toBe(503);
      });
    });

    it('503: GET disputed, a non-not-found storage failure', async () => {
      const failing: CredentialRepository = {
        save: () => {
          throw new Error('storage down');
        },
        findByDocumentId: () => {
          throw new Error('storage down');
        },
      };
      const app = createApp(undefined, undefined, undefined, undefined, undefined, createCredentialResolver(failing));
      await withApp(app, async (url) => {
        const res = await fetch(`${url}/v1/credentials/anything/disputed`);
        expect(res.status).toBe(503);
      });
    });

    it("the header falls back to 'unknown' when the dispute lookup throws, and the credential still resolves 200 with an unchanged body", async () => {
      const repo = wrapAgentRepo(new MemoryAgentRepository(), {
        listCompromiseWindows: () => Promise.reject(new Error('db down')),
      });
      const branchCredentialRepo = new MemoryCredentialRepository();
      const seed = new Uint8Array(randomBytes(32));
      const branchIssuerDid = 'did:abt:zHeaderUnknownIssuer';
      const branchAgentDid = 'did:abt:zHeaderUnknownAgent';
      const claim: WorkHistoryClaim = {
        jobId: 'job-header-unknown',
        pullRequestUrl: 'https://github.com/buyer/repo/pull/11',
        mergeCommitSha: 'facefacefacefacefacefacefacefacefaceface',
        mergedAt: '2026-08-05T00:00:00.000Z',
        diffAdditions: 1,
        diffDeletions: 1,
        diffFiles: 1,
        briefHash: 'sha256:brief-header-unknown',
        specHash: null,
        repository: 'buyer/repo',
        signedBy: `${branchAgentDid}#zK`,
        buyerDid: 'did:abt:zBuyer',
      };
      const issued = await createCredentialsAdapter(
        { did: branchIssuerDid, seed },
        branchCredentialRepo,
      ).issueWorkHistoryCredential(branchAgentDid, claim);
      await branchCredentialRepo.save({
        completedJobId: 'job-header-unknown',
        subjectDid: branchAgentDid,
        document: issued,
      });
      const app = createApp(
        new MemoryOperatorRepository(),
        repo,
        undefined,
        undefined,
        undefined,
        createCredentialsAdapter({ did: branchIssuerDid, seed }, branchCredentialRepo),
      );
      await withApp(app, async (url) => {
        const res = await fetch(`${url}/v1/credentials/job-header-unknown`);
        expect(res.status).toBe(200);
        expect(res.headers.get('x-freeagents-dispute-status')).toBe('unknown');
        expect(await res.json()).toEqual(issued);
      });
    });
  });

  // disputableFacts and parseDateOrNull are not exported, so their branches
  // are exercised the same way the routes are: through a document saved
  // straight into the credential repository. Real issuance
  // (createCredentialsAdapter) always fills signedBy, mergedAt and validFrom,
  // so these malformed shapes are unreachable through the production issuer
  // path and are only reachable from whatever a stored document actually
  // contains -- the same trust boundary getCredential already crosses.
  describe('disputableFacts / parseDateOrNull edge branches', () => {
    const EDGE_AGENT_DID = 'did:abt:zEdgeFactsAgent';

    function baseHire(): Record<string, unknown> {
      return {
        brief: 'sha256:brief-edge',
        repository: 'buyer/repo',
        pullRequest: 'https://github.com/buyer/repo/pull/1',
        mergedAt: '2026-08-05T00:00:00.000Z',
        mergeCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        signedBy: `${EDGE_AGENT_DID}#zEdgeKey`,
        buyer: 'did:abt:zBuyer',
        additions: 1,
        deletions: 1,
        filesChanged: 1,
      };
    }

    function hireWithout(...omit: readonly string[]): Record<string, unknown> {
      const hire = baseHire();
      for (const key of omit) delete hire[key];
      return hire;
    }

    function rawDocument(
      id: string,
      subjectDid: string,
      hire: Record<string, unknown>,
      validFrom: unknown = '2026-08-06T00:00:00.000Z',
    ): VerifiableCredential {
      return {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        id: `urn:uuid:${id}`,
        type: ['VerifiableCredential', 'CompletedHireCredential'],
        issuer: ISSUER_DID,
        validFrom,
        credentialSubject: { id: subjectDid, hire },
        proof: { type: 'Ed25519Signature2020', proofValue: 'zMockEdgeProof' },
      } as unknown as VerifiableCredential;
    }

    beforeAll(async () => {
      await agentRepo.create({
        did: EDGE_AGENT_DID,
        operatorDid: 'did:abt:zOperatorKeyHash',
        delegation: { ...delegation, credentialSubject: { id: EDGE_AGENT_DID } },
        name: 'edge-facts-scout',
        skills: [],
        githubLogin: null,
      });
      await agentRepo.reportKeyCompromise(EDGE_AGENT_DID, {
        key: `${EDGE_AGENT_DID}#zEdgeKey`,
        from: new Date('2026-08-01T00:00:00.000Z'),
        to: new Date('2026-08-10T00:00:00.000Z'),
      });
    });

    it('signedBy absent from hire: disputed false (disputableFacts null branch)', async () => {
      const hire = hireWithout('signedBy');
      const jobId = 'job-edge-signedby-absent';
      await credentialRepo.save({
        completedJobId: jobId,
        subjectDid: EDGE_AGENT_DID,
        document: rawDocument(jobId, EDGE_AGENT_DID, hire),
      });

      const res = await fetch(`${baseUrl}/v1/credentials/${jobId}/disputed`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { disputed: boolean };
      expect(body.disputed).toBe(false);
    });

    it('signedBy is a non-string: disputed false (disputableFacts null branch, the typeof guard)', async () => {
      const hire = { ...baseHire(), signedBy: 42 };
      const jobId = 'job-edge-signedby-non-string';
      await credentialRepo.save({
        completedJobId: jobId,
        subjectDid: EDGE_AGENT_DID,
        document: rawDocument(jobId, EDGE_AGENT_DID, hire),
      });

      const res = await fetch(`${baseUrl}/v1/credentials/${jobId}/disputed`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { disputed: boolean };
      expect(body.disputed).toBe(false);
    });

    it('mergedAt missing, validFrom outside the window: disputed false (parseDateOrNull null return on hire.mergedAt)', async () => {
      const hire = hireWithout('mergedAt');
      const jobId = 'job-edge-mergedat-missing';
      await credentialRepo.save({
        completedJobId: jobId,
        subjectDid: EDGE_AGENT_DID,
        document: rawDocument(jobId, EDGE_AGENT_DID, hire, '2026-09-01T00:00:00.000Z'),
      });

      const res = await fetch(`${baseUrl}/v1/credentials/${jobId}/disputed`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { disputed: boolean };
      expect(body.disputed).toBe(false);
    });

    it('validFrom unparseable, mergedAt outside the window: disputed false (parseDateOrNull null return on document.validFrom)', async () => {
      const hire = { ...baseHire(), mergedAt: '2026-09-01T00:00:00.000Z' };
      const jobId = 'job-edge-validfrom-unparseable';
      await credentialRepo.save({
        completedJobId: jobId,
        subjectDid: EDGE_AGENT_DID,
        document: rawDocument(jobId, EDGE_AGENT_DID, hire, 'not a date'),
      });

      const res = await fetch(`${baseUrl}/v1/credentials/${jobId}/disputed`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { disputed: boolean };
      expect(body.disputed).toBe(false);
    });

    it('the credential subject DID is not a stored agent: 200 with disputed false and clear, not a 404 (the ?? [] fallback on both routes)', async () => {
      const unstoredAgentDid = 'did:abt:zNeverRegisteredForEdgeFacts';
      const hire = { ...baseHire(), signedBy: `${unstoredAgentDid}#zK` };
      const jobId = 'job-edge-unstored-subject';
      await credentialRepo.save({
        completedJobId: jobId,
        subjectDid: unstoredAgentDid,
        document: rawDocument(jobId, unstoredAgentDid, hire),
      });

      const disputedRes = await fetch(`${baseUrl}/v1/credentials/${jobId}/disputed`);
      expect(disputedRes.status).toBe(200);
      const disputedBody = (await disputedRes.json()) as { disputed: boolean; windows: unknown[] };
      expect(disputedBody.disputed).toBe(false);
      expect(disputedBody.windows).toEqual([]);

      const resolveRes = await fetch(`${baseUrl}/v1/credentials/${jobId}`);
      expect(resolveRes.status).toBe(200);
      expect(resolveRes.headers.get('x-freeagents-dispute-status')).toBe('clear');
    });
  });
});
