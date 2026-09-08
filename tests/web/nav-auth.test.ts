// P8e: the nav tells the truth about whether you are signed in. Before
// this card every page's nav rendered a static "Sign in" link regardless
// of session state (fa_session was written by signin.js and read by no
// other file in src/web/), and there was no sign-out control anywhere
// despite POST /auth/signout being mounted and working -- the
// inert-declared-control class this repo has hit five times. This file
// drives the real pages with jsdom, the same discipline
// tests/web/signin-flow.test.ts holds to, and proves the nav actually
// changes state rather than merely shipping the markup for it.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { fakeGitHubConfig, fakeGitHubFetch } from '../helpers/session-fixtures.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

// The seventeen page shells the web surface serves, per src/web/static.ts's
// own PAGE_FILES map (auth-callback-success/error are not routed pages;
// they are rendered directly by the callback route and carry no nav).
const NAV_PAGES = ['/', '/how', '/browse', '/signin', '/verify', '/agents/x', '/accounts/x', '/v1/credentials/x', '/jobs/x', '/hire', '/agreement', '/deposit', '/staged', '/pullrequest', '/myjobs', '/myagents', '/outcomes', '/settings', '/no-such-page'] as const;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('every page that carries the nav loads the shared client and the nav script', () => {
  it.each(NAV_PAGES)('%s loads api.js and nav.js', async (path) => {
    const res = await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } });
    const body = await res.text();
    expect(body, `${path} is missing api.js`).toContain('src="/js/pages/api.js"');
    expect(body, `${path} is missing nav.js`).toContain('src="/js/pages/nav.js"');
  });
});

interface RenderedNav {
  window: JSDOM['window'];
  document: Document;
  close: () => void;
}

async function renderNav(path: string, session: { token: string } | null): Promise<RenderedNav> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  const response = await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } });
  const markup = await response.text();

  const dom = new JSDOM(markup, {
    url: `${baseUrl}${path}`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      if (session !== null) {
        window.sessionStorage.setItem('fa_session', JSON.stringify(session));
      }
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

  if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);

  return { window: dom.window, document: dom.window.document, close: () => dom.window.close() };
}

describe('signed out, every page keeps the nav exactly as it is today', () => {
  it.each(['/browse', '/how', '/verify'])('%s shows Sign in and no sign-out control', async (path) => {
    const page = await renderNav(path, null);
    try {
      const signin = page.document.getElementById('nav-signin');
      const signedIn = page.document.getElementById('nav-signed-in');
      expect(signin).not.toBeNull();
      expect(signin!.hidden).toBe(false);
      expect(signedIn).not.toBeNull();
      expect(signedIn!.hidden).toBe(true);
    } finally {
      page.close();
    }
  });
});

describe('signed in, the nav tells the truth', () => {
  it('drops the Sign in link and shows a sign-out control, on a page that already carries the link', async () => {
    const page = await renderNav('/browse', { token: 'a-live-looking-token' });
    try {
      const signin = page.document.getElementById('nav-signin');
      const signedIn = page.document.getElementById('nav-signed-in');
      expect(signin, 'browse.html must carry #nav-signin').not.toBeNull();
      expect(signin!.hidden).toBe(true);
      expect(signedIn, 'browse.html must carry #nav-signed-in').not.toBeNull();
      expect(signedIn!.hidden).toBe(false);
      expect(page.document.getElementById('nav-signout')).not.toBeNull();
    } finally {
      page.close();
    }
  });

  // qa's own "build only what exists" instruction: signin.html has no
  // Sign in link on itself today (it is the destination the link points
  // to), so there is nothing to hide there, but the signed-in state must
  // still be honest if a signed-in person lands back on it.
  it('shows the signed-in state on /signin too, which carries no Sign in link to begin with', async () => {
    const page = await renderNav('/signin', { token: 'a-live-looking-token' });
    try {
      const signedIn = page.document.getElementById('nav-signed-in');
      expect(signedIn).not.toBeNull();
      expect(signedIn!.hidden).toBe(false);
    } finally {
      page.close();
    }
  });
});

describe('sign out actually ends the session', () => {
  it('clicking sign out calls POST /auth/signout with the bearer token, clears storage, and the nav returns to signed out', async () => {
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'octo-nav-signout', id: 5001 }),
    });
    const configuredServer = createApp(
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, sessionAdapter,
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => configuredServer.once('listening', resolve));
    const configuredBaseUrl = `http://127.0.0.1:${(configuredServer.address() as AddressInfo).port}`;

    const start = await sessionAdapter.beginGitHubOAuth();
    const session = await sessionAdapter.completeGitHubOAuth({ code: 'good-code', state: start.state });

    const virtualConsole = new VirtualConsole();
    const failures: string[] = [];
    virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

    const response = await fetch(`${configuredBaseUrl}/browse`, { headers: { Accept: HTML } });
    const markup = await response.text();

    const dom = new JSDOM(markup, {
      url: `${configuredBaseUrl}/browse`,
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse(window) {
        window.sessionStorage.setItem('fa_session', JSON.stringify(session));
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
      await new Promise((resolve) => setTimeout(resolve, 150));

      const signoutBtn = dom.window.document.getElementById('nav-signout') as HTMLButtonElement | null;
      expect(signoutBtn).not.toBeNull();
      signoutBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 200));

      if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);

      // The nav returned to signed out.
      const signin = dom.window.document.getElementById('nav-signin');
      const signedIn = dom.window.document.getElementById('nav-signed-in');
      expect(signin!.hidden).toBe(false);
      expect(signedIn!.hidden).toBe(true);

      // sessionStorage was cleared.
      expect(dom.window.sessionStorage.getItem('fa_session')).toBeNull();

      // The token no longer resolves at all, driven over real HTTP against
      // a session-gated route: the same dead-token proof
      // tests/api/auth-routes.test.ts holds POST /auth/signout to
      // directly, reasserted here because the nav's own click is what
      // triggered the signout this time, not a direct fetch to the route.
      const after = await fetch(`${configuredBaseUrl}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session!.token}` },
        body: JSON.stringify({ agentDid: 'did:abt:nav-signout-agent', repository: 'buyer/target-repo', brief: 'x' }),
      });
      expect(after.status).toBe(401);
    } finally {
      dom.window.close();
      await new Promise<void>((resolve) => configuredServer.close(() => resolve()));
    }
  });
});

// P8m: the My jobs entry nav.js's own header comment apologises for
// ("none of those pages exist yet") -- this card builds the page it
// names, so the link joins here, in the one place the nav's own rule
// says it must (brief scope item 6: "one implementation in nav.js").
describe('the My jobs link (P8m): one implementation in nav.js, absent signed out, present signed in', () => {
  it('is absent from the nav when signed out', async () => {
    const page = await renderNav('/browse', null);
    try {
      const links = Array.from(page.document.querySelectorAll('.links a')).map((a) => a.textContent);
      expect(links).not.toContain('My jobs');
    } finally {
      page.close();
    }
  });

  it('appears in the nav links, pointing at /myjobs, once signed in', async () => {
    const page = await renderNav('/browse', { token: 'a-live-looking-token' });
    try {
      const myJobsLink = Array.from(page.document.querySelectorAll('.links a')).find((a) => a.textContent === 'My jobs') as HTMLAnchorElement | undefined;
      expect(myJobsLink).not.toBeUndefined();
      expect(myJobsLink?.getAttribute('href')).toBe('/myjobs');
    } finally {
      page.close();
    }
  });

  it('disappears again once signed out (no leftover element from an earlier signed-in render)', async () => {
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'octo-nav-myjobs', id: 5101 }),
    });
    const configuredServer = createApp(
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, sessionAdapter,
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => configuredServer.once('listening', resolve));
    const configuredBaseUrl = `http://127.0.0.1:${(configuredServer.address() as AddressInfo).port}`;
    const start = await sessionAdapter.beginGitHubOAuth();
    const session = await sessionAdapter.completeGitHubOAuth({ code: 'good-code', state: start.state });

    const virtualConsole = new VirtualConsole();
    const failures: string[] = [];
    virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));
    const response = await fetch(`${configuredBaseUrl}/browse`, { headers: { Accept: HTML } });
    const markup = await response.text();
    const dom = new JSDOM(markup, {
      url: `${configuredBaseUrl}/browse`,
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse(window) {
        window.sessionStorage.setItem('fa_session', JSON.stringify(session));
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
      await new Promise((resolve) => setTimeout(resolve, 150));

      const signoutBtn = dom.window.document.getElementById('nav-signout') as HTMLButtonElement | null;
      expect(signoutBtn).not.toBeNull();
      signoutBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);

      const links = Array.from(dom.window.document.querySelectorAll('.links a')).map((a) => a.textContent);
      expect(links).not.toContain('My jobs');
    } finally {
      dom.window.close();
      await new Promise<void>((resolve) => configuredServer.close(() => resolve()));
    }
  });
});

// P8n: the My agents entry, appended after My jobs, one implementation in
// nav.js (brief scope item 6). Both branches of the guard are proved, same
// discipline the My jobs block above holds to.
describe('the My agents link (P8n): one implementation in nav.js, absent signed out, present signed in', () => {
  it('is absent from the nav when signed out', async () => {
    const page = await renderNav('/browse', null);
    try {
      const links = Array.from(page.document.querySelectorAll('.links a')).map((a) => a.textContent);
      expect(links).not.toContain('My agents');
    } finally {
      page.close();
    }
  });

  it('appears in the nav links, pointing at /myagents, once signed in', async () => {
    const page = await renderNav('/browse', { token: 'a-live-looking-token' });
    try {
      const myAgentsLink = Array.from(page.document.querySelectorAll('.links a')).find((a) => a.textContent === 'My agents') as HTMLAnchorElement | undefined;
      expect(myAgentsLink).not.toBeUndefined();
      expect(myAgentsLink?.getAttribute('href')).toBe('/myagents');
    } finally {
      page.close();
    }
  });

  it('disappears again once signed out (no leftover element from an earlier signed-in render)', async () => {
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'octo-nav-myagents', id: 5201 }),
    });
    const configuredServer = createApp(
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, sessionAdapter,
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => configuredServer.once('listening', resolve));
    const configuredBaseUrl = `http://127.0.0.1:${(configuredServer.address() as AddressInfo).port}`;
    const start = await sessionAdapter.beginGitHubOAuth();
    const session = await sessionAdapter.completeGitHubOAuth({ code: 'good-code', state: start.state });

    const virtualConsole = new VirtualConsole();
    const failures: string[] = [];
    virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));
    const response = await fetch(`${configuredBaseUrl}/browse`, { headers: { Accept: HTML } });
    const markup = await response.text();
    const dom = new JSDOM(markup, {
      url: `${configuredBaseUrl}/browse`,
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse(window) {
        window.sessionStorage.setItem('fa_session', JSON.stringify(session));
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
      await new Promise((resolve) => setTimeout(resolve, 150));

      const signoutBtn = dom.window.document.getElementById('nav-signout') as HTMLButtonElement | null;
      expect(signoutBtn).not.toBeNull();
      signoutBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);

      const links = Array.from(dom.window.document.querySelectorAll('.links a')).map((a) => a.textContent);
      expect(links).not.toContain('My agents');
    } finally {
      dom.window.close();
      await new Promise<void>((resolve) => configuredServer.close(() => resolve()));
    }
  });
});

// P8n repair round 1, D1 (inert-declared-control): jsdom performs no
// layout, so it cannot see that the nav bar this card's link joins
// overflows a real 320px viewport and the overflow sits exactly under the
// My agents link, making a tap on its centre land on the Sign out button
// instead. This drives one throwaway real Chrome (tests/helpers/real-browser.ts,
// the same driver shape spec/wireframe/wirebrowse.py already uses for the
// wireframe's own gates) so the assertion is real geometry and a real
// dispatched click, not a jsdom stand-in for either.
// P8v (ruling 7): the Settings entry, appended after Dashboard, one
// implementation in nav.js (brief scope item 6). Both branches proved
// the same discipline the earlier link blocks hold to.
describe('the Settings link (P8v ruling 7): one implementation in nav.js, absent signed out, present signed in', () => {
  it('is absent from the nav when signed out', async () => {
    const page = await renderNav('/browse', null);
    try {
      const links = Array.from(page.document.querySelectorAll('.links a')).map((a) => a.textContent);
      expect(links).not.toContain('Settings');
    } finally {
      page.close();
    }
  });

  it('appears in the nav links, pointing at /settings, once signed in', async () => {
    const page = await renderNav('/browse', { token: 'a-live-looking-token' });
    try {
      const settingsLink = Array.from(page.document.querySelectorAll('.links a')).find((a) => a.textContent === 'Settings') as HTMLAnchorElement | undefined;
      expect(settingsLink).not.toBeUndefined();
      expect(settingsLink?.getAttribute('href')).toBe('/settings');
    } finally {
      page.close();
    }
  });

  it('disappears again once signed out (no leftover element from an earlier signed-in render)', async () => {
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'octo-nav-settings', id: 5401 }),
    });
    const configuredServer = createApp(
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, sessionAdapter,
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => configuredServer.once('listening', resolve));
    const configuredBaseUrl = `http://127.0.0.1:${(configuredServer.address() as AddressInfo).port}`;
    const start = await sessionAdapter.beginGitHubOAuth();
    const session = await sessionAdapter.completeGitHubOAuth({ code: 'good-code', state: start.state });

    const virtualConsole = new VirtualConsole();
    const failures: string[] = [];
    virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));
    const response = await fetch(`${configuredBaseUrl}/browse`, { headers: { Accept: HTML } });
    const markup = await response.text();
    const dom = new JSDOM(markup, {
      url: `${configuredBaseUrl}/browse`,
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse(window) {
        window.sessionStorage.setItem('fa_session', JSON.stringify(session));
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
      await new Promise((resolve) => setTimeout(resolve, 150));

      const signoutBtn = dom.window.document.getElementById('nav-signout') as HTMLButtonElement | null;
      expect(signoutBtn).not.toBeNull();
      signoutBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);

      const links = Array.from(dom.window.document.querySelectorAll('.links a')).map((a) => a.textContent);
      expect(links).not.toContain('Settings');
    } finally {
      dom.window.close();
      await new Promise<void>((resolve) => configuredServer.close(() => resolve()));
    }
  });
});


describe('at 320px the nav bar does not overflow and a tap on My agents reaches the link (P8n repair, D1)', () => {
  it('documentElement does not scroll sideways and a click at the link centre navigates instead of hitting sign-out', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'octo-nav-320', id: 5301 }),
    });
    const configuredServer = createApp(
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, sessionAdapter,
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => configuredServer.once('listening', resolve));
    const configuredBaseUrl = `http://127.0.0.1:${(configuredServer.address() as AddressInfo).port}`;
    const start = await sessionAdapter.beginGitHubOAuth();
    const session = await sessionAdapter.completeGitHubOAuth({ code: 'good-code', state: start.state });

    const browser = await RealBrowser.launch({ width: 320, height: 700 });
    try {
      await browser.goto(`${configuredBaseUrl}/browse`);
      await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(session))})`);
      await browser.goto(`${configuredBaseUrl}/browse`);

      const overflow = await browser.evaluate<{ scrollWidth: number; clientWidth: number }>(`
        ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })
      `);
      expect(overflow.scrollWidth, 'the 320px nav bar must not scroll sideways').toBe(overflow.clientWidth);

      const tap = await browser.evaluate<{ hitId: string; sessionAfter: boolean; pathnameAfter: string }>(`
        (function () {
          var link = document.getElementById('nav-myagents');
          var r = link.getBoundingClientRect();
          var cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
          var hit = document.elementFromPoint(cx, cy);
          hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
          return {
            hitId: hit.id,
            sessionAfter: sessionStorage.getItem('fa_session') !== null,
            pathnameAfter: location.pathname,
          };
        })()
      `);
      expect(tap.hitId, 'a tap at the My agents link centre must hit the link, not the sign-out button').toBe('nav-myagents');
      expect(tap.sessionAfter, 'tapping the My agents link must not clear the session').toBe(true);
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => configuredServer.close(() => resolve()));
    }
  });
});
