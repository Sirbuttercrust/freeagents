// R-17 (ENT-8, ENT-2.4): GET /agents/:agentDid extends its response with the
// agent's work record as three separately labelled tiers, computed at read
// time from src/domain/agent-work-record.ts. No route was added: this is
// the same GET /agents/:agentDid the R-2 agent-invariant2 suite already
// pins, widened.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { renderAvatar } from '../../src/api/avatar.js';
import { MemoryAgentRepository, MemoryCredentialRepository } from '../../src/adapters/storage/memory.js';
import type { Agent, Delegation } from '../../src/domain/agent.js';
import { DELEGATION_TYPE } from '../../src/domain/agent.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';

function listen(app: Express): Promise<Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}

function portOf(srv: Server): number {
  return (srv.address() as AddressInfo).port;
}

function delegation(agentDid: string, operatorDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-tiers-test',
    type: ['VerifiableCredential', DELEGATION_TYPE],
    issuer: operatorDid,
    issuanceDate: new Date().toISOString(),
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: new Date().toISOString(),
      verificationMethod: `${operatorDid}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zProof',
    },
  };
}

function credentialDoc(id: string, subjectDid: string): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id,
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: 'did:abt:platform',
    validFrom: '2026-01-03T00:00:00.000Z',
    credentialSubject: {
      id: subjectDid,
      hire: {
        brief: 'sha256:brief',
        repository: 'buyer/target-repo',
        pullRequest: 'https://github.com/buyer/target-repo/pull/1',
        mergedAt: '2026-01-03T00:00:00.000Z',
        mergeCommit: 'deadbeef',
        signedBy: `${subjectDid}#key-1`,
        buyer: 'did:example:buyer',
        additions: 1,
        deletions: 1,
        filesChanged: 1,
      },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zProof' },
  };
}

describe('GET /agents/:agentDid, three-tier work record (R-17)', () => {
  let server: Server;
  let baseUrl: string;
  const agentRepo = new MemoryAgentRepository();
  const credentialRepo = new MemoryCredentialRepository();
  const agentDid = 'did:abt:zAgentTiers';
  const operatorDid = 'did:abt:zOperatorTiers';

  beforeAll(async () => {
    const app = createApp(undefined, agentRepo, undefined, undefined, undefined, undefined, undefined, credentialRepo);
    server = await listen(app);
    baseUrl = `http://127.0.0.1:${portOf(server)}`;

    const row: Agent = await agentRepo.create({
      did: agentDid,
      operatorDid,
      delegation: delegation(agentDid, operatorDid),
      name: 'tiers-agent',
      skills: ['triage'],
      githubLogin: null,
    });
    expect(row.did).toBe(agentDid);

    await credentialRepo.save({
      completedJobId: 'job-tiers-1',
      subjectDid: agentDid,
      document: credentialDoc('https://platform.example/v1/credentials/job-tiers-1', agentDid),
      repositoryPublic: true,
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('carries verifiedHires, verifiedPriorWork, and portfolio as three separate arrays', async () => {
    const res = await fetch(`${baseUrl}/agents/${agentDid}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.verifiedHires).toEqual([
      {
        credentialId: 'https://platform.example/v1/credentials/job-tiers-1',
        repository: 'buyer/target-repo',
        pullRequest: 'https://github.com/buyer/target-repo/pull/1',
        mergedAt: '2026-01-03T00:00:00.000Z',
        mergeCommit: 'deadbeef',
        buyerDid: 'did:example:buyer',
      },
    ]);
    expect(body.verifiedPriorWork).toEqual([]);
    expect(body.portfolio).toEqual([]);
  });

  it('the base agent fields are unchanged (avatar, key rotations, etc.)', async () => {
    const res = await fetch(`${baseUrl}/agents/${agentDid}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.avatar).toBe(renderAvatar(agentDid));
    expect(body.did).toBe(agentDid);
  });

  it('no field on the response is derived from more than one tier: item 2 of the issue, asserted structurally', async () => {
    const res = await fetch(`${baseUrl}/agents/${agentDid}`);
    const body = (await res.json()) as Record<string, unknown>;

    const verifiedHires = body.verifiedHires as unknown[];
    const verifiedPriorWork = body.verifiedPriorWork as unknown[];
    const portfolio = body.portfolio as unknown[];

    // The only numbers a client can read off this response that could ever
    // be a "combined score" are ones equal to a sum of two or more tier
    // counts. A field with such a value is exactly the thing item 2
    // forbids: a total, an average expressed as a ratio, or a sort key
    // derived from more than one tier. This walks every numeric value
    // anywhere on the response body (not a fixed field name), so a future
    // field added ANYWHERE in the response, at any nesting depth, trips
    // this assertion if its value happens to equal such a sum.
    const tierCounts = [verifiedHires.length, verifiedPriorWork.length, portfolio.length];
    const forbiddenSums = new Set<number>();
    for (let i = 0; i < tierCounts.length; i += 1) {
      for (let j = i + 1; j < tierCounts.length; j += 1) {
        forbiddenSums.add((tierCounts[i] ?? 0) + (tierCounts[j] ?? 0));
      }
    }
    forbiddenSums.add(tierCounts.reduce((a, b) => a + b, 0));
    // Zero is excluded: every empty tier trivially sums to zero, and a
    // legitimate unrelated zero elsewhere (an empty keyRotations count, if
    // one ever appeared as a number) must not be flagged as a violation.
    forbiddenSums.delete(0);

    function numericFields(value: unknown, path: string): Array<{ path: string; value: number }> {
      if (typeof value === 'number') return [{ path, value }];
      if (Array.isArray(value)) {
        return value.flatMap((entry, i) => numericFields(entry, `${path}[${i}]`));
      }
      if (value !== null && typeof value === 'object') {
        return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
          numericFields(entry, path === '' ? key : `${path}.${key}`),
        );
      }
      return [];
    }

    for (const { path, value } of numericFields(body, '')) {
      // A field inside one of the three tier arrays is that tier's own
      // data (a diffAdditions-style count on one item), not a cross-tier
      // derivation, so those paths are exempt from the forbidden-sum check.
      if (path.startsWith('verifiedHires[') || path.startsWith('verifiedPriorWork[') || path.startsWith('portfolio[')) {
        continue;
      }
      expect(forbiddenSums.has(value), `field '${path}' = ${value} equals a sum of two tiers' counts`).toBe(false);
    }
  });

  it("an agent with no credentials renders three empty tiers, not an absence (ENT-2.4)", async () => {
    const emptyAgentDid = 'did:abt:zAgentEmptyTiers';
    await agentRepo.create({
      did: emptyAgentDid,
      operatorDid,
      delegation: delegation(emptyAgentDid, operatorDid),
      name: 'empty-agent',
      skills: [],
      githubLogin: null,
    });

    const res = await fetch(`${baseUrl}/agents/${emptyAgentDid}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.verifiedHires).toEqual([]);
    expect(body.verifiedPriorWork).toEqual([]);
    expect(body.portfolio).toEqual([]);
  });

  it('a platform-brokered merge into a PRIVATE repository does not reach the verified-hire tier (invariant 4)', async () => {
    const privateAgentDid = 'did:abt:zAgentPrivateRepo';
    await agentRepo.create({
      did: privateAgentDid,
      operatorDid,
      delegation: delegation(privateAgentDid, operatorDid),
      name: 'private-repo-agent',
      skills: [],
      githubLogin: null,
    });
    await credentialRepo.save({
      completedJobId: 'job-private-1',
      subjectDid: privateAgentDid,
      document: credentialDoc('https://platform.example/v1/credentials/job-private-1', privateAgentDid),
      repositoryPublic: false,
    });

    const res = await fetch(`${baseUrl}/agents/${privateAgentDid}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.verifiedHires).toEqual([]);
    expect((body.portfolio as unknown[]).length).toBe(1);
  });

  it('follows the verified hire\'s credential id through the resolver and gets the document back', async () => {
    const res = await fetch(`${baseUrl}/agents/${agentDid}`);
    const body = (await res.json()) as Record<string, unknown>;
    const hire = (body.verifiedHires as Array<Record<string, unknown>>)[0];
    expect(hire).toBeDefined();
    const credentialId = String(hire?.credentialId);

    const resolved = await fetch(credentialId.replace(/^https?:\/\/[^/]+/, baseUrl));
    expect(resolved.status).toBe(200);
    const doc = (await resolved.json()) as VerifiableCredential;
    expect(doc.id).toBe(credentialId);
    expect(doc.credentialSubject.id).toBe(agentDid);
  });

  it('returns 404 for an unregistered agent', async () => {
    const res = await fetch(`${baseUrl}/agents/did:abt:znobody`);
    expect(res.status).toBe(404);
  });
});
