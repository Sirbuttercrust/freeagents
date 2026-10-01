// P8b: the /signin page's own script, run for real (jsdom) against the real
// app, proving two things static assertions on the markup cannot: clicking
// "Continue with GitHub" actually calls GET /auth/github/start, and an
// unconfigured deployment (no FREEAGENTS_GITHUB_CLIENT_ID) is told so
// honestly rather than being handed a button that silently does nothing.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { fakeGitHubConfig } from '../helpers/session-fixtures.js';
import { createPasskeyFixture } from '../helpers/webauthn-fixtures.js';

let server: Server;
let baseUrl: string;

// No FREEAGENTS_GITHUB_CLIENT_ID in the environment here: sessionAdapterFromEnv
// (the createApp() default) builds an adapter whose clientId is ''. The
// redirect URL GET /auth/github/start answers therefore carries an empty
// client_id, which is exactly the signal the page reads back.
beforeAll(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function renderSignin(): Promise<{ window: JSDOM['window']; document: Document; close: () => void }> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  const response = await fetch(`${baseUrl}/signin`, { headers: { Accept: 'text/html' } });
  const markup = await response.text();

  const dom = new JSDOM(markup, {
    url: `${baseUrl}/signin`,
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

  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 250));

  if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);

  return { window: dom.window, document: dom.window.document, close: () => dom.window.close() };
}

describe('the /signin page, running its own script against the real server', () => {
  it('clicking "Continue with GitHub" on an unconfigured deployment says so honestly, never a silent no-op', async () => {
    const page = await renderSignin();
    try {
      const btn = page.document.getElementById('btn-github') as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      btn!.click();

      // The fetch to /auth/github/start and the redirect-URL parse are
      // both async; give the page's own promise chain a turn.
      await new Promise((resolve) => setTimeout(resolve, 100));

      const unconfigured = page.document.getElementById('github-unconfigured');
      expect(unconfigured).not.toBeNull();
      expect(unconfigured!.hidden).toBe(false);
      expect(unconfigured!.textContent).toContain('not set up');
    } finally {
      page.close();
    }
  });

  it('both passkey controls are present, and disabled with the reason shown, when the browser has no WebAuthn', async () => {
    const page = await renderSignin();
    try {
      // jsdom carries no WebAuthn API, so the page's own feature check
      // (`!('credentials' in navigator)`) disables both passkey controls
      // here. This proves the DEGRADE path; the ceremonies themselves run
      // in real Chrome in tests/web/signin-passkey.test.ts.
      const buttons = ['btn-passkey', 'btn-passkey-create'].map((id) => page.document.getElementById(id) as HTMLButtonElement | null);
      buttons.forEach((btn) => expect(btn).not.toBeNull());
      const unavailable = page.document.getElementById('passkey-unavailable');
      expect(unavailable).not.toBeNull();
      expect(unavailable!.hidden).toBe(false);
      expect(buttons.map((btn) => btn!.disabled)).toEqual([true, true]);
    } finally {
      page.close();
    }
  });
});

describe('a configured deployment reaches the real GitHub redirect (client_id present)', () => {
  it('GET /auth/github/start answers a redirect carrying the configured client_id', async () => {
    const sessionAdapter = createSessionAdapter({ github: fakeGitHubConfig() });
    const configuredServer = createApp(
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, sessionAdapter,
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => configuredServer.once('listening', resolve));
    const configuredBaseUrl = `http://127.0.0.1:${(configuredServer.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${configuredBaseUrl}/auth/github/start`);
      const body = (await res.json()) as { redirectUrl: string };
      const clientId = new URL(body.redirectUrl).searchParams.get('client_id');
      expect(clientId).toBe(fakeGitHubConfig().clientId);
      expect(clientId).not.toBe('');
    } finally {
      await new Promise<void>((resolve) => configuredServer.close(() => resolve()));
    }
  });
});

// FIX-B61b: this block used to pin "the subject the page sends to
// POST /auth/passkey/register is stable across attempts", a name the page
// minted and kept in localStorage. That name was the defect: the server now
// makes the account's name, and a page that names one could only ever be
// guessing. What is pinned instead is its absence: two presses of Create a
// passkey send register no body, and nothing is written to localStorage.
// jsdom has no WebAuthn, so the ceremony is rejected at once; the sign-in
// ceremony and the full create path run in real Chrome in
// tests/web/signin-passkey.test.ts.
function withFakeWebAuthnSupport(window: JSDOM['window']): void {
  Object.defineProperty(window.navigator, 'credentials', {
    configurable: true,
    // The ceremony is never completed in this environment (no jsdom
    // WebAuthn implementation exists to answer it); rejecting immediately
    // is enough to observe what the page sent before it asked for one.
    value: { create: () => Promise.reject(new Error('no WebAuthn ceremony available in this test environment')) },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).PublicKeyCredential = function PublicKeyCredential(): void {};
}

describe('the /signin page sends and keeps no passkey name', () => {
  it('two presses of Create a passkey post register with no body, and localStorage stays empty', async () => {
    const virtualConsole = new VirtualConsole();
    const failures: string[] = [];
    virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

    const registerBodies: Array<string | null> = [];

    const response = await fetch(`${baseUrl}/signin`, { headers: { Accept: 'text/html' } });
    const markup = await response.text();

    const dom = new JSDOM(markup, {
      url: `${baseUrl}/signin`,
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse(window) {
        withFakeWebAuthnSupport(window);
        Object.defineProperty(window, 'fetch', {
          writable: true,
          value: (input: string, init?: RequestInit) => {
            if (input.includes('/auth/passkey/register')) registerBodies.push(typeof init?.body === 'string' ? init.body : null);
            return fetch(new URL(input, baseUrl), init);
          },
        });
      },
    });

    try {
      await new Promise<void>((resolve) => {
        if (dom.window.document.readyState === 'complete') resolve();
        else dom.window.addEventListener('load', () => resolve());
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const btn = dom.window.document.getElementById('btn-passkey-create') as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      expect(btn!.disabled).toBe(false);

      btn!.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      btn!.click();
      await new Promise((resolve) => setTimeout(resolve, 150));

      if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);

      expect(registerBodies).toEqual([null, null]);
      expect(dom.window.localStorage.length).toBe(0);
      expect(dom.window.localStorage.getItem('fa_passkey_subject')).toBeNull();
    } finally {
      dom.window.close();
    }
  });
});

// P8e (claim-contradicts-implementation): P8d
// merged before this fix and provisions an Account on the FIRST sign-in
// for every method, passkey included -- proved by
// tests/api/account-provisioning.test.ts's own "passkey sign-in: a
// stranger signs in and hires immediately, the same as GitHub". The
// caveat this test used to pin ("still needs a registered account, which
// this build does not create for you yet") was true at P8b and false
// from P8d onward; it stayed on screen anyway until this fix. This test
// now pins the honest sentence: signed in, and ready to use, with no
// leftover caveat about an account the product already created.
function withRealWebAuthnCeremony(window: JSDOM['window'], fixture: ReturnType<typeof createPasskeyFixture>): void {
  Object.defineProperty(window.navigator, 'credentials', {
    configurable: true,
    value: {
      create: (options: { publicKey: { challenge: ArrayBuffer } }) =>
        Promise.resolve().then(() => {
          const bytes = new Uint8Array(options.publicKey.challenge);
          let binary = '';
          for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] ?? 0);
          const challenge = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          const response = fixture.registrationResponse(challenge, 'localhost');
          return {
            id: response.id,
            rawId: base64urlToArrayBuffer(response.rawId),
            type: response.type,
            response: {
              attestationObject: base64urlToArrayBuffer(response.response.attestationObject),
              clientDataJSON: base64urlToArrayBuffer(response.response.clientDataJSON),
            },
            getClientExtensionResults: () => ({}),
          };
        }),
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).PublicKeyCredential = function PublicKeyCredential(): void {};
}

function base64urlToArrayBuffer(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(value.length + ((4 - (value.length % 4)) % 4), '=');
  const raw = atob(padded);
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return buffer;
}

describe('a completed passkey sign-in on the real page tells the person the truth, and only the truth', () => {
  it('says signed in, with no leftover caveat about an account the product already created', async () => {
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      passkey: { rpName: 'FreeAgents test', rpID: 'localhost', origin: 'http://localhost:3000' },
    });
    const configuredServer = createApp(
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, sessionAdapter,
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => configuredServer.once('listening', resolve));
    const configuredBaseUrl = `http://127.0.0.1:${(configuredServer.address() as AddressInfo).port}`;

    const virtualConsole = new VirtualConsole();
    const failures: string[] = [];
    virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

    const fixture = createPasskeyFixture();
    const response = await fetch(`${configuredBaseUrl}/signin`, { headers: { Accept: 'text/html' } });
    const markup = await response.text();

    const dom = new JSDOM(markup, {
      url: `${configuredBaseUrl}/signin`,
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse(window) {
        withRealWebAuthnCeremony(window, fixture);
        Object.defineProperty(window, 'fetch', {
          writable: true,
          value: (input: string, init?: RequestInit) => fetch(new URL(input, configuredBaseUrl), init),
        });
      },
    });

    try {
      await new Promise<void>((resolve) => {
        if (dom.window.document.readyState === 'complete') resolve();
        else dom.window.addEventListener('load', () => resolve());
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const btn = dom.window.document.getElementById('btn-passkey-create') as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      expect(btn!.disabled).toBe(false);

      btn!.click();
      await new Promise((resolve) => setTimeout(resolve, 250));

      if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);

      const status = dom.window.document.getElementById('signin-status');
      expect(status).not.toBeNull();
      expect(status!.hidden).toBe(false);
      expect(status!.textContent).toBe('Signed in with a passkey. You can hire or list an agent now.');
      expect(status!.textContent).not.toContain('did not go through');
      // D2 guard: the retracted caveat must not resurface. True at P8b,
      // false since P8d's account provisioning merged.
      expect(status!.textContent).not.toContain('registered account');
      expect(status!.textContent).not.toContain('does not create');
    } finally {
      dom.window.close();
      await new Promise<void>((resolve) => configuredServer.close(() => resolve()));
    }
  });
});

// inert-declared-control: nav.js renders exactly
// once at DOMContentLoaded and, before this fix, exposed nothing on
// window; signin.js wrote fa_session on the passkey path and never
// re-rendered it. Unlike the GitHub path there is no navigation
// afterwards, so nothing else re-ran the nav either. A person who signs
// in with a passkey on /signin stood on a page whose nav still said
// "Sign in" and offered no way to sign out. This drives the create
// ceremony (Create a passkey, the one jsdom's stub can answer) through the
// real page's own scripts, the same discipline the rest of this file holds
// to, and checks the nav in place, with no reload.
describe('the nav on /signin tells the truth immediately after a passkey sign-in, with no reload', () => {
  it('hides Sign in, shows a working Sign out, right after the ceremony completes', async () => {
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      passkey: { rpName: 'FreeAgents test', rpID: 'localhost', origin: 'http://localhost:3000' },
    });
    const configuredServer = createApp(
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, sessionAdapter,
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => configuredServer.once('listening', resolve));
    const configuredBaseUrl = `http://127.0.0.1:${(configuredServer.address() as AddressInfo).port}`;

    const virtualConsole = new VirtualConsole();
    const failures: string[] = [];
    virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

    const fixture = createPasskeyFixture();
    const response = await fetch(`${configuredBaseUrl}/signin`, { headers: { Accept: 'text/html' } });
    const markup = await response.text();

    const dom = new JSDOM(markup, {
      url: `${configuredBaseUrl}/signin`,
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse(window) {
        withRealWebAuthnCeremony(window, fixture);
        Object.defineProperty(window, 'fetch', {
          writable: true,
          value: (input: string, init?: RequestInit) => fetch(new URL(input, configuredBaseUrl), init),
        });
      },
    });

    try {
      await new Promise<void>((resolve) => {
        if (dom.window.document.readyState === 'complete') resolve();
        else dom.window.addEventListener('load', () => resolve());
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Before the click: the page is signed out, same as any other visit.
      const signinBefore = dom.window.document.getElementById('nav-signin');
      const signedInBefore = dom.window.document.getElementById('nav-signed-in');
      expect(signinBefore!.hidden).toBe(false);
      expect(signedInBefore!.hidden).toBe(true);

      const btn = dom.window.document.getElementById('btn-passkey-create') as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      btn!.click();
      await new Promise((resolve) => setTimeout(resolve, 250));

      if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);

      // The session landed in storage, the same key nav.js reads.
      const stored = dom.window.sessionStorage.getItem('fa_session');
      expect(stored).not.toBeNull();

      // The nav on THIS page, with no reload and no navigation, now tells
      // the truth: Sign in is gone, Sign out is there and works.
      const signin = dom.window.document.getElementById('nav-signin');
      const signedIn = dom.window.document.getElementById('nav-signed-in');
      expect(signin!.hidden, 'nav-signin should be hidden after a passkey sign-in').toBe(true);
      expect(signedIn!.hidden, 'nav-signed-in should be visible after a passkey sign-in').toBe(false);

      const signoutBtn = dom.window.document.getElementById('nav-signout') as HTMLButtonElement | null;
      expect(signoutBtn).not.toBeNull();
      signoutBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(dom.window.document.getElementById('nav-signin')!.hidden).toBe(false);
      expect(dom.window.document.getElementById('nav-signed-in')!.hidden).toBe(true);
      expect(dom.window.sessionStorage.getItem('fa_session')).toBeNull();
    } finally {
      dom.window.close();
      await new Promise<void>((resolve) => configuredServer.close(() => resolve()));
    }
  });
});
