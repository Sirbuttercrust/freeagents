// ORG1b: the private-repository walkthrough page (SITEMAP P-32) and the two
// places a buyer meets the problem it solves.
//
// A GitHub personal account gives a collaborator write access or nothing,
// so a private repository there cannot be shared read-only. The way
// through is an organization repository with forking of private
// repositories turned on and the Read role for two outside collaborators
// (the agent's account, and the platform's). This file pins:
//
//   (a) /private-repos answers 200, one <main>, at most 120 words by S1's
//       counter (ported, with its tripwire);
//   (b) the four steps, in order, each with GitHub's own page, the five
//       links exactly these URLs;
//   (c) opened for a job whose record carries githubAccessNeeded, step 4
//       names both accounts; with no job, an unknown job, or a job past
//       staging it says the same thing without names, and the four steps
//       render every time;
//   (d) no machine words on the surface (S1's lists, pinned against S1's
//       own file so the copy cannot drift);
//   (e) the hire page links it beside the repository field, inside S1's
//       ceiling;
//   (f) the deposit page, on the REAL routes: Pay's four repository
//       refusals (f1, f2) and confirm's (f3) each say so in words, the
//       three about sharing link the page for this job, and once the
//       buyer has done what the page says (the repository moved into an
//       organization and shared, which the platform then reads under its
//       new name from the old path) the same press goes through; every
//       other 409 keeps today's sentence (f4);
//   (g) the page in real Chrome at 320 and 1280, with and without a job:
//       no sideways scroll, every control 44px or more, and the reveal
//       finished and still under reduced motion. Also the deposit page at
//       both widths with a Pay refusal and with confirm's refusal showing.
//
// Set ORG1B_CAPTURE_DIR to a directory to have (g) save a screenshot of
// each state it measures. Off by default.
import type { Server } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { MemoryAccountRepository, MemoryAgentRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import type { GithubAdapter, RepositoryFacts, StagingRepoRef } from '../../src/adapters/github/types.js';
import { RepositoryEmptyError, RepositoryNotAccessibleError } from '../../src/adapters/github/types.js';
import { createAbtPaymentRail } from '../../src/adapters/payment/abt.js';
import type { Session } from '../../src/adapters/identity/session.js';
import { didSuffix, type Delegation } from '../../src/domain/agent.js';
import { createJob, type Job } from '../../src/domain/job.js';
import { abtEnv, fakeAbtChainClient, fromRandom, reservePort, withEnv } from '../helpers/abt-fixtures.js';
import { createStagingLifecycleGithubFake, PLATFORM_LOGIN } from '../helpers/github-staging-fixtures.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession } from '../helpers/session-fixtures.js';
import { unsettledGate } from '../helpers/settlement-fixtures.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../..');
const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const BROWSER_TIMEOUT_MS = 60_000;

const pageSource = (page: string): string => readFileSync(join(repoRoot, 'src/web/pages', `${page}.html`), 'utf8');

// ------------------------------------------------------- S1's instruments

// static_words.py, the same port hire-journey-simple.test.ts carries, line
// for line: <main> to </main>, script, style and template blocks out,
// comments out, tags to spaces, entities decoded, split on whitespace.
function staticWords(src: string): string[] {
  const m = src.match(/<main[\s\S]*?<\/main>/);
  let body = m ? m[0] : src;
  body = body.replace(/<(script|style|template)[^>]*>[\s\S]*?<\/\1>/g, '');
  body = body.replace(/<!--[\s\S]*?-->/g, '');
  const text = body.replace(/<[^>]+>/g, ' ');
  const decoded = new JSDOM(`<p>${text.replace(/</g, '&lt;')}</p>`).window.document.body.textContent ?? '';
  return decoded.split(/\s+/).filter(Boolean);
}

// S1's machine-word lists. Copied, then pinned against S1's file below, so
// a word added there cannot silently miss this page.
const JARGON = ['credential', 'credentials', 'attestation', 'attested', 'hash', 'hashes', 'Ed25519', 'settlement', 'settle', 'settles', 'settled', 'rail', 'rails', 'specHash', 'diffHash'];
const JARGON_EXACT = ['DID', 'DIDs'];
const DID_STRING = /\bdid:[a-z0-9]+:/i;

function machineWords(text: string, identities: ReadonlyArray<string>): string[] {
  const found = [
    ...JARGON.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(text)),
    ...JARGON_EXACT.filter((w) => new RegExp(`\\b${w}\\b`).test(text)),
  ];
  if (DID_STRING.test(text)) found.push('a DID string');
  for (const id of identities) {
    const suffix = id.replace(/^did:[a-z0-9]+:/i, '');
    if (text.includes(id) || text.includes(suffix)) found.push(`the identity ${id}`);
  }
  return found;
}

// ------------------------------------------------------------ the fixtures

const GH_DOCS = 'https://docs.github.com/en';
const STEP_LINKS: ReadonlyArray<ReadonlyArray<string>> = [
  [`${GH_DOCS}/organizations/collaborating-with-groups-in-organizations/creating-a-new-organization-from-scratch`],
  [`${GH_DOCS}/repositories/creating-and-managing-repositories/transferring-a-repository`],
  [`${GH_DOCS}/organizations/managing-organization-settings/managing-the-forking-policy-for-your-organization`],
  [
    `${GH_DOCS}/organizations/managing-user-access-to-your-organizations-repositories/managing-outside-collaborators/adding-outside-collaborators-to-repositories-in-your-organization`,
    `${GH_DOCS}/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization`,
  ],
];

const AGENT_DID = 'did:abt:zOrg1bVerifiedAgent';
const UNVERIFIED_AGENT_DID = 'did:abt:zOrg1bUnverifiedAgent';
const OPERATOR_DID = 'did:abt:zOrg1bOperator';
const BUYER_DID = 'did:abt:org1b-buyer';
const AGENT_LOGIN = 'org1b-agent-gh';
const RECENT = new Date(Date.now() - 60 * 60 * 1000);

function delegation(did: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:org1b-${did}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: OPERATOR_DID,
    issuanceDate: '2026-09-01T00:00:00Z',
    credentialSubject: { id: did },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-09-01T00:00:00Z',
      verificationMethod: `${OPERATOR_DID}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zOrg1bFixtureNotVerifiedHere',
    },
  };
}

// A fully agreed job at proposed: the state confirm runs from.
function agreed(id: string, repository: string, agentDid = AGENT_DID): Job {
  const base = createJob({ id, buyerDid: BUYER_DID, agentDid, repository, brief: 'Fix the checkout flow' }, new Date('2026-09-01T00:00:00Z'));
  return {
    ...base,
    status: 'proposed',
    criteria: [{ text: 'The checkout works', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
    priceUsd: '400.00',
    rail: 'abt',
    depositPercent: 25,
    redoAllowance: 1,
    deliveryWindowDays: 5,
    priceAcceptedByBuyer: true,
    priceAcceptedByAgent: true,
  };
}

// What GitHub answers the platform's account for a repository path, right
// now. A path with no entry reads as the staging fake's default, a ready
// repository. 'hidden' is the 404 GitHub gives an account that cannot see
// a private repository; 'empty' is a repository with no commits.
type RepoAnswer = 'hidden' | 'empty' | RepositoryFacts;
const world = new Map<string, RepoAnswer>();

function worldGithub(github: GithubAdapter): GithubAdapter {
  return {
    ...github,
    readRepository: (ref: StagingRepoRef) => {
      const answer = world.get(`${ref.owner}/${ref.repo}`);
      if (answer === 'hidden') return Promise.reject(new RepositoryNotAccessibleError(ref.owner, ref.repo, 404));
      if (answer === 'empty') return Promise.reject(new RepositoryEmptyError(ref.owner, ref.repo));
      return answer === undefined ? github.readRepository(ref) : Promise.resolve(answer);
    },
  };
}

// The buyer does the page's four steps on GitHub: a new organization, the
// repository moved into it, forking of private repositories turned on, and
// Read for both accounts. What the platform then reads is the moved
// repository, under its new name, from the OLD path too: GitHub follows
// its redirect once the platform's account can read the repository. The
// job itself is never edited here; it keeps the name it was briefed with.
const NEW_ORG = 'org1b-buyer-org';
function followThePage(path: string): string {
  const name = path.slice(path.indexOf('/') + 1);
  const moved = `${NEW_ORG}/${name}`;
  const facts: RepositoryFacts = { fullName: moved, private: true, ownerIsOrganization: true, allowForking: true, defaultBranch: 'main', sha: `${name}-head-sha` };
  world.set(path, facts);
  world.set(moved, facts);
  return moved;
}

let server: Server;
let baseUrl: string;
let session: Session;
let jobRepo: MemoryJobRepository;

beforeAll(async () => {
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: AGENT_DID,
    operatorDid: OPERATOR_DID,
    delegation: delegation(AGENT_DID),
    name: 'org1b-scout',
    skills: ['websites'],
    githubLogin: null,
  });
  await agentRepo.updateGithubBinding(AGENT_DID, { handle: AGENT_LOGIN, status: 'verified' });
  // No verified GitHub login: confirm answers a DIFFERENT 409 for this
  // agent's jobs, the one the deposit page must keep today's sentence for.
  await agentRepo.create({
    did: UNVERIFIED_AGENT_DID,
    operatorDid: OPERATOR_DID,
    delegation: delegation(UNVERIFIED_AGENT_DID),
    name: 'org1b-unverified-scout',
    skills: ['websites'],
    githubLogin: null,
  });

  const accountRepo = new MemoryAccountRepository();
  await accountRepo.register({ did: BUYER_DID, githubLogin: 'org1b-buyer' });
  await accountRepo.register({ did: OPERATOR_DID, githubLogin: 'org1b-operator' });

  jobRepo = new MemoryJobRepository();
  const settlementGate = unsettledGate();
  // Confirm runs only once the deposit has settled, so the jobs confirm is
  // pressed on start settled. The Pay jobs start unsettled: Pay is the
  // press before any money has moved.
  const settled: Job[] = [
    agreed('org1b-proposed', 'buyer/org1b-named'),
    { ...agreed('org1b-staged', 'buyer/org1b-staged'), status: 'staged', confirmedAt: RECENT, confirmedSpecHash: 'sha256:org1b', stagedAt: RECENT, stagedCommit: 'org1bstaged', stagingRepo: { owner: PLATFORM_LOGIN, repo: 'org1b-staged' } },
    agreed('org1b-hidden', 'buyer/org1b-hidden'),
    agreed('org1b-unverified', 'buyer/org1b-unverified', UNVERIFIED_AGENT_DID),
    agreed('org1b-shot-320', 'buyer/org1b-shot-320'),
    agreed('org1b-shot-1280', 'buyer/org1b-shot-1280'),
  ];
  const unpaid: Job[] = [
    agreed('org1b-pay-hidden', 'buyer/org1b-pay-hidden'),
    agreed('org1b-pay-personal', 'buyer/org1b-pay-personal'),
    agreed('org1b-pay-forking-off', `${NEW_ORG}/org1b-pay-forking-off`),
    agreed('org1b-pay-empty', 'buyer/org1b-pay-empty'),
    // Agreed on USDC: the ABT start door answers a DIFFERENT 409 (the
    // rail), the one Pay must keep today's sentence for.
    { ...agreed('org1b-pay-other-rail', 'buyer/org1b-pay-other-rail'), rail: 'usdc' },
    agreed('org1b-payshot-320', 'buyer/org1b-payshot-320'),
    agreed('org1b-payshot-1280', 'buyer/org1b-payshot-1280'),
  ];
  for (const f of settled) {
    await jobRepo.create(f);
    settlementGate.markDepositSettled(f.id);
  }
  for (const f of unpaid) await jobRepo.create(f);

  // Briefed as buyer/<name>: a private repository the platform's account
  // cannot see (GitHub answers 404), as it is before the page's steps.
  for (const path of ['buyer/org1b-hidden', 'buyer/org1b-shot-320', 'buyer/org1b-shot-1280', 'buyer/org1b-pay-hidden', 'buyer/org1b-payshot-320', 'buyer/org1b-payshot-1280']) {
    world.set(path, 'hidden');
  }
  // Private on a personal account, which the platform's account can see
  // only as a collaborator with write access.
  world.set('buyer/org1b-pay-personal', { fullName: 'buyer/org1b-pay-personal', private: true, ownerIsOrganization: false, allowForking: true, defaultBranch: 'main', sha: 'personal-head-sha' });
  // In an organization already, with forking of private repositories off
  // (GitHub's default for a new organization).
  world.set(`${NEW_ORG}/org1b-pay-forking-off`, { fullName: `${NEW_ORG}/org1b-pay-forking-off`, private: true, ownerIsOrganization: true, allowForking: false, defaultBranch: 'main', sha: 'forking-off-head-sha' });
  world.set('buyer/org1b-pay-empty', 'empty');

  // The ABT rail, set up as tests/web/deposit.test.ts sets it up: the
  // recipient resolves from the agent's operator, and the public base URL
  // is baked in when the rail is built, so the port is reserved first.
  await accountRepo.setOperatorAddressAbt(OPERATOR_DID, didSuffix(AGENT_DID));
  const port = await reservePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const railEnv = abtEnv(baseUrl, fromRandom(), fromRandom().address, fromRandom().address);
  const abtRail = await withEnv(railEnv, async () =>
    createAbtPaymentRail({
      chainClient: fakeAbtChainClient().client,
      rateSource: async () => '1',
      spentTransferStorage: {
        async record(): Promise<void> {},
        async findByHash(): Promise<null> {
          return null;
        },
      },
    }),
  );

  const sessionAdapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'org1b-buyer', id: 9611 }) });
  const { github } = createStagingLifecycleGithubFake();
  const app = await withEnv(railEnv, async () =>
    createApp(
      accountRepo,
      agentRepo,
      undefined,
      worldGithub(github),
      jobRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sessionAdapter,
      undefined,
      settlementGate,
      undefined,
      undefined,
      abtRail,
    ),
  );
  server = app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  session = await mintSession(sessionAdapter);
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Rendered {
  readonly document: Document;
  readonly window: JSDOM['window'];
  close(): void;
}

// A page with its own scripts run for real, signed in as the buyer when
// asked. Waits for the page's own done signal, never a fixed sleep.
async function render(path: string, ready: (d: Document) => boolean, what: string, signedIn = false): Promise<Rendered> {
  const failures: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e: Error) => failures.push(e.message));
  const res = await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } });
  expect(res.status, path).toBe(200);
  const dom = new JSDOM(await res.text(), {
    url: `${baseUrl}${path}`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      if (signedIn) window.sessionStorage.setItem('fa_session', JSON.stringify(session));
      Object.defineProperty(window, 'fetch', {
        writable: true,
        value: (input: string, init?: RequestInit) => fetch(new URL(input, baseUrl), init),
      });
    },
  });
  const deadline = Date.now() + 8000;
  while (!ready(dom.window.document)) {
    if (Date.now() > deadline) throw new Error(`${what} did not settle within 8000ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
  const real = failures.filter((m) => !m.includes('Not implemented'));
  if (real.length > 0) throw new Error(`page script failed on ${path}: ${real.join('; ')}`);
  return { document: dom.window.document, window: dom.window, close: () => dom.window.close() };
}

// private-repos.js removes data-pending from #step-accounts once it has
// decided what step 4 says, whichever way it went.
const walkthroughReady = (d: Document): boolean => {
  const host = d.getElementById('step-accounts');
  return host !== null && !host.hasAttribute('data-pending');
};

// ---------------------------------------------------------------- (a)

describe('(a) /private-repos is one page, one <main>, at most 120 words', () => {
  it('the counter agrees with static_words.py on a known input', () => {
    const src = '<nav>Nav words</nav><main><!-- a <b>note</b> --><h1>One&nbsp;two</h1><script>var x = "no";</script><template><p>no</p></template><p>three &amp; four</p></main>';
    expect(staticWords(src)).toEqual(['One', 'two', 'three', '&', 'four']);
  });

  it('answers 200 as a page, with no session', async () => {
    const res = await fetch(`${baseUrl}/private-repos`, { headers: { Accept: HTML } });
    expect(res.status).toBe(200);
    expect(String(res.headers.get('content-type'))).toContain('text/html');
  });

  it('carries exactly one <main> and at most 120 words inside it', () => {
    const src = pageSource('private-repos');
    expect(src.match(/<main\b/g)?.length, 'exactly one <main>, or the count reads the whole file').toBe(1);
    const words = staticWords(src);
    expect(words.length, 'the counter read nothing: the page or the port broke').toBeGreaterThan(20);
    expect(words.length, `${words.length} words: ${words.join(' ')}`).toBeLessThanOrEqual(120);
  });

  it('wears how.html\u2019s head, nav, footer and stylesheets', () => {
    const sheets = (src: string): string[] => [...src.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => m[1] ?? '');
    const scripts = (src: string): string[] => [...src.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1] ?? '');
    const how = pageSource('how');
    const page = pageSource('private-repos');
    expect(sheets(page)).toEqual(sheets(how));
    // how.html's scripts, in order, with this page's own before ui.js.
    expect(scripts(page).filter((s) => s !== '/js/pages/private-repos.js')).toEqual(scripts(how));
    const block = (src: string, tag: string): string => (src.match(new RegExp(`<${tag}[\\s\\S]*?</${tag}>`))?.[0] ?? '').replace(/ class="on"/g, '');
    expect(block(page, 'nav')).toBe(block(how, 'nav'));
    expect(block(page, 'footer')).toBe(block(how, 'footer'));
  });
});

// ---------------------------------------------------------------- (b)

describe('(b) the four steps, in order, each with GitHub\u2019s own page', () => {
  it('four numbered steps, in order, and the five links exactly', async () => {
    const page = await render('/private-repos', walkthroughReady, 'the walkthrough');
    try {
      const steps = Array.from(page.document.querySelectorAll('main ol#steps > li'));
      expect(steps).toHaveLength(4);
      const titles = steps.map((s) => (s.querySelector('h2')?.textContent ?? '').trim());
      expect(titles[0]).toMatch(/organization/i);
      expect(titles[1]).toMatch(/move/i);
      expect(titles[2]).toMatch(/forking/i);
      expect(titles[3]).toMatch(/read/i);
      expect(steps.map((s) => (s.querySelector('.rnode')?.textContent ?? '').trim())).toEqual(['1', '2', '3', '4']);

      steps.forEach((step, i) => {
        const links = Array.from(step.querySelectorAll('a'));
        expect(links.map((a) => a.getAttribute('href')), `step ${i + 1}`).toEqual(STEP_LINKS[i]);
        for (const a of links) {
          expect(a.getAttribute('rel'), `${a.getAttribute('href')}`).toBe('noreferrer');
          expect((a.textContent ?? '').trim().length, 'a link with no words').toBeGreaterThan(0);
        }
      });
      // And nothing else links out of <main>: these five.
      expect(page.document.querySelectorAll('main a[href]')).toHaveLength(5);
      // One primary button at most (none is needed).
      expect(page.document.querySelectorAll('main .btn-primary').length).toBeLessThanOrEqual(1);
    } finally {
      page.close();
    }
  });

  it('step 3 says where the setting is and that it starts off, and step 4 says Read, never Write', () => {
    const doc = new JSDOM(pageSource('private-repos')).window.document;
    const steps = Array.from(doc.querySelectorAll('main ol#steps > li'));
    const three = (steps[2]?.textContent ?? '').replace(/\s+/g, ' ');
    expect(three).toContain('Settings');
    expect(three).toContain('Member privileges');
    expect(three).toMatch(/starts off/);
    const four = (steps[3]?.textContent ?? '').replace(/\s+/g, ' ');
    expect(four).toContain('outside collaborators');
    expect(four).toMatch(/Read, never Write/);
  });
});

// ---------------------------------------------------------------- (c)

function stepFour(d: Document): { plainShown: boolean; accounts: string[]; listShown: boolean; steps: number } {
  const plain = d.getElementById('accounts-plain') as HTMLElement;
  const list = d.getElementById('accounts') as HTMLElement;
  return {
    plainShown: !plain.hidden,
    listShown: !list.hidden,
    accounts: Array.from(list.querySelectorAll('li')).map((li) => (li.textContent ?? '').replace(/\s+/g, ' ').trim()),
    steps: d.querySelectorAll('main ol#steps > li').length,
  };
}

describe('(c) step 4 names both accounts only when the job does', () => {
  it('a job that carries githubAccessNeeded: both logins, the plain line gone', async () => {
    // The field is really there: this is the server's reply, not a stub.
    const read = (await (await fetch(`${baseUrl}/jobs/org1b-proposed`, { headers: { Accept: 'application/json' } })).json()) as Record<string, unknown>;
    expect(read.githubAccessNeeded).toEqual({ agentGithubLogin: AGENT_LOGIN, platformGithubLogin: PLATFORM_LOGIN });

    const page = await render('/private-repos?job=org1b-proposed', walkthroughReady, 'the walkthrough for a job');
    try {
      const four = stepFour(page.document);
      expect(four.steps).toBe(4);
      expect(four.listShown).toBe(true);
      expect(four.plainShown, 'the plain line stayed beside the names').toBe(false);
      expect(four.accounts).toEqual([`@${AGENT_LOGIN}, the agent`, `@${PLATFORM_LOGIN}, FreeAgents`]);
      // As text, never markup.
      expect(page.document.querySelectorAll('#accounts .login')).toHaveLength(2);
    } finally {
      page.close();
    }
  });

  it('a login carrying markup renders as text, never as HTML', async () => {
    // Driven through the page's own script with the one read replaced, so
    // the value is hostile; every other part is the real page.
    const res = await fetch(`${baseUrl}/private-repos?job=x`, { headers: { Accept: HTML } });
    const dom = new JSDOM(await res.text(), {
      url: `${baseUrl}/private-repos?job=x`,
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole: new VirtualConsole(),
      beforeParse(window) {
        Object.defineProperty(window, 'fetch', {
          writable: true,
          value: (input: string, init?: RequestInit) =>
            String(input).startsWith('/jobs/')
              ? Promise.resolve(new Response(JSON.stringify({ githubAccessNeeded: { agentGithubLogin: '<img src=x id=planted>', platformGithubLogin: 'ok-login' } }), { status: 200, headers: { 'content-type': 'application/json' } }))
              : fetch(new URL(input, baseUrl), init),
        });
      },
    });
    try {
      const deadline = Date.now() + 8000;
      while (!walkthroughReady(dom.window.document) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      expect(dom.window.document.getElementById('planted')).toBeNull();
      expect(dom.window.document.getElementById('accounts')?.textContent).toContain('@<img src=x id=planted>');
    } finally {
      dom.window.close();
    }
  });

  it.each([
    ['no job', '/private-repos'],
    ['an unknown job', '/private-repos?job=no-such-job'],
    ['a job past staging', '/private-repos?job=org1b-staged'],
  ])('%s: the plain line, no names, and the four steps', async (_label, path) => {
    const page = await render(path, walkthroughReady, `the walkthrough (${_label})`);
    try {
      const four = stepFour(page.document);
      expect(four.steps).toBe(4);
      expect(four.plainShown).toBe(true);
      expect(four.listShown).toBe(false);
      expect(four.accounts).toEqual([]);
      expect(page.document.querySelector('main')?.textContent ?? '').not.toContain(PLATFORM_LOGIN);
    } finally {
      page.close();
    }
  });

  it('a failed read: the plain line and the four steps', async () => {
    const res = await fetch(`${baseUrl}/private-repos?job=org1b-proposed`, { headers: { Accept: HTML } });
    const dom = new JSDOM(await res.text(), {
      url: `${baseUrl}/private-repos?job=org1b-proposed`,
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole: new VirtualConsole(),
      beforeParse(window) {
        Object.defineProperty(window, 'fetch', {
          writable: true,
          value: (input: string, init?: RequestInit) =>
            String(input).startsWith('/jobs/') ? Promise.resolve(new Response('{"error":"storage unavailable"}', { status: 503 })) : fetch(new URL(input, baseUrl), init),
        });
      },
    });
    try {
      const deadline = Date.now() + 8000;
      while (!walkthroughReady(dom.window.document)) {
        if (Date.now() > deadline) throw new Error('the walkthrough never settled after a failed read');
        await new Promise((r) => setTimeout(r, 25));
      }
      const four = stepFour(dom.window.document);
      expect(four.steps).toBe(4);
      expect(four.plainShown).toBe(true);
      expect(four.listShown).toBe(false);
    } finally {
      dom.window.close();
    }
  });

  it('no GitHub login is written into the page itself', () => {
    const page = pageSource('private-repos') + readFileSync(join(repoRoot, 'src/web/public/js/pages/private-repos.js'), 'utf8');
    expect(page).not.toContain(PLATFORM_LOGIN);
    expect(page).not.toMatch(/@[A-Za-z0-9-]{3,}/);
  });
});

// ---------------------------------------------------------------- (d)

describe('(d) no machine words on the surface', () => {
  it('the lists here are S1\u2019s lists, word for word', () => {
    const s1 = readFileSync(join(here, 'hire-journey-simple.test.ts'), 'utf8');
    const list = (name: string): string[] => {
      const body = s1.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))?.[1];
      expect(body, `${name} not found in S1's file`).toBeDefined();
      return [...(body ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
    };
    expect(list('JARGON')).toEqual(JARGON);
    expect(list('JARGON_EXACT')).toEqual(JARGON_EXACT);
  });

  it('the gate says no to a planted word and a planted DID', () => {
    expect(machineWords('Give the agent\u2019s DID read access', [])).not.toEqual([]);
    expect(machineWords('share with did:abt:zOrg1bVerifiedAgent', [])).not.toEqual([]);
    expect(machineWords('The agent did the work.', [])).toEqual([]);
  });

  it.each([
    ['no job', '/private-repos'],
    ['a job with both accounts named', '/private-repos?job=org1b-proposed'],
  ])('%s', async (_label, path) => {
    const page = await render(path, walkthroughReady, `the walkthrough (${_label})`);
    try {
      const d = page.document;
      d.querySelectorAll('script, style, nav, footer').forEach((el) => el.remove());
      const text = d.querySelector('main')?.textContent ?? '';
      expect(text.trim().length).toBeGreaterThan(100);
      expect(machineWords(text, [AGENT_DID, OPERATOR_DID, BUYER_DID])).toEqual([]);
    } finally {
      page.close();
    }
  });
});

// ---------------------------------------------------------------- (e)

describe('(e) the hire page links it beside the repository field', () => {
  it('one quiet .sf-more link in the repository field, to /private-repos, that answers 200', async () => {
    const doc = new JSDOM(pageSource('hire')).window.document;
    const links = Array.from(doc.querySelectorAll('a[href^="/private-repos"]'));
    expect(links).toHaveLength(1);
    const link = links[0]!;
    expect(link.classList.contains('sf-more')).toBe(true);
    expect(link.getAttribute('href')).toBe('/private-repos');
    // Beside the field: inside the same .field as the repository input.
    expect(link.closest('.field')?.querySelector('#repo'), 'the link is not in the repository field').not.toBeNull();
    const words = (link.textContent ?? '').trim().split(/\s+/);
    expect(words.length, 'S1 wants four or more words that say what is behind it').toBeGreaterThanOrEqual(4);
    expect(words.length, 'the card allows at most nine').toBeLessThanOrEqual(9);
    const res = await fetch(`${baseUrl}/private-repos`, { headers: { Accept: HTML } });
    expect(res.status).toBe(200);
  });

  it('hire.html stays inside S1\u2019s ceiling of 120 words', () => {
    const src = pageSource('hire');
    expect(src.match(/<main\b/g)?.length).toBe(1);
    const words = staticWords(src);
    expect(words.length, `hire: ${words.length} words`).toBeLessThanOrEqual(120);
  });
});

// ---------------------------------------------------------------- (f)
//
// Every case below runs the REAL routes: POST .../abt/start on a real ABT
// rail and POST .../confirm against the settlement gate. The repository
// becomes readable only by the state the page's steps produce
// (followThePage above): the job keeps the name it was briefed with, and
// GitHub answers that old path with the moved repository's new name.

const FINISH_SIGNING = 'Finish signing the agreement';
const NO_AGREED_PRICE = 'There is no agreed price to pay against yet';

const depositReady = (d: Document): boolean => {
  const body = d.getElementById('deposit-body') as HTMLElement | null;
  const err = d.getElementById('load-error') as HTMLElement | null;
  return (body !== null && !body.hidden) || (err !== null && !err.hidden);
};

async function pressApproved(page: Rendered, settledWhen: (d: Document) => boolean, what: string): Promise<void> {
  (page.document.getElementById('approved-btn') as HTMLButtonElement).click();
  const deadline = Date.now() + 8000;
  while (!settledWhen(page.document)) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen within 8000ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const scanOpen = (d: Document): boolean => (d.getElementById('scan') as HTMLElement).hasAttribute('open');
const payRefused = (d: Document): boolean => !(d.getElementById('pay-error') as HTMLElement).hidden;

// One press of Pay, waited on until the page has answered it either way:
// the scan opened, or the refusal box showed. Never a fixed sleep, and
// never a blank result: a press that does neither fails here.
async function pressPay(page: Rendered, what: string): Promise<{ text: string; link: HTMLAnchorElement | null; scan: boolean }> {
  const payBtn = page.document.getElementById('pay-btn') as HTMLButtonElement;
  expect(payBtn.disabled, 'Pay is not pressable').toBe(false);
  payBtn.click();
  const deadline = Date.now() + 8000;
  while (!scanOpen(page.document) && !payRefused(page.document)) {
    if (Date.now() > deadline) throw new Error(`${what}: Pay did nothing within 8000ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
  const detail = page.document.getElementById('pay-error-detail')!;
  return {
    text: payRefused(page.document) ? (detail.textContent ?? '').replace(/\s+/g, ' ').trim() : '',
    link: payRefused(page.document) ? (detail.querySelector('a') as HTMLAnchorElement | null) : null,
    scan: scanOpen(page.document),
  };
}

async function expectWalkthroughLink(link: HTMLAnchorElement | null, jobId: string): Promise<void> {
  expect(link, 'no link to the walkthrough').not.toBeNull();
  expect(link!.getAttribute('href')).toBe(`/private-repos?job=${jobId}`);
  expect(link!.classList.contains('sf-more')).toBe(true);
  expect((link!.textContent ?? '').trim().length, 'a link with no words').toBeGreaterThan(0);
  // The link lands on something that exists.
  expect((await fetch(`${baseUrl}${link!.getAttribute('href')}`, { headers: { Accept: HTML } })).status).toBe(200);
}

describe('(f1) Pay on a repository the platform cannot see', () => {
  it('says so in words with the page for this job, never "no agreed price"; after the page\u2019s steps, Pay starts the deposit', async () => {
    const jobId = 'org1b-pay-hidden';
    const page = await render(`/deposit?job=${jobId}`, depositReady, 'the deposit page', true);
    try {
      expect((page.document.getElementById('deposit-body') as HTMLElement).hidden, 'the deposit screen did not render').toBe(false);
      const first = await pressPay(page, 'the first press');
      expect(first.scan, 'the scan opened on a repository nobody can read').toBe(false);
      expect(first.text).toContain("can't see this repository");
      expect(first.text).toMatch(/press Pay again/);
      expect(first.text).not.toContain(NO_AGREED_PRICE);
      expect(machineWords(first.text, [AGENT_DID, OPERATOR_DID, BUYER_DID])).toEqual([]);
      await expectWalkthroughLink(first.link, jobId);

      // The buyer follows the page. The job is untouched: it still names
      // the path it was briefed with.
      followThePage('buyer/org1b-pay-hidden');
      expect((await jobRepo.findById(jobId))?.repository).toBe('buyer/org1b-pay-hidden');
      const second = await pressPay(page, 'the press after the move');
      expect(second.scan, `Pay did not start the deposit after the move: ${second.text}`).toBe(true);
      expect(payRefused(page.document), 'the refusal stayed up beside the scan').toBe(false);
    } finally {
      page.close();
    }
  });
});

describe('(f2) Pay on the other three repository refusals', () => {
  it('a private repository on a personal account: says move it into an organization, with the page', async () => {
    const jobId = 'org1b-pay-personal';
    const page = await render(`/deposit?job=${jobId}`, depositReady, 'the deposit page', true);
    try {
      const got = await pressPay(page, 'Pay on a personal account');
      expect(got.scan).toBe(false);
      expect(got.text).toMatch(/personal account/);
      expect(got.text).toMatch(/organization/);
      expect(got.text).not.toContain(NO_AGREED_PRICE);
      expect(machineWords(got.text, [AGENT_DID, OPERATOR_DID, BUYER_DID])).toEqual([]);
      await expectWalkthroughLink(got.link, jobId);
    } finally {
      page.close();
    }
  });

  it('forking of private repositories off: says so and where it is turned on, with the page', async () => {
    const jobId = 'org1b-pay-forking-off';
    const page = await render(`/deposit?job=${jobId}`, depositReady, 'the deposit page', true);
    try {
      const got = await pressPay(page, 'Pay with forking off');
      expect(got.scan).toBe(false);
      expect(got.text).toMatch(/[Ff]orking of private repositories is off/);
      expect(got.text).toMatch(/Settings/);
      expect(got.text).not.toContain(NO_AGREED_PRICE);
      await expectWalkthroughLink(got.link, jobId);
    } finally {
      page.close();
    }
  });

  it('an empty repository: says to add a first commit, and links nothing', async () => {
    const jobId = 'org1b-pay-empty';
    const page = await render(`/deposit?job=${jobId}`, depositReady, 'the deposit page', true);
    try {
      const got = await pressPay(page, 'Pay on an empty repository');
      expect(got.scan).toBe(false);
      expect(got.text).toMatch(/no commits/);
      expect(got.text).toMatch(/first commit/);
      expect(got.text).not.toContain(NO_AGREED_PRICE);
      expect(got.link, 'sharing is not the fix here').toBeNull();
    } finally {
      page.close();
    }
  });
});

describe('(f3) confirm on a repository the platform cannot see', () => {
  it('says so in words with the page for this job, never "finish signing"; after the page\u2019s steps, the next press confirms under the new name', async () => {
    const jobId = 'org1b-hidden';
    const page = await render(`/deposit?job=${jobId}`, depositReady, 'the deposit page', true);
    try {
      expect((page.document.getElementById('deposit-body') as HTMLElement).hidden, 'the deposit screen did not render').toBe(false);
      const errorBox = page.document.getElementById('confirm-error') as HTMLElement;
      await pressApproved(page, () => !errorBox.hidden, 'the first press\u2019s refusal');

      const detail = page.document.getElementById('confirm-error-detail')!;
      const text = (detail.textContent ?? '').replace(/\s+/g, ' ');
      expect(text).toContain("can't see this repository");
      expect(text).toMatch(/press this again/);
      expect(text).not.toContain(FINISH_SIGNING);
      expect(machineWords(text, [AGENT_DID, OPERATOR_DID, BUYER_DID])).toEqual([]);
      await expectWalkthroughLink(detail.querySelector('a'), jobId);

      // The 409 persisted nothing.
      const after409 = await jobRepo.findById(jobId);
      expect(after409?.status).toBe('proposed');
      expect(after409?.stagingRepo).toBeNull();
      expect(after409?.repository).toBe('buyer/org1b-hidden');

      // The buyer follows the page; the same press on the same page now
      // confirms, and the job carries the repository's new name.
      const moved = followThePage('buyer/org1b-hidden');
      const deadline = Date.now() + 8000;
      (page.document.getElementById('approved-btn') as HTMLButtonElement).click();
      let stored = await jobRepo.findById(jobId);
      while (stored?.status !== 'confirmed' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        stored = await jobRepo.findById(jobId);
      }
      expect(stored?.status, 'the second press did not confirm').toBe('confirmed');
      expect(stored?.stagingRepo).not.toBeNull();
      expect(stored?.repository).toBe(moved);
    } finally {
      page.close();
    }
  });
});

describe('(f4) every other 409 keeps today\u2019s sentence', () => {
  it('a different start 409 (the rail) keeps "no agreed price" and gets no link', async () => {
    const page = await render('/deposit?job=org1b-pay-other-rail', depositReady, 'the deposit page', true);
    try {
      // The page only pays with ABT; the job was agreed on USDC, so the
      // ABT start door answers its rail 409.
      (page.document.getElementById('rail-abt') as HTMLInputElement).click();
      const got = await pressPay(page, 'Pay against the wrong rail');
      expect(got.scan).toBe(false);
      expect(got.text).toContain(NO_AGREED_PRICE);
      expect(got.text).not.toMatch(/repository/);
      expect(got.link).toBeNull();
    } finally {
      page.close();
    }
  });

  it('a different confirm 409 keeps "finish signing" and gets no link', async () => {
    const page = await render('/deposit?job=org1b-unverified', depositReady, 'the deposit page', true);
    try {
      const errorBox = page.document.getElementById('confirm-error') as HTMLElement;
      await pressApproved(page, () => !errorBox.hidden, 'the refusal');
      const detail = page.document.getElementById('confirm-error-detail')!;
      expect(detail.textContent ?? '').toContain(FINISH_SIGNING);
      expect(detail.textContent ?? '').not.toMatch(/repository/);
      expect(detail.querySelector('a')).toBeNull();
      expect((await jobRepo.findById('org1b-unverified'))?.status).toBe('proposed');
    } finally {
      page.close();
    }
  });
});

// ---------------------------------------------------------------- (g)

const SWEEP = `
  (function () {
    function inSentence(a) {
      return [].some.call(a.parentElement.childNodes, function (n) {
        return n.nodeType === 3 && n.textContent.trim().length > 0;
      });
    }
    var doc = document.documentElement;
    var all = [].filter.call(document.querySelectorAll(SCOPE), function (el) {
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      past: [].filter.call(document.querySelectorAll('body *'), function (el) {
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.right > doc.clientWidth + 0.5 && getComputedStyle(el).position !== 'fixed';
      }).slice(0, 6).map(function (el) { return el.tagName + '#' + el.id + '.' + el.className; }),
      measured: all.length,
      small: all.filter(function (el) {
        var r = el.getBoundingClientRect();
        return (r.width < 44 || r.height < 44) && !(el.tagName === 'A' && inSentence(el));
      }).map(function (el) {
        var r = el.getBoundingClientRect();
        return (el.id || el.className || el.tagName) + ' "' + el.textContent.trim().slice(0, 30) + '" ' + Math.round(r.width) + 'x' + Math.round(r.height);
      })
    };
  })()
`;
const sweep = (scope: string): string => SWEEP.replace('SCOPE', JSON.stringify(scope));

interface Sweep {
  scrollWidth: number;
  clientWidth: number;
  past: string[];
  measured: number;
  small: string[];
}

const captureDir = process.env.ORG1B_CAPTURE_DIR ?? '';

async function capture(browser: RealBrowser, name: string, fullPage: boolean): Promise<void> {
  if (captureDir === '') return;
  mkdirSync(captureDir, { recursive: true });
  let clip: Record<string, number> | undefined;
  if (fullPage) {
    const metrics = (await browser.send('Page.getLayoutMetrics')) as { result?: { cssContentSize?: { height: number } } };
    const height = Math.ceil(metrics.result?.cssContentSize?.height ?? 900);
    clip = { x: 0, y: 0, width: await browser.evaluate<number>('document.documentElement.clientWidth'), height, scale: 1 };
  }
  const shot = (await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage, ...(clip ? { clip } : {}) })) as { result?: { data?: string } };
  if (shot.result?.data) writeFileSync(join(captureDir, `${name}.png`), Buffer.from(shot.result.data, 'base64'));
}

async function launch(width: number): Promise<RealBrowser> {
  const browser = await RealBrowser.launch({ width, height: 900 });
  if (width === 320) {
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 780, deviceScaleFactor: 2, mobile: true });
    await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  }
  return browser;
}

describe('(g) laid out right in real Chrome', () => {
  const PATHS: ReadonlyArray<readonly [string, string, boolean]> = [
    ['no job', '/private-repos', false],
    ['named', '/private-repos?job=org1b-proposed', true],
  ];
  for (const width of [320, 1280]) {
    it.each(PATHS)(`${width}px: %s, no sideways scroll and every control 44px or more`, async (label, path, named) => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for the ORG1b layout sweep; skipping (see CHROME_BIN)');
        return;
      }
      const browser = await launch(width);
      try {
        await browser.goto(`${baseUrl}${path}`, 1200);
        const shown = await browser.evaluate<{ names: number; pending: boolean }>(`({
          names: document.querySelectorAll('#accounts:not([hidden]) li').length,
          pending: document.getElementById('step-accounts').hasAttribute('data-pending')
        })`);
        expect(shown.pending, 'the page never settled step 4').toBe(false);
        expect(shown.names).toBe(named ? 2 : 0);
        await browser.evaluate(`(async function () { for (var y = 0; y < document.documentElement.scrollHeight; y += 300) { scrollTo(0, y); await new Promise(function (r) { setTimeout(r, 60); }); } scrollTo(0, 0); })()`);
        await new Promise((r) => setTimeout(r, 800));
        await capture(browser, `private-repos-${label.replace(/[^a-z]+/g, '-')}-${width}`, true);
        const got = await browser.evaluate<Sweep>(sweep('main a[href], main button, main input'));
        expect(got.measured, 'nothing to measure: the page did not render its links').toBe(5);
        expect(got.past, `${path} at ${width}: past the right edge`).toEqual([]);
        expect(got.scrollWidth, `${path} at ${width}: sideways scroll`).toBe(got.clientWidth);
        expect(got.small, `${path} at ${width}: under 44px`).toEqual([]);
        // Every link starts where its step's heading starts: a shared
        // class once centred step 4's pair at 320 while the sweep above
        // stayed green.
        const offsets = await browser.evaluate<number[]>(`[].map.call(document.querySelectorAll('main ol#steps > li'), function (li) {
          var h = li.querySelector('h2').getBoundingClientRect().left;
          return [].map.call(li.querySelectorAll('a'), function (a) { return Math.round(a.getBoundingClientRect().left - h); });
        }).reduce(function (all, row) { return all.concat(row); }, [])`);
        expect(offsets).toHaveLength(5);
        // The first link of each step sits flush; step 4's second may sit
        // beside its first (1280) or under it (320), flush either way.
        expect(offsets.filter((o, i) => i !== 4 && o !== 0), `${path} at ${width}: a link not aligned with its step: ${offsets.join(',')}`).toEqual([]);
        if (width === 320) expect(offsets[4], 'the second link of step 4 at 320').toBe(0);
        else expect(offsets[4]!, 'the second link of step 4 at 1280, beside its first').toBeGreaterThan(0);
      } finally {
        await browser.close();
      }
    }, BROWSER_TIMEOUT_MS);

    it(`${width}px: the deposit sheet with the repository sentence fits, and its link is 44px or more`, async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for the ORG1b layout sweep; skipping (see CHROME_BIN)');
        return;
      }
      const jobId = `org1b-shot-${width}`;
      const browser = await launch(width);
      try {
        await browser.send('Page.addScriptToEvaluateOnNewDocument', {
          source: `window.sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(session))});`,
        });
        await browser.goto(`${baseUrl}/deposit?job=${jobId}`, 1500);
        await browser.evaluate(`(function () { document.getElementById('scan').showModal(); document.getElementById('approved-btn').click(); })()`);
        const deadline = Date.now() + 8000;
        let link = '';
        while (Date.now() < deadline) {
          link = await browser.evaluate<string>(`(function () { var a = document.querySelector('#confirm-error:not([hidden]) #confirm-error-detail a'); return a ? a.getAttribute('href') : ''; })()`);
          if (link !== '') break;
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(link).toBe(`/private-repos?job=${jobId}`);
        await browser.evaluate(`document.getElementById('confirm-error').scrollIntoView({ block: 'center' })`);
        await new Promise((r) => setTimeout(r, 300));
        await capture(browser, `deposit-sheet-repository-409-${width}`, false);
        const got = await browser.evaluate<Sweep>(sweep('dialog[open] a[href], dialog[open] button'));
        expect(got.past, `the sheet at ${width}: past the right edge`).toEqual([]);
        expect(got.scrollWidth).toBe(got.clientWidth);
        const small = got.small.filter((s) => s.includes('confirm-private-repos-link'));
        expect(small, `the walkthrough link in the sheet at ${width}`).toEqual([]);
        if (width === 320) expect(got.small, `the sheet at ${width}: under 44px`).toEqual([]);
      } finally {
        await browser.close();
      }
    }, BROWSER_TIMEOUT_MS);

    it(`${width}px: a Pay refusal with its link fits, and every control near it is 44px or more`, async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for the ORG1b layout sweep; skipping (see CHROME_BIN)');
        return;
      }
      const jobId = `org1b-payshot-${width}`;
      const browser = await launch(width);
      try {
        await browser.send('Page.addScriptToEvaluateOnNewDocument', {
          source: `window.sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(session))});`,
        });
        await browser.goto(`${baseUrl}/deposit?job=${jobId}`, 1500);
        await browser.evaluate(`document.getElementById('pay-btn').click()`);
        const deadline = Date.now() + 8000;
        let link = '';
        while (Date.now() < deadline) {
          link = await browser.evaluate<string>(`(function () { var a = document.querySelector('#pay-error:not([hidden]) #pay-error-detail a'); return a ? a.getAttribute('href') : ''; })()`);
          if (link !== '') break;
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(link).toBe(`/private-repos?job=${jobId}`);
        expect(await browser.evaluate<boolean>(`document.getElementById('scan').hasAttribute('open')`), 'the scan opened on a refusal').toBe(false);
        await browser.evaluate(`document.getElementById('pay-error').scrollIntoView({ block: 'center' })`);
        await new Promise((r) => setTimeout(r, 300));
        await capture(browser, `deposit-pay-repository-409-${width}`, false);
        const got = await browser.evaluate<Sweep>(sweep('#pay-error a[href], #pay-btn, #back-to-agreement'));
        expect(got.measured, 'nothing to measure near the refusal').toBe(3);
        expect(got.past, `the page at ${width}: past the right edge`).toEqual([]);
        expect(got.scrollWidth, `the page at ${width}: sideways scroll`).toBe(got.clientWidth);
        // The walkthrough link at both widths. The two buttons take the
        // site's own button height: 44px on touch (320), 40px on a fine
        // pointer (1280), the same split the confirm sheet test above uses.
        expect(got.small.filter((s) => s.includes('pay-private-repos-link')), `the walkthrough link at ${width}`).toEqual([]);
        if (width === 320) expect(got.small, `the refusal at ${width}: under 44px`).toEqual([]);
      } finally {
        await browser.close();
      }
    }, BROWSER_TIMEOUT_MS);
  }

  it.each([['no-preference'], ['reduce']])('the steps end finished and still, prefers-reduced-motion: %s', async (motion) => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for the ORG1b layout sweep; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 1280, height: 900 });
    try {
      await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion }] });
      await browser.goto(`${baseUrl}/private-repos`, 1500);
      const read = (): Promise<{ matches: boolean; styles: string[] }> =>
        browser.evaluate(`({
          matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
          styles: [].map.call(document.querySelectorAll('main .reveal, main .stagger > *'), function (el) {
            var cs = getComputedStyle(el); return cs.opacity + '|' + cs.transform + '|' + cs.transitionDuration;
          })
        })`);
      const got = await read();
      expect(got.matches).toBe(motion === 'reduce');
      expect(got.styles).toHaveLength(5);
      if (motion === 'reduce') {
        // No transition at all, and already at the end.
        expect(got.styles).toEqual(Array(5).fill('1|none|0s'));
      } else {
        // In view, so revealed, and at rest once its transition has run.
        await new Promise((r) => setTimeout(r, 1200));
        const later = await read();
        expect(later.styles.map((s) => s.split('|').slice(0, 2).join('|'))).toEqual(Array(5).fill('1|none'));
      }
    } finally {
      await browser.close();
    }
  }, BROWSER_TIMEOUT_MS);
});
