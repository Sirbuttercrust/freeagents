// P8s: the conduct record page, driven end to end against the real app
// (the discipline tests/web/pullrequest.test.ts and tests/web/staged.test.ts
// already hold to). Reads GET /buyers/:githubLogin/conduct for real, never
// a client-side stub for the happy paths.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import {
  MemoryAgentRepository,
  MemoryAccountRepository,
  MemoryJobRepository,
} from '../../src/adapters/storage/memory.js';
import { createJob, type Job } from '../../src/domain/job.js';
import type { Delegation } from '../../src/domain/agent.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const OPERATOR_DID = 'did:abt:conduct-page-operator';
const AGENT_DID = 'did:abt:conduct-page-agent';
const OWN_AGENT_DID = 'did:abt:conduct-page-own-agent';
const BUYER_DID = 'did:abt:conduct-page-buyer';

function delegationFixture(agentDid: string, operatorDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:delegation-for-${agentDid}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-01-01T00:00:00Z',
      verificationMethod: `${agentDid}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zfixture-not-verified-here',
    },
  };
}

function jobFixture(id: string, buyerDid: string, agentDid: string, overrides: Partial<Job> = {}): Job {
  const base = createJob(
    { id, buyerDid, agentDid, repository: 'buyer/conduct-repo', brief: 'A secret brief nobody reads here' },
    new Date('2026-08-01T00:00:00Z'),
  );
  return { ...base, ...overrides };
}

interface Rendered {
  window: JSDOM['window'];
  document: Document;
  close: () => void;
}

async function renderPage(baseUrl: string, path: string): Promise<Rendered> {
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
  for (let waited = 0; waited < 350; waited += 50) { await new Promise((resolve) => setTimeout(resolve, 50)); }
  if (failures.length > 0) throw new Error(`page script failed on ${path}: ${failures.join('; ')}`);
  return { window: dom.window, document: dom.window.document, close: () => dom.window.close() };
}

function renderConduct(baseUrl: string, account: string | null): Promise<Rendered> {
  const qs = account === null ? '' : `?account=${encodeURIComponent(account)}`;
  return renderPage(baseUrl, `/conduct${qs}`);
}

// W-conduct. Every CSS rule in force on this page: its own <style> block
// plus each stylesheet it LINKS, fetched over HTTP from the running app.
//
// The layout assertion below used to read document.querySelector('style')
// alone, which was correct for as long as .counts lived in this page's own
// block. W-conduct moved it, .who, .ct and .fixed out to
// src/web/public/css/flow.css when this screen joined the polished visual
// system, and that narrowed assertion would have gone red on a page whose
// behaviour had not changed: its subject was the inline block while its
// stated claim was about the screen.
//
// The hrefs are read from the page's own markup rather than named here, so
// a sheet that stops being linked leaves the corpus rather than silently
// keeping an assertion green, and the fetch is what proves the file is
// really served at that path. An empty population throws: a corpus that
// quietly became one inline block would turn every match into a green loop
// over nothing. Same helper and same reasoning as
// tests/web/pullrequest.test.ts:134.
async function pageCss(page: Rendered, baseUrl: string): Promise<string> {
  const inline = Array.from(page.document.querySelectorAll('style')).map((s) => s.textContent ?? '');
  const hrefs = Array.from(page.document.querySelectorAll('link[rel="stylesheet"]')).map(
    (l) => l.getAttribute('href') ?? '',
  );
  if (hrefs.length === 0) throw new Error('no linked stylesheets on the conduct page: the corpus would be inline CSS only');
  const linked: string[] = [];
  for (const href of hrefs) {
    const res = await fetch(new URL(href, baseUrl));
    if (!res.ok) throw new Error(`the conduct page links ${href} and the app answers ${res.status} for it`);
    const text = await res.text();
    if (text.trim() === '') throw new Error(`${href} is served empty`);
    linked.push(text);
  }
  return [...inline, ...linked].join('\n');
}

// A selector's DECLARATION, comments blanked out first so a rule named in
// a comment cannot answer for a rule that ships. Returns every line that
// carries the selector in selector position, so a caller can assert the
// rule exists somewhere in the corpus and then assert what it does.
function declarationsOf(css: string, selector: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return clean
    .split('\n')
    .filter((line) => new RegExp(`(^|[\\s,>+~])${escaped}\\s*[,{]`).test(line))
    .map((line) => line.trim());
}

// The 404/network branches
// of onLoaded() are reached only when GET /buyers/:githubLogin/conduct
// itself answers 404 or the fetch throws, neither of which the real app
// under test produces on this route (it only ever answers 200 or 503, see
// src/api/app.ts:2474-2488). Reaching those branches for a real assertion
// means intercepting window.fetch for exactly the /buyers/ call, the same
// technique tests/web/deposit.test.ts already uses for its mocked-route case -- every
// OTHER request (the page shell, css, js) still goes over the real network
// to the real server, so this is not a client-side stub of the page itself.
function renderConductMocked(
  baseUrl: string,
  account: string,
  mockBuyersFetch: () => Promise<Response>,
): Promise<Rendered> {
  const path = `/conduct?account=${encodeURIComponent(account)}`;
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));
  return fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } }).then(async (response) => {
    const markup = await response.text();
    const dom = new JSDOM(markup, {
      url: `${baseUrl}${path}`,
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse(window) {
        Object.defineProperty(window, 'fetch', {
          writable: true,
          value: (input: string, init?: RequestInit) =>
            String(input).includes('/buyers/') ? mockBuyersFetch() : fetch(new URL(input, baseUrl), init),
        });
      },
    });
    await new Promise<void>((resolve) => {
      if (dom.window.document.readyState === 'complete') resolve();
      else dom.window.addEventListener('load', () => resolve());
    });
    for (let waited = 0; waited < 350; waited += 50) { await new Promise((resolve) => setTimeout(resolve, 50)); }
    if (failures.length > 0) throw new Error(`page script failed on ${path}: ${failures.join('; ')}`);
    return { window: dom.window, document: dom.window.document, close: () => dom.window.close() };
  });
}

describe('the conduct record page, driven end to end against the real app', () => {
  let agentRepo: MemoryAgentRepository;
  let jobRepo: MemoryJobRepository;
  let accountRepo: MemoryAccountRepository;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: OPERATOR_DID, githubLogin: 'conduct-page-operator-login' });
    await accountRepo.register({ did: BUYER_DID, githubLogin: 'conduct-page-buyer' });
    agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: OPERATOR_DID,
      delegation: delegationFixture(AGENT_DID, OPERATOR_DID),
      name: 'conduct-page-scout',
      skills: ['triage'],
      githubLogin: null,
    });
    // The buyer's OWN agent -- a different DID from AGENT_DID above, so
    // the buyer-side jobs on AGENT_DID never leak into operatorCounts
    // (operatorConductForDid reads every job on this agent regardless of
    // who the buyer was).
    await agentRepo.create({
      did: OWN_AGENT_DID,
      operatorDid: BUYER_DID,
      delegation: delegationFixture(OWN_AGENT_DID, BUYER_DID),
      name: 'conduct-page-own-agent',
      skills: ['triage'],
      githubLogin: null,
    });
    jobRepo = new MemoryJobRepository();

    // The buyer side: one of each of the six wireframe rows.
    await jobRepo.create(jobFixture('job-confirmed-only', BUYER_DID, AGENT_DID, { status: 'staged', confirmedAt: new Date('2026-08-02T00:00:00Z') }));
    await jobRepo.create(jobFixture('job-merged', BUYER_DID, AGENT_DID, { status: 'completed', confirmedAt: new Date('2026-08-02T00:00:00Z'), mergeCommit: 'c1', mergedAt: new Date('2026-08-03T00:00:00Z') }));
    await jobRepo.create(jobFixture('job-deemed', BUYER_DID, AGENT_DID, { status: 'deemed_completed', confirmedAt: new Date('2026-08-02T00:00:00Z'), deemedCompletedAt: new Date('2026-08-03T00:00:00Z') }));
    await jobRepo.create(jobFixture('job-cited-closed', BUYER_DID, AGENT_DID, { status: 'cited_closed', confirmedAt: new Date('2026-08-02T00:00:00Z'), citedCloseAt: new Date('2026-08-03T00:00:00Z') }));
    await jobRepo.create(jobFixture('job-redo-requested', BUYER_DID, AGENT_DID, { status: 'staged', confirmedAt: new Date('2026-08-02T00:00:00Z'), redoRequestedAt: new Date('2026-08-03T00:00:00Z') }));
    await jobRepo.create(jobFixture('job-staged-declined', BUYER_DID, AGENT_DID, { status: 'staged_declined', confirmedAt: new Date('2026-08-02T00:00:00Z') }));
    await jobRepo.create(jobFixture('job-closed-unpaid', BUYER_DID, AGENT_DID, { status: 'closed_unpaid', confirmedAt: new Date('2026-08-02T00:00:00Z') }));
    // A confirmed-and-withdrawn job: walkedAfterConfirm, deliberately NOT
    // one of stagedDeclined/closedUnpaid, so a wiring bug that binds
    // "walked away" to walkedAfterConfirm would show 1 here instead of 2.
    await jobRepo.create(jobFixture('job-withdrawn', BUYER_DID, AGENT_DID, { status: 'withdrawn', confirmedAt: new Date('2026-08-02T00:00:00Z') }));

    // The operator side: BUYER_DID also operates OWN_AGENT_DID
    // (registered above with operatorDid: BUYER_DID), so its own jobs as
    // an agent feed operatorCounts. Two delivered-never-paid (the redo
    // refusal below also ended staged_declined), one redo refused, four
    // walked away after the deposit and five paid and never delivered. The
    // last two are counts nothing else on the page holds, so a leaf bound
    // to the wrong field shows a number its own field does not.
    await jobRepo.create(jobFixture('job-op-delivered-never-paid', 'did:abt:conduct-page-other-buyer', OWN_AGENT_DID, { status: 'staged_declined', confirmedAt: new Date('2026-08-02T00:00:00Z') }));
    await jobRepo.create(jobFixture('job-op-redo-refused', 'did:abt:conduct-page-other-buyer', OWN_AGENT_DID, { status: 'staged_declined', confirmedAt: new Date('2026-08-02T00:00:00Z'), redoRequestedAt: new Date('2026-08-03T00:00:00Z'), redoRefusedAt: new Date('2026-08-04T00:00:00Z') }));
    for (let i = 0; i < 4; i++) await jobRepo.create(jobFixture(`job-op-walked-after-deposit-${i}`, 'did:abt:conduct-page-other-buyer', OWN_AGENT_DID, { status: 'expired_unstaged', confirmedAt: new Date('2026-08-02T00:00:00Z') }));
    for (let i = 0; i < 5; i++) await jobRepo.create(jobFixture(`job-op-paid-never-delivered-${i}`, 'did:abt:conduct-page-other-buyer', OWN_AGENT_DID, { status: 'paid_undelivered', confirmedAt: new Date('2026-08-02T00:00:00Z') }));

    // A second, cold-start account: keyed, but no jobs on either side.
    await accountRepo.register({ did: 'did:abt:conduct-page-cold', githubLogin: 'conduct-page-cold-account' });

    const app = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('missing account parameter (ruling 1, mutation proof: an empty page is honest)', () => {
    it('renders the load failure and no visible count row', async () => {
      const page = await renderConduct(baseUrl, null);
      try {
        expect(page.document.getElementById('load-error')?.hidden).toBe(false);
        expect(page.document.getElementById('conduct-body')?.hidden).toBe(true);
        expect(page.document.getElementById('not-keyed')?.hidden).toBe(true);
      } finally {
        page.close();
      }
    });
  });

  describe('keyed: false (ruling 3, mutation proof 2)', () => {
    it('renders its own sentence and no count rows -- never eight zeros', async () => {
      const page = await renderConduct(baseUrl, 'nobody-ever-registered-this-login');
      try {
        const notice = page.document.getElementById('not-keyed');
        expect(notice?.hidden).toBe(false);
        expect((notice?.textContent ?? '').toLowerCase()).toContain('no verified github account');
        expect(page.document.getElementById('conduct-body')?.hidden).toBe(true);
        expect(page.document.getElementById('load-error')?.hidden).toBe(true);
      } finally {
        page.close();
      }
    });
  });

  describe('a 503 storage failure (standing defect silent-success-on-failure, mutation proof 6)', () => {
    it('renders its own sentence, never a count row and never the cold start', async () => {
      const failingJobRepo = {
        create: () => Promise.reject(new Error('unused')),
        update: () => Promise.reject(new Error('unused')),
        findById: () => Promise.reject(new Error('unused')),
        complete: () => Promise.reject(new Error('unused')),
        findCompletedByJobId: () => Promise.reject(new Error('unused')),
        findByBuyerDid: () => Promise.reject(new Error('db down')),
      };
      const failingAccountRepo = new MemoryAccountRepository();
      await failingAccountRepo.register({ did: 'did:abt:conduct-page-503', githubLogin: 'conduct-page-503-login' });
      const failingApp = createApp(failingAccountRepo, new MemoryAgentRepository(), undefined, undefined, failingJobRepo as never);
      const failingServer = failingApp.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => failingServer.once('listening', resolve));
      const failingBaseUrl = `http://127.0.0.1:${(failingServer.address() as AddressInfo).port}`;
      try {
        const page = await renderConduct(failingBaseUrl, 'conduct-page-503-login');
        try {
          expect(page.document.getElementById('load-error')?.hidden).toBe(false);
          expect(page.document.getElementById('conduct-body')?.hidden).toBe(true);
          expect(page.document.getElementById('not-keyed')?.hidden).toBe(true);
        } finally {
          page.close();
        }
      } finally {
        await new Promise<void>((resolve) => failingServer.close(() => resolve()));
      }
    });
  });

  describe('a 404 absent record, distinct from the 503 sentence', () => {
    it('renders its own sentence, never the 503 wording and never a count row', async () => {
      const page = await renderConductMocked(baseUrl, 'conduct-page-buyer', async () =>
        new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } }),
      );
      try {
        const detail = (page.document.getElementById('load-error-detail')?.textContent ?? '').toLowerCase();
        expect(page.document.getElementById('load-error')?.hidden).toBe(false);
        expect(detail).toContain('no conduct record');
        expect(detail).not.toContain('reloading may work');
        expect(page.document.getElementById('conduct-body')?.hidden).toBe(true);
        expect(page.document.getElementById('not-keyed')?.hidden).toBe(true);
      } finally {
        page.close();
      }
    });
  });

  describe('a network failure, distinct from the 503 and 404 sentences', () => {
    it('renders the failed-read sentence, never a count row', async () => {
      const page = await renderConductMocked(baseUrl, 'conduct-page-buyer', async () => {
        throw new Error('simulated network failure');
      });
      try {
        const detail = (page.document.getElementById('load-error-detail')?.textContent ?? '').toLowerCase();
        expect(page.document.getElementById('load-error')?.hidden).toBe(false);
        expect(detail).toContain('reloading may work');
        expect(detail).not.toContain('no conduct record');
        expect(page.document.getElementById('conduct-body')?.hidden).toBe(true);
        expect(page.document.getElementById('not-keyed')?.hidden).toBe(true);
      } finally {
        page.close();
      }
    });
  });

  describe('an all-zero conduct response, on setCount\'s own coercion (W7a done-means item 3)', () => {
    it('renders every count as "0", both sections, with no new-account badge or encouragement text', async () => {
      const page = await renderConductMocked(baseUrl, 'conduct-page-buyer', async () =>
        new Response(
          JSON.stringify({ githubLogin: 'conduct-page-buyer', keyed: true, counts: {}, operatorCounts: {} }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      try {
        expect(page.document.getElementById('conduct-body')?.hidden).toBe(false);
        expect(page.document.getElementById('load-error')?.hidden).toBe(true);
        expect(page.document.getElementById('not-keyed')?.hidden).toBe(true);
        const ids = ['ct-confirmed', 'ct-merged', 'ct-deemed', 'ct-cited-closes', 'ct-redos-requested', 'ct-walked-away', 'ct-delivered-never-paid', 'ct-redos-refused', 'ct-walked-after-deposit', 'ct-paid-never-delivered'];
        ids.forEach((id) => {
          expect(page.document.getElementById(id)?.textContent, `${id} did not coerce to "0"`).toBe('0');
        });
        expect(page.document.querySelectorAll('#buyer-counts .dg-leaf').length).toBe(6);
        expect(page.document.querySelectorAll('#operator-counts .dg-leaf').length).toBe(4);
        const bodyText = page.document.body.textContent ?? '';
        expect(bodyText.toLowerCase()).not.toContain('new account');
        expect(bodyText.toLowerCase()).not.toContain('encourag');
      } finally {
        page.close();
      }
    });
  });

  describe('the cold start (ruling 4, mutation proof 3): same render path, same selectors, zeros', () => {
    it('a keyed account with no history renders all ten rows at zero, through the exact same selectors as a populated account', async () => {
      const page = await renderConduct(baseUrl, 'conduct-page-cold-account');
      try {
        expect(page.document.getElementById('conduct-body')?.hidden).toBe(false);
        expect(page.document.getElementById('load-error')?.hidden).toBe(true);
        expect(page.document.getElementById('not-keyed')?.hidden).toBe(true);
        const ids = ['ct-confirmed', 'ct-merged', 'ct-deemed', 'ct-cited-closes', 'ct-redos-requested', 'ct-walked-away', 'ct-delivered-never-paid', 'ct-redos-refused', 'ct-walked-after-deposit', 'ct-paid-never-delivered'];
        ids.forEach((id) => {
          expect(page.document.getElementById(id)?.textContent).toBe('0');
        });
        expect(page.document.querySelectorAll('.dg-leaf').length).toBe(10);
        // Mutation proof 3: the zero case renders through the exact same
        // selectors as the populated case, never a second branch with its
        // own marker.
        expect(page.document.getElementById('buyer-counts')?.hasAttribute('data-cold-start')).toBe(false);
        // DIAG1c: a zero leaf is drawn, in the quieter .is-zero style, and
        // never hidden (ruling 4).
        const leaves = Array.from(page.document.querySelectorAll('.dg-leaf'));
        expect(leaves.filter((l) => l.classList.contains('is-zero')).length, 'every leaf of the cold start takes the zero style').toBe(10);
        expect(leaves.filter((l) => (l as HTMLElement).hidden || l.closest('[hidden]') !== null).length, 'no leaf is hidden').toBe(0);
      } finally {
        page.close();
      }
    });
  });

  describe('a populated account: six buyer rows bound to the fields ruling 2 names', () => {
    it('renders each count from the real GET /buyers/:githubLogin/conduct response, field by field', async () => {
      const page = await renderConduct(baseUrl, 'conduct-page-buyer');
      try {
        expect(page.document.getElementById('conduct-body')?.hidden).toBe(false);
        // confirmed: every job above reached confirmed (8 buyer-side jobs).
        expect(page.document.getElementById('ct-confirmed')?.textContent).toBe('8');
        expect(page.document.getElementById('ct-merged')?.textContent).toBe('1');
        expect(page.document.getElementById('ct-deemed')?.textContent).toBe('1');
        expect(page.document.getElementById('ct-cited-closes')?.textContent).toBe('1');
        expect(page.document.getElementById('ct-redos-requested')?.textContent).toBe('1');
        // walked away: stagedDeclined (1) + closedUnpaid (1) = 2, NOT the
        // withdrawn-after-confirm count (which is 1, walkedAfterConfirm).
        expect(page.document.getElementById('ct-walked-away')?.textContent).toBe('2');
        // DIAG1c: the diagram counts up to data-n, so it carries the same
        // number, field by field, and a non-zero leaf is not in the zero
        // style.
        for (const [id, n] of [['ct-confirmed', '8'], ['ct-merged', '1'], ['ct-deemed', '1'], ['ct-cited-closes', '1'], ['ct-redos-requested', '1'], ['ct-walked-away', '2']]) {
          expect(page.document.getElementById(id!)?.getAttribute('data-n'), `${id} counts up to its field`).toBe(n);
          expect(page.document.getElementById(id!)?.closest('.dg-leaf')?.classList.contains('is-zero'), `${id} is not styled as a zero`).toBe(false);
        }
      } finally {
        page.close();
      }
    });

    it('renders the four operator rows bound to operatorCounts, in page order, under their own heading', async () => {
      const page = await renderConduct(baseUrl, 'conduct-page-buyer');
      try {
        const owner = Array.from(page.document.querySelectorAll('#operator-counts .dg-leaf')).map((l) => {
          const n = l.querySelector('.n');
          return [n?.id, n?.textContent, n?.getAttribute('data-n'), l.querySelector('.l')?.textContent, l.classList.contains('is-zero')];
        });
        expect(owner, 'each owner row on its own field, text and data-n, none in the zero style').toEqual([
          ['ct-delivered-never-paid', '2', '2', 'delivered and never paid for', false],
          ['ct-redos-refused', '1', '1', 'redos refused', false],
          ['ct-walked-after-deposit', '4', '4', 'walked away after the deposit', false],
          ['ct-paid-never-delivered', '5', '5', 'paid and never delivered', false],
        ]);
        // DIAG1c: the two headings are the diagram's branch heads now, and
        // each count hangs under its own.
        const heads = Array.from(page.document.querySelectorAll('.dg-group-head h3')).map((h) => h.textContent ?? '');
        expect(heads).toEqual(['When they hire', 'When their agents are hired']);
        for (const id of ['ct-delivered-never-paid', 'ct-redos-refused', 'ct-walked-after-deposit', 'ct-paid-never-delivered']) {
          expect(page.document.getElementById(id)?.closest('.dg-tree')?.querySelector('.dg-group-head h3')?.textContent, `${id} hangs under the owner branch`).toBe('When their agents are hired');
        }
      } finally {
        page.close();
      }
    });

    it('renders exactly ten count rows: six buyer, four operator, no ninth or eleventh', async () => {
      const page = await renderConduct(baseUrl, 'conduct-page-buyer');
      try {
        expect(page.document.querySelectorAll('.dg-leaf').length).toBe(10);
        expect(page.document.querySelectorAll('.dg-leaf .n').length).toBe(10);
        expect(page.document.querySelectorAll('#buyer-counts .dg-leaf').length).toBe(6);
        expect(page.document.querySelectorAll('#operator-counts .dg-leaf').length).toBe(4);
      } finally {
        page.close();
      }
    });
  });

  describe('the "How to read this" list (ruling 5)', () => {
    it('renders five items, behind "Show how to read this"', async () => {
      const page = await renderConduct(baseUrl, 'conduct-page-buyer');
      try {
        expect(page.document.querySelectorAll('.fixed li').length).toBe(5);
        expect(page.document.querySelector('.fixed')?.closest('#how-to-read'), 'the list sits inside its disclosure').not.toBeNull();
        const text = page.document.querySelector('.fixed')?.textContent ?? '';
        expect(text).toContain('These are counts, never a score');
        expect(text).toContain('Tied to a confirmed GitHub account');
        expect(text).toContain('A zero is shown as a zero');
        expect(text).toContain('Nothing here says anyone was wrong');
        expect(text).toContain('Operators can require a record before they take work');
      } finally {
        page.close();
      }
    });
  });

  describe('the scope fence: no percentage, no star, no letter grade, no sum (done means item 13)', () => {
    it('the document carries no percent sign, no star character, and no computed total of the two sides', async () => {
      const page = await renderConduct(baseUrl, 'conduct-page-buyer');
      try {
        const text = page.document.body.textContent ?? '';
        expect(text).not.toContain('%');
        expect(text).not.toMatch(/\u2605|\u2606/);
        // 8 (confirmed) + 1 (deliveredNeverPaid) is a plausible accidental
        // sum a bug could render; assert the actual sum never appears as
        // a standalone rendered count.
        const buyerConfirmed = Number(page.document.getElementById('ct-confirmed')?.textContent ?? '0');
        const operatorDeliveredNeverPaid = Number(page.document.getElementById('ct-delivered-never-paid')?.textContent ?? '0');
        const bogusSum = buyerConfirmed + operatorDeliveredNeverPaid;
        const renderedNumbers = Array.from(page.document.querySelectorAll('.dg-leaf .n')).map((n) => n.textContent);
        expect(renderedNumbers, 'the ten numbers are read').toHaveLength(10);
        expect(renderedNumbers).not.toContain(String(bogusSum));
        // The owner's four are never added to each other or to the record
        // as a whole: walkedAfterDeposit 4 + paidNeverDelivered 5 = 9, the
        // owner's four together 12, all ten 26. None is a real count here,
        // so any of them standing alone anywhere in the page is a sum.
        const owner = ['ct-delivered-never-paid', 'ct-redos-refused', 'ct-walked-after-deposit', 'ct-paid-never-delivered']
          .map((id) => Number(page.document.getElementById(id)?.textContent ?? 'NaN'));
        expect(owner, 'the owner\u2019s four, read off the page').toEqual([2, 1, 4, 5]);
        const all = renderedNumbers.map(Number);
        const sums = [owner[2]! + owner[3]!, owner.reduce((a, b) => a + b, 0), all.reduce((a, b) => a + b, 0)];
        expect(sums).toEqual([9, 12, 26]);
        for (const sum of sums) {
          expect(renderedNumbers, `${sum} is a sum, never a count`).not.toContain(String(sum));
          expect(text, `${sum} is a sum and shows nowhere on the page`).not.toMatch(new RegExp(`(^|\\D)${sum}(\\D|$)`));
        }
      } finally {
        page.close();
      }
    });
  });

  describe('every string is content, never markup (mutation proof 5)', () => {
    it('a githubLogin containing markup renders as literal text, never parsed', async () => {
      const markupLogin = '<img src=x onerror=alert(1)>evil-login';
      await accountRepo.register({ did: 'did:abt:conduct-page-markup', githubLogin: markupLogin });
      const page = await renderConduct(baseUrl, markupLogin);
      try {
        expect(page.document.getElementById('conduct-body')?.hidden).toBe(false);
        expect(page.document.querySelector('#who-name img')).toBeNull();
        expect(page.document.getElementById('who-name')?.textContent).toBe(markupLogin);
      } finally {
        page.close();
      }
    });
  });

  describe('no anchor on the page points at an unmounted path (mutation proof 7, standing defect inert-declared-control)', () => {
    it('every anchor with an href resolves to a path this build mounts', async () => {
      const page = await renderConduct(baseUrl, 'conduct-page-buyer');
      try {
        // NAV1: every page's signed-in row now carries the account menu's
        // /dashboard and /settings links in its static markup (hidden while
        // signed out). Both are mounted; asserted here rather than assumed.
        const mounted = new Set(['/', '/browse', '/how', '/signin', '/verify', '/dashboard', '/settings']);
        for (const path of ['/dashboard', '/settings']) {
          const res = await fetch(`${baseUrl}${path}`, { headers: { Accept: 'text/html' } });
          expect(res.status, `${path} is mounted`).toBe(200);
        }
        const anchors = Array.from(page.document.querySelectorAll('a[href]'));
        expect(anchors.length).toBeGreaterThan(0);
        anchors.forEach((a) => {
          const href = a.getAttribute('href') ?? '';
          expect(mounted.has(href), `unexpected anchor href: ${href}`).toBe(true);
        });
        // Ruling 6: no "Their agents" button/anchor exists at all -- the
        // wireframe's own control, not the "their agents" prose in the
        // section copy, which legitimately describes the operator side.
        const controlAnchors = Array.from(page.document.querySelectorAll('a')).filter((a) => (a.textContent ?? '').trim().toLowerCase() === 'their agents');
        expect(controlAnchors.length).toBe(0);
        expect(Array.from(page.document.querySelectorAll('a[href]')).some((a) => (a.getAttribute('href') ?? '').startsWith('/accounts/'))).toBe(false);
      } finally {
        page.close();
      }
    });
  });

  describe('the polished visual system (W-conduct)', () => {
    it('every component this page draws is declared by a sheet it actually loads', async () => {
      const page = await renderConduct(baseUrl, 'conduct-page-buyer');
      try {
        const css = await pageCss(page, baseUrl);
        // The components this page draws. Each must be declared somewhere
        // in the corpus: not in a named file, because where a rule lives
        // is this card's business and the next card's to change, but it
        // must exist where the page can reach it. DIAG1c: the counts are
        // the diagram's leaves now (.dg-leaf in diagrams.css), and the
        // wireframe's .counts grid and .ct rows no longer ship here.
        for (const selector of ['.who', '.who .av', '.fixed', '.sidenote', '.dg-root', '.dg-cols', '.dg-tree', '.dg-group-head', '.dg-counts', '.dg-leaf', '.dg-leaf.is-zero .n', '.dg-def']) {
          expect(
            declarationsOf(css, selector).length,
            `${selector} is declared by no stylesheet this page loads and no inline block`,
          ).toBeGreaterThan(0);
        }
      } finally {
        page.close();
      }
    });

    it('the page-local block declares only what no loaded sheet declares', async () => {
      const page = await renderConduct(baseUrl, 'conduct-page-buyer');
      try {
        const inline = Array.from(page.document.querySelectorAll('style'))
          .map((s) => s.textContent ?? '')
          .join('\n');
        // .sidenote is page copy styling and is declared nowhere else, so
        // it legitimately rides here. Everything else the page draws is
        // now flow.css's, and a local copy of a shared rule is dead
        // weight that drifts: assert the duplicates are gone rather than
        // trusting a reading of the file.
        expect(declarationsOf(inline, '.sidenote').length, '.sidenote should stay page-local').toBeGreaterThan(0);
        for (const selector of ['.counts', '.ct', '.fixed', '.who', '.dg-leaf']) {
          expect(
            declarationsOf(inline, selector),
            `${selector} is declared page-locally AND by a loaded sheet; the local copy will drift`,
          ).toEqual([]);
        }
      } finally {
        page.close();
      }
    });

    it('the account strip carries no avatar element, and leads flush with the page', async () => {
      // The avatar decision, asserted rather than described. There is no
      // mount point anywhere on the page or in its script, so the swarm
      // engine has nothing to paint: a data-avatar written into a comment
      // to satisfy a regex would not move this number.
      for (const account of ['conduct-page-buyer', 'conduct-page-cold-account']) {
        const page = await renderConduct(baseUrl, account);
        try {
          expect(page.document.querySelectorAll('[data-avatar]').length, `${account}: a mount with no DID behind it`).toBe(0);
          // DIAG1c: the diagram draws four icons (the root's GitHub mark
          // and the three struck plates) and its Replay one more, so the
          // page loads icons.js; an icon host outside the diagram would be
          // one it does not account for.
          expect(page.document.querySelectorAll('[data-ico]').length, `${account}: the diagram's five icon hosts`).toBe(5);
          expect(page.document.querySelectorAll('main [data-ico]:not(#conduct-diagram [data-ico])').length, `${account}: an icon host outside the diagram`).toBe(0);
          // No reserved box either: an empty disc on a single strip reads
          // as a failed image rather than as alignment, and the real
          // browser assertion below pins the geometry that says so.
          expect(page.document.querySelectorAll('.who .av').length, `${account}: a reserved avatar box with nothing that can fill it`).toBe(0);
          expect(page.document.getElementById('who-name'), 'the account name is the strip').not.toBeNull();
        } finally {
          page.close();
        }
      }
    });

    // The measurement behind the markup decision above, kept so a later
    // reader can re-derive it rather than take the comment's word.
    // Measured: with no avatar element the account name's left edge and
    // the h1's left edge are both 100 at 1280; inserting a 32px .av moves
    // the name to 144 and leaves the h1 at 100, a 44px indent with nothing
    // in it.
    it('the account name lines up with the heading under it, in a real browser', async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
        return;
      }
      const browser = await RealBrowser.launch({ width: 1280, height: 900 });
      try {
        await browser.goto(`${baseUrl}/conduct?account=conduct-page-buyer`);
        const edges = await browser.evaluate<{ name: number; h1: number; planted: number }>(`
          (() => {
            const left = (s) => Math.round(document.querySelector(s).getBoundingClientRect().left);
            const before = { name: left('.who .n'), h1: left('h1') };
            const who = document.querySelector('.who');
            const av = document.createElement('span');
            av.className = 'av';
            who.insertBefore(av, who.firstElementChild);
            const planted = left('.who .n');
            av.remove();
            return { ...before, planted };
          })()
        `);
        expect(edges.name, 'the account name must lead flush with the heading below it').toBe(edges.h1);
        // The control: a reserved box really does indent the name, so the
        // assertion above is measuring something rather than restating a
        // layout that could not differ.
        expect(edges.planted, 'a reserved avatar box should indent the name; if not, this gate proves nothing').toBeGreaterThan(edges.h1);
      } finally {
        await browser.close();
      }
    }, 60000);

    it('loads no avatar engine and no avatar core, because it mounts nothing for one to paint', async () => {
      const page = await renderConduct(baseUrl, 'conduct-page-buyer');
      try {
        // The scripts the page SHIPS, read from the served markup. The
        // rendered document is the wrong source for this: office.js adds
        // the avatar core and bots.js to <head> for the footer by itself,
        // at run time, on every page, so they appear there whatever this
        // page loads.
        const served = await (await fetch(`${baseUrl}/conduct?account=conduct-page-buyer`, { headers: { Accept: HTML } })).text();
        const scripts = [...served.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1] ?? '');
        expect(Array.from(page.document.querySelectorAll('body > script[src]')).map((s) => s.getAttribute('src')), 'the rendered page runs the same list').toEqual(scripts);
        // The card's rule: swarm.js ships here if and only if a mount
        // ships here. The assertion above pins the mount count at 0, so
        // this one pins the engine out, and the two can never disagree
        // without one of them going red. DIAG1c: the same holds for the
        // avatar core and bots.js, which draw agents; this page draws
        // none, and office.js fetches them for the footer by itself.
        expect(scripts, 'swarm.js on a page with no [data-avatar] is an engine with nothing to paint').not.toContain('/js/swarm.js');
        expect(scripts, 'bots.js on a page that draws no agent').not.toContain('/js/bots.js');
        expect(scripts.filter((s) => s.includes('bot-avatars')), 'the avatar core on a page that draws no agent').toEqual([]);
        // The whole list, in order: icons.js before polish.js and
        // diagrams.js (both paint icons), diagrams.js before conduct.js
        // (so FADiagram exists when the read lands), ui.js last (it
        // observes the .reveal block and wires the two disclosures).
        expect(scripts).toEqual([
          '/js/pages/api.js',
          '/js/pages/nav.js',
          '/js/office.js',
          '/js/icons.js',
          '/js/polish.js',
          '/js/diagrams.js',
          '/js/pages/conduct.js',
          '/js/pages/ui.js',
        ]);
      } finally {
        page.close();
      }
    });

    // The page is hidden at load and revealed by the read, so this is the
    // one state question JavaScript decides outright. Recorded as a fact
    // rather than repaired here: <main hidden> is how all four states stay
    // mutually exclusive, and changing it is a different card.
    it('with scripts disabled the page renders its shell and no counts, and says so', async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
        return;
      }
      const browser = await RealBrowser.launch({ width: 320, height: 800 });
      try {
        await browser.send('Emulation.setScriptExecutionDisabled', { value: true });
        await browser.goto(`${baseUrl}/conduct?account=conduct-page-buyer`);
        const seen = await browser.evaluate<{ text: string; counts: number; overflow: boolean; brand: string; logo: boolean }>(`
          ({
            text: (document.body.innerText || '').replace(/\\s+/g, ' ').trim(),
            counts: Array.from(document.querySelectorAll('.dg-leaf .n')).filter(n => n.textContent.trim() !== '').length,
            overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            brand: (document.querySelector('a.brand') || { getAttribute: () => '' }).getAttribute('aria-label') || '',
            logo: Array.from(document.querySelectorAll('a.brand img')).some(i => i.complete && i.naturalWidth > 0 && i.getBoundingClientRect().width > 0)
          })
        `);
        // No JS means no read, so no number may appear. What a reader gets
        // is the nav and the footer: the shell, never a half-filled record.
        expect(seen.counts, 'a count rendered with no read behind it').toBe(0);
        expect(seen.overflow, 'the scriptless page must not scroll sideways either').toBe(false);
        // The product name is the logo now (DESIGN.md section 8): an image
        // inside a labelled link, not a text node, so it is asserted as a
        // painted logo and a named link rather than read out of innerText.
        expect(seen.brand).toBe('FreeAgents home');
        expect(seen.logo, 'the logo did not paint with scripts off').toBe(true);
        expect(seen.text).toContain('How it works');
      } finally {
        await browser.close();
      }
      // Every real-browser test in this file carries its own timeout, the
      // same 60s tests/web/outcomes-polished.test.ts uses. Vitest's 5s
      // default is shorter than a cold Chrome launch plus four navigations,
      // and a test that times out mid-run never reaches its finally block:
      // one such timeout here left 34 headless Chromes alive, and the leak
      // looks exactly like the page being slow.
    }, 60000);

    it('reveal lands on visible content in both motion modes', async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
        return;
      }
      const browser = await RealBrowser.launch({ width: 1280, height: 900 });
      try {
        const read = async () =>
          browser.evaluate<{ jsReveal: boolean; hidden: number; total: number }>(`
            ({
              jsReveal: document.documentElement.classList.contains('js-reveal'),
              hidden: Array.from(document.querySelectorAll('.reveal'))
                .filter(r => getComputedStyle(r).opacity !== '1').length,
              total: document.querySelectorAll('.reveal').length
            })
          `);

        // Reduced motion: the hidden state sits inside a no-preference
        // query, so nothing is ever transparent, at any scroll position.
        // DIAG1c: one reveal block is left, the five items, and it sits
        // behind "Show how to read this"; both motion runs open it first,
        // as a reader would, so the block is measured where it can show.
        const open = "document.querySelector('[data-disclose=\"how-to-read\"]').click()";
        await browser.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        });
        await browser.goto(`${baseUrl}/conduct?account=conduct-page-buyer`);
        await browser.evaluate(open);
        const reduced = await read();
        expect(reduced.total, 'this page should carry one reveal block, the five items').toBe(1);
        expect(reduced.jsReveal, 'ui.js must not arm the hidden state under reduced motion').toBe(false);
        expect(reduced.hidden, 'a reduced-motion reader must see every block at full opacity').toBe(0);

        // Full motion: the hidden state is armed, and everything still
        // ends visible once scrolled. This is the end-state assertion, not
        // an absence-of-motion one: a block that never reveals fails here.
        await browser.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
        });
        await browser.goto(`${baseUrl}/conduct?account=conduct-page-buyer`);
        const armed = await read();
        expect(armed.jsReveal, 'ui.js should arm the hidden state when motion is allowed').toBe(true);
        await browser.evaluate(open);
        await browser.evaluate('window.scrollTo(0, document.body.scrollHeight)');

        // POLLED, NOT SLEPT. The reveal transition is 500ms (base.css's
        // named exception) and the observer adds .is-in on a later frame
        // than the scroll, so a block can sit mid-transition well past a
        // second: measured at opacity 0.18 1.2s after the scroll and 1
        // by 2.0s on an idle machine. A fixed sleep tuned to that turns
        // this into a gate that only passes when nothing else is running.
        // ui.js reveals everything unconditionally at 3s whatever the
        // observer did, so 8s is a deadline no correct page can miss and
        // a broken one cannot sneak through.
        let settled = await read();
        const deadline = Date.now() + 8000;
        while (settled.hidden > 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          settled = await read();
        }
        expect(settled.hidden, 'every reveal block must end visible after scrolling').toBe(0);
      } finally {
        await browser.close();
      }
    }, 60000);

    it('every interactive control clears 44px at 320, in the open nav state', async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
        return;
      }
      const browser = await RealBrowser.launch({ width: 320, height: 800 });
      try {
        await browser.goto(`${baseUrl}/conduct?account=conduct-page-buyer`);
        const small = await browser.evaluate<Array<{ t: string; h: number }>>(`
          Array.from(document.querySelectorAll('a[href], button'))
            .filter(e => e.getBoundingClientRect().height > 0)
            .map(e => ({ t: (e.textContent || '').trim().slice(0, 30),
                         h: Math.round(e.getBoundingClientRect().height) }))
            .filter(e => e.h < 44)
        `);
        expect(small, 'controls under the 44px floor at 320px').toEqual([]);
      } finally {
        await browser.close();
      }
    }, 60000);
  });

  // DIAG1c: THE BREAKPOINTS MOVED WITH THE LAYOUT. The counts used to be one
  // .counts grid (three columns, two under 700px, one under 380px). They
  // are the diagram's leaves now: each branch is one column of leaves, and
  // the two branches (.dg-cols) sit side by side above 900px and stack at
  // 900px and under, the width at which every diagram in diagrams.css
  // folds onto one rail. So the pins read .dg-cols at the component's own
  // breakpoint, in the same two ways they read .counts: the declared rule
  // text, and the used value in a real browser on both sides of it.
  describe('layout: the two branches side by side above 900px, stacked at 900px and under (layout-broken-at-desktop)', () => {
    it('the .dg-cols rules declare two columns, and one at the diagrams\u2019 900px breakpoint, in whichever sheet the page really gets them from', async () => {
      const page = await renderConduct(baseUrl, 'conduct-page-buyer');
      try {
        const css = (await pageCss(page, baseUrl)).replace(/\/\*[\s\S]*?\*\//g, '');
        expect(css).toMatch(/\.dg-cols\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)/);
        const narrow = /@media \(max-width:\s*900px\)\s*\{([\s\S]*?)\n\}/g;
        const blocks = [...css.matchAll(narrow)].map((m) => m[1] ?? '');
        expect(blocks.some((b) => /\.dg-cols\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/.test(b)), 'one column at 900px and under').toBe(true);
      } finally {
        page.close();
      }
    });

    // The assertion above reads DECLARED rule text, which says a rule is
    // written somewhere in the corpus and not that it decides anything.
    // This one reads the used value back off the real grid in a real
    // browser at three widths, so a rule that is present but loses the
    // cascade fails here even while the text match passes.
    it('at real viewports the branches really resolve to two columns at 1280 and one at 900, 600 and 320', async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
        return;
      }
      const browser = await RealBrowser.launch({ width: 1280, height: 900 });
      try {
        const read = async (width: number, height: number): Promise<number> => {
          await browser.setViewport(width, height);
          await browser.goto(`${baseUrl}/conduct?account=conduct-page-buyer`);
          return browser.evaluate<number>(`
            getComputedStyle(document.querySelector('#conduct-diagram .dg-cols')).gridTemplateColumns.split(' ').length
          `);
        };
        expect(await read(1280, 900), 'two branches side by side above 900px').toBe(2);
        expect(await read(900, 900), 'stacked at 900px').toBe(1);
        expect(await read(600, 900), 'stacked at 600px').toBe(1);
        expect(await read(320, 900), 'stacked at 320px').toBe(1);
      } finally {
        await browser.close();
      }
    }, 60000);

    // Done-means item 14, standing defect layout-broken-at-desktop: jsdom
    // performs no layout, so real overflow and real tap-target height can
    // only be proved with a real browser (the same instrument
    // tests/web/myagents.test.ts uses, tests/helpers/real-browser.ts).
    it('at a real 320px viewport there is no horizontal overflow', async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
        return;
      }
      const browser = await RealBrowser.launch({ width: 320, height: 900 });
      try {
        await browser.goto(`${baseUrl}/conduct?account=conduct-page-buyer`);
        const overflow = await browser.evaluate<{ scrollWidth: number; clientWidth: number }>(`
          ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })
        `);
        expect(overflow.scrollWidth, 'the 320px page must not scroll sideways').toBe(overflow.clientWidth);
      } finally {
        await browser.close();
      }
    }, 60000);
  });
});
