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
import { MemoryAccountRepository, MemoryAgentRepository, MemoryJobRepository, MemoryMessageRepository, MemorySettlementRepository } from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, type SigningIdentity } from '../helpers/sign-request.js';
import { postSigned, withEnv } from '../helpers/abt-fixtures.js';
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
}

function transfer(to: string, value: string): Erc20ObservedTransfer {
  return { to, value, tokenContract: ABT_TOKEN, chainId: CHAIN_ID };
}

function chainClient(chain: Chain): AbtEthChainClient {
  return {
    decimals: async () => 18,
    getTransactionReceipt: async (hash) => chain.receipts.get(hash.toLowerCase()) ?? null,
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
  const operatorDid = 'did:abt:op-abt-eth';
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
  const chain: Chain = { receipts: new Map(), recorded: new Map() };
  const feed: { reading: RateReading | null } = { reading: { usdPerToken: '0.25', updatedAt: FEED_TIME } };
  const inner: AbtEthQuoteLockStorage = createMemoryAbtEthQuoteLockStorage();
  const locks: AbtEthQuoteLock[] = [];
  const lockStorage: AbtEthQuoteLockStorage = {
    create: async (lock) => {
      const stored = await inner.create(lock);
      locks.push(stored);
      return stored;
    },
    read: (id) => inner.read(options.lockIdsIgnoreCase === true ? id.toLowerCase() : id),
  };
  const shorts = createMemoryAbtEthShortPaymentStorage();
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
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
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
    chain,
    feed,
    locks,
    shorts,
    halfPaid,
    usdcReceipts,
    readsFail,
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
