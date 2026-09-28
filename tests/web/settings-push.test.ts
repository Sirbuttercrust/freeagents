// FIX-PUSH: phone and desktop notifications, turned on from Settings with one
// press. The switch is driven end to end against the real app: POST and
// DELETE /accounts/:did/push-subscriptions answer for real, and the server's
// side is read back from the push subscription repository the app was built
// with. Only the browser's own push machinery is stubbed (jsdom has no
// service worker, Push API or Notification), and a stub stands in for the
// browser, never for the server.
//
// Also here: the service worker itself, run in a vm context (g); GET /sw.js
// and the manifest (h, i); and the row in real Chrome at 320, 390 and 1280 (l).
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { JSDOM, VirtualConsole } from 'jsdom';
import webpush from 'web-push';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { createPushSender } from '../../src/adapters/push/push.js';
import type { PushSender } from '../../src/adapters/push/push.js';
import { MemoryAccountRepository, MemoryPushSubscriptionRepository } from '../../src/adapters/storage/memory.js';
import type { PushSubscription as StoredPushSubscription } from '../../src/domain/notification.js';
import type { Session } from '../../src/adapters/identity/session.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession } from '../helpers/session-fixtures.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const PLATFORM_SEED = 'e'.repeat(64);
const BROWSER_TIMEOUT_MS = 60_000;
const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '../../src/web/public');

const SENTENCES = {
  blocked: "Notifications are blocked for this site. Allow them in your browser's settings, then try again.",
  dismissed: 'Nothing changed.',
  expired: 'Your session has expired. Sign in again to turn this on.',
  failed: 'That did not go through. Try again in a moment.',
  offline: 'That did not reach the server. Check your connection and try again.',
  offAnyway: 'Notifications are off on this device. The server did not confirm, but nothing more will reach it.',
};

// A repository whose upsert can be made to throw, so the route answers its
// own 503 (decision 7's "anything else").
class FlakyPushRepo extends MemoryPushSubscriptionRepository {
  failUpsert = false;
  override async upsert(subscription: StoredPushSubscription): Promise<StoredPushSubscription> {
    if (this.failUpsert) throw new Error('storage down');
    return super.upsert(subscription);
  }
}

// createApp's positional parameters, filled only where this file needs them.
function buildApp(accounts: MemoryAccountRepository, session: ReturnType<typeof createSessionAdapter>, pushRepo: MemoryPushSubscriptionRepository, sender: PushSender) {
  const u = undefined;
  return createApp(accounts, u, u, u, u, u, u, u, { read: 100_000, write: 100_000 }, u, u, session,
    u, u, u, u, u, u, u, u, u, u, u, u, u, pushRepo, u, sender);
}

async function listen(app: ReturnType<typeof createApp>): Promise<{ server: Server; url: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const keys = webpush.generateVAPIDKeys();
let server: Server;
let nullServer: Server;
let baseUrl: string;
let nullKeyUrl: string;
let session: Session;
let ownDid: string;
const pushRepo = new FlakyPushRepo();

beforeAll(async () => {
  process.env.FREEAGENTS_PLATFORM_SEED = PLATFORM_SEED;
  const accounts = new MemoryAccountRepository();
  const sessionAdapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'push-switch-owner', id: 9911 }) });
  const sender = createPushSender({ subject: 'mailto:test@example.invalid', publicKey: keys.publicKey, privateKey: keys.privateKey });
  ({ server, url: baseUrl } = await listen(buildApp(accounts, sessionAdapter, pushRepo, sender)));
  // The same accounts and sessions, on a deployment with no push key.
  ({ server: nullServer, url: nullKeyUrl } = await listen(
    buildApp(accounts, sessionAdapter, new MemoryPushSubscriptionRepository(), { publicKey: null, async send() {} }),
  ));
  session = await mintSession(sessionAdapter);
  const me = await fetch(`${baseUrl}/accounts/me`, { headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}` } });
  ownDid = ((await me.json()) as { did: string }).did;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => nullServer.close(() => resolve()));
});

beforeEach(async () => {
  pushRepo.failUpsert = false;
  for (const row of await pushRepo.listByAccountDid(ownDid)) await pushRepo.removeByEndpoint(row.endpoint);
});

// ------------------------------------------------------------ the browser stub

interface FakeSub { endpoint: string; toJSON: () => unknown; unsubscribe: () => Promise<boolean> }
interface Browser {
  secure?: boolean; serviceWorker?: boolean; pushManager?: boolean; notification?: boolean;
  permission?: string; answer?: string; existing?: boolean;
}
interface Stub {
  log: string[];
  sub: FakeSub | null;
  subscribeOptions: Array<{ userVisibleOnly: boolean; applicationServerKey: Uint8Array }>;
  permissionAskedInClick: boolean[];
  unsubscribed: string[];
}

let counter = 0;
function fakeSub(stub: Stub): FakeSub {
  counter += 1;
  const endpoint = `https://push.example.invalid/send/${counter}`;
  const sub: FakeSub = {
    endpoint,
    toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: `p256dh-${counter}`, auth: `auth-${counter}` } }),
    unsubscribe: async () => { stub.unsubscribed.push(endpoint); if (stub.sub === sub) stub.sub = null; return true; },
  };
  return sub;
}

function install(window: JSDOM['window'], opts: Browser, stub: Stub): void {
  Object.defineProperty(window, 'isSecureContext', { value: opts.secure ?? true, configurable: true });
  // A click is being dispatched exactly between the window's capture and
  // bubble listeners, which is how "asked inside the press" is observed.
  let inClick = false;
  window.addEventListener('click', () => { inClick = true; }, true);
  window.addEventListener('click', () => { inClick = false; });
  let registered = opts.existing ?? false;
  const reg = {
    pushManager: {
      subscribe: async (o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
        stub.log.push('subscribe');
        stub.subscribeOptions.push(o);
        stub.sub = fakeSub(stub);
        return stub.sub;
      },
      getSubscription: async () => stub.sub,
    },
  };
  if (opts.serviceWorker !== false) {
    Object.defineProperty(window.navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register: async (url: string) => { stub.log.push(`register ${url}`); registered = true; return reg; },
        // Resolves only once a worker was registered, as the real one does.
        get ready() { return registered ? Promise.resolve(reg) : new Promise(() => {}); },
        getRegistration: async () => (registered ? reg : undefined),
      },
    });
  }
  if (opts.pushManager !== false) Object.defineProperty(window, 'PushManager', { value: function PushManager() {}, configurable: true });
  if (opts.notification !== false) {
    const N = {
      permission: opts.permission ?? 'default',
      requestPermission: () => {
        stub.log.push('requestPermission');
        stub.permissionAskedInClick.push(inClick);
        N.permission = opts.answer ?? 'granted';
        return Promise.resolve(N.permission);
      },
    };
    Object.defineProperty(window, 'Notification', { value: N, configurable: true });
  }
  if (opts.existing) stub.sub = fakeSub(stub);
}

// Holds, fails, or answers 503 to one request the page makes; null lets it
// through to the real app.
type Gate = (path: string, method: string) => Promise<void> | 'reject' | '503' | null;

interface Page {
  window: JSDOM['window'];
  document: Document;
  stub: Stub;
  calls: Array<{ method: string; path: string; body: unknown; auth: string }>;
  hold: (fn: Gate | null) => void;
  close: () => void;
}

async function renderSettings(opts: Browser & { from?: string; signedIn?: boolean; gate?: Gate } = {}): Promise<Page> {
  const from = opts.from ?? baseUrl;
  const failures: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e: Error) => failures.push(e.message));
  const markup = await (await fetch(`${from}/settings`, { headers: { Accept: HTML } })).text();
  const stub: Stub = { log: [], sub: null, subscribeOptions: [], permissionAskedInClick: [], unsubscribed: [] };
  const calls: Page['calls'] = [];
  let gate: Gate | null = opts.gate ?? null;
  const dom = new JSDOM(markup, {
    url: `${from}/settings`, runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      if (opts.signedIn !== false) window.sessionStorage.setItem('fa_session', JSON.stringify(session));
      install(window, opts, stub);
      Object.defineProperty(window, 'fetch', {
        writable: true,
        value: async (input: string, init?: RequestInit) => {
          const path = new URL(input, from).pathname;
          const method = init?.method ?? 'GET';
          const headers = (init?.headers ?? {}) as Record<string, string>;
          calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.Authorization ?? '' });
          const held = gate ? gate(path, method) : null;
          if (held === 'reject') throw new TypeError('Failed to fetch');
          if (held === '503') return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
          if (held) await held;
          return fetch(new URL(input, from), init);
        },
      });
    },
  });
  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', () => resolve());
  });
  await until(() => !dom.window.document.getElementById('settings-body')!.hidden || !dom.window.document.getElementById('signin-required')!.hidden);
  await new Promise((r) => setTimeout(r, 300));
  if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);
  return { window: dom.window, document: dom.window.document, stub, calls, hold: (fn) => { gate = fn; }, close: () => dom.window.close() };
}

async function until(fn: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
}

const toggle = (p: Page) => p.document.getElementById('push-toggle') as HTMLInputElement;
const stateText = (p: Page) => p.document.getElementById('push-state')?.textContent ?? '';
const note = (p: Page) => p.document.getElementById('push-note')?.textContent ?? '';
const pushCalls = (p: Page, method: string) => p.calls.filter((c) => c.method === method && c.path.endsWith('/push-subscriptions'));
const serverRows = () => pushRepo.listByAccountDid(ownDid);

async function press(p: Page): Promise<void> {
  toggle(p).click();
  await until(() => !toggle(p).disabled);
  await new Promise((r) => setTimeout(r, 30));
}

async function expectAbsent(p: Page): Promise<void> {
  expect(p.document.getElementById('push-row')).toBeNull();
  expect(p.document.getElementById('push-toggle')).toBeNull();
  expect(p.document.body.textContent ?? '').not.toContain('Notifications on this device');
}

// ------------------------------------------------------------------ (a) (b)

describe('(a) the switch is absent wherever push cannot work', () => {
  it('the key route answering null: the key is read, and no row is built', async () => {
    const page = await renderSettings({ from: nullKeyUrl });
    try {
      expect(page.document.getElementById('settings-body')!.hidden).toBe(false);
      expect(page.calls.some((c) => c.path === '/push/vapid-public-key')).toBe(true);
      await expectAbsent(page);
    } finally { page.close(); }
  });

  it.each([
    ['no PushManager', { pushManager: false }],
    ['no serviceWorker', { serviceWorker: false }],
    ['no Notification', { notification: false }],
    ['not a secure context', { secure: false }],
  ] as const)('%s: no row, and the key is never read', async (_name, opts) => {
    const page = await renderSettings(opts);
    try {
      expect(page.document.getElementById('settings-body')!.hidden).toBe(false);
      expect(page.calls.some((c) => c.path === '/push/vapid-public-key')).toBe(false);
      await expectAbsent(page);
    } finally { page.close(); }
  });

  it('signed out: the sign-in block, and no row', async () => {
    const page = await renderSettings({ signedIn: false });
    try {
      expect(page.document.getElementById('signin-required')!.hidden).toBe(false);
      await expectAbsent(page);
    } finally { page.close(); }
  });

  it.each([
    ['answers 503', '503'],
    ['never reaches the server', 'reject'],
  ] as const)('the key read that %s: no row', async (_n, outcome) => {
    const page = await renderSettings({ gate: (path) => (path === '/push/vapid-public-key' ? outcome : null) });
    try {
      expect(page.document.getElementById('settings-body')!.hidden).toBe(false);
      expect(page.calls.some((c) => c.path === '/push/vapid-public-key')).toBe(true);
      await expectAbsent(page);
    } finally { page.close(); }
  });
});

describe('(b) shown, and its state on load is this browser\u2019s own (decision 6)', () => {
  it('a key and a capable browser with no subscription: the row reads Off, and nothing was asked or registered', async () => {
    const page = await renderSettings();
    try {
      expect(await until(() => toggle(page) !== null)).toBe(true);
      expect(toggle(page).checked).toBe(false);
      expect(stateText(page)).toBe('Off');
      expect(page.document.getElementById('push-label')!.textContent).toBe('Notifications on this device');
      expect(page.stub.log).toEqual([]);
      // Inside the connected-accounts pane, after its account rows.
      expect(page.document.getElementById('push-row')!.parentElement!.id).toBe('account-rows');
      // Under 20 words, and no word of the machinery on screen.
      const words = (page.document.getElementById('push-row')!.textContent ?? '').trim().split(/\s+/);
      expect(words.length).toBeLessThan(20);
      expect(words.join(' ')).not.toMatch(/push|vapid|service worker|subscription|endpoint/i);
    } finally { page.close(); }
  });

  it('a subscription with permission granted reads On', async () => {
    const page = await renderSettings({ existing: true, permission: 'granted' });
    try {
      expect(await until(() => stateText(page) === 'On')).toBe(true);
      expect(toggle(page).checked).toBe(true);
    } finally { page.close(); }
  });

  it('a subscription whose permission was taken away reads Off', async () => {
    const page = await renderSettings({ existing: true, permission: 'denied' });
    try {
      expect(await until(() => toggle(page) !== null)).toBe(true);
      expect(stateText(page)).toBe('Off');
    } finally { page.close(); }
  });
});

// ------------------------------------------------------------ (c) (d) (f)

describe('(c) turning it on: one press, and the server holds it', () => {
  it('asks inside the press, subscribes with the key\u2019s bytes, posts exactly the subscription with the bearer token, then reads On', async () => {
    const page = await renderSettings();
    try {
      await until(() => toggle(page) !== null);
      toggle(page).click();
      // Mid-flight the box is disabled and busy, and still reads Off.
      expect(toggle(page).disabled).toBe(true);
      expect(toggle(page).getAttribute('aria-busy')).toBe('true');
      expect(stateText(page)).toBe('Off');
      await until(() => !toggle(page).disabled);

      expect(page.stub.permissionAskedInClick).toEqual([true]);
      expect(page.stub.log).toEqual(['requestPermission', 'register /sw.js', 'subscribe']);
      const opts = page.stub.subscribeOptions[0]!;
      expect(opts.userVisibleOnly).toBe(true);
      expect(Array.from(opts.applicationServerKey)).toEqual(Array.from(Buffer.from(keys.publicKey, 'base64url')));

      const posts = pushCalls(page, 'POST');
      expect(posts).toHaveLength(1);
      expect(decodeURIComponent(posts[0]!.path)).toBe(`/accounts/${ownDid}/push-subscriptions`);
      expect(posts[0]!.auth).toBe(`Bearer ${session.token}`);
      expect(posts[0]!.body).toEqual(page.stub.sub!.toJSON());

      const rows = await serverRows();
      expect(rows.map((r) => [r.endpoint, r.p256dh, r.auth])).toEqual([[page.stub.sub!.endpoint, expect.stringMatching(/^p256dh-/), expect.stringMatching(/^auth-/)]]);
      expect(stateText(page)).toBe('On');
      expect(toggle(page).checked).toBe(true);
      expect(toggle(page).hasAttribute('aria-busy')).toBe(false);
      expect(note(page)).toBe('');
    } finally { page.close(); }
  });
});

describe('(d) turning it off', () => {
  it('one DELETE with the endpoint, the server row gone, the browser unsubscribed, Off', async () => {
    const page = await renderSettings({ existing: true, permission: 'granted' });
    try {
      await until(() => stateText(page) === 'On');
      const endpoint = page.stub.sub!.endpoint;
      await pushRepo.upsert({ id: 'ps-seed', accountDid: ownDid, endpoint, p256dh: 'p', auth: 'a', createdAt: new Date() });
      await press(page);
      const deletes = pushCalls(page, 'DELETE');
      expect(deletes).toHaveLength(1);
      expect(deletes[0]!.body).toEqual({ endpoint });
      expect(await serverRows()).toEqual([]);
      expect(page.stub.unsubscribed).toEqual([endpoint]);
      expect(stateText(page)).toBe('Off');
      expect(toggle(page).checked).toBe(false);
      expect(note(page)).toBe('');
    } finally { page.close(); }
  });

  it('a DELETE the server refuses still unsubscribes the browser, reads Off, and says so', async () => {
    const page = await renderSettings({ existing: true, permission: 'granted' });
    try {
      await until(() => stateText(page) === 'On');
      const endpoint = page.stub.sub!.endpoint;
      page.window.sessionStorage.setItem('fa_session', JSON.stringify({ ...session, token: 'a-token-nobody-minted' }));
      await press(page);
      expect(pushCalls(page, 'DELETE')).toHaveLength(1);
      expect(page.stub.unsubscribed).toEqual([endpoint]);
      expect(stateText(page)).toBe('Off');
      expect(note(page)).toBe(SENTENCES.offAnyway);
    } finally { page.close(); }
  });
});

describe('(f) one press at a time', () => {
  it('two presses and a press on the label before the POST answers send one POST', async () => {
    const page = await renderSettings();
    try {
      await until(() => toggle(page) !== null);
      let release: () => void = () => {};
      const held = new Promise<void>((r) => { release = r; });
      page.hold((path, method) => (method === 'POST' && path.endsWith('/push-subscriptions') ? held : null));
      toggle(page).click();
      await until(() => pushCalls(page, 'POST').length === 1);
      toggle(page).click();
      (page.document.getElementById('push-switch') as HTMLLabelElement).click();
      await new Promise((r) => setTimeout(r, 100));
      release();
      await until(() => !toggle(page).disabled);
      await new Promise((r) => setTimeout(r, 100));
      expect(pushCalls(page, 'POST')).toHaveLength(1);
      expect(page.stub.subscribeOptions).toHaveLength(1);
      expect(stateText(page)).toBe('On');
    } finally { page.close(); }
  });
});

// ------------------------------------------------------------------- (e) (j)

describe('(e) every refusal: its own sentence, Off, nothing left behind, the box enabled again', () => {
  const cases: Array<[string, Browser, (p: Page) => void, string, boolean]> = [
    ['permission denied', { answer: 'denied' }, () => {}, SENTENCES.blocked, false],
    ['permission dismissed', { answer: 'default' }, () => {}, SENTENCES.dismissed, false],
    ['a 401 from the POST (a token nobody minted)', {}, (p) => p.window.sessionStorage.setItem('fa_session', JSON.stringify({ ...session, token: 'a-token-nobody-minted' })), SENTENCES.expired, true],
    ['a 503 from the POST (storage down)', {}, () => { pushRepo.failUpsert = true; }, SENTENCES.failed, true],
    ['a POST that never reached the server', {}, (p) => p.hold((path, method) => (method === 'POST' && path.endsWith('/push-subscriptions') ? 'reject' : null)), SENTENCES.offline, true],
  ];
  it.each(cases)('%s', async (_name, opts, arrange, sentence, subscribed) => {
    const page = await renderSettings(opts);
    try {
      await until(() => toggle(page) !== null);
      arrange(page);
      await press(page);
      expect(note(page)).toBe(sentence);
      expect(stateText(page)).toBe('Off');
      expect(toggle(page).checked).toBe(false);
      expect(toggle(page).disabled).toBe(false);
      expect(page.stub.sub).toBeNull();
      expect(page.stub.subscribeOptions).toHaveLength(subscribed ? 1 : 0);
      expect(page.stub.unsubscribed).toHaveLength(subscribed ? 1 : 0);
      expect(await serverRows()).toEqual([]);
    } finally { page.close(); }
  });
});

describe('(j) the sentence node is a live region from the moment it is built', () => {
  it('#push-note carries role="alert" before anything is written into it, and the sentence lands there', async () => {
    const page = await renderSettings({ answer: 'denied' });
    try {
      await until(() => toggle(page) !== null);
      const n = page.document.getElementById('push-note')!;
      expect(n.getAttribute('role')).toBe('alert');
      expect(n.textContent).toBe('');
      expect(n.hidden).toBe(false);
      await press(page);
      expect(page.document.getElementById('push-note')).toBe(n);
      expect(n.textContent).toBe(SENTENCES.blocked);
    } finally { page.close(); }
  });
});

// ------------------------------------------------------------------------ (g)

describe('(g) the service worker', () => {
  // Read per test, so a missing worker fails each case rather than the file.
  const source = () => readFileSync(join(publicDir, 'js/sw.js'), 'utf8');
  interface Win { url: string; focused: boolean; navigated: string[]; focusCalls: number; navigate: (u: string) => Promise<unknown>; focus: () => Promise<unknown> }
  function load(windows: Win[] = []) {
    const listeners: Record<string, (e: unknown) => void> = {};
    const shown: Array<[string, Record<string, unknown>]> = [];
    const opened: string[] = [];
    let claimed = 0;
    const self = {
      addEventListener: (type: string, fn: (e: unknown) => void) => { listeners[type] = fn; },
      location: { origin: 'https://freeagents.test' },
      registration: { showNotification: async (title: string, options: Record<string, unknown>) => { shown.push([title, options]); } },
      clients: {
        claim: async () => { claimed += 1; },
        matchAll: async () => windows,
        openWindow: async (u: string) => { opened.push(u); return null; },
      },
    };
    vm.runInNewContext(source(), { self, URL });
    const fire = async (type: string, e: Record<string, unknown>) => {
      const waits: Array<Promise<unknown>> = [];
      listeners[type]!({ ...e, waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await Promise.all(waits);
    };
    return { listeners, shown, opened, fire, claims: () => claimed };
  }
  function win(url: string, focused: boolean, navigates = true): Win {
    const w: Win = {
      url, focused, navigated: [], focusCalls: 0,
      navigate: async (u: string) => { if (!navigates) throw new TypeError('not controlled'); w.navigated.push(u); return w; },
      focus: async () => { w.focusCalls += 1; return w; },
    };
    return w;
  }
  const clickOn = (data: unknown) => { let closed = 0; return { e: { notification: { data, close: () => { closed += 1; } } }, closed: () => closed }; };

  it('listens for push, activate and notificationclick, and nothing else (no fetch handler, no cache)', () => {
    expect(Object.keys(load().listeners).sort()).toEqual(['activate', 'notificationclick', 'push']);
  });

  it('a push shows its title and body, carries the jobId, and is tagged by it', async () => {
    const sw = load();
    await sw.fire('push', { data: { json: () => ({ title: 'FreeAgents', body: 'You have a new message.', jobId: 'j-1' }) } });
    expect(sw.shown).toEqual([['FreeAgents', { body: 'You have a new message.', icon: '/icon-192.png', data: { jobId: 'j-1' }, tag: 'j-1' }]]);
  });

  it.each([
    ['will not parse', { data: { json: () => { throw new SyntaxError('bad'); } } }],
    ['has no payload', { data: null }],
  ])('a push that %s still shows FreeAgents and the fallback sentence', async (_n, e) => {
    const sw = load();
    await sw.fire('push', e);
    expect(sw.shown).toEqual([['FreeAgents', { body: 'You have a new notification.', icon: '/icon-192.png', data: { jobId: '' } }]]);
  });

  it('activate claims the open pages', async () => {
    const sw = load();
    await sw.fire('activate', {});
    expect(sw.claims()).toBe(1);
  });

  it('a click with a jobId closes it and navigates the focused open window to the conversation, then focuses it', async () => {
    const other = win('https://freeagents.test/browse', false);
    const focused = win('https://freeagents.test/settings', true);
    const sw = load([other, focused]);
    const c = clickOn({ jobId: 'j-9' });
    await sw.fire('notificationclick', c.e);
    expect(c.closed()).toBe(1);
    expect(focused.navigated).toEqual(['https://freeagents.test/messages?job=j-9']);
    expect(focused.focusCalls).toBe(1);
    expect(other.navigated).toEqual([]);
    expect(sw.opened).toEqual([]);
  });

  it('opens a window when none is open, and when the open one cannot be navigated', async () => {
    const none = load();
    await none.fire('notificationclick', clickOn({ jobId: 'j-9' }).e);
    expect(none.opened).toEqual(['https://freeagents.test/messages?job=j-9']);
    const stuck = win('https://freeagents.test/', true, false);
    const uncontrolled = load([stuck]);
    await uncontrolled.fire('notificationclick', clickOn({ jobId: 'j-9' }).e);
    expect(uncontrolled.opened).toEqual(['https://freeagents.test/messages?job=j-9']);
    expect(stuck.focusCalls).toBe(0);
  });

  it('a click without a jobId opens /messages', async () => {
    const sw = load();
    await sw.fire('notificationclick', clickOn({ jobId: '' }).e);
    expect(sw.opened).toEqual(['https://freeagents.test/messages']);
  });
});

// ------------------------------------------------------------------- (h) (i)

describe('(h) GET /sw.js and (i) the manifest', () => {
  it('GET /sw.js answers 200 as JavaScript, no-cache, with the committed bytes', async () => {
    const res = await fetch(`${baseUrl}/sw.js`, { headers: { Accept: '*/*' } });
    expect(res.status).toBe(200);
    expect(String(res.headers.get('content-type')).split(';')[0]).toBe('text/javascript');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(Buffer.from(await res.arrayBuffer()).equals(readFileSync(join(publicDir, 'js/sw.js')))).toBe(true);
  });

  it('the manifest opens at / as a standalone app, which iPhone and iPad need before they deliver a push', async () => {
    const manifest = (await (await fetch(`${baseUrl}/site.webmanifest`)).json()) as Record<string, unknown>;
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
  });
});

// ------------------------------------------------------------------------ (l)

const captureDir = process.env.SETTINGS_PUSH_CAPTURE_DIR ?? '';
async function capture(b: RealBrowser, name: string): Promise<void> {
  if (captureDir === '') return;
  mkdirSync(captureDir, { recursive: true });
  const shot = (await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })) as { result?: { data?: string } };
  if (shot.result?.data) writeFileSync(join(captureDir, `${name}.png`), Buffer.from(shot.result.data, 'base64'));
}

const SWEEP = `(function () {
  var doc = document.documentElement;
  var label = document.getElementById('push-switch');
  var r = label ? label.getBoundingClientRect() : null;
  var row = document.getElementById('push-row');
  var rr = row ? row.getBoundingClientRect() : null;
  return {
    present: !!label, w: r ? r.width : 0, h: r ? r.height : 0,
    rowRight: rr ? rr.right : 0, vw: doc.clientWidth,
    scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth,
    running: document.getAnimations().filter(function (a) { return a.playState === 'running'; }).length,
    note: (document.getElementById('push-note') || {}).textContent || '',
    state: (document.getElementById('push-state') || {}).textContent || ''
  };
})()`;
interface Swept { present: boolean; w: number; h: number; rowRight: number; vw: number; scrollWidth: number; clientWidth: number; running: number; note: string; state: string }

function checkRow(width: number, state: string, g: Swept): void {
  expect(g.present, `${state}: the row is built in real Chrome`).toBe(true);
  expect(g.scrollWidth, `${state} at ${width}: sideways scroll`).toBe(g.clientWidth);
  expect(g.rowRight, `${state} at ${width}: the row runs past the screen`).toBeLessThanOrEqual(g.vw);
  expect(g.h, `${state} at ${width}: the label is under 44px tall`).toBeGreaterThanOrEqual(44);
  expect(g.w, `${state} at ${width}: the label is under 44px wide`).toBeGreaterThanOrEqual(44);
  expect(g.running, `${state}: an animation running under reduced motion`).toBe(0);
}

describe('(l) the row in real Chrome, under reduced motion', () => {
  it.each([[320, true], [390, true], [1280, false]] as const)('%ipx (touch: %s): the row, and the row after a refusal', async (width, touch) => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for the settings push sweep; skipping (see CHROME_BIN)');
      return;
    }
    const b = await RealBrowser.launch({ width, height: 900 });
    try {
      if (touch) {
        await b.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 2, mobile: true });
        await b.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      }
      await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await b.goto(`${baseUrl}/signin`, 200);
      await b.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(session))})`);
      // A real refusal: this origin's notification permission is denied.
      await b.send('Browser.setPermission', { permission: { name: 'notifications' }, setting: 'denied', origin: baseUrl });
      await b.goto(`${baseUrl}/settings`, 600);
      const deadline = Date.now() + 8000;
      let got = await b.evaluate<Swept>(SWEEP);
      while (!got.present && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 100)); got = await b.evaluate<Swept>(SWEEP); }
      const check = (state: string, g: Swept) => checkRow(width, state, g);
      check('the row', got);
      expect(got.state).toBe('Off');
      await capture(b, `settings-push-off-${width}`);

      // A real press where a thumb or a pointer lands: the label's centre.
      const at = await b.evaluate<{ x: number; y: number }>(`(function () { var l = document.getElementById('push-switch'); l.scrollIntoView({ block: 'center' }); var r = l.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (touch) {
        await b.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] });
        await b.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
        await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      }
      const refusedBy = Date.now() + 8000;
      got = await b.evaluate<Swept>(SWEEP);
      while (got.note === '' && Date.now() < refusedBy) { await new Promise((r) => setTimeout(r, 100)); got = await b.evaluate<Swept>(SWEEP); }
      expect(got.note).toBe(SENTENCES.blocked);
      expect(got.state).toBe('Off');
      check('after the refusal', got);
      await capture(b, `settings-push-refused-${width}`);
      expect(await serverRows()).toEqual([]);
    } finally {
      await b.close();
    }
  }, BROWSER_TIMEOUT_MS);

  // Real Chrome, permission granted, one real press: whatever Chrome's own
  // push service answers, the page and the server must agree. On means the
  // server holds exactly this browser's subscription; Off means it holds
  // none and the page says why. Which one happened is printed, because it
  // depends on whether this Chrome build can reach a push service at all.
  // Opt in with SETTINGS_PUSH_REAL=1: Chrome's subscribe goes out to its
  // vendor's push service over the internet, and the suite does not depend
  // on the network.
  it.each([[390, true], [1280, false]] as const)('%ipx (touch: %s): a real press with permission granted leaves the page and the server agreeing', async (width, touch) => {
    if (!hasRealBrowser() || process.env.SETTINGS_PUSH_REAL !== '1') {
      console.warn('real push subscribe skipped (needs Chrome and SETTINGS_PUSH_REAL=1)');
      return;
    }
    const b = await RealBrowser.launch({ width, height: 900 });
    try {
      if (touch) {
        await b.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 2, mobile: true });
        await b.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      }
      await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await b.goto(`${baseUrl}/signin`, 200);
      await b.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(session))})`);
      await b.send('Browser.setPermission', { permission: { name: 'notifications' }, setting: 'granted', origin: baseUrl });
      await b.goto(`${baseUrl}/settings`, 600);
      const ready = Date.now() + 8000;
      while (!(await b.evaluate<boolean>(`!!document.getElementById('push-toggle')`)) && Date.now() < ready) await new Promise((r) => setTimeout(r, 100));
      await b.evaluate(`document.getElementById('push-toggle').click()`);
      const settled = Date.now() + 15000;
      let got = await b.evaluate<Swept>(SWEEP);
      while (got.state !== 'On' && got.note === '' && Date.now() < settled) { await new Promise((r) => setTimeout(r, 200)); got = await b.evaluate<Swept>(SWEEP); }
      const rows = await serverRows();
      const browserSub = await b.evaluate<string | null>(`navigator.serviceWorker.getRegistration('/').then(function (r) { return r ? r.pushManager.getSubscription() : null; }).then(function (s) { return s ? s.endpoint : null; })`);
      console.warn(`real Chrome push: state=${got.state} note=${JSON.stringify(got.note)} server rows=${rows.length} browser subscription=${browserSub === null ? 'none' : 'present'}`);
      if (got.state === 'On') {
        expect(rows.map((r) => r.endpoint)).toEqual([browserSub]);
        checkRow(width, 'on', got);
        await capture(b, `settings-push-on-${width}`);
      } else {
        expect(got.note).not.toBe('');
        expect(rows).toEqual([]);
        expect(browserSub).toBeNull();
      }
    } finally {
      await b.close();
    }
  }, BROWSER_TIMEOUT_MS);
});
