// P8h: a signed-in buyer opens the agreement for a hire, reads every term
// the agent proposed as one numbered list, signs the lines one at a time,
// and the agreement locks itself when the last mark lands (no confirm
// button, no confirm call, ever).
//
// Driven at the route level over HTTP against the real app, with real
// sessions minted through the sign-in path (jsdom, the discipline
// tests/web/job.test.ts and tests/web/hire-flow.test.ts already hold to),
// never merely asserting the markup shipped (inert-declared-control,
// eighth occurrence).
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { MemoryAgentRepository, MemoryAccountRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import type { JobRepository } from '../../src/adapters/storage/types.js';
import { createJob, type Job, type CompletedJob } from '../../src/domain/job.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSessionToken } from '../helpers/session-fixtures.js';
import type { Delegation } from '../../src/domain/agent.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const AGENT_DID = 'did:abt:agreement-page-agent';
const BUYER_ACCOUNT_DID = 'did:abt:agreement-page-buyer-account';
const STRANGER_ACCOUNT_DID = 'did:abt:agreement-page-stranger-account';

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
    { id: overrides.id, buyerDid: BUYER_ACCOUNT_DID, agentDid: AGENT_DID, repository: 'buyer/agreement-repo', brief: 'Fix the checkout flow' },
    new Date('2026-08-01T00:00:00Z'),
  );
  return { ...base, ...overrides };
}

interface Rendered {
  window: JSDOM['window'];
  document: Document;
  close: () => void;
}

async function renderAgreement(baseUrl: string, jobId: string, session: { token: string } | null): Promise<Rendered> {
  const path = `/agreement?job=${encodeURIComponent(jobId)}`;
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
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (failures.length > 0) throw new Error(`page script failed on ${path}: ${failures.join('; ')}`);
  return { window: dom.window, document: dom.window.document, close: () => dom.window.close() };
}

async function clickMark(page: Rendered, rowIndexInDom: number, whichCell: 'm-you' | 'm-them'): Promise<void> {
  const rows = Array.from(page.document.querySelectorAll('#terms > li'));
  const row = rows[rowIndexInDom];
  if (!row) throw new Error(`no row at DOM index ${rowIndexInDom}`);
  const sigcells = Array.from(row.querySelectorAll('.sigcell'));
  const cell = sigcells[whichCell === 'm-you' ? 0 : 1];
  if (!cell) throw new Error(`no sigcell for ${whichCell} in row ${rowIndexInDom}`);
  const btn = cell.querySelector('button.sig') as HTMLButtonElement | null;
  if (!btn) throw new Error(`no mark button in ${whichCell} of row ${rowIndexInDom}`);
  btn.click();
  await new Promise((resolve) => setTimeout(resolve, 250));
}

async function proposeCriterion(page: Rendered, text: string): Promise<void> {
  const input = page.document.getElementById('newcrit') as HTMLInputElement | null;
  if (!input) throw new Error('no #newcrit input');
  input.value = text;
  const btn = page.document.getElementById('propose-submit') as HTMLButtonElement | null;
  if (!btn) throw new Error('no #propose-submit button');
  btn.click();
  await new Promise((resolve) => setTimeout(resolve, 250));
}

describe('the agreement screen, driven end to end against the real app', () => {
  let agentRepo: MemoryAgentRepository;
  let jobRepo: MemoryJobRepository;
  let accountRepo: MemoryAccountRepository;
  let server: Server;
  let baseUrl: string;
  let buyerToken: string;
  let sessionAdapterRef: ReturnType<typeof createSessionAdapter>;

  beforeAll(async () => {
    agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:agreement-page-operator',
      delegation: delegationFixture(AGENT_DID, 'did:abt:agreement-page-operator'),
      name: 'agreement-page-scout',
      skills: ['triage'],
      githubLogin: null,
    });

    accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: BUYER_ACCOUNT_DID, githubLogin: 'agreement-page-buyer' });
    await accountRepo.register({ did: STRANGER_ACCOUNT_DID, githubLogin: 'agreement-page-stranger' });

    jobRepo = new MemoryJobRepository();

    // A proposed job: two criteria (one already accepted by the buyer, one
    // not), a price the agent has accepted and the buyer has not, and a
    // delivery window sharing the price's acceptance pair.
    await jobRepo.create(
      jobFixture({
        id: 'job-half-signed',
        status: 'proposed',
        criteria: [
          { text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
          { text: 'A regression test is added', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: true },
        ],
        priceUsd: '1200.00',
        rail: 'abt',
        priceAcceptedByBuyer: false,
        priceAcceptedByAgent: true,
        deliveryWindowDays: 6,
      }),
    );

    // Two unaccepted-by-buyer criteria, so clicking one proves the exact
    // index sent rather than an already-true neighbour hiding an
    // off-by-one (mutation proof 2).
    await jobRepo.create(
      jobFixture({
        id: 'job-two-unsigned',
        status: 'proposed',
        criteria: [
          { text: 'First criterion', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: true },
          { text: 'Second criterion', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: true },
        ],
      }),
    );

    // A job with a price but no criteria outstanding for the buyer, used
    // for the price+delivery shared-mark test.
    await jobRepo.create(
      jobFixture({
        id: 'job-price-only',
        status: 'proposed',
        criteria: [{ text: 'Only criterion', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
        priceUsd: '500.00',
        rail: 'usdc',
        priceAcceptedByBuyer: false,
        priceAcceptedByAgent: true,
        deliveryWindowDays: 10,
      }),
    );

    // Fully agreed: locks the outstanding panel into "the deposit is next".
    await jobRepo.create(
      jobFixture({
        id: 'job-fully-agreed',
        status: 'proposed',
        criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
        priceUsd: '300.00',
        rail: 'abt',
        priceAcceptedByBuyer: true,
        priceAcceptedByAgent: true,
        deliveryWindowDays: 3,
      }),
    );

    // A job neither the buyer nor the stranger nor the agent's account
    // (there is none) is a stranger to, for the 403 test.
    await jobRepo.create(jobFixture({ id: 'job-for-403', status: 'proposed', criteria: [{ text: 'x', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: false }] }));

    // For the 409 mutation proof: withdrawn before the buyer ever clicks.
    await jobRepo.create(
      jobFixture({
        id: 'job-to-withdraw',
        status: 'proposed',
        criteria: [{ text: 'Will be withdrawn', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: false }],
      }),
    );

    // Dedicated fixture for the propose test, kept separate from
    // job-half-signed so a mutation here never changes what an earlier
    // or later test in this file reads back for that job.
    await jobRepo.create(
      jobFixture({
        id: 'job-for-propose',
        status: 'proposed',
        criteria: [
          { text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
          { text: 'A regression test is added', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: true },
        ],
      }),
    );

    sessionAdapterRef = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'agreement-page-buyer', id: 9101 }) });

    server = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapterRef).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    buyerToken = await mintSessionToken(sessionAdapterRef);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('a signed-out visitor', () => {
    it('is told to sign in and is not shown marks that cannot work', async () => {
      const page = await renderAgreement(baseUrl, 'job-half-signed', null);
      try {
        const notice = page.document.getElementById('signin-required');
        expect(notice).not.toBeNull();
        expect(notice!.hidden).toBe(false);
        expect((notice!.textContent ?? '').toLowerCase()).toContain('sign in');
        const body = page.document.getElementById('agreement-body');
        expect(body!.hidden).toBe(true);
        expect(body!.querySelectorAll('button.sig').length).toBe(0);
      } finally {
        page.close();
      }
    });
  });

  describe('the who strip and the back link', () => {
    it('the back link reads "Back to brief" and points at the hire page (wireframe agreement.html:251)', async () => {
      const page = await renderAgreement(baseUrl, 'job-half-signed', { token: buyerToken });
      try {
        const back = page.document.getElementById('back-link');
        expect(back?.textContent).toBe('Back to brief');
      } finally {
        page.close();
      }
    });

    it('offers a plain exit to my jobs, "Leave this for now" (wireframe agreement.html:244)', async () => {
      const page = await renderAgreement(baseUrl, 'job-half-signed', { token: buyerToken });
      try {
        const leave = page.document.getElementById('leave-link') as HTMLAnchorElement | null;
        expect(leave).not.toBeNull();
        expect(leave!.textContent).toBe('Leave this for now');
        expect(leave!.getAttribute('href')).toBe('/myjobs');
      } finally {
        page.close();
      }
    });
  });

  describe('the h1 states what the screen is for, and the live agent name renders in the who strip (Group 1 of the wireframe reconcile)', () => {
    it('the h1 is the wireframe\'s static "Agree the terms", never a placeholder built from the agent name', async () => {
      const page = await renderAgreement(baseUrl, 'job-half-signed', { token: buyerToken });
      try {
        const h1 = page.document.querySelector('.pname');
        expect(h1?.textContent).toBe('Agree the terms');
      } finally {
        page.close();
      }
    });

    it('the who strip carries the live agent name once the record loads, never a placeholder or empty string first', async () => {
      const page = await renderAgreement(baseUrl, 'job-half-signed', { token: buyerToken });
      try {
        const name = page.document.getElementById('agent-name');
        expect(name?.textContent).toBe('agreement-page-scout');
        expect(name?.hasAttribute('data-pending')).toBe(false);
      } finally {
        page.close();
      }
    });
  });

  describe('an unknown job id', () => {
    it('answers a readable page, not a blank screen', async () => {
      const page = await renderAgreement(baseUrl, 'no-such-job', { token: buyerToken });
      try {
        const notice = page.document.getElementById('load-error');
        expect(notice).not.toBeNull();
        expect(notice!.hidden).toBe(false);
      } finally {
        page.close();
      }
    });
  });

  describe('the term matrix, driven end to end', () => {
    it('renders one row per criterion plus a price row plus a delivery row, numbered contiguously, with the agent\'s marks shown and the buyer\'s outstanding lines offered as controls', async () => {
      const page = await renderAgreement(baseUrl, 'job-half-signed', { token: buyerToken });
      try {
        const rows = Array.from(page.document.querySelectorAll('#terms > li'));
        expect(rows.length).toBe(4);

        const numbers = rows.map((row) => row.querySelector('.num')?.textContent ?? '');
        expect(numbers).toEqual(['01', '02', '03', '04']);

        function sigcells(row: Element): Element[] {
          return Array.from(row.querySelectorAll('.sigcell'));
        }

        // Row 1: buyer already signed -> a report, no button.
        expect(sigcells(rows[0]!)[0]!.querySelector('button')).toBeNull();
        expect(sigcells(rows[0]!)[0]!.querySelector('.sig.is-signed')).not.toBeNull();
        // Row 2: buyer has not signed -> a real button.
        expect(sigcells(rows[1]!)[0]!.querySelector('button.sig.is-waiting')).not.toBeNull();
        // Every row: the agent's mark is a statement, never a button.
        rows.forEach((row) => {
          expect(sigcells(row)[1]!.querySelector('button')).toBeNull();
        });
        // Row 3 (price) and row 4 (delivery): agent signed, buyer has not.
        expect(sigcells(rows[2]!)[1]!.querySelector('.sig.is-signed')).not.toBeNull();
        expect(sigcells(rows[2]!)[0]!.querySelector('button.sig.is-waiting')).not.toBeNull();
        expect(sigcells(rows[3]!)[1]!.querySelector('.sig.is-signed')).not.toBeNull();
        expect(sigcells(rows[3]!)[0]!.querySelector('button.sig.is-waiting')).not.toBeNull();
        expect(rows[3]!.querySelector('.txt')?.textContent ?? '').toContain('6 days');
      } finally {
        page.close();
      }
    });

    it('the lockbar decodes state into an actionable sentence naming how many signatures wait on the buyer', async () => {
      const page = await renderAgreement(baseUrl, 'job-half-signed', { token: buyerToken });
      try {
        const lockbar = page.document.getElementById('lockbar')?.textContent ?? '';
        expect(lockbar.toLowerCase()).toContain('waiting on you');
        expect(lockbar.toLowerCase()).toContain('3 signatures');
      } finally {
        page.close();
      }
    });

    it('when every line is fully agreed, states so and points at the deposit next, never a status word alone', async () => {
      const page = await renderAgreement(baseUrl, 'job-fully-agreed', { token: buyerToken });
      try {
        const lockbar = page.document.getElementById('lockbar');
        expect(lockbar?.textContent?.toLowerCase()).toContain('fully agreed');
        expect(lockbar?.className).toContain('is-locked');
        const depositRow = page.document.getElementById('deposit-row') as HTMLElement | null;
        expect(depositRow?.hidden).toBe(false);
        expect(page.document.getElementById('deposit-link')?.getAttribute('href')).toBe('/deposit?job=job-fully-agreed');
        expect(page.document.querySelectorAll('#terms button.sig').length).toBe(0);
      } finally {
        page.close();
      }
    });
  });

  describe('the terms list is a single flat grid, not a boxed sub-list', () => {
    it('renders each line as a direct child of the terms grid, with no wrapper element breaking the column layout (layout-broken-at-desktop)', async () => {
      const page = await renderAgreement(baseUrl, 'job-half-signed', { token: buyerToken });
      try {
        expect(page.document.getElementById('terms-body')).toBeNull();
        const grid = page.document.getElementById('terms');
        expect(grid).not.toBeNull();
        const rows = Array.from(page.document.querySelectorAll('#terms > li'));
        expect(rows.length).toBeGreaterThan(0);
        rows.forEach((row) => {
          expect(row.parentElement).toBe(grid);
        });
      } finally {
        page.close();
      }
    });
  });

  describe('the agreement does not claim to lock itself', () => {
    it('the lede states the true sequence: fully agreed, then the deposit, nothing recorded before that', async () => {
      const page = await renderAgreement(baseUrl, 'job-half-signed', { token: buyerToken });
      try {
        const lede = page.document.querySelector('.lede')?.textContent ?? '';
        expect(lede.toLowerCase()).not.toContain('locks by itself');
        expect(lede.toLowerCase()).toContain('deposit settles');
      } finally {
        page.close();
      }
    });

    it('the raw-list disclosure says the fingerprint is computed after the deposit settles, not when the last mark lands', async () => {
      const page = await renderAgreement(baseUrl, 'job-half-signed', { token: buyerToken });
      try {
        const disclosure = page.document.getElementById('rawlist')?.textContent ?? '';
        expect(disclosure.toLowerCase()).not.toContain('computed once the last mark lands');
        expect(disclosure.toLowerCase()).toContain('deposit settles');
      } finally {
        page.close();
      }
    });

  });

  describe('the fingerprint coverage disclosure', () => {
    it('does not claim to cover cancellation terms, which specText never hashes', async () => {
      const page = await renderAgreement(baseUrl, 'job-half-signed', { token: buyerToken });
      try {
        const covers = page.document.getElementById('tech-fingerprint-covers')?.textContent ?? '';
        expect(covers.toLowerCase()).not.toContain('cancellation');
      } finally {
        page.close();
      }
    });
  });

  describe('clicking a criterion mark', () => {
    it('posts to the exact index clicked, and re-reading the job shows only that index flipped (mutation proof 2: off-by-one)', async () => {
      const page = await renderAgreement(baseUrl, 'job-two-unsigned', { token: buyerToken });
      try {
        // Click the SECOND row (index 1); if the client sent index 0 by
        // mistake, criterion 0 would flip instead and this assertion goes
        // red on the wrong element.
        await clickMark(page, 1, 'm-you');

        const readBack = await fetch(`${baseUrl}/jobs/job-two-unsigned`, { headers: { Accept: 'application/json' } });
        const body = (await readBack.json()) as { criteria: Array<{ acceptedByBuyer: boolean }> };
        expect(body.criteria[0]!.acceptedByBuyer).toBe(false);
        expect(body.criteria[1]!.acceptedByBuyer).toBe(true);
      } finally {
        page.close();
      }
    });
  });

  describe('clicking the price mark', () => {
    it('posts to price/accept, and the delivery row\'s mark reflects the same acceptance (mutation proof 3)', async () => {
      const page = await renderAgreement(baseUrl, 'job-price-only', { token: buyerToken });
      try {
        const rowsBefore = Array.from(page.document.querySelectorAll('#terms > li'));
        expect(rowsBefore.length).toBe(3); // one criterion, price, delivery
        await clickMark(page, 1, 'm-you'); // row 1 (0-indexed) is the price row

        const rowsAfter = Array.from(page.document.querySelectorAll('#terms > li'));
        expect(rowsAfter[1]!.querySelectorAll('.sigcell')[0]!.querySelector('.sig.is-signed')).not.toBeNull();
        expect(rowsAfter[2]!.querySelectorAll('.sigcell')[0]!.querySelector('.sig.is-signed')).not.toBeNull();

        const readBack = await fetch(`${baseUrl}/jobs/job-price-only`, { headers: { Accept: 'application/json' } });
        const body = (await readBack.json()) as { price: { acceptedByBuyer: boolean } };
        expect(body.price.acceptedByBuyer).toBe(true);
      } finally {
        page.close();
      }
    });
  });

  describe('proposing a criterion', () => {
    it('sends the current criteria unchanged plus the new one, so the new line appears unaccepted by both parties and every pre-existing line keeps its acceptance flags (P1, proposeCriteria diff)', async () => {
      const page = await renderAgreement(baseUrl, 'job-for-propose', { token: buyerToken });
      try {
        await proposeCriterion(page, 'A third criterion, newly proposed');

        const readBack = await fetch(`${baseUrl}/jobs/job-for-propose`, { headers: { Accept: 'application/json' } });
        const body = (await readBack.json()) as {
          criteria: Array<{ text: string; acceptedByBuyer: boolean; acceptedByAgent: boolean; proposedBy: string }>;
        };
        expect(body.criteria.length).toBe(3);
        expect(body.criteria[0]).toMatchObject({ text: 'The login bug is fixed', acceptedByBuyer: true, acceptedByAgent: true });
        expect(body.criteria[1]).toMatchObject({ text: 'A regression test is added', acceptedByBuyer: false, acceptedByAgent: true });
        expect(body.criteria[2]).toMatchObject({
          text: 'A third criterion, newly proposed',
          acceptedByBuyer: false,
          acceptedByAgent: false,
          proposedBy: 'buyer',
        });
      } finally {
        page.close();
      }
    });
  });
  describe('the fixed terms', () => {
    it('render with no button, no input, and no mark anywhere inside their container', async () => {
      const page = await renderAgreement(baseUrl, 'job-half-signed', { token: buyerToken });
      try {
        const fixed = page.document.getElementById('fixed-terms');
        expect(fixed).not.toBeNull();
        expect(fixed!.querySelectorAll('button').length).toBe(0);
        expect(fixed!.querySelectorAll('input').length).toBe(0);
        expect(fixed!.querySelectorAll('.sig').length).toBe(0);
        expect(fixed!.textContent ?? '').toContain('300.00 of $1200.00');
      } finally {
        page.close();
      }
    });
  });

  describe('a signed-in stranger to this job', () => {
    it('is refused with the 403 sentence, not a blank screen', async () => {
      const strangerAdapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'agreement-page-stranger', id: 9102 }) });
      const strangerAccountRepo = new MemoryAccountRepository();
      await strangerAccountRepo.register({ did: STRANGER_ACCOUNT_DID, githubLogin: 'agreement-page-stranger' });
      const strangerServer = createApp(strangerAccountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, undefined, undefined, undefined, undefined, strangerAdapter).listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => strangerServer.once('listening', resolve));
      const strangerBaseUrl = `http://127.0.0.1:${(strangerServer.address() as AddressInfo).port}`;
      try {
        const token = await mintSessionToken(strangerAdapter);
        const page = await renderAgreement(strangerBaseUrl, 'job-for-403', { token });
        try {
          const notice = page.document.getElementById('party-error');
          expect(notice).not.toBeNull();
          expect(notice!.hidden).toBe(false);
          expect((notice!.textContent ?? '').toLowerCase()).toContain('not a party');
          const body = page.document.getElementById('agreement-body');
          expect(body!.hidden).toBe(true);
        } finally {
          page.close();
        }
      } finally {
        await new Promise<void>((resolve) => strangerServer.close(() => resolve()));
      }
    });
  });

  describe('a criterion containing markup', () => {
    it('renders as literal text', async () => {
      await jobRepo.create(
        jobFixture({
          id: 'job-markup-criterion',
          status: 'proposed',
          criteria: [{ text: 'Fix <b>the</b> bug, not <img src=x onerror=alert(1)>', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: false }],
        }),
      );
      const page = await renderAgreement(baseUrl, 'job-markup-criterion', { token: buyerToken });
      try {
        const line = page.document.querySelector('#terms > li .txt');
        expect(line).not.toBeNull();
        expect(line!.textContent ?? '').toContain('Fix <b>the</b> bug, not <img src=x onerror=alert(1)>');
        expect(line!.querySelector('img')).toBeNull();
        expect(line!.querySelector('b')).toBeNull();
      } finally {
        page.close();
      }
    });
  });

  describe('the session token appears nowhere in the rendered document', () => {
    it('not in the URL, any href, or the query string', async () => {
      const page = await renderAgreement(baseUrl, 'job-half-signed', { token: buyerToken });
      try {
        expect(page.window.location.href).not.toContain(buyerToken);
        const anchors = Array.from(page.document.querySelectorAll('a[href]'));
        for (const anchor of anchors) {
          expect(anchor.getAttribute('href') ?? '').not.toContain(buyerToken);
        }
        expect(page.document.documentElement.outerHTML).not.toContain(buyerToken);
      } finally {
        page.close();
      }
    });
  });

  describe('the nav on /agreement', () => {
    it('flips to signed-in for a person with a session', async () => {
      const page = await renderAgreement(baseUrl, 'job-half-signed', { token: buyerToken });
      try {
        expect(page.document.getElementById('nav-signin')!.hidden).toBe(true);
        expect(page.document.getElementById('nav-signed-in')!.hidden).toBe(false);
      } finally {
        page.close();
      }
    });
  });

  describe('mutation proof 4: no confirm call, ever', () => {
    it('signing every remaining line on a fully-agreeable job never requests POST /jobs/:jobId/confirm', async () => {
      await jobRepo.create(
        jobFixture({
          id: 'job-sign-to-completion',
          status: 'proposed',
          criteria: [{ text: 'Last line', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: true }],
        }),
      );
      const page = await renderAgreement(baseUrl, 'job-sign-to-completion', { token: buyerToken });
      const requestedPaths: string[] = [];
      try {
        const realFetch = page.window.fetch.bind(page.window);
        page.window.fetch = ((input: string, init?: RequestInit) => {
          requestedPaths.push(typeof input === 'string' ? input : String(input));
          return realFetch(input, init);
        }) as typeof fetch;

        await clickMark(page, 0, 'm-you');

        expect(requestedPaths.some((p) => p.includes('/confirm'))).toBe(false);
        const lockbar = page.document.getElementById('lockbar')?.textContent ?? '';
        expect(lockbar.toLowerCase()).toContain('fully agreed');
      } finally {
        page.close();
      }
    });
  });

  describe('mutation proof 7: the job page\'s CTA', () => {
    it('resolves to /agreement?job=<id> for the id the page rendered, read from the DOM after the script has run', async () => {
      const response = await fetch(`${baseUrl}/jobs/job-half-signed`, { headers: { Accept: HTML } });
      const markup = await response.text();
      const virtualConsole = new VirtualConsole();
      const failures: string[] = [];
      virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));
      const dom = new JSDOM(markup, {
        url: `${baseUrl}/jobs/job-half-signed`,
        runScripts: 'dangerously',
        resources: 'usable',
        pretendToBeVisual: true,
        virtualConsole,
        beforeParse(window) {
          Object.defineProperty(window, 'fetch', {
            writable: true,
            value: (input: string, init?: RequestInit) => fetch(new URL(input, baseUrl), init),
          });
        },
      });
      try {
        await new Promise<void>((resolve) => {
          if (dom.window.document.readyState === 'complete') resolve();
          else dom.window.addEventListener('load', () => resolve());
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);
        const link = dom.window.document.getElementById('agreement-link');
        expect(link).not.toBeNull();
        expect(link!.getAttribute('href')).toBe('/agreement?job=job-half-signed');
        const cta = dom.window.document.getElementById('agreement-cta');
        expect(cta!.hidden).toBe(false);
      } finally {
        dom.window.close();
      }
    });
  });

  describe('every refusal a mark click can hit renders its own distinct sentence', () => {
    const sentences: string[] = [];

    it('mutation proof 1 + a distinct 401: the signed-in guard removed reads as everyone getting marks; here it is the expired-session sentence on a click', async () => {
      // Sign the buyer out server-side between page load and the click, so
      // the load succeeds (fresh token at load) but the click's own POST
      // meets a dead token -- the exact "expired after the page loaded"
      // case scope item 8's 401 sentence exists for.
      const oneUseAdapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'agreement-page-expiring', id: 9201 }) });
      const oneUseAccountRepo = new MemoryAccountRepository();
      await oneUseAccountRepo.register({ did: 'did:abt:agreement-page-expiring-account', githubLogin: 'agreement-page-expiring' });
      const oneUseAgentRepo = new MemoryAgentRepository();
      await oneUseAgentRepo.create({
        did: 'did:abt:agreement-page-expiring-agent',
        operatorDid: 'did:abt:agreement-page-expiring-operator',
        delegation: delegationFixture('did:abt:agreement-page-expiring-agent', 'did:abt:agreement-page-expiring-operator'),
        name: 'expiring-scout',
        skills: [],
        githubLogin: null,
      });
      const oneUseJobRepo = new MemoryJobRepository();
      await oneUseJobRepo.create(
        createJob(
          { id: 'job-expiring', buyerDid: 'did:abt:agreement-page-expiring-account', agentDid: 'did:abt:agreement-page-expiring-agent', repository: 'buyer/x', brief: 'x' },
          new Date(),
        ),
      );
      await oneUseJobRepo.update({
        ...(await oneUseJobRepo.findById('job-expiring'))!,
        status: 'proposed',
        criteria: [{ text: 'A line', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: true }],
      });
      const oneUseServer = createApp(oneUseAccountRepo, oneUseAgentRepo, undefined, undefined, oneUseJobRepo, undefined, undefined, undefined, undefined, undefined, undefined, oneUseAdapter).listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => oneUseServer.once('listening', resolve));
      const oneUseBaseUrl = `http://127.0.0.1:${(oneUseServer.address() as AddressInfo).port}`;
      try {
        const token = await mintSessionToken(oneUseAdapter);
        const page = await renderAgreement(oneUseBaseUrl, 'job-expiring', { token });
        try {
          await fetch(`${oneUseBaseUrl}/auth/signout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
          await clickMark(page, 0, 'm-you');
          const errorText = page.document.getElementById('submit-error-detail')?.textContent ?? '';
          expect(errorText.toLowerCase()).toContain('expired');
          sentences.push(errorText);
        } finally {
          page.close();
        }
      } finally {
        await new Promise<void>((resolve) => oneUseServer.close(() => resolve()));
      }
    });

    it('a distinct 409: the job moved on since the page loaded (a redo requester leaving a tab open)', async () => {
      const page = await renderAgreement(baseUrl, 'job-to-withdraw', { token: buyerToken });
      try {
        await fetch(`${baseUrl}/jobs/job-to-withdraw/withdraw`, { method: 'POST', headers: { Authorization: `Bearer ${buyerToken}` } });
        await clickMark(page, 0, 'm-you');
        const errorText = page.document.getElementById('submit-error-detail')?.textContent ?? '';
        expect(errorText.toLowerCase()).toContain('reload');
        sentences.push(errorText);
      } finally {
        page.close();
      }
    });

    it('a distinct 503: storage unavailable', async () => {
      class FailingUpdateJobRepository implements JobRepository {
        private readonly real = new MemoryJobRepository();
        async create(job: Job): Promise<Job> {
          return this.real.create(job);
        }
        async update(): Promise<Job | null> {
          throw new Error('connection refused');
        }
        async findById(id: string): Promise<Job | null> {
          return this.real.findById(id);
        }
        async complete(job: Job, completedJob: Omit<CompletedJob, 'id'>): Promise<Job | null> {
          return this.real.complete(job, completedJob);
        }
        async findCompletedByJobId(id: string): Promise<CompletedJob | null> {
          return this.real.findCompletedByJobId(id);
        }
      }
      const failingRepo = new FailingUpdateJobRepository();
      await failingRepo.create(
        jobFixture({ id: 'job-storage-fails', status: 'proposed', criteria: [{ text: 'x', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: false }] }),
      );
      const storageAdapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'agreement-page-buyer', id: 9101 }) });
      const storageAccountRepo = new MemoryAccountRepository();
      await storageAccountRepo.register({ did: BUYER_ACCOUNT_DID, githubLogin: 'agreement-page-buyer' });
      const storageServer = createApp(storageAccountRepo, agentRepo, undefined, undefined, failingRepo, undefined, undefined, undefined, undefined, undefined, undefined, storageAdapter).listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => storageServer.once('listening', resolve));
      const storageBaseUrl = `http://127.0.0.1:${(storageServer.address() as AddressInfo).port}`;
      try {
        const token = await mintSessionToken(storageAdapter);
        const page = await renderAgreement(storageBaseUrl, 'job-storage-fails', { token });
        try {
          await clickMark(page, 0, 'm-you');
          const errorText = page.document.getElementById('submit-error-detail')?.textContent ?? '';
          expect(errorText.toLowerCase()).toContain('unavailable');
          sentences.push(errorText);
        } finally {
          page.close();
        }
      } finally {
        await new Promise<void>((resolve) => storageServer.close(() => resolve()));
      }
    });

    it('the collected sentences are pairwise distinct (mutation proof 5)', () => {
      expect(sentences.length).toBe(3);
      expect(new Set(sentences).size).toBe(sentences.length);
    });
  });

  // QA round 1, D1 unstyled-ported-component: the polished-stack swap
  // deleted the page-local rules for .who, .steps li/.on/.done and
  // .draftflag, and nothing in base.css, polish.css or agreement.css
  // replaced them, so all three rendered with zero matching author rules.
  // jsdom performs no layout and cannot see this (it never computed a
  // border width from a stylesheet a browser would apply), so this is
  // driven through RealBrowser, the same instrument QA used to find it.
  describe('the who strip, step rail and draft flag carry real styling (D1 unstyled-ported-component)', () => {
    it('at 1280px, .who is a flex row with its border and the current step is visually distinct from the rest', async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
        return;
      }
      const browser = await RealBrowser.launch({ width: 1280, height: 900 });
      try {
        await browser.goto(`${baseUrl}/agreement?job=job-half-signed`);
        await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify({ token: buyerToken }))})`);
        await browser.goto(`${baseUrl}/agreement?job=job-half-signed`);

        const who = await browser.evaluate<{ display: string; borderBottomWidth: string; marginBottom: string; nameWeight: string }>(`
          (function () {
            var who = document.getElementById('who');
            var name = document.getElementById('agent-name');
            var s = getComputedStyle(who);
            var ns = getComputedStyle(name);
            return { display: s.display, borderBottomWidth: s.borderBottomWidth, marginBottom: s.marginBottom, nameWeight: ns.fontWeight };
          })()
        `);
        expect(who.display).toBe('flex');
        expect(parseFloat(who.borderBottomWidth)).toBeGreaterThan(0);
        expect(parseFloat(who.marginBottom)).toBeGreaterThan(0);
        expect(parseFloat(who.nameWeight)).toBeGreaterThanOrEqual(550);

        const rail = await browser.evaluate<{ borderTops: string[]; borderColors: string[] }>(`
          (function () {
            var items = Array.from(document.querySelectorAll('.steps li'));
            return {
              borderTops: items.map(function (li) { return getComputedStyle(li).borderTopWidth; }),
              borderColors: items.map(function (li) { return getComputedStyle(li).borderTopColor; }),
            };
          })()
        `);
        // The current step (#s2, "on") must carry a border WIDTH (the
        // wireframe's own state carrier: the rule is 2px solid on every
        // step, and the current one is distinguished by colour, not
        // width) and a COLOUR distinct from an untouched future step
        // (#s3); zero width on all five, or an identical colour on every
        // step, is the exact QA finding: the rail cannot show where you
        // are.
        expect(rail.borderTops[1]).not.toBe('0px');
        expect(rail.borderColors[1]).not.toBe(rail.borderColors[2]);

        const draftflag = await browser.evaluate<{ fontFamily: string; borderLeftWidth: string; paddingLeft: string }>(`
          (function () {
            var el = document.querySelector('.draftflag');
            var s = getComputedStyle(el);
            return { fontFamily: s.fontFamily, borderLeftWidth: s.borderLeftWidth, paddingLeft: s.paddingLeft };
          })()
        `);
        expect(draftflag.fontFamily.toLowerCase()).not.toContain('geist');
        expect(parseFloat(draftflag.borderLeftWidth)).toBeGreaterThan(0);
        expect(parseFloat(draftflag.paddingLeft)).toBeGreaterThan(0);
      } finally {
        await browser.close();
      }
    });

    it('at 320px the step rail collapses its labels and .railnow carries the current step in words, with no horizontal overflow', async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
        return;
      }
      const browser = await RealBrowser.launch({ width: 320, height: 900 });
      try {
        await browser.goto(`${baseUrl}/agreement?job=job-half-signed`);
        await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify({ token: buyerToken }))})`);
        await browser.goto(`${baseUrl}/agreement?job=job-half-signed`);

        const metrics = await browser.evaluate<{ scrollWidth: number; clientWidth: number; stepFontSize: string; railnowDisplay: string; railnowText: string }>(`
          (function () {
            var step = document.querySelector('.steps li');
            var railnow = document.querySelector('.railnow');
            return {
              scrollWidth: document.documentElement.scrollWidth,
              clientWidth: document.documentElement.clientWidth,
              stepFontSize: getComputedStyle(step).fontSize,
              railnowDisplay: getComputedStyle(railnow).display,
              railnowText: railnow.textContent || '',
            };
          })()
        `);
        expect(metrics.scrollWidth, `scrollWidth ${metrics.scrollWidth} vs clientWidth ${metrics.clientWidth}`).toBe(metrics.clientWidth);
        expect(metrics.stepFontSize).toBe('0px');
        expect(metrics.railnowDisplay).toBe('block');
        expect(metrics.railnowText.toLowerCase()).toContain('step 2 of 5');
      } finally {
        await browser.close();
      }
    });
  });

  // QA round 1 note (not a defect, but worth pinning): renderLockbar's
  // `needed = lines.length * 2` is the only place the "signatures needed"
  // half of the count comes from, and none of the existing assertions
  // read the number pair, only the phrase. A mutation to
  // `lines.length` kept all 27 tests green while the live page rendered
  // "6 of 3" at 200% meter width on the fully-agreed fixture. This test
  // reads the actual digits so that mutation goes red.
  describe('the lockbar count states two signatures needed per line, not one', () => {
    it('on a fully-agreed job with 3 lines (1 criterion + price + delivery), the count reads 6 of 6, not 6 of 3', async () => {
      const page = await renderAgreement(baseUrl, 'job-fully-agreed', { token: buyerToken });
      try {
        const count = page.document.getElementById('lockcount')?.textContent ?? '';
        expect(count).toContain('6');
        expect(count).toMatch(/6\s*(of|\/)\s*6/i);
        const meter = page.document.getElementById('lockmeter-fill') as HTMLElement | null;
        expect(meter?.style.width).toBe('100%');
      } finally {
        page.close();
      }
    });

    it('on a half-signed job with 4 lines, the denominator reads 8, not 4', async () => {
      const page = await renderAgreement(baseUrl, 'job-half-signed', { token: buyerToken });
      try {
        // Fixture: criterion 0 both signed (2), criterion 1 agent-only (1),
        // price agent-only (1), delivery shares price's pair, agent-only
        // (1). Collected = 5, needed = 4 lines x 2 = 8. The mutation this
        // test is written against (needed = lines.length) would read the
        // denominator as 4, half the true figure.
        const count = page.document.getElementById('lockcount')?.textContent ?? '';
        expect(count).toMatch(/5\s*(of|\/)\s*8/i);
      } finally {
        page.close();
      }
    });
  });

  // QA round 2, D2 script-rendered-icon-never-painted: every .ico host
  // agreement.js builds in script (the eight .sigdot marks, the .from
  // proposer arrow) ships empty. icons.js paints once on DOMContentLoaded
  // and polish.js paints once in init(), both before the job fetch
  // resolves, and nothing repaints after. This is DOM shape, not layout,
  // so jsdom (which builds the SVG element FAIcon.paint appends same as a
  // real browser) is the right instrument; no RealBrowser needed.
  describe('the sigdot marks carry a painted icon, not an empty host (D2 script-rendered-icon-never-painted)', () => {
    it('after the terms render, every .sigdot host has a painted svg child', async () => {
      const page = await renderAgreement(baseUrl, 'job-half-signed', { token: buyerToken });
      try {
        const dots = Array.from(page.document.querySelectorAll('.sigdot .ico'));
        expect(dots.length).toBeGreaterThan(0);
        dots.forEach((dot) => {
          expect(dot.querySelector('svg')).not.toBeNull();
        });
      } finally {
        page.close();
      }
    });

    it('after clicking a mark and the row re-renders, the new sigdot host is still painted', async () => {
      const page = await renderAgreement(baseUrl, 'job-two-unsigned', { token: buyerToken });
      try {
        await clickMark(page, 0, 'm-you');
        const dots = Array.from(page.document.querySelectorAll('.sigdot .ico'));
        expect(dots.length).toBeGreaterThan(0);
        dots.forEach((dot) => {
          expect(dot.querySelector('svg')).not.toBeNull();
        });
      } finally {
        page.close();
      }
    });
  });
});
