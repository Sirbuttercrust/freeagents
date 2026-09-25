// W-settings: the account settings page rebuilt on spec/wireframe/settings.html's
// polished visual system.
//
// The conformance gate (tests/web/wireframe-conformance.test.ts) measures one
// thing about this page's clothes: that every stylesheet the wireframe loads
// is linked. A link tag satisfies it. So it is equally satisfied by a page
// that loads polish.css and then keeps the pre-polish dot the sheet has no
// rule for, mounts a glyph that never paints because the row was built after
// the icon sweep ran, ships the copy button bare, or loads the scripts in an
// order where the painter is not defined when the sweep asks for it. This file
// is the distance between passing that gate and wearing the design.
//
// tests/web/settings.test.ts owns the live wiring: the one read, the PATCH on
// a press, the rulings about what does and does not render, and the 320px
// floor. Nothing here restates it.
//
// Two kinds of assertion live here, and the split is deliberate. jsdom
// performs no layout, so it can see markup, script order and a painted svg
// child but can never see that a class changed a box. Every claim about what
// polish.css DOES to this page is measured in a real browser instead.
import type { Server } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession } from '../helpers/session-fixtures.js';
import type { Session } from '../../src/adapters/identity/session.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const PLATFORM_SEED = 'd'.repeat(64);
const GITHUB_LOGIN = 'settings-polish-owner';

// EVERY TEST BELOW THAT DRIVES A REAL BROWSER CARRIES AN EXPLICIT TIMEOUT.
// vitest's default is 5000ms and RealBrowser.launch alone takes 1 to 4s on
// an idle machine; withOpenPage adds two navigations and a disclosure
// click on top of that. Run inside the full suite, or beside another
// seat's build, launch plus that setup regularly passes 5s and the test
// fails with a timeout that says nothing about the page: CI1 measured the
// tick-morph test timing out under full-suite load while passing alone in
// about 3.6s, the same timing-dependency shape
// tests/web/hire-polished.test.ts:486-495 already named and fixed the same
// way. 30s is past every launch observed here and a genuinely broken
// assertion still fails inside it.
const BROWSER_TIMEOUT_MS = 30_000;

const here = dirname(fileURLToPath(import.meta.url));
const iconsPath = join(here, '../../src/web/public/js/icons.js');
const pagePath = join(here, '../../src/web/pages/settings.html');

let server: Server;
let baseUrl: string;
let session: Session;

beforeAll(async () => {
  process.env.FREEAGENTS_PLATFORM_SEED = PLATFORM_SEED;

  const sessionAdapter = createSessionAdapter({
    github: fakeGitHubConfig(),
    fetchImpl: fakeGitHubFetch({ login: GITHUB_LOGIN, id: 9902 }),
  });
  const app = createApp(
    new MemoryAccountRepository(), undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, sessionAdapter,
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  session = await mintSession(sessionAdapter);
  // P8d provisions the account on first resolve, the same first call
  // tests/web/settings.test.ts makes before it reads the DID back.
  await fetch(`${baseUrl}/accounts/me`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}` },
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function servedMarkup(): Promise<string> {
  const res = await fetch(`${baseUrl}/settings`, { headers: { Accept: HTML } });
  expect(res.status).toBe(200);
  return res.text();
}

interface Rendered {
  document: Document;
  window: JSDOM['window'];
  close: () => void;
}

// The page with its own scripts run for real against the real app, the same
// instrument tests/web/settings.test.ts uses. The account rows this file
// asserts on do not exist until GET /accounts/me resolves, so the wait is not
// optional garnish.
async function renderSettings(from: string = baseUrl): Promise<Rendered> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  const res = await fetch(`${from}/settings`, { headers: { Accept: HTML } });
  const markup = await res.text();

  const dom = new JSDOM(markup, {
    url: `${from}/settings`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.sessionStorage.setItem('fa_session', JSON.stringify(session));
      Object.defineProperty(window, 'fetch', {
        writable: true,
        value: (input: string, init?: RequestInit) => fetch(new URL(input, from), init),
      });
    },
  });

  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);

  return { document: dom.window.document, window: dom.window, close: () => dom.window.close() };
}

// A proxy in front of the real app that rewrites one served file on its way
// to the browser. This is how the two mutation controls below plant their
// defect: the page is otherwise identical, served by the same app, so a
// control that goes green is telling us the assertion cannot fail.
// tests/web/settings.test.ts:274-311 already proxies this app to force a 401.
async function withRewrittenAsset(
  path: string,
  rewrite: (body: string) => string,
  run: (proxyBaseUrl: string) => Promise<void>,
): Promise<void> {
  const realPort = (server.address() as AddressInfo).port;
  const proxy = http.createServer((req, res) => {
    if (req.url === path) {
      const upstream = http.request(
        { hostname: '127.0.0.1', port: realPort, path: req.url, method: req.method, headers: req.headers },
        (upstreamRes) => {
          const chunks: Buffer[] = [];
          upstreamRes.on('data', (c: Buffer) => chunks.push(c));
          upstreamRes.on('end', () => {
            const body = rewrite(Buffer.concat(chunks).toString('utf8'));
            res.writeHead(upstreamRes.statusCode ?? 200, {
              'Content-Type': upstreamRes.headers['content-type'] ?? 'application/javascript',
            });
            res.end(body);
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
  try {
    await run(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
}

// A real browser on the signed-in page, with the identity disclosure opened.
// Every size assertion in this file goes through here: #ident is hidden on
// load, so a probe that never opens it measures nothing about the copy
// control, and the existing 320px sweep in tests/web/settings.test.ts skips
// it for exactly that reason (it filters [hidden] subtrees out).
async function withOpenPage<T>(width: number, fn: (browser: RealBrowser) => Promise<T>): Promise<T | null> {
  if (!hasRealBrowser()) {
    console.warn('no Chrome found for real-browser measurement; skipping (see CHROME_BIN)');
    return null;
  }
  const browser = await RealBrowser.launch({ width, height: 900 });
  try {
    await browser.goto(`${baseUrl}/settings`);
    await browser.evaluate(
      `sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(session))})`,
    );
    await browser.goto(`${baseUrl}/settings`);
    await browser.evaluate(`document.querySelector('[data-disclose="ident"]').click(); true;`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

function linkedSheets(markup: string): string[] {
  return [...markup.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map(
    (m) => ((m[1] ?? '').split('/').pop() ?? '').trim(),
  );
}

function loadedScripts(markup: string): string[] {
  return [...markup.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => (m[1] ?? '').trim());
}

// ---------------------------------------------------------------- 1. the stack

describe('1. the page wears the polished system, and only the sheets it uses', () => {
  it('loads tokens, base and polish, and none of the page-specific sheets', async () => {
    const sheets = linkedSheets(await servedMarkup());

    expect(sheets, 'the polished layer must be linked').toContain('polish.css');
    expect(sheets).toContain('tokens.css');
    expect(sheets).toContain('base.css');

    // The absence half, which the conformance gate does not make: it checks
    // only that the wireframe's sheets are present, so an over-load passes it
    // in silence. None of these four has a component on this screen.
    const overLoaded = ['market.css', 'gallery.css', 'agreement.css', 'landing.css'].filter((s) =>
      sheets.includes(s),
    );
    expect(overLoaded, 'stylesheets loaded by a page that uses none of their components').toEqual([]);
  });

  it('loads icons before polish, both before the page script, and no avatar engine', async () => {
    const scripts = loadedScripts(await servedMarkup());

    expect(scripts).toEqual([
      '/js/pages/api.js',
      '/js/pages/nav.js',
      '/js/office.js',
      '/js/icons.js',
      '/js/polish.js',
      '/js/pages/settings.js',
      '/js/pages/ui.js',
    ]);

    // Stated as an ordering as well as a list, because the list is the thing
    // a later edit reshuffles. polish.js's init() calls FAIcon.paint() as its
    // first statement, so icons.js has to have defined window.FAIcon by then.
    const icons = scripts.indexOf('/js/icons.js');
    const polish = scripts.indexOf('/js/polish.js');
    const page = scripts.indexOf('/js/pages/settings.js');
    expect(icons, '/js/icons.js is not loaded').toBeGreaterThan(-1);
    expect(polish - icons, 'polish.js is parsed before the icon set it paints from').toBeGreaterThan(0);
    expect(page - polish, 'the page script runs before the sweeps it repaints after').toBeGreaterThan(0);

    // swarm.js paints [data-avatar] hosts. This page mounts none, so loading
    // the engine would ship a module with nothing to do. Parsed, not grepped:
    // a grep cannot tell an attribute on an element from the word in a
    // comment, and this page's head comment names the engine to explain why
    // it is absent.
    expect(scripts.some((s) => s.includes('swarm.js'))).toBe(false);
    const shell = new JSDOM(readFileSync(pagePath, 'utf8'));
    try {
      expect(Array.from(shell.window.document.querySelectorAll('[data-avatar]')).length).toBe(0);
    } finally {
      shell.window.close();
    }
  });
});

// -------------------------------------------- 2. the GitHub row's state marker

describe('2. the GitHub row wears the wireframe\u2019s glyph, and the glyph paints', () => {
  it('renders span.ico[data-ico="check-circle"] and no dot anywhere in the rows', async () => {
    const page = await renderSettings();
    try {
      const host = page.document.getElementById('account-rows');
      expect(host, '#account-rows is missing').not.toBeNull();

      // POSITIVE CONTROL. Every assertion below is satisfied by an empty
      // pane, so the read has to have produced the row first.
      const githubRow = Array.from(host!.querySelectorAll('.between')).find((el) =>
        (el.textContent ?? '').includes('GitHub account'),
      );
      expect(githubRow, 'no GitHub row rendered: the assertions below would pass vacuously').toBeTruthy();
      expect(githubRow?.textContent ?? '').toContain(`@${GITHUB_LOGIN}`);

      const marker = githubRow!.querySelector('.state .ico');
      expect(marker, 'the state marker is not an .ico host').not.toBeNull();
      expect(marker?.getAttribute('data-ico')).toBe('check-circle');

      // The pre-polish marker. polish.css carries no .dot rule, so a dot
      // here would wear nothing of the sheet this card links.
      expect(
        Array.from(host!.querySelectorAll('.dot')).length,
        'the pre-polish dot is back inside the account rows',
      ).toBe(0);
    } finally {
      page.close();
    }
  });

  it('the glyph host is PAINTED after the read resolves, not left empty', async () => {
    const page = await renderSettings();
    try {
      const hosts = Array.from(page.document.querySelectorAll('#account-rows [data-ico]'));
      expect(hosts.length, 'no glyph host in the rows: this sweep would pass vacuously').toBeGreaterThan(0);

      // The assertion this whole section exists for. icons.js and polish.js
      // both sweep at DOMContentLoaded, which is before GET /accounts/me
      // resolves, so a host built in that callback is never visited by
      // either. An unpainted host collapses to nothing and the login beside
      // it still reads correctly, which is why the failure is invisible in a
      // screenshot.
      const unpainted = hosts
        .filter((el) => el.firstElementChild === null)
        .map((el) => el.getAttribute('data-ico') ?? '');
      expect(unpainted, 'glyph hosts with no painted child: the repaint after the read is missing').toEqual([]);
      hosts.forEach((el) => {
        expect(el.querySelector('svg'), 'a painted host whose child is not an svg').not.toBeNull();
      });
    } finally {
      page.close();
    }
  });

  // MUTATION CONTROL for the assertion above. The repaint call is removed
  // from the served script and nothing else changes; if the host still comes
  // back painted, something other than this call is painting it and the
  // assertion above is not measuring what its name says.
  it('control: with the repaint call removed, the same host comes back empty', async () => {
    const marker = 'if (window.FAIcon) window.FAIcon.paint(host);';
    let planted = false;
    await withRewrittenAsset(
      '/js/pages/settings.js',
      (body) => {
        planted = body.includes(marker);
        return body.replace(marker, '/* repaint suppressed by the mutation control */');
      },
      async (proxyBaseUrl) => {
        const page = await renderSettings(proxyBaseUrl);
        try {
          expect(planted, 'the control never found the repaint call to remove').toBe(true);
          const hosts = Array.from(page.document.querySelectorAll('#account-rows [data-ico]'));
          expect(hosts.length, 'the control rendered no row, so its result means nothing').toBeGreaterThan(0);
          expect(
            hosts.filter((el) => el.firstElementChild === null).length,
            'the host painted anyway with the repaint removed, so the assertion above cannot fail',
          ).toBe(hosts.length);
        } finally {
          page.close();
        }
      },
    );
  });

  it('every data-ico on the page names a glyph icons.js actually registers', async () => {
    // Derived from the shipped file, so a name removed from icons.js fails
    // here rather than painting nothing in production.
    const glyphs = new Set(
      [...readFileSync(iconsPath, 'utf8').matchAll(/^\s+"([a-z0-9-]+)":/gm)].map((m) => m[1] ?? ''),
    );
    expect(glyphs.size, 'no glyph names parsed out of icons.js: the derivation is broken').toBeGreaterThan(10);

    const page = await renderSettings();
    try {
      const hosts = Array.from(page.document.querySelectorAll('[data-ico]'));
      expect(hosts.length, 'no [data-ico] host on the page: this sweep would pass vacuously').toBeGreaterThan(0);
      const unknown = hosts
        .map((el) => el.getAttribute('data-ico') ?? '')
        .filter((name) => !glyphs.has(name));
      expect(unknown, 'data-ico names with no glyph in icons.js (these paint nothing, silently)').toEqual([]);
    } finally {
      page.close();
    }
  });
});

// ------------------------------------------------------- 3. the stagger index

describe('3. each account row carries its own stagger index', () => {
  it('--i ascends from 0 across the rendered rows', async () => {
    const page = await renderSettings();
    try {
      const rows = Array.from(page.document.querySelectorAll('#account-rows > *')) as HTMLElement[];
      expect(rows.length, 'no rows rendered: an empty ascending sequence is not evidence').toBeGreaterThan(1);
      const indices = rows.map((row) => row.style.getPropertyValue('--i').trim());
      expect(indices, 'the rows do not carry their own index, so they all share one delay').toEqual(
        rows.map((_, i) => String(i)),
      );
    } finally {
      page.close();
    }
  });

  // And the half jsdom cannot see: that the index reaches a delay. The
  // container opts in with .stagger.reveal and base.css turns --i into
  // transition-delay only inside a prefers-reduced-motion: no-preference
  // block, under the .js-reveal class ui.js adds.
  it('the index reaches a real transition-delay, ascending, in a real browser', async () => {
    const measured = await withOpenPage(1280, async (browser) =>
      browser.evaluate<{ jsReveal: boolean; rows: Array<{ i: string; delay: string }> }>(`
        (function () {
          var host = document.getElementById('account-rows');
          return {
            jsReveal: document.documentElement.classList.contains('js-reveal'),
            rows: Array.from(host.children).map(function (row) {
              return { i: row.style.getPropertyValue('--i').trim(),
                       delay: getComputedStyle(row).transitionDelay };
            })
          };
        })()
      `),
    );
    if (measured === null) return;

    expect(measured.jsReveal, 'the reveal layer never engaged, so no delay can apply').toBe(true);
    expect(measured.rows.length, 'no rows measured').toBeGreaterThan(1);

    const seconds = measured.rows.map((row) => parseFloat(row.delay));
    seconds.forEach((value, i) => {
      expect(Number.isFinite(value), `row ${i} has no readable transition-delay`).toBe(true);
    });
    // Strictly ascending is the property that matters: the rows arrive one
    // after another rather than together. The step itself is base.css's to
    // choose and this file does not pin it.
    for (let i = 1; i < seconds.length; i += 1) {
      expect(
        seconds[i]! > seconds[i - 1]!,
        `row ${i} does not arrive after row ${i - 1} (${JSON.stringify(measured.rows)})`,
      ).toBe(true);
    }
  }, BROWSER_TIMEOUT_MS);
});

// --------------------------------------------------------- 4. the copy control

describe('4. the identity copy control is the wireframe\u2019s, and the class does work', () => {
  it('#did-copy is a .copybtn carrying an .icoslot with both glyphs and a .lbl', async () => {
    const page = await renderSettings();
    try {
      const btn = page.document.getElementById('did-copy');
      expect(btn, '#did-copy is missing').not.toBeNull();
      expect(btn?.classList.contains('copybtn'), '#did-copy is not a .copybtn').toBe(true);

      const slot = btn!.querySelector('.icoslot');
      expect(slot, 'no .icoslot: the two glyphs have nothing to stack in').not.toBeNull();
      expect(slot?.querySelector('.ico.ico-copy[data-ico="copy"]'), 'no copy glyph').not.toBeNull();
      expect(slot?.querySelector('.ico.ico-done[data-ico="check"]'), 'no done glyph').not.toBeNull();
      expect(btn!.querySelector('.lbl')?.textContent?.trim(), 'the label is not a .lbl reading Copy').toBe('Copy');

      // The id is what settings.js writes the DID to. Keeping the structure
      // and losing the id would ship a button that copies an empty string.
      expect(btn?.getAttribute('data-copy'), 'the DID never reached the button').not.toBe('');
    } finally {
      page.close();
    }
  });

  // MEASURED, not read. The class is the hook polish.css hangs the stacked
  // slot on, so the way to prove the class does something is to take it off
  // and watch the box change. jsdom cannot do this: it performs no layout and
  // would report the same nothing either way.
  it('the .copybtn class is load-bearing: removing it changes the slot\u2019s box', async () => {
    const measured = await withOpenPage(1280, async (browser) =>
      browser.evaluate<{ withClass: [number, number]; without: [number, number] }>(`
        (function () {
          function box(el) {
            var r = el.getBoundingClientRect();
            return [Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100];
          }
          var btn = document.getElementById('did-copy');
          var slot = btn.querySelector('.icoslot');
          var withClass = box(slot);
          btn.classList.remove('copybtn');
          var without = box(slot);
          btn.classList.add('copybtn');
          return { withClass: withClass, without: without };
        })()
      `),
    );
    if (measured === null) return;

    // Shipped: the slot is one square cell holding both glyphs on top of each
    // other. Strip the class and polish.css's rule stops applying, so the two
    // glyphs lay out side by side and the slot widens.
    expect(measured.withClass[0], 'the slot is not square, so the glyphs are not stacked').toBe(
      measured.withClass[1],
    );
    expect(
      measured.without[0] > measured.withClass[0],
      `stripping .copybtn changed nothing (${JSON.stringify(measured)}), so the class is doing no work`,
    ).toBe(true);
  }, BROWSER_TIMEOUT_MS);

  it('the tick morph swaps the glyphs and leaves the label and the button box alone', async () => {
    const measured = await withOpenPage(1280, async (browser) => {
      const before = await browser.evaluate<{ copy: string; done: string; lbl: string; box: [number, number] }>(`
        (function () {
          var btn = document.getElementById('did-copy');
          var r = btn.getBoundingClientRect();
          return {
            copy: getComputedStyle(btn.querySelector('.ico-copy')).opacity,
            done: getComputedStyle(btn.querySelector('.ico-done')).opacity,
            lbl: btn.querySelector('.lbl').textContent,
            box: [Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100]
          };
        })()
      `);
      // The class polish.js's copyMorph adds on a press. Added directly so
      // this measures the STYLE, not the clipboard permission a headless
      // browser may refuse.
      await browser.evaluate(`document.getElementById('did-copy').classList.add('is-done'); true;`);
      // Past the transition, so the reading is the settled value rather than
      // a frame somewhere in the middle of it.
      await new Promise((resolve) => setTimeout(resolve, 900));
      const after = await browser.evaluate<{ copy: string; done: string; lbl: string; box: [number, number] }>(`
        (function () {
          var btn = document.getElementById('did-copy');
          var r = btn.getBoundingClientRect();
          return {
            copy: getComputedStyle(btn.querySelector('.ico-copy')).opacity,
            done: getComputedStyle(btn.querySelector('.ico-done')).opacity,
            lbl: btn.querySelector('.lbl').textContent,
            box: [Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100]
          };
        })()
      `);
      return { before, after };
    });
    if (measured === null) return;

    const { before, after } = measured;
    expect(parseFloat(before.copy), 'the copy glyph is not visible at rest').toBeGreaterThan(0.9);
    expect(parseFloat(before.done), 'the tick is visible before anything happened').toBeLessThan(0.1);
    expect(parseFloat(after.copy), 'the copy glyph did not give way to the tick').toBeLessThan(0.1);
    expect(parseFloat(after.done), 'the tick never arrived').toBeGreaterThan(0.9);

    // The point of morphing the icon rather than rewriting the word: the row
    // beside it does not reflow while the state changes.
    expect(after.lbl, 'the label changed, which is the reflow this design avoids').toBe(before.lbl);
    expect(after.box, 'the button resized while reporting the copy').toEqual(before.box);
  }, BROWSER_TIMEOUT_MS);

  // MUTATION CONTROL for the morph above: the same reading, with the class
  // polish.css hangs the swap on removed from the button.
  it('control: without .copybtn, the same press leaves both glyphs at rest', async () => {
    const measured = await withOpenPage(1280, async (browser) => {
      await browser.evaluate(`
        var b = document.getElementById('did-copy');
        b.classList.remove('copybtn');
        b.classList.add('is-done');
        true;
      `);
      await new Promise((resolve) => setTimeout(resolve, 900));
      return browser.evaluate<{ copy: string; done: string }>(`
        (function () {
          var btn = document.getElementById('did-copy');
          return {
            copy: getComputedStyle(btn.querySelector('.ico-copy')).opacity,
            done: getComputedStyle(btn.querySelector('.ico-done')).opacity
          };
        })()
      `);
    });
    if (measured === null) return;

    // Neither glyph is hidden, because the rule that hides one of them is
    // scoped to .copybtn. A control that still reported a swap here would
    // mean the assertion above is reading something else.
    expect(
      parseFloat(measured.copy) > 0.9 && parseFloat(measured.done) > 0.9,
      `the morph survived the class being removed (${JSON.stringify(measured)}), so it is not polish.css doing it`,
    ).toBe(true);
  }, BROWSER_TIMEOUT_MS);
});

// -------------------------------------------- 5. the sheet is doing real work

describe('5. polish.css is not decoration on this page', () => {
  // The honest form of "why is this sheet here". Every other assertion in
  // this file survives the sheet being dropped, because markup does not care
  // whether a rule exists. This one disables the sheet in place and re-reads
  // the same two boxes.
  it('disabling polish.css collapses the glyph and unstacks the copy slot', async () => {
    const measured = await withOpenPage(1280, async (browser) => {
      const probe = `
        (function () {
          function box(el) {
            var r = el.getBoundingClientRect();
            return [Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100];
          }
          return {
            stateIco: box(document.querySelector('#account-rows .state .ico')),
            icoslot: box(document.querySelector('#did-copy .icoslot'))
          };
        })()
      `;
      const on = await browser.evaluate<{ stateIco: [number, number]; icoslot: [number, number] }>(probe);
      await browser.evaluate(`
        Array.from(document.styleSheets).forEach(function (sheet) {
          if (String(sheet.href).indexOf('polish.css') !== -1) sheet.disabled = true;
        });
        true;
      `);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const off = await browser.evaluate<{ stateIco: [number, number]; icoslot: [number, number] }>(probe);
      return { on, off };
    });
    if (measured === null) return;

    const { on, off } = measured;
    // Shipped: both are real square boxes.
    expect(on.stateIco[0], 'the state glyph has no width with the sheet loaded').toBeGreaterThan(0);
    expect(on.stateIco[0], 'the state glyph is not square').toBe(on.stateIco[1]);
    expect(on.icoslot[0], 'the copy slot is not square, so the glyphs are not stacked').toBe(on.icoslot[1]);

    // Sheet off: base.css declares no .ico and no .icoslot, so the glyph
    // host has nothing sizing it and collapses to zero width. This is what
    // the page looked like before this card, with the glyph in place but no
    // sheet to size it, and it is why the marker swap and the sheet had to
    // land together.
    expect(
      off.stateIco[0],
      `the state glyph keeps its width without polish.css (${JSON.stringify(measured)}), so the sheet is not what sizes it`,
    ).toBe(0);
    expect(
      off.icoslot[0] !== on.icoslot[0],
      `the copy slot is unchanged without polish.css (${JSON.stringify(measured)})`,
    ).toBe(true);
  }, BROWSER_TIMEOUT_MS);
});
