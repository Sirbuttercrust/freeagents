// P4: the payment gates on confirm and pull-request, plus the stage and
// staged-decline routes. Every assertion here fails without: the
// SettlementGate param on createApp, the 402 gate in front of confirm,
// the 402 gate in front of pull-request (before the fork call), and the
// two new routes.
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { MemorySettlementGate } from '../../src/adapters/payment/gate.js';
import {
  MemoryAgentRepository,
  MemoryJobRepository,
  MemoryAccountRepository,
} from '../../src/adapters/storage/memory.js';
import type { GithubAdapter, OpenStagedPullRequestInput, PullRequestRef } from '../../src/adapters/github/types.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';

const AGENT_GITHUB_LOGIN = 'scout-payment-gate';
const proposal = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
];

function fakeGithub(recorded: OpenStagedPullRequestInput[]): GithubAdapter {
  const { github: staging } = createStagingLifecycleGithubFake();
  return {
    ...staging,
    openStagedPullRequest: (input) => {
      recorded.push(input);
      const ref: PullRequestRef = { owner: input.sourceOwner, repo: input.sourceRepo, number: 1 };
      return Promise.resolve(ref);
    },
  };
}

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

async function startApp(settlementGate: MemorySettlementGate, github?: GithubAdapter) {
  const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(101));
  const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(102));
  const operatorRepo = new MemoryAccountRepository();
  await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-payment-gate' });
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: agent.did,
    operatorDid: 'did:abt:op-payment-gate',
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: AGENT_GITHUB_LOGIN,
  });
  await agentRepo.updateGithubBinding(agent.did, { handle: AGENT_GITHUB_LOGIN, status: 'verified' });
  const jobRepo = new MemoryJobRepository();
  const forkCalls: OpenStagedPullRequestInput[] = [];
  const app = createApp(
    operatorRepo,
    agentRepo,
    undefined,
    github ?? fakeGithub(forkCalls),
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
    anyCommitStagingObserver(),
  );
  // Bound explicitly to 127.0.0.1 (not the dual-stack default): on a
  // dev machine with other fixed-port daemons bound to 127.0.0.1, a
  // dual-stack listen(0) can be handed a port number that daemon
  // already owns, and this test's own fetch to that port is then free
  // to be routed to either listener by the OS (diagnose-flaky-server-
  // port-tests skill). Matches the baseUrl this function already builds.
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, baseUrl, buyer, agent, forkCalls };
}

async function walkToConfirmed(
  baseUrl: string,
  buyer: SigningIdentity,
  agent: SigningIdentity,
): Promise<string> {
  const created = await postSigned(baseUrl, '/jobs', {
    buyerDid: buyer.did,
    agentDid: agent.did,
    repository: 'buyer/target-repo',
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

describe('confirm is gated on the deposit (P4, anchor)', () => {
  let server: Server;
  let baseUrl: string;
  let buyer: SigningIdentity;
  let agent: SigningIdentity;
  let gate: MemorySettlementGate;

  beforeAll(async () => {
    gate = new MemorySettlementGate();
    ({ server, baseUrl, buyer, agent } = await startApp(gate));
  });

  afterAll(() => server.close());

  it('refuses confirm with 402 when the deposit is unsettled, naming what the buyer must pay', async () => {
    const created = await postSigned(baseUrl, '/jobs', {
      buyerDid: buyer.did,
      agentDid: agent.did,
      repository: 'buyer/target-repo',
      brief: 'A job nobody paid a deposit on',
    }, buyer);
    const jobId = String(((await created.json()) as Record<string, unknown>).id);
    await postSigned(baseUrl, `/jobs/${jobId}/criteria`, { criteria: proposal, priceUsd: '500.00', rail: 'abt' }, agent);
    await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, buyer);
    await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agent);
    await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, buyer);
    await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agent);
    await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, buyer);
    await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, agent);

    const confirm = await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
    expect(confirm.status).toBe(402);
    const body = (await confirm.json()) as Record<string, unknown>;
    expect(body.error).toBeDefined();
    // What the buyer must pay: the deposit amount, computed from the
    // agreed price and the fixed deposit percent.
    expect(body.depositUsd).toBe('125.00');

    // The job never budged: still proposed, no specHash.
    const read = await (await fetch(`${baseUrl}/jobs/${jobId}`)).json() as Record<string, unknown>;
    expect(read.status).toBe('proposed');
  });

  it('the 409 criteria/price gates still fire before the 402 money gate', async () => {
    // A fresh draft with no price at all: the existing 409 criteria path
    // must answer first, exactly as the brief requires ("a caller sees
    // the agreement problems first, the money problem last").
    const created = await postSigned(baseUrl, '/jobs', {
      buyerDid: buyer.did,
      agentDid: agent.did,
      repository: 'buyer/target-repo',
      brief: 'A fresh draft',
    }, buyer);
    const jobId = String(((await created.json()) as Record<string, unknown>).id);
    const confirm = await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
    expect(confirm.status).toBe(409);
  });

  it('allows confirm once the deposit is settled', async () => {
    const jobId = await walkToConfirmed(baseUrl, buyer, agent);
    gate.markDepositSettled(jobId);
    const confirm = await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
    expect(confirm.status).toBe(200);
    const body = (await confirm.json()) as Record<string, unknown>;
    expect(body.status).toBe('confirmed');
  });
});

describe('pull-request is gated on the balance, before any fork call (P4, anchor)', () => {
  it('refuses with 402 when the balance is unsettled, and fires github zero times', async () => {
    const gate = new MemorySettlementGate();
    const { server, baseUrl, buyer, agent, forkCalls } = await startApp(gate);
    try {
      const jobId = await walkToConfirmed(baseUrl, buyer, agent);
      gate.markDepositSettled(jobId);
      const confirm = await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
      expect(confirm.status).toBe(200);

      // Stage the work (a later section of this file drives the stage
      // route itself; here it is a precondition for reaching pull-request
      // at all under the new table, confirmed -> staged -> submitted).
      const stage = await postSigned(baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'abc123def' }, agent);
      expect(stage.status).toBe(200);

      const before = forkCalls.length;
      const pr = await postSigned(baseUrl, `/jobs/${jobId}/pull-request`, {}, agent);
      expect(pr.status).toBe(402);
      const body = (await pr.json()) as Record<string, unknown>;
      expect(body.error).toBeDefined();
      expect(forkCalls.length).toBe(before);

      const read = await (await fetch(`${baseUrl}/jobs/${jobId}`)).json() as Record<string, unknown>;
      expect(read.status).toBe('staged');
    } finally {
      server.close();
    }
  });

  it('allows pull-request once the balance is settled, and fires github exactly once', async () => {
    const gate = new MemorySettlementGate();
    const { server, baseUrl, buyer, agent, forkCalls } = await startApp(gate);
    try {
      const jobId = await walkToConfirmed(baseUrl, buyer, agent);
      gate.markDepositSettled(jobId);
      await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
      await postSigned(baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'abc123def' }, agent);
      gate.markBalanceSettled(jobId);

      const pr = await postSigned(baseUrl, `/jobs/${jobId}/pull-request`, {}, agent);
      expect(pr.status).toBe(200);
      expect(forkCalls.length).toBe(1);
      const body = (await pr.json()) as Record<string, unknown>;
      expect(body.status).toBe('submitted');
    } finally {
      server.close();
    }
  });
});

describe('stage route: only the agent stages, confirmed -> staged (P4)', () => {
  it('the agent stages a confirmed job, stamping stagedCommit and stagedAt', async () => {
    const gate = alwaysSettledGate();
    const { server, baseUrl, buyer, agent } = await startApp(gate as MemorySettlementGate);
    try {
      const jobId = await walkToConfirmed(baseUrl, buyer, agent);
      await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
      const stage = await postSigned(baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-sha-1' }, agent);
      expect(stage.status).toBe(200);
      const body = (await stage.json()) as Record<string, unknown>;
      expect(body.status).toBe('staged');
    } finally {
      server.close();
    }
  });

  it('refuses the buyer: only the agent may stage', async () => {
    const gate = alwaysSettledGate();
    const { server, baseUrl, buyer, agent } = await startApp(gate as MemorySettlementGate);
    try {
      const jobId = await walkToConfirmed(baseUrl, buyer, agent);
      await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
      const stage = await postSigned(baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-sha-1' }, buyer);
      expect(stage.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('refuses to stage a job that is not confirmed (409)', async () => {
    const gate = alwaysSettledGate();
    const { server, baseUrl, buyer, agent } = await startApp(gate as MemorySettlementGate);
    try {
      const created = await postSigned(baseUrl, '/jobs', {
        buyerDid: buyer.did,
        agentDid: agent.did,
        repository: 'buyer/target-repo',
        brief: 'A fresh draft',
      }, buyer);
      const jobId = String(((await created.json()) as Record<string, unknown>).id);
      const stage = await postSigned(baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-sha-1' }, agent);
      expect(stage.status).toBe(409);
    } finally {
      server.close();
    }
  });
});

describe('staged-decline route: buyer only, staged -> staged_declined, free (P4)', () => {
  it('the buyer declines staged work for free, terminally', async () => {
    const gate = alwaysSettledGate();
    const { server, baseUrl, buyer, agent } = await startApp(gate as MemorySettlementGate);
    try {
      const jobId = await walkToConfirmed(baseUrl, buyer, agent);
      await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
      await postSigned(baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-sha-1' }, agent);

      const decline = await postSigned(baseUrl, `/jobs/${jobId}/staged-decline`, {}, buyer);
      expect(decline.status).toBe(200);
      const body = (await decline.json()) as Record<string, unknown>;
      expect(body.status).toBe('staged_declined');
    } finally {
      server.close();
    }
  });

  it('refuses the agent: only the buyer may decline at staged', async () => {
    const gate = alwaysSettledGate();
    const { server, baseUrl, buyer, agent } = await startApp(gate as MemorySettlementGate);
    try {
      const jobId = await walkToConfirmed(baseUrl, buyer, agent);
      await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
      await postSigned(baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-sha-1' }, agent);

      const decline = await postSigned(baseUrl, `/jobs/${jobId}/staged-decline`, {}, agent);
      expect(decline.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('refuses to decline a job that is not staged (409)', async () => {
    const gate = alwaysSettledGate();
    const { server, baseUrl, buyer, agent } = await startApp(gate as MemorySettlementGate);
    try {
      const jobId = await walkToConfirmed(baseUrl, buyer, agent);
      await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
      const decline = await postSigned(baseUrl, `/jobs/${jobId}/staged-decline`, {}, buyer);
      expect(decline.status).toBe(409);
    } finally {
      server.close();
    }
  });
});
