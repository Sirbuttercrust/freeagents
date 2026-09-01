// R-19 (D4, ENT-1.2): GET /accounts/:did/agents, the operator roster.
// Widens the same browse-card assembly R-20 built (src/domain/browse.ts,
// src/domain/agent-work-record.ts): a roster row carries the exact same
// three tier counts a browse card does for the same agent, read the same
// way, so the two surfaces cannot drift. The aggregate rides beside the
// roster, derived structurally from the SAME rows (src/domain/operator-
// roster.ts), never a caller-supplied total drawn from a wider population.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import {
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
  MemoryAccountRepository,
} from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';

const OPERATOR_DID = 'did:abt:zRosterOperator';
const OTHER_OPERATOR_DID = 'did:abt:zRosterOtherOperator';

function delegation(agentDid: string, operatorDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:roster-${agentDid}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-08-30T00:00:00.000Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-08-30T00:00:00.000Z',
      verificationMethod: `${operatorDid}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zProof',
    },
  };
}

function credentialDoc(
  id: string,
  subjectDid: string,
  mergeCommit: string,
  mergedAt: string,
  buyerDid = 'did:example:buyer',
): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id,
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
        mergeCommit,
        signedBy: `${subjectDid}#key-1`,
        buyer: buyerDid,
        additions: 1,
        deletions: 1,
        filesChanged: 1,
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

function portOf(server: Server): number {
  return (server.address() as AddressInfo).port;
}

async function withApp(app: Express, run: (url: string) => Promise<void>): Promise<void> {
  const server = await listen(app);
  try {
    await run(`http://127.0.0.1:${portOf(server)}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

interface Rig {
  app: Express;
  agentRepo: MemoryAgentRepository;
  credentialRepo: MemoryCredentialRepository;
  operatorRepo: MemoryAccountRepository;
}

function buildApp(): Rig {
  const operatorRepo = new MemoryAccountRepository();
  const agentRepo = new MemoryAgentRepository();
  const credentialRepo = new MemoryCredentialRepository();
  const jobRepo = new MemoryJobRepository();
  const app = createApp(operatorRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, credentialRepo);
  return { app, agentRepo, credentialRepo, operatorRepo };
}

async function registerOperator(operatorRepo: MemoryAccountRepository, did: string, githubLogin: string): Promise<void> {
  await operatorRepo.register({ did, githubLogin });
}

async function registerAgent(
  agentRepo: MemoryAgentRepository,
  did: string,
  operatorDid: string,
  name: string,
): Promise<void> {
  await agentRepo.create({
    did,
    operatorDid,
    delegation: delegation(did, operatorDid),
    name,
    skills: ['triage'],
    githubLogin: null,
  });
}

describe('GET /accounts/:did/agents (R-19 roster)', () => {
  it('404s for an operator that was never registered', async () => {
    const { app } = buildApp();
    await withApp(app, async (url) => {
      const res = await fetch(`${url}/accounts/did:abt:zNeverRegistered/agents`);
      expect(res.status).toBe(404);
    });
  });

  it('an operator running zero agents renders an honest empty roster (ENT-2.4)', async () => {
    const { app, operatorRepo } = buildApp();
    await registerOperator(operatorRepo, OPERATOR_DID, 'roster-operator');

    await withApp(app, async (url) => {
      const res = await fetch(`${url}/accounts/${OPERATOR_DID}/agents`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { agents: unknown[]; aggregate: Record<string, number> };
      expect(body.agents).toEqual([]);
      expect(body.aggregate).toEqual({
        totalVerifiedHireCount: 0,
        totalVerifiedPriorWorkCount: 0,
        totalPortfolioCount: 0,
      });
    });
  });

  it('lists only the agents delegated from this operator, never another operator\'s', async () => {
    const { app, operatorRepo, agentRepo } = buildApp();
    await registerOperator(operatorRepo, OPERATOR_DID, 'roster-operator');
    await registerOperator(operatorRepo, OTHER_OPERATOR_DID, 'roster-other-operator');
    await registerAgent(agentRepo, 'did:abt:zRosterMine', OPERATOR_DID, 'mine');
    await registerAgent(agentRepo, 'did:abt:zRosterTheirs', OTHER_OPERATOR_DID, 'theirs');

    await withApp(app, async (url) => {
      const res = await fetch(`${url}/accounts/${OPERATOR_DID}/agents`);
      const body = (await res.json()) as { agents: Array<{ did: string }> };
      expect(body.agents.map((a) => a.did)).toEqual(['did:abt:zRosterMine']);
    });
  });

  it('a single-agent operator sees the same roster shape as a multi-agent one, one row', async () => {
    const { app, operatorRepo, agentRepo } = buildApp();
    await registerOperator(operatorRepo, OPERATOR_DID, 'roster-operator');
    await registerAgent(agentRepo, 'did:abt:zRosterSolo', OPERATOR_DID, 'solo');

    await withApp(app, async (url) => {
      const res = await fetch(`${url}/accounts/${OPERATOR_DID}/agents`);
      const body = (await res.json()) as { agents: Array<{ did: string; verifiedHireCount: number }> };
      expect(body.agents).toHaveLength(1);
      expect(body.agents[0]?.did).toBe('did:abt:zRosterSolo');
    });
  });

  it('a roster row carries the same tier counts browse shows for the same agent (no drift)', async () => {
    const { app, operatorRepo, agentRepo, credentialRepo } = buildApp();
    await registerOperator(operatorRepo, OPERATOR_DID, 'roster-operator');
    await registerAgent(agentRepo, 'did:abt:zRosterMatch', OPERATOR_DID, 'match');
    await credentialRepo.save({
      completedJobId: 'job-roster-public',
      subjectDid: 'did:abt:zRosterMatch',
      document: credentialDoc('https://platform.example/v1/credentials/job-roster-public', 'did:abt:zRosterMatch', 'c-public', '2026-08-01T00:00:00.000Z'),
      repositoryPublic: true,
    });
    await credentialRepo.save({
      completedJobId: 'job-roster-private',
      subjectDid: 'did:abt:zRosterMatch',
      document: credentialDoc('https://platform.example/v1/credentials/job-roster-private', 'did:abt:zRosterMatch', 'c-private', '2026-08-02T00:00:00.000Z'),
      repositoryPublic: false,
    });

    await withApp(app, async (url) => {
      const browseRes = await fetch(`${url}/agents`);
      const browseBody = (await browseRes.json()) as {
        agents: Array<{ did: string; verifiedHireCount: number; verifiedPriorWorkCount: number; portfolioCount: number; buyerCount: number }>;
      };
      const browseCard = browseBody.agents.find((a) => a.did === 'did:abt:zRosterMatch');
      expect(browseCard).toBeDefined();

      const rosterRes = await fetch(`${url}/accounts/${OPERATOR_DID}/agents`);
      const rosterBody = (await rosterRes.json()) as {
        agents: Array<{ did: string; verifiedHireCount: number; verifiedPriorWorkCount: number; portfolioCount: number; buyerCount: number }>;
      };
      const rosterRow = rosterBody.agents.find((a) => a.did === 'did:abt:zRosterMatch');
      expect(rosterRow).toBeDefined();

      expect(rosterRow?.verifiedHireCount).toBe(browseCard?.verifiedHireCount);
      expect(rosterRow?.verifiedPriorWorkCount).toBe(browseCard?.verifiedPriorWorkCount);
      expect(rosterRow?.portfolioCount).toBe(browseCard?.portfolioCount);
      expect(rosterRow?.buyerCount).toBe(browseCard?.buyerCount);
      expect(rosterRow?.verifiedHireCount).toBe(1);
      expect(rosterRow?.portfolioCount).toBe(1);
    });
  });

  it('the aggregate is per tier, summed across every agent in the roster, never blended', async () => {
    const { app, operatorRepo, agentRepo, credentialRepo } = buildApp();
    await registerOperator(operatorRepo, OPERATOR_DID, 'roster-operator');
    await registerAgent(agentRepo, 'did:abt:zRosterAggA', OPERATOR_DID, 'agg-a');
    await registerAgent(agentRepo, 'did:abt:zRosterAggB', OPERATOR_DID, 'agg-b');

    await credentialRepo.save({
      completedJobId: 'job-agg-a-1',
      subjectDid: 'did:abt:zRosterAggA',
      document: credentialDoc('https://platform.example/v1/credentials/job-agg-a-1', 'did:abt:zRosterAggA', 'c-agg-a-1', '2026-08-01T00:00:00.000Z'),
      repositoryPublic: true,
    });
    await credentialRepo.save({
      completedJobId: 'job-agg-a-2',
      subjectDid: 'did:abt:zRosterAggA',
      document: credentialDoc('https://platform.example/v1/credentials/job-agg-a-2', 'did:abt:zRosterAggA', 'c-agg-a-2', '2026-08-02T00:00:00.000Z'),
      repositoryPublic: false,
    });
    await credentialRepo.save({
      completedJobId: 'job-agg-b-1',
      subjectDid: 'did:abt:zRosterAggB',
      document: credentialDoc('https://platform.example/v1/credentials/job-agg-b-1', 'did:abt:zRosterAggB', 'c-agg-b-1', '2026-08-03T00:00:00.000Z'),
      repositoryPublic: true,
    });

    await withApp(app, async (url) => {
      const res = await fetch(`${url}/accounts/${OPERATOR_DID}/agents`);
      const body = (await res.json()) as { aggregate: { totalVerifiedHireCount: number; totalVerifiedPriorWorkCount: number; totalPortfolioCount: number } };
      // Agent A: 1 verified hire, 1 portfolio. Agent B: 1 verified hire.
      // Total: 2 verified hires, 0 prior work, 1 portfolio, three separate
      // figures, never combined into one score.
      expect(body.aggregate.totalVerifiedHireCount).toBe(2);
      expect(body.aggregate.totalVerifiedPriorWorkCount).toBe(0);
      expect(body.aggregate.totalPortfolioCount).toBe(1);
    });
  });

  // Proof round 3, D4: mutation M5 (aggregate computed over the FILTERED
  // rows instead of the full roster) left every test in this file green.
  // A skill filter that removes agent B from view must not also remove
  // agent B's hire from the aggregate: the aggregate names the FULL
  // roster, always, whether or not a filter is active.
  it('a skill filter narrows the visible rows but never the aggregate, which stays full-roster (D4)', async () => {
    const { app, operatorRepo, agentRepo, credentialRepo } = buildApp();
    await registerOperator(operatorRepo, OPERATOR_DID, 'roster-operator');
    await agentRepo.create({
      did: 'did:abt:zRosterFilterA',
      operatorDid: OPERATOR_DID,
      delegation: delegation('did:abt:zRosterFilterA', OPERATOR_DID),
      name: 'filter-a',
      skills: ['python'],
      githubLogin: null,
    });
    await agentRepo.create({
      did: 'did:abt:zRosterFilterB',
      operatorDid: OPERATOR_DID,
      delegation: delegation('did:abt:zRosterFilterB', OPERATOR_DID),
      name: 'filter-b',
      skills: ['rust'],
      githubLogin: null,
    });
    await credentialRepo.save({
      completedJobId: 'job-filter-a',
      subjectDid: 'did:abt:zRosterFilterA',
      document: credentialDoc('https://platform.example/v1/credentials/job-filter-a', 'did:abt:zRosterFilterA', 'c-filter-a', '2026-08-01T00:00:00.000Z'),
      repositoryPublic: true,
    });

    await withApp(app, async (url) => {
      const filtered = await fetch(`${url}/accounts/${OPERATOR_DID}/agents?skill=rust`);
      const body = (await filtered.json()) as {
        agents: Array<{ did: string }>;
        aggregate: { totalVerifiedHireCount: number };
      };
      // Only agent B (rust) is on screen, but agent A's verified hire
      // still counts toward the aggregate: it is over the full roster.
      expect(body.agents.map((a) => a.did)).toEqual(['did:abt:zRosterFilterB']);
      expect(body.aggregate.totalVerifiedHireCount).toBe(1);
    });
  });

  // Proof round 3, D1: the client cannot know whether it is looking at the
  // full roster or a filtered slice from body.agents.length alone. A
  // filtered roster must still tell the page the FULL size, so the page
  // can gate its own controls on the unfiltered count rather than the
  // count of rows currently on screen.
  it('reports the full roster size alongside a filtered, narrower agents array (D1)', async () => {
    const { app, operatorRepo, agentRepo } = buildApp();
    await registerOperator(operatorRepo, OPERATOR_DID, 'roster-operator');
    for (let i = 0; i < 11; i += 1) {
      const did = `did:abt:zRosterSizeAgent${i}`;
      await agentRepo.create({
        did,
        operatorDid: OPERATOR_DID,
        delegation: delegation(did, OPERATOR_DID),
        name: `size-${i}`,
        skills: i < 6 ? ['python'] : ['rust'],
        githubLogin: null,
      });
    }

    await withApp(app, async (url) => {
      const res = await fetch(`${url}/accounts/${OPERATOR_DID}/agents?skill=rust`);
      const body = (await res.json()) as { agents: unknown[]; agentCount: number };
      expect(body.agents.length).toBe(5);
      expect(body.agentCount).toBe(11);
    });
  });

  it('the response never carries a combined score, reputation number, or ranking field', async () => {
    const { app, operatorRepo, agentRepo, credentialRepo } = buildApp();
    await registerOperator(operatorRepo, OPERATOR_DID, 'roster-operator');
    await registerAgent(agentRepo, 'did:abt:zRosterNoScore', OPERATOR_DID, 'no-score');
    await credentialRepo.save({
      completedJobId: 'job-no-score',
      subjectDid: 'did:abt:zRosterNoScore',
      document: credentialDoc('https://platform.example/v1/credentials/job-no-score', 'did:abt:zRosterNoScore', 'c-no-score', '2026-08-01T00:00:00.000Z'),
      repositoryPublic: true,
    });

    await withApp(app, async (url) => {
      const res = await fetch(`${url}/accounts/${OPERATOR_DID}/agents`);
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['agentCount', 'agents', 'aggregate', 'operatorDid'].sort());
      expect(Object.keys(body.aggregate as object).sort()).toEqual(
        ['totalVerifiedHireCount', 'totalVerifiedPriorWorkCount', 'totalPortfolioCount'].sort(),
      );
    });
  });
});
