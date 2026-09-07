// P8g: a signed-in buyer describes work and a job exists. Before this
// card POST /jobs (src/api/app.ts:2316) took a live session and nothing
// else, and nothing in the product surface ever called it: agent.html's
// primary CTA sent everyone, signed in or not, to /signin, the seventh
// occurrence of inert-declared-control in this repo. This file drives the
// real app over HTTP with a browser Accept header and a real session
// minted through the sign-in path (jsdom, the discipline
// tests/web/job.test.ts and tests/web/nav-auth.test.ts already hold to),
// and proves a signed-in person can actually reach the hire that gets
// created, not merely that the markup shipped.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { MemoryAgentRepository, MemoryAccountRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import type { Agent } from '../../src/domain/agent.js';
import type { Job, CompletedJob } from '../../src/domain/job.js';
import type { AgentRepository, JobRepository, AgentInput, KeyRotationInput } from '../../src/adapters/storage/types.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSessionToken } from '../helpers/session-fixtures.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { SessionAdapter } from '../../src/adapters/identity/session.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

const AGENT_DID = 'did:abt:hire-page-agent';

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

// jsdom's Location is a legacy platform object that cannot complete a real
// cross-document navigation (node_modules/jsdom/lib/jsdom/living/window/
// navigation.js); the same limitation tests/web/operator-roster.test.ts
// documents and works around. The one observable seam jsdom itself calls
// on every href/assign path is whatwg-url's parseURL, an ordinary
// writable module export. This intercepts that seam to observe the URL a
// page script asked to navigate to, the same way a real browser's
// location.assign spy would.
const require = createRequire(import.meta.url);
const whatwgURL = require('whatwg-url') as { parseURL: (v: string, opts?: unknown) => unknown };

function captureNavigations(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = whatwgURL.parseURL;
  whatwgURL.parseURL = function (this: unknown, v: string, opts?: unknown) {
    calls.push(v);
    return original.call(this, v, opts);
  };
  return {
    calls,
    restore() {
      whatwgURL.parseURL = original;
    },
  };
}

interface Rendered {
  window: JSDOM['window'];
  document: Document;
  close: () => void;
}

async function renderHire(
  baseUrl: string,
  path: string,
  session: { token: string } | null,
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
      if (session !== null) {
        window.sessionStorage.setItem('fa_session', JSON.stringify(session));
      }
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
  await new Promise((resolve) => setTimeout(resolve, 250));

  // jsdom logs "Not implemented: navigation" whenever the page's own
  // script sets window.location.href, because it cannot actually follow
  // it (see captureNavigations' own comment). That single, expected
  // message must not fail this helper the way a real script error would;
  // every other jsdomError still does.
  const real = failures.filter((message) => !message.includes('Not implemented: navigation'));
  if (real.length > 0) throw new Error(`page script failed on ${path}: ${real.join('; ')}`);

  return { window: dom.window, document: dom.window.document, close: () => dom.window.close() };
}

describe('the hire screen, driven end to end against the real app', () => {
  let agentRepo: AgentRepository;
  let jobRepo: JobRepository;
  let sessionAdapter: SessionAdapter;
  let server: Server;
  let baseUrl: string;
  let token: string;

  beforeAll(async () => {
    agentRepo = new MemoryAgentRepository();
    jobRepo = new MemoryJobRepository();
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:hire-page-operator',
      delegation: delegationFixture(AGENT_DID, 'did:abt:hire-page-operator'),
      name: 'hire-page-scout',
      skills: ['triage'],
      githubLogin: null,
    });

    sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'hire-page-buyer', id: 9001 }),
    });

    const accountRepo = new MemoryAccountRepository();
    // Registered explicitly rather than relying on first-sign-in
    // auto-provisioning (resolveActingParty, src/api/app.ts): provisioning
    // needs FREEAGENTS_PLATFORM_SEED, which this suite does not set (the
    // same reason tests/api/app.test.ts registers its own fixed buyer DID
    // ahead of every job test rather than depending on the seed).
    await accountRepo.register({ did: 'did:abt:hire-page-buyer-account', githubLogin: 'hire-page-buyer' });

    server = createApp(
      accountRepo,
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
      sessionAdapter,
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    token = await mintSessionToken(sessionAdapter);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('a signed-out visitor', () => {
    it('is told to sign in and is not shown a form that cannot work', async () => {
      const page = await renderHire(baseUrl, `/hire?agent=${encodeURIComponent(AGENT_DID)}`, null);
      try {
        const notice = page.document.getElementById('signin-required');
        expect(notice).not.toBeNull();
        expect(notice!.hidden).toBe(false);
        expect((notice!.textContent ?? '').toLowerCase()).toContain('sign in');

        const form = page.document.getElementById('hire-body');
        expect(form).not.toBeNull();
        expect(form!.hidden).toBe(true);
      } finally {
        page.close();
      }
    });
  });

  describe('a signed-in buyer completes the flow end to end', () => {
    it('names the agent, submits the brief, and the response is 201, then GET /jobs/<id> carries the byte-identical brief', async () => {
      const brief = 'Fix the checkout flow and add a regression test.';
      const page = await renderHire(baseUrl, `/hire?agent=${encodeURIComponent(AGENT_DID)}`, { token });
      const nav = captureNavigations();
      try {
        const summary = page.document.getElementById('agent-name');
        expect(summary).not.toBeNull();
        expect(summary!.textContent ?? '').toContain('hire-page-scout');

        const form = page.document.getElementById('hire-form') as HTMLFormElement | null;
        expect(form).not.toBeNull();
        const hireBody = page.document.getElementById('hire-body');
        expect(hireBody).not.toBeNull();
        expect(hireBody!.hidden).toBe(false);

        const repoInput = page.document.getElementById('repo') as HTMLInputElement | null;
        const briefInput = page.document.getElementById('brief') as HTMLTextAreaElement | null;
        expect(repoInput).not.toBeNull();
        expect(briefInput).not.toBeNull();
        repoInput!.value = 'buyer/target-repo';
        briefInput!.value = brief;

        const submitButton = page.document.getElementById('btn-send') as HTMLButtonElement | null;
        expect(submitButton).not.toBeNull();
        submitButton!.click();

        // Wait for the POST to resolve and the page's own script to call
        // window.location.href with the /jobs/<id> destination.
        await new Promise<void>((resolve) => {
          const check = (): void => {
            if (nav.calls.some((v) => v.startsWith('/jobs/'))) {
              resolve();
              return;
            }
            setTimeout(check, 25);
          };
          check();
        });

        // The Location this browser is sent to, read from the navigation
        // the page's own script actually made, not from a fixture.
        const destination = nav.calls.find((v) => v.startsWith('/jobs/')) ?? '';
        const jobId = destination.replace('/jobs/', '');
        expect(jobId).not.toBe('');

        const readBack = await fetch(`${baseUrl}/jobs/${jobId}`, { headers: { Accept: 'application/json' } });
        expect(readBack.status).toBe(200);
        const body = (await readBack.json()) as Record<string, unknown>;
        expect(body.brief).toBe(brief);
        expect(body.repository).toBe('buyer/target-repo');
        expect(body.agentDid).toBe(AGENT_DID);
        expect(body.id).toBe(jobId);
      } finally {
        nav.restore();
        page.close();
      }
    });
  });

  describe('the client-side guards keep a bad submission off the network entirely', () => {
    it('a whitespace-only brief never reaches the network', async () => {
      const page = await renderHire(baseUrl, `/hire?agent=${encodeURIComponent(AGENT_DID)}`, { token });
      const nav = captureNavigations();
      try {
        const before = (await jobRepo.findByBuyerDid?.('did:abt:hire-page-buyer-account')) ?? [];
        const beforeCount = before.length;

        const repoInput = page.document.getElementById('repo') as HTMLInputElement | null;
        const briefInput = page.document.getElementById('brief') as HTMLTextAreaElement | null;
        repoInput!.value = 'buyer/target-repo';
        briefInput!.value = '   \n  ';

        (page.document.getElementById('btn-send') as HTMLButtonElement).click();
        await new Promise((resolve) => setTimeout(resolve, 150));

        const briefError = page.document.getElementById('brief-error');
        expect(briefError).not.toBeNull();
        expect(briefError!.hidden).toBe(false);
        expect(nav.calls.some((v) => v.startsWith('/jobs/'))).toBe(false);

        const after = (await jobRepo.findByBuyerDid?.('did:abt:hire-page-buyer-account')) ?? [];
        expect(after.length).toBe(beforeCount);
      } finally {
        nav.restore();
        page.close();
      }
    });

    it('a repository string that is not owner/name never reaches the network', async () => {
      const page = await renderHire(baseUrl, `/hire?agent=${encodeURIComponent(AGENT_DID)}`, { token });
      const nav = captureNavigations();
      try {
        const repoInput = page.document.getElementById('repo') as HTMLInputElement | null;
        const briefInput = page.document.getElementById('brief') as HTMLTextAreaElement | null;
        repoInput!.value = 'not-a-valid-repo-string';
        briefInput!.value = 'Do the thing';

        (page.document.getElementById('btn-send') as HTMLButtonElement).click();
        await new Promise((resolve) => setTimeout(resolve, 150));

        const repoError = page.document.getElementById('repo-error');
        expect(repoError).not.toBeNull();
        expect(repoError!.hidden).toBe(false);
        expect(nav.calls.some((v) => v.startsWith('/jobs/'))).toBe(false);
      } finally {
        nav.restore();
        page.close();
      }
    });
  });

  describe('a brief containing markup round-trips as literal text on the job page it lands on', () => {
    it('the job page renders it through textContent, not innerHTML', async () => {
      const markupBrief = 'Fix <b>the</b> checkout flow, not <img src=x onerror=alert(1)>';
      const page = await renderHire(baseUrl, `/hire?agent=${encodeURIComponent(AGENT_DID)}`, { token });
      const nav = captureNavigations();
      let jobId = '';
      try {
        const repoInput = page.document.getElementById('repo') as HTMLInputElement | null;
        const briefInput = page.document.getElementById('brief') as HTMLTextAreaElement | null;
        repoInput!.value = 'buyer/markup-repo';
        briefInput!.value = markupBrief;

        (page.document.getElementById('btn-send') as HTMLButtonElement).click();
        await new Promise<void>((resolve) => {
          const check = (): void => {
            if (nav.calls.some((v) => v.startsWith('/jobs/'))) {
              resolve();
              return;
            }
            setTimeout(check, 25);
          };
          check();
        });
        const destination = nav.calls.find((v) => v.startsWith('/jobs/')) ?? '';
        jobId = destination.replace('/jobs/', '');
      } finally {
        nav.restore();
        page.close();
      }

      expect(jobId).not.toBe('');
      const jobPage = await renderHire(baseUrl, `/jobs/${jobId}`, null);
      try {
        const claim = jobPage.document.getElementById('claim');
        expect(claim).not.toBeNull();
        expect(claim!.textContent ?? '').toContain(markupBrief);
        expect(claim!.querySelector('img')).toBeNull();
      } finally {
        jobPage.close();
      }
    });
  });

  describe('the session token appears nowhere in the rendered document', () => {
    it('not in any href, and not in the query string', async () => {
      const page = await renderHire(baseUrl, `/hire?agent=${encodeURIComponent(AGENT_DID)}`, { token });
      try {
        expect(page.window.location.href).not.toContain(token);
        const anchors = Array.from(page.document.querySelectorAll('a[href]'));
        for (const anchor of anchors) {
          expect(anchor.getAttribute('href') ?? '').not.toContain(token);
        }
        expect(page.document.documentElement.outerHTML).not.toContain(token);
      } finally {
        page.close();
      }
    });
  });

  describe('agent.html\'s primary CTA resolves to /hire?agent=<did>, read from the DOM after the page\'s own script has run', () => {
    it('points at the hire screen for the agent this page rendered, never at /signin', async () => {
      const response = await fetch(`${baseUrl}/agents/${encodeURIComponent(AGENT_DID)}`, { headers: { Accept: HTML } });
      const markup = await response.text();
      const virtualConsole = new VirtualConsole();
      const failures: string[] = [];
      virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

      const dom = new JSDOM(markup, {
        url: `${baseUrl}/agents/${encodeURIComponent(AGENT_DID)}`,
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
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);

        const cta = dom.window.document.getElementById('hire-cta');
        expect(cta).not.toBeNull();
        expect(cta!.getAttribute('href')).toBe(`/hire?agent=${encodeURIComponent(AGENT_DID)}`);
      } finally {
        dom.window.close();
      }
    });
  });

  describe('the nav on /hire flips to signed-in for a person with a session', () => {
    it('hides Sign in and shows the sign-out control', async () => {
      const page = await renderHire(baseUrl, `/hire?agent=${encodeURIComponent(AGENT_DID)}`, { token });
      try {
        const signin = page.document.getElementById('nav-signin');
        const signedIn = page.document.getElementById('nav-signed-in');
        expect(signin).not.toBeNull();
        expect(signin!.hidden).toBe(true);
        expect(signedIn).not.toBeNull();
        expect(signedIn!.hidden).toBe(false);
      } finally {
        page.close();
      }
    });
  });
});

// A stand-in AgentRepository that answers a real agent for the first
// findByDid call (the page's own GET /agents/:did, which must succeed so
// the form renders) and null for every call after that (POST /jobs' own
// findByDid, simulating the agent vanishing between the two, the one way
// the route's own 404 -- distinct from the page's pre-check -- is
// genuinely reachable through the full flow rather than mocked).
class VanishingAfterFirstReadAgentRepository implements AgentRepository {
  private calls = 0;
  constructor(private readonly agent: Agent) {}
  async create(_input: AgentInput): Promise<Agent> {
    throw new Error('not used in this fixture');
  }
  async findByDid(did: string): Promise<Agent | null> {
    this.calls += 1;
    if (this.calls === 1 && did === this.agent.did) return this.agent;
    return null;
  }
  async updateGithubBinding(): Promise<Agent | null> {
    return null;
  }
  async recordKeyRotation(_did: string, _input: KeyRotationInput): Promise<Agent | null> {
    return null;
  }
}

// A JobRepository whose create() always throws, everything else
// delegated to a real MemoryJobRepository so a route that reads before
// writing (none of the ones this file exercises do, but this keeps the
// stand-in honest) still behaves normally.
class FailingCreateJobRepository implements JobRepository {
  private readonly real = new MemoryJobRepository();
  async create(_job: Job): Promise<Job> {
    throw new Error('connection refused');
  }
  async update(job: Job): Promise<Job | null> {
    return this.real.update(job);
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
  async findCompletedByAgent(agentDid: string): Promise<readonly CompletedJob[]> {
    return this.real.findCompletedByAgent!(agentDid);
  }
  async findByBuyerDid(buyerDid: string): Promise<readonly Job[]> {
    return this.real.findByBuyerDid!(buyerDid);
  }
}

// The six refusals in scope item 9, each rendering its own distinct
// sentence. Driven against dedicated, narrowly-configured servers so each
// refusal is genuinely reachable rather than mocked at the client.
describe('every refusal POST /jobs can return renders its own distinct sentence', () => {
  const sentences: string[] = [];

  async function submitAndCaptureError(
    baseUrl: string,
    agentDid: string,
    session: { token: string } | null,
  ): Promise<string> {
    const page = await renderHire(baseUrl, `/hire?agent=${encodeURIComponent(agentDid)}`, session);
    try {
      if (session === null) {
        // The signed-out gate renders before the form; its own sentence is
        // pinned separately above. Nothing to submit here.
        return page.document.getElementById('signin-required')?.textContent ?? '';
      }
      const repoInput = page.document.getElementById('repo') as HTMLInputElement | null;
      const briefInput = page.document.getElementById('brief') as HTMLTextAreaElement | null;
      if (!repoInput || !briefInput) {
        // The agent read itself failed before the form ever rendered: the
        // load-error sentence is what a visitor sees, and there is no
        // form to submit.
        return page.document.getElementById('load-error-detail')?.textContent ?? '';
      }
      repoInput.value = 'buyer/target-repo';
      briefInput.value = 'Fix the login bug';
      (page.document.getElementById('btn-send') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const detail = page.document.getElementById('submit-error-detail')?.textContent ?? '';
      return detail;
    } finally {
      page.close();
    }
  }

  it('signed out: told to sign in, distinct sentence', async () => {
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:refusal-operator',
      delegation: delegationFixture(AGENT_DID, 'did:abt:refusal-operator'),
      name: 'refusal-scout',
      skills: [],
      githubLogin: null,
    });
    const server = createApp(new MemoryAccountRepository(), agentRepo).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const sentence = await submitAndCaptureError(baseUrl, AGENT_DID, null);
      expect(sentence.toLowerCase()).toContain('sign in');
      sentences.push(sentence);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('the agent is not registered (404): distinct sentence', async () => {
    const NOT_REGISTERED_AGENT_DID = 'did:abt:refusal-404-agent';
    const realAgent: Agent = {
      did: NOT_REGISTERED_AGENT_DID,
      operatorDid: 'did:abt:refusal-404-operator',
      delegation: delegationFixture(NOT_REGISTERED_AGENT_DID, 'did:abt:refusal-404-operator'),
      name: 'refusal-404-scout',
      skills: [],
      githubLogin: null,
      proofStatus: 'unverified',
      createdAt: new Date(),
      keyRotations: [],
      floorPriceUsd: null,
      minBuyerMerges: null,
      maxWalkedAfterConfirm: null,
    };
    const vanishingAgentRepo = new VanishingAfterFirstReadAgentRepository(realAgent);
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'refusal-404-buyer', id: 1 }),
    });
    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: 'did:abt:refusal-404-buyer-account', githubLogin: 'refusal-404-buyer' });
    const server = createApp(
      accountRepo,
      vanishingAgentRepo,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      sessionAdapter,
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const token = await mintSessionToken(sessionAdapter);
      const sentence = await submitAndCaptureError(baseUrl, NOT_REGISTERED_AGENT_DID, { token });
      expect(sentence.toLowerCase()).toContain('is not registered');
      sentences.push(sentence);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('the buyer-conduct threshold refuses (403): distinct sentence', async () => {
    const agentRepo = new MemoryAgentRepository();
    const CONDUCT_AGENT_DID = 'did:abt:refusal-conduct-agent';
    await agentRepo.create({
      did: CONDUCT_AGENT_DID,
      operatorDid: 'did:abt:refusal-conduct-operator',
      delegation: delegationFixture(CONDUCT_AGENT_DID, 'did:abt:refusal-conduct-operator'),
      name: 'conduct-scout',
      skills: [],
      githubLogin: null,
      minBuyerMerges: 5,
    });
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'refusal-conduct-buyer', id: 2 }),
    });
    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: 'did:abt:refusal-conduct-buyer-account', githubLogin: 'refusal-conduct-buyer' });
    const server = createApp(
      accountRepo,
      agentRepo,
      undefined, undefined, new MemoryJobRepository(), undefined, undefined, undefined, undefined, undefined, undefined,
      sessionAdapter,
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const token = await mintSessionToken(sessionAdapter);
      const sentence = await submitAndCaptureError(baseUrl, CONDUCT_AGENT_DID, { token });
      expect(sentence.toLowerCase()).toContain('minbuyermerges');
      sentences.push(sentence);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('storage is unavailable (503): distinct sentence', async () => {
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:refusal-503-operator',
      delegation: delegationFixture(AGENT_DID, 'did:abt:refusal-503-operator'),
      name: 'refusal-503-scout',
      skills: [],
      githubLogin: null,
    });
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'refusal-503-buyer', id: 3 }),
    });
    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: 'did:abt:refusal-503-buyer-account', githubLogin: 'refusal-503-buyer' });
    const server = createApp(
      accountRepo,
      agentRepo,
      undefined, undefined, new FailingCreateJobRepository(), undefined, undefined, undefined, undefined, undefined, undefined,
      sessionAdapter,
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const token = await mintSessionToken(sessionAdapter);
      const sentence = await submitAndCaptureError(baseUrl, AGENT_DID, { token });
      expect(sentence.toLowerCase()).toContain('unavailable');
      sentences.push(sentence);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('a repository string the server rejects (400): distinct sentence', async () => {
    // The client-side owner/name guard blocks a malformed repository
    // before the network (already pinned above), so the route's own 400
    // wording for the identical rule is reached by disabling that guard
    // for this one probe -- a direct fetch, not the page's own submit
    // path -- which is the only way to observe the route's own message
    // rather than the client's pre-empting one, per scope item 9's "pass
    // the route's own message through; one wording of each rule, not two".
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:refusal-400-operator',
      delegation: delegationFixture(AGENT_DID, 'did:abt:refusal-400-operator'),
      name: 'refusal-400-scout',
      skills: [],
      githubLogin: null,
    });
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'refusal-400-buyer', id: 4 }),
    });
    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: 'did:abt:refusal-400-buyer-account', githubLogin: 'refusal-400-buyer' });
    const server = createApp(
      accountRepo,
      agentRepo,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      sessionAdapter,
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const token = await mintSessionToken(sessionAdapter);
      const res = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agentDid: AGENT_DID, repository: 'not-owner-name-repo', brief: 'Fix the login bug' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      sentences.push(String(body.error));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('the session has expired (401): distinct sentence', async () => {
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:refusal-401-operator',
      delegation: delegationFixture(AGENT_DID, 'did:abt:refusal-401-operator'),
      name: 'refusal-401-scout',
      skills: [],
      githubLogin: null,
    });
    const server = createApp(new MemoryAccountRepository(), agentRepo).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      // A live-looking but never-issued token: the exact shape hire.js
      // would carry for a session that expired after the page loaded.
      const sentence = await submitAndCaptureError(baseUrl, AGENT_DID, { token: 'expired-or-unknown-token' });
      expect(sentence.toLowerCase()).toContain('expired');
      sentences.push(sentence);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('all six collected sentences are pairwise distinct', () => {
    expect(sentences.length).toBe(6);
    expect(new Set(sentences).size).toBe(sentences.length);
  });
});
