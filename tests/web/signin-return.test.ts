// SW3-01: a person who presses Sign in on a page is back on that page after
// signing in. Before this, auth-callback.js ended every GitHub sign-in with
// location.replace("/"), so a hirer who pressed Hire, signed in, and came
// back had to find the agent again from the front page.
//
// These drive the real pages (jsdom, served by createApp(), the discipline
// tests/web/signin-flow.test.ts and tests/web/nav-auth.test.ts hold to):
//   (a) pressing Sign in stores the page's own path and query, and only that;
//   (b) the GitHub callback page lands on the stored path and removes it;
//   (c) the callback page refuses any stored value that is not this site's
//       own path, and lands on / instead;
//   (d) a passkey sign-in on /signin follows the same rule.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import type { SessionAdapter } from '../../src/adapters/identity/session.js';
import { fakeGitHubConfig, fakeGitHubFetch } from '../helpers/session-fixtures.js';
import { createPasskeyFixture } from '../helpers/webauthn-fixtures.js';

const RETURN_KEY = 'fa_return_to';
const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

// jsdom cannot complete a cross-document navigation (its own
// living/window/navigation.js says so). Every location.replace, assign and
// href write a page script makes goes through
// LocationImpl._locationObjectNavigate, so that one method is swapped here
// for a recorder: the landing each test asserts is the URL the page's own
// script asked for, and nothing is followed (a javascript: URL is never
// evaluated).
const require = createRequire(import.meta.url);
const whatwgURL = require('whatwg-url') as { serializeURL: (u: unknown) => string };
const locationImpl = require('jsdom/lib/jsdom/living/window/Location-impl.js') as {
  implementation: { prototype: { _locationObjectNavigate: (url: unknown, opts?: { replacement?: boolean }) => void } };
};

interface Navigation { url: string; replacement: boolean }
let navigations: Navigation[] = [];
const originalLocationNavigate = locationImpl.implementation.prototype._locationObjectNavigate;

beforeEach(() => {
  navigations = [];
  locationImpl.implementation.prototype._locationObjectNavigate = function (url: unknown, opts?: { replacement?: boolean }) {
    navigations.push({ url: whatwgURL.serializeURL(url), replacement: opts?.replacement === true });
  };
});

afterEach(() => {
  locationImpl.implementation.prototype._locationObjectNavigate = originalLocationNavigate;
});

// A press on an anchor, read at the window in the bubble phase (after every
// listener the page registered): the href it would follow and whether any
// page script cancelled it. The recorder then cancels it itself, because
// jsdom cannot follow it.
function pressLink(page: Page, link: HTMLAnchorElement): { href: string; cancelledByPage: boolean } {
  let seen = { href: '', cancelledByPage: true };
  const record = (event: Event): void => {
    seen = { href: link.href, cancelledByPage: event.defaultPrevented };
    event.preventDefault();
  };
  page.window.addEventListener('click', record);
  link.click();
  page.window.removeEventListener('click', record);
  return seen;
}

let server: Server;
let baseUrl: string;
let sessionAdapter: SessionAdapter;

beforeAll(async () => {
  sessionAdapter = createSessionAdapter({
    github: fakeGitHubConfig(),
    fetchImpl: fakeGitHubFetch({ login: 'return-path-hirer', id: 7101 }),
    passkey: { rpName: 'FreeAgents test', rpID: 'localhost', origin: 'http://localhost:3000' },
  });
  server = createApp(
    undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, sessionAdapter,
  ).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Page { window: JSDOM['window']; document: Document; close: () => void }

async function render(
  path: string,
  fetchPath: string,
  options: { stored?: string; prepare?: (window: JSDOM['window']) => void } = {},
): Promise<Page> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  const markup = await (await fetch(`${baseUrl}${fetchPath}`, { headers: { Accept: HTML } })).text();
  const dom = new JSDOM(markup, {
    url: `${baseUrl}${path}`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      if (options.stored !== undefined) window.sessionStorage.setItem(RETURN_KEY, options.stored);
      options.prepare?.(window);
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
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (failures.length > 0) throw new Error(`page script failed on ${path}: ${failures.join('; ')}`);
  return { window: dom.window, document: dom.window.document, close: () => dom.window.close() };
}

function stored(page: Page): string | null {
  return page.window.sessionStorage.getItem(RETURN_KEY);
}

describe('(a) pressing Sign in remembers the page it was pressed on', () => {
  it.each([
    ['/hire?agent=x', '#signin-link'],
    ['/agreement?job=y', '#signin-link'],
  ])('on %s, a press on %s stores exactly that path and query', async (path, selector) => {
    const page = await render(path, path);
    try {
      expect(page.document.getElementById('signin-required')!.hidden).toBe(false);
      const press = pressLink(page, page.document.querySelector(selector) as HTMLAnchorElement);
      expect(stored(page)).toBe(path);
      // The page's own navigation is untouched: the press still goes to /signin.
      expect(press).toEqual({ href: `${baseUrl}/signin`, cancelledByPage: false });
    } finally {
      page.close();
    }
  });

  it('on /browse, a press on the nav\'s Sign in stores /browse, without the hash', async () => {
    const page = await render('/browse#results', '/browse');
    try {
      const press = pressLink(page, page.document.getElementById('nav-signin') as HTMLAnchorElement);
      expect(stored(page)).toBe('/browse');
      expect(press).toEqual({ href: `${baseUrl}/signin`, cancelledByPage: false });
    } finally {
      page.close();
    }
  });

  it('on /browse, a press on a link that is not to this site\'s /signin stores nothing', async () => {
    const page = await render('/browse', '/browse');
    try {
      const elsewhere = page.document.createElement('a');
      elsewhere.href = 'https://example.com/signin';
      page.document.body.appendChild(elsewhere);
      pressLink(page, elsewhere);
      pressLink(page, page.document.querySelector('.links a[href="/how"]') as HTMLAnchorElement);
      expect(stored(page)).toBeNull();
    } finally {
      page.close();
    }
  });

  it('on /signin itself, pressing its own controls or a link back to /signin stores nothing', async () => {
    const page = await render('/signin', '/signin');
    try {
      (page.document.getElementById('btn-github') as HTMLButtonElement).click();
      const back = page.document.createElement('a');
      back.href = '/signin';
      back.textContent = 'Sign in';
      page.document.body.appendChild(back);
      pressLink(page, back);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stored(page)).toBeNull();
    } finally {
      page.close();
    }
  });
});

// The callback page, as GET /auth/github/callback really renders it for a
// browser after a good code and state.
async function renderCallback(storedValue?: string): Promise<Page> {
  const start = await sessionAdapter.beginGitHubOAuth();
  const path = `/auth/github/callback?code=good-code&state=${encodeURIComponent(start.state)}`;
  return render(path, path, storedValue === undefined ? {} : { stored: storedValue });
}

describe('(b) the GitHub callback page lands where Sign in was pressed', () => {
  it('with /hire?agent=x stored, it lands there and the key is gone afterwards', async () => {
    const page = await renderCallback('/hire?agent=x');
    try {
      expect(navigations).toEqual([{ url: `${baseUrl}/hire?agent=x`, replacement: true }]);
      expect(stored(page)).toBeNull();
      expect(page.window.sessionStorage.getItem('fa_session')).not.toBeNull();
    } finally {
      page.close();
    }
  });

  it('with nothing stored, it lands on / as it always has', async () => {
    const page = await renderCallback();
    try {
      expect(navigations).toEqual([{ url: `${baseUrl}/`, replacement: true }]);
    } finally {
      page.close();
    }
  });
});

describe('(c) the callback page follows only this site\'s own paths', () => {
  it.each([
    'https://example.com/x',
    '//example.com/x',
    '/\\example.com',
    '/\t/example.com',
    '/signin',
    '/signin?next=1',
    '/SignIn/',
    '/auth/github/callback?code=1',
    '/AUTH/github/start',
    'javascript:alert(1)',
    '',
  ])('refuses %j, lands on / and removes the key', async (value) => {
    const page = await renderCallback(value);
    try {
      expect(navigations).toEqual([{ url: `${baseUrl}/`, replacement: true }]);
      expect(stored(page)).toBeNull();
    } finally {
      page.close();
    }
  });

  it('lands on / when the stored path cannot be read at all', async () => {
    const start = await sessionAdapter.beginGitHubOAuth();
    const path = `/auth/github/callback?code=good-code&state=${encodeURIComponent(start.state)}`;
    const page = await render(path, path, {
      stored: '/hire?agent=x',
      prepare: (window) => {
        const original = window.Storage.prototype.getItem;
        window.Storage.prototype.getItem = function (this: Storage, key: string): string | null {
          if (key === RETURN_KEY) throw new Error('storage refused');
          return original.call(this, key);
        };
      },
    });
    try {
      expect(navigations).toEqual([{ url: `${baseUrl}/`, replacement: true }]);
    } finally {
      page.close();
    }
  });
});

// The same real WebAuthn "none" registration ceremony
// tests/web/signin-flow.test.ts drives, so Create a passkey completes for real.
function withRealWebAuthnCeremony(window: JSDOM['window'], fixture: ReturnType<typeof createPasskeyFixture>): void {
  const toBuffer = (value: string): ArrayBuffer => {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(value.length + ((4 - (value.length % 4)) % 4), '=');
    const raw = atob(padded);
    const buffer = new ArrayBuffer(raw.length);
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return buffer;
  };
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
            rawId: toBuffer(response.rawId),
            type: response.type,
            response: {
              attestationObject: toBuffer(response.response.attestationObject),
              clientDataJSON: toBuffer(response.response.clientDataJSON),
            },
            getClientExtensionResults: () => ({}),
          };
        }),
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).PublicKeyCredential = function PublicKeyCredential(): void {};
}

async function passkeySignIn(storedValue?: string): Promise<Page> {
  const fixture = createPasskeyFixture();
  const page = await render('/signin', '/signin', {
    ...(storedValue === undefined ? {} : { stored: storedValue }),
    prepare: (window) => withRealWebAuthnCeremony(window, fixture),
  });
  (page.document.getElementById('btn-passkey-create') as HTMLButtonElement).click();
  await new Promise((resolve) => setTimeout(resolve, 300));
  return page;
}

describe('(d) a passkey sign-in on /signin follows the same rule', () => {
  it('with /hire?agent=x stored, it goes there and removes the key', async () => {
    const page = await passkeySignIn('/hire?agent=x');
    try {
      expect(page.window.sessionStorage.getItem('fa_session')).not.toBeNull();
      expect(navigations).toEqual([{ url: `${baseUrl}/hire?agent=x`, replacement: true }]);
      expect(stored(page)).toBeNull();
    } finally {
      page.close();
    }
  });

  it.each([undefined, '//example.com/x'])('with %j stored, it stays on /signin and says it signed you in', async (value) => {
    const page = await passkeySignIn(value);
    try {
      expect(page.window.sessionStorage.getItem('fa_session')).not.toBeNull();
      expect(navigations).toEqual([]);
      expect(page.document.getElementById('signin-status')!.textContent).toBe(
        'Signed in with a passkey. You can hire or list an agent now.',
      );
      expect(stored(page)).toBeNull();
    } finally {
      page.close();
    }
  });
});
