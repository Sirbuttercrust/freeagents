// P8v settings (P-23), from spec/wireframe/settings.html. Driven end to
// end against the real app, the discipline tests/web/dashboard.test.ts and
// tests/web/myjobs.test.ts already hold to: GET /accounts/me and
// PATCH /accounts/:did/operator-address are exercised for real, never
// asserted from a client-side stub.
import type { Server } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession } from '../helpers/session-fixtures.js';
import type { Session } from '../../src/adapters/identity/session.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const VALID_EVM = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const VALID_ABT = 'z6MkExampleSuffix';
// P8d: resolving a session to an account when none exists yet needs
// FREEAGENTS_PLATFORM_SEED, the same stance tests/web/dashboard.test.ts and
// tests/web/myjobs.test.ts already take.
const PLATFORM_SEED = 'f'.repeat(64);

interface Rendered {
  window: JSDOM['window'];
  document: Document;
  fetchCalls: Array<{ url: string; init?: RequestInit }>;
  close: () => void;
}

async function renderSettings(baseUrl: string, session: { token: string } | null): Promise<Rendered> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  const response = await fetch(`${baseUrl}/settings`, { headers: { Accept: HTML } });
  const markup = await response.text();
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

  const dom = new JSDOM(markup, {
    url: `${baseUrl}/settings`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      if (session !== null) window.sessionStorage.setItem('fa_session', JSON.stringify(session));
      Object.defineProperty(window, 'fetch', {
        writable: true,
        value: (input: string, init?: RequestInit) => {
          if (init === undefined) fetchCalls.push({ url: String(input) });
          else fetchCalls.push({ url: String(input), init });
          return fetch(new URL(input, baseUrl), init);
        },
      });
    },
  });

  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', () => resolve());
  });
  for (let waited = 0; waited < 500; waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);
  return { window: dom.window, document: dom.window.document, fetchCalls, close: () => dom.window.close() };
}

describe('the settings screen, driven end to end against the real app', () => {
  let accountRepo: MemoryAccountRepository;
  let server: Server;
  let baseUrl: string;
  let session: Session;
  let ownDid: string;
  let originalSeed: string | undefined;

  beforeAll(async () => {
    originalSeed = process.env.FREEAGENTS_PLATFORM_SEED;
    process.env.FREEAGENTS_PLATFORM_SEED = PLATFORM_SEED;

    accountRepo = new MemoryAccountRepository();

    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'settings-page-owner', id: 9901 }),
    });

    const app = createApp(
      accountRepo, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, sessionAdapter,
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    baseUrl = `http://127.0.0.1:${address.port}`;

    session = await mintSession(sessionAdapter);
    const meRes = await fetch(`${baseUrl}/accounts/me`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}` },
    });
    const me = (await meRes.json()) as { did: string };
    ownDid = me.did;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalSeed === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
    else process.env.FREEAGENTS_PLATFORM_SEED = originalSeed;
  });

  it('serves the page as HTML on a plain own-path mount (done-means 1)', async () => {
    const res = await fetch(`${baseUrl}/settings`, { headers: { Accept: HTML } });
    expect(res.status).toBe(200);
    expect(String(res.headers.get('content-type'))).toContain('text/html');
    expect(await res.text()).toContain('<!doctype html>');
  });

  it('a signed-out visitor sees the sign-in block and no field, and takes no authenticated read (done-means 2)', async () => {
    const page = await renderSettings(baseUrl, null);
    try {
      expect(page.document.getElementById('signin-required')?.hidden).toBe(false);
      expect(page.document.getElementById('settings-body')?.hidden).toBe(true);
      expect(page.fetchCalls.some((c) => c.url.includes('/accounts/me'))).toBe(false);
    } finally {
      page.close();
    }
  });

  it('signed in, takes exactly one read, GET /accounts/me, and no other (done-means 3)', async () => {
    const page = await renderSettings(baseUrl, session);
    try {
      const paths = page.fetchCalls.map((c) => new URL(c.url, baseUrl).pathname);
      expect(paths).toEqual(['/accounts/me']);
    } finally {
      page.close();
    }
  });

  it('both payout inputs render prefilled from the read; an unset address renders an empty input (done-means 4)', async () => {
    const page = await renderSettings(baseUrl, session);
    try {
      const evm = page.document.getElementById('payout-evm') as HTMLInputElement | null;
      const abt = page.document.getElementById('payout-abt') as HTMLInputElement | null;
      expect(evm).not.toBeNull();
      expect(abt).not.toBeNull();
      expect(evm?.value).toBe('');
      expect(abt?.value).toBe('');
    } finally {
      page.close();
    }
  });

  it('pressing Save with nothing edited sends no PATCH (guard-without-a-test, settings.js no-change guard)', async () => {
    const page = await renderSettings(baseUrl, session);
    try {
      const saveBtn = page.document.getElementById('save-btn') as HTMLButtonElement | null;
      expect(saveBtn).not.toBeNull();
      saveBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 300));

      const patchCalls = page.fetchCalls.filter((c) => c.init?.method === 'PATCH');
      expect(patchCalls.length).toBe(0);
    } finally {
      page.close();
    }
  });

  it('an account with one rail set and not the other renders exactly that', async () => {
    await accountRepo.setOperatorAddressEvm(ownDid, VALID_EVM);
    const page = await renderSettings(baseUrl, session);
    try {
      const evm = page.document.getElementById('payout-evm') as HTMLInputElement | null;
      const abt = page.document.getElementById('payout-abt') as HTMLInputElement | null;
      expect(evm?.value).toBe(VALID_EVM);
      expect(abt?.value).toBe('');
    } finally {
      page.close();
    }
  });

  it('saving sends PATCH once, on a press, with only the fields that changed, to the DID the read answered (done-means 5, mutation proof 2)', async () => {
    const page = await renderSettings(baseUrl, session);
    try {
      const abt = page.document.getElementById('payout-abt') as HTMLInputElement | null;
      expect(abt).not.toBeNull();
      abt!.value = VALID_ABT;
      abt!.dispatchEvent(new page.window.Event('input', { bubbles: true }));
      const saveBtn = page.document.getElementById('save-btn') as HTMLButtonElement | null;
      expect(saveBtn).not.toBeNull();
      saveBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 300));

      const patchCalls = page.fetchCalls.filter((c) => c.init?.method === 'PATCH');
      expect(patchCalls.length).toBe(1);
      expect(decodeURIComponent(new URL(patchCalls[0]!.url, baseUrl).pathname)).toBe(`/accounts/${ownDid}/operator-address`);
      const sentBody = JSON.parse(String(patchCalls[0]!.init!.body)) as Record<string, unknown>;
      expect(sentBody).toEqual({ operatorAddressAbt: VALID_ABT });
    } finally {
      page.close();
    }
  });

  it('a save is never fired on blur, only on a press of the save control (mutation proof 9)', async () => {
    const page = await renderSettings(baseUrl, session);
    try {
      const evm = page.document.getElementById('payout-evm') as HTMLInputElement | null;
      evm!.value = VALID_EVM;
      evm!.dispatchEvent(new page.window.Event('input', { bubbles: true }));
      evm!.dispatchEvent(new page.window.Event('blur', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 300));

      const patchCalls = page.fetchCalls.filter((c) => c.init?.method === 'PATCH');
      expect(patchCalls.length).toBe(0);
    } finally {
      page.close();
    }
  });

  it('a 400 from the route renders the route own message; the typed value stays in the input (done-means 6, mutation proof 3)', async () => {
    const page = await renderSettings(baseUrl, session);
    try {
      const evm = page.document.getElementById('payout-evm') as HTMLInputElement | null;
      evm!.value = 'not-an-address';
      evm!.dispatchEvent(new page.window.Event('input', { bubbles: true }));
      const saveBtn = page.document.getElementById('save-btn') as HTMLButtonElement | null;
      saveBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Mutation proof 7: the malformed value actually reached the
      // route (this file sends what was typed and never reimplements
      // the route's own regex to refuse it locally first).
      const patchCalls = page.fetchCalls.filter((c) => c.init?.method === 'PATCH');
      expect(patchCalls.length).toBe(1);

      const saveError = page.document.getElementById('save-error');
      expect(saveError?.hidden).toBe(false);
      const detail = page.document.getElementById('save-error-detail')?.textContent ?? '';
      expect(detail).toContain('operatorAddressEvm must be an EVM address');
      const saveSuccess = page.document.getElementById('save-success');
      expect(saveSuccess?.hidden).toBe(true);
      expect(evm!.value).toBe('not-an-address');
    } finally {
      page.close();
    }
  });

  it('a 200 renders a saved confirmation and the inputs hold the saved values (done-means 7)', async () => {
    const page = await renderSettings(baseUrl, session);
    try {
      const evm = page.document.getElementById('payout-evm') as HTMLInputElement | null;
      const secondEvm = '0x' + 'a'.repeat(40);
      evm!.value = secondEvm;
      evm!.dispatchEvent(new page.window.Event('input', { bubbles: true }));
      const saveBtn = page.document.getElementById('save-btn') as HTMLButtonElement | null;
      saveBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 300));

      const saveSuccess = page.document.getElementById('save-success');
      expect(saveSuccess?.hidden).toBe(false);
      expect(evm!.value).toBe(secondEvm);
    } finally {
      page.close();
    }
  });

  it('a 401 from the save route reveals the sign-in block, and the typed value stays in the input (silent-success-on-failure)', async () => {
    const realPort = (server.address() as AddressInfo).port;
    const proxy = http.createServer((req, res) => {
      if (req.method === 'PATCH' && req.url && req.url.includes('/operator-address')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session expired' }));
        return;
      }
      const upstream = http.request(
        { hostname: '127.0.0.1', port: realPort, path: req.url, method: req.method, headers: req.headers },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      req.pipe(upstream);
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyBaseUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    try {
      const page = await renderSettings(proxyBaseUrl, session);
      try {
        const evm = page.document.getElementById('payout-evm') as HTMLInputElement | null;
        const typedValue = '0x' + 'b'.repeat(40);
        evm!.value = typedValue;
        evm!.dispatchEvent(new page.window.Event('input', { bubbles: true }));
        const saveBtn = page.document.getElementById('save-btn') as HTMLButtonElement | null;
        saveBtn!.click();
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(page.document.getElementById('signin-required')?.hidden).toBe(false);
        expect(page.document.getElementById('settings-body')?.hidden).toBe(true);
        expect(evm!.value).toBe(typedValue);
      } finally {
        page.close();
      }
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it('the GitHub row renders only when githubLogin is not null, and carries no control (done-means 8)', async () => {
    const page = await renderSettings(baseUrl, session);
    try {
      const text = page.document.body.textContent ?? '';
      expect(text).toContain('@settings-page-owner');
      const githubRow = Array.from(page.document.querySelectorAll('.between')).find((el) =>
        (el.textContent ?? '').includes('GitHub account'),
      );
      expect(githubRow).toBeTruthy();
      expect(githubRow?.querySelectorAll('a, button, input').length).toBe(0);
    } finally {
      page.close();
    }
  });

  it('the GitHub row is absent when githubLogin is null (mutation proof 5)', async () => {
    const realPort = (server.address() as AddressInfo).port;
    const proxy = http.createServer((req, res) => {
      if (req.url && req.url.endsWith('/accounts/me')) {
        const upstream = http.request(
          { hostname: '127.0.0.1', port: realPort, path: req.url, method: req.method, headers: req.headers },
          (upstreamRes) => {
            const chunks: Buffer[] = [];
            upstreamRes.on('data', (c: Buffer) => chunks.push(c));
            upstreamRes.on('end', () => {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
              body.githubLogin = null;
              res.writeHead(upstreamRes.statusCode ?? 200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(body));
            });
          },
        );
        req.pipe(upstream);
        return;
      }
      const upstream = http.request(
        { hostname: '127.0.0.1', port: realPort, path: req.url, method: req.method, headers: req.headers },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      req.pipe(upstream);
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyBaseUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    try {
      const page = await renderSettings(proxyBaseUrl, session);
      try {
        const githubRow = Array.from(page.document.querySelectorAll('.between')).find((el) =>
          (el.textContent ?? '').includes('GitHub account'),
        );
        expect(githubRow).toBeUndefined();
      } finally {
        page.close();
      }
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it('the sign-in method rows reflect exactly which of githubLogin and passkeySubject are non-null, and carry no control (done-means 9)', async () => {
    const page = await renderSettings(baseUrl, session);
    try {
      const signInRow = Array.from(page.document.querySelectorAll('.between')).find((el) =>
        (el.textContent ?? '').includes('Sign-in method'),
      );
      expect(signInRow).toBeTruthy();
      expect(signInRow?.textContent ?? '').toContain('GitHub');
      expect(signInRow?.textContent ?? '').not.toContain('passkey');
      expect(signInRow?.querySelectorAll('a, button, input').length).toBe(0);
    } finally {
      page.close();
    }
  });

  it('no display name input, no notification control, no signing key row, no Manage keys link, no closing-your-account section, and no "checked N hours ago" string exists anywhere (done-means 10)', async () => {
    const page = await renderSettings(baseUrl, session);
    try {
      expect(page.document.getElementById('dn')).toBeNull();
      const text = page.document.body.textContent ?? '';
      expect(text).not.toContain('checked');
      expect(text).not.toContain('hours ago');
      expect(text).not.toContain('Close my account');
      expect(text).not.toContain('Signing key');
      expect(text).not.toContain('Manage keys');
      expect(text).not.toContain('Email about your jobs');
      const manageKeysLinks = Array.from(page.document.querySelectorAll('a')).filter(
        (a) => a.getAttribute('href') === 'keys.html' || a.getAttribute('href') === '/keys',
      );
      expect(manageKeysLinks.length).toBe(0);
    } finally {
      page.close();
    }
  });

  it('the identity disclosure is collapsed on load, opens to the DID and its Copy control, carrying the DID the read answered (done-means 11)', async () => {
    const page = await renderSettings(baseUrl, session);
    try {
      const panel = page.document.getElementById('ident');
      expect(panel?.hidden).toBe(true);
      const btn = page.document.querySelector('[data-disclose="ident"]') as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      btn!.click();
      expect(panel?.hidden).toBe(false);
      const didValue = page.document.getElementById('did-value')?.textContent ?? '';
      expect(didValue).toBe(ownDid);
      const copyBtn = page.document.getElementById('did-copy');
      expect(copyBtn?.getAttribute('data-copy')).toBe(ownDid);
    } finally {
      page.close();
    }
  });

  it('no anchor on the page points at an unmounted path (done-means 13)', async () => {
    const page = await renderSettings(baseUrl, session);
    try {
      const hrefs = Array.from(page.document.querySelectorAll('a'))
        .map((a) => a.getAttribute('href'))
        .filter((h): h is string => h !== null && h.startsWith('/'));
      const uniquePaths = Array.from(new Set(hrefs));
      expect(uniquePaths.length).toBeGreaterThan(0);
      for (const path of uniquePaths) {
        const res = await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } });
        expect(res.status, `${path} must be served by the real app`).toBe(200);
      }
    } finally {
      page.close();
    }
  });

  it('no control on the page (anchor, button onclick, or form action) points at a path static.ts does not mount (mutation proof 6)', async () => {
    const page = await renderSettings(baseUrl, session);
    try {
      const anchorHrefs = Array.from(page.document.querySelectorAll('a'))
        .map((a) => a.getAttribute('href'))
        .filter((h): h is string => h !== null && h.startsWith('/'));
      const onclickPaths = Array.from(page.document.querySelectorAll('[onclick]'))
        .map((el) => el.getAttribute('onclick') ?? '')
        .map((code) => {
          const match = /(?:href|location(?:\.href)?)\s*=\s*['"](\/[^'"]*)['"]/.exec(code);
          return match ? match[1] : null;
        })
        .filter((h): h is string => h !== null);
      const allPaths = Array.from(new Set([...anchorHrefs, ...onclickPaths]));
      expect(allPaths.length).toBeGreaterThan(0);
      for (const path of allPaths) {
        const res = await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } });
        expect(res.status, `${path} must be served by the real app`).toBe(200);
      }
    } finally {
      page.close();
    }
  });

  it('a failed read (non-401) renders the load error', async () => {
    const realPort = (server.address() as AddressInfo).port;
    const proxy = http.createServer((req, res) => {
      if (req.url && req.url.endsWith('/accounts/me')) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'storage unavailable' }));
        return;
      }
      const upstream = http.request(
        { hostname: '127.0.0.1', port: realPort, path: req.url, method: req.method, headers: req.headers },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      req.pipe(upstream);
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyBaseUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    try {
      const page = await renderSettings(proxyBaseUrl, session);
      try {
        expect(page.document.getElementById('load-error')?.hidden).toBe(false);
        expect(page.document.getElementById('signin-required')?.hidden).toBe(true);
        expect(page.document.getElementById('settings-body')?.hidden).toBe(true);
      } finally {
        page.close();
      }
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it('a 401 on /accounts/me renders the sign-in block, not the load error', async () => {
    const page = await renderSettings(baseUrl, { token: 'a-token-nobody-minted' });
    try {
      expect(page.document.getElementById('signin-required')?.hidden).toBe(false);
      expect(page.document.getElementById('load-error')?.hidden).toBe(true);
      expect(page.document.getElementById('settings-body')?.hidden).toBe(true);
    } finally {
      page.close();
    }
  });

  describe('layout: 320px shows no horizontal overflow and every interactive element is at least 44px (done-means 14)', () => {
    it('real Chrome measurement', async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
        return;
      }
      const browser = await RealBrowser.launch({ width: 320, height: 900 });
      try {
        await browser.goto(`${baseUrl}/settings`);
        await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(session))})`);
        await browser.goto(`${baseUrl}/settings`);

        const overflow = await browser.evaluate<{ scrollWidth: number; clientWidth: number }>(`
          ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })
        `);
        expect(overflow.scrollWidth, 'the 320px page must not scroll sideways').toBe(overflow.clientWidth);

        const undersized = await browser.evaluate<Array<[string, number, number]>>(`
          Array.from(document.querySelectorAll('#settings-body a, #settings-body button, #settings-body input'))
            .filter((el) => !el.closest('[hidden]'))
            .map((el) => {
              const r = el.getBoundingClientRect();
              return [el.id || el.textContent || '', r.width, r.height];
            })
            .filter(([, w, h]) => w < 44 || h < 44)
        `);
        expect(undersized, `undersized targets: ${JSON.stringify(undersized)}`).toEqual([]);
      } finally {
        await browser.close();
      }
    });
  });
});

// Ruling 7 nav test: signed in shows a Settings link, signed out removes it.
// The absent/present branches for the other pages already exist in
// nav-auth.test.ts; the Settings-specific pair lives beside them there.
