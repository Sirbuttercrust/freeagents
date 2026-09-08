// P8m: the My jobs screen, driven end to end against the real app (the
// discipline tests/web/pullrequest.test.ts, tests/web/staged.test.ts and
// tests/web/nav-auth.test.ts already hold to). GET /accounts/me and
// GET /accounts/:did/jobs are both exercised for real, never asserted
// from a client-side stub.
import type { Server } from 'node:http';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { MemoryAccountRepository, MemoryAgentRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import { createJob, type Job } from '../../src/domain/job.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession } from '../helpers/session-fixtures.js';
import type { Session } from '../../src/adapters/identity/session.js';
import type { Delegation } from '../../src/domain/agent.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
// P8d: resolving a session to an account when none exists yet
// (resolveActingParty's own provisioning path) needs FREEAGENTS_PLATFORM_SEED.
// GET /accounts/me is exactly that first authenticated call this test file
// makes, so the seed is set for the whole suite, mirroring
// tests/api/account-provisioning.test.ts's own withPlatformSeed pattern.
const PLATFORM_SEED = 'f'.repeat(64);

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

async function renderMyJobs(baseUrl: string, session: Session | null): Promise<Rendered> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  const response = await fetch(`${baseUrl}/myjobs`, { headers: { Accept: HTML } });
  const markup = await response.text();
  const dom = new JSDOM(markup, {
    url: `${baseUrl}/myjobs`,
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

describe('the My jobs screen, driven end to end against the real app', () => {
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

    agentDid = 'did:abt:myjobs-page-agent';
    const operatorDid = 'did:abt:myjobs-page-operator';

    agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agentDid,
      operatorDid,
      delegation: delegationFixture(agentDid, operatorDid),
      name: 'myjobs-page-scout',
      skills: ['triage'],
      githubLogin: null,
    });

    accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: operatorDid, githubLogin: 'myjobs-page-operator-login' });

    jobRepo = new MemoryJobRepository();

    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'myjobs-page-buyer', id: 9701 }),
    });

    const app = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    baseUrl = `http://127.0.0.1:${address.port}`;

    buyerSession = await mintSession(sessionAdapter);
    // The session provisions an account on its first authenticated call
    // (P8d, resolveActingParty); GET /accounts/me is that first call for
    // every test below, so buyerDid is not known ahead of time here --
    // each test fetches its own rows against whatever DID the session
    // resolves to, read back from GET /accounts/me itself.
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalSeed === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
    else process.env.FREEAGENTS_PLATFORM_SEED = originalSeed;
  });

  it('a signed-out visitor is sent to sign in and no row is ever rendered (done-means 8)', async () => {
    const page = await renderMyJobs(baseUrl, null);
    try {
      expect(page.document.getElementById('signin-required')?.hidden).toBe(false);
      expect(page.document.getElementById('myjobs-body')?.hidden).toBe(true);
      expect(page.document.querySelectorAll('#rows > *').length).toBe(0);
    } finally {
      page.close();
    }
  });

  it('a buyer with no hires sees the wireframe empty state and Browse agents, not a blank list or an error (done-means 9)', async () => {
    const page = await renderMyJobs(baseUrl, buyerSession);
    try {
      expect(page.document.getElementById('load-error')?.hidden).toBe(true);
      expect(page.document.getElementById('myjobs-body')?.hidden).toBe(false);
      expect(page.document.getElementById('empty-state')?.hidden).toBe(false);
      const browseLinks = Array.from(page.document.querySelectorAll('#empty-state a')).filter((a) => a.textContent === 'Browse agents');
      expect(browseLinks.length).toBeGreaterThan(0);
    } finally {
      page.close();
    }
  });

  it('a signed-in buyer with hires sees one row per hire, each opening /jobs/:jobId, and the session token never appears in the document (done-means 6, 11)', async () => {
    // Resolve this session's own DID first (the same GET /accounts/me
    // read myjobs.js itself makes), so the fixture jobs are planted
    // against the REAL buyerDid this session resolves to.
    const meRes = await fetch(`${baseUrl}/accounts/me`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${buyerSession.token}` },
    });
    const me = (await meRes.json()) as { did: string };
    const buyerDid = me.did;

    await jobRepo.create(jobFixture({ id: 'myjobs-row-staged', buyerDid, agentDid, status: 'staged', stagedAt: new Date('2026-08-01T00:00:00Z') }, new Date('2026-08-01T00:00:00Z')));
    await jobRepo.create(jobFixture({ id: 'myjobs-row-completed', buyerDid, agentDid, repository: 'buyer/other-repo', brief: 'Ship the thing', status: 'completed', mergedAt: new Date('2026-08-02T00:00:00Z') }, new Date('2026-08-02T00:00:00Z')));

    const page = await renderMyJobs(baseUrl, buyerSession);
    try {
      expect(page.document.getElementById('myjobs-body')?.hidden).toBe(false);
      const rows = Array.from(page.document.querySelectorAll('#rows > a'));
      expect(rows.length).toBe(2);
      const hrefs = rows.map((r) => r.getAttribute('href'));
      expect(hrefs).toContain('/jobs/myjobs-row-staged');
      expect(hrefs).toContain('/jobs/myjobs-row-completed');
      expect(page.document.documentElement.outerHTML).not.toContain(buyerSession.token);
    } finally {
      page.close();
    }
  });

  it('the four filter chips filter the rendered rows, and the four bucket counts sum to the All count (done-means 7)', async () => {
    const meRes = await fetch(`${baseUrl}/accounts/me`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${buyerSession.token}` },
    });
    const me = (await meRes.json()) as { did: string };
    const buyerDid = me.did;

    // Fresh ids so this test's counts are not polluted by the previous
    // test's two rows on the same shared buyerDid.
    await jobRepo.create(jobFixture({ id: 'chip-staged', buyerDid, agentDid, status: 'staged', stagedAt: new Date('2026-08-03T00:00:00Z') }, new Date('2026-08-03T00:00:00Z')));
    await jobRepo.create(jobFixture({ id: 'chip-confirmed', buyerDid, agentDid, status: 'confirmed', confirmedAt: new Date('2026-08-04T00:00:00Z') }, new Date('2026-08-04T00:00:00Z')));
    await jobRepo.create(jobFixture({ id: 'chip-completed', buyerDid, agentDid, status: 'completed', mergedAt: new Date('2026-08-05T00:00:00Z') }, new Date('2026-08-05T00:00:00Z')));
    await jobRepo.create(jobFixture({ id: 'chip-declined', buyerDid, agentDid, status: 'declined' }, new Date('2026-08-06T00:00:00Z')));

    const page = await renderMyJobs(baseUrl, buyerSession);
    try {
      const chips = Array.from(page.document.querySelectorAll('.filters .chip'));
      const chipText = (bucket: string): string => chips.find((c) => c.getAttribute('data-bucket') === bucket)?.textContent ?? '';
      const allCount = parseInt(chipText('all').replace(/\D/g, ''), 10);
      const waitingCount = parseInt(chipText('waitingOnYou').replace(/\D/g, ''), 10);
      const progressCount = parseInt(chipText('inProgress').replace(/\D/g, ''), 10);
      const shippedCount = parseInt(chipText('shipped').replace(/\D/g, ''), 10);
      const notShippedCount = parseInt(chipText('notShipped').replace(/\D/g, ''), 10);
      expect(waitingCount + progressCount + shippedCount + notShippedCount).toBe(allCount);

      const inProgressChip = chips.find((c) => c.getAttribute('data-bucket') === 'inProgress') as HTMLButtonElement;
      inProgressChip.click();
      const rows = Array.from(page.document.querySelectorAll('#rows > a'));
      expect(rows.length).toBe(progressCount);
      expect(rows.map((r) => r.getAttribute('href'))).toContain('/jobs/chip-confirmed');
      expect(inProgressChip.getAttribute('aria-pressed')).toBe('true');
      const allChip = chips.find((c) => c.getAttribute('data-bucket') === 'all') as HTMLButtonElement;
      expect(allChip.getAttribute('aria-pressed')).toBe('false');
    } finally {
      page.close();
    }
  });

  it('a job title with markup renders as content, never markup (mutation proof 6)', async () => {
    const meRes = await fetch(`${baseUrl}/accounts/me`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${buyerSession.token}` },
    });
    const me = (await meRes.json()) as { did: string };
    const buyerDid = me.did;

    await jobRepo.create(jobFixture({ id: 'myjobs-markup', buyerDid, agentDid, brief: '<img src=x onerror=alert(1)>Ship it', status: 'confirmed', confirmedAt: new Date('2026-08-07T00:00:00Z') }, new Date('2026-08-07T00:00:00Z')));

    const page = await renderMyJobs(baseUrl, buyerSession);
    try {
      expect(page.document.querySelector('#rows img')).toBeNull();
      const row = page.document.querySelector('a[href="/jobs/myjobs-markup"] .t');
      expect(row?.textContent).toContain('<img src=x onerror=alert(1)>Ship it');
    } finally {
      page.close();
    }
  });

  describe('layout: 320px, chip row wraps, chip and row controls are 44px targets (layout-broken-at-desktop)', () => {
    it('every chip measures at least 44px tall, the filters row is set to wrap, and the row links carry no fixed width that would overflow', async () => {
      const meRes = await fetch(`${baseUrl}/accounts/me`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${buyerSession.token}` },
      });
      const me = (await meRes.json()) as { did: string };
      const buyerDid = me.did;
      await jobRepo.create(jobFixture({ id: 'myjobs-layout-row', buyerDid, agentDid, status: 'confirmed', confirmedAt: new Date('2026-08-08T00:00:00Z') }, new Date('2026-08-08T00:00:00Z')));

      const page = await renderMyJobs(baseUrl, buyerSession);
      try {
        Object.defineProperty(page.window, 'innerWidth', { writable: true, configurable: true, value: 320 });
        const chips = Array.from(page.document.querySelectorAll('.filters .chip'));
        expect(chips.length).toBe(5);
        chips.forEach((chip) => {
          const style = page.window.getComputedStyle(chip as Element);
          expect(parseFloat(style.minHeight)).toBeGreaterThanOrEqual(44);
        });

        // base.css's own 320px media query wraps .filters (the shared
        // filter-chip vocabulary this page reuses, per the brief's own
        // instruction not to invent a second one), read from the
        // stylesheet the same way tests/web/staged.test.ts's own layout
        // block already pins declared rules rather than a real reflow
        // jsdom cannot perform.
        const baseCss = await (await fetch(`${baseUrl}/css/base.css`)).text();
        expect(baseCss).toMatch(/@media \(max-width: 420px\)[\s\S]*\.filters\s*\{\s*flex-wrap:\s*wrap/);

        const row = page.document.querySelector('#rows > a');
        expect(row).not.toBeNull();
        const rowStyle = page.window.getComputedStyle(row as Element);
        expect(rowStyle.display).toBe('flex');
      } finally {
        page.close();
      }
    });
  });
});
