// P8v: the operator's own side of one job (SITEMAP P-25, operatorjob.html),
// driven end to end against the real app (the discipline
// tests/web/staged.test.ts already holds to). Every route the wireframe
// wires up is exercised for real: POST /jobs/:jobId/redo-refuse,
// POST /jobs/:jobId/stage (both first submission and the redo-accept
// restage), each against a real signed-in operator SESSION (the P8v
// relation, never the agent's own signing key), never asserted from a
// client-side stub.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import {
  MemoryAgentRepository,
  MemoryAccountRepository,
  MemoryJobRepository,
  MemoryAttestationRepository,
} from '../../src/adapters/storage/memory.js';
import { createJob, REDO_LAPSE_EXTENSION_DAYS, type Job } from '../../src/domain/job.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession, mintSessionToken } from '../helpers/session-fixtures.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import { createStagingLifecycleGithubFake, PLATFORM_LOGIN } from '../helpers/github-staging-fixtures.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { Session } from '../../src/adapters/identity/session.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const AGENT_DID = 'did:abt:operatorjob-page-agent';
const OPERATOR_LOGIN = 'operatorjob-page-operator';
const STRANGER_LOGIN = 'operatorjob-page-stranger';

// Recent, not hardcoded: GET /jobs/:jobId runs the live lapse clocks on
// every read (applyLiveLapses, src/api/app.ts), and expireUnstaged
// flips a confirmed job to expired_unstaged EXPIRE_UNSTAGED_AFTER_DAYS
// after confirmedAt. A fixed 2026-08 fixture date would already be
// past that window by the time this suite runs; every timestamp below
// is computed from the real wall clock instead (staged.test.ts's own
// RECENT pattern).
const RECENT = new Date(Date.now() - 60 * 60 * 1000);

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
    { id: overrides.id, buyerDid: 'did:abt:operatorjob-page-buyer', agentDid: AGENT_DID, repository: 'buyer/operatorjob-repo', brief: 'Fix the checkout flow' },
    RECENT,
  );
  return { ...base, ...overrides };
}

interface Rendered {
  window: JSDOM['window'];
  document: Document;
  close: () => void;
}

async function renderPage(
  baseUrl: string,
  path: string,
  session: { token: string } | null,
  onFetch?: (input: string, init?: RequestInit) => void,
  // Round 3 fix (qa D1, gate-fails-open): lets a test fault ONE route the
  // page reads without touching the real app, so a degraded read can be
  // told apart from a healthy one. Returns a Response to short-circuit
  // that request, or null to let it pass through to the real server
  // (the default for every path a test does not name).
  faultRoute?: (input: string) => Response | null,
): Promise<Rendered> {
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
        value: (input: string, init?: RequestInit) => {
          if (onFetch) onFetch(input, init);
          if (faultRoute) {
            const faulted = faultRoute(input);
            if (faulted !== null) return Promise.resolve(faulted);
          }
          return fetch(new URL(input, baseUrl), init);
        },
      });
    },
  });

  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (failures.length > 0) throw new Error(`page script failed on ${path}: ${failures.join('; ')}`);
  return { window: dom.window, document: dom.window.document, close: () => dom.window.close() };
}

function renderOperatorJob(
  baseUrl: string,
  jobId: string,
  session: { token: string } | null,
  onFetch?: (input: string, init?: RequestInit) => void,
  faultRoute?: (input: string) => Response | null,
): Promise<Rendered> {
  return renderPage(baseUrl, `/operatorjob?job=${encodeURIComponent(jobId)}`, session, onFetch, faultRoute);
}

describe('the operator job screen, driven end to end against the real app (P8v)', () => {
  let agentRepo: MemoryAgentRepository;
  let jobRepo: MemoryJobRepository;
  let attestationRepo: MemoryAttestationRepository;
  let server: Server;
  let baseUrl: string;
  let operatorSession: Session;
  let operatorDid: string;

  beforeAll(async () => {
    const operatorAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: OPERATOR_LOGIN, id: 88101 }),
    });
    operatorDid = 'did:abt:operatorjob-page-operator-account';

    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: operatorDid, githubLogin: OPERATOR_LOGIN });
    await accountRepo.register({ did: 'did:abt:operatorjob-page-buyer', githubLogin: 'operatorjob-page-buyer-login' });

    agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid,
      delegation: delegationFixture(AGENT_DID, operatorDid),
      name: 'operatorjob-page-scout',
      skills: ['triage'],
      githubLogin: 'operatorjob-page-scout-login',
    });
    await agentRepo.updateGithubBinding(AGENT_DID, { handle: 'operatorjob-page-scout-login', status: 'verified' });

    jobRepo = new MemoryJobRepository();
    attestationRepo = new MemoryAttestationRepository();
    const { github } = createStagingLifecycleGithubFake();

    // Registers a staging repository the fake github recognises, matching
    // stagingRepo/baseCommit on the fixtures below (createStagingRepository
    // names the repo `staging-${jobId}` under PLATFORM_LOGIN, the exact
    // shape jobFixture's own stagingRepo overrides already assume).
    async function registerStagingRepo(jobId: string, baseCommit: string): Promise<void> {
      await github.createStagingRepository({ jobId, baseCommit, sourceOwner: 'buyer', sourceRepo: 'operatorjob-repo' });
    }

    const app = createApp(
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
      operatorAdapter,
      undefined,
      alwaysSettledGate(),
      anyCommitStagingObserver(),
      attestationRepo,
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    baseUrl = `http://127.0.0.1:${address.port}`;

    operatorSession = await mintSession(operatorAdapter);

    // Confirmed, ready to stage.
    await registerStagingRepo('job-confirmed', 'base-commit-confirmed');
    await jobRepo.create(jobFixture({
      id: 'job-confirmed',
      status: 'confirmed',
      criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
      priceUsd: '900.00',
      rail: 'abt',
      depositPercent: 25,
      priceAcceptedByBuyer: true,
      priceAcceptedByAgent: true,
      confirmedSpecHash: 'sha256:confirmed-spec',
      confirmedAt: RECENT,
      stagingRepo: { owner: PLATFORM_LOGIN, repo: 'staging-job-confirmed' },
      baseCommit: 'base-commit-confirmed',
    }));

    // Staged, then redo-requested, citing criterion 0.
    await registerStagingRepo('job-redo-requested', 'base-commit-redo');
    const stagedBase = jobFixture({
      id: 'job-redo-requested',
      status: 'staged',
      criteria: [
        { text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
        { text: 'Checkout e2e test passes', proposedBy: 'buyer', acceptedByBuyer: true, acceptedByAgent: true },
      ],
      priceUsd: '1200.00',
      rail: 'abt',
      depositPercent: 25,
      redoAllowance: 1,
      priceAcceptedByBuyer: true,
      priceAcceptedByAgent: true,
      confirmedSpecHash: 'sha256:redo-spec',
      confirmedAt: RECENT,
      stagingRepo: { owner: PLATFORM_LOGIN, repo: 'staging-job-redo-requested' },
      baseCommit: 'base-commit-redo',
      stagedAt: RECENT,
      stagedCommit: 'commit-sha-original',
    });
    await jobRepo.create({
      ...stagedBase,
      status: 'redo_requested',
      redoUsedCount: 1,
      redoRequestedCriterionIndex: 0,
      redoRequestedAt: RECENT,
      stagedLapseExtensionDays: REDO_LAPSE_EXTENSION_DAYS,
    });

    // A second, freshly-staged job for the accept-then-restage flow (its
    // own row so the redo-requested fixture above stays untouched by a
    // mutating test).
    await registerStagingRepo('job-redo-accept-flow', 'base-commit-accept');
    await jobRepo.create({
      ...jobFixture({
        id: 'job-redo-accept-flow',
        status: 'staged',
        criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
        priceUsd: '700.00',
        rail: 'abt',
        depositPercent: 25,
        redoAllowance: 1,
        priceAcceptedByBuyer: true,
        priceAcceptedByAgent: true,
        confirmedSpecHash: 'sha256:accept-spec',
        confirmedAt: RECENT,
        stagingRepo: { owner: PLATFORM_LOGIN, repo: 'staging-job-redo-accept-flow' },
        baseCommit: 'base-commit-accept',
      }),
      status: 'redo_requested',
      stagedAt: RECENT,
      stagedCommit: 'commit-sha-accept-original',
      redoUsedCount: 1,
      redoRequestedCriterionIndex: 0,
      redoRequestedAt: RECENT,
    });

    // Another, for the refuse flow.
    await registerStagingRepo('job-redo-refuse-flow', 'base-commit-refuse');
    await jobRepo.create({
      ...jobFixture({
        id: 'job-redo-refuse-flow',
        status: 'staged',
        criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
        priceUsd: '500.00',
        rail: 'abt',
        depositPercent: 25,
        redoAllowance: 1,
        priceAcceptedByBuyer: true,
        priceAcceptedByAgent: true,
        confirmedSpecHash: 'sha256:refuse-spec',
        confirmedAt: RECENT,
        stagingRepo: { owner: PLATFORM_LOGIN, repo: 'staging-job-redo-refuse-flow' },
        baseCommit: 'base-commit-refuse',
      }),
      status: 'redo_requested',
      stagedAt: RECENT,
      stagedCommit: 'commit-sha-refuse-original',
      redoUsedCount: 1,
      redoRequestedCriterionIndex: 0,
      redoRequestedAt: RECENT,
    });

    // Draft, for the drafting-section link.
    await jobRepo.create(jobFixture({ id: 'job-draft', status: 'draft', criteria: [] }));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('a signed-out visitor, an unknown job id', () => {
    it('each renders its own readable panel, never a blank screen', async () => {
      const signedOut = await renderOperatorJob(baseUrl, 'job-confirmed', null);
      const unknownJob = await renderOperatorJob(baseUrl, 'no-such-job', operatorSession);
      try {
        expect(signedOut.document.getElementById('signin-required')?.hidden).toBe(false);
        expect(signedOut.document.getElementById('operatorjob-body')?.hidden).toBe(true);

        expect(unknownJob.document.getElementById('load-error')?.hidden).toBe(false);
        expect(unknownJob.document.getElementById('operatorjob-body')?.hidden).toBe(true);
      } finally {
        signedOut.close();
        unknownJob.close();
      }
    });
  });

  describe('a stranger to this job (neither its buyer, its agent, nor its operator)', () => {
    it('is refused with the party-error panel, not a blank screen', async () => {
      const strangerAdapter = createSessionAdapter({
        github: fakeGitHubConfig(),
        fetchImpl: fakeGitHubFetch({ login: STRANGER_LOGIN, id: 88102 }),
      });
      const strangerAccountRepo = new MemoryAccountRepository();
      await strangerAccountRepo.register({ did: 'did:abt:operatorjob-page-stranger-account', githubLogin: STRANGER_LOGIN });
      const strangerServer = createApp(
        strangerAccountRepo,
        agentRepo,
        undefined,
        undefined,
        jobRepo,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        strangerAdapter,
        undefined,
        alwaysSettledGate(),
        anyCommitStagingObserver(),
        attestationRepo,
      ).listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => strangerServer.once('listening', resolve));
      const strangerBaseUrl = `http://127.0.0.1:${(strangerServer.address() as AddressInfo).port}`;
      try {
        const token = await mintSessionToken(strangerAdapter);
        const page = await renderOperatorJob(strangerBaseUrl, 'job-confirmed', { token });
        try {
          expect(page.document.getElementById('party-error')?.hidden).toBe(false);
          expect(page.document.getElementById('operatorjob-body')?.hidden).toBe(true);
        } finally {
          page.close();
        }
      } finally {
        await new Promise<void>((resolve) => strangerServer.close(() => resolve()));
      }
    });
  });

  describe("a buyer session (not this job's agent or operator)", () => {
    it('is refused with the party-error panel, never the agent/operator controls (round 2 fix, D1)', async () => {
      // The 2026-09-01 "one account, many roles" case: a session that
      // resolves to THIS job's buyer, reached through the ordinary
      // /operatorjob?job=<id> link dashboard.js and incoming.js now emit.
      // A fresh server shares the same jobRepo/agentRepo/attestationRepo
      // (the stranger-session pattern above) but its own account repo,
      // registering only the buyer's account so the session resolves to
      // job-redo-requested's own buyerDid.
      const buyerAdapter = createSessionAdapter({
        github: fakeGitHubConfig(),
        fetchImpl: fakeGitHubFetch({ login: 'operatorjob-page-buyer-login', id: 88104 }),
      });
      const buyerAccountRepo = new MemoryAccountRepository();
      await buyerAccountRepo.register({ did: 'did:abt:operatorjob-page-buyer', githubLogin: 'operatorjob-page-buyer-login' });
      const buyerServer = createApp(
        buyerAccountRepo,
        agentRepo,
        undefined,
        undefined,
        jobRepo,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        buyerAdapter,
        undefined,
        alwaysSettledGate(),
        anyCommitStagingObserver(),
        attestationRepo,
      ).listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => buyerServer.once('listening', resolve));
      const buyerBaseUrl = `http://127.0.0.1:${(buyerServer.address() as AddressInfo).port}`;
      try {
        const buyerSession = await mintSession(buyerAdapter);
        const page = await renderOperatorJob(buyerBaseUrl, 'job-redo-requested', buyerSession);
        try {
          expect(page.document.getElementById('party-error')?.hidden).toBe(false);
          expect(page.document.getElementById('operatorjob-body')?.hidden).toBe(true);
        } finally {
          page.close();
        }
      } finally {
        await new Promise<void>((resolve) => buyerServer.close(() => resolve()));
      }
    });
  });

  describe("a buyer session whose own account read is degraded (qa round 3, D1: gate-fails-open)", () => {
    it('lands on the party-error panel, never the agent/operator controls, when GET /accounts/:did cannot confirm the seat', async () => {
      // Same fixture as the healthy-read buyer test above (a session that
      // resolves to job-redo-requested's own buyerDid, whose agent
      // belongs to a DIFFERENT operator), but this render answers every
      // GET /accounts/:did with a 503 instead of letting it reach the
      // real app. GET /accounts/:did (app.ts:1403-1415) genuinely answers
      // 503 on any storage failure and 404 when the DID names no
      // registered Account, so an unresolved read is not exotic; the
      // page must treat "could not confirm" as its own outcome rather
      // than folding it into "not the buyer".
      const buyerAdapter = createSessionAdapter({
        github: fakeGitHubConfig(),
        fetchImpl: fakeGitHubFetch({ login: 'operatorjob-page-buyer-login', id: 88105 }),
      });
      const buyerAccountRepo = new MemoryAccountRepository();
      await buyerAccountRepo.register({ did: 'did:abt:operatorjob-page-buyer', githubLogin: 'operatorjob-page-buyer-login' });
      const buyerServer = createApp(
        buyerAccountRepo,
        agentRepo,
        undefined,
        undefined,
        jobRepo,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        buyerAdapter,
        undefined,
        alwaysSettledGate(),
        anyCommitStagingObserver(),
        attestationRepo,
      ).listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => buyerServer.once('listening', resolve));
      const buyerBaseUrl = `http://127.0.0.1:${(buyerServer.address() as AddressInfo).port}`;
      try {
        const buyerSession = await mintSession(buyerAdapter);
        const page = await renderOperatorJob(buyerBaseUrl, 'job-redo-requested', buyerSession, undefined, (input) => {
          if (input.includes('/accounts/')) return new Response(JSON.stringify({ error: 'storage unavailable' }), { status: 503 });
          return null;
        });
        try {
          expect(page.document.getElementById('party-error')?.hidden).toBe(false);
          expect(page.document.getElementById('operatorjob-body')?.hidden).toBe(true);
        } finally {
          page.close();
        }
      } finally {
        await new Promise<void>((resolve) => buyerServer.close(() => resolve()));
      }
    });
  });

  describe('a confirmed job: the stage panel, live', () => {
    it('renders the stage panel and submitting a commit moves the job to staged, restaged through the real route', async () => {
      const page = await renderOperatorJob(baseUrl, 'job-confirmed', operatorSession);
      try {
        expect(page.document.getElementById('stage-panel')?.hidden).toBe(false);
        const input = page.document.getElementById('stage-commit-input') as HTMLInputElement;
        input.value = 'commit-confirmed-first';
        const btn = page.document.getElementById('stage-submit-btn') as HTMLButtonElement;
        btn.click();
        await new Promise((resolve) => setTimeout(resolve, 300));

        const after = await fetch(`${baseUrl}/jobs/job-confirmed`, { headers: { Accept: 'application/json' } });
        const afterBody = (await after.json()) as { status: string; stagedCommit: string };
        expect(afterBody.status).toBe('staged');
        expect(afterBody.stagedCommit).toBe('commit-confirmed-first');
      } finally {
        page.close();
      }
    });
  });

  describe('a redo_requested job: the redo panel names the cited criterion', () => {
    it('renders the cited criterion text, never a fixture line number', async () => {
      const page = await renderOperatorJob(baseUrl, 'job-redo-requested', operatorSession);
      try {
        expect(page.document.getElementById('redo-panel')?.hidden).toBe(false);
        const text = page.document.getElementById('redo-facts')?.textContent ?? '';
        expect(text).toContain('The login bug is fixed');
      } finally {
        page.close();
      }
    });
  });

  describe('the redo dialogs show the consequence from the job\'s own real numbers (round 2 fix, D2)', () => {
    it('the accept dialog states the real extension days, the unchanged price and the redos left', async () => {
      const page = await renderOperatorJob(baseUrl, 'job-redo-requested', operatorSession);
      try {
        (page.document.getElementById('redo-accept-btn') as HTMLButtonElement).click();
        const text = page.document.getElementById('accept-consequences')?.textContent ?? '';
        expect(text).toContain(String(REDO_LAPSE_EXTENSION_DAYS));
        expect(text).toContain('$1200.00');
        expect(text.toLowerCase()).toContain('none');
      } finally {
        page.close();
      }
    });

    it('the refuse dialog states what the operator receives or keeps, from the job\'s own price line', async () => {
      const page = await renderOperatorJob(baseUrl, 'job-redo-requested', operatorSession);
      try {
        (page.document.getElementById('redo-refuse-btn') as HTMLButtonElement).click();
        const text = page.document.getElementById('refuse-consequences')?.textContent ?? '';
        expect(text).toContain('$1200.00');
        expect(text).toContain('$300.00');
      } finally {
        page.close();
      }
    });
  });

  describe('accepting the redo: the operator session posts to /jobs/:jobId/stage, live', () => {
    it('restages through the real route and the job returns to staged with the new commit', async () => {
      const page = await renderOperatorJob(baseUrl, 'job-redo-accept-flow', operatorSession);
      try {
        (page.document.getElementById('redo-accept-btn') as HTMLButtonElement).click();
        const input = page.document.getElementById('accept-commit-input') as HTMLInputElement;
        input.value = 'commit-sha-restaged';
        input.dispatchEvent(new page.window.Event('input', { bubbles: true }));
        const confirmBtn = page.document.getElementById('accept-confirm-btn') as HTMLButtonElement;
        expect(confirmBtn.disabled).toBe(false);
        confirmBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 300));

        const after = await fetch(`${baseUrl}/jobs/job-redo-accept-flow`, { headers: { Accept: 'application/json' } });
        const afterBody = (await after.json()) as { status: string; stagedCommit: string };
        expect(afterBody.status).toBe('staged');
        expect(afterBody.stagedCommit).toBe('commit-sha-restaged');
      } finally {
        page.close();
      }
    });
  });

  describe('refusing the redo: the operator session posts to /jobs/:jobId/redo-refuse, live', () => {
    it('returns the job to staged with the refusal recorded', async () => {
      const page = await renderOperatorJob(baseUrl, 'job-redo-refuse-flow', operatorSession);
      try {
        (page.document.getElementById('redo-refuse-btn') as HTMLButtonElement).click();
        const confirmBtn = page.document.getElementById('refuse-confirm-btn') as HTMLButtonElement;
        confirmBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 300));

        const after = await fetch(`${baseUrl}/jobs/job-redo-refuse-flow`, { headers: { Accept: 'application/json' } });
        const afterBody = (await after.json()) as { status: string; redo: { refusedAt: string | null } };
        expect(afterBody.status).toBe('staged');
        expect(afterBody.redo.refusedAt).not.toBeNull();
      } finally {
        page.close();
      }
    });
  });

  describe('a draft job: the drafting section links to the agreement screen', () => {
    it('renders a link to /agreement?job=<id>, not a duplicate of the agreement screen', async () => {
      const page = await renderOperatorJob(baseUrl, 'job-draft', operatorSession);
      try {
        expect(page.document.getElementById('drafting-section')?.hidden).toBe(false);
        const link = page.document.getElementById('agreement-link') as HTMLAnchorElement | null;
        expect(link?.getAttribute('href')).toBe('/agreement?job=job-draft');
      } finally {
        page.close();
      }
    });
  });

  describe('the money facts, computed from the job\'s own agreed price', () => {
    it('renders agreed price, deposit and balance matching the stored price line', async () => {
      const page = await renderOperatorJob(baseUrl, 'job-confirmed', operatorSession);
      try {
        const rows = page.document.querySelectorAll('#money-facts > li');
        expect(rows.length).toBeGreaterThanOrEqual(3);
        const text = page.document.getElementById('money-facts')?.textContent ?? '';
        expect(text).toContain('$900.00');
        expect(text).toContain('$225.00'); // 25% deposit
        expect(text).toContain('$675.00'); // remainder
      } finally {
        page.close();
      }
    });
  });

  describe('the session token never rides in the document', () => {
    it('the token does not appear anywhere in the rendered document', async () => {
      const page = await renderOperatorJob(baseUrl, 'job-confirmed', operatorSession);
      try {
        expect(page.document.documentElement.outerHTML).not.toContain(operatorSession.token);
      } finally {
        page.close();
      }
    });
  });

  describe('every anchor this page renders reaches a path the app actually mounts', () => {
    it('fetches each unique href against the real app and gets 200', async () => {
      const page = await renderOperatorJob(baseUrl, 'job-draft', operatorSession);
      try {
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
  });

  describe('layout: 320px, no horizontal overflow', () => {
    it('at 320px there is no horizontal overflow on the redo panel state', async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
        return;
      }
      const browser = await RealBrowser.launch({ width: 320, height: 900 });
      try {
        await browser.goto(`${baseUrl}/operatorjob?job=job-redo-requested`);
        await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(operatorSession))})`);
        await browser.goto(`${baseUrl}/operatorjob?job=job-redo-requested`);

        const overflow = await browser.evaluate<{ scrollWidth: number; clientWidth: number }>(`
          ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })
        `);
        expect(overflow.scrollWidth, 'the 320px page must not scroll sideways').toBe(overflow.clientWidth);

        const acceptBtn = await browser.evaluate<{ height: number } | null>(`
          (function () {
            var btn = document.getElementById('redo-accept-btn');
            if (!btn) return null;
            var r = btn.getBoundingClientRect();
            return { height: r.height };
          })()
        `);
        expect(acceptBtn?.height, 'the accept-redo control must reach the 44px tap floor at 320px').toBeGreaterThanOrEqual(44);
      } finally {
        await browser.close();
      }
    });

    it('at 320px the accept-redo dialog, opened, has no horizontal overflow (the wireframe\'s own open state)', async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
        return;
      }
      const browser = await RealBrowser.launch({ width: 320, height: 900 });
      try {
        await browser.goto(`${baseUrl}/operatorjob?job=job-redo-requested`);
        await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(operatorSession))})`);
        await browser.goto(`${baseUrl}/operatorjob?job=job-redo-requested`);
        await browser.evaluate(`document.getElementById('redo-accept-btn').click()`);

        const overflow = await browser.evaluate<{ scrollWidth: number; clientWidth: number }>(`
          ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })
        `);
        expect(overflow.scrollWidth, 'the 320px page must not scroll sideways with the accept dialog open').toBe(overflow.clientWidth);

        const consequenceRows = await browser.evaluate<number>(`document.querySelectorAll('#accept-consequences > li').length`);
        expect(consequenceRows, 'the accept dialog must render its consequence rows').toBeGreaterThan(0);
      } finally {
        await browser.close();
      }
    });

    it('at 320px the confirmed-state stage panel also has no horizontal overflow', async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
        return;
      }
      const browser = await RealBrowser.launch({ width: 320, height: 900 });
      try {
        // A separate, unmutated job: job-confirmed is used by an earlier
        // mutating test in this file, so this reads job-draft instead,
        // whose state (drafting section, technical disclosure, history,
        // money facts with no price yet) still exercises the shared
        // layout the redo test above does not touch.
        await browser.goto(`${baseUrl}/operatorjob?job=job-draft`);
        await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(operatorSession))})`);
        await browser.goto(`${baseUrl}/operatorjob?job=job-draft`);

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
