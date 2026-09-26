// FIX-B39 (bugs.md B39): shared open-rail HTTP test harness for
// tests/api/job-open-rail.test.ts and tests/api/job-payment-rail-door-
// eligibility.test.ts (both drive an open quote, both need a buyer, an
// agent whose operator carries zero, one or two payout addresses, and a
// settlement repository the test can write into directly).
import type { Server } from 'node:http';
import { fromRandom } from '@ocap/wallet';
import { createApp } from '../../src/api/app.js';
import { PrismaSettlementGate, type SettlementGate } from '../../src/adapters/payment/gate.js';
import { createAbtPaymentRail, type AbtPaymentRail } from '../../src/adapters/payment/abt.js';
import { createUsdcPaymentRail, type UsdcChainClient, type UsdcPaymentRailShim } from '../../src/adapters/payment/usdc.js';
import type { UsdcSpentTransferRow, UsdcSpentTransferStorage } from '../../src/adapters/payment/usdc-spent-transfer-storage-types.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryJobRepository,
  MemorySettlementRepository,
} from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, type SigningIdentity } from './sign-request.js';
import { postSigned, abtEnv, reservePort, withEnv, pureTxEncoder, fakeAbtChainClient } from './abt-fixtures.js';
import { createStagingLifecycleGithubFake } from './github-staging-fixtures.js';

const USDC_TOKEN = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const USDC_FEE_ADDRESS = '0xFeeAddress000000000000000000000000000';
const USDC_CHAIN_ID = 421614;

export interface OpenRailApp {
  readonly server: Server;
  readonly baseUrl: string;
  readonly buyer: SigningIdentity;
  readonly agent: SigningIdentity;
  readonly settlementRepo: MemorySettlementRepository;
  readonly operatorRepo: MemoryAccountRepository;
  readonly operatorDid: string;
}

interface OpenRailActors {
  readonly buyer: SigningIdentity;
  readonly agent: SigningIdentity;
  readonly operatorRepo: MemoryAccountRepository;
  readonly operatorDid: string;
  readonly agentRepo: MemoryAgentRepository;
  readonly jobRepo: MemoryJobRepository;
  readonly settlementRepo: MemorySettlementRepository;
  readonly github: ReturnType<typeof createStagingLifecycleGithubFake>['github'];
}

// The buyer, the hired agent, its operator (with zero, one or two
// payout addresses), and fresh in-memory repositories, shared by both
// harness variants below.
// Fixed, distinct seeds (tests/api/job-payment-usdc.test.ts's own
// fill(111)/fill(112) precedent): a random seed per identity had a
// 1-in-200 chance of colliding buyer and agent into one signer, making
// every criterion-accept land against a single party so confirm answers
// the wrong 409 ("criteria outstanding") on an otherwise-correct run
// (review r2, defect 2).
const OPEN_RAIL_BUYER_SEED = 121;
const OPEN_RAIL_AGENT_SEED = 122;

async function buildOpenRailActors(
  operatorAddresses: { readonly abt?: string; readonly evm?: string },
): Promise<OpenRailActors> {
  const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(OPEN_RAIL_BUYER_SEED));
  const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(OPEN_RAIL_AGENT_SEED));
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
  const { github } = createStagingLifecycleGithubFake();
  return { buyer, agent, operatorRepo, operatorDid, agentRepo, jobRepo: new MemoryJobRepository(), settlementRepo: new MemorySettlementRepository(), github };
}

// gate defaults to a PrismaSettlementGate reading the SAME settlementRepo,
// so a test that records a settlement directly on settlementRepo sees it
// reflected through the gate with no separate wiring step. No payment
// rail is wired (both start doors answer 503): use
// startOpenRailAppWithRails for a test that drives a real /start call.
export async function startOpenRailApp(
  operatorAddresses: { readonly abt?: string; readonly evm?: string } = {},
  gate?: SettlementGate,
): Promise<OpenRailApp> {
  const actors = await buildOpenRailActors(operatorAddresses);
  const server = createApp(
    actors.operatorRepo, actors.agentRepo, undefined, actors.github, actors.jobRepo,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    gate ?? new PrismaSettlementGate(actors.settlementRepo),
    undefined, undefined, undefined, undefined, actors.settlementRepo,
  ).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a port');
  return {
    server, baseUrl: `http://127.0.0.1:${address.port}`,
    buyer: actors.buyer, agent: actors.agent, settlementRepo: actors.settlementRepo,
    operatorRepo: actors.operatorRepo, operatorDid: actors.operatorDid,
  };
}

// The default $500.00 open-quote price (walkToOpenQuoteAccepted) with the
// job's fixed 25% deposit: 125.00 USD price transfer, 6% USDC fee on
// that (7.50 USD) fee transfer, at USDC's 6 decimals and a 1:1 rate.
const OPEN_QUOTE_USDC_DEPOSIT_PRICE_HASH = '0xopen-quote-usdc-price';
const OPEN_QUOTE_USDC_DEPOSIT_FEE_HASH = '0xopen-quote-usdc-fee';

function fakeUsdcRail(operatorAddress: string): UsdcPaymentRailShim {
  const rows = new Map<string, UsdcSpentTransferRow>();
  const spentTransferStorage: UsdcSpentTransferStorage = {
    async record(row) {
      rows.set(row.hash, { ...row });
    },
    async findByHash(hash) {
      return rows.get(hash) ?? null;
    },
  };
  // FIX-B39: the wallet-response door needs a chain client that actually
  // observes a real transfer for the deposit leg's hashes this file's
  // own open-quote-through-wallet-response test drives, or confirm()
  // never answers confirmed: true and the test can prove nothing about
  // rule 3's currency backfill. Every other hash used across this
  // suite's refusal tests never reaches the chain client at all
  // (checkRailDoorEligible refuses first), so this fixed pair is
  // sufficient.
  const chainClient: UsdcChainClient = {
    decimals: async () => 6,
    getTransactionReceipt: async (hash: string) => {
      if (hash.toLowerCase() === OPEN_QUOTE_USDC_DEPOSIT_PRICE_HASH) {
        return {
          status: 1,
          transfer: { to: operatorAddress, value: '125000000', tokenContract: USDC_TOKEN, chainId: USDC_CHAIN_ID },
        };
      }
      if (hash.toLowerCase() === OPEN_QUOTE_USDC_DEPOSIT_FEE_HASH) {
        return {
          status: 1,
          transfer: { to: USDC_FEE_ADDRESS, value: '7500000', tokenContract: USDC_TOKEN, chainId: USDC_CHAIN_ID },
        };
      }
      return null;
    },
  };
  return createUsdcPaymentRail({
    chainClient,
    rateSource: async () => '1',
    halfPaidStorage: { record: async () => {}, read: async () => null, clear: async () => {} },
    spentTransferStorage,
  });
}

function fakeAbtRail(): AbtPaymentRail {
  const rows = new Map<string, { hash: string; jobId: string; leg: 'deposit' | 'balance' }>();
  return createAbtPaymentRail({
    chainClient: fakeAbtChainClient(true).client,
    rateSource: async () => '1',
    spentTransferStorage: {
      async record(row) {
        rows.set(row.hash, { ...row });
      },
      async findByHash(hash) {
        return rows.get(hash) ?? null;
      },
    },
  });
}

// The same harness with BOTH real payment rails wired (fake chain
// clients, no network), for a test that drives an actual /start call or
// the full DID Connect wallet protocol. FREEAGENTS_PUBLIC_BASE_URL must
// be set before createApp constructs WalletAuthenticator, so the port is
// reserved and env set up FIRST (abt-fixtures.ts's own pattern).
export async function startOpenRailAppWithRails(
  operatorAddresses: { readonly abt?: string; readonly evm?: string } = {},
): Promise<OpenRailApp> {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const platformWallet = fromRandom();
  const abtToken = fromRandom().address;
  const abtFeeAddress = fromRandom().address;
  const usdcEnv = {
    FREEAGENTS_USDC_RPC_URL: 'https://sepolia-rollup.arbitrum.io/rpc',
    FREEAGENTS_USDC_TOKEN_CONTRACT: USDC_TOKEN,
    FREEAGENTS_USDC_CHAIN_ID: String(USDC_CHAIN_ID),
    FREEAGENTS_USDC_FEE_ADDRESS: USDC_FEE_ADDRESS,
  };
  return withEnv({ ...usdcEnv, ...abtEnv(baseUrl, platformWallet, abtToken, abtFeeAddress) }, async () => {
    const actors = await buildOpenRailActors(operatorAddresses);
    const gate = new PrismaSettlementGate(actors.settlementRepo);
    const app = createApp(
      actors.operatorRepo, actors.agentRepo, undefined, actors.github, actors.jobRepo,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      gate, undefined, undefined, fakeAbtRail(), fakeUsdcRail(operatorAddresses.evm ?? '0xUnusedOperator00000000000000000000000'), actors.settlementRepo, pureTxEncoder,
    );
    const server = app.listen(port, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    return {
      server, baseUrl,
      buyer: actors.buyer, agent: actors.agent, settlementRepo: actors.settlementRepo,
      operatorRepo: actors.operatorRepo, operatorDid: actors.operatorDid,
    };
  });
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

// A single-criterion price proposal (open, or pinned if rail is
// passed), with no criteria acceptance walked: payableRails only needs
// the job at 'proposed' with a price, never all the way to accepted.
export async function proposeOneCriterionPrice(
  app: Pick<OpenRailApp, 'baseUrl' | 'agent'>,
  jobId: string,
  opts: { readonly priceUsd?: string; readonly rail?: 'abt' | 'usdc' } = {},
): Promise<Response> {
  return postSigned(app.baseUrl, `/jobs/${jobId}/criteria`, {
    criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent' }],
    priceUsd: opts.priceUsd ?? '500.00',
    ...(opts.rail !== undefined ? { rail: opts.rail } : {}),
  }, app.agent);
}

const DEPOSIT_RAIL_DEFAULTS = {
  abt: { operatorAddress: 'z1Operator', feeAddress: 'z1Fee' },
  usdc: { operatorAddress: '0xOperator', feeAddress: '0xFee' },
} as const;

// Writes a settled deposit row straight to the repository (the shortcut
// this suite's other fixtures take for testing a projection or a gate,
// never the settlement mechanics themselves), with the rail's ordinary
// operator and fee addresses as sensible defaults.
export async function recordDeposit(
  app: Pick<OpenRailApp, 'settlementRepo'>,
  jobId: string,
  rail: 'abt' | 'usdc',
  overrides: { readonly hash?: string; readonly operatorAddress?: string; readonly feeAddress?: string } = {},
): Promise<void> {
  const defaults = DEPOSIT_RAIL_DEFAULTS[rail];
  await app.settlementRepo.record({
    jobId,
    leg: 'deposit',
    rail,
    hash: overrides.hash ?? `hash-deposit-${jobId}`,
    secondaryHash: null,
    operatorAddress: overrides.operatorAddress ?? defaults.operatorAddress,
    feeAddress: overrides.feeAddress ?? defaults.feeAddress,
    amountUsd: '125.00',
    observedAt: new Date('2026-01-01T00:00:00Z'),
  });
}

// Exported: tests/api/job-open-rail.test.ts's own "a real price-acceptance
// refusal is not mistaken for the missing-record one" case re-proposes
// this SAME text (a different price only) to reset price acceptance
// without touching criteria acceptance, and needs the identical list.
export const OPEN_QUOTE_CRITERIA = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'agent' },
];

// Proposes a price (open, or pinned if rail is passed), both parties
// accept every criterion, both accept the price. The job ends
// 'proposed', priceUsd set, rail null unless pinned.
export async function walkToOpenQuoteAccepted(
  app: Pick<OpenRailApp, 'baseUrl' | 'buyer' | 'agent'>,
  opts: { readonly priceUsd?: string; readonly rail?: 'abt' | 'usdc' } = {},
): Promise<string> {
  const jobId = await openDraft(app);
  await postSigned(app.baseUrl, `/jobs/${jobId}/criteria`, {
    criteria: OPEN_QUOTE_CRITERIA,
    priceUsd: opts.priceUsd ?? '500.00',
    ...(opts.rail !== undefined ? { rail: opts.rail } : {}),
  }, app.agent);
  await postSigned(app.baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, app.buyer);
  await postSigned(app.baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, app.agent);
  await postSigned(app.baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, app.buyer);
  await postSigned(app.baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, app.agent);
  await postSigned(app.baseUrl, `/jobs/${jobId}/price/accept`, {}, app.buyer);
  await postSigned(app.baseUrl, `/jobs/${jobId}/price/accept`, {}, app.agent);
  return jobId;
}
