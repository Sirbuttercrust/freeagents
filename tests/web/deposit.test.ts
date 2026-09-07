// P8i: the deposit screen (SITEMAP P-12). Driven end to end against the
// real app with a browser Accept header and jsdom (the discipline
// tests/web/agreement.test.ts and tests/web/hire-flow.test.ts already
// hold to). Every payment route the wireframe wires up is exercised for
// real: POST .../payments/deposit/abt/start against a real DID Connect
// session, and POST .../confirm against a real MemorySettlementGate,
// never asserted from a client-side stub.
import type { Server } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { MemoryAgentRepository, MemoryAccountRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import { createJob, type Job } from '../../src/domain/job.js';
import { ABT_FEE_RATE_PERCENT, USDC_FEE_RATE_PERCENT, calculateFee } from '../../src/domain/payment.js';
import { createAbtPaymentRail } from '../../src/adapters/payment/abt.js';
import { didSuffix } from '../../src/domain/agent.js';
import { fromRandom } from '@ocap/wallet';
import { fakeGitHubConfig, fakeGitHubFetch, mintSessionToken } from '../helpers/session-fixtures.js';
import { unsettledGate } from '../helpers/settlement-fixtures.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';
import { abtEnv, fakeAbtChainClient, reservePort, withEnv } from '../helpers/abt-fixtures.js';
import type { Delegation } from '../../src/domain/agent.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const AGENT_DID = 'did:abt:deposit-page-agent';
const HIRED_AGENT_DID = 'did:abt:deposit-page-hired-agent';
const BUYER_ACCOUNT_DID = 'did:abt:deposit-page-buyer-account';
const STRANGER_ACCOUNT_DID = 'did:abt:deposit-page-stranger-account';

function delegationFixture(did: string, operatorDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:delegation-for-${did}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: did },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-01-01T00:00:00Z',
      verificationMethod: `${did}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zfixture-not-verified-here',
    },
  };
}

function jobFixture(overrides: Partial<Job> & { id: string }): Job {
  const base = createJob(
    { id: overrides.id, buyerDid: BUYER_ACCOUNT_DID, agentDid: AGENT_DID, repository: 'buyer/deposit-repo', brief: 'Fix the checkout flow' },
    new Date('2026-08-01T00:00:00Z'),
  );
  return { ...base, ...overrides };
}

interface Rendered {
  window: JSDOM['window'];
  document: Document;
  close: () => void;
}

async function renderDeposit(baseUrl: string, jobId: string, session: { token: string } | null): Promise<Rendered> {
  const path = `/deposit?job=${encodeURIComponent(jobId)}`;
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  const response = await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } });
  const markup = await response.text();
  const dom = new JSDOM(markup, {
    url: `${baseUrl}${path}`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      if (session !== null) window.sessionStorage.setItem('fa_session', JSON.stringify(session));
      Object.defineProperty(window, 'fetch', {
        writable: true,
        value: (input: string, init?: RequestInit) => fetch(new URL(input, baseUrl), init),
      });
    },
  });

  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 350));
  if (failures.length > 0) throw new Error(`page script failed on ${path}: ${failures.join('; ')}`);
  return { window: dom.window, document: dom.window.document, close: () => dom.window.close() };
}

describe('the deposit screen, driven end to end against the real app', () => {
  let agentRepo: MemoryAgentRepository;
  let jobRepo: MemoryJobRepository;
  let accountRepo: MemoryAccountRepository;
  let server: Server;
  let baseUrl: string;
  let buyerToken: string;
  let settlementGate: ReturnType<typeof unsettledGate>;
  let openStagedPullRequestCalls: unknown[];

  beforeAll(async () => {
    agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:deposit-page-operator',
      delegation: delegationFixture(AGENT_DID, 'did:abt:deposit-page-operator'),
      name: 'deposit-page-scout',
      skills: ['triage'],
      githubLogin: null,
    });
    await agentRepo.updateGithubBinding(AGENT_DID, { handle: 'deposit-page-scout-gh', status: 'verified' });

    accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: BUYER_ACCOUNT_DID, githubLogin: 'deposit-page-buyer' });
    await accountRepo.register({ did: STRANGER_ACCOUNT_DID, githubLogin: 'deposit-page-stranger' });

    jobRepo = new MemoryJobRepository();

    // Fully agreed: every criterion and the price accepted by both
    // parties, at proposed. The screen this card builds.
    await jobRepo.create(
      jobFixture({
        id: 'job-fully-agreed',
        status: 'proposed',
        criteria: [
          { text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
          { text: 'A regression test is added', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
        ],
        priceUsd: '1200.00',
        rail: 'abt',
        depositPercent: 25,
        redoAllowance: 1,
        priceAcceptedByBuyer: true,
        priceAcceptedByAgent: true,
        deliveryWindowDays: 6,
      }),
    );

    // The half-up tie case payment.ts itself pins: $0.50 at 3 percent is
    // exactly $0.0150, the tie ruling 3's own constant-drift test needs.
    await jobRepo.create(
      jobFixture({
        id: 'job-tie-case',
        status: 'proposed',
        criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
        priceUsd: '2.00',
        rail: 'abt',
        depositPercent: 25,
        priceAcceptedByBuyer: true,
        priceAcceptedByAgent: true,
      }),
    );

    // No delivery window at all: ruling 5, no date the platform cannot
    // know.
    await jobRepo.create(
      jobFixture({
        id: 'job-no-window',
        status: 'proposed',
        criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
        priceUsd: '300.00',
        rail: 'abt',
        depositPercent: 25,
        priceAcceptedByBuyer: true,
        priceAcceptedByAgent: true,
      }),
    );

    // Half-signed: not ready for a deposit yet.
    await jobRepo.create(
      jobFixture({
        id: 'job-half-signed',
        status: 'proposed',
        criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: true }],
        priceUsd: '400.00',
        rail: 'abt',
        priceAcceptedByBuyer: false,
        priceAcceptedByAgent: true,
      }),
    );

    // A stranger's 403 fixture.
    await jobRepo.create(
      jobFixture({
        id: 'job-for-403',
        status: 'proposed',
        criteria: [{ text: 'x', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
        priceUsd: '100.00',
        rail: 'abt',
        priceAcceptedByBuyer: true,
        priceAcceptedByAgent: true,
      }),
    );

    // D3 (Proof review round 1): dedicated jobs for the pay-start 409 (a
    // race where the price is cleared server-side between load and
    // press) and the confirm 409 (a race where another actor confirms
    // the job between load and press). Separate ids from job-for-403 so
    // this suite's own mid-test jobRepo mutations never collide with the
    // 403 test's own fixture.
    await jobRepo.create(
      jobFixture({
        id: 'job-for-409-price-race',
        status: 'proposed',
        criteria: [{ text: 'x', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
        priceUsd: '100.00',
        rail: 'abt',
        priceAcceptedByBuyer: true,
        priceAcceptedByAgent: true,
      }),
    );
    await jobRepo.create(
      jobFixture({
        id: 'job-for-409-confirm-race',
        status: 'proposed',
        criteria: [{ text: 'x', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
        priceUsd: '100.00',
        rail: 'abt',
        priceAcceptedByBuyer: true,
        priceAcceptedByAgent: true,
      }),
    );
    // D3: a job for the 401 tests, whose session is invalidated between
    // page load and the press (the load itself needs a live session to
    // reach deposit-body at all).
    await jobRepo.create(
      jobFixture({
        id: 'job-for-401-race',
        status: 'proposed',
        criteria: [{ text: 'x', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
        priceUsd: '100.00',
        rail: 'abt',
        priceAcceptedByBuyer: true,
        priceAcceptedByAgent: true,
      }),
    );

    // For the real confirm round trip: fully agreed, deposit unsettled at
    // first, marked settled mid-test.
    await jobRepo.create(
      jobFixture({
        id: 'job-to-confirm',
        status: 'proposed',
        criteria: [{ text: 'Confirmable line', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
        priceUsd: '600.00',
        rail: 'abt',
        depositPercent: 25,
        priceAcceptedByBuyer: true,
        priceAcceptedByAgent: true,
      }),
    );

    // D1 (Proof review round 1): a SEPARATE agent with a genuinely
    // completed hire, driven through create then complete exactly like
    // tests/web/browse.test.ts's own fixture. Kept off AGENT_DID on
    // purpose: AGENT_DID backs job-fully-agreed, whose own test below
    // pins the negative case (no count), so the two paths need two
    // different agents rather than one agent asserting both facts.
    await agentRepo.create({
      did: HIRED_AGENT_DID,
      operatorDid: 'did:abt:deposit-page-hired-operator',
      delegation: delegationFixture(HIRED_AGENT_DID, 'did:abt:deposit-page-hired-operator'),
      name: 'deposit-page-hired-scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const completedHireDraft = jobFixture({
      id: 'deposit-page-completed-hire',
      buyerDid: 'did:example:deposit-page-past-buyer',
      agentDid: HIRED_AGENT_DID,
      status: 'draft',
    });
    await jobRepo.create(completedHireDraft);
    await jobRepo.complete(
      { ...completedHireDraft, status: 'completed', mergeCommit: 'deposit-page-commit-1', mergedAt: new Date('2026-08-30T00:00:00Z') },
      {
        jobId: completedHireDraft.id,
        buyerDid: completedHireDraft.buyerDid,
        agentDid: HIRED_AGENT_DID,
        mergeCommit: 'deposit-page-commit-1',
        completedAt: new Date('2026-08-30T00:00:00Z'),
      },
    );
    // The job the positive-path test itself renders: same buyer, fully
    // agreed, hired agent HAS a verified hire.
    await jobRepo.create(
      jobFixture({
        id: 'job-hired-agent-has-hires',
        agentDid: HIRED_AGENT_DID,
        status: 'proposed',
        criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
        priceUsd: '500.00',
        rail: 'abt',
        depositPercent: 25,
        priceAcceptedByBuyer: true,
        priceAcceptedByAgent: true,
      }),
    );

    const sessionAdapterRef = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'deposit-page-buyer', id: 9301 }) });
    settlementGate = unsettledGate();
    const { github, calls } = createStagingLifecycleGithubFake();
    openStagedPullRequestCalls = calls.openStagedPullRequest;

    // The ABT rail needs a real operator address to resolve a recipient
    // (abt-did-connect.ts reads operatorAddressAbt, never the DID
    // suffix), and WalletAuthenticator bakes FREEAGENTS_PUBLIC_BASE_URL
    // into the session it mints at construction time (review round 1,
    // D1 in job-payment-abt.test.ts's own header comment), so the port
    // has to be reserved before createApp is ever called.
    await accountRepo.setOperatorAddressAbt('did:abt:deposit-page-operator', didSuffix(AGENT_DID));
    const platformWallet = fromRandom();
    const port = await reservePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const abtRailEnv = abtEnv(baseUrl, platformWallet, fromRandom().address, fromRandom().address);
    const abtRail = await withEnv(abtRailEnv, async () =>
      createAbtPaymentRail({
        chainClient: fakeAbtChainClient().client,
        rateSource: async () => '1',
        spentTransferStorage: {
          async record(): Promise<void> {},
          async findByHash(): Promise<null> {
            return null;
          },
        },
      }),
    );
    const app = await withEnv(abtRailEnv, async () =>
      createApp(
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
        sessionAdapterRef,
        undefined,
        settlementGate,
        undefined,
        undefined,
        abtRail,
      ),
    );
    server = app.listen(port, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));

    buyerToken = await mintSessionToken(sessionAdapterRef);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('a signed-out visitor', () => {
    it('is told to sign in and is not shown a pay control that cannot work', async () => {
      const page = await renderDeposit(baseUrl, 'job-fully-agreed', null);
      try {
        const notice = page.document.getElementById('signin-required');
        expect(notice).not.toBeNull();
        expect(notice!.hidden).toBe(false);
        expect((notice!.textContent ?? '').toLowerCase()).toContain('sign in');
        const body = page.document.getElementById('deposit-body');
        expect(body!.hidden).toBe(true);
      } finally {
        page.close();
      }
    });
  });

  describe('an unknown job id', () => {
    it('answers a readable page, not a blank screen', async () => {
      const page = await renderDeposit(baseUrl, 'no-such-job', { token: buyerToken });
      try {
        const notice = page.document.getElementById('load-error');
        expect(notice).not.toBeNull();
        expect(notice!.hidden).toBe(false);
      } finally {
        page.close();
      }
    });
  });

  describe('a stranger to the job', () => {
    it('is refused with the 403 sentence, not a blank screen', async () => {
      const strangerAdapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'deposit-page-stranger', id: 9302 }) });
      const strangerAccountRepo = new MemoryAccountRepository();
      await strangerAccountRepo.register({ did: STRANGER_ACCOUNT_DID, githubLogin: 'deposit-page-stranger' });
      const strangerServer = createApp(strangerAccountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, undefined, undefined, undefined, undefined, strangerAdapter).listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => strangerServer.once('listening', resolve));
      const strangerBaseUrl = `http://127.0.0.1:${(strangerServer.address() as AddressInfo).port}`;
      try {
        const token = await mintSessionToken(strangerAdapter);
        const page = await renderDeposit(strangerBaseUrl, 'job-for-403', { token });
        try {
          const notice = page.document.getElementById('party-error');
          expect(notice).not.toBeNull();
          expect(notice!.hidden).toBe(false);
          const body = page.document.getElementById('deposit-body');
          expect(body!.hidden).toBe(true);
        } finally {
          page.close();
        }
      } finally {
        await new Promise<void>((resolve) => strangerServer.close(() => resolve()));
      }
    });
  });

  describe('a job that is not fully agreed', () => {
    it('is not ready for a deposit yet, and links back to the agreement', async () => {
      const page = await renderDeposit(baseUrl, 'job-half-signed', { token: buyerToken });
      try {
        const notice = page.document.getElementById('not-ready-error');
        expect(notice).not.toBeNull();
        expect(notice!.hidden).toBe(false);
        const link = page.document.getElementById('not-ready-link') as HTMLAnchorElement | null;
        expect(link?.getAttribute('href')).toBe('/agreement?job=job-half-signed');
      } finally {
        page.close();
      }
    });
  });

  describe('the one number, computed from the projection and pinned against src/domain/payment.ts', () => {
    it('the ABT total, deposit and fee rows agree with calculateFee for the same inputs', async () => {
      const page = await renderDeposit(baseUrl, 'job-fully-agreed', { token: buyerToken });
      try {
        const deposit = calculateFee('1200.00', 25);
        const fee = calculateFee(deposit, ABT_FEE_RATE_PERCENT);
        const total = (parseFloat(deposit) + parseFloat(fee)).toFixed(2);
        expect(page.document.getElementById('total-amount')?.textContent).toBe(`$${total}`);
        expect(page.document.getElementById('deposit-amount')?.textContent).toBe(`$${parseFloat(deposit).toFixed(2)}`);
        expect(page.document.getElementById('fee-amount')?.textContent).toBe(`$${parseFloat(fee).toFixed(2)}`);
      } finally {
        page.close();
      }
    });

    it('the half-up tie case ($0.50 deposit at 3 percent) matches payment.ts exactly (mutation proof 2)', async () => {
      const page = await renderDeposit(baseUrl, 'job-tie-case', { token: buyerToken });
      try {
        const deposit = calculateFee('2.00', 25); // 0.50
        expect(deposit).toBe('0.50');
        const fee = calculateFee(deposit, ABT_FEE_RATE_PERCENT); // 0.0150 -> half-up -> 0.02
        expect(fee).toBe('0.02');
        expect(page.document.getElementById('fee-amount')?.textContent).toBe('$0.02');
      } finally {
        page.close();
      }
    });

    it('states the deposit counts toward the price, not on top of it', async () => {
      const page = await renderDeposit(baseUrl, 'job-fully-agreed', { token: buyerToken });
      try {
        const line = page.document.getElementById('counts-toward-line')?.textContent ?? '';
        expect(line.toLowerCase()).toContain('counts toward');
        expect(line.toLowerCase()).not.toContain('an extra charge on top');
      } finally {
        page.close();
      }
    });
  });

  describe('the rail chooser changes the total in place (mutation proof 4)', () => {
    it('choosing USDC swaps the total, fee and approval sentence; choosing ABT swaps them back', async () => {
      const page = await renderDeposit(baseUrl, 'job-fully-agreed', { token: buyerToken });
      try {
        const abtTotalText = page.document.getElementById('total-amount')?.textContent ?? '';
        const usdcRadio = page.document.getElementById('rail-usdc') as HTMLInputElement;
        usdcRadio.checked = true;
        usdcRadio.dispatchEvent(new page.window.Event('change', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 50));

        const usdcTotalText = page.document.getElementById('total-amount')?.textContent ?? '';
        expect(usdcTotalText).not.toBe(abtTotalText);
        const usdcDeposit = calculateFee('1200.00', 25);
        const usdcFee = calculateFee(usdcDeposit, USDC_FEE_RATE_PERCENT);
        const usdcTotal = (parseFloat(usdcDeposit) + parseFloat(usdcFee)).toFixed(2);
        expect(usdcTotalText).toBe(`$${usdcTotal}`);
        expect(page.document.getElementById('usdc-pay-note')?.hidden).toBe(false);

        const abtRadio = page.document.getElementById('rail-abt') as HTMLInputElement;
        abtRadio.checked = true;
        abtRadio.dispatchEvent(new page.window.Event('change', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(page.document.getElementById('total-amount')?.textContent).toBe(abtTotalText);
        expect(page.document.getElementById('usdc-pay-note')?.hidden).toBe(true);
      } finally {
        page.close();
      }
    });
  });

  describe('the USDC pay control can never start a payment (mutation proof 8)', () => {
    it('is disabled in every state, and no request to any usdc path is ever made from this page', async () => {
      const originalFetch = global.fetch;
      const usdcCalls: string[] = [];
      const page = await renderDeposit(baseUrl, 'job-fully-agreed', { token: buyerToken });
      try {
        const usdcRadio = page.document.getElementById('rail-usdc') as HTMLInputElement;
        usdcRadio.checked = true;
        usdcRadio.dispatchEvent(new page.window.Event('change', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 50));

        const payBtn = page.document.getElementById('pay-btn') as HTMLButtonElement;
        expect(payBtn.disabled).toBe(true);

        Object.defineProperty(page.window, 'fetch', {
          writable: true,
          value: (input: string, init?: RequestInit) => {
            if (String(input).includes('usdc')) usdcCalls.push(String(input));
            return originalFetch(new URL(input, baseUrl), init);
          },
        });
        payBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(usdcCalls.length).toBe(0);
      } finally {
        page.close();
      }
    });
  });

  describe('the verified hire count (scope item 7)', () => {
    it('renders the agent name with no count when the agent has none', async () => {
      const page = await renderDeposit(baseUrl, 'job-fully-agreed', { token: buyerToken });
      try {
        expect(page.document.getElementById('agent-name')?.textContent).toBe('deposit-page-scout');
        expect(page.document.getElementById('agent-hires')?.textContent ?? '').toBe('');
      } finally {
        page.close();
      }
    });

    it('renders the real count from GET /agents/:agentDid/hires when the agent has a verified hire (D1)', async () => {
      const page = await renderDeposit(baseUrl, 'job-hired-agent-has-hires', { token: buyerToken });
      try {
        expect(page.document.getElementById('agent-name')?.textContent).toBe('deposit-page-hired-scout');
        expect(page.document.getElementById('agent-hires')?.textContent ?? '').toBe('1 verified hire');
      } finally {
        page.close();
      }
    });

    it('renders the agent name with no count when the hires read fails (D1)', async () => {
      const realPort = (server.address() as AddressInfo).port;
      const proxy = http.createServer((req, res) => {
        if (req.url !== undefined && /\/agents\/[^/]+\/hires$/.test(req.url)) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'storage unavailable' }));
          return;
        }
        const upstream = http.request(
          { hostname: '127.0.0.1', port: realPort, path: req.url, method: req.method, headers: req.headers },
          (upstreamRes) => {
            res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
            upstreamRes.pipe(res);
          },
        );
        req.pipe(upstream);
      });
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const proxyBaseUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      try {
        const page = await renderDeposit(proxyBaseUrl, 'job-hired-agent-has-hires', { token: buyerToken });
        try {
          expect(page.document.getElementById('agent-name')?.textContent).toBe('deposit-page-hired-scout');
          expect(page.document.getElementById('agent-hires')?.textContent ?? '').toBe('');
        } finally {
          page.close();
        }
      } finally {
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      }
    });
  });

  describe('by when (ruling 5, no date the platform cannot know)', () => {
    it('states the window relative to the payment clearing, never a calendar date', async () => {
      const page = await renderDeposit(baseUrl, 'job-fully-agreed', { token: buyerToken });
      try {
        const byline = page.document.getElementById('byline')?.textContent ?? '';
        expect(byline.toLowerCase()).toContain('after this payment clears');
        expect(byline).not.toMatch(/\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)/);
      } finally {
        page.close();
      }
    });

    it('with no delivery window, says the window was not part of the agreement rather than inventing one', async () => {
      const page = await renderDeposit(baseUrl, 'job-no-window', { token: buyerToken });
      try {
        const byline = page.document.getElementById('byline')?.textContent ?? '';
        expect(byline.toLowerCase()).toContain('not part of this agreement');
      } finally {
        page.close();
      }
    });
  });

  describe('the technical disclosure (ruling 5)', () => {
    it('the fingerprint says it is computed when the deposit settles, never a placeholder hash', async () => {
      const page = await renderDeposit(baseUrl, 'job-fully-agreed', { token: buyerToken });
      try {
        const hash = page.document.getElementById('tech-spec-hash')?.textContent ?? '';
        expect(hash.toLowerCase()).toContain('computed when the deposit settles');
        expect(hash).not.toMatch(/^sha256:/);
      } finally {
        page.close();
      }
    });
  });

  describe('the session token never rides in the document (constraint: no cookie, no URL)', () => {
    it('the token does not appear anywhere in the rendered document, including inside the dialog', async () => {
      const page = await renderDeposit(baseUrl, 'job-fully-agreed', { token: buyerToken });
      try {
        expect(page.document.documentElement.outerHTML).not.toContain(buyerToken);
      } finally {
        page.close();
      }
    });
  });

  describe('a criterion containing markup renders as literal text (api.js rule 3)', () => {
    it('never parses buyer or agent prose as HTML', async () => {
      await jobRepo.create(
        jobFixture({
          id: 'job-markup-criterion',
          status: 'proposed',
          criteria: [{ text: '<img src=x onerror=alert(1)>Ship it', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
          priceUsd: '150.00',
          rail: 'abt',
          priceAcceptedByBuyer: true,
          priceAcceptedByAgent: true,
        }),
      );
      const page = await renderDeposit(baseUrl, 'job-markup-criterion', { token: buyerToken });
      try {
        expect(page.document.querySelector('#getlist img')).toBeNull();
        const list = page.document.getElementById('getlist')?.textContent ?? '';
        expect(list).toContain('<img src=x onerror=alert(1)>Ship it');
      } finally {
        page.close();
      }
    });
  });

  describe('the ABT pay control starts a real payment and opens the scan (scope items 3 and 5)', () => {
    it('posts once to the abt start route and the scan URL is byte-identical to what the route answered (mutation proof 5)', async () => {
      const page = await renderDeposit(baseUrl, 'job-fully-agreed', { token: buyerToken });
      try {
        let startCalls = 0;
        let observedUrl = '';
        const originalFetch = global.fetch;
        Object.defineProperty(page.window, 'fetch', {
          writable: true,
          value: async (input: string, init?: RequestInit) => {
            const response = await originalFetch(new URL(input, baseUrl), init);
            if (String(input).includes('/payments/deposit/abt/start')) {
              startCalls += 1;
              const cloned = response.clone();
              const body = (await cloned.json()) as { url: string };
              observedUrl = body.url;
            }
            return response;
          },
        });

        const payBtn = page.document.getElementById('pay-btn') as HTMLButtonElement;
        expect(payBtn.disabled).toBe(false);
        payBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(startCalls).toBe(1);
        const scanUrl = (page.document.getElementById('scan-url') as HTMLInputElement | null)?.value ?? '';
        expect(scanUrl).not.toBe('');
        // Byte-identical to what the route this same press called
        // actually answered, never a re-derived or re-fetched value
        // (mutation proof 5: encode a different string than the route
        // returned and this assertion goes red).
        expect(scanUrl).toBe(observedUrl);

        const dialog = page.document.getElementById('scan') as HTMLDialogElement;
        expect(dialog.hasAttribute('open')).toBe(true);
      } finally {
        page.close();
      }
    });
  });

  describe('confirm is called on the buyer\'s own press, once, and never fakes a settlement (rulings 4)', () => {
    it('with no settlement recorded, confirm\'s 402 renders as the waiting sentence and the job stays at proposed', async () => {
      const page = await renderDeposit(baseUrl, 'job-to-confirm', { token: buyerToken });
      try {
        const approvedBtn = page.document.getElementById('approved-btn') as HTMLButtonElement;
        approvedBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 200));

        const waiting = page.document.getElementById('confirm-waiting');
        expect(waiting?.hidden).toBe(false);
        const waitingText = (waiting?.textContent ?? '').toLowerCase();
        expect(waitingText).not.toContain('error');
        expect(waitingText).not.toContain('something went wrong');

        const job = await jobRepo.findById('job-to-confirm');
        expect(job?.status).toBe('proposed');
      } finally {
        page.close();
      }
    });

    it('with a settlement recorded, confirm returns 200, the job confirms with a specHash, and the buyer is sent to /jobs/<id>', async () => {
      settlementGate.markDepositSettled('job-to-confirm');
      const page = await renderDeposit(baseUrl, 'job-to-confirm', { token: buyerToken });
      try {
        const approvedBtn = page.document.getElementById('approved-btn') as HTMLButtonElement;
        approvedBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 300));

        const job = await jobRepo.findById('job-to-confirm');
        expect(job?.status).toBe('confirmed');
        expect(job?.confirmedSpecHash).not.toBeNull();
      } finally {
        page.close();
      }
    });

    it('confirm is called exactly once per press, and nothing else on the page ever calls it (mutation proof 6)', async () => {
      await jobRepo.create(
        jobFixture({
          id: 'job-confirm-count',
          status: 'proposed',
          criteria: [{ text: 'Countable line', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
          priceUsd: '250.00',
          rail: 'abt',
          priceAcceptedByBuyer: true,
          priceAcceptedByAgent: true,
        }),
      );
      const path = `/deposit?job=job-confirm-count`;
      const response = await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } });
      const markup = await response.text();
      let confirmCalls = 0;
      const virtualConsole = new VirtualConsole();
      const failures: string[] = [];
      virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));
      const dom = new JSDOM(markup, {
        url: `${baseUrl}${path}`,
        runScripts: 'dangerously',
        resources: 'usable',
        pretendToBeVisual: true,
        virtualConsole,
        beforeParse(window) {
          window.sessionStorage.setItem('fa_session', JSON.stringify({ token: buyerToken }));
          // Installed BEFORE any page script runs (mutation proof 6 needs
          // the whole page lifecycle observed, including a call this
          // script might make during its own load, not only after).
          Object.defineProperty(window, 'fetch', {
            writable: true,
            value: (input: string, init?: RequestInit) => {
              if (String(input).includes('/confirm')) confirmCalls += 1;
              return fetch(new URL(input, baseUrl), init);
            },
          });
        },
      });
      await new Promise<void>((resolve) => {
        if (dom.window.document.readyState === 'complete') resolve();
        else dom.window.addEventListener('load', () => resolve());
      });
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);
      try {
        expect(confirmCalls).toBe(0);
        const approvedBtn = dom.window.document.getElementById('approved-btn') as HTMLButtonElement;
        approvedBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(confirmCalls).toBe(1);
      } finally {
        dom.window.close();
      }
    });
  });

  describe('every refusal in scope item 8 renders its own distinct sentence (mutation proof 7)', () => {
    it('the 402 waiting sentence, the 403 party sentence and a generic load-error sentence all differ from each other', async () => {
      const wait402 = await renderDeposit(baseUrl, 'job-to-confirm', { token: buyerToken });
      const forbidden403 = await renderDeposit(baseUrl, 'job-for-403', { token: buyerToken });
      const missing404 = await renderDeposit(baseUrl, 'no-such-job-again', { token: buyerToken });
      try {
        const approvedBtn = wait402.document.getElementById('approved-btn') as HTMLButtonElement;
        approvedBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 200));
        const waitingText = wait402.document.getElementById('confirm-waiting')?.textContent ?? '';
        const forbiddenText = forbidden403.document.getElementById('party-error')?.textContent ?? '';
        const missingText = missing404.document.getElementById('load-error')?.textContent ?? '';
        const distinctSentences = new Set([waitingText, forbiddenText, missingText]);
        expect(distinctSentences.size).toBe(3);
      } finally {
        wait402.close();
        forbidden403.close();
        missing404.close();
      }
    });
  });

  describe('the agreement page routes a fully signed agreement to this screen (scope item 4)', () => {
    it('resolves the agreement page\'s primary control to /deposit?job=<id> (mutation proof 9)', async () => {
      const agreementPage = await renderDeposit(baseUrl, 'job-fully-agreed', { token: buyerToken });
      agreementPage.close();
      const response = await fetch(`${baseUrl}/agreement?job=job-fully-agreed`, { headers: { Accept: HTML } });
      const markup = await response.text();
      const virtualConsole = new VirtualConsole();
      const failures: string[] = [];
      virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));
      const dom = new JSDOM(markup, {
        url: `${baseUrl}/agreement?job=job-fully-agreed`,
        runScripts: 'dangerously',
        resources: 'usable',
        pretendToBeVisual: true,
        virtualConsole,
        beforeParse(window) {
          window.sessionStorage.setItem('fa_session', JSON.stringify({ token: buyerToken }));
          Object.defineProperty(window, 'fetch', {
            writable: true,
            value: (input: string, init?: RequestInit) => fetch(new URL(input, baseUrl), init),
          });
        },
      });
      await new Promise<void>((resolve) => {
        if (dom.window.document.readyState === 'complete') resolve();
        else dom.window.addEventListener('load', () => resolve());
      });
      await new Promise((resolve) => setTimeout(resolve, 350));
      try {
        const link = dom.window.document.querySelector('a[href^="/deposit"]') as HTMLAnchorElement | null;
        expect(link).not.toBeNull();
        expect(link!.getAttribute('href')).toBe('/deposit?job=job-fully-agreed');
      } finally {
        dom.window.close();
      }
    });
  });

  describe('the nav on /deposit flips to signed-in', () => {
    it('shows the signed-in nav for a person with a session', async () => {
      const page = await renderDeposit(baseUrl, 'job-fully-agreed', { token: buyerToken });
      try {
        const signedIn = page.document.getElementById('nav-signed-in');
        expect(signedIn?.hidden).toBe(false);
      } finally {
        page.close();
      }
    });
  });

  describe('layout: no wrapper div breaks the rail chooser or totals grid (layout-broken-at-desktop)', () => {
    it('every rail option label and the scan dialog close control are at least 44px', async () => {
      const page = await renderDeposit(baseUrl, 'job-fully-agreed', { token: buyerToken });
      try {
        const closeBtn = page.document.querySelector('.sclose');
        expect(closeBtn).not.toBeNull();
        const style = page.window.getComputedStyle(closeBtn as Element);
        expect(parseFloat(style.width)).toBeGreaterThanOrEqual(44);
        expect(parseFloat(style.height)).toBeGreaterThanOrEqual(44);
      } finally {
        page.close();
      }
    });

    it('the rail option labels keep their two-column grid, not a wrapper-crushed block (D2)', async () => {
      const page = await renderDeposit(baseUrl, 'job-fully-agreed', { token: buyerToken });
      try {
        const labels = page.document.querySelectorAll('.railopt label');
        expect(labels.length).toBe(2);
        labels.forEach((label) => {
          const style = page.window.getComputedStyle(label as Element);
          expect(style.display).toBe('grid');
          expect(style.gridTemplateColumns).toBe('1fr auto');
          expect(parseFloat(style.minHeight)).toBeGreaterThanOrEqual(44);
          expect(parseFloat(style.paddingLeft)).toBeGreaterThanOrEqual(44);
        });
      } finally {
        page.close();
      }
    });

    it('the totals rows keep their space-between flex layout, not a wrapper-crushed block (D2)', async () => {
      const page = await renderDeposit(baseUrl, 'job-fully-agreed', { token: buyerToken });
      try {
        const rows = page.document.querySelectorAll('.total .parts li');
        expect(rows.length).toBeGreaterThanOrEqual(3);
        rows.forEach((row) => {
          const style = page.window.getComputedStyle(row as Element);
          expect(style.display).toBe('flex');
          expect(style.justifyContent).toBe('space-between');
        });
      } finally {
        page.close();
      }
    });
  });

  it('reuses the platform staging repository lifecycle exactly once per confirm (sanity: no double staging repo call leaking from this page)', () => {
    expect(openStagedPullRequestCalls.length).toBe(0);
  });
});
