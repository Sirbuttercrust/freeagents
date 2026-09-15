// W-signin: the sign-in page rebuilt on spec/wireframe/signin.html's polished
// visual system.
//
// The conformance gate (tests/web/wireframe-conformance.test.ts) measures one
// thing about this page's clothes: that every stylesheet the wireframe loads
// is present. It cannot see an over-load, a dead icon name, a builder note
// rendered as copy, or a 40px tap target, and every one of those is a way to
// pass that gate while shipping the wrong page. This file is those six
// assertions, plus a guard on each of the two repairs W-signin made to the
// live wiring.
//
// Where a fact is derived from the wireframe rather than typed here (the note
// prose, the icon vocabulary), the derivation FAILS LOUDLY on an empty
// population: a selector that stops matching would otherwise turn a real sweep
// into a green loop over nothing.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

const here = dirname(fileURLToPath(import.meta.url));
const wireframePath = join(here, '../../spec/wireframe/signin.html');
const builtPath = join(here, '../../src/web/pages/signin.html');
const iconsPath = join(here, '../../src/web/public/js/icons.js');

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

async function servedMarkup(): Promise<string> {
  const res = await fetch(`${baseUrl}/signin`, { headers: { Accept: HTML } });
  expect(res.status).toBe(200);
  return res.text();
}

// The page with its own scripts run for real, the same instrument
// tests/web/signin-flow.test.ts and tests/web/signin-wireframe.test.ts use.
// jsdom performs no layout, so nothing here reads a size; the two size
// assertions below drive a real browser instead.
async function renderSignin(): Promise<{ document: Document; window: JSDOM['window']; close: () => void }> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  const markup = await servedMarkup();
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

  return { document: dom.window.document, window: dom.window, close: () => dom.window.close() };
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
  it('loads polish.css, and loads neither market.css, gallery.css nor agreement.css', async () => {
    const sheets = linkedSheets(await servedMarkup());

    // The presence half. This is the assertion the conformance gate makes,
    // restated here so this file fails on its own if the sheet is dropped.
    expect(sheets, 'the polished layer must be linked').toContain('polish.css');
    expect(sheets).toContain('tokens.css');
    expect(sheets).toContain('base.css');

    // The absence half, which the conformance gate does NOT make: it checks
    // only that the wireframe's sheets are present, so an over-load passes it
    // silently. market.css and gallery.css are the marketplace card and the
    // portfolio gallery; agreement.css is the signature matrix. This page has
    // none of the three.
    const overLoaded = ['market.css', 'gallery.css', 'agreement.css', 'landing.css'].filter((s) =>
      sheets.includes(s),
    );
    expect(overLoaded, 'stylesheets loaded by a page that uses none of their components').toEqual([]);
  });

  it('loads the polished scripts in order, and does not load the avatar engine', async () => {
    const scripts = loadedScripts(await servedMarkup());

    expect(scripts).toEqual([
      '/js/pages/api.js',
      '/js/pages/nav.js',
      '/js/icons.js',
      '/js/polish.js',
      '/js/pages/signin.js',
      '/js/pages/ui.js',
    ]);

    // swarm.js paints [data-avatar] hosts. The wireframe declares none here,
    // because there is no agent on a sign-in page, so loading the engine would
    // ship a module with nothing to do. Parsed, not grepped: a grep cannot
    // tell an attribute on an element from the word in a comment, and this
    // page's own comment explains why the attribute is absent.
    expect(scripts.some((s) => s.includes('swarm.js'))).toBe(false);
    const shell = new JSDOM(readFileSync(builtPath, 'utf8'));
    try {
      expect(Array.from(shell.window.document.querySelectorAll('[data-avatar]')).length).toBe(0);
    } finally {
      shell.window.close();
    }
  });

  it('wears the wireframe\u2019s class vocabulary: .narrow and .or in, .col and .note out', async () => {
    const page = await renderSignin();
    try {
      // The swap this card made. .col was the built page's own 460px
      // uncentred column and is not a wireframe name; .narrow and .or are.
      // The conformance gate compares headings, controls and stylesheets and
      // never looks at a class, so nothing else would notice the old
      // vocabulary coming back under the new stylesheet.
      const columns = Array.from(page.document.querySelectorAll('.narrow'));
      expect(columns.length, 'no .narrow column: the page is not on the wireframe\u2019s vocabulary').toBeGreaterThan(0);
      expect(Array.from(page.document.querySelectorAll('.col')).length, '.col is the retired column name').toBe(0);

      const dividers = Array.from(page.document.querySelectorAll('.or'));
      expect(dividers.length, 'the wireframe\u2019s "or" divider is missing').toBe(1);
      expect((dividers[0]?.textContent ?? '').trim()).toBe('or');
    } finally {
      page.close();
    }
  });

  // The other half of the vocabulary check, and it cannot run in jsdom.
  // .narrow and .or exist in no shipped sheet (base.css:85 declares a
  // DIFFERENT .narrow: 640px, uncentred, for a reading column), so both are
  // page-local here exactly as they are in the wireframe, and a page-local
  // rule wins over a linked one at equal specificity only by SOURCE ORDER.
  // jsdom resolves the linked sheets after the inline block and reports
  // base.css's 640px winning; real Chrome reports 400px. Measured both ways
  // before believing either: the page is correct and jsdom's cascade is the
  // artifact, which is exactly why a page-local override gets measured in a
  // browser that lays the page out.
  it('the page-local .narrow beats base.css\u2019s reading column, measured in a real browser', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 1280, height: 900 });
    try {
      await browser.goto(`${baseUrl}/signin`);
      const measured = await browser.evaluate<{ widths: string[]; boxes: Array<[number, number]>; orDisplay: string }>(`
        (function () {
          var cols = Array.from(document.querySelectorAll('.narrow'));
          return {
            widths: cols.map(function (c) { return getComputedStyle(c).maxWidth; }),
            // Each column against ITS OWN parent .wrap, not the first .wrap on
            // the page: that one belongs to the nav, and measuring every column
            // against it reports a 1280px difference on a perfectly centred
            // column.
            boxes: cols.map(function (c) {
              var r = c.getBoundingClientRect();
              var w = c.parentElement.getBoundingClientRect();
              return [Math.round(r.left - w.left), Math.round(w.right - r.right)];
            }),
            orDisplay: getComputedStyle(document.querySelector('.or')).display,
          };
        })()
      `);

      expect(measured.widths.length).toBeGreaterThan(0);
      measured.widths.forEach((width) => {
        expect(width, '.narrow lost its 400px page-local width to base.css\u2019s 640px').toBe('400px');
      });
      // Centred, asserted as geometry rather than as the string "auto":
      // getComputedStyle resolves an auto margin to its used value, so
      // reading the property back can never see the declaration.
      measured.boxes.forEach(([left, right]) => {
        expect(Math.abs(left - right), `.narrow is not centred (gaps ${left} and ${right})`).toBeLessThanOrEqual(1);
      });
      expect(measured.orDisplay, '.or lost its page-local rule and renders as a bare word').toBe('flex');
    } finally {
      await browser.close();
    }
  });
});

// ------------------------------------------------------------ 2. the 44px floor

describe('2. both real sign-in buttons carry the 44px floor', () => {
  // The declaration, read out of the page's own sheet through the CSSOM
  // rather than grepped as text. This is what keeps the assertion alive on a
  // machine with no Chrome, where the measurement below skips.
  //
  // getPropertyValue, not style.minHeight: jsdom's CSSStyleDeclaration returns
  // undefined for the camelCase accessor on a rule read back out of a sheet,
  // so reading it that way parses every rule and finds a floor nowhere.
  it('the page sheet declares a min-height of at least 44px covering both buttons', async () => {
    const page = await renderSignin();
    try {
      const covered: Record<string, number> = {};
      const sheets = Array.from(page.document.styleSheets) as CSSStyleSheet[];
      sheets.forEach((sheet) => {
        let rules: CSSRule[] = [];
        try {
          rules = Array.from(sheet.cssRules ?? []);
        } catch {
          return; // a cross-origin sheet has no readable rules; none here are
        }
        rules.forEach((rule) => {
          const styleRule = rule as CSSStyleRule;
          if (typeof styleRule.selectorText !== 'string') return;
          const declared = parseFloat(styleRule.style?.getPropertyValue('min-height') ?? '');
          if (!Number.isFinite(declared)) return;
          styleRule.selectorText.split(',').forEach((selector) => {
            const id = selector.trim();
            if (id === '#btn-github' || id === '#btn-passkey') {
              covered[id] = Math.max(covered[id] ?? 0, declared);
            }
          });
        });
      });

      expect(covered['#btn-github'] ?? 0, 'no rule sets a min-height on #btn-github').toBeGreaterThanOrEqual(44);
      expect(covered['#btn-passkey'] ?? 0, 'no rule sets a min-height on #btn-passkey').toBeGreaterThanOrEqual(44);
    } finally {
      page.close();
    }
  });

  // And the measurement. base.css:118 gives .btn min-height 40px and
  // polish.css:568 raises it to 44 only under (max-width: 760px), (pointer:
  // coarse), so a DESKTOP pointer is where this page's floor was actually
  // missing: a screenshot at either width looks identical.
  it.each([
    [1280, 'desktop'],
    [320, 'mobile'],
  ])('measures at least 44x44 in a real browser at %ipx (%s)', async (width) => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: width as number, height: 900 });
    try {
      await browser.goto(`${baseUrl}/signin`);
      const undersized = await browser.evaluate<Array<[string, number, number]>>(`
        ['btn-github', 'btn-passkey']
          .map(function (id) {
            var r = document.getElementById(id).getBoundingClientRect();
            return [id, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10];
          })
          .filter(function (row) { return row[1] < 44 || row[2] < 44; })
      `);
      expect(undersized, `under the floor: ${JSON.stringify(undersized)}`).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});

// ------------------------------------------------------------- 3. the icon set

describe('3. every icon mounted on the page names a glyph that exists', () => {
  it('every data-ico resolves in icons.js, and every host is painted after load', async () => {
    // The vocabulary, derived from the shipped file rather than typed here:
    // a name added to icons.js is usable the day it lands, and a name removed
    // fails this test rather than painting nothing.
    const glyphs = new Set(
      [...readFileSync(iconsPath, 'utf8').matchAll(/^\s+"([a-z0-9-]+)":/gm)].map((m) => m[1] ?? ''),
    );
    expect(glyphs.size, 'no glyph names parsed out of icons.js: the derivation is broken').toBeGreaterThan(10);

    const page = await renderSignin();
    try {
      const hosts = Array.from(page.document.querySelectorAll('[data-ico]'));
      expect(hosts.length, 'no [data-ico] host on the page: this sweep would pass vacuously').toBeGreaterThan(0);

      const unknown = hosts
        .map((el) => el.getAttribute('data-ico') ?? '')
        .filter((name) => !glyphs.has(name));
      expect(unknown, 'data-ico names with no glyph in icons.js (these paint nothing, silently)').toEqual([]);

      // A correct name still paints nothing if icons.js never runs on this
      // page. An empty host collapses and the neighbouring word carries on, so
      // the failure is invisible in a screenshot.
      const unpainted = hosts
        .filter((el) => el.querySelector('svg') === null)
        .map((el) => el.getAttribute('data-ico') ?? '');
      expect(unpainted, 'data-ico hosts with no painted svg child').toEqual([]);
    } finally {
      page.close();
    }
  });
});

// -------------------------------------------------------- 4. no builder notes

describe('4. not one of the wireframe\u2019s builder notes is rendered', () => {
  it('no element carries class "note", and no note prose appears in the built page', async () => {
    const wireframe = readFileSync(wireframePath, 'utf8');

    // Derived from the wireframe's own div.note blocks. The notes explain the
    // design to a builder; rendering them would turn the page's reasoning into
    // its copy. Sentences shorter than 40 characters are dropped: they are too
    // short to be distinctive and would match ordinary product copy.
    const noteSentences = [...wireframe.matchAll(/<div class="note">([\s\S]*?)<\/div>/g)]
      .map((m) => (m[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
      .flatMap((text) => text.split(/(?<=\.)\s+/))
      .map((s) => s.trim())
      .filter((s) => s.length >= 40);
    expect(
      noteSentences.length,
      'no note prose parsed out of the wireframe: the derivation is broken, not the page',
    ).toBeGreaterThan(5);

    const page = await renderSignin();
    try {
      expect(
        Array.from(page.document.querySelectorAll('.note')).length,
        'the built page renders an element with class "note"',
      ).toBe(0);

      const rendered = (page.document.body.textContent ?? '').replace(/\s+/g, ' ');
      const leaked = noteSentences.filter((s) => rendered.includes(s));
      expect(leaked, 'builder-note prose rendered as product copy').toEqual([]);
    } finally {
      page.close();
    }
  });
});

// ------------------------------------- 5. no password, no account-type question

describe('5. the page asks for no password and no account type', () => {
  it('carries no password input, no form, and no role or account-type control', async () => {
    const page = await renderSignin();
    try {
      // POSITIVE CONTROL FIRST. Every assertion below is satisfied by an
      // empty page, so the page has to be doing its job before their absence
      // means anything: two real controls, and the settled statement that
      // replaced the question.
      expect(page.document.getElementById('btn-github'), '#btn-github is missing').not.toBeNull();
      expect(page.document.getElementById('btn-passkey'), '#btn-passkey is missing').not.toBeNull();
      const rendered = (page.document.body.textContent ?? '').replace(/\s+/g, ' ').toLowerCase();
      expect(rendered, 'the page no longer states that there is no account type to pick').toContain(
        'no signup form and no account type',
      );

      const passwords = Array.from(page.document.querySelectorAll('input')).filter((input) => {
        const attrs = [
          input.getAttribute('type') ?? '',
          input.getAttribute('name') ?? '',
          input.getAttribute('id') ?? '',
          input.getAttribute('autocomplete') ?? '',
        ]
          .join(' ')
          .toLowerCase();
        return attrs.includes('password');
      });
      expect(passwords.length, 'a password field on a page whose claim is that there is none').toBe(0);

      // No form at all. Nothing on this page is submitted: both controls run
      // a ceremony in script, and a form is how a password field or a role
      // picker arrives with somewhere to post to.
      expect(Array.from(page.document.querySelectorAll('form')).length, 'a form on a page with nothing to submit').toBe(0);

      // The account-type question: the wireframe's own note records the
      // operator's ruling that it should not be asked at all ("Just an account
      // should be able to do both"), and ENT-1 has no role field for an answer
      // to be stored in. A radio group, a select, or a checkbox pair is how it
      // would come back.
      const choosers = Array.from(page.document.querySelectorAll('select, input[type="radio"], input[type="checkbox"]'));
      expect(
        choosers.map((el) => el.getAttribute('id') ?? el.tagName.toLowerCase()),
        'a control offering a choice on a page whose whole argument is that there is nothing to choose',
      ).toEqual([]);

      // And the question wearing copy instead of markup. These are the ask
      // forms, not the word: the page legitimately SAYS there is no account
      // type, which is the sentence the positive control above pins.
      [
        'i want to hire',
        'i operate an agent',
        'choose your account type',
        'select an account type',
        'which describes you',
        'list an agent i operate or both',
      ].forEach((phrase) => {
        expect(rendered, `the account-type question resurfaced as copy: "${phrase}"`).not.toContain(phrase);
      });
    } finally {
      page.close();
    }
  });
});

// ------------------------------------------------------ 6. the three empty states

describe('6. the three honest-state boxes survive, with the visibility they shipped with', () => {
  it('all three exist by id in the served markup, with the same two hidden', async () => {
    const markup = await servedMarkup();
    const dom = new JSDOM(markup); // no scripts: this reads what the SERVER sent
    try {
      const states = ['account-notice', 'github-unconfigured', 'passkey-unavailable'].map((id) => {
        const el = dom.window.document.getElementById(id);
        expect(el, `#${id} is missing from the built page`).not.toBeNull();
        return [id, el!.hasAttribute('hidden'), el!.classList.contains('empty')] as const;
      });

      expect(states).toEqual([
        // Shown on load: signing in creates the account, which is the fact a
        // first-time visitor needs before pressing anything.
        ['account-notice', false, true],
        // Hidden until the live check says otherwise. Both are conditions, not
        // announcements, so a page that showed them on load would be telling
        // every visitor that sign-in is broken.
        ['github-unconfigured', true, true],
        ['passkey-unavailable', true, true],
      ]);
    } finally {
      dom.window.close();
    }
  });

  it('the hidden pair is driven by the real condition, not left dark', async () => {
    // jsdom carries no WebAuthn API, so the page's own feature check is true
    // here and the passkey box must come up. That is the state box doing its
    // job: the opposite result would mean the box exists and nothing can ever
    // show it.
    const page = await renderSignin();
    try {
      expect(page.document.getElementById('passkey-unavailable')!.hidden).toBe(false);
      expect((page.document.getElementById('btn-passkey') as HTMLButtonElement).disabled).toBe(true);
      // GitHub's box stays down until its own control is pressed and the
      // client id comes back empty (tests/web/signin-flow.test.ts drives that
      // click); nothing on load may raise it.
      expect(page.document.getElementById('github-unconfigured')!.hidden).toBe(true);
    } finally {
      page.close();
    }
  });
});

// --------------------------------------------- 7. the two W-signin live repairs

describe('7. the access list renders into the component its sheet styles', () => {
  // Before W-signin, signin.html declared .cap, .cap .what, .cap .why and
  // .cap .where, and signin.js built the row as a bare <div>: four rules with
  // nothing to match, on a component that looked styled in the source and
  // rendered unstyled on the page. A class no markup uses is dead and looks
  // alive.
  it('every capability row carries .cap, with its route and its reason inside', async () => {
    const page = await renderSignin();
    try {
      const rows = Array.from(page.document.querySelectorAll('#public-caps > *, #identified-caps > *'));
      expect(rows.length, 'GET /capabilities rendered no rows: this sweep would pass vacuously').toBeGreaterThan(0);

      const wrongClass = rows.filter((el) => !el.classList.contains('cap')).length;
      expect(wrongClass, 'capability rows rendered without the class their rules are written for').toBe(0);

      rows.forEach((el) => {
        expect(el.querySelector('.what')?.textContent ?? '').not.toBe('');
        expect(el.querySelector('.where')?.textContent ?? '').toMatch(/^(GET|POST) \//);
      });

      // The reason is the service's own sentence, so at least one row must
      // carry one; a page rendering only names would have quietly dropped the
      // half of the row that explains the limit.
      expect(rows.some((el) => (el.querySelector('.why')?.textContent ?? '').length > 20)).toBe(true);
    } finally {
      page.close();
    }
  });

  // Found by looking at the live page, not by any assertion: agent.browse.list
  // had no LABELS entry in signin.js, so the row rendered its raw capability
  // id to a person, beside seven rows in plain language. readable()'s fallback
  // to the id is the right failure mode (a guess would be worse) and it is
  // silent, which is what let this ship. Every id in src/domain/access.ts is
  // swept, so a capability added there fails here rather than on the page.
  it('every capability renders in plain language, never its raw id', async () => {
    const capabilities = (await (await fetch(`${baseUrl}/capabilities`)).json()) as {
      capabilities: Array<{ id: string }>;
    };
    expect(capabilities.capabilities.length, 'GET /capabilities returned nothing to label').toBeGreaterThan(0);

    const page = await renderSignin();
    try {
      const labels = Array.from(page.document.querySelectorAll('#public-caps .what, #identified-caps .what')).map(
        (el) => el.textContent ?? '',
      );
      expect(labels.length, 'no capability label rendered').toBe(capabilities.capabilities.length);

      const ids = new Set(capabilities.capabilities.map((cap) => cap.id));
      const raw = labels.filter((label) => ids.has(label));
      expect(raw, 'capability ids rendered to a person instead of a label (add them to LABELS in signin.js)').toEqual([]);

      // And the shape of an id, for a label that reads like one without
      // matching an id exactly: a dotted lowercase token with no space.
      const idShaped = labels.filter((label) => /^[a-z]+(\.[a-z]+)+$/.test(label.trim()));
      expect(idShaped, 'a label that reads as a protocol identifier').toEqual([]);
    } finally {
      page.close();
    }
  });

  it('320px: no horizontal overflow, with all three state boxes open', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 320, height: 900 });
    try {
      await browser.goto(`${baseUrl}/signin`);

      // Open the states a visitor can actually reach, rather than measuring
      // the page in the one arrangement that is easiest to pass: an unconfigured
      // deployment shows the GitHub box, a browser without WebAuthn shows the
      // passkey box, and the access list is long mono route text in a 400px
      // column.
      const opened = await browser.evaluate<number>(`
        ['account-notice', 'github-unconfigured', 'passkey-unavailable']
          .map(function (id) { var el = document.getElementById(id); el.hidden = false; return id; })
          .length
      `);
      expect(opened, 'the sweep opened no state: it would measure a page nobody sees').toBe(3);

      const metrics = await browser.evaluate<{ scrollWidth: number; clientWidth: number; offenders: string[] }>(`
        (function () {
          var offenders = [].filter.call(document.querySelectorAll('body *'), function (el) {
            return el.getBoundingClientRect().right > 320.5;
          }).map(function (el) {
            return (el.id || el.className || el.tagName) + ' @' +
                   Math.round(el.getBoundingClientRect().right);
          });
          return {
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            offenders: offenders.slice(0, 8),
          };
        })()
      `);
      expect(
        metrics.scrollWidth,
        `320px page scrolls sideways. offenders: ${JSON.stringify(metrics.offenders)}`,
      ).toBe(metrics.clientWidth);
      expect(metrics.offenders).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
