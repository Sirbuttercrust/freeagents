// SW3-07: once a staged hire is paid in full the buyer's other two moves at
// staged are gone. The ruling is "one redo
// at staged before the balance, free decline at staged", and the domain's
// design record says the buyer has exactly three moves there: pay, redo, or
// decline for free. Paying is one of the three. These pins run on a real
// MemorySettlementGate and assert the whole refusal sentence and the job's
// status after each refusal.
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemorySettlementGate } from '../../src/adapters/payment/gate.js';
import { MemoryAccountRepository, MemoryAgentRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';

const AGENT_GITHUB_LOGIN = 'scout-staged-paid';
const PAID_DECLINE_SENTENCE =
  'This hire is paid in full, so the work can no longer be declined. The agent opens the pull request next.';
const PAID_REDO_SENTENCE =
  'This hire is paid in full, so a redo can no longer be requested. The agent opens the pull request next.';
const proposal = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
];

// A gate whose second-payment read fails once, the way a durable store does
// when it blips. Every route that loads a staged job already reads the gate
// once while loading it (the lapse clock), and that read would answer 503
// before the route's own paid check ran. So the failure is armed to skip
// that first read and throw on the next one, which is the paid check's own.
// It throws once and then answers normally, so the job can be read back.
class RemainderReadFailsGate extends MemorySettlementGate {
  private readsBeforeFailure: number | null = null;

  failAfterReads(reads: number): void {
    this.readsBeforeFailure = reads;
  }

  override async balanceSettled(jobId: string): Promise<boolean> {
    if (this.readsBeforeFailure !== null) {
      if (this.readsBeforeFailure === 0) {
        this.readsBeforeFailure = null;
        throw new Error('settlement store down');
      }
      this.readsBeforeFailure -= 1;
    }
    return super.balanceSettled(jobId);
  }
}

let buyer: SigningIdentity;
let agent: SigningIdentity;
let stranger: SigningIdentity;

async function postSigned(base: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${base}${path}`;
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

async function postUnsigned(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function startApp(gate: MemorySettlementGate): Promise<{ server: Server; baseUrl: string }> {
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: agent.did,
    operatorDid: 'did:abt:op-staged-paid',
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: AGENT_GITHUB_LOGIN,
    negotiatesOnOwnersBehalf: true,
  });
  await agentRepo.updateGithubBinding(agent.did, { handle: AGENT_GITHUB_LOGIN, status: 'verified' });
  const accountRepo = new MemoryAccountRepository();
  await accountRepo.register({ did: buyer.did, githubLogin: 'buyer-staged-paid' });
  await accountRepo.register({ did: stranger.did, githubLogin: 'stranger-staged-paid' });
  const { github } = createStagingLifecycleGithubFake();
  const server = createApp(
    accountRepo,
    agentRepo,
    undefined,
    github,
    new MemoryJobRepository(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    gate,
    anyCommitStagingObserver(),
  ).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

// The deposit leg is settled before confirm, the way the deposit door
// leaves it. Stops at confirmed when `stage` is false.
async function walkHire(base: string, gate: MemorySettlementGate, stage: boolean): Promise<string> {
  const created = await postSigned(base, '/jobs', { agentDid: agent.did, repository: 'buyer/target-repo', brief: 'Fix the login bug' }, buyer);
  expect(created.status).toBe(201);
  const jobId = String(((await created.json()) as Record<string, unknown>).id);
  expect((await postSigned(base, `/jobs/${jobId}/criteria`, { criteria: proposal, priceUsd: '500.00', rail: 'abt' }, agent)).status).toBe(200);
  for (const index of [0, 1]) {
    expect((await postSigned(base, `/jobs/${jobId}/criteria/${index}/accept`, {}, buyer)).status).toBe(200);
    expect((await postSigned(base, `/jobs/${jobId}/criteria/${index}/accept`, {}, agent)).status).toBe(200);
  }
  expect((await postSigned(base, `/jobs/${jobId}/price/accept`, {}, buyer)).status).toBe(200);
  expect((await postSigned(base, `/jobs/${jobId}/price/accept`, {}, agent)).status).toBe(200);
  gate.markDepositSettled(jobId);
  expect((await postSigned(base, `/jobs/${jobId}/confirm`, {}, buyer)).status).toBe(200);
  if (stage) {
    expect((await postSigned(base, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-sha-1' }, agent)).status).toBe(200);
  }
  return jobId;
}

async function readJob(base: string, jobId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/jobs/${jobId}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe('a hire paid in full at staged can no longer be declined or sent back for a redo (SW3-07)', () => {
  let server: Server;
  let baseUrl: string;
  let gate: MemorySettlementGate;

  beforeAll(async () => {
    buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(131));
    agent = await signingIdentityFromSeed(new Uint8Array(32).fill(132));
    stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(133));
    gate = new MemorySettlementGate();
    ({ server, baseUrl } = await startApp(gate));
  });

  afterAll(() => {
    server.close();
  });

  // (a)
  it('refuses the buyer\'s staged-decline with 409 and the whole sentence once both legs are settled, and the job stays staged', async () => {
    const jobId = await walkHire(baseUrl, gate, true);
    gate.markBalanceSettled(jobId);

    const res = await postSigned(baseUrl, `/jobs/${jobId}/staged-decline`, {}, buyer);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: PAID_DECLINE_SENTENCE });
    expect((await readJob(baseUrl, jobId)).status).toBe('staged');
  });

  // (b)
  it('refuses the buyer\'s redo with 409 and the whole sentence once both legs are settled, and the job stays staged with no redo record', async () => {
    const jobId = await walkHire(baseUrl, gate, true);
    gate.markBalanceSettled(jobId);

    const res = await postSigned(baseUrl, `/jobs/${jobId}/redo`, { criterionIndex: 0 }, buyer);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: PAID_REDO_SENTENCE });
    const after = await readJob(baseUrl, jobId);
    expect(after.status).toBe('staged');
    expect(after).not.toHaveProperty('redo');
  });

  // (c)
  it('an unpaid staged hire (deposit only) is still declined for free', async () => {
    const jobId = await walkHire(baseUrl, gate, true);

    const res = await postSigned(baseUrl, `/jobs/${jobId}/staged-decline`, {}, buyer);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).status).toBe('staged_declined');
  });

  it('an unpaid staged hire (deposit only) still takes its one redo', async () => {
    const jobId = await walkHire(baseUrl, gate, true);

    const res = await postSigned(baseUrl, `/jobs/${jobId}/redo`, { criterionIndex: 0 }, buyer);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).status).toBe('redo_requested');
  });

  // (e)
  it('the agent, a stranger and an unsigned caller get their own 403 and 401 on a paid hire, never the paid 409', async () => {
    const jobId = await walkHire(baseUrl, gate, true);
    gate.markBalanceSettled(jobId);

    for (const path of ['staged-decline', 'redo']) {
      const body = path === 'redo' ? { criterionIndex: 0 } : {};
      const asAgent = await postSigned(baseUrl, `/jobs/${jobId}/${path}`, body, agent);
      expect(asAgent.status).toBe(403);
      expect(await asAgent.json()).toEqual({ error: `only the buyer may ${path} this job` });

      const asStranger = await postSigned(baseUrl, `/jobs/${jobId}/${path}`, body, stranger);
      expect(asStranger.status).toBe(403);
      expect(await asStranger.json()).toEqual({ error: 'signature does not name a party to this job' });

      const anonymous = await postUnsigned(baseUrl, `/jobs/${jobId}/${path}`, body);
      expect(anonymous.status).toBe(401);
      expect(JSON.stringify(await anonymous.json())).not.toContain('paid in full');
    }
    expect((await readJob(baseUrl, jobId)).status).toBe('staged');
  });

  // (f)
  it('a confirmed hire with both legs marked settled gets the transition 409 on decline, not the paid one', async () => {
    const jobId = await walkHire(baseUrl, gate, false);
    gate.markBalanceSettled(jobId);

    const res = await postSigned(baseUrl, `/jobs/${jobId}/staged-decline`, {}, buyer);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'a job in status "confirmed" cannot move to "staged_declined"' });
    expect((await readJob(baseUrl, jobId)).status).toBe('confirmed');
  });
});

// (d), on a server of its own: the gate here throws on the second-payment read.
describe('a gate that cannot answer whether the hire is paid in full refuses with 503 and writes nothing (SW3-07)', () => {
  let server: Server;
  let baseUrl: string;
  let gate: RemainderReadFailsGate;

  beforeAll(async () => {
    buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(131));
    agent = await signingIdentityFromSeed(new Uint8Array(32).fill(132));
    stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(133));
    gate = new RemainderReadFailsGate();
    ({ server, baseUrl } = await startApp(gate));
  });

  afterAll(() => {
    server.close();
  });

  it('answers 503 storage unavailable on staged-decline and the job still reads staged', async () => {
    const jobId = await walkHire(baseUrl, gate, true);
    gate.failAfterReads(1);

    const res = await postSigned(baseUrl, `/jobs/${jobId}/staged-decline`, {}, buyer);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'storage unavailable' });
    expect((await readJob(baseUrl, jobId)).status).toBe('staged');
  });

  it('answers 503 storage unavailable on redo and the job still reads staged with no redo record', async () => {
    const jobId = await walkHire(baseUrl, gate, true);
    gate.failAfterReads(1);

    const res = await postSigned(baseUrl, `/jobs/${jobId}/redo`, { criterionIndex: 0 }, buyer);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'storage unavailable' });
    const after = await readJob(baseUrl, jobId);
    expect(after.status).toBe('staged');
    expect(after).not.toHaveProperty('redo');
  });
});
