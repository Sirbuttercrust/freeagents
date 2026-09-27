// USDC-WEBa (Make 3): the browser wallet engine, driven in jsdom against the real
// app -- exactly the discipline tests/web/deposit.test.ts holds to, extended for
// a wallet protocol. No page loads the engine yet (USDC-WEBb): this proves it
// directly, loading /js/pages/api.js and /js/usdc-wallet.js from the app's own
// static mount and driving a fake EIP-1193 wallet whose receipts the server's
// fake chain client answers, decoded from the data the wallet was given, so a
// confirmed payment proves the engine asked for exactly what the server confirms.
import type { Server } from 'node:http';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { Interface } from 'ethers';
import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { PrismaSettlementGate } from '../../src/adapters/payment/gate.js';
import { createUsdcPaymentRail, type UsdcChainClient } from '../../src/adapters/payment/usdc.js';
import type { UsdcSpentTransferRow, UsdcSpentTransferStorage } from '../../src/adapters/payment/usdc-spent-transfer-storage-types.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSessionToken } from '../helpers/session-fixtures.js';
import { MemoryAccountRepository, MemoryAgentRepository, MemoryJobRepository, MemorySettlementRepository } from '../../src/adapters/storage/memory.js';
import { fakeHalfPaidStorage } from '../helpers/usdc-half-paid-fixtures.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import { signingIdentityFromSeed, type SigningIdentity } from '../helpers/sign-request.js';
import { postSigned } from '../helpers/abt-fixtures.js';
const USDC_TOKEN = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const USDC_FEE_ADDRESS = '0x00000000000000000000000000000000000000AB';
const USDC_OPERATOR_ADDRESS = '0x00000000000000000000000000000000000000CD';
const USDC_CHAIN_ID = 421614;
const BUYER_FROM_ADDRESS = '0x00000000000000000000000000000000000000EF';
const TRANSFER_IFACE = new Interface(['function transfer(address,uint256)']);
// A live, shared receipt store the server's chain client reads, written only by
// the fake wallet's eth_sendTransaction handler: proves the receipt confirm()
// reads is the transfer the engine's call data asked for, never test-invented.
interface ChainState {
  readonly receipts: Map<string, { status: number; transfer: { to: string; value: string; tokenContract: string; chainId: number } }>;
  hashCounter: number;
}
type Eip6963Window = {
  addEventListener: (event: string, handler: () => void) => void;
  dispatchEvent: (event: Event) => void; CustomEvent: typeof CustomEvent;
  ethereum?: unknown;
};
function announceWallet(win: Eip6963Window, uuid: string, name: string): void {
  win.dispatchEvent(new win.CustomEvent('eip6963:announceProvider', { detail: { info: { uuid, name }, provider: {} } }));
}
function newChainState(): ChainState {
  return { receipts: new Map(), hashCounter: 0 };
}
// A late-landing fee receipt: the transaction was real, only slow.
function markFeeConfirmed(chainState: ChainState): void {
  chainState.receipts.set('0xsent2', {
    status: 1,
    transfer: { to: USDC_FEE_ADDRESS.toLowerCase(), value: '7500000', tokenContract: USDC_TOKEN, chainId: USDC_CHAIN_ID },
  });
}
function serverChainClient(state: ChainState): UsdcChainClient {
  return {
    decimals: async () => 6,
    getTransactionReceipt: async (hash: string) => state.receipts.get(hash.toLowerCase()) ?? null,
  };
}
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
// The rail reads its env at construction; this suite builds one rail per
// harness (each with its own fake chain client): every call site below wraps
// createUsdcPaymentRail in this, mirroring every sibling file's withUsdcEnv.
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
// The fake EIP-1193 wallet. Records every call, decodes eth_sendTransaction's
// own data through ethers' Interface alone (never this engine), and writes the
// server's own chain state so confirm() observes what this wallet signed.
interface RecordedSend {
  readonly to: string;
  readonly data: string;
  readonly recipient: string;
  readonly amountBaseUnits: string;
}
interface FakeWalletOptions {
  readonly chainState: ChainState;
  readonly switchBehavior?: 'succeed' | 'fail-then-add-succeeds' | 'always-fail' | 'refuse-with-4001';
  readonly refuseFeeTransfer?: boolean;
  readonly failPriceOnChain?: boolean;
  readonly feeNeverConfirms?: boolean;
  readonly priceNeverConfirms?: boolean;
  readonly mismatchPriceReceipt?: boolean;
  readonly pendingRounds?: number;
}
interface FakeWallet {
  readonly provider: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
  readonly calls: string[];
  readonly sends: RecordedSend[];
}
function buildFakeWallet(opts: FakeWalletOptions): FakeWallet {
  const calls: string[] = [];
  const sends: RecordedSend[] = [];
  let switchAttempt = 0;
  const receiptReadCounts = new Map<string, number>();
  async function request(args: { method: string; params?: unknown[] }): Promise<unknown> {
    calls.push(args.method);
    const params = args.params ?? [];
    switch (args.method) {
      case 'eth_requestAccounts':
        return [BUYER_FROM_ADDRESS];
      case 'wallet_switchEthereumChain': {
        if (opts.switchBehavior === 'always-fail') {
          throw { code: -32603, message: 'unrecognized chain id' };
        }
        if (opts.switchBehavior === 'refuse-with-4001') {
          throw { code: 4001, message: 'User rejected' };
        }
        if (opts.switchBehavior === 'fail-then-add-succeeds') {
          switchAttempt += 1;
          if (switchAttempt === 1) throw { code: -32603, message: 'unrecognized chain id' };
        }
        return null;
      }
      case 'wallet_addEthereumChain':
        return null;
      case 'eth_sendTransaction': {
        const tx = params[0] as { from: string; to: string; data: string; value: string };
        const [recipient, amount] = TRANSFER_IFACE.decodeFunctionData('transfer', tx.data) as unknown as [string, bigint];
        const isFee = tx.to.toLowerCase() === USDC_TOKEN.toLowerCase() && sends.length === 1;
        if (isFee && opts.refuseFeeTransfer) {
          throw { code: 4001, message: 'User rejected' };
        }
        opts.chainState.hashCounter += 1;
        const hash = `0xsent${opts.chainState.hashCounter}`;
        sends.push({ to: tx.to, data: tx.data, recipient, amountBaseUnits: amount.toString() });
        const failThisOne = sends.length === 1 && opts.failPriceOnChain === true;
        const isFirstSend = sends.length === 1;
        const isSecondSend = sends.length === 2;
        if (isFirstSend && opts.priceNeverConfirms) {
          // Never mines: the server's legStatus reads not_confirmed.
          return hash;
        }
        if (isFirstSend && opts.mismatchPriceReceipt) {
          // Lands status 1 but a DIFFERENT amount: legStatus reads mismatched.
          opts.chainState.receipts.set(hash, {
            status: 1,
            transfer: { to: recipient.toLowerCase(), value: (amount + 1n).toString(), tokenContract: tx.to, chainId: USDC_CHAIN_ID },
          });
          return hash;
        }
        if (isSecondSend && opts.feeNeverConfirms) {
          // No receipt ever written: receiptStatus reads "pending".
          return hash;
        }
        opts.chainState.receipts.set(hash, {
          status: failThisOne ? 0 : 1,
          transfer: { to: recipient.toLowerCase(), value: amount.toString(), tokenContract: tx.to, chainId: USDC_CHAIN_ID },
        });
        return hash;
      }
      case 'eth_getTransactionReceipt': {
        const hash = String(params[0]);
        const rounds = (receiptReadCounts.get(hash) ?? 0) + 1;
        receiptReadCounts.set(hash, rounds);
        const pendingRounds = opts.pendingRounds ?? 0;
        if (rounds <= pendingRounds) return null;
        const receipt = opts.chainState.receipts.get(hash.toLowerCase());
        if (!receipt) return null;
        return { status: receipt.status === 1 ? '0x1' : '0x0' };
      }
      default:
        throw new Error(`fake wallet: unhandled method ${args.method}`);
    }
  }
  return { provider: { request }, calls, sends };
}
interface Harness {
  readonly server: Server;
  readonly baseUrl: string;
  readonly buyer: SigningIdentity;
  readonly agent: SigningIdentity;
  readonly settlementRepo: MemorySettlementRepository;
  readonly usdcRail: ReturnType<typeof createUsdcPaymentRail>;
  readonly buyerToken: string;
  readonly jobId: string;
}
async function buildHarness(opts: { readonly chainState: ChainState; readonly seedSuffix: number }): Promise<Harness> {
  const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(200 + opts.seedSuffix));
  const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(220 + opts.seedSuffix));
  const login = `usdc-engine-buyer-${opts.seedSuffix}`;
  const accountRepo = new MemoryAccountRepository();
  await accountRepo.register({ did: buyer.did, githubLogin: login });
  const operatorDid = `did:abt:usdc-engine-operator-${opts.seedSuffix}`;
  await accountRepo.register({ did: operatorDid, githubLogin: `usdc-engine-operator-${opts.seedSuffix}` });
  await accountRepo.setOperatorAddressEvm(operatorDid, USDC_OPERATOR_ADDRESS);
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: agent.did,
    operatorDid,
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: `scout-usdc-engine-${opts.seedSuffix}`,
    negotiatesOnOwnersBehalf: true,
  });
  await agentRepo.updateGithubBinding(agent.did, { handle: `scout-usdc-engine-${opts.seedSuffix}`, status: 'verified' });
  const jobRepo = new MemoryJobRepository();
  const settlementRepo = new MemorySettlementRepository();
  const gate = new PrismaSettlementGate(settlementRepo);
  const { github } = createStagingLifecycleGithubFake();
  const usdcRail = withUsdcEnv(() =>
    createUsdcPaymentRail({
      chainClient: serverChainClient(opts.chainState),
      rateSource: async () => '1',
      halfPaidStorage: fakeHalfPaidStorage(),
      spentTransferStorage: fakeSpentTransferStorage(),
    }),
  );
  const sessionAdapter = createSessionAdapter({
    github: fakeGitHubConfig(),
    fetchImpl: fakeGitHubFetch({ login, id: 900000 + opts.seedSuffix }),
  });
  const app = createApp(
    accountRepo, agentRepo, undefined, github, jobRepo, undefined, undefined, undefined,
    undefined, undefined, undefined, sessionAdapter, undefined, gate, anyCommitStagingObserver(),
    undefined, null, usdcRail, settlementRepo,
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const created = await postSigned(baseUrl, '/jobs', {
    buyerDid: buyer.did,
    agentDid: agent.did,
    repository: 'buyer/target-repo',
    brief: 'Fix the login bug',
  }, buyer);
  const jobId = String(((await created.json()) as Record<string, unknown>).id);
  const criteria = [
    { text: 'The login bug is fixed', proposedBy: 'agent' },
    { text: 'Checkout e2e test passes', proposedBy: 'agent' },
  ];
  await postSigned(baseUrl, `/jobs/${jobId}/criteria`, { criteria, priceUsd: '500.00', rail: 'usdc' }, agent);
  for (const idx of [0, 1]) {
    await postSigned(baseUrl, `/jobs/${jobId}/criteria/${idx}/accept`, {}, buyer);
    await postSigned(baseUrl, `/jobs/${jobId}/criteria/${idx}/accept`, {}, agent);
  }
  await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, agent);
  const buyerToken = await mintSessionToken(sessionAdapter);
  return { server, baseUrl, buyer, agent, settlementRepo, usdcRail, buyerToken, jobId };
}
interface EnginePage {
  readonly window: JSDOM['window'];
  close: () => void;
}
// Loads the two real scripts from the app's own static mount (never disk):
// api.js for FAApi.postAuthed, usdc-wallet.js for window.FAUsdcWallet. Both
// eval in one jsdom window carrying localStorage and a baseUrl-resolving fetch.
async function loadEnginePage(baseUrl: string): Promise<EnginePage> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: `${baseUrl}/`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
  });
  Object.defineProperty(dom.window, 'fetch', {
    writable: true,
    value: (input: string, init?: RequestInit) => fetch(new URL(input, baseUrl), init),
  });
  const apiJs = await (await fetch(`${baseUrl}/js/pages/api.js`)).text();
  const walletJs = await (await fetch(`${baseUrl}/js/usdc-wallet.js`)).text();
  dom.window.eval(apiJs);
  dom.window.eval(walletJs);
  if (failures.length > 0) throw new Error(`engine scripts failed to load: ${failures.join('; ')}`);
  return { window: dom.window, close: () => dom.window.close() };
}
type FAUsdcWallet = {
  discover: (opts?: unknown) => Promise<unknown[]>;
  pay: (opts: Record<string, unknown>) => Promise<{ outcome: string; message: string; leg?: string }>;
  check: (opts: Record<string, unknown>) => Promise<{ outcome: string; message: string }>;
  transferCallData: (recipient: string, amountBaseUnits: string) => string;
};
function engineOf(page: EnginePage): FAUsdcWallet {
  return (page.window as unknown as { FAUsdcWallet: FAUsdcWallet }).FAUsdcWallet;
}
// The default pay() call shape almost every test below uses: the
// deposit leg, a 5ms/5-round bounded poll. Overrides merge on top.
function payDeposit(
  page: EnginePage, h: Harness,
  wallet: { id: string; name: string; icon: string; provider: FakeWallet['provider'] } | null,
  overrides: Record<string, unknown> = {},
): Promise<{ outcome: string; message: string; leg?: string }> {
  return engineOf(page).pay({ window: page.window, wallet, jobId: h.jobId, leg: 'deposit', token: h.buyerToken, pollIntervalMs: 5, pollLimit: 5, ...overrides });
}
const opened: Array<{ server: Server; page?: EnginePage }> = [];
afterEach(async () => {
  while (opened.length > 0) {
    const entry = opened.pop();
    if (!entry) continue;
    entry.page?.close();
    await new Promise<void>((resolve) => entry.server.close(() => resolve()));
  }
});
// Shared setup every test below starts from: a fresh chain state, a
// harness on it, and the engine page loaded against that harness's own
// baseUrl. Registered with `opened` so afterEach tears both down.
async function setup(seedSuffix: number): Promise<{ chainState: ChainState; h: Harness; page: EnginePage }> {
  const chainState = newChainState();
  const h = await buildHarness({ chainState, seedSuffix });
  const page = await newDevicePage(h);
  return { chainState, h, page };
}
// Loads a fresh device (second engine page against the same job/server).
async function newDevicePage(h: Harness): Promise<EnginePage> {
  opened.push({ server: h.server });
  const page = await loadEnginePage(h.baseUrl);
  opened[opened.length - 1]!.page = page;
  return page;
}
// A wallet entry, the shape discover() would answer, wrapping a fake
// provider under a test-chosen id.
function walletEntry(id: string, provider: FakeWallet['provider']): { id: string; name: string; icon: string; provider: FakeWallet['provider'] } {
  return { id, name: 'Fake Wallet', icon: '', provider };
}
// Builds a fake wallet and wraps it as a discover()-shaped entry, for
// sites that never inspect wallet.sends/.calls afterward.
function fakeWalletEntry(id: string, opts: FakeWalletOptions): { id: string; name: string; icon: string; provider: FakeWallet['provider'] } {
  return walletEntry(id, buildFakeWallet(opts).provider);
}
// Wraps a raw provider to count eth_getTransactionReceipt calls: both the
// check()-reads-nothing and check()-posts-twice mutations, and the
// post-before-poll mutation, are only caught by counting, not by outcome.
function countingProvider(raw: FakeWallet['provider']): { provider: FakeWallet['provider']; reads: { value: number } } {
  const reads = { value: 0 };
  return {
    reads,
    provider: {
      request: async (args: { method: string; params?: unknown[] }) => {
        if (args.method === 'eth_getTransactionReceipt') reads.value += 1;
        return raw.request(args);
      },
    },
  };
}
// Swaps page.window.fetch to count POSTs whose URL contains `fragment`.
function spyOnPosts(page: EnginePage, fragment: string): { count: { value: number }; restore: () => void } {
  const count = { value: 0 };
  const originalFetch = page.window.fetch;
  Object.defineProperty(page.window, 'fetch', {
    writable: true,
    value: async (input: string, init?: RequestInit) => {
      if (String(input).includes(fragment)) count.value += 1;
      return (originalFetch as typeof fetch)(input, init);
    },
  });
  return { count, restore: () => Object.defineProperty(page.window, 'fetch', { writable: true, value: originalFetch }) };
}
// Installs a fetch override on page.window; `handler` gets the raw input/init
// plus a `callOriginal()` to reach the real request, for tests that need to
// rewrite, drop, or restore one route's answer.
function mockFetch(page: EnginePage, handler: (input: string, init: RequestInit | undefined, callOriginal: () => Promise<Response>) => Promise<Response>): () => void {
  const originalFetch = page.window.fetch;
  Object.defineProperty(page.window, 'fetch', {
    writable: true,
    value: async (input: string, init?: RequestInit) => handler(input, init, () => (originalFetch as typeof fetch)(input, init)),
  });
  return () => Object.defineProperty(page.window, 'fetch', { writable: true, value: originalFetch });
}
// Reads this engine's own localStorage record for a job/leg, or null.
function storedRecord(page: EnginePage, jobId: string, leg: string): string | null {
  return (page.window as unknown as { localStorage: { getItem: (key: string) => string | null } }).localStorage.getItem(`fa_usdc_wallet:${jobId}:${leg}`);
}
// Writes a settlement row directly, simulating another device or rail
// settling this leg mid-flight (the B49 race Make 1 exists to close).
function settleDeposit(h: Harness, hash: string): Promise<void> {
  return h.settlementRepo.record({
    jobId: h.jobId, leg: 'deposit', rail: 'usdc', hash, secondaryHash: `${hash}-fee`,
    operatorAddress: USDC_OPERATOR_ADDRESS, feeAddress: USDC_FEE_ADDRESS, amountUsd: '125.00', observedAt: new Date(),
  });
}
describe('the engine pays a deposit and a balance end to end against the real routes', () => {
  it('deposit: paid, both transfers land, and the settlement row exists', async () => {
    const { chainState, h, page } = await setup(1);
    const result = await payDeposit(page, h, fakeWalletEntry('w1', { chainState }));
    expect(result.outcome).toBe('paid');
    const row = await h.settlementRepo.findByJobAndLeg(h.jobId, 'deposit');
    expect(row).not.toBeNull();
    expect(row?.amountUsd).toBe('125.00');
  });
  it('balance: paid once the job is staged, and the settlement row exists', async () => {
    const { chainState, h, page } = await setup(2);
    const depositResult = await payDeposit(page, h, fakeWalletEntry('w2', { chainState }));
    expect(depositResult.outcome).toBe('paid');
    const confirm = await postSigned(h.baseUrl, `/jobs/${h.jobId}/confirm`, {}, h.buyer);
    expect(confirm.status).toBe(200);
    const stage = await postSigned(h.baseUrl, `/jobs/${h.jobId}/stage`, { stagedCommit: 'commit-usdc-engine' }, h.agent);
    expect(stage.status).toBe(200);
    const balanceResult = await payDeposit(page, h, fakeWalletEntry('w2', { chainState }), { leg: 'remainder' });
    expect(balanceResult.outcome).toBe('paid');
    const row = await h.settlementRepo.findByJobAndLeg(h.jobId, 'remainder');
    expect(row).not.toBeNull();
    expect(row?.amountUsd).toBe('375.00');
  });
});
describe('invariant 2: the call data decodes, with no call to this service, to what the server confirmed', () => {
  it('each transfer decodes to the recipient and amount the start answer named, price before fee', async () => {
    const { chainState, h, page } = await setup(3);
    const wallet = buildFakeWallet({ chainState });
    const result = await payDeposit(page, h, walletEntry('w3', wallet.provider));
    expect(result.outcome).toBe('paid');
    expect(wallet.sends).toHaveLength(2);
    // Decoded through ethers' Interface ALONE (TRANSFER_IFACE), never this
    // engine: the call data itself carries the fact, not a taken-on-faith claim.
    expect(wallet.sends[0]!.recipient.toLowerCase()).toBe(USDC_OPERATOR_ADDRESS.toLowerCase());
    expect(wallet.sends[0]!.amountBaseUnits).toBe('125000000');
    expect(wallet.sends[1]!.recipient.toLowerCase()).toBe(USDC_FEE_ADDRESS.toLowerCase());
    expect(wallet.sends[1]!.amountBaseUnits).toBe('7500000');
  });
  it('an amount above 2^53 base units survives exactly through transferCallData (never a float)', async () => {
    const { page } = await setup(4);
    const huge = '9007199254740993'; // 2^53 + 1
    const data = engineOf(page).transferCallData(USDC_OPERATOR_ADDRESS, huge);
    const [, amount] = TRANSFER_IFACE.decodeFunctionData('transfer', data) as unknown as [string, bigint];
    expect(amount.toString()).toBe(huge);
  });
});
describe('discovery: EIP-6963 announced wallets, window.ethereum only as a fallback', () => {
  it('two announced wallets are both listed by name and id', async () => {
    const { page } = await setup(5);
    const win = page.window as unknown as Eip6963Window;
    win.addEventListener('eip6963:requestProvider', () => {
      announceWallet(win, 'uuid-a', 'Wallet A');
      announceWallet(win, 'uuid-b', 'Wallet B');
    });
    const found = (await engineOf(page).discover({ window: page.window, discoveryWindowMs: 20 })) as Array<{ id: string; name: string }>;
    expect(found.map((w) => w.id).sort()).toEqual(['uuid-a', 'uuid-b']);
    expect(found.map((w) => w.name).sort()).toEqual(['Wallet A', 'Wallet B']);
  });
  it('window.ethereum appears only when nothing announces', async () => {
    const { page } = await setup(6);
    (page.window as unknown as { ethereum: unknown }).ethereum = { marker: 'window.ethereum' };
    const found = (await engineOf(page).discover({ window: page.window, discoveryWindowMs: 20 })) as Array<{ id: string; provider: { marker: string } }>;
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe('window.ethereum');
    expect(found[0]!.provider.marker).toBe('window.ethereum');
  });
  it('window.ethereum is dropped when a wallet DOES announce (not merely appended)', async () => {
    const { page } = await setup(28);
    const win = page.window as unknown as Eip6963Window;
    win.ethereum = { marker: 'window.ethereum' };
    win.addEventListener('eip6963:requestProvider', () => announceWallet(win, 'uuid-c', 'Wallet C'));
    const found = (await engineOf(page).discover({ window: page.window, discoveryWindowMs: 20 })) as Array<{ id: string; name: string }>;
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe('uuid-c');
  });
});
describe('chain switching (EIP-3326/3085)', () => {
  it('add-then-switch: a switch refused for a reason other than 4001 tries an add, once, then switches', async () => {
    const { chainState, h, page } = await setup(7);
    const wallet = buildFakeWallet({ chainState, switchBehavior: 'fail-then-add-succeeds' });
    const result = await payDeposit(page, h, walletEntry('w7', wallet.provider));
    expect(result.outcome).toBe('paid');
    expect(wallet.calls.filter((c) => c === 'wallet_addEthereumChain')).toHaveLength(1);
    expect(wallet.calls.filter((c) => c === 'wallet_switchEthereumChain')).toHaveLength(2);
  });
  // The rail's own chain id is always 421614 (usdcEnvVars); this proves the
  // refusal path by mangling usdc/start's own answer to an unknown chain id,
  // rather than building a second harness on a third chain.
  it('an unknown chain is refused with a sentence and no switch or add call', async () => {
    const { h, page } = await setup(17);
    const wallet = buildFakeWallet({ chainState: newChainState() });
    mockFetch(page, async (input, init, callOriginal) => {
      const response = await callOriginal();
      if (!String(input).includes('/usdc/start')) return response;
      const body = (await response.clone().json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, chainId: 999999 }), { status: response.status, headers: { 'content-type': 'application/json' } });
    });
    const result = await payDeposit(page, h, walletEntry('w-odd', wallet.provider));
    expect(result.outcome).toBe('wallet_error');
    expect(result.message.toLowerCase()).toContain('network');
    expect(wallet.calls).not.toContain('wallet_switchEthereumChain');
    expect(wallet.calls).not.toContain('wallet_addEthereumChain');
    expect(wallet.sends).toHaveLength(0);
  });
});
describe('resume: a reload never sends the price transfer again', () => {
  it('resumes from localStorage after a reload (same device, same window object)', async () => {
    const { chainState, h, page } = await setup(8);
    // First attempt: the fee transfer is refused (buyer closes the
    // wallet at the second approval), leaving the price hash stored.
    const firstWallet = buildFakeWallet({ chainState, refuseFeeTransfer: true });
    const first = await payDeposit(page, h, walletEntry('w8', firstWallet.provider));
    expect(first.outcome).toBe('fee_due');
    expect(firstWallet.sends).toHaveLength(1);
    // Resume, same window (same localStorage): only the fee is sent.
    const secondWallet = buildFakeWallet({ chainState });
    const second = await payDeposit(page, h, walletEntry('w8', secondWallet.provider));
    expect(second.outcome).toBe('paid');
    expect(secondWallet.sends).toHaveLength(1);
    expect(secondWallet.sends[0]!.recipient.toLowerCase()).toBe(USDC_FEE_ADDRESS.toLowerCase());
  });
  it('resumes from localStorage ALONE: proven by a server that never learned about the price transfer at all', async () => {
    // The other localStorage test also passes if readStored() were deleted,
    // since confirm() writes halfPaidRecord too. Isolate it by dropping the
    // FIRST wallet-response POST, so the server never learns the price
    // landed and halfPaidRecord stays absent.
    const { chainState, h, page } = await setup(29);
    const firstWallet = buildFakeWallet({ chainState, refuseFeeTransfer: true });
    let droppedOnce = false;
    const restore = mockFetch(page, async (input, init, callOriginal) => {
      if (!droppedOnce && String(input).includes('/usdc/wallet-response')) {
        droppedOnce = true;
        throw new Error('network drop');
      }
      return callOriginal();
    });
    const first = await payDeposit(page, h, walletEntry('w29', firstWallet.provider));
    expect(first.outcome).toBe('server_refused');
    expect(firstWallet.sends).toHaveLength(1);
    // No half-paid row exists server-side: only localStorage knows.
    restore();
    const secondWallet = buildFakeWallet({ chainState });
    const second = await payDeposit(page, h, walletEntry('w29', secondWallet.provider));
    expect(second.outcome).toBe('paid');
    expect(secondWallet.sends).toHaveLength(1);
    expect(secondWallet.sends[0]!.recipient.toLowerCase()).toBe(USDC_FEE_ADDRESS.toLowerCase());
  });
  it('resumes on a clean device from the server\u2019s halfPaidRecord (no localStorage)', async () => {
    const { chainState, h, page: deviceAPage } = await setup(9);
    const deviceAWallet = buildFakeWallet({ chainState, refuseFeeTransfer: true });
    const first = await payDeposit(deviceAPage, h, walletEntry('wA', deviceAWallet.provider));
    expect(first.outcome).toBe('fee_due');
    deviceAPage.close();
    // A clean device, no localStorage record at all: only halfPaidRecord
    // from the server tells it the price already landed.
    const deviceBPage = await newDevicePage(h);
    const deviceBWallet = buildFakeWallet({ chainState });
    const second = await payDeposit(deviceBPage, h, walletEntry('wB', deviceBWallet.provider));
    expect(second.outcome).toBe('paid');
    expect(deviceBWallet.sends).toHaveLength(1);
    expect(deviceBWallet.sends[0]!.recipient.toLowerCase()).toBe(USDC_FEE_ADDRESS.toLowerCase());
  });
  it('never resends a transfer whose halfPaidRecord hash is only not_confirmed (still pending), not failed', async () => {
    // Device A's fee lands on chain but has not mined when pay() gives up
    // waiting, so the half-paid row records 'not_confirmed', not 'confirmed'.
    // Reusing only 'confirmed' would resend it.
    const { chainState, h, page: deviceAPage } = await setup(18);
    const deviceAWallet = buildFakeWallet({ chainState, feeNeverConfirms: true });
    const first = await payDeposit(deviceAPage, h, walletEntry('wA18', deviceAWallet.provider), { pollLimit: 2 });
    expect(first.outcome).toBe('waiting_network');
    expect(deviceAWallet.sends).toHaveLength(2);
    deviceAPage.close();
    // The fee's receipt lands after the fact, like the waiting-network
    // case above: the transaction was real, only slow.
    markFeeConfirmed(chainState);
    const deviceBPage = await newDevicePage(h);
    const deviceBWallet = buildFakeWallet({ chainState });
    const second = await payDeposit(deviceBPage, h, walletEntry('wB18', deviceBWallet.provider));
    expect(second.outcome).toBe('paid');
    // Both hashes were already known; only their receipts needed re-reading.
    expect(deviceBWallet.sends).toHaveLength(0);
  });
});
describe('every other outcome in Make 3', () => {
  it('cancelled at the first approval: nothing sent, nothing posted', async () => {
    const { h, page } = await setup(10);
    const provider = { request: async (args: { method: string }) => {
      if (args.method === 'eth_requestAccounts') throw { code: 4001, message: 'User rejected' };
      throw new Error(`unexpected call ${args.method}`);
    } };
    const result = await payDeposit(page, h, walletEntry('w10', provider));
    expect(result.outcome).toBe('cancelled');
    expect(await h.settlementRepo.findByJobAndLeg(h.jobId, 'deposit')).toBeNull();
  });
  it('a transfer that fails on the network, while the other is still pending, offers to send that one transfer again', async () => {
    const { chainState, h, page } = await setup(11);
    // The price fails on chain; the fee is sent but never confirms (still
    // pending), so this is not "price still due" (needs the FEE confirmed):
    // it is a failed transfer with nothing else confirmed to report instead.
    const wallet = buildFakeWallet({ chainState, failPriceOnChain: true, feeNeverConfirms: true });
    const first = await payDeposit(page, h, walletEntry('w11', wallet.provider));
    expect(first.outcome).toBe('transfer_failed');
    expect(first.leg).toBe('price');
    // The fee's own receipt lands after the fact (a slow confirmation),
    // leaving only the price transfer to resolve.
    markFeeConfirmed(chainState);
    // The buyer presses "send it again": resend: 'price' sends only the
    // price transfer, never the already-landed fee again.
    const retryWallet = buildFakeWallet({ chainState });
    const retry = await engineOf(page).pay({ window: page.window, wallet: walletEntry('w11', retryWallet.provider), jobId: h.jobId, leg: 'deposit', token: h.buyerToken, resend: 'price', pollIntervalMs: 5, pollLimit: 5 });
    expect(retry.outcome).toBe('paid');
    expect(retryWallet.sends).toHaveLength(1);
  });
  it('fee still due: the price landed and the buyer refused the fee approval', async () => {
    const { chainState, h, page } = await setup(12);
    const result = await payDeposit(page, h, fakeWalletEntry('w12', { chainState, refuseFeeTransfer: true }));
    expect(result.outcome).toBe('fee_due');
    expect(await h.settlementRepo.findByJobAndLeg(h.jobId, 'deposit')).toBeNull();
  });
  it('never reports fee_due when the price itself has not confirmed yet (B49 review round 1, defect 2)', async () => {
    // The price landed on chain but has not mined yet, so the server's
    // legs.price.status answers not_confirmed. fee_due must never be
    // guessed from "the fee was refused" alone.
    const { chainState, h, page } = await setup(19);
    const result = await payDeposit(page, h, fakeWalletEntry('w19', { chainState, priceNeverConfirms: true, refuseFeeTransfer: true }));
    expect(result.outcome).not.toBe('fee_due');
    expect(result.outcome).toBe('waiting_network');
    expect(await h.settlementRepo.findByJobAndLeg(h.jobId, 'deposit')).toBeNull();
  });
  it('waiting on the network: not_confirmed after the bounded wait, check() posts once more without a timer', async () => {
    const { chainState, h, page } = await setup(13);
    const wallet = buildFakeWallet({ chainState, feeNeverConfirms: true });
    const result = await payDeposit(page, h, walletEntry('w13', wallet.provider), { pollIntervalMs: 1, pollLimit: 2 });
    expect(result.outcome).toBe('waiting_network');
    // The fee's receipt lands after pay()'s own bounded wait gave up.
    markFeeConfirmed(chainState);
    // check(): reads each stored hash's receipt exactly once (never a
    // timer, never a re-added poll loop) and posts wallet-response once.
    const counted = countingProvider(wallet.provider);
    const posts = spyOnPosts(page, '/usdc/wallet-response');
    const checkResult = await engineOf(page).check({ window: page.window, wallet: walletEntry('w13', counted.provider), jobId: h.jobId, leg: 'deposit', token: h.buyerToken });
    expect(checkResult.outcome).toBe('paid');
    expect(counted.reads.value).toBe(2);
    expect(posts.count.value).toBe(1);
  });
  it('no wallet found: discover() answers nothing and pay() is never called with one', async () => {
    const { h, page } = await setup(14);
    const result = await payDeposit(page, h, null);
    expect(result.outcome).toBe('no_wallet');
  });
  it('a wallet error (too little gas, for example) is reported in the wallet\u2019s own words', async () => {
    const { h, page } = await setup(15);
    const provider = { request: async (args: { method: string }) => {
      if (args.method === 'eth_requestAccounts') throw new Error('insufficient funds for gas');
      throw new Error(`unexpected call ${args.method}`);
    } };
    const result = await payDeposit(page, h, walletEntry('w15', provider));
    expect(result.outcome).toBe('wallet_error');
    expect(result.message).toBe('insufficient funds for gas');
  });
});
describe('no wallet-response posts before both receipts exist', () => {
  it('the wallet-response body always carries feeTx.signed true once the fee transfer was sent, and posts exactly once, after both receipts confirm', async () => {
    const { chainState, h, page } = await setup(16);
    const wallet = buildFakeWallet({ chainState, pendingRounds: 2 });
    const order: string[] = [];
    const confirmed = new Set<string>();
    const raw = wallet.provider.request;
    const orderedProvider = {
      request: async (args: { method: string; params?: unknown[] }) => {
        const out = await raw(args);
        const hash = String((args.params ?? [])[0]);
        if (args.method === 'eth_getTransactionReceipt' && out && (out as { status: string }).status === '0x1' && !confirmed.has(hash)) {
          confirmed.add(hash); order.push(`confirmed:${hash}`);
        }
        return out;
      },
    };
    const bodies: Array<Record<string, unknown>> = [];
    mockFetch(page, async (input, init, callOriginal) => {
      if (String(input).includes('/usdc/wallet-response') && init?.body) {
        order.push('post');
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      }
      return callOriginal();
    });
    const result = await payDeposit(page, h, walletEntry('w16', orderedProvider));
    expect(result.outcome).toBe('paid');
    // Exactly one POST (pendingRounds forces two pending reads first),
    // and both distinct transfers were confirmed before that POST fired.
    expect(bodies).toHaveLength(1);
    expect((bodies[0] as unknown as { feeTx: { signed: boolean } }).feeTx.signed).toBe(true);
    const postIndex = order.indexOf('post');
    expect(new Set(order.slice(0, postIndex))).toEqual(new Set([...confirmed].map((hh) => `confirmed:${hh}`)));
    expect(confirmed.size).toBe(2);
  });
  it('pay() never posts wallet-response on a bare setTimeout: the poll count matches pollLimit, not real time', async () => {
    const { chainState, h, page } = await setup(20);
    const wallet = buildFakeWallet({ chainState, feeNeverConfirms: true });
    const posts = spyOnPosts(page, '/usdc/wallet-response');
    const result = await payDeposit(page, h, walletEntry('w20', wallet.provider), { pollIntervalMs: 1, pollLimit: 3 });
    expect(result.outcome).toBe('waiting_network');
    expect(posts.count.value).toBe(1);
    // price + fee sent, each receipt read at least once per bounded round.
    expect(wallet.calls.filter((c) => c === 'eth_getTransactionReceipt').length).toBeGreaterThanOrEqual(2);
  });
  it('the bounded poll loop actually retries: it reads each receipt more than once when the first read is pending', async () => {
    // The server confirms independently of this engine's local wait; only
    // the receipt-read COUNT tells a real retry loop apart from a deleted one.
    const { chainState, h, page } = await setup(30);
    const wallet = buildFakeWallet({ chainState, pendingRounds: 1 });
    const result = await payDeposit(page, h, walletEntry('w30', wallet.provider), { pollIntervalMs: 1, pollLimit: 5 });
    expect(result.outcome).toBe('paid');
    // Two items, each read twice minimum: a deleted retry loop reads each once (2 total).
    expect(wallet.calls.filter((c) => c === 'eth_getTransactionReceipt').length).toBeGreaterThan(2);
  });
});
describe('outcomes with no case before B49 review round 1 (defect 3)', () => {
  it('already_paid: the server\'s own already-paid refusal is forwarded and the stored record cleared', async () => {
    const { chainState, h, page } = await setup(21);
    const first = await payDeposit(page, h, fakeWalletEntry('w21a', { chainState }));
    expect(first.outcome).toBe('paid');
    // A second pay() call on the same already-settled leg.
    const secondWallet = buildFakeWallet({ chainState });
    const second = await payDeposit(page, h, walletEntry('w21b', secondWallet.provider));
    expect(second.outcome).toBe('already_paid');
    expect(second.message).toContain('already been paid');
    expect(secondWallet.sends).toHaveLength(0);
  });
  it('already_paid via wallet-response itself: a leg settled by another device between start and this call\'s response is refused there, not at start', async () => {
    // outcomeFromResponse's own already-paid branch: usdc/start answered
    // 200, but the leg settled before this call's OWN wallet-response
    // reached the server. Simulated by settling right after start answers.
    const { chainState, h, page } = await setup(33);
    const wallet = buildFakeWallet({ chainState });
    let raced = false;
    mockFetch(page, async (input, init, callOriginal) => {
      const response = await callOriginal();
      if (!raced && String(input).includes('/usdc/start')) { raced = true; await settleDeposit(h, 'raced-hash'); }
      return response;
    });
    const result = await payDeposit(page, h, walletEntry('w33', wallet.provider));
    expect(result.outcome).toBe('already_paid');
    expect(result.message).toContain('already been paid');
    expect(wallet.sends).toHaveLength(2);
    expect(storedRecord(page, h.jobId, 'deposit')).toBeNull();
  });
  it('already_paid actually clears a NON-empty stored record, not a no-op on an empty key', async () => {
    const { chainState, h, page } = await setup(34);
    const firstWallet = buildFakeWallet({ chainState, refuseFeeTransfer: true });
    expect((await payDeposit(page, h, walletEntry('w34a', firstWallet.provider))).outcome).toBe('fee_due');
    expect(storedRecord(page, h.jobId, 'deposit')).not.toBeNull();
    await settleDeposit(h, 'raced-hash-2');
    const secondWallet = buildFakeWallet({ chainState });
    const second = await payDeposit(page, h, walletEntry('w34b', secondWallet.provider));
    expect(second.outcome).toBe('already_paid');
    expect(secondWallet.sends).toHaveLength(0);
    expect(storedRecord(page, h.jobId, 'deposit')).toBeNull();
  });
  it('price_due: the fee landed and the price failed on the network', async () => {
    const { chainState, h, page } = await setup(22);
    const result = await payDeposit(page, h, fakeWalletEntry('w22', { chainState, failPriceOnChain: true }));
    expect(result.outcome).toBe('price_due');
  });
  it('mismatched: a transfer landed on chain but did not pay what this leg expects', async () => {
    const { chainState, h, page } = await setup(23);
    const result = await payDeposit(page, h, fakeWalletEntry('w23', { chainState, mismatchPriceReceipt: true }));
    expect(result.outcome).toBe('mismatched');
    expect(await h.settlementRepo.findByJobAndLeg(h.jobId, 'deposit')).toBeNull();
  });
  it('refused by the server: usdc/start answers a non-200 with a sentence, no wallet transfer sent', async () => {
    const { h, page } = await setup(24);
    const wallet = buildFakeWallet({ chainState: newChainState() });
    mockFetch(page, async (input, init, callOriginal) => {
      if (!String(input).includes('/usdc/start')) return callOriginal();
      return new Response(JSON.stringify({ error: 'this job has no agreed price to pay against' }), { status: 409, headers: { 'content-type': 'application/json' } });
    });
    const result = await payDeposit(page, h, walletEntry('w24', wallet.provider));
    expect(result.outcome).toBe('server_refused');
    expect(result.message).toBe('this job has no agreed price to pay against');
    expect(wallet.sends).toHaveLength(0);
  });
  it('4001 on switch: cancelled, nothing sent, matching the brief\'s "you closed the wallet before switching networks"', async () => {
    const { chainState, h, page } = await setup(25);
    const wallet = buildFakeWallet({ chainState, switchBehavior: 'refuse-with-4001' });
    const result = await payDeposit(page, h, walletEntry('w25', wallet.provider));
    expect(result.outcome).toBe('cancelled');
    expect(wallet.sends).toHaveLength(0);
    expect(wallet.calls.filter((c) => c === 'wallet_addEthereumChain')).toHaveLength(0);
  });
  it('a stored record is cleared exactly when the payment is confirmed', async () => {
    const { chainState, h, page } = await setup(26);
    const result = await payDeposit(page, h, fakeWalletEntry('w26', { chainState }));
    expect(result.outcome).toBe('paid');
    expect(storedRecord(page, h.jobId, 'deposit')).toBeNull();
  });
  it('the uuid dedupe drops a second announcement with the same uuid', async () => {
    const { page } = await setup(27);
    const win = page.window as unknown as Eip6963Window;
    win.addEventListener('eip6963:requestProvider', () => {
      announceWallet(win, 'uuid-dup', 'Wallet First');
      announceWallet(win, 'uuid-dup', 'Wallet Second');
    });
    const found = (await engineOf(page).discover({ window: page.window, discoveryWindowMs: 20 })) as Array<{ id: string; name: string }>;
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe('Wallet First');
  });
});
