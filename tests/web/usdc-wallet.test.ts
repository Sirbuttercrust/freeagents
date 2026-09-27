// USDC-WEBa (Make 3): the browser wallet engine, driven in jsdom against
// the real app -- exactly the discipline tests/web/deposit.test.ts holds
// to, extended for a wallet protocol. No page loads the engine yet (that
// is USDC-WEBb): this proves it directly, loading /js/pages/api.js and
// /js/usdc-wallet.js from the app's own static mount and driving a fake
// EIP-1193 wallet. The server's fake chain client answers receipts for
// the hashes the fake wallet itself returned, with the transfer decoded
// from the data the wallet was given -- so a confirmed payment proves
// the engine asked for exactly what the server confirms.
import type { Server } from 'node:http';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { Interface } from 'ethers';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { PrismaSettlementGate } from '../../src/adapters/payment/gate.js';
import { createUsdcPaymentRail, type UsdcChainClient } from '../../src/adapters/payment/usdc.js';
import type { UsdcSpentTransferRow, UsdcSpentTransferStorage } from '../../src/adapters/payment/usdc-spent-transfer-storage-types.js';
import type { UsdcHalfPaidRow, UsdcHalfPaidStorage } from '../../src/adapters/payment/usdc-half-paid-storage-types.js';
import { MemoryAccountRepository, MemoryAgentRepository, MemoryJobRepository, MemorySettlementRepository } from '../../src/adapters/storage/memory.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSessionToken } from '../helpers/session-fixtures.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

const USDC_TOKEN = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const USDC_FEE_ADDRESS = '0x00000000000000000000000000000000000000AB';
const USDC_OPERATOR_ADDRESS = '0x00000000000000000000000000000000000000CD';
const USDC_CHAIN_ID = 421614;
const BUYER_FROM_ADDRESS = '0x00000000000000000000000000000000000000EF';
const TRANSFER_IFACE = new Interface(['function transfer(address,uint256)']);

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

// A live, shared receipt store the server's chain client reads, written
// only by the fake wallet's own eth_sendTransaction handler below --
// this is what proves the receipt confirm() reads was actually the
// transfer the engine's call data asked for, never invented by the test.
interface ChainState {
  readonly receipts: Map<string, { status: number; transfer: { to: string; value: string; tokenContract: string; chainId: number } }>;
  hashCounter: number;
}

function newChainState(): ChainState {
  return { receipts: new Map(), hashCounter: 0 };
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

function fakeHalfPaidStorage(): UsdcHalfPaidStorage {
  const rows = new Map<string, UsdcHalfPaidRow>();
  function key(jobId: string, leg: 'deposit' | 'balance'): string {
    return `${jobId}:${leg}`;
  }
  return {
    async record(row) {
      rows.set(key(row.jobId, row.leg), { ...row });
    },
    async read(jobId, leg) {
      return rows.get(key(jobId, leg)) ?? null;
    },
    async clear(jobId, leg) {
      rows.delete(key(jobId, leg));
    },
  };
}

// The rail reads its env at construction, and this suite constructs one
// rail per harness (each with its own fake chain client): every call
// site below wraps createUsdcPaymentRail in this, mirroring every
// sibling test file's own withUsdcEnv pattern.
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
// own data through ethers' Interface alone (never through this service),
// and writes the server's own chain state so confirm() observes exactly
// what this wallet was asked to sign.
interface RecordedSend {
  readonly to: string;
  readonly data: string;
  readonly recipient: string;
  readonly amountBaseUnits: string;
}
interface FakeWalletOptions {
  readonly chainState: ChainState;
  readonly switchBehavior?: 'succeed' | 'fail-then-add-succeeds' | 'always-fail';
  readonly refuseFeeTransfer?: boolean;
  readonly failPriceOnChain?: boolean;
  readonly feeNeverConfirms?: boolean;
  readonly pendingRounds?: number;
}
interface FakeWallet {
  readonly provider: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
  readonly calls: string[];
  readonly sends: RecordedSend[];
  addedChain: boolean;
  switchedChain: string | null;
}

function buildFakeWallet(opts: FakeWalletOptions): FakeWallet {
  const calls: string[] = [];
  const sends: RecordedSend[] = [];
  let addedChain = false;
  let switchedChain: string | null = null;
  let switchAttempt = 0;
  const receiptReadCounts = new Map<string, number>();

  async function request(args: { method: string; params?: unknown[] }): Promise<unknown> {
    calls.push(args.method);
    const params = args.params ?? [];
    switch (args.method) {
      case 'eth_requestAccounts':
        return [BUYER_FROM_ADDRESS];
      case 'wallet_switchEthereumChain': {
        const target = (params[0] as { chainId: string }).chainId;
        if (opts.switchBehavior === 'always-fail') {
          throw { code: -32603, message: 'unrecognized chain id' };
        }
        if (opts.switchBehavior === 'fail-then-add-succeeds') {
          switchAttempt += 1;
          if (switchAttempt === 1) throw { code: -32603, message: 'unrecognized chain id' };
        }
        switchedChain = target;
        return null;
      }
      case 'wallet_addEthereumChain':
        addedChain = true;
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
        const isSecondSend = sends.length === 2;
        if (isSecondSend && opts.feeNeverConfirms) {
          // Deliberately no receipt is ever written for this hash: a
          // real chain that never mines a transaction reads back null
          // forever, which the engine's own receiptStatus reads as
          // "pending", never "failed".
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

  return {
    provider: { request },
    calls,
    sends,
    get addedChain() {
      return addedChain;
    },
    set addedChain(_v: boolean) {
      /* read-only from the outside; kept as a getter/setter pair so the
         interface above can declare it as a plain field. */
    },
    get switchedChain() {
      return switchedChain;
    },
    set switchedChain(_v: string | null) {
      /* see addedChain */
    },
  };
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
    accountRepo,
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
    sessionAdapter,
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
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, agent);

  const buyerToken = await mintSessionToken(sessionAdapter);
  return { server, baseUrl, buyer, agent, settlementRepo, usdcRail, buyerToken, jobId };
}

interface EnginePage {
  readonly window: JSDOM['window'];
  close: () => void;
}

// Loads the two real scripts from the app's own static mount (never read
// from disk directly): api.js for FAApi.postAuthed, usdc-wallet.js for
// window.FAUsdcWallet. Both are evaluated in one jsdom window carrying
// localStorage and a fetch that resolves relative paths against baseUrl.
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
  opened.push({ server: h.server });
  const page = await loadEnginePage(h.baseUrl);
  opened[opened.length - 1]!.page = page;
  return { chainState, h, page };
}

// A wallet entry, the shape discover() would answer, wrapping a fake
// provider under a test-chosen id.
function walletEntry(id: string, provider: FakeWallet['provider']): { id: string; name: string; icon: string; provider: FakeWallet['provider'] } {
  return { id, name: 'Fake Wallet', icon: '', provider };
}

describe('the engine pays a deposit and a balance end to end against the real routes', () => {
  it('deposit: paid, both transfers land, and the settlement row exists', async () => {
    const { chainState, h, page } = await setup(1);
    const wallet = walletEntry('w1', buildFakeWallet({ chainState }).provider);

    const result = await engineOf(page).pay({ window: page.window, wallet, jobId: h.jobId, leg: 'deposit', token: h.buyerToken, pollIntervalMs: 5, pollLimit: 5 });
    expect(result.outcome).toBe('paid');
    const row = await h.settlementRepo.findByJobAndLeg(h.jobId, 'deposit');
    expect(row).not.toBeNull();
    expect(row?.amountUsd).toBe('125.00');
  });

  it('balance: paid once the job is staged, and the settlement row exists', async () => {
    const { chainState, h, page } = await setup(2);

    const depositWallet = buildFakeWallet({ chainState });
    const depositResult = await engineOf(page).pay({ window: page.window, wallet: walletEntry('w2', depositWallet.provider), jobId: h.jobId, leg: 'deposit', token: h.buyerToken, pollIntervalMs: 5, pollLimit: 5 });
    expect(depositResult.outcome).toBe('paid');

    const confirm = await postSigned(h.baseUrl, `/jobs/${h.jobId}/confirm`, {}, h.buyer);
    expect(confirm.status).toBe(200);
    const stage = await postSigned(h.baseUrl, `/jobs/${h.jobId}/stage`, { stagedCommit: 'commit-usdc-engine' }, h.agent);
    expect(stage.status).toBe(200);

    const balanceWallet = buildFakeWallet({ chainState });
    const balanceResult = await engineOf(page).pay({ window: page.window, wallet: walletEntry('w2', balanceWallet.provider), jobId: h.jobId, leg: 'remainder', token: h.buyerToken, pollIntervalMs: 5, pollLimit: 5 });
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

    const result = await engineOf(page).pay({ window: page.window, wallet: walletEntry('w3', wallet.provider), jobId: h.jobId, leg: 'deposit', token: h.buyerToken, pollIntervalMs: 5, pollLimit: 5 });
    expect(result.outcome).toBe('paid');
    expect(wallet.sends).toHaveLength(2);
    // Decoded through ethers' Interface ALONE (TRANSFER_IFACE), never
    // through this engine: proves the call data itself carries the fact,
    // not a claim this test takes on faith.
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
    const win = page.window as unknown as {
      addEventListener: (event: string, handler: () => void) => void;
      dispatchEvent: (event: Event) => void;
      CustomEvent: typeof CustomEvent;
    };

    win.addEventListener('eip6963:requestProvider', () => {
      win.dispatchEvent(new win.CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'uuid-a', name: 'Wallet A' }, provider: {} } }));
      win.dispatchEvent(new win.CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'uuid-b', name: 'Wallet B' }, provider: {} } }));
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
});

describe('chain switching (EIP-3326/3085)', () => {
  it('add-then-switch: a switch refused for a reason other than 4001 tries an add, once, then switches', async () => {
    const { chainState, h, page } = await setup(7);
    const wallet = buildFakeWallet({ chainState, switchBehavior: 'fail-then-add-succeeds' });

    const result = await engineOf(page).pay({ window: page.window, wallet: walletEntry('w7', wallet.provider), jobId: h.jobId, leg: 'deposit', token: h.buyerToken, pollIntervalMs: 5, pollLimit: 5 });
    expect(result.outcome).toBe('paid');
    expect(wallet.calls.filter((c) => c === 'wallet_addEthereumChain')).toHaveLength(1);
    expect(wallet.calls.filter((c) => c === 'wallet_switchEthereumChain')).toHaveLength(2);
  });

  // The rail's own configured chain id is always 421614 (usdcEnvVars);
  // this test proves the refusal path by mangling usdc/start's OWN
  // answer to name a chain id KNOWN_CHAINS does not list, rather than
  // building a second harness on a third chain id.
  it('an unknown chain is refused with a sentence and no switch or add call', async () => {
    const { h, page } = await setup(17);
    const wallet = buildFakeWallet({ chainState: newChainState() });

    const originalFetch = page.window.fetch;
    Object.defineProperty(page.window, 'fetch', {
      writable: true,
      value: async (input: string, init?: RequestInit) => {
        const response = await (originalFetch as typeof fetch)(input, init);
        if (String(input).includes('/usdc/start')) {
          const body = (await response.clone().json()) as Record<string, unknown>;
          return new Response(JSON.stringify({ ...body, chainId: 999999 }), { status: response.status, headers: { 'content-type': 'application/json' } });
        }
        return response;
      },
    });

    const result = await engineOf(page).pay({ window: page.window, wallet: walletEntry('w-odd', wallet.provider), jobId: h.jobId, leg: 'deposit', token: h.buyerToken, pollIntervalMs: 5, pollLimit: 5 });
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
    const first = await engineOf(page).pay({ window: page.window, wallet: walletEntry('w8', firstWallet.provider), jobId: h.jobId, leg: 'deposit', token: h.buyerToken, pollIntervalMs: 5, pollLimit: 5 });
    expect(first.outcome).toBe('fee_due');
    expect(firstWallet.sends).toHaveLength(1);

    // Resume, same window (same localStorage): only the fee is sent.
    const secondWallet = buildFakeWallet({ chainState });
    const second = await engineOf(page).pay({ window: page.window, wallet: walletEntry('w8', secondWallet.provider), jobId: h.jobId, leg: 'deposit', token: h.buyerToken, pollIntervalMs: 5, pollLimit: 5 });
    expect(second.outcome).toBe('paid');
    expect(secondWallet.sends).toHaveLength(1);
    expect(secondWallet.sends[0]!.recipient.toLowerCase()).toBe(USDC_FEE_ADDRESS.toLowerCase());
  });

  it('resumes on a clean device from the server\u2019s halfPaidRecord (no localStorage)', async () => {
    const { chainState, h, page: deviceAPage } = await setup(9);

    const deviceAWallet = buildFakeWallet({ chainState, refuseFeeTransfer: true });
    const first = await engineOf(deviceAPage).pay({ window: deviceAPage.window, wallet: walletEntry('wA', deviceAWallet.provider), jobId: h.jobId, leg: 'deposit', token: h.buyerToken, pollIntervalMs: 5, pollLimit: 5 });
    expect(first.outcome).toBe('fee_due');
    deviceAPage.close();

    // A clean device, no localStorage record at all: only halfPaidRecord
    // from the server tells it the price already landed.
    const deviceBPage = await loadEnginePage(h.baseUrl);
    opened.push({ server: h.server, page: deviceBPage });
    const deviceBWallet = buildFakeWallet({ chainState });
    const second = await engineOf(deviceBPage).pay({ window: deviceBPage.window, wallet: walletEntry('wB', deviceBWallet.provider), jobId: h.jobId, leg: 'deposit', token: h.buyerToken, pollIntervalMs: 5, pollLimit: 5 });
    expect(second.outcome).toBe('paid');
    expect(deviceBWallet.sends).toHaveLength(1);
    expect(deviceBWallet.sends[0]!.recipient.toLowerCase()).toBe(USDC_FEE_ADDRESS.toLowerCase());
  });
});

describe('every other outcome in Make 3', () => {
  it('cancelled at the first approval: nothing sent, nothing posted', async () => {
    const { h, page } = await setup(10);
    const provider = { request: async (args: { method: string }) => {
      if (args.method === 'eth_requestAccounts') throw { code: 4001, message: 'User rejected' };
      throw new Error(`unexpected call ${args.method}`);
    } };
    const result = await engineOf(page).pay({ window: page.window, wallet: walletEntry('w10', provider), jobId: h.jobId, leg: 'deposit', token: h.buyerToken });
    expect(result.outcome).toBe('cancelled');
    expect(await h.settlementRepo.findByJobAndLeg(h.jobId, 'deposit')).toBeNull();
  });

  it('a transfer that fails on the network, while the other is still pending, offers to send that one transfer again', async () => {
    const { chainState, h, page } = await setup(11);
    // The price fails on chain; the fee is sent but never confirms
    // within the bounded wait (still pending), so this is not the
    // "price still due" case (that needs the FEE confirmed) -- it is a
    // failed transfer with nothing else confirmed to report instead.
    const wallet = buildFakeWallet({ chainState, failPriceOnChain: true, feeNeverConfirms: true });

    const first = await engineOf(page).pay({ window: page.window, wallet: walletEntry('w11', wallet.provider), jobId: h.jobId, leg: 'deposit', token: h.buyerToken, pollIntervalMs: 5, pollLimit: 5 });
    expect(first.outcome).toBe('transfer_failed');
    expect(first.leg).toBe('price');

    // The fee transfer's own receipt lands after the fact (a slow
    // confirmation, exactly like the waiting-on-the-network case
    // above), so the retry below only has the price transfer left to
    // resolve.
    chainState.receipts.set('0xsent2', {
      status: 1,
      transfer: { to: USDC_FEE_ADDRESS.toLowerCase(), value: '7500000', tokenContract: USDC_TOKEN, chainId: USDC_CHAIN_ID },
    });

    // The buyer presses "send it again": resend: 'price' never sends
    // the stored (failed) hash again.
    const retryWallet = buildFakeWallet({ chainState });
    const retry = await engineOf(page).pay({ window: page.window, wallet: walletEntry('w11', retryWallet.provider), jobId: h.jobId, leg: 'deposit', token: h.buyerToken, resend: 'price', pollIntervalMs: 5, pollLimit: 5 });
    expect(retry.outcome).toBe('paid');
  });

  it('fee still due: the price landed and the buyer refused the fee approval', async () => {
    const { chainState, h, page } = await setup(12);
    const wallet = buildFakeWallet({ chainState, refuseFeeTransfer: true });
    const result = await engineOf(page).pay({ window: page.window, wallet: walletEntry('w12', wallet.provider), jobId: h.jobId, leg: 'deposit', token: h.buyerToken, pollIntervalMs: 5, pollLimit: 5 });
    expect(result.outcome).toBe('fee_due');
    expect(await h.settlementRepo.findByJobAndLeg(h.jobId, 'deposit')).toBeNull();
  });

  it('waiting on the network: not_confirmed after the bounded wait, check() posts once more without a timer', async () => {
    const { chainState, h, page } = await setup(13);
    const wallet = buildFakeWallet({ chainState, feeNeverConfirms: true });

    const result = await engineOf(page).pay({ window: page.window, wallet: walletEntry('w13', wallet.provider), jobId: h.jobId, leg: 'deposit', token: h.buyerToken, pollIntervalMs: 1, pollLimit: 2 });
    expect(result.outcome).toBe('waiting_network');

    // The fee's receipt lands on chain after pay()'s own bounded wait
    // gave up: written directly into the shared chain state, exactly
    // what a slow-confirming transaction looks like from outside.
    chainState.receipts.set('0xsent2', {
      status: 1,
      transfer: { to: USDC_FEE_ADDRESS.toLowerCase(), value: '7500000', tokenContract: USDC_TOKEN, chainId: USDC_CHAIN_ID },
    });

    // check(): reads the receipts once (never on a timer) and posts
    // wallet-response once.
    const checkResult = await engineOf(page).check({ window: page.window, wallet: walletEntry('w13', wallet.provider), jobId: h.jobId, leg: 'deposit', token: h.buyerToken });
    expect(checkResult.outcome).toBe('paid');
  });

  it('no wallet found: discover() answers nothing and pay() is never called with one', async () => {
    const { h, page } = await setup(14);
    const result = await engineOf(page).pay({ window: page.window, wallet: null, jobId: h.jobId, leg: 'deposit', token: h.buyerToken });
    expect(result.outcome).toBe('no_wallet');
  });

  it('a wallet error (too little gas, for example) is reported in the wallet\u2019s own words', async () => {
    const { h, page } = await setup(15);
    const provider = { request: async (args: { method: string }) => {
      if (args.method === 'eth_requestAccounts') throw new Error('insufficient funds for gas');
      throw new Error(`unexpected call ${args.method}`);
    } };
    const result = await engineOf(page).pay({ window: page.window, wallet: walletEntry('w15', provider), jobId: h.jobId, leg: 'deposit', token: h.buyerToken });
    expect(result.outcome).toBe('wallet_error');
    expect(result.message).toBe('insufficient funds for gas');
  });
});

describe('no wallet-response posts before both receipts exist', () => {
  it('the wallet-response body always carries feeTx.signed true once the fee transfer was sent', async () => {
    const { chainState, h, page } = await setup(16);
    const wallet = buildFakeWallet({ chainState });

    let walletResponseBody: Record<string, unknown> | null = null;
    const originalFetch = page.window.fetch;
    Object.defineProperty(page.window, 'fetch', {
      writable: true,
      value: async (input: string, init?: RequestInit) => {
        if (String(input).includes('/usdc/wallet-response') && init?.body) {
          walletResponseBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        }
        return (originalFetch as typeof fetch)(input, init);
      },
    });

    const result = await engineOf(page).pay({ window: page.window, wallet: walletEntry('w16', wallet.provider), jobId: h.jobId, leg: 'deposit', token: h.buyerToken, pollIntervalMs: 5, pollLimit: 5 });
    expect(result.outcome).toBe('paid');
    expect(walletResponseBody).not.toBeNull();
    expect((walletResponseBody as unknown as { feeTx: { signed: boolean } }).feeTx.signed).toBe(true);
    // Exactly one wallet-response POST for this one pay() call.
    expect(wallet.calls.filter((c) => c === 'eth_getTransactionReceipt').length).toBeGreaterThanOrEqual(2);
  });
});
