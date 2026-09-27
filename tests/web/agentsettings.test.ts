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

async function start(repo: MemoryAgentRepository, write: number, adapter: ReturnType<typeof createSessionAdapter>): Promise<[Server, string]> {
  const s = createApp(
    new MemoryAccountRepository(), repo, createIdentityAdapter(createKnownKeyStore()),
    undefined, undefined, undefined, undefined, undefined,
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

interface Call { readonly path: string; readonly method: string; readonly body: Record<string, unknown> | null; readonly authed: boolean }
interface Page {
  window: JSDOM['window']; document: Document; calls: Call[];
  // When set, a matching request rejects the way fetch does offline.
  reject: ((path: string, method: string) => boolean) | null;
  close: () => void;
}

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
}

async function render(path: string, session: Session | null, opts: { base?: string; reject?: Page['reject'] } = {}): Promise<Page> {
  const base = opts.base ?? baseUrl;
  const failures: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e: Error) => failures.push(e.message));
  const markup = await (await fetch(`${base}${path}`, { headers: { Accept: HTML } })).text();
  const calls: Call[] = [];
  const page = { calls, reject: opts.reject ?? null } as Page;
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
          });
          if (page.reject?.(String(input), method)) return Promise.reject(new TypeError('Failed to fetch'));
          return fetch(new URL(input, base), init);
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
  it.each(VIEWPORTS)('%ipx (touch: %s): the filled form, a refusal, and the saved state', async (width, touch) => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for the agentsettings layout sweep; skipping (see CHROME_BIN)');
      return;
    }
    const did = await listAgent(githubOwner, { name: `layout-agent-${width}`, description: 'Turns a Figma file into a typed React component.', skills: ['React', 'TypeScript', 'Accessibility'], floorPriceUsd: '40.00' });
    const browser = await launch(width, touch);
    try {
      const check = async (state: string): Promise<void> => {
        const got = await browser.evaluate<Swept>(SWEEP);
        // Back to my agents, four fields, Save changes.
        expect(got.measured, `${state}: the controls measured`).toBe(6);
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
    } finally {
      await browser.close();
    }
  }, BROWSER_TIMEOUT_MS);

  it.each([[320], [390]])('/myagents at %ipx on touch: the Settings link is 44px and nothing scrolls sideways', async (width) => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for the agentsettings layout sweep; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await launch(width, true);
    try {
      await browser.goto(`${baseUrl}/myagents`, 600);
      expect(await wait(browser, `document.querySelectorAll('.arow .settings-link').length > 0`), 'a row\u2019s Settings link').toBe(true);
      const got = await browser.evaluate<{ sizes: number[][]; scrollWidth: number; clientWidth: number; running: number }>(`(function () {
        var links = [].slice.call(document.querySelectorAll('.arow .settings-link'));
        return {
          sizes: links.map(function (a) { var r = a.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }),
          scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
          running: document.getAnimations().filter(function (a) { return a.playState === 'running'; }).length
        };
      })()`);
      expect(got.sizes.length).toBeGreaterThan(0);
      for (const [w, h] of got.sizes) {
        expect(w, 'Settings link width').toBeGreaterThanOrEqual(44);
        expect(h, 'Settings link height').toBeGreaterThanOrEqual(44);
      }
      expect(got.scrollWidth, `/myagents at ${width}: sideways scroll`).toBe(got.clientWidth);
      expect(got.running).toBe(0);
      await capture(browser, `myagents-settings-${width}`);
    } finally {
      await browser.close();
    }
  }, BROWSER_TIMEOUT_MS);
});
