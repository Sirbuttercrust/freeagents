// P8u: the dashboard screen, driven end to end against the real app (the
// discipline tests/web/myjobs.test.ts and tests/web/incoming.test.ts
// already hold to). GET /accounts/me, GET /accounts/:did/jobs,
// GET /accounts/:did/pending and GET /accounts/:did/incoming are all
// exercised for real, never asserted from a client-side stub.
import type { Server } from 'node:http';
import http from 'node:http';
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
// tests/web/incoming.test.ts already take.
const PLATFORM_SEED = 'c'.repeat(64);

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

async function renderDashboard(baseUrl: string, session: { token: string } | null): Promise<Rendered> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  const response = await fetch(`${baseUrl}/dashboard`, { headers: { Accept: HTML } });
  const markup = await response.text();
  const dom = new JSDOM(markup, {
    url: `${baseUrl}/dashboard`,
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
  for (let waited = 0; waited < 500; waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);
  return { window: dom.window, document: dom.window.document, close: () => dom.window.close() };
}

function sectionHeadings(document: Document): string[] {
  return Array.from(document.querySelectorAll('#dgrid > section h2')).map((h) => h.textContent ?? '');
}

function sectionByHeading(document: Document, heading: string): Element | null {
  return Array.from(document.querySelectorAll('#dgrid > section')).find(
    (s) => s.querySelector('h2')?.textContent === heading,
  ) ?? null;
}

describe('the dashboard screen, driven end to end against the real app', () => {
  let agentRepo: MemoryAgentRepository;
  let jobRepo: MemoryJobRepository;
  let accountRepo: MemoryAccountRepository;
  let server: Server;
  let baseUrl: string;
  let buyerSession: Session;
  let agentDid: string;
  let originalSeed: string | undefined;

  beforeAll(async () => {
    originalSeed = process.env.FREEAGENTS_PLATFORM_SEED;
    process.env.FREEAGENTS_PLATFORM_SEED = PLATFORM_SEED;

    agentDid = 'did:abt:dashboard-page-agent';
    const operatorDid = 'did:abt:dashboard-page-operator';

    agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agentDid,
      operatorDid,
      delegation: delegationFixture(agentDid, operatorDid),
      name: 'dashboard-page-scout',
      skills: ['triage'],
      githubLogin: null,
    });

    accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: operatorDid, githubLogin: 'dashboard-page-operator-login' });

    jobRepo = new MemoryJobRepository();

    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'dashboard-page-buyer', id: 9801 }),
    });

    const app = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    baseUrl = `http://127.0.0.1:${address.port}`;

    buyerSession = await mintSession(sessionAdapter);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalSeed === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
    else process.env.FREEAGENTS_PLATFORM_SEED = originalSeed;
  });

  it('serves the page as HTML on a plain own-path mount (done-means 1)', async () => {
    const res = await fetch(`${baseUrl}/dashboard`, { headers: { Accept: HTML } });
    expect(res.status).toBe(200);
    expect(String(res.headers.get('content-type'))).toContain('text/html');
    expect(await res.text()).toContain('<!doctype html>');
  });

  it('a signed-out visitor sees the sign-in block and takes no authenticated read (done-means 2)', async () => {
    const page = await renderDashboard(baseUrl, null);
    try {
      expect(page.document.getElementById('signin-required')?.hidden).toBe(false);
      expect(page.document.getElementById('dashboard-body')?.hidden).toBe(true);
      expect(page.document.querySelectorAll('#dgrid > *').length).toBe(0);
    } finally {
      page.close();
    }
  });

  it('a buyer with nothing waiting sees the wireframe empty state, one sentence and one Browse agents action, and no grid (done-means 9)', async () => {
    const page = await renderDashboard(baseUrl, buyerSession);
    try {
      expect(page.document.getElementById('load-error')?.hidden).toBe(true);
      expect(page.document.getElementById('dashboard-body')?.hidden).toBe(false);
      expect(page.document.getElementById('page-empty-state')?.hidden).toBe(false);
      expect(page.document.getElementById('grid-wrap')?.hidden).toBe(true);
      const emptyText = page.document.getElementById('page-empty-state')?.textContent ?? '';
      expect(emptyText).toContain('Nothing needs your attention today.');
      const browseLinks = Array.from(page.document.querySelectorAll('#page-empty-state a')).filter((a) => a.textContent === 'Browse agents');
      expect(browseLinks.length).toBe(1);
      expect(browseLinks[0]?.getAttribute('href')).toBe('/browse');
    } finally {
      page.close();
    }
  });

  it('takes exactly four reads: /accounts/me, then jobs, pending and incoming, no per-agent read (done-means 3)', async () => {
    const requested: string[] = [];
    const virtualConsole = new VirtualConsole();
    const failures: string[] = [];
    virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));
    const response = await fetch(`${baseUrl}/dashboard`, { headers: { Accept: HTML } });
    const markup = await response.text();
    const dom = new JSDOM(markup, {
      url: `${baseUrl}/dashboard`,
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse(window) {
        window.sessionStorage.setItem('fa_session', JSON.stringify(buyerSession));
        Object.defineProperty(window, 'fetch', {
          writable: true,
          value: (input: string, init?: RequestInit) => {
            requested.push(String(input));
            return fetch(new URL(input, baseUrl), init);
          },
        });
      },
    });
    try {
      await new Promise<void>((resolve) => {
        if (dom.window.document.readyState === 'complete') resolve();
        else dom.window.addEventListener('load', () => resolve());
      });
      for (let waited = 0; waited < 500; waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);
      const paths = requested.map((r) => new URL(r, baseUrl).pathname);
      expect(paths).toContain('/accounts/me');
      const jobsCount = paths.filter((p) => p.endsWith('/jobs')).length;
      const pendingCount = paths.filter((p) => p.endsWith('/pending')).length;
      const incomingCount = paths.filter((p) => p.endsWith('/incoming')).length;
      expect(jobsCount).toBe(1);
      expect(pendingCount).toBe(1);
      expect(incomingCount).toBe(1);
      // Exactly four reads total: me + jobs + pending + incoming.
      expect(paths.length).toBe(4);
      // No per-agent read: /agents/:agentDid never appears.
      expect(paths.some((p) => /^\/agents\/[^/]+$/.test(p))).toBe(false);
    } finally {
      dom.window.close();
    }
  });

  it('section 1 renders waitingOnYou job rows and waitingOnBuyer pending rows, newest first, capped at five, with See all to /myjobs, and the primary sits on the first pending row (done-means 4, 10)', async () => {
    const meRes = await fetch(`${baseUrl}/accounts/me`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${buyerSession.token}` },
    });
    const me = (await meRes.json()) as { did: string };
    const buyerDid = me.did;

    // A staged job (waitingOnYou), older than the pending offer.
    await jobRepo.create(jobFixture({ id: 'd1-staged', buyerDid, agentDid, status: 'staged', stagedAt: new Date('2026-08-01T00:00:00Z') }, new Date('2026-08-01T00:00:00Z')));
    // A pending row waiting on the buyer's signature (draft/proposed with
    // every criterion agent-signed), newer than the staged job.
    const buyerCriteria: Criterion[] = [{ text: 'agent signed', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: true }];
    await jobRepo.create(jobFixture({ id: 'd1-pending-buyer', buyerDid, agentDid, status: 'proposed', criteria: buyerCriteria }, new Date('2026-08-05T00:00:00Z')));

    const page = await renderDashboard(baseUrl, buyerSession);
    try {
      expect(sectionHeadings(page.document)).toContain('Waiting on you');
      const section = sectionByHeading(page.document, 'Waiting on you');
      expect(section).not.toBeNull();
      const seeAll = section?.querySelector('a.small');
      expect(seeAll?.getAttribute('href')).toBe('/myjobs');

      const rows = Array.from(section?.querySelectorAll('.rows > *') ?? []);
      expect(rows.length).toBe(2);
      // Newest first: the pending row (Aug 5) before the staged job (Aug 1).
      const primary = rows[0]?.querySelector('a.btn-primary');
      expect(primary).not.toBeNull();
      expect(primary?.textContent).toBe('Read and sign');
      expect(primary?.getAttribute('href')).toBe('/agreement?job=d1-pending-buyer');

      const jobRow = rows[1];
      expect(jobRow?.tagName.toLowerCase()).toBe('a');
      expect(jobRow?.getAttribute('href')).toBe('/jobs/d1-staged');
    } finally {
      page.close();
    }
  });

  it('section 2 renders inProgress job rows and noReply/waitingOnOperator pending rows, newest first, capped at five, See all to /myjobs, and no control on any pending row (done-means 5)', async () => {
    const meRes = await fetch(`${baseUrl}/accounts/me`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${buyerSession.token}` },
    });
    const me = (await meRes.json()) as { did: string };
    const buyerDid = me.did;

    await jobRepo.create(jobFixture({ id: 'd2-confirmed', buyerDid, agentDid, status: 'confirmed', confirmedAt: new Date('2026-08-02T00:00:00Z') }, new Date('2026-08-02T00:00:00Z')));
    // A draft with no criteria (noReply).
    await jobRepo.create(jobFixture({ id: 'd2-pending-noreply', buyerDid, agentDid, status: 'draft', criteria: [] }, new Date('2026-08-06T00:00:00Z')));
    // A proposed job where the buyer edited (waitingOnOperator).
    const operatorCriteria: Criterion[] = [{ text: 'buyer edit', proposedBy: 'buyer', acceptedByBuyer: true, acceptedByAgent: false }];
    await jobRepo.create(jobFixture({ id: 'd2-pending-operator', buyerDid, agentDid, status: 'proposed', criteria: operatorCriteria }, new Date('2026-08-07T00:00:00Z')));

    const page = await renderDashboard(baseUrl, buyerSession);
    try {
      const section = sectionByHeading(page.document, 'In progress');
      expect(section).not.toBeNull();
      expect(section?.querySelector('a.small')?.getAttribute('href')).toBe('/myjobs');

      const rows = Array.from(section?.querySelectorAll('.rows > *') ?? []);
      expect(rows.length).toBe(3);
      // Newest first: operator (Aug 7), noreply (Aug 6), confirmed (Aug 2).
      expect(rows[0]?.textContent).toContain('Waiting on the agent to sign');
      expect(rows[1]?.textContent).toContain('Brief sent, no reply yet');

      // No control at all on either pending row: no anchor, no button.
      expect(rows[0]?.querySelectorAll('a, button').length).toBe(0);
      expect(rows[1]?.querySelectorAll('a, button').length).toBe(0);
      expect(rows[0]?.tagName.toLowerCase()).toBe('div');
      expect(rows[1]?.tagName.toLowerCase()).toBe('div');

      // The confirmed job is still a real anchor to /jobs/:id.
      expect(rows[2]?.tagName.toLowerCase()).toBe('a');
      expect(rows[2]?.getAttribute('href')).toBe('/jobs/d2-confirmed');
    } finally {
      page.close();
    }
  });

  it('section 3 renders incoming offers, newest first, capped at five, See all to /incoming (done-means 6)', async () => {
    const operatorDid = 'did:abt:dashboard-page-operator';
    await jobRepo.create(jobFixture({ id: 'd3-offer-a', buyerDid: 'did:abt:dashboard-buyer-x', agentDid, status: 'draft', criteria: [] }, new Date('2026-08-03T00:00:00Z')));
    await jobRepo.create(jobFixture({ id: 'd3-offer-b', buyerDid: 'did:abt:dashboard-buyer-y', agentDid, status: 'draft', criteria: [] }, new Date('2026-08-08T00:00:00Z')));

    // Sign in as the operator who runs this agent.
    const operatorSessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'dashboard-page-operator-login', id: 9802 }),
    });
    // Reuse the same account by resolving through /accounts/me on a fresh
    // session for the operator login already registered in beforeAll.
    const operatorSession = await mintSession(operatorSessionAdapter);
    const app2 = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, undefined, undefined, undefined, undefined, operatorSessionAdapter);
    const server2 = app2.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server2.once('listening', resolve));
    const address2 = server2.address();
    if (address2 === null || typeof address2 === 'string') throw new Error('expected a port');
    const baseUrl2 = `http://127.0.0.1:${address2.port}`;
    try {
      const meRes = await fetch(`${baseUrl2}/accounts/me`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${operatorSession.token}` },
      });
      const me = (await meRes.json()) as { did: string };
      expect(me.did).toBe(operatorDid);

      const page = await renderDashboard(baseUrl2, operatorSession);
      try {
        const section = sectionByHeading(page.document, 'Your agents need attention');
        expect(section).not.toBeNull();
        expect(section?.querySelector('a.small')?.getAttribute('href')).toBe('/incoming');
        const rows = Array.from(section?.querySelectorAll('.rows > *') ?? []);
        expect(rows.length).toBeGreaterThanOrEqual(2);
        // Newest first: d3-offer-b (Aug 8) before d3-offer-a (Aug 3), among
        // whatever offers already exist on this shared agent/repo.
        const hrefs = rows.map((r) => r.getAttribute('href'));
        expect(hrefs.every((h) => h === '/incoming')).toBe(true);
      } finally {
        page.close();
      }
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });

  it('section 4 renders only dated shipped/notShipped rows inside 14 days, newest first, capped at five, See all to /myjobs (done-means 7, mutation proof 6)', async () => {
    const meRes = await fetch(`${baseUrl}/accounts/me`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${buyerSession.token}` },
    });
    const me = (await meRes.json()) as { did: string };
    const buyerDid = me.did;

    const now = new Date();
    const within = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const outside = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000);

    await jobRepo.create(jobFixture({ id: 'd4-shipped-recent', buyerDid, agentDid, status: 'completed', mergedAt: within }, within));
    // Outside the 14-day window: excluded.
    await jobRepo.create(jobFixture({ id: 'd4-shipped-old', buyerDid, agentDid, status: 'completed', mergedAt: outside }, outside));
    // notShipped with no date (declined has no dedicated timestamp):
    // excluded, never guessed into the window.
    await jobRepo.create(jobFixture({ id: 'd4-declined-nodate', buyerDid, agentDid, status: 'declined' }, within));

    const page = await renderDashboard(baseUrl, buyerSession);
    try {
      const section = sectionByHeading(page.document, 'Recently completed');
      expect(section).not.toBeNull();
      expect(section?.querySelector('a.small')?.getAttribute('href')).toBe('/myjobs');
      const rows = Array.from(section?.querySelectorAll('.rows > *') ?? []);
      const hrefs = rows.map((r) => r.getAttribute('href'));
      expect(hrefs).toContain('/jobs/d4-shipped-recent');
      expect(hrefs).not.toContain('/jobs/d4-shipped-old');
      expect(hrefs).not.toContain('/jobs/d4-declined-nodate');
    } finally {
      page.close();
    }
  });

  it('a section with no rows renders no heading and no See all link (done-means 8, mutation proof 1)', async () => {
    // A fresh buyer session with only one waitingOnYou job: sections 2, 3
    // and 4 must contribute nothing to the grid.
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'dashboard-lonely-buyer', id: 9803 }),
    });
    const app2 = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter);
    const server2 = app2.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server2.once('listening', resolve));
    const address2 = server2.address();
    if (address2 === null || typeof address2 === 'string') throw new Error('expected a port');
    const baseUrl2 = `http://127.0.0.1:${address2.port}`;
    try {
      const session = await mintSession(sessionAdapter);
      const meRes = await fetch(`${baseUrl2}/accounts/me`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}` },
      });
      const me = (await meRes.json()) as { did: string };
      await jobRepo.create(jobFixture({ id: 'd5-lonely-staged', buyerDid: me.did, agentDid, status: 'staged', stagedAt: new Date() }, new Date()));

      const page = await renderDashboard(baseUrl2, session);
      try {
        const headings = sectionHeadings(page.document);
        expect(headings).toEqual(['Waiting on you']);
        expect(page.document.querySelectorAll('#dgrid > section').length).toBe(1);
      } finally {
        page.close();
      }
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });

  it('a failed section read renders its own sentence and suppresses the page-level empty state, while other sections still render (done-means 12, mutation proof 2)', async () => {
    const realPort = (server.address() as AddressInfo).port;

    const proxy = http.createServer((req, res) => {
      if (req.url && req.url.endsWith('/incoming')) {
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
      const page = await renderDashboard(proxyBaseUrl, buyerSession);
      try {
        // Never the page-level empty state when a section read failed:
        // that would be a claim the failed read knows nothing about.
        expect(page.document.getElementById('page-empty-state')?.hidden).toBe(true);
        expect(page.document.getElementById('grid-wrap')?.hidden).toBe(false);
        const section = sectionByHeading(page.document, 'Your agents need attention');
        expect(section).not.toBeNull();
        const sentence = section?.querySelector('.rows p.sub')?.textContent ?? '';
        expect(sentence).not.toBe('');
        expect(section?.querySelectorAll('.rows > *').length).toBe(1);
      } finally {
        page.close();
      }
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it('a 401 on /accounts/me renders the sign-in block, not the load error (claim-contradicts-implementation)', async () => {
    const page = await renderDashboard(baseUrl, { token: 'a-token-nobody-minted' });
    try {
      // An unrecognised token: getAuthed still resolves ok() with the
      // route's own status attached (401). The brief's standing line is
      // explicit: a 401 renders the sign-in block, not an error.
      expect(page.document.getElementById('signin-required')?.hidden).toBe(false);
      expect(page.document.getElementById('load-error')?.hidden).toBe(true);
      expect(page.document.getElementById('dashboard-body')?.hidden).toBe(true);
    } finally {
      page.close();
    }
  });

  it('a non-401 failure on /accounts/me still renders the load error, not the sign-in block (guard-without-a-test permitting case)', async () => {
    const realPort = (server.address() as AddressInfo).port;
    const proxy = http.createServer((req, res) => {
      if (req.url && req.url.endsWith('/accounts/me')) {
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
      const page = await renderDashboard(proxyBaseUrl, buyerSession);
      try {
        expect(page.document.getElementById('load-error')?.hidden).toBe(false);
        expect(page.document.getElementById('signin-required')?.hidden).toBe(true);
        expect(page.document.getElementById('dashboard-body')?.hidden).toBe(true);
      } finally {
        page.close();
      }
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it('exactly one painted btn-primary is visible on the page at any time (done-means 10, mutation proof 4)', async () => {
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'dashboard-primary-buyer', id: 9804 }),
    });
    const app2 = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter);
    const server2 = app2.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server2.once('listening', resolve));
    const address2 = server2.address();
    if (address2 === null || typeof address2 === 'string') throw new Error('expected a port');
    const baseUrl2 = `http://127.0.0.1:${address2.port}`;
    try {
      const session = await mintSession(sessionAdapter);
      const meRes = await fetch(`${baseUrl2}/accounts/me`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}` },
      });
      const me = (await meRes.json()) as { did: string };
      const criteria: Criterion[] = [{ text: 'agent signed', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: true }];
      await jobRepo.create(jobFixture({ id: 'd6-primary-a', buyerDid: me.did, agentDid, status: 'proposed', criteria }, new Date('2026-08-01T00:00:00Z')));
      await jobRepo.create(jobFixture({ id: 'd6-primary-b', buyerDid: me.did, agentDid, status: 'proposed', criteria }, new Date('2026-08-02T00:00:00Z')));

      const page = await renderDashboard(baseUrl2, session);
      try {
        const primaries = Array.from(page.document.querySelectorAll('.btn-primary')).filter(
          (el) => el.closest('[hidden]') === null,
        );
        expect(primaries.length).toBe(1);
      } finally {
        page.close();
      }
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });

  it('the disclose panel renders exactly ruling 6\'s three definitions when the grid renders (done-means 11)', async () => {
    const meRes = await fetch(`${baseUrl}/accounts/me`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${buyerSession.token}` },
    });
    const me = (await meRes.json()) as { did: string };
    await jobRepo.create(jobFixture({ id: 'd7-disclose', buyerDid: me.did, agentDid, status: 'confirmed', confirmedAt: new Date() }, new Date()));

    const page = await renderDashboard(baseUrl, buyerSession);
    try {
      const dds = Array.from(page.document.querySelectorAll('#dashboard-grouping .kv dd')).map((dd) => dd.textContent);
      expect(dds).toEqual([
        'an agreement waiting on your signature, or work staged or delivered and waiting on your move',
        'a brief the agent has not answered yet, or a hire you have confirmed',
        'merged, or closed without shipping, in the last 14 days',
      ]);
    } finally {
      page.close();
    }
  });

  it('pending rows in section 2 carry no anchor and no button (mutation proof 3)', async () => {
    const meRes = await fetch(`${baseUrl}/accounts/me`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${buyerSession.token}` },
    });
    const me = (await meRes.json()) as { did: string };
    await jobRepo.create(jobFixture({ id: 'd8-noreply', buyerDid: me.did, agentDid, status: 'draft', criteria: [] }, new Date()));

    const page = await renderDashboard(baseUrl, buyerSession);
    try {
      const section = sectionByHeading(page.document, 'In progress');
      const row = Array.from(section?.querySelectorAll('.rows > *') ?? []).find((r) => r.textContent?.includes('Brief sent, no reply yet'));
      expect(row).toBeDefined();
      expect(row?.tagName.toLowerCase()).not.toBe('a');
      expect(row?.tagName.toLowerCase()).not.toBe('button');
      expect(row?.querySelectorAll('a, button').length).toBe(0);
    } finally {
      page.close();
    }
  });

  it('sorts section 1 by date newest-first across both sources, not by source (mutation proof 5)', async () => {
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'dashboard-sort-buyer', id: 9805 }),
    });
    const app2 = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter);
    const server2 = app2.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server2.once('listening', resolve));
    const address2 = server2.address();
    if (address2 === null || typeof address2 === 'string') throw new Error('expected a port');
    const baseUrl2 = `http://127.0.0.1:${address2.port}`;
    try {
      const session = await mintSession(sessionAdapter);
      const meRes = await fetch(`${baseUrl2}/accounts/me`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}` },
      });
      const me = (await meRes.json()) as { did: string };
      const criteria: Criterion[] = [{ text: 'agent signed', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: true }];
      // The pending row is OLDER than the staged job: if section 1 sorted
      // "pending first" rather than by date, the pending row would still
      // lead. This proves it leads only because it is newer.
      await jobRepo.create(jobFixture({ id: 'd9-pending-old', buyerDid: me.did, agentDid, status: 'proposed', criteria }, new Date('2026-08-01T00:00:00Z')));
      await jobRepo.create(jobFixture({ id: 'd9-staged-new', buyerDid: me.did, agentDid, status: 'staged', stagedAt: new Date('2026-08-10T00:00:00Z') }, new Date('2026-08-10T00:00:00Z')));

      const page = await renderDashboard(baseUrl2, session);
      try {
        const section = sectionByHeading(page.document, 'Waiting on you');
        const rows = Array.from(section?.querySelectorAll('.rows > *') ?? []);
        expect(rows.length).toBe(2);
        expect(rows[0]?.getAttribute('href') ?? rows[0]?.querySelector('a')?.getAttribute('href')).toBe('/jobs/d9-staged-new');
      } finally {
        page.close();
      }
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });

  it('a brief with markup renders as content, never markup (mutation proof 7)', async () => {
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'dashboard-markup-buyer', id: 9806 }),
    });
    const app2 = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter);
    const server2 = app2.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server2.once('listening', resolve));
    const address2 = server2.address();
    if (address2 === null || typeof address2 === 'string') throw new Error('expected a port');
    const baseUrl2 = `http://127.0.0.1:${address2.port}`;
    try {
      const session = await mintSession(sessionAdapter);
      const meRes = await fetch(`${baseUrl2}/accounts/me`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}` },
      });
      const me = (await meRes.json()) as { did: string };
      await jobRepo.create(jobFixture({ id: 'd10-markup', buyerDid: me.did, agentDid, brief: '<img src=x onerror=alert(1)>Ship it', status: 'confirmed', confirmedAt: new Date() }, new Date()));

      const page = await renderDashboard(baseUrl2, session);
      try {
        expect(page.document.querySelector('#dgrid img')).toBeNull();
        const row = Array.from(page.document.querySelectorAll('#dgrid .t')).find((t) => t.textContent?.includes('Ship it'));
        expect(row?.textContent).toContain('<img src=x onerror=alert(1)>Ship it');
      } finally {
        page.close();
      }
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });

  it('each section is capped at five rows (mutation proof 8)', async () => {
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'dashboard-cap-buyer', id: 9807 }),
    });
    const app2 = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter);
    const server2 = app2.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server2.once('listening', resolve));
    const address2 = server2.address();
    if (address2 === null || typeof address2 === 'string') throw new Error('expected a port');
    const baseUrl2 = `http://127.0.0.1:${address2.port}`;
    try {
      const session = await mintSession(sessionAdapter);
      const meRes = await fetch(`${baseUrl2}/accounts/me`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}` },
      });
      const me = (await meRes.json()) as { did: string };
      for (let i = 0; i < 8; i += 1) {
        await jobRepo.create(jobFixture({ id: `d11-cap-${i}`, buyerDid: me.did, agentDid, status: 'confirmed', confirmedAt: new Date(2026, 7, i + 1) }, new Date(2026, 7, i + 1)));
      }

      const page = await renderDashboard(baseUrl2, session);
      try {
        const section = sectionByHeading(page.document, 'In progress');
        const rows = Array.from(section?.querySelectorAll('.rows > *') ?? []);
        expect(rows.length).toBe(5);
      } finally {
        page.close();
      }
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });

  it('no anchor on the page points at an unmounted path (done-means 14)', async () => {
    const meRes = await fetch(`${baseUrl}/accounts/me`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${buyerSession.token}` },
    });
    const me = (await meRes.json()) as { did: string };
    const criteria: Criterion[] = [{ text: 'agent signed', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: true }];
    await jobRepo.create(jobFixture({ id: 'd12-anchor-pending', buyerDid: me.did, agentDid, status: 'proposed', criteria }, new Date('2026-08-20T00:00:00Z')));
    await jobRepo.create(jobFixture({ id: 'd12-anchor-job', buyerDid: me.did, agentDid, status: 'confirmed', confirmedAt: new Date('2026-08-21T00:00:00Z') }, new Date('2026-08-21T00:00:00Z')));

    const page = await renderDashboard(baseUrl, buyerSession);
    try {
      const hrefs = Array.from(page.document.querySelectorAll('a'))
        .map((a) => a.getAttribute('href'))
        .filter((h): h is string => h !== null && h.startsWith('/'))
        .map((h) => h.split('?')[0] as string);
      const uniquePaths = Array.from(new Set(hrefs));
      expect(uniquePaths.length).toBeGreaterThan(0);
      for (const path of uniquePaths) {
        if (path.startsWith('/jobs/') || path === '/agreement') continue; // dynamic paths, checked by their own routes' negotiation
        const res = await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } });
        expect(res.status, `${path} must be served by the real app`).toBe(200);
      }
    } finally {
      page.close();
    }
  });

  it('the document contains no elapsed time, age, badge count, or cross-section total (done-means 15)', async () => {
    const meRes = await fetch(`${baseUrl}/accounts/me`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${buyerSession.token}` },
    });
    const me = (await meRes.json()) as { did: string };
    await jobRepo.create(jobFixture({ id: 'd13-scope', buyerDid: me.did, agentDid, status: 'confirmed', confirmedAt: new Date() }, new Date()));

    const page = await renderDashboard(baseUrl, buyerSession);
    try {
      const text = page.document.body.textContent ?? '';
      expect(text).not.toMatch(/\d+\s*(days?|hours?|minutes?)\s*ago/i);
      expect(text).not.toMatch(/overdue/i);
    } finally {
      page.close();
    }
  });

  describe('layout: .dgrid is two columns above 760px and one below; 320px shows no horizontal overflow (done-means 16)', () => {
    it('.dgrid declares the two-column/one-column media query in the page\'s own style block', async () => {
      const res = await fetch(`${baseUrl}/dashboard`, { headers: { Accept: HTML } });
      const markup = await res.text();
      expect(markup).toMatch(/\.dgrid\s*\{[^}]*grid-template-columns:\s*1fr 1fr/);
      expect(markup).toMatch(/@media \(max-width: 760px\)[\s\S]*\.dgrid\s*\{\s*grid-template-columns:\s*1fr/);
    });

    it('at 320px there is no horizontal overflow, real Chrome', async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
        return;
      }
      const meRes = await fetch(`${baseUrl}/accounts/me`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${buyerSession.token}` },
      });
      const me = (await meRes.json()) as { did: string };
      await jobRepo.create(jobFixture({ id: 'd14-layout', buyerDid: me.did, agentDid, status: 'confirmed', confirmedAt: new Date() }, new Date()));

      const browser = await RealBrowser.launch({ width: 320, height: 900 });
      try {
        await browser.goto(`${baseUrl}/dashboard`);
        await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(buyerSession))})`);
        await browser.goto(`${baseUrl}/dashboard`);

        const overflow = await browser.evaluate<{ scrollWidth: number; clientWidth: number }>(`
          ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })
        `);
        expect(overflow.scrollWidth, 'the 320px page must not scroll sideways').toBe(overflow.clientWidth);
      } finally {
        await browser.close();
      }
    });

    it('every interactive element is at least 44px at 320px, real Chrome (tap-target-under-44px)', async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
        return;
      }
      const meRes = await fetch(`${baseUrl}/accounts/me`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${buyerSession.token}` },
      });
      const me = (await meRes.json()) as { did: string };
      await jobRepo.create(jobFixture({ id: 'd15-tap-target', buyerDid: me.did, agentDid, status: 'confirmed', confirmedAt: new Date() }, new Date()));

      const browser = await RealBrowser.launch({ width: 320, height: 900 });
      try {
        await browser.goto(`${baseUrl}/dashboard`);
        await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(buyerSession))})`);
        await browser.goto(`${baseUrl}/dashboard`);

        const undersized = await browser.evaluate<Array<[string, number, number]>>(`
          Array.from(document.querySelectorAll('#dgrid a, #dgrid button'))
            .map((el) => {
              const r = el.getBoundingClientRect();
              return [el.textContent || '', r.width, r.height];
            })
            .filter(([, w, h]) => w < 44 || h < 44)
        `);
        expect(undersized, `undersized targets: ${JSON.stringify(undersized)}`).toEqual([]);
      } finally {
        await browser.close();
      }
    });
  });
});

describe('the Dashboard nav link (P8u ruling 7): one implementation in nav.js, absent signed out, present signed in', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function renderNav(path: string, session: { token: string } | null): Promise<Rendered> {
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
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);
    return { window: dom.window, document: dom.window.document, close: () => dom.window.close() };
  }

  it('is absent from the nav when signed out (done-means 13, mutation proof 9)', async () => {
    const page = await renderNav('/browse', null);
    try {
      const links = Array.from(page.document.querySelectorAll('.links a')).map((a) => a.textContent);
      expect(links).not.toContain('Dashboard');
    } finally {
      page.close();
    }
  });

  it('appears in the nav links, pointing at /dashboard, once signed in (done-means 13, mutation proof 9)', async () => {
    const page = await renderNav('/browse', { token: 'a-live-looking-token' });
    try {
      const link = Array.from(page.document.querySelectorAll('.links a')).find((a) => a.textContent === 'Dashboard') as HTMLAnchorElement | undefined;
      expect(link).not.toBeUndefined();
      expect(link?.getAttribute('href')).toBe('/dashboard');
    } finally {
      page.close();
    }
  });

  it('/dashboard itself carries api.js and nav.js like every other page', async () => {
    const res = await fetch(`${baseUrl}/dashboard`, { headers: { Accept: HTML } });
    const body = await res.text();
    expect(body).toContain('src="/js/pages/api.js"');
    expect(body).toContain('src="/js/pages/nav.js"');
  });

  it('disappears again once signed out (no leftover element from an earlier signed-in render)', async () => {
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'octo-nav-dashboard', id: 5301 }),
    });
    const configuredServer = createApp(
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, sessionAdapter,
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => configuredServer.once('listening', resolve));
    const configuredBaseUrl = `http://127.0.0.1:${(configuredServer.address() as AddressInfo).port}`;
    const start = await sessionAdapter.beginGitHubOAuth();
    const session = await sessionAdapter.completeGitHubOAuth({ code: 'good-code', state: start.state });

    const virtualConsole = new VirtualConsole();
    const failures: string[] = [];
    virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));
    const response = await fetch(`${configuredBaseUrl}/browse`, { headers: { Accept: HTML } });
    const markup = await response.text();
    const dom = new JSDOM(markup, {
      url: `${configuredBaseUrl}/browse`,
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse(window) {
        window.sessionStorage.setItem('fa_session', JSON.stringify(session));
        Object.defineProperty(window, 'fetch', {
          writable: true,
          value: (input: string, init?: RequestInit) => fetch(new URL(input, configuredBaseUrl), init),
        });
      },
    });
    try {
      await new Promise<void>((resolve) => {
        if (dom.window.document.readyState === 'complete') resolve();
        else dom.window.addEventListener('load', () => resolve());
      });
      await new Promise((resolve) => setTimeout(resolve, 150));

      const signoutBtn = dom.window.document.getElementById('nav-signout') as HTMLButtonElement | null;
      expect(signoutBtn).not.toBeNull();
      signoutBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);

      const links = Array.from(dom.window.document.querySelectorAll('.links a')).map((a) => a.textContent);
      expect(links).not.toContain('Dashboard');
    } finally {
      dom.window.close();
      await new Promise<void>((resolve) => configuredServer.close(() => resolve()));
    }
  });
});
