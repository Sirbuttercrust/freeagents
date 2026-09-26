// FIX-B39 (bugs.md B39), rule 3: the deposit that settles fixes the
// currency for the job. confirm sets job.rail from the settled deposit
// when the quote left it open, BEFORE confirmSpec runs, so specHash still
// carries rail:<currency> in the same position and the recomputation in
// tests/api/job-confirm.test.ts holds unchanged. An open-quote job whose
// deposit has not settled answers confirm's existing 402, never
// confirmSpec's false "no price has been proposed" 409.
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { PrismaSettlementGate } from '../../src/adapters/payment/gate.js';
import { MemorySettlementRepository, MemoryAgentRepository, MemoryJobRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';

const proposal = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'agent' },
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

interface Setup {
  readonly server: Server;
  readonly baseUrl: string;
  readonly buyer: SigningIdentity;
  readonly agent: SigningIdentity;
  readonly settlementRepo: MemorySettlementRepository;
}

async function startApp(): Promise<Setup> {
  const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(211));
  const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(212));
  const operatorRepo = new MemoryAccountRepository();
  await operatorRepo.register({ did: buyer.did, githubLogin: `buyer-confirm-open-rail-${Math.random()}` });
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: agent.did,
    operatorDid: 'did:abt:op-confirm-open-rail',
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: 'scout-confirm-open-rail',
    negotiatesOnOwnersBehalf: true,
  });
  await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-confirm-open-rail', status: 'verified' });
  const jobRepo = new MemoryJobRepository();
  const settlementRepo = new MemorySettlementRepository();
  const gate = new PrismaSettlementGate(settlementRepo);
  const { github } = createStagingLifecycleGithubFake();
  const server = createApp(
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
    gate,
    undefined,
    undefined,
    undefined,
    undefined,
    settlementRepo,
  ).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a port');
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, buyer, agent, settlementRepo };
}

async function walkToPriceAccepted(setup: Setup): Promise<string> {
  const created = await postSigned(setup.baseUrl, '/jobs', {
    buyerDid: setup.buyer.did,
    agentDid: setup.agent.did,
    repository: 'buyer/target-repo',
    brief: 'Fix the login bug',
  }, setup.buyer);
  const jobId = String(((await created.json()) as Record<string, unknown>).id);
  await postSigned(setup.baseUrl, `/jobs/${jobId}/criteria`, { criteria: proposal, priceUsd: '500.00' }, setup.agent);
  await postSigned(setup.baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, setup.buyer);
  await postSigned(setup.baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, setup.agent);
  await postSigned(setup.baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, setup.buyer);
  await postSigned(setup.baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, setup.agent);
  await postSigned(setup.baseUrl, `/jobs/${jobId}/price/accept`, {}, setup.buyer);
  await postSigned(setup.baseUrl, `/jobs/${jobId}/price/accept`, {}, setup.agent);
  return jobId;
}

describe('confirm on an open quote: no deposit settled answers 402, never confirmSpec\'s false 409', () => {
  let setup: Setup;
  beforeAll(async () => {
    setup = await startApp();
  });
  afterAll(() => setup.server.close());

  it('answers 402 naming depositUsd, not 409 "no price has been proposed"', async () => {
    const jobId = await walkToPriceAccepted(setup);
    const confirmed = await postSigned(setup.baseUrl, `/jobs/${jobId}/confirm`, {}, setup.buyer);
    expect(confirmed.status).toBe(402);
    const body = (await confirmed.json()) as { error: string; depositUsd: string };
    expect(body.error).toContain('deposit has not settled');
    expect(body.depositUsd).toBe('125.00');
  });
});

describe('confirm on an open quote: the settled deposit backfills job.rail before confirmSpec runs', () => {
  it('confirms with the confirmed job\'s rail equal to the settled deposit\'s rail, and specHash recomputes off node:crypto alone', async () => {
    const setup = await startApp();
    try {
      const jobId = await walkToPriceAccepted(setup);
      await setup.settlementRepo.record({
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
      const confirmed = await postSigned(setup.baseUrl, `/jobs/${jobId}/confirm`, {}, setup.buyer);
      expect(confirmed.status).toBe(200);
      const body = (await confirmed.json()) as Record<string, unknown>;
      expect(body.status).toBe('confirmed');
      const price = body.price as { priceUsd: string; rail: string; depositPercent: number; redoAllowance: number; deliveryWindowDays: number | null };
      expect(price.rail).toBe('abt');

      // Invariant 2: recomputable from the confirmed response alone.
      const criteria = body.criteria as Array<{ text: string }>;
      const joined = [
        ...criteria.map((c) => c.text),
        `price:${price.priceUsd}`,
        `rail:${price.rail}`,
        `deposit:${price.depositPercent}`,
        `redo:${price.redoAllowance}`,
        `window:${price.deliveryWindowDays}`,
      ].join('\n');
      const recomputed = 'sha256:' + createHash('sha256').update(joined).digest('hex');
      expect(recomputed).toBe(body.specHash);
    } finally {
      setup.server.close();
    }
  });

  it('never clears either party\'s price acceptance: confirm succeeds straight through (both acceptances were already true)', async () => {
    // If backfilling job.rail cleared acceptance, confirmSpec's own
    // criteria-acceptance-independent price gate would still pass (price
    // acceptance is checked separately), but confirm would then fail on
    // priceAcceptedByBuyer/Agent being false. Confirm succeeding at all
    // here (previous test) is the proof; this test pins the SAME job
    // reaching 'confirmed', not stuck at some intermediate re-accept step.
    const setup = await startApp();
    try {
      const jobId = await walkToPriceAccepted(setup);
      await setup.settlementRepo.record({
        jobId,
        leg: 'deposit',
        rail: 'usdc',
        hash: 'hash-deposit-2',
        secondaryHash: null,
        operatorAddress: '0xOperator',
        feeAddress: '0xFee',
        amountUsd: '125.00',
        observedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const confirmed = await postSigned(setup.baseUrl, `/jobs/${jobId}/confirm`, {}, setup.buyer);
      expect(confirmed.status).toBe(200);
    } finally {
      setup.server.close();
    }
  });
});

describe('confirm on a PINNED quote keeps its existing order and answers exactly (untouched)', () => {
  it('a job pinned to usdc with an abt deposit settled by mistake still confirms with rail usdc (the pin wins; a settlement gate is a separate concern)', async () => {
    // This test documents the pinned-quote path is UNCHANGED by this
    // card: confirm never overwrites an already-pinned rail from a
    // settlement row. The scenario itself (deposit settled on the wrong
    // rail for a pinned job) is exactly what the payment doors refuse
    // before it can happen; this only proves confirm's own backfill is
    // conditional on job.rail being null.
    const setup = await startApp();
    try {
      const created = await postSigned(setup.baseUrl, '/jobs', {
        buyerDid: setup.buyer.did,
        agentDid: setup.agent.did,
        repository: 'buyer/target-repo',
        brief: 'Fix the login bug',
      }, setup.buyer);
      const jobId = String(((await created.json()) as Record<string, unknown>).id);
      await postSigned(setup.baseUrl, `/jobs/${jobId}/criteria`, { criteria: proposal, priceUsd: '500.00', rail: 'usdc' }, setup.agent);
      await postSigned(setup.baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, setup.buyer);
      await postSigned(setup.baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, setup.agent);
      await postSigned(setup.baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, setup.buyer);
      await postSigned(setup.baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, setup.agent);
      await postSigned(setup.baseUrl, `/jobs/${jobId}/price/accept`, {}, setup.buyer);
      await postSigned(setup.baseUrl, `/jobs/${jobId}/price/accept`, {}, setup.agent);
      await setup.settlementRepo.record({
        jobId,
        leg: 'deposit',
        rail: 'abt',
        hash: 'hash-deposit-3',
        secondaryHash: null,
        operatorAddress: 'z1Operator',
        feeAddress: 'z1Fee',
        amountUsd: '125.00',
        observedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const confirmed = await postSigned(setup.baseUrl, `/jobs/${jobId}/confirm`, {}, setup.buyer);
      expect(confirmed.status).toBe(200);
      const body = (await confirmed.json()) as Record<string, unknown>;
      const price = body.price as { rail: string };
      expect(price.rail).toBe('usdc');
    } finally {
      setup.server.close();
    }
  });
});
