// The browser wallet engine pays a leg in ABT on Ethereum, driven in jsdom against the
// real app and the real ABT-on-Ethereum routes (the discipline tests/web/usdc-wallet.test.ts
// holds to). The rail is injected at createApp's own positions: the real rail on a fake
// chain client (receipts and block times) and a fake price feed. A fake EIP-1193 wallet
// writes the chain state the server reads, decoded from the call data it was given, so a
// confirmed payment proves the engine asked for exactly what the server confirms.
import type { Server } from 'node:http';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Interface } from 'ethers';
import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { createAbtEthPaymentRail } from '../../src/adapters/payment/abt-eth.js';
import { createMemoryAbtEthQuoteLockStorage } from '../../src/adapters/payment/abt-eth-quote-lock-memory.js';
import type { AbtEthQuoteLock, AbtEthQuoteLockStorage } from '../../src/adapters/payment/abt-eth-quote-lock.js';
import { createMemoryAbtEthShortPaymentStorage } from '../../src/adapters/payment/abt-eth-short-payment-memory.js';
import type { AbtEthShortPaymentStorage } from '../../src/adapters/payment/abt-eth-short-payment.js';
import type { Erc20ObservedTransfer } from '../../src/adapters/payment/erc20.js';
import { PrismaSettlementGate } from '../../src/adapters/payment/gate.js';
import type { RateReading } from '../../src/adapters/payment/types.js';
import { createUsdcPaymentRail } from '../../src/adapters/payment/usdc.js';
import type { UsdcSpentTransferRow, UsdcSpentTransferStorage } from '../../src/adapters/payment/usdc-spent-transfer-storage-types.js';
import { MemoryAccountRepository, MemoryAgentRepository, MemoryJobRepository, MemoryMessageRepository, MemorySettlementRepository } from '../../src/adapters/storage/memory.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSessionToken } from '../helpers/session-fixtures.js';
import { fakeHalfPaidStorage } from '../helpers/usdc-half-paid-fixtures.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import { signingIdentityFromSeed, type SigningIdentity } from '../helpers/sign-request.js';
import { postSigned } from '../helpers/abt-fixtures.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const INSIDE_HOLD = '2026-10-06T12:10:00.000Z';
const AFTER_HOLD = '2026-10-06T12:20:00.000Z';
const FEED_TIME = new Date('2026-10-06T11:59:00.000Z');
const ABT_TOKEN = '0xb98d4c97425d9908e66e53a6fdf673acca0be986';
const ABT_FEE_ADDRESS = '0x2222222222222222222222222222222222222222';
const OWNER_ETH = '0x1111111111111111111111111111111111111111';
const USDC_TOKEN = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const USDC_FEE_ADDRESS = '0x00000000000000000000000000000000000000AB';
const OWNER_USDC = '0x00000000000000000000000000000000000000CD';
const USDC_CHAIN_ID = 421614;
const BUYER_FROM_ADDRESS = '0x00000000000000000000000000000000000000EF';
const ABT_KEY = 'fa_abt_eth_wallet';
const USDC_KEY = 'fa_usdc_wallet';
const TRANSFER_IFACE = new Interface(['function transfer(address,uint256)']);

const PRICE_SENTENCE = 'The ABT price is not available right now. Nothing was charged. Try again in a minute.';
const SHORT_SENTENCE =
  'Your payment arrived after the price hold, and ABT is now worth less than the agreed price. The owner will either accept it as paid or send it back to you, and the hire waits until they choose.';
const UNSUPPORTED_SENTENCE = 'This page cannot pay that way yet. Nothing was charged.';
const ETHEREUM_CHAIN = {
  chainId: '0x1',
  chainName: 'Ethereum',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://ethereum-rpc.publicnode.com'],
  blockExplorerUrls: ['https://etherscan.io'],
};
const DEPOSIT_PAID_LINE = {
  body: 'Deposit paid',
  systemEvent: { type: 'deposit_paid', leg: 'deposit', amountUsd: '125.00', rail: 'abt_eth' },
};
const REMAINDER_PAID_LINE = {
  body: 'Remainder paid',
  systemEvent: { type: 'remainder_paid', leg: 'remainder', amountUsd: '375.00', rail: 'abt_eth' },
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

// Both rails read the same receipt store; every hash is unique across them.
interface Chain {
  readonly receipts: Map<string, { status: number; transfer: Erc20ObservedTransfer }>;
  readonly recorded: Map<string, Date | null>;
  hashCounter: number;
  // The block time the next transfers are recorded at.
  recordedAt: string | null;
}
function newChain(): Chain {
  return { receipts: new Map(), recorded: new Map(), hashCounter: 0, recordedAt: INSIDE_HOLD };
}
function hashOf(n: number): string {
  return `0x${n.toString(16).padStart(64, '0')}`;
}
interface RecordedSend {
  readonly hash: string;
  readonly to: string;
  readonly recipient: string;
  readonly amountBaseUnits: string;
}
function landReceipt(chain: Chain, send: RecordedSend): void {
  const token = send.to.toLowerCase();
  chain.receipts.set(send.hash, {
    status: 1,
    transfer: { to: send.recipient.toLowerCase(), value: send.amountBaseUnits, tokenContract: token, chainId: token === ABT_TOKEN ? 1 : USDC_CHAIN_ID },
  });
}

interface WalletOptions {
  readonly switchBehavior?: 'succeed' | 'fail-then-add-succeeds' | 'refuse-with-4001';
  readonly refuseFeeTransfer?: boolean;
  readonly feeNeverConfirms?: boolean;
}
interface FakeWallet {
  readonly provider: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
  readonly calls: string[];
  readonly sends: RecordedSend[];
  readonly switches: unknown[];
  readonly adds: unknown[];
}
// The fake EIP-1193 wallet. It decodes eth_sendTransaction's own data through ethers'
// Interface alone, never the engine, and writes the chain state the server confirms from.
function buildFakeWallet(chain: Chain, opts: WalletOptions = {}): FakeWallet {
  const calls: string[] = [];
  const sends: RecordedSend[] = [];
  const switches: unknown[] = [];
  const adds: unknown[] = [];
  async function request(args: { method: string; params?: unknown[] }): Promise<unknown> {
    calls.push(args.method);
    const params = args.params ?? [];
    switch (args.method) {
      case 'eth_requestAccounts':
        return [BUYER_FROM_ADDRESS];
      case 'wallet_switchEthereumChain':
        switches.push(params[0]);
        if (opts.switchBehavior === 'refuse-with-4001') throw { code: 4001, message: 'User rejected' };
        if (opts.switchBehavior === 'fail-then-add-succeeds' && switches.length === 1) throw { code: -32603, message: 'unrecognized chain id' };
        return null;
      case 'wallet_addEthereumChain':
        adds.push(params[0]);
        return null;
      case 'eth_sendTransaction': {
        const tx = params[0] as { to: string; data: string };
        const [recipient, amount] = TRANSFER_IFACE.decodeFunctionData('transfer', tx.data) as unknown as [string, bigint];
        if (sends.length === 1 && opts.refuseFeeTransfer) throw { code: 4001, message: 'User rejected' };
        chain.hashCounter += 1;
        const send = { hash: hashOf(chain.hashCounter), to: tx.to, recipient, amountBaseUnits: amount.toString() };
        sends.push(send);
        chain.recorded.set(send.hash, chain.recordedAt === null ? null : new Date(chain.recordedAt));
        if (!(sends.length === 2 && opts.feeNeverConfirms)) landReceipt(chain, send);
        return send.hash;
      }
      case 'eth_getTransactionReceipt': {
        const receipt = chain.receipts.get(String(params[0]).toLowerCase());
        return receipt ? { status: receipt.status === 1 ? '0x1' : '0x0' } : null;
      }
      default:
        throw new Error(`fake wallet: unhandled method ${args.method}`);
    }
  }
  return { provider: { request }, calls, sends, switches, adds };
}

function memorySpent(): UsdcSpentTransferStorage {
  const rows = new Map<string, UsdcSpentTransferRow>();
  return { record: async (row) => void rows.set(row.hash, { ...row }), findByHash: async (hash) => rows.get(hash) ?? null };
}
// Each rail reads its env at construction.
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const original: Record<string, string | undefined> = {};
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

interface Harness {
  readonly server: Server;
  readonly baseUrl: string;
  readonly buyer: SigningIdentity;
  readonly agent: SigningIdentity;
  readonly chain: Chain;
  readonly feed: { reading: RateReading | null };
  readonly locks: AbtEthQuoteLock[];
  readonly shorts: AbtEthShortPaymentStorage;
  readonly settlementRepo: MemorySettlementRepository;
  readonly messageRepo: MemoryMessageRepository;
  readonly buyerToken: string;
  readonly jobId: string;
}
// The job prices at 500.00 USD with the default 25 percent deposit: deposit 125.00,
// remainder 375.00. The feed answers 0.25 USD per ABT, so the deposit is 500 ABT plus a
// 15 ABT fee, at 18 decimals.
async function buildHarness(seed: number): Promise<Harness> {
  const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(150 + seed));
  const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(170 + seed));
  const login = `abt-eth-engine-buyer-${seed}`;
  const accounts = new MemoryAccountRepository();
  await accounts.register({ did: buyer.did, githubLogin: login });
  const operatorDid = `did:abt:abt-eth-engine-operator-${seed}`;
  await accounts.register({ did: operatorDid, githubLogin: `abt-eth-engine-operator-${seed}` });
  await accounts.setOperatorAddressAbtEth(operatorDid, OWNER_ETH);
  await accounts.setOperatorAddressEvm(operatorDid, OWNER_USDC);
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({ did: agent.did, operatorDid, delegation: { fixture: true } as never, name: 'scout', skills: ['triage'], githubLogin: `scout-abt-eth-engine-${seed}`, negotiatesOnOwnersBehalf: true });
  await agentRepo.updateGithubBinding(agent.did, { handle: `scout-abt-eth-engine-${seed}`, status: 'verified' });
  const settlementRepo = new MemorySettlementRepository();
  const messageRepo = new MemoryMessageRepository();
  const { github } = createStagingLifecycleGithubFake();
  const chain = newChain();
  const feed: { reading: RateReading | null } = { reading: { usdPerToken: '0.25', updatedAt: FEED_TIME } };
  const abtRail = withEnv(
    { FREEAGENTS_ABT_ETH_RPC_URL: 'https://rpc.example.test', FREEAGENTS_ABT_ETH_TOKEN_CONTRACT: ABT_TOKEN, FREEAGENTS_ABT_ETH_CHAIN_ID: '1', FREEAGENTS_ABT_ETH_FEE_ADDRESS: ABT_FEE_ADDRESS },
    () =>
      createAbtEthPaymentRail({
        chainClient: {
          decimals: async () => 18,
          getTransactionReceipt: async (hash) => chain.receipts.get(hash.toLowerCase()) ?? null,
          recordedAt: async (hash) => chain.recorded.get(hash.toLowerCase()) ?? null,
        },
        rateSource: async () => feed.reading,
        spentTransferStorage: memorySpent(),
        halfPaidStorage: fakeHalfPaidStorage(),
      }),
  );
  const usdcRail = withEnv(
    { FREEAGENTS_USDC_RPC_URL: 'https://sepolia-rollup.arbitrum.io/rpc', FREEAGENTS_USDC_TOKEN_CONTRACT: USDC_TOKEN, FREEAGENTS_USDC_CHAIN_ID: String(USDC_CHAIN_ID), FREEAGENTS_USDC_FEE_ADDRESS: USDC_FEE_ADDRESS },
    () =>
      createUsdcPaymentRail({
        chainClient: { decimals: async () => 6, getTransactionReceipt: async (hash) => chain.receipts.get(hash.toLowerCase()) ?? null },
        rateSource: async () => '1',
        halfPaidStorage: fakeHalfPaidStorage(),
        spentTransferStorage: memorySpent(),
      }),
  );
  const inner: AbtEthQuoteLockStorage = createMemoryAbtEthQuoteLockStorage();
  const locks: AbtEthQuoteLock[] = [];
  const lockStorage: AbtEthQuoteLockStorage = {
    create: async (lock) => {
      const stored = await inner.create(lock);
      locks.push(stored);
      return stored;
    },
    read: (id) => inner.read(id),
  };
  const shorts = createMemoryAbtEthShortPaymentStorage();
  const sessionAdapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login, id: 900000 + seed }) });
  const app = createApp(
    accounts, agentRepo, undefined, github, new MemoryJobRepository(), undefined, undefined, undefined,
    undefined, undefined, undefined, sessionAdapter, undefined, new PrismaSettlementGate(settlementRepo), anyCommitStagingObserver(),
    undefined, null, usdcRail, settlementRepo, undefined, undefined, messageRepo,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    abtRail, lockStorage, shorts,
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const created = await postSigned(baseUrl, '/jobs', { buyerDid: buyer.did, agentDid: agent.did, repository: 'buyer/target-repo', brief: 'Fix the login bug' }, buyer);
  const jobId = String(((await created.json()) as Record<string, unknown>).id);
  const criteria = [
    { text: 'The login bug is fixed', proposedBy: 'agent' },
    { text: 'Checkout e2e test passes', proposedBy: 'agent' },
  ];
  await postSigned(baseUrl, `/jobs/${jobId}/criteria`, { criteria, priceUsd: '500.00' }, agent);
  for (const idx of [0, 1]) {
    await postSigned(baseUrl, `/jobs/${jobId}/criteria/${idx}/accept`, {}, buyer);
    await postSigned(baseUrl, `/jobs/${jobId}/criteria/${idx}/accept`, {}, agent);
  }
  await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, agent);
  const buyerToken = await mintSessionToken(sessionAdapter);
  return { server, baseUrl, buyer, agent, chain, feed, locks, shorts, settlementRepo, messageRepo, buyerToken, jobId };
}

interface EnginePage {
  readonly window: JSDOM['window'];
  close: () => void;
}
// Loads the two real scripts from the app's own static mount: api.js for FAApi.postAuthed
// and usdc-wallet.js for window.FAUsdcWallet, in one jsdom window with its own localStorage.
async function loadEnginePage(baseUrl: string): Promise<EnginePage> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: `${baseUrl}/`, runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole });
  Object.defineProperty(dom.window, 'fetch', { writable: true, value: (input: string, init?: RequestInit) => fetch(new URL(input, baseUrl), init) });
  dom.window.eval(await (await fetch(`${baseUrl}/js/pages/api.js`)).text());
  dom.window.eval(await (await fetch(`${baseUrl}/js/usdc-wallet.js`)).text());
  if (failures.length > 0) throw new Error(`engine scripts failed to load: ${failures.join('; ')}`);
  return { window: dom.window, close: () => dom.window.close() };
}
type Outcome = { outcome: string; message: string; status?: number; leg?: string };
type Engine = {
  pay: (opts: Record<string, unknown>) => Promise<Outcome>;
  check: (opts: Record<string, unknown>) => Promise<Outcome>;
};
function engineOf(page: EnginePage): Engine {
  return (page.window as unknown as { FAUsdcWallet: Engine }).FAUsdcWallet;
}

const opened: Array<{ server: Server; pages: EnginePage[] }> = [];
afterEach(async () => {
  vi.useRealTimers();
  while (opened.length > 0) {
    const entry = opened.pop();
    if (!entry) continue;
    entry.pages.forEach((page) => page.close());
    await new Promise<void>((resolve) => entry.server.close(() => resolve()));
  }
});
async function newDevicePage(h: Harness): Promise<EnginePage> {
  const page = await loadEnginePage(h.baseUrl);
  opened.find((entry) => entry.server === h.server)?.pages.push(page);
  return page;
}
async function setup(seed: number): Promise<{ h: Harness; page: EnginePage }> {
  const h = await buildHarness(seed);
  opened.push({ server: h.server, pages: [] });
  return { h, page: await newDevicePage(h) };
}

type WalletEntry = { id: string; name: string; icon: string; provider: FakeWallet['provider'] };
function walletEntry(wallet: FakeWallet): WalletEntry {
  return { id: 'fake', name: 'Fake Wallet', icon: '', provider: wallet.provider };
}
function payOpts(page: EnginePage, h: Harness, wallet: FakeWallet | null, over: Record<string, unknown>): Record<string, unknown> {
  return { window: page.window, wallet: wallet === null ? null : walletEntry(wallet), jobId: h.jobId, leg: 'deposit', token: h.buyerToken, pollIntervalMs: 5, pollLimit: 5, ...over };
}
function payAbt(page: EnginePage, h: Harness, wallet: FakeWallet | null, over: Record<string, unknown> = {}): Promise<Outcome> {
  return engineOf(page).pay(payOpts(page, h, wallet, { rail: 'abt_eth', ...over }));
}
// No rail option: the engine's default, the USDC rail.
function payUsdc(page: EnginePage, h: Harness, wallet: FakeWallet): Promise<Outcome> {
  return engineOf(page).pay(payOpts(page, h, wallet, {}));
}

interface Seen {
  readonly path: string;
  readonly body: unknown;
  readonly answer: unknown;
}
// Records every request the page makes with the server's answer. Optionally drops the
// first report before it reaches the server, and runs a hook once a start has answered.
function watchRoutes(page: EnginePage, opts: { dropFirstReport?: boolean; afterStart?: () => void } = {}): Seen[] {
  const seen: Seen[] = [];
  let dropped = false;
  const originalFetch = page.window.fetch;
  Object.defineProperty(page.window, 'fetch', {
    writable: true,
    value: async (input: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
      if (opts.dropFirstReport && !dropped && String(input).includes('/wallet-response')) {
        dropped = true;
        seen.push({ path: String(input), body, answer: null });
        throw new Error('network drop');
      }
      const response = await (originalFetch as typeof fetch)(input, init);
      seen.push({ path: String(input), body, answer: await response.clone().json() });
      if (String(input).endsWith('/start')) opts.afterStart?.();
      return response;
    },
  });
  return seen;
}
// Rewrites the answer of one route, the way a server answering differently would.
function rewriteAnswer(page: EnginePage, fragment: string, rewrite: (body: Record<string, unknown>) => Record<string, unknown>): void {
  const originalFetch = page.window.fetch;
  Object.defineProperty(page.window, 'fetch', {
    writable: true,
    value: async (input: string, init?: RequestInit) => {
      const response = await (originalFetch as typeof fetch)(input, init);
      if (!String(input).includes(fragment)) return response;
      const body = (await response.clone().json()) as Record<string, unknown>;
      return new Response(JSON.stringify(rewrite(body)), { status: response.status, headers: { 'content-type': 'application/json' } });
    },
  });
}
function stored(page: EnginePage, key: string, h: Harness, leg = 'deposit'): string | null {
  return (page.window as unknown as { localStorage: { getItem: (k: string) => string | null } }).localStorage.getItem(`${key}:${h.jobId}:${leg}`);
}
async function paidLines(h: Harness): Promise<unknown[]> {
  const rows = await h.messageRepo.listByJobId(h.jobId);
  return rows
    .filter((row) => row.systemEvent?.type === 'deposit_paid' || row.systemEvent?.type === 'remainder_paid')
    .map((row) => ({ body: row.body, systemEvent: row.systemEvent }));
}
function settlementRow(h: Harness, leg: 'deposit' | 'remainder', hashes: [string, string]): Record<string, unknown> {
  return {
    jobId: h.jobId, leg, rail: 'abt_eth', hash: hashes[0], secondaryHash: hashes[1], operatorAddress: OWNER_ETH,
    feeAddress: ABT_FEE_ADDRESS, amountUsd: leg === 'deposit' ? '125.00' : '375.00', observedAt: NOW,
  };
}
function lowered(sends: RecordedSend[]): unknown[] {
  return sends.map((s) => ({ to: s.to.toLowerCase(), recipient: s.recipient.toLowerCase(), amountBaseUnits: s.amountBaseUnits }));
}
function reports(seen: Seen[]): Seen[] {
  return seen.filter((entry) => entry.path.endsWith('/abt_eth/wallet-response'));
}

describe('(a) the engine pays a deposit and a remainder in ABT on Ethereum against the real routes', () => {
  it('leaves the whole settlement row and one paid line after each leg', async () => {
    const { h, page } = await setup(1);
    const wallet = buildFakeWallet(h.chain);

    const deposit = await payAbt(page, h, wallet);

    expect(deposit).toEqual({ outcome: 'paid', message: 'This payment is confirmed.' });
    expect(await h.settlementRepo.findByJobAndLeg(h.jobId, 'deposit')).toEqual(settlementRow(h, 'deposit', [hashOf(1), hashOf(2)]));
    expect(await paidLines(h)).toEqual([DEPOSIT_PAID_LINE]);

    expect((await postSigned(h.baseUrl, `/jobs/${h.jobId}/confirm`, {}, h.buyer)).status).toBe(200);
    expect((await postSigned(h.baseUrl, `/jobs/${h.jobId}/stage`, { stagedCommit: 'commit-abt-eth-engine' }, h.agent)).status).toBe(200);
    const remainder = await payAbt(page, h, wallet, { leg: 'remainder' });

    expect(remainder).toEqual({ outcome: 'paid', message: 'This payment is confirmed.' });
    expect(await h.settlementRepo.findByJobAndLeg(h.jobId, 'remainder')).toEqual(settlementRow(h, 'remainder', [hashOf(3), hashOf(4)]));
    expect(await paidLines(h)).toEqual([DEPOSIT_PAID_LINE, REMAINDER_PAID_LINE]);
  });
});

describe('(b) invariant 2: the call data decodes, with no call to this service, to what the start answered', () => {
  it('each transfer decodes through ethers alone to the recipient and the 18-decimal amount the start named, price before fee', async () => {
    const { h, page } = await setup(2);
    const wallet = buildFakeWallet(h.chain);
    const seen = watchRoutes(page);

    expect((await payAbt(page, h, wallet)).outcome).toBe('paid');

    expect(lowered(wallet.sends)).toEqual([
      { to: ABT_TOKEN, recipient: OWNER_ETH, amountBaseUnits: '500000000000000000000' },
      { to: ABT_TOKEN, recipient: ABT_FEE_ADDRESS, amountBaseUnits: '15000000000000000000' },
    ]);
    expect((seen[0]!.answer as { transfers: unknown[] }).transfers).toEqual([
      { recipient: OWNER_ETH, amountBaseUnits: '500000000000000000000', tokenContract: ABT_TOKEN },
      { recipient: ABT_FEE_ADDRESS, amountBaseUnits: '15000000000000000000', tokenContract: ABT_TOKEN },
    ]);
  });
});

describe('(c) the wallet is on Ethereum before it signs', () => {
  it('asks for accounts, switches to chain 1, then sends both transfers and reads both receipts', async () => {
    const { h, page } = await setup(3);
    const wallet = buildFakeWallet(h.chain);

    expect((await payAbt(page, h, wallet)).outcome).toBe('paid');

    expect(wallet.switches).toEqual([{ chainId: '0x1' }]);
    expect(wallet.adds).toEqual([]);
    expect(wallet.calls).toEqual([
      'eth_requestAccounts', 'wallet_switchEthereumChain', 'eth_sendTransaction', 'eth_sendTransaction',
      'eth_getTransactionReceipt', 'eth_getTransactionReceipt',
    ]);
  });

  it('a switch refused for a reason other than 4001 adds Ethereum once, then switches again', async () => {
    const { h, page } = await setup(4);
    const wallet = buildFakeWallet(h.chain, { switchBehavior: 'fail-then-add-succeeds' });

    expect((await payAbt(page, h, wallet)).outcome).toBe('paid');

    expect(wallet.adds).toEqual([ETHEREUM_CHAIN]);
    expect(wallet.switches).toEqual([{ chainId: '0x1' }, { chainId: '0x1' }]);
  });

  it('a switch the buyer closes (4001) is cancelled, with no add and nothing sent', async () => {
    const { h, page } = await setup(5);
    const wallet = buildFakeWallet(h.chain, { switchBehavior: 'refuse-with-4001' });

    const result = await payAbt(page, h, wallet);

    expect(result).toEqual({ outcome: 'cancelled', message: 'You closed the wallet before switching networks.' });
    expect(wallet.switches).toEqual([{ chainId: '0x1' }]);
    expect(wallet.adds).toEqual([]);
    expect(wallet.sends).toEqual([]);
  });
});

describe('(d) the report carries the lock the start answered', () => {
  it('posts exactly { priceTxHash, feeTx, quoteLockId } to the ABT-on-Ethereum routes, with the start answer\'s own lock id', async () => {
    const { h, page } = await setup(6);
    const seen = watchRoutes(page);

    expect((await payAbt(page, h, buildFakeWallet(h.chain))).outcome).toBe('paid');

    expect(seen.map((entry) => entry.path)).toEqual([
      `/jobs/${h.jobId}/payments/deposit/abt_eth/start`,
      `/jobs/${h.jobId}/payments/deposit/abt_eth/wallet-response`,
    ]);
    const lockId = (seen[0]!.answer as { quoteLock: { id: string } }).quoteLock.id;
    expect(lockId).toBe(h.locks[0]!.id);
    expect(seen[1]!.body).toEqual({ priceTxHash: hashOf(1), feeTx: { signed: true, hash: hashOf(2) }, quoteLockId: lockId });
  });

  it('stores the lock id beside the hashes, and check() reports with the stored id', async () => {
    const { h, page } = await setup(7);
    const seen = watchRoutes(page);
    const wallet = buildFakeWallet(h.chain, { feeNeverConfirms: true });

    const first = await payAbt(page, h, wallet, { pollLimit: 1 });

    expect(first.outcome).toBe('waiting_network');
    const lockId = h.locks[0]!.id;
    expect(JSON.parse(stored(page, ABT_KEY, h)!)).toEqual({ priceTxHash: hashOf(1), feeTxHash: hashOf(2), quoteLockId: lockId });
    landReceipt(h.chain, wallet.sends[1]!);

    const checked = await engineOf(page).check(payOpts(page, h, wallet, { rail: 'abt_eth' }));

    expect(checked).toEqual({ outcome: 'paid', message: 'This payment is confirmed.' });
    expect(reports(seen).map((entry) => entry.body)).toEqual([
      { priceTxHash: hashOf(1), feeTx: { signed: true, hash: hashOf(2) }, quoteLockId: lockId },
      { priceTxHash: hashOf(1), feeTx: { signed: true, hash: hashOf(2) }, quoteLockId: lockId },
    ]);
    expect(stored(page, ABT_KEY, h)).toBeNull();
  });
});

describe('(d2) the lock rides only the ABT report, and check() never guesses one', () => {
  it('a USDC report body stays exactly { priceTxHash, feeTx }, with no lock id', async () => {
    const { h, page } = await setup(16);
    const seen = watchRoutes(page);

    expect((await payUsdc(page, h, buildFakeWallet(h.chain))).outcome).toBe('paid');

    expect(seen.map((entry) => entry.path)).toEqual([
      `/jobs/${h.jobId}/payments/deposit/usdc/start`,
      `/jobs/${h.jobId}/payments/deposit/usdc/wallet-response`,
    ]);
    expect(seen[1]!.body).toEqual({ priceTxHash: hashOf(1), feeTx: { signed: true, hash: hashOf(2) } });
  });

  it('check() on an ABT record that holds no lock id refuses with a sentence and posts nothing', async () => {
    const { h, page } = await setup(17);
    const seen = watchRoutes(page);
    const wallet = buildFakeWallet(h.chain);
    (page.window as unknown as { localStorage: { setItem: (k: string, v: string) => void } }).localStorage.setItem(
      `${ABT_KEY}:${h.jobId}:deposit`,
      JSON.stringify({ priceTxHash: hashOf(1), feeTxHash: hashOf(2) }),
    );

    const checked = await engineOf(page).check(payOpts(page, h, wallet, { rail: 'abt_eth' }));

    expect(checked).toEqual({ outcome: 'server_refused', message: 'There is no saved price for this payment. Start the payment again to finish it.' });
    expect(seen).toEqual([]);
    expect(wallet.calls).toEqual([]);
  });
});

describe('(e) a record of one currency is never resumed as the other', () => {
  it('a USDC record under its own key is not resumed by an ABT payment of the same job and leg, and is left alone', async () => {
    const { h, page } = await setup(8);
    // The first payment's report never reaches the server. A report that did
    // would leave the server holding a half-paid USDC leg, and the second
    // currency is refused while the first is half-paid on the server.
    watchRoutes(page, { dropFirstReport: true });
    const usdcWallet = buildFakeWallet(h.chain, { refuseFeeTransfer: true });
    expect((await payUsdc(page, h, usdcWallet)).outcome).toBe('server_refused');
    const usdcRecord = stored(page, USDC_KEY, h);
    expect(JSON.parse(usdcRecord!)).toEqual({ priceTxHash: hashOf(1), feeTxHash: null });
    expect(stored(page, ABT_KEY, h)).toBeNull();

    const abtWallet = buildFakeWallet(h.chain);
    const result = await payAbt(page, h, abtWallet);

    expect(result.outcome).toBe('paid');
    expect(lowered(abtWallet.sends)).toEqual([
      { to: ABT_TOKEN, recipient: OWNER_ETH, amountBaseUnits: '500000000000000000000' },
      { to: ABT_TOKEN, recipient: ABT_FEE_ADDRESS, amountBaseUnits: '15000000000000000000' },
    ]);
    expect(await h.settlementRepo.findByJobAndLeg(h.jobId, 'deposit')).toEqual(settlementRow(h, 'deposit', [hashOf(2), hashOf(3)]));
    expect(stored(page, USDC_KEY, h)).toBe(usdcRecord);
    expect(stored(page, ABT_KEY, h)).toBeNull();
  });

  it('an ABT record under its own key is not resumed by a USDC payment of the same job and leg, and is left alone', async () => {
    const { h, page } = await setup(9);
    // The first payment's report never reaches the server. A report that did
    // would leave the server holding a half-paid ABT leg, and the second
    // currency is refused while the first is half-paid on the server.
    watchRoutes(page, { dropFirstReport: true });
    const abtWallet = buildFakeWallet(h.chain, { refuseFeeTransfer: true });
    expect((await payAbt(page, h, abtWallet)).outcome).toBe('server_refused');
    const abtRecord = stored(page, ABT_KEY, h);
    expect(JSON.parse(abtRecord!)).toEqual({ priceTxHash: hashOf(1), feeTxHash: null, quoteLockId: h.locks[0]!.id });
    expect(stored(page, USDC_KEY, h)).toBeNull();

    const usdcWallet = buildFakeWallet(h.chain);
    const result = await payUsdc(page, h, usdcWallet);

    expect(result.outcome).toBe('paid');
    expect(lowered(usdcWallet.sends)).toEqual([
      { to: USDC_TOKEN.toLowerCase(), recipient: OWNER_USDC.toLowerCase(), amountBaseUnits: '125000000' },
      { to: USDC_TOKEN.toLowerCase(), recipient: USDC_FEE_ADDRESS.toLowerCase(), amountBaseUnits: '7500000' },
    ]);
    expect(stored(page, ABT_KEY, h)).toBe(abtRecord);
    expect(stored(page, USDC_KEY, h)).toBeNull();
  });
});

describe('(f) a half-paid ABT leg resumes without sending the price again', () => {
  it('a reload resumes from the rail\'s own record, and reports with the lock of the start it just made', async () => {
    const { h, page } = await setup(10);
    const seen = watchRoutes(page, { dropFirstReport: true });
    const firstWallet = buildFakeWallet(h.chain, { refuseFeeTransfer: true });
    // The first report never reaches the server, so only this device knows the price was sent.
    const first = await payAbt(page, h, firstWallet);
    expect(first.outcome).toBe('server_refused');
    expect(firstWallet.sends).toHaveLength(1);

    const secondWallet = buildFakeWallet(h.chain);
    const second = await payAbt(page, h, secondWallet);

    expect(second).toEqual({ outcome: 'paid', message: 'This payment is confirmed.' });
    expect(lowered(secondWallet.sends)).toEqual([{ to: ABT_TOKEN, recipient: ABT_FEE_ADDRESS, amountBaseUnits: '15000000000000000000' }]);
    expect(h.locks).toHaveLength(2);
    const lastReport = reports(seen).pop()!;
    expect(lastReport.body).toEqual({ priceTxHash: hashOf(1), feeTx: { signed: true, hash: hashOf(2) }, quoteLockId: h.locks[1]!.id });
    expect(await h.settlementRepo.findByJobAndLeg(h.jobId, 'deposit')).toEqual(settlementRow(h, 'deposit', [hashOf(1), hashOf(2)]));
  });

  it('a clean device resumes from the start\'s halfPaidRecord, and reports with the lock of its own start', async () => {
    const { h, page: deviceA } = await setup(11);
    const walletA = buildFakeWallet(h.chain, { refuseFeeTransfer: true });
    expect((await payAbt(deviceA, h, walletA)).outcome).toBe('fee_due');
    deviceA.close();

    const deviceB = await newDevicePage(h);
    const seen = watchRoutes(deviceB);
    const walletB = buildFakeWallet(h.chain);
    const result = await payAbt(deviceB, h, walletB);

    expect(result).toEqual({ outcome: 'paid', message: 'This payment is confirmed.' });
    expect(lowered(walletB.sends)).toEqual([{ to: ABT_TOKEN, recipient: ABT_FEE_ADDRESS, amountBaseUnits: '15000000000000000000' }]);
    expect(seen[0]!.answer).toHaveProperty('halfPaidRecord');
    const startLockId = (seen[0]!.answer as { quoteLock: { id: string } }).quoteLock.id;
    expect(reports(seen)[0]!.body).toEqual({ priceTxHash: hashOf(1), feeTx: { signed: true, hash: hashOf(2) }, quoteLockId: startLockId });
    expect(await h.settlementRepo.findByJobAndLeg(h.jobId, 'deposit')).toEqual(settlementRow(h, 'deposit', [hashOf(1), hashOf(2)]));
  });
});

describe('(g) a transfer that arrives after the price hold and is worth less now', () => {
  it('is the outcome short, never paid: no settlement row, no paid line, and the stored record cleared', async () => {
    const { h, page } = await setup(12);
    h.chain.recordedAt = AFTER_HOLD;
    const seen = watchRoutes(page, {
      afterStart: () => {
        h.feed.reading = { usdPerToken: '0.2', updatedAt: new Date('2026-10-06T11:59:30.000Z') };
      },
    });
    const wallet = buildFakeWallet(h.chain);

    const result = await payAbt(page, h, wallet);

    expect(result).toEqual({ outcome: 'short', message: SHORT_SENTENCE });
    expect(reports(seen)[0]!.answer).toEqual({
      rail: 'abt_eth',
      hash: hashOf(1),
      confirmed: true,
      legs: { price: { status: 'confirmed', hash: hashOf(1) }, fee: { status: 'confirmed', hash: hashOf(2) } },
      halfPaid: false,
      priceRecordedAt: AFTER_HOLD,
      short: { recordedAt: AFTER_HOLD, agreedUsd: '125.00', worthUsd: '100' },
    });
    expect(await h.settlementRepo.findByJobAndLeg(h.jobId, 'deposit')).toBeNull();
    expect(await paidLines(h)).toEqual([]);
    expect(await h.shorts.findByJobAndLeg(h.jobId, 'deposit')).toHaveLength(1);
    expect(stored(page, ABT_KEY, h)).toBeNull();
  });
});

describe('(h) a start answer with no usable price lock is refused before the wallet is asked to do anything', () => {
  it.each([
    ['no lock at all', (body: Record<string, unknown>) => ({ ...body, quoteLock: undefined })],
    ['an empty lock id', (body: Record<string, unknown>) => ({ ...body, quoteLock: { id: '' } })],
  ])('%s: the ABT price sentence, one accounts request and nothing else sent to the wallet', async (_name, rewrite) => {
    const { h, page } = await setup(13);
    rewriteAnswer(page, '/abt_eth/start', rewrite);
    const wallet = buildFakeWallet(h.chain);

    const result = await payAbt(page, h, wallet);

    expect(result).toEqual({ outcome: 'server_refused', message: PRICE_SENTENCE });
    expect(wallet.calls).toEqual(['eth_requestAccounts']);
    expect(stored(page, ABT_KEY, h)).toBeNull();
  });

  it('the start\'s price-unavailable 503 reads as the same ABT price sentence', async () => {
    const { h, page } = await setup(14);
    h.feed.reading = null;
    const wallet = buildFakeWallet(h.chain);

    const result = await payAbt(page, h, wallet);

    expect(result).toEqual({ outcome: 'server_refused', status: 503, message: PRICE_SENTENCE });
    expect(wallet.calls).toEqual(['eth_requestAccounts']);
    expect(h.locks).toEqual([]);
  });
});

describe('(i) any other rail value is refused at once', () => {
  it.each([['abt'], ['USDC'], [''], [null]])('pay() and check() with rail %j: a sentence, no request and no wallet call', async (rail) => {
    const { h, page } = await setup(15);
    const seen = watchRoutes(page);
    const wallet = buildFakeWallet(h.chain);

    const paid = await payAbt(page, h, wallet, { rail });
    const checked = await engineOf(page).check(payOpts(page, h, wallet, { rail }));

    expect(paid).toEqual({ outcome: 'server_refused', message: UNSUPPORTED_SENTENCE });
    expect(checked).toEqual({ outcome: 'server_refused', message: UNSUPPORTED_SENTENCE });
    expect(seen).toEqual([]);
    expect(wallet.calls).toEqual([]);
  });
});
