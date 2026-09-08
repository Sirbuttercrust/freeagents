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

  it('a signed-in operator with offers sees one row per offer, in the route\'s own order, each with the agent name, the repository, the brief and one state pill matching waitingOn -- and no control anywhere on the page points at an unmounted path (done-means 2, 3, 4)', async () => {
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

      // No control anywhere on any row: no anchor, no button.
      expect(page.document.querySelectorAll('#rows a').length).toBe(0);
      expect(page.document.querySelectorAll('#rows button').length).toBe(0);

      expect(page.document.documentElement.outerHTML).not.toContain(operatorSession.token);
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
    it('at 320px there is no horizontal overflow', async () => {
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
      } finally {
        await browser.close();
      }
    });
  });
});

