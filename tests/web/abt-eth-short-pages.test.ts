// A short ABT-on-Ethereum payment on the pages: a transfer recorded after its price hold
// and worth less than agreed holds the hire on the owner's answer (the 2026-10-01
// ruling). The owner sees it in the conversation and on /operatorjob and accepts it as
// paid with one press; the hirer sees that the hire waits on the owner, and /deposit and
// /staged stop offering a payment the platform would refuse.
//
// Driven against the real app with the real ABT-on-Ethereum rail injected at createApp's
// own positions, the harness tests/web/abt-eth-checkout.test.ts builds (copied here, not
// imported): a fake chain the server reads receipts and block times from, and a fake
// price feed. A short payment is made through the routes a hirer's wallet and page use
// (shortPay: the start, two transfers the network records after the hold, the report read
// while ABT is at 0.20 instead of 0.25) unless a case names the short storage instead. A
// second session signs in as the agent's owner through a switchable fake GitHub fetch. Pages are
// served by the app's own static mount into jsdom; (i) drives real Chrome. Times are read
// in UTC so every date on the page is a literal here.
import type { Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import type { Session } from '../../src/adapters/identity/session.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import { createAbtEthPaymentRail } from '../../src/adapters/payment/abt-eth.js';
import { createMemoryAbtEthQuoteLockStorage } from '../../src/adapters/payment/abt-eth-quote-lock-memory.js';
import { createMemoryAbtEthShortPaymentStorage } from '../../src/adapters/payment/abt-eth-short-payment-memory.js';
import type { AbtEthShortPaymentStorage } from '../../src/adapters/payment/abt-eth-short-payment-types.js';
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
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession } from '../helpers/session-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import { fakeHalfPaidStorage } from '../helpers/usdc-half-paid-fixtures.js';

const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'UTC';
afterAll(() => { process.env.TZ = ORIGINAL_TZ; });

const NOW = new Date('2026-10-06T12:00:00.000Z');
const AFTER_HOLD = '2026-10-06T12:20:00.000Z';
const FEED: RateReading = { usdPerToken: '0.25', updatedAt: new Date('2026-10-06T11:59:00.000Z') } as RateReading;
const DROPPED: RateReading = { usdPerToken: '0.2', updatedAt: new Date('2026-10-06T11:59:30.000Z') } as RateReading;
const RECENT = new Date('2026-10-06T11:00:00.000Z');
const ABT_TOKEN = '0xb98d4c97425d9908e66e53a6fdf673acca0be986';
const FEE_ADDRESS = '0x2222222222222222222222222222222222222222';
const OWNER_ETH = '0x1111111111111111111111111111111111111111';
const BUYER_DID = 'did:abt:abt-eth-short-buyer';
const BUYER_LOGIN = 'abt-eth-short-buyer';
const AGENT = 'did:abt:zAbtEthShortAgent';
const OPERATOR = `${AGENT}-operator`;
const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

interface Receipt { status: number; transfer: Erc20ObservedTransfer }
interface Harness {
  readonly baseUrl: string;
  readonly buyer: Session;
  readonly owner: Session;
  readonly chain: { receipts: Map<string, Receipt>; recorded: Map<string, Date>; count: number; throws: boolean };
  readonly feed: { reading: RateReading | null };
  readonly shorts: AbtEthShortPaymentStorage & { broken: boolean };
  readonly accounts: MemoryAccountRepository;
  readonly settlementRepo: MemorySettlementRepository;
  addJob(overrides: Partial<Job> & { id: string }): Promise<void>;
  close(): Promise<void>;
}

async function buildHarness(): Promise<Harness> {
  const chain: Harness['chain'] = { receipts: new Map(), recorded: new Map(), count: 0, throws: false };
  const feed: Harness['feed'] = { reading: FEED };
  const accounts = new MemoryAccountRepository();
  await accounts.register({ did: BUYER_DID, githubLogin: BUYER_LOGIN });
  await accounts.register({ did: OPERATOR, githubLogin: `${AGENT.slice(8)}-operator` });
  await accounts.setOperatorAddressAbtEth(OPERATOR, OWNER_ETH);
  const agents = new MemoryAgentRepository();
  await agents.create({ did: AGENT, operatorDid: OPERATOR, delegation: { fixture: true } as never, name: 'short-scout', skills: ['triage'], githubLogin: 'short-scout-gh' });
  await agents.updateGithubBinding(AGENT, { handle: 'short-scout-gh', status: 'verified' });
  const spent = new Map<string, UsdcSpentTransferRow>();
  const env: Record<string, string> = { FREEAGENTS_ABT_ETH_RPC_URL: 'https://rpc.example.test', FREEAGENTS_ABT_ETH_TOKEN_CONTRACT: ABT_TOKEN, FREEAGENTS_ABT_ETH_CHAIN_ID: '1', FREEAGENTS_ABT_ETH_FEE_ADDRESS: FEE_ADDRESS };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const rail = createAbtEthPaymentRail({
    chainClient: {
      decimals: async () => 18,
      getTransactionReceipt: async (hash) => { if (chain.throws) throw new Error('node down'); return chain.receipts.get(hash.toLowerCase()) ?? null; },
      recordedAt: async (hash) => chain.recorded.get(hash.toLowerCase()) ?? null,
    },
    rateSource: async () => feed.reading,
    spentTransferStorage: { record: async (row) => void spent.set(row.hash, { ...row }), findByHash: async (hash) => spent.get(hash) ?? null },
    halfPaidStorage: fakeHalfPaidStorage(),
  });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  // The short storage, with a switch that makes every read of it fail.
  const inner = createMemoryAbtEthShortPaymentStorage();
  const shorts = {
    broken: false,
    record: (row) => inner.record(row),
    findByHash: (hash) => inner.findByHash(hash),
    findByJobAndLeg: async (jobId, leg) => { if (shorts.broken) throw new Error('storage down'); return inner.findByJobAndLeg(jobId, leg); },
  } as Harness['shorts'];
  const jobRepo = new MemoryJobRepository();
  const settlementRepo = new MemorySettlementRepository();
  const attestationRepo = new MemoryAttestationRepository();
  const credentialRepo = new MemoryCredentialRepository();
  const credentials = createCredentialsAdapter(undefined, credentialRepo);
  let gh = { login: BUYER_LOGIN, id: 941001 };
  const ghFetch = ((input: string | URL | Request, init?: RequestInit) => fakeGitHubFetch(gh)(input, init)) as typeof fetch;
  const sessionAdapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: ghFetch });
  const app = createApp(
    accounts, agents, undefined, createStagingLifecycleGithubFake().github, jobRepo, credentials, undefined, credentialRepo,
    { upstream: 10_000, write: 10_000, read: 10_000, verify: 10_000 }, undefined, undefined, sessionAdapter, undefined,
    new PrismaSettlementGate(settlementRepo), anyCommitStagingObserver(), attestationRepo, null, null, settlementRepo,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    rail, createMemoryAbtEthQuoteLockStorage(), shorts,
  );
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a port');
  const buyer = await mintSession(sessionAdapter);
  gh = { login: `${AGENT.slice(8)}-operator`, id: 941002 };
  const owner = await mintSession(sessionAdapter);
  async function addJob(overrides: Partial<Job> & { id: string }): Promise<void> {
    const base = createJob({ id: overrides.id, buyerDid: BUYER_DID, agentDid: AGENT, repository: 'buyer/abt-eth-short', brief: 'Fix the login bug' }, new Date('2026-09-01T00:00:00Z'));
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
    baseUrl: `http://127.0.0.1:${address.port}`, buyer, owner, chain, feed, shorts, accounts, settlementRepo, addJob,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let h: Harness;
let seq = 0;
beforeAll(async () => { h = await buildHarness(); });
afterAll(async () => { await h.close(); });
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); h.feed.reading = FEED; h.chain.throws = false; h.shorts.broken = false; });

async function call(who: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${who.token}`, Accept: 'application/json', 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${h.baseUrl}${path}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
type Leg = 'deposit' | 'remainder';
// A deposit job (proposed), or a staged job whose deposit settled (for the balance).
async function hire(leg: Leg): Promise<string> {
  seq += 1;
  const id = `abt-eth-short-${seq}`;
  if (leg === 'deposit') { await h.addJob({ id }); return id; }
  await h.addJob({ id, status: 'staged', rail: 'abt_eth', stagedAt: RECENT, stagedCommit: `commit-${id}`, confirmedAt: RECENT, confirmedSpecHash: `sha256:${id}` });
  await h.settlementRepo.record({ jobId: id, leg: 'deposit', rail: 'abt_eth', hash: `0x${String(seq).padStart(64, 'd')}`, secondaryHash: null, operatorAddress: OWNER_ETH, feeAddress: FEE_ADDRESS, amountUsd: '125.00', observedAt: RECENT });
  return id;
}
// What a hirer's wallet does: start, two transfers the network records after the hold,
// then the report, read while ABT is at 0.20 (or with no price at all: unpriced).
async function shortPay(id: string, leg: Leg, unpriced = false): Promise<{ price: string; fee: string }> {
  const start = await call(h.buyer, 'POST', `/jobs/${id}/payments/${leg}/abt_eth/start`, {});
  expect(start.status).toBe(200);
  const transfers = start.body.transfers as Array<{ recipient: string; amountBaseUnits: string; tokenContract: string }>;
  const [price, fee] = transfers.map((t) => {
    h.chain.count += 1;
    const hash = `0x${h.chain.count.toString(16).padStart(64, '0')}`;
    h.chain.receipts.set(hash, { status: 1, transfer: { to: t.recipient.toLowerCase(), value: t.amountBaseUnits, tokenContract: t.tokenContract.toLowerCase(), chainId: 1 } });
    h.chain.recorded.set(hash, new Date(AFTER_HOLD));
    return hash;
  }) as [string, string];
  h.feed.reading = unpriced ? null : DROPPED;
  const report = await call(h.buyer, 'POST', `/jobs/${id}/payments/${leg}/abt_eth/wallet-response`, { priceTxHash: price, feeTx: { signed: true, hash: fee }, quoteLockId: (start.body.quoteLock as { id: string }).id });
  h.feed.reading = FEED;
  expect(report.status).toBe(200);
  expect(report.body.short).toBeDefined();
  return { price, fee };
}
const accept = (id: string, leg: Leg = 'deposit'): ReturnType<typeof call> => call(h.owner, 'POST', `/jobs/${id}/payments/${leg}/abt_eth/accept-short`, {});

// ------------------------------------------------------------------ jsdom

interface Page {
  readonly window: JSDOM['window'];
  readonly document: Document;
  readonly requests: string[];
  readonly posts: Array<{ path: string; body: unknown }>;
  close(): Promise<void>;
}
type Stand = (method: string, path: string) => Response | Promise<Response> | null;
// The page as a browser runs it, signed in as `who`. `stand` answers one request in the
// route's place (named per case below). TextDecoder is handed in so /messages streams.
async function render(path: string, who: Session, ready: (d: Document) => boolean, stand: Stand = () => null): Promise<Page> {
  const requests: string[] = [], posts: Page['posts'] = [], failures: string[] = [], controllers: AbortController[] = [];
  const pending = { n: 0 };
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e: Error) => failures.push(e.message));
  const markup = await (await fetch(`${h.baseUrl}${path}`, { headers: { Accept: HTML } })).text();
  const dom = new JSDOM(markup, {
    url: `${h.baseUrl}${path}`, runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.sessionStorage.setItem('fa_session', JSON.stringify(who));
      Object.defineProperty(window, 'TextDecoder', { writable: true, value: TextDecoder });
      Object.defineProperty(window, 'fetch', {
        writable: true,
        value: (input: string, init: RequestInit = {}) => {
          const url = new URL(input, h.baseUrl), method = (init.method ?? 'GET').toUpperCase();
          requests.push(`${method} ${url.pathname}`);
          if (method === 'POST') posts.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : null });
          const stood = stand(method, url.pathname);
          if (stood !== null) return Promise.resolve(stood);
          const ctrl = new AbortController();
          controllers.push(ctrl);
          const theirs = init.signal as { aborted: boolean; addEventListener(t: string, f: () => void): void } | null | undefined;
          if (theirs) { if (theirs.aborted) ctrl.abort(); else theirs.addEventListener('abort', () => ctrl.abort()); }
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { signal: _dropped, ...rest } = init;
          const streams = url.pathname.endsWith('/stream');
          if (!streams) pending.n += 1;
          return fetch(url, { ...rest, signal: ctrl.signal }).finally(() => { if (!streams) pending.n -= 1; });
        },
      });
    },
  });
  await until(() => ready(dom.window.document), `${path} never became ready`);
  if (failures.length > 0) throw new Error(`page script failed on ${path}: ${failures.join('; ')}`);
  return {
    window: dom.window, document: dom.window.document, requests, posts,
    async close() { await until(() => pending.n === 0, `${path} kept a request open`); controllers.forEach((c) => c.abort()); await wait(60); dom.window.close(); },
  };
}
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(condition: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 300; i += 1) { if (condition()) return; await wait(20); }
  throw new Error(`until: ${message}`);
}
const shown = (d: Document, id: string): boolean => { for (let e: HTMLElement | null = d.getElementById(id); e; e = e.parentElement) if (e.hidden) return false; return d.getElementById(id) !== null; };
const text = (d: Document, id: string): string => (d.getElementById(id)?.textContent ?? '').replace(/\s+/g, ' ').trim();
const anchors = (e: Element | null): string[][] => Array.from(e?.querySelectorAll('a') ?? []).map((a) => [(a.textContent ?? '').trim(), a.getAttribute('href') ?? '']);
// A payments read that fails with a 503. Its body still carries a short leg on each side,
// so a reader that skipped the status check would draw one: the status is what is tested.
const fail503 = (path: string): Stand => (method, p) => (method === 'GET' && p === path
  ? new Response(JSON.stringify({
    error: 'storage unavailable', deposit: null, remainder: null,
    short: { deposit: { rail: 'abt_eth', agreedUsd: '125.00', worthUsd: '100', recordedAt: AFTER_HOLD }, remainder: { rail: 'abt_eth', agreedUsd: '375.00', worthUsd: '300', recordedAt: AFTER_HOLD } },
  }), { status: 503 })
  : null);

const openThread = (id: string, who: Session, stand?: Stand): Promise<Page> =>
  render(`/messages?job=${id}`, who, (d) => d.querySelector('#conv .a-pin .pin-now') !== null && d.querySelector(`.convlist a[data-job="${id}"]`) !== null, stand);
const eventLines = (p: Page): unknown[] => Array.from(p.document.querySelectorAll('.thread .event')).map((e) => ({ text: (e.textContent ?? '').replace(/\s+/g, ' ').trim(), links: anchors(e) }));
const strip = (p: Page): unknown => {
  const next = p.document.getElementById('pin-next');
  return { now: (p.document.querySelector('.a-pin .pin-now')?.textContent ?? '').trim(), next: next === null ? null : [(next.textContent ?? '').trim(), next.getAttribute('href')] };
};
const listLine = (p: Page, id: string): string => (p.document.querySelector(`.convlist a[data-job="${id}"] .cl-lt`)?.textContent ?? '').trim();
const seats = [['the hirer', 'buyer'], ['the owner', 'owner']] as const;
const as = (who: 'buyer' | 'owner'): Session => (who === 'buyer' ? h.buyer : h.owner);

describe('(a) the conversation draws the short payment for both seats', () => {
  it.each([
    ['a short deposit', 'deposit', false, 'Deposit arrived worth less, $100 of $125'],
    ['a short balance', 'remainder', false, 'Balance arrived worth less, $300 of $375'],
    ['a deposit no price could be read for', 'deposit', true, 'Deposit arrived worth less than agreed'],
  ] as const)('%s: one line for each seat, the owner\u2019s with Answer, and the list says Payment arrived short', async (_label, leg, unpriced, line) => {
    const id = await hire(leg);
    await shortPay(id, leg, unpriced);
    for (const [, who] of seats) {
      const page = await openThread(id, as(who));
      try {
        expect(eventLines(page)).toEqual([{ text: who === 'owner' ? `${line} Answer` : line, links: who === 'owner' ? [['Answer', `/operatorjob?job=${id}`]] : [] }]);
        expect(listLine(page, id)).toBe('Payment arrived short');
      } finally { await page.close(); }
    }
  }, 60_000);

  it('a short payment that arrives while the hirer has the thread open is announced in words', async () => {
    const id = await hire('deposit');
    const page = await openThread(id, h.buyer);
    try {
      await shortPay(id, 'deposit');
      await until(() => page.document.querySelectorAll('#thread-live p').length > 0, 'nothing announced');
      expect(Array.from(page.document.querySelectorAll('#thread-live p')).map((p) => p.textContent)).toEqual(['Payment arrived short']);
    } finally { await page.close(); }
  }, 30_000);
});

describe('(b) the pinned strip, while short and after the owner accepts', () => {
  it('each seat\u2019s strip and next step, whole, before and after', async () => {
    const id = await hire('deposit');
    await shortPay(id, 'deposit');
    const read = async (): Promise<unknown[]> => {
      const out: unknown[] = [];
      for (const [, who] of seats) { const page = await openThread(id, as(who)); try { out.push(strip(page)); } finally { await page.close(); } }
      return out;
    };
    expect(await read()).toEqual([
      { now: "Waiting on the owner's answer", next: null },
      { now: 'Your answer needed', next: ['Answer', `/operatorjob?job=${id}`] },
    ]);
    expect((await accept(id)).status).toBe(200);
    expect(await read()).toEqual([
      { now: 'Agreed. The deposit starts the work', next: ['Pay the deposit', `/deposit?job=${id}`] },
      { now: 'Agreed. Waiting for the deposit', next: ['Review the quote', `/agreement?job=${id}`] },
    ]);
    const page = await openThread(id, h.owner);
    try { expect(eventLines(page)).toEqual([{ text: 'Deposit arrived worth less, $100 of $125', links: [] }, { text: 'Deposit paid, $125', links: [] }]); } finally { await page.close(); }
  }, 60_000);
});

// ------------------------------------------------------------------ /operatorjob

const openOwnerPage = (id: string, stand?: Stand): Promise<Page> =>
  render(`/operatorjob?job=${id}`, h.owner, (d) => !d.getElementById('operatorjob-body')!.hidden && d.getElementById('money-facts')!.children.length > 0, stand);
const moneyRows = (p: Page): string[] => Array.from(p.document.querySelectorAll('#money-facts li')).map((li) => Array.from(li.children).map((c) => (c.textContent ?? '').trim()).join(' | '));
const panel = (p: Page): unknown => (shown(p.document, 'short-panel')
  ? { heading: (p.document.querySelector('#short-panel h2')?.textContent ?? '').trim(), line: text(p.document, 'short-line'), sub: (p.document.querySelector('#short-panel .sub')?.textContent ?? '').trim(), button: text(p.document, 'short-accept-btn') }
  : null);
const stateLines = (p: Page): string[] => [text(p.document, 'state-heading'), text(p.document, 'state-lede')];
const SUB = 'The hire waits on your answer.';

describe('(c) /operatorjob while a payment waits on the owner', () => {
  it.each([
    ['a short deposit on a proposed hire', 'deposit', false,
      { heading: 'A payment arrived short', line: 'The deposit arrived worth $100.00, not the agreed $125.00.', sub: SUB, button: 'Accept $100.00 as paid' },
      ['Agreed price | $500.00', 'Deposit arrived short, October 6, 2026 | $100.00 of $125.00 in ABT on Ethereum', 'Balance, not paid yet | $375.00', 'Platform fee | paid by the buyer, on top'],
      ['A payment waits on your answer', 'The deposit arrived worth less than agreed. Accept it as paid to go on.']],
    ['a short balance on a staged hire', 'remainder', false,
      { heading: 'A payment arrived short', line: 'The balance arrived worth $300.00, not the agreed $375.00.', sub: SUB, button: 'Accept $300.00 as paid' },
      ['Agreed price | $500.00', `Deposit received, October 6, 2026 | $125.00 in ABT on Ethereum, to ${OWNER_ETH}`, 'Balance arrived short, October 6, 2026 | $300.00 of $375.00 in ABT on Ethereum', 'Platform fee | paid by the buyer, on top'],
      ['A payment waits on your answer', 'The balance arrived worth less than agreed. Accept it as paid to go on.']],
    ['a deposit no price could be read for', 'deposit', true,
      { heading: 'A payment arrived short', line: 'The deposit arrived worth less than the agreed $125.00.', sub: SUB, button: 'Accept as paid' },
      ['Agreed price | $500.00', 'Deposit arrived short, October 6, 2026 | less than $125.00 in ABT on Ethereum', 'Balance, not paid yet | $375.00', 'Platform fee | paid by the buyer, on top'],
      ['A payment waits on your answer', 'The deposit arrived worth less than agreed. Accept it as paid to go on.']],
  ] as const)('%s: the panel, the money rows and the state lines, whole', async (_label, leg, unpriced, want, rows, lines) => {
    const id = await hire(leg);
    await shortPay(id, leg, unpriced);
    const page = await openOwnerPage(id);
    try {
      expect({ panel: panel(page), rows: moneyRows(page), lines: stateLines(page) }).toEqual({ panel: want, rows: [...rows], lines: [...lines] });
      expect(page.document.body.textContent).not.toContain('not paid yet$125');
    } finally { await page.close(); }
  }, 30_000);
});

describe('(d) the owner\u2019s one press, end to end', () => {
  it('the press posts once with {}, even pressed twice; the page reads paid, no panel, focus on the heading; the row and the thread line are written', async () => {
    const id = await hire('deposit');
    const sent = await shortPay(id, 'deposit');
    const page = await openOwnerPage(id);
    try {
      const btn = page.document.getElementById('short-accept-btn') as HTMLButtonElement;
      btn.click();
      btn.click();
      await until(() => !shown(page.document, 'short-panel'), 'the panel never went');
      await until(() => page.document.activeElement?.id === 'state-heading', 'focus never reached the heading');
      expect(page.posts).toEqual([{ path: `/jobs/${id}/payments/deposit/abt_eth/accept-short`, body: {} }]);
      expect(panel(page)).toBeNull();
      expect(moneyRows(page)[1]).toBe(`Deposit received, October 6, 2026 | $125.00 in ABT on Ethereum, to ${OWNER_ETH}`);
      expect(stateLines(page)).toEqual(['Drafting the agreement', 'Criteria and a price have been proposed. Both sides are still agreeing terms.']);
      expect(btn.getAttribute('aria-disabled')).toBeNull();
      expect(btn.disabled).toBe(false);
    } finally { await page.close(); }
    expect(await h.settlementRepo.findByJobAndLeg(id, 'deposit')).toEqual({
      jobId: id, leg: 'deposit', rail: 'abt_eth', hash: sent.price, secondaryHash: sent.fee, operatorAddress: OWNER_ETH, feeAddress: FEE_ADDRESS, amountUsd: '125.00', observedAt: NOW,
    });
    const thread = await call(h.buyer, 'GET', `/jobs/${id}/messages`);
    expect((thread.body.messages as Array<{ body: string }>).map((m) => m.body)).toEqual(['Deposit arrived worth less than agreed', 'Deposit paid']);
  }, 30_000);

  it('a second click while the first is in flight posts nothing, and the button is aria-disabled, never disabled', async () => {
    const id = await hire('deposit');
    await shortPay(id, 'deposit');
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    // A stand-in that holds the press's answer until the test lets it go.
    const page = await openOwnerPage(id, (m, p) => (m === 'POST' && p.endsWith('/accept-short') ? held.then(() => new Response(JSON.stringify({ error: 'No payment on this leg waits on your answer.' }), { status: 409 })) : null));
    try {
      const btn = page.document.getElementById('short-accept-btn') as HTMLButtonElement;
      btn.click();
      await wait(50);
      expect([btn.getAttribute('aria-disabled'), btn.getAttribute('aria-busy'), btn.disabled]).toEqual(['true', 'true', false]);
      btn.click();
      release();
      await until(() => shown(page.document, 'short-error'), 'no refusal');
      expect(page.posts.map((x) => x.path)).toEqual([`/jobs/${id}/payments/deposit/abt_eth/accept-short`]);
    } finally { await page.close(); }
  }, 30_000);
});

// ------------------------------------------------------------------ (e) refusals

const NOT_ANSWERING = 'The payment service is not answering right now. Try again in a moment.';
const CATCH_ALL = 'This payment could not be accepted just now. Reload the page to see where it stands.';
const standIn = (status: number, error: string | null): Stand => (m, p) => (m === 'POST' && p.endsWith('/accept-short')
  ? (error === null ? Promise.reject(new TypeError('network down')) as unknown as Response : new Response(JSON.stringify({ error }), { status }))
  : null);
interface Refusal {
  readonly label: string; readonly sentence: string; readonly links: string[][];
  // How the short payment is made before the page loads: by the hirer's wallet, or one
  // row written through the injected short storage (the missing-lock case, whose route
  // check sits after the more-than-one check, so its row must be the leg's only one).
  readonly via: 'wallet' | 'storage';
  // The state the press meets, set after the page loaded; returns its undo.
  arrange(id: string, sent: { price: string } | null): Promise<() => Promise<void>>;
  readonly stand?: Stand;
}
const nothing = async (): Promise<() => Promise<void>> => async () => {};
const REFUSALS: Refusal[] = [
  { label: 'the owner cleared the payout address after it landed short (the operator-address 409)', sentence: 'Add your ABT on Ethereum payout address in Settings first.', links: [['Open Settings', '/settings']], via: 'wallet',
    arrange: async () => { await h.accounts.setOperatorAddressAbtEth(OPERATOR, null as unknown as string); return async () => { await h.accounts.setOperatorAddressAbtEth(OPERATOR, OWNER_ETH); }; } },
  { label: 'the price receipt is gone from the chain (not confirmed)', sentence: 'The network does not show this payment as confirmed right now, so it cannot be accepted. Try again in a few minutes.', links: [], via: 'wallet',
    arrange: async (_id, sent) => { const r = h.chain.receipts.get(sent!.price)!; h.chain.receipts.delete(sent!.price); return async () => { h.chain.receipts.set(sent!.price, r); }; } },
  { label: 'the chain client throws (the rail 503)', sentence: NOT_ANSWERING, links: [], via: 'wallet', arrange: async () => { h.chain.throws = true; return async () => { h.chain.throws = false; }; } },
  { label: 'the short storage fails (the storage 503)', sentence: NOT_ANSWERING, links: [], via: 'wallet', arrange: async () => { h.shorts.broken = true; return async () => { h.shorts.broken = false; }; } },
  { label: 'a short row whose lock is not stored (the missing-lock 409)', sentence: 'This payment can no longer be accepted here. Message the hirer.', links: [], via: 'storage', arrange: nothing },
  { label: 'two unsettled short rows (more than one)', sentence: 'More than one payment on this leg waits on your answer, so none can be accepted here. Message the hirer.', links: [], via: 'wallet',
    arrange: async (id) => { await h.shorts.record(shortRow(id, 'f', 'any-lock')); return async () => {}; } },
  { label: 'a settlement with another hash written after the page loaded (nothing waits)', sentence: 'No payment on this leg waits on your answer.', links: [], via: 'wallet',
    arrange: async (id) => { await h.settlementRepo.record({ jobId: id, leg: 'deposit', rail: 'abt_eth', hash: `0x${'a'.repeat(64)}`, secondaryHash: null, operatorAddress: OWNER_ETH, feeAddress: FEE_ADDRESS, amountUsd: '125.00', observedAt: NOW }); return async () => {}; } },
  // Three answers no page reaches, so a stand-in answers the one press in the route's place:
  // the buyer's 403 and the agent-key 403 (only the owner's seat renders this page), the
  // not-configured 503 (no rail, no short, no panel), and a press that never arrives.
  { label: 'stand-in: the buyer\u2019s 403', sentence: CATCH_ALL, links: [], via: 'wallet', arrange: nothing, stand: standIn(403, 'only the agent may payments/:leg/abt_eth/accept-short this job') },
  { label: 'stand-in: the agent-key 403', sentence: CATCH_ALL, links: [], via: 'wallet', arrange: nothing, stand: standIn(403, 'the owner has not allowed this agent to negotiate on its own signature') },
  { label: 'stand-in: the not-configured 503', sentence: CATCH_ALL, links: [], via: 'wallet', arrange: nothing, stand: standIn(503, 'the abt_eth payment rail is not configured on this deployment') },
  { label: 'stand-in: a press that never reaches the server', sentence: NOT_ANSWERING, links: [], via: 'wallet', arrange: nothing, stand: standIn(0, null) },
];
function shortRow(id: string, fill: string, lockId: string): Parameters<AbtEthShortPaymentStorage['record']>[0] {
  // The storage keys rows by hash, so each job's row gets its own.
  return { priceTxHash: `0x${id.replace(/\D/g, '').padStart(64, fill)}`, jobId: id, leg: 'deposit', lockId, feeTxHash: null, amountToken: '500', amountUsd: '125.00', usdPerTokenAtRead: '0.2', worthUsd: '100', recordedAt: new Date(AFTER_HOLD), readAt: NOW };
}

describe('(e) every refusal of the press reads as one sentence a person can act on', () => {
  it.each(REFUSALS.map((r) => [r.label, r] as const))('%s', async (_label, r) => {
    const id = await hire('deposit');
    let sent: { price: string } | null = null;
    if (r.via === 'wallet') sent = await shortPay(id, 'deposit');
    else await h.shorts.record(shortRow(id, 'e', 'no-such-lock'));
    const page = await openOwnerPage(id, r.stand);
    expect(shown(page.document, 'short-panel')).toBe(true);
    const restore = await r.arrange(id, sent);
    // What is on record once the state is set, before the press.
    const settled = await h.settlementRepo.findByJobAndLeg(id, 'deposit');
    try {
      (page.document.getElementById('short-accept-btn') as HTMLButtonElement).click();
      await until(() => shown(page.document, 'short-error'), 'no refusal shown');
      const alert = page.document.getElementById('short-error')!;
      expect({ role: alert.getAttribute('role'), sentence: text(page.document, 'short-error-detail'), links: anchors(alert), focus: page.document.activeElement?.id })
        .toEqual({ role: 'alert', sentence: r.sentence, links: r.links, focus: 'short-error' });
      const btn = page.document.getElementById('short-accept-btn') as HTMLButtonElement;
      expect([btn.getAttribute('aria-disabled'), btn.disabled, shown(page.document, 'short-accept-btn')]).toEqual([null, false, true]);
      expect(await h.settlementRepo.findByJobAndLeg(id, 'deposit')).toEqual(settled);
    } finally { await restore(); await page.close(); }
  }, 30_000);
});

// ------------------------------------------------------------------ the hirer's pages

const openDeposit = (id: string, stand?: Stand): Promise<Page> =>
  render(`/deposit?job=${id}`, h.buyer, (d) => !d.getElementById('deposit-body')!.hidden && text(d, 'pay-btn') !== '', stand);
const openStaged = (id: string, stand?: Stand): Promise<Page> =>
  render(`/staged?job=${id}`, h.buyer, (d) => d.getElementById('choices-section') === null || text(d, 'pay-btn').startsWith('Pay the balance'), stand);
const waitNote = (p: Page): unknown => (p.document.getElementById('short-wait') === null ? null
  : { sentence: (p.document.querySelector('#short-wait p')?.textContent ?? '').trim(), links: anchors(p.document.getElementById('short-wait')), shown: shown(p.document, 'short-wait') });

describe('(f) /deposit while the deposit waits on the owner', () => {
  it('no Pay, no options, the sentence and its link, no POST on load; after the accept, the already-paid path', async () => {
    const id = await hire('deposit');
    await shortPay(id, 'deposit');
    let page = await openDeposit(id);
    try {
      await wait(200);
      expect({ pay: shown(page.document, 'pay-btn'), rails: shown(page.document, 'rails'), total: shown(page.document, 'total-pane'), heading: shown(page.document, 'rails-heading'), gas: shown(page.document, 'gas-note'), note: waitNote(page) }).toEqual({
        pay: false, rails: false, total: false, heading: false, gas: false,
        note: { sentence: 'Your payment arrived worth less than agreed. The owner decides if it counts.', links: [['Message the owner', `/messages?job=${id}`]], shown: true },
      });
      expect(page.requests.filter((r) => r.startsWith('POST '))).toEqual([]);
    } finally { await page.close(); }
    expect((await accept(id)).status).toBe(200);
    page = await openDeposit(id);
    try {
      expect([waitNote(page), shown(page.document, 'pay-btn')]).toEqual([null, true]);
      // A wallet that connects and switches networks, and never sends: the start answers
      // already paid before anything is signed.
      const win = page.window;
      const provider = { request: async (a: { method: string }) => (a.method === 'eth_requestAccounts' ? ['0x00000000000000000000000000000000000000ef'] : null) };
      win.addEventListener('eip6963:requestProvider', () => {
        win.dispatchEvent(new win.CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'w-paid', name: 'Wallet', icon: '' }, provider } }));
      });
      (page.document.getElementById('pay-btn') as HTMLButtonElement).click();
      await until(() => text(page.document, 'scanh') === 'Already paid', 'the already-paid sheet never opened');
      expect(shown(page.document, 'approved-btn')).toBe(true);
    } finally { await page.close(); }
  }, 30_000);
});

describe('(g) /staged while the balance waits on the owner', () => {
  it('no choices, no clock, no link about declining, a lede that asks for no payment, the line and its link, no POST on load', async () => {
    const id = await hire('remainder');
    await shortPay(id, 'remainder');
    const page = await openStaged(id);
    try {
      await until(() => waitNote(page) !== null, 'no line');
      expect({ lede: text(page.document, 'lede'), choices: page.document.getElementById('choices-section'), clock: page.document.getElementById('clock'), outcomes: page.document.getElementById('outcomes-more'), paid: shown(page.document, 'balance-paid'), note: waitNote(page), tech: text(page.document, 'tech-hidden-note') }).toEqual({
        lede: 'Staged on October 6, 2026. The hire waits on the owner.',
        choices: null, clock: null, outcomes: null, paid: false,
        note: { sentence: 'Your balance arrived worth less than agreed. The owner decides if it counts.', links: [['Message the owner', `/messages?job=${id}`]], shown: true },
        tech: 'The work stays hidden until you pay.',
      });
      expect(page.requests.filter((r) => r.startsWith('POST '))).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);
});

describe('(h) a failed payments read changes nothing on any of the four pages', () => {
  it('a short deposit, its payments read answering 503: /operatorjob, /messages and /deposit read as they do without the read', async () => {
    const id = await hire('deposit');
    await shortPay(id, 'deposit');
    const failed = fail503(`/jobs/${id}/payments`);
    let page = await openOwnerPage(id, failed);
    try {
      expect({ panel: panel(page), rows: moneyRows(page), lines: stateLines(page) }).toEqual({
        panel: null, rows: ['Agreed price | $500.00', 'Deposit | $125.00', 'Balance, when the buyer pays it | $375.00', 'Platform fee | paid by the buyer, on top'],
        lines: ['Drafting the agreement', 'Criteria and a price have been proposed. Both sides are still agreeing terms.'],
      });
    } finally { await page.close(); }
    const strips: unknown[] = [];
    for (const [, who] of seats) {
      page = await openThread(id, as(who), failed);
      try { strips.push({ strip: strip(page), links: anchors(page.document.querySelector('.thread .event')) }); } finally { await page.close(); }
    }
    expect(strips).toEqual([
      { strip: { now: 'Agreed. The deposit starts the work', next: ['Pay the deposit', `/deposit?job=${id}`] }, links: [] },
      { strip: { now: 'Agreed. Waiting for the deposit', next: ['Review the quote', `/agreement?job=${id}`] }, links: [] },
    ]);
    page = await openDeposit(id, failed);
    try {
      expect([waitNote(page), shown(page.document, 'pay-btn'), text(page.document, 'pay-btn'), shown(page.document, 'rails')]).toEqual([null, true, 'Pay $128.75 with your wallet', true]);
    } finally { await page.close(); }
  }, 60_000);

  it('a short balance, its payments read answering 503: /staged keeps its lede, its choices and its clock', async () => {
    const id = await hire('remainder');
    await shortPay(id, 'remainder');
    const page = await openStaged(id, fail503(`/jobs/${id}/payments`));
    try {
      await wait(200);
      expect([waitNote(page), text(page.document, 'lede'), text(page.document, 'pay-btn'), shown(page.document, 'choices-section'), text(page.document, 'clock-days')]).toEqual([null, 'Staged on October 6, 2026. Pay the balance and the pull request opens on your repository.', 'Pay the balance, $386.25', true, '7 days to decide, until October 13, 2026.']);
    } finally { await page.close(); }
  }, 30_000);
});

// ------------------------------------------------------------------ (i) real Chrome

// Sideways scroll, controls under 44px on a phone, and the contrast of every text node in
// the measured regions: each ancestor's background colour, then its background gradients'
// every colour stop, composited over the paper beneath, keeping each stop as a separate
// candidate so the worst one decides. The shared .pane and .a-pin fills are such gradients
// (two white stops at 2.8% and 5.5%), and so is the root's floodlight. Anything else the
// arithmetic cannot account for (an image that is not a gradient, an opacity under 1 on
// the way up once every reveal has finished) is reported.
const MEASURE = (regions: string) => `(function () {
  function parse(s) { var m = /^rgba?\\(([^)]*)\\)$/.exec(s); if (!m) return null; var p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(parseFloat); return [p[0] / 255, p[1] / 255, p[2] / 255, p.length > 3 ? p[3] : 1]; }
  function over(t, u) { return [t[0] * t[3] + u[0] * (1 - t[3]), t[1] * t[3] + u[1] * (1 - t[3]), t[2] * t[3] + u[2] * (1 - t[3]), 1]; }
  function stops(img) { if (/url\\(/.test(img) || !/^(\\s*,?\\s*((linear|radial)-gradient\\((?:[^()]|\\([^()]*\\))*\\)|none))+$/.test(img)) return null; return (img.match(/rgba?\\([^)]*\\)/g) || []).map(parse); }
  function lum(c) { function ch(v) { return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); } return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]); }
  var bad = [], low = [], small = [], texts = 0, controls = 0, worstSeen = Infinity, phone = innerWidth < 760;
  [].forEach.call(document.querySelectorAll(${JSON.stringify(regions)}), function (region) {
    var walk = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
    for (var n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!/\\S/.test(n.nodeValue)) continue;
      var host = n.parentElement, r = host.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      var chain = []; for (var e = host; e; e = e.parentElement) chain.unshift(e);
      var papers = [[1, 1, 1, 1]];
      chain.forEach(function (el) {
        var cs = getComputedStyle(el), b = parse(cs.backgroundColor);
        if (parseFloat(cs.opacity) < 1) bad.push(el.tagName + '.' + el.className + ' opacity');
        if (b) papers = papers.map(function (p) { return over(b, p); });
        if (cs.backgroundImage !== 'none') {
          var s = stops(cs.backgroundImage);
          if (s === null || s.indexOf(null) !== -1) bad.push(el.tagName + '.' + el.className + ' image');
          else papers = [].concat.apply([], papers.map(function (p) { return s.map(function (c) { return over(c, p); }); }));
        }
      });
      var color = parse(getComputedStyle(host).color) || [0, 0, 0, 1], px = parseFloat(getComputedStyle(host).fontSize), worst = Infinity;
      papers.forEach(function (paper) { var a = lum(over(color, paper)), b2 = lum(paper); worst = Math.min(worst, (Math.max(a, b2) + 0.05) / (Math.min(a, b2) + 0.05)); });
      texts += 1;
      worstSeen = Math.min(worstSeen, worst);
      if (worst < (px >= 24 ? 3 : 4.5)) low.push(n.nodeValue.trim().slice(0, 30) + ' ' + worst.toFixed(2));
    }
    [].forEach.call(region.querySelectorAll('a, button'), function (c) { var q = c.getBoundingClientRect(); if (!q.width) return; controls += 1; if (phone && (q.width < 44 || q.height < 44)) small.push(c.textContent.trim() + ' ' + Math.round(q.width) + 'x' + Math.round(q.height)); });
  });
  return { scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth, texts: texts, controls: controls, low: low, small: small, bad: bad.filter(function (v, i, a) { return a.indexOf(v) === i; }),
    worst: worstSeen === Infinity ? null : Math.round(worstSeen * 100) / 100,
    alert: (function (a) { return a && !a.hidden ? a.querySelector('p').textContent : null; })(document.getElementById('short-error')) };
})()`;
interface Measure { scroll: number; texts: number; controls: number; low: string[]; small: string[]; bad: string[]; worst: number | null; alert: string | null }
const captureDir = process.env.B2C3_CAPTURE_DIR ?? '';

describe('(i) in real Chrome at 320, 390 and 1280', () => {
  it.each([[320], [390], [1280]] as const)('%ipx: /operatorjob with the panel and with a refusal, the owner\u2019s thread line, /deposit and /staged waiting', async (width) => {
    if (!hasRealBrowser()) { console.warn('no Chrome found; skipping (see CHROME_BIN)'); return; }
    // The payments are made under the frozen clock, so each lands after its hold; the
    // browsers then run on the real one.
    const deposit = await hire('deposit');
    await shortPay(deposit, 'deposit');
    const balance = await hire('remainder');
    await shortPay(balance, 'remainder');
    // The refusal is a real one: a second short row on the same leg, so the press answers
    // the more-than-one 409.
    const refused = await hire('deposit');
    await shortPay(refused, 'deposit');
    await h.shorts.record(shortRow(refused, 'c', 'any-lock'));
    vi.useRealTimers();
    const look = async (who: Session, path: string, regions: string, name: string, before?: string): Promise<Measure> => {
      const b = await RealBrowser.launch({ width, height: 800 });
      try {
        if (width < 760) {
          await b.send('Emulation.setDeviceMetricsOverride', { width, height: 740, deviceScaleFactor: 2, mobile: true });
          await b.send('Emulation.setTouchEmulationEnabled', { enabled: true });
        }
        await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(who))});` });
        await b.goto(`${h.baseUrl}${path}`, 1800);
        if (before) { await b.evaluate(before); await wait(900); }
        await b.evaluate(`(document.querySelector(${JSON.stringify(regions.split(',')[0])}) || document.body).scrollIntoView({ block: 'center' })`);
        // ui.js reveals what scrolls into view; measure once nothing is mid-fade.
        for (let i = 0; i < 40 && (await b.evaluate<boolean>(`[].some.call(document.querySelectorAll('.reveal, .stagger > *'), function (e) { return parseFloat(getComputedStyle(e).opacity) < 1; })`)); i += 1) await wait(100);
        if (captureDir) {
          mkdirSync(captureDir, { recursive: true });
          const png = (await b.send('Page.captureScreenshot', { format: 'png' })) as { result?: { data?: string } };
          if (png.result?.data) writeFileSync(join(captureDir, `${name}-${width}.png`), Buffer.from(png.result.data, 'base64'));
        }
        return await b.evaluate<Measure>(MEASURE(regions));
      } finally { await b.close(); }
    };
    const press = `document.getElementById('short-accept-btn').click()`;
    const all: Array<[string, Measure]> = [
      ['panel', await look(h.owner, `/operatorjob?job=${deposit}`, '#short-panel, #money-facts, .glow', 'operatorjob-panel')],
      ['messages', await look(h.owner, `/messages?job=${deposit}`, '.thread .event, .a-pin', 'messages-owner-line')],
      ['deposit', await look(h.buyer, `/deposit?job=${deposit}`, '#short-wait', 'deposit-waiting')],
      ['staged', await look(h.buyer, `/staged?job=${balance}`, '#short-wait', 'staged-waiting')],
      ['refusal', await look(h.owner, `/operatorjob?job=${refused}`, '#short-panel', 'operatorjob-refusal', press)],
    ];
    console.log(`${width}: ${JSON.stringify(all)}`);
    if (captureDir) writeFileSync(join(captureDir, `measure-${width}.json`), JSON.stringify(all, null, 1));
    for (const [name, m] of all) {
      expect({ name, scroll: m.scroll, low: m.low, small: m.small, bad: m.bad }).toEqual({ name, scroll: 0, low: [], small: [], bad: [] });
      expect(m.texts, `${name}: text measured`).toBeGreaterThan(0);
      expect(m.controls, `${name}: controls measured`).toBeGreaterThan(0);
    }
    expect(all.find(([n]) => n === 'refusal')![1].alert).toBe('More than one payment on this leg waits on your answer, so none can be accepted here. Message the hirer.');
  }, 180_000);
});
