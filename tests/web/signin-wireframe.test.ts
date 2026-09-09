// W6 S1: "Once signed in" on /signin (spec/wireframe/signin.html:164-180),
// gated by the same session rule nav.js already uses (never a second
// rule), a signed-out visitor must not be shown a menu of pages that will
// bounce them back here.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';

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
