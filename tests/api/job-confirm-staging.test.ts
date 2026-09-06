// B14a scope item 2: "if repository creation fails, confirm fails closed
// and the deposit remains recorded (it settled on chain; the job stays
// proposed with the settlement row intact and the error names the
// cause)." Every assertion here fails without that ordering: the confirm
// route must not persist a job with a null stagingRepo, and the settlement
// row confirm already read must still be there afterwards -- nothing here
// rolls it back, because nothing needed to: confirm only reads it, it
// never writes it.
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import type { GithubAdapter, CreateStagingRepositoryInput } from '../../src/adapters/github/types.js';
import {
  MemoryAgentRepository,
  MemoryAccountRepository,
  MemoryJobRepository,
  MemorySettlementRepository,
} from '../../src/adapters/storage/memory.js';
import { PrismaSettlementGate } from '../../src/adapters/payment/gate.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(221));
const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(222));

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

// Mirrors job-pull-request.test.ts's own rejectingOnPullRequest: every
// method the fixture offers is unchanged except the one this route's
// fail-closed path is being pinned against.
function rejectingOnCreateStagingRepository(github: GithubAdapter): GithubAdapter {
  return {
    ...github,
    createStagingRepository: (_input: CreateStagingRepositoryInput) =>
      Promise.reject(new Error('connection refused by github')),
  };
}

interface Started {
  readonly server: Server;
  readonly baseUrl: string;
  readonly jobRepo: MemoryJobRepository;
  readonly settlementRepo: MemorySettlementRepository;
}

async function startApp(github: GithubAdapter): Promise<Started> {
  const operatorRepo = new MemoryAccountRepository();
  await operatorRepo.register({ did: buyer.did, githubLogin: `buyer-confirm-staging-${Math.random()}` });
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: agent.did,
    operatorDid: 'did:abt:op-confirm-staging',
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: 'scout-confirm-staging',
  });
  await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-confirm-staging', status: 'verified' });
  const jobRepo = new MemoryJobRepository();
  const settlementRepo = new MemorySettlementRepository();
  const settlementGate = new PrismaSettlementGate(settlementRepo);
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
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, jobRepo, settlementRepo };
}

async function walkToPriceAccepted(baseUrl: string): Promise<string> {
  const created = await postSigned(baseUrl, '/jobs', {
    buyerDid: buyer.did,
    agentDid: agent.did,
    repository: 'buyer/confirm-staging-repo',
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

describe('POST /jobs/:jobId/confirm: fails closed when staging repository creation fails (B14a scope item 2)', () => {
  it('answers 503, logs the cause, leaves the job proposed with no staging repository, and keeps the settlement row', async () => {
    const { github } = createStagingLifecycleGithubFake();
    active = await startApp(rejectingOnCreateStagingRepository(github));
    const jobId = await walkToPriceAccepted(active.baseUrl);

    // The deposit settled on chain BEFORE confirm is ever called -- this
    // is the fact confirm's own settlement-gate check reads, and the fact
    // the card says must survive a staging-repository failure untouched.
    await active.settlementRepo.record({
      jobId,
      leg: 'deposit',
      rail: 'abt',
      hash: 'hash-deposit-1',
      secondaryHash: null,
      operatorAddress: 'z1Operator',
      feeAddress: 'z1Fee',
      amountUsd: '125.00',
      observedAt: new Date('2026-01-01T00:00:00Z'),
    });

    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const confirm = await postSigned(active.baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
      expect(confirm.status).toBe(503);
      expect(await confirm.json()).toEqual({ error: 'github unavailable' });
      expect(errorLog).toHaveBeenCalled();

      // The row never budged off proposed: no stagingRepo, no baseCommit,
      // no confirmedAt -- confirmSpec's own pure transform ran, but the
      // route never persisted its result because the github call after it
      // threw first.
      const stored = await active.jobRepo.findById(jobId);
      expect(stored?.status).toBe('proposed');
      expect(stored?.stagingRepo).toBeNull();
      expect(stored?.baseCommit).toBeNull();
      expect(stored?.confirmedAt).toBeNull();

      // And the read-back over HTTP agrees.
      const read = await fetch(`${active.baseUrl}/jobs/${jobId}`);
      const readBack = (await read.json()) as Record<string, unknown>;
      expect(readBack.status).toBe('proposed');

      // The settlement row confirm read is still exactly there: this route
      // never writes to SettlementRepository, so a github failure after
      // the read has nothing to roll back.
      const settlement = await active.settlementRepo.findByJobAndLeg(jobId, 'deposit');
      expect(settlement).not.toBeNull();
      expect(settlement?.hash).toBe('hash-deposit-1');
    } finally {
      errorLog.mockRestore();
    }
  });
});
