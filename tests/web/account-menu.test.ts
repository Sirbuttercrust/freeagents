// NAV1: the account menu at the top right, under a person's own profile
// icon (2026-09-30).
//
// Every pin here but (i) drives real Chrome (tests/helpers/real-browser.ts)
// against createApp() with a real session adapter, so sessions, the one
// GET /accounts/me read and sign-out are the product's own. Keys and clicks
// are real input (CDP Input.dispatch*), because a native <details> only
// opens on a trusted Enter, Space or click; a synthetic event proves
// nothing about it.
//
//   (a) the signed-in bar and the menu's contents; signed out unchanged
//   (b) a passkey-only account: the name line, and the passkey name nowhere
//   (c) the tint for a DID is --agent-(hash % 5 + 1), in all five bands,
//       and every tint clears 3:1, computed from tokens.css
//   (d) /accounts/me failing (503, network): neutral icon, working menu,
//       and exactly one /accounts/me request per load
//   (e) keyboard, click outside, choosing an item, tabbing out, the
//       session ending, closed after reload
//   (f) Sign out from inside the menu ends the session
//   (g) 320, 390 and 1280 on a touch profile: the two menus open in turn,
//       never together, 44px controls, no sideways scroll
//   (h) /accounts/:did: the profile icon in the header, bots in the roster
//   (i) all 29 pages carry the same signed-in row markup
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import type { Session } from '../../src/adapters/identity/session.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
} from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';
import { fakeGitHubConfig, fakeGitHubFetch } from '../helpers/session-fixtures.js';
import { createPasskeyFixture } from '../helpers/webauthn-fixtures.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const BROWSER_TIMEOUT_MS = 60_000;
const here = dirname(fileURLToPath(import.meta.url));
const pagesDir = join(here, '../../src/web/pages');

const GITHUB_LOGIN = 'octo-nav1-menu';
const PASSKEY_SUBJECT = 'pk-nav1-server-made-name-7f2';
const OPERATOR_DID = 'did:abt:zNav1RosterOperator';
const ROSTER_AGENTS = ['did:abt:zNav1RosterAgentOne', 'did:abt:zNav1RosterAgentTwo'];
// One DID per identity band, found by hashing (FNV-1a mod 5, plus one).
const BAND_DIDS: Record<number, string> = {
  1: 'did:abt:zNav1Band3',
  2: 'did:abt:zNav1Band2',
  3: 'did:abt:zNav1Band5',
  4: 'did:abt:zNav1Band1',
  5: 'did:abt:zNav1Band0',
};

// Stores throw on a GitHub lookup while `failing` is set, so GET
// /accounts/me answers the route's own 503 ("storage unavailable").
class FlakyAccounts extends MemoryAccountRepository {
  failing = false;
  override async findByGithubLogin(login: string): ReturnType<MemoryAccountRepository['findByGithubLogin']> {
    if (this.failing) throw new Error('storage unavailable (test)');
    return super.findByGithubLogin(login);
  }
}

let server: Server;
let base: string;
let accounts: FlakyAccounts;
let gh: Session;
let pk: Session;
let originalSeed: string | undefined;

function delegation(agentDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:nav1-${agentDid}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: OPERATOR_DID,
    issuanceDate: '2026-09-30T00:00:00.000Z',
    credentialSubject: { id: agentDid },
    proof: { type: 'Ed25519Signature2020', created: '2026-09-30T00:00:00.000Z', verificationMethod: `${OPERATOR_DID}#key-1`, proofPurpose: 'assertionMethod', proofValue: 'zProof' },
  };
}

beforeAll(async () => {
  originalSeed = process.env.FREEAGENTS_PLATFORM_SEED;
  process.env.FREEAGENTS_PLATFORM_SEED = 'a7'.repeat(32);
  accounts = new FlakyAccounts();
  const agents = new MemoryAgentRepository();
  await accounts.register({ did: OPERATOR_DID, githubLogin: 'nav1-roster-operator' });
  for (const [i, did] of ROSTER_AGENTS.entries()) {
    await agents.create({ did, operatorDid: OPERATOR_DID, delegation: delegation(did), name: `nav1-agent-${i}`, skills: ['typescript'], githubLogin: null });
  }
  const sessions = createSessionAdapter({
    github: fakeGitHubConfig(),
    fetchImpl: fakeGitHubFetch({ login: GITHUB_LOGIN, id: 8101 }),
    passkey: { rpName: 'FreeAgents test', rpID: 'localhost', origin: 'http://localhost:3000' },
  });
  const app = createApp(
    accounts, agents, undefined, undefined, new MemoryJobRepository(), undefined,
    undefined, new MemoryCredentialRepository(), undefined, undefined, undefined, sessions,
  );
  server = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const start = await sessions.beginGitHubOAuth();
  gh = (await sessions.completeGitHubOAuth({ code: 'good-code', state: start.state }))!;
  const { optionsJson } = await sessions.registerPasskey(PASSKEY_SUBJECT);
  const challenge = (JSON.parse(optionsJson) as { challenge: string }).challenge;
  const response = createPasskeyFixture().registrationResponse(challenge, 'localhost');
  pk = (await sessions.verifyPasskey(JSON.stringify({ subject: PASSKEY_SUBJECT, response })))!;
  if (!gh || !pk) throw new Error('fixture sessions did not mint');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (originalSeed === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
  else process.env.FREEAGENTS_PLATFORM_SEED = originalSeed;
});

// ------------------------------------------------------------ the driver

interface Page {
  b: RealBrowser;
  meReads: () => number;
  close: () => Promise<void>;
}

// One Chrome per call. The session goes into sessionStorage before any
// page script runs, on every document this tab loads, so a reload keeps
// it. `touch` turns on touch emulation (coarse pointer), the phone profile.
async function openAs(session: Session | null, width: number, opts: { touch?: boolean; failMe?: 'network' } = {}): Promise<Page> {
  const b = await RealBrowser.launch({ width, height: 800 });
  let reads = 0;
  await b.send('Network.enable');
  b.onEvent('Network.requestWillBeSent', (p) => {
    const url = (p as { request: { url: string } }).request.url;
    if (new URL(url).pathname === '/accounts/me') reads += 1;
  });
  if (opts.failMe === 'network') {
    await b.send('Fetch.enable', { patterns: [{ urlPattern: '*/accounts/me*' }] });
    b.onEvent('Fetch.requestPaused', (p) => {
      void b.send('Fetch.failRequest', { requestId: (p as { requestId: string }).requestId, errorReason: 'Failed' });
    });
  }
  if (opts.touch) await b.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const put = session === null
    ? "try { sessionStorage.removeItem('fa_session'); } catch (e) {}"
    : `try { sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(session))}); } catch (e) {}`;
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: put });
  return { b, meReads: () => reads, close: () => b.close() };
}

async function until(b: RealBrowser, expr: string, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await b.evaluate<boolean>(expr)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function clickAt(b: RealBrowser, x: number, y: number): Promise<void> {
  await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await new Promise((r) => setTimeout(r, 150));
}

async function click(b: RealBrowser, selector: string): Promise<void> {
  const c = await b.evaluate<{ x: number; y: number } | null>(`(function () {
    var e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null;
    var r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!c) throw new Error(`nothing to click at ${selector}`);
  await clickAt(b, c.x, c.y);
}

const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  ' ': { code: 'Space', vk: 32, text: ' ' },
  Escape: { code: 'Escape', vk: 27 },
  Tab: { code: 'Tab', vk: 9 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
};
async function press(b: RealBrowser, key: string): Promise<void> {
  const k = KEYS[key]!;
  const down: Record<string, unknown> = { type: 'keyDown', key, code: k.code, windowsVirtualKeyCode: k.vk };
  if (k.text) down.text = k.text;
  await b.send('Input.dispatchKeyEvent', down);
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: k.code, windowsVirtualKeyCode: k.vk });
  await new Promise((r) => setTimeout(r, 120));
}

interface Control { name: string; w: number; h: number; left: number; right: number }
// Every control a person can see in the nav, in document order, with its
// box. checkVisibility() is false for display:none, [hidden], and content
// inside a closed <details> (Chrome still lays that content out under
// content-visibility: hidden, so a box alone is not a visibility signal).
const NAV_CONTROLS = `(function () {
  return Array.prototype.filter.call(document.querySelectorAll('nav.nav a[href], nav.nav button, nav.nav summary'), function (e) {
    var r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && e.checkVisibility({ visibilityProperty: true });
  }).map(function (e) {
    var r = e.getBoundingClientRect();
    return { name: (e.getAttribute('aria-label') || e.textContent).trim(), w: r.width, h: r.height, left: r.left, right: r.right };
  });
})()`;
const STATE = `({
  account: document.getElementById('nav-account').open,
  phone: !!document.querySelector('nav.nav.is-open'),
  focus: document.activeElement ? (document.activeElement.id || document.activeElement.textContent.trim()) : null,
  sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth
})`;
interface State { account: boolean; phone: boolean; focus: string | null; sw: number; cw: number }
const names = (cs: Control[]): string[] => cs.map((c) => c.name);

// Reads the account menu once the one /accounts/me answer has landed.
async function nameLine(b: RealBrowser): Promise<string | null> {
  await until(b, "!document.getElementById('nav-account-name').hidden");
  return b.evaluate<string | null>("(function(){ var n = document.getElementById('nav-account-name'); return n.hidden ? null : n.textContent; })()");
}

// ------------------------------------------------------------------ pins

describe('(a) the signed-in bar holds Browse, My jobs, My agents, Messages and the account menu; signed out is unchanged', () => {
  it('signed in with GitHub at 1280: exactly those five and the brand, and the menu opens to the login, Dashboard, Settings, Sign out in order', async () => {
    if (!hasRealBrowser()) return console.warn('no Chrome found; skipping (see CHROME_BIN)');
    const p = await openAs(gh, 1280);
    try {
      await p.b.goto(`${base}/browse`);
      expect(await nameLine(p.b)).toBe(GITHUB_LOGIN);
      const closed = await p.b.evaluate<Control[]>(NAV_CONTROLS);
      expect(names(closed)).toEqual(['FreeAgents home', 'Browse', 'My jobs', 'My agents', 'Messages', 'Account menu']);
      const btn = closed.find((c) => c.name === 'Account menu')!;
      expect(Math.min(btn.w, btn.h), 'the account menu button is a 44px target').toBeGreaterThanOrEqual(44);
      expect(btn.right, 'the account menu sits at the top right, right of every bar link').toBeGreaterThan(Math.max(...closed.filter((c) => c !== btn).map((c) => c.right)));

      await click(p.b, '#nav-account-btn');
      const drop = await p.b.evaluate<string[]>(`Array.prototype.filter.call(document.querySelectorAll('#nav-account-drop > *'), function (e) {
        return e.checkVisibility({ visibilityProperty: true }); }).map(function (e) { return e.textContent.trim(); })`);
      expect(drop, 'the open menu, top to bottom').toEqual([GITHUB_LOGIN, 'Dashboard', 'Settings', 'Sign out']);
    } finally {
      await p.close();
    }
  }, BROWSER_TIMEOUT_MS);

  it('signed out at 1280: Browse, How it works and Sign in, and no account menu', async () => {
    if (!hasRealBrowser()) return console.warn('no Chrome found; skipping (see CHROME_BIN)');
    const p = await openAs(null, 1280);
    try {
      await p.b.goto(`${base}/browse`);
      expect(names(await p.b.evaluate<Control[]>(NAV_CONTROLS))).toEqual(['FreeAgents home', 'Browse', 'How it works', 'Sign in']);
      expect(p.meReads(), 'signed out, the nav reads no account').toBe(0);
    } finally {
      await p.close();
    }
  }, BROWSER_TIMEOUT_MS);
});

describe('(b) a passkey-only account reads "Signed in with a passkey", and its passkey name is shown nowhere', () => {
  const ROUTES = ['/', '/how', '/browse', '/signin', '/verify', '/agents/x', '/accounts/x', '/v1/credentials/x', '/jobs/x', '/hire',
    '/agreement', '/deposit', '/staged', '/pullrequest', '/myjobs', '/myagents', '/outcomes', '/private-repos', '/incoming',
    '/conduct', '/dashboard', '/operatorjob', '/settings', '/notifications', '/messages', '/listagent', '/agentsettings',
    '/review', '/no-such-page'];

  it('the route list is the 29 pages that carry the signed-in row', () => {
    expect(ROUTES.length).toBe(29);
    expect(new Set(ROUTES).size).toBe(29);
  });

  it('on every one of the 29 pages, with the menu open, the name line reads exactly "Signed in with a passkey" and the page holds no copy of the passkey name', async () => {
    if (!hasRealBrowser()) return console.warn('no Chrome found; skipping (see CHROME_BIN)');
    const p = await openAs(pk, 1280);
    const seen: Record<string, { name: string | null; leaks: boolean }> = {};
    try {
      for (const route of ROUTES) {
        await p.b.goto(`${base}${route}`, 300);
        const name = await nameLine(p.b);
        await p.b.evaluate("document.getElementById('nav-account').open = true");
        await new Promise((r) => setTimeout(r, 400));
        const leaks = await p.b.evaluate<boolean>(`document.documentElement.outerHTML.indexOf(${JSON.stringify(PASSKEY_SUBJECT)}) !== -1 || document.title.indexOf(${JSON.stringify(PASSKEY_SUBJECT)}) !== -1`);
        seen[route] = { name, leaks };
      }
    } finally {
      await p.close();
    }
    const expected = Object.fromEntries(ROUTES.map((r) => [r, { name: 'Signed in with a passkey', leaks: false }]));
    expect(seen).toEqual(expected);
  }, 180_000);
});

describe('(c) the icon is the account\u2019s identity colour, --agent-(hash % 5 + 1), and every tint clears 3:1', () => {
  it('FAApi.identityBand equals FABots.hash % 5 + 1, and the drawn plate paints that --agent-N token, for a DID in each of the five bands', async () => {
    if (!hasRealBrowser()) return console.warn('no Chrome found; skipping (see CHROME_BIN)');
    const p = await openAs(null, 1280);
    try {
      await p.b.goto(`${base}/dashboard`);
      const got = await p.b.evaluate<Record<string, { band: number; hashBand: number; plate: string; token: string; ink: string; bg: string }>>(`(function () {
        function paint(v) { var s = document.createElement('span'); s.style.background = v; document.body.appendChild(s); var c = getComputedStyle(s).backgroundColor; s.remove(); return c; }
        var out = {};
        ${JSON.stringify(Object.values(BAND_DIDS))}.forEach(function (did) {
          var m = document.createElement('span'); m.style.width = m.style.height = '30px'; document.body.appendChild(m);
          FAApi.personMark(m, did);
          var band = Number(m.getAttribute('data-band'));
          out[did] = { band: band, hashBand: FABots.hash(did) % 5 + 1, plate: getComputedStyle(m).backgroundColor,
                       token: paint('var(--agent-' + band + ')'), ink: getComputedStyle(m).color, bg: paint('var(--bg)') };
          m.remove();
        });
        return out;
      })()`);
      for (const [want, did] of Object.entries(BAND_DIDS)) {
        const g = got[did]!;
        expect({ did, band: g.band, hashBand: g.hashBand, plateIsToken: g.plate === g.token, inkIsBg: g.ink === g.bg })
          .toEqual({ did, band: Number(want), hashBand: Number(want), plateIsToken: true, inkIsBg: true });
      }
    } finally {
      await p.close();
    }
  }, BROWSER_TIMEOUT_MS);

  it('the nav\u2019s own mark for the signed-in account wears the band its DID from GET /accounts/me derives', async () => {
    if (!hasRealBrowser()) return console.warn('no Chrome found; skipping (see CHROME_BIN)');
    const me = (await (await fetch(`${base}/accounts/me`, { headers: { authorization: `Bearer ${gh.token}` } })).json()) as { did: string };
    const p = await openAs(gh, 1280);
    try {
      await p.b.goto(`${base}/dashboard`);
      await until(p.b, "document.getElementById('nav-account-mark').hasAttribute('data-band')");
      const r = await p.b.evaluate<{ band: string | null; hashBand: number }>(`({ band: document.getElementById('nav-account-mark').getAttribute('data-band'),
        hashBand: FABots.hash(${JSON.stringify(me.did)}) % 5 + 1 })`);
      expect(r.band).toBe(String(r.hashBand));
    } finally {
      await p.close();
    }
  }, BROWSER_TIMEOUT_MS);

  it('computed from tokens.css: each of the five plates clears 3:1 against --bg, --bg-1 and --bg-2, the --bg silhouette clears 3:1 on each plate, and the neutral --fg-2 on --bg-2 clears it too', () => {
    const css = readFileSync(join(here, '../../src/web/public/css/tokens.css'), 'utf8');
    const tok = (name: string): string => {
      const m = new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(css);
      if (!m) throw new Error(`${name} is not a hex token in tokens.css`);
      return m[1]!;
    };
    const lum = (hex: string): number => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    };
    const ratio = (a: string, b: string): number => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    const failing: string[] = [];
    for (const n of [1, 2, 3, 4, 5]) {
      const plate = tok(`--agent-${n}`);
      for (const surface of ['--bg', '--bg-1', '--bg-2']) {
        if (ratio(plate, tok(surface)) < 3) failing.push(`--agent-${n} plate on ${surface}: ${ratio(plate, tok(surface)).toFixed(2)}`);
      }
      if (ratio(tok('--bg'), plate) < 3) failing.push(`--bg silhouette on --agent-${n}: ${ratio(tok('--bg'), plate).toFixed(2)}`);
    }
    if (ratio(tok('--fg-2'), tok('--bg-2')) < 3) failing.push('neutral --fg-2 on --bg-2');
    expect(failing).toEqual([]);
  });
});

describe('(d) GET /accounts/me failing still gives a working menu with the neutral icon, and each load reads it exactly once', () => {
  const NEUTRAL = `(function () {
    var m = document.getElementById('nav-account-mark');
    function paint(v) { var s = document.createElement('span'); s.style.background = v; document.body.appendChild(s); var c = getComputedStyle(s).backgroundColor; s.remove(); return c; }
    function ink(v) { var s = document.createElement('span'); s.style.color = v; document.body.appendChild(s); var c = getComputedStyle(s).color; s.remove(); return c; }
    return { band: m.getAttribute('data-band'), glyph: m.querySelectorAll('svg').length,
             plateIsBg2: getComputedStyle(m).backgroundColor === paint('var(--bg-2)'), inkIsFg2: getComputedStyle(m).color === ink('var(--fg-2)') };
  })()`;
  const ITEMS = `Array.prototype.filter.call(document.querySelectorAll('#nav-account-drop > *'), function (e) {
    return e.checkVisibility({ visibilityProperty: true }); }).map(function (e) { return e.textContent.trim(); })`;

  for (const failure of ['503', 'network'] as const) {
    it(`a ${failure} answer leaves the silhouette neutral (--fg-2 on --bg-2), the menu opens to Dashboard, Settings, Sign out, and one /accounts/me request was made`, async () => {
      if (!hasRealBrowser()) return console.warn('no Chrome found; skipping (see CHROME_BIN)');
      accounts.failing = failure === '503';
      const p = await openAs(gh, 1280, failure === 'network' ? { failMe: 'network' } : {});
      try {
        await p.b.goto(`${base}/browse`, 1200);
        expect(await p.b.evaluate(NEUTRAL)).toEqual({ band: null, glyph: 1, plateIsBg2: true, inkIsFg2: true });
        await click(p.b, '#nav-account-btn');
        expect(await p.b.evaluate<string[]>(ITEMS)).toEqual(['Dashboard', 'Settings', 'Sign out']);
        expect(p.meReads()).toBe(1);
      } finally {
        accounts.failing = false;
        await p.close();
      }
    }, BROWSER_TIMEOUT_MS);
  }

  it('a load that succeeds reads /accounts/me exactly once, for both the menu and the Messages badge', async () => {
    if (!hasRealBrowser()) return console.warn('no Chrome found; skipping (see CHROME_BIN)');
    const p = await openAs(gh, 1280);
    try {
      await p.b.goto(`${base}/browse`);
      expect(await nameLine(p.b)).toBe(GITHUB_LOGIN);
      await new Promise((r) => setTimeout(r, 600));
      expect(p.meReads()).toBe(1);
    } finally {
      await p.close();
    }
  }, BROWSER_TIMEOUT_MS);
});

describe('(e) the account menu by keyboard and pointer: closed on load, Enter and Space open, arrows and Tab reach every item; Escape, a click outside, choosing an item, tabbing out and the session ending close it', () => {
  it('Enter opens, ArrowDown walks Dashboard, Settings, Sign out, Escape closes with focus back on the button; Space opens and Tab reaches every item', async () => {
    if (!hasRealBrowser()) return console.warn('no Chrome found; skipping (see CHROME_BIN)');
    const p = await openAs(gh, 1280);
    try {
      await p.b.goto(`${base}/browse`);
      expect((await p.b.evaluate<State>(STATE)).account, 'closed on load').toBe(false);
      await p.b.evaluate("document.getElementById('nav-account-btn').focus()");
      await press(p.b, 'Enter');
      const walked: (string | null)[] = [(await p.b.evaluate<State>(STATE)).account ? 'open' : 'closed'];
      for (let i = 0; i < 3; i++) {
        await press(p.b, 'ArrowDown');
        walked.push((await p.b.evaluate<State>(STATE)).focus);
      }
      await press(p.b, 'Escape');
      const after = await p.b.evaluate<State>(STATE);
      expect({ walked, open: after.account, focus: after.focus }).toEqual({
        walked: ['open', 'Dashboard', 'Settings', 'nav-signout'], open: false, focus: 'nav-account-btn',
      });

      await press(p.b, ' ');
      const tabbed: (string | null)[] = [(await p.b.evaluate<State>(STATE)).account ? 'open' : 'closed'];
      for (let i = 0; i < 3; i++) {
        await press(p.b, 'Tab');
        tabbed.push((await p.b.evaluate<State>(STATE)).focus);
      }
      expect(tabbed).toEqual(['open', 'Dashboard', 'Settings', 'nav-signout']);
    } finally {
      await p.close();
    }
  }, BROWSER_TIMEOUT_MS);

  it('a click outside closes it, choosing an item closes it, and it is closed again after a reload', async () => {
    if (!hasRealBrowser()) return console.warn('no Chrome found; skipping (see CHROME_BIN)');
    const p = await openAs(gh, 1280);
    try {
      await p.b.goto(`${base}/browse`);
      await click(p.b, '#nav-account-btn');
      const opened = (await p.b.evaluate<State>(STATE)).account;
      await clickAt(p.b, 12, 520);
      const outside = (await p.b.evaluate<State>(STATE)).account;

      await click(p.b, '#nav-account-btn');
      // Keep the page: the item's own navigation is not what is measured.
      await p.b.evaluate("document.addEventListener('click', function (e) { if (e.target.closest('#nav-account-drop a')) e.preventDefault(); }, true)");
      await click(p.b, '#nav-account-drop a[href="/settings"]');
      const chosen = (await p.b.evaluate<State>(STATE)).account;

      await click(p.b, '#nav-account-btn');
      await p.b.goto(`${base}/browse`);
      const reloaded = (await p.b.evaluate<State>(STATE)).account;
      expect({ opened, outside, chosen, reloaded }).toEqual({ opened: true, outside: false, chosen: false, reloaded: false });
    } finally {
      await p.close();
    }
  }, BROWSER_TIMEOUT_MS);

  it('Tab past Sign out moves focus out of the menu onto the page, and the menu closes behind it', async () => {
    if (!hasRealBrowser()) return console.warn('no Chrome found; skipping (see CHROME_BIN)');
    const p = await openAs(gh, 1280);
    try {
      await p.b.goto(`${base}/browse`);
      await click(p.b, '#nav-account-btn');
      await p.b.evaluate("document.getElementById('nav-signout').focus()");
      const before = await p.b.evaluate<State>(STATE);
      await press(p.b, 'Tab');
      const after = await p.b.evaluate<{ open: boolean; inMenu: boolean; onPage: boolean }>(`({
        open: document.getElementById('nav-account').open,
        inMenu: document.getElementById('nav-account').contains(document.activeElement),
        onPage: document.activeElement !== null && document.activeElement !== document.body
      })`);
      expect({ before: { open: before.account, focus: before.focus }, after })
        .toEqual({ before: { open: true, focus: 'nav-signout' }, after: { open: false, inMenu: false, onPage: true } });
    } finally {
      await p.close();
    }
  }, BROWSER_TIMEOUT_MS);

  it('when the session ends with the menu open, FANav.refresh() closes it, and signing back in shows it closed', async () => {
    if (!hasRealBrowser()) return console.warn('no Chrome found; skipping (see CHROME_BIN)');
    const p = await openAs(gh, 1280);
    try {
      await p.b.goto(`${base}/browse`);
      await click(p.b, '#nav-account-btn');
      const opened = (await p.b.evaluate<State>(STATE)).account;
      const stored = await p.b.evaluate<string>("sessionStorage.getItem('fa_session')");
      await p.b.evaluate("sessionStorage.removeItem('fa_session'); FANav.refresh()");
      const ended = await p.b.evaluate<{ open: boolean; row: boolean }>("({ open: document.getElementById('nav-account').open, row: !document.getElementById('nav-signed-in').hidden })");
      await p.b.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(stored)}); FANav.refresh()`);
      const back = await p.b.evaluate<{ open: boolean; row: boolean }>("({ open: document.getElementById('nav-account').open, row: !document.getElementById('nav-signed-in').hidden })");
      expect({ opened, ended, back }).toEqual({ opened: true, ended: { open: false, row: false }, back: { open: false, row: true } });
    } finally {
      await p.close();
    }
  }, BROWSER_TIMEOUT_MS);

  it('on /dashboard the Dashboard item carries aria-current="page", and only it', async () => {
    if (!hasRealBrowser()) return console.warn('no Chrome found; skipping (see CHROME_BIN)');
    const p = await openAs(gh, 1280);
    try {
      await p.b.goto(`${base}/dashboard`);
      const current = await p.b.evaluate<string[]>("Array.prototype.map.call(document.querySelectorAll('#nav-account-drop [aria-current=\"page\"]'), function (e) { return e.textContent; })");
      expect(current).toEqual(['Dashboard']);
    } finally {
      await p.close();
    }
  }, BROWSER_TIMEOUT_MS);
});

describe('(f) Sign out from inside the menu does what #nav-signout always did', () => {
  it('a real click on the menu\u2019s Sign out posts /auth/signout, clears the session, returns the nav to signed out, and the token no longer resolves', async () => {
    if (!hasRealBrowser()) return console.warn('no Chrome found; skipping (see CHROME_BIN)');
    const sessions = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'octo-nav1-signout', id: 8102 }) });
    const app = createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessions);
    const own = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => own.once('listening', resolve));
    const ownBase = `http://127.0.0.1:${(own.address() as AddressInfo).port}`;
    const start = await sessions.beginGitHubOAuth();
    const session = (await sessions.completeGitHubOAuth({ code: 'c', state: start.state }))!;
    const b = await RealBrowser.launch({ width: 1280, height: 800 });
    try {
      await b.goto(`${ownBase}/browse`);
      await b.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(session))})`);
      await b.goto(`${ownBase}/browse`);
      await click(b, '#nav-account-btn');
      const label = await b.evaluate<string>("document.getElementById('nav-signout').textContent");
      await click(b, '#nav-signout');
      await until(b, "sessionStorage.getItem('fa_session') === null");
      const after = await b.evaluate<{ stored: boolean; signin: boolean; row: boolean; controls: string[] }>(`({
        stored: sessionStorage.getItem('fa_session') !== null,
        signin: !document.getElementById('nav-signin').hidden,
        row: !document.getElementById('nav-signed-in').hidden,
        controls: ${NAV_CONTROLS}.map(function (c) { return c.name; })
      })`);
      expect({ label, ...after }).toEqual({ label: 'Sign out', stored: false, signin: true, row: false, controls: ['FreeAgents home', 'Browse', 'How it works', 'Sign in'] });
      const res = await fetch(`${ownBase}/accounts/me`, { headers: { authorization: `Bearer ${session.token}` } });
      expect(res.status, 'the signed-out token is dead').toBe(401);
    } finally {
      await b.close();
      await new Promise<void>((resolve) => own.close(() => resolve()));
    }
  }, BROWSER_TIMEOUT_MS);
});

describe('(g) on a touch profile at 320, 390 and 1280 the two menus open in turn and never together, every control is 44px or more, and nothing scrolls sideways', () => {
  for (const width of [320, 390, 1280]) {
    it(`at ${width}px`, async () => {
      if (!hasRealBrowser()) return console.warn('no Chrome found; skipping (see CHROME_BIN)');
      const p = await openAs(gh, width, { touch: true });
      try {
        await p.b.goto(`${base}/browse`);
        await nameLine(p.b);
        expect(await p.b.evaluate<boolean>("matchMedia('(pointer: coarse)').matches"), 'the touch profile is live').toBe(true);
        const phone = width <= 760;
        const small = (cs: Control[]): string[] => cs.filter((c) => c.w < 44 || c.h < 44).map((c) => `${c.name} ${c.w.toFixed(1)}x${c.h.toFixed(1)}`);
        const offscreen = (cs: Control[], w: number): string[] => cs.filter((c) => c.left < 0 || c.right > w).map((c) => c.name);

        const bar = await p.b.evaluate<Control[]>(NAV_CONTROLS);
        expect(names(bar).includes('Account menu'), 'the account icon is in the bar').toBe(true);
        expect(names(bar).includes('Menu'), 'the phone Menu button beside it').toBe(phone);

        await click(p.b, '#nav-account-btn');
        const s1 = await p.b.evaluate<State>(STATE);
        const c1 = await p.b.evaluate<Control[]>(NAV_CONTROLS);
        const record: Record<string, unknown> = {
          accountOpen: { account: s1.account, phone: s1.phone, sideways: s1.sw - s1.cw, small: small(c1), off: offscreen(c1, s1.cw) },
        };
        const expected: Record<string, unknown> = {
          accountOpen: { account: true, phone: false, sideways: 0, small: [], off: [] },
        };
        if (phone) {
          await click(p.b, 'nav.nav .menu');
          const s2 = await p.b.evaluate<State>(STATE);
          const c2 = await p.b.evaluate<Control[]>(NAV_CONTROLS);
          record.phoneOpen = { account: s2.account, phone: s2.phone, sideways: s2.sw - s2.cw, small: small(c2), off: offscreen(c2, s2.cw) };
          await click(p.b, '#nav-account-btn');
          const s3 = await p.b.evaluate<State>(STATE);
          record.accountAgain = { account: s3.account, phone: s3.phone };
          expected.phoneOpen = { account: false, phone: true, sideways: 0, small: [], off: [] };
          expected.accountAgain = { account: true, phone: false };
        }
        expect(record).toEqual(expected);
      } finally {
        await p.close();
      }
    }, BROWSER_TIMEOUT_MS);
  }
});

describe('(h) /accounts/:did shows the operator\u2019s profile icon in the header, and the roster keeps one bot per agent', () => {
  it('the header is a .pmark in the operator\u2019s band with no canvas and no bot mount; each of the two roster cards holds exactly one bot canvas', async () => {
    if (!hasRealBrowser()) return console.warn('no Chrome found; skipping (see CHROME_BIN)');
    const p = await openAs(null, 390);
    try {
      await p.b.goto(`${base}/accounts/${encodeURIComponent(OPERATOR_DID)}`);
      await until(p.b, "document.querySelectorAll('[data-avatar] canvas').length >= 2 && document.getElementById('avatar').classList.contains('pmark')");
      const r = await p.b.evaluate<Record<string, unknown>>(`(function () {
        var h = document.getElementById('avatar'); var box = h.getBoundingClientRect();
        return {
          header: { mark: h.classList.contains('pmark'), band: h.getAttribute('data-band'), glyph: h.querySelectorAll(':scope > svg').length,
                    canvases: h.querySelectorAll('canvas').length, mount: h.hasAttribute('data-avatar'), round: getComputedStyle(h).borderRadius === '50%',
                    size: Math.round(box.width) },
          hashBand: String(FABots.hash(${JSON.stringify(OPERATOR_DID)}) % 5 + 1),
          operatorMounts: document.querySelectorAll('[data-avatar="${OPERATOR_DID}"]').length,
          roster: Array.prototype.map.call(document.querySelectorAll('[data-avatar]'), function (e) {
            return [e.getAttribute('data-avatar'), e.querySelectorAll('canvas.bot').length]; }).sort()
        };
      })()`);
      expect(r).toEqual({
        header: { mark: true, band: r.hashBand, glyph: 1, canvases: 0, mount: false, round: true, size: 76 },
        hashBand: r.hashBand,
        operatorMounts: 0,
        roster: ROSTER_AGENTS.map((d) => [d, 1]).sort(),
      });
    } finally {
      await p.close();
    }
  }, BROWSER_TIMEOUT_MS);
});

describe('(i) every page that carries the nav carries the same signed-in row', () => {
  const ROW = `<div class="row" id="nav-signed-in" hidden>
      <details class="avatarmenu" id="nav-account">
        <summary class="avatarbtn" id="nav-account-btn" aria-label="Account menu"><span class="pmark" id="nav-account-mark"></span></summary>
        <div class="avatardrop" id="nav-account-drop">
          <p class="avatarname" id="nav-account-name" hidden></p>
          <a href="/dashboard">Dashboard</a>
          <a href="/settings">Settings</a>
          <button type="button" id="nav-signout">Sign out</button>
        </div>
      </details>
    </div>`;

  it('29 of the 31 page files carry #nav-signed-in, each exactly once, inside its <nav>, byte for byte this row', () => {
    const files = readdirSync(pagesDir).filter((f) => f.endsWith('.html')).sort();
    expect(files.length).toBe(31);
    const report = files.map((f) => {
      const html = readFileSync(join(pagesDir, f), 'utf8');
      const nav = /<nav class="nav">[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
      return { f, rows: html.split('id="nav-signed-in"').length - 1, exact: nav.split(ROW).length - 1 };
    });
    const carrying = report.filter((r) => r.rows > 0);
    expect(carrying.length).toBe(29);
    expect(carrying.filter((r) => r.rows !== 1 || r.exact !== 1)).toEqual([]);
    expect(report.filter((r) => r.rows === 0).map((r) => r.f)).toEqual(['auth-callback-error.html', 'auth-callback-success.html']);
  });
});
