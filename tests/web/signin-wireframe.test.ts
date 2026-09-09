// W6 S1: "Once signed in" on /signin (spec/wireframe/signin.html:164-180),
// gated by the same session rule nav.js already uses (never a second
// rule), a signed-out visitor must not be shown a menu of pages that will
// bounce them back here.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession } from '../helpers/session-fixtures.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

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

async function renderSignin(session: { token: string } | null): Promise<{ document: Document; close: () => void }> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  const response = await fetch(`${baseUrl}/signin`, { headers: { Accept: HTML } });
  const markup = await response.text();

  const dom = new JSDOM(markup, {
    url: `${baseUrl}/signin`,
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
  await new Promise((resolve) => setTimeout(resolve, 250));

  if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);

  return { document: dom.window.document, close: () => dom.window.close() };
}

describe('signed out, "Once signed in" is absent (W6 S1)', () => {
  it('the section stays hidden, so a signed-out visitor is not shown a menu that will bounce them back here', async () => {
    const page = await renderSignin(null);
    try {
      const section = page.document.getElementById('once-signed-in');
      expect(section).not.toBeNull();
      expect(section!.hidden).toBe(true);
    } finally {
      page.close();
    }
  });
});

describe('signed in, "Once signed in" carries the three real destinations (W6 S1)', () => {
  it('renders Jobs, My agents and Identity, each linking to its real route', async () => {
    const page = await renderSignin({ token: 'a-live-looking-token' });
    try {
      const section = page.document.getElementById('once-signed-in');
      expect(section).not.toBeNull();
      expect(section!.hidden).toBe(false);

      const links = Array.from(section!.querySelectorAll('a'));
      const jobs = links.find((a) => a.textContent === 'Jobs');
      const myAgents = links.find((a) => a.textContent === 'My agents');
      const identity = links.find((a) => a.textContent === 'Identity');

      expect(jobs?.getAttribute('href')).toBe('/myjobs');
      expect(myAgents?.getAttribute('href')).toBe('/myagents');
      expect(identity?.getAttribute('href')).toBe('/settings');
    } finally {
      page.close();
    }
  });
});

// Proof round 1, D1 (stale-state-after-signout): #once-signed-in was set on
// load and on the passkey path, and nothing ever cleared it. Clicking
// nav-signout cleared the session and reverted the nav, but this section
// stayed visible, showing a signed-out visitor a menu of pages (Jobs, My
// agents, Identity) that would bounce them back here.
describe('signing out clears "Once signed in" (W6 round 2, D1)', () => {
  it('hides the section again once the real sign-out click has finished', async () => {
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'octo-signin-signout', id: 6001 }),
    });
    const configuredServer = createApp(
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, sessionAdapter,
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => configuredServer.once('listening', resolve));
    const configuredBaseUrl = `http://127.0.0.1:${(configuredServer.address() as AddressInfo).port}`;

    const session = await mintSession(sessionAdapter);

    const virtualConsole = new VirtualConsole();
    const failures: string[] = [];
    virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

    const response = await fetch(`${configuredBaseUrl}/signin`, { headers: { Accept: HTML } });
    const markup = await response.text();

    const dom = new JSDOM(markup, {
      url: `${configuredBaseUrl}/signin`,
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
      await new Promise((resolve) => setTimeout(resolve, 250));

      // Positive control: signed in, the section is visible before the click.
      const section = dom.window.document.getElementById('once-signed-in');
      expect(section).not.toBeNull();
      expect(section!.hidden).toBe(false);

      const signoutBtn = dom.window.document.getElementById('nav-signout') as HTMLButtonElement | null;
      expect(signoutBtn).not.toBeNull();
      signoutBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 250));

      if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);

      expect(dom.window.sessionStorage.getItem('fa_session')).toBeNull();
      expect(section!.hidden, 'once-signed-in must hide in the same act that clears the session').toBe(true);
    } finally {
      dom.window.close();
      await new Promise<void>((resolve) => configuredServer.close(() => resolve()));
    }
  });
});

// Proof round 1, D2 (tap-target-under-floor): the three "Once signed in"
// destination links (Jobs, My agents, Identity) sat inside span > .between
// > .rows with no covered-class treatment, so base.css's 44px floor block
// never reached them. Measured before this fix: 33x17, 70x17, 49x17 at
// 320px. Real Chrome, real layout, the same instrument
// tests/web/myagents.test.ts and tests/web/dashboard.test.ts already hold
// their own tap targets to: jsdom performs no layout, so only a real
// browser can prove a link actually reaches the floor.
describe('layout: 320px, the three "Once signed in" links reach the 44px floor (W6 round 2, D2)', () => {
  it('Jobs, My agents and Identity each measure at least 44px tall, and the page does not overflow', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 320, height: 900 });
    try {
      await browser.goto(`${baseUrl}/signin`);
      await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify({ token: 'a-live-looking-token' }))})`);
      await browser.goto(`${baseUrl}/signin`);

      const overflow = await browser.evaluate<{ scrollWidth: number; clientWidth: number }>(`
        ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })
      `);
      expect(overflow.scrollWidth, 'the 320px page must not scroll sideways').toBe(overflow.clientWidth);

      const undersized = await browser.evaluate<Array<[string, number, number]>>(`
        Array.from(document.querySelectorAll('#once-signed-in a'))
          .map((el) => {
            const r = el.getBoundingClientRect();
            return [el.textContent || '', r.width, r.height];
          })
          .filter(([, w, h]) => w < 44 || h < 44)
      `);
      expect(undersized, `undersized targets: ${JSON.stringify(undersized)}`).toEqual([]);

      const linkCount = await browser.evaluate<number>(`document.querySelectorAll('#once-signed-in a').length`);
      expect(linkCount, 'Jobs, My agents and Identity must all be present to measure').toBe(3);
    } finally {
      await browser.close();
    }
  });
});
