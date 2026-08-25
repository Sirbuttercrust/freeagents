// R-17 (ENT-2.4, ENT-11.5, MISSION invariant 5): GET /agents/:agentDid/profile
// assembles the three evidence tiers from storage. This file proves the
// route's own contract - counts, shapes, the 404/503 legs every route on
// this surface takes, and that one agent never sees another's hires. The
// "nothing blends the tiers" acceptance criterion lives in
// profile-invariant2.test.ts, mirroring how credential-resolve.test.ts and
// its own invariant2 file split the same way.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

import { afterAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createCredentialResolver } from '../../src/adapters/credentials/credentials.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';
import {
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryOperatorRepository,
} from '../../src/adapters/storage/memory.js';
import type { AgentRepository, CredentialRepository } from '../../src/adapters/storage/types.js';

// Generic identifiers only (public repository).
const OPERATOR_DID = 'did:abt:op-profile';
const AGENT_DID = 'did:abt:agent-profile';
const OTHER_AGENT_DID = 'did:abt:agent-profile-other';

// The response shape this file asserts against, narrow enough for property
// access without `any`. profile-invariant2.test.ts pins the full contract.
interface ProfileBody {
  readonly agent: { readonly did: string };
  readonly evidence: {
    readonly verifiedHire: {
      readonly tier: string;
      readonly label: string;
      readonly count: number;
      readonly items: readonly { readonly credentialPath: string; readonly jobId: string }[];
    };
    readonly verifiedPriorWork: { readonly tier: string; readonly label: string; readonly count: number; readonly items: readonly unknown[] };
    readonly portfolio: { readonly tier: string; readonly label: string; readonly count: number; readonly items: readonly unknown[] };
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

async function registerAgent(agentRepo: MemoryAgentRepository, did: string): Promise<void> {
  await agentRepo.create({
    did,
    operatorDid: OPERATOR_DID,
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: null,
  });
}

// A stored credential document, shaped like the one createCredentialsAdapter
// issues. No real signature: this file asserts the route's own contract, not
// that the proof verifies (profile-invariant2.test.ts owns that).
function creditedDocument(subjectDid: string, completedJobId: string): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: 'did:abt:platform',
    credentialSubject: {
      id: subjectDid,
      jobId: completedJobId,
      pullRequestUrl: `https://github.com/buyer/target-repo/pull/${completedJobId}`,
      mergeCommitSha: `sha-${completedJobId}`,
      mergedAt: '2026-08-21T12:00:00.000Z',
      diffAdditions: 1,
      diffDeletions: 0,
      specHash: 'sha256:spec',
      filesChanged: 1,
      repository: 'buyer/target-repo',
      signedBy: `${subjectDid}#${completedJobId}`,
      buyerDid: 'did:abt:buyer-profile',
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zfixture' },
  };
}

async function start(
  credentialRepo: CredentialRepository,
  agentRepo: MemoryAgentRepository = new MemoryAgentRepository(),
): Promise<{ server: Server; baseUrl: string }> {
  const app = createApp(
    new MemoryOperatorRepository(),
    agentRepo,
    undefined,
    undefined,
    undefined,
    createCredentialResolver(credentialRepo),
    credentialRepo,
  );
  const server = await listen(app);
  return { server, baseUrl: `http://127.0.0.1:${portOf(server)}` };
}

describe('GET /agents/:agentDid/profile', () => {
  const servers: Server[] = [];

  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  });

  it('a stored credential renders as one verified hire', async () => {
    const credentialRepo = new MemoryCredentialRepository();
    await credentialRepo.save({
      completedJobId: 'job-profile-1',
      subjectDid: AGENT_DID,
      document: creditedDocument(AGENT_DID, 'job-profile-1'),
    });
    const agentRepo = new MemoryAgentRepository();
    await registerAgent(agentRepo, AGENT_DID);
    const { server, baseUrl } = await start(credentialRepo, agentRepo);
    servers.push(server);

    const res = await fetch(`${baseUrl}/agents/${AGENT_DID}/profile`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProfileBody;

    expect(body.evidence.verifiedHire.count).toBe(1);
    expect(body.evidence.verifiedHire.items).toHaveLength(1);
    const item = body.evidence.verifiedHire.items[0];
    expect(item?.credentialPath).toBe('/v1/credentials/job-profile-1');
    expect(item?.jobId).toBe('job-profile-1');
    expect(body.agent.did).toBe(AGENT_DID);
  });

  it('the linked credentialPath actually resolves, as application/ld+json', async () => {
    const credentialRepo = new MemoryCredentialRepository();
    await credentialRepo.save({
      completedJobId: 'job-profile-2',
      subjectDid: AGENT_DID,
      document: creditedDocument(AGENT_DID, 'job-profile-2'),
    });
    const agentRepo = new MemoryAgentRepository();
    await registerAgent(agentRepo, AGENT_DID);
    const { server, baseUrl } = await start(credentialRepo, agentRepo);
    servers.push(server);

    const profileRes = await fetch(`${baseUrl}/agents/${AGENT_DID}/profile`);
    const body = (await profileRes.json()) as ProfileBody;
    const credentialPath = body.evidence.verifiedHire.items[0]?.credentialPath;

    const linked = await fetch(`${baseUrl}${credentialPath}`);
    expect(linked.status).toBe(200);
    expect(String(linked.headers.get('content-type')).startsWith('application/ld+json')).toBe(true);
  });

  it('zeros render as zeros for an agent with no credentials', async () => {
    const credentialRepo = new MemoryCredentialRepository();
    const agentRepo = new MemoryAgentRepository();
    await registerAgent(agentRepo, AGENT_DID);
    const { server, baseUrl } = await start(credentialRepo, agentRepo);
    servers.push(server);

    const res = await fetch(`${baseUrl}/agents/${AGENT_DID}/profile`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProfileBody;

    expect(body.evidence.verifiedHire).toEqual({
      tier: 'verified-hire',
      label: 'Verified hire',
      count: 0,
      items: [],
    });
    expect(body.evidence.verifiedPriorWork).toEqual({
      tier: 'verified-prior-work',
      label: 'Verified prior work',
      count: 0,
      items: [],
    });
    expect(body.evidence.portfolio).toEqual({
      tier: 'portfolio',
      label: 'Portfolio claim',
      count: 0,
      items: [],
    });
    // No promotional or "new agent" framing anywhere in the body (ENT-2.4, D1).
    const raw = JSON.stringify(body);
    expect(/new|badge|featured/i.test(raw)).toBe(false);
  });

  it('returns 404 for an unknown agent DID', async () => {
    const credentialRepo = new MemoryCredentialRepository();
    const { server, baseUrl } = await start(credentialRepo);
    servers.push(server);

    const res = await fetch(`${baseUrl}/agents/did:abt:never-registered/profile`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('returns 503 when the credential store fails', async () => {
    const failing: CredentialRepository = {
      save: () => {
        throw new Error('storage down');
      },
      findByDocumentId: () => {
        throw new Error('storage down');
      },
      listBySubjectDid: () => {
        throw new Error('storage down');
      },
    };
    const agentRepo = new MemoryAgentRepository();
    await registerAgent(agentRepo, AGENT_DID);
    const { server, baseUrl } = await start(failing, agentRepo);
    servers.push(server);

    const res = await fetch(`${baseUrl}/agents/${AGENT_DID}/profile`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'storage unavailable' });
  });

  it('returns 503 when the agent lookup fails', async () => {
    const failing: AgentRepository = {
      create: () => {
        throw new Error('storage down');
      },
      findByDid: () => {
        throw new Error('storage down');
      },
      updateGithubBinding: () => {
        throw new Error('storage down');
      },
      recordKeyRotation: () => {
        throw new Error('storage down');
      },
    };
    const credentialRepo = new MemoryCredentialRepository();
    const app = createApp(
      new MemoryOperatorRepository(),
      failing,
      undefined,
      undefined,
      undefined,
      createCredentialResolver(credentialRepo),
      credentialRepo,
    );
    const server = await listen(app);
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${portOf(server)}`;

    const res = await fetch(`${baseUrl}/agents/${AGENT_DID}/profile`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'storage unavailable' });
  });

  it('two agents do not see each other\'s hires', async () => {
    const credentialRepo = new MemoryCredentialRepository();
    await credentialRepo.save({
      completedJobId: 'job-profile-mine',
      subjectDid: AGENT_DID,
      document: creditedDocument(AGENT_DID, 'job-profile-mine'),
    });
    await credentialRepo.save({
      completedJobId: 'job-profile-theirs',
      subjectDid: OTHER_AGENT_DID,
      document: creditedDocument(OTHER_AGENT_DID, 'job-profile-theirs'),
    });
    const agentRepo = new MemoryAgentRepository();
    await registerAgent(agentRepo, AGENT_DID);
    await registerAgent(agentRepo, OTHER_AGENT_DID);
    const { server, baseUrl } = await start(credentialRepo, agentRepo);
    servers.push(server);

    const mine = await fetch(`${baseUrl}/agents/${AGENT_DID}/profile`);
    const mineBody = (await mine.json()) as ProfileBody;
    expect(mineBody.evidence.verifiedHire.count).toBe(1);
    expect(mineBody.evidence.verifiedHire.items[0]?.jobId).toBe('job-profile-mine');

    const theirs = await fetch(`${baseUrl}/agents/${OTHER_AGENT_DID}/profile`);
    const theirsBody = (await theirs.json()) as ProfileBody;
    expect(theirsBody.evidence.verifiedHire.count).toBe(1);
    expect(theirsBody.evidence.verifiedHire.items[0]?.jobId).toBe('job-profile-theirs');
  });
});
