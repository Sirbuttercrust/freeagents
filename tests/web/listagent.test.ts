// FIX-B41c: the list-an-agent page (/listagent), driven end to end against
// the real app with memory repositories and real sessions, the discipline
// tests/web/myagents.test.ts holds to. POST /agents, GET /accounts/me and
// GET /agents/:did are exercised for real, never stubbed. Letters match the
// card's test list.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import { createKnownKeyStore } from '../../src/adapters/identity/did-abt-resolver.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import type { Session } from '../../src/adapters/identity/session.js';
import { MemoryAccountRepository, MemoryAgentRepository } from '../../src/adapters/storage/memory.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession } from '../helpers/session-fixtures.js';
import { createPasskeyFixture } from '../helpers/webauthn-fixtures.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const here = dirname(fileURLToPath(import.meta.url));
const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const PLATFORM_SEED = 'c41'.padEnd(64, '7');
const BROWSER_TIMEOUT_MS = 90_000;
const CEILING = "Until its GitHub account is confirmed, nobody can pay for this agent's work.";

let server: Server;
let baseUrl: string;
let accountRepo: MemoryAccountRepository;
let originalSeed: string | undefined;
let githubOwner: Session;
let passkeyOwner: Session;
let walletOwner: Session;
let nextLogin = '';
let sessionAdapter: ReturnType<typeof createSessionAdapter>;

beforeAll(async () => {
  originalSeed = process.env.FREEAGENTS_PLATFORM_SEED;
  process.env.FREEAGENTS_PLATFORM_SEED = PLATFORM_SEED;
  accountRepo = new MemoryAccountRepository();
  sessionAdapter = createSessionAdapter({
    github: fakeGitHubConfig(),
    fetchImpl: ((input: string | URL | Request, init?: RequestInit) => fakeGitHubFetch({ login: nextLogin, id: 4100 })(input, init)) as typeof fetch,
    passkey: { rpName: 'FreeAgents test', rpID: 'localhost', origin: 'http://localhost:3000' },
  });
  server = createApp(
    accountRepo, new MemoryAgentRepository(), createIdentityAdapter(createKnownKeyStore()),
    undefined, undefined, undefined, undefined, undefined,
    { verify: 10_000, read: 10_000, write: 10_000, upstream: 10_000 }, undefined, undefined, sessionAdapter,
  ).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  nextLogin = 'listagent-owner';
  githubOwner = await mintSession(sessionAdapter);
  // A wallet-registered account: its DID was not derived by the platform,
  // so the site path answers 409 for it.
  await accountRepo.register({ did: 'did:abt:zListagentWalletOwner', githubLogin: 'listagent-wallet-owner' });
  nextLogin = 'listagent-wallet-owner';
  walletOwner = await mintSession(sessionAdapter);

  const subject = 'listagent-passkey-owner';
  const { optionsJson } = await sessionAdapter.registerPasskey(subject);
  const { challenge } = JSON.parse(optionsJson) as { challenge: string };
  const response = createPasskeyFixture().registrationResponse(challenge, 'localhost');
  const session = await sessionAdapter.verifyPasskey(JSON.stringify({ subject, response }));
  if (session === null) throw new Error('expected a passkey session');
  passkeyOwner = session;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (originalSeed === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
  else process.env.FREEAGENTS_PLATFORM_SEED = originalSeed;
});

// ------------------------------------------------------------ the harness

interface Call { readonly path: string; readonly method: string; readonly body: Record<string, unknown> | null; readonly authed: boolean }
interface Page { window: JSDOM['window']; document: Document; calls: Call[]; close: () => void }

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
}

async function render(path: string, session: Session | null, storage: Record<string, string> = {}): Promise<Page> {
  const failures: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e: Error) => failures.push(e.message));
  const markup = await (await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } })).text();
  const calls: Call[] = [];
  const dom = new JSDOM(markup, {
    url: `${baseUrl}${path}`, runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      if (session !== null) window.sessionStorage.setItem('fa_session', JSON.stringify(session));
      for (const [k, v] of Object.entries(storage)) window.sessionStorage.setItem(k, v);
      Object.defineProperty(window, 'fetch', {
        writable: true,
        value: (input: string, init?: RequestInit) => {
          const headers = (init?.headers ?? {}) as Record<string, string>;
          calls.push({
            path: String(input), method: (init?.method ?? 'GET').toUpperCase(),
            body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
            authed: typeof headers.Authorization === 'string',
          });
          return fetch(new URL(input, baseUrl), init);
        },
      });
    },
  });
  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', () => resolve());
  });
  const d = dom.window.document;
  await until(() => ['signin-required', 'load-error', 'list-body', 'myagents-body'].some((id) => d.getElementById(id)?.hidden === false) || path !== '/listagent' && path !== '/myagents');
  await new Promise((r) => setTimeout(r, 100));
  if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);
  return { window: dom.window, document: d, calls, close: () => dom.window.close() };
}

function type(page: Page, id: string, value: string): void {
  const input = page.document.getElementById(id) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new page.window.Event('input', { bubbles: true }));
}

const posts = (page: Page): Call[] => page.calls.filter((c) => c.method === 'POST' && c.path === '/agents');
const shown = (page: Page, id: string): boolean => (page.document.getElementById(id) as HTMLElement | null)?.hidden === false;

async function create(page: Page): Promise<void> {
  const before = posts(page).length;
  (page.document.getElementById('create-btn') as HTMLButtonElement).click();
  await until(() => posts(page).length > before);
  await until(() => shown(page, 'created') || shown(page, 'form-error'));
}

async function readAgent(did: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/agents/${encodeURIComponent(did)}`, { headers: { Accept: 'application/json' } });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

// The hire journey's machine-word gate, same lists (hire-journey-simple.test.ts).
const JARGON = ['credential', 'credentials', 'attestation', 'attested', 'hash', 'hashes', 'Ed25519', 'settlement', 'settle', 'settles', 'settled', 'rail', 'rails', 'specHash', 'diffHash', 'delegation'];
function machineWords(page: Page): string[] {
  const main = page.document.querySelector('main')!.cloneNode(true) as HTMLElement;
  main.querySelectorAll('[hidden], script, style').forEach((el) => el.remove());
  const text = main.textContent ?? '';
  return [
    ...JARGON.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(text)),
    ...['DID', 'DIDs'].filter((w) => new RegExp(`\\b${w}\\b`).test(text)),
    ...(/\bdid:[a-z0-9]+:/i.test(text) ? ['a DID string'] : []),
  ];
}

// ----------------------------------------------------------------- (a)

describe('(a) signed out', () => {
  it('shows the sign-in prompt and makes no authenticated request', async () => {
    const page = await render('/listagent', null);
    try {
      expect(shown(page, 'signin-required')).toBe(true);
      expect(shown(page, 'list-body')).toBe(false);
      expect(page.document.getElementById('signin-link')?.getAttribute('href')).toBe('/signin');
      expect(page.calls.filter((c) => c.authed)).toEqual([]);
      expect(page.calls.some((c) => c.path.includes('/accounts/me'))).toBe(false);
    } finally {
      page.close();
    }
  });

  it('a stored session the server does not know shows the sign-in prompt, not the load error', async () => {
    const stale = { ...githubOwner, token: 'no-such-token-listagent' } as Session;
    const page = await render('/listagent', stale);
    try {
      expect(page.calls.some((c) => c.path.includes('/accounts/me') && c.authed)).toBe(true);
      expect(shown(page, 'signin-required')).toBe(true);
      expect(shown(page, 'load-error')).toBe(false);
      expect(shown(page, 'list-body')).toBe(false);
    } finally {
      page.close();
    }
  });
});

// ----------------------------------------------------------------- (b)

describe('(b) a GitHub owner lists an agent', () => {
  it('posts once with no did, delegation or operator; the agent reads back and appears on /myagents', async () => {
    const page = await render('/listagent', githubOwner);
    let did = '';
    try {
      expect(shown(page, 'list-body')).toBe(true);
      type(page, 'nm', 'pixel-scout');
      type(page, 'ds', 'Turns a Figma file into a typed React component.');
      type(page, 'sk', ' React, , TypeScript ,react');
      type(page, 'fl', '40.5');
      await create(page);
      expect(posts(page)).toHaveLength(1);
      const body = posts(page)[0]!.body!;
      expect(Object.keys(body).sort()).toEqual(['description', 'floorPriceUsd', 'name', 'skills']);
      expect(body).toEqual({ name: 'pixel-scout', description: 'Turns a Figma file into a typed React component.', skills: ['React', 'TypeScript'], floorPriceUsd: '40.50' });
      expect(shown(page, 'created')).toBe(true);
      expect(shown(page, 'list-body')).toBe(false);
      expect(page.document.getElementById('created-heading')?.textContent).toBe('pixel-scout is listed.');
      const href = page.document.getElementById('agent-link')?.getAttribute('href') ?? '';
      expect(href.startsWith('/agents/')).toBe(true);
      did = decodeURIComponent(href.slice('/agents/'.length));
    } finally {
      page.close();
    }
    const agent = await readAgent(did);
    expect(agent).toMatchObject({ name: 'pixel-scout', description: 'Turns a Figma file into a typed React component.', skills: ['React', 'TypeScript'], floorPriceUsd: '40.50' });
    const roster = await render('/myagents', githubOwner);
    try {
      await until(() => roster.document.querySelector(`[data-agent-row="${did}"]`) !== null);
      expect(roster.document.querySelector(`[data-agent-row="${did}"] .nm`)?.textContent).toBe('pixel-scout');
    } finally {
      roster.close();
    }
  });

  it('posts once however often Create is pressed while the first request is out', async () => {
    const page = await render('/listagent', githubOwner);
    try {
      type(page, 'nm', 'posts-once');
      type(page, 'sk', 'triage');
      const btn = page.document.getElementById('create-btn') as HTMLButtonElement;
      const form = page.document.getElementById('list-form') as HTMLFormElement;
      btn.click();
      expect(btn.disabled, 'Create is disabled while the request is out').toBe(true);
      // Enter in a field submits the form without the button, so the
      // disabled button alone does not stop a second post.
      form.dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
      btn.click();
      await until(() => shown(page, 'created'));
      await new Promise((r) => setTimeout(r, 200));
      expect(posts(page)).toHaveLength(1);
    } finally {
      page.close();
    }
  });
});

// ----------------------------------------------------------------- (c)

describe('(c) the GitHub box, and the ceiling', () => {
  it('ticked, sends the account\u2019s own login, and the agent reads back verified with no ceiling', async () => {
    const page = await render('/listagent', githubOwner);
    try {
      expect(shown(page, 'gh-field')).toBe(true);
      expect(page.document.getElementById('gh-login')?.textContent).toBe('listagent-owner');
      const box = page.document.getElementById('gh') as HTMLInputElement;
      expect(box.checked, 'the box starts unticked').toBe(false);
      box.click();
      type(page, 'nm', 'own-account-agent');
      type(page, 'sk', 'triage');
      await create(page);
      expect(posts(page)[0]!.body!.githubLogin).toBe('listagent-owner');
      expect(shown(page, 'ceiling')).toBe(false);
      expect(shown(page, 'gh-confirm'), 'Confirm GitHub on a verified agent').toBe(false);
      const did = decodeURIComponent((page.document.getElementById('agent-link')?.getAttribute('href') ?? '').slice(8));
      expect((await readAgent(did)).proofStatus).toBe('verified');
    } finally {
      page.close();
    }
  });

  it('unticked, sends no login and the created state shows the ceiling', async () => {
    const page = await render('/listagent', githubOwner);
    try {
      type(page, 'nm', 'other-account-agent');
      type(page, 'sk', 'triage');
      await create(page);
      expect('githubLogin' in posts(page)[0]!.body!).toBe(false);
      expect(shown(page, 'ceiling')).toBe(true);
    } finally {
      page.close();
    }
  });

  it('a passkey owner sees no box, sends no login, and after Create sees the ceiling', async () => {
    const me = (await (await fetch(`${baseUrl}/accounts/me`, { headers: { Accept: 'application/json', Authorization: `Bearer ${passkeyOwner.token}` } })).json()) as Record<string, unknown>;
    expect(me.githubLogin, 'what GET /accounts/me answers for a passkey account').toBeNull();
    const page = await render('/listagent', passkeyOwner);
    try {
      expect(shown(page, 'list-body')).toBe(true);
      expect(shown(page, 'gh-field')).toBe(false);
      type(page, 'nm', 'passkey-agent');
      type(page, 'sk', 'triage');
      await create(page);
      expect('githubLogin' in posts(page)[0]!.body!).toBe(false);
      expect(shown(page, 'ceiling')).toBe(true);
      expect(page.document.getElementById('ceiling')?.textContent?.trim()).toBe(CEILING);
    } finally {
      page.close();
    }
  });

  it('the box carries no line saying it can only be set now: the account can be confirmed later', () => {
    const src = readFileSync(join(here, '../../src/web/pages/listagent.html'), 'utf8');
    expect(src).not.toContain('It can only be set now.');
  });

  // GET /accounts/me answers the GitHub account's login for this token, but
  // the stored session does not prove it: it is not a GitHub sign-in, or it
  // names another login. The saved draft asks for the box ticked, so a page
  // that trusted the account alone would send the login.
  it.each([
    ['not a GitHub sign-in', { method: 'passkey' }],
    ['a GitHub sign-in naming another login', { subject: 'someone-else' }],
  ])('%s: no box, and no login sent', async (_label, change) => {
    const unproved = { ...githubOwner, ...change } as Session;
    const draft = JSON.stringify({ nm: 'unproved-agent', ds: '', sk: 'triage', fl: '', gh: true });
    const page = await render('/listagent', unproved, { fa_listagent_draft: draft });
    try {
      expect(shown(page, 'list-body')).toBe(true);
      expect(shown(page, 'gh-field')).toBe(false);
      await create(page);
      expect(posts(page)).toHaveLength(1);
      expect('githubLogin' in posts(page)[0]!.body!).toBe(false);
      expect(shown(page, 'ceiling')).toBe(true);
    } finally {
      page.close();
    }
  });
});

// ----------------------------------------------------------------- (j)

// FIX-B47c: the created state's Confirm GitHub, lettered after (i) and
// kept beside (c), the ceiling it sits under. jsdom cannot follow a real
// navigation; hire-flow.test.ts's seam (whatwg-url's parseURL) records the
// URL the page asked to go to.
const whatwgURL = createRequire(import.meta.url)('whatwg-url') as { parseURL: (v: string, o?: unknown) => unknown };
function captureNavigations(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = whatwgURL.parseURL;
  whatwgURL.parseURL = function (this: unknown, v: string, o?: unknown) { calls.push(v); return original.call(this, v, o); };
  return { calls, restore: () => { whatwgURL.parseURL = original; } };
}

describe('(j) Confirm GitHub on the created state', () => {
  it('an unverified agent: the button under the ceiling, the one primary; a press sends one start and goes to GitHub', async () => {
    const page = await render('/listagent', passkeyOwner);
    const nav = captureNavigations();
    try {
      type(page, 'nm', 'confirm-after');
      type(page, 'sk', 'triage');
      await create(page);
      const did = decodeURIComponent((page.document.getElementById('agent-link')?.getAttribute('href') ?? '').slice(8));
      const btn = page.document.getElementById('gh-confirm') as HTMLButtonElement;
      expect(shown(page, 'ceiling')).toBe(true);
      expect(shown(page, 'gh-confirm')).toBe(true);
      expect(btn.textContent).toBe('Confirm GitHub');
      const ceiling = page.document.getElementById('ceiling')!;
      expect(ceiling.compareDocumentPosition(btn) & page.window.Node.DOCUMENT_POSITION_FOLLOWING, 'the button sits under the ceiling').toBeTruthy();
      const primaries = Array.from(page.document.querySelectorAll('#created .btn-primary')).filter((el) => !(el as HTMLElement).closest('[hidden]'));
      expect(primaries.map((el) => el.id)).toEqual(['gh-confirm']);
      expect(page.document.getElementById('gh-error')?.getAttribute('role'), 'a live region before any sentence').toBe('alert');
      btn.click();
      btn.click();
      await until(() => nav.calls.some((v) => v.startsWith('https://github.com/')));
      await new Promise((r) => setTimeout(r, 150));
      const starts = page.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/github-proof/start'));
      expect(starts.map((c) => c.path)).toEqual([`/agents/${encodeURIComponent(did)}/github-proof/start`]);
      expect(starts[0]!.authed).toBe(true);
      const went = nav.calls.filter((v) => v.startsWith('https://github.com/'));
      expect(went).toHaveLength(1);
      expect(new URL(went[0]!).pathname).toBe('/login/oauth/authorize');
      expect(new URL(went[0]!).searchParams.get('scope')).toBe('gist');
    } finally {
      nav.restore();
      page.close();
    }
  });

  it('a refused press says its sentence under the buttons and goes nowhere', async () => {
    const page = await render('/listagent', passkeyOwner);
    const nav = captureNavigations();
    try {
      type(page, 'nm', 'confirm-refused');
      type(page, 'sk', 'triage');
      await create(page);
      page.window.sessionStorage.setItem('fa_session', JSON.stringify({ ...passkeyOwner, token: 'no-such-token-listagent' }));
      (page.document.getElementById('gh-confirm') as HTMLButtonElement).click();
      await until(() => page.document.getElementById('gh-error')?.textContent !== '');
      expect(page.document.getElementById('gh-error')?.textContent).toBe('Your session has expired. Sign in again to confirm it.');
      expect(shown(page, 'gh-error')).toBe(true);
      expect(nav.calls.filter((v) => v.startsWith('https://github.com/'))).toEqual([]);
      expect((page.document.getElementById('gh-confirm') as HTMLButtonElement).disabled).toBe(false);
      expect(machineWords(page)).toEqual([]);
    } finally {
      nav.restore();
      page.close();
    }
  });
});

// ----------------------------------------------------------------- (d)

describe('(d) refusals keep every value and never show success', () => {
  async function refused(page: Page): Promise<void> {
    expect(shown(page, 'form-error')).toBe(true);
    expect(shown(page, 'created')).toBe(false);
    expect(shown(page, 'list-body')).toBe(true);
    expect(machineWords(page)).toEqual([]);
  }

  it('a 400 from the server (a description past 160 characters) gets a plain sentence', async () => {
    const page = await render('/listagent', githubOwner);
    try {
      const long = 'x'.repeat(161);
      type(page, 'nm', 'too-long');
      type(page, 'ds', long);
      type(page, 'sk', 'triage');
      type(page, 'fl', '12');
      await create(page);
      expect(posts(page)).toHaveLength(1);
      await refused(page);
      expect(page.document.getElementById('form-error-detail')?.textContent).toMatch(/160 characters/);
      expect(['nm', 'ds', 'sk', 'fl'].map((id) => (page.document.getElementById(id) as HTMLInputElement).value)).toEqual(['too-long', long, 'triage', '12']);
    } finally {
      page.close();
    }
  });

  it('a 409 for a wallet-registered account names the wallet, not the account\u2019s DID', async () => {
    const page = await render('/listagent', walletOwner);
    try {
      type(page, 'nm', 'wallet-agent');
      type(page, 'sk', 'triage');
      await create(page);
      await refused(page);
      expect(page.document.getElementById('form-error-detail')?.textContent).toMatch(/wallet/);
      expect((page.document.getElementById('nm') as HTMLInputElement).value).toBe('wallet-agent');
    } finally {
      page.close();
    }
  });

  it('a session ended between load and Create gets a real 401 and the sign-in sentence', async () => {
    nextLogin = 'listagent-owner';
    const soon = await mintSession(sessionAdapter);
    const page = await render('/listagent', soon);
    try {
      expect(shown(page, 'list-body')).toBe(true);
      const out = await fetch(`${baseUrl}/auth/signout`, { method: 'POST', headers: { Authorization: `Bearer ${soon.token}` } });
      expect(out.status).toBe(204);
      type(page, 'nm', 'ended-session');
      type(page, 'sk', 'triage');
      await create(page);
      expect(posts(page)).toHaveLength(1);
      await refused(page);
      expect(page.document.getElementById('form-error-detail')?.textContent).toBe('Your session has expired. Sign in again to create this listing.');
      expect(['nm', 'sk'].map((id) => (page.document.getElementById(id) as HTMLInputElement).value)).toEqual(['ended-session', 'triage']);
    } finally {
      page.close();
    }
  });

  it.each([['40.5.0'], ['forty'], ['-3']])('a price of "%s" is refused before any request', async (floor) => {
    const page = await render('/listagent', githubOwner);
    try {
      type(page, 'nm', 'price-check');
      type(page, 'sk', 'triage');
      type(page, 'fl', floor);
      (page.document.getElementById('create-btn') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 200));
      expect(posts(page)).toEqual([]);
      await refused(page);
      expect(page.document.getElementById('form-error-detail')?.textContent).toBe('Write the price in dollars and cents, like 40.00.');
      expect((page.document.getElementById('fl') as HTMLInputElement).value).toBe(floor);
    } finally {
      page.close();
    }
  });

  it('no name, or no skill after trimming, is refused before any request', async () => {
    const page = await render('/listagent', githubOwner);
    try {
      type(page, 'sk', 'triage');
      (page.document.getElementById('create-btn') as HTMLButtonElement).click();
      expect(page.document.getElementById('form-error-detail')?.textContent).toBe('Give the agent a name.');
      type(page, 'nm', 'named');
      type(page, 'sk', ' , ,');
      (page.document.getElementById('create-btn') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 200));
      expect(page.document.getElementById('form-error-detail')?.textContent).toBe('Add at least one skill.');
      expect(posts(page)).toEqual([]);
    } finally {
      page.close();
    }
  });
});

// ----------------------------------------------------------------- (e)

describe('(e) a half-filled form survives a reload, and a 201 clears it', () => {
  it('restores every typed value and the box after a reload, then clears the draft on create', async () => {
    const first = await render('/listagent', githubOwner);
    let draft = '';
    try {
      type(first, 'nm', 'draft-agent');
      type(first, 'ds', 'Half written');
      type(first, 'sk', 'go');
      (first.document.getElementById('gh') as HTMLInputElement).click();
      draft = first.window.sessionStorage.getItem('fa_listagent_draft') ?? '';
      expect(draft).not.toBe('');
    } finally {
      first.close();
    }
    const again = await render('/listagent', githubOwner, { fa_listagent_draft: draft });
    try {
      expect(['nm', 'ds', 'sk', 'fl'].map((id) => (again.document.getElementById(id) as HTMLInputElement).value)).toEqual(['draft-agent', 'Half written', 'go', '']);
      expect((again.document.getElementById('gh') as HTMLInputElement).checked).toBe(true);
      await create(again);
      expect(shown(again, 'created')).toBe(true);
      expect(again.window.sessionStorage.getItem('fa_listagent_draft')).toBeNull();
    } finally {
      again.close();
    }
  });
});

// ----------------------------------------------------------------- (f)

describe('(f) the ways in, and every link lands', () => {
  it('landing\u2019s and how\u2019s list links open /listagent', async () => {
    const landing = await render('/', null);
    const how = await render('/how', null);
    try {
      expect(landing.document.getElementById('door-list')?.getAttribute('href')).toBe('/listagent');
      const list = Array.from(how.document.querySelectorAll('main a.btn, a.btn')).filter((a) => /list an agent/i.test(a.textContent ?? ''));
      expect(list.map((a) => a.getAttribute('href'))).toEqual(['/listagent']);
    } finally {
      landing.close();
      how.close();
    }
  });

  it.each([['/'], ['/how'], ['/myagents'], ['/listagent']])('every href %s ships lands on a mounted route, /listagent among them', async (path) => {
    const res = await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } });
    expect(res.status, `${path} itself`).toBe(200);
    const markup = await res.text();
    const hrefs = [...new Set([...markup.matchAll(/href="(\/[^"#?]*)/g)].map((m) => m[1]!))];
    expect(hrefs.length).toBeGreaterThan(3);
    // The three ways in each carry the link; /listagent links My agents.
    expect(hrefs).toContain(path === '/listagent' ? '/myagents' : '/listagent');
    for (const href of hrefs) {
      const res = await fetch(`${baseUrl}${href}`, { headers: { Accept: HTML } });
      expect(res.status, `${path} links ${href}, which answers ${res.status}`).toBe(200);
    }
  });

  it('/myagents keeps one primary: the header drops to plain while an avatar editor is open', async () => {
    const page = await render('/myagents', githubOwner);
    try {
      await until(() => page.document.querySelector('.avedit-toggle') !== null);
      const cta = page.document.getElementById('list-agent-cta')!;
      const primaries = () => Array.from(page.document.querySelectorAll('.btn-primary')).filter((b) => !(b as HTMLElement).closest('[hidden]'));
      expect(cta.classList.contains('btn-primary')).toBe(true);
      expect(primaries()).toHaveLength(1);
      const toggle = page.document.querySelector('.avedit-toggle') as HTMLButtonElement;
      toggle.click();
      expect(cta.classList.contains('btn-primary'), 'the header stayed primary beside Save').toBe(false);
      expect(primaries().map((b) => b.textContent)).toEqual(['Save']);
      toggle.click();
      expect(cta.classList.contains('btn-primary')).toBe(true);
      expect(primaries()).toHaveLength(1);
    } finally {
      page.close();
    }
  });
});

// ----------------------------------------------------------------- (h)

// static_words.py's rule, as tests/web/past-work-simple.test.ts ports it.
function staticWords(src: string): string[] {
  const m = src.match(/<main[\s\S]*?<\/main>/);
  let body = m ? m[0] : src;
  body = body.replace(/<(script|style|template)[^>]*>[\s\S]*?<\/\1>/g, '');
  body = body.replace(/<!--[\s\S]*?-->/g, '');
  const text = body.replace(/<[^>]+>/g, ' ');
  const decoded = new JSDOM(`<p>${text.replace(/</g, '&lt;')}</p>`).window.document.body.textContent ?? '';
  return decoded.split(/\s+/).filter(Boolean);
}

describe('(h) words', () => {
  it('the page shell sits in one <main> at 90 words or fewer', () => {
    const src = readFileSync(join(here, '../../src/web/pages/listagent.html'), 'utf8');
    expect(src.match(/<main\b/g)).toHaveLength(1);
    expect(staticWords(src).length).toBeLessThanOrEqual(90);
  });

  it('no machine word or DID on the rendered page, signed out, on the form, or created', async () => {
    const out = await render('/listagent', null);
    const form = await render('/listagent', githubOwner);
    const done = await render('/listagent', passkeyOwner);
    try {
      type(done, 'nm', 'words-agent');
      type(done, 'sk', 'triage');
      await create(done);
      expect(shown(done, 'ceiling')).toBe(true);
      for (const page of [out, form, done]) expect(machineWords(page)).toEqual([]);
    } finally {
      out.close();
      form.close();
      done.close();
    }
  });
});

// ----------------------------------------------------------------- (i)

const captureDir = process.env.LISTAGENT_CAPTURE_DIR ?? '';

async function capture(browser: RealBrowser, name: string): Promise<void> {
  if (captureDir === '') return;
  mkdirSync(captureDir, { recursive: true });
  const shot = (await browser.send('Page.captureScreenshot', { format: 'png' })) as { result?: { data?: string } };
  if (shot.result?.data) writeFileSync(join(captureDir, `${name}.png`), Buffer.from(shot.result.data, 'base64'));
}

const SWEEP = `(function () {
  var doc = document.documentElement;
  var controls = [].filter.call(document.querySelectorAll('main a[href], main button, main input:not([type=checkbox]), main label.check'), function (el) {
    var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
  });
  return {
    scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, measured: controls.length,
    small: controls.filter(function (el) { var r = el.getBoundingClientRect(); return r.width < 44 || r.height < 44; })
      .map(function (el) { var r = el.getBoundingClientRect(); return (el.id || el.tagName) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); }),
    running: document.getAnimations().filter(function (a) { return a.playState === 'running'; }).length
  };
})()`;
interface Swept { scrollWidth: number; clientWidth: number; measured: number; small: string[]; running: number }

const VIEWPORTS = [[320, true], [390, true], [1280, false]] as const;

describe('(i) laid out right in real Chrome, under reduced motion', () => {
  it.each(VIEWPORTS)('%ipx (touch: %s): empty form, a refusal, and the created state with the ceiling and Confirm GitHub', async (width, touch) => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for the listagent layout sweep; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width, height: 900 });
    try {
      if (touch) {
        await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 2, mobile: true });
        await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      }
      await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      const as = async (session: Session): Promise<void> => {
        await browser.evaluate(`sessionStorage.clear(); sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(session))})`);
        await browser.goto(`${baseUrl}/listagent`, 900);
      };
      const check = async (state: string, expected: number): Promise<void> => {
        const got = await browser.evaluate<Swept>(SWEEP);
        expect(got.measured, `${state}: the controls measured`).toBe(expected);
        expect(got.scrollWidth, `${state} at ${width}: sideways scroll`).toBe(got.clientWidth);
        // The page sets its 44px floor at every width, so it is held at
        // 1280 with a mouse too, not only on touch.
        expect(got.small, `${state} at ${width}: under 44px`).toEqual([]);
        expect(got.running, `${state}: an animation running under reduced motion`).toBe(0);
      };
      await browser.goto(`${baseUrl}/signin`, 300);
      await as(githubOwner);
      await check('the empty form', 6);
      // The box sits beside its words, not stacked on them: a single-class
      // rule once lost to base.css's `.field label { display: block }`.
      const gap = await browser.evaluate<number>(`(function () { var i = document.getElementById('gh').getBoundingClientRect(); var t = document.querySelector('.check > span').getBoundingClientRect(); return t.left - i.right; })()`);
      expect(gap, 'the GitHub box and its words').toBeGreaterThanOrEqual(8);
      await capture(browser, `listagent-empty-${width}`);
      await browser.evaluate(`(function () { var f = document.getElementById('fl'); f.value = '40.5.0'; document.getElementById('nm').value = 'layout-agent'; document.getElementById('sk').value = 'triage'; document.getElementById('create-btn').click(); })()`);
      expect(await browser.evaluate<boolean>(`!document.getElementById('form-error').hidden`)).toBe(true);
      await check('the refusal', 6);
      await capture(browser, `listagent-refusal-${width}`);
      await as(passkeyOwner);
      await browser.evaluate(`(function () { document.getElementById('nm').value = 'layout-agent-${width}'; document.getElementById('sk').value = 'triage'; document.getElementById('create-btn').click(); })()`);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !(await browser.evaluate<boolean>(`!document.getElementById('created').hidden`))) await new Promise((r) => setTimeout(r, 100));
      expect(await browser.evaluate<boolean>(`!document.getElementById('ceiling').hidden`), 'the ceiling on the created state').toBe(true);
      // Confirm GitHub, See its page, My agents.
      await check('the created state', 3);
      expect(await browser.evaluate<boolean>(`!document.getElementById('gh-confirm').hidden`), 'Confirm GitHub on the created state').toBe(true);
      await capture(browser, `listagent-created-ceiling-${width}`);
    } finally {
      await browser.close();
    }
  }, BROWSER_TIMEOUT_MS);
});
