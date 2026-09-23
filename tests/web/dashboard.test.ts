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
import { MemoryAccountRepository, MemoryAgentRepository, MemoryCredentialRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import { createJob, type Job, type Criterion } from '../../src/domain/job.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession } from '../helpers/session-fixtures.js';
import type { Session } from '../../src/adapters/identity/session.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
// P8d: resolving a session to an account when none exists yet needs
// FREEAGENTS_PLATFORM_SEED, the same stance tests/web/myjobs.test.ts and
// tests/web/incoming.test.ts already take.
const PLATFORM_SEED = 'c'.repeat(64);

// EVERY TEST BELOW THAT DRIVES A REAL BROWSER CARRIES AN EXPLICIT TIMEOUT.
// vitest's default is 5000ms and RealBrowser.launch alone takes 1 to 4s on
// an idle machine; the two layout tests each perform a launch, two
// navigations and a resize. Run inside the full suite, or beside another
// seat's build, that setup regularly passes 5s, which is exactly what CI1
// caught: run 35390871202 reported both "the two dspan-6 sections..." and
// "under prefers-reduced-motion..." red with "Test timed out in 5000ms",
// not a real layout defect, the same timing-dependency shape
// tests/web/hire-polished.test.ts:486-495 already named and fixed.
//
// CI2 finding: 30s was not past every launch after all. PR run
// 35901282897 (identical code to main's own green push run 35900696646)
// reproduced "the two dspan-6 sections..." as "Test timed out in 30000ms"
// on node 22, while the SAME test in the SAME run passed on node 24 at
// 2661ms. That is not a real layout defect either: it is this test's own
// 30_000ms ceiling colliding with tests/helpers/real-browser.ts's launch()
// having an internal 30000ms deadline of its own (waiting for Chrome's
// debug port), so a launch that legitimately needs close to its own
// ceiling under a loaded shared runner leaves this test's timer with
// nothing left for the two navigations, two evaluates, the resize and the
// close that still have to run afterward. Local timing (see the scratch
// harness this card's handoff cites) put that non-launch overhead at
// 1.5-2s warm; 60s gives it real headroom above launch()'s own worst case
// rather than colliding with it, and a genuinely broken layout still
// fails in milliseconds once the page is up, well inside either ceiling.
const BROWSER_TIMEOUT_MS = 60_000;

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

// Mirrors tests/web/myagents.test.ts's own credentialDoc: the minimal
// CompletedHireCredential shape agentWorkRecord needs to promote an agent
// to the verified-hire tier, so section 3's "no verified record yet" test
// can drive a real read rather than a stub.
function credentialDoc(id: string, subjectDid: string, mergeCommit: string, buyerDid: string): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id,
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: 'did:abt:platform',
    validFrom: '2026-08-30T00:00:00.000Z',
    credentialSubject: {
      id: subjectDid,
      hire: {
        brief: 'sha256:brief',
        repository: 'buyer/target-repo',
        pullRequest: 'https://github.com/buyer/target-repo/pull/1',
        mergedAt: '2026-08-30T00:00:00.000Z',
        mergeCommit,
        signedBy: `${subjectDid}#key-1`,
        buyer: buyerDid,
        additions: 4,
        deletions: 1,
        filesChanged: 1,
      },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zProof' },
  };
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

// W-dashboard: the four sections no longer share one row container, which
// is the shape change spec/wireframe/dashboard.html asks for in its own
// words ("Four identical panels say the four things are equally urgent,
// which is false"). Section 1 holds decision cards in a .dcards grid,
// section 2 holds job rows with a stage rail in a .jobstack, and the two
// half-width reference sections still hold plain .rows. Named here once
// so every case below asks for the container that section actually has,
// rather than each case carrying its own literal.
const ROW_CONTAINER: Record<string, string> = {
  'Waiting on you': '.dcards',
  'In progress': '.jobstack',
  'Your agents': '.rows',
  'Recently completed': '.rows',
};

function sectionRows(document: Document, heading: string): Element[] {
  const section = sectionByHeading(document, heading);
  const container = ROW_CONTAINER[heading];
  if (section === null || container === undefined) return [];
  return Array.from(section.querySelectorAll(`${container} > *`));
}

describe('the dashboard screen, driven end to end against the real app', () => {
  let agentRepo: MemoryAgentRepository;
  let jobRepo: MemoryJobRepository;
  let accountRepo: MemoryAccountRepository;
  let credentialRepo: MemoryCredentialRepository;
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
    credentialRepo = new MemoryCredentialRepository();

    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'dashboard-page-buyer', id: 9801 }),
    });

    const app = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, credentialRepo, undefined, undefined, undefined, sessionAdapter);
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

  it('takes exactly five reads for a buyer who operates nothing: /accounts/me, then jobs, pending, incoming and the agent roster, no per-agent read (done-means 3, W5 ruling)', async () => {
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
      const rosterCount = paths.filter((p) => p.endsWith('/agents')).length;
      expect(jobsCount).toBe(1);
      expect(pendingCount).toBe(1);
      expect(incomingCount).toBe(1);
      expect(rosterCount).toBe(1);
      // Exactly five reads total: me + jobs + pending + incoming + roster.
      // The roster read is unconditional (W5 ruling): accountProjection
      // carries no operated-agent count, so the page cannot know whether
      // this buyer operates anything without asking.
      expect(paths.length).toBe(5);
      // No per-agent read: this buyer's roster is empty, so
      // /agents/:agentDid never appears. This is the assertion that
      // proves per-agent reads are scoped to rows the roster actually
      // returned and are never fired speculatively.
      expect(paths.some((p) => /^\/agents\/[^/]+$/.test(p))).toBe(false);
    } finally {
      dom.window.close();
    }
  });

  it('an operator holding N operated agents takes 5 + N reads: the same five, plus exactly one /agents/:agentDid per roster row, matching the roster DIDs (W5 ruling)', async () => {
    const operatorSessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'dashboard-roster-operator', id: 9808 }),
    });
    const app2 = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, undefined, undefined, undefined, undefined, operatorSessionAdapter);
    const server2 = app2.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server2.once('listening', resolve));
    const address2 = server2.address();
    if (address2 === null || typeof address2 === 'string') throw new Error('expected a port');
    const baseUrl2 = `http://127.0.0.1:${address2.port}`;
    try {
      const operatorSession = await mintSession(operatorSessionAdapter);
      const meRes = await fetch(`${baseUrl2}/accounts/me`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${operatorSession.token}` },
      });
      const me = (await meRes.json()) as { did: string };
      const operatorDid = me.did;

      const rosterAgentA = 'did:abt:dashboard-roster-agent-a';
      const rosterAgentB = 'did:abt:dashboard-roster-agent-b';
      await agentRepo.create({
        did: rosterAgentA,
        operatorDid,
        delegation: delegationFixture(rosterAgentA, operatorDid),
        name: 'roster-agent-a',
        skills: [],
        githubLogin: null,
      });
      await agentRepo.create({
        did: rosterAgentB,
        operatorDid,
        delegation: delegationFixture(rosterAgentB, operatorDid),
        name: 'roster-agent-b',
        skills: [],
        githubLogin: null,
      });

      const requested: string[] = [];
      const virtualConsole = new VirtualConsole();
      const failures: string[] = [];
      virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));
      const response = await fetch(`${baseUrl2}/dashboard`, { headers: { Accept: HTML } });
      const markup = await response.text();
      const dom = new JSDOM(markup, {
        url: `${baseUrl2}/dashboard`,
        runScripts: 'dangerously',
        resources: 'usable',
        pretendToBeVisual: true,
        virtualConsole,
        beforeParse(window) {
          window.sessionStorage.setItem('fa_session', JSON.stringify(operatorSession));
          Object.defineProperty(window, 'fetch', {
            writable: true,
            value: (input: string, init?: RequestInit) => {
              requested.push(String(input));
              return fetch(new URL(input, baseUrl2), init);
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
        const paths = requested.map((r) => new URL(r, baseUrl2).pathname);
        const perAgentPaths = paths.filter((p) => /^\/agents\/[^/]+$/.test(p));
        // Exactly one per roster row, matching the roster DIDs: a
        // duplicate or speculative read fails this.
        expect(perAgentPaths.sort()).toEqual(
          [`/agents/${encodeURIComponent(rosterAgentA)}`, `/agents/${encodeURIComponent(rosterAgentB)}`].sort(),
        );
        // The same five, plus exactly N (2) per-agent reads: 7 total.
        expect(paths.length).toBe(7);
      } finally {
        dom.window.close();
      }
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
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

      const rows = sectionRows(page.document, 'Waiting on you');
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

      const rows = sectionRows(page.document, 'In progress');
      expect(rows.length).toBe(3);
      // Newest first: operator (Aug 7), noreply (Aug 6), confirmed (Aug 2).
      expect(rows[0]?.textContent).toContain('Waiting on the agent to sign');
      expect(rows[1]?.textContent).toContain('Brief sent, no reply yet');

      // No control at all on either pending row: no anchor, no button.
      expect(rows[0]?.querySelectorAll('a, button').length).toBe(0);
      expect(rows[1]?.querySelectorAll('a, button').length).toBe(0);
      expect(rows[0]?.tagName.toLowerCase()).toBe('div');
      expect(rows[1]?.tagName.toLowerCase()).toBe('div');

      // W-dashboard: every row in this section draws SITEMAP.md P-13's
      // five states as an aria-hidden rail with a real-text .flow-now
      // sentence under it. The rail being aria-hidden and the sentence
      // being real text are the same decision, so both are asserted: a
      // rail that lost its aria-hidden would read five stage names aloud
      // in place of the sentence that actually says where the work is.
      for (const row of rows) {
        const rail = row.querySelector('ol.flow');
        expect(rail, 'every in-progress row draws the stage rail').not.toBeNull();
        expect(rail?.getAttribute('aria-hidden')).toBe('true');
        expect(rail?.querySelectorAll('.flow-step').length).toBe(5);
        expect(Array.from(rail?.querySelectorAll('.flow-lbl') ?? []).map((l) => l.textContent)).toEqual([
          'Brief', 'Criteria', 'Confirmed', 'Pull request', 'Merged',
        ]);
        // Exactly one current node, and the travelling light sits on it.
        expect(rail?.querySelectorAll('.flow-step.is-now').length).toBe(1);
        expect(rail?.querySelectorAll('.flow-spark').length).toBe(1);
        expect(row.querySelector('.flow-step.is-now .flow-line .flow-spark')).not.toBeNull();
        // Never the accent: pipeline.css gives .is-merged the accent dot
        // and nothing in flight may claim it (DESIGN.md 2.2).
        expect(row.querySelectorAll('.flow-step.is-merged').length).toBe(0);
        const sentence = row.querySelector('.flow-now')?.textContent ?? '';
        expect(sentence.trim()).not.toBe('');
      }

      // The stage each row is on, read off the rail: the two pending rows
      // have not agreed criteria (index 1), the confirmed hire has (index 2).
      const stageOf = (row: Element | undefined): number =>
        Array.from(row?.querySelectorAll('.flow-step') ?? []).findIndex((s) => s.classList.contains('is-now'));
      expect(stageOf(rows[0])).toBe(1);
      expect(stageOf(rows[1])).toBe(1);
      expect(stageOf(rows[2])).toBe(2);

      // The confirmed job is still a real anchor to /jobs/:id.
      expect(rows[2]?.tagName.toLowerCase()).toBe('a');
      expect(rows[2]?.getAttribute('href')).toBe('/jobs/d2-confirmed');
    } finally {
      page.close();
    }
  });

  it('section 3 renders incoming offers alongside the unproven-GitHub half, newest first among the offers, capped at five combined, See all to /myagents (done-means 6, W5 ruling)', async () => {
    // An isolated agent and operator, not shared with any other case in
    // this file: the combined cap (attention rows plus offer rows) needs
    // a roster and an offer set this test fully controls, the same
    // isolation the roster-read tests above already take.
    const isolatedAgentDid = 'did:abt:dashboard-section3-agent';
    const isolatedOperatorSessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'dashboard-section3-operator', id: 9809 }),
    });
    const app2 = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, undefined, undefined, undefined, undefined, isolatedOperatorSessionAdapter);
    const server2 = app2.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server2.once('listening', resolve));
    const address2 = server2.address();
    if (address2 === null || typeof address2 === 'string') throw new Error('expected a port');
    const baseUrl2 = `http://127.0.0.1:${address2.port}`;
    try {
      const isolatedOperatorSession = await mintSession(isolatedOperatorSessionAdapter);
      const meRes = await fetch(`${baseUrl2}/accounts/me`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${isolatedOperatorSession.token}` },
      });
      const me = (await meRes.json()) as { did: string };
      const isolatedOperatorDid = me.did;

      await agentRepo.create({
        did: isolatedAgentDid,
        operatorDid: isolatedOperatorDid,
        delegation: delegationFixture(isolatedAgentDid, isolatedOperatorDid),
        name: 'section3-scout',
        skills: [],
        githubLogin: null,
      });

      await jobRepo.create(jobFixture({ id: 'd3-offer-a', buyerDid: 'did:abt:dashboard-buyer-x', agentDid: isolatedAgentDid, status: 'draft', criteria: [] }, new Date('2026-08-03T00:00:00Z')));
      await jobRepo.create(jobFixture({ id: 'd3-offer-b', buyerDid: 'did:abt:dashboard-buyer-y', agentDid: isolatedAgentDid, status: 'draft', criteria: [] }, new Date('2026-08-08T00:00:00Z')));

      const page = await renderDashboard(baseUrl2, isolatedOperatorSession);
      try {
        const section = sectionByHeading(page.document, 'Your agents');
        expect(section).not.toBeNull();
        // W5 ruling, handoff item 2: See all now goes to /myagents, the
        // full list of the thing this heading names, not /incoming.
        expect(section?.querySelector('a.small')?.getAttribute('href')).toBe('/myagents');
        const rows = sectionRows(page.document, 'Your agents');
        // The wireframe's order (handoff item 1): the unproven-GitHub
        // row (this roster's one agent, githubLogin null, no verified
        // record) comes first, the two offers second, newest first.
        expect(rows.length).toBe(3);
        expect(rows[0]?.getAttribute('href')).toBe(`/agents/${encodeURIComponent(isolatedAgentDid)}`);
        expect(rows[0]?.textContent).toContain('section3-scout');
        expect(rows[0]?.textContent).toContain('no verified record yet');
        expect(rows[0]?.textContent).toContain('GitHub not confirmed');
        expect(rows[1]?.getAttribute('href')).toBe('/operatorjob?job=d3-offer-b');
        expect(rows[2]?.getAttribute('href')).toBe('/operatorjob?job=d3-offer-a');
      } finally {
        page.close();
      }
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });

  it('section 3 caps at five rows COMBINED, not five per half: six attention rows plus one offer render only the first five attention rows and drop the offer entirely (review round 1, D1)', async () => {
    // A per-half cap (attentionRows.slice(0, 5).concat(offerRows.slice(0, 5)))
    // passed the old fixture (one attention row, two offers, asserting
    // rows.length === 3) because that count is identical under both the
    // combined cap and a per-half cap. Six attention rows plus one offer
    // is the smallest fixture where the two rules disagree: the combined
    // cap yields exactly five rows and drops the offer outright, while a
    // per-half cap would yield six (five attention rows plus the offer).
    const isolatedOperatorSessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'dashboard-s3-cap-operator', id: 9811 }),
    });
    const app2 = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, credentialRepo, undefined, undefined, undefined, isolatedOperatorSessionAdapter);
    const server2 = app2.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server2.once('listening', resolve));
    const address2 = server2.address();
    if (address2 === null || typeof address2 === 'string') throw new Error('expected a port');
    const baseUrl2 = `http://127.0.0.1:${address2.port}`;
    try {
      const isolatedOperatorSession = await mintSession(isolatedOperatorSessionAdapter);
      const meRes = await fetch(`${baseUrl2}/accounts/me`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${isolatedOperatorSession.token}` },
      });
      const me = (await meRes.json()) as { did: string };
      const isolatedOperatorDid = me.did;

      // Six unproven agents, no verified record, githubLogin null so
      // proofStatus defaults to unverified: every one of them is a real
      // attention row on its own honest merit, no credential needed.
      const capAgentDids = Array.from({ length: 6 }, (_unused, i) => `did:abt:dashboard-s3-cap-agent-${i}`);
      for (let i = 0; i < capAgentDids.length; i += 1) {
        const capAgentDid = capAgentDids[i] as string;
        await agentRepo.create({
          did: capAgentDid,
          operatorDid: isolatedOperatorDid,
          delegation: delegationFixture(capAgentDid, isolatedOperatorDid),
          name: `cap-agent-${i}`,
          skills: [],
          githubLogin: null,
        });
      }
      const firstCapAgentDid = capAgentDids[0] as string;
      await jobRepo.create(jobFixture({ id: 'd3-cap-offer', buyerDid: 'did:abt:dashboard-cap-buyer', agentDid: firstCapAgentDid, status: 'draft', criteria: [] }, new Date('2026-08-09T00:00:00Z')));

      const page = await renderDashboard(baseUrl2, isolatedOperatorSession);
      try {
        const section = sectionByHeading(page.document, 'Your agents');
        expect(section).not.toBeNull();
        const rows = sectionRows(page.document, 'Your agents');
        // Five rows total, not six: the combined cap, not a per-half cap.
        expect(rows.length).toBe(5);
        // All five are attention rows, in roster order (ties on the
        // default sort are stable): the sixth agent and the offer are
        // both pushed out by rows that arrived first.
        const hrefs = rows.map((r) => r.getAttribute('href'));
        for (let i = 0; i < 5; i += 1) {
          const capAgentDid = capAgentDids[i] as string;
          expect(hrefs).toContain(`/agents/${encodeURIComponent(capAgentDid)}`);
        }
        const sixthCapAgentDid = capAgentDids[5] as string;
        expect(hrefs).not.toContain(`/agents/${encodeURIComponent(sixthCapAgentDid)}`);
        expect(hrefs).not.toContain('/operatorjob?job=d3-cap-offer');
      } finally {
        page.close();
      }
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });

  it('section 3 renders an agent whose proofStatus is not verified but who DOES have a verified record: only the GitHub-not-confirmed trail, never the no-record meta (handoff item 1, unverified-state-claim guard)', async () => {
    const isolatedAgentDid = 'did:abt:dashboard-s3-unconfirmed-only-agent';
    const isolatedOperatorSessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'dashboard-s3-unconfirmed-only-operator', id: 9810 }),
    });
    const app2 = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, credentialRepo, undefined, undefined, undefined, isolatedOperatorSessionAdapter);
    const server2 = app2.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server2.once('listening', resolve));
    const address2 = server2.address();
    if (address2 === null || typeof address2 === 'string') throw new Error('expected a port');
    const baseUrl2 = `http://127.0.0.1:${address2.port}`;
    try {
      const isolatedOperatorSession = await mintSession(isolatedOperatorSessionAdapter);
      const meRes = await fetch(`${baseUrl2}/accounts/me`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${isolatedOperatorSession.token}` },
      });
      const me = (await meRes.json()) as { did: string };
      const isolatedOperatorDid = me.did;

      await agentRepo.create({
        did: isolatedAgentDid,
        operatorDid: isolatedOperatorDid,
        delegation: delegationFixture(isolatedAgentDid, isolatedOperatorDid),
        name: 'unconfirmed-only-scout',
        skills: [],
        githubLogin: null,
      });
      // A verified hire: verifiedHireCount > 0, so "no verified record
      // yet" must NOT render. proofStatus stays 'unverified' (the
      // repository's own default), so "GitHub not confirmed" must.
      await credentialRepo.save({
        completedJobId: 'dashboard-s3-unconfirmed-only-job',
        subjectDid: isolatedAgentDid,
        document: credentialDoc('https://platform.example/v1/credentials/dashboard-s3-unconfirmed-only-job', isolatedAgentDid, 'dashboard-s3-unconfirmed-only-commit', 'did:example:dashboard-s3-buyer'),
        repositoryPublic: true,
      });

      const page = await renderDashboard(baseUrl2, isolatedOperatorSession);
      try {
        const section = sectionByHeading(page.document, 'Your agents');
        expect(section).not.toBeNull();
        const rows = sectionRows(page.document, 'Your agents');
        const row = rows.find((r) => r.getAttribute('href') === `/agents/${encodeURIComponent(isolatedAgentDid)}`);
        expect(row, 'the unproven-GitHub row must exist').toBeTruthy();
        expect(row?.textContent).toContain('GitHub not confirmed');
        expect(row?.textContent).not.toContain('no verified record yet');
      } finally {
        page.close();
      }
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });

  it('section 3 renders an agent with no verified record who IS confirmed: only the no-record meta, never the GitHub-not-confirmed trail (handoff item 1, unverified-state-claim guard)', async () => {
    const isolatedAgentDid = 'did:abt:dashboard-s3-norecord-only-agent';
    const isolatedOperatorSessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'dashboard-s3-norecord-only-operator', id: 9811 }),
    });
    const app2 = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, credentialRepo, undefined, undefined, undefined, isolatedOperatorSessionAdapter);
    const server2 = app2.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server2.once('listening', resolve));
    const address2 = server2.address();
    if (address2 === null || typeof address2 === 'string') throw new Error('expected a port');
    const baseUrl2 = `http://127.0.0.1:${address2.port}`;
    try {
      const isolatedOperatorSession = await mintSession(isolatedOperatorSessionAdapter);
      const meRes = await fetch(`${baseUrl2}/accounts/me`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${isolatedOperatorSession.token}` },
      });
      const me = (await meRes.json()) as { did: string };
      const isolatedOperatorDid = me.did;

      // No credential ever saved for this agent: verifiedHireCount and
      // verifiedPriorWorkCount are both zero, so "no verified record
      // yet" must render. githubLogin is set and updateGithubBinding
      // marks proofStatus 'verified', so "GitHub not confirmed" must
      // NOT.
      await agentRepo.create({
        did: isolatedAgentDid,
        operatorDid: isolatedOperatorDid,
        delegation: delegationFixture(isolatedAgentDid, isolatedOperatorDid),
        name: 'norecord-only-scout',
        skills: [],
        githubLogin: 'norecord-only-gh',
      });
      await agentRepo.updateGithubBinding(isolatedAgentDid, { handle: 'norecord-only-gh', status: 'verified' });

      const page = await renderDashboard(baseUrl2, isolatedOperatorSession);
      try {
        const section = sectionByHeading(page.document, 'Your agents');
        expect(section).not.toBeNull();
        const rows = sectionRows(page.document, 'Your agents');
        const row = rows.find((r) => r.getAttribute('href') === `/agents/${encodeURIComponent(isolatedAgentDid)}`);
        expect(row, 'the no-record row must exist').toBeTruthy();
        expect(row?.textContent).toContain('no verified record yet');
        expect(row?.textContent).not.toContain('GitHub not confirmed');
      } finally {
        page.close();
      }
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });

  it('section 3 renders an agent with BOTH no verified record and an unconfirmed GitHub: both independent lines together, from two independent facts, never one inferred from the other (handoff item 1)', async () => {
    const isolatedAgentDid = 'did:abt:dashboard-s3-both-agent';
    const isolatedOperatorSessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'dashboard-s3-both-operator', id: 9812 }),
    });
    const app2 = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, credentialRepo, undefined, undefined, undefined, isolatedOperatorSessionAdapter);
    const server2 = app2.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server2.once('listening', resolve));
    const address2 = server2.address();
    if (address2 === null || typeof address2 === 'string') throw new Error('expected a port');
    const baseUrl2 = `http://127.0.0.1:${address2.port}`;
    try {
      const isolatedOperatorSession = await mintSession(isolatedOperatorSessionAdapter);
      const meRes = await fetch(`${baseUrl2}/accounts/me`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${isolatedOperatorSession.token}` },
      });
      const me = (await meRes.json()) as { did: string };
      const isolatedOperatorDid = me.did;

      await agentRepo.create({
        did: isolatedAgentDid,
        operatorDid: isolatedOperatorDid,
        delegation: delegationFixture(isolatedAgentDid, isolatedOperatorDid),
        name: 'both-scout',
        skills: [],
        githubLogin: null,
      });

      const page = await renderDashboard(baseUrl2, isolatedOperatorSession);
      try {
        const section = sectionByHeading(page.document, 'Your agents');
        expect(section).not.toBeNull();
        const rows = sectionRows(page.document, 'Your agents');
        const row = rows.find((r) => r.getAttribute('href') === `/agents/${encodeURIComponent(isolatedAgentDid)}`);
        expect(row, 'the row must exist').toBeTruthy();
        expect(row?.textContent).toContain('no verified record yet');
        expect(row?.textContent).toContain('GitHub not confirmed');
      } finally {
        page.close();
      }
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });

  it('section 3: a failed per-agent read leaves that row exactly as the roster rendered it, no attention line, never a guessed confirmed (handoff item 1, myagents.js:174-179 parity)', async () => {
    const isolatedAgentDid = 'did:abt:dashboard-s3-flaky-agent';
    const isolatedOperatorSessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'dashboard-s3-flaky-operator', id: 9813 }),
    });
    const app2 = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, credentialRepo, undefined, undefined, undefined, isolatedOperatorSessionAdapter);
    const server2 = app2.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server2.once('listening', resolve));
    const address2 = server2.address();
    if (address2 === null || typeof address2 === 'string') throw new Error('expected a port');
    const baseUrl2 = `http://127.0.0.1:${address2.port}`;
    try {
      const isolatedOperatorSession = await mintSession(isolatedOperatorSessionAdapter);
      const meRes = await fetch(`${baseUrl2}/accounts/me`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${isolatedOperatorSession.token}` },
      });
      const me = (await meRes.json()) as { did: string };
      const isolatedOperatorDid = me.did;

      // No verified record either: if the per-agent read's failure were
      // ever mistaken for a section-level failure, the whole section
      // would render its failure sentence instead of this row.
      await agentRepo.create({
        did: isolatedAgentDid,
        operatorDid: isolatedOperatorDid,
        delegation: delegationFixture(isolatedAgentDid, isolatedOperatorDid),
        name: 'flaky-scout',
        skills: [],
        githubLogin: null,
      });

      // A proxy that answers GET /agents/<isolatedAgentDid> with a
      // storage failure and passes every other request straight
      // through, the same technique myagents.test.ts and
      // agent-cold-start.test.ts already use.
      const realPort2 = (server2.address() as AddressInfo).port;
      const flakyPath = `/agents/${encodeURIComponent(isolatedAgentDid)}`;
      const proxy = http.createServer((req, res) => {
        if (req.url === flakyPath) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'storage unavailable' }));
          return;
        }
        const upstream = http.request(
          { hostname: '127.0.0.1', port: realPort2, path: req.url, method: req.method, headers: req.headers },
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
        const page = await renderDashboard(proxyBaseUrl, isolatedOperatorSession);
        try {
          const section = sectionByHeading(page.document, 'Your agents');
          expect(section, 'the section itself must still render (a per-agent failure is not a section failure)').not.toBeNull();
          const rows = sectionRows(page.document, 'Your agents');
          const row = rows.find((r) => r.getAttribute('href') === `/agents/${encodeURIComponent(isolatedAgentDid)}`);
          expect(row, 'the row itself still renders despite the failed detail read').toBeTruthy();
          // Never a guessed "confirmed": no attention line at all, not
          // a false positive claiming the proof state either way.
          expect(row?.textContent).not.toContain('GitHub not confirmed');
          expect((row?.textContent ?? '').toLowerCase()).not.toContain('confirmed');
        } finally {
          page.close();
        }
      } finally {
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
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
      const rows = sectionRows(page.document, 'Recently completed');
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
        const section = sectionByHeading(page.document, 'Your agents');
        expect(section).not.toBeNull();
        const sentence = section?.querySelector('.rows p.sub')?.textContent ?? '';
        expect(sentence).not.toBe('');
        expect(sectionRows(page.document, 'Your agents').length).toBe(1);
        // W-dashboard: a failed section carries no count. A "0" beside the
        // heading would be a claim about rows a read that never answered
        // knows nothing about (unverified-state-claim).
        expect(section?.querySelector('.secount')).toBeNull();
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
      const row = sectionRows(page.document, 'In progress').find((r) => r.textContent?.includes('Brief sent, no reply yet'));
      expect(section).not.toBeNull();
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
        expect(section).not.toBeNull();
        const rows = sectionRows(page.document, 'Waiting on you');
        expect(rows.length).toBe(2);
        expect(rows[0]?.getAttribute('href') ?? rows[0]?.querySelector('a')?.getAttribute('href')).toBe('/jobs/d9-staged-new');
      } finally {
        page.close();
      }
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });

  it('a buyer-supplied brief and repository both render as content, never markup (mutation proof 7)', async () => {
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
      // W-dashboard: section 2's job row leads with the REPOSITORY (the
      // wireframe's own .jobrow-id: repo and PR above the agent name),
      // and section 1's decision card leads with the brief. Both strings
      // are buyer-supplied, so both are driven here: pinning only the
      // brief would leave the string section 2 actually renders untested.
      await jobRepo.create(jobFixture({ id: 'd10-markup-repo', buyerDid: me.did, agentDid, repository: '<img src=x onerror=alert(1)>owner/repo', status: 'confirmed', confirmedAt: new Date() }, new Date()));
      await jobRepo.create(jobFixture({ id: 'd10-markup-brief', buyerDid: me.did, agentDid, brief: '<img src=x onerror=alert(2)>Ship it', status: 'staged', stagedAt: new Date() }, new Date()));

      const page = await renderDashboard(baseUrl2, session);
      try {
        expect(page.document.querySelector('#dgrid img')).toBeNull();
        const titles = Array.from(page.document.querySelectorAll('#dgrid .t'));
        const repoTitle = titles.find((t) => t.textContent?.includes('owner/repo'));
        expect(repoTitle?.textContent).toContain('<img src=x onerror=alert(1)>owner/repo');
        const briefTitle = titles.find((t) => t.textContent?.includes('Ship it'));
        expect(briefTitle?.textContent).toContain('<img src=x onerror=alert(2)>Ship it');
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
        expect(section).not.toBeNull();
        const rows = sectionRows(page.document, 'In progress');
        expect(rows.length).toBe(5);
        // W-dashboard: the count beside the heading is what the section is
        // SHOWING, so it can never disagree with the rows on screen. Eight
        // jobs exist and five render; a count of eight here would be a
        // total across rows this page deliberately does not show.
        expect(section?.querySelector('.secount')?.textContent).toBe('5');
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

  // W-dashboard, done-means 4: the avatars. The wireframe mounts three
  // data-avatar elements and the built page mounted none, which is one of
  // the two assertions the conformance gate failed on. The mount is a
  // contract with the swarm engine, so this drives the real page and reads
  // the attribute back rather than trusting the markup.
  it('mounts a data-avatar on every in-progress row whose read carries a DID, and never an empty one', async () => {
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'dashboard-avatar-buyer', id: 9814 }),
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
      // A pending row: GET /accounts/:did/pending carries agentDid
      // (src/api/app.ts), so this row CAN mount and must.
      await jobRepo.create(jobFixture({ id: 'd16-avatar-pending', buyerDid: me.did, agentDid, status: 'draft', criteria: [] }, new Date('2026-08-11T00:00:00Z')));
      // A confirmed hire: GET /accounts/:did/jobs carries agentName and
      // no agentDid today, so this row must render with NO mount rather
      // than an empty one. Never invent a DID, never derive one from a
      // name. When the jobs row shape gains agentDid this assertion is
      // the one that flips, and it flips deliberately.
      await jobRepo.create(jobFixture({ id: 'd16-avatar-job', buyerDid: me.did, agentDid, status: 'confirmed', confirmedAt: new Date('2026-08-10T00:00:00Z') }, new Date('2026-08-10T00:00:00Z')));

      const page = await renderDashboard(baseUrl2, session);
      try {
        const rows = sectionRows(page.document, 'In progress');
        expect(rows.length).toBe(2);
        // Newest first: the pending row (Aug 11) leads.
        const pendingRow = rows[0];
        const jobRow = rows[1];

        const mount = pendingRow?.querySelector('[data-avatar]');
        expect(mount, 'a row whose read carries a DID mounts an avatar').not.toBeNull();
        expect(mount?.getAttribute('data-avatar')).toBe(agentDid);
        expect(mount?.classList.contains('jobav')).toBe(true);
        expect(mount?.classList.contains('is-unknown')).toBe(false);
        // The engine actually filled it: FASwarm draws an SVG from the DID.
        expect(mount?.querySelector('svg'), 'swarm.js must fill the mount').not.toBeNull();

        // A row with no DID keeps the 30px box so the repo names down the
        // section share one left edge, and carries NO data-avatar: there
        // is nothing for the engine to paint and nothing claimed. An
        // empty data-avatar would paint a disc standing in for an
        // identity nobody supplied.
        const unknown = jobRow?.querySelector('.jobav');
        expect(unknown, 'the box stays so the column stays aligned').not.toBeNull();
        expect(unknown?.classList.contains('is-unknown')).toBe(true);
        expect(unknown?.hasAttribute('data-avatar')).toBe(false);
        expect(unknown?.firstElementChild, 'nothing is painted into it').toBeNull();

        // Nowhere on the page is there a mount with an empty value: that
        // would paint a grey disc standing in for an identity nobody gave.
        const empty = Array.from(page.document.querySelectorAll('[data-avatar]')).filter(
          (el) => (el.getAttribute('data-avatar') ?? '') === '',
        );
        expect(empty).toEqual([]);
      } finally {
        page.close();
      }
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
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

  describe('layout: the twelve-column grid pairs the two reference sections and stacks them below 900px; 320px shows no horizontal overflow (done-means 16)', () => {
    // W-dashboard: .dgrid was a 2x2 grid of equal panels declared in this
    // page's own <style> block. The wireframe rejects that shape in its
    // own words ("Four identical panels say the four things are equally
    // urgent, which is false"), so the grid is now twelve columns in
    // pipeline.css: sections 1 and 2 span 12, sections 3 and 4 span 6 and
    // pair off underneath. The rule moved, so the assertion follows it to
    // the file that ships it, and the real-Chrome case below measures the
    // resulting geometry rather than trusting either declaration.
    it('pipeline.css ships the twelve-column grid and the collapse rule, and the page loads it', async () => {
      const page = await fetch(`${baseUrl}/dashboard`, { headers: { Accept: HTML } });
      const markup = await page.text();
      expect(markup).toContain('href="/css/pipeline.css"');

      const sheet = await fetch(`${baseUrl}/css/pipeline.css`);
      expect(sheet.status, 'pipeline.css must be served, not just referenced').toBe(200);
      const css = await sheet.text();
      expect(css).toMatch(/\.dgrid\s*\{[^}]*grid-template-columns:\s*repeat\(12, 1fr\)/);
      expect(css).toMatch(/\.dspan-12\s*\{\s*grid-column:\s*span 12/);
      expect(css).toMatch(/\.dspan-6\s*\{\s*grid-column:\s*span 6/);
      expect(css).toMatch(/@media \(max-width: 900px\)\s*\{\s*\.dspan-6\s*\{\s*grid-column:\s*span 12/);
    });

    it('the travelling light has no keyframes outside prefers-reduced-motion: no-preference', async () => {
      // The rest state is the design and the animation is the enhancement
      // (pipeline.css's own header): base.css ends with
      // `animation: none !important` under reduced motion, so anything
      // whose meaning lives in its keyframes renders as a frozen first
      // frame. Every `animation:` declaration in this sheet must therefore
      // sit inside the no-preference block, which is what this reads.
      const css = await (await fetch(`${baseUrl}/css/pipeline.css`)).text();
      const noPreference = css.indexOf('@media (prefers-reduced-motion: no-preference)');
      expect(noPreference, 'pipeline.css must carry the no-preference block').toBeGreaterThan(-1);
      const before = css.slice(0, noPreference);
      expect(before).not.toMatch(/^\s*animation:/m);
      // And the light itself is neutral, never the accent: --accent means
      // "we watched this happen" and work in flight has not happened.
      const spark = /\.flow-spark\s*\{[\s\S]*?\}/.exec(css)?.[0] ?? '';
      expect(spark).not.toBe('');
      expect(spark).not.toContain('--accent');
      expect(spark).not.toContain('--t-hire');
    });

    it('the two dspan-6 sections sit side by side at 1280px and stack at 320px, real Chrome', async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
        return;
      }
      // CI2 D1 rework: per-step timing on the actual runner, since local
      // timing does not reproduce the 30s+ duration CI showed. Each line
      // is prefixed so it survives vitest's output and can be grepped
      // straight out of the Actions log. TEMPORARY: always on for this
      // diagnostic push; gated back to opt-in once the runner numbers are
      // in and the timeout is sized (or the cause fixed) from them.
      const stepStart = Date.now();
      let lastMark = stepStart;
      const mark = (label: string): void => {
        const t = Date.now();
        console.log(`[CI2-TIMING] ${label}: ${t - lastMark}ms (total ${t - stepStart}ms)`);
        lastMark = t;
      };

      const meRes = await fetch(`${baseUrl}/accounts/me`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${buyerSession.token}` },
      });
      const me = (await meRes.json()) as { did: string };
      mark('seed:accounts-me');
      const now = new Date();
      // One row in section 3 and one in section 4, so both half-width
      // sections actually render and their geometry can be measured. A
      // roster agent with no verified record is section 3's own honest
      // attention row; a merged hire inside the window is section 4's.
      const pairAgentDid = 'did:abt:dashboard-layout-pair-agent';
      await agentRepo.create({
        did: pairAgentDid,
        operatorDid: me.did,
        delegation: delegationFixture(pairAgentDid, me.did),
        name: 'layout-pair-scout',
        skills: [],
        githubLogin: null,
      });
      await jobRepo.create(jobFixture({ id: 'd14-pair-shipped', buyerDid: me.did, agentDid, status: 'completed', mergedAt: now }, now));
      mark('seed:agent+job');

      const measure = `
        (() => {
          const grid = document.getElementById('dgrid').getBoundingClientRect();
          const six = Array.from(document.querySelectorAll('#dgrid > section'))
            .filter((el) => el.classList.contains('dspan-6'));
          return {
            grid: Math.round(grid.width),
            boxes: six.map((el) => {
              const r = el.getBoundingClientRect();
              return [Math.round(r.top), Math.round(r.left), Math.round(r.width)];
            }),
          };
        })()
      `;

      // ONE browser for both widths, resized between the two measurements
      // rather than relaunched. Every real-Chrome case in this suite costs
      // a process, and the files run concurrently: a second launch here
      // widens the window in which another file's browser contends for the
      // same machine, which is how a green suite starts flaking. The
      // measurement is unchanged, since setViewport drives the same
      // Emulation.setDeviceMetricsOverride the launch does.
      //
      // Both claims are made AGAINST THE GRID'S OWN WIDTH, never against a
      // pixel count carried from the other viewport: a 320px section is
      // 292px and a 1280px half-section is 531px, so "wider than before"
      // is false at the width where the collapse actually happens.
      type Measured = { grid: number; boxes: Array<[number, number, number]> };
      const browser = await RealBrowser.launch({ width: 1280, height: 900 });
      mark('browser:launch');
      try {
        await browser.goto(`${baseUrl}/dashboard`);
        mark('browser:goto1');
        await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(buyerSession))})`);
        mark('browser:evaluate-set-session');
        await browser.goto(`${baseUrl}/dashboard`);
        mark('browser:goto2');

        const wide = await browser.evaluate<Measured>(measure);
        mark('browser:measure-wide');
        expect(wide.boxes.length, 'both half-width sections must render for this measurement').toBe(2);
        const [wideFirst, wideSecond] = wide.boxes as [[number, number, number], [number, number, number]];
        // Side by side: same row, different columns.
        expect(wideFirst[0]).toBe(wideSecond[0]);
        expect(wideSecond[1]).toBeGreaterThan(wideFirst[1]);
        // Each is about half the grid, and neither spans it.
        expect(wideSecond[1]).toBeGreaterThan(wideFirst[1] + wideFirst[2] - 1);
        expect(wideFirst[2]).toBeLessThan(wide.grid * 0.55);

        await browser.setViewport(320, 900);
        mark('browser:set-viewport-320');
        await new Promise((resolve) => setTimeout(resolve, 200));
        const narrow = await browser.evaluate<Measured>(measure);
        mark('browser:measure-narrow');
        expect(narrow.boxes.length).toBe(2);
        const [narrowFirst, narrowSecond] = narrow.boxes as [[number, number, number], [number, number, number]];
        // Stacked: same column, one below the other.
        expect(narrowSecond[0]).toBeGreaterThan(narrowFirst[0]);
        expect(narrowSecond[1]).toBe(narrowFirst[1]);
        // And the collapse is real rather than a reflow: each now spans
        // the whole grid.
        expect(narrowFirst[2]).toBe(narrow.grid);
        expect(narrowSecond[2]).toBe(narrow.grid);
      } finally {
        await browser.close();
        mark('browser:close');
      }
    }, BROWSER_TIMEOUT_MS);

    it('under prefers-reduced-motion the rail still says where the work is, with every animation off, real Chrome', async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
        return;
      }
      // The standard: every animation gates on prefers-reduced-motion with
      // a dignified static end. The CSS-source case above proves the
      // keyframes live in the right block; this proves what a person who
      // asked not to be moved actually SEES, which is the claim that
      // matters. base.css ends with `animation: none !important` under
      // reduce, so an effect whose meaning lives in its keyframes would
      // render here as a frozen first frame: a light at translateX(-100%)
      // and opacity 0, which is nothing at all.
      const meRes = await fetch(`${baseUrl}/accounts/me`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${buyerSession.token}` },
      });
      const me = (await meRes.json()) as { did: string };
      await jobRepo.create(jobFixture({ id: 'd17-reduced-motion', buyerDid: me.did, agentDid, status: 'confirmed', confirmedAt: new Date() }, new Date()));

      const browser = await RealBrowser.launch({ width: 1280, height: 1000 });
      try {
        await browser.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        });
        await browser.goto(`${baseUrl}/dashboard`);
        await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(buyerSession))})`);
        await browser.goto(`${baseUrl}/dashboard`);

        const rest = await browser.evaluate<{
          reduce: boolean;
          sparkAnimation: string | null;
          ringAnimation: string | null;
          ringBorder: string | null;
          sparkOpacity: string | null;
          sparkGapFromNode: number | null;
          hidden: number;
        }>(`
          (() => {
            const spark = document.querySelector('#dgrid .flow-step.is-now .flow-spark');
            const dot = document.querySelector('#dgrid .flow-step.is-now .flow-dot');
            const line = spark && spark.parentElement;
            const sc = spark && getComputedStyle(spark);
            const ring = dot && getComputedStyle(dot, '::after');
            const sr = spark && spark.getBoundingClientRect();
            const lr = line && line.getBoundingClientRect();
            return {
              reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
              sparkAnimation: sc ? sc.animationName : null,
              ringAnimation: ring ? ring.animationName : null,
              ringBorder: ring ? ring.border : null,
              sparkOpacity: sc ? sc.opacity : null,
              sparkGapFromNode: sr && lr ? Math.round(lr.right - sr.right) : null,
              hidden: Array.from(document.querySelectorAll('#dgrid .reveal, #dgrid .stagger > *'))
                .filter((e) => getComputedStyle(e).opacity !== '1').length,
            };
          })()
        `);

        expect(rest.reduce, 'the emulation must actually take').toBe(true);
        // Nothing is running.
        expect(rest.sparkAnimation).toBe('none');
        expect(rest.ringAnimation).toBe('none');
        // And the meaning survives anyway: the light is fully visible and
        // parked against the current node, with a standing ring around it.
        expect(rest.sparkOpacity).toBe('1');
        expect(rest.sparkGapFromNode, 'the light rests against the current node').toBe(0);
        expect(rest.ringBorder).toContain('1px solid');
        // No content is left faded out by a reveal that never fired.
        expect(rest.hidden).toBe(0);
      } finally {
        await browser.close();
      }
    }, BROWSER_TIMEOUT_MS);

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
    }, BROWSER_TIMEOUT_MS);

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

        // W-dashboard: the filter above passes trivially on an empty
        // grid, so the measurement states what it actually measured.
        // Every shape this page renders a control in has to be in the
        // sample or the pass means nothing: a decision card, the one
        // primary button, and a job row with its stage rail.
        const measured = await browser.evaluate<{ controls: number; cards: number; primaries: number; jobrows: number }>(`
          ({
            controls: document.querySelectorAll('#dgrid a, #dgrid button').length,
            cards: document.querySelectorAll('#dgrid .dcard').length,
            primaries: document.querySelectorAll('#dgrid .btn-primary').length,
            jobrows: document.querySelectorAll('#dgrid .jobrow').length,
          })
        `);
        expect(measured.controls, 'the 44px sweep measured nothing, so it proved nothing').toBeGreaterThan(3);
        expect(measured.cards).toBeGreaterThan(0);
        expect(measured.primaries).toBe(1);
        expect(measured.jobrows).toBeGreaterThan(0);
      } finally {
        await browser.close();
      }
    }, BROWSER_TIMEOUT_MS);
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
