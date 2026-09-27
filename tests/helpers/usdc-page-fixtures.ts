// USDC-WEBb: a real app with both payment rails on fake chains, and the
// deposit and balance pages rendered from its own static mount in jsdom,
// for tests/web/usdc-pay-pages.test.ts. The fake wallet is written after
// tests/web/usdc-wallet.test.ts's own (not imported from it): an EIP-1193
// provider that announces itself through EIP-6963 in the page's window,
// decodes each transfer it is asked to sign with ethers' Interface alone,
// and writes the receipt the server's chain client reads. So a confirmed
// payment proves the page asked the wallet for exactly what the server
// checks.
import type { Server } from 'node:http';
import { Interface } from 'ethers';
import { JSDOM, VirtualConsole } from 'jsdom';
import { fromRandom } from '@ocap/wallet';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import type { Session } from '../../src/adapters/identity/session.js';
import { PrismaSettlementGate } from '../../src/adapters/payment/gate.js';
import { createAbtPaymentRail } from '../../src/adapters/payment/abt.js';
import { createUsdcPaymentRail, type UsdcChainClient } from '../../src/adapters/payment/usdc.js';
import type { UsdcSpentTransferRow } from '../../src/adapters/payment/usdc-spent-transfer-storage-types.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryAttestationRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
  MemorySettlementRepository,
} from '../../src/adapters/storage/memory.js';
import { didSuffix } from '../../src/domain/agent.js';
import { buildAttestation } from '../../src/domain/attestation.js';
import { createJob, type Job } from '../../src/domain/job.js';
import { abtEnv, fakeAbtChainClient, reservePort, withEnv } from './abt-fixtures.js';
import { createStagingLifecycleGithubFake } from './github-staging-fixtures.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession } from './session-fixtures.js';
import { anyCommitStagingObserver } from './staging-fixtures.js';
import { fakeHalfPaidStorage } from './usdc-half-paid-fixtures.js';

export const USDC_TOKEN = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
export const USDC_FEE_ADDRESS = '0x00000000000000000000000000000000000000ab';
export const USDC_OPERATOR_ADDRESS = '0x00000000000000000000000000000000000000cd';
const USDC_CHAIN_ID = 421614;
const TRANSFER_IFACE = new Interface(['function transfer(address,uint256)']);
const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

export const BUYER_DID = 'did:abt:usdc-pages-buyer';
export const AGENT_DID = 'did:abt:zUsdcPagesAgent';
export const OPERATOR_DID = 'did:abt:usdc-pages-operator';
// An agent whose owner set no payout address at all: payableRails is [].
export const UNPAID_AGENT_DID = 'did:abt:zUsdcPagesUnpaidAgent';
const BUYER_LOGIN = 'usdc-pages-buyer';

// The server's view of the chain, written only by the fake wallet.
type Receipt = { status: number; transfer: { to: string; value: string; tokenContract: string; chainId: number } };
export interface ChainState { readonly receipts: Map<string, Receipt>; count: number }

export interface WalletSend { readonly to: string; readonly recipient: string; readonly amountBaseUnits: string }
export interface PageWallet {
  readonly provider: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
  readonly calls: string[];
  readonly sends: WalletSend[];
  // Hands every receipt held back by `serverLags` to the server's chain.
  release(): void;
}
export interface PageWalletOptions {
  // eth_requestAccounts refused with 4001: the engine answers cancelled.
  readonly refuseAccounts?: boolean;
  // The first fee transfer lands with status 0: transfer_failed, fee.
  readonly failFirstFee?: boolean;
  // Receipts reach this wallet at once but the server's chain only on
  // release(): the engine answers waiting_network.
  readonly serverLags?: boolean;
}

export function buildPageWallet(chain: ChainState, opts: PageWalletOptions = {}): PageWallet {
  const calls: string[] = [];
  const sends: WalletSend[] = [];
  const local = new Map<string, number>();
  const held: Array<[string, Receipt]> = [];
  let feeFailed = false;
  async function request(args: { method: string; params?: unknown[] }): Promise<unknown> {
    calls.push(args.method);
    switch (args.method) {
      case 'eth_requestAccounts':
        if (opts.refuseAccounts) throw { code: 4001, message: 'User rejected' };
        return ['0x00000000000000000000000000000000000000ef'];
      case 'wallet_switchEthereumChain':
      case 'wallet_addEthereumChain':
        return null;
      case 'eth_sendTransaction': {
        const tx = (args.params ?? [])[0] as { to: string; data: string };
        const [recipient, amount] = TRANSFER_IFACE.decodeFunctionData('transfer', tx.data) as unknown as [string, bigint];
        sends.push({ to: tx.to, recipient: recipient.toLowerCase(), amountBaseUnits: amount.toString() });
        chain.count += 1;
        const hash = `0xpage${chain.count}`;
        const isFee = recipient.toLowerCase() === USDC_FEE_ADDRESS;
        const status = isFee && opts.failFirstFee && !feeFailed ? 0 : 1;
        if (isFee && status === 0) feeFailed = true;
        const receipt: Receipt = { status, transfer: { to: recipient.toLowerCase(), value: amount.toString(), tokenContract: tx.to, chainId: USDC_CHAIN_ID } };
        local.set(hash, status);
        if (opts.serverLags) held.push([hash, receipt]);
        else chain.receipts.set(hash, receipt);
        return hash;
      }
      case 'eth_getTransactionReceipt': {
        const status = local.get(String((args.params ?? [])[0]));
        return status === undefined ? null : { status: status === 1 ? '0x1' : '0x0' };
      }
      default:
        throw new Error(`page wallet: unhandled method ${args.method}`);
    }
  }
  return {
    provider: { request },
    calls,
    sends,
    release() { for (const [hash, receipt] of held.splice(0)) chain.receipts.set(hash, receipt); },
  };
}

// EIP-6963: every wallet listed answers the page's own request event.
export function announceWallets(win: JSDOM['window'], wallets: ReadonlyArray<{ uuid: string; name: string; icon?: string; wallet: PageWallet }>): void {
  win.addEventListener('eip6963:requestProvider', () => {
    for (const w of wallets) {
      win.dispatchEvent(new win.CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: w.uuid, name: w.name, icon: w.icon ?? '' }, provider: w.wallet.provider } }));
    }
  });
}

export interface PageHarness {
  readonly baseUrl: string;
  readonly chain: ChainState;
  readonly jobRepo: MemoryJobRepository;
  readonly settlementRepo: MemorySettlementRepository;
  readonly session: Session;
  addJob(overrides: Partial<Job> & { id: string }): Promise<Job>;
  settle(jobId: string, leg: 'deposit' | 'remainder', rail: 'abt' | 'usdc'): Promise<void>;
  close(): Promise<void>;
}

const CRITERIA = [{ text: 'The login bug is fixed', proposedBy: 'agent' as const, acceptedByBuyer: true, acceptedByAgent: true }];

export async function buildPageHarness(): Promise<PageHarness> {
  const chain: ChainState = { receipts: new Map(), count: 0 };
  const accountRepo = new MemoryAccountRepository();
  await accountRepo.register({ did: BUYER_DID, githubLogin: BUYER_LOGIN });
  await accountRepo.register({ did: OPERATOR_DID, githubLogin: 'usdc-pages-operator' });
  await accountRepo.setOperatorAddressAbt(OPERATOR_DID, didSuffix(AGENT_DID));
  await accountRepo.setOperatorAddressEvm(OPERATOR_DID, USDC_OPERATOR_ADDRESS);
  const unpaidOperator = 'did:abt:usdc-pages-unpaid-operator';
  await accountRepo.register({ did: unpaidOperator, githubLogin: 'usdc-pages-unpaid-operator' });
  const agentRepo = new MemoryAgentRepository();
  for (const [did, operatorDid, name] of [[AGENT_DID, OPERATOR_DID, 'usdc-scout'], [UNPAID_AGENT_DID, unpaidOperator, 'unpaid-scout']] as const) {
    await agentRepo.create({ did, operatorDid, delegation: { fixture: true } as never, name, skills: ['triage'], githubLogin: `${name}-gh` });
    await agentRepo.updateGithubBinding(did, { handle: `${name}-gh`, status: 'verified' });
  }
  const jobRepo = new MemoryJobRepository();
  const settlementRepo = new MemorySettlementRepository();
  const attestationRepo = new MemoryAttestationRepository();
  const credentialRepo = new MemoryCredentialRepository();
  const credentials = createCredentialsAdapter(undefined, credentialRepo);
  const { github } = createStagingLifecycleGithubFake();
  const sessionAdapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: BUYER_LOGIN, id: 930001 }) });
  const serverChain: UsdcChainClient = {
    decimals: async () => 6,
    getTransactionReceipt: async (hash: string) => chain.receipts.get(hash.toLowerCase()) ?? null,
  };
  const spent = new Map<string, UsdcSpentTransferRow>();
  const usdcEnv = {
    FREEAGENTS_USDC_RPC_URL: 'https://sepolia-rollup.arbitrum.io/rpc', FREEAGENTS_USDC_TOKEN_CONTRACT: USDC_TOKEN,
    FREEAGENTS_USDC_CHAIN_ID: String(USDC_CHAIN_ID), FREEAGENTS_USDC_FEE_ADDRESS: USDC_FEE_ADDRESS,
  };
  const usdcRail = await withEnv(usdcEnv, async () => createUsdcPaymentRail({
    chainClient: serverChain,
    rateSource: async () => '1',
    halfPaidStorage: fakeHalfPaidStorage(),
    spentTransferStorage: { async record(row) { spent.set(row.hash, { ...row }); }, async findByHash(hash) { return spent.get(hash) ?? null; } },
  }));
  // WalletAuthenticator bakes the public base URL in at construction, so
  // the port is reserved first (deposit.test.ts's own reason).
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const abtRailEnv = abtEnv(baseUrl, fromRandom(), fromRandom().address, fromRandom().address);
  const abtRail = await withEnv(abtRailEnv, async () => createAbtPaymentRail({
    chainClient: fakeAbtChainClient().client,
    rateSource: async () => '1',
    spentTransferStorage: { async record(): Promise<void> {}, async findByHash(): Promise<null> { return null; } },
  }));
  const app = await withEnv(abtRailEnv, async () => createApp(
    accountRepo, agentRepo, undefined, github, jobRepo, credentials, undefined, credentialRepo,
    // One test file drives many pages at one IP; the limiter is not what it checks.
    { upstream: 10_000, write: 10_000, read: 10_000, verify: 10_000 }, undefined,
    undefined, sessionAdapter, undefined, new PrismaSettlementGate(settlementRepo), anyCommitStagingObserver(),
    attestationRepo, abtRail, usdcRail, settlementRepo,
  ));
  const server: Server = app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const session = await mintSession(sessionAdapter);

  async function addJob(overrides: Partial<Job> & { id: string }): Promise<Job> {
    const base = createJob({ id: overrides.id, buyerDid: BUYER_DID, agentDid: AGENT_DID, repository: 'buyer/usdc-pages-repo', brief: 'Fix the login bug' }, new Date('2026-09-01T00:00:00Z'));
    const job: Job = {
      ...base, status: 'proposed', criteria: CRITERIA, priceUsd: '1200.00', rail: null, depositPercent: 25, redoAllowance: 1,
      priceAcceptedByBuyer: true, priceAcceptedByAgent: true, ...overrides,
    };
    await jobRepo.create(job);
    if (job.status === 'staged') {
      const observation = {
        diffHash: `sha256:${job.id}`, filesChanged: 1, linesAdded: 3, linesRemoved: 1, changedPaths: ['src/login.ts'],
        lineShareByCategory: { source: 100, test: 0, lockfile: 0, generated: 0, vendored: 0 }, testsDeleted: [], testsSkipAdded: [], commitSigners: [{ matchesAgentDid: true }],
      };
      const attestation = buildAttestation(job, observation, new Date());
      await attestationRepo.save({ jobId: job.id, attestation, signed: await credentials.signAttestation(attestation) });
    }
    return job;
  }
  // A settlement row the way another device or an earlier visit leaves it.
  async function settle(jobId: string, leg: 'deposit' | 'remainder', rail: 'abt' | 'usdc'): Promise<void> {
    await settlementRepo.record({
      jobId, leg, rail, hash: `0xsettled-${jobId}-${leg}`, secondaryHash: `0xsettled-${jobId}-${leg}-fee`,
      operatorAddress: USDC_OPERATOR_ADDRESS, feeAddress: USDC_FEE_ADDRESS, amountUsd: '300.00', observedAt: new Date(),
    });
  }
  return {
    baseUrl, chain, jobRepo, settlementRepo, session, addJob, settle,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface RenderedPage {
  readonly window: JSDOM['window'];
  readonly document: Document;
  // Every request the page made, as "METHOD path", in order.
  readonly requests: string[];
  // Waits for every request the page started to answer, and a beat for
  // the page to act on it, then closes: a window closed under a pending
  // request throws inside the page script, after the test has moved on.
  close(): Promise<void>;
}

// Renders a page from the app's own static mount with the buyer signed
// in, and waits for `ready` (a real condition on the document, never a
// fixed sleep alone).
export async function renderPage(h: PageHarness, path: string, ready: (doc: Document) => boolean): Promise<RenderedPage> {
  const requests: string[] = [];
  const inFlight = { value: 0 };
  const failures: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));
  const markup = await (await fetch(`${h.baseUrl}${path}`, { headers: { Accept: HTML } })).text();
  const dom = new JSDOM(markup, {
    url: `${h.baseUrl}${path}`, runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.sessionStorage.setItem('fa_session', JSON.stringify(h.session));
      Object.defineProperty(window, 'fetch', {
        writable: true,
        value: (input: string, init?: RequestInit) => {
          requests.push(`${init?.method ?? 'GET'} ${new URL(input, h.baseUrl).pathname}`);
          inFlight.value += 1;
          return fetch(new URL(input, h.baseUrl), init).finally(() => { inFlight.value -= 1; });
        },
      });
    },
  });
  await waitFor(() => ready(dom.window.document), `${path} never became ready`);
  if (failures.length > 0) throw new Error(`page script failed on ${path}: ${failures.join('; ')}`);
  async function close(): Promise<void> {
    await waitFor(() => inFlight.value === 0, `${path} kept a request open`);
    await new Promise((resolve) => setTimeout(resolve, 60));
    dom.window.close();
  }
  return { window: dom.window, document: dom.window.document, requests, close };
}

export async function waitFor(condition: () => boolean, message: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`waitFor: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// The text of an element, and whether it is shown (no [hidden] on it or
// any ancestor), read the way a person meets it.
export function shown(doc: Document, id: string): boolean {
  let el: Element | null = doc.getElementById(id);
  if (el === null) return false;
  while (el !== null) { if ((el as HTMLElement).hidden) return false; el = el.parentElement; }
  return true;
}
export function text(doc: Document, id: string): string {
  return (doc.getElementById(id)?.textContent ?? '').trim();
}
