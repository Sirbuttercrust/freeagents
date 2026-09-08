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
    // an agent feed operatorCounts. One delivered-never-paid, one redo
    // refused.
    await jobRepo.create(jobFixture('job-op-delivered-never-paid', 'did:abt:conduct-page-other-buyer', OWN_AGENT_DID, { status: 'staged_declined', confirmedAt: new Date('2026-08-02T00:00:00Z') }));
    await jobRepo.create(jobFixture('job-op-redo-refused', 'did:abt:conduct-page-other-buyer', OWN_AGENT_DID, { status: 'staged_declined', confirmedAt: new Date('2026-08-02T00:00:00Z'), redoRequestedAt: new Date('2026-08-03T00:00:00Z'), redoRefusedAt: new Date('2026-08-04T00:00:00Z') }));

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

  describe('the cold start (ruling 4, mutation proof 3): same render path, same selectors, zeros', () => {
    it('a keyed account with no history renders all eight rows at zero, through the exact same selectors as a populated account', async () => {
      const page = await renderConduct(baseUrl, 'conduct-page-cold-account');
      try {
        expect(page.document.getElementById('conduct-body')?.hidden).toBe(false);
        expect(page.document.getElementById('load-error')?.hidden).toBe(true);
        expect(page.document.getElementById('not-keyed')?.hidden).toBe(true);
        const ids = ['ct-confirmed', 'ct-merged', 'ct-deemed', 'ct-cited-closes', 'ct-redos-requested', 'ct-walked-away', 'ct-delivered-never-paid', 'ct-redos-refused'];
        ids.forEach((id) => {
          expect(page.document.getElementById(id)?.textContent).toBe('0');
        });
        expect(page.document.querySelectorAll('.ct').length).toBe(8);
        // Mutation proof 3: the zero case renders through the exact same
        // selectors as the populated case, never a second branch with its
        // own marker.
        expect(page.document.getElementById('buyer-counts')?.hasAttribute('data-cold-start')).toBe(false);
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
      } finally {
        page.close();
      }
    });

    it('renders the two operator rows bound to operatorCounts, under their own heading', async () => {
      const page = await renderConduct(baseUrl, 'conduct-page-buyer');
      try {
        expect(page.document.getElementById('ct-delivered-never-paid')?.textContent).toBe('2');
        expect(page.document.getElementById('ct-redos-refused')?.textContent).toBe('1');
        const headings = Array.from(page.document.querySelectorAll('h2')).map((h) => h.textContent ?? '');
        expect(headings.some((h) => h.toLowerCase().includes('when they hire'))).toBe(true);
        expect(headings.some((h) => h.toLowerCase().includes('when their agents are hired'))).toBe(true);
      } finally {
        page.close();
      }
    });

    it('renders exactly eight count rows: six buyer, two operator, no seventh or ninth', async () => {
      const page = await renderConduct(baseUrl, 'conduct-page-buyer');
      try {
        expect(page.document.querySelectorAll('.ct').length).toBe(8);
        expect(page.document.querySelectorAll('#buyer-counts .ct').length).toBe(6);
        expect(page.document.querySelectorAll('#operator-counts .ct').length).toBe(2);
      } finally {
        page.close();
      }
    });
  });

  describe('the "How to read this" list (ruling 5)', () => {
    it('renders five items', async () => {
      const page = await renderConduct(baseUrl, 'conduct-page-buyer');
      try {
        expect(page.document.querySelectorAll('.fixed li').length).toBe(5);
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
        const renderedNumbers = Array.from(page.document.querySelectorAll('.ct .n')).map((n) => n.textContent);
        expect(renderedNumbers).not.toContain(String(bogusSum));
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
        const mounted = new Set(['/', '/browse', '/how', '/signin', '/verify']);
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

  describe('layout: three columns, two under 700px, one under 380px (layout-broken-at-desktop)', () => {
    it('the .counts grid rules match the wireframe breakpoints', async () => {
      const page = await renderConduct(baseUrl, 'conduct-page-buyer');
      try {
        const css = page.document.querySelector('style')?.textContent ?? '';
        expect(css).toMatch(/\.counts\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*1fr\)/);
        expect(css).toMatch(/@media \(max-width:\s*700px\)\s*\{\s*\.counts\s*\{\s*grid-template-columns:\s*repeat\(2,\s*1fr\)/);
        expect(css).toMatch(/@media \(max-width:\s*380px\)\s*\{\s*\.counts\s*\{\s*grid-template-columns:\s*1fr/);
      } finally {
        page.close();
      }
    });

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
    });
  });
});
