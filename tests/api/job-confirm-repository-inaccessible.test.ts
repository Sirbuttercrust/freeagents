// ORG1: a GitHub 404/403 reading the buyer's repository at confirm time
// means the platform cannot see it -- most commonly a personal-account
// private repository, where GitHub offers no read-only role. Before this
// card, confirm's single catch-all around the github calls answered 503
// "github unavailable" for this exact case, indistinguishable from a real
// outage. This suite pins the split: RepositoryNotAccessibleError (thrown
// by github.getDefaultBranchHead, see
// tests/adapters/github/github-staging.test.ts) answers 409 with a
// message the buyer can act on; every other failure from that same call
// still answers 503, unchanged (see job-confirm-staging.test.ts, which
// this suite deliberately does not duplicate).
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import type { GithubAdapter, StagingRepoRef } from '../../src/adapters/github/types.js';
import { RepositoryNotAccessibleError } from '../../src/adapters/github/types.js';
import {
  MemoryAgentRepository,
  MemoryAccountRepository,
  MemoryJobRepository,
} from '../../src/adapters/storage/memory.js';
import { createStagingLifecycleGithubFake, PLATFORM_LOGIN } from '../helpers/github-staging-fixtures.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(241));
const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(242));

const proposal = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
];

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

// Mirrors job-confirm-staging.test.ts's own rejectingOnCreateStagingRepository:
// every method the fixture offers is unchanged except the one this route's
// two error branches are being pinned against.
function rejectingOnGetDefaultBranchHead(github: GithubAdapter, err: Error): GithubAdapter {
  return {
    ...github,
    getDefaultBranchHead: (_ref: StagingRepoRef) => Promise.reject(err),
  };
}

interface Started {
  readonly server: Server;
  readonly baseUrl: string;
  readonly jobRepo: MemoryJobRepository;
}

async function startApp(github: GithubAdapter): Promise<Started> {
  const operatorRepo = new MemoryAccountRepository();
  await operatorRepo.register({ did: buyer.did, githubLogin: `buyer-confirm-repo-inaccessible-${Math.random()}` });
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: agent.did,
    operatorDid: 'did:abt:op-confirm-repo-inaccessible',
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: 'scout-confirm-repo-inaccessible',
    negotiatesOnOwnersBehalf: true,
  });
  await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-confirm-repo-inaccessible', status: 'verified' });
  const jobRepo = new MemoryJobRepository();
  const settlementGate = alwaysSettledGate();
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
    settlementGate,
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, jobRepo };
}

async function walkToPriceAccepted(baseUrl: string, repository: string): Promise<string> {
  const created = await postSigned(baseUrl, '/jobs', {
    buyerDid: buyer.did,
    agentDid: agent.did,
    repository,
    brief: 'Fix the login bug',
  }, buyer);
  const jobId = String(((await created.json()) as Record<string, unknown>).id);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria`, { criteria: proposal, priceUsd: '500.00', rail: 'abt' }, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, agent);
  return jobId;
}

let active: Started | null = null;
afterEach(async () => {
  if (active !== null) {
    await new Promise<void>((resolve) => active!.server.close(() => resolve()));
    active = null;
  }
});

describe('POST /jobs/:jobId/confirm: a repository the platform cannot see (ORG1)', () => {
  it('answers 409 with an actionable message on RepositoryNotAccessibleError, never 503', async () => {
    const { github } = createStagingLifecycleGithubFake();
    active = await startApp(
      rejectingOnGetDefaultBranchHead(github, new RepositoryNotAccessibleError('buyer', 'private-repo', 404)),
    );
    const jobId = await walkToPriceAccepted(active.baseUrl, 'buyer/private-repo');

    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const confirm = await postSigned(active.baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
      expect(confirm.status).toBe(409);
      const body = (await confirm.json()) as { error: string };
      expect(body.error.toLowerCase()).toContain('cannot see this repository');
      expect(body.error.toLowerCase()).toContain('organization');
      expect(body.error.toLowerCase()).toContain('read access');

      // The row never budged off proposed: a state conflict, not a write.
      const stored = await active.jobRepo.findById(jobId);
      expect(stored?.status).toBe('proposed');
      expect(stored?.stagingRepo).toBeNull();
    } finally {
      errorLog.mockRestore();
    }
  });

  // ORG1 r2 fix (QA defect 1): confirm's own read of the buyer's
  // repository runs on the platform's token, not the agent's, so the
  // message a buyer acts on has to name the platform's own GitHub login
  // as well as the agent's -- naming only the agent sends the buyer to
  // grant read to an account that was never going to make confirm work.
  it('the 409 message names BOTH the agent account and the platform account that need read', async () => {
    const { github } = createStagingLifecycleGithubFake();
    active = await startApp(
      rejectingOnGetDefaultBranchHead(github, new RepositoryNotAccessibleError('buyer', 'private-repo', 404)),
    );
    const jobId = await walkToPriceAccepted(active.baseUrl, 'buyer/private-repo');

    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const confirm = await postSigned(active.baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
      expect(confirm.status).toBe(409);
      const body = (await confirm.json()) as { error: string };
      expect(body.error).toContain('scout-confirm-repo-inaccessible');
      expect(body.error).toContain(PLATFORM_LOGIN);
    } finally {
      errorLog.mockRestore();
    }
  });

  it('the 409 message ends with the walkthrough page address for this job, on the deployment\'s public origin', async () => {
    const { github } = createStagingLifecycleGithubFake();
    active = await startApp(
      rejectingOnGetDefaultBranchHead(github, new RepositoryNotAccessibleError('buyer', 'private-repo', 404)),
    );
    const jobId = await walkToPriceAccepted(active.baseUrl, 'buyer/private-repo');

    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previous = process.env.FREEAGENTS_PUBLIC_BASE_URL;
    // A trailing slash on purpose: the address is built by
    // publicBaseUrlFromEnv, which strips it, so a hand-rolled join would
    // show up here as a double slash.
    process.env.FREEAGENTS_PUBLIC_BASE_URL = 'https://org1b.example/';
    try {
      const confirm = await postSigned(active.baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
      expect(confirm.status).toBe(409);
      const body = (await confirm.json()) as { error: string };
      expect(body.error.endsWith(`https://org1b.example/private-repos?job=${encodeURIComponent(jobId)}`), body.error).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.FREEAGENTS_PUBLIC_BASE_URL;
      else process.env.FREEAGENTS_PUBLIC_BASE_URL = previous;
      errorLog.mockRestore();
    }
  });

  it('answers 409 the same way on a 403 (an org repository never shared with the platform account)', async () => {
    const { github } = createStagingLifecycleGithubFake();
    active = await startApp(
      rejectingOnGetDefaultBranchHead(github, new RepositoryNotAccessibleError('some-org', 'private-repo', 403)),
    );
    const jobId = await walkToPriceAccepted(active.baseUrl, 'some-org/private-repo');

    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const confirm = await postSigned(active.baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
      expect(confirm.status).toBe(409);
    } finally {
      errorLog.mockRestore();
    }
  });

  it('still answers 503 for a real outage (connection refused), the RepositoryNotAccessibleError branch does not swallow it', async () => {
    const { github } = createStagingLifecycleGithubFake();
    active = await startApp(rejectingOnGetDefaultBranchHead(github, new Error('connection refused by github')));
    const jobId = await walkToPriceAccepted(active.baseUrl, 'buyer/outage-repo');

    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const confirm = await postSigned(active.baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
      expect(confirm.status).toBe(503);
      expect(await confirm.json()).toEqual({ error: 'github unavailable' });
    } finally {
      errorLog.mockRestore();
    }
  });
});
