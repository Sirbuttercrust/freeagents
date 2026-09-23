// P8q: the Incoming work screen, driven end to end against the real app
// (the discipline tests/web/myjobs.test.ts and tests/web/myagents.test.ts
// already hold to). GET /accounts/me and GET /accounts/:did/incoming are
// both exercised for real, never asserted from a client-side stub.
import type { Server } from 'node:http';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { MemoryAccountRepository, MemoryAgentRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import { createJob, type Job, type Criterion } from '../../src/domain/job.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession } from '../helpers/session-fixtures.js';
import type { Session } from '../../src/adapters/identity/session.js';
import type { Delegation } from '../../src/domain/agent.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

// Real-browser layout tests launch Chrome, navigate at least once and
// evaluate in the page; vitest's 5000ms default times out under full-suite
// load exactly the way CI1 found in dashboard.test.ts and
// hire-polished.test.ts (run 35390871202, layout tests red on
// "Test timed out in 5000ms" with no layout defect). 30s is past every
// launch observed here and a genuinely broken layout still fails inside it.
const BROWSER_TIMEOUT_MS = 30_000;

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
// P8d: resolving a session to an account when none exists yet needs
// FREEAGENTS_PLATFORM_SEED, the same stance tests/web/myjobs.test.ts and
// tests/web/myagents.test.ts already take.
const PLATFORM_SEED = 'd'.repeat(64);

function delegationFixture(agentDid: string, operatorDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:delegation-for-${agentDid}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: agentDid },
    proof: { type: 'Ed25519Signature2020', created: '2026-01-01T00:00:00Z', verificationMethod: `${agentDid}#key-1`, proofPurpose: 'assertionMethod', proofValue: 'zfixture-not-verified-here' },
  };
}

function jobFixture(overrides: Partial<Job> & { id: string; buyerDid: string; agentDid: string }, createdAt: Date): Job {
  const base = createJob(
    { id: overrides.id, buyerDid: overrides.buyerDid, agentDid: overrides.agentDid, repository: overrides.repository ?? 'buyer/target-repo', brief: overrides.brief ?? 'Fix the login bug' },
    createdAt,
  );
  return { ...base, ...overrides };
}

interface Rendered {
  window: JSDOM['window'];
  document: Document;
  close: () => void;
}

async function renderIncoming(baseUrl: string, session: Session | null): Promise<Rendered> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  const response = await fetch(`${baseUrl}/incoming`, { headers: { Accept: HTML } });
  const markup = await response.text();
  const dom = new JSDOM(markup, {
    url: `${baseUrl}/incoming`,
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
  for (let waited = 0; waited < 400; waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);
  return { window: dom.window, document: dom.window.document, close: () => dom.window.close() };
}

describe('the Incoming work screen, driven end to end against the real app', () => {
  let agentRepo: MemoryAgentRepository;
  let jobRepo: MemoryJobRepository;
  let accountRepo: MemoryAccountRepository;
  let server: Server;
  let baseUrl: string;
  let operatorSession: Session;
  let agentDid: string;
  let originalSeed: string | undefined;

  beforeAll(async () => {
    originalSeed = process.env.FREEAGENTS_PLATFORM_SEED;
    process.env.FREEAGENTS_PLATFORM_SEED = PLATFORM_SEED;

    agentRepo = new MemoryAgentRepository();
    accountRepo = new MemoryAccountRepository();
    jobRepo = new MemoryJobRepository();

    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'incoming-page-operator', id: 9702 }),
    });

    const app = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    baseUrl = `http://127.0.0.1:${address.port}`;

    operatorSession = await mintSession(sessionAdapter);
    // The session provisions an account on its first authenticated call
    // (P8d, resolveActingParty); GET /accounts/me is that first call for
    // every test below, so the operator's real DID is not known ahead of
    // time here -- resolved once, then the fixture agent is created
    // against it (the same shape tests/web/myagents.test.ts uses for its
    // roster).
    const meRes = await fetch(`${baseUrl}/accounts/me`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${operatorSession.token}` },
    });
    const me = (await meRes.json()) as { did: string };
    const operatorDid = me.did;

    agentDid = 'did:abt:incoming-page-agent';
    await agentRepo.create({
      did: agentDid,
      operatorDid,
      delegation: delegationFixture(agentDid, operatorDid),
      name: 'incoming-page-scout',
      skills: ['triage'],
      githubLogin: null,
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalSeed === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
    else process.env.FREEAGENTS_PLATFORM_SEED = originalSeed;
  });

  it('a signed-out visitor is sent to sign in and no incoming read is ever attempted (done-means 5, mutation proof 3)', async () => {
    const page = await renderIncoming(baseUrl, null);
    try {
      expect(page.document.getElementById('signin-required')?.hidden).toBe(false);
      expect(page.document.getElementById('incoming-body')?.hidden).toBe(true);
      expect(page.document.querySelectorAll('#rows > *').length).toBe(0);
    } finally {
      page.close();
    }
  });

  it('an operator with zero offers sees the wireframe empty-state sentence and no control (done-means 6)', async () => {
    const page = await renderIncoming(baseUrl, operatorSession);
    try {
      expect(page.document.getElementById('load-error')?.hidden).toBe(true);
      expect(page.document.getElementById('incoming-body')?.hidden).toBe(false);
      expect(page.document.getElementById('empty-state')?.hidden).toBe(false);
      const emptyText = page.document.getElementById('empty-state')?.textContent ?? '';
      expect(emptyText).toContain('No work is waiting on a reply.');
      const controls = page.document.querySelectorAll('#empty-state a, #empty-state button');
      expect(controls.length).toBe(0);
    } finally {
      page.close();
    }
  });

  it('a signed-in operator with offers sees one row per offer, in the route\'s own order, each with the agent name, the repository, the brief and one state pill matching waitingOn, each row linking to the operator job page (done-means 2, 3, 4)', async () => {
    const noReplyCriteria: Criterion[] = [];
    const waitingOnBuyerCriteria: Criterion[] = [{ text: 'agent proposed', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: true }];
    const waitingOnOperatorCriteria: Criterion[] = [{ text: 'buyer edit', proposedBy: 'buyer', acceptedByBuyer: true, acceptedByAgent: false }];

    await jobRepo.create(jobFixture({ id: 'incoming-row-none', buyerDid: 'did:abt:incoming-buyer-1', agentDid, repository: 'lakeforge/ingest-service', brief: 'Watch for drift.', status: 'draft', criteria: noReplyCriteria }, new Date('2026-08-01T00:00:00Z')));
    await jobRepo.create(jobFixture({ id: 'incoming-row-buyer', buyerDid: 'did:abt:incoming-buyer-2', agentDid, repository: 'coalfield/api-tests', brief: 'Add property-based tests.', status: 'proposed', criteria: waitingOnBuyerCriteria }, new Date('2026-08-02T00:00:00Z')));
    await jobRepo.create(jobFixture({ id: 'incoming-row-operator', buyerDid: 'did:abt:incoming-buyer-3', agentDid, repository: 'northline/billing-api', brief: 'Migrate billing endpoints.', status: 'proposed', criteria: waitingOnOperatorCriteria }, new Date('2026-08-03T00:00:00Z')));

    const page = await renderIncoming(baseUrl, operatorSession);
    try {
      expect(page.document.getElementById('incoming-body')?.hidden).toBe(false);
      const rows = Array.from(page.document.querySelectorAll('#rows > *'));
      expect(rows.length).toBe(3);

      // Newest first, matching the route's own order (job-operator was
      // created last).
      const whos = rows.map((r) => r.querySelector('.who')?.textContent);
      expect(whos).toEqual(['incoming-page-scout', 'incoming-page-scout', 'incoming-page-scout']);

      const repos = rows.map((r) => r.querySelector('.repo')?.textContent);
      expect(repos).toEqual(['northline/billing-api', 'coalfield/api-tests', 'lakeforge/ingest-service']);

      const states = rows.map((r) => ({ cls: r.querySelector('.state')?.className, text: r.querySelector('.state')?.textContent }));
      expect(states[0]?.cls).toContain('state-none');
      expect(states[0]?.text).toContain('Buyer proposed a change, waiting on you');
      expect(states[1]?.cls).toContain('state-done');
      expect(states[1]?.text).toContain('Sent, waiting on the buyer');
      expect(states[2]?.cls).toContain('state-none');
      expect(states[2]?.text).toContain('New, nothing sent back yet');

      const briefs = rows.map((r) => r.querySelector('.brief')?.textContent);
      expect(briefs).toEqual(['Migrate billing endpoints.', 'Add property-based tests.', 'Watch for drift.']);

      // P8v built and mounted the operator job page, making every row a
      // full-row link. W7b reverts that (see the test below, "each
      // waitingOn state renders its own wireframe action"): a labelled
      // anchor inside a row-wide anchor is invalid markup and a
      // keyboard-navigation defect, so the destination moves from the
      // row to the wireframe's own per-state .foot button. This
      // assertion still proves the two things it always proved -- one
      // control per offer, each carrying that offer's own id, reaching a
      // path the app actually mounts (proven below by the review round 1
      // D2 test, which fetches every href against the real app) -- just
      // read off the button instead of the row.
      const footLinks = page.document.querySelectorAll('#rows .foot a');
      expect(footLinks.length).toBe(3);
      Array.from(footLinks).forEach((a) => {
        expect(a.getAttribute('href')).toMatch(/^\/operatorjob\?job=/);
      });
      expect(page.document.querySelectorAll('#rows a').length).toBe(3);
      expect(page.document.querySelectorAll('#rows button').length).toBe(0);

      expect(page.document.documentElement.outerHTML).not.toContain(operatorSession.token);
    } finally {
      page.close();
    }
  });

  it('each waitingOn state renders its own wireframe action, only noReply carries btn-primary, and each action reaches /operatorjob?job=<the offer\\u2019s own id> (W7b)', async () => {
    const noReplyCriteria: Criterion[] = [];
    const waitingOnBuyerCriteria: Criterion[] = [{ text: 'agent proposed', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: true }];
    const waitingOnOperatorCriteria: Criterion[] = [{ text: 'buyer edit', proposedBy: 'buyer', acceptedByBuyer: true, acceptedByAgent: false }];

    await jobRepo.create(jobFixture({ id: 'w7b-row-none', buyerDid: 'did:abt:w7b-buyer-1', agentDid, status: 'draft', criteria: noReplyCriteria }, new Date('2026-08-20T00:00:00Z')));
    await jobRepo.create(jobFixture({ id: 'w7b-row-buyer', buyerDid: 'did:abt:w7b-buyer-2', agentDid, status: 'proposed', criteria: waitingOnBuyerCriteria }, new Date('2026-08-21T00:00:00Z')));
    await jobRepo.create(jobFixture({ id: 'w7b-row-operator', buyerDid: 'did:abt:w7b-buyer-3', agentDid, status: 'proposed', criteria: waitingOnOperatorCriteria }, new Date('2026-08-22T00:00:00Z')));

    const page = await renderIncoming(baseUrl, operatorSession);
    try {
      const rows = Array.from(page.document.querySelectorAll('#rows > .orow'));
      expect(rows.length).toBeGreaterThanOrEqual(3);

      function footFor(jobId: string) {
        const link = Array.from(page.document.querySelectorAll('a')).find(
          (a) => a.getAttribute('href') === `/operatorjob?job=${jobId}`,
        );
        const row = link?.closest('.orow');
        return { link, foot: row?.querySelector('.foot') };
      }

      const noReply = footFor('w7b-row-none');
      expect(noReply.link?.textContent).toContain('Draft the agreement');
      expect(noReply.link?.classList.contains('btn-primary')).toBe(true);
      expect(noReply.foot?.querySelector('.small.dim')).toBeTruthy();

      const waitingOnBuyer = footFor('w7b-row-buyer');
      expect(waitingOnBuyer.link?.textContent).toContain('See what you sent');
      expect(waitingOnBuyer.link?.classList.contains('btn-primary')).toBe(false);

      const waitingOnOperator = footFor('w7b-row-operator');
      expect(waitingOnOperator.link?.textContent).toContain('Review the change');
      expect(waitingOnOperator.link?.classList.contains('btn-primary')).toBe(false);

      // The row itself is no longer a link: a labelled anchor inside a
      // row-wide anchor is invalid markup and a keyboard-navigation defect.
      expect(page.document.querySelector('#rows > a')).toBeNull();
    } finally {
      page.close();
    }
  });

  it('a 403 from the incoming route, a 503, and a network failure each render their own distinct sentence, and none renders the empty state (done-means 7)', async () => {
    // 403: a stranger's session naming another account. Rather than
    // exercising the real 403 gate (which requires the caller's own DID
    // to equal the path DID), this proxies GET /accounts/:did/incoming to
    // return each status directly, the same technique
    // tests/web/myagents.test.ts's own flaky-detail-read test uses.
    const realPort = (server.address() as AddressInfo).port;

    async function withStatus(status: number, body: unknown): Promise<string> {
      const proxy = http.createServer((req, res) => {
        if (req.url && req.url.startsWith('/accounts/') && req.url.endsWith('/incoming')) {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
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
        const page = await renderIncoming(proxyBaseUrl, operatorSession);
        try {
          expect(page.document.getElementById('empty-state')?.hidden).not.toBe(false);
          expect(page.document.getElementById('load-error')?.hidden).toBe(false);
          return page.document.getElementById('load-error-detail')?.textContent ?? '';
        } finally {
          page.close();
        }
      } finally {
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      }
    }

    const forbidden = await withStatus(403, { error: 'an account may only read its own incoming list' });
    const unavailable = await withStatus(503, { error: 'storage unavailable' });

    expect(forbidden).not.toBe('');
    expect(unavailable).not.toBe('');
    expect(forbidden).not.toBe(unavailable);

    // Network failure: point at a port nothing listens on.
    const deadPort = await new Promise<number>((resolve, reject) => {
      const probe = http.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const addr = probe.address() as AddressInfo;
        probe.close((err) => (err ? reject(err) : resolve(addr.port)));
      });
    });
    const deadBaseUrl = `http://127.0.0.1:${deadPort}`;
    const virtualConsole = new VirtualConsole();
    const failures: string[] = [];
    virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));
    const markup = readFileSync(new URL('../../src/web/pages/incoming.html', import.meta.url), 'utf8');
    const dom = new JSDOM(markup, {
      url: `${baseUrl}/incoming`,
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse(window) {
        window.sessionStorage.setItem('fa_session', JSON.stringify(operatorSession));
        Object.defineProperty(window, 'fetch', {
          writable: true,
          value: (input: string, init?: RequestInit) => {
            const url = new URL(String(input), baseUrl);
            if (url.pathname === '/accounts/me') return fetch(new URL('/accounts/me', baseUrl), init);
            return fetch(new URL(url.pathname + url.search, deadBaseUrl), init);
          },
        });
      },
    });
    // The scripts referenced by the fetched page markup are relative
    // paths the JSDOM constructor above cannot resolve without a real
    // fetch of /js/*, so this reads them from disk directly rather than
    // relying on JSDOM's own script loading (resources: 'usable' only
    // fetches via its internal loader, which still hits the real
    // network path). Load and eval them onto window in order.
    for (const rel of ['api.js', 'nav.js', 'incoming.js']) {
      const src = readFileSync(new URL(`../../src/web/public/js/pages/${rel}`, import.meta.url), 'utf8');
      dom.window.eval(src);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);
    try {
      expect(dom.window.document.getElementById('empty-state')?.hidden).not.toBe(false);
      const networkDetail = dom.window.document.getElementById('load-error-detail')?.textContent ?? '';
      expect(networkDetail).not.toBe('');
      expect(networkDetail).not.toBe(forbidden);
      expect(networkDetail).not.toBe(unavailable);
    } finally {
      dom.window.close();
    }
  });

  it('a non-200 from /accounts/me and an empty-did body each render the account sentence, distinct from every incoming-route sentence, and never issue the incoming read (review round 1 D1)', async () => {
    const realPort = (server.address() as AddressInfo).port;

    async function withAccountMe(respond: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ detail: string; incomingRequested: boolean }> {
      let incomingRequested = false;
      const proxy = http.createServer((req, res) => {
        if (req.url === '/accounts/me') {
          respond(req, res);
          return;
        }
        if (req.url && req.url.startsWith('/accounts/') && req.url.endsWith('/incoming')) {
          incomingRequested = true;
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
        const page = await renderIncoming(proxyBaseUrl, operatorSession);
        try {
          expect(page.document.getElementById('empty-state')?.hidden).not.toBe(false);
          expect(page.document.getElementById('load-error')?.hidden).toBe(false);
          const detail = page.document.getElementById('load-error-detail')?.textContent ?? '';
          return { detail, incomingRequested };
        } finally {
          page.close();
        }
      } finally {
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      }
    }

    const accountUnreadable = await withAccountMe((req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'account storage unavailable' }));
    });
    const accountNoDid = await withAccountMe((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({}));
    });

    // Distinct, honest copy naming the account read, not the incoming read.
    const incomingRouteSentences = [
      'Your incoming work could not be reached just now. Reloading may work.',
      'Your incoming work could not be confirmed for this account.',
      'Storage is unavailable just now. Try again in a moment.',
      'Your incoming work could not be loaded just now. Reloading may work.',
    ];
    expect(accountUnreadable.detail).not.toBe('');
    expect(accountNoDid.detail).not.toBe('');
    expect(incomingRouteSentences).not.toContain(accountUnreadable.detail);
    expect(incomingRouteSentences).not.toContain(accountNoDid.detail);

    // Neither refusal path fires the pointless GET /accounts//incoming --
    // the guard on the account read must stop the pipeline before the
    // second fetch, not merely render different copy after firing it.
    expect(accountUnreadable.incomingRequested).toBe(false);
    expect(accountNoDid.incomingRequested).toBe(false);
  });

  it('every anchor this page renders reaches a path the app actually mounts, asked of the real app rather than read out of an href (review round 1 D2, inert-declared-control)', async () => {
    // Its own fixture row, not reused from an earlier test: an anchor
    // this test's mutation proof adds must appear regardless of which
    // other tests in this file happen to run alongside it.
    await jobRepo.create(jobFixture({ id: 'incoming-anchor-check', buyerDid: 'did:abt:incoming-anchor-buyer', agentDid, status: 'draft', criteria: [] }, new Date('2026-08-12T00:00:00Z')));

    const page = await renderIncoming(baseUrl, operatorSession);
    try {
      expect(page.document.querySelectorAll('#rows > *').length).toBeGreaterThan(0);
      const hrefs = Array.from(page.document.querySelectorAll('a'))
        .map((a) => a.getAttribute('href'))
        .filter((h): h is string => h !== null && h.startsWith('/'));
      const uniquePaths = Array.from(new Set(hrefs));
      expect(uniquePaths.length).toBeGreaterThan(0);
      for (const path of uniquePaths) {
        const res = await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } });
        expect(res.status, `${path} must be served by the real app`).toBe(200);
      }
    } finally {
      page.close();
    }
  });

  it('a brief with markup renders as content, never markup (mutation proof 4)', async () => {
    await jobRepo.create(jobFixture({ id: 'incoming-markup', buyerDid: 'did:abt:incoming-markup-buyer', agentDid, brief: '<img src=x onerror=alert(1)>Ship it', status: 'draft', criteria: [] }, new Date('2026-08-10T00:00:00Z')));

    const page = await renderIncoming(baseUrl, operatorSession);
    try {
      expect(page.document.querySelector('#rows img')).toBeNull();
      const brief = Array.from(page.document.querySelectorAll('.brief')).find((b) => (b.textContent ?? '').indexOf('Ship it') !== -1);
      expect(brief?.textContent).toContain('<img src=x onerror=alert(1)>Ship it');
    } finally {
      page.close();
    }
  });

  describe('layout: 320px, the row wraps its .between and .foot rather than overflowing (layout-broken-at-desktop)', () => {
    it('at 320px there is no horizontal overflow and the foot action measures 44px or taller', async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
        return;
      }
      await jobRepo.create(jobFixture({ id: 'incoming-layout-row', buyerDid: 'did:abt:incoming-layout-buyer', agentDid, status: 'draft', criteria: [] }, new Date('2026-08-11T00:00:00Z')));

      const browser = await RealBrowser.launch({ width: 320, height: 900 });
      try {
        await browser.goto(`${baseUrl}/incoming`);
        await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(operatorSession))})`);
        await browser.goto(`${baseUrl}/incoming`);

        const overflow = await browser.evaluate<{ scrollWidth: number; clientWidth: number }>(`
          ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })
        `);
        expect(overflow.scrollWidth, 'the 320px page must not scroll sideways').toBe(overflow.clientWidth);

        const footAction = await browser.evaluate<{ found: boolean; height: number } | null>(`
          (function () {
            var link = document.querySelector('.orow .foot a');
            if (!link) return null;
            var r = link.getBoundingClientRect();
            return { found: true, height: r.height };
          })()
        `);
        expect(footAction?.found, 'at least one row foot action must render').toBe(true);
        // Subpixel slack, for the same reason the desktop guard below
        // carries it: this is a getBoundingClientRect() height against a
        // 44px min-height, so an exact 44 floor goes red on float noise
        // rather than on a short control. The 0.05px of slack is 240 times
        // narrower than the 12px drop to .btn-sm's own 32px, which is the
        // defect being caught.
        expect(footAction?.height, 'the foot action must reach the 44px tap floor at 320px').toBeGreaterThanOrEqual(43.95);
      } finally {
        await browser.close();
      }
    }, BROWSER_TIMEOUT_MS);

    // W-incoming item 4. The height check above cannot see this defect: a
    // button squeezed below its label is still 44px tall.
    //
    // MEASURED, 320px, Chrome, with each rule suppressed in turn (the
    // numbers in incoming.html's own comment come from this test): as
    // shipped the button is 152.31px around 134.31px of label, and with
    // either rule suppressed it is still 152.31px.
    //
    // So a gate that only looks at the page as it stands would pass with
    // `flex: none` deleted, which is the vacuous-gate defect. Each rule is
    // therefore pinned by suppressing its partner: with wrap off, only
    // `flex: none` is holding the button, and with `flex: none` off, only
    // wrap is. Delete either rule from the page and one arm goes red.
    it('at 320px the row action holds its label, and each of the two rules that hold it is pinned on its own (W-incoming item 4)', async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
        return;
      }
      await jobRepo.create(jobFixture({ id: 'incoming-shrink-row', buyerDid: 'did:abt:incoming-shrink-buyer', agentDid, status: 'draft', criteria: [] }, new Date('2026-08-13T00:00:00Z')));

      const browser = await RealBrowser.launch({ width: 320, height: 900 });
      try {
        await browser.goto(`${baseUrl}/incoming`);
        await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(operatorSession))})`);
        await browser.goto(`${baseUrl}/incoming`);

        // Each button's own label width comes from a Range over its text,
        // which reports the rendered ink rather than the padding box, so
        // the comparison is "does the button hold its text" and never "is
        // some CSS property set to some value".
        //
        // `suppress` removes one rule at a time through an inline style,
        // and every arm is restored before the next is measured.
        const measure = (suppress: 'nothing' | 'wrap' | 'flex-none') => browser.evaluate<{ label: string; boxWidth: number; textWidth: number }[]>(`
          (function () {
            var suppress = ${JSON.stringify(suppress)};
            var out = [];
            Array.prototype.forEach.call(document.querySelectorAll('.orow .foot'), function (foot) {
              foot.style.flexWrap = suppress === 'wrap' ? 'nowrap' : '';
              var btn = foot.querySelector('a.btn');
              if (!btn) return;
              btn.style.flex = suppress === 'flex-none' ? '0 1 auto' : '';
              var range = document.createRange();
              range.selectNodeContents(btn);
              out.push({
                label: btn.textContent,
                boxWidth: btn.getBoundingClientRect().width,
                textWidth: range.getBoundingClientRect().width,
              });
            });
            return out;
          })()
        `);

        for (const suppressed of ['nothing', 'wrap', 'flex-none'] as const) {
          const actions = await measure(suppressed);
          const held = suppressed === 'nothing' ? 'as shipped' : `with ${suppressed} suppressed`;
          expect(actions.length, `at least one row action must render at 320px (${held})`).toBeGreaterThan(0);
          for (const action of actions) {
            expect(action.textWidth, `"${action.label}" must measure as real rendered text`).toBeGreaterThan(0);
            expect(
              action.boxWidth,
              `${held}: "${action.label}" is ${action.boxWidth}px wide around ${action.textWidth}px of label, so the button shrank below its own text`,
            ).toBeGreaterThanOrEqual(action.textWidth);
          }
        }

        // And the document never scrolls sideways under any of the three,
        // because keeping the button wide is only a fix if it does not
        // push the page past 320px.
        const overflow = await browser.evaluate<number>(
          `document.documentElement.scrollWidth - document.documentElement.clientWidth`,
        );
        expect(overflow, 'the 320px page must not scroll sideways').toBe(0);
      } finally {
        await browser.close();
      }
    }, BROWSER_TIMEOUT_MS);

    // W-incoming, the class collision this rebuild surfaced. The
    // wireframe names the row's bottom strip `.foot`
    // (spec/wireframe/incoming.html:46) and this site uses the same word
    // for the page footer element (base.css:427-434). Nothing in the
    // wireframe's own sheets carries a bare `.foot` rule, so the clash
    // exists only on the built page, and it landed on every row.
    //
    // MEASURED before the page-local undo, served page, three rows: each
    // `.orow .foot` took `border-top: 1px solid var(--line)` from
    // base.css, drawing a hairline between the brief and the date that
    // the wireframe does not draw, and `.foot a { min-height: 44px }`
    // (base.css:433, a 0-1-1 selector) outranked `.btn-sm` (0-1-0) and
    // made the row action 44px tall at desktop where the wireframe's own
    // measures 32px.
    //
    // Both halves are asserted here, on both sides of the collision: the
    // row must be free of the footer's rules AND the page footer must
    // still have them, because an undo written too broadly would strip
    // the real footer instead.
    it('the row .foot does not inherit the page footer rules, and the page footer keeps them (W-incoming, .foot class collision)', async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
        return;
      }
      await jobRepo.create(jobFixture({ id: 'incoming-footclash-row', buyerDid: 'did:abt:incoming-footclash-buyer', agentDid, status: 'draft', criteria: [] }, new Date('2026-08-14T00:00:00Z')));

      // Desktop, because the 44px floor legitimately applies under
      // `(max-width: 760px), (pointer: coarse)` (polish.css:566-570) and
      // would mask the min-height half of this defect at phone width.
      const browser = await RealBrowser.launch({ width: 1280, height: 900 });
      try {
        await browser.goto(`${baseUrl}/incoming`);
        await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(operatorSession))})`);
        await browser.goto(`${baseUrl}/incoming`);

        const seen = await browser.evaluate<{
          rowFeet: { borderTopWidth: string; actionHeight: number }[];
          pageFooterBorderTop: string;
          pageFooterLinkHeights: number[];
        }>(`
          (function () {
            var rowFeet = Array.prototype.map.call(document.querySelectorAll('.orow .foot'), function (f) {
              var a = f.querySelector('a.btn');
              return {
                borderTopWidth: getComputedStyle(f).borderTopWidth,
                actionHeight: a ? a.getBoundingClientRect().height : -1,
              };
            });
            var pf = document.querySelector('footer.foot');
            return {
              rowFeet: rowFeet,
              pageFooterBorderTop: getComputedStyle(pf).borderTopWidth,
              pageFooterLinkHeights: Array.prototype.map.call(pf.querySelectorAll('a'), function (a) {
                return a.getBoundingClientRect().height;
              }),
            };
          })()
        `);

        expect(seen.rowFeet.length, 'at least one row must render').toBeGreaterThan(0);
        for (const foot of seen.rowFeet) {
          expect(foot.borderTopWidth, 'a row foot drew the page footer\u2019s hairline').toBe('0px');
          // Tolerance, not exactness, because the number under test is a
          // getBoundingClientRect() height and the two values it has to
          // tell apart are 12px apart. Written against a real defect: an
          // exact `toBe(32)` here read 32.00006103515625 on some runs of
          // the whole file and 32 on others, so the suite result depended
          // on how many rows earlier tests had already created. The 0.005
          // window toBeCloseTo's default precision gives is 2400 times
          // narrower than that 12px gap, so the page footer's 44px cannot
          // slip through it.
          expect(foot.actionHeight, 'the row action took the page footer\u2019s 44px min-height at desktop').toBeCloseTo(32);
        }

        // The other side of the same collision: the undo must be page-local
        // and must not reach the real footer.
        expect(seen.pageFooterBorderTop, 'the page footer lost its own top rule').not.toBe('0px');
        expect(seen.pageFooterLinkHeights.length).toBeGreaterThan(0);
        for (const height of seen.pageFooterLinkHeights) {
          expect(height, 'a page footer link fell under the 44px floor').toBeGreaterThanOrEqual(44);
        }
      } finally {
        await browser.close();
      }
    }, BROWSER_TIMEOUT_MS);
  });

  // W-incoming item 1, the W11 D2 defect class
  // (script-rendered-icon-never-painted). icons.js paints every [data-ico]
  // host ONCE at load (icons.js:116-123) and every row on this page is
  // built by renderRows after a fetch resolves, long after that sweep. A
  // host offerRow creates and hands to the sweep stays an empty box
  // forever, which no screenshot of a static shell can show. This asserts
  // the painter ran over a SCRIPT-BUILT host: every pill icon inside
  // #rows carries a real <svg> child with real path geometry.
  it('every state-pill icon offerRow builds is painted, not left for the load sweep (W11 D2, script-rendered-icon-never-painted)', async () => {
    const noReplyCriteria: Criterion[] = [];
    const waitingOnBuyerCriteria: Criterion[] = [{ text: 'agent proposed', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: true }];
    const waitingOnOperatorCriteria: Criterion[] = [{ text: 'buyer edit', proposedBy: 'buyer', acceptedByBuyer: true, acceptedByAgent: false }];

    await jobRepo.create(jobFixture({ id: 'paint-row-none', buyerDid: 'did:abt:paint-buyer-1', agentDid, status: 'draft', criteria: noReplyCriteria }, new Date('2026-08-24T00:00:00Z')));
    await jobRepo.create(jobFixture({ id: 'paint-row-buyer', buyerDid: 'did:abt:paint-buyer-2', agentDid, status: 'proposed', criteria: waitingOnBuyerCriteria }, new Date('2026-08-25T00:00:00Z')));
    await jobRepo.create(jobFixture({ id: 'paint-row-operator', buyerDid: 'did:abt:paint-buyer-3', agentDid, status: 'proposed', criteria: waitingOnOperatorCriteria }, new Date('2026-08-26T00:00:00Z')));

    const page = await renderIncoming(baseUrl, operatorSession);
    try {
      // The hosts must exist at all, and they must be inside #rows, which
      // is the part the static shell cannot supply.
      const hosts = Array.from(page.document.querySelectorAll('#rows .state .ico[data-ico]'));
      expect(hosts.length, 'every rendered row must mount a state-pill icon host').toBeGreaterThanOrEqual(3);

      for (const host of hosts) {
        const name = host.getAttribute('data-ico');
        const svg = host.firstElementChild;
        expect(svg, `the ${String(name)} host inside #rows is empty: the load sweep ran before this row existed`).not.toBeNull();
        expect(svg?.tagName.toLowerCase()).toBe('svg');
        // Real geometry, not an empty <svg> shell: icons.js fills the
        // glyph from its own path table (icons.js:52,56 carry both names
        // this page uses).
        expect(svg?.innerHTML ?? '', `the ${String(name)} glyph painted no geometry`).toContain('<path');
      }

      // And the page's static shell mounts none of them, which is why the
      // load sweep could never have covered these: this is the assertion
      // that makes the one above about renderRows rather than markup.
      const shell = readFileSync(new URL('../../src/web/pages/incoming.html', import.meta.url), 'utf8');
      expect(shell, 'the static page must not pre-mount pill icon hosts; these come from offerRow').not.toContain('data-ico');
    } finally {
      page.close();
    }
  });

  // W-incoming item 3. The pill is a three-way mapping and each arm has
  // its own class, its own glyph NAME (not merely some glyph) and its own
  // sentence. A single STATE_INFO table drives all three, so a mapping
  // that drifts on any one axis fails here.
  it('each waitingOn value renders its own pill class, glyph name and sentence, and the primary button appears on noReply alone (W-incoming item 3)', async () => {
    const noReplyCriteria: Criterion[] = [];
    const waitingOnBuyerCriteria: Criterion[] = [{ text: 'agent proposed', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: true }];
    const waitingOnOperatorCriteria: Criterion[] = [{ text: 'buyer edit', proposedBy: 'buyer', acceptedByBuyer: true, acceptedByAgent: false }];

    await jobRepo.create(jobFixture({ id: 'pill-row-none', buyerDid: 'did:abt:pill-buyer-1', agentDid, status: 'draft', criteria: noReplyCriteria }, new Date('2026-08-27T00:00:00Z')));
    await jobRepo.create(jobFixture({ id: 'pill-row-buyer', buyerDid: 'did:abt:pill-buyer-2', agentDid, status: 'proposed', criteria: waitingOnBuyerCriteria }, new Date('2026-08-28T00:00:00Z')));
    await jobRepo.create(jobFixture({ id: 'pill-row-operator', buyerDid: 'did:abt:pill-buyer-3', agentDid, status: 'proposed', criteria: waitingOnOperatorCriteria }, new Date('2026-08-29T00:00:00Z')));

    const page = await renderIncoming(baseUrl, operatorSession);
    try {
      function rowFor(jobId: string) {
        const link = Array.from(page.document.querySelectorAll('#rows a')).find(
          (a) => a.getAttribute('href') === `/operatorjob?job=${jobId}`,
        );
        const row = link?.closest('.orow');
        if (!row) throw new Error(`no row rendered for ${jobId}`);
        const pill = row.querySelector('.state');
        return {
          cls: pill?.className ?? '',
          ico: pill?.querySelector('.ico')?.getAttribute('data-ico') ?? '',
          text: (pill?.textContent ?? '').trim(),
          primary: link?.classList.contains('btn-primary') ?? false,
        };
      }

      // The wireframe's own three pills (spec/wireframe/incoming.html:93,
      // 114, 135), read off the built page.
      const noReply = rowFor('pill-row-none');
      expect(noReply.cls).toContain('state-none');
      expect(noReply.ico).toBe('minus-circle');
      expect(noReply.text).toBe('New, nothing sent back yet');
      expect(noReply.primary, 'the unanswered row carries the page\u2019s one primary action').toBe(true);

      const waitingOnBuyer = rowFor('pill-row-buyer');
      expect(waitingOnBuyer.cls).toContain('state-done');
      expect(waitingOnBuyer.ico).toBe('check-circle');
      expect(waitingOnBuyer.text).toBe('Sent, waiting on the buyer');
      expect(waitingOnBuyer.primary, 'nothing is due from the operator on this row').toBe(false);

      const waitingOnOperator = rowFor('pill-row-operator');
      expect(waitingOnOperator.cls).toContain('state-none');
      expect(waitingOnOperator.ico).toBe('minus-circle');
      expect(waitingOnOperator.text).toBe('Buyer proposed a change, waiting on you');
      expect(waitingOnOperator.primary, 'only the unanswered row is emphasised').toBe(false);

      // The three arms are genuinely distinct on the two axes that can
      // silently collapse into one: the glyph and the sentence.
      const glyphs = [noReply.ico, waitingOnBuyer.ico, waitingOnOperator.ico];
      expect(new Set(glyphs).size, 'check-circle must not be the glyph on every state').toBe(2);
      const sentences = [noReply.text, waitingOnBuyer.text, waitingOnOperator.text];
      expect(new Set(sentences).size, 'each state says its own sentence').toBe(3);

      // The .dot this pill used to carry is gone: the wireframe draws a
      // glyph, and a page carrying both would draw two markers.
      expect(page.document.querySelectorAll('#rows .state .dot').length).toBe(0);
    } finally {
      page.close();
    }
  });

  // W-incoming item 2. The wireframe's one data-avatar is the face on its
  // nav account menu (spec/wireframe/incoming.html:66), never a row: its
  // three .orow rows draw none. The conformance gate's own 'avatars'
  // entry states that reason; this pins the behaviour it excuses, so the
  // entry is not a claim with nothing behind it (guard-without-a-test).
  //
  // The route DOES carry agentDid on every offer (src/api/app.ts:1720-
  // 1727), so the absence is a design call rather than a data limit, and
  // that makes the second half of this test the one that matters: no
  // identity is ever derived from an agent NAME anywhere in this file.
  it('no row carries an avatar, and no identity is ever derived from an agent name (W-incoming item 2)', async () => {
    await jobRepo.create(jobFixture({ id: 'avatar-absence-row', buyerDid: 'did:abt:avatar-absence-buyer', agentDid, status: 'draft', criteria: [] }, new Date('2026-08-30T00:00:00Z')));

    const page = await renderIncoming(baseUrl, operatorSession);
    try {
      expect(page.document.querySelectorAll('#rows > .orow').length).toBeGreaterThan(0);
      expect(page.document.querySelectorAll('#rows [data-avatar]').length, 'the wireframe\u2019s rows draw no face; neither do these').toBe(0);
      expect(page.document.querySelectorAll('[data-avatar]').length, 'the nav account menu is not built (nav.js:91-126), so no avatar mounts anywhere').toBe(0);
      expect(page.document.querySelectorAll('#rows img, #rows svg.av, #rows .av, #rows .rav').length).toBe(0);
    } finally {
      page.close();
    }

    // swarm.js is the engine that fills a [data-avatar]; loading it on a
    // page with no mount would be a script with nothing to paint.
    const shell = readFileSync(new URL('../../src/web/pages/incoming.html', import.meta.url), 'utf8');
    expect(shell).not.toContain('data-avatar');
    expect(shell, 'swarm.js has nothing to paint on this page').not.toContain('/js/swarm.js');

    // No identity is derived from a NAME. The script reads agentDid for
    // the fallback label only (A.shortDid), and FASwarm.avatar, FA.avatar
    // and every hash-a-string-into-a-face shape are absent outright.
    const script = readFileSync(new URL('../../src/web/public/js/pages/incoming.js', import.meta.url), 'utf8');
    expect(script).not.toContain('FASwarm');
    expect(script).not.toContain('FA.avatar');
    expect(script).not.toContain('data-avatar');
    expect(script, 'agentName is a label, never an identity to draw from').not.toMatch(/avatar\s*\(\s*[^)]*agentName/);
  });
});

