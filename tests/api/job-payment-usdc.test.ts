// P10 / S1: the USDC payment surface (brief, scope item 4). Every
// assertion here fails without: the two USDC payment routes, the
// usdcPaymentRail capability parameter on createApp, and the observed
// settlement record they write on confirmed: true.
//
// S1 (this card): the fake chain client here answers a full observed
// transfer (recipient, value, token, chain id), not merely a status, so
// these route tests exercise the real binding path end to end rather than
// a stubbed-out "any confirmed hash confirms" shortcut.
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { PrismaSettlementGate } from '../../src/adapters/payment/gate.js';
import { createUsdcPaymentRail, type UsdcChainClient, type UsdcObservedTransfer } from '../../src/adapters/payment/usdc.js';
import type { UsdcSpentTransferRow, UsdcSpentTransferStorage } from '../../src/adapters/payment/usdc-spent-transfer-storage-types.js';
import { MemorySettlementRepository } from '../../src/adapters/storage/memory.js';
import {
  MemoryAgentRepository,
  MemoryJobRepository,
  MemoryAccountRepository,
} from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';

const proposal = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
];

const USDC_TOKEN = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const USDC_FEE_ADDRESS = '0xFeeAddress000000000000000000000000000';
const USDC_OPERATOR_ADDRESS = '0xOperator000000000000000000000000000000';
const USDC_CHAIN_ID = 421614;

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

// S1: a receipt map keyed by hash, each answering the full observed
// transfer (or null for "nothing landed yet") that legStatus binds
// against -- never merely a status.
type ReceiptSpec = { readonly status: number | null; readonly transfer: UsdcObservedTransfer | null };

function fakeUsdcChainClient(receipts: Record<string, ReceiptSpec | null> = {}): UsdcChainClient {
  return {
    decimals: async () => 6,
    getTransactionReceipt: async (hash: string) => receipts[hash] ?? null,
  };
}

// S1: a stateful fake of the spent-transfer storage, so these route tests
// never touch Prisma (DATABASE_URL is unset here) and a re-confirm within
// one test still sees what an earlier record() wrote.
function fakeSpentTransferStorage(): UsdcSpentTransferStorage {
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

// The job in every test here prices at 500.00 USD with the default 25%
// deposit: deposit 125.00 (fee 6% = 7.50), remainder 375.00 (fee 6% =
// 22.50), at a 1:1 rate and USDC's 6 decimals.
function depositPriceTransfer(overrides: Partial<UsdcObservedTransfer> = {}): UsdcObservedTransfer {
  return { to: USDC_OPERATOR_ADDRESS, value: '125000000', tokenContract: USDC_TOKEN, chainId: USDC_CHAIN_ID, ...overrides };
}
function depositFeeTransfer(overrides: Partial<UsdcObservedTransfer> = {}): UsdcObservedTransfer {
  return { to: USDC_FEE_ADDRESS, value: '7500000', tokenContract: USDC_TOKEN, chainId: USDC_CHAIN_ID, ...overrides };
}
function remainderPriceTransfer(overrides: Partial<UsdcObservedTransfer> = {}): UsdcObservedTransfer {
  return { to: USDC_OPERATOR_ADDRESS, value: '375000000', tokenContract: USDC_TOKEN, chainId: USDC_CHAIN_ID, ...overrides };
}
function remainderFeeTransfer(overrides: Partial<UsdcObservedTransfer> = {}): UsdcObservedTransfer {
  return { to: USDC_FEE_ADDRESS, value: '22500000', tokenContract: USDC_TOKEN, chainId: USDC_CHAIN_ID, ...overrides };
}

function usdcEnvVars(): Record<string, string> {
  return {
    FREEAGENTS_USDC_RPC_URL: 'https://sepolia-rollup.arbitrum.io/rpc',
    FREEAGENTS_USDC_TOKEN_CONTRACT: USDC_TOKEN,
    FREEAGENTS_USDC_CHAIN_ID: String(USDC_CHAIN_ID),
    FREEAGENTS_USDC_FEE_ADDRESS: USDC_FEE_ADDRESS,
  };
}

function withUsdcEnv<T>(fn: () => T): T {
  const original: Record<string, string | undefined> = {};
  const vars = usdcEnvVars();
  for (const key of Object.keys(vars)) {
    original[key] = process.env[key];
    process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

interface StartedApp {
  server: Server;
  baseUrl: string;
  buyer: SigningIdentity;
  agent: SigningIdentity;
  settlementRepo: MemorySettlementRepository;
}

async function startApp(usdcRail: ReturnType<typeof createUsdcPaymentRail> | null): Promise<StartedApp> {
  const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(111));
  const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(112));
  const operatorRepo = new MemoryAccountRepository();
  await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-usdc-surface' });
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: agent.did,
    operatorDid: 'did:abt:op-usdc-surface',
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: null,
  });
  const jobRepo = new MemoryJobRepository();
  const settlementRepo = new MemorySettlementRepository();
  const gate = new PrismaSettlementGate(settlementRepo);

  const app = createApp(
    operatorRepo,
    agentRepo,
    undefined,
    undefined,
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
    anyCommitStagingObserver(),
    undefined,
    null,
    usdcRail,
    settlementRepo,
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, baseUrl, buyer, agent, settlementRepo };
}

async function walkToConfirmed(baseUrl: string, buyer: SigningIdentity, agent: SigningIdentity): Promise<string> {
  const created = await postSigned(baseUrl, '/jobs', {
    buyerDid: buyer.did,
    agentDid: agent.did,
    repository: 'buyer/target-repo',
    brief: 'Fix the login bug',
  }, buyer);
  const jobId = String(((await created.json()) as Record<string, unknown>).id);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria`, { criteria: proposal, priceUsd: '500.00', rail: 'usdc' }, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, agent);
  return jobId;
}

describe('POST /jobs/:jobId/payments/deposit/usdc/start: an unconfigured rail refuses cleanly', () => {
  it('answers a clear 503 naming the rail, and the process does not crash', async () => {
    const { server, baseUrl, buyer, agent } = await startApp(null);
    try {
      const jobId = await walkToConfirmed(baseUrl, buyer, agent);
      const res = await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, { operatorAddress: USDC_OPERATOR_ADDRESS }, buyer);
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body.error)).toContain('usdc');
    } finally {
      server.close();
    }
  });
});

describe('POST /jobs/:jobId/payments/deposit/usdc/start: the happy path', () => {
  let server: Server;
  let baseUrl: string;
  let buyer: SigningIdentity;
  let agent: SigningIdentity;

  beforeAll(async () => {
    const usdcRail = withUsdcEnv(() =>
      createUsdcPaymentRail({
        chainClient: fakeUsdcChainClient(),
        rateSource: async () => '1',
        halfPaidStorage: { record: async () => {}, read: async () => null, clear: async () => {} },
        spentTransferStorage: fakeSpentTransferStorage(),
      }),
    );
    ({ server, baseUrl, buyer, agent } = await startApp(usdcRail));
  });

  afterAll(() => server.close());

  it('answers the two-transfer PaymentRequest, computed from the JOB price, ignoring an amount in the body', async () => {
    const jobId = await walkToConfirmed(baseUrl, buyer, agent);
    const res = await postSigned(
      baseUrl,
      `/jobs/${jobId}/payments/deposit/usdc/start`,
      { operatorAddress: USDC_OPERATOR_ADDRESS, amountUsd: '999999.00' },
      buyer,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.rail).toBe('usdc');
    const transfers = body.transfers as Array<Record<string, unknown>>;
    expect(transfers).toHaveLength(2);
    // 25% deposit of 500.00 is 125.00, at a 1:1 rate and 6 percent fee.
    expect(transfers[0]?.amountBaseUnits).toBe('125000000');
    expect(transfers[0]?.recipient).toBe(USDC_OPERATOR_ADDRESS);
    expect(transfers[1]?.amountBaseUnits).toBe('7500000');
  });

  it('refuses a stranger: a signer who is not the job\'s buyer cannot start a payment', async () => {
    const jobId = await walkToConfirmed(baseUrl, buyer, agent);
    const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(199));
    // Registered so the signature itself verifies (R-34); the refusal
    // under test is that a verified signature naming neither party is
    // 403, not that an unregistered DID's signature is unverifiable.
    await postSigned(baseUrl, '/accounts', { did: stranger.did, githubLogin: 'stranger-usdc-start' }, stranger);
    const res = await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, { operatorAddress: USDC_OPERATOR_ADDRESS }, stranger);
    expect(res.status).toBe(403);
  });
});

describe('POST /jobs/:jobId/payments/deposit/usdc/wallet-response: confirm writes the settlement row only when confirmed', () => {
  it('confirmed true writes exactly one settlement row and the gate opens confirm', async () => {
    const usdcRail = withUsdcEnv(() =>
      createUsdcPaymentRail({
        chainClient: fakeUsdcChainClient({
          '0xprice1': { status: 1, transfer: depositPriceTransfer() },
          '0xfee1': { status: 1, transfer: depositFeeTransfer() },
        }),
        rateSource: async () => '1',
        halfPaidStorage: { record: async () => {}, read: async () => null, clear: async () => {} },
        spentTransferStorage: fakeSpentTransferStorage(),
      }),
    );
    const { server, baseUrl, buyer, agent, settlementRepo } = await startApp(usdcRail);
    try {
      const jobId = await walkToConfirmed(baseUrl, buyer, agent);
      await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, { operatorAddress: USDC_OPERATOR_ADDRESS }, buyer);

      const res = await postSigned(
        baseUrl,
        `/jobs/${jobId}/payments/deposit/usdc/wallet-response`,
        {
          operatorAddress: USDC_OPERATOR_ADDRESS,
          priceTxHash: '0xprice1',
          feeTx: { signed: true, hash: '0xfee1' },
        },
        buyer,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.confirmed).toBe(true);

      const row = await settlementRepo.findByJobAndLeg(jobId, 'deposit');
      expect(row).not.toBeNull();
      expect(row?.amountUsd).toBe('125.00');

      // Repeated confirm on the same ref leaves exactly one row (idempotent
      // per the interface's own requirement); observedAt legitimately
      // advances on each write since confirm() re-observes the chain every
      // call, so only the hash identity is pinned here.
      await postSigned(
        baseUrl,
        `/jobs/${jobId}/payments/deposit/usdc/wallet-response`,
        {
          operatorAddress: USDC_OPERATOR_ADDRESS,
          priceTxHash: '0xprice1',
          feeTx: { signed: true, hash: '0xfee1' },
        },
        buyer,
      );
      const rowAgain = await settlementRepo.findByJobAndLeg(jobId, 'deposit');
      expect(rowAgain?.hash).toBe(row?.hash);
      expect(rowAgain?.jobId).toBe(row?.jobId);
      expect(rowAgain?.leg).toBe(row?.leg);

      const confirm = await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
      expect(confirm.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('confirmed false (nothing landed yet) writes no settlement row, and the gate still refuses', async () => {
    const usdcRail = withUsdcEnv(() =>
      createUsdcPaymentRail({
        chainClient: fakeUsdcChainClient(),
        rateSource: async () => '1',
        halfPaidStorage: { record: async () => {}, read: async () => null, clear: async () => {} },
        spentTransferStorage: fakeSpentTransferStorage(),
      }),
    );
    const { server, baseUrl, buyer, agent, settlementRepo } = await startApp(usdcRail);
    try {
      const jobId = await walkToConfirmed(baseUrl, buyer, agent);
      await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, { operatorAddress: USDC_OPERATOR_ADDRESS }, buyer);
      const res = await postSigned(
        baseUrl,
        `/jobs/${jobId}/payments/deposit/usdc/wallet-response`,
        { operatorAddress: USDC_OPERATOR_ADDRESS, priceTxHash: '0xprice2', feeTx: { signed: true, hash: '0xfee2' } },
        buyer,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.confirmed).toBe(false);
      expect(await settlementRepo.findByJobAndLeg(jobId, 'deposit')).toBeNull();

      const confirm = await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
      expect(confirm.status).toBe(402);
    } finally {
      server.close();
    }
  });

  it('the half-paid case writes no settlement, and the response names which leg confirmed and which did not', async () => {
    const usdcRail = withUsdcEnv(() =>
      createUsdcPaymentRail({
        chainClient: fakeUsdcChainClient({
          '0xprice3': { status: 1, transfer: depositPriceTransfer() },
        }),
        rateSource: async () => '1',
        halfPaidStorage: { record: async () => {}, read: async () => null, clear: async () => {} },
        spentTransferStorage: fakeSpentTransferStorage(),
      }),
    );
    const { server, baseUrl, buyer, agent, settlementRepo } = await startApp(usdcRail);
    try {
      const jobId = await walkToConfirmed(baseUrl, buyer, agent);
      await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, { operatorAddress: USDC_OPERATOR_ADDRESS }, buyer);
      const res = await postSigned(
        baseUrl,
        `/jobs/${jobId}/payments/deposit/usdc/wallet-response`,
        { operatorAddress: USDC_OPERATOR_ADDRESS, priceTxHash: '0xprice3', feeTx: { signed: true, hash: '0xfee3' } },
        buyer,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.confirmed).toBe(false);
      expect(body.halfPaid).toBe(true);
      const legs = body.legs as Record<string, Record<string, unknown>>;
      expect(legs.price?.status).toBe('confirmed');
      expect(legs.fee?.status).toBe('not_confirmed');
      expect(await settlementRepo.findByJobAndLeg(jobId, 'deposit')).toBeNull();

      const confirm = await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
      expect(confirm.status).toBe(402);
    } finally {
      server.close();
    }
  });

  it('a stranger cannot post a wallet response for someone else\'s job', async () => {
    const usdcRail = withUsdcEnv(() =>
      createUsdcPaymentRail({
        chainClient: fakeUsdcChainClient({
          '0xprice4': { status: 1, transfer: depositPriceTransfer() },
          '0xfee4': { status: 1, transfer: depositFeeTransfer() },
        }),
        rateSource: async () => '1',
        halfPaidStorage: { record: async () => {}, read: async () => null, clear: async () => {} },
        spentTransferStorage: fakeSpentTransferStorage(),
      }),
    );
    const { server, baseUrl, buyer, agent } = await startApp(usdcRail);
    try {
      const jobId = await walkToConfirmed(baseUrl, buyer, agent);
      const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(198));
      await postSigned(baseUrl, '/accounts', { did: stranger.did, githubLogin: 'stranger-usdc-wallet-response' }, stranger);
      const res = await postSigned(
        baseUrl,
        `/jobs/${jobId}/payments/deposit/usdc/wallet-response`,
        { operatorAddress: USDC_OPERATOR_ADDRESS, priceTxHash: '0xprice4', feeTx: { signed: true, hash: '0xfee4' } },
        stranger,
      );
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });
});

describe('S1: priceTxHash equal to feeTx.hash is refused as a malformed request, not answered as a chain observation (Case D)', () => {
  it('answers 400 and confirms neither leg', async () => {
    const usdcRail = withUsdcEnv(() =>
      createUsdcPaymentRail({
        chainClient: fakeUsdcChainClient({
          '0xsame': { status: 1, transfer: depositPriceTransfer() },
        }),
        rateSource: async () => '1',
        halfPaidStorage: { record: async () => {}, read: async () => null, clear: async () => {} },
        spentTransferStorage: fakeSpentTransferStorage(),
      }),
    );
    const { server, baseUrl, buyer, agent, settlementRepo } = await startApp(usdcRail);
    try {
      const jobId = await walkToConfirmed(baseUrl, buyer, agent);
      await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, { operatorAddress: USDC_OPERATOR_ADDRESS }, buyer);
      const res = await postSigned(
        baseUrl,
        `/jobs/${jobId}/payments/deposit/usdc/wallet-response`,
        { operatorAddress: USDC_OPERATOR_ADDRESS, priceTxHash: '0xsame', feeTx: { signed: true, hash: '0xsame' } },
        buyer,
      );
      expect(res.status).toBe(400);
      expect(await settlementRepo.findByJobAndLeg(jobId, 'deposit')).toBeNull();
    } finally {
      server.close();
    }
  });
});

describe('review round 3, D4: the job\'s own agent is a real party to the job but not its buyer, and starting or confirming a usdc payment is refused', () => {
  it('the agent cannot start a usdc payment for the job it was hired on, and no settlement is written', async () => {
    const usdcRail = withUsdcEnv(() =>
      createUsdcPaymentRail({
        chainClient: fakeUsdcChainClient(),
        rateSource: async () => '1',
        halfPaidStorage: { record: async () => {}, read: async () => null, clear: async () => {} },
        spentTransferStorage: fakeSpentTransferStorage(),
      }),
    );
    const { server, baseUrl, buyer, agent, settlementRepo } = await startApp(usdcRail);
    try {
      const jobId = await walkToConfirmed(baseUrl, buyer, agent);
      const res = await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, { operatorAddress: USDC_OPERATOR_ADDRESS }, agent);
      expect(res.status).toBe(403);
      expect(await settlementRepo.findByJobAndLeg(jobId, 'deposit')).toBeNull();
    } finally {
      server.close();
    }
  });

  it('the agent cannot post a wallet response and settle the job\'s own remainder leg', async () => {
    const usdcRail = withUsdcEnv(() =>
      createUsdcPaymentRail({
        chainClient: fakeUsdcChainClient({
          '0xagentprice': { status: 1, transfer: remainderPriceTransfer() },
          '0xagentfee': { status: 1, transfer: remainderFeeTransfer() },
        }),
        rateSource: async () => '1',
        halfPaidStorage: { record: async () => {}, read: async () => null, clear: async () => {} },
        spentTransferStorage: fakeSpentTransferStorage(),
      }),
    );
    const { server, baseUrl, buyer, agent, settlementRepo } = await startApp(usdcRail);
    try {
      const jobId = await walkToConfirmed(baseUrl, buyer, agent);
      const res = await postSigned(
        baseUrl,
        `/jobs/${jobId}/payments/remainder/usdc/wallet-response`,
        { operatorAddress: USDC_OPERATOR_ADDRESS, priceTxHash: '0xagentprice', feeTx: { signed: true, hash: '0xagentfee' } },
        agent,
      );
      expect(res.status).toBe(403);
      expect(await settlementRepo.findByJobAndLeg(jobId, 'remainder')).toBeNull();
    } finally {
      server.close();
    }
  });
});

describe('the remainder leg confirms independently of the deposit leg, and unlocks pull-request', () => {
  it('a settled remainder leg lets pull-request pass its settlement gate, driven through the route', async () => {
    const usdcRail = withUsdcEnv(() =>
      createUsdcPaymentRail({
        chainClient: fakeUsdcChainClient({
          '0xdep-price': { status: 1, transfer: depositPriceTransfer() },
          '0xdep-fee': { status: 1, transfer: depositFeeTransfer() },
          '0xrem-price': { status: 1, transfer: remainderPriceTransfer() },
          '0xrem-fee': { status: 1, transfer: remainderFeeTransfer() },
        }),
        rateSource: async () => '1',
        halfPaidStorage: { record: async () => {}, read: async () => null, clear: async () => {} },
        spentTransferStorage: fakeSpentTransferStorage(),
      }),
    );
    const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(121));
    const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(122));
    const operatorRepo = new MemoryAccountRepository();
    await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-usdc-remainder' });
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: 'did:abt:op-usdc-remainder',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const jobRepo = new MemoryJobRepository();
    const settlementRepo = new MemorySettlementRepository();
    const gate = new PrismaSettlementGate(settlementRepo);
    const forkCalls: unknown[] = [];
    const github = {
      getPullRequest: () => Promise.reject(new Error('unused')),
      getMergeCommitSignature: () => Promise.reject(new Error('unused')),
      getPublicGist: () => Promise.reject(new Error('unused')),
      forkAndOpenPullRequest: (input: unknown) => {
        forkCalls.push(input);
        return Promise.resolve({ owner: 'freeagents-platform', repo: 'target-repo', number: 1 });
      },
    };
    const app = createApp(
      operatorRepo,
      agentRepo,
      undefined,
      github as never,
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
      anyCommitStagingObserver(),
      undefined,
      null,
      usdcRail,
      settlementRepo,
    );
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const jobId = await walkToConfirmed(baseUrl, buyer, agent);
      // Deposit settles first (confirm needs it).
      await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, { operatorAddress: USDC_OPERATOR_ADDRESS }, buyer);
      await postSigned(
        baseUrl,
        `/jobs/${jobId}/payments/deposit/usdc/wallet-response`,
        { operatorAddress: USDC_OPERATOR_ADDRESS, priceTxHash: '0xdep-price', feeTx: { signed: true, hash: '0xdep-fee' } },
        buyer,
      );
      const confirm = await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
      expect(confirm.status).toBe(200);
      await postSigned(baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-usdc-1' }, agent);

      const before = forkCalls.length;
      const prBlocked = await postSigned(baseUrl, `/jobs/${jobId}/pull-request`, {}, agent);
      expect(prBlocked.status).toBe(402);
      expect(forkCalls.length).toBe(before);

      await postSigned(baseUrl, `/jobs/${jobId}/payments/remainder/usdc/start`, { operatorAddress: USDC_OPERATOR_ADDRESS }, buyer);
      await postSigned(
        baseUrl,
        `/jobs/${jobId}/payments/remainder/usdc/wallet-response`,
        { operatorAddress: USDC_OPERATOR_ADDRESS, priceTxHash: '0xrem-price', feeTx: { signed: true, hash: '0xrem-fee' } },
        buyer,
      );
      const remainderRow = await settlementRepo.findByJobAndLeg(jobId, 'remainder');
      expect(remainderRow?.amountUsd).toBe('375.00');

      const pr = await postSigned(baseUrl, `/jobs/${jobId}/pull-request`, {}, agent);
      expect(pr.status).toBe(200);
      expect(forkCalls.length).toBe(before + 1);
    } finally {
      server.close();
    }
  });
});
