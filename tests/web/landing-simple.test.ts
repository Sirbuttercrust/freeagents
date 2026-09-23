// L1: the landing page, simple. The page is the sample for the whole site's
// simplification, so what it promises is pinned here as rules rather than as
// copy:
//
//   a word ceiling      everything a person reads inside <main> is at most
//                       150 words, measured twice: from the markup (always
//                       runs) and from main.innerText in a real browser at
//                       1280 wide (what the brief measures)
//   two doors           the first viewport says what this is and offers one
//                       primary door (hire an agent) and one secondary door
//                       (list your agent), both fully on screen at 1280x900
//   the diagram         "How a hire works" is the reusable step flow with
//                       five steps, each at most five words; under reduced
//                       motion it is complete and still; with motion it is
//                       armed until scrolled into view, plays once, and ends
//                       complete
//   one money line      "never holds the money" appears exactly once
//   no jargon           none of the machine words DESIGN.md 1.3 keeps off a
//                       primary path
//   the detail moved    every link that replaced a section lands on an
//                       anchor that exists on /how
//
// These replace nothing that was deleted: the tests that guard the landing
// page elsewhere (render.test.ts, landing-bots.test.ts, mobile-layout.test.ts,
// static.test.ts, outcomes.test.ts) still run against the new page unchanged.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAccountRepository, MemoryAgentRepository } from '../../src/adapters/storage/memory.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const WORD_CEILING = 150;
const STEP_WORD_CEILING = 5;

// DESIGN.md 1.3: the machine words that never sit on a primary path. Matched
// as whole words, case-insensitive.
const JARGON = ['DID', 'DIDs', 'credential', 'credentials', 'Ed25519', 'hash', 'hashed', 'attestation', 'attested', 'proof suite', 'JSON-LD', 'specHash', 'fork', 'pull request', 'repo', 'repository', 'merge', 'merged'];

const here = dirname(fileURLToPath(import.meta.url));
const stepflowJs = readFileSync(join(here, '../../src/web/public/js/stepflow.js'), 'utf8');

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createApp(new MemoryAccountRepository(), new MemoryAgentRepository()).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function landingDoc(): Promise<Document> {
  const res = await fetch(`${baseUrl}/`, { headers: { Accept: 'text/html' } });
  expect(res.status).toBe(200);
  // No scripts: this is the page as markup, which is also the page a reader
  // gets when every script fails.
  return new JSDOM(await res.text()).window.document;
}

// The words a reader sees in an element, from markup: text nodes only, with
// comments, scripts, styles and SVG (decorative, aria-hidden) skipped.
function visibleWords(root: Element): string[] {
  const out: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      out.push(...(node.textContent ?? '').split(/\s+/).filter(Boolean));
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'svg' || el.hasAttribute('hidden')) return;
    el.childNodes.forEach(walk);
  };
  walk(root);
  return out;
}

describe('the landing page is simple, read from the markup', () => {
  it(`carries at most ${WORD_CEILING} words inside <main>`, async () => {
    const doc = await landingDoc();
    const main = doc.querySelector('main');
    expect(main, 'the page has no <main>, so nothing bounds what the ceiling counts').not.toBeNull();
    const words = visibleWords(main!);
    expect(words.length, `main carries ${words.length} words: ${words.join(' ')}`).toBeLessThanOrEqual(WORD_CEILING);
  });

  it('puts all the page copy inside <main>, so the ceiling cannot be dodged by moving a section out', async () => {
    const doc = await landingDoc();
    const outside = Array.from(doc.body.children).filter((el) => {
      const tag = el.tagName.toLowerCase();
      if (tag === 'main' || tag === 'nav' || tag === 'script') return false;
      if (el.id === 'foot' || el.classList.contains('agent-layer')) return false;
      return visibleWords(el).length > 0;
    });
    expect(outside.map((el) => `${el.tagName.toLowerCase()}#${el.id}`)).toEqual([]);
  });

  it('offers two doors in the hero: one primary to hire, one secondary to list', async () => {
    const doc = await landingDoc();
    const hero = doc.getElementById('hero')!;
    expect(hero.querySelector('h1')?.textContent?.trim()).toBeTruthy();
    const buttons = Array.from(hero.querySelectorAll('a.btn, button.btn'));
    expect(buttons, 'the hero has exactly two buttons').toHaveLength(2);
    const primary = buttons.filter((b) => b.classList.contains('btn-primary'));
    expect(primary, 'exactly one primary button (DESIGN.md 4.1)').toHaveLength(1);
    expect(primary[0]!.getAttribute('href')).toBe('/browse');
    expect(primary[0]!.textContent).toMatch(/hire/i);
    const secondary = buttons.find((b) => !b.classList.contains('btn-primary'))!;
    expect(secondary.getAttribute('href')).toBe('/signin');
    expect(secondary.textContent).toMatch(/list/i);
    // And no other primary anywhere on the page.
    expect(doc.querySelectorAll('.btn-primary')).toHaveLength(1);
  });

  it('draws "How a hire works" as the step flow: five steps, each a picture and at most five words', async () => {
    const doc = await landingDoc();
    const flow = doc.querySelector('#how [data-stepflow]');
    expect(flow, 'the hire diagram is not the step flow component').not.toBeNull();
    const steps = Array.from(flow!.querySelectorAll(':scope > .sf-step'));
    expect(steps).toHaveLength(5);
    for (const step of steps) {
      const svg = step.querySelector('.sf-node svg');
      expect(svg, `step "${step.textContent?.trim()}" has no picture`).not.toBeNull();
      const words = visibleWords(step.querySelector('.sf-label')!);
      expect(words.length, `"${words.join(' ')}"`).toBeGreaterThan(0);
      expect(words.length, `"${words.join(' ')}"`).toBeLessThanOrEqual(STEP_WORD_CEILING);
    }
    // No paragraph of explanation inside the diagram section.
    expect(doc.querySelectorAll('#how p').length, 'the only paragraph in #how is the money line').toBe(1);
  });

  it('says the money line exactly once, in plain words', async () => {
    const doc = await landingDoc();
    const text = visibleWords(doc.querySelector('main')!).join(' ');
    expect(text.match(/never holds the money/gi) ?? []).toHaveLength(1);
    expect(text).toMatch(/owner/i);
  });

  it('keeps the machine words off the page (DESIGN.md 1.3)', async () => {
    const doc = await landingDoc();
    const text = visibleWords(doc.querySelector('main')!).join(' ');
    const found = JARGON.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(text));
    expect(found, `jargon on the landing page: ${found.join(', ')}`).toEqual([]);
  });

  it('every link that stands in for moved detail lands on an anchor /how really has', async () => {
    const doc = await landingDoc();
    const links = Array.from(doc.querySelectorAll('main a[href^="/how#"]'));
    expect(links.length, 'the proof and the refusals each link to their detail').toBeGreaterThanOrEqual(2);
    const res = await fetch(`${baseUrl}/how`, { headers: { Accept: 'text/html' } });
    const how = new JSDOM(await res.text()).window.document;
    for (const a of links) {
      const id = a.getAttribute('href')!.split('#')[1]!;
      expect(how.getElementById(id), `/how has no #${id} for "${a.textContent}"`).not.toBeNull();
      // DESIGN.md 4.2: the link says what is behind it, never "More".
      expect((a.textContent ?? '').trim().split(/\s+/).length, `"${a.textContent}" does not say what is behind it`).toBeGreaterThanOrEqual(3);
    }
    // All four refusals the landing page names are explained there.
    const limits = how.getElementById('limits')!;
    expect(limits.querySelectorAll('.nopecard')).toHaveLength(4);
  });

  it('the step flow script only arms a diagram it is about to play, so every failure lands on the finished picture', () => {
    // The finished diagram is the CSS default; sf-armed is the only class
    // that hides anything, and it must be added after the reduced-motion and
    // missing-observer exits, never before them.
    const enhance = stepflowJs.slice(stepflowJs.indexOf('function enhance'), stepflowJs.indexOf('function iconFor'));
    const armAt = enhance.indexOf('classList.add("sf-armed")');
    const exitAt = enhance.indexOf('reduced() || typeof IntersectionObserver');
    expect(armAt).toBeGreaterThan(0);
    expect(exitAt).toBeGreaterThan(0);
    expect(exitAt, 'the diagram is armed before the reduced-motion exit').toBeLessThan(armAt);
  });
});

type Probe = {
  words: number;
  text: string;
  height: number;
  overflow: number;
  doors: Array<{ text: string; top: number; bottom: number; w: number; h: number }>;
  h1Bottom: number;
  tiny: string[];
  flow: {
    classes: string;
    plays: string | null;
    nodes: Array<{ opacity: number; transform: string }>;
    labels: Array<{ opacity: number; transform: string }>;
    lines: Array<{ transform: string; w: number; h: number }>;
  };
};

const PROBE = `
  (function () {
    var main = document.querySelector('main');
    var de = document.documentElement;
    var flow = document.querySelector('#how [data-stepflow]');
    function st(el) { var cs = getComputedStyle(el); return { opacity: +cs.opacity, transform: cs.transform }; }
    var tiny = [];
    var w = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
      var n = w.currentNode;
      if (!n.textContent.trim()) continue;
      var fs = parseFloat(getComputedStyle(n.parentElement).fontSize);
      if (fs < 13) tiny.push(n.textContent.trim().slice(0, 30) + ' at ' + fs + 'px');
    }
    return {
      words: main.innerText.split(/\\s+/).filter(Boolean).length,
      text: main.innerText,
      height: de.scrollHeight,
      overflow: de.scrollWidth - de.clientWidth,
      doors: [].map.call(document.querySelectorAll('#hero .btn'), function (b) {
        var r = b.getBoundingClientRect();
        return { text: b.textContent.trim(), top: r.top, bottom: r.bottom, w: r.width, h: r.height };
      }),
      h1Bottom: document.querySelector('#hero h1').getBoundingClientRect().bottom,
      tiny: tiny,
      flow: {
        classes: flow.className,
        plays: flow.getAttribute('data-sf-plays'),
        nodes: [].map.call(flow.querySelectorAll('.sf-node'), st),
        labels: [].map.call(flow.querySelectorAll('.sf-label'), st),
        lines: [].map.call(flow.querySelectorAll('.sf-step + .sf-step'), function (s) {
          var cs = getComputedStyle(s, '::before');
          return { transform: cs.transform, w: parseFloat(cs.width), h: parseFloat(cs.height) };
        })
      }
    };
  })()
`;

async function open(width: number, height: number, motion: 'reduce' | 'no-preference'): Promise<RealBrowser> {
  const b = await RealBrowser.launch({ width, height });
  if (width <= 760) {
    await b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
    await b.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion }] });
  await b.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs = []; addEventListener('error', function (e) { window.__errs.push(String(e.message)); });`,
  });
  await b.goto(`${baseUrl}/`, 1200);
  return b;
}

// A finished step: fully lit and not moved. 'none' is the computed transform
// of an element with no transform at all.
function expectFinished(flow: Probe['flow'], label: string): void {
  expect(flow.nodes, `${label}: five plates`).toHaveLength(5);
  expect(flow.lines, `${label}: four joining lines`).toHaveLength(4);
  for (const [i, n] of flow.nodes.entries()) {
    expect(n.opacity, `${label}: plate ${i + 1} is not fully lit`).toBe(1);
    expect(n.transform, `${label}: plate ${i + 1} is still moved`).toBe('none');
  }
  for (const [i, l] of flow.labels.entries()) {
    expect(l.opacity, `${label}: label ${i + 1} is not fully shown`).toBe(1);
    expect(l.transform, `${label}: label ${i + 1} is still moved`).toBe('none');
  }
  for (const [i, l] of flow.lines.entries()) {
    expect(l.transform, `${label}: line ${i + 1} is not fully drawn`).toBe('none');
    expect(Math.max(l.w, l.h), `${label}: line ${i + 1} has no length`).toBeGreaterThan(8);
  }
}

describe('the landing page is simple, measured in a real browser', { timeout: 90000 }, () => {
  it(`1280 wide: main.innerText is at most ${WORD_CEILING} words, both doors sit in the first viewport, no small type`, async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found; skipping (see CHROME_BIN)');
      return;
    }
    const b = await open(1280, 900, 'no-preference');
    try {
      const p = await b.evaluate<Probe>(PROBE);
      console.log(`landing at 1280: ${p.words} words, ${p.height}px tall`);
      expect(p.words, p.text).toBeLessThanOrEqual(WORD_CEILING);
      expect(p.doors.map((d) => d.text)).toEqual(['Hire an agent', 'List your agent']);
      for (const d of p.doors) {
        expect(d.top, `${d.text} starts above the viewport`).toBeGreaterThanOrEqual(0);
        expect(d.bottom, `${d.text} is below the first viewport`).toBeLessThanOrEqual(900);
      }
      expect(p.h1Bottom).toBeLessThanOrEqual(900);
      expect(p.tiny, 'text inside main set below 13px').toEqual([]);
      expect(await b.evaluate<string[]>('window.__errs')).toEqual([]);
    } finally {
      await b.close();
    }
  });

  it('under reduced motion the hire diagram is the finished picture on arrival, and never plays', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found; skipping (see CHROME_BIN)');
      return;
    }
    for (const width of [1280, 320]) {
      const b = await open(width, width === 320 ? 640 : 900, 'reduce');
      try {
        // Checked BEFORE the diagram is scrolled to: reduced motion means
        // nothing waits for the reader to arrive.
        const before = await b.evaluate<Probe>(PROBE);
        expect(before.flow.classes, `${width}: armed under reduced motion`).not.toContain('sf-armed');
        expectFinished(before.flow, `${width}, reduced, before scrolling`);
        await b.evaluate(`document.getElementById('how').scrollIntoView()`);
        await new Promise((r) => setTimeout(r, 1500));
        const after = await b.evaluate<Probe>(PROBE);
        expect(after.flow.plays, `${width}: played under reduced motion`).toBe(null);
        expectFinished(after.flow, `${width}, reduced, after scrolling`);
      } finally {
        await b.close();
      }
    }
  });

  it('with motion the diagram waits for the reader, plays once, and ends on the same finished picture', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found; skipping (see CHROME_BIN)');
      return;
    }
    const b = await open(1280, 900, 'no-preference');
    try {
      const top = await b.evaluate<Probe>(PROBE);
      expect(top.flow.classes, 'the diagram is below the fold and should be waiting').toContain('sf-armed');
      expect(top.flow.plays).toBe(null);
      expect(top.flow.nodes[0]!.opacity, 'an armed plate is dimmed, not hidden').toBeGreaterThan(0);

      await b.evaluate(`document.getElementById('how').scrollIntoView({ block: 'center' })`);
      await new Promise((r) => setTimeout(r, 700));
      const mid = await b.evaluate<Probe>(PROBE);
      expect(mid.flow.classes).toContain('sf-play');
      expect(mid.flow.plays).toBe('1');

      await new Promise((r) => setTimeout(r, 4500));
      const done = await b.evaluate<Probe>(PROBE);
      expect(done.flow.classes).toContain('sf-done');
      expectFinished(done.flow, 'with motion, after playing');

      // Away and back: it does not play again.
      await b.evaluate('window.scrollTo(0, 0)');
      await new Promise((r) => setTimeout(r, 800));
      await b.evaluate(`document.getElementById('how').scrollIntoView({ block: 'center' })`);
      await new Promise((r) => setTimeout(r, 800));
      const again = await b.evaluate<Probe>(PROBE);
      expect(again.flow.plays, 'the diagram replayed').toBe('1');
      expectFinished(again.flow, 'with motion, after returning');
      expect(await b.evaluate<string[]>('window.__errs')).toEqual([]);
    } finally {
      await b.close();
    }
  });

  it('no bot ever sits on top of the page copy or a control, at any scroll depth (the visibility law)', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found; skipping (see CHROME_BIN)');
      return;
    }
    for (const [width, height] of [[1280, 900], [320, 640]] as const) {
      const b = await open(width, height, 'no-preference');
      try {
        const total = await b.evaluate<number>('document.documentElement.scrollHeight');
        const covered: string[] = [];
        for (let y = 0; y <= total - height; y += Math.round(height / 3)) {
          await b.evaluate(`window.scrollTo(0, ${y})`);
          await new Promise((r) => setTimeout(r, 900));
          // Hit-test the centre of every text line and control that is on
          // screen. The topmost element there must belong to the page, never
          // to an agent layer: a bot is allowed to pass BEHIND copy, never
          // over it. elementFromPoint answers by hit-testing, and the page
          // makes its content boxes click-through on purpose, so for the
          // probe everything is made hit-testable (the bots' bodies too,
          // whole box, which is stricter than their drawn shape) and the
          // question becomes pure paint order. The full-viewport dust layers
          // stay out: they would win every point.
          const hits = await b.evaluate<string[]>(`
            (function () {
              var probe = document.createElement('style');
              probe.textContent = 'main, main * { pointer-events: auto !important } .agent-layer > div, .agent-layer > div * { pointer-events: auto !important }';
              document.head.appendChild(probe);
              var out = [], main = document.querySelector('main');
              var w = document.createTreeWalker(main, NodeFilter.SHOW_TEXT), pts = [];
              while (w.nextNode()) {
                var n = w.currentNode; if (!n.textContent.trim()) continue;
                var rg = document.createRange(); rg.selectNodeContents(n);
                [].forEach.call(rg.getClientRects(), function (r) { pts.push([n.textContent.trim().slice(0, 24), r]); });
              }
              [].forEach.call(main.querySelectorAll('a, button, .sf-node'), function (el) { pts.push([el.className + ' ' + el.textContent.trim().slice(0, 20), el.getBoundingClientRect()]); });
              pts.forEach(function (p) {
                var r = p[1];
                if (r.width < 1 || r.bottom < 70 || r.top > innerHeight - 1) return;
                var x = r.left + r.width / 2, y = r.top + r.height / 2;
                var top = document.elementFromPoint(x, y);
                if (top && top.closest('.agent-layer')) out.push(p[0] + ' @ ' + Math.round(x) + ',' + Math.round(y));
              });
              probe.remove();
              return out;
            })()
          `);
          covered.push(...hits.map((h) => `${width}px, scroll ${y}: ${h}`));
        }
        expect(covered, 'a bot is painted over page content').toEqual([]);
      } finally {
        await b.close();
      }
    }
  });

  it('320 wide: no sideways scroll, every control in main at least 44px, both doors tappable', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found; skipping (see CHROME_BIN)');
      return;
    }
    const b = await open(320, 640, 'no-preference');
    try {
      const p = await b.evaluate<Probe>(PROBE);
      expect(p.overflow).toBe(0);
      for (const d of p.doors) {
        expect(d.h, `${d.text} height`).toBeGreaterThanOrEqual(44);
        expect(d.w, `${d.text} width`).toBeGreaterThanOrEqual(44);
      }
      const small = await b.evaluate<string[]>(`[].filter.call(document.querySelectorAll('main a, main button'), function (el) {
        var r = el.getBoundingClientRect(); return r.width > 0 && (r.width < 44 || r.height < 44);
      }).map(function (el) { var r = el.getBoundingClientRect(); return el.textContent.trim() + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); })`);
      expect(small).toEqual([]);
      const edges = await b.evaluate<string[]>(`[].filter.call(document.querySelectorAll('main *'), function (el) {
        var r = el.getBoundingClientRect(); return r.width > 0 && (r.right > 320.5 || r.left < -0.5);
      }).map(function (el) { return el.tagName + '.' + el.className; })`);
      expect(edges, 'content past an edge at 320').toEqual([]);
    } finally {
      await b.close();
    }
  });

  it('the step flow is reusable: another list of steps mounts from data and finishes under reduced motion', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found; skipping (see CHROME_BIN)');
      return;
    }
    const b = await open(1280, 900, 'reduce');
    try {
      const r = await b.evaluate<{ steps: number; labels: string[]; svgs: number; classes: string }>(`
        (function () {
          var host = document.createElement('div');
          document.querySelector('main').appendChild(host);
          var ol = FAStepflow.render(host, [
            { label: 'Brief', icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>' },
            { label: 'Review', icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>' },
            { label: 'Merge', icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>' }
          ], 'A second flow');
          return {
            steps: ol.querySelectorAll('.sf-step').length,
            labels: [].map.call(ol.querySelectorAll('.sf-label'), function (l) { return l.textContent; }),
            svgs: ol.querySelectorAll('.sf-node svg').length,
            classes: ol.className
          };
        })()
      `);
      expect(r).toEqual({ steps: 3, labels: ['Brief', 'Review', 'Merge'], svgs: 3, classes: 'stepflow sf-done' });
    } finally {
      await b.close();
    }
  });
});
