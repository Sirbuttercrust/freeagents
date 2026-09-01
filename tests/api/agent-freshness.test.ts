// R-37 (spec/roadmap.md, ENT-2, ENT-4): GET /agents/:agentDid carries
// lastHireCompletedAt and recordLastChangedAt as ISO dates, derived at
// read time from stored hires and the agent's own record, never entered
// by the operator and never a stored column that can drift. Same route
// R-17's agent-profile-tiers suite already pins, widened again.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import {
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
  MemoryOperatorRepository,
} from '../../src/adapters/storage/memory.js';
import type { Agent, Delegation } from '../../src/domain/agent.js';
import { DELEGATION_TYPE } from '../../src/domain/agent.js';
import type { Job } from '../../src/domain/job.js';
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
    id: `urn:uuid:delegation-freshness-${agentDid}`,
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

function jobFixture(overrides: Partial<Job> & { id: string; agentDid: string }): Job {
  return {
    buyerDid: 'did:example:freshness-buyer',
    repository: 'buyer/freshness-repo',
    brief: 'Fix the checkout flow',
    briefHash: 'sha256:brief',
    confirmedSpecHash: null,
    status: 'draft',
    criteria: [],
    pullRequestUrl: null,
    mergeCommit: null,
    mergedAt: null,
    confirmedAt: null,
    submittedAt: null,
    deadline: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function credentialDoc(id: string, subjectDid: string, mergeCommit: string, mergedAt: string): VerifiableCredential {
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
        repository: 'buyer/freshness-repo',
        pullRequest: `https://github.com/buyer/freshness-repo/pull/1`,
        mergedAt,
        mergeCommit,
        signedBy: `${subjectDid}#key-1`,
        buyer: 'did:example:freshness-buyer',
        additions: 10,
        deletions: 2,
        filesChanged: 1,
      },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zProof' },
  };
}

// Completes a job AND issues its credential in the same call, mirroring
// what the real merge route always does (src/api/app.ts's POST
// /jobs/:jobId/merge writes jobRepo.complete then credentialRepo.save for
// every merge, never one without the other). repositoryPublic controls
// which tier evidenceTier assigns the credential to (invariant 4): a
// private-repo merge demotes to portfolio, so lastHireCompletedAt (D1,
// Proof task t_28c5458e) must read this same tier boundary, not the wider
// jobRepo population alone.
async function completeJobWithCredential(
  jobRepo: MemoryJobRepository,
  credentialRepo: MemoryCredentialRepository,
  id: string,
  agentDid: string,
  mergeCommit: string,
  completedAt: Date,
  repositoryPublic: boolean,
): Promise<void> {
  const draft = jobFixture({ id, agentDid });
  await jobRepo.create(draft);
  await jobRepo.complete(
    { ...draft, status: 'completed', mergeCommit, mergedAt: completedAt },
    { jobId: id, buyerDid: draft.buyerDid, agentDid, mergeCommit, completedAt },
  );
  await credentialRepo.save({
    completedJobId: id,
    subjectDid: agentDid,
    document: credentialDoc(`urn:uuid:${id}`, agentDid, mergeCommit, completedAt.toISOString()),
    repositoryPublic,
  });
}

describe('GET /agents/:agentDid, freshness (R-37)', () => {
  let server: Server;
  let baseUrl: string;
  const agentRepo = new MemoryAgentRepository();
  const jobRepo = new MemoryJobRepository();
  const credentialRepo = new MemoryCredentialRepository();
  const operatorDid = 'did:abt:zOperatorFreshness';

  const coldDid = 'did:abt:zAgentFreshnessCold';
  const hiredDid = 'did:abt:zAgentFreshnessHired';
  const privateOnlyDid = 'did:abt:zAgentFreshnessPrivateOnly';

  beforeAll(async () => {
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
    server = await listen(app);
    baseUrl = `http://127.0.0.1:${portOf(server)}`;

    const coldRow: Agent = await agentRepo.create({
      did: coldDid,
      operatorDid,
      delegation: delegation(coldDid, operatorDid),
      name: 'cold-agent',
      skills: ['triage'],
      githubLogin: null,
    });
    expect(coldRow.did).toBe(coldDid);

    await agentRepo.create({
      did: hiredDid,
      operatorDid,
      delegation: delegation(hiredDid, operatorDid),
      name: 'hired-agent',
      skills: ['triage'],
      githubLogin: null,
    });
    await completeJobWithCredential(
      jobRepo,
      credentialRepo,
      'freshness-job-1',
      hiredDid,
      'freshcafe1',
      new Date('2026-02-01T00:00:00.000Z'),
      true,
    );
    await completeJobWithCredential(
      jobRepo,
      credentialRepo,
      'freshness-job-2',
      hiredDid,
      'freshcafe2',
      new Date('2026-05-01T00:00:00.000Z'),
      true,
    );

    // D1 (Proof, task t_28c5458e): an agent whose only completed hire merged
    // into a private repository. evidenceTier demotes it to portfolio, so
    // verifiedHires stays empty for this agent even though jobRepo carries a
    // completed job dated 2026-07-04. lastHireCompletedAt must not read past
    // that tier boundary.
    await agentRepo.create({
      did: privateOnlyDid,
      operatorDid,
      delegation: delegation(privateOnlyDid, operatorDid),
      name: 'private-only-agent',
      skills: ['triage'],
      githubLogin: null,
    });
    await completeJobWithCredential(
      jobRepo,
      credentialRepo,
      'freshness-job-private',
      privateOnlyDid,
      'freshprivate1',
      new Date('2026-07-04T00:00:00.000Z'),
      false,
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('an agent with no completed hire renders lastHireCompletedAt as null, honestly, not hidden', async () => {
    const res = await fetch(`${baseUrl}/agents/${coldDid}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.lastHireCompletedAt).toBeNull();
  });

  it('a cold-start agent still carries recordLastChangedAt as an ISO date (its own creation)', async () => {
    const res = await fetch(`${baseUrl}/agents/${coldDid}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.recordLastChangedAt).toBe('string');
    expect(Number.isNaN(Date.parse(String(body.recordLastChangedAt)))).toBe(false);
  });

  it('lastHireCompletedAt is the MOST RECENT completed hire, derived from stored job data', async () => {
    const res = await fetch(`${baseUrl}/agents/${hiredDid}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.lastHireCompletedAt).toBe('2026-05-01T00:00:00.000Z');
  });

  it('recordLastChangedAt moves when a new hire completes, proving it is derived, not a stored constant', async () => {
    const before = await fetch(`${baseUrl}/agents/${hiredDid}`);
    const beforeBody = (await before.json()) as Record<string, unknown>;
    const beforeChanged = String(beforeBody.recordLastChangedAt);

    // Dated well past this test's own run instant, so the new hire is
    // unambiguously the latest fact in the record regardless of how far
    // in real time the agent's own createdAt landed relative to the
    // earlier 2026-02/2026-05 fixture dates.
    await completeJobWithCredential(
      jobRepo,
      credentialRepo,
      'freshness-job-3',
      hiredDid,
      'freshcafe3',
      new Date('2099-01-01T00:00:00.000Z'),
      true,
    );

    const after = await fetch(`${baseUrl}/agents/${hiredDid}`);
    const afterBody = (await after.json()) as Record<string, unknown>;
    expect(afterBody.lastHireCompletedAt).toBe('2099-01-01T00:00:00.000Z');
    expect(afterBody.recordLastChangedAt).toBe('2099-01-01T00:00:00.000Z');
    expect(afterBody.recordLastChangedAt).not.toBe(beforeChanged);
  });

  it('both dates are ISO-8601 strings, not epoch numbers or Date objects', async () => {
    const res = await fetch(`${baseUrl}/agents/${hiredDid}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.lastHireCompletedAt).toBe('string');
    expect(typeof body.recordLastChangedAt).toBe('string');
  });

  it('lastHireCompletedAt is null for an agent whose only completed hire is a private-repo merge, matching its empty verified-hire tier (D1)', async () => {
    const res = await fetch(`${baseUrl}/agents/${privateOnlyDid}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // The tier this date is supposed to sit beside is empty: a merge into a
    // private repository never reaches verified-hire (invariant 4).
    expect(body.verifiedHires).toEqual([]);
    // The blocker Proof reported: this must not read July 4 out of the
    // wider, tier-blind findCompletedByAgent population.
    expect(body.lastHireCompletedAt).toBeNull();
  });
});
