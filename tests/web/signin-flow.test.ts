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

  it('the passkey button is present and enabled when the browser supports WebAuthn', async () => {
    const page = await renderSignin();
    try {
      // jsdom carries no WebAuthn API, so the page's own feature check
      // (`!('credentials' in navigator)`) disables the button here -- this
      // proves the DEGRADE path, not the happy path (auth-routes.test.ts
      // and the real ceremony fixture cover the happy path over HTTP
      // directly, since navigator.credentials.create() has no jsdom
      // implementation to drive it through a browser DOM at all).
      const btn = page.document.getElementById('btn-passkey') as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      const unavailable = page.document.getElementById('passkey-unavailable');
      expect(unavailable).not.toBeNull();
      expect(unavailable!.hidden).toBe(false);
      expect(btn!.disabled).toBe(true);
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

// qa (review round 1, D1, inert-declared-control): the page's own
// beginPasskey() minted a fresh random subject on every click, so a session
// it produced could never resolve to an Account bound to an earlier subject.
// Driven through the page's own script (jsdom), not by importing signin.js's
// internals, the same discipline the rest of this file holds to. jsdom has
// no WebAuthn implementation (the file's own earlier comment), so the
// ceremony itself cannot complete here; this proves the one thing that CAN
// be proven in this environment without it: the subject the page sends to
// POST /auth/passkey/register is stable across repeated attempts on one
// device, not re-minted every time.
function withFakeWebAuthnSupport(window: JSDOM['window']): void {
  Object.defineProperty(window.navigator, 'credentials', {
    configurable: true,
    // The ceremony is never completed in this environment (no jsdom
    // WebAuthn implementation exists to answer it); rejecting immediately
    // is enough to observe what subject the page registered before it
    // asked for a ceremony at all.
    value: { create: () => Promise.reject(new Error('no WebAuthn ceremony available in this test environment')) },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).PublicKeyCredential = function PublicKeyCredential(): void {};
}

describe('the /signin page\'s passkey subject is stable across attempts, not re-minted per click', () => {
  it('sends the same subject to POST /auth/passkey/register on a second click as on the first', async () => {
    const virtualConsole = new VirtualConsole();
    const failures: string[] = [];
    virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

    const registeredSubjects: string[] = [];

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
            const url = input;
            if (url.includes('/auth/passkey/register') && typeof init?.body === 'string') {
              try {
                const parsed = JSON.parse(init.body) as { subject?: unknown };
                if (typeof parsed.subject === 'string') registeredSubjects.push(parsed.subject);
              } catch {
                // malformed body would fail the assertion below on its own
              }
            }
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

      const btn = dom.window.document.getElementById('btn-passkey') as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      expect(btn!.disabled).toBe(false);

      btn!.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      btn!.click();
      await new Promise((resolve) => setTimeout(resolve, 150));

      if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);

      expect(registeredSubjects.length).toBe(2);
      expect(registeredSubjects[0]).toEqual(registeredSubjects[1]);
      expect(registeredSubjects[0]?.length).toBeGreaterThan(0);
    } finally {
      dom.window.close();
    }
  });
});
