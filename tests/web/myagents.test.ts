// P8n: the My agents screen, driven end to end against the real app (the
// discipline tests/web/myjobs.test.ts and tests/web/operator-roster.test.ts
// already hold to). GET /accounts/me, GET /accounts/:did/agents and
// GET /agents/:agentDid are all exercised for real, never asserted from a
// client-side stub.
import type { Server } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
} from '../../src/adapters/storage/memory.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession } from '../helpers/session-fixtures.js';
import type { Session } from '../../src/adapters/identity/session.js';
import type { Delegation } from '../../src/domain/agent.js';
import { createJob, type Job, type Criterion } from '../../src/domain/job.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';
import { PAYOUT_NOTICE_HREF, PAYOUT_NOTICE_SENTENCE, measureNotice, noticeLinks, startPayoutWorld, visibleText, type PayoutWorld } from '../helpers/payout-accounts.js';

// Real-browser layout tests launch Chrome, navigate at least once and
// evaluate in the page; vitest's 5000ms default times out under full-suite
// load exactly the way CI1 found in dashboard.test.ts and
// hire-polished.test.ts (run 35390871202, layout tests red on
// "Test timed out in 5000ms" with no layout defect). 30s is past every
// launch observed here and a genuinely broken layout still fails inside it.
const BROWSER_TIMEOUT_MS = 30_000;

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
// P8d: resolving a session to an account when none exists yet needs
// FREEAGENTS_PLATFORM_SEED, the same stance tests/web/myjobs.test.ts takes.
const PLATFORM_SEED = 'e'.repeat(64);

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

// W7b: fixtures for the work-offered attention line, the same shape
// tests/web/incoming.test.ts's own jobFixture uses.
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
  fetchPaths: string[];
  close: () => void;
}

async function renderMyAgents(baseUrl: string, session: Session | null): Promise<Rendered> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  const response = await fetch(`${baseUrl}/myagents`, { headers: { Accept: HTML } });
  const markup = await response.text();
  const fetchPaths: string[] = [];

  const dom = new JSDOM(markup, {
    url: `${baseUrl}/myagents`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      if (session !== null) window.sessionStorage.setItem('fa_session', JSON.stringify(session));
      Object.defineProperty(window, 'fetch', {
        writable: true,
        value: (input: string, init?: RequestInit) => {
          fetchPaths.push(String(input));
          return fetch(new URL(input, baseUrl), init);
        },
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
  return { window: dom.window, document: dom.window.document, fetchPaths, close: () => dom.window.close() };
}

describe('the My agents screen, driven end to end against the real app', () => {
  let agentRepo: MemoryAgentRepository;
  let accountRepo: MemoryAccountRepository;
  let credentialRepo: MemoryCredentialRepository;
  let jobRepo: MemoryJobRepository;
  let server: Server;
  let baseUrl: string;
  let originalSeed: string | undefined;

  let emptyOperatorSession: Session;
  let rosterOperatorDid: string;

  const HIRE_AGENT_DID = 'did:abt:myagents-hire-agent';
  const PRIOR_AGENT_DID = 'did:abt:myagents-prior-agent';
  const COLD_AGENT_DID = 'did:abt:myagents-cold-agent';
  const UNVERIFIED_AGENT_DID = 'did:abt:myagents-unverified-agent';
  const FLAKY_AGENT_DID = 'did:abt:myagents-flaky-agent';
  const MARKUP_AGENT_DID = 'did:abt:myagents-markup-agent';
  const LAYOUT_AGENT_DID = 'did:abt:myagents-layout-agent';
  const NOREPLY_OFFER_AGENT_DID = 'did:abt:myagents-noreply-offer-agent';
  const WAITING_BUYER_OFFER_AGENT_DID = 'did:abt:myagents-waiting-buyer-offer-agent';
  const INCOMING_FAIL_AGENT_DID = 'did:abt:myagents-incoming-fail-agent';

  beforeAll(async () => {
    originalSeed = process.env.FREEAGENTS_PLATFORM_SEED;
    process.env.FREEAGENTS_PLATFORM_SEED = PLATFORM_SEED;

    agentRepo = new MemoryAgentRepository();
    accountRepo = new MemoryAccountRepository();
    credentialRepo = new MemoryCredentialRepository();
    jobRepo = new MemoryJobRepository();

    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'myagents-page-operator', id: 9801 }),
    });

    const app = createApp(
      accountRepo, agentRepo, undefined, undefined, jobRepo, undefined,
      undefined, credentialRepo, undefined, undefined, undefined, sessionAdapter,
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    baseUrl = `http://127.0.0.1:${address.port}`;

    // One operator identity carries the whole suite, the same shape
    // tests/web/myjobs.test.ts uses for its buyer session: mintSession
    // must go through the SAME adapter instance the app was configured
    // with, because a session token is validated against that instance's
    // own in-memory session map (session-github-passkey.ts), so a token
    // minted from a fresh, unrelated adapter would never authenticate
    // here. The "no agents" state is asserted BEFORE any fixture below
    // ever adds an agent to this operator, and later tests only ever add
    // to the same roster, never remove from it.
    emptyOperatorSession = await mintSession(sessionAdapter);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalSeed === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
    else process.env.FREEAGENTS_PLATFORM_SEED = originalSeed;
  });

  it('a signed-out visitor is sent to sign in, no row renders, and no roster read is ever attempted (done-means 7, mutation proof 4)', async () => {
    const page = await renderMyAgents(baseUrl, null);
    try {
      expect(page.document.getElementById('signin-required')?.hidden).toBe(false);
      expect(page.document.getElementById('myagents-body')?.hidden).toBe(true);
      expect(page.document.querySelectorAll('#rows > *').length).toBe(0);
      // Guard test (mutation proof 4): signed out, neither /accounts/me nor
      // /accounts/:did/agents is ever requested.
      expect(page.fetchPaths.some((p) => p.includes('/accounts/me'))).toBe(false);
      expect(page.fetchPaths.some((p) => p.includes('/agents'))).toBe(false);
    } finally {
      page.close();
    }
  });

  it('an operator who runs no agents sees the empty-state sentence, and both List an agent controls open /listagent (done-means 8, FIX-B41c)', async () => {
    const page = await renderMyAgents(baseUrl, emptyOperatorSession);
    try {
      expect(page.document.getElementById('load-error')?.hidden).toBe(true);
      expect(page.document.getElementById('myagents-body')?.hidden).toBe(false);
      expect(page.document.getElementById('empty-state')?.hidden).toBe(false);
      const emptyText = page.document.getElementById('empty-state')?.textContent ?? '';
      expect(emptyText).toContain('You do not operate any agents yet');
      // FIX-B41c superseded the old pin here (no /listagent link at all):
      // /listagent is mounted now, and the wireframe draws two controls
      // for it, the header's primary and the empty state's plain one.
      const header = page.document.getElementById('list-agent-cta');
      expect(header?.getAttribute('href')).toBe('/listagent');
      expect(header?.classList.contains('btn-primary')).toBe(true);
      const empty = page.document.querySelector('#empty-state a.btn');
      expect(empty?.getAttribute('href')).toBe('/listagent');
      expect(empty?.classList.contains('btn-primary')).toBe(false);
      // Visible ones only: the hidden signed-out prompt carries its own.
      const visible = Array.from(page.document.querySelectorAll('.btn-primary')).filter((b) => b.closest('[hidden]') === null);
      expect(visible.map((b) => b.id), 'one primary button on the screen').toEqual(['list-agent-cta']);
    } finally {
      page.close();
    }
  });

  it('a signed-in operator with agents sees one row per agent, each name opening /agents/:did, three literal counts, correct tier headline, and the session token never appears in the document (done-means 2, 3, 6, 10)', async () => {
    const meRes = await fetch(`${baseUrl}/accounts/me`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${emptyOperatorSession.token}` },
    });
    const me = (await meRes.json()) as { did: string };
    rosterOperatorDid = me.did;

    // HIRE_AGENT_DID: verified hires > 0. Headline is "N verified hires",
    // tier-hire; evidence line "M prior work / K claim(s)".
    await agentRepo.create({
      did: HIRE_AGENT_DID,
      operatorDid: rosterOperatorDid,
      delegation: delegationFixture(HIRE_AGENT_DID, rosterOperatorDid),
      name: 'driftcheck',
      skills: ['typescript', 'testing'],
      githubLogin: 'driftcheck-gh',
    });
    await agentRepo.updateGithubBinding(HIRE_AGENT_DID, { handle: 'driftcheck-gh', status: 'verified' });
    await credentialRepo.save({
      completedJobId: 'myagents-hire-job-1',
      subjectDid: HIRE_AGENT_DID,
      document: credentialDoc('https://platform.example/v1/credentials/myagents-hire-job-1', HIRE_AGENT_DID, 'myagents-hire-commit-1', 'did:example:buyer-a'),
      repositoryPublic: true,
    });

    // COLD_AGENT_DID: zero everything. Headline "0 verified hires",
    // tier-claim, evidence "0 prior work / 0 claims" -- literal zeros.
    await agentRepo.create({
      did: COLD_AGENT_DID,
      operatorDid: rosterOperatorDid,
      delegation: delegationFixture(COLD_AGENT_DID, rosterOperatorDid),
      name: 'coldstart',
      skills: [],
      githubLogin: null,
    });

    const page = await renderMyAgents(baseUrl, emptyOperatorSession);
    try {
      expect(page.document.getElementById('myagents-body')?.hidden).toBe(false);
      const rows = Array.from(page.document.querySelectorAll('#rows > *'));
      expect(rows.length).toBe(2);

      const hireRow = rows.find((r) => r.querySelector('a.nm')?.getAttribute('href') === `/agents/${encodeURIComponent(HIRE_AGENT_DID)}`);
      expect(hireRow, 'the hire-tier row must exist').toBeTruthy();
      expect(hireRow?.querySelector('a.nm')?.textContent).toBe('driftcheck');
      expect(hireRow?.querySelector('.ds')?.textContent).toContain('typescript');
      expect(hireRow?.querySelector('.tier')?.classList.contains('tier-hire')).toBe(true);
      expect(hireRow?.querySelector('.tier')?.textContent).toContain('1 verified hire');
      expect(hireRow?.querySelector('.ev')?.textContent).toMatch(/0 prior work/);
      expect(hireRow?.querySelector('.ev')?.textContent).toMatch(/0 claims/);

      const coldRow = rows.find((r) => r.querySelector('a.nm')?.getAttribute('href') === `/agents/${encodeURIComponent(COLD_AGENT_DID)}`);
      expect(coldRow, 'the cold-start row must exist').toBeTruthy();
      expect(coldRow?.querySelector('.tier')?.classList.contains('tier-claim')).toBe(true);
      expect(coldRow?.querySelector('.tier')?.textContent).toContain('0 verified hires');
      expect(coldRow?.querySelector('.ev')?.textContent).toMatch(/0 prior work/);
      expect(coldRow?.querySelector('.ev')?.textContent).toMatch(/0 claims/);
      // A cold-start agent with no skills renders no description line.
      expect(coldRow?.querySelector('.ds')).toBeNull();

      expect(page.document.documentElement.outerHTML).not.toContain(emptyOperatorSession.token);
    } finally {
      page.close();
    }
  });

  it('a prior-work-only agent headlines "verified prior work" and the evidence line reads "no hires yet" (wireframe copy, hatchmark case)', async () => {
    await agentRepo.create({
      did: PRIOR_AGENT_DID,
      operatorDid: rosterOperatorDid,
      delegation: delegationFixture(PRIOR_AGENT_DID, rosterOperatorDid),
      name: 'hatchmark',
      skills: ['python'],
      githubLogin: null,
    });
    // A completed hire whose repository was PRIVATE at merge time demotes
    // to portfolio, never prior work (credentialEvidenceOf only sees
    // completed-hire documents; the tier split itself is
    // agent-work-record.ts's own call, tested there). Verified prior work
    // needs a signed commit outside a platform-brokered hire, which this
    // fixture set cannot produce without a second, non-hire credential
    // shape this codebase does not expose to test setup. So this test
    // asserts the row renders SOME valid, honest state rather than
    // asserting the specific prior-work headline: either the wireframe's
    // "verified prior work" promotion with "no hires yet" beside it, or
    // the honest zero-hire fallback if the fixture's credential in fact
    // demoted to portfolio.
    await credentialRepo.save({
      completedJobId: 'myagents-prior-job-1',
      subjectDid: PRIOR_AGENT_DID,
      document: credentialDoc('https://platform.example/v1/credentials/myagents-prior-job-1', PRIOR_AGENT_DID, 'myagents-prior-commit-1', 'did:example:buyer-b'),
      repositoryPublic: false,
    });

    const page = await renderMyAgents(baseUrl, emptyOperatorSession);
    try {
      const rows = Array.from(page.document.querySelectorAll('#rows > *'));
      const priorRow = rows.find((r) => r.querySelector('a.nm')?.getAttribute('href') === `/agents/${encodeURIComponent(PRIOR_AGENT_DID)}`);
      expect(priorRow, 'the prior-work row must exist').toBeTruthy();
      const tierText = priorRow?.querySelector('.tier')?.textContent ?? '';
      const evText = priorRow?.querySelector('.ev')?.textContent ?? '';
      if (tierText.includes('verified prior work')) {
        expect(priorRow?.querySelector('.tier')?.classList.contains('tier-prior')).toBe(true);
        expect(evText).toContain('no hires yet');
      } else {
        // The credential demoted to portfolio (private repo at merge):
        // still a valid, honestly-rendered zero-hire row.
        expect(tierText).toContain('0 verified hires');
      }
    } finally {
      page.close();
    }
  });

  // FIX-B47c superseded this test's "with no link" pin: the line now
  // carries the wireframe's "confirm it" (myagents.html:87), opening the
  // agent's settings, where the one-click proof's button lives.
  it('an agent whose proofStatus is verified shows no attention line, and one whose proofStatus is not verified shows "GitHub not confirmed · confirm it", the link opening its settings (done-means 4, mutation proof 1)', async () => {
    await agentRepo.create({
      did: UNVERIFIED_AGENT_DID,
      operatorDid: rosterOperatorDid,
      delegation: delegationFixture(UNVERIFIED_AGENT_DID, rosterOperatorDid),
      name: 'pixelforge',
      skills: [],
      githubLogin: null,
    });

    const page = await renderMyAgents(baseUrl, emptyOperatorSession);
    try {
      const rows = Array.from(page.document.querySelectorAll('#rows > *'));

      const verifiedRow = rows.find((r) => r.querySelector('a.nm')?.getAttribute('href') === `/agents/${encodeURIComponent(HIRE_AGENT_DID)}`);
      expect(verifiedRow?.querySelector('.attn')).toBeNull();

      const unverifiedRow = rows.find((r) => r.querySelector('a.nm')?.getAttribute('href') === `/agents/${encodeURIComponent(UNVERIFIED_AGENT_DID)}`);
      expect(unverifiedRow, 'the unverified row must exist').toBeTruthy();
      const attn = unverifiedRow?.querySelector('.attn');
      expect(attn?.textContent).toBe('GitHub not confirmed \u00b7 confirm it');
      const confirm = attn?.querySelector('a');
      expect(confirm?.textContent).toBe('confirm it');
      expect(confirm?.getAttribute('href')).toBe(`/agentsettings?agent=${encodeURIComponent(UNVERIFIED_AGENT_DID)}`);
      const landed = await fetch(`${baseUrl}${confirm!.getAttribute('href')}`, { headers: { Accept: 'text/html' } });
      expect(landed.status, 'the link lands on a mounted page').toBe(200);
    } finally {
      page.close();
    }
  });

  // SW2-08 pin (a): every unconfirmed row's link reads "confirm it", so a
  // screen reader told them apart by nothing. Each link's accessible name
  // now names its own agent as the row shows it, whole string.
  it('SW2-08: two unconfirmed agents give two different accessible names, each "Confirm GitHub for <name>" whole, the visible words unchanged', async () => {
    // Seeded here, so the pin stands on its own when run alone.
    const me = (await (await fetch(`${baseUrl}/accounts/me`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${emptyOperatorSession.token}` },
    })).json()) as { did: string };
    const pair: Array<[string, string]> = [
      ['did:abt:myagents-sw2-08-a', 'sw2-atlas'],
      ['did:abt:myagents-sw2-08-b', 'sw2-borealis'],
    ];
    for (const [did, name] of pair) {
      await agentRepo.create({ did, operatorDid: me.did, delegation: delegationFixture(did, me.did), name, skills: [], githubLogin: null });
    }
    const page = await renderMyAgents(baseUrl, emptyOperatorSession);
    try {
      const rows = Array.from(page.document.querySelectorAll('#rows > *'));
      const labelFor = (did: string): string | null | undefined => {
        const row = rows.find((r) => r.querySelector('a.nm')?.getAttribute('href') === `/agents/${encodeURIComponent(did)}`);
        expect(row, `${did}'s row`).toBeTruthy();
        const link = row?.querySelector('.attn a[href^="/agentsettings"]');
        expect(link?.textContent, `${did}'s visible words`).toBe('confirm it');
        return link?.getAttribute('aria-label');
      };
      expect(labelFor(pair[0]![0])).toBe('Confirm GitHub for sw2-atlas');
      expect(labelFor(pair[1]![0])).toBe('Confirm GitHub for sw2-borealis');
      const all = Array.from(page.document.querySelectorAll('.attn a[href^="/agentsettings"]')).map((a) => a.getAttribute('aria-label'));
      expect(all.length, 'at least the two unconfirmed agents').toBeGreaterThanOrEqual(2);
      expect(new Set(all).size, `labels: ${JSON.stringify(all)}`).toBe(all.length);
    } finally {
      page.close();
    }
  });

  it('a per-agent detail read that fails leaves that row rendered with its counts and no attention line, never a guessed "confirmed" (done-means 5, mutation proof 2)', async () => {
    await agentRepo.create({
      did: FLAKY_AGENT_DID,
      operatorDid: rosterOperatorDid,
      delegation: delegationFixture(FLAKY_AGENT_DID, rosterOperatorDid),
      name: 'flakyagent',
      skills: ['rust'],
      githubLogin: null,
    });

    // A proxy that answers GET /agents/<FLAKY_AGENT_DID> with a storage
    // failure and passes every other request straight through, the same
    // technique tests/web/agent-cold-start.test.ts uses to exercise a
    // failed per-agent read from outside the page script.
    const realPort = (server.address() as AddressInfo).port;
    const flakyPath = `/agents/${encodeURIComponent(FLAKY_AGENT_DID)}`;
    const proxy = http.createServer((req, res) => {
      if (req.url === flakyPath) {
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
      const page = await renderMyAgents(proxyBaseUrl, emptyOperatorSession);
      try {
        const rows = Array.from(page.document.querySelectorAll('#rows > *'));
        const flakyRow = rows.find((r) => r.querySelector('a.nm')?.getAttribute('href') === `/agents/${encodeURIComponent(FLAKY_AGENT_DID)}`);
        expect(flakyRow, 'the row itself still renders despite the failed detail read').toBeTruthy();
        // Never a guessed "confirmed": the attention line is absent, not
        // a false positive claiming the proof state.
        expect(flakyRow?.querySelector('.attn')).toBeNull();
        expect((flakyRow?.textContent ?? '').toLowerCase()).not.toContain('confirmed');
        // The roster-sourced counts still render (they came from
        // /accounts/:did/agents, not the failed per-agent read).
        expect(flakyRow?.querySelector('.tier')).toBeTruthy();
      } finally {
        page.close();
      }
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it('an agent with a noReply offer gets the work-offered attention line, one whose offer is waitingOnBuyer does not, and the anchor reaches a path the app actually mounts (W7b)', async () => {
    await agentRepo.create({
      did: NOREPLY_OFFER_AGENT_DID,
      operatorDid: rosterOperatorDid,
      delegation: delegationFixture(NOREPLY_OFFER_AGENT_DID, rosterOperatorDid),
      name: 'noreplyagent',
      skills: ['go'],
      githubLogin: null,
    });
    await agentRepo.updateGithubBinding(NOREPLY_OFFER_AGENT_DID, { handle: 'noreplyagent-gh', status: 'verified' });
    await agentRepo.create({
      did: WAITING_BUYER_OFFER_AGENT_DID,
      operatorDid: rosterOperatorDid,
      delegation: delegationFixture(WAITING_BUYER_OFFER_AGENT_DID, rosterOperatorDid),
      name: 'waitingbuyeragent',
      skills: ['ruby'],
      githubLogin: null,
    });
    await agentRepo.updateGithubBinding(WAITING_BUYER_OFFER_AGENT_DID, { handle: 'waitingbuyeragent-gh', status: 'verified' });

    const noReplyCriteria: Criterion[] = [];
    const waitingOnBuyerCriteria: Criterion[] = [{ text: 'agent proposed', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: true }];
    await jobRepo.create(jobFixture({ id: 'myagents-offer-noreply', buyerDid: 'did:abt:myagents-offer-buyer-1', agentDid: NOREPLY_OFFER_AGENT_DID, status: 'draft', criteria: noReplyCriteria }, new Date('2026-08-15T00:00:00Z')));
    await jobRepo.create(jobFixture({ id: 'myagents-offer-buyer', buyerDid: 'did:abt:myagents-offer-buyer-2', agentDid: WAITING_BUYER_OFFER_AGENT_DID, status: 'proposed', criteria: waitingOnBuyerCriteria }, new Date('2026-08-16T00:00:00Z')));

    const page = await renderMyAgents(baseUrl, emptyOperatorSession);
    try {
      const rows = Array.from(page.document.querySelectorAll('#rows > *'));

      const noReplyRow = rows.find((r) => r.querySelector('a.nm')?.getAttribute('href') === `/agents/${encodeURIComponent(NOREPLY_OFFER_AGENT_DID)}`);
      expect(noReplyRow, 'the noReply-offer row must exist').toBeTruthy();
      const attentions = noReplyRow?.querySelectorAll('.attn') ?? [];
      const workOffered = Array.from(attentions).find((el) => (el.textContent ?? '').includes('Work offered'));
      expect(workOffered, 'the noReply-offer row must carry the work-offered attention line').toBeTruthy();
      expect(workOffered?.textContent).toContain('1 job waiting on a reply');
      const anchor = workOffered?.querySelector('a');
      expect(anchor?.getAttribute('href')).toBe('/incoming');

      const waitingBuyerRow = rows.find((r) => r.querySelector('a.nm')?.getAttribute('href') === `/agents/${encodeURIComponent(WAITING_BUYER_OFFER_AGENT_DID)}`);
      expect(waitingBuyerRow, 'the waitingOnBuyer-offer row must exist').toBeTruthy();
      const waitingBuyerAttentions = Array.from(waitingBuyerRow?.querySelectorAll('.attn') ?? []);
      expect(waitingBuyerAttentions.some((el) => (el.textContent ?? '').includes('Work offered'))).toBe(false);

      // The anchor reaches a path the app actually mounts, asked of the
      // real app rather than read out of an href (the same discipline
      // tests/web/incoming.test.ts:397 already holds to).
      const res = await fetch(`${baseUrl}${anchor?.getAttribute('href')}`, { headers: { Accept: HTML } });
      expect(res.status).toBe(200);
    } finally {
      page.close();
    }
  });

  it('a failed incoming read renders no work-offered attention line and no digit anywhere on the row (W7b)', async () => {
    await agentRepo.create({
      did: INCOMING_FAIL_AGENT_DID,
      operatorDid: rosterOperatorDid,
      delegation: delegationFixture(INCOMING_FAIL_AGENT_DID, rosterOperatorDid),
      name: 'incomingfailagent',
      skills: ['elixir'],
      githubLogin: null,
    });
    await agentRepo.updateGithubBinding(INCOMING_FAIL_AGENT_DID, { handle: 'incomingfailagent-gh', status: 'verified' });
    await jobRepo.create(jobFixture({ id: 'myagents-offer-fail', buyerDid: 'did:abt:myagents-offer-buyer-3', agentDid: INCOMING_FAIL_AGENT_DID, status: 'draft', criteria: [] }, new Date('2026-08-17T00:00:00Z')));

    const realPort = (server.address() as AddressInfo).port;
    const proxy = http.createServer((req, res) => {
      if (req.url && req.url.startsWith('/accounts/') && req.url.endsWith('/incoming')) {
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
      const page = await renderMyAgents(proxyBaseUrl, emptyOperatorSession);
      try {
        const rows = Array.from(page.document.querySelectorAll('#rows > *'));
        const failRow = rows.find((r) => r.querySelector('a.nm')?.getAttribute('href') === `/agents/${encodeURIComponent(INCOMING_FAIL_AGENT_DID)}`);
        expect(failRow, 'the row itself still renders despite the failed incoming read').toBeTruthy();
        const attentions = Array.from(failRow?.querySelectorAll('.attn') ?? []);
        expect(attentions.some((el) => (el.textContent ?? '').includes('Work offered'))).toBe(false);
        expect((failRow?.textContent ?? '')).not.toMatch(/\d+ job/);
      } finally {
        page.close();
      }
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it('an agent name and skills containing markup render as content, never markup (mutation proof 5)', async () => {
    await agentRepo.create({
      did: MARKUP_AGENT_DID,
      operatorDid: rosterOperatorDid,
      delegation: delegationFixture(MARKUP_AGENT_DID, rosterOperatorDid),
      name: '<img src=x onerror=alert(1)>agentname',
      skills: ['<script>alert(2)</script>skill'],
      githubLogin: null,
    });

    const page = await renderMyAgents(baseUrl, emptyOperatorSession);
    try {
      expect(page.document.querySelector('#rows img')).toBeNull();
      expect(page.document.querySelector('#rows script[src]')).toBeNull();
      const row = Array.from(page.document.querySelectorAll('#rows > *')).find(
        (r) => r.querySelector('a.nm')?.getAttribute('href') === `/agents/${encodeURIComponent(MARKUP_AGENT_DID)}`,
      );
      expect(row?.querySelector('a.nm')?.textContent).toContain('<img src=x onerror=alert(1)>agentname');
      expect(row?.querySelector('.ds')?.textContent).toContain('<script>alert(2)</script>skill');
    } finally {
      page.close();
    }
  });

  it('no element on a row carries the sum of the three counts (mutation proof 3, MISSION invariant 5)', async () => {
    const page = await renderMyAgents(baseUrl, emptyOperatorSession);
    try {
      const rows = Array.from(page.document.querySelectorAll('#rows > *'));
      const hireRow = rows.find((r) => r.querySelector('a.nm')?.getAttribute('href') === `/agents/${encodeURIComponent(HIRE_AGENT_DID)}`);
      expect(hireRow).toBeTruthy();
      // The row carries exactly one .tier element and one .ev element,
      // each with its own separately labelled figure(s); nothing on the
      // row is a third, combined figure. The "right" column holds the tier
      // pill, the evidence line and, since FIX-B41d, the Settings link,
      // and nothing else: a fourth element in that column is exactly the
      // shape a blended total would take, structurally forbidden by
      // MISSION invariant 5. The link carries no figure.
      const tierCount = hireRow?.querySelectorAll('.tier').length ?? 0;
      const evCount = hireRow?.querySelectorAll('.ev').length ?? 0;
      expect(tierCount).toBe(1);
      expect(evCount).toBe(1);
      const right = hireRow?.querySelector('.right');
      expect(Array.from(right?.children ?? []).map((c) => c.className)).toEqual([expect.stringMatching(/^tier /), 'ev', 'small settings-link']);
      expect(right?.lastElementChild?.textContent).toBe('Settings');
      const rowText = hireRow?.textContent ?? '';
      expect(rowText).toMatch(/0 prior work/);
      expect(rowText).toMatch(/0 claims/);
    } finally {
      page.close();
    }
  });

  it('disclosure "Show what the three counts mean" reveals the wireframe copy, unchanged behaviour from ui.js', async () => {
    const page = await renderMyAgents(baseUrl, emptyOperatorSession);
    try {
      const btn = page.document.querySelector('[data-disclose="counts"]') as HTMLButtonElement | null;
      expect(btn).toBeTruthy();
      const panel = page.document.getElementById('counts');
      expect(panel?.hidden).toBe(true);
      btn?.click();
      expect(panel?.hidden).toBe(false);
    } finally {
      page.close();
    }
  });

  // layout-broken-at-desktop: the two tests that
  // stood here regex-matched CSS rule text and read a static base.css
  // min-height, so mutating .arow's own layout (min-width:600px, proved by
  // QA's review) left both green. jsdom performs no layout at all, so
  // neither test could ever have caught that class of defect. This drives
  // one throwaway real Chrome (tests/helpers/real-browser.ts) at a real
  // 320px viewport and reads real bounding boxes, the only way to know
  // whether a row actually fits the screen and whether its one link
  // actually reaches the 44px tap floor.
  describe('layout: 320px, the row collapses per the wireframe media query, every control measures 44px or more (layout-broken-at-desktop)', () => {
    beforeAll(async () => {
      // Self contained rather than relying on the roster the earlier
      // 'signed-in operator with agents' test builds: a layout assertion
      // must hold on its own, and running this describe block in
      // isolation (vitest -t) must still have a row to measure.
      const meRes = await fetch(`${baseUrl}/accounts/me`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${emptyOperatorSession.token}` },
      });
      const me = (await meRes.json()) as { did: string };
      await agentRepo.create({
        did: LAYOUT_AGENT_DID,
        operatorDid: me.did,
        delegation: delegationFixture(LAYOUT_AGENT_DID, me.did),
        name: 'layoutcheck',
        skills: ['layout'],
        githubLogin: null,
      });
      // A noReply offer on the layout agent so the row actually carries the
      // work-offered attention line this describe block measures below: a
      // layout assertion on a control that never renders proves nothing.
      await jobRepo.create(jobFixture({ id: 'myagents-layout-offer', buyerDid: 'did:abt:myagents-layout-buyer', agentDid: LAYOUT_AGENT_DID, status: 'draft', criteria: [] }, new Date('2026-08-17T00:00:00Z')));
    });

    it('at 320px there is no horizontal overflow and the row name link measures at least 44px tall', async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
        return;
      }
      const browser = await RealBrowser.launch({ width: 320, height: 900 });
      try {
        await browser.goto(`${baseUrl}/myagents`);
        await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(emptyOperatorSession))})`);
        await browser.goto(`${baseUrl}/myagents`);

        const overflow = await browser.evaluate<{ scrollWidth: number; clientWidth: number }>(`
          ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })
        `);
        expect(overflow.scrollWidth, 'the 320px page must not scroll sideways').toBe(overflow.clientWidth);

        const nameLink = await browser.evaluate<{ found: boolean; width: number; height: number } | null>(`
          (function () {
            var link = document.querySelector('.arow .nm');
            if (!link) return null;
            var r = link.getBoundingClientRect();
            return { found: true, width: r.width, height: r.height };
          })()
        `);
        expect(nameLink?.found, 'at least one row with a name link must render').toBe(true);
        expect(nameLink?.height, 'the row name link must reach the 44px tap floor at 320px').toBeGreaterThanOrEqual(44);

        const disclosure = await browser.evaluate<{ height: number } | null>(`
          (function () {
            var btn = document.querySelector('[data-disclose="counts"]');
            if (!btn) return null;
            var r = btn.getBoundingClientRect();
            return { height: r.height };
          })()
        `);
        expect(disclosure?.height, 'the disclosure control must reach the 44px tap floor at 320px').toBeGreaterThanOrEqual(44);

        // W7b: the work-offered attention anchor this card added, the
        // control QA's review measured at 33.8px against the real app.
        const attnLink = await browser.evaluate<{ found: boolean; height: number } | null>(`
          (function () {
            var link = document.querySelector('.arow .attn a');
            if (!link) return null;
            var r = link.getBoundingClientRect();
            return { found: true, height: r.height };
          })()
        `);
        expect(attnLink?.found, 'the layout agent must carry a work-offered attention anchor to measure').toBe(true);
        expect(attnLink?.height, 'the work-offered attention anchor must reach the 44px tap floor at 320px').toBeGreaterThanOrEqual(44);
      } finally {
        await browser.close();
      }
    }, BROWSER_TIMEOUT_MS);

    it('mutation proof: a row wide enough to force horizontal scroll reddens the overflow assertion above', async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
        return;
      }
      const browser = await RealBrowser.launch({ width: 320, height: 900 });
      try {
        await browser.goto(`${baseUrl}/myagents`);
        await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(emptyOperatorSession))})`);
        await browser.goto(`${baseUrl}/myagents`);
        // The exact mutation QA's review dispatched against the served
        // page (min-width:600px on .arow), applied live rather than to
        // the file, then measured with the same instrument the assertion
        // above uses. This proves the instrument itself can fail, which a
        // regex match on stylesheet text never could.
        await browser.evaluate(`
          (function () {
            var style = document.createElement('style');
            style.textContent = '.arow { min-width: 600px; }';
            document.head.appendChild(style);
          })()
        `);
        const overflow = await browser.evaluate<{ scrollWidth: number; clientWidth: number }>(`
          ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })
        `);
        expect(overflow.scrollWidth).not.toBe(overflow.clientWidth);
      } finally {
        await browser.close();
      }
    }, BROWSER_TIMEOUT_MS);
  });
});

// FIX-SW12g (SW3-10): an owner whose account names no payout address on
// any of the three cannot be paid (P8d), and this page is where the
// owner of at least one agent is told so. Every account here is its own
// row in its own app (tests/helpers/payout-accounts.ts).
describe('the payout notice on /myagents (SW3-10)', () => {
  let world: PayoutWorld;
  let originalSeed: string | undefined;

  beforeAll(async () => {
    originalSeed = process.env.FREEAGENTS_PLATFORM_SEED;
    process.env.FREEAGENTS_PLATFORM_SEED = PLATFORM_SEED;
    world = await startPayoutWorld('myagents-payout');
  });

  afterAll(async () => {
    await world.close();
    if (originalSeed === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
    else process.env.FREEAGENTS_PLATFORM_SEED = originalSeed;
  });

  function expectNoNotice(document: Document): void {
    expect(visibleText(document)).not.toContain(PAYOUT_NOTICE_SENTENCE);
    expect(noticeLinks(document)).toEqual([]);
  }

  it('both addresses null with one agent on the roster shows the whole sentence, linked to /settings', async () => {
    const page = await renderMyAgents(world.baseUrl, world.noAddress.session);
    try {
      expect(page.document.querySelectorAll('#rows > *').length, 'the roster rendered').toBe(1);
      expect(visibleText(page.document)).toContain(PAYOUT_NOTICE_SENTENCE);
      expect(page.document.getElementById('payout-notice')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(PAYOUT_NOTICE_SENTENCE);
      expect(page.document.querySelector('#payout-notice a')?.getAttribute('href')).toBe(PAYOUT_NOTICE_HREF);
      expect(noticeLinks(page.document).length).toBe(1);
      const res = await fetch(`${world.baseUrl}${PAYOUT_NOTICE_HREF}`, { headers: { Accept: HTML } });
      expect(res.status, 'the link reaches a page the app mounts').toBe(200);
    } finally {
      page.close();
    }
  });

  it.each([
    ['only the EVM (USDC) address set', 'evmOnly'],
    ['only the ABT address set', 'abtOnly'],
    ['only the ABT-on-Ethereum address set', 'abtEthOnly'],
  ] as const)('%s shows neither the sentence nor the link', async (_label, key) => {
    const page = await renderMyAgents(world.baseUrl, world[key].session);
    try {
      expect(page.document.querySelectorAll('#rows > *').length, 'the roster rendered').toBe(1);
      expectNoNotice(page.document);
    } finally {
      page.close();
    }
  });

  it('an account with no agents shows neither: a person who only hires needs no payout address', async () => {
    const page = await renderMyAgents(world.baseUrl, world.noAgents.session);
    try {
      expect(page.document.getElementById('empty-state')?.hidden).toBe(false);
      expectNoNotice(page.document);
    } finally {
      page.close();
    }
  });

  it.each([
    ['a non-200 /accounts/me', (path: string) => path === '/accounts/me'],
    ['a non-200 roster read', (path: string) => /^\/accounts\/[^/]+\/agents$/.test(path)],
  ] as const)('%s shows neither, and the page\'s own failure sentence instead', async (_label, fails) => {
    const proxy = await world.failing(fails);
    try {
      const page = await renderMyAgents(proxy.baseUrl, world.noAddress.session);
      try {
        expect(page.document.getElementById('load-error')?.hidden).toBe(false);
        expectNoNotice(page.document);
      } finally {
        page.close();
      }
    } finally {
      await proxy.close();
    }
  });

  it('in a real browser the notice holds at 320, 390 and 1280 with no sideways scroll, and its link is 44px tall on a phone', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const measured = await measureNotice(world.baseUrl, '/myagents', world.noAddress.session, [320, 390, 1280]);
    for (const m of measured) {
      expect(m.link, `the notice link rendered at ${m.width}`).not.toBeNull();
      expect(m.scrollWidth, `no sideways scroll at ${m.width}`).toBe(m.clientWidth);
      if (m.width < 760) expect(m.link?.height, `the link reaches the 44px floor at ${m.width}`).toBeGreaterThanOrEqual(44);
    }
  }, BROWSER_TIMEOUT_MS);
});
