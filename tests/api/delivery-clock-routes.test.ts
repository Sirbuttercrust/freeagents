// The delivery clock on the routes: a staged or redo_requested hire whose
// remainder settled more than 7 days ago, with no pull request open, ends as
// paid_undelivered on every read and mutation that runs the job clocks, and
// the time it counts from is the one the remainder's settlement row first
// recorded. A payment report posted twice writes nothing the second time, so
// it can neither move that time nor repeat the paid line in the conversation.
//
// Every case runs over real HTTP against createApp with memory storage. The
// settlement row a case needs is planted with a chosen observedAt, or written
// by the USDC wallet-response route itself. Only Date is faked, so the clock
// the routes read is the one each case sets. Expected values are literals.
import type { Server } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import type { DidDocument, IdentityAdapter } from '../../src/adapters/identity/types.js';
import { MemorySettlementGate, PrismaSettlementGate, type SettlementGate } from '../../src/adapters/payment/gate.js';
import { createUsdcPaymentRail, type UsdcChainClient, type UsdcObservedTransfer } from '../../src/adapters/payment/usdc.js';
import type { UsdcSpentTransferRow, UsdcSpentTransferStorage } from '../../src/adapters/payment/usdc-spent-transfer-storage-types.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
  MemoryMessageRepository,
  MemorySettlementRepository,
} from '../../src/adapters/storage/memory.js';
import type { ObservedSettlementRecord } from '../../src/adapters/storage/types.js';
import { resolveAvatar } from '../../src/domain/avatar-spec.js';
import { createJob, type Job } from '../../src/domain/job.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { testSessionAdapter } from '../helpers/session-fixtures.js';
import { createStagingLifecycleGithubFake, type StagingLifecycleFixture } from '../helpers/github-staging-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-10-06T12:00:00.000Z');
const agentIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(171));
const buyerIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(173));
const ownerIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(174));
const AGENT_DID = agentIdentity.did;
const BUYER_DID = buyerIdentity.did;
const OWNER_DID = ownerIdentity.did;
const AGENT_GITHUB_LOGIN = 'scout-delivery';
const BUYER_LOGIN = 'buyer-delivery';
const OWNER_LOGIN = 'owner-delivery';
const REPOSITORY = 'buyer/target-repo';
const STAGED_COMMIT = 'commit-delivery-1';

const USDC_TOKEN = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const USDC_FEE_ADDRESS = '0xFeeAddress000000000000000000000000000';
const USDC_OPERATOR_ADDRESS = '0xOperator000000000000000000000000000000';
const USDC_CHAIN_ID = 421614;

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

// What the USDC rail reads off the chain for the 500.00 USD hire (deposit
// 125.00 and remainder 375.00, fee 6%, at 1:1 and USDC's 6 decimals).
type Transfer = UsdcObservedTransfer;
function transfer(to: string, value: string): Transfer {
  return { to, value, tokenContract: USDC_TOKEN, chainId: USDC_CHAIN_ID };
}
function chainClient(): UsdcChainClient {
  const receipts = new Map<string, { status: number; transfer: Transfer }>([
    ['0xdep-price', { status: 1, transfer: transfer(USDC_OPERATOR_ADDRESS, '125000000') }],
    ['0xdep-fee', { status: 1, transfer: transfer(USDC_FEE_ADDRESS, '7500000') }],
    ['0xrem-price', { status: 1, transfer: transfer(USDC_OPERATOR_ADDRESS, '375000000') }],
    ['0xrem-fee', { status: 1, transfer: transfer(USDC_FEE_ADDRESS, '22500000') }],
  ]);
  return {
    decimals: async () => 6,
    getTransactionReceipt: async (hash: string) => receipts.get(hash.toLowerCase()) ?? null,
  };
}
function spentTransferStorage(): UsdcSpentTransferStorage {
  const rows = new Map<string, UsdcSpentTransferRow>();
  return {
    async record(row) {
      rows.set(row.hash, { ...row });
    },
    async findByHash(hash) {
      return rows.get(hash) ?? null;
    },
  };
}
function buildUsdcRail(): ReturnType<typeof createUsdcPaymentRail> {
  const env: Record<string, string> = {
    FREEAGENTS_USDC_RPC_URL: 'https://sepolia-rollup.arbitrum.io/rpc',
    FREEAGENTS_USDC_TOKEN_CONTRACT: USDC_TOKEN,
    FREEAGENTS_USDC_CHAIN_ID: String(USDC_CHAIN_ID),
    FREEAGENTS_USDC_FEE_ADDRESS: USDC_FEE_ADDRESS,
  };
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    original[key] = process.env[key];
    process.env[key] = env[key];
  }
  try {
    return createUsdcPaymentRail({
      chainClient: chainClient(),
      rateSource: async () => '1',
      halfPaidStorage: { record: async () => {}, read: async () => null, clear: async () => {} },
      spentTransferStorage: spentTransferStorage(),
    });
  } finally {
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

// A settlement repository whose remainder read can be made to fail while
// every other read answers, so the failure under test is the clock's own
// read and not the gate's.
class FlakyRemainderRepository extends MemorySettlementRepository {
  failRemainderReads = false;
  override async findByJobAndLeg(jobId: string, leg: 'deposit' | 'remainder'): Promise<ObservedSettlementRecord | null> {
    if (leg === 'remainder' && this.failRemainderReads) throw new Error('settlement storage went away');
    return super.findByJobAndLeg(jobId, leg);
  }
}

interface Rig {
  readonly baseUrl: string;
  readonly jobRepo: MemoryJobRepository;
  readonly settlementRepo: FlakyRemainderRepository;
  readonly messageRepo: MemoryMessageRepository;
  readonly fixture: StagingLifecycleFixture;
}

async function boot(options: { gate?: (repo: FlakyRemainderRepository) => SettlementGate } = {}): Promise<Rig> {
  const fixture = createStagingLifecycleGithubFake();
  const identity: IdentityAdapter = {
    ...createIdentityAdapter(),
    resolveDid: (did: string): Promise<DidDocument> =>
      Promise.resolve({ id: did, controller: null, verificationMethod: [`${did}#key-1`], alsoKnownAs: null }),
  };
  const credentialRepo = new MemoryCredentialRepository();
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: AGENT_DID,
    operatorDid: OWNER_DID,
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: AGENT_GITHUB_LOGIN,
    negotiatesOnOwnersBehalf: true,
  });
  await agentRepo.updateGithubBinding(AGENT_DID, { handle: AGENT_GITHUB_LOGIN, status: 'verified' });
  const accounts = new MemoryAccountRepository();
  await accounts.register({ did: BUYER_DID, githubLogin: BUYER_LOGIN });
  await accounts.register({ did: OWNER_DID, githubLogin: OWNER_LOGIN });
  await accounts.setOperatorAddressEvm(OWNER_DID, USDC_OPERATOR_ADDRESS);
  const jobRepo = new MemoryJobRepository();
  const settlementRepo = new FlakyRemainderRepository();
  const messageRepo = new MemoryMessageRepository();
  const gate = options.gate === undefined ? new PrismaSettlementGate(settlementRepo) : options.gate(settlementRepo);
  const server = createApp(
    accounts,
    agentRepo,
    identity,
    fixture.github,
    jobRepo,
    createCredentialsAdapter({ did: 'did:abt:test-platform-issuer', seed: new Uint8Array(32).fill(7) }, credentialRepo),
    undefined,
    credentialRepo,
    { verify: 100_000, read: 100_000, write: 100_000, upstream: 100_000 },
    undefined,
    undefined,
    testSessionAdapter(),
    undefined,
    gate,
    anyCommitStagingObserver(),
    undefined,
    null,
    buildUsdcRail(),
    settlementRepo,
    undefined,
    undefined,
    messageRepo,
  ).listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected server to listen on a port');
  return { baseUrl: `http://127.0.0.1:${address.port}`, jobRepo, settlementRepo, messageRepo, fixture };
}

async function send(rig: Rig, method: 'GET' | 'POST', path: string, identity: SigningIdentity | null, body?: unknown): Promise<Response> {
  const targetUri = `${rig.baseUrl}${path}`;
  if (identity === null) return fetch(targetUri, { headers: { Accept: 'application/json' } });
  if (method === 'GET') {
    const signed = signRequest(identity, 'GET', targetUri, { components: ['@method', '@target-uri', 'content-digest'] });
    return fetch(targetUri, {
      headers: {
        Accept: 'application/json',
        'signature-input': signed['signature-input'],
        signature: signed.signature,
        'content-digest': signed['content-digest'],
      },
    });
  }
  const bodyText = JSON.stringify(body ?? {});
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

// A paid-for hire stored as staged (or redo_requested) with the work staged
// one day before the remainder settled, so the unpaid clock has nothing to
// say about it.
function plantedJob(id: string, status: 'staged' | 'redo_requested', stagedAt: Date): Job {
  const base: Job = createJob(
    { id, buyerDid: BUYER_DID, agentDid: AGENT_DID, repository: REPOSITORY, brief: 'Fix the login bug' },
    new Date(NOW.getTime() - 40 * DAY_MS),
  );
  return {
    ...base,
    status,
    criteria: [{ text: 'fixes the login bug', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
    confirmedSpecHash: 'a'.repeat(64),
    confirmedAt: new Date(stagedAt.getTime() - 2 * DAY_MS),
    priceUsd: '500.00',
    rail: 'usdc',
    priceAcceptedByBuyer: true,
    priceAcceptedByAgent: true,
    stagingRepo: { owner: 'freeagents-platform', repo: `staging-${id}` },
    baseCommit: 'buyer-target-repo-head-sha',
    stagedAt,
    stagedCommit: STAGED_COMMIT,
    ...(status === 'redo_requested' ? { redoUsedCount: 1, redoRequestedCriterionIndex: 0, redoRequestedAt: new Date(stagedAt.getTime() + 3_600_000) } : {}),
  };
}

function settlementRow(jobId: string, leg: 'deposit' | 'remainder', observedAt: Date): ObservedSettlementRecord {
  return {
    jobId,
    leg,
    rail: 'usdc',
    hash: `0x${leg}-planted-price`,
    secondaryHash: `0x${leg}-planted-fee`,
    operatorAddress: USDC_OPERATOR_ADDRESS,
    feeAddress: USDC_FEE_ADDRESS,
    amountUsd: leg === 'deposit' ? '125.00' : '375.00',
    observedAt,
  };
}

const settledAgo = (ms: number): Date => new Date(NOW.getTime() - ms);
const JUST_OVER_7_DAYS = 7 * DAY_MS + 1;
const EXACTLY_7_DAYS = 7 * DAY_MS;

async function plantPaid(rig: Rig, id: string, status: 'staged' | 'redo_requested', settledMsAgo: number): Promise<Job> {
  const settledAt = settledAgo(settledMsAgo);
  const job = plantedJob(id, status, new Date(settledAt.getTime() - DAY_MS));
  await rig.jobRepo.create(job);
  await rig.settlementRepo.record(settlementRow(id, 'remainder', settledAt));
  return job;
}

async function storedStatus(rig: Rig, id: string): Promise<string | undefined> {
  return (await rig.jobRepo.findById(id))?.status;
}

describe('(a) GET /jobs/:jobId on a staged hire paid in full', () => {
  it('answers paid_undelivered and stores it when the remainder settled 7 days and 1 ms ago', async () => {
    const rig = await boot();
    await plantPaid(rig, 'j-dc-a-over', 'staged', JUST_OVER_7_DAYS);

    const res = await send(rig, 'GET', '/jobs/j-dc-a-over', null);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('paid_undelivered');
    expect(await storedStatus(rig, 'j-dc-a-over')).toBe('paid_undelivered');
  });

  it('answers staged and stores nothing new when the remainder settled exactly 7 days ago', async () => {
    const rig = await boot();
    await plantPaid(rig, 'j-dc-a-edge', 'staged', EXACTLY_7_DAYS);

    const res = await send(rig, 'GET', '/jobs/j-dc-a-edge', null);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('staged');
    expect(await storedStatus(rig, 'j-dc-a-edge')).toBe('staged');
  });

  it('counts from the remainder row: a deposit row 30 days old does not end a hire whose remainder settled a day ago', async () => {
    const rig = await boot();
    await plantPaid(rig, 'j-dc-a-deposit', 'staged', DAY_MS);
    await rig.settlementRepo.record(settlementRow('j-dc-a-deposit', 'deposit', settledAgo(30 * DAY_MS)));

    const res = await send(rig, 'GET', '/jobs/j-dc-a-deposit', null);

    expect(((await res.json()) as { status: string }).status).toBe('staged');
    expect(await storedStatus(rig, 'j-dc-a-deposit')).toBe('staged');
  });

  it('ends a hire whose remainder settled 8 days ago even when its deposit row is a day old', async () => {
    const rig = await boot();
    await plantPaid(rig, 'j-dc-a-remainder', 'staged', 8 * DAY_MS);
    await rig.settlementRepo.record(settlementRow('j-dc-a-remainder', 'deposit', settledAgo(DAY_MS)));

    const res = await send(rig, 'GET', '/jobs/j-dc-a-remainder', null);

    expect(((await res.json()) as { status: string }).status).toBe('paid_undelivered');
  });
});

describe('(b) GET /jobs/:jobId on a hire with a redo pending, paid in full', () => {
  it('answers paid_undelivered and stores it when the remainder settled 7 days and 1 ms ago', async () => {
    const rig = await boot();
    await plantPaid(rig, 'j-dc-b-over', 'redo_requested', JUST_OVER_7_DAYS);

    const res = await send(rig, 'GET', '/jobs/j-dc-b-over', null);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('paid_undelivered');
    expect(await storedStatus(rig, 'j-dc-b-over')).toBe('paid_undelivered');
  });

  it('answers redo_requested when the remainder settled exactly 7 days ago', async () => {
    const rig = await boot();
    await plantPaid(rig, 'j-dc-b-edge', 'redo_requested', EXACTLY_7_DAYS);

    const res = await send(rig, 'GET', '/jobs/j-dc-b-edge', null);

    expect(((await res.json()) as { status: string }).status).toBe('redo_requested');
    expect(await storedStatus(rig, 'j-dc-b-edge')).toBe('redo_requested');
  });
});

describe('(c) a staged hire with no remainder row is outside the delivery clock', () => {
  it('stays staged 5 days after staging, however old a settlement would have been', async () => {
    const rig = await boot();
    await rig.jobRepo.create(plantedJob('j-dc-c-young', 'staged', settledAgo(5 * DAY_MS)));

    const res = await send(rig, 'GET', '/jobs/j-dc-c-young', null);

    expect(((await res.json()) as { status: string }).status).toBe('staged');
  });

  it('stays staged when an injected gate says settled but no row exists, 30 days on', async () => {
    const rig = await boot({
      gate: () => {
        const gate = new MemorySettlementGate();
        gate.markBalanceSettled('j-dc-c-gate');
        return gate;
      },
    });
    await rig.jobRepo.create(plantedJob('j-dc-c-gate', 'staged', settledAgo(30 * DAY_MS)));

    const res = await send(rig, 'GET', '/jobs/j-dc-c-gate', null);

    expect(((await res.json()) as { status: string }).status).toBe('staged');
    expect(await storedStatus(rig, 'j-dc-c-gate')).toBe('staged');
  });

  it('control: still closes unpaid on its own clock, 9 days after staging', async () => {
    const rig = await boot();
    await rig.jobRepo.create(plantedJob('j-dc-c-unpaid', 'staged', settledAgo(9 * DAY_MS)));

    const res = await send(rig, 'GET', '/jobs/j-dc-c-unpaid', null);

    expect(((await res.json()) as { status: string }).status).toBe('closed_unpaid');
    expect(await storedStatus(rig, 'j-dc-c-unpaid')).toBe('closed_unpaid');
  });
});

describe('(d) every list read runs the delivery clock', () => {
  const ID = 'j-dc-d';
  const planted = async (): Promise<Rig> => {
    const rig = await boot();
    await plantPaid(rig, ID, 'staged', JUST_OVER_7_DAYS);
    return rig;
  };
  const thread = (job: Job, seat: 'buyer' | 'agent'): Record<string, unknown> => ({
    jobId: ID,
    status: 'paid_undelivered',
    writable: false,
    seat,
    brief: 'Fix the login bug',
    createdAt: job.createdAt.toISOString(),
    agentDid: AGENT_DID,
    agentName: 'scout',
    avatarSpec: resolveAvatar(null, AGENT_DID),
    counterpartDid: seat === 'buyer' ? OWNER_DID : BUYER_DID,
    counterpartGithubLogin: seat === 'buyer' ? OWNER_LOGIN : BUYER_LOGIN,
    lastActivityAt: job.createdAt.toISOString(),
    lastMessage: null,
    unreadCount: seat === 'agent' ? 1 : 0,
  });

  it("the buyer's job list shows the hire ended, among the ones that did not ship", async () => {
    const rig = await planted();

    const res = await send(rig, 'GET', `/accounts/${BUYER_DID}/jobs`, buyerIdentity);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { jobs: unknown[] }).jobs).toEqual([
      {
        id: ID,
        brief: 'Fix the login bug',
        agentName: 'scout',
        repository: REPOSITORY,
        status: 'paid_undelivered',
        bucket: 'notShipped',
        date: null,
      },
    ]);
    expect(await storedStatus(rig, ID)).toBe('paid_undelivered');
  });

  it.each(['buyer', 'agent'] as const)("the %s seat's thread list shows the hire ended and not writable", async (seat) => {
    const rig = await planted();
    const job = (await rig.jobRepo.findById(ID))!;
    const did = seat === 'buyer' ? BUYER_DID : OWNER_DID;
    const identity = seat === 'buyer' ? buyerIdentity : ownerIdentity;

    const res = await send(rig, 'GET', `/accounts/${did}/threads`, identity);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { threads: unknown[] }).threads).toEqual([thread(job, seat)]);
  });

  it("the buyer's public conduct record counts the hire as confirmed and nothing else", async () => {
    const rig = await planted();

    const res = await send(rig, 'GET', `/buyers/${BUYER_LOGIN}/conduct`, null);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      githubLogin: BUYER_LOGIN,
      keyed: true,
      counts: {
        confirmed: 1,
        walkedAfterConfirm: 0,
        stagedDeclined: 0,
        closedUnpaid: 0,
        merged: 0,
        deemed: 0,
        closedUnmerged: 0,
        citedCloses: 0,
        redosRequested: 0,
        walkedAway: 0,
      },
      operatorCounts: { deliveredNeverPaid: 0, redosRefused: 0, walkedAfterDeposit: 0, paidNeverDelivered: 0 },
    });
  });

  it("the owner's public conduct record counts the hire as paid and never delivered", async () => {
    const rig = await planted();

    const res = await send(rig, 'GET', `/buyers/${OWNER_LOGIN}/conduct`, null);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      githubLogin: OWNER_LOGIN,
      keyed: true,
      counts: {
        confirmed: 0,
        walkedAfterConfirm: 0,
        stagedDeclined: 0,
        closedUnpaid: 0,
        merged: 0,
        deemed: 0,
        closedUnmerged: 0,
        citedCloses: 0,
        redosRequested: 0,
        walkedAway: 0,
      },
      operatorCounts: { deliveredNeverPaid: 0, redosRefused: 0, walkedAfterDeposit: 0, paidNeverDelivered: 1 },
    });
  });
});

describe('(e) a mutation on the ended hire refuses as for any final status', () => {
  it('POST /jobs/:jobId/pull-request on a staged hire the load ends answers 409 with the final-status sentence and reads nothing from GitHub', async () => {
    const rig = await boot();
    await plantPaid(rig, 'j-dc-e', 'staged', JUST_OVER_7_DAYS);

    const res = await send(rig, 'POST', '/jobs/j-dc-e/pull-request', agentIdentity, {
      pullRequestUrl: 'https://github.com/buyer/target-repo/pull/9',
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'this job is "paid_undelivered", a final status, so it cannot change' });
    expect(rig.fixture.calls.getPullRequest).toEqual([]);
    expect(await storedStatus(rig, 'j-dc-e')).toBe('paid_undelivered');
  });
});

describe('(f) POST /jobs/:jobId/merge on a hire that ended before a pull request opened', () => {
  it('answers 409 and never reads a pull request from GitHub', async () => {
    const rig = await boot();
    await rig.jobRepo.create({ ...plantedJob('j-dc-f', 'staged', settledAgo(9 * DAY_MS)), status: 'paid_undelivered' });

    const res = await send(rig, 'POST', '/jobs/j-dc-f/merge', buyerIdentity);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'cannot merge a job in status "paid_undelivered"' });
    expect(rig.fixture.calls.getPullRequest).toEqual([]);
  });
});

interface PaymentWalk {
  readonly jobId: string;
  readonly depositBody: unknown;
}

// Walks a real hire to staged over the routes: brief, criteria, price,
// deposit paid by wallet response, confirm, stage.
async function walkToStaged(rig: Rig): Promise<PaymentWalk> {
  const created = await send(rig, 'POST', '/jobs', buyerIdentity, {
    buyerDid: BUYER_DID,
    agentDid: AGENT_DID,
    repository: REPOSITORY,
    brief: 'Fix the login bug',
  });
  const jobId = String(((await created.json()) as { id: unknown }).id);
  await send(rig, 'POST', `/jobs/${jobId}/criteria`, agentIdentity, {
    criteria: [
      { text: 'The login bug is fixed', proposedBy: 'agent' },
      { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
    ],
    priceUsd: '500.00',
    rail: 'usdc',
  });
  for (const index of [0, 1]) {
    await send(rig, 'POST', `/jobs/${jobId}/criteria/${String(index)}/accept`, buyerIdentity);
    await send(rig, 'POST', `/jobs/${jobId}/criteria/${String(index)}/accept`, agentIdentity);
  }
  await send(rig, 'POST', `/jobs/${jobId}/price/accept`, buyerIdentity);
  await send(rig, 'POST', `/jobs/${jobId}/price/accept`, agentIdentity);
  await send(rig, 'POST', `/jobs/${jobId}/payments/deposit/usdc/start`, buyerIdentity);
  const deposit = await send(rig, 'POST', `/jobs/${jobId}/payments/deposit/usdc/wallet-response`, buyerIdentity, {
    priceTxHash: '0xdep-price',
    feeTx: { signed: true, hash: '0xdep-fee' },
  });
  const depositBody: unknown = await deposit.json();
  expect(deposit.status).toBe(200);
  expect((await send(rig, 'POST', `/jobs/${jobId}/confirm`, buyerIdentity)).status).toBe(200);
  expect((await send(rig, 'POST', `/jobs/${jobId}/stage`, agentIdentity, { stagedCommit: STAGED_COMMIT })).status).toBe(200);
  return { jobId, depositBody };
}

const REMAINDER_REPORT = { priceTxHash: '0xrem-price', feeTx: { signed: true, hash: '0xrem-fee' } };

async function paidLines(rig: Rig, jobId: string, body: string): Promise<number> {
  return (await rig.messageRepo.listByJobId(jobId)).filter((message) => message.body === body).length;
}

describe('(g) B82: a payment report posted twice writes nothing the second time', () => {
  it('a replayed deposit report answers as the first did, keeps the first observedAt and adds no second paid line', async () => {
    const rig = await boot();
    const { jobId, depositBody } = await walkToStaged(rig);
    const first = await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit');
    expect(first?.observedAt).toEqual(NOW);
    expect(await paidLines(rig, jobId, 'Deposit paid')).toBe(1);

    vi.setSystemTime(new Date(NOW.getTime() + 2 * DAY_MS));
    const replay = await send(rig, 'POST', `/jobs/${jobId}/payments/deposit/usdc/wallet-response`, buyerIdentity, {
      priceTxHash: '0xdep-price',
      feeTx: { signed: true, hash: '0xdep-fee' },
    });

    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(depositBody);
    expect((await rig.settlementRepo.findByJobAndLeg(jobId, 'deposit'))?.observedAt).toEqual(NOW);
    expect(await paidLines(rig, jobId, 'Deposit paid')).toBe(1);
  });

  it('a replayed remainder report answers as the first did, keeps the first observedAt and adds no second paid line', async () => {
    const rig = await boot();
    const { jobId } = await walkToStaged(rig);
    await send(rig, 'POST', `/jobs/${jobId}/payments/remainder/usdc/start`, buyerIdentity);
    const firstRes = await send(rig, 'POST', `/jobs/${jobId}/payments/remainder/usdc/wallet-response`, buyerIdentity, REMAINDER_REPORT);
    const firstBody: unknown = await firstRes.json();
    expect(firstRes.status).toBe(200);

    vi.setSystemTime(new Date(NOW.getTime() + 6 * DAY_MS));
    const replay = await send(rig, 'POST', `/jobs/${jobId}/payments/remainder/usdc/wallet-response`, buyerIdentity, REMAINDER_REPORT);

    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    expect((await rig.settlementRepo.findByJobAndLeg(jobId, 'remainder'))?.observedAt).toEqual(NOW);
    expect(await paidLines(rig, jobId, 'Remainder paid')).toBe(1);
  });

  it('a remainder replayed after 6 days does not stop the hire ending on day 7 and 1 ms', async () => {
    const rig = await boot();
    const { jobId } = await walkToStaged(rig);
    await send(rig, 'POST', `/jobs/${jobId}/payments/remainder/usdc/start`, buyerIdentity);
    await send(rig, 'POST', `/jobs/${jobId}/payments/remainder/usdc/wallet-response`, buyerIdentity, REMAINDER_REPORT);

    vi.setSystemTime(new Date(NOW.getTime() + 6 * DAY_MS));
    const replay = await send(rig, 'POST', `/jobs/${jobId}/payments/remainder/usdc/wallet-response`, buyerIdentity, REMAINDER_REPORT);
    expect(replay.status).toBe(200);

    vi.setSystemTime(new Date(NOW.getTime() + EXACTLY_7_DAYS));
    const onDaySeven = await send(rig, 'GET', `/jobs/${jobId}`, null);
    expect(((await onDaySeven.json()) as { status: string }).status).toBe('staged');

    vi.setSystemTime(new Date(NOW.getTime() + JUST_OVER_7_DAYS));
    const afterDaySeven = await send(rig, 'GET', `/jobs/${jobId}`, null);
    expect(((await afterDaySeven.json()) as { status: string }).status).toBe('paid_undelivered');
    expect(await storedStatus(rig, jobId)).toBe('paid_undelivered');
  });

  it('a first remainder report still writes the row at the time it arrived and one paid line', async () => {
    const rig = await boot();
    const { jobId } = await walkToStaged(rig);
    vi.setSystemTime(new Date(NOW.getTime() + DAY_MS));
    await send(rig, 'POST', `/jobs/${jobId}/payments/remainder/usdc/start`, buyerIdentity);

    const res = await send(rig, 'POST', `/jobs/${jobId}/payments/remainder/usdc/wallet-response`, buyerIdentity, REMAINDER_REPORT);

    expect(res.status).toBe(200);
    const row = await rig.settlementRepo.findByJobAndLeg(jobId, 'remainder');
    expect(row?.observedAt).toEqual(new Date('2026-10-07T12:00:00.000Z'));
    expect(await paidLines(rig, jobId, 'Remainder paid')).toBe(1);
  });
});

describe('(h) a settlement read that throws', () => {
  it('answers 503 on GET /jobs/:jobId and writes nothing', async () => {
    const rig = await boot({
      gate: () => {
        const gate = new MemorySettlementGate();
        gate.markBalanceSettled('j-dc-h');
        return gate;
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await plantPaid(rig, 'j-dc-h', 'staged', JUST_OVER_7_DAYS);
    const before = structuredClone(await rig.jobRepo.findById('j-dc-h'));
    rig.settlementRepo.failRemainderReads = true;

    const res = await send(rig, 'GET', '/jobs/j-dc-h', null);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'storage unavailable' });
    expect(await rig.jobRepo.findById('j-dc-h')).toEqual(before);
    expect(await rig.messageRepo.listByJobId('j-dc-h')).toEqual([]);
  });
});
