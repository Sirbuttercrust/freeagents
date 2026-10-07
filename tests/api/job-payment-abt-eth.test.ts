// The ABT-on-Ethereum payment routes (start and wallet-response), the rail
// offered only when the owner set an address for it, and the late-transfer
// rule wired through them. Real HTTP against createApp with memory storage,
// the real rail on a fake chain client (receipts and block times) and a fake
// price feed; only Date is faked. The job prices at 500.00 USD with the
// default 25 percent deposit: deposit 125.00 USD, remainder 375.00 USD, fee 3
// percent, and the feed answers 0.25 USD per ABT unless a case moves it, so
// the deposit is 500 ABT plus a 15 ABT fee and the remainder 1500 plus 45, at
// 18 decimals. Expected values are written out from literals.
import type { Server } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createUsdcPaymentRail, type UsdcPaymentRailShim } from '../../src/adapters/payment/usdc.js';
import { createAbtEthPaymentRail, type AbtEthHalfPaidStorage, type AbtEthPaymentRail } from '../../src/adapters/payment/abt-eth.js';
import { createMemoryAbtEthQuoteLockStorage } from '../../src/adapters/payment/abt-eth-quote-lock-memory.js';
import type { AbtEthQuoteLock, AbtEthQuoteLockStorage } from '../../src/adapters/payment/abt-eth-quote-lock.js';
import { createMemoryAbtEthShortPaymentStorage } from '../../src/adapters/payment/abt-eth-short-payment-memory.js';
import type { AbtEthShortPaymentStorage } from '../../src/adapters/payment/abt-eth-short-payment.js';
import type { AbtEthChainClient, Erc20ObservedTransfer } from '../../src/adapters/payment/erc20.js';
import { PrismaSettlementGate } from '../../src/adapters/payment/gate.js';
import { agentGithubLoginUnverifiedMessage, legAlreadySettledMessage, legRailMismatchMessage, legStatusConflictMessage, operatorAddressNotSetMessage } from '../../src/adapters/payment/route-support.js';
import type { RateReading } from '../../src/adapters/payment/types.js';
import type { UsdcSpentTransferRow, UsdcSpentTransferStorage } from '../../src/adapters/payment/usdc-spent-transfer-storage-types.js';
import { MemoryAccountRepository, MemoryAgentRepository, MemoryJobRepository, MemoryMessageRepository, MemoryNotificationRepository, MemorySettlementRepository } from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, type SigningIdentity } from '../helpers/sign-request.js';
import { getSigned, postSigned, withEnv } from '../helpers/abt-fixtures.js';
import { fakeHalfPaidStorage } from '../helpers/usdc-half-paid-fixtures.js';
import { createStagingLifecycleGithubFake, registerAgentForkPullRequest, type StagingLifecycleFixture } from '../helpers/github-staging-fixtures.js';
import { startOpenRailAppWithRails } from '../helpers/open-rail-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const HOLD_ENDS = '2026-10-06T12:15:00.000Z';
const INSIDE_HOLD = '2026-10-06T12:10:00.000Z';
const AFTER_HOLD = '2026-10-06T12:20:00.000Z';
const REPORTED_AT = '2026-10-06T12:40:00.000Z';
const DAY_MS = 86_400_000;
const FEED_TIME = new Date('2026-10-06T11:59:00.000Z');

const ABT_TOKEN = '0xb98d4c97425d9908e66e53a6fdf673acca0be986';
const FEE_ADDRESS = '0x2222222222222222222222222222222222222222';
const OWNER_ETH = '0x1111111111111111111111111111111111111111';
const OWNER_USDC = '0x4444444444444444444444444444444444444444';
const CHAIN_ID = 1;

const DEP_PRICE = '0xaaaa000000000000000000000000000000000000000000000000000000000001';
const DEP_FEE = '0xbbbb000000000000000000000000000000000000000000000000000000000002';
const REM_PRICE = '0xaaaa000000000000000000000000000000000000000000000000000000000003';
const REM_FEE = '0xbbbb000000000000000000000000000000000000000000000000000000000004';

const DEP_PRICE_UNITS = '500000000000000000000';
const DEP_FEE_UNITS = '15000000000000000000';
const REM_PRICE_UNITS = '1500000000000000000000';
const REM_FEE_UNITS = '45000000000000000000';

const NO_LOCK = 'This payment has no locked ABT price. Start the payment again.';
const PRICE_CHANGED = 'The agreed price changed after this payment started. Start the payment again.';
const BAD_REPORT = 'body must be { priceTxHash, feeTx, quoteLockId }; feeTx is { signed: true, hash } or { signed: false }; quoteLockId is the id the start answered';

const criteria = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
];

const servers: Server[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) server.close();
});

function setTime(iso: string): void {
  vi.setSystemTime(new Date(iso));
}

type Receipt = { readonly status: number | null; readonly transfer: Erc20ObservedTransfer | null };

interface Chain {
  readonly receipts: Map<string, Receipt>;
  readonly recorded: Map<string, Date | null>;
  // A switch that makes every receipt read throw.
  readonly fails: { on: boolean };
}

function transfer(to: string, value: string): Erc20ObservedTransfer {
  return { to, value, tokenContract: ABT_TOKEN, chainId: CHAIN_ID };
}

function chainClient(chain: Chain): AbtEthChainClient {
  return {
    decimals: async () => 18,
    getTransactionReceipt: async (hash) => {
      if (chain.fails.on) throw new Error('rpc down');
      return chain.receipts.get(hash.toLowerCase()) ?? null;
    },
    recordedAt: async (hash) => chain.recorded.get(hash.toLowerCase()) ?? null,
  };
}
function memorySpent(): UsdcSpentTransferStorage {
  const rows = new Map<string, UsdcSpentTransferRow>();
  return { record: async (row) => void rows.set(row.hash, { ...row }), findByHash: async (hash) => rows.get(hash) ?? null };
}

function buildRail(chain: Chain, feed: { reading: RateReading | null }, halfPaid: AbtEthHalfPaidStorage): AbtEthPaymentRail {
  const env: Record<string, string> = {
    FREEAGENTS_ABT_ETH_RPC_URL: 'https://rpc.example.test',
    FREEAGENTS_ABT_ETH_TOKEN_CONTRACT: ABT_TOKEN,
    FREEAGENTS_ABT_ETH_CHAIN_ID: String(CHAIN_ID),
    FREEAGENTS_ABT_ETH_FEE_ADDRESS: FEE_ADDRESS,
  };
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    original[key] = process.env[key];
    process.env[key] = env[key];
  }
  try {
    return createAbtEthPaymentRail({
      chainClient: chainClient(chain),
      rateSource: async () => feed.reading,
      spentTransferStorage: memorySpent(),
      halfPaidStorage: halfPaid,
    });
  } finally {
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

interface Rig {
  readonly baseUrl: string;
  readonly buyer: SigningIdentity;
  readonly agent: SigningIdentity;
  readonly stranger: SigningIdentity;
  // The agent's owner, signing as the operator the agent is registered under.
  readonly operator: SigningIdentity;
  readonly accounts: MemoryAccountRepository;
  readonly agentRepo: MemoryAgentRepository;
  readonly notifications: MemoryNotificationRepository;
  readonly chain: Chain;
  readonly feed: { reading: RateReading | null };
  readonly locks: AbtEthQuoteLock[];
  readonly shorts: AbtEthShortPaymentStorage;
  readonly halfPaid: AbtEthHalfPaidStorage;
  // What the USDC rail's chain reads answer, when the rig wires that rail
  // beside this one (usdcRail), and a switch that makes the half-paid
  // reads of both rails throw.
  readonly usdcReceipts: Map<string, Receipt>;
  readonly readsFail: { on: boolean };
  // A switch that makes only the short-payment read throw, and one for the
  // quote lock read.
  readonly shortReadsFail: { on: boolean };
  readonly lockReadsFail: { on: boolean };
  readonly settlementRepo: MemorySettlementRepository;
  readonly messageRepo: MemoryMessageRepository;
  readonly fixture: StagingLifecycleFixture;
}

const USDC_TOKEN = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const USDC_FEE_ADDRESS = '0x3333333333333333333333333333333333333333';
const USDC_CHAIN_ID = 421614;

async function buildUsdcRail(receipts: Map<string, Receipt>, readsFail: { on: boolean }): Promise<UsdcPaymentRailShim> {
  const env = {
    FREEAGENTS_USDC_RPC_URL: 'https://rpc.example.test',
    FREEAGENTS_USDC_TOKEN_CONTRACT: USDC_TOKEN,
    FREEAGENTS_USDC_CHAIN_ID: String(USDC_CHAIN_ID),
    FREEAGENTS_USDC_FEE_ADDRESS: USDC_FEE_ADDRESS,
  };
  const inner = fakeHalfPaidStorage();
  return withEnv(env, async () =>
    createUsdcPaymentRail({
      chainClient: { decimals: async () => 6, getTransactionReceipt: async (hash: string) => receipts.get(hash.toLowerCase()) ?? null },
      rateSource: async () => '1',
      halfPaidStorage: {
        ...inner,
        read: async (jobId, leg) => {
          if (readsFail.on) throw new Error('storage down');
          return inner.read(jobId, leg);
        },
      },
      spentTransferStorage: memorySpent(),
    }),
  );
}

interface RigOptions {
  // Wires the USDC rail beside the ABT-on-Ethereum one.
  readonly usdcRail?: boolean;
  readonly railConfigured?: boolean;
  readonly ownerEth?: string | null;
  readonly ownerUsdc?: string | null;
  readonly agentVerified?: boolean;
  // A lock store that finds a row whatever the case of the id it is asked
  // for, so a report can name a real lock in a spelling that is not the
  // stored one.
  readonly lockIdsIgnoreCase?: boolean;
}

async function boot(options: RigOptions = {}): Promise<Rig> {
  const ownerEth = options.ownerEth === undefined ? OWNER_ETH : options.ownerEth;
  const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(141));
  const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(142));
  const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(143));
  const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(144));
  const operatorDid = operator.did;
  const accounts = new MemoryAccountRepository();
  await accounts.register({ did: buyer.did, githubLogin: 'buyer-abt-eth' });
  await accounts.register({ did: operatorDid, githubLogin: 'operator-abt-eth' });
  await accounts.register({ did: stranger.did, githubLogin: 'stranger-abt-eth' });
  if (ownerEth !== null) await accounts.setOperatorAddressAbtEth(operatorDid, ownerEth);
  if (options.ownerUsdc != null) await accounts.setOperatorAddressEvm(operatorDid, options.ownerUsdc);
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({ did: agent.did, operatorDid, delegation: { fixture: true } as never, name: 'scout', skills: ['triage'], githubLogin: 'scout-abt-eth', negotiatesOnOwnersBehalf: true });
  if (options.agentVerified !== false) await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-abt-eth', status: 'verified' });
  const settlementRepo = new MemorySettlementRepository();
  const messageRepo = new MemoryMessageRepository();
  const fixture = createStagingLifecycleGithubFake();
  const chain: Chain = { receipts: new Map(), recorded: new Map(), fails: { on: false } };
  const notifications = new MemoryNotificationRepository();
  const lockReadsFail = { on: false };
  const feed: { reading: RateReading | null } = { reading: { usdPerToken: '0.25', updatedAt: FEED_TIME } };
  const inner: AbtEthQuoteLockStorage = createMemoryAbtEthQuoteLockStorage();
  const locks: AbtEthQuoteLock[] = [];
  const lockStorage: AbtEthQuoteLockStorage = {
    create: async (lock) => {
      const stored = await inner.create(lock);
      locks.push(stored);
      return stored;
    },
    read: async (id) => {
      if (lockReadsFail.on) throw new Error('storage down');
      return inner.read(options.lockIdsIgnoreCase === true ? id.toLowerCase() : id);
    },
  };
  const shortsInner = createMemoryAbtEthShortPaymentStorage();
  const shortReadsFail = { on: false };
  const shorts: AbtEthShortPaymentStorage = {
    ...shortsInner,
    findByJobAndLeg: async (jobId, leg) => {
      if (shortReadsFail.on) throw new Error('storage down');
      return shortsInner.findByJobAndLeg(jobId, leg);
    },
  };
  const halfPaid: AbtEthHalfPaidStorage = fakeHalfPaidStorage();
  const readsFail = { on: false };
  const railHalfPaid: AbtEthHalfPaidStorage = {
    ...halfPaid,
    read: async (jobId, leg) => {
      if (readsFail.on) throw new Error('storage down');
      return halfPaid.read(jobId, leg);
    },
  };
  const rail = options.railConfigured === false ? null : buildRail(chain, feed, railHalfPaid);
  const usdcReceipts = new Map<string, Receipt>();
  const usdcRail = options.usdcRail === true ? await buildUsdcRail(usdcReceipts, readsFail) : null;

  const app = createApp(
    accounts,
    agentRepo,
    undefined, fixture.github, new MemoryJobRepository(), undefined, undefined, undefined,
    { verify: 100_000, read: 100_000, write: 100_000, upstream: 100_000 },
    undefined, undefined, undefined, undefined,
    new PrismaSettlementGate(settlementRepo), anyCommitStagingObserver(), undefined, null, usdcRail,
    settlementRepo, undefined, undefined, messageRepo,
    undefined, notifications, undefined, undefined, undefined, undefined, undefined,
    rail, lockStorage, shorts,
  );
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected server to listen on a port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    buyer,
    agent,
    stranger,
    operator,
    accounts,
    agentRepo,
    notifications,
    chain,
    feed,
    locks,
    shorts,
    halfPaid,
    usdcReceipts,
    readsFail,
    shortReadsFail,
    lockReadsFail,
    settlementRepo,
    messageRepo,
    fixture,
  };
}

interface Parties {
  readonly baseUrl: string;
  readonly buyer: SigningIdentity;
  readonly agent: SigningIdentity;
}

async function createJob(rig: Parties): Promise<string> {
  const created = await postSigned(rig.baseUrl, '/jobs', {
    buyerDid: rig.buyer.did,
    agentDid: rig.agent.did,
    repository: 'buyer/target-repo',
    brief: 'Fix the login bug',
  }, rig.buyer);
  return String(((await created.json()) as Record<string, unknown>).id);
}

async function walkToProposedAndPriced(rig: Parties, rail?: 'abt' | 'usdc' | 'abt_eth'): Promise<string> {
  const jobId = await createJob(rig);
  await postSigned(rig.baseUrl, `/jobs/${jobId}/criteria`, {
    criteria,
    priceUsd: '500.00',
    ...(rail === undefined ? {} : { rail }),
  }, rig.agent);
  for (const index of [0, 1]) {
    await postSigned(rig.baseUrl, `/jobs/${jobId}/criteria/${index}/accept`, {}, rig.buyer);
    await postSigned(rig.baseUrl, `/jobs/${jobId}/criteria/${index}/accept`, {}, rig.agent);
  }
  await postSigned(rig.baseUrl, `/jobs/${jobId}/price/accept`, {}, rig.buyer);
  await postSigned(rig.baseUrl, `/jobs/${jobId}/price/accept`, {}, rig.agent);
  return jobId;
}

function legPath(jobId: string, leg: string, route: 'start' | 'wallet-response'): string {
  return `/jobs/${jobId}/payments/${leg}/abt_eth/${route}`;
}

async function startLeg(rig: Rig, jobId: string, leg: 'deposit' | 'remainder', as: SigningIdentity = rig.buyer): Promise<Response> {
  return postSigned(rig.baseUrl, legPath(jobId, leg, 'start'), {}, as);
}

async function startOk(rig: Rig, jobId: string, leg: 'deposit' | 'remainder'): Promise<string> {
  const res = await startLeg(rig, jobId, leg);
  expect(res.status).toBe(200);
  return String(((await res.json()) as { quoteLock: { id: string } }).quoteLock.id);
}

// The whole lock row a start leaves; `over` is what a case moved (the feed
// reading, the clock, the amounts).
function lockRow(jobId: string, id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, jobId, leg: 'deposit', amountUsd: '125.00', usdPerToken: '0.25', rateUpdatedAt: FEED_TIME,
    amountToken: '500', feeToken: '15', lockedAt: NOW, expiresAt: new Date(HOLD_ENDS), ...over,
  };
}

interface Pair {
  readonly price: string;
  readonly fee: string;
}
const DEPOSIT_PAIR: Pair = { price: DEP_PRICE, fee: DEP_FEE };
const REMAINDER_PAIR: Pair = { price: REM_PRICE, fee: REM_FEE };

function reportBody(pair: Pair, quoteLockId: string): Record<string, unknown> {
  return { priceTxHash: pair.price, feeTx: { signed: true, hash: pair.fee }, quoteLockId };
}

async function report(rig: Rig, jobId: string, leg: 'deposit' | 'remainder', body: unknown, as: SigningIdentity = rig.buyer): Promise<Response> {
  return postSigned(rig.baseUrl, legPath(jobId, leg, 'wallet-response'), body, as);
}

// Puts both transfers of a leg on the fake chain, the price one recorded at
// `recordedAt` (null: the chain gave no block time).
function landPair(rig: Rig, leg: 'deposit' | 'remainder', recordedAt: string | null): void {
  const pair = leg === 'deposit' ? DEPOSIT_PAIR : REMAINDER_PAIR;
  const priceUnits = leg === 'deposit' ? DEP_PRICE_UNITS : REM_PRICE_UNITS;
  const feeUnits = leg === 'deposit' ? DEP_FEE_UNITS : REM_FEE_UNITS;
  rig.chain.receipts.set(pair.price, { status: 1, transfer: transfer(OWNER_ETH, priceUnits) });
  rig.chain.receipts.set(pair.fee, { status: 1, transfer: transfer(FEE_ADDRESS, feeUnits) });
  rig.chain.recorded.set(pair.price, recordedAt === null ? null : new Date(recordedAt));
}

function confirmationBody(pair: Pair, priceRecordedAt: string | null): Record<string, unknown> {
  return {
    rail: 'abt_eth',
    hash: pair.price,
    confirmed: true,
    legs: { price: { status: 'confirmed', hash: pair.price }, fee: { status: 'confirmed', hash: pair.fee } },
    halfPaid: false,
    priceRecordedAt,
  };
}

// The conversation's paid lines, whole.
async function paidLines(rig: Rig, jobId: string): Promise<unknown[]> {
  const rows = await rig.messageRepo.listByJobId(jobId);
  return rows
    .filter((row) => row.systemEvent?.type === 'deposit_paid' || row.systemEvent?.type === 'remainder_paid')
    .map((row) => ({ body: row.body, systemEvent: row.systemEvent }));
}

// No settlement row for the deposit and no paid line in the thread.
async function expectNothingSettled(rig: Rig, jobId: string): Promise<void> {
  expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit')).toBeNull();
  expect(await paidLines(rig, jobId)).toEqual([]);
}

// The whole settlement row a paid deposit or remainder leaves.
function settlementRow(jobId: string, leg: 'deposit' | 'remainder', observedAt: string): Record<string, unknown> {
  const pair = leg === 'deposit' ? DEPOSIT_PAIR : REMAINDER_PAIR;
  return {
    jobId,
    leg,
    rail: 'abt_eth',
    hash: pair.price,
    secondaryHash: pair.fee,
    operatorAddress: OWNER_ETH,
    feeAddress: FEE_ADDRESS,
    amountUsd: leg === 'deposit' ? '125.00' : '375.00',
    observedAt: new Date(observedAt),
  };
}

// The whole short row a deposit leg leaves.
function shortRow(jobId: string, lockId: string, read: { usdPerTokenAtRead: string | null; worthUsd: string | null; recordedAt: string | null; readAt: string }): Record<string, unknown> {
  return {
    priceTxHash: DEP_PRICE,
    jobId,
    leg: 'deposit',
    lockId,
    feeTxHash: DEP_FEE,
    amountToken: '500',
    amountUsd: '125.00',
    usdPerTokenAtRead: read.usdPerTokenAtRead,
    worthUsd: read.worthUsd,
    recordedAt: read.recordedAt === null ? null : new Date(read.recordedAt),
    readAt: new Date(read.readAt),
  };
}

const DEPOSIT_PAID_LINE = {
  body: 'Deposit paid',
  systemEvent: { type: 'deposit_paid', leg: 'deposit', amountUsd: '125.00', rail: 'abt_eth' },
};
const REMAINDER_PAID_LINE = {
  body: 'Remainder paid',
  systemEvent: { type: 'remainder_paid', leg: 'remainder', amountUsd: '375.00', rail: 'abt_eth' },
};

function depositStartBody(lockId: string): Record<string, unknown> {
  return {
    rail: 'abt_eth',
    jobId: 'unset',
    leg: 'deposit',
    chainId: CHAIN_ID,
    transfers: [
      { recipient: OWNER_ETH, amountBaseUnits: DEP_PRICE_UNITS, tokenContract: ABT_TOKEN },
      { recipient: FEE_ADDRESS, amountBaseUnits: DEP_FEE_UNITS, tokenContract: ABT_TOKEN },
    ],
    quoteLock: { id: lockId, usdPerAbt: '0.25', rateUpdatedAt: FEED_TIME.toISOString(), expiresAt: HOLD_ENDS },
  };
}

describe('(a) a deployment with no ABT-on-Ethereum rail', () => {
  it('answers 503 on both routes and writes nothing', async () => {
    const rig = await boot({ railConfigured: false });
    const jobId = await walkToProposedAndPriced(rig);

    const start = await startLeg(rig, jobId, 'deposit');
    const response = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, 'any-lock'));

    expect(start.status).toBe(503);
    expect(await start.json()).toEqual({ error: 'the abt_eth payment rail is not configured on this deployment' });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'the abt_eth payment rail is not configured on this deployment' });
    expect(rig.locks).toEqual([]);
    await expectNothingSettled(rig, jobId);
  });
});

describe('(b) who may use the routes', () => {
  it('refuses a stranger with 403 and an unsigned caller with 401, on both routes, and writes nothing', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    landPair(rig, 'deposit', INSIDE_HOLD);

    const strangerStart = await startLeg(rig, jobId, 'deposit', rig.stranger);
    const strangerReport = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, 'any-lock'), rig.stranger);
    const unsignedStart = await fetch(`${rig.baseUrl}${legPath(jobId, 'deposit', 'start')}`, { method: 'POST' });
    const unsignedReport = await fetch(`${rig.baseUrl}${legPath(jobId, 'deposit', 'wallet-response')}`, { method: 'POST' });

    expect([strangerStart.status, strangerReport.status, unsignedStart.status, unsignedReport.status]).toEqual([403, 403, 401, 401]);
    expect(rig.locks).toEqual([]);
    await expectNothingSettled(rig, jobId);
  });
});

describe('(c) an owner with a USDC address and no ABT-on-Ethereum address', () => {
  it('is refused on both routes with the ABT-on-Ethereum sentence, and the USDC address is never used', async () => {
    const rig = await boot({ ownerEth: null, ownerUsdc: OWNER_USDC });
    const jobId = await walkToProposedAndPriced(rig);
    // The transfers a USDC-address recipient would have been paid: if the
    // route fell back to that address these would confirm.
    rig.chain.receipts.set(DEP_PRICE, { status: 1, transfer: transfer(OWNER_USDC, DEP_PRICE_UNITS) });
    rig.chain.receipts.set(DEP_FEE, { status: 1, transfer: transfer(FEE_ADDRESS, DEP_FEE_UNITS) });
    rig.chain.recorded.set(DEP_PRICE, new Date(INSIDE_HOLD));

    const start = await startLeg(rig, jobId, 'deposit');
    const response = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, 'any-lock'));

    expect(start.status).toBe(409);
    expect(await start.json()).toEqual({ error: operatorAddressNotSetMessage('abt_eth') });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: operatorAddressNotSetMessage('abt_eth') });
    expect(rig.locks).toEqual([]);
    expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit')).toBeNull();
  });
});

describe('(d) the start', () => {
  it('answers both transfers in 18-decimal base units, the price to the owner and the fee to the platform, with the whole quote lock', async () => {
    const rig = await boot({ ownerUsdc: OWNER_USDC });
    const jobId = await walkToProposedAndPriced(rig);

    const res = await postSigned(rig.baseUrl, legPath(jobId, 'deposit', 'start'), { amountUsd: '999999.00' }, rig.buyer);

    expect(res.status).toBe(200);
    const lock = rig.locks[0];
    if (lock === undefined) throw new Error('expected one lock row');
    expect(await res.json()).toEqual({ ...depositStartBody(lock.id), jobId });
    expect(rig.locks).toEqual([lockRow(jobId, lock.id)]);
  });

  it('builds the request from the lock it wrote, not from a second reading of the feed', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    // The feed answers 0.25 to its first reading and 0.5 to every later one.
    let reads = 0;
    Object.defineProperty(rig.feed, 'reading', {
      get: () => ({ usdPerToken: reads++ === 0 ? '0.25' : '0.5', updatedAt: FEED_TIME }),
    });

    const res = await startLeg(rig, jobId, 'deposit');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...depositStartBody(rig.locks[0]?.id ?? 'no lock written'), jobId });
    expect(reads).toBe(1);
  });

  it('writes a second lock with its own id on a second start', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);

    const first = await startOk(rig, jobId, 'deposit');
    setTime('2026-10-06T12:05:00.000Z');
    rig.feed.reading = { usdPerToken: '0.5', updatedAt: new Date('2026-10-06T12:04:00.000Z') };
    const second = await startOk(rig, jobId, 'deposit');

    expect(second).not.toBe(first);
    expect(rig.locks).toEqual([
      lockRow(jobId, first),
      lockRow(jobId, second, {
        usdPerToken: '0.5', rateUpdatedAt: new Date('2026-10-06T12:04:00.000Z'), amountToken: '250', feeToken: '7.5',
        lockedAt: new Date('2026-10-06T12:05:00.000Z'), expiresAt: new Date('2026-10-06T12:20:00.000Z'),
      }),
    ]);
  });

  it('answers the rate-unavailable sentence with 503 and writes no lock when the feed has no reading', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    rig.feed.reading = null;

    const res = await startLeg(rig, jobId, 'deposit');

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'The ABT price is not available right now. Try again in a minute.' });
    expect(rig.locks).toEqual([]);
  });
});

describe('the gates the USDC routes make, made on both ABT-on-Ethereum routes', () => {
  it('refuses a leg that is not deposit or remainder with 400', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);

    const start = await postSigned(rig.baseUrl, legPath(jobId, 'sideways', 'start'), {}, rig.buyer);
    const response = await postSigned(rig.baseUrl, legPath(jobId, 'sideways', 'wallet-response'), reportBody(DEPOSIT_PAIR, 'x'), rig.buyer);

    expect([start.status, response.status]).toEqual([400, 400]);
    expect(await start.json()).toEqual({ error: 'leg must be "deposit" or "remainder"' });
    expect(await response.json()).toEqual({ error: 'leg must be "deposit" or "remainder"' });
    expect(rig.locks).toEqual([]);
  });

  it('refuses a body that names the recipient with 400 and writes nothing', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    landPair(rig, 'deposit', INSIDE_HOLD);
    const lockId = await startOk(rig, jobId, 'deposit');

    const start = await postSigned(rig.baseUrl, legPath(jobId, 'deposit', 'start'), { operatorAddress: OWNER_USDC }, rig.buyer);
    const response = await report(rig, jobId, 'deposit', { ...reportBody(DEPOSIT_PAIR, lockId), operatorAddress: OWNER_USDC });

    const sentence = { error: "the recipient is resolved from the hired agent's operator and may not be supplied" };
    expect([start.status, response.status]).toEqual([400, 400]);
    expect(await start.json()).toEqual(sentence);
    expect(await response.json()).toEqual(sentence);
    expect(rig.locks).toHaveLength(1);
    expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit')).toBeNull();
  });

  it('refuses a job with no agreed price on the start with 409 and writes no lock', async () => {
    const rig = await boot();
    const jobId = await createJob(rig);

    const start = await startLeg(rig, jobId, 'deposit');

    expect(start.status).toBe(409);
    expect(await start.json()).toEqual({ error: 'this job has no agreed price to pay against' });
    expect(rig.locks).toEqual([]);
  });

  it('refuses a job priced on another rail on both routes, and writes nothing', async () => {
    const rig = await boot({ ownerUsdc: OWNER_USDC });
    const jobId = await walkToProposedAndPriced(rig, 'usdc');
    landPair(rig, 'deposit', INSIDE_HOLD);

    const start = await startLeg(rig, jobId, 'deposit');
    const response = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, 'any-lock'));

    expect([start.status, response.status]).toEqual([409, 409]);
    expect(await start.json()).toEqual({ error: legRailMismatchMessage('abt_eth', 'usdc') });
    expect(await response.json()).toEqual({ error: legRailMismatchMessage('abt_eth', 'usdc') });
    expect(rig.locks).toEqual([]);
    expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit')).toBeNull();
  });

  it('refuses a deposit already settled in another currency on both routes', async () => {
    const rig = await boot({ ownerUsdc: OWNER_USDC });
    const jobId = await walkToProposedAndPriced(rig);
    await rig.settlementRepo.record({
      jobId,
      leg: 'deposit',
      rail: 'usdc',
      hash: '0xusdc-deposit',
      secondaryHash: null,
      operatorAddress: OWNER_USDC,
      feeAddress: FEE_ADDRESS,
      amountUsd: '125.00',
      observedAt: NOW,
    });
    landPair(rig, 'remainder', INSIDE_HOLD);

    const start = await startLeg(rig, jobId, 'remainder');
    const response = await report(rig, jobId, 'remainder', reportBody(REMAINDER_PAIR, 'any-lock'));

    const sentence = { error: 'the deposit for this job was paid in "usdc"; the "abt_eth" payment routes refuse it' };
    expect([start.status, response.status]).toEqual([409, 409]);
    expect(await start.json()).toEqual(sentence);
    expect(await response.json()).toEqual(sentence);
    expect(rig.locks).toEqual([]);
  });

  it('refuses a leg the job is not in the status for, on both routes', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    landPair(rig, 'remainder', INSIDE_HOLD);

    const start = await startLeg(rig, jobId, 'remainder');
    const response = await report(rig, jobId, 'remainder', reportBody(REMAINDER_PAIR, 'any-lock'));

    expect([start.status, response.status]).toEqual([409, 409]);
    expect(await start.json()).toEqual({ error: legStatusConflictMessage('remainder', 'proposed') });
    expect(await response.json()).toEqual({ error: legStatusConflictMessage('remainder', 'proposed') });
    expect(rig.locks).toEqual([]);
    expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'remainder')).toBeNull();
  });

  it('refuses a leg that already settled, on both routes, for a payment that is not the recorded one', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    landPair(rig, 'deposit', INSIDE_HOLD);
    const lockId = await startOk(rig, jobId, 'deposit');
    expect((await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId))).status).toBe(200);
    const other: Pair = { price: REM_PRICE, fee: REM_FEE };
    rig.chain.receipts.set(other.price, { status: 1, transfer: transfer(OWNER_ETH, DEP_PRICE_UNITS) });
    rig.chain.receipts.set(other.fee, { status: 1, transfer: transfer(FEE_ADDRESS, DEP_FEE_UNITS) });
    const before = await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit');

    const start = await startLeg(rig, jobId, 'deposit');
    const response = await report(rig, jobId, 'deposit', reportBody(other, lockId));

    const sentence = { error: legAlreadySettledMessage('deposit') };
    expect([start.status, response.status]).toEqual([409, 409]);
    expect(await start.json()).toEqual(sentence);
    expect(await response.json()).toEqual(sentence);
    expect(rig.locks).toHaveLength(1);
    expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit')).toEqual(before);
    expect(await paidLines(rig, jobId)).toEqual([DEPOSIT_PAID_LINE]);
  });

  it('refuses a deposit start while the agent has no verified GitHub login, and writes no lock', async () => {
    const rig = await boot({ agentVerified: false });
    const jobId = await walkToProposedAndPriced(rig);

    const res = await startLeg(rig, jobId, 'deposit');

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: agentGithubLoginUnverifiedMessage() });
    expect(rig.locks).toEqual([]);
  });

  it('refuses a malformed report with 400 and the same transaction named twice with 400, and settles nothing', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    landPair(rig, 'deposit', INSIDE_HOLD);
    const lockId = await startOk(rig, jobId, 'deposit');

    const noFee = await report(rig, jobId, 'deposit', { priceTxHash: DEP_PRICE, quoteLockId: lockId });
    const noPrice = await report(rig, jobId, 'deposit', { feeTx: { signed: false }, quoteLockId: lockId });
    const same = await report(rig, jobId, 'deposit', {
      priceTxHash: DEP_PRICE,
      feeTx: { signed: true, hash: DEP_PRICE.toUpperCase().replace('0X', '0x') },
      quoteLockId: lockId,
    });

    expect([noFee.status, noPrice.status, same.status]).toEqual([400, 400, 400]);
    expect(await noFee.json()).toEqual({ error: BAD_REPORT });
    expect(await noPrice.json()).toEqual({ error: BAD_REPORT });
    expect(await same.json()).toEqual({ error: 'priceTxHash and feeTx.hash must not be the same transaction' });
    await expectNothingSettled(rig, jobId);
  });
});

describe('(e) a rate that moves between the start and the report', () => {
  it('does not change what the report is checked against: the lock\'s amounts, whatever the body carries', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    landPair(rig, 'deposit', INSIDE_HOLD);
    const lockId = await startOk(rig, jobId, 'deposit');
    setTime(INSIDE_HOLD);
    rig.feed.reading = { usdPerToken: '0.5', updatedAt: new Date('2026-10-06T12:09:00.000Z') };

    // The body's own amounts are not read either.
    const res = await report(rig, jobId, 'deposit', { ...reportBody(DEPOSIT_PAIR, lockId), amountToken: '1', feeToken: '1' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(confirmationBody(DEPOSIT_PAIR, INSIDE_HOLD));
    expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit')).toEqual(settlementRow(jobId, 'deposit', INSIDE_HOLD));
  });
});

describe('(f) the lock the report names', () => {
  it('refuses a report with no quoteLockId with 400', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    landPair(rig, 'deposit', INSIDE_HOLD);
    await startOk(rig, jobId, 'deposit');

    const missing = await report(rig, jobId, 'deposit', { priceTxHash: DEP_PRICE, feeTx: { signed: true, hash: DEP_FEE } });
    const empty = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, ''));
    const wrongType = await report(rig, jobId, 'deposit', { ...reportBody(DEPOSIT_PAIR, 'x'), quoteLockId: 7 });

    expect([missing.status, empty.status, wrongType.status]).toEqual([400, 400, 400]);
    expect(await missing.json()).toEqual({ error: BAD_REPORT });
    expect(await empty.json()).toEqual({ error: BAD_REPORT });
    expect(await wrongType.json()).toEqual({ error: BAD_REPORT });
    expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit')).toBeNull();
  });

  it('refuses an unknown lock id with 409 and settles nothing', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    landPair(rig, 'deposit', INSIDE_HOLD);
    await startOk(rig, jobId, 'deposit');

    const res = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, 'no-such-lock'));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: NO_LOCK });
    await expectNothingSettled(rig, jobId);
  });

  it("refuses another job's lock with 409 and settles nothing", async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    const otherJobId = await walkToProposedAndPriced(rig);
    landPair(rig, 'deposit', INSIDE_HOLD);
    await startOk(rig, jobId, 'deposit');
    const otherLockId = await startOk(rig, otherJobId, 'deposit');

    const res = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, otherLockId));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: NO_LOCK });
    await expectNothingSettled(rig, jobId);
  });

  it("refuses another leg's lock with 409 and settles nothing", async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    landPair(rig, 'deposit', INSIDE_HOLD);
    landPair(rig, 'remainder', INSIDE_HOLD);
    const depositLock = await startOk(rig, jobId, 'deposit');
    setTime(INSIDE_HOLD);
    expect((await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, depositLock))).status).toBe(200);
    await postSigned(rig.baseUrl, `/jobs/${jobId}/confirm`, {}, rig.buyer);
    await postSigned(rig.baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-abt-eth-1' }, rig.agent);
    await startOk(rig, jobId, 'remainder');

    const res = await report(rig, jobId, 'remainder', reportBody(REMAINDER_PAIR, depositLock));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: NO_LOCK });
    expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'remainder')).toBeNull();
    expect(await paidLines(rig, jobId)).toEqual([DEPOSIT_PAID_LINE]);
  });

  it('refuses a lock made for a price that has since changed, with 409, and settles nothing', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    landPair(rig, 'deposit', INSIDE_HOLD);
    const lockId = await startOk(rig, jobId, 'deposit');
    await postSigned(rig.baseUrl, `/jobs/${jobId}/criteria`, { criteria, priceUsd: '600.00' }, rig.agent);

    const res = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: PRICE_CHANGED });
    await expectNothingSettled(rig, jobId);
  });
});

describe('the late-transfer rule', () => {
  it('(g) settles at the held price a transfer recorded inside the hold and reported after it', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    landPair(rig, 'deposit', INSIDE_HOLD);
    const lockId = await startOk(rig, jobId, 'deposit');
    setTime(REPORTED_AT);
    // The price fell a lot since: inside the hold, that does not matter.
    rig.feed.reading = { usdPerToken: '0.01', updatedAt: new Date('2026-10-06T12:39:00.000Z') };

    const res = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(confirmationBody(DEPOSIT_PAIR, INSIDE_HOLD));
    expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit')).toEqual(settlementRow(jobId, 'deposit', REPORTED_AT));
    expect(await paidLines(rig, jobId)).toEqual([DEPOSIT_PAID_LINE]);
    expect(await rig.shorts.findByJobAndLeg(jobId, 'deposit')).toEqual([]);
  });

  it('(h) settles a transfer recorded after the hold that is still worth the agreed price', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    landPair(rig, 'deposit', AFTER_HOLD);
    const lockId = await startOk(rig, jobId, 'deposit');
    setTime(REPORTED_AT);
    rig.feed.reading = { usdPerToken: '0.25', updatedAt: new Date('2026-10-06T12:39:00.000Z') };

    const res = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(confirmationBody(DEPOSIT_PAIR, AFTER_HOLD));
    expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit')).toEqual(settlementRow(jobId, 'deposit', REPORTED_AT));
    expect(await paidLines(rig, jobId)).toEqual([DEPOSIT_PAID_LINE]);
    expect(await rig.shorts.findByJobAndLeg(jobId, 'deposit')).toEqual([]);
  });

  it('(i) stores a transfer recorded after the hold that is worth less now as short, and settles nothing', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    landPair(rig, 'deposit', AFTER_HOLD);
    const lockId = await startOk(rig, jobId, 'deposit');
    setTime(REPORTED_AT);
    rig.feed.reading = { usdPerToken: '0.2', updatedAt: new Date('2026-10-06T12:39:00.000Z') };
    const jobBefore = await (await fetch(`${rig.baseUrl}/jobs/${jobId}`)).json();

    const res = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ...confirmationBody(DEPOSIT_PAIR, AFTER_HOLD),
      short: { recordedAt: AFTER_HOLD, agreedUsd: '125.00', worthUsd: '100' },
    });
    await expectNothingSettled(rig, jobId);
    expect(await rig.shorts.findByJobAndLeg(jobId, 'deposit')).toEqual([
      shortRow(jobId, lockId, { usdPerTokenAtRead: '0.2', worthUsd: '100', recordedAt: AFTER_HOLD, readAt: REPORTED_AT }),
    ]);
    expect(await (await fetch(`${rig.baseUrl}/jobs/${jobId}`)).json()).toEqual(jobBefore);
  });

  it('(j) stores a transfer recorded after the hold as short with no worth when no price can be read now', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    landPair(rig, 'deposit', AFTER_HOLD);
    const lockId = await startOk(rig, jobId, 'deposit');
    setTime(REPORTED_AT);
    rig.feed.reading = null;

    const res = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ...confirmationBody(DEPOSIT_PAIR, AFTER_HOLD),
      short: { recordedAt: AFTER_HOLD, agreedUsd: '125.00', worthUsd: null },
    });
    await expectNothingSettled(rig, jobId);
    expect(await rig.shorts.findByJobAndLeg(jobId, 'deposit')).toEqual([
      shortRow(jobId, lockId, { usdPerTokenAtRead: null, worthUsd: null, recordedAt: AFTER_HOLD, readAt: REPORTED_AT }),
    ]);
  });

  it('(k) judges a transfer with no block time as recorded after the hold, even when the report is inside it', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    landPair(rig, 'deposit', null);
    const lockId = await startOk(rig, jobId, 'deposit');
    // Inside the hold by the clock of the request, worth less now.
    setTime(INSIDE_HOLD);
    rig.feed.reading = { usdPerToken: '0.2', updatedAt: new Date('2026-10-06T12:09:00.000Z') };

    const res = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ...confirmationBody(DEPOSIT_PAIR, null),
      short: { recordedAt: null, agreedUsd: '125.00', worthUsd: '100' },
    });
    await expectNothingSettled(rig, jobId);
    expect(await rig.shorts.findByJobAndLeg(jobId, 'deposit')).toEqual([
      shortRow(jobId, lockId, { usdPerTokenAtRead: '0.2', worthUsd: '100', recordedAt: null, readAt: INSIDE_HOLD }),
    ]);
  });
});

describe('(l) a payment reported twice', () => {
  // A deposit recorded and reported inside the hold, then the buyer's
  // confirm, so the job has moved on when the report comes again.
  async function settledDeposit(rig: Rig): Promise<{ jobId: string; lockId: string; firstBody: unknown }> {
    const jobId = await walkToProposedAndPriced(rig);
    landPair(rig, 'deposit', INSIDE_HOLD);
    const lockId = await startOk(rig, jobId, 'deposit');
    setTime(INSIDE_HOLD);
    const firstBody = await (await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId))).json();
    expect((await postSigned(rig.baseUrl, `/jobs/${jobId}/confirm`, {}, rig.buyer)).status).toBe(200);
    setTime(REPORTED_AT);
    return { jobId, lockId, firstBody };
  }

  it('answers a settled leg as the first call did and leaves one settlement row with its first time and one paid line, even after the job moved on', async () => {
    const rig = await boot();
    const { jobId, lockId, firstBody } = await settledDeposit(rig);

    const again = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId));

    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(firstBody);
    expect(firstBody).toEqual(confirmationBody(DEPOSIT_PAIR, INSIDE_HOLD));
    expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit')).toEqual(settlementRow(jobId, 'deposit', INSIDE_HOLD));
    expect(await paidLines(rig, jobId)).toEqual([DEPOSIT_PAID_LINE]);
  });

  it('recognises the replay when both hashes come back in capitals, and writes nothing again', async () => {
    const rig = await boot();
    const { jobId, lockId, firstBody } = await settledDeposit(rig);
    const capitals = { price: DEP_PRICE.toUpperCase().replace('0X', '0x'), fee: DEP_FEE.toUpperCase().replace('0X', '0x') };

    const again = await report(rig, jobId, 'deposit', reportBody(capitals, lockId));

    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(firstBody);
    expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit')).toEqual(settlementRow(jobId, 'deposit', INSIDE_HOLD));
    expect(await paidLines(rig, jobId)).toEqual([DEPOSIT_PAID_LINE]);
  });

  it('refuses the recorded price hash with a different fee hash instead of treating it as a replay', async () => {
    const rig = await boot();
    const { jobId, lockId } = await settledDeposit(rig);
    const row = await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit');

    const res = await report(rig, jobId, 'deposit', reportBody({ price: DEP_PRICE, fee: REM_FEE }, lockId));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: legStatusConflictMessage('deposit', 'confirmed') });
    expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit')).toEqual(row);
    expect(await paidLines(rig, jobId)).toEqual([DEPOSIT_PAID_LINE]);
  });

  it('keeps one short row when a short leg is reported twice, and answers the same body', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    landPair(rig, 'deposit', AFTER_HOLD);
    const lockId = await startOk(rig, jobId, 'deposit');
    setTime(REPORTED_AT);
    rig.feed.reading = { usdPerToken: '0.2', updatedAt: new Date('2026-10-06T12:39:00.000Z') };
    const first = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId));
    const firstBody = await first.json();

    const again = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId));

    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(firstBody);
    expect(firstBody).toEqual({
      ...confirmationBody(DEPOSIT_PAIR, AFTER_HOLD),
      short: { recordedAt: AFTER_HOLD, agreedUsd: '125.00', worthUsd: '100' },
    });
    expect(await rig.shorts.findByJobAndLeg(jobId, 'deposit')).toHaveLength(1);
    await expectNothingSettled(rig, jobId);
  });
});

describe('(m) a half-paid leg', () => {
  it('settles nothing when the price confirmed and the fee did not, and the next start answers the half-paid record', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    rig.chain.receipts.set(DEP_PRICE, { status: 1, transfer: transfer(OWNER_ETH, DEP_PRICE_UNITS) });
    rig.chain.recorded.set(DEP_PRICE, new Date(INSIDE_HOLD));
    const lockId = await startOk(rig, jobId, 'deposit');
    setTime(INSIDE_HOLD);

    const res = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      rail: 'abt_eth',
      hash: DEP_PRICE,
      confirmed: false,
      legs: { price: { status: 'confirmed', hash: DEP_PRICE }, fee: { status: 'not_confirmed', hash: DEP_FEE } },
      halfPaid: true,
      priceRecordedAt: INSIDE_HOLD,
    });
    await expectNothingSettled(rig, jobId);
    expect(await rig.shorts.findByJobAndLeg(jobId, 'deposit')).toEqual([]);

    const restart = await startLeg(rig, jobId, 'deposit');

    // The restart finishes the payment at the lock its first transfer was
    // confirmed against: the same lock with its own hold end (12:15, not a
    // new 12:25), and no second lock row.
    expect(restart.status).toBe(200);
    expect(await restart.json()).toEqual({
      ...depositStartBody(lockId),
      jobId,
      halfPaidRecord: { priceTxHash: DEP_PRICE, priceStatus: 'confirmed', feeTxHash: DEP_FEE, feeStatus: 'not_confirmed' },
    });
    expect(rig.locks).toEqual([lockRow(jobId, lockId)]);
  });
});

describe('(n) the rail is offered only when the owner set it up', () => {
  async function payableRails(rig: Rig, jobId: string): Promise<unknown> {
    return ((await (await fetch(`${rig.baseUrl}/jobs/${jobId}`)).json()) as { payableRails?: unknown }).payableRails;
  }

  it('lists abt_eth, after the other two, exactly when the owner has an ABT-on-Ethereum address', async () => {
    const withAddress = await boot({ ownerUsdc: OWNER_USDC });
    const withoutAddress = await boot({ ownerEth: null, ownerUsdc: OWNER_USDC });
    const withAddressJob = await walkToProposedAndPriced(withAddress);
    const withoutAddressJob = await walkToProposedAndPriced(withoutAddress);

    expect(await payableRails(withAddress, withAddressJob)).toEqual(['usdc', 'abt_eth']);
    expect(await payableRails(withoutAddress, withoutAddressJob)).toEqual(['usdc']);
  });

  it('lists only abt_eth for an owner with no other address', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);

    expect(await payableRails(rig, jobId)).toEqual(['abt_eth']);
  });

  it('accepts a quote naming abt_eth and pins the job; the ABT and USDC doors then refuse it', async () => {
    const app = await startOpenRailAppWithRails({ abt: 'z1OperatorAbt', evm: OWNER_USDC });
    servers.push(app.server);
    const jobId = await walkToProposedAndPriced(app, 'abt_eth');
    const read = (await (await fetch(`${app.baseUrl}/jobs/${jobId}`)).json()) as { payableRails?: unknown; price?: { rail?: unknown } };
    const usdcStart = await postSigned(app.baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, {}, app.buyer);
    const abtStart = await postSigned(app.baseUrl, `/jobs/${jobId}/payments/deposit/abt/start`, {}, app.buyer);

    expect(read.payableRails).toEqual(['abt_eth']);
    expect(read.price?.rail).toBe('abt_eth');
    expect(usdcStart.status).toBe(409);
    expect(await usdcStart.json()).toEqual({ error: legRailMismatchMessage('usdc', 'abt_eth') });
    expect(abtStart.status).toBe(409);
    expect(await abtStart.json()).toEqual({ error: legRailMismatchMessage('abt', 'abt_eth') });
  });

  it('answers a quote naming a rail that is not one of the three with 400 naming all three', async () => {
    const rig = await boot();
    const jobId = await createJob(rig);

    const res = await postSigned(rig.baseUrl, `/jobs/${jobId}/criteria`, { criteria, priceUsd: '500.00', rail: 'paypal' }, rig.agent);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        'a proposed price must be { priceUsd, rail?, deliveryWindowDays? }; priceUsd a decimal string, rail (if present) "abt", "usdc" or "abt_eth", deliveryWindowDays (if present) a positive integer',
    });
  });
});

describe('(o) the remainder leg settles on its own', () => {
  async function payDeposit(rig: Rig, jobId: string): Promise<void> {
    landPair(rig, 'deposit', INSIDE_HOLD);
    const lockId = await startOk(rig, jobId, 'deposit');
    setTime(INSIDE_HOLD);
    expect((await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId))).status).toBe(200);
    expect((await postSigned(rig.baseUrl, `/jobs/${jobId}/confirm`, {}, rig.buyer)).status).toBe(200);
    expect((await postSigned(rig.baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-abt-eth-1' }, rig.agent)).status).toBe(200);
  }

  it('opens the pull-request gate, which stays shut until the remainder settles', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    await payDeposit(rig, jobId);
    const before = rig.fixture.calls.getPullRequest.length;

    const blocked = await postSigned(rig.baseUrl, `/jobs/${jobId}/pull-request`, { pullRequestUrl: 'https://github.com/buyer/target-repo/pull/1' }, rig.agent);
    expect(blocked.status).toBe(402);
    expect(rig.fixture.calls.getPullRequest.length).toBe(before);

    landPair(rig, 'remainder', '2026-10-06T12:12:00.000Z');
    const lockId = await startOk(rig, jobId, 'remainder');
    const paid = await report(rig, jobId, 'remainder', reportBody(REMAINDER_PAIR, lockId));
    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual(confirmationBody(REMAINDER_PAIR, '2026-10-06T12:12:00.000Z'));
    expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'remainder')).toEqual(settlementRow(jobId, 'remainder', INSIDE_HOLD));
    expect(await paidLines(rig, jobId)).toEqual([DEPOSIT_PAID_LINE, REMAINDER_PAID_LINE]);

    const { url } = registerAgentForkPullRequest(rig.fixture, {
      repository: 'buyer/target-repo',
      jobId,
      stagedCommit: 'commit-abt-eth-1',
      agentLogin: 'scout-abt-eth',
    });
    const opened = await postSigned(rig.baseUrl, `/jobs/${jobId}/pull-request`, { pullRequestUrl: url }, rig.agent);
    expect(opened.status).toBe(200);
    expect(rig.fixture.calls.getPullRequest.length).toBe(before + 1);
  });

  it('starts the delivery clock from the remainder row it first wrote, and a later replay does not move it', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    await payDeposit(rig, jobId);
    const remainderAt = new Date(INSIDE_HOLD).getTime();
    setTime(INSIDE_HOLD);
    landPair(rig, 'remainder', INSIDE_HOLD);
    const lockId = await startOk(rig, jobId, 'remainder');
    expect((await report(rig, jobId, 'remainder', reportBody(REMAINDER_PAIR, lockId))).status).toBe(200);
    // A replay five days on. It must not move the row the clock counts from.
    vi.setSystemTime(new Date(remainderAt + 5 * DAY_MS));
    expect((await report(rig, jobId, 'remainder', reportBody(REMAINDER_PAIR, lockId))).status).toBe(200);
    expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'remainder')).toEqual(settlementRow(jobId, 'remainder', INSIDE_HOLD));

    vi.setSystemTime(new Date(remainderAt + 7 * DAY_MS));
    const atSeven = (await (await fetch(`${rig.baseUrl}/jobs/${jobId}`)).json()) as { status: string };
    vi.setSystemTime(new Date(remainderAt + 7 * DAY_MS + 1));
    const pastSeven = (await (await fetch(`${rig.baseUrl}/jobs/${jobId}`)).json()) as { status: string };

    expect(atSeven.status).toBe('staged');
    expect(pastSeven.status).toBe('paid_undelivered');
    expect(await paidLines(rig, jobId)).toEqual([DEPOSIT_PAID_LINE, REMAINDER_PAID_LINE]);
  });
});

// A leg whose first transfer the network recorded at one lock's amounts is
// finished at that lock: the same amounts and the same hold. A later start
// never re-prices it, and a report that names a newer lock for a transfer
// already on record is refused without touching the record.
describe('(p) a half-paid leg is finished at the lock its first transfer was confirmed against', () => {
  const EARLIER_PRICE_SENTENCE = 'This payment was started at an earlier price. Reload the page to finish it.';
  const RESENT_PRICE = '0xaaaa000000000000000000000000000000000000000000000000000000000005';
  const FEED_LATER = new Date('2026-10-06T12:39:00.000Z');
  const AFTER_HOLD_REPORT = '2026-10-06T12:21:00.000Z';
  const PRICE_ONLY_RECORD = { priceTxHash: DEP_PRICE, priceStatus: 'confirmed', feeTxHash: DEP_FEE, feeStatus: 'not_confirmed' } as const;

  function landPrice(rig: Rig, hash: string, recordedAt: string): void {
    rig.chain.receipts.set(hash, { status: 1, transfer: transfer(OWNER_ETH, DEP_PRICE_UNITS) });
    rig.chain.recorded.set(hash, new Date(recordedAt));
  }

  function landFee(rig: Rig): void {
    rig.chain.receipts.set(DEP_FEE, { status: 1, transfer: transfer(FEE_ADDRESS, DEP_FEE_UNITS) });
  }

  // The deposit started at lock1 (500 ABT plus 15 at 0.25), the price
  // transfer recorded at `recordedAt` and reported at `reportedAt`, the fee
  // not on the network yet. Answers the job and lock1's id.
  async function halfPaidAtLock1(rig: Rig, recordedAt: string, reportedAt: string): Promise<{ jobId: string; lockId: string }> {
    const jobId = await walkToProposedAndPriced(rig);
    landPrice(rig, DEP_PRICE, recordedAt);
    const lockId = await startOk(rig, jobId, 'deposit');
    setTime(reportedAt);
    const res = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      rail: 'abt_eth',
      hash: DEP_PRICE,
      confirmed: false,
      legs: { price: { status: 'confirmed', hash: DEP_PRICE }, fee: { status: 'not_confirmed', hash: DEP_FEE } },
      halfPaid: true,
      priceRecordedAt: recordedAt,
    });
    return { jobId, lockId };
  }

  // The deposit started at lock1 and the price transfer failed on the network
  // while the fee confirmed: a half-paid leg whose price has NOT reached the
  // owner (the fee is the transfer already on the network). Answers the job
  // and lock1's id.
  const FEE_ONLY_RECORD = { priceTxHash: DEP_PRICE, priceStatus: 'not_confirmed', feeTxHash: DEP_FEE, feeStatus: 'confirmed' } as const;
  async function feeOnlyAtLock1(rig: Rig): Promise<{ jobId: string; lockId: string }> {
    const jobId = await walkToProposedAndPriced(rig);
    rig.chain.receipts.set(DEP_PRICE, { status: 0, transfer: null });
    landFee(rig);
    const lockId = await startOk(rig, jobId, 'deposit');
    setTime(INSIDE_HOLD);
    const res = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      rail: 'abt_eth',
      hash: DEP_PRICE,
      confirmed: false,
      legs: { price: { status: 'not_confirmed', hash: DEP_PRICE }, fee: { status: 'confirmed', hash: DEP_FEE } },
      halfPaid: true,
      priceRecordedAt: null,
    });
    return { jobId, lockId };
  }

  // ABT is worth 0.20 now, and the clock is past the hold.
  function priceMovesAndHoldPasses(rig: Rig): void {
    setTime(REPORTED_AT);
    rig.feed.reading = { usdPerToken: '0.2', updatedAt: FEED_LATER };
  }

  // What a start answers for a leg half-paid at lock1: lock1's own amounts,
  // lock1 with its own hold end, and the record.
  function lock1Restart(jobId: string, lockId: string, halfPaidRecord: Record<string, unknown>): Record<string, unknown> {
    return { ...depositStartBody(lockId), jobId, halfPaidRecord };
  }

  it('(a) answers lock1 after the price moved and the hold passed, writes no lock, and settles at lock1 when the fee lands', async () => {
    const rig = await boot();
    const { jobId, lockId } = await halfPaidAtLock1(rig, INSIDE_HOLD, INSIDE_HOLD);
    priceMovesAndHoldPasses(rig);

    const restart = await startLeg(rig, jobId, 'deposit');

    expect(restart.status).toBe(200);
    expect(await restart.json()).toEqual(lock1Restart(jobId, lockId, PRICE_ONLY_RECORD));
    expect(rig.locks).toEqual([lockRow(jobId, lockId)]);

    landFee(rig);
    const done = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId));

    expect(done.status).toBe(200);
    expect(await done.json()).toEqual(confirmationBody(DEPOSIT_PAIR, INSIDE_HOLD));
    expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit')).toEqual(settlementRow(jobId, 'deposit', REPORTED_AT));
    expect(await paidLines(rig, jobId)).toEqual([DEPOSIT_PAID_LINE]);
    expect(await rig.halfPaid.read(jobId, 'deposit')).toBeNull();
  });

  it('(a2) answers lock1 on a restart while the feed has no reading, and makes no quote', async () => {
    const rig = await boot();
    const { jobId, lockId } = await halfPaidAtLock1(rig, INSIDE_HOLD, INSIDE_HOLD);
    setTime(REPORTED_AT);
    rig.feed.reading = null;

    const restart = await startLeg(rig, jobId, 'deposit');

    expect(restart.status).toBe(200);
    expect(await restart.json()).toEqual(lock1Restart(jobId, lockId, PRICE_ONLY_RECORD));
    expect(rig.locks).toEqual([lockRow(jobId, lockId)]);
  });

  it('(b) answers the fee amount of lock1 when the fee was refused, and the fee sent at that amount settles the leg with lock1', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    landPrice(rig, DEP_PRICE, INSIDE_HOLD);
    const lockId = await startOk(rig, jobId, 'deposit');
    setTime(INSIDE_HOLD);
    const refused = await report(rig, jobId, 'deposit', { priceTxHash: DEP_PRICE, feeTx: { signed: false }, quoteLockId: lockId });
    expect(refused.status).toBe(200);
    expect(await refused.json()).toEqual({
      rail: 'abt_eth',
      hash: DEP_PRICE,
      confirmed: false,
      legs: { price: { status: 'confirmed', hash: DEP_PRICE }, fee: { status: 'not_signed' } },
      halfPaid: true,
      priceRecordedAt: INSIDE_HOLD,
    });
    priceMovesAndHoldPasses(rig);

    const restart = await startLeg(rig, jobId, 'deposit');

    // The fee is lock1's 15 ABT, not 18.75 at the 0.20 the feed reads now.
    expect(restart.status).toBe(200);
    expect(await restart.json()).toEqual(
      lock1Restart(jobId, lockId, { priceTxHash: DEP_PRICE, priceStatus: 'confirmed', feeTxHash: null, feeStatus: 'not_signed' }),
    );
    expect(rig.locks).toEqual([lockRow(jobId, lockId)]);

    landFee(rig);
    const done = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId));

    expect(done.status).toBe(200);
    expect(await done.json()).toEqual(confirmationBody(DEPOSIT_PAIR, INSIDE_HOLD));
    expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit')).toEqual(settlementRow(jobId, 'deposit', REPORTED_AT));
    expect(await paidLines(rig, jobId)).toEqual([DEPOSIT_PAID_LINE]);
  });

  it('(c) refuses a report that names another lock for the recorded price hash, in capitals, and loses nothing', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    landPrice(rig, DEP_PRICE, INSIDE_HOLD);
    const lockId = await startOk(rig, jobId, 'deposit');
    const otherLockId = await startOk(rig, jobId, 'deposit');
    expect(otherLockId).not.toBe(lockId);
    setTime(INSIDE_HOLD);
    const first = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId));
    expect((await first.json()) as { halfPaid: boolean }).toMatchObject({ halfPaid: true });
    landFee(rig);
    const capitals = { price: DEP_PRICE.toUpperCase().replace('0X', '0x'), fee: DEP_FEE.toUpperCase().replace('0X', '0x') };

    const res = await report(rig, jobId, 'deposit', reportBody(capitals, otherLockId));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: EARLIER_PRICE_SENTENCE });
    await expectNothingSettled(rig, jobId);
    expect(await rig.shorts.findByJobAndLeg(jobId, 'deposit')).toEqual([]);
    expect(await rig.halfPaid.read(jobId, 'deposit')).toEqual({
      jobId, leg: 'deposit', ...PRICE_ONLY_RECORD, lockId,
    });
    const restart = await startLeg(rig, jobId, 'deposit');
    expect(restart.status).toBe(200);
    expect(await restart.json()).toEqual(lock1Restart(jobId, lockId, PRICE_ONLY_RECORD));
    expect(rig.locks).toHaveLength(2);
  });

  it('(d) settles at the held price when the price was recorded inside lock1\'s hold and the fee landed after it', async () => {
    const rig = await boot();
    const { jobId, lockId } = await halfPaidAtLock1(rig, INSIDE_HOLD, INSIDE_HOLD);
    priceMovesAndHoldPasses(rig);
    landFee(rig);

    const done = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId));

    expect(done.status).toBe(200);
    expect(await done.json()).toEqual(confirmationBody(DEPOSIT_PAIR, INSIDE_HOLD));
    expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit')).toEqual(settlementRow(jobId, 'deposit', REPORTED_AT));
    expect(await paidLines(rig, jobId)).toEqual([DEPOSIT_PAID_LINE]);
    expect(await rig.shorts.findByJobAndLeg(jobId, 'deposit')).toEqual([]);
  });

  it('(d2) stores the leg as short, judged against lock1, when the price was recorded after lock1\'s hold and ABT is worth less now', async () => {
    const rig = await boot();
    const { jobId, lockId } = await halfPaidAtLock1(rig, AFTER_HOLD, AFTER_HOLD_REPORT);
    priceMovesAndHoldPasses(rig);
    landFee(rig);

    const done = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId));

    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({
      ...confirmationBody(DEPOSIT_PAIR, AFTER_HOLD),
      short: { recordedAt: AFTER_HOLD, agreedUsd: '125.00', worthUsd: '100' },
    });
    await expectNothingSettled(rig, jobId);
    expect(await rig.shorts.findByJobAndLeg(jobId, 'deposit')).toEqual([
      shortRow(jobId, lockId, { usdPerTokenAtRead: '0.2', worthUsd: '100', recordedAt: AFTER_HOLD, readAt: REPORTED_AT }),
    ]);
  });

  it('(e) keeps today\'s start for a half-paid record that names no lock: a new lock at the current price', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    await rig.halfPaid.record({ jobId, leg: 'deposit', ...PRICE_ONLY_RECORD, lockId: null });
    priceMovesAndHoldPasses(rig);

    const restart = await startLeg(rig, jobId, 'deposit');

    expect(restart.status).toBe(200);
    const created = rig.locks[0];
    if (created === undefined) throw new Error('expected a new lock row');
    expect(await restart.json()).toEqual({
      rail: 'abt_eth',
      jobId,
      leg: 'deposit',
      chainId: CHAIN_ID,
      transfers: [
        { recipient: OWNER_ETH, amountBaseUnits: '625000000000000000000', tokenContract: ABT_TOKEN },
        { recipient: FEE_ADDRESS, amountBaseUnits: '18750000000000000000', tokenContract: ABT_TOKEN },
      ],
      quoteLock: { id: created.id, usdPerAbt: '0.2', rateUpdatedAt: FEED_LATER.toISOString(), expiresAt: '2026-10-06T12:55:00.000Z' },
      halfPaidRecord: PRICE_ONLY_RECORD,
    });
    expect(rig.locks).toEqual([
      lockRow(jobId, created.id, {
        usdPerToken: '0.2', rateUpdatedAt: FEED_LATER, amountToken: '625', feeToken: '18.75',
        lockedAt: new Date(REPORTED_AT), expiresAt: new Date('2026-10-06T12:55:00.000Z'),
      }),
    ]);
  });

  it('(f) answers lock1 when the price transfer failed on the network and the fee confirmed, and a resent price transfer settles with lock1', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    rig.chain.receipts.set(DEP_PRICE, { status: 0, transfer: null });
    landFee(rig);
    const lockId = await startOk(rig, jobId, 'deposit');
    setTime(INSIDE_HOLD);
    const failed = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId));
    expect(failed.status).toBe(200);
    expect(await failed.json()).toEqual({
      rail: 'abt_eth',
      hash: DEP_PRICE,
      confirmed: false,
      legs: { price: { status: 'not_confirmed', hash: DEP_PRICE }, fee: { status: 'confirmed', hash: DEP_FEE } },
      halfPaid: true,
      priceRecordedAt: null,
    });
    priceMovesAndHoldPasses(rig);

    const restart = await startLeg(rig, jobId, 'deposit');

    expect(restart.status).toBe(200);
    expect(await restart.json()).toEqual(
      lock1Restart(jobId, lockId, { priceTxHash: DEP_PRICE, priceStatus: 'not_confirmed', feeTxHash: DEP_FEE, feeStatus: 'confirmed' }),
    );
    expect(rig.locks).toEqual([lockRow(jobId, lockId)]);

    landPrice(rig, RESENT_PRICE, INSIDE_HOLD);
    const done = await report(rig, jobId, 'deposit', reportBody({ price: RESENT_PRICE, fee: DEP_FEE }, lockId));

    expect(done.status).toBe(200);
    expect(await done.json()).toEqual(confirmationBody({ price: RESENT_PRICE, fee: DEP_FEE }, INSIDE_HOLD));
    expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit')).toEqual({
      ...settlementRow(jobId, 'deposit', REPORTED_AT),
      hash: RESENT_PRICE,
    });
    expect(await paidLines(rig, jobId)).toEqual([DEPOSIT_PAID_LINE]);
  });

  it('(g) writes the id of the lock it checked into the record, whatever spelling the report used', async () => {
    const rig = await boot({ lockIdsIgnoreCase: true });
    const jobId = await walkToProposedAndPriced(rig);
    landPrice(rig, DEP_PRICE, INSIDE_HOLD);
    const lockId = await startOk(rig, jobId, 'deposit');
    setTime(INSIDE_HOLD);

    const res = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId.toUpperCase()));

    expect(res.status).toBe(200);
    expect(await rig.halfPaid.read(jobId, 'deposit')).toEqual({ jobId, leg: 'deposit', ...PRICE_ONLY_RECORD, lockId });
  });

  it('(h) refuses a start whose half-paid record names a lock that fails its check, with the lock sentence, and writes nothing', async () => {
    const rig = await boot();
    const jobId = await walkToProposedAndPriced(rig);
    await rig.halfPaid.record({ jobId, leg: 'deposit', ...PRICE_ONLY_RECORD, lockId: 'no-such-lock' });

    const res = await startLeg(rig, jobId, 'deposit');

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: NO_LOCK });
    expect(rig.locks).toEqual([]);
  });

  // The half-paid price-changed sentence meets a leg whose FEE is the transfer
  // already on the network (a half-paid leg whose price confirmed is held, and
  // the re-price is refused before it lands: see (j)). So every case here sets
  // up the fee-only leg of case (f).
  describe('(i) the agreed price changes while only the fee transfer is on the network', () => {
    const HALF_PAID_REPRICED_SENTENCE =
      "One of this payment's two transfers is already on the network, at the price agreed when it started. " +
      'The agreed price has changed since. Ask the agent to put that earlier price back, and this payment can be finished.';

    async function reprice(rig: Rig, jobId: string, priceUsd: string): Promise<void> {
      expect((await postSigned(rig.baseUrl, `/jobs/${jobId}/criteria`, { criteria, priceUsd }, rig.agent)).status).toBe(200);
      for (const index of [0, 1]) {
        expect((await postSigned(rig.baseUrl, `/jobs/${jobId}/criteria/${index}/accept`, {}, rig.buyer)).status).toBe(200);
        expect((await postSigned(rig.baseUrl, `/jobs/${jobId}/criteria/${index}/accept`, {}, rig.agent)).status).toBe(200);
      }
      expect((await postSigned(rig.baseUrl, `/jobs/${jobId}/price/accept`, {}, rig.buyer)).status).toBe(200);
      expect((await postSigned(rig.baseUrl, `/jobs/${jobId}/price/accept`, {}, rig.agent)).status).toBe(200);
    }

    it('refuses a start with the sentence that names what the buyer can do, and writes no lock', async () => {
      const rig = await boot();
      const { jobId, lockId } = await feeOnlyAtLock1(rig);
      await reprice(rig, jobId, '600.00');

      const res = await startLeg(rig, jobId, 'deposit');

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: HALF_PAID_REPRICED_SENTENCE });
      expect(rig.locks).toEqual([lockRow(jobId, lockId)]);
    });

    it('refuses a resent price transfer reported with lock1 with the same sentence, settles nothing, and keeps the record', async () => {
      const rig = await boot();
      const { jobId, lockId } = await feeOnlyAtLock1(rig);
      await reprice(rig, jobId, '600.00');
      landPrice(rig, RESENT_PRICE, INSIDE_HOLD);

      const res = await report(rig, jobId, 'deposit', reportBody({ price: RESENT_PRICE, fee: DEP_FEE }, lockId));

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: HALF_PAID_REPRICED_SENTENCE });
      await expectNothingSettled(rig, jobId);
      expect(await rig.halfPaid.read(jobId, 'deposit')).toEqual({ jobId, leg: 'deposit', ...FEE_ONLY_RECORD, lockId });
    });

    it('finishes the leg at lock1 once the earlier price is put back', async () => {
      const rig = await boot();
      const { jobId, lockId } = await feeOnlyAtLock1(rig);
      await reprice(rig, jobId, '600.00');
      await reprice(rig, jobId, '500.00');
      priceMovesAndHoldPasses(rig);

      const restart = await startLeg(rig, jobId, 'deposit');

      expect(restart.status).toBe(200);
      expect(await restart.json()).toEqual(lock1Restart(jobId, lockId, FEE_ONLY_RECORD));
      landPrice(rig, RESENT_PRICE, INSIDE_HOLD);
      const done = await report(rig, jobId, 'deposit', reportBody({ price: RESENT_PRICE, fee: DEP_FEE }, lockId));
      expect(done.status).toBe(200);
      expect(await done.json()).toEqual(confirmationBody({ price: RESENT_PRICE, fee: DEP_FEE }, INSIDE_HOLD));
      expect(await paidLines(rig, jobId)).toEqual([DEPOSIT_PAID_LINE]);
    });

    it('keeps the lock sentence for a leg that is not half paid', async () => {
      const rig = await boot();
      const jobId = await walkToProposedAndPriced(rig);
      landPair(rig, 'deposit', INSIDE_HOLD);
      const lockId = await startOk(rig, jobId, 'deposit');
      await reprice(rig, jobId, '600.00');

      const res = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId));

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: PRICE_CHANGED });
    });
  });

  // B88: a leg whose price transfer already reached the owner and has not
  // settled holds the way a settled leg does. These cases run on the real
  // routes with the USDC rail wired beside this one where the second currency
  // matters.
  describe('(j) a leg whose price transfer reached the owner is held', () => {
    const HELD_TERMS = "The deposit's price has already reached the owner, so the terms can no longer change. The buyer finishes the payment, then confirms the hire.";
    const HELD_WITHDRAW = "The deposit's price has already reached the owner, so this hire can no longer be withdrawn. Finish the payment, then confirm the hire.";
    const HELD_DECLINE = "The deposit's price has already reached the owner, so this hire can no longer be declined.";
    const HELD_STAGED_DECLINE = "The balance's price has already reached the owner, so the work can no longer be declined. Finish the payment, and the agent opens the pull request next.";
    const HELD_REDO = "The balance's price has already reached the owner, so a redo can no longer be requested. Finish the payment, and the agent opens the pull request next.";
    const HELD_IN_ABT_ETH = 'part of the deposit for this job was paid in "abt_eth"; finish it there, the "usdc" payment routes refuse it';
    const STORAGE_DOWN = { error: 'storage unavailable' };
    const USDC_PRICE = '0xcc01';
    const USDC_FEE = '0xcc02';
    const BOTH = { usdcRail: true, ownerUsdc: OWNER_USDC } as const;

    async function readJob(rig: Rig, jobId: string): Promise<unknown> {
      return (await fetch(`${rig.baseUrl}/jobs/${jobId}`)).json();
    }

    function usdcPath(jobId: string, route: 'start' | 'wallet-response'): string {
      return `/jobs/${jobId}/payments/deposit/usdc/${route}`;
    }

    // The USDC deposit, 125.00 to the owner and 7.50 as the fee: the price
    // transfer on the network, the fee approved in the wallet and not yet on
    // the network. Answers the job.
    async function usdcHalfPaid(rig: Rig): Promise<string> {
      const jobId = await walkToProposedAndPriced(rig);
      expect((await postSigned(rig.baseUrl, usdcPath(jobId, 'start'), {}, rig.buyer)).status).toBe(200);
      rig.usdcReceipts.set(USDC_PRICE, { status: 1, transfer: { to: OWNER_USDC, value: '125000000', tokenContract: USDC_TOKEN, chainId: USDC_CHAIN_ID } });
      const res = await postSigned(rig.baseUrl, usdcPath(jobId, 'wallet-response'), { priceTxHash: USDC_PRICE, feeTx: { signed: true, hash: USDC_FEE } }, rig.buyer);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        rail: 'usdc',
        hash: USDC_PRICE,
        confirmed: false,
        legs: { price: { status: 'confirmed', hash: USDC_PRICE }, fee: { status: 'not_confirmed', hash: USDC_FEE } },
        halfPaid: true,
      });
      return jobId;
    }

    async function payableRails(rig: Rig, jobId: string): Promise<unknown> {
      return ((await readJob(rig, jobId)) as { payableRails?: unknown }).payableRails;
    }

    it('(a) refuses the agent\'s and the buyer\'s re-price of a USDC deposit half-paid, leaves the job as it was, and settles it at 125.00 when the fee lands', async () => {
      const rig = await boot(BOTH);
      const jobId = await usdcHalfPaid(rig);
      const before = structuredClone(await readJob(rig, jobId));

      const byAgent = await postSigned(rig.baseUrl, `/jobs/${jobId}/criteria`, { criteria, priceUsd: '600.00' }, rig.agent);
      const byBuyer = await postSigned(rig.baseUrl, `/jobs/${jobId}/criteria`, { criteria, priceUsd: '600.00' }, rig.buyer);

      expect(byAgent.status).toBe(409);
      expect(await byAgent.json()).toEqual({ error: HELD_TERMS });
      expect(byBuyer.status).toBe(409);
      expect(await byBuyer.json()).toEqual({ error: HELD_TERMS });
      expect(await readJob(rig, jobId)).toEqual(before);

      rig.usdcReceipts.set(USDC_FEE, { status: 1, transfer: { to: USDC_FEE_ADDRESS, value: '7500000', tokenContract: USDC_TOKEN, chainId: USDC_CHAIN_ID } });
      const done = await postSigned(rig.baseUrl, usdcPath(jobId, 'wallet-response'), { priceTxHash: USDC_PRICE, feeTx: { signed: true, hash: USDC_FEE } }, rig.buyer);

      expect(done.status).toBe(200);
      expect(await done.json()).toEqual({
        rail: 'usdc',
        hash: USDC_PRICE,
        confirmed: true,
        legs: { price: { status: 'confirmed', hash: USDC_PRICE }, fee: { status: 'confirmed', hash: USDC_FEE } },
        halfPaid: false,
      });
      expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit')).toEqual({
        jobId, leg: 'deposit', rail: 'usdc', hash: USDC_PRICE, secondaryHash: USDC_FEE,
        operatorAddress: OWNER_USDC, feeAddress: USDC_FEE_ADDRESS, amountUsd: '125.00', observedAt: NOW,
      });
      expect(await paidLines(rig, jobId)).toEqual([{
        body: 'Deposit paid',
        systemEvent: { type: 'deposit_paid', leg: 'deposit', amountUsd: '125.00', rail: 'usdc' },
      }]);
    });

    it('(b) refuses the re-price of a deposit half-paid at lock1, leaves the job as it was, answers lock1 on a restart, and settles at lock1 when the fee lands', async () => {
      const rig = await boot();
      const { jobId, lockId } = await halfPaidAtLock1(rig, INSIDE_HOLD, INSIDE_HOLD);
      const before = structuredClone(await readJob(rig, jobId));

      const res = await postSigned(rig.baseUrl, `/jobs/${jobId}/criteria`, { criteria, priceUsd: '600.00' }, rig.agent);

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: HELD_TERMS });
      expect(await readJob(rig, jobId)).toEqual(before);
      priceMovesAndHoldPasses(rig);
      const restart = await startLeg(rig, jobId, 'deposit');
      expect(restart.status).toBe(200);
      expect(await restart.json()).toEqual(lock1Restart(jobId, lockId, PRICE_ONLY_RECORD));
      landFee(rig);
      const done = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId));
      expect(done.status).toBe(200);
      expect(await done.json()).toEqual(confirmationBody(DEPOSIT_PAIR, INSIDE_HOLD));
      expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit')).toEqual(settlementRow(jobId, 'deposit', REPORTED_AT));
    });

    it('(c) refuses the buyer\'s withdraw of a half-paid deposit, and the job stays as it was', async () => {
      const rig = await boot();
      const { jobId } = await halfPaidAtLock1(rig, INSIDE_HOLD, INSIDE_HOLD);
      const before = structuredClone(await readJob(rig, jobId));

      const res = await postSigned(rig.baseUrl, `/jobs/${jobId}/withdraw`, {}, rig.buyer);

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: HELD_WITHDRAW });
      expect(await readJob(rig, jobId)).toEqual(before);
    });

    it('(c) refuses the buyer\'s withdraw of a deposit half-paid in USDC, and the job stays as it was', async () => {
      const rig = await boot(BOTH);
      const jobId = await usdcHalfPaid(rig);
      const before = structuredClone(await readJob(rig, jobId));

      const res = await postSigned(rig.baseUrl, `/jobs/${jobId}/withdraw`, {}, rig.buyer);

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: HELD_WITHDRAW });
      expect(await readJob(rig, jobId)).toEqual(before);
    });

    it('(d) refuses the agent\'s decline of a half-paid deposit, and the job stays as it was', async () => {
      const rig = await boot();
      const { jobId } = await halfPaidAtLock1(rig, INSIDE_HOLD, INSIDE_HOLD);
      const before = structuredClone(await readJob(rig, jobId));

      const res = await postSigned(rig.baseUrl, `/jobs/${jobId}/decline`, {}, rig.agent);

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: HELD_DECLINE });
      expect(await readJob(rig, jobId)).toEqual(before);
    });

    // The deposit paid and confirmed, the work staged, and the remainder's
    // price transfer on the network with its fee not yet.
    async function halfPaidRemainder(rig: Rig): Promise<string> {
      const jobId = await walkToProposedAndPriced(rig);
      landPair(rig, 'deposit', INSIDE_HOLD);
      const depositLock = await startOk(rig, jobId, 'deposit');
      setTime(INSIDE_HOLD);
      expect((await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, depositLock))).status).toBe(200);
      expect((await postSigned(rig.baseUrl, `/jobs/${jobId}/confirm`, {}, rig.buyer)).status).toBe(200);
      expect((await postSigned(rig.baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-abt-eth-1' }, rig.agent)).status).toBe(200);
      rig.chain.receipts.set(REM_PRICE, { status: 1, transfer: transfer(OWNER_ETH, REM_PRICE_UNITS) });
      rig.chain.recorded.set(REM_PRICE, new Date(INSIDE_HOLD));
      const lockId = await startOk(rig, jobId, 'remainder');
      const res = await report(rig, jobId, 'remainder', reportBody(REMAINDER_PAIR, lockId));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        rail: 'abt_eth',
        hash: REM_PRICE,
        confirmed: false,
        legs: { price: { status: 'confirmed', hash: REM_PRICE }, fee: { status: 'not_confirmed', hash: REM_FEE } },
        halfPaid: true,
        priceRecordedAt: INSIDE_HOLD,
      });
      return jobId;
    }

    it.each([
      ['staged-decline', 'staged-decline', {}, HELD_STAGED_DECLINE],
      ['redo', 'redo', { criterionIndex: 0 }, HELD_REDO],
    ])('(e) refuses the buyer\'s %s on a half-paid remainder, and the job is still staged with no redo recorded', async (_name, route, body, sentence) => {
      const rig = await boot();
      const jobId = await halfPaidRemainder(rig);
      const before = structuredClone(await readJob(rig, jobId));

      const res = await postSigned(rig.baseUrl, `/jobs/${jobId}/${route}`, body, rig.buyer);

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: sentence });
      const after = await readJob(rig, jobId);
      expect(after).toEqual(before);
      expect((after as { status: string }).status).toBe('staged');
    });

    it.each([
      ['abt_eth/start', (rig: Rig, jobId: string) => startLeg(rig, jobId, 'deposit')],
      // A fresh pair, not a replay: nothing is recorded for these hashes.
      ['abt_eth/wallet-response', (rig: Rig, jobId: string) => report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, 'a-lock-this-door-never-checks'))],
    ])('(f) refuses a deposit half-paid in USDC at %s, writes no lock and no settlement', async (_door, call) => {
      const rig = await boot(BOTH);
      const jobId = await usdcHalfPaid(rig);

      const res = await call(rig, jobId);

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'part of the deposit for this job was paid in "usdc"; finish it there, the "abt_eth" payment routes refuse it',
      });
      expect(rig.locks).toEqual([]);
      await expectNothingSettled(rig, jobId);
    });

    it('(f) offers only USDC for a deposit half-paid in USDC, and the USDC rail finishes the leg with one settlement row', async () => {
      const rig = await boot(BOTH);
      const jobId = await usdcHalfPaid(rig);

      expect(await payableRails(rig, jobId)).toEqual(['usdc']);

      rig.usdcReceipts.set(USDC_FEE, { status: 1, transfer: { to: USDC_FEE_ADDRESS, value: '7500000', tokenContract: USDC_TOKEN, chainId: USDC_CHAIN_ID } });
      const done = await postSigned(rig.baseUrl, usdcPath(jobId, 'wallet-response'), { priceTxHash: USDC_PRICE, feeTx: { signed: true, hash: USDC_FEE } }, rig.buyer);
      expect(done.status).toBe(200);
      expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit')).toEqual({
        jobId, leg: 'deposit', rail: 'usdc', hash: USDC_PRICE, secondaryHash: USDC_FEE,
        operatorAddress: OWNER_USDC, feeAddress: USDC_FEE_ADDRESS, amountUsd: '125.00', observedAt: NOW,
      });
    });

    it.each([
      ['usdc/start', 'start', {}],
      ['usdc/wallet-response', 'wallet-response', { priceTxHash: USDC_PRICE, feeTx: { signed: false } }],
    ] as const)('(f) refuses a deposit half-paid on abt_eth at %s, and offers only abt_eth', async (_door, route, body) => {
      const rig = await boot(BOTH);
      const { jobId } = await halfPaidAtLock1(rig, INSIDE_HOLD, INSIDE_HOLD);

      const res = await postSigned(rig.baseUrl, usdcPath(jobId, route), body, rig.buyer);

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: HELD_IN_ABT_ETH });
      expect(await payableRails(rig, jobId)).toEqual(['abt_eth']);
      await expectNothingSettled(rig, jobId);
    });

    it('(g) holds nothing for a leg with only its fee on the network: the re-price answers 200 and both currencies are still offered', async () => {
      const rig = await boot(BOTH);
      const { jobId } = await feeOnlyAtLock1(rig);
      expect(await payableRails(rig, jobId)).toEqual(['usdc', 'abt_eth']);
      const before = structuredClone(await readJob(rig, jobId)) as {
        price: { priceUsd: string; acceptedByAgent: boolean; acceptedByBuyer: boolean };
      };

      const res = await postSigned(rig.baseUrl, `/jobs/${jobId}/criteria`, { criteria, priceUsd: '600.00' }, rig.agent);

      expect(res.status).toBe(200);
      // A re-price changes the price and clears both sides' acceptance; nothing else in the body moves.
      const expected = structuredClone(before);
      expected.price.priceUsd = '600.00';
      expected.price.acceptedByAgent = false;
      expected.price.acceptedByBuyer = false;
      expect(await readJob(rig, jobId)).toEqual(expected);
    });

    it('(h) answers 503 and changes nothing when the half-paid read fails, at criteria and at abt_eth/start', async () => {
      const rig = await boot();
      const jobId = await walkToProposedAndPriced(rig);
      const before = structuredClone(await readJob(rig, jobId));
      rig.readsFail.on = true;

      const criteriaRes = await postSigned(rig.baseUrl, `/jobs/${jobId}/criteria`, { criteria, priceUsd: '600.00' }, rig.agent);
      const startRes = await startLeg(rig, jobId, 'deposit');
      rig.readsFail.on = false;

      expect(criteriaRes.status).toBe(503);
      expect(await criteriaRes.json()).toEqual(STORAGE_DOWN);
      expect(startRes.status).toBe(503);
      expect(await startRes.json()).toEqual(STORAGE_DOWN);
      expect(rig.locks).toEqual([]);
      expect(await readJob(rig, jobId)).toEqual(before);
    });
  });
});

const REMAINDER_RECORDED = '2026-10-06T12:30:00.000Z';
const OTHER_PRICE = '0xaaaa000000000000000000000000000000000000000000000000000000000009';
const OTHER_FEE = '0xbbbb00000000000000000000000000000000000000000000000000000000000a';

async function readJob(rig: Rig, jobId: string): Promise<unknown> {
  return (await fetch(`${rig.baseUrl}/jobs/${jobId}`)).json();
}

// What the first report of the short deposit answered.
const SHORT_DEPOSIT_BODY = {
  ...confirmationBody(DEPOSIT_PAIR, AFTER_HOLD),
  short: { recordedAt: AFTER_HOLD, agreedUsd: '125.00', worthUsd: '100' },
};

// The deposit transfers recorded after the hold, reported with ABT at
// 0.20 against a lock at 0.25: 500 ABT is worth 100.00, not 125.00.
async function shortDeposit(rig: Rig): Promise<{ jobId: string; lockId: string }> {
  const jobId = await walkToProposedAndPriced(rig);
  landPair(rig, 'deposit', AFTER_HOLD);
  const lockId = await startOk(rig, jobId, 'deposit');
  setTime(REPORTED_AT);
  rig.feed.reading = { usdPerToken: '0.2', updatedAt: new Date('2026-10-06T12:39:00.000Z') };
  const res = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(SHORT_DEPOSIT_BODY);
  return { jobId, lockId };
}

// The deposit paid inside its hold, confirmed and staged at INSIDE_HOLD.
async function stagedPaidDeposit(rig: Rig): Promise<string> {
  const jobId = await walkToProposedAndPriced(rig);
  landPair(rig, 'deposit', INSIDE_HOLD);
  const lockId = await startOk(rig, jobId, 'deposit');
  setTime(INSIDE_HOLD);
  expect((await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId))).status).toBe(200);
  expect((await postSigned(rig.baseUrl, `/jobs/${jobId}/confirm`, {}, rig.buyer)).status).toBe(200);
  expect((await postSigned(rig.baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-abt-eth-1' }, rig.agent)).status).toBe(200);
  return jobId;
}

// The remainder transfers recorded after the remainder's hold, worth 300.00
// against 375.00 when read: a short remainder on a staged job.
async function shortRemainder(rig: Rig): Promise<string> {
  const jobId = await stagedPaidDeposit(rig);
  landPair(rig, 'remainder', REMAINDER_RECORDED);
  const lockId = await startOk(rig, jobId, 'remainder');
  setTime(REPORTED_AT);
  rig.feed.reading = { usdPerToken: '0.2', updatedAt: new Date('2026-10-06T12:39:00.000Z') };
  const res = await report(rig, jobId, 'remainder', reportBody(REMAINDER_PAIR, lockId));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    ...confirmationBody(REMAINDER_PAIR, REMAINDER_RECORDED),
    short: { recordedAt: REMAINDER_RECORDED, agreedUsd: '375.00', worthUsd: '300' },
  });
  return jobId;
}

// A payment the network recorded after its price hold, worth less than the
// agreed price when the platform read it, is stored short. The money is with
// the owner, who answers it, so the leg is held the way a settled one is:
// nothing asks for it again, nothing changes its price, nobody walks away,
// and the unpaid clock does not close it.
describe('(q) a payment stored short holds the hire while it waits on the owner', () => {
  const SHORT_START = 'This payment reached the owner worth less than the agreed price, so the hire waits on the owner to accept it or return it. Message the owner.';
  const WAITS = 'The hire waits on the owner to accept the payment or return it.';
  const SHORT_TERMS = `The deposit has already reached the owner and waits on their answer, so the terms can no longer change. ${WAITS}`;
  const SHORT_WITHDRAW = 'The deposit has already reached the owner and waits on their answer, so this hire can no longer be withdrawn. Message the owner.';
  const SHORT_DECLINE = `The deposit has already reached the owner and waits on their answer, so this hire can no longer be declined. ${WAITS}`;
  const SHORT_STAGED_DECLINE = 'The balance has already reached the owner and waits on their answer, so the work can no longer be declined. Message the owner.';
  const SHORT_REDO = 'The balance has already reached the owner and waits on their answer, so a redo can no longer be requested. Message the owner.';
  const SHORT_ON_USDC = 'the deposit for this job reached the owner in "abt_eth" worth less than the agreed price and waits on their answer; the "usdc" payment routes refuse it. Message the owner.';
  const STORAGE_DOWN = { error: 'storage unavailable' };
  const BOTH = { usdcRail: true, ownerUsdc: OWNER_USDC } as const;

  async function conduct(rig: Rig, login: string): Promise<unknown> {
    return (await fetch(`${rig.baseUrl}/buyers/${login}/conduct`)).json();
  }

  it.each(['deposit', 'remainder'] as const)('(a) refuses abt_eth/start on a short %s, and writes no lock', async (leg) => {
    const rig = await boot();
    const jobId = leg === 'deposit' ? (await shortDeposit(rig)).jobId : await shortRemainder(rig);
    const locksBefore = structuredClone(rig.locks);
    const shortsBefore = structuredClone(await rig.shorts.findByJobAndLeg(jobId, leg));
    const jobBefore = structuredClone(await readJob(rig, jobId));

    const res = await startLeg(rig, jobId, leg);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: SHORT_START });
    expect(rig.locks).toEqual(locksBefore);
    expect(await rig.shorts.findByJobAndLeg(jobId, leg)).toEqual(shortsBefore);
    expect(await readJob(rig, jobId)).toEqual(jobBefore);
  });

  it('(b) offers only abt_eth for a short deposit, and the USDC doors refuse it', async () => {
    const rig = await boot(BOTH);
    const { jobId } = await shortDeposit(rig);
    expect(((await readJob(rig, jobId)) as { payableRails: unknown }).payableRails).toEqual(['abt_eth']);

    const start = await postSigned(rig.baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, {}, rig.buyer);
    const respond = await postSigned(
      rig.baseUrl,
      `/jobs/${jobId}/payments/deposit/usdc/wallet-response`,
      { priceTxHash: '0xcc01', feeTx: { signed: false } },
      rig.buyer,
    );

    expect(start.status).toBe(409);
    expect(await start.json()).toEqual({ error: SHORT_ON_USDC });
    expect(respond.status).toBe(409);
    expect(await respond.json()).toEqual({ error: SHORT_ON_USDC });
    await expectNothingSettled(rig, jobId);
  });

  it('(c) refuses the re-price of a short deposit at 600.00, and the job reads as it did', async () => {
    const rig = await boot();
    const { jobId } = await shortDeposit(rig);
    const before = structuredClone(await readJob(rig, jobId));

    const res = await postSigned(rig.baseUrl, `/jobs/${jobId}/criteria`, { criteria, priceUsd: '600.00' }, rig.agent);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: SHORT_TERMS });
    expect(await readJob(rig, jobId)).toEqual(before);
  });

  it.each([
    ['withdraw', 'deposit', 'withdraw', {}, 'buyer', SHORT_WITHDRAW],
    ['decline', 'deposit', 'decline', {}, 'agent', SHORT_DECLINE],
    ['staged-decline', 'remainder', 'staged-decline', {}, 'buyer', SHORT_STAGED_DECLINE],
    ['redo', 'remainder', 'redo', { criterionIndex: 0 }, 'buyer', SHORT_REDO],
  ] as const)('(d) refuses %s on a short %s with its sentence, and the job reads as it did', async (_name, leg, route, body, who, sentence) => {
    const rig = await boot();
    const jobId = leg === 'deposit' ? (await shortDeposit(rig)).jobId : await shortRemainder(rig);
    const before = structuredClone(await readJob(rig, jobId));

    const res = await postSigned(rig.baseUrl, `/jobs/${jobId}/${route}`, body, rig[who]);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: sentence });
    expect(await readJob(rig, jobId)).toEqual(before);
  });

  describe('(e) the unpaid clock', () => {
    const NOT_CLOSED = { confirmed: 1, walkedAfterConfirm: 0, stagedDeclined: 0, closedUnpaid: 0, merged: 0, deemed: 0, closedUnmerged: 0, citedCloses: 0, redosRequested: 0, walkedAway: 0 };
    const NO_OPERATOR_COUNTS = { deliveredNeverPaid: 0, redosRefused: 0, walkedAfterDeposit: 0, paidNeverDelivered: 0 };

    it('does not close a short remainder, at stagedAt + 7 days + 1 ms or at + 30 days, and both public records stay as they were', async () => {
      const rig = await boot();
      const jobId = await shortRemainder(rig);
      const stagedAt = new Date(INSIDE_HOLD).getTime();
      const hirerBefore = structuredClone(await conduct(rig, 'buyer-abt-eth'));
      const ownerBefore = structuredClone(await conduct(rig, 'operator-abt-eth'));
      expect(hirerBefore).toEqual({ githubLogin: 'buyer-abt-eth', keyed: true, counts: NOT_CLOSED, operatorCounts: NO_OPERATOR_COUNTS });
      expect(ownerBefore).toEqual({ githubLogin: 'operator-abt-eth', keyed: true, counts: { ...NOT_CLOSED, confirmed: 0 }, operatorCounts: NO_OPERATOR_COUNTS });

      for (const offset of [7 * DAY_MS + 1, 30 * DAY_MS]) {
        vi.setSystemTime(new Date(stagedAt + offset));
        expect(((await readJob(rig, jobId)) as { status: string }).status).toBe('staged');
        expect(await conduct(rig, 'buyer-abt-eth')).toEqual(hirerBefore);
        expect(await conduct(rig, 'operator-abt-eth')).toEqual(ownerBefore);
      }
    });

    it('control: a remainder never paid still closes unpaid at stagedAt + 7 days + 1 ms, not before', async () => {
      const rig = await boot();
      const jobId = await stagedPaidDeposit(rig);
      const stagedAt = new Date(INSIDE_HOLD).getTime();

      vi.setSystemTime(new Date(stagedAt + 7 * DAY_MS));
      const atSeven = (await readJob(rig, jobId)) as { status: string };
      vi.setSystemTime(new Date(stagedAt + 7 * DAY_MS + 1));
      const pastSeven = (await readJob(rig, jobId)) as { status: string };

      expect(atSeven.status).toBe('staged');
      expect(pastSeven.status).toBe('closed_unpaid');
    });
  });

  describe('(f) the pair already stored short is never judged again', () => {
    it.each([
      ['as it was sent', (pair: Pair) => reportBody(pair, 'unused')],
      ['with its hashes in capitals', (pair: Pair) => ({ priceTxHash: pair.price.toUpperCase(), feeTx: { signed: true, hash: pair.fee.toUpperCase() }, quoteLockId: 'unused' })],
    ])('answers the first body %s after ABT recovers to 0.30, and writes nothing', async (_name, build) => {
      const rig = await boot();
      const { jobId, lockId } = await shortDeposit(rig);
      const rowsBefore = structuredClone(await rig.shorts.findByJobAndLeg(jobId, 'deposit'));
      const locksBefore = structuredClone(rig.locks);
      setTime('2026-10-06T13:00:00.000Z');
      rig.feed.reading = { usdPerToken: '0.3', updatedAt: new Date('2026-10-06T12:59:00.000Z') };

      const res = await report(rig, jobId, 'deposit', { ...build(DEPOSIT_PAIR), quoteLockId: lockId });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(SHORT_DEPOSIT_BODY);
      await expectNothingSettled(rig, jobId);
      expect(await rig.shorts.findByJobAndLeg(jobId, 'deposit')).toEqual(rowsBefore);
      expect(rowsBefore).toEqual([shortRow(jobId, lockId, { usdPerTokenAtRead: '0.2', worthUsd: '100', recordedAt: AFTER_HOLD, readAt: REPORTED_AT })]);
      expect(rig.locks).toEqual(locksBefore);
    });

    it('refuses a fresh pair on the same leg, and writes nothing', async () => {
      const rig = await boot();
      const { jobId, lockId } = await shortDeposit(rig);
      const rowsBefore = structuredClone(await rig.shorts.findByJobAndLeg(jobId, 'deposit'));
      rig.chain.receipts.set(OTHER_PRICE, { status: 1, transfer: transfer(OWNER_ETH, DEP_PRICE_UNITS) });
      rig.chain.receipts.set(OTHER_FEE, { status: 1, transfer: transfer(FEE_ADDRESS, DEP_FEE_UNITS) });
      rig.chain.recorded.set(OTHER_PRICE, new Date(AFTER_HOLD));
      rig.feed.reading = { usdPerToken: '0.3', updatedAt: new Date('2026-10-06T12:39:00.000Z') };

      const res = await report(rig, jobId, 'deposit', reportBody({ price: OTHER_PRICE, fee: OTHER_FEE }, lockId));

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: SHORT_START });
      await expectNothingSettled(rig, jobId);
      expect(await rig.shorts.findByJobAndLeg(jobId, 'deposit')).toEqual(rowsBefore);
    });

    it('refuses the stored price hash reported with another fee hash, and writes nothing', async () => {
      const rig = await boot();
      const { jobId, lockId } = await shortDeposit(rig);
      const rowsBefore = structuredClone(await rig.shorts.findByJobAndLeg(jobId, 'deposit'));

      const res = await report(rig, jobId, 'deposit', reportBody({ price: DEP_PRICE, fee: OTHER_FEE }, lockId));

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: SHORT_START });
      expect(await rig.shorts.findByJobAndLeg(jobId, 'deposit')).toEqual(rowsBefore);
    });
  });

  describe('(g) controls', () => {
    it('a deposit worth the agreed price settles as before and holds nothing', async () => {
      const rig = await boot();
      const jobId = await walkToProposedAndPriced(rig);
      landPair(rig, 'deposit', AFTER_HOLD);
      const lockId = await startOk(rig, jobId, 'deposit');
      setTime(REPORTED_AT);
      rig.feed.reading = { usdPerToken: '0.25', updatedAt: new Date('2026-10-06T12:39:00.000Z') };

      const res = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(confirmationBody(DEPOSIT_PAIR, AFTER_HOLD));
      expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit')).toEqual(settlementRow(jobId, 'deposit', REPORTED_AT));
      expect(await rig.shorts.findByJobAndLeg(jobId, 'deposit')).toEqual([]);
    });

    it.each([
      ['abt_eth/start', (rig: Rig, jobId: string) => startLeg(rig, jobId, 'deposit')],
      ['abt_eth/wallet-response with a fresh pair', (rig: Rig, jobId: string) => report(rig, jobId, 'deposit', reportBody({ price: OTHER_PRICE, fee: OTHER_FEE }, 'a-lock-this-door-never-checks'))],
    ])('a short deposit that later has a settlement row holds nothing: %s answers as for a settled leg', async (_door, call) => {
      const rig = await boot(BOTH);
      const { jobId } = await shortDeposit(rig);
      await rig.settlementRepo.record({
        jobId, leg: 'deposit', rail: 'abt_eth', hash: DEP_PRICE, secondaryHash: DEP_FEE,
        operatorAddress: OWNER_ETH, feeAddress: FEE_ADDRESS, amountUsd: '125.00', observedAt: new Date(REPORTED_AT),
      });
      const locksBefore = structuredClone(rig.locks);

      const res = await call(rig, jobId);

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: legAlreadySettledMessage('deposit') });
      expect(rig.locks).toEqual(locksBefore);
    });
  });

  describe('(h) a failed short read', () => {
    it('answers 503 and changes nothing at criteria and at abt_eth/start', async () => {
      const rig = await boot();
      const jobId = await walkToProposedAndPriced(rig);
      const before = structuredClone(await readJob(rig, jobId));
      rig.shortReadsFail.on = true;

      const criteriaRes = await postSigned(rig.baseUrl, `/jobs/${jobId}/criteria`, { criteria, priceUsd: '600.00' }, rig.agent);
      const startRes = await startLeg(rig, jobId, 'deposit');
      rig.shortReadsFail.on = false;

      expect(criteriaRes.status).toBe(503);
      expect(await criteriaRes.json()).toEqual(STORAGE_DOWN);
      expect(startRes.status).toBe(503);
      expect(await startRes.json()).toEqual(STORAGE_DOWN);
      expect(rig.locks).toEqual([]);
      expect(await readJob(rig, jobId)).toEqual(before);
    });

    it('answers 503 when the clock of a staged job cannot read the short store, never "not short"', async () => {
      const rig = await boot();
      const jobId = await stagedPaidDeposit(rig);
      vi.setSystemTime(new Date(new Date(INSIDE_HOLD).getTime() + 8 * DAY_MS));
      rig.shortReadsFail.on = true;

      const res = await fetch(`${rig.baseUrl}/jobs/${jobId}`);

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual(STORAGE_DOWN);
    });
  });
});

// What the owner sees of a payment stored short in (q), and the one press that
// accepts it as paid. The press reads the chain again from the stored pair and
// the stored lock, then writes the settlement row at the agreed amount; the
// short row stays as the record that the leg arrived short.
describe('(r) the owner sees a short payment and accepts it as paid with one press', () => {
  const ACCEPT_AT = '2026-10-06T13:00:00.000Z';
  const NOTHING_WAITS = { error: 'No payment on this leg waits on your answer.' };
  const NOT_CONFIRMED = { error: 'The network does not show this payment as confirmed right now, so it cannot be accepted. Try again in a few minutes.' };
  const TWO_WAIT = { error: 'More than one payment on this leg waits on your answer, so none can be accepted here. Message the hirer.' };
  const NOT_ALLOWED = {
    error: "the owner has not allowed this agent to negotiate on its own signature; sign in as the operator, or have the operator turn on negotiatesOnOwnersBehalf for this agent",
  };
  const SHORT_DEPOSIT_LINE = {
    body: 'Deposit arrived worth less than agreed',
    systemEvent: { type: 'payment_short', leg: 'deposit', agreedUsd: '125.00', worthUsd: '100' },
  };
  const SHORT_REMAINDER_LINE = {
    body: 'Remainder arrived worth less than agreed',
    systemEvent: { type: 'payment_short', leg: 'remainder', agreedUsd: '375.00', worthUsd: '300' },
  };
  const NO_SHORT = { deposit: null, remainder: null };

  const accept = (rig: Rig, jobId: string, leg: string, as: SigningIdentity = rig.operator): Promise<Response> =>
    postSigned(rig.baseUrl, `/jobs/${jobId}/payments/${leg}/abt_eth/accept-short`, {}, as);
  const paymentsRead = (rig: Rig, jobId: string): Promise<Response> => getSigned(rig.baseUrl, `/jobs/${jobId}/payments`, rig.buyer);
  const depositLeg = (observedAt: string): Record<string, unknown> => ({ rail: 'abt_eth', amountUsd: '125.00', operatorAddress: OWNER_ETH, observedAt });

  // The thread's lines of the named event types, whole.
  async function lines(rig: Rig, jobId: string, ...types: string[]): Promise<unknown[]> {
    const rows = await rig.messageRepo.listByJobId(jobId);
    return rows.filter((row) => types.includes(row.systemEvent?.type ?? '')).map((row) => ({ body: row.body, systemEvent: row.systemEvent }));
  }
  // Everything a press may write for one leg: its settlement row, its short
  // rows and the thread's short and paid lines.
  async function written(rig: Rig, jobId: string, leg: 'deposit' | 'remainder'): Promise<unknown> {
    return structuredClone({
      settlement: await rig.settlementRepo.findByJobAndLeg(jobId, leg),
      shorts: await rig.shorts.findByJobAndLeg(jobId, leg),
      lines: await lines(rig, jobId, 'payment_short', 'deposit_paid', 'remainder_paid'),
    });
  }
  // The notifications written at one instant for one account.
  async function notifiedAt(rig: Rig, did: string, iso: string): Promise<unknown[]> {
    const rows = await rig.notifications.listByAccountDid(did);
    return rows.filter((row) => row.createdAt.getTime() === new Date(iso).getTime()).map((row) => ({ accountDid: row.accountDid, eventType: row.eventType }));
  }

  describe('(a) the first short report writes one line and notifies both sides', () => {
    it('writes the whole deposit line and notifies the buyer and the owner with new_message', async () => {
      const rig = await boot();
      const { jobId } = await shortDeposit(rig);

      expect(await lines(rig, jobId, 'payment_short')).toEqual([SHORT_DEPOSIT_LINE]);
      expect(await notifiedAt(rig, rig.buyer.did, REPORTED_AT)).toEqual([{ accountDid: rig.buyer.did, eventType: 'new_message' }]);
      expect(await notifiedAt(rig, rig.operator.did, REPORTED_AT)).toEqual([{ accountDid: rig.operator.did, eventType: 'new_message' }]);
    });

    it('writes the whole remainder line at 375.00', async () => {
      const rig = await boot();
      const jobId = await shortRemainder(rig);

      expect(await lines(rig, jobId, 'payment_short')).toEqual([SHORT_REMAINDER_LINE]);
    });

    it('adds no second line when the same short pair is reported again', async () => {
      const rig = await boot();
      const { jobId, lockId } = await shortDeposit(rig);
      const before = await written(rig, jobId, 'deposit');
      setTime('2026-10-06T13:00:00.000Z');

      const again = await report(rig, jobId, 'deposit', reportBody(DEPOSIT_PAIR, lockId));

      expect(again.status).toBe(200);
      expect(await again.json()).toEqual(SHORT_DEPOSIT_BODY);
      expect(await written(rig, jobId, 'deposit')).toEqual(before);
      expect(await notifiedAt(rig, rig.buyer.did, '2026-10-06T13:00:00.000Z')).toEqual([]);
    });
  });

  describe('(b) the payments read names a short leg until it settles', () => {
    const SHORT_READ = { rail: 'abt_eth', agreedUsd: '125.00', worthUsd: '100', recordedAt: AFTER_HOLD };

    it('answers the short deposit whole, then the settled leg with no short after the press', async () => {
      const rig = await boot();
      const { jobId } = await shortDeposit(rig);

      const during = await paymentsRead(rig, jobId);
      expect(during.status).toBe(200);
      expect(await during.json()).toEqual({ deposit: null, remainder: null, short: { deposit: SHORT_READ, remainder: null } });

      setTime(ACCEPT_AT);
      expect((await accept(rig, jobId, 'deposit')).status).toBe(200);
      const after = await paymentsRead(rig, jobId);
      expect(after.status).toBe(200);
      expect(await after.json()).toEqual({ deposit: depositLeg(ACCEPT_AT), remainder: null, short: NO_SHORT });
    });

    it('answers the short remainder whole, with the deposit settled and no short deposit', async () => {
      const rig = await boot();
      const jobId = await shortRemainder(rig);

      const res = await paymentsRead(rig, jobId);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        deposit: depositLeg(INSIDE_HOLD),
        remainder: null,
        short: { deposit: null, remainder: { rail: 'abt_eth', agreedUsd: '375.00', worthUsd: '300', recordedAt: REMAINDER_RECORDED } },
      });
    });

    it('answers a short row stored with no price as worthUsd null and recordedAt null', async () => {
      const rig = await boot();
      const jobId = await walkToProposedAndPriced(rig);
      await rig.shorts.record({
        priceTxHash: DEP_PRICE, jobId, leg: 'deposit', lockId: 'a-lock', feeTxHash: DEP_FEE, amountToken: '500', amountUsd: '125.00',
        usdPerTokenAtRead: null, worthUsd: null, recordedAt: null, readAt: new Date(REPORTED_AT),
      });

      const res = await paymentsRead(rig, jobId);

      expect(await res.json()).toEqual({ deposit: null, remainder: null, short: { deposit: { rail: 'abt_eth', agreedUsd: '125.00', worthUsd: null, recordedAt: null }, remainder: null } });
    });

    it('answers 503 when the short read fails, never a null short', async () => {
      const rig = await boot();
      const { jobId } = await shortDeposit(rig);
      rig.shortReadsFail.on = true;

      const res = await paymentsRead(rig, jobId);

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'storage unavailable' });
    });

    it('answers no short at all on a deployment with no ABT-on-Ethereum rail', async () => {
      const rig = await boot({ railConfigured: false });
      const jobId = await walkToProposedAndPriced(rig);

      const res = await paymentsRead(rig, jobId);

      expect(await res.json()).toEqual({ deposit: null, remainder: null, short: NO_SHORT });
    });
  });

  describe('(c) the owner accepts with one press', () => {
    it('settles a short deposit at 125.00 with the agent negotiation switch off: whole body, whole row, one paid line after the short line, short row unchanged', async () => {
      const rig = await boot();
      const { jobId } = await shortDeposit(rig);
      await rig.agentRepo.setNegotiatesOnOwnersBehalf(rig.agent.did, false);
      const shortsBefore = structuredClone(await rig.shorts.findByJobAndLeg(jobId, 'deposit'));
      setTime(ACCEPT_AT);

      const res = await accept(rig, jobId, 'deposit');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(depositLeg(ACCEPT_AT));
      expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit')).toEqual(settlementRow(jobId, 'deposit', ACCEPT_AT));
      expect(await lines(rig, jobId, 'payment_short', 'deposit_paid', 'remainder_paid')).toEqual([SHORT_DEPOSIT_LINE, DEPOSIT_PAID_LINE]);
      expect(await rig.shorts.findByJobAndLeg(jobId, 'deposit')).toEqual(shortsBefore);
      expect(await notifiedAt(rig, rig.buyer.did, ACCEPT_AT)).toEqual([{ accountDid: rig.buyer.did, eventType: 'new_message' }]);
      expect(await notifiedAt(rig, rig.operator.did, ACCEPT_AT)).toEqual([{ accountDid: rig.operator.did, eventType: 'new_message' }]);
    });

    it('lifts the hold: abt_eth/start is the already-paid 409, confirm answers 200 and the price reads abt_eth', async () => {
      const rig = await boot();
      const { jobId } = await shortDeposit(rig);
      setTime(ACCEPT_AT);
      expect((await accept(rig, jobId, 'deposit')).status).toBe(200);

      const start = await startLeg(rig, jobId, 'deposit');
      const confirm = await postSigned(rig.baseUrl, `/jobs/${jobId}/confirm`, {}, rig.buyer);

      expect(start.status).toBe(409);
      expect(await start.json()).toEqual({ error: legAlreadySettledMessage('deposit') });
      expect(confirm.status).toBe(200);
      expect(((await readJob(rig, jobId)) as { price: { rail: string } }).price.rail).toBe('abt_eth');
    });
  });

  describe('(d) who may press', () => {
    it("settles when the agent's own key presses with its owner's permission on", async () => {
      const rig = await boot();
      const { jobId } = await shortDeposit(rig);
      setTime(ACCEPT_AT);

      const res = await accept(rig, jobId, 'deposit', rig.agent);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(depositLeg(ACCEPT_AT));
      expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit')).toEqual(settlementRow(jobId, 'deposit', ACCEPT_AT));
    });

    it.each([
      ["the agent's own key with the switch off", 403, NOT_ALLOWED, async (rig: Rig) => {
        await rig.agentRepo.setNegotiatesOnOwnersBehalf(rig.agent.did, false);
        return rig.agent;
      }],
      ['the buyer', 403, { error: 'only the agent may payments/:leg/abt_eth/accept-short this job' }, async (rig: Rig) => rig.buyer],
      ['a registered stranger', 403, { error: 'signature does not name a party to this job' }, async (rig: Rig) => rig.stranger],
    ] as const)('refuses %s and writes nothing', async (_who, status, sentence, pick) => {
      const rig = await boot();
      const { jobId } = await shortDeposit(rig);
      const before = await written(rig, jobId, 'deposit');
      setTime(ACCEPT_AT);

      const res = await accept(rig, jobId, 'deposit', await pick(rig));

      expect(res.status).toBe(status);
      expect(await res.json()).toEqual(sentence);
      expect(await written(rig, jobId, 'deposit')).toEqual(before);
    });

    it('refuses an unsigned caller with 401 and writes nothing', async () => {
      const rig = await boot();
      const { jobId } = await shortDeposit(rig);
      const before = await written(rig, jobId, 'deposit');

      const res = await fetch(`${rig.baseUrl}/jobs/${jobId}/payments/deposit/abt_eth/accept-short`, { method: 'POST' });

      expect(res.status).toBe(401);
      expect(await written(rig, jobId, 'deposit')).toEqual(before);
    });

    it('refuses a leg that is not deposit or remainder with 400', async () => {
      const rig = await boot();
      const { jobId } = await shortDeposit(rig);

      const res = await accept(rig, jobId, 'balance');

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'leg must be "deposit" or "remainder"' });
    });
  });

  describe('(e) a short remainder accepted two days after it was stored', () => {
    const TWO_DAYS_ON = new Date(REPORTED_AT).getTime() + 2 * DAY_MS;

    async function acceptedRemainder(): Promise<{ rig: Rig; jobId: string }> {
      const rig = await boot();
      const jobId = await shortRemainder(rig);
      vi.setSystemTime(new Date(TWO_DAYS_ON));
      const res = await accept(rig, jobId, 'remainder');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ rail: 'abt_eth', amountUsd: '375.00', operatorAddress: OWNER_ETH, observedAt: new Date(TWO_DAYS_ON).toISOString() });
      return { rig, jobId };
    }

    it('settles at 375.00 with the accept time as observedAt, and the pull request is shut before and open after', async () => {
      const rig = await boot();
      const jobId = await shortRemainder(rig);
      const before = await postSigned(rig.baseUrl, `/jobs/${jobId}/pull-request`, { pullRequestUrl: 'https://github.com/buyer/target-repo/pull/1' }, rig.agent);
      expect(before.status).toBe(402);
      vi.setSystemTime(new Date(TWO_DAYS_ON));

      const res = await accept(rig, jobId, 'remainder');

      expect(res.status).toBe(200);
      expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'remainder')).toEqual(settlementRow(jobId, 'remainder', new Date(TWO_DAYS_ON).toISOString()));
      expect(await lines(rig, jobId, 'payment_short', 'deposit_paid', 'remainder_paid')).toEqual([DEPOSIT_PAID_LINE, SHORT_REMAINDER_LINE, REMAINDER_PAID_LINE]);
      const { url } = registerAgentForkPullRequest(rig.fixture, { repository: 'buyer/target-repo', jobId, stagedCommit: 'commit-abt-eth-1', agentLogin: 'scout-abt-eth' });
      const opened = await postSigned(rig.baseUrl, `/jobs/${jobId}/pull-request`, { pullRequestUrl: url }, rig.agent);
      expect(opened.status).toBe(200);
    });

    it('runs the delivery clock from the accept: staged at accept + 7 days, paid_undelivered at + 1 ms', async () => {
      const { rig, jobId } = await acceptedRemainder();

      vi.setSystemTime(new Date(TWO_DAYS_ON + 7 * DAY_MS));
      const atSeven = (await readJob(rig, jobId)) as { status: string };
      vi.setSystemTime(new Date(TWO_DAYS_ON + 7 * DAY_MS + 1));
      const pastSeven = (await readJob(rig, jobId)) as { status: string };

      expect(atSeven.status).toBe('staged');
      expect(pastSeven.status).toBe('paid_undelivered');
    });
  });

  describe('(f) a press pressed twice', () => {
    it('answers the second press with the first body and keeps one settlement row, its first observedAt, and one paid line', async () => {
      const rig = await boot();
      const { jobId } = await shortDeposit(rig);
      setTime(ACCEPT_AT);
      const first = await accept(rig, jobId, 'deposit');
      const firstBody = structuredClone(await first.json());
      const afterFirst = await written(rig, jobId, 'deposit');
      setTime('2026-10-06T14:00:00.000Z');

      const second = await accept(rig, jobId, 'deposit');

      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(firstBody);
      expect(firstBody).toEqual(depositLeg(ACCEPT_AT));
      expect(await written(rig, jobId, 'deposit')).toEqual(afterFirst);
      expect(await lines(rig, jobId, 'deposit_paid')).toEqual([DEPOSIT_PAID_LINE]);
    });

    it('reads a settlement row for the short hash written in capitals as the replay, answers from that row and writes nothing', async () => {
      const rig = await boot();
      const { jobId } = await shortDeposit(rig);
      await rig.settlementRepo.record({
        jobId, leg: 'deposit', rail: 'abt_eth', hash: DEP_PRICE.toUpperCase(), secondaryHash: DEP_FEE.toUpperCase(),
        operatorAddress: OWNER_ETH, feeAddress: FEE_ADDRESS, amountUsd: '125.00', observedAt: new Date('2026-10-06T12:50:00.000Z'),
      });
      const before = await written(rig, jobId, 'deposit');

      const res = await accept(rig, jobId, 'deposit');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(depositLeg('2026-10-06T12:50:00.000Z'));
      expect(await written(rig, jobId, 'deposit')).toEqual(before);
    });
  });

  describe('(g) nothing waits on the owner', () => {
    const shortFor = (jobId: string, priceTxHash: string): Parameters<AbtEthShortPaymentStorage['record']>[0] => ({
      priceTxHash, jobId, leg: 'deposit', lockId: 'a-lock', feeTxHash: null, amountToken: '500', amountUsd: '125.00',
      usdPerTokenAtRead: '0.2', worthUsd: '100', recordedAt: new Date(AFTER_HOLD), readAt: new Date(REPORTED_AT),
    });

    it('answers 409 for a leg with no short row, and writes nothing', async () => {
      const rig = await boot();
      const jobId = await walkToProposedAndPriced(rig);
      const before = await written(rig, jobId, 'deposit');

      const res = await accept(rig, jobId, 'deposit');

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual(NOTHING_WAITS);
      expect(await written(rig, jobId, 'deposit')).toEqual(before);
    });

    it('answers 409 for a leg an ordinary payment settled, and writes nothing', async () => {
      const rig = await boot();
      const jobId = await stagedPaidDeposit(rig);
      const before = await written(rig, jobId, 'deposit');

      const res = await accept(rig, jobId, 'deposit');

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual(NOTHING_WAITS);
      expect(await written(rig, jobId, 'deposit')).toEqual(before);
    });

    it('answers 409 for a leg settled by another payment than the short one, and writes nothing', async () => {
      const rig = await boot();
      const { jobId } = await shortDeposit(rig);
      await rig.settlementRepo.record({
        jobId, leg: 'deposit', rail: 'abt_eth', hash: OTHER_PRICE, secondaryHash: OTHER_FEE,
        operatorAddress: OWNER_ETH, feeAddress: FEE_ADDRESS, amountUsd: '125.00', observedAt: new Date('2026-10-06T12:50:00.000Z'),
      });
      const before = await written(rig, jobId, 'deposit');

      const res = await accept(rig, jobId, 'deposit');

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual(NOTHING_WAITS);
      expect(await written(rig, jobId, 'deposit')).toEqual(before);
    });

    it('answers 409 with the two-payments sentence for two unsettled short rows, and writes nothing', async () => {
      const rig = await boot();
      const jobId = await walkToProposedAndPriced(rig);
      await rig.shorts.record(shortFor(jobId, DEP_PRICE));
      await rig.shorts.record(shortFor(jobId, OTHER_PRICE));
      const before = await written(rig, jobId, 'deposit');

      const res = await accept(rig, jobId, 'deposit');

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual(TWO_WAIT);
      expect(await written(rig, jobId, 'deposit')).toEqual(before);
    });

    it("answers 409 for another job's short hash, and writes nothing on either job", async () => {
      const rig = await boot();
      const jobId = await walkToProposedAndPriced(rig);
      const other = await shortDeposit(rig);
      const before = await written(rig, jobId, 'deposit');
      const otherBefore = await written(rig, other.jobId, 'deposit');

      const res = await accept(rig, jobId, 'deposit');

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual(NOTHING_WAITS);
      expect(await written(rig, jobId, 'deposit')).toEqual(before);
      expect(await written(rig, other.jobId, 'deposit')).toEqual(otherBefore);
    });
  });

  describe('(h) the press reads the chain, and a read that fails is never a guess', () => {
    it.each([
      ['the price receipt gone from the chain answers the not-confirmed 409', 409, NOT_CONFIRMED, (rig: Rig) => {
        rig.chain.receipts.delete(DEP_PRICE);
        return () => undefined;
      }],
      ['the fee receipt gone from the chain answers the not-confirmed 409', 409, NOT_CONFIRMED, (rig: Rig) => {
        rig.chain.receipts.delete(DEP_FEE);
        return () => undefined;
      }],
      ['a chain client that throws answers 503', 503, { error: 'the abt_eth payment rail is unavailable' }, (rig: Rig) => {
        rig.chain.fails.on = true;
        return () => { rig.chain.fails.on = false; };
      }],
      ['a short store that cannot be read answers 503', 503, { error: 'storage unavailable' }, (rig: Rig) => {
        rig.shortReadsFail.on = true;
        return () => { rig.shortReadsFail.on = false; };
      }],
      ['a lock store that cannot be read answers 503', 503, { error: 'storage unavailable' }, (rig: Rig) => {
        rig.lockReadsFail.on = true;
        return () => { rig.lockReadsFail.on = false; };
      }],
    ] as const)('%s, and writes nothing', async (_name, status, sentence, breakIt) => {
      const rig = await boot();
      const { jobId } = await shortDeposit(rig);
      const before = await written(rig, jobId, 'deposit');
      setTime(ACCEPT_AT);
      const restore = breakIt(rig);

      const res = await accept(rig, jobId, 'deposit');
      restore();

      expect(res.status).toBe(status);
      expect(await res.json()).toEqual(sentence);
      expect(await written(rig, jobId, 'deposit')).toEqual(before);
    });

    it('rebuilds the check from the stored lock: a feed that moved since changes nothing the chain is asked for', async () => {
      const rig = await boot();
      const { jobId } = await shortDeposit(rig);
      rig.feed.reading = { usdPerToken: '0.5', updatedAt: new Date('2026-10-06T12:50:00.000Z') };
      setTime(ACCEPT_AT);

      const res = await accept(rig, jobId, 'deposit');

      expect(res.status).toBe(200);
      expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit')).toEqual(settlementRow(jobId, 'deposit', ACCEPT_AT));
    });

    it('answers 409 and writes nothing when the stored lock amounts no longer match what the chain holds', async () => {
      const rig = await boot();
      const { jobId } = await shortDeposit(rig);
      rig.chain.receipts.set(DEP_PRICE, { status: 1, transfer: transfer(OWNER_ETH, '400000000000000000000') });
      const before = await written(rig, jobId, 'deposit');
      setTime(ACCEPT_AT);

      const res = await accept(rig, jobId, 'deposit');

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual(NOT_CONFIRMED);
      expect(await written(rig, jobId, 'deposit')).toEqual(before);
    });
  });

  describe('(i) no price read', () => {
    it('settles at the agreed amount with the feed answering no reading at all', async () => {
      const rig = await boot();
      const { jobId } = await shortDeposit(rig);
      rig.feed.reading = null;
      setTime(ACCEPT_AT);

      const res = await accept(rig, jobId, 'deposit');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(depositLeg(ACCEPT_AT));
      expect(await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit')).toEqual(settlementRow(jobId, 'deposit', ACCEPT_AT));
    });
  });

  describe('(j) a deployment with no ABT-on-Ethereum rail', () => {
    it('answers 503 and writes nothing', async () => {
      const rig = await boot({ railConfigured: false });
      const jobId = await walkToProposedAndPriced(rig);
      const before = await written(rig, jobId, 'deposit');

      const res = await accept(rig, jobId, 'deposit');

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'the abt_eth payment rail is not configured on this deployment' });
      expect(await written(rig, jobId, 'deposit')).toEqual(before);
    });
  });

  describe('(k) an owner who has since cleared the ABT-on-Ethereum address', () => {
    it('answers the operator-address 409 and writes nothing', async () => {
      const rig = await boot();
      const { jobId } = await shortDeposit(rig);
      // The interface only sets an address; a cleared one is the column null.
      await rig.accounts.setOperatorAddressAbtEth(rig.operator.did, null as never);
      const before = await written(rig, jobId, 'deposit');

      const res = await accept(rig, jobId, 'deposit');

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: operatorAddressNotSetMessage('abt_eth') });
      expect(await written(rig, jobId, 'deposit')).toEqual(before);
    });
  });
});
