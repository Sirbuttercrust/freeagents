// FIX-B61b: /signin signs a returning person back into the account their
// passkey was made for. Before this card the page's one passkey control ran
// a registration on every press, under a name the page minted and kept in
// localStorage, so every press made a new account and nobody could sign
// back in. Now "Use a passkey" runs a WebAuthn authentication against
// POST /auth/passkey/signin/start and /auth/passkey/signin, and "Create a
// passkey" runs the registration, which names no one.
//
// Real Chrome, a real CDP virtual authenticator per device, and a real app
// with passkeys configured for http://localhost:<port> (the WebAuthn origin
// has to be the page's own). jsdom has no WebAuthn, so none of this can be
// shown there. What the page sends is read off the wire through CDP's
// Network domain, not from a wrapper the page could route around.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { MemoryAccountRepository, MemoryPasskeyCredentialRepository } from '../../src/adapters/storage/memory.js';
import type { PasskeyCredentialRepository, StoredPasskeyCredential } from '../../src/adapters/storage/types.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';
import { fakeGitHubConfig } from '../helpers/session-fixtures.js';

const TIMEOUT_MS = 60_000;

// Every sentence the page can leave in #signin-status after a passkey
// press, pinned whole so no two outcomes can collapse into one.
const SIGNED_IN = 'Signed in with a passkey. You can hire or list an agent now.';
const NO_PASSKEY_USED = 'No passkey was used. If this device has none for FreeAgents yet, press Create a passkey, or continue with GitHub.';
const NO_PASSKEY_MADE = 'No passkey was made. Press Create a passkey to try again, or continue with GitHub.';
const SIGNIN_REFUSED = 'That passkey did not sign you in. Press Use a passkey to try again, or press Create a passkey if this device has none for FreeAgents.';
const CREATE_REFUSED = 'That passkey was not accepted, so no account was made. Press Create a passkey to try again, or continue with GitHub.';
const STORAGE_TROUBLE = 'FreeAgents could not reach its records just now, so you are not signed in. Try again in a moment.';
const NOT_CONFIGURED = 'Passkeys are not set up on this deployment. Continue with GitHub instead.';
const GENERIC = 'The passkey did not go through. Try again, or continue with GitHub.';

const USE = 'btn-passkey';
const CREATE = 'btn-passkey-create';

// GET /accounts/me provisions the account on a first signed-in read, and
// that derives an operator DID from the platform seed.
beforeAll(() => {
  vi.stubEnv('FREEAGENTS_PLATFORM_SEED', 'f'.repeat(64));
});
afterAll(() => {
  vi.unstubAllEnvs();
});

// A real in-memory passkey store whose reads or writes can be made to fail.
class FlakyPasskeyStore implements PasskeyCredentialRepository {
  readonly inner = new MemoryPasskeyCredentialRepository();
  failReads = false;
  failSave = false;
  async save(credential: StoredPasskeyCredential): Promise<void> {
    if (this.failSave) throw new Error('disk full');
    await this.inner.save(credential);
  }
  async findById(id: string): Promise<StoredPasskeyCredential | null> {
    if (this.failReads) throw new Error('connection refused');
    return this.inner.findById(id);
  }
  recordUse(id: string, newCounter: number): Promise<void> {
    return this.inner.recordUse(id, newCounter);
  }
}

interface Site {
  readonly origin: string;
  readonly api: string;
  readonly store: FlakyPasskeyStore;
  close(): Promise<void>;
}

// The port is bound first, so the adapter can be built with the origin the
// browser will actually report.
async function startSite(options: { passkey?: boolean } = {}): Promise<Site> {
  let handler: http.RequestListener = (_req, res) => res.writeHead(503).end();
  const server = http.createServer((req, res) => handler(req, res));
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://localhost:${port}`;
  const store = new FlakyPasskeyStore();
  const adapter = createSessionAdapter({
    github: fakeGitHubConfig(),
    ...(options.passkey === false ? {} : { passkey: { rpName: 'FreeAgents test', rpID: 'localhost', origin } }),
    passkeyCredentials: store,
  });
  const app = createApp(new MemoryAccountRepository(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, adapter);
  handler = app as unknown as http.RequestListener;
  return {
    origin,
    api: `http://127.0.0.1:${port}`,
    store,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: string | undefined;
}

interface Device {
  readonly browser: RealBrowser;
  readonly authenticatorId: string;
  readonly sent: Sent[];
}

// One person's device: its own Chrome, its own authenticator, and a record
// of every /auth/ and /accounts/ request the page puts on the wire.
async function openDevice(width = 1280): Promise<Device> {
  const browser = await RealBrowser.launch({ width, height: 900 });
  try {
    await browser.send('WebAuthn.enable', { enableUI: false });
    const added = await browser.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
    });
    await browser.send('Network.enable');
    const sent: Sent[] = [];
    browser.onEvent('Network.requestWillBeSent', (params) => {
      const request = (params as { request: { method: string; url: string; postData?: string } }).request;
      const path = new URL(request.url).pathname;
      if (path.startsWith('/auth/') || path.startsWith('/accounts/')) sent.push({ method: request.method, path, body: request.postData });
    });
    return { browser, authenticatorId: (added.result as { authenticatorId: string }).authenticatorId, sent };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// A fresh visit: no session in this tab, nothing recorded yet.
async function visit(device: Device, site: Site): Promise<void> {
  await device.browser.goto(`${site.origin}/signin`);
  await device.browser.evaluate('sessionStorage.clear()');
  await device.browser.goto(`${site.origin}/signin`);
  device.sent.length = 0;
}

interface Settled {
  readonly status: string;
  readonly statusHidden: boolean;
  readonly useDisabled: boolean;
  readonly createDisabled: boolean;
  readonly session: { subject?: string; method?: string; token?: string } | null;
  readonly storedName: string | null;
}

// A real mouse press at the control's centre (a user gesture, as a person
// gives one), then wait for the page to finish the ceremony: a status that
// is no longer an in-progress sentence and both controls usable again.
async function press(device: Device, id: string): Promise<Settled> {
  const box = await device.browser.evaluate<{ x: number; y: number }>(`(function () {
    var el = document.getElementById(${JSON.stringify(id)});
    el.scrollIntoView({ block: 'center' });
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await device.browser.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
  const deadline = Date.now() + 15_000;
  for (;;) {
    const state = await device.browser.evaluate<Settled>(`(function () {
      var s = document.getElementById('signin-status');
      var raw = sessionStorage.getItem('fa_session');
      return {
        status: s.textContent, statusHidden: s.hidden,
        useDisabled: document.getElementById('btn-passkey').disabled,
        createDisabled: (document.getElementById('btn-passkey-create') || { disabled: false }).disabled,
        session: raw ? JSON.parse(raw) : null,
        storedName: localStorage.getItem('fa_passkey_subject'),
      };
    })()`);
    const busy = state.status.endsWith('\u2026') || state.useDisabled || state.createDisabled;
    if (!busy && !state.statusHidden && state.status !== '') return state;
    if (Date.now() > deadline) throw new Error(`the page never settled after pressing #${id}: ${JSON.stringify(state)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function accountDid(site: Site, token: string): Promise<{ status: number; did: unknown }> {
  const res = await fetch(`${site.api}/accounts/me`, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
  const body = (await res.json()) as { did?: unknown };
  return { status: res.status, did: body.did };
}

function calls(device: Device): string[] {
  return device.sent.map((s) => `${s.method} ${s.path}`);
}

// Creates a passkey on this device and returns the account it made.
async function createOn(device: Device, site: Site): Promise<string> {
  await visit(device, site);
  const settled = await press(device, CREATE);
  expect(settled.status).toBe(SIGNED_IN);
  const me = await accountDid(site, settled.session?.token ?? '');
  expect(me.status).toBe(200);
  expect(typeof me.did).toBe('string');
  return me.did as string;
}

async function signInOn(device: Device, site: Site): Promise<{ settled: Settled; did: unknown }> {
  await visit(device, site);
  const settled = await press(device, USE);
  expect(settled.status).toBe(SIGNED_IN);
  expect(calls(device).filter((c) => c.startsWith('POST /auth/'))).toEqual(['POST /auth/passkey/signin/start', 'POST /auth/passkey/signin']);
  return { settled, did: (await accountDid(site, settled.session?.token ?? '')).did };
}

// Holds the whole case, and closes every browser and server it opened.
async function withRig(run: (rig: { site: (o?: { passkey?: boolean }) => Promise<Site>; device: (w?: number) => Promise<Device> }) => Promise<void>): Promise<void> {
  if (!hasRealBrowser()) {
    console.warn('no Chrome found for the real-browser passkey tests; skipping (see CHROME_BIN)');
    return;
  }
  const sites: Site[] = [];
  const devices: Device[] = [];
  try {
    await run({
      site: async (o) => { const s = await startSite(o); sites.push(s); return s; },
      device: async (w) => { const d = await openDevice(w); devices.push(d); return d; },
    });
  } finally {
    for (const d of devices) await d.browser.close();
    for (const s of sites) await s.close();
  }
}

describe('/signin with a passkey, in real Chrome with a virtual authenticator', () => {
  it('(a) a first visit: Create a passkey makes one account and names nobody', () => withRig(async ({ site, device }) => {
    const s = await site();
    const d = await device();
    await visit(d, s);
    const settled = await press(d, CREATE);

    expect(settled.status).toBe(SIGNED_IN);
    expect(settled.session?.method).toBe('passkey');
    expect(calls(d).filter((c) => c.startsWith('POST /auth/'))).toEqual(['POST /auth/passkey/register', 'POST /auth/passkey/verify']);
    const register = d.sent.find((c) => c.path === '/auth/passkey/register');
    expect(register?.body ?? '', 'register must carry no body').toBe('');
    const verify = d.sent.find((c) => c.path === '/auth/passkey/verify');
    const verifyBody = JSON.parse(verify?.body ?? '{}') as { responseJson: string };
    expect(Object.keys(verifyBody)).toEqual(['responseJson']);
    expect(Object.keys(JSON.parse(verifyBody.responseJson) as object)).toEqual(['response']);
    expect(verify?.body ?? '').not.toContain('subject');
    expect(settled.storedName, 'the page must not keep a passkey name in localStorage').toBeNull();

    const me = await accountDid(s, settled.session?.token ?? '');
    expect(me.status).toBe(200);
  }), TIMEOUT_MS);

  it('(b) returning on the same device, a fresh load and Use a passkey land on the same account, never registering', () => withRig(async ({ site, device }) => {
    const s = await site();
    const d = await device();
    const made = await createOn(d, s);

    const back = await signInOn(d, s);
    expect(back.did).toBe(made);
    expect(back.settled.session?.method).toBe('passkey');
    expect(back.settled.storedName).toBeNull();
    const signin = d.sent.find((c) => c.path === '/auth/passkey/signin');
    const assertion = JSON.parse((JSON.parse(signin?.body ?? '{}') as { responseJson: string }).responseJson) as Record<string, unknown>;
    expect(Object.keys(assertion).sort()).toEqual(['clientExtensionResults', 'id', 'rawId', 'response', 'type']);
    expect(signin?.body ?? '').not.toContain('subject');
  }), TIMEOUT_MS);

  it('(c) two people on one site each sign back into their own account', () => withRig(async ({ site, device }) => {
    const s = await site();
    const a = await device();
    const b = await device();
    const madeA = await createOn(a, s);
    const madeB = await createOn(b, s);
    expect(madeA).not.toBe(madeB);

    expect((await signInOn(a, s)).did).toBe(madeA);
    expect((await signInOn(b, s)).did).toBe(madeB);
  }), TIMEOUT_MS);

  it('(d) no passkey on this device: Use a passkey says so, stays signed out, and leaves both controls usable', () => withRig(async ({ site, device }) => {
    const s = await site();
    const d = await device();
    await visit(d, s);
    const settled = await press(d, USE);

    expect(settled.status).toBe(NO_PASSKEY_USED);
    expect(settled.session).toBeNull();
    expect(settled.useDisabled).toBe(false);
    expect(settled.createDisabled).toBe(false);
    expect(calls(d).filter((c) => c.startsWith('POST /auth/'))).toEqual(['POST /auth/passkey/signin/start']);
  }), TIMEOUT_MS);

  it('(d) a person who cancels Create a passkey is told no passkey was made', () => withRig(async ({ site, device }) => {
    const s = await site();
    const d = await device();
    // An authenticator that cannot verify the user refuses a registration
    // that requires it, the same NotAllowedError a cancelled prompt gives.
    await d.browser.send('WebAuthn.setUserVerified', { authenticatorId: d.authenticatorId, isUserVerified: false });
    await visit(d, s);
    const settled = await press(d, CREATE);

    expect(settled.status).toBe(NO_PASSKEY_MADE);
    expect(settled.session).toBeNull();
    expect(calls(d).filter((c) => c.startsWith('POST /auth/'))).toEqual(['POST /auth/passkey/register']);
  }), TIMEOUT_MS);

  it('(e) a passkey the site never stored is refused with a sentence naming what to do', () => withRig(async ({ site, device }) => {
    const s = await site();
    const d = await device();
    // A resident passkey for this rpId that no account was ever made for.
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await d.browser.send('WebAuthn.addCredential', {
      authenticatorId: d.authenticatorId,
      credential: {
        credentialId: randomBytes(16).toString('base64'),
        isResidentCredential: true,
        rpId: 'localhost',
        privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
        userHandle: Buffer.from('pk-never-registered').toString('base64'),
        signCount: 0,
      },
    });
    await visit(d, s);
    const settled = await press(d, USE);

    expect(settled.status).toBe(SIGNIN_REFUSED);
    expect(settled.session).toBeNull();
    expect(calls(d).filter((c) => c.startsWith('POST /auth/'))).toEqual(['POST /auth/passkey/signin/start', 'POST /auth/passkey/signin']);
  }), TIMEOUT_MS);

  it('(e) storage trouble on sign-in and on create each say to try again in a moment', () => withRig(async ({ site, device }) => {
    const s = await site();
    const d = await device();
    await createOn(d, s);
    s.store.failReads = true;
    await visit(d, s);
    const signin = await press(d, USE);
    expect(signin.status).toBe(STORAGE_TROUBLE);
    expect(signin.session).toBeNull();

    s.store.failSave = true;
    await visit(d, s);
    const create = await press(d, CREATE);
    expect(create.status).toBe(STORAGE_TROUBLE);
    expect(create.session).toBeNull();
  }), TIMEOUT_MS);

  it('(e) a deployment with passkeys off says so from either control', () => withRig(async ({ site, device }) => {
    const s = await site({ passkey: false });
    const d = await device();
    await visit(d, s);
    expect((await press(d, USE)).status).toBe(NOT_CONFIGURED);
    expect((await press(d, CREATE)).status).toBe(NOT_CONFIGURED);
    expect(calls(d).filter((c) => c.startsWith('POST /auth/'))).toEqual(['POST /auth/passkey/signin/start', 'POST /auth/passkey/register']);
  }), TIMEOUT_MS);

  // The two answers no real server here gives on demand: verify refusing a
  // fresh passkey, and a start route failing outright. Scripted on the wire
  // with CDP's Fetch domain; everything else in the ceremony is real.
  it.each([
    ['/auth/passkey/verify', 401, { error: 'invalid or expired sign-in attempt' }, CREATE, CREATE_REFUSED],
    ['/auth/passkey/signin/start', 500, { error: 'internal error' }, USE, GENERIC],
  ] as const)('(e) %s answering %i leaves the sentence for it', (path, status, body, control, sentence) => withRig(async ({ site, device }) => {
    const s = await site();
    const d = await device();
    await d.browser.send('Fetch.enable', { patterns: [{ urlPattern: `*${path}`, requestStage: 'Request' }] });
    d.browser.onEvent('Fetch.requestPaused', (params) => {
      void d.browser.send('Fetch.fulfillRequest', {
        requestId: (params as { requestId: string }).requestId,
        responseCode: status,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify(body)).toString('base64'),
      });
    });
    await visit(d, s);
    const settled = await press(d, control);
    expect(settled.status).toBe(sentence);
    expect(settled.session).toBeNull();
  }), TIMEOUT_MS);

  it('(f) the status line is a live region from the moment the page is built, before anything is shown', () => withRig(async ({ site, device }) => {
    const s = await site();
    const d = await device();
    await visit(d, s);
    const before = await d.browser.evaluate<{ role: string | null; live: string | null; hidden: boolean }>(`(function () {
      var s = document.getElementById('signin-status');
      return { role: s.getAttribute('role'), live: s.getAttribute('aria-live'), hidden: s.hidden };
    })()`);
    expect(before).toEqual({ role: 'status', live: 'polite', hidden: true });
    const settled = await press(d, USE);
    expect(settled.status).toBe(NO_PASSKEY_USED);
    const after = await d.browser.evaluate<string | null>(`document.getElementById('signin-status').getAttribute('role')`);
    expect(after).toBe('status');
  }), TIMEOUT_MS);

  it.each([320, 1280])('(g) at %ipx both passkey controls wear the existing button style, measure 44px or more, and nothing scrolls sideways', (width) => withRig(async ({ site, device }) => {
    const s = await site();
    const d = await device(width);
    await visit(d, s);
    const measured = await d.browser.evaluate<{ classes: string[]; small: string[]; overflow: number }>(`(function () {
      var ids = ['btn-github', 'btn-passkey', 'btn-passkey-create'];
      return {
        classes: ids.map(function (id) { return document.getElementById(id).className; }),
        small: ids.filter(function (id) {
          var r = document.getElementById(id).getBoundingClientRect();
          return r.width < 44 || r.height < 44;
        }),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()`);
    expect(measured.classes).toEqual(['btn btn-primary btn-block', 'btn btn-block', 'btn btn-block']);
    expect(measured.small).toEqual([]);
    expect(measured.overflow).toBe(0);
  }), TIMEOUT_MS);
});
