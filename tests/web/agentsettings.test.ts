// FIX-B41d: the agent settings page (/agentsettings?agent=<did>) and the
// Settings link into it from /myagents, driven end to end against the real
// app with memory repositories and real sessions, the discipline
// tests/web/listagent.test.ts holds to. Every agent here is listed through
// POST /agents from its owner's own session, so each case starts from a real
// site-listed agent. GET /accounts/me, GET /agents/:did and PATCH
// /agents/:did are exercised for real, never stubbed. Letters match the
// card's test list.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sign } from 'node:crypto';
import { createRequire } from 'node:module';

import { createApp } from '../../src/api/app.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import { createKnownKeyStore } from '../../src/adapters/identity/did-abt-resolver.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import type { Session } from '../../src/adapters/identity/session.js';
import { GistNotFoundError, type Gist, type GithubAdapter } from '../../src/adapters/github/types.js';
import { MemoryAccountRepository, MemoryAgentRepository } from '../../src/adapters/storage/memory.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession } from '../helpers/session-fixtures.js';
import { signingIdentityFromSeed } from '../helpers/sign-request.js';
import { createPasskeyFixture } from '../helpers/webauthn-fixtures.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const here = dirname(fileURLToPath(import.meta.url));
const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const PLATFORM_SEED = 'd41'.padEnd(64, '8');
const BROWSER_TIMEOUT_MS = 90_000;
const STATES = ['signin-required', 'load-error', 'missing', 'stranger', 'settings-body', 'myagents-body'];

let server: Server;
let baseUrl: string;
// A second app whose write class allows one request a minute, so the
// page's second save meets a real 429: the one status the page has no
// sentence of its own for.
let tightServer: Server;
let tightUrl: string;
let agentRepo: MemoryAgentRepository;
let tightAgentRepo: MemoryAgentRepository;
let originalSeed: string | undefined;
let githubOwner: Session;
let passkeyOwner: Session;
let stranger: Session;
let tightOwner: Session;
let nextLogin = '';
let sessions: ReturnType<typeof createSessionAdapter>;

// FIX-B47c: a fake GitHub for the proof's own calls, the shape
// tests/api/github-proof-callback.test.ts builds. A gist is published as
// whichever account the fake OAuth exchange answered (nextLogin at that
// moment), so the real callback's own check reads it back and verifies.
const gists = new Map<string, Gist>();
const fakeGithub = {
  platformLogin: 'freeagents-platform',
  getPublicGist: async (ref: { readonly id: string }): Promise<Gist> => {
    const gist = gists.get(ref.id);
    if (gist === undefined) throw new GistNotFoundError(ref.id);
    return gist;
  },
  createGist: async (input: { readonly filename: string; readonly content: string }): Promise<{ id: string }> => {
    const id = `settings-gist-${gists.size + 1}`;
    gists.set(id, { id, owner: nextLogin, files: { [input.filename]: input.content } });
    return { id };
  },
  deleteGist: async (input: { readonly id: string }): Promise<void> => { gists.delete(input.id); },
  deleteGrant: async (): Promise<void> => undefined,
} as unknown as GithubAdapter;

async function start(repo: MemoryAgentRepository, write: number, adapter: ReturnType<typeof createSessionAdapter>): Promise<[Server, string]> {
  const s = createApp(
    new MemoryAccountRepository(), repo, createIdentityAdapter(createKnownKeyStore()),
    fakeGithub, undefined, undefined, undefined, undefined,
    { verify: 10_000, read: 10_000, write, upstream: 10_000 }, undefined, undefined, adapter,
  ).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => s.once('listening', resolve));
  return [s, `http://127.0.0.1:${(s.address() as AddressInfo).port}`];
}

beforeAll(async () => {
  originalSeed = process.env.FREEAGENTS_PLATFORM_SEED;
  process.env.FREEAGENTS_PLATFORM_SEED = PLATFORM_SEED;
  const adapter = () => createSessionAdapter({
    github: fakeGitHubConfig(),
    fetchImpl: ((input: string | URL | Request, init?: RequestInit) => fakeGitHubFetch({ login: nextLogin, id: 4141 })(input, init)) as typeof fetch,
    passkey: { rpName: 'FreeAgents test', rpID: 'localhost', origin: 'http://localhost:3000' },
  });
  sessions = adapter();
  const tightSessions = adapter();
  agentRepo = new MemoryAgentRepository();
  tightAgentRepo = new MemoryAgentRepository();
  [server, baseUrl] = await start(agentRepo, 10_000, sessions);
  [tightServer, tightUrl] = await start(tightAgentRepo, 1, tightSessions);

  nextLogin = 'settings-owner';
  githubOwner = await mintSession(sessions);
  nextLogin = 'settings-stranger';
  stranger = await mintSession(sessions);
  nextLogin = 'settings-tight-owner';
  tightOwner = await mintSession(tightSessions);

  const subject = 'settings-passkey-owner';
  const { optionsJson } = await sessions.registerPasskey(subject);
  const { challenge } = JSON.parse(optionsJson) as { challenge: string };
  const response = createPasskeyFixture().registrationResponse(challenge, 'localhost');
  const session = await sessions.verifyPasskey(JSON.stringify({ subject, response }));
  if (session === null) throw new Error('expected a passkey session');
  passkeyOwner = session;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => tightServer.close(() => resolve()));
  if (originalSeed === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
  else process.env.FREEAGENTS_PLATFORM_SEED = originalSeed;
});

// ------------------------------------------------------------ the harness

// Lists an agent the way /listagent does: POST /agents from the owner's own
// session. Answers the new agent's DID.
async function listAgent(owner: Session, body: Record<string, unknown>, base = baseUrl): Promise<string> {
  const res = await fetch(`${base}/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${owner.token}` },
    body: JSON.stringify(body),
  });
  expect(res.status, 'POST /agents from the owner\u2019s session').toBe(201);
  return ((await res.json()) as { did: string }).did;
}

async function readAgent(did: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/agents/${encodeURIComponent(did)}`, { headers: { Accept: 'application/json' } });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

interface Call { readonly path: string; readonly method: string; readonly body: Record<string, unknown> | null; readonly authed: boolean; readonly auth: string; readonly credentials: string | undefined }
interface Page {
  window: JSDOM['window']; document: Document; calls: Call[];
  // FIX-B47c: what POST .../github-proof/start answered, in order.
  starts: { status: number; body: Record<string, unknown>; cookie: string }[];
  // When set, a matching request rejects the way fetch does offline.
  reject: ((path: string, method: string) => boolean) | null;
  close: () => void;
}

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
}

async function render(path: string, session: Session | null, opts: { base?: string; reject?: Page['reject']; hold?: (path: string, method: string) => Promise<void> | null } = {}): Promise<Page> {
  const base = opts.base ?? baseUrl;
  const failures: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e: Error) => failures.push(e.message));
  const markup = await (await fetch(`${base}${path}`, { headers: { Accept: HTML } })).text();
  const calls: Call[] = [];
  const page = { calls, starts: [], reject: opts.reject ?? null } as unknown as Page;
  const dom = new JSDOM(markup, {
    url: `${base}${path}`, runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      if (session !== null) window.sessionStorage.setItem('fa_session', JSON.stringify(session));
      Object.defineProperty(window, 'fetch', {
        writable: true,
        value: (input: string, init?: RequestInit) => {
          const headers = (init?.headers ?? {}) as Record<string, string>;
          const method = (init?.method ?? 'GET').toUpperCase();
          calls.push({
            path: String(input), method,
            body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
            authed: typeof headers.Authorization === 'string',
            auth: headers.Authorization ?? '',
            credentials: init?.credentials,
          });
          if (page.reject?.(String(input), method)) return Promise.reject(new TypeError('Failed to fetch'));
          // When set, a matching request waits for the returned promise
          // before it goes out, so a test can close the window first.
          const go = (): Promise<Response> => {
            if (!String(input).endsWith('/github-proof/start')) return fetch(new URL(input, base), init);
            return fetch(new URL(input, base), init).then(async (res) => {
              const set = res.headers.getSetCookie().find((line) => line.startsWith('fa_oauth_state='));
              page.starts.push({ status: res.status, body: (await res.clone().json()) as Record<string, unknown>, cookie: set === undefined ? '' : set.split(';')[0]! });
              return res;
            });
          };
          const held = opts.hold?.(String(input), method) ?? null;
          if (held !== null) return held.then(go);
          return go();
        },
      });
    },
  });
  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', () => resolve());
  });
  const d = dom.window.document;
  await until(() => STATES.some((id) => d.getElementById(id)?.hidden === false));
  await new Promise((r) => setTimeout(r, 100));
  if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);
  return Object.assign(page, { window: dom.window, document: d, close: () => dom.window.close() });
}

const settingsPath = (did: string): string => `/agentsettings?agent=${encodeURIComponent(did)}`;
const patches = (page: Page): Call[] => page.calls.filter((c) => c.method === 'PATCH');
const shown = (page: Page, id: string): boolean => (page.document.getElementById(id) as HTMLElement | null)?.hidden === false;
const val = (page: Page, id: string): string => (page.document.getElementById(id) as HTMLInputElement).value;
const values = (page: Page): string[] => ['nm', 'ds', 'sk', 'fl'].map((id) => val(page, id));
const text = (page: Page, id: string): string => page.document.getElementById(id)?.textContent?.trim() ?? '';

function type(page: Page, id: string, value: string): void {
  const input = page.document.getElementById(id) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new page.window.Event('input', { bubbles: true }));
}

async function save(page: Page): Promise<void> {
  const before = patches(page).length;
  (page.document.getElementById('save-btn') as HTMLButtonElement).click();
  await until(() => patches(page).length > before);
  await until(() => text(page, 'saved') !== '' || shown(page, 'form-error'));
}

const JARGON = ['credential', 'credentials', 'attestation', 'attested', 'hash', 'hashes', 'Ed25519', 'settlement', 'settle', 'settles', 'settled', 'rail', 'rails', 'specHash', 'diffHash', 'delegation'];
function machineWords(page: Page): string[] {
  const main = page.document.querySelector('main')!.cloneNode(true) as HTMLElement;
  main.querySelectorAll('[hidden], script, style').forEach((el) => el.remove());
  const words = main.textContent ?? '';
  return [
    ...JARGON.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(words)),
    ...['DID', 'DIDs'].filter((w) => new RegExp(`\\b${w}\\b`).test(words)),
    ...(/\bdid:[a-z0-9]+:/i.test(words) ? ['a DID string'] : []),
  ];
}

// ----------------------------------------------------------------- (a)

describe('(a) signed out', () => {
  it('shows the sign-in prompt and makes no authenticated request', async () => {
    const did = await listAgent(githubOwner, { name: 'signed-out-view', skills: ['triage'] });
    const page = await render(settingsPath(did), null);
    try {
      expect(shown(page, 'signin-required')).toBe(true);
      expect(shown(page, 'settings-body')).toBe(false);
      expect(page.document.getElementById('signin-link')?.getAttribute('href')).toBe('/signin');
      expect(page.calls.filter((c) => c.authed)).toEqual([]);
    } finally {
      page.close();
    }
  });

  it('a stored session the server does not know shows the sign-in prompt, not the load error', async () => {
    const did = await listAgent(githubOwner, { name: 'stale-view', skills: ['triage'] });
    const page = await render(settingsPath(did), { ...githubOwner, token: 'no-such-token-settings' } as Session);
    try {
      expect(page.calls.some((c) => c.path === '/accounts/me' && c.authed)).toBe(true);
      expect(shown(page, 'signin-required')).toBe(true);
      expect(shown(page, 'load-error')).toBe(false);
      expect(shown(page, 'settings-body')).toBe(false);
    } finally {
      page.close();
    }
  });
});

// ----------------------------------------------------------------- (b)

describe('(b) no agent to show', () => {
  it.each([['no ?agent=', '/agentsettings'], ['an unregistered agent', settingsPath('did:abt:zNoSuchAgentSettings')]])('%s: one sentence and a link to My agents, no form', async (_label, path) => {
    const page = await render(path, githubOwner);
    try {
      expect(shown(page, 'missing')).toBe(true);
      expect(shown(page, 'settings-body')).toBe(false);
      expect(shown(page, 'load-error')).toBe(false);
      expect(page.document.querySelector('#missing a')?.getAttribute('href')).toBe('/myagents');
      expect(text(page, 'missing-sentence')).toBe('We could not find that agent.');
    } finally {
      page.close();
    }
  });

  it.each([['the account read', '/accounts/me'], ['the agent read', '/agents/']])('%s never reaching the server shows the load error, not \u201cnot found\u201d', async (_label, prefix) => {
    const did = await listAgent(githubOwner, { name: 'offline-view', skills: ['triage'] });
    const page = await render(settingsPath(did), githubOwner, { reject: (p) => p.startsWith(prefix) });
    try {
      expect(page.calls.some((c) => c.path.startsWith(prefix))).toBe(true);
      expect(shown(page, 'load-error')).toBe(true);
      expect(shown(page, 'missing')).toBe(false);
      expect(shown(page, 'signin-required')).toBe(false);
      expect(shown(page, 'settings-body')).toBe(false);
    } finally {
      page.close();
    }
  });
});

// ----------------------------------------------------------------- (c)

describe('(c) a signed-in stranger', () => {
  it('sees one sentence and the agent\u2019s public page, no form, and sends no PATCH', async () => {
    const did = await listAgent(githubOwner, { name: 'not-yours', skills: ['triage'] });
    const page = await render(settingsPath(did), stranger);
    try {
      expect(shown(page, 'stranger')).toBe(true);
      expect(shown(page, 'settings-body')).toBe(false);
      expect(page.document.getElementById('public-link')?.getAttribute('href')).toBe(`/agents/${encodeURIComponent(did)}`);
      expect(page.document.getElementById('settings-form')?.closest('[hidden]')).not.toBeNull();
      expect(patches(page)).toEqual([]);
      expect(machineWords(page)).toEqual([]);
    } finally {
      page.close();
    }
  });
});

// ----------------------------------------------------------------- (d)

describe('(d) the owner opens the page', () => {
  it('every field shows the stored value', async () => {
    const did = await listAgent(githubOwner, { name: 'filled-in', description: 'Reads a diff and says what broke.', skills: ['Go', 'triage'], floorPriceUsd: '75.00' });
    const page = await render(settingsPath(did), githubOwner);
    try {
      expect(shown(page, 'settings-body')).toBe(true);
      expect(text(page, 'agent-name')).toBe('filled-in');
      expect(page.document.getElementById('back-link')?.getAttribute('href')).toBe('/myagents');
      expect(values(page)).toEqual(['filled-in', 'Reads a diff and says what broke.', 'Go, triage', '75.00']);
      expect(text(page, 'saved')).toBe('');
    } finally {
      page.close();
    }
  });

  it('an unset description and floor open empty, never 0', async () => {
    const did = await listAgent(passkeyOwner, { name: 'bare-listing', skills: ['triage'] });
    const page = await render(settingsPath(did), passkeyOwner);
    try {
      expect(values(page)).toEqual(['bare-listing', '', 'triage', '']);
      expect(page.document.querySelector('main')?.textContent ?? '').not.toMatch(/\b0\.00\b|no minimum/i);
    } finally {
      page.close();
    }
  });
});

// ----------------------------------------------------------------- (e)

describe('(e) saving', () => {
  it.each([['a GitHub owner', () => githubOwner], ['a passkey owner', () => passkeyOwner]])('%s changes all four fields with one PATCH of exactly four keys', async (_label, owner) => {
    const did = await listAgent(owner(), { name: 'before-edit', skills: ['triage'] });
    const page = await render(settingsPath(did), owner());
    try {
      type(page, 'nm', 'after-edit');
      type(page, 'ds', 'Writes the migration and its rollback.');
      type(page, 'sk', ' SQL, , Postgres ,sql');
      type(page, 'fl', '40');
      await save(page);
      expect(patches(page)).toHaveLength(1);
      expect(patches(page)[0]!.path).toBe(`/agents/${encodeURIComponent(did)}`);
      expect(patches(page)[0]!.body).toEqual({ name: 'after-edit', description: 'Writes the migration and its rollback.', skills: ['SQL', 'Postgres'], floorPriceUsd: '40.00' });
      expect(text(page, 'agent-name')).toBe('after-edit');
      expect(values(page)).toEqual(['after-edit', 'Writes the migration and its rollback.', 'SQL, Postgres', '40.00']);
      expect(text(page, 'saved')).toBe('Saved.');
      expect(page.document.getElementById('saved')?.getAttribute('role')).toBe('status');
      expect(shown(page, 'form-error')).toBe(false);
    } finally {
      page.close();
    }
    expect(await readAgent(did)).toMatchObject({ name: 'after-edit', description: 'Writes the migration and its rollback.', skills: ['SQL', 'Postgres'], floorPriceUsd: '40.00' });
  });

  it('clearing the description and the floor sends null for each, and both read back null', async () => {
    const did = await listAgent(githubOwner, { name: 'to-clear', description: 'Soon gone.', skills: ['triage'], floorPriceUsd: '12.50' });
    const page = await render(settingsPath(did), githubOwner);
    try {
      type(page, 'ds', '   ');
      type(page, 'fl', '');
      await save(page);
      expect(patches(page)[0]!.body).toEqual({ name: 'to-clear', description: null, skills: ['triage'], floorPriceUsd: null });
      expect(values(page)).toEqual(['to-clear', '', 'triage', '']);
      expect(text(page, 'saved')).toBe('Saved.');
    } finally {
      page.close();
    }
    expect(await readAgent(did)).toMatchObject({ description: null, floorPriceUsd: null });
  });
});

// ----------------------------------------------------------------- (f)

describe('(f) one PATCH per press', () => {
  it('two presses before the first answer send one PATCH', async () => {
    const did = await listAgent(githubOwner, { name: 'press-twice', skills: ['triage'] });
    const page = await render(settingsPath(did), githubOwner);
    try {
      const btn = page.document.getElementById('save-btn') as HTMLButtonElement;
      btn.click();
      expect(btn.disabled, 'Save is disabled while the request is out').toBe(true);
      // Enter in a field submits the form without the button, so the
      // disabled button alone does not stop a second PATCH.
      page.document.getElementById('settings-form')!.dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
      await until(() => text(page, 'saved') !== '');
      await new Promise((r) => setTimeout(r, 200));
      expect(patches(page)).toHaveLength(1);
      expect(btn.disabled).toBe(false);
    } finally {
      page.close();
    }
  });
});

// ----------------------------------------------------------------- (g)

describe('(g) refusals change nothing but the sentence', () => {
  async function refusedAfter(page: Page, typed: string[], sentence: string): Promise<void> {
    expect(shown(page, 'form-error')).toBe(true);
    expect(text(page, 'form-error-detail')).toBe(sentence);
    expect(values(page), 'every typed value stays').toEqual(typed);
    expect(text(page, 'saved'), '"Saved." after a refusal').toBe('');
    expect(machineWords(page)).toEqual([]);
  }

  it.each([
    ['an empty name', 'nm', '  ', 'Give the agent a name.'],
    ['skills of only commas and spaces', 'sk', ' , ,', 'Add at least one skill.'],
    ['a price of "40.5.0"', 'fl', '40.5.0', 'Write the price in dollars and cents, like 40.00.'],
  ])('%s is refused before any request, with focus on that field', async (_label, id, value, sentence) => {
    const did = await listAgent(githubOwner, { name: 'checked-first', skills: ['triage'] });
    const page = await render(settingsPath(did), githubOwner);
    try {
      type(page, id, value);
      const typed = values(page);
      (page.document.getElementById('save-btn') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 200));
      expect(patches(page)).toEqual([]);
      await refusedAfter(page, typed, sentence);
      expect(page.document.activeElement?.id).toBe(id);
    } finally {
      page.close();
    }
  });

  it('a 400 (a 161-character description set on the field) gets its own sentence', async () => {
    const did = await listAgent(githubOwner, { name: 'too-long', skills: ['triage'] });
    const page = await render(settingsPath(did), githubOwner);
    try {
      type(page, 'ds', 'x'.repeat(161));
      await save(page);
      await refusedAfter(page, ['too-long', 'x'.repeat(161), 'triage', ''], 'That was not accepted. Keep the description to one line of up to 160 characters, and try again.');
    } finally {
      page.close();
    }
    expect((await readAgent(did)).description).toBeNull();
  });

  it.each([
    ['401: an unknown token', () => 'no-such-token-at-save', 'Your session has expired. Sign in again to save your changes.'],
    ['403: a signed-in stranger\u2019s token', () => stranger.token, 'Only this agent\u2019s owner can change it. Sign in with the account that listed it.'],
  ])('%s swapped in between load and save', async (_label, token, sentence) => {
    const did = await listAgent(githubOwner, { name: 'swapped-token', skills: ['triage'] });
    const page = await render(settingsPath(did), githubOwner);
    try {
      page.window.sessionStorage.setItem('fa_session', JSON.stringify({ ...githubOwner, token: token() }));
      type(page, 'nm', 'not-saved');
      await save(page);
      expect(patches(page)).toHaveLength(1);
      await refusedAfter(page, ['not-saved', '', 'triage', ''], sentence);
    } finally {
      page.close();
    }
    expect((await readAgent(did)).name).toBe('swapped-token');
  });

  it('a session cleared between load and save sends nothing and says to sign in again', async () => {
    const did = await listAgent(githubOwner, { name: 'cleared-session', skills: ['triage'] });
    const page = await render(settingsPath(did), githubOwner);
    try {
      page.window.sessionStorage.removeItem('fa_session');
      (page.document.getElementById('save-btn') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 200));
      expect(patches(page)).toEqual([]);
      await refusedAfter(page, ['cleared-session', '', 'triage', ''], 'Your session has expired. Sign in again to save your changes.');
    } finally {
      page.close();
    }
  });

  it('a 503 (the listing update throws) gets its own sentence', async () => {
    const did = await listAgent(githubOwner, { name: 'storage-down', skills: ['triage'] });
    const page = await render(settingsPath(did), githubOwner);
    const real = agentRepo.updateListing;
    agentRepo.updateListing = async () => { throw new Error('storage down (test)'); };
    try {
      type(page, 'fl', '9');
      await save(page);
      await refusedAfter(page, ['storage-down', '', 'triage', '9'], 'Saving is unavailable just now. Try again in a moment.');
    } finally {
      agentRepo.updateListing = real;
      page.close();
    }
  });

  it('a status with no sentence of its own (a real 429) gets the default sentence', async () => {
    const did = await listAgent(tightOwner, { name: 'rate-limited', skills: ['triage'] }, tightUrl);
    const page = await render(settingsPath(did), tightOwner, { base: tightUrl });
    try {
      // The tight app's write class allows one request a minute; the
      // listing above spent it, so this save meets the limiter.
      await save(page);
      expect(patches(page)).toHaveLength(1);
      await refusedAfter(page, ['rate-limited', '', 'triage', ''], 'That did not go through. Try again in a moment.');
    } finally {
      page.close();
    }
  });

  it('a save that never reaches the server gets its own sentence', async () => {
    const did = await listAgent(githubOwner, { name: 'offline-save', skills: ['triage'] });
    const page = await render(settingsPath(did), githubOwner);
    try {
      page.reject = (_p, method) => method === 'PATCH';
      type(page, 'sk', 'triage, go');
      await save(page);
      await refusedAfter(page, ['offline-save', '', 'triage, go', ''], 'That did not reach the server. Check your connection and try again.');
      // The next press, back online, goes through and clears the sentence.
      page.reject = null;
      await save(page);
      expect(text(page, 'saved')).toBe('Saved.');
      expect(shown(page, 'form-error')).toBe(false);
      // "Saved." speaks for what was on screen when it was said: a press
      // that is refused takes it away, and so does any edit.
      page.reject = (_p, method) => method === 'PATCH';
      await save(page);
      expect(shown(page, 'form-error')).toBe(true);
      expect(text(page, 'saved'), '"Saved." beside a refusal').toBe('');
      page.reject = null;
      await save(page);
      expect(text(page, 'saved')).toBe('Saved.');
      type(page, 'nm', 'offline-save-edited');
      expect(text(page, 'saved'), '"Saved." after an unsaved edit').toBe('');
    } finally {
      page.close();
    }
  });
});

// ----------------------------------------------------------------- (h)

describe('(h) /myagents opens every agent\u2019s settings', () => {
  it('every row carries Settings, and every href the rendered page carries lands on a mounted route', async () => {
    nextLogin = 'settings-roster-owner';
    // An owner with no other agents, so the roster is exactly these two.
    const owner = await mintSession(sessions);
    const dids = [
      await listAgent(owner, { name: 'roster-one', skills: ['triage'] }),
      await listAgent(owner, { name: 'roster-two', skills: ['go'] }),
    ];
    const page = await render('/myagents', owner);
    try {
      await until(() => page.document.querySelectorAll('[data-agent-row]').length === 2);
      for (const [i, did] of dids.entries()) {
        const link = page.document.querySelector(`[data-agent-row="${did}"] .right a.settings-link`);
        expect(link, `row ${did} has no Settings link`).not.toBeNull();
        expect(link!.textContent).toBe('Settings');
        expect(link!.getAttribute('href')).toBe(settingsPath(did));
        expect(link!.getAttribute('aria-label')).toBe(`Settings for roster-${i === 0 ? 'one' : 'two'}`);
      }
      const hrefs = [...new Set(Array.from(page.document.querySelectorAll('a[href^="/"]')).map((a) => a.getAttribute('href')!))];
      expect(hrefs).toContain(settingsPath(dids[0]!));
      for (const href of hrefs) {
        const res = await fetch(`${baseUrl}${href}`, { headers: { Accept: HTML } });
        expect(res.status, `/myagents links ${href}, which answers ${res.status}`).toBe(200);
      }
    } finally {
      page.close();
    }
  });

  // The page's per-row read (GET /agents/:did, myagents.js loadDetail) is
  // the one read no render signal waits for, so a test can close the window
  // while it is out. A read that answers after that must paint nothing:
  // bots.js has no document left to draw into, and the throw is an
  // unhandled rejection that fails the whole CI run. Every row read is
  // held, the window closed, then the reads released. The open-window twin
  // proves the hold itself does not stop a live page painting.
  it('a row read that answers after the page is closed paints nothing; one that answers while open paints', async () => {
    nextLogin = 'settings-late-read-owner';
    const owner = await mintSession(sessions);
    const did = await listAgent(owner, { name: 'late-read', skills: ['triage'] });
    const heldRead = (p: string, m: string): boolean => m === 'GET' && p.startsWith('/agents/did');
    for (const closeFirst of [true, false]) {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => { release = r; });
      const page = await render('/myagents', owner, { hold: (p, m) => (heldRead(p, m) ? gate : null) });
      await until(() => page.document.querySelector(`[data-agent-row="${did}"]`) !== null);
      const bots = (page.window as unknown as { FABots: { mount: (...a: unknown[]) => unknown } }).FABots;
      const realMount = bots.mount.bind(bots);
      let closed = false;
      let mountsAfterClose = 0;
      bots.mount = (...a: unknown[]) => (closed ? (mountsAfterClose += 1, null) : realMount(...a));
      const host = page.document.querySelector(`[data-agent-row="${did}"] .rav`)!;
      expect(page.calls.some((c) => heldRead(c.path, c.method)), 'the row read went out').toBe(true);
      expect(host.querySelector('canvas'), 'painted before its read answered').toBeNull();
      if (closeFirst) {
        page.close();
        closed = true;
        release();
        await new Promise((r) => setTimeout(r, 400));
        expect(mountsAfterClose, 'a closed page painted an avatar').toBe(0);
      } else {
        release();
        try {
          await until(() => host.querySelector('canvas') !== null);
          expect(host.querySelector('canvas'), 'an open page never painted its row').not.toBeNull();
        } finally {
          page.close();
        }
      }
    }
  });
});

// ------------------------------------------------ FIX-B47c: GitHub proof

// jsdom cannot follow a real navigation; hire-flow.test.ts's seam
// (whatwg-url's parseURL) records the URL a page asked to go to.
const whatwgURL = createRequire(import.meta.url)('whatwg-url') as { parseURL: (v: string, o?: unknown) => unknown };
function captureNavigations(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = whatwgURL.parseURL;
  whatwgURL.parseURL = function (this: unknown, v: string, o?: unknown) { calls.push(v); return original.call(this, v, o); };
  return { calls, restore: () => { whatwgURL.parseURL = original; } };
}
const toGithub = (calls: string[]): string[] => calls.filter((v) => v.startsWith('https://github.com/login/oauth/authorize'));
const startsOf = (page: Page): Call[] => page.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/github-proof/start'));
const GH_WORDS = 'GitHub account Nobody can pay this agent until its GitHub account is confirmed. On GitHub, pick the account it works from. FreeAgents posts one public gist there, then its access ends. Confirm GitHub';

function sectionWords(page: Page): string {
  const section = page.document.getElementById('gh-section')!.cloneNode(true) as HTMLElement;
  section.querySelectorAll('[hidden]').forEach((el) => el.remove());
  return (section.textContent ?? '').replace(/\s+/g, ' ').trim();
}

// Presses Confirm GitHub and waits until the start has answered and the
// page has acted on it (left for GitHub, or said a sentence).
async function press(page: Page, nav: { calls: string[] }): Promise<void> {
  const before = startsOf(page).length;
  (page.document.getElementById('gh-confirm') as HTMLButtonElement).click();
  await until(() => startsOf(page).length > before);
  await until(() => toGithub(nav.calls).length > 0 || text(page, 'gh-error') !== '');
}

// A site agent that brought its own DID: the platform never held its key.
async function listOwnKeyAgent(owner: Session): Promise<string> {
  const me = (await (await fetch(`${baseUrl}/accounts/me`, { headers: { Accept: 'application/json', Authorization: `Bearer ${owner.token}` } })).json()) as { did: string };
  const key = await signingIdentityFromSeed(new Uint8Array(32).fill(47));
  const signature = sign(null, Buffer.from(`freeagents:list-agent:v1:${key.did}:${me.did}`, 'utf8'), key.privateKey).toString('base64');
  return listAgent(owner, { name: 'own-key', skills: ['triage'], did: key.did, agentProof: { signature, publicKeyMultibase: key.keyid.slice(key.keyid.indexOf('#') + 1) } });
}

describe('(l) the GitHub account section', () => {
  it('an unverified agent: the words and the button, no outcome line; the section says at most 35 words and no machine word', async () => {
    const did = await listAgent(passkeyOwner, { name: 'unconfirmed', skills: ['triage'] });
    const page = await render(settingsPath(did), passkeyOwner);
    try {
      expect(shown(page, 'gh-unverified')).toBe(true);
      expect(shown(page, 'gh-confirmed')).toBe(false);
      const btn = page.document.getElementById('gh-confirm') as HTMLButtonElement;
      expect(btn.textContent).toBe('Confirm GitHub');
      expect(btn.className, 'Save is the one primary here').toBe('btn');
      expect(text(page, 'gh-outcome')).toBe('');
      expect(sectionWords(page)).toBe(GH_WORDS);
      expect(sectionWords(page).split(' ').length).toBeLessThanOrEqual(35);
      expect(sectionWords(page)).not.toMatch(/\b(OAuth|token|scope|statement|DID|key|delegation)\b/i);
    } finally {
      page.close();
    }
  });

  it('a verified agent (the GitHub box ticked at listing): "Confirmed: @login" and no button', async () => {
    const did = await listAgent(githubOwner, { name: 'confirmed', skills: ['triage'], githubLogin: 'settings-owner' });
    const page = await render(settingsPath(did), githubOwner);
    try {
      expect(shown(page, 'gh-confirmed')).toBe(true);
      expect(text(page, 'gh-confirmed')).toBe('Confirmed: @settings-owner');
      expect(shown(page, 'gh-unverified')).toBe(false);
      expect(page.document.getElementById('gh-confirm')?.closest('[hidden]')).not.toBeNull();
    } finally {
      page.close();
    }
  });

  it.each([
    ['a stranger', () => stranger, 'stranger'],
    ['a signed-out visitor', () => null, 'signin-required'],
  ])('%s sees no section', async (_label, who, state) => {
    const did = await listAgent(passkeyOwner, { name: 'no-section', skills: ['triage'] });
    const page = await render(settingsPath(did), who());
    try {
      expect(shown(page, state)).toBe(true);
      expect(page.document.getElementById('gh-section')?.closest('[hidden]')).not.toBeNull();
    } finally {
      page.close();
    }
  });

  it('a missing agent sees no section', async () => {
    const page = await render(settingsPath('did:abt:zNoSuchProofAgent'), passkeyOwner);
    try {
      expect(shown(page, 'missing')).toBe(true);
      expect(page.document.getElementById('gh-section')?.closest('[hidden]')).not.toBeNull();
    } finally {
      page.close();
    }
  });

  it('every sentence node is a live region before it is first shown', async () => {
    const did = await listAgent(passkeyOwner, { name: 'live-regions', skills: ['triage'] });
    const page = await render(settingsPath(did), passkeyOwner);
    try {
      expect(text(page, 'gh-error')).toBe('');
      expect(page.document.getElementById('gh-error')?.getAttribute('role')).toBe('alert');
      expect(text(page, 'gh-outcome')).toBe('');
      expect(page.document.getElementById('gh-outcome')?.getAttribute('role')).toBe('status');
      expect(page.document.getElementById('gh-confirmed')?.getAttribute('role')).toBe('status');
    } finally {
      page.close();
    }
  });
});

describe('(m) the press', () => {
  it.each([['a passkey owner', () => passkeyOwner], ['a GitHub owner', () => githubOwner]])('%s: one start with the session\u2019s token, then exactly the redirectUrl it answered', async (_label, owner) => {
    const did = await listAgent(owner(), { name: 'press-once', skills: ['triage'] });
    const page = await render(settingsPath(did), owner());
    const nav = captureNavigations();
    try {
      const btn = page.document.getElementById('gh-confirm') as HTMLButtonElement;
      btn.click();
      expect(btn.disabled, 'the button is off while the start is out').toBe(true);
      expect(btn.getAttribute('data-busy')).toBe('true');
      btn.click();
      await until(() => toGithub(nav.calls).length > 0);
      await new Promise((r) => setTimeout(r, 150));
      expect(startsOf(page)).toHaveLength(1);
      expect(startsOf(page)[0]!.path).toBe(`/agents/${encodeURIComponent(did)}/github-proof/start`);
      expect(startsOf(page)[0]!.auth).toBe(`Bearer ${owner().token}`);
      expect(page.starts).toHaveLength(1);
      expect(page.starts[0]!.status).toBe(200);
      expect(toGithub(nav.calls)).toEqual([page.starts[0]!.body.redirectUrl]);
      expect(text(page, 'gh-error')).toBe('');
    } finally {
      nav.restore();
      page.close();
    }
  });

  it('coming back from GitHub through the browser\u2019s page cache gives the button back', async () => {
    const did = await listAgent(passkeyOwner, { name: 'back-button', skills: ['triage'] });
    const page = await render(settingsPath(did), passkeyOwner);
    try {
      const btn = page.document.getElementById('gh-confirm') as HTMLButtonElement;
      btn.disabled = true;
      btn.setAttribute('data-busy', 'true');
      const shownAgain = new page.window.Event('pageshow');
      Object.defineProperty(shownAgain, 'persisted', { value: true });
      page.window.dispatchEvent(shownAgain);
      expect(btn.disabled).toBe(false);
      expect(btn.hasAttribute('data-busy')).toBe(false);
    } finally {
      page.close();
    }
  });
});

// B76: the press is the one write that sends credentials, so the browser
// stores the fa_oauth_state cookie the start sets and sends it back on
// GitHub's redirect. Every other write on the page still omits them.
describe('(m2) the press sends credentials, no other write does', () => {
  it('the start goes out with credentials same-origin and the save on the same page still goes out with omit', async () => {
    const did = await listAgent(passkeyOwner, { name: 'press-credentials', skills: ['triage'] });
    const page = await render(settingsPath(did), passkeyOwner);
    const nav = captureNavigations();
    try {
      type(page, 'nm', 'press-credentials-renamed');
      await save(page);
      await press(page, nav);
      expect(patches(page)).toHaveLength(1);
      expect(patches(page)[0]!.credentials).toBe('omit');
      expect(startsOf(page)).toHaveLength(1);
      expect(startsOf(page)[0]!.credentials).toBe('same-origin');
      expect(startsOf(page)[0]!.auth).toBe(`Bearer ${passkeyOwner.token}`);
      expect(toGithub(nav.calls)).toHaveLength(1);
    } finally {
      nav.restore();
      page.close();
    }
  });
});

describe('(n) each refusal leaves the page where it is and says one sentence', () => {
  async function refusedWith(page: Page, nav: { calls: string[] }, sentence: string, status: number | null): Promise<void> {
    await press(page, nav);
    await new Promise((r) => setTimeout(r, 100));
    if (status !== null) expect(page.starts.map((s) => s.status)).toEqual([status]);
    expect(text(page, 'gh-error')).toBe(sentence);
    expect(shown(page, 'gh-error')).toBe(true);
    expect(toGithub(nav.calls), 'a refusal navigated').toEqual([]);
    const btn = page.document.getElementById('gh-confirm') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.hasAttribute('data-busy')).toBe(false);
    expect(shown(page, 'gh-unverified')).toBe(true);
    expect(machineWords(page)).toEqual([]);
  }

  it.each([
    ['401: an unknown token', () => 'no-such-token-at-proof', 401, 'Your session has expired. Sign in again to confirm it.'],
    ['403: a stranger\u2019s token', () => stranger.token, 403, 'Only this agent\u2019s owner can confirm its GitHub account. Sign in with the account that listed it.'],
  ])('%s swapped in between load and press', async (_label, token, status, sentence) => {
    const did = await listAgent(passkeyOwner, { name: 'swapped-proof', skills: ['triage'] });
    const page = await render(settingsPath(did), passkeyOwner);
    const nav = captureNavigations();
    try {
      page.window.sessionStorage.setItem('fa_session', JSON.stringify({ ...passkeyOwner, token: token() }));
      await refusedWith(page, nav, sentence, status);
    } finally {
      nav.restore();
      page.close();
    }
  });

  it('409: a site agent that brought its own DID', async () => {
    const did = await listOwnKeyAgent(githubOwner);
    const page = await render(settingsPath(did), githubOwner);
    const nav = captureNavigations();
    try {
      await refusedWith(page, nav, 'This agent was registered with its own identity, so it confirms its GitHub account through the API.', 409);
    } finally {
      nav.restore();
      page.close();
    }
  });

  it('503: the platform seed unset between load and press; the next press, with it back, goes through', async () => {
    const did = await listAgent(passkeyOwner, { name: 'no-seed', skills: ['triage'] });
    const page = await render(settingsPath(did), passkeyOwner);
    const nav = captureNavigations();
    try {
      delete process.env.FREEAGENTS_PLATFORM_SEED;
      await refusedWith(page, nav, 'Confirming GitHub is not available just now. Try again later.', 503);
      process.env.FREEAGENTS_PLATFORM_SEED = PLATFORM_SEED;
      await press(page, nav);
      expect(toGithub(nav.calls)).toHaveLength(1);
      expect(shown(page, 'gh-error'), 'the old sentence beside a start that went through').toBe(false);
    } finally {
      process.env.FREEAGENTS_PLATFORM_SEED = PLATFORM_SEED;
      nav.restore();
      page.close();
    }
  });

  it('a status with no sentence of its own (a real 429) gets the default sentence', async () => {
    // The tight app allows one write a minute, and (g)'s 429 case spent it
    // on its listing, so this reuses that agent; run alone, it lists one.
    const listed = (await tightAgentRepo.listAll()).find((a) => a.name === 'rate-limited');
    const did = listed?.did ?? await listAgent(tightOwner, { name: 'rate-limited', skills: ['triage'] }, tightUrl);
    const page = await render(settingsPath(did), tightOwner, { base: tightUrl });
    const nav = captureNavigations();
    try {
      await refusedWith(page, nav, 'That did not go through. Try again in a moment.', 429);
    } finally {
      nav.restore();
      page.close();
    }
  });

  it('a start that never reaches the server', async () => {
    const did = await listAgent(passkeyOwner, { name: 'proof-offline', skills: ['triage'] });
    const page = await render(settingsPath(did), passkeyOwner, { reject: (p) => p.endsWith('/github-proof/start') });
    const nav = captureNavigations();
    try {
      (page.document.getElementById('gh-confirm') as HTMLButtonElement).click();
      await until(() => text(page, 'gh-error') !== '');
      expect(startsOf(page)).toHaveLength(1);
      await refusedWith(page, nav, 'That did not reach the server. Check your connection and try again.', null);
    } finally {
      nav.restore();
      page.close();
    }
  });
});

describe('(o) the landing from GitHub', () => {
  const landingOf = (page: Page): string => page.window.location.pathname + page.window.location.search;

  it('verified: the whole click through the real start and callback, with a fake GitHub, ends "GitHub confirmed."', async () => {
    const did = await listAgent(passkeyOwner, { name: 'whole-click', skills: ['triage'] });
    const page = await render(settingsPath(did), passkeyOwner);
    const nav = captureNavigations();
    let redirectUrl = '';
    // The cookie the start set, which the page's browser would hold and send
    // back on GitHub's redirect (B76). The jsdom page cannot hold it: the
    // harness forwards the start with node's fetch.
    let cookie = '';
    try {
      await press(page, nav);
      redirectUrl = toGithub(nav.calls)[0]!;
      cookie = page.starts[0]!.cookie;
    } finally {
      nav.restore();
      page.close();
    }
    nextLogin = 'proof-picked-account';
    const state = new URL(redirectUrl).searchParams.get('state')!;
    const back = await fetch(`${baseUrl}/auth/github/callback?code=any&state=${encodeURIComponent(state)}`, { headers: { Accept: HTML, Cookie: cookie }, redirect: 'manual' });
    expect(back.status).toBe(302);
    const landing = back.headers.get('location')!;
    expect(landing).toBe(`${settingsPath(did)}&github=verified`);
    expect(await readAgent(did)).toMatchObject({ proofStatus: 'verified', githubLogin: 'proof-picked-account' });
    const after = await render(landing, passkeyOwner);
    try {
      expect(text(after, 'gh-outcome')).toBe('GitHub confirmed.');
      expect(text(after, 'gh-confirmed')).toBe('Confirmed: @proof-picked-account');
      expect(shown(after, 'gh-unverified')).toBe(false);
      expect(landingOf(after)).toBe(settingsPath(did));
      expect(machineWords(after)).toEqual([]);
    } finally {
      after.close();
    }
  });

  it.each([
    ['verified, on an agent that still reads unverified', 'verified', ''],
    ['refused', 'refused', 'Nothing changed. You can confirm it whenever you are ready.'],
    ['failed', 'failed', 'That did not work, and nothing changed. Try again.'],
    ['an unknown value', 'maybe', ''],
    // A name every object inherits: the lookup must be the table's own.
    ['a built-in name', 'toString', ''],
  ])('%s', async (_label, outcome, sentence) => {
    const did = await listAgent(passkeyOwner, { name: `landing-${outcome}`, skills: ['triage'] });
    const page = await render(`${settingsPath(did)}&github=${outcome}`, passkeyOwner);
    try {
      expect(text(page, 'gh-outcome')).toBe(sentence);
      expect(shown(page, 'gh-unverified'), 'the button stays').toBe(true);
      expect(shown(page, 'gh-confirmed')).toBe(false);
      expect(landingOf(page)).toBe(settingsPath(did));
      expect(machineWords(page)).toEqual([]);
    } finally {
      page.close();
    }
  });

  it('a stranger landing with ?github=verified sees no outcome sentence', async () => {
    const did = await listAgent(githubOwner, { name: 'landing-stranger', skills: ['triage'], githubLogin: 'settings-owner' });
    const page = await render(`${settingsPath(did)}&github=verified`, stranger);
    try {
      expect(shown(page, 'stranger')).toBe(true);
      expect(text(page, 'gh-outcome')).toBe('');
    } finally {
      page.close();
    }
  });
});

// ------------------------------------------------ FIX-B43b: the listing

// The third section: the owner stops listing the agent, and lists it again,
// through the real PUT /agents/:agentDid/listing. Letters are the card's,
// prefixed "listing" so they do not collide with this file's own (a) to (o).
const LISTED = {
  heading: 'Stop listing this agent',
  lines: ['It leaves browse and nobody can hire it. Work that already shipped stays on the record, and its receipts keep working.', 'You can list it again later.'],
};
const UNLISTED = {
  heading: 'List this agent again',
  lines: ['It is not listed, so nobody can find it or hire it. Its record stays public.'],
  button: 'List it again',
};
const LISTING_REFUSED = {
  401: 'Your session has expired. Sign in again to change its listing.',
  403: 'Only this agent\u2019s owner can change its listing. Sign in with the account that listed it.',
  404: 'We could not find this agent any more. Go back to My agents.',
  failed: 'That did not work, and nothing changed. Try again.',
  offline: 'That did not reach the server, and nothing changed. Check your connection and try again.',
};

const puts = (page: Page): Call[] => page.calls.filter((c) => c.method === 'PUT' && c.path.endsWith('/listing'));
const listingBtn = (page: Page): HTMLButtonElement => page.document.getElementById('listing-btn') as HTMLButtonElement;
function listingState(page: Page): { heading: string; lines: string[]; button: string } {
  return {
    heading: text(page, 'listing-heading'),
    lines: Array.from(page.document.querySelectorAll('#listing-words p')).map((p) => (p.textContent ?? '').trim()),
    button: listingBtn(page).textContent?.trim() ?? '',
  };
}
const listedState = (name: string): ReturnType<typeof listingState> => ({ ...LISTED, button: `Stop listing ${name}` });
const unlistedState = (): ReturnType<typeof listingState> => ({ heading: UNLISTED.heading, lines: UNLISTED.lines, button: UNLISTED.button });

// Presses the listing button and waits until the PUT has answered and the
// page has acted on it (the button is back).
async function pressListing(page: Page): Promise<void> {
  const before = puts(page).length;
  listingBtn(page).click();
  await until(() => puts(page).length > before);
  await until(() => !listingBtn(page).disabled);
}

async function setListedByApi(owner: Session, did: string, listed: boolean): Promise<void> {
  const res = await fetch(`${baseUrl}/agents/${encodeURIComponent(did)}/listing`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ listed }),
  });
  expect(res.status).toBe(200);
}

async function browseDids(): Promise<string[]> {
  const res = await fetch(`${baseUrl}/agents`, { headers: { Accept: 'application/json' } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { agents: { did: string }[] }).agents.map((a) => a.did);
}

describe('listing (a) a listed agent', () => {
  it('shows the section with the wireframe\u2019s heading and two sentences, and a button reading "Stop listing <the agent\u2019s real name>"', async () => {
    const did = await listAgent(githubOwner, { name: 'still-listed', skills: ['triage'] });
    const page = await render(settingsPath(did), githubOwner);
    try {
      expect(shown(page, 'settings-body')).toBe(true);
      expect(page.document.getElementById('listing-section')?.closest('[hidden]')).toBeNull();
      expect(listingState(page)).toEqual(listedState('still-listed'));
      // The wireframe's "Stop listing axiom-ui" is its sample name; this is
      // the live-name pin wireframe-conformance.test.ts cites.
      expect(listingBtn(page).textContent).toBe(`Stop listing ${text(page, 'agent-name')}`);
      expect(listingBtn(page).className, 'Save changes is the one primary').toBe('btn');
      expect(listingBtn(page).type).toBe('button');
      expect(text(page, 'listing-error')).toBe('');
      expect(shown(page, 'listing-error')).toBe(false);
      expect(puts(page)).toEqual([]);
      expect(machineWords(page)).toEqual([]);
    } finally {
      page.close();
    }
  });

  it('an agent that opens already unlisted shows the unlisted state', async () => {
    const did = await listAgent(githubOwner, { name: 'opens-unlisted', skills: ['triage'] });
    await setListedByApi(githubOwner, did, false);
    const page = await render(settingsPath(did), githubOwner);
    try {
      expect(listingState(page)).toEqual(unlistedState());
      expect(machineWords(page)).toEqual([]);
    } finally {
      page.close();
    }
  });
});

describe('listing (b) Stop listing', () => {
  it.each([['a GitHub owner', () => githubOwner], ['a passkey owner', () => passkeyOwner]])('%s: one PUT of exactly { listed: false } with the session\u2019s token, and the section redraws unlisted', async (_label, owner) => {
    const did = await listAgent(owner(), { name: 'to-unlist', skills: ['triage'] });
    const page = await render(settingsPath(did), owner());
    try {
      await pressListing(page);
      expect(puts(page)).toHaveLength(1);
      expect(puts(page)[0]!.path).toBe(`/agents/${encodeURIComponent(did)}/listing`);
      expect(puts(page)[0]!.body).toEqual({ listed: false });
      expect(puts(page)[0]!.auth).toBe(`Bearer ${owner().token}`);
      expect(listingState(page)).toEqual(unlistedState());
      expect(shown(page, 'listing-error')).toBe(false);
    } finally {
      page.close();
    }
    expect((await readAgent(did)).listed).toBe(false);
  });

  it('the section draws the answer\u2019s listed, not the one pressed', async () => {
    const did = await listAgent(githubOwner, { name: 'answer-wins', skills: ['triage'] });
    const page = await render(settingsPath(did), githubOwner);
    // The route answers 200 with the agent still listed.
    const real = agentRepo.setListed;
    agentRepo.setListed = async (d: string) => agentRepo.findByDid(d);
    try {
      await pressListing(page);
      expect(puts(page)[0]!.body).toEqual({ listed: false });
      expect(listingState(page)).toEqual(listedState('answer-wins'));
      expect(shown(page, 'listing-error')).toBe(false);
    } finally {
      agentRepo.setListed = real;
      page.close();
    }
  });
});

describe('listing (c) List it again', () => {
  it('sends exactly { listed: true } and redraws listed; the agent reads listed again', async () => {
    const did = await listAgent(githubOwner, { name: 'to-relist', skills: ['triage'] });
    await setListedByApi(githubOwner, did, false);
    const page = await render(settingsPath(did), githubOwner);
    try {
      expect(listingState(page)).toEqual(unlistedState());
      await pressListing(page);
      expect(puts(page)).toHaveLength(1);
      expect(puts(page)[0]!.body).toEqual({ listed: true });
      expect(listingState(page)).toEqual(listedState('to-relist'));
    } finally {
      page.close();
    }
    expect((await readAgent(did)).listed).toBe(true);
  });

  it('both directions from one page: Stop listing, then List it again, two PUTs', async () => {
    const did = await listAgent(githubOwner, { name: 'round-trip', skills: ['triage'] });
    const page = await render(settingsPath(did), githubOwner);
    try {
      await pressListing(page);
      expect(listingState(page)).toEqual(unlistedState());
      await pressListing(page);
      expect(listingState(page)).toEqual(listedState('round-trip'));
      expect(puts(page).map((c) => c.body)).toEqual([{ listed: false }, { listed: true }]);
    } finally {
      page.close();
    }
  });
});

describe('listing (d) one PUT per press', () => {
  it('a second press before the first answers sends nothing', async () => {
    const did = await listAgent(githubOwner, { name: 'listing-twice', skills: ['triage'] });
    const page = await render(settingsPath(did), githubOwner);
    try {
      const btn = listingBtn(page);
      btn.click();
      expect(btn.disabled, 'the button is off while the PUT is out').toBe(true);
      expect(btn.getAttribute('data-busy')).toBe('true');
      btn.click();
      // A click event reaches the listener even on a disabled button when
      // it is dispatched rather than clicked, so the press guard itself is
      // what has to hold here.
      btn.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
      await until(() => listingState(page).button === UNLISTED.button);
      await new Promise((r) => setTimeout(r, 200));
      expect(puts(page)).toHaveLength(1);
      expect(btn.disabled).toBe(false);
      expect(btn.hasAttribute('data-busy')).toBe(false);
    } finally {
      page.close();
    }
  });
});

describe('listing (e) each refusal says one sentence and changes nothing', () => {
  async function refusedListing(page: Page, before: ReturnType<typeof listingState>, sentence: string, sent: number): Promise<void> {
    await pressListing(page);
    expect(puts(page)).toHaveLength(sent);
    await until(() => text(page, 'listing-error') !== '');
    expect(text(page, 'listing-error')).toBe(sentence);
    expect(shown(page, 'listing-error')).toBe(true);
    expect(page.document.getElementById('listing-error')?.getAttribute('role')).toBe('alert');
    expect(listingState(page), 'a refusal redrew the section').toEqual(before);
    expect(listingBtn(page).disabled).toBe(false);
    expect(machineWords(page)).toEqual([]);
  }

  it.each([
    ['401: an unknown token', () => 'no-such-token-at-listing', LISTING_REFUSED[401]],
    ['403: a signed-in stranger\u2019s token', () => stranger.token, LISTING_REFUSED[403]],
  ])('%s swapped in between load and press', async (_label, token, sentence) => {
    const did = await listAgent(githubOwner, { name: 'swapped-listing', skills: ['triage'] });
    const page = await render(settingsPath(did), githubOwner);
    try {
      page.window.sessionStorage.setItem('fa_session', JSON.stringify({ ...githubOwner, token: token() }));
      await refusedListing(page, listedState('swapped-listing'), sentence, 1);
    } finally {
      page.close();
    }
    expect((await readAgent(did)).listed).toBe(true);
  });

  it.each([
    ['404: the agent is gone by the time of the press', async () => null, LISTING_REFUSED[404]],
    ['503: storage fails', async () => { throw new Error('storage down (test)'); }, LISTING_REFUSED.failed],
  ])('%s', async (_label, stub, sentence) => {
    const did = await listAgent(githubOwner, { name: 'listing-refused', skills: ['triage'] });
    await setListedByApi(githubOwner, did, false);
    const page = await render(settingsPath(did), githubOwner);
    const real = agentRepo.setListed;
    agentRepo.setListed = stub as typeof agentRepo.setListed;
    try {
      await refusedListing(page, unlistedState(), sentence, 1);
    } finally {
      agentRepo.setListed = real;
      page.close();
    }
    expect((await readAgent(did)).listed).toBe(false);
  });

  it('a press that never reaches the server gets its own sentence; the next press, back online, goes through and clears it', async () => {
    const did = await listAgent(githubOwner, { name: 'listing-offline', skills: ['triage'] });
    const page = await render(settingsPath(did), githubOwner, { reject: (p, m) => m === 'PUT' && p.endsWith('/listing') });
    try {
      await refusedListing(page, listedState('listing-offline'), LISTING_REFUSED.offline, 1);
      page.reject = null;
      await pressListing(page);
      expect(listingState(page)).toEqual(unlistedState());
      expect(shown(page, 'listing-error'), 'the old sentence beside a press that went through').toBe(false);
    } finally {
      page.close();
    }
  });

  it('a session cleared between load and press sends nothing and says to sign in again', async () => {
    const did = await listAgent(githubOwner, { name: 'listing-cleared', skills: ['triage'] });
    const page = await render(settingsPath(did), githubOwner);
    try {
      page.window.sessionStorage.removeItem('fa_session');
      listingBtn(page).click();
      await new Promise((r) => setTimeout(r, 200));
      expect(puts(page)).toEqual([]);
      expect(text(page, 'listing-error')).toBe(LISTING_REFUSED[401]);
      expect(listingState(page)).toEqual(listedState('listing-cleared'));
    } finally {
      page.close();
    }
  });

  it('the alert node is in the page, role="alert" and empty, before any press', async () => {
    const did = await listAgent(githubOwner, { name: 'listing-live-region', skills: ['triage'] });
    const page = await render(settingsPath(did), githubOwner);
    try {
      const node = page.document.getElementById('listing-error');
      expect(node).not.toBeNull();
      expect(node!.getAttribute('role')).toBe('alert');
      expect(text(page, 'listing-error')).toBe('');
    } finally {
      page.close();
    }
  });
});

describe('listing (f) only the owner sees the section', () => {
  it.each([
    ['a stranger', () => stranger, 'stranger'],
    ['a signed-out visitor', () => null, 'signin-required'],
  ])('%s sees no section and sends no PUT', async (_label, who, state) => {
    const did = await listAgent(githubOwner, { name: 'listing-not-yours', skills: ['triage'] });
    const page = await render(settingsPath(did), who());
    try {
      expect(shown(page, state)).toBe(true);
      expect(page.document.getElementById('listing-section')?.closest('[hidden]')).not.toBeNull();
      listingBtn(page).click();
      await new Promise((r) => setTimeout(r, 200));
      expect(puts(page)).toEqual([]);
    } finally {
      page.close();
    }
    expect((await readAgent(did)).listed).toBe(true);
  });
});

describe('listing (g) the Details form keeps what was typed', () => {
  it('a listing press leaves every typed value, and "Saved." stays unsaid', async () => {
    const did = await listAgent(githubOwner, { name: 'typed-then-unlisted', skills: ['triage'] });
    const page = await render(settingsPath(did), githubOwner);
    try {
      type(page, 'nm', 'half-typed');
      type(page, 'ds', 'Not saved yet.');
      type(page, 'sk', 'go, sql');
      type(page, 'fl', '12');
      await pressListing(page);
      expect(listingState(page)).toEqual(unlistedState());
      expect(values(page)).toEqual(['half-typed', 'Not saved yet.', 'go, sql', '12']);
      expect(text(page, 'agent-name')).toBe('typed-then-unlisted');
      expect(text(page, 'saved')).toBe('');
      expect(patches(page)).toEqual([]);
    } finally {
      page.close();
    }
  });

  it('a saved rename renames the button too', async () => {
    const did = await listAgent(githubOwner, { name: 'old-name', skills: ['triage'] });
    const page = await render(settingsPath(did), githubOwner);
    try {
      type(page, 'nm', 'new-name');
      await save(page);
      expect(text(page, 'saved')).toBe('Saved.');
      expect(listingState(page)).toEqual(listedState('new-name'));
    } finally {
      page.close();
    }
  });
});

describe('listing (h) the press reaches browse', () => {
  it('after Stop listing, GET /agents leaves the agent out and GET /agents/:agentDid reads listed: false; after List it again it is back', async () => {
    const did = await listAgent(githubOwner, { name: 'browse-round-trip', skills: ['triage'] });
    expect(await browseDids()).toContain(did);
    const page = await render(settingsPath(did), githubOwner);
    try {
      await pressListing(page);
      expect(listingState(page)).toEqual(unlistedState());
      expect(await browseDids()).not.toContain(did);
      expect(await readAgent(did)).toMatchObject({ did, listed: false });
      await pressListing(page);
      expect(listingState(page)).toEqual(listedState('browse-round-trip'));
      expect(await browseDids()).toContain(did);
      expect(await readAgent(did)).toMatchObject({ did, listed: true });
    } finally {
      page.close();
    }
  });

  it('/myagents marks an unlisted row "Not listed" beside its name, from the roster read alone', async () => {
    nextLogin = 'listing-roster-owner';
    const owner = await mintSession(sessions);
    const shown = await listAgent(owner, { name: 'roster-listed', skills: ['triage'] });
    const hidden = await listAgent(owner, { name: 'roster-unlisted', skills: ['triage'] });
    const shape = (page: Page): string[] => page.calls.map((c) => `${c.method} ${c.path.replace(/did%3A[^/?]+/g, '<did>')}`).sort();
    const before = await render('/myagents', owner);
    let callsBefore: string[];
    try {
      await until(() => before.document.querySelectorAll('[data-agent-row]').length === 2);
      await new Promise((r) => setTimeout(r, 200));
      expect(before.document.querySelectorAll('.unlisted')).toHaveLength(0);
      callsBefore = shape(before);
    } finally {
      before.close();
    }
    await setListedByApi(owner, hidden, false);
    const page = await render('/myagents', owner);
    try {
      await until(() => page.document.querySelectorAll('[data-agent-row]').length === 2);
      await new Promise((r) => setTimeout(r, 200));
      const mark = page.document.querySelector(`[data-agent-row="${hidden}"] .nm + .unlisted`);
      expect(mark?.textContent).toBe('Not listed');
      expect(page.document.querySelectorAll('.unlisted')).toHaveLength(1);
      expect(page.document.querySelector(`[data-agent-row="${shown}"] .unlisted`)).toBeNull();
      expect(shape(page), 'the mark cost a request').toEqual(callsBefore);
    } finally {
      page.close();
    }
  });
});

// ----------------------------------------------------------------- (j)

// static_words.py's rule, ported line for line (tests/web/past-work-simple.test.ts).
function staticWords(src: string): string[] {
  const m = src.match(/<main[\s\S]*?<\/main>/);
  let body = m ? m[0] : src;
  body = body.replace(/<(script|style|template)[^>]*>[\s\S]*?<\/\1>/g, '');
  body = body.replace(/<!--[\s\S]*?-->/g, '');
  const words = body.replace(/<[^>]+>/g, ' ');
  const decoded = new JSDOM(`<p>${words.replace(/</g, '&lt;')}</p>`).window.document.body.textContent ?? '';
  return decoded.split(/\s+/).filter(Boolean);
}

describe('(j) words', () => {
  it('the page shell sits in one <main> at 100 words or fewer', () => {
    const src = readFileSync(join(here, '../../src/web/pages/agentsettings.html'), 'utf8');
    expect(src.match(/<main\b/g)).toHaveLength(1);
    expect(staticWords(src).length).toBeLessThanOrEqual(100);
  });

  it('no machine word or DID on the rendered page in any state', async () => {
    const did = await listAgent(githubOwner, { name: 'words-agent', skills: ['triage'], floorPriceUsd: '20.00' });
    const pages = [
      await render(settingsPath(did), null),
      await render('/agentsettings', githubOwner),
      await render(settingsPath(did), stranger),
      await render(settingsPath(did), githubOwner),
      await render(settingsPath(did), githubOwner),
    ];
    try {
      const [, , , refused, saved] = pages;
      type(refused!, 'fl', 'forty');
      (refused!.document.getElementById('save-btn') as HTMLButtonElement).click();
      expect(shown(refused!, 'form-error')).toBe(true);
      await save(saved!);
      expect(text(saved!, 'saved')).toBe('Saved.');
      for (const page of pages) expect(machineWords(page)).toEqual([]);
    } finally {
      for (const page of pages) page.close();
    }
  });
});

// ----------------------------------------------------------------- (k)

const captureDir = process.env.AGENTSETTINGS_CAPTURE_DIR ?? '';

async function capture(browser: RealBrowser, name: string): Promise<void> {
  if (captureDir === '') return;
  mkdirSync(captureDir, { recursive: true });
  const shot = (await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })) as { result?: { data?: string } };
  if (shot.result?.data) writeFileSync(join(captureDir, `${name}.png`), Buffer.from(shot.result.data, 'base64'));
}

// Every visible link, button and text field in <main>, and the page's width.
const SWEEP = `(function () {
  var doc = document.documentElement;
  var controls = [].filter.call(document.querySelectorAll('main a[href], main button, main input'), function (el) {
    var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
  });
  return {
    scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, measured: controls.length,
    small: controls.filter(function (el) { var r = el.getBoundingClientRect(); return r.width < 44 || r.height < 44; })
      .map(function (el) { var r = el.getBoundingClientRect(); return (el.id || el.className || el.tagName) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); }),
    running: document.getAnimations().filter(function (a) { return a.playState === 'running'; }).length
  };
})()`;
interface Swept { scrollWidth: number; clientWidth: number; measured: number; small: string[]; running: number }

const VIEWPORTS = [[320, true], [390, true], [1280, false]] as const;

async function wait(browser: RealBrowser, expression: string): Promise<boolean> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await browser.evaluate<boolean>(expression)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function launch(width: number, touch: boolean): Promise<RealBrowser> {
  const browser = await RealBrowser.launch({ width, height: 900 });
  if (touch) {
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 2, mobile: true });
    await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  }
  await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await browser.goto(`${baseUrl}/signin`, 300);
  await browser.evaluate(`sessionStorage.clear(); sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(githubOwner))})`);
  return browser;
}

describe('(k) laid out right in real Chrome, under reduced motion', () => {
  it.each(VIEWPORTS)('%ipx (touch: %s): the filled form, a refusal, the saved state, a GitHub refusal, each GitHub landing, and the listing section in both states', async (width, touch) => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for the agentsettings layout sweep; skipping (see CHROME_BIN)');
      return;
    }
    const did = await listAgent(githubOwner, { name: `layout-agent-${width}`, description: 'Turns a Figma file into a typed React component.', skills: ['React', 'TypeScript', 'Accessibility'], floorPriceUsd: '40.00' });
    const browser = await launch(width, touch);
    try {
      const check = async (state: string, controls = 8): Promise<void> => {
        const got = await browser.evaluate<Swept>(SWEEP);
        // Back to my agents, four fields, Save changes, Confirm GitHub
        // while the agent is unconfirmed, and the listing button.
        expect(got.measured, `${state}: the controls measured`).toBe(controls);
        expect(got.scrollWidth, `${state} at ${width}: sideways scroll`).toBe(got.clientWidth);
        // The page sets its 44px floor at every width, so it is held at
        // 1280 with a mouse too, not only on touch.
        expect(got.small, `${state} at ${width}: under 44px`).toEqual([]);
        expect(got.running, `${state}: an animation running under reduced motion`).toBe(0);
      };
      await browser.goto(`${baseUrl}${settingsPath(did)}`, 600);
      expect(await wait(browser, `!document.getElementById('settings-body').hidden`), 'the owner\u2019s form').toBe(true);
      await check('the filled form');
      await capture(browser, `agentsettings-filled-${width}`);
      await browser.evaluate(`(function () { document.getElementById('fl').value = '40.5.0'; document.getElementById('save-btn').click(); })()`);
      expect(await browser.evaluate<boolean>(`!document.getElementById('form-error').hidden`)).toBe(true);
      await check('the refusal');
      await capture(browser, `agentsettings-refusal-${width}`);
      await browser.evaluate(`(function () { document.getElementById('fl').value = '45'; document.getElementById('save-btn').click(); })()`);
      expect(await wait(browser, `document.getElementById('saved').textContent === 'Saved.'`), 'the saved state').toBe(true);
      await check('the saved state');
      await capture(browser, `agentsettings-saved-${width}`);
      // FIX-B47c: the GitHub section refused (a stale token), then each
      // landing sentence GitHub's callback can bring the owner back to.
      await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify({ ...githubOwner, token: 'no-such-token-layout' }))}); document.getElementById('gh-confirm').click()`);
      expect(await wait(browser, `document.getElementById('gh-error').textContent !== ''`), 'the GitHub refusal').toBe(true);
      await check('the GitHub refusal');
      await capture(browser, `agentsettings-github-refusal-${width}`);
      await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(githubOwner))})`);
      for (const outcome of ['refused', 'failed']) {
        await browser.goto(`${baseUrl}${settingsPath(did)}&github=${outcome}`, 600);
        expect(await wait(browser, `document.getElementById('gh-outcome').textContent !== ''`), `the ${outcome} landing`).toBe(true);
        await check(`the ${outcome} landing`);
        await capture(browser, `agentsettings-github-${outcome}-${width}`);
      }
      const confirmed = await listAgent(githubOwner, { name: `layout-confirmed-${width}`, skills: ['React'], githubLogin: 'settings-owner' });
      await browser.goto(`${baseUrl}${settingsPath(confirmed)}&github=verified`, 600);
      expect(await wait(browser, `document.getElementById('gh-outcome').textContent === 'GitHub confirmed.'`), 'the verified landing').toBe(true);
      await check('the verified landing', 7);
      await capture(browser, `agentsettings-github-verified-${width}`);
      // FIX-B43b: the listing section, pressed in real Chrome both ways.
      // The long name is the widest label the button can carry here.
      const listingHeight = `Math.round(document.getElementById('listing-btn').getBoundingClientRect().height)`;
      const longName = `layout-listing-a-long-agent-name-${width}`;
      const listing = await listAgent(githubOwner, { name: longName, skills: ['React'], githubLogin: 'settings-owner' });
      await browser.goto(`${baseUrl}${settingsPath(listing)}`, 600);
      expect(await wait(browser, `document.getElementById('listing-btn').textContent === ${JSON.stringify(`Stop listing ${longName}`)}`), 'the listed state').toBe(true);
      expect(await browser.evaluate<number>(listingHeight), 'Stop listing, height').toBeGreaterThanOrEqual(44);
      await check('the listed state', 7);
      await capture(browser, `agentsettings-listed-${width}`);
      await browser.evaluate(`document.getElementById('listing-btn').click()`);
      expect(await wait(browser, `document.getElementById('listing-btn').textContent === 'List it again' && !document.getElementById('listing-btn').disabled`), 'the unlisted state').toBe(true);
      expect(await browser.evaluate<number>(listingHeight), 'List it again, height').toBeGreaterThanOrEqual(44);
      await check('the unlisted state', 7);
      await capture(browser, `agentsettings-unlisted-${width}`);
      // A refusal in the unlisted state: a stale token, then the sentence.
      await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify({ ...githubOwner, token: 'no-such-token-listing-layout' }))}); document.getElementById('listing-btn').click()`);
      expect(await wait(browser, `document.getElementById('listing-error').textContent !== ''`), 'the listing refusal').toBe(true);
      await check('the listing refusal', 7);
      await capture(browser, `agentsettings-listing-refusal-${width}`);
      await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(githubOwner))})`);
      expect((await readAgent(listing)).listed).toBe(false);
    } finally {
      await browser.close();
    }
  }, BROWSER_TIMEOUT_MS);

  it.each([[320], [390]])('/myagents at %ipx on touch: the Settings and "confirm it" links are 44px and nothing scrolls sideways', async (width) => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for the agentsettings layout sweep; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await launch(width, true);
    try {
      await browser.goto(`${baseUrl}/myagents`, 600);
      expect(await wait(browser, `document.querySelectorAll('.arow .settings-link').length > 0 && document.querySelectorAll('.arow .attn a[href^="/agentsettings"]').length > 0`), 'a row\u2019s Settings and confirm it links').toBe(true);
      const got = await browser.evaluate<{ sizes: number[][]; scrollWidth: number; clientWidth: number; running: number }>(`(function () {
        var links = [].slice.call(document.querySelectorAll('.arow .settings-link, .arow .attn a[href^="/agentsettings"]'));
        return {
          sizes: links.map(function (a) { var r = a.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }),
          scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
          running: document.getAnimations().filter(function (a) { return a.playState === 'running'; }).length
        };
      })()`);
      expect(got.sizes.length).toBeGreaterThan(0);
      for (const [w, h] of got.sizes) {
        expect(w, 'link width').toBeGreaterThanOrEqual(44);
        expect(h, 'link height').toBeGreaterThanOrEqual(44);
      }
      expect(got.scrollWidth, `/myagents at ${width}: sideways scroll`).toBe(got.clientWidth);
      expect(got.running).toBe(0);
      await capture(browser, `myagents-settings-${width}`);
    } finally {
      await browser.close();
    }
  }, BROWSER_TIMEOUT_MS);
});
