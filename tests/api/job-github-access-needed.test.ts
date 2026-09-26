// ORG1 done-means item 3: the agent-facing job data names, for a private
// repository, the GitHub read access the buyer's organization must
// grant, and the account that needs it -- the agent's own VERIFIED
// GitHub login (never an unverified one, matching confirm's own
// grantPush guard, B14a). One projection key, carried by every response
// that already carries jobProjection's other fields: POST /jobs (the
// agent reads its own new job) and GET /jobs/:jobId (every party's
// live read, including the buyer walking their own repository
// decision).
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryAccountRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import { createStagingLifecycleGithubFake, PLATFORM_LOGIN } from '../helpers/github-staging-fixtures.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(251));
const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(252));

async function postSigned(baseUrl: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, 'POST', targetUri, { body: bodyText });
  return fetch(targetUri, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
    body: bodyText,
  });
}

interface Started {
  readonly server: Server;
  readonly baseUrl: string;
}

async function startApp(agentRepo: MemoryAgentRepository): Promise<Started> {
  const operatorRepo = new MemoryAccountRepository();
  await operatorRepo.register({ did: buyer.did, githubLogin: `buyer-access-needed-${Math.random()}` });
  const jobRepo = new MemoryJobRepository();
  const { github } = createStagingLifecycleGithubFake();
  const app = createApp(
    operatorRepo,
    agentRepo,
    undefined,
    github,
    jobRepo,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    alwaysSettledGate(),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe('job data names the GitHub read access needed and the account (ORG1)', () => {
  it('POST /jobs response carries githubAccessNeeded.agentGithubLogin for a verified agent', async () => {
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: 'did:abt:op-access-needed',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: 'scout-access-needed',
      negotiatesOnOwnersBehalf: true,
    });
    await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-access-needed', status: 'verified' });
    const { server, baseUrl } = await startApp(agentRepo);
    try {
      const created = await postSigned(baseUrl, '/jobs', {
        buyerDid: buyer.did,
        agentDid: agent.did,
        repository: 'buyer/access-needed-repo',
        brief: 'Fix the login bug',
      }, buyer);
      expect(created.status).toBe(201);
      const body = (await created.json()) as Record<string, unknown>;
      const access = body.githubAccessNeeded as Record<string, unknown>;
      expect(access).toBeDefined();
      expect(access.agentGithubLogin).toBe('scout-access-needed');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // ORG1 r2 fix, defect 1: confirm's own read of the buyer's repository
  // (getDefaultBranchHead) and the pull-request route's read of the PR
  // (getPullRequest) both run on the PLATFORM's single token -- never the
  // agent's. A buyer who grants read ONLY to the agent's account still
  // gets a platform account that cannot see the repository, so this
  // field has to name both accounts that need read, not just the
  // agent's. Same key (githubAccessNeeded), a second field on it.
  it('POST /jobs response also carries githubAccessNeeded.platformGithubLogin, the account confirm itself reads as', async () => {
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: 'did:abt:op-access-needed-platform',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: 'scout-access-needed-platform',
      negotiatesOnOwnersBehalf: true,
    });
    await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-access-needed-platform', status: 'verified' });
    const { server, baseUrl } = await startApp(agentRepo);
    try {
      const created = await postSigned(baseUrl, '/jobs', {
        buyerDid: buyer.did,
        agentDid: agent.did,
        repository: 'buyer/access-needed-repo-platform',
        brief: 'Fix the login bug',
      }, buyer);
      const body = (await created.json()) as Record<string, unknown>;
      const access = body.githubAccessNeeded as Record<string, unknown>;
      expect(access.platformGithubLogin).toBe(PLATFORM_LOGIN);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('GET /jobs/:jobId carries the same field on a live read', async () => {
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: 'did:abt:op-access-needed-2',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: 'scout-access-needed-2',
      negotiatesOnOwnersBehalf: true,
    });
    await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-access-needed-2', status: 'verified' });
    const { server, baseUrl } = await startApp(agentRepo);
    try {
      const created = await postSigned(baseUrl, '/jobs', {
        buyerDid: buyer.did,
        agentDid: agent.did,
        repository: 'buyer/access-needed-repo-2',
        brief: 'Fix the login bug',
      }, buyer);
      const jobId = String(((await created.json()) as Record<string, unknown>).id);

      const read = await fetch(`${baseUrl}/jobs/${jobId}`);
      expect(read.status).toBe(200);
      const readBody = (await read.json()) as Record<string, unknown>;
      const access = readBody.githubAccessNeeded as Record<string, unknown>;
      expect(access.agentGithubLogin).toBe('scout-access-needed-2');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('omits githubAccessNeeded when the agent has no verified GitHub login (nothing to name yet)', async () => {
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: 'did:abt:op-access-needed-3',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
      negotiatesOnOwnersBehalf: true,
    });
    const { server, baseUrl } = await startApp(agentRepo);
    try {
      const created = await postSigned(baseUrl, '/jobs', {
        buyerDid: buyer.did,
        agentDid: agent.did,
        repository: 'buyer/access-needed-repo-3',
        brief: 'Fix the login bug',
      }, buyer);
      expect(created.status).toBe(201);
      const body = (await created.json()) as Record<string, unknown>;
      expect(body.githubAccessNeeded).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // QA r1 defect 3 (guard-without-a-test): the earlier suite only ever
  // exercised githubLogin === null for "nothing to name yet". A login
  // that IS present but whose binding was never verified (created, no
  // updateGithubBinding call -- MemoryAgentRepository.create always
  // starts a row at proofStatus 'unverified') is a different case: this
  // pins that the proofStatus gate, not just the null check, is what
  // withholds the field. Removing `agent.proofStatus !== 'verified'`
  // from githubAccessNeededFor leaves this red (the field would appear
  // with an unverified login), which the null-only test above cannot
  // catch since it never sets a login at all.
  it('omits githubAccessNeeded when the agent has a GitHub login that is not yet verified', async () => {
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: 'did:abt:op-access-needed-unverified',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: 'scout-access-needed-unverified',
      negotiatesOnOwnersBehalf: true,
    });
    // Deliberately no updateGithubBinding call: the login is present but
    // proofStatus stays at its create-time default, 'unverified'.
    const { server, baseUrl } = await startApp(agentRepo);
    try {
      const created = await postSigned(baseUrl, '/jobs', {
        buyerDid: buyer.did,
        agentDid: agent.did,
        repository: 'buyer/access-needed-repo-unverified',
        brief: 'Fix the login bug',
      }, buyer);
      expect(created.status).toBe(201);
      const body = (await created.json()) as Record<string, unknown>;
      expect(body.githubAccessNeeded).toBeUndefined();

      const jobId = String((body as { id: unknown }).id);
      const read = await fetch(`${baseUrl}/jobs/${jobId}`);
      const readBody = (await read.json()) as Record<string, unknown>;
      expect(readBody.githubAccessNeeded).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // Once confirm has succeeded, the platform already proved it can read
  // the buyer's repository (a staging repository exists), so the access
  // question is settled and the field must not keep appearing on every
  // later read forever (job-merge.test.ts and tests/e2e/smoke.test.ts
  // both pin an EXACT projection shape on confirmed/merged/stale rows;
  // this field must not silently widen it).
  it('omits githubAccessNeeded once a staging repository exists (confirm already proved access)', async () => {
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: 'did:abt:op-access-needed-4',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: 'scout-access-needed-4',
      negotiatesOnOwnersBehalf: true,
    });
    await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-access-needed-4', status: 'verified' });
    const { server, baseUrl } = await startApp(agentRepo);
    try {
      const created = await postSigned(baseUrl, '/jobs', {
        buyerDid: buyer.did,
        agentDid: agent.did,
        repository: 'buyer/access-needed-repo-4',
        brief: 'Fix the login bug',
      }, buyer);
      const jobId = String(((await created.json()) as Record<string, unknown>).id);
      await postSigned(baseUrl, `/jobs/${jobId}/criteria`, {
        criteria: [
          { text: 'The login bug is fixed', proposedBy: 'agent' },
          { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
        ],
        priceUsd: '500.00',
        rail: 'abt',
      }, agent);
      await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, buyer);
      await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agent);
      await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, buyer);
      await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agent);
      await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, buyer);
      await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, agent);
      const confirmed = await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
      expect(confirmed.status).toBe(200);
      const confirmedBody = (await confirmed.json()) as Record<string, unknown>;
      expect(confirmedBody.stagingRepo).not.toBeNull();
      expect(confirmedBody.githubAccessNeeded).toBeUndefined();

      const read = await fetch(`${baseUrl}/jobs/${jobId}`);
      const readBody = (await read.json()) as Record<string, unknown>;
      expect(readBody.githubAccessNeeded).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
