// FIX-SW12m (SW3-08, SITEMAP P-17, ENT-10): the buyer of a completed hire
// writes a review from /review?job=<id>. POST /jobs/:jobId/reviews existed
// and no page reached it, and /review answered the not-found page. These
// pins drive the real app over HTTP with real sessions for the buyer, the
// agent's owner and a stranger, let the page's own script run in jsdom,
// and read what a visitor is left looking at. A write is read back from
// GET /agents/:agentDid/reviews, never from the page alone.
//
// (a) the form and the work beside it, (b) the write, (c) each refusal,
// (d) every state that is not the form, (f) no number anywhere, (g) the
// route and its rate class, and the layout in real Chrome at 320, 390 and
// 1280. (e), the job page's link, is in tests/web/job.test.ts.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { classifyRoute } from '../../src/api/rate-limit-classes.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
  MemoryReviewRepository,
} from '../../src/adapters/storage/memory.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';
import { createJob, type Job } from '../../src/domain/job.js';
import type { Delegation } from '../../src/domain/agent.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSessionToken } from '../helpers/session-fixtures.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const AGENT_DID = 'did:abt:rv-agent';
const OWNER_DID = 'did:abt:rv-owner';
const BUYER_DID = 'did:abt:rv-buyer';
const STRANGER_DID = 'did:abt:rv-stranger';
const REPO = 'buyer/rv-repo';
const PR = 'https://github.com/buyer/rv-repo/pull/7';
const RECENT = new Date(Date.now() - 60 * 60 * 1000);
const TEXT = 'It asked two good questions up front and the pull request matched the brief.';

// Every sentence the page can say, spelled once, asserted whole.
const SAY = {
  signin: 'Sign in to review this hire.',
  missing: 'We could not find that hire.',
  inFlight: 'You can review this hire once the work merges.',
  ended: 'Only a hire whose work merged can be reviewed.',
  notBuyer: 'Only the person who hired this agent can review this hire.',
  loadError: 'We could not read this hire. Reloading may work.',
  stays: 'Your review is public and stays attached to this job.',
  blank: 'Write something before posting.',
  expired: 'Your session has expired. Sign in again to post this.',
  forbidden: 'Only the buyer on this job may write a review for it.',
  already: 'This job already has a review.',
  storage: 'Storage is unavailable just now. Try again in a moment.',
  offline: 'Could not reach the server just now. Try again in a moment.',
};

function delegation(): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:delegation-for-${AGENT_DID}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: OWNER_DID,
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: AGENT_DID },
    proof: { type: 'Ed25519Signature2020', created: '2026-01-01T00:00:00Z', verificationMethod: `${AGENT_DID}#key-1`, proofPurpose: 'assertionMethod', proofValue: 'zfixture' },
  };
}

function job(id: string, overrides: Partial<Job> = {}): Job {
  const base = createJob({ id, buyerDid: BUYER_DID, agentDid: AGENT_DID, repository: REPO, brief: 'Fix the checkout flow' }, RECENT);
  return { ...base, ...overrides };
}
const done = (id: string): Job =>
  job(id, { status: 'completed', pullRequestUrl: PR, submittedAt: RECENT, mergeCommit: 'rvmerge', mergedAt: new Date('2026-09-02T12:00:00Z') });

let server: Server;
let baseUrl: string;
let reviewRepo: MemoryReviewRepository;
const tokens: Record<'buyer' | 'owner' | 'stranger', string> = { buyer: '', owner: '', stranger: '' };
type Who = keyof typeof tokens | null;

interface Post { path: string; auth: string | null; body: unknown }
interface Page { document: Document; window: JSDOM['window']; posts: Post[]; quiet: () => Promise<void>; close: () => void }
type Fault = (path: string, init?: RequestInit) => Response | 'network' | null;

async function render(path: string, who: Who, fault?: Fault): Promise<Page> {
  const res = await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } });
  expect(res.status, `GET ${path} as a page`).toBe(200);
  const markup = await res.text();
  const failures: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e: Error) => failures.push(e.message));
  const posts: Post[] = [];
  let inflight = 0;
  let lastSettle = Date.now();
  const settle = <T>(v: T): T => { inflight -= 1; lastSettle = Date.now(); return v; };
  const dom = new JSDOM(markup, {
    url: `${baseUrl}${path}`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      if (who !== null) window.sessionStorage.setItem('fa_session', JSON.stringify({ token: tokens[who] }));
      Object.defineProperty(window, 'fetch', {
        writable: true,
        value: (input: string, init?: RequestInit) => {
          if (init?.method === 'POST') {
            const headers = (init.headers ?? {}) as Record<string, string>;
            posts.push({ path: input, auth: headers.Authorization ?? null, body: JSON.parse(String(init.body ?? 'null')) });
          }
          inflight += 1;
          const faulted = fault ? fault(input, init) : null;
          if (faulted === 'network') return Promise.reject(new TypeError('Failed to fetch')).catch((e: unknown) => { settle(null); throw e; });
          if (faulted !== null) return Promise.resolve(faulted).then(settle);
          return fetch(new URL(input, baseUrl), init).then(settle, (e: unknown) => { settle(null); throw e; });
        },
      });
    },
  });
  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', () => resolve());
  });
  const quiet = async (): Promise<void> => {
    const deadline = Date.now() + 8000;
    while (inflight > 0 || Date.now() - lastSettle < 150) {
      if (Date.now() > deadline) throw new Error(`${path} kept reading past 8s`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  await quiet();
  const real = failures.filter((m) => !m.includes('Not implemented: navigation'));
  if (real.length > 0) throw new Error(`page script failed on ${path}: ${real.join('; ')}`);
  return { document: dom.window.document, window: dom.window, posts, quiet, close: () => dom.window.close() };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Visible means no [hidden] ancestor: the state a person is looking at.
function visible(page: Page, id: string): boolean {
  const node = page.document.getElementById(id);
  return node !== null && node.closest('[hidden]') === null;
}
const text = (page: Page, id: string): string => (page.document.getElementById(id)?.textContent ?? '').trim();
function hasForm(page: Page): boolean {
  const post = Array.from(page.document.querySelectorAll('button')).some((b) => (b.textContent ?? '').trim() === 'Post review');
  return page.document.querySelector('textarea') !== null || post;
}

function type(page: Page, value: string): void {
  (page.document.getElementById('rv') as HTMLTextAreaElement).value = value;
}
async function post(page: Page): Promise<void> {
  (page.document.getElementById('post-btn') as HTMLButtonElement).click();
  await page.quiet();
}

async function reviewsFor(jobId: string): Promise<Array<{ jobId: string; text: string }>> {
  const body = (await (await fetch(`${baseUrl}/agents/${encodeURIComponent(AGENT_DID)}/reviews`, { headers: { Accept: 'application/json' } })).json()) as { reviews: Array<{ jobId: string; text: string }> };
  return body.reviews.filter((r) => r.jobId === jobId);
}

beforeAll(async () => {
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({ did: AGENT_DID, operatorDid: OWNER_DID, delegation: delegation(), name: 'rv-scout', skills: ['triage'], githubLogin: null, floorPriceUsd: null });
  const accountRepo = new MemoryAccountRepository();
  for (const [did, login] of [[OWNER_DID, 'rv-owner'], [BUYER_DID, 'rv-buyer'], [STRANGER_DID, 'rv-stranger']] as const) {
    await accountRepo.register({ did, githubLogin: login });
  }
  const jobRepo = new MemoryJobRepository();
  const credentialRepo = new MemoryCredentialRepository();
  reviewRepo = new MemoryReviewRepository();
  let login = 'rv-owner';
  const adapter = createSessionAdapter({
    github: fakeGitHubConfig(),
    fetchImpl: ((input: string, init?: RequestInit) => fakeGitHubFetch({ login, id: login.length })(input, init)) as typeof fetch,
  });
  server = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, credentialRepo,
    { verify: 10_000, read: 10_000, write: 10_000, upstream: 10_000 }, undefined, reviewRepo, adapter).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tokens.owner = await mintSessionToken(adapter);
  login = 'rv-buyer';
  tokens.buyer = await mintSessionToken(adapter);
  login = 'rv-stranger';
  tokens.stranger = await mintSessionToken(adapter);

  const ids = ['rv-form', 'rv-post', 'rv-refuse', 'rv-race', 'rv-reviewed', 'rv-words', ...[320, 390, 1280].map((w) => `rv-layout-${w}`)];
  for (const id of ids) {
    await jobRepo.create(done(id));
    const doc: VerifiableCredential = {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      id: `https://freeagents.dev/v1/credentials/${id}`,
      type: ['VerifiableCredential', 'CompletedHireCredential'],
      issuer: 'did:abt:platform',
      validFrom: '2026-09-02T12:00:00.000Z',
      credentialSubject: {
        id: AGENT_DID,
        hire: { brief: 'sha256:rv-brief', repository: REPO, pullRequest: PR, mergedAt: '2026-09-02T12:00:00.000Z', mergeCommit: 'rvmerge', signedBy: `${AGENT_DID}#key-1`, buyer: BUYER_DID, additions: 12, deletions: 3, filesChanged: 2 },
      },
      proof: { type: 'Ed25519Signature2020', proofValue: 'zRvProof' },
    };
    await credentialRepo.save({ completedJobId: id, subjectDid: AGENT_DID, document: doc, repositoryPublic: true });
  }
  await jobRepo.create(job('rv-submitted', { status: 'submitted', pullRequestUrl: PR, submittedAt: RECENT }));
  await jobRepo.create(job('rv-deemed', { status: 'deemed_completed', pullRequestUrl: PR, submittedAt: RECENT }));
  // Paid in full, and the pull request never opened within seven days.
  await jobRepo.create(job('rv-paid-undelivered', { status: 'paid_undelivered', stagedAt: RECENT, stagedCommit: 'rvstaged' }));
  await reviewRepo.save({ jobId: 'rv-reviewed', authorDid: BUYER_DID, agentDid: AGENT_DID, text: 'Already said my piece.', createdAt: new Date('2026-09-03T12:00:00Z') });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('(a) the buyer of a completed hire sees the form, with the work beside it', () => {
  it('/review?job=<completed> answers 200 and shows the form, the repository, the receipt and the pull request', async () => {
    const page = await render('/review?job=rv-form', 'buyer');
    try {
      expect(visible(page, 'review-form')).toBe(true);
      expect(visible(page, 'rv')).toBe(true);
      expect(text(page, 'post-btn')).toBe('Post review');
      expect(text(page, 'review-heading')).toBe('How did this go?');
      expect(text(page, 'subject-title')).toBe(REPO);
      expect(text(page, 'subject-shipped')).toMatch(/^Shipped on .*2026$/);
      const receipt = page.document.getElementById('receipt-link')!;
      expect([visible(page, 'receipt-link'), receipt.getAttribute('href'), receipt.textContent]).toEqual([true, '/v1/credentials/rv-form', 'See the receipt']);
      const pr = page.document.getElementById('pr-link')!;
      expect([visible(page, 'pr-link'), pr.getAttribute('href'), pr.getAttribute('target'), pr.getAttribute('rel')]).toEqual([true, PR, '_blank', 'noopener']);
      expect(text(page, 'agent-name')).toBe('rv-scout');
      // Not now and Back to the job both return to the hire.
      expect(page.document.getElementById('notnow-link')?.getAttribute('href')).toBe('/jobs/rv-form');
      expect(page.document.getElementById('back-link')?.getAttribute('href')).toBe('/jobs/rv-form');
      // The 1200-character budget is maxlength, and the counter reads it.
      const area = page.document.getElementById('rv')!;
      expect([area.getAttribute('maxlength'), area.getAttribute('data-counter')]).toEqual(['1200', 'c-rv']);
      expect(text(page, 'c-rv')).toBe('0 / 1200');
      // The refusal node is an alert from the moment the page is built.
      expect([page.document.getElementById('form-error')?.getAttribute('role'), text(page, 'form-error')]).toEqual(['alert', '']);
    } finally {
      page.close();
    }
  });
});

describe('(b) Post review sends one POST and shows what the server kept', () => {
  it('exactly one POST with { agentDid, text } and the bearer token; on 201 the form is gone and the review shows read-only', async () => {
    const page = await render('/review?job=rv-post', 'buyer');
    try {
      type(page, `  ${TEXT}  `);
      const btn = page.document.getElementById('post-btn') as HTMLButtonElement;
      btn.click();
      expect(btn.disabled, 'the button is disabled while the write runs').toBe(true);
      btn.click();
      await page.quiet();
      expect(page.posts).toEqual([{ path: '/jobs/rv-post/reviews', auth: `Bearer ${tokens.buyer}`, body: { agentDid: AGENT_DID, text: TEXT } }]);
      expect(hasForm(page)).toBe(false);
      expect(visible(page, 'posted')).toBe(true);
      expect(text(page, 'posted-text')).toBe(TEXT);
      expect(text(page, 'posted-date')).toMatch(/^Posted on .*\d{4}$/);
      expect(page.document.getElementById('posted-back')?.getAttribute('href')).toBe('/jobs/rv-post');
      expect((await reviewsFor('rv-post')).map((r) => r.text)).toEqual([TEXT]);
    } finally {
      page.close();
    }
  });
});

describe('(c) every refusal says one whole sentence and keeps what was typed', () => {
  it('blank text sends nothing and says so', async () => {
    const page = await render('/review?job=rv-refuse', 'buyer');
    try {
      type(page, '   \n ');
      await post(page);
      expect(page.posts).toEqual([]);
      expect(text(page, 'form-error')).toBe(SAY.blank);
    } finally {
      page.close();
    }
  });

  const REVIEWS = /^\/jobs\/rv-refuse\/reviews$/;
  it.each([
    ['a 401 (the session expired)', SAY.expired, 'expired', undefined],
    ['a 403', SAY.forbidden, 'buyer', (p: string) => (REVIEWS.test(p) ? json(403, { error: 'only the buyer on this job may write a review for it' }) : null)],
    ['a 503', SAY.storage, 'buyer', (p: string) => (REVIEWS.test(p) ? json(503, { error: 'storage unavailable' }) : null)],
    ['a network failure', SAY.offline, 'buyer', (p: string) => (REVIEWS.test(p) ? 'network' as const : null)],
  ] as const)('%s', async (_what, sentence, who, fault) => {
    const page = await render('/review?job=rv-refuse', 'buyer', fault as Fault | undefined);
    try {
      if (who === 'expired') page.window.sessionStorage.setItem('fa_session', JSON.stringify({ token: 'no-such-token' }));
      type(page, TEXT);
      await post(page);
      expect(page.posts.length).toBe(1);
      expect(text(page, 'form-error')).toBe(sentence);
      expect(page.document.getElementById('form-error')?.getAttribute('role')).toBe('alert');
      expect((page.document.getElementById('rv') as HTMLTextAreaElement).value).toBe(TEXT);
      expect(visible(page, 'resignin-link'), 'Sign in is offered only after a 401').toBe(who === 'expired');
    } finally {
      page.close();
    }
    expect(await reviewsFor('rv-refuse')).toEqual([]);
  });

  it('a 409 (a review landed after the page loaded) says the job already has one', async () => {
    const page = await render('/review?job=rv-race', 'buyer');
    try {
      const first = await fetch(`${baseUrl}/jobs/rv-race/reviews`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${tokens.buyer}` }, body: JSON.stringify({ agentDid: AGENT_DID, text: 'From another tab.' }) });
      expect(first.status).toBe(201);
      type(page, TEXT);
      await post(page);
      expect(text(page, 'form-error')).toBe(SAY.already);
      expect((page.document.getElementById('rv') as HTMLTextAreaElement).value).toBe(TEXT);
    } finally {
      page.close();
    }
  });
});

describe('(d) everyone else sees one sentence and no form', () => {
  const failJob: Fault = (p) => (p === '/jobs/rv-form' ? json(503, { error: 'storage unavailable' }) : null);
  const failReviews: Fault = (p) => (p.endsWith('/reviews') ? json(503, { error: 'storage unavailable' }) : null);
  it.each([
    ['signed out', '/review?job=rv-form', null, 'signin-required', SAY.signin, undefined],
    ['no such hire', '/review?job=rv-nope', 'buyer', 'missing', SAY.missing, undefined],
    ['no job in the address', '/review', 'buyer', 'missing', SAY.missing, undefined],
    ['a submitted hire', '/review?job=rv-submitted', 'buyer', 'not-finished', SAY.inFlight, undefined],
    ['a deemed-completed hire', '/review?job=rv-deemed', 'buyer', 'not-finished', SAY.ended, undefined],
    ['a signed-in stranger', '/review?job=rv-form', 'stranger', 'not-buyer', SAY.notBuyer, undefined],
    ['the agent\u2019s owner', '/review?job=rv-form', 'owner', 'not-buyer', SAY.notBuyer, undefined],
    ['a failed job read', '/review?job=rv-form', 'buyer', 'load-error', SAY.loadError, failJob],
    ['a failed reviews read', '/review?job=rv-form', 'buyer', 'load-error', SAY.loadError, failReviews],
  ] as const)('%s', async (_what, path, who, state, sentence, fault) => {
    const page = await render(path, who, fault);
    try {
      expect(visible(page, state), `#${state} is showing`).toBe(true);
      expect(text(page, state)).toContain(sentence);
      expect(hasForm(page)).toBe(false);
      expect(visible(page, 'review-body')).toBe(false);
    } finally {
      page.close();
    }
  });

  it('a hire paid in full that ended with no pull request gets the ended sentence and no form', async () => {
    const page = await render('/review?job=rv-paid-undelivered', 'buyer');
    try {
      expect(visible(page, 'not-finished'), '#not-finished is showing').toBe(true);
      expect(text(page, 'not-finished-sentence')).toBe('Only a hire whose work merged can be reviewed.');
      expect(hasForm(page)).toBe(false);
      expect(visible(page, 'review-body')).toBe(false);
    } finally {
      page.close();
    }
  });

  it('signed out: Sign in remembers this page, so signing in comes back here', async () => {
    const page = await render('/review?job=rv-form', null);
    try {
      (page.document.getElementById('signin-link') as HTMLAnchorElement).click();
      expect(page.window.sessionStorage.getItem('fa_return_to')).toBe('/review?job=rv-form');
    } finally {
      page.close();
    }
  });

  it('a review already written shows read-only, with its date, and no form', async () => {
    const page = await render('/review?job=rv-reviewed', 'buyer');
    try {
      expect(hasForm(page)).toBe(false);
      expect([visible(page, 'posted'), text(page, 'posted-text')]).toEqual([true, 'Already said my piece.']);
      expect(text(page, 'posted')).toContain(SAY.stays);
      expect(text(page, 'posted-date')).toMatch(/^Posted on .*2026$/);
    } finally {
      page.close();
    }
  });
});

describe('(f) no star, rating, score or average anywhere (ENT-10.2)', () => {
  it('the form, and the posted review, carry no number control and no score word', async () => {
    const form = await render('/review?job=rv-words', 'buyer');
    const posted = await render('/review?job=rv-reviewed', 'buyer');
    try {
      for (const page of [form, posted]) {
        const words = (page.document.body.textContent ?? '').toLowerCase();
        expect(words).not.toMatch(/\b[1-5](\.\d)?\s*(star|\/\s*5|out of 5)/);
        expect(words).not.toMatch(/\b(stars?|rating|ratings|rated|score|scores|average)\b/);
        const controls = page.document.querySelectorAll('input[type="range"], input[type="number"], [role="slider"], [class*="star" i], [data-rating], [data-score]');
        expect(controls.length).toBe(0);
      }
    } finally {
      form.close();
      posted.close();
    }
  });
});

describe('(g) the route and its rate class', () => {
  it('GET /review serves the page shell as html', async () => {
    const res = await fetch(`${baseUrl}/review?job=rv-form`, { headers: { Accept: HTML } });
    expect([res.status, String(res.headers.get('content-type')).includes('text/html')]).toEqual([200, true]);
  });

  it('GET /review is exempt as a page shell, and the write it calls stays a write', () => {
    expect(classifyRoute('GET', '/review')).toBe('exempt');
    expect(classifyRoute('POST', '/jobs/j-1/reviews')).toBe('write');
  });
});

// ---------------------------------------------------------------- layout

const captureDir = process.env.REVIEW_CAPTURE_DIR ?? '';
async function capture(browser: RealBrowser, name: string): Promise<void> {
  if (captureDir === '') return;
  mkdirSync(captureDir, { recursive: true });
  const shot = (await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })) as { result?: { data?: string } };
  if (shot.result?.data) writeFileSync(join(captureDir, `${name}.png`), Buffer.from(shot.result.data, 'base64'));
}

// Every visible link, button and field in <main> named by selector, and
// the page's width.
const sweep = (selector: string): string => `(function () {
  var doc = document.documentElement;
  var els = [].filter.call(document.querySelectorAll(${JSON.stringify(selector)}), function (el) {
    var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
  });
  return {
    scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth,
    names: els.map(function (el) { return el.id || el.tagName; }),
    small: els.filter(function (el) { var r = el.getBoundingClientRect(); return r.height < 44; })
      .map(function (el) { return (el.id || el.tagName) + ' ' + Math.round(el.getBoundingClientRect().height); })
  };
})()`;
interface Swept { scrollWidth: number; clientWidth: number; names: string[]; small: string[] }

async function waitFor(browser: RealBrowser, expression: string): Promise<boolean> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await browser.evaluate<boolean>(expression)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe('laid out right in real Chrome: the form, the posted review and the job page\u2019s link', () => {
  it.each([[320, true], [390, true], [1280, false]] as const)('%ipx (touch: %s): no sideways scroll; /review 44px everywhere, the job page 44px on touch', async (width, touch) => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for the review layout sweep; skipping (see CHROME_BIN)');
      return;
    }
    const id = `rv-layout-${width}`;
    const browser = await RealBrowser.launch({ width, height: 900 });
    try {
      if (touch) {
        await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 2, mobile: true });
        await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      }
      await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify({ token: tokens.buyer }))});` });
      const check = async (state: string, selector: string, want: string[], floor = true): Promise<void> => {
        const got = await browser.evaluate<Swept>(sweep(selector));
        expect(got.names, `${state}: the controls measured`).toEqual(want);
        expect(got.scrollWidth, `${state} at ${width}: sideways scroll`).toBe(got.clientWidth);
        if (floor) expect(got.small, `${state} at ${width}: under 44px`).toEqual([]);
      };
      const MAIN = 'main a[href], main button, main textarea';
      await browser.goto(`${baseUrl}/review?job=${id}`, 300);
      expect(await waitFor(browser, `!document.getElementById('review-body').hidden && document.getElementById('agent-name').textContent === 'rv-scout'`), 'the form').toBe(true);
      await check('the form', MAIN, ['back-link', 'receipt-link', 'pr-link', 'rv', 'post-btn', 'notnow-link']);
      await capture(browser, `review-form-${width}`);
      await browser.evaluate(`(function () { document.getElementById('rv').value = ${JSON.stringify(TEXT)}; document.getElementById('post-btn').click(); })()`);
      expect(await waitFor(browser, `!document.getElementById('posted').hidden`), 'the posted state').toBe(true);
      await check('the posted state', MAIN, ['back-link', 'receipt-link', 'pr-link', 'posted-back']);
      await capture(browser, `review-posted-${width}`);
      await browser.goto(`${baseUrl}/jobs/${id}`, 300);
      expect(await waitFor(browser, `!!document.getElementById('review-link')`), 'Write a review on the job page').toBe(true);
      // /review sets its 44px floor at every width. The job page's buttons
      // take polish.css's floor on a phone and base.css's 40px with a
      // mouse, the same as every other button on that page, so the floor
      // is held on the two phone widths there.
      await check('the completed job page', '#credential-section a', ['credential-link', 'review-link'], touch);
      await capture(browser, `job-completed-${width}`);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
