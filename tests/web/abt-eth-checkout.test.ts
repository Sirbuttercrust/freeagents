// A hirer pays in ABT on Ethereum from /deposit and /staged, driven end to end against the
// real app with the real ABT-on-Ethereum rail injected at createApp's own positions (the
// rig tests/web/abt-eth-wallet.test.ts holds to): a fake chain the server reads receipts
// and block times from, a fake price feed, and a fake EIP-1193 wallet that announces itself
// in the page's own window and decodes each transfer it is asked to sign with ethers alone.
// The pages come from the app's static mount into jsdom; the layout case drives real Chrome.
// Times are read in UTC so every clock time on the page is a literal here.
import type { Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Interface } from 'ethers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import type { Session } from '../../src/adapters/identity/session.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import { createAbtEthPaymentRail } from '../../src/adapters/payment/abt-eth.js';
import { createMemoryAbtEthQuoteLockStorage } from '../../src/adapters/payment/abt-eth-quote-lock-memory.js';
import type { AbtEthQuoteLock, AbtEthQuoteLockStorage } from '../../src/adapters/payment/abt-eth-quote-lock.js';
import { createMemoryAbtEthShortPaymentStorage } from '../../src/adapters/payment/abt-eth-short-payment-memory.js';
import type { Erc20ObservedTransfer } from '../../src/adapters/payment/erc20.js';
import { PrismaSettlementGate } from '../../src/adapters/payment/gate.js';
import type { RateReading } from '../../src/adapters/payment/types.js';
import type { UsdcSpentTransferRow } from '../../src/adapters/payment/usdc-spent-transfer-storage-types.js';
import {
  MemoryAccountRepository, MemoryAgentRepository, MemoryAttestationRepository, MemoryCredentialRepository,
  MemoryJobRepository, MemorySettlementRepository,
} from '../../src/adapters/storage/memory.js';
import { buildAttestation } from '../../src/domain/attestation.js';
import { createJob, type Job } from '../../src/domain/job.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';
import { PAYOUT_NOTICE_SENTENCE, startPayoutWorld, visibleText, type PayoutAccount, type PayoutWorld } from '../helpers/payout-accounts.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession } from '../helpers/session-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import { fakeHalfPaidStorage } from '../helpers/usdc-half-paid-fixtures.js';
import { announceWallets, renderPage, shown, text, type PageHarness, type PageWallet, type RenderedPage } from '../helpers/usdc-page-fixtures.js';

// Clock times on the page are read in UTC for this file only, and put back after.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'UTC';
afterAll(() => { process.env.TZ = ORIGINAL_TZ; });

const NOW = new Date('2026-10-06T12:00:00.000Z');
const INSIDE_HOLD = '2026-10-06T12:10:00.000Z';
const AFTER_HOLD = '2026-10-06T12:20:00.000Z';
const FEED_TIME = new Date('2026-10-06T11:59:00.000Z');
const RECENT = new Date('2026-10-06T11:00:00.000Z');
const ABT_TOKEN = '0xb98d4c97425d9908e66e53a6fdf673acca0be986';
const ABT_FEE_ADDRESS = '0x2222222222222222222222222222222222222222';
const OWNER_ETH = '0x1111111111111111111111111111111111111111';
const OWNER_USDC = '0x00000000000000000000000000000000000000cd';
const TRANSFER_IFACE = new Interface(['function transfer(address,uint256)']);
const BUYER_DID = 'did:abt:abt-eth-checkout-buyer';
const BUYER_LOGIN = 'abt-eth-checkout-buyer';
// Every rail's owner: ABT on ArcBlock, USDC on Arbitrum and ABT on Ethereum all set.
const AGENT_ALL = 'did:abt:zAbtEthCheckoutAll';
// ABT on Ethereum and USDC on Arbitrum only.
const AGENT_ETH = 'did:abt:zAbtEthCheckoutEth';

const SHORT_SENTENCE =
  'Your payment arrived after the price hold, and ABT is now worth less than the agreed price. The owner will either accept it as paid or send it back to you, and the hire waits until they choose.';
const NOT_CONFIGURED_SENTENCE = 'Paying in ABT on Ethereum is not available on this site right now. Nothing was charged.';
const RATE_LINES = ['1 ABT = $0.25, held until 12:15 PM.', 'Price data by CoinGecko, updated 11:59 AM.'];
const DEPOSIT_PRICE_SENDS = [
  { to: ABT_TOKEN, recipient: OWNER_ETH, amountBaseUnits: '500000000000000000000' },
  { to: ABT_TOKEN, recipient: ABT_FEE_ADDRESS, amountBaseUnits: '15000000000000000000' },
];

interface Receipt { status: number; transfer: Erc20ObservedTransfer }
// held: while true, a sent transfer's receipt waits in `pending` and the server's chain
// can't see it, so the server answers "not confirmed" while the wallet reports it landed.
interface Chain {
  readonly receipts: Map<string, Receipt>;
  readonly pending: Map<string, Receipt>;
  readonly recorded: Map<string, Date>;
  count: number;
  recordedAt: string;
  held: boolean;
}
function releaseHeld(chain: Chain): void {
  for (const [hash, receipt] of chain.pending) chain.receipts.set(hash, receipt);
  chain.pending.clear();
  chain.held = false;
}
interface Harness {
  readonly baseUrl: string;
  readonly session: Session;
  readonly chain: Chain;
  readonly feed: { reading: RateReading | null };
  readonly locks: AbtEthQuoteLock[];
  readonly jobRepo: MemoryJobRepository;
  readonly settlementRepo: MemorySettlementRepository;
  addJob(overrides: Partial<Job> & { id: string }): Promise<void>;
  close(): Promise<void>;
}

function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) { original[key] = process.env[key]; process.env[key] = vars[key]; }
  try { return fn(); } finally {
    for (const key of Object.keys(original)) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
  }
}

// The app, with the ABT-on-Ethereum rail or (abtEth false) without one, as a deployment
// that never set it up. No USDC or ArcBlock rail: no case here pays on either.
async function buildHarness(abtEth: boolean): Promise<Harness> {
  const chain: Chain = { receipts: new Map(), pending: new Map(), recorded: new Map(), count: 0, recordedAt: INSIDE_HOLD, held: false };
  const feed: { reading: RateReading | null } = { reading: { usdPerToken: '0.25', updatedAt: FEED_TIME } as RateReading };
  const accounts = new MemoryAccountRepository();
  await accounts.register({ did: BUYER_DID, githubLogin: BUYER_LOGIN });
  const agents = new MemoryAgentRepository();
  for (const agentDid of [AGENT_ALL, AGENT_ETH]) {
    const operatorDid = `${agentDid}-operator`;
    await accounts.register({ did: operatorDid, githubLogin: `${agentDid.slice(8)}-operator` });
    if (agentDid === AGENT_ALL) await accounts.setOperatorAddressAbt(operatorDid, 'zAbtEthCheckoutArcBlockAddress');
    await accounts.setOperatorAddressEvm(operatorDid, OWNER_USDC);
    await accounts.setOperatorAddressAbtEth(operatorDid, OWNER_ETH);
    await agents.create({ did: agentDid, operatorDid, delegation: { fixture: true } as never, name: agentDid.slice(8), skills: ['triage'], githubLogin: `${agentDid.slice(8)}-gh` });
    await agents.updateGithubBinding(agentDid, { handle: `${agentDid.slice(8)}-gh`, status: 'verified' });
  }
  const spent = new Map<string, UsdcSpentTransferRow>();
  const rail = abtEth ? withEnv(
    { FREEAGENTS_ABT_ETH_RPC_URL: 'https://rpc.example.test', FREEAGENTS_ABT_ETH_TOKEN_CONTRACT: ABT_TOKEN, FREEAGENTS_ABT_ETH_CHAIN_ID: '1', FREEAGENTS_ABT_ETH_FEE_ADDRESS: ABT_FEE_ADDRESS },
    () => createAbtEthPaymentRail({
      chainClient: {
        decimals: async () => 18,
        getTransactionReceipt: async (hash) => chain.receipts.get(hash.toLowerCase()) ?? null,
        recordedAt: async (hash) => chain.recorded.get(hash.toLowerCase()) ?? null,
      },
      rateSource: async () => feed.reading,
      spentTransferStorage: { record: async (row) => void spent.set(row.hash, { ...row }), findByHash: async (hash) => spent.get(hash) ?? null },
      halfPaidStorage: fakeHalfPaidStorage(),
    }),
  ) : null;
  const inner = createMemoryAbtEthQuoteLockStorage();
  const locks: AbtEthQuoteLock[] = [];
  const lockStorage: AbtEthQuoteLockStorage = { create: async (lock) => { const s = await inner.create(lock); locks.push(s); return s; }, read: (id) => inner.read(id) };
  const jobRepo = new MemoryJobRepository();
  const settlementRepo = new MemorySettlementRepository();
  const attestationRepo = new MemoryAttestationRepository();
  const credentialRepo = new MemoryCredentialRepository();
  const credentials = createCredentialsAdapter(undefined, credentialRepo);
  const sessionAdapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: BUYER_LOGIN, id: 940001 }) });
  const app = createApp(
    accounts, agents, undefined, createStagingLifecycleGithubFake().github, jobRepo, credentials, undefined, credentialRepo,
    { upstream: 10_000, write: 10_000, read: 10_000, verify: 10_000 }, undefined, undefined, sessionAdapter, undefined,
    new PrismaSettlementGate(settlementRepo), anyCommitStagingObserver(), attestationRepo, null, null, settlementRepo,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    rail, lockStorage, createMemoryAbtEthShortPaymentStorage(),
  );
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a port');
  async function addJob(overrides: Partial<Job> & { id: string }): Promise<void> {
    const base = createJob({ id: overrides.id, buyerDid: BUYER_DID, agentDid: AGENT_ETH, repository: 'buyer/abt-eth-checkout', brief: 'Fix the login bug' }, new Date('2026-09-01T00:00:00Z'));
    const job: Job = {
      ...base, status: 'proposed', criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
      priceUsd: '500.00', rail: null, depositPercent: 25, redoAllowance: 1, priceAcceptedByBuyer: true, priceAcceptedByAgent: true, ...overrides,
    };
    await jobRepo.create(job);
    if (job.status !== 'staged') return;
    const observation = {
      diffHash: `sha256:${job.id}`, filesChanged: 1, linesAdded: 3, linesRemoved: 1, changedPaths: ['src/login.ts'],
      lineShareByCategory: { source: 100, test: 0, lockfile: 0, generated: 0, vendored: 0 }, testsDeleted: [], testsSkipAdded: [], commitSigners: [{ matchesAgentDid: true }],
    };
    const attestation = buildAttestation(job, observation, new Date());
    await attestationRepo.save({ jobId: job.id, attestation, signed: await credentials.signAttestation(attestation) });
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`, session: await mintSession(sessionAdapter), chain, feed, locks, jobRepo, settlementRepo, addJob,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface Send { readonly hash: string; readonly to: string; readonly recipient: string; readonly amountBaseUnits: string }
interface Wallet extends PageWallet { readonly sends: Send[]; readonly switches: unknown[] }
// onRequest runs as each request arrives, before the wallet answers it.
function buildWallet(chain: Chain, onRequest: (method: string) => void = () => {}): Wallet {
  const calls: string[] = [], sends: Send[] = [], switches: unknown[] = [];
  async function request(args: { method: string; params?: unknown[] }): Promise<unknown> {
    onRequest(args.method);
    calls.push(args.method);
    const params = args.params ?? [];
    if (args.method === 'eth_requestAccounts') return ['0x00000000000000000000000000000000000000ef'];
    if (args.method === 'wallet_switchEthereumChain') { switches.push(params[0]); return null; }
    if (args.method === 'eth_sendTransaction') {
      const tx = params[0] as { to: string; data: string };
      const [recipient, amount] = TRANSFER_IFACE.decodeFunctionData('transfer', tx.data) as unknown as [string, bigint];
      chain.count += 1;
      const send = { hash: `0x${chain.count.toString(16).padStart(64, '0')}`, to: tx.to.toLowerCase(), recipient: recipient.toLowerCase(), amountBaseUnits: amount.toString() };
      sends.push(send);
      chain.recorded.set(send.hash, new Date(chain.recordedAt));
      (chain.held ? chain.pending : chain.receipts).set(send.hash, { status: 1, transfer: { to: send.recipient, value: send.amountBaseUnits, tokenContract: send.to, chainId: 1 } });
      return send.hash;
    }
    // The wallet sees every transfer it sent as landed, held or not.
    if (args.method === 'eth_getTransactionReceipt') return sends.some((s) => s.hash === String(params[0])) ? { status: '0x1' } : null;
    throw new Error(`fake wallet: unhandled method ${args.method}`);
  }
  return { provider: { request }, calls, sends, switches, release() {} };
}

// Polls by count, never by the clock: Date is frozen in the jsdom cases.
async function until(condition: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) { if (condition()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error(`until: ${message}`);
}
interface Seen { readonly path: string; readonly body: unknown; readonly answer: unknown }
function watch(page: RenderedPage): Seen[] {
  const seen: Seen[] = [];
  const inner = page.window.fetch.bind(page.window);
  Object.defineProperty(page.window, 'fetch', {
    writable: true,
    value: async (input: string, init?: RequestInit) => {
      const response = await inner(input, init);
      if (init?.method === 'POST') seen.push({ path: String(input), body: init.body ? JSON.parse(String(init.body)) : null, answer: await response.clone().json() });
      return response;
    },
  });
  return seen;
}
const asHarness = (h: { baseUrl: string; session: Session }): PageHarness => h as unknown as PageHarness;
const openDeposit = (h: Harness, id: string): Promise<RenderedPage> =>
  renderPage(asHarness(h), `/deposit?job=${id}`, (d) => !d.getElementById('deposit-body')!.hidden && (d.getElementById('pay-btn')!.textContent ?? '') !== '');
const openStaged = (h: Harness, id: string): Promise<RenderedPage> =>
  renderPage(asHarness(h), `/staged?job=${id}`, (d) => (d.getElementById('pay-btn')!.textContent ?? '').startsWith('Pay the balance'));
function choose(page: RenderedPage, id: string): void {
  const radio = page.document.getElementById(`rail-${id}`) as HTMLInputElement;
  radio.checked = true;
  radio.dispatchEvent(new page.window.Event('change', { bubbles: true }));
}
const press = (page: RenderedPage, id: string): void => (page.document.getElementById(id) as HTMLButtonElement).click();
const status = (page: RenderedPage): string => text(page.document, 'usdc-status');
const presses = (page: RenderedPage): string[] => ['usdc-retry', 'usdc-resend', 'usdc-check', 'usdc-reload'].filter((id) => shown(page.document, id));
const count = (page: RenderedPage, request: string): number => page.requests.filter((r) => r === request).length;
const rateLines = (page: RenderedPage): string[] => Array.from(page.document.querySelectorAll('#abt-rate p')).map((p) => (p.textContent ?? '').trim());
// Each option as a person reads it: shown, checked, and its three spans' text.
function options(page: RenderedPage): unknown[] {
  return Array.from(page.document.querySelectorAll('#rails .railopt')).map((opt) => ({
    id: opt.id, shown: shown(page.document, opt.id), checked: (opt.querySelector('input') as HTMLInputElement).checked,
    name: opt.querySelector('.rname')?.textContent, amount: opt.querySelector('.ramt')?.textContent, why: opt.querySelector('.rwhy')?.textContent,
  }));
}
// The page's one gas line as a person reads it: the whole sentence while shown, else null.
const gasLine = (page: RenderedPage): string | null => (shown(page.document, 'gas-note') ? text(page.document, 'gas-note') : null);

let h: Harness;
let bare: Harness;
let seq = 0;
beforeAll(async () => { h = await buildHarness(true); bare = await buildHarness(false); });
afterAll(async () => { await h.close(); await bare.close(); });
async function job(on: Harness, overrides: Partial<Job> = {}): Promise<string> {
  seq += 1;
  const id = `abt-eth-checkout-${seq}`;
  await on.addJob({ id, ...overrides });
  return id;
}

describe('/deposit offers ABT on Ethereum, named with its network', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); h.feed.reading = { usdPerToken: '0.25', updatedAt: FEED_TIME }; h.chain.recordedAt = INSIDE_HOLD; releaseHeld(h.chain); });

  it('(a) all three set up: the three options in order, each whole, and ABT on ArcBlock chosen', async () => {
    const page = await openDeposit(h, await job(h, { agentDid: AGENT_ALL }));
    try {
      expect(options(page)).toEqual([
        { id: 'railopt-abt', shown: true, checked: true, name: 'ABT on ArcBlock', amount: '$128.75 today', why: '3% fee, one approval' },
        { id: 'railopt-abt-eth', shown: true, checked: false, name: 'ABT on Ethereum', amount: '$128.75 today', why: '3% fee, two approvals' },
        { id: 'railopt-usdc', shown: true, checked: false, name: 'USDC on Arbitrum', amount: '$132.50 today', why: '6% fee, two approvals' },
      ]);
      expect(gasLine(page)).toBeNull();
    } finally { await page.close(); }
  }, 30_000);

  it('(b) ABT on Ethereum and USDC set up: ArcBlock hidden and unchecked, ABT on Ethereum chosen with its gas line; USDC swaps the lines', async () => {
    const page = await openDeposit(h, await job(h));
    try {
      expect(options(page)).toEqual([
        { id: 'railopt-abt', shown: false, checked: false, name: 'ABT on ArcBlock', amount: '$128.75 today', why: '3% fee, one approval' },
        { id: 'railopt-abt-eth', shown: true, checked: true, name: 'ABT on Ethereum', amount: '$128.75 today', why: '3% fee, two approvals' },
        { id: 'railopt-usdc', shown: true, checked: false, name: 'USDC on Arbitrum', amount: '$132.50 today', why: '6% fee, two approvals' },
      ]);
      expect([text(page.document, 'total-amount'), text(page.document, 'fee-label'), text(page.document, 'pay-btn')]).toEqual(['$128.75', 'FreeAgents fee, 3 percent', 'Pay $128.75 with your wallet']);
      expect(gasLine(page)).toBe('You need a little ETH on Ethereum for gas.');
      choose(page, 'usdc');
      expect(gasLine(page)).toBe('You need a little ETH on Arbitrum for gas.');
      choose(page, 'abt-eth');
      expect(gasLine(page)).toBe('You need a little ETH on Ethereum for gas.');
    } finally { await page.close(); }
  }, 30_000);

  it('(c) and (d) the deposit paid end to end: rate shown before the wallet is asked, Ethereum, two transfers, the lock reported, the row, one confirm', async () => {
    const id = await job(h);
    const page = await openDeposit(h, id);
    try {
      const atFirstAsk: unknown[] = [];
      const wallet = buildWallet(h.chain, (method) => {
        if (method !== 'eth_requestAccounts' && atFirstAsk.length === 0) {
          atFirstAsk.push({ method, rateShown: shown(page.document, 'abt-rate'), lines: rateLines(page), addressShown: shown(page.document, 'scan-abt-address') });
        }
      });
      announceWallets(page.window, [{ uuid: 'w-eth', name: 'Eth Wallet', wallet }]);
      const seen = watch(page);
      press(page, 'pay-btn');
      expect([text(page.document, 'scanh'), text(page.document, 'scan-approvals-line')]).toEqual(['Approve in your wallet', 'Two approvals, $125.00 then $3.75. Both are part of this one payment.']);
      // page.requests logs the confirm as it is sent, and watch() only after its answer is read, so wait for both.
      await until(() => count(page, `POST /jobs/${id}/confirm`) === 1 && seen.some((s) => s.path === `/jobs/${id}/confirm`), 'confirm was never called and answered');
      expect(atFirstAsk).toEqual([{ method: 'wallet_switchEthereumChain', rateShown: true, lines: RATE_LINES, addressShown: false }]);
      expect(wallet.switches).toEqual([{ chainId: '0x1' }]);
      expect(wallet.sends.map(({ to, recipient, amountBaseUnits }) => ({ to, recipient, amountBaseUnits }))).toEqual(DEPOSIT_PRICE_SENDS);
      expect(seen.map((s) => s.path)).toEqual([`/jobs/${id}/payments/deposit/abt_eth/start`, `/jobs/${id}/payments/deposit/abt_eth/wallet-response`, `/jobs/${id}/confirm`]);
      expect((seen[0]!.answer as { quoteLock: unknown }).quoteLock).toEqual({ id: h.locks.at(-1)!.id, usdPerAbt: '0.25', rateUpdatedAt: '2026-10-06T11:59:00.000Z', expiresAt: '2026-10-06T12:15:00.000Z' });
      expect(seen[1]!.body).toEqual({ priceTxHash: wallet.sends[0]!.hash, feeTx: { signed: true, hash: wallet.sends[1]!.hash }, quoteLockId: h.locks.at(-1)!.id });
      expect(await h.settlementRepo.findByJobAndLeg(id, 'deposit')).toEqual({
        jobId: id, leg: 'deposit', rail: 'abt_eth', hash: wallet.sends[0]!.hash, secondaryHash: wallet.sends[1]!.hash,
        operatorAddress: OWNER_ETH, feeAddress: ABT_FEE_ADDRESS, amountUsd: '125.00', observedAt: NOW,
      });
      expect(status(page)).toBe('This payment is confirmed.');
      await new Promise((r) => setTimeout(r, 200));
      expect(count(page, `POST /jobs/${id}/confirm`)).toBe(1);
      expect(count(page, `POST /jobs/${id}/payments/deposit/abt/start`)).toBe(0);
    } finally { await page.close(); }
  }, 30_000);

  it('(c2) the network slow to confirm: Check again reports the same transfers and lock to .../abt_eth/wallet-response, then confirms once', async () => {
    const id = await job(h);
    const page = await openDeposit(h, id);
    try {
      h.chain.held = true;
      const wallet = buildWallet(h.chain);
      announceWallets(page.window, [{ uuid: 'w-slow', name: 'Eth Wallet', wallet }]);
      const seen = watch(page);
      press(page, 'pay-btn');
      await until(() => status(page) !== '', 'no sentence after the first press');
      expect({ status: status(page), presses: presses(page) }).toEqual({ status: 'The network has not confirmed this payment yet. Check again shortly.', presses: ['usdc-check'] });
      releaseHeld(h.chain);
      press(page, 'usdc-check');
      await until(() => status(page) !== '', 'no sentence after Check again');
      expect({ status: status(page), presses: presses(page) }).toEqual({ status: 'This payment is confirmed.', presses: [] });
      await until(() => count(page, `POST /jobs/${id}/confirm`) === 1 && seen.some((s) => s.path === `/jobs/${id}/confirm`), 'confirm was never called and answered');
      expect(seen.map((s) => s.path)).toEqual([
        `/jobs/${id}/payments/deposit/abt_eth/start`, `/jobs/${id}/payments/deposit/abt_eth/wallet-response`,
        `/jobs/${id}/payments/deposit/abt_eth/wallet-response`, `/jobs/${id}/confirm`,
      ]);
      const report = { priceTxHash: wallet.sends[0]!.hash, feeTx: { signed: true, hash: wallet.sends[1]!.hash }, quoteLockId: h.locks.at(-1)!.id };
      expect([seen[1]!.body, seen[2]!.body]).toEqual([report, report]);
      expect(wallet.sends).toHaveLength(2);
      expect((await h.settlementRepo.findByJobAndLeg(id, 'deposit'))?.rail).toBe('abt_eth');
    } finally { await page.close(); }
  }, 30_000);

  it('(c3) a rate drawn by an earlier attempt is gone when the next start is refused', async () => {
    const id = await job(h);
    const page = await openDeposit(h, id);
    try {
      let switches = 0;
      const wallet = buildWallet(h.chain, (method) => {
        if (method === 'wallet_switchEthereumChain' && (switches += 1) === 1) throw Object.assign(new Error('closed'), { code: 4001 });
      });
      announceWallets(page.window, [{ uuid: 'w-stale', name: 'Eth Wallet', wallet }]);
      press(page, 'pay-btn');
      await until(() => status(page) !== '', 'no sentence after the first press');
      const sheet = (): unknown => ({ status: status(page), presses: presses(page), rateShown: shown(page.document, 'abt-rate'), lines: rateLines(page) });
      expect(sheet()).toEqual({ status: 'You closed the wallet before switching networks.', presses: ['usdc-retry'], rateShown: true, lines: RATE_LINES });
      h.feed.reading = null;
      press(page, 'usdc-retry');
      await until(() => status(page) !== '' && status(page) !== 'You closed the wallet before switching networks.', 'no sentence after Try again');
      expect(sheet()).toEqual({ status: 'The ABT price is not available right now. Nothing was charged. Try again in a minute.', presses: ['usdc-retry'], rateShown: false, lines: ['', 'Price data by CoinGecko'] });
      expect(wallet.sends).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);

  it('(c4) two wallets: Pay again opens the wallet pick with no rate from the earlier attempt on show', async () => {
    const id = await job(h);
    const page = await openDeposit(h, id);
    try {
      let switches = 0;
      const first = buildWallet(h.chain, (method) => {
        if (method === 'wallet_switchEthereumChain' && (switches += 1) === 1) throw Object.assign(new Error('closed'), { code: 4001 });
      });
      announceWallets(page.window, [{ uuid: 'w-a', name: 'Wallet A', wallet: first }, { uuid: 'w-b', name: 'Wallet B', wallet: buildWallet(h.chain) }]);
      const picks = (): string[] => (shown(page.document, 'usdc-pick') ? Array.from(page.document.querySelectorAll('#usdc-wallets button')).map((b) => (b.textContent ?? '').trim()) : []);
      const sheet = (): unknown => ({ status: status(page), picks: picks(), rateShown: shown(page.document, 'abt-rate'), lines: rateLines(page) });
      press(page, 'pay-btn');
      await until(() => picks().length > 0, 'the wallet pick never opened');
      (page.document.querySelector('#usdc-wallets button') as HTMLButtonElement).click();
      await until(() => status(page) !== '', 'no sentence after picking Wallet A');
      expect(sheet()).toEqual({ status: 'You closed the wallet before switching networks.', picks: [], rateShown: true, lines: RATE_LINES });
      (page.document.querySelector('#scan [data-closes]') as HTMLButtonElement).click();
      press(page, 'pay-btn');
      await until(() => picks().length > 0, 'the wallet pick never opened again');
      expect(sheet()).toEqual({ status: '', picks: ['Wallet A', 'Wallet B'], rateShown: false, lines: ['', 'Price data by CoinGecko'] });
      expect(first.sends).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);

  it('(e) a late transfer worth less now: the short sentence whole, no press, no confirm, no row, Pay stays disabled', async () => {
    const id = await job(h);
    const page = await openDeposit(h, id);
    try {
      h.chain.recordedAt = AFTER_HOLD;
      const wallet = buildWallet(h.chain, (method) => {
        if (method === 'eth_sendTransaction') h.feed.reading = { usdPerToken: '0.2', updatedAt: new Date('2026-10-06T11:59:30.000Z') };
      });
      announceWallets(page.window, [{ uuid: 'w-short', name: 'Late Wallet', wallet }]);
      press(page, 'pay-btn');
      // Stops on a confirm too, so a short read as paid fails on the confirm count itself.
      await until(() => status(page) !== '' || count(page, `POST /jobs/${id}/confirm`) > 0, 'no sentence and no confirm');
      await new Promise((r) => setTimeout(r, 200));
      expect(count(page, `POST /jobs/${id}/confirm`)).toBe(0);
      expect(status(page)).toBe(SHORT_SENTENCE);
      expect(presses(page)).toEqual([]);
      expect(shown(page.document, 'approved-btn')).toBe(false);
      expect(wallet.sends).toHaveLength(2);
      expect(await h.settlementRepo.findByJobAndLeg(id, 'deposit')).toBeNull();
      expect((page.document.getElementById('pay-btn') as HTMLButtonElement).disabled).toBe(true);
    } finally { await page.close(); }
  }, 30_000);

  it('(f) a site with no ABT-on-Ethereum rail: the plain sentence whole and no Try again', async () => {
    const page = await openDeposit(bare, await job(bare));
    try {
      announceWallets(page.window, [{ uuid: 'w-none', name: 'Wallet', wallet: buildWallet(bare.chain) }]);
      press(page, 'pay-btn');
      await until(() => status(page) !== '', 'no sentence');
      expect(status(page)).toBe(NOT_CONFIGURED_SENTENCE);
      expect(presses(page)).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);
});

describe('/staged pays a hire in ABT on Ethereum in its own currency', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it('(g) the Ethereum gas line, the 3 percent fee line, the rate shown before the wallet is asked, and the remainder paid through .../abt_eth/, never .../abt/start', async () => {
    const id = await job(h, { status: 'staged', rail: 'abt_eth', stagedAt: RECENT, stagedCommit: 'commit-abt-eth-checkout', confirmedAt: RECENT, confirmedSpecHash: 'sha256:abt-eth-checkout' });
    const page = await openStaged(h, id);
    try {
      expect(gasLine(page)).toBe('You need a little ETH on Ethereum for gas.');
      expect(page.document.querySelector('#choices .para')?.textContent).toBe('$375.00 of the $500.00 price, plus the 3 percent fee. Then the pull request opens on your repository, and merging is up to you.');
      expect(text(page.document, 'pay-btn')).toBe('Pay the balance, $386.25');
      const atFirstAsk: unknown[] = [];
      const wallet = buildWallet(h.chain, (method) => {
        if (method !== 'eth_requestAccounts' && atFirstAsk.length === 0) {
          atFirstAsk.push({ method, heading: text(page.document, 'scanh'), rateShown: shown(page.document, 'abt-rate'), lines: rateLines(page), addressShown: shown(page.document, 'scan-abt-address') });
        }
      });
      announceWallets(page.window, [{ uuid: 'w-bal', name: 'Eth Wallet', wallet }]);
      press(page, 'pay-btn');
      await until(() => status(page) !== '', 'no sentence');
      expect(atFirstAsk).toEqual([{ method: 'wallet_switchEthereumChain', heading: 'Pay the balance', rateShown: true, lines: RATE_LINES, addressShown: false }]);
      expect(status(page)).toBe('This payment is confirmed.');
      expect(wallet.sends.map(({ recipient, amountBaseUnits }) => ({ recipient, amountBaseUnits }))).toEqual([
        { recipient: OWNER_ETH, amountBaseUnits: '1500000000000000000000' },
        { recipient: ABT_FEE_ADDRESS, amountBaseUnits: '45000000000000000000' },
      ]);
      expect(page.requests.filter((r) => r.startsWith('POST '))).toEqual([`POST /jobs/${id}/payments/remainder/abt_eth/start`, `POST /jobs/${id}/payments/remainder/abt_eth/wallet-response`]);
      expect((await h.settlementRepo.findByJobAndLeg(id, 'remainder'))?.rail).toBe('abt_eth');
      expect(text(page.document, 'scan-status')).toBe('The pull request opens once the operator submits the work.');
    } finally { await page.close(); }
  }, 30_000);
});

// (h) An owner whose only address is ABT on Ethereum can be paid now, so no notice.
describe('(h) the payout notice counts the ABT-on-Ethereum address', () => {
  let world: PayoutWorld;
  let seed: string | undefined;
  beforeAll(async () => { seed = process.env.FREEAGENTS_PLATFORM_SEED; process.env.FREEAGENTS_PLATFORM_SEED = 'd'.repeat(64); world = await startPayoutWorld('abt-eth-checkout'); });
  afterAll(async () => { await world.close(); if (seed === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED; else process.env.FREEAGENTS_PLATFORM_SEED = seed; });
  const rendered = (d: Document): boolean => !d.getElementById('payout-notice')!.hidden || d.querySelector('#dgrid > section, #rows > *') !== null;
  for (const path of ['/dashboard', '/myagents']) {
    it.each([['only ABT on Ethereum set', 'abtEthOnly', false], ['none set', 'noAddress', true]] as const)(`${path}, %s`, async (_label, key, notice) => {
      const account: PayoutAccount = world[key];
      const page = await renderPage(asHarness({ baseUrl: world.baseUrl, session: account.session }), path, rendered);
      try {
        await new Promise((r) => setTimeout(r, 200));
        expect({ notice: shown(page.document, 'payout-notice'), sentence: visibleText(page.document).includes(PAYOUT_NOTICE_SENTENCE) }).toEqual({ notice, sentence: notice });
      } finally { await page.close(); }
    }, 30_000);
  }
});

// (i) Real Chrome: the three options, then the ABT-on-Ethereum sheet open on its rate. The
// fake wallet answers accounts and never answers the network switch, so the sheet stays
// open on exactly the state the hirer reads before approving anything.
const MEASURE = `(function () {
  var doc = document.documentElement, sheet = document.querySelector('dialog[open]');
  function vis(el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  var controls = [].filter.call((sheet || document).querySelectorAll(sheet ? 'button' : '#rails label, #pay-btn, #back-to-agreement'), vis);
  return {
    open: !!sheet, scroll: [doc.scrollWidth, doc.clientWidth], sheetOverflow: sheet ? sheet.scrollWidth - sheet.clientWidth : 0,
    names: [].filter.call(document.querySelectorAll('#rails .rname'), vis).map(function (e) { return e.textContent; }),
    rate: sheet && vis(document.getElementById('abt-rate')) ? [].map.call(document.querySelectorAll('#abt-rate p'), function (p) { return p.textContent.trim(); }) : [],
    measured: controls.length,
    small: controls.filter(function (el) { var r = el.getBoundingClientRect(); return r.width < 44 || r.height < 44; })
      .map(function (el) { var r = el.getBoundingClientRect(); return (el.id || el.textContent.trim().slice(0, 20)) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); })
  };
})()`;
interface Measure { open: boolean; scroll: number[]; sheetOverflow: number; names: string[]; rate: string[]; measured: number; small: string[] }
const WALLET = `window.ethereum = { request: function (a) { return a.method === 'eth_requestAccounts' ? Promise.resolve(['0x00000000000000000000000000000000000000ef']) : new Promise(function () {}); } };`;
const captureDir = process.env.ABT_ETH_CAPTURE_DIR ?? '';

describe('(i) in real Chrome: three options, and the ABT-on-Ethereum sheet showing its rate', () => {
  for (const width of [320, 390, 1280]) {
    it(`${width}px`, async () => {
      if (!hasRealBrowser()) { console.warn('no Chrome found; skipping (see CHROME_BIN)'); return; }
      const id = await job(h, { agentDid: AGENT_ALL });
      const browser = await RealBrowser.launch({ width, height: 800 });
      try {
        if (width < 760) {
          await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 740, deviceScaleFactor: 2, mobile: true });
          await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true });
        }
        await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(h.session))}); ${WALLET}` });
        await browser.goto(`${h.baseUrl}/deposit?job=${id}`, 900);
        const shot = async (name: string): Promise<void> => {
          if (captureDir === '') return;
          mkdirSync(captureDir, { recursive: true });
          const png = (await browser.send('Page.captureScreenshot', { format: 'png' })) as { result?: { data?: string } };
          if (png.result?.data) writeFileSync(join(captureDir, `abt-eth-${name}-${width}.png`), Buffer.from(png.result.data, 'base64'));
        };
        await browser.evaluate(`document.getElementById('rails').scrollIntoView({ block: 'center' })`);
        const rest = await browser.evaluate<Measure>(MEASURE);
        await shot('options');
        await browser.evaluate(`(function () { var r = document.getElementById('rail-abt-eth'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); document.getElementById('pay-btn').click(); })()`);
        let open = await browser.evaluate<Measure>(MEASURE);
        for (let i = 0; i < 40 && open.rate.length === 0; i += 1) { await new Promise((r) => setTimeout(r, 100)); open = await browser.evaluate<Measure>(MEASURE); }
        await browser.evaluate(`document.getElementById('abt-rate').scrollIntoView({ block: 'center' })`);
        await shot('sheet');
        console.log(`${width}: rest ${JSON.stringify(rest)} open ${JSON.stringify(open)}`);
        expect(rest.names).toEqual(['ABT on ArcBlock', 'ABT on Ethereum', 'USDC on Arbitrum']);
        expect(open.open).toBe(true);
        expect(open.rate[0]).toMatch(/^1 ABT = \$0\.25, held until .+\.$/);
        expect(open.rate[1]).toMatch(/^Price data by CoinGecko, updated .+\.$/);
        for (const m of [rest, open]) {
          expect(m.scroll[0], 'sideways scroll').toBe(m.scroll[1]);
          expect(m.sheetOverflow, 'the sheet scrolls sideways').toBe(0);
          expect(m.measured).toBeGreaterThan(1);
          if (width < 760) expect(m.small, 'under 44px').toEqual([]);
        }
      } finally { await browser.close(); }
    }, 60_000);
  }
});
