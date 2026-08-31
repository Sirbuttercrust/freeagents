// R-20 (ENT-2.2, D1): GET /agents, the browse listing. Assembles R-17's
// three-tier work record (agent-work-record.ts) into browse cards
// (domain/browse.ts), the same "route delegates, domain decides" split
// GET /agents/:agentDid already keeps. No parallel endpoint: this widens
// the one list-shaped read the page needs, the way R-17 widened
// GET /agents/:agentDid rather than adding a second route. buyerCount is
// derived by toBrowseCard itself from the verified-hire tier alone, so this
// route (and this test file) never reads job history.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import {
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
  MemoryOperatorRepository,
} from '../../src/adapters/storage/memory.js';
import type { AgentRepository, JobRepository } from '../../src/adapters/storage/types.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';

const OPERATOR_DID = 'did:abt:zBrowseOperator';

function delegation(agentDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:browse-${agentDid}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: OPERATOR_DID,
    issuanceDate: '2026-08-30T00:00:00.000Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-08-30T00:00:00.000Z',
      verificationMethod: `${OPERATOR_DID}#key-1`,
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
  jobRepo: MemoryJobRepository;
}

function buildApp(): Rig {
  const agentRepo = new MemoryAgentRepository();
  const credentialRepo = new MemoryCredentialRepository();
  const jobRepo = new MemoryJobRepository();
  const app = createApp(
    new MemoryOperatorRepository(),
    agentRepo,
    undefined,
    undefined,
    jobRepo,
    undefined,
    undefined,
    credentialRepo,
  );
  return { app, agentRepo, credentialRepo, jobRepo };
}

async function registerAgent(
  agentRepo: MemoryAgentRepository,
  did: string,
  name: string,
  skills: string[],
  createdAt = new Date('2026-08-01T00:00:00Z'),
): Promise<void> {
  await agentRepo.create({
    did,
    operatorDid: OPERATOR_DID,
    delegation: delegation(did),
    name,
    skills,
    githubLogin: null,
  });
  void createdAt; // MemoryAgentRepository stamps createdAt itself; kept for readability at call sites.
}

describe('GET /agents (R-20 browse)', () => {
  it('200 with an empty list when no agents are registered', async () => {
    const { app } = buildApp();
    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { agents: unknown[] };
      expect(body.agents).toEqual([]);
    });
  });

  it('default order is verified hires, descending (D1), with no sort parameter supplied', async () => {
    const { app, agentRepo, credentialRepo } = buildApp();
    await registerAgent(agentRepo, 'did:abt:zLow', 'low', ['triage']);
    await registerAgent(agentRepo, 'did:abt:zHigh', 'high', ['triage']);
    await registerAgent(agentRepo, 'did:abt:zMid', 'mid', ['triage']);

    await credentialRepo.save({
      completedJobId: 'job-low',
      subjectDid: 'did:abt:zLow',
      document: credentialDoc('https://platform.example/v1/credentials/job-low', 'did:abt:zLow', 'c-low', '2026-08-02T00:00:00.000Z'),
      repositoryPublic: true,
    });
    for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) {
      await credentialRepo.save({
        completedJobId: `job-high-${id}`,
        subjectDid: 'did:abt:zHigh',
        document: credentialDoc(`https://platform.example/v1/credentials/job-high-${id}`, 'did:abt:zHigh', `c-high-${id}`, `2026-08-0${i + 3}T00:00:00.000Z`),
        repositoryPublic: true,
      });
    }
    for (const id of ['a', 'b']) {
      await credentialRepo.save({
        completedJobId: `job-mid-${id}`,
        subjectDid: 'did:abt:zMid',
        document: credentialDoc(`https://platform.example/v1/credentials/job-mid-${id}`, 'did:abt:zMid', `c-mid-${id}`, '2026-08-05T00:00:00.000Z'),
        repositoryPublic: true,
      });
    }

    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sort: string; agents: Array<{ did: string; verifiedHireCount: number }> };
      expect(body.sort).toBe('verified-hires');
      expect(body.agents.map((a) => a.did)).toEqual(['did:abt:zHigh', 'did:abt:zMid', 'did:abt:zLow']);
      expect(body.agents.map((a) => a.verifiedHireCount)).toEqual([4, 2, 1]);
    });
  });

  it('sort is a query parameter: ?sort=recently-listed reorders by listing date', async () => {
    const { app, agentRepo } = buildApp();
    await registerAgent(agentRepo, 'did:abt:zOld', 'old', []);
    // createdAt is driver-stamped at registration time (memory.ts), so a
    // real gap is what separates "old" from "new" here, the same way a
    // second real listing would.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await registerAgent(agentRepo, 'did:abt:zNew', 'new', []);

    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents?sort=recently-listed`);
      const body = (await res.json()) as { sort: string; agents: Array<{ did: string }> };
      expect(body.sort).toBe('recently-listed');
      expect(body.agents.map((a) => a.did)).toEqual(['did:abt:zNew', 'did:abt:zOld']);
    });
  });

  it('sort is a query parameter: ?sort=recently-verified reorders by the latest verified hire', async () => {
    const { app, agentRepo, credentialRepo } = buildApp();
    await registerAgent(agentRepo, 'did:abt:zStale', 'stale', []);
    await registerAgent(agentRepo, 'did:abt:zFresh', 'fresh', []);
    await credentialRepo.save({
      completedJobId: 'job-stale',
      subjectDid: 'did:abt:zStale',
      document: credentialDoc('https://platform.example/v1/credentials/job-stale', 'did:abt:zStale', 'c-stale', '2026-01-01T00:00:00.000Z'),
      repositoryPublic: true,
    });
    await credentialRepo.save({
      completedJobId: 'job-fresh',
      subjectDid: 'did:abt:zFresh',
      document: credentialDoc('https://platform.example/v1/credentials/job-fresh', 'did:abt:zFresh', 'c-fresh', '2026-08-01T00:00:00.000Z'),
      repositoryPublic: true,
    });

    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents?sort=recently-verified`);
      const body = (await res.json()) as { agents: Array<{ did: string }> };
      expect(body.agents.map((a) => a.did)).toEqual(['did:abt:zFresh', 'did:abt:zStale']);
    });
  });

  it('an unknown sort value falls back to the default rather than erroring or inventing one', async () => {
    const { app, agentRepo } = buildApp();
    await registerAgent(agentRepo, 'did:abt:zA', 'a', []);

    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents?sort=most-popular`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sort: string };
      expect(body.sort).toBe('verified-hires');
    });
  });

  it('no popularity or upvote sort exists: those values also fall back to the default', async () => {
    const { app } = buildApp();
    await withApp(app, async (url) => {
      for (const bogus of ['popularity', 'upvotes', 'trending', 'stars']) {
        const res = await fetch(`${url}/agents?sort=${bogus}`);
        const body = (await res.json()) as { sort: string };
        expect(body.sort).toBe('verified-hires');
      }
    });
  });

  it('the evidence row is on the card: three separately labelled counts, never a sum', async () => {
    const { app, agentRepo, credentialRepo } = buildApp();
    await registerAgent(agentRepo, 'did:abt:zEvidence', 'evidence', ['triage']);
    await credentialRepo.save({
      completedJobId: 'job-public',
      subjectDid: 'did:abt:zEvidence',
      document: credentialDoc('https://platform.example/v1/credentials/job-public', 'did:abt:zEvidence', 'c-public', '2026-08-01T00:00:00.000Z'),
      repositoryPublic: true,
    });
    await credentialRepo.save({
      completedJobId: 'job-private',
      subjectDid: 'did:abt:zEvidence',
      document: credentialDoc('https://platform.example/v1/credentials/job-private', 'did:abt:zEvidence', 'c-private', '2026-08-02T00:00:00.000Z'),
      repositoryPublic: false,
    });

    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents`);
      const body = (await res.json()) as {
        agents: Array<{
          verifiedHireCount: number;
          verifiedPriorWorkCount: number;
          portfolioCount: number;
        }>;
      };
      const card = body.agents[0];
      expect(card?.verifiedHireCount).toBe(1);
      expect(card?.verifiedPriorWorkCount).toBe(0);
      // The private-repo merge demotes to portfolio (invariant 4), same as
      // the profile page.
      expect(card?.portfolioCount).toBe(1);
    });
  });

  it('buyer diversity rides the verified count: "N verified hires, M buyers"', async () => {
    const { app, agentRepo, credentialRepo } = buildApp();
    await registerAgent(agentRepo, 'did:abt:zBuyers', 'buyers', []);
    await credentialRepo.save({
      completedJobId: 'job-b1',
      subjectDid: 'did:abt:zBuyers',
      document: credentialDoc('https://platform.example/v1/credentials/job-b1', 'did:abt:zBuyers', 'c-b1', '2026-08-01T00:00:00.000Z', 'did:example:buyer-a'),
      repositoryPublic: true,
    });
    await credentialRepo.save({
      completedJobId: 'job-b2',
      subjectDid: 'did:abt:zBuyers',
      document: credentialDoc('https://platform.example/v1/credentials/job-b2', 'did:abt:zBuyers', 'c-b2', '2026-08-02T00:00:00.000Z', 'did:example:buyer-b'),
      repositoryPublic: true,
    });

    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents`);
      const body = (await res.json()) as { agents: Array<{ verifiedHireCount: number; buyerCount: number }> };
      const card = body.agents[0];
      expect(card?.verifiedHireCount).toBe(2);
      expect(card?.buyerCount).toBe(2);
    });
  });

  // Proof's exact reproduction (t_698205aa, summary-contradicts-tier): an
  // agent with one PUBLIC merge (buyer-a, verified) and two PRIVATE merges
  // (buyers b and c, portfolio) used to render "1 verified hire, 3 buyers"
  // because buyerCount was computed over every completed job regardless of
  // tier. It must now render "1 verified hire, 1 buyer": buyerCount rides
  // the same population as verifiedHireCount.
  it('an agent with public and private merges never shows a buyer count wider than its verified-hire population', async () => {
    const { app, agentRepo, credentialRepo } = buildApp();
    await registerAgent(agentRepo, 'did:abt:zDivergentApi', 'divergent', []);
    await credentialRepo.save({
      completedJobId: 'job-public',
      subjectDid: 'did:abt:zDivergentApi',
      document: credentialDoc('https://platform.example/v1/credentials/job-public', 'did:abt:zDivergentApi', 'c-public', '2026-08-01T00:00:00.000Z', 'did:example:buyer-a'),
      repositoryPublic: true,
    });
    await credentialRepo.save({
      completedJobId: 'job-private-1',
      subjectDid: 'did:abt:zDivergentApi',
      document: credentialDoc('https://platform.example/v1/credentials/job-private-1', 'did:abt:zDivergentApi', 'c-private-1', '2026-08-02T00:00:00.000Z', 'did:example:buyer-b'),
      repositoryPublic: false,
    });
    await credentialRepo.save({
      completedJobId: 'job-private-2',
      subjectDid: 'did:abt:zDivergentApi',
      document: credentialDoc('https://platform.example/v1/credentials/job-private-2', 'did:abt:zDivergentApi', 'c-private-2', '2026-08-03T00:00:00.000Z', 'did:example:buyer-c'),
      repositoryPublic: false,
    });

    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents`);
      const body = (await res.json()) as { agents: Array<{ verifiedHireCount: number; portfolioCount: number; buyerCount: number }> };
      const card = body.agents[0];
      expect(card?.verifiedHireCount).toBe(1);
      expect(card?.portfolioCount).toBe(2);
      expect(card?.buyerCount).toBe(1);
    });
  });

  it('top-bar filtering by skill narrows the list without changing the active sort order', async () => {
    const { app, agentRepo, credentialRepo } = buildApp();
    await registerAgent(agentRepo, 'did:abt:zTs', 'ts-agent', ['typescript']);
    await registerAgent(agentRepo, 'did:abt:zPy', 'py-agent', ['python']);
    // The python agent has more verified hires, but the filter should keep
    // only the typescript agent, and ordering among the survivors is still
    // by the active sort (verified-hires), not by filter match order.
    for (const id of ['a', 'b', 'c']) {
      await credentialRepo.save({
        completedJobId: `job-py-${id}`,
        subjectDid: 'did:abt:zPy',
        document: credentialDoc(`https://platform.example/v1/credentials/job-py-${id}`, 'did:abt:zPy', `c-py-${id}`, '2026-08-01T00:00:00.000Z'),
        repositoryPublic: true,
      });
    }

    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents?skill=typescript`);
      const body = (await res.json()) as { agents: Array<{ did: string }> };
      expect(body.agents.map((a) => a.did)).toEqual(['did:abt:zTs']);
    });
  });

  it('a cold-start agent (zero everything) appears in the list, ordered honestly, never buried or boosted', async () => {
    const { app, agentRepo, credentialRepo } = buildApp();
    await registerAgent(agentRepo, 'did:abt:zEstablished', 'established', []);
    await registerAgent(agentRepo, 'did:abt:zCold', 'cold', []);
    await credentialRepo.save({
      completedJobId: 'job-established',
      subjectDid: 'did:abt:zEstablished',
      document: credentialDoc('https://platform.example/v1/credentials/job-established', 'did:abt:zEstablished', 'c-est', '2026-08-01T00:00:00.000Z'),
      repositoryPublic: true,
    });

    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents`);
      const body = (await res.json()) as {
        agents: Array<{ did: string; verifiedHireCount: number; verifiedPriorWorkCount: number; portfolioCount: number; buyerCount: number }>;
      };
      const cold = body.agents.find((a) => a.did === 'did:abt:zCold');
      expect(cold).toBeDefined();
      expect(cold?.verifiedHireCount).toBe(0);
      expect(cold?.verifiedPriorWorkCount).toBe(0);
      expect(cold?.portfolioCount).toBe(0);
      expect(cold?.buyerCount).toBe(0);
      // Sorted last on its own honest merit under the default sort, not
      // dropped from the list and not reordered to hide it.
      expect(body.agents.map((a) => a.did)).toEqual(['did:abt:zEstablished', 'did:abt:zCold']);
    });
  });

  // Proof (t_698205aa, defect no-blend-sweep-vacuous): the original fixture
  // here was 1 verified hire (implicitly 1 buyer) and 1 portfolio item, so
  // tierCounts [1, 0, 1] made forbiddenSums {1, 2} and buyerCount 1 (now
  // derived structurally by toBrowseCard) collided with its own sum. Because
  // verifiedPriorWorkCount is 0 for every agent in this codebase today
  // (agentWorkRecord never populates it yet), verifiedHireCount + 0 is
  // always in the forbidden set, so a genuinely non-blended buyerCount must
  // be LESS than verifiedHireCount to avoid a false collision. This fixture
  // uses three verified hires from two distinct buyers (buyerCount 2, not
  // 3) plus one portfolio item, so the forbidden set {1, 3, 4} cannot
  // coincidentally catch buyerCount and the sweep is exercised for real.
  it('a structural sweep: no numeric field on the response is derived from more than one tier', async () => {
    const { app, agentRepo, credentialRepo } = buildApp();
    await registerAgent(agentRepo, 'did:abt:zStructural', 'structural', ['triage']);
    await credentialRepo.save({
      completedJobId: 'job-structural-hire-1',
      subjectDid: 'did:abt:zStructural',
      document: credentialDoc(
        'https://platform.example/v1/credentials/job-structural-hire-1',
        'did:abt:zStructural',
        'c-structural-1',
        '2026-08-01T00:00:00.000Z',
        'did:example:buyer-x',
      ),
      repositoryPublic: true,
    });
    await credentialRepo.save({
      completedJobId: 'job-structural-hire-2',
      subjectDid: 'did:abt:zStructural',
      document: credentialDoc(
        'https://platform.example/v1/credentials/job-structural-hire-2',
        'did:abt:zStructural',
        'c-structural-2',
        '2026-08-02T00:00:00.000Z',
        'did:example:buyer-x',
      ),
      repositoryPublic: true,
    });
    await credentialRepo.save({
      completedJobId: 'job-structural-hire-3',
      subjectDid: 'did:abt:zStructural',
      document: credentialDoc(
        'https://platform.example/v1/credentials/job-structural-hire-3',
        'did:abt:zStructural',
        'c-structural-3',
        '2026-08-03T00:00:00.000Z',
        'did:example:buyer-y',
      ),
      repositoryPublic: true,
    });
    await credentialRepo.save({
      completedJobId: 'job-structural-portfolio',
      subjectDid: 'did:abt:zStructural',
      document: credentialDoc('https://platform.example/v1/credentials/job-structural-portfolio', 'did:abt:zStructural', 'c-structural-4', '2026-08-04T00:00:00.000Z'),
      repositoryPublic: false,
    });

    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents`);
      const body = (await res.json()) as { agents: Array<Record<string, unknown>> };
      const card = body.agents[0] as { verifiedHireCount: number; verifiedPriorWorkCount: number; portfolioCount: number; buyerCount: number };
      expect(card.verifiedHireCount).toBe(3);
      expect(card.portfolioCount).toBe(1);
      expect(card.buyerCount).toBe(2);

      const tierCounts = [card.verifiedHireCount, card.verifiedPriorWorkCount, card.portfolioCount];
      const forbiddenSums = new Set<number>();
      for (let i = 0; i < tierCounts.length; i += 1) {
        for (let j = i + 1; j < tierCounts.length; j += 1) {
          forbiddenSums.add((tierCounts[i] ?? 0) + (tierCounts[j] ?? 0));
        }
      }
      forbiddenSums.add(tierCounts.reduce((a, b) => a + b, 0));
      forbiddenSums.delete(0);
      expect(forbiddenSums).toEqual(new Set([3, 4, 1]));

      function numericFields(value: unknown, path: string): Array<{ path: string; value: number }> {
        if (typeof value === 'number') return [{ path, value }];
        if (Array.isArray(value)) return value.flatMap((entry, i) => numericFields(entry, `${path}[${i}]`));
        if (value !== null && typeof value === 'object') {
          return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
            numericFields(entry, path === '' ? key : `${path}.${key}`),
          );
        }
        return [];
      }

      for (const { path, value } of numericFields(card, '')) {
        // The three tier counts themselves are legitimate single-tier
        // facts, not derivations (mirrors agent-profile-tiers.test.ts's
        // exemption for the tier ARRAYS themselves): the sweep exists to
        // catch a FOURTH field blending two of them, not to flag the
        // counts it is built from.
        if (['verifiedHireCount', 'verifiedPriorWorkCount', 'portfolioCount'].includes(path)) continue;
        expect(forbiddenSums.has(value), `field '${path}' = ${value} equals a sum of two tiers' counts`).toBe(false);
      }
    });
  });

  // Positive control, same fixture and forbidden-sum set as the test above:
  // proves the sweep instrument itself catches a genuinely blended field
  // (Proof's reproduction added combinedEvidence and both sweeps went red).
  it('mutation proof: a card carrying a field that sums two tier counts is caught by the sweep', async () => {
    const { app, agentRepo, credentialRepo } = buildApp();
    await registerAgent(agentRepo, 'did:abt:zStructuralMutant', 'structural-mutant', ['triage']);
    await credentialRepo.save({
      completedJobId: 'job-mutant-hire-1',
      subjectDid: 'did:abt:zStructuralMutant',
      document: credentialDoc('https://platform.example/v1/credentials/job-mutant-hire-1', 'did:abt:zStructuralMutant', 'c-mutant-1', '2026-08-01T00:00:00.000Z', 'did:example:buyer-x'),
      repositoryPublic: true,
    });
    await credentialRepo.save({
      completedJobId: 'job-mutant-hire-2',
      subjectDid: 'did:abt:zStructuralMutant',
      document: credentialDoc('https://platform.example/v1/credentials/job-mutant-hire-2', 'did:abt:zStructuralMutant', 'c-mutant-2', '2026-08-02T00:00:00.000Z', 'did:example:buyer-x'),
      repositoryPublic: true,
    });
    await credentialRepo.save({
      completedJobId: 'job-mutant-hire-3',
      subjectDid: 'did:abt:zStructuralMutant',
      document: credentialDoc('https://platform.example/v1/credentials/job-mutant-hire-3', 'did:abt:zStructuralMutant', 'c-mutant-3', '2026-08-03T00:00:00.000Z', 'did:example:buyer-y'),
      repositoryPublic: true,
    });
    await credentialRepo.save({
      completedJobId: 'job-mutant-portfolio',
      subjectDid: 'did:abt:zStructuralMutant',
      document: credentialDoc('https://platform.example/v1/credentials/job-mutant-portfolio', 'did:abt:zStructuralMutant', 'c-mutant-4', '2026-08-04T00:00:00.000Z'),
      repositoryPublic: false,
    });

    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents`);
      const body = (await res.json()) as { agents: Array<Record<string, unknown>> };
      const card = body.agents[0] as { verifiedHireCount: number; verifiedPriorWorkCount: number; portfolioCount: number };
      const tierCounts = [card.verifiedHireCount, card.verifiedPriorWorkCount, card.portfolioCount];
      const forbiddenSums = new Set<number>();
      for (let i = 0; i < tierCounts.length; i += 1) {
        for (let j = i + 1; j < tierCounts.length; j += 1) {
          forbiddenSums.add((tierCounts[i] ?? 0) + (tierCounts[j] ?? 0));
        }
      }
      forbiddenSums.add(tierCounts.reduce((a, b) => a + b, 0));
      forbiddenSums.delete(0);

      const mutated = { ...card, combinedEvidence: card.verifiedHireCount + card.portfolioCount };
      const offenders: string[] = [];
      function numericFields(value: unknown, path: string): Array<{ path: string; value: number }> {
        if (typeof value === 'number') return [{ path, value }];
        if (Array.isArray(value)) return value.flatMap((entry, i) => numericFields(entry, `${path}[${i}]`));
        if (value !== null && typeof value === 'object') {
          return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
            numericFields(entry, path === '' ? key : `${path}.${key}`),
          );
        }
        return [];
      }
      for (const { path, value } of numericFields(mutated, '')) {
        if (['verifiedHireCount', 'verifiedPriorWorkCount', 'portfolioCount'].includes(path)) continue;
        if (forbiddenSums.has(value)) offenders.push(path);
      }
      expect(offenders).toContain('combinedEvidence');
    });
  });

  it('503 when the agent repository does not implement listAll', async () => {
    const stub: AgentRepository = {
      create: () => Promise.reject(new Error('unused')),
      findByDid: () => Promise.reject(new Error('unused')),
      updateGithubBinding: () => Promise.reject(new Error('unused')),
      recordKeyRotation: () => Promise.reject(new Error('unused')),
      // listAll intentionally omitted.
    };
    const app = createApp(new MemoryOperatorRepository(), stub);
    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'storage unavailable' });
    });
  });

  it('503 when the agent repository throws', async () => {
    const failing: AgentRepository = {
      create: () => Promise.reject(new Error('unused')),
      findByDid: () => Promise.reject(new Error('unused')),
      updateGithubBinding: () => Promise.reject(new Error('unused')),
      recordKeyRotation: () => Promise.reject(new Error('unused')),
      listAll: () => Promise.reject(new Error('db down')),
    };
    const app = createApp(new MemoryOperatorRepository(), failing);
    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'storage unavailable' });
    });
  });

  // Now that toBrowseCard derives buyerCount from the verified-hire tier
  // alone (never from job history), GET /agents no longer reads the job
  // repository at all. A driver missing findCompletedByAgent entirely --
  // the exact stub that used to 503 this route -- must succeed, proving
  // the dependency is genuinely gone rather than just softened.
  it('succeeds even when the job repository does not implement findCompletedByAgent, because browse no longer reads job history', async () => {
    const stubJobRepo: JobRepository = {
      create: () => Promise.reject(new Error('unused')),
      update: () => Promise.reject(new Error('unused')),
      findById: () => Promise.reject(new Error('unused')),
      complete: () => Promise.reject(new Error('unused')),
      findCompletedByJobId: () => Promise.reject(new Error('unused')),
      // findCompletedByAgent intentionally omitted.
    };
    const agentRepo = new MemoryAgentRepository();
    await registerAgent(agentRepo, 'did:abt:zNoHiresRoute', 'noop', []);
    const app = createApp(new MemoryOperatorRepository(), agentRepo, undefined, undefined, stubJobRepo);
    await withApp(app, async (url) => {
      const res = await fetch(`${url}/agents`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { agents: Array<{ did: string; buyerCount: number }> };
      expect(body.agents.map((a) => a.did)).toEqual(['did:abt:zNoHiresRoute']);
      expect(body.agents[0]?.buyerCount).toBe(0);
    });
  });
});
