// FIX-B39 (bugs.md B39): shared open-rail HTTP test harness. Extracted so
// tests/api/job-open-rail.test.ts and tests/api/job-payment-rail-door-
// eligibility.test.ts do not each grow their own copy of the same
// app-wiring and walk-to-open-quote boilerplate (both drive an open
// quote, both need a buyer, an agent whose operator carries zero, one or
// two payout addresses, and a settlement repository the test can write
// into directly).
import type { Server } from 'node:http';
import { createApp } from '../../src/api/app.js';
import { PrismaSettlementGate, type SettlementGate } from '../../src/adapters/payment/gate.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryJobRepository,
  MemorySettlementRepository,
} from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, type SigningIdentity } from './sign-request.js';
import { postSigned } from './abt-fixtures.js';
import { createStagingLifecycleGithubFake } from './github-staging-fixtures.js';

export interface OpenRailApp {
  readonly server: Server;
  readonly baseUrl: string;
  readonly buyer: SigningIdentity;
  readonly agent: SigningIdentity;
  readonly settlementRepo: MemorySettlementRepository;
  readonly operatorRepo: MemoryAccountRepository;
  readonly operatorDid: string;
}

// gate defaults to a PrismaSettlementGate reading the SAME settlementRepo
// this function returns, so a test that records a settlement directly on
// settlementRepo sees it reflected through the gate with no separate
// wiring step (confirm's own default stance).
export async function startOpenRailApp(
  operatorAddresses: { readonly abt?: string; readonly evm?: string } = {},
  gate?: SettlementGate,
): Promise<OpenRailApp> {
  const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(Math.floor(Math.random() * 200) + 1));
  const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(Math.floor(Math.random() * 200) + 1));
  const operatorRepo = new MemoryAccountRepository();
  await operatorRepo.register({ did: buyer.did, githubLogin: `buyer-open-rail-${Math.random()}` });
  const operatorDid = `did:abt:op-open-rail-${Math.random()}`;
  await operatorRepo.register({ did: operatorDid, githubLogin: `operator-open-rail-${Math.random()}` });
  if (operatorAddresses.abt !== undefined) await operatorRepo.setOperatorAddressAbt(operatorDid, operatorAddresses.abt);
  if (operatorAddresses.evm !== undefined) await operatorRepo.setOperatorAddressEvm(operatorDid, operatorAddresses.evm);
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: agent.did,
    operatorDid,
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: 'scout-open-rail',
    negotiatesOnOwnersBehalf: true,
  });
  await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-open-rail', status: 'verified' });
  const jobRepo = new MemoryJobRepository();
  const settlementRepo = new MemorySettlementRepository();
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
    gate ?? new PrismaSettlementGate(settlementRepo),
    undefined,
    undefined,
    undefined,
    undefined,
    settlementRepo,
  ).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a port');
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, buyer, agent, settlementRepo, operatorRepo, operatorDid };
}

export async function openDraft(app: Pick<OpenRailApp, 'baseUrl' | 'buyer' | 'agent'>): Promise<string> {
  const created = await postSigned(app.baseUrl, '/jobs', {
    buyerDid: app.buyer.did,
    agentDid: app.agent.did,
    repository: 'buyer/target-repo',
    brief: 'Fix the login bug',
  }, app.buyer);
  return String(((await created.json()) as Record<string, unknown>).id);
}

const OPEN_QUOTE_CRITERIA = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'agent' },
];

// Open quote (no rail named): proposes a price with no `rail`, both
// parties accept every criterion, both accept the price. The job ends
// 'proposed', priceUsd set, rail still null.
export async function walkToOpenQuoteAccepted(
  app: Pick<OpenRailApp, 'baseUrl' | 'buyer' | 'agent'>,
  priceUsd = '500.00',
): Promise<string> {
  const jobId = await openDraft(app);
  await postSigned(app.baseUrl, `/jobs/${jobId}/criteria`, { criteria: OPEN_QUOTE_CRITERIA, priceUsd }, app.agent);
  await postSigned(app.baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, app.buyer);
  await postSigned(app.baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, app.agent);
  await postSigned(app.baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, app.buyer);
  await postSigned(app.baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, app.agent);
  await postSigned(app.baseUrl, `/jobs/${jobId}/price/accept`, {}, app.buyer);
  await postSigned(app.baseUrl, `/jobs/${jobId}/price/accept`, {}, app.agent);
  return jobId;
}
