// W-verify: the verify page rebuilt on spec/wireframe/verify.html's polished
// visual system.
//
// The conformance gate (tests/web/wireframe-conformance.test.ts) measures one
// thing about this page's clothes: that every stylesheet the wireframe loads
// is present. It cannot see an over-load, a dead icon name, a builder note
// rendered as copy, a 32px copy button, or a copy control that says "Copy"
// and copies nothing, and every one of those is a way to pass that gate while
// shipping the wrong page. This file is the brief's six assertions, plus a
// guard on each of the two live-wiring repairs W-verify made.
//
// Where a fact is derived from the wireframe or from a shipped file rather
// than typed here (the note prose, the icon vocabulary, the control
// population), the derivation FAILS LOUDLY on an empty population: a selector
// that stops matching would otherwise turn a real sweep into a green loop
// over nothing.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryCredentialRepository } from '../../src/adapters/storage/memory.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

// Real-browser layout tests launch Chrome, navigate at least once and
// evaluate in the page; vitest's 5000ms default times out under full-suite
// load exactly the way CI1 found in dashboard.test.ts and
// hire-polished.test.ts (run 35390871202, layout tests red on
// "Test timed out in 5000ms" with no layout defect). 30s is past every
// launch observed here and a genuinely broken layout still fails inside it.
const BROWSER_TIMEOUT_MS = 30_000;

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

const here = dirname(fileURLToPath(import.meta.url));
const wireframePath = join(here, '../../spec/wireframe/verify.html');
const builtPath = join(here, '../../src/web/pages/verify.html');
const iconsPath = join(here, '../../src/web/public/js/icons.js');

const AGENT_DID = 'did:abt:zWVerifyPolishedAgent';
const JOB_ID = 'w-verify-polished-job';

function credentialDoc(): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id: `https://freeagents.dev/v1/credentials/${JOB_ID}`,
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: 'did:abt:platform',
    validFrom: '2026-08-30T00:00:00.000Z',
    credentialSubject: {
      id: AGENT_DID,
      hire: {
        brief: 'sha256:brief',
        repository: 'buyer/w-verify-polished-repo',
        pullRequest: 'https://github.com/buyer/w-verify-polished-repo/pull/7',
        mergedAt: '2026-08-20T00:00:00.000Z',
        mergeCommit: 'wverifypolishedcommit',
        signedBy: `${AGENT_DID}#key-1`,
        buyer: 'did:example:w-verify-polished-buyer',
        additions: 5,
        deletions: 1,
        filesChanged: 1,
      },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zw-verify-polished-proof' },
  };
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const credentialRepo = new MemoryCredentialRepository();
  await credentialRepo.save({
    completedJobId: JOB_ID,
    subjectDid: AGENT_DID,
    document: credentialDoc(),
    repositoryPublic: true,
  });
  server = createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, credentialRepo).listen(
    0,
    '127.0.0.1',
  );
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function servedMarkup(path = '/verify'): Promise<string> {
  const res = await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } });
  expect(res.status).toBe(200);
  return res.text();
}

interface Rendered {
  document: Document;
  requests: string[];
  openDisclosures: () => number;
  close: () => void;
}

// The page with its own scripts run for real, the same instrument
// tests/web/verify-wireframe.test.ts uses. jsdom performs no layout, so
// nothing here reads a size; the floor assertions drive a real browser.
async function renderVerify(path: string): Promise<Rendered> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  const requests: string[] = [];
  const markup = await servedMarkup(path);
  const dom = new JSDOM(markup, {
    url: `${baseUrl}${path}`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      Object.defineProperty(window, 'fetch', {
        writable: true,
        value: (input: string, init?: RequestInit) => {
          requests.push(String(input));
          return fetch(new URL(input, baseUrl), init);
        },
      });
    },
  });

  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 300));

  if (failures.length > 0) throw new Error(`page script failed on ${path}: ${failures.join('; ')}`);

  const document = dom.window.document;
  return {
    document,
    requests,
    // Every copy control on this page lives behind a disclosure. A sweep
    // that never opens one reports a clean page in both the broken and the
    // fixed state, so the count is returned and asserted by each caller.
    openDisclosures: () => {
      const triggers = Array.from(document.querySelectorAll('[data-disclose]'));
      triggers.forEach((btn) => (btn as HTMLElement).click());
      return triggers.length;
    },
    close: () => dom.window.close(),
  };
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
  it('loads polish.css, and loads none of market.css, gallery.css or agreement.css', async () => {
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
      '/js/office.js',
      '/js/icons.js',
      '/js/polish.js',
      '/js/pages/verify.js',
      '/js/pages/ui.js',
    ]);

    // swarm.js paints [data-avatar] hosts. The wireframe declares none here,
    // because there is no agent on a verification page, so loading the engine
    // would ship a module with nothing to do. Parsed, not grepped: a grep
    // cannot tell an attribute on an element from the word in a comment, and
    // this page's own comment explains why the attribute is absent.
    expect(scripts.some((s) => s.includes('swarm.js'))).toBe(false);
    const shell = new JSDOM(readFileSync(builtPath, 'utf8'));
    try {
      expect(Array.from(shell.window.document.querySelectorAll('[data-avatar]')).length).toBe(0);
    } finally {
      shell.window.close();
    }
  });
});

// ------------------------------------------------------------------ 2. the hero

describe('2. the hero is the wireframe\u2019s pane, with the live pill', () => {
  it('wraps the glow in .pane.pane-pad.reveal[data-reveal] and opens with .state.state-live and its .dot', async () => {
    const page = await renderVerify('/verify');
    try {
      const hero = page.document.querySelector('.pane.pane-pad.reveal');
      expect(hero, 'no .pane.pane-pad.reveal: the hero is not the wireframe\u2019s').not.toBeNull();
      expect(hero!.hasAttribute('data-reveal'), 'the hero pane carries no data-reveal').toBe(true);

      // The glow is INSIDE the pane, which is the wireframe's nesting and the
      // reason the radial reads as light on the surface rather than behind a
      // bare column.
      expect(hero!.querySelector('.glow'), 'the glow is not inside the hero pane').not.toBeNull();

      const pill = hero!.querySelector('.state.state-live');
      expect(pill, 'no .state.state-live pill in the hero').not.toBeNull();
      expect(pill!.querySelector('.dot'), 'the live pill carries no .dot').not.toBeNull();
      expect((pill!.textContent ?? '').replace(/\s+/g, ' ').trim()).toBe('Independently checkable');

      // The pill sits inside the glow, above the h1, which is the wireframe's
      // order: the state of the thing before its name.
      const glow = hero!.querySelector('.glow')!;
      expect(glow.contains(pill!), 'the live pill is outside the glow it opens').toBe(true);
      const h1 = glow.querySelector('h1');
      expect(h1, 'no h1 in the hero glow').not.toBeNull();
      expect(
        pill!.compareDocumentPosition(h1!) & page.document.DOCUMENT_POSITION_FOLLOWING,
        'the live pill does not precede the heading',
      ).toBeTruthy();

      // The three checks wear the wireframe's .checked, not the built
      // page's retired .checks with its .n number chip.
      const checked = page.document.querySelectorAll('.checked > div');
      expect(checked.length, 'the wireframe\u2019s .checked block is missing or empty').toBe(3);
      expect(
        Array.from(page.document.querySelectorAll('.checks')).length,
        '.checks is the retired page-local name for .checked',
      ).toBe(0);
      expect(
        Array.from(page.document.querySelectorAll('.checked .n')).length,
        'the .n number chip is the retired treatment; the wireframe draws a dot before each heading',
      ).toBe(0);
    } finally {
      page.close();
    }
  });
});

// ----------------------------------------------------------- 3. the copy buttons

describe('3. every copy control carries the wireframe\u2019s glyphs', () => {
  it('every [data-copy] is a .copybtn with an .icoslot holding both ico-copy and ico-done', async () => {
    const page = await renderVerify(`/verify?credential=${JOB_ID}`);
    try {
      expect(page.openDisclosures(), 'the sweep opened no disclosure: every copy control lives behind one').toBe(3);

      const controls = Array.from(page.document.querySelectorAll('[data-copy]'));
      expect(controls.length, 'no [data-copy] control on the page: this sweep would pass vacuously').toBe(6);

      const wrong = controls
        .filter((el) => {
          const slot = el.querySelector('.icoslot');
          return (
            !el.classList.contains('copybtn') ||
            slot === null ||
            slot.querySelector('.ico.ico-copy') === null ||
            slot.querySelector('.ico.ico-done') === null ||
            el.querySelector('.lbl') === null
          );
        })
        .map((el) => el.id || el.className);
      expect(wrong, 'copy controls without the wireframe\u2019s copybtn/icoslot/ico/lbl structure').toEqual([]);
    } finally {
      page.close();
    }
  });

  // A correct structure still paints nothing if the glyph name does not exist
  // in the sprite, and nothing throws when it does not: the host collapses and
  // the neighbouring word carries on, so the failure is invisible in a
  // screenshot. The vocabulary is derived from the shipped file rather than
  // typed here, so a name removed from icons.js fails this rather than
  // painting nothing.
  it('every data-ico on the page names a glyph that exists, and every host is painted', async () => {
    const glyphs = new Set(
      [...readFileSync(iconsPath, 'utf8').matchAll(/^\s+"([a-z0-9-]+)":/gm)].map((m) => m[1] ?? ''),
    );
    expect(glyphs.size, 'no glyph names parsed out of icons.js: the derivation is broken').toBeGreaterThan(10);

    const page = await renderVerify(`/verify?credential=${JOB_ID}`);
    try {
      page.openDisclosures();
      const hosts = Array.from(page.document.querySelectorAll('[data-ico]'));
      expect(hosts.length, 'no [data-ico] host on the page: this sweep would pass vacuously').toBe(12);

      const unknown = hosts.map((el) => el.getAttribute('data-ico') ?? '').filter((name) => !glyphs.has(name));
      expect(unknown, 'data-ico names with no glyph in icons.js (these paint nothing, silently)').toEqual([]);

      const unpainted = hosts
        .filter((el) => el.querySelector('svg') === null)
        .map((el) => el.getAttribute('data-ico') ?? '');
      expect(unpainted, 'data-ico hosts with no painted svg child').toEqual([]);
    } finally {
      page.close();
    }
  });
});

// --------------------------------------------------------- 4. no builder notes

describe('4. not one of the wireframe\u2019s four builder notes is rendered', () => {
  it('no element carries class "note", and no note prose appears in the built page', async () => {
    const wireframe = readFileSync(wireframePath, 'utf8');

    // Derived from the wireframe's own div.note blocks: the "no Verify button
    // that calls us" note, the "no sign-in on this page" note, the
    // Ed25519Signature2020 note and the "disputed state is not drawn" note.
    // They explain the design to a builder; rendering them would turn the
    // page's reasoning into its copy. Sentences shorter than 40 characters
    // are dropped: they are too short to be distinctive and would match
    // ordinary product copy.
    const noteSentences = [...wireframe.matchAll(/<div class="note">([\s\S]*?)<\/div>/g)]
      .map((m) => (m[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
      .flatMap((text) => text.split(/(?<=\.)\s+/))
      .map((s) => s.trim())
      .filter((s) => s.length >= 40);
    expect(
      noteSentences.length,
      'no note prose parsed out of the wireframe: the derivation is broken, not the page',
    ).toBeGreaterThan(5);

    const page = await renderVerify(`/verify?credential=${JOB_ID}`);
    try {
      page.openDisclosures();
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

// ------------------------------------------------------------- 5. the 44px floor

describe('5. every real control on the page clears 44px, at 1280 and at 320', () => {
  // The page has two states and each hides controls the other shows: with no
  // receipt asked for, the lookup form, its field and its submit button; with one loaded,
  // the three action anchors and Download JSON. Measuring one state leaves the
  // other unmeasured, which is how a 32px control ships.
  //
  // The nav is excluded and the footer is not. The nav is shared chrome
  // rendered on every page from the same markup and governed by its own rules
  // in base.css and polish.css; this card owns the page. The footer links are
  // in scope and pass, so including them costs nothing and covers more.
  //
  // The floor is 43.95, not 44 (S3): at 320 this sweep named
  // "receipt-link 147.8x44" as under the floor, a height that prints as 44
  // at one decimal and sits a hair below it, float noise in layout rather
  // than a short control. The same slack past-work-simple.test.ts's
  // TAP_FLOOR carries and proves with a planted 43.9px control.
  const sweep = `
    (function () {
      ['sigcheck', 'ghcheck', 'idcheck'].forEach(function (id) {
        var b = document.querySelector('[data-disclose="' + id + '"]');
        if (b) b.click();
      });
      var all = [].filter.call(document.querySelectorAll('button, a[href], a[id], input:not([type="hidden"]), select, textarea'), function (el) {
        if (el.closest('nav')) return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;   // a hidden control is measured in its own state
      });
      return {
        measured: all.map(function (el) { return el.id || el.className || el.tagName; }),
        under: all.filter(function (el) {
          var r = el.getBoundingClientRect();
          return r.width < 43.95 || r.height < 43.95;
        }).map(function (el) {
          var r = el.getBoundingClientRect();
          return (el.id || el.className || el.tagName) + ' ' +
                 Math.round(r.width * 10) / 10 + 'x' + Math.round(r.height * 10) / 10;
        })
      };
    })()
  `;

  it.each([
    [1280, 'desktop'],
    [320, 'mobile'],
  ])('measures at least 44x44 in a real browser at %ipx (%s), in both page states', async (width) => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: width as number, height: 900 });
    try {
      // State one: no receipt asked for. The lookup form is the page.
      await browser.goto(`${baseUrl}/verify`);
      const lookup = await browser.evaluate<{ measured: string[]; under: string[] }>(sweep);
      expect(
        lookup.measured.length,
        'the lookup state offered no control to measure: this sweep would pass vacuously',
      ).toBeGreaterThan(8);
      expect(lookup.measured, 'the lookup form\u2019s submit button was not reached').toContain('btn btn-primary');
      expect(lookup.measured, 'the lookup field was not reached').toContain('credential-id');
      expect(lookup.under, `under the floor at ${width}px (lookup state): ${JSON.stringify(lookup.under)}`).toEqual([]);

      // State two: a receipt loaded. The action row and Download JSON appear.
      await browser.goto(`${baseUrl}/verify?credential=${JOB_ID}`);
      const loaded = await browser.evaluate<{ measured: string[]; under: string[] }>(sweep);
      expect(
        loaded.measured.length,
        'the loaded state offered no control to measure: this sweep would pass vacuously',
      ).toBeGreaterThan(12);
      ['pr-link', 'receipt-link', 'verify-agent-link', 'sig-download-link'].forEach((id) => {
        expect(loaded.measured, `${id} was not reached by the sweep`).toContain(id);
      });
      expect(loaded.under, `under the floor at ${width}px (loaded state): ${JSON.stringify(loaded.under)}`).toEqual([]);
    } finally {
      await browser.close();
    }
  }, BROWSER_TIMEOUT_MS);

  it('320px: no horizontal overflow, with every disclosure open and a receipt loaded', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 320, height: 900 });
    try {
      await browser.goto(`${baseUrl}/verify?credential=${JOB_ID}`);
      const opened = await browser.evaluate<number>(`
        [].map.call(document.querySelectorAll('[data-disclose]'), function (b) { b.click(); return 1; }).length
      `);
      expect(opened, 'the sweep opened no disclosure: it would measure the page nobody reads').toBe(3);

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
            offenders: offenders.slice(0, 8)
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
  }, BROWSER_TIMEOUT_MS);
});

// ------------------------------------------------------- 6. nothing depends on us

describe('6. the page performs no request that could be read as a check', () => {
  it('issues exactly two GETs, the credential read and the agent-name read, and states that it checked nothing', async () => {
    const page = await renderVerify(`/verify?credential=${JOB_ID}`);
    try {
      // POSITIVE CONTROL FIRST. An empty page satisfies "makes no check", so
      // the page has to be doing its job before the absence means anything:
      // the receipt loaded, the claim was restated, and the commands carry
      // real values.
      expect(page.document.getElementById('loaded')!.hidden, 'no receipt loaded: this assertion would be vacuous').toBe(
        false,
      );
      expect(page.document.getElementById('claim')!.textContent ?? '').toContain('w-verify-polished-repo');

      expect(page.requests, 'the page made a request other than the credential read and the agent-name read').toEqual([
        `/v1/credentials/${JOB_ID}`,
        `/agents/${encodeURIComponent(AGENT_DID)}`,
      ]);

      // The sentence that makes the reads honest. Without it the page reads
      // a receipt and says nothing about having done so, which is the shape
      // of a check being performed quietly. S3 shortened it from "This page
      // has checked none of that" to the line below; the rule is unchanged.
      const rendered = (page.document.body.textContent ?? '').replace(/\s+/g, ' ');
      expect(rendered, 'the page no longer says it has checked nothing').toContain('This page checks nothing itself');

      // And the verdict language a check would produce. These are phrases
      // this page must never render about the receipt it just read; the
      // wireframe's own copy names the checks a PERSON runs and never claims
      // one has passed here.
      [
        'signature is valid',
        'signature verified',
        'verified by freeagents',
        'we verified',
        'we checked',
        'verification passed',
        'this receipt is valid',
      ].forEach((phrase) => {
        expect(rendered.toLowerCase(), `a verdict this page cannot honestly reach: "${phrase}"`).not.toContain(phrase);
      });
    } finally {
      page.close();
    }
  });

  it('makes no request at all when no receipt is asked for', async () => {
    const page = await renderVerify('/verify');
    try {
      expect(page.document.getElementById('lookup')!.hidden, 'the lookup form did not come up').toBe(false);
      expect(page.requests, 'the page called out with nothing to read').toEqual([]);
    } finally {
      page.close();
    }
  });
});

// ------------------------------------------- 7. the two W-verify live repairs

describe('7. no copy control on this page says "Copy" and copies nothing', () => {
  // Measured before the repair, on the built page with the disclosures opened
  // and no receipt asked for: cmd-fetch-copy, cmd-pr-copy and cmd-commit-copy
  // were all reachable with data-copy="", and ui.js's handler returns on an
  // empty value. Three controls that paint, focus, clear the tap floor, say
  // "Copy", and do nothing when pressed, on the page whose whole argument is
  // that it does what it says.
  //
  // Swept, not spot-checked by id: a seventh control added later is caught by
  // the same assertion rather than inheriting the defect quietly.
  it.each([
    ['/verify', 'no receipt asked for'],
    [`/verify?credential=${JOB_ID}`, 'a receipt loaded'],
    ['/verify?credential=no-such-receipt-at-all', 'a receipt that does not resolve'],
  ])('%s (%s): every reachable copy control carries a value', async (path) => {
    const page = await renderVerify(path);
    try {
      expect(page.openDisclosures(), 'the sweep opened no disclosure').toBe(3);

      const reachable = (node: Element): boolean => {
        for (let el: Element | null = node; el; el = el.parentElement) {
          if ((el as HTMLElement).hidden) return false;
        }
        return true;
      };
      const live = Array.from(page.document.querySelectorAll('[data-copy]')).filter(reachable);
      expect(live.length, 'no reachable copy control: this sweep would pass vacuously').toBeGreaterThan(0);

      const dead = live.filter((el) => (el.getAttribute('data-copy') ?? '') === '').map((el) => el.id);
      expect(dead, 'reachable copy controls with nothing to copy (inert-declared-control)').toEqual([]);

      // And the value is the line it sits beside, not some other command:
      // a control wired to the wrong sibling copies something that runs and
      // answers about the wrong thing, which is worse than copying nothing.
      const mismatched = Array.from(page.document.querySelectorAll('.cmd'))
        .map((block) => {
          const pre = (block.querySelector('pre')?.textContent ?? '').trim();
          const btn = block.querySelector('[data-copy]');
          const value = btn?.getAttribute('data-copy') ?? '';
          return pre === value ? null : `${btn?.id ?? '?'}: pre=${JSON.stringify(pre)} value=${JSON.stringify(value)}`;
        })
        .filter((row): row is string => row !== null);
      expect(mismatched, 'a command control copying something other than the line beside it').toEqual([]);
    } finally {
      page.close();
    }
  });

  // ui.js swapped btn.textContent to "Copied" and back on every [data-copy].
  // On a .copybtn that replaces the whole subtree: the .icoslot, both glyphs
  // and the .lbl are destroyed on the first press and the restore puts back a
  // bare word, permanently. Measured on the shipped markup shape before the
  // repair: two glyphs and one label at rest, zero of each after one click.
  // Invisible in a screenshot of a page nobody has clicked, which is how it
  // shipped on the agent and operator profiles.
  it('a pressed copy button keeps its glyphs and its label', async () => {
    const page = await renderVerify(`/verify?credential=${JOB_ID}`);
    try {
      page.openDisclosures();
      const btn = page.document.getElementById('cmd-pr-copy')!;
      const shape = () => ({
        glyphs: btn.querySelectorAll('[data-ico]').length,
        painted: btn.querySelectorAll('.icoslot svg').length,
        label: (btn.querySelector('.lbl')?.textContent ?? '').trim(),
      });

      expect(shape()).toEqual({ glyphs: 2, painted: 2, label: 'Copy' });
      (btn as HTMLElement).click();
      expect(shape(), 'the press destroyed the button\u2019s own icon and label').toEqual({
        glyphs: 2,
        painted: 2,
        label: 'Copy',
      });
      // polish.js's copyMorph is what reports the result on a .copybtn, and
      // it can only do that if the glyphs it toggles are still there.
      expect(btn.classList.contains('is-done'), 'the copy button reported nothing back').toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(shape(), 'the restore timer left a bare word where the icon was').toEqual({
        glyphs: 2,
        painted: 2,
        label: 'Copy',
      });
      expect(btn.classList.contains('is-done')).toBe(false);
    } finally {
      page.close();
    }
  });
});

// ------------------------------------------------- 8. the reveal's end state

describe('8. the hero reveal lands on visible content in both motion modes', () => {
  // The hero is now a .reveal, which this card added. Reduced motion does not
  // mean "no animation ran", it means the person sees a dignified static
  // result, and the failure mode is the pane sitting at its hidden start
  // frame forever: missing content on the one page whose job is to be
  // readable without us. So the assertion under reduce is a pair that pulls
  // against itself, nothing moved AND the pane is still painted, because
  // checking only the first passes a hero that vanished.
  it.each([
    ['no-preference', true],
    ['reduce', false],
  ])('prefers-reduced-motion: %s', async (motion, expectJsReveal) => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 1280, height: 900 });
    try {
      await browser.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: motion }],
      });
      await browser.goto(`${baseUrl}/verify`);

      // Polled to a deadline past the page's own 3s unconditional backstop
      // rather than settled once: a gate that only passes on an idle machine
      // is flaky, not green, and a genuinely stalled reveal is still stalled
      // when the deadline passes.
      const measured = await browser.evaluate<{
        matches: boolean;
        jsReveal: boolean;
        opacity: string;
        transform: string;
        box: [number, number];
        stack: string[];
      }>(`
        (function () {
          var hero = document.querySelector('.pane.pane-pad.reveal');
          var deadline = Date.now() + 5000;
          return new Promise(function (resolve) {
            (function poll() {
              var cs = getComputedStyle(hero);
              var settled = parseFloat(cs.opacity) >= 0.99 &&
                (cs.transform === 'none' || cs.transform === 'matrix(1, 0, 0, 1, 0, 0)');
              if (settled || Date.now() > deadline) {
                var r = hero.getBoundingClientRect();
                var h = hero.querySelector('h1').getBoundingClientRect();
                resolve({
                  matches: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
                  jsReveal: document.documentElement.classList.contains('js-reveal'),
                  opacity: cs.opacity,
                  transform: cs.transform,
                  box: [Math.round(r.width), Math.round(r.height)],
                  stack: [].slice.call(document.elementsFromPoint(h.left + 8, h.top + 8), 0, 3)
                    .map(function (e) { return e.tagName + '.' + (e.className || ''); })
                });
              } else { setTimeout(poll, 100); }
            })();
          });
        })()
      `);

      // The emulation actually applied. Without this the reduce row silently
      // measures the no-preference branch and confirms it.
      expect(measured.matches, 'the reduced-motion emulation did not apply').toBe(motion === 'reduce');
      expect(measured.jsReveal, 'the hidden state is applied in the wrong motion mode').toBe(expectJsReveal);

      // Visible, in both modes.
      expect(parseFloat(measured.opacity), 'the hero settled invisible').toBeGreaterThanOrEqual(0.99);
      expect(['none', 'matrix(1, 0, 0, 1, 0, 0)'], 'the hero settled off its resting position').toContain(
        measured.transform,
      );
      expect(measured.box[0], 'the hero has no width').toBeGreaterThan(0);
      expect(measured.box[1], 'the hero has no height').toBeGreaterThan(0);

      // The visibility law, asked of the browser rather than read off a
      // z-index: the glow is decorative and must sit BELOW the heading. The
      // h1 wins its own pixel, or something is painting over the text.
      expect(measured.stack[0], `something is painted over the heading: ${JSON.stringify(measured.stack)}`).toBe('H1.');
    } finally {
      await browser.close();
    }
  }, BROWSER_TIMEOUT_MS);
});

