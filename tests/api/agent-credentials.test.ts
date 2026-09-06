// B9 (launch ledger): the receipts listing every agent profile already links
// to. GET /agents/:agentDid/credentials replaces the notImplemented stub.
//
// The anchor this file exists to hold: a deemed-completion credential is not
// a hire (P6), so a document that never merged must never appear on this
// route. credentialEvidenceOf is the one narrowing every reader of
// listBySubjectDid goes through, and this route uses it rather than
// re-filtering by hand, mirroring GET /agents/:agentDid/reviews's shape:
// look the agent up first, 404 when it is not registered, then read the
// listing, and map a storage throw to 503.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryAccountRepository, MemoryCredentialRepository } from '../../src/adapters/storage/memory.js';
import type { AgentRepository, CredentialRepository } from '../../src/adapters/storage/types.js';
import type { Agent, Delegation } from '../../src/domain/agent.js';
import type { VerifiableCredential, DeemedCompletionCredential } from '../../src/adapters/credentials/types.js';

const AGENT_DID = 'did:abt:zCredentialsAgent';

const delegation: Delegation = {
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  id: 'urn:uuid:credentials-route-test',
  type: ['VerifiableCredential', 'AgentDelegation'],
  issuer: 'did:abt:zCredentialsOperator',
  issuanceDate: '2026-08-21T05:00:00.000Z',
  credentialSubject: { id: AGENT_DID },
  proof: {
    type: 'Ed25519Signature2020',
    created: '2026-08-21T05:00:00.000Z',
    verificationMethod: 'did:abt:zCredentialsOperator#zCredentialsOperator',
    proofPurpose: 'assertionMethod',
    proofValue: 'zMockProofValue',
  },
};

// A shaped fixture credential, the same stance tests/api/compromise.test.ts's
// shapedCredential and tests/api/credential-resolve.test.ts take: only the
// fields this route's projection and credentialEvidenceOf actually read.
function shapedHireCredential(subjectDid: string, jobId: string): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id: `urn:uuid:hire-${jobId}`,
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: 'did:abt:platform',
    validFrom: '2026-08-12T00:00:00.000Z',
    credentialSubject: {
      id: subjectDid,
      hire: {
        brief: 'sha256:brief',
        repository: 'buyer/target-repo',
        pullRequest: `https://github.com/buyer/target-repo/pull/${jobId}`,
        mergedAt: '2026-08-12T00:00:00.000Z',
        mergeCommit: '3f8a2c1d9e7b4a5f6c8d0e1f2a3b4c5d6e7f8a9b',
        signedBy: `${subjectDid}#zJobKey`,
        buyer: 'did:example:buyer',
        additions: 1,
        deletions: 1,
        filesChanged: 1,
      },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zProof' },
  };
}

function shapedDeemedCredential(subjectDid: string, jobId: string): DeemedCompletionCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id: `urn:uuid:deemed-${jobId}`,
    type: ['VerifiableCredential', 'DeemedCompletionCredential'],
    issuer: 'did:abt:platform',
    validFrom: '2026-08-12T00:00:00.000Z',
    credentialSubject: {
      id: subjectDid,
      deemedCompletion: {
        stagedCommit: 'staged-sha',
        noMerge: true,
        buyer: 'did:example:buyer',
      },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zProof' },
  };
}

function listen(app: Express): Promise<Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
}

function portOf(server: Server): number {
  return (server.address() as AddressInfo).port;
}

describe('GET /agents/:agentDid/credentials (B9)', () => {
  let server: Server;
  let baseUrl: string;
  const agentRepo = new MemoryAgentRepository();
  const credentialRepo = new MemoryCredentialRepository();

  beforeAll(async () => {
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:zCredentialsOperator',
      delegation,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const app = createApp(
      new MemoryAccountRepository(),
      agentRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      credentialRepo,
    );
    server = await listen(app);
    baseUrl = `http://127.0.0.1:${portOf(server)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('200: a registered agent with a hire credential gets it back, narrowed to the pinned key set', async () => {
    await credentialRepo.save({
      completedJobId: 'job-credentials-1',
      subjectDid: AGENT_DID,
      document: shapedHireCredential(AGENT_DID, 'job-credentials-1'),
      repositoryPublic: true,
    });

    const res = await fetch(`${baseUrl}/agents/${AGENT_DID}/credentials`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentDid: string; credentials: Array<Record<string, unknown>> };
    expect(body.agentDid).toBe(AGENT_DID);
    expect(body.credentials).toHaveLength(1);
    expect(body.credentials[0]).toEqual({
      credentialId: 'urn:uuid:hire-job-credentials-1',
      repository: 'buyer/target-repo',
      pullRequest: 'https://github.com/buyer/target-repo/pull/job-credentials-1',
      mergedAt: '2026-08-12T00:00:00.000Z',
      mergeCommit: '3f8a2c1d9e7b4a5f6c8d0e1f2a3b4c5d6e7f8a9b',
      buyerDid: 'did:example:buyer',
      repositoryPublic: true,
    });
    expect(Object.keys(body.credentials[0]!).sort()).toEqual(
      ['buyerDid', 'credentialId', 'mergeCommit', 'mergedAt', 'pullRequest', 'repository', 'repositoryPublic'].sort(),
    );
  });

  it('a deemed-completion credential alongside a hire credential: only the hire appears (P6, mutation proof 2)', async () => {
    const mixedAgentDid = 'did:abt:zCredentialsMixed';
    await agentRepo.create({
      did: mixedAgentDid,
      operatorDid: 'did:abt:zCredentialsOperator',
      delegation: { ...delegation, credentialSubject: { id: mixedAgentDid } },
      name: 'scout-mixed',
      skills: ['triage'],
      githubLogin: null,
    });
    await credentialRepo.save({
      completedJobId: 'job-credentials-mixed-hire',
      subjectDid: mixedAgentDid,
      document: shapedHireCredential(mixedAgentDid, 'job-credentials-mixed-hire'),
    });
    await credentialRepo.save({
      completedJobId: 'job-credentials-mixed-deemed',
      subjectDid: mixedAgentDid,
      document: shapedDeemedCredential(mixedAgentDid, 'job-credentials-mixed-deemed'),
    });

    const res = await fetch(`${baseUrl}/agents/${mixedAgentDid}/credentials`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credentials: Array<Record<string, unknown>> };
    expect(body.credentials).toHaveLength(1);
    expect(body.credentials[0]?.credentialId).toBe('urn:uuid:hire-job-credentials-mixed-hire');
  });

  it('200: a registered agent with no credentials returns an empty list, never a 404 (ENT-2.4, mutation proof 3)', async () => {
    const bareAgentDid = 'did:abt:zCredentialsBare';
    await agentRepo.create({
      did: bareAgentDid,
      operatorDid: 'did:abt:zCredentialsOperator',
      delegation: { ...delegation, credentialSubject: { id: bareAgentDid } },
      name: 'scout-bare',
      skills: ['triage'],
      githubLogin: null,
    });

    const res = await fetch(`${baseUrl}/agents/${bareAgentDid}/credentials`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agentDid: bareAgentDid, credentials: [] });
  });

  it('404: an unregistered agent DID (mutation proof 3)', async () => {
    const res = await fetch(`${baseUrl}/agents/did:abt:znobody/credentials`);
    expect(res.status).toBe(404);
  });
});

describe('GET /agents/:agentDid/credentials, storage branches', () => {
  function makeApp(overrides: {
    findByDid?: (did: string) => Promise<Agent | null>;
    credentialRepo?: CredentialRepository;
  }): Express {
    const baseAgents = new MemoryAgentRepository();
    const agentRepo: AgentRepository = {
      create: (input) => baseAgents.create(input),
      findByDid: overrides.findByDid ?? ((did) => baseAgents.findByDid(did)),
      updateGithubBinding: (did, input) => baseAgents.updateGithubBinding(did, input),
      recordKeyRotation: (did, input) => baseAgents.recordKeyRotation(did, input),
    };
    return createApp(
      new MemoryAccountRepository(),
      agentRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      overrides.credentialRepo ?? new MemoryCredentialRepository(),
    );
  }

  async function withApp(app: Express, run: (url: string) => Promise<void>): Promise<void> {
    const server = await listen(app);
    try {
      await run(`http://127.0.0.1:${portOf(server)}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('503: the agent lookup throws', async () => {
    const app = makeApp({ findByDid: () => Promise.reject(new Error('db down')) });
    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents/${AGENT_DID}/credentials`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'storage unavailable' });
    });
  });

  it('503: listBySubjectDid throws, never an empty list (mutation proof 4)', async () => {
    const failing: CredentialRepository = {
      save: () => Promise.reject(new Error('unused')),
      findByDocumentId: () => Promise.reject(new Error('unused')),
      listBySubjectDid: () => Promise.reject(new Error('db down')),
    };
    const app = makeApp({ findByDid: () => Promise.resolve({ did: AGENT_DID } as Agent), credentialRepo: failing });
    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents/${AGENT_DID}/credentials`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'storage unavailable' });
    });
  });
});
