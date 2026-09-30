// The animated diagrams on /outcomes (src/web/public/js/diagrams.js and
// css/diagrams.css), measured in a real browser.
//
// Every assertion here is about rendered behaviour: whether a node is lit,
// whether a wire is drawn, whether a word can be read against the pixels
// behind it, whether a frame callback runs. jsdom lays nothing out and runs
// no frame loop, so none of it can be asserted there.
//
// "The finished picture" is read, never written down: every pin that asks
// whether a diagram is finished compares it against the same page loaded
// with ?still, the component's own test hook for the finished frame, in the
// same browser at the same size.
//
//   (a) plays once as it scrolls into view, never again on its own; Replay
//   (b) reduced motion and scripts off: finished at load, nothing moves
//   (c) every word inside the diagrams meets AA at ?t=0 and mid-play,
//       measured on painted pixels
//   (d) no frame callback runs once the play has ended
//   (e) the full wording sits behind one disclosure, closed on every load
//   (f) the deposit coins match MISSION.md's deposit share
//   (g) 320, 390 and 1280 on a touch profile: no sideways scroll, 44 px
//       controls, via labels inside the page
//   and Make 2: every way the script can fail lands on the finished picture.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const T_MS = 90_000;

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Opts {
  width: number;
  height: number;
  touch?: boolean;
  motion?: 'reduce' | 'no-preference';
  scriptsOff?: boolean;
  init?: string;
}

async function openBrowser(o: Opts): Promise<RealBrowser> {
  const b = await RealBrowser.launch({ width: o.width, height: o.height });
  if (o.touch) {
    await b.send('Emulation.setDeviceMetricsOverride', {
      width: o.width,
      height: o.height,
      deviceScaleFactor: 2,
      mobile: true,
      screenOrientation: { angle: 0, type: 'portraitPrimary' },
    });
    await b.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  await b.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: o.motion ?? 'no-preference' }],
  });
  if (o.scriptsOff) await b.send('Emulation.setScriptExecutionDisabled', { value: true });
  if (o.init) await b.send('Page.addScriptToEvaluateOnNewDocument', { source: o.init });
  return b;
}

// One string per node, wire, label and coin, per diagram. Two states are
// the same picture exactly when these are equal.
interface DiagramState {
  nodes: string[];
  wires: string[];
  vias: string[];
  coins: string[];
  strikes: string[];
  replayShown: boolean;
  top: number;
}

const STATE = `
  (function () {
    function cs(e) { return getComputedStyle(e); }
    return Array.from(document.querySelectorAll('[data-diagram]')).map(function (d) {
      var replay = d.querySelector('.dg-replay');
      return {
        nodes: Array.from(d.querySelectorAll('.dg-node')).map(function (n) {
          var h = n.querySelector('h3');
          return [n.getAttribute('data-id'), cs(n).opacity, cs(n).transform, cs(n).boxShadow, h ? cs(h).color : ''].join('|');
        }),
        wires: Array.from(d.querySelectorAll('.dg-wires .dg-wire')).map(function (w) { return cs(w).strokeDashoffset; }),
        vias: Array.from(d.querySelectorAll('.dg-via')).map(function (v) {
          return [v.textContent, cs(v).opacity, cs(v).transform, cs(v).color].join('|');
        }),
        coins: Array.from(d.querySelectorAll('.dg-coin')).map(function (c) { return cs(c).backgroundColor + '|' + cs(c).transform; }),
        strikes: Array.from(d.querySelectorAll('.dg-strike path')).map(function (p) { return cs(p).strokeDashoffset; }),
        replayShown: !!replay && !replay.hidden && cs(replay).display !== 'none',
        top: d.getBoundingClientRect().top
      };
    });
  })()
`;

type Picture = Omit<DiagramState, 'replayShown' | 'top'>;
function picture(s: DiagramState): Picture {
  return { nodes: s.nodes, wires: s.wires, vias: s.vias, coins: s.coins, strikes: s.strikes };
}

async function state(b: RealBrowser): Promise<DiagramState[]> {
  return b.evaluate<DiagramState[]>(STATE);
}

// The finished picture, read off ?still at this browser's size. Every pin
// that compares against it first needs it to hold both diagrams, or an
// empty page would equal an empty reference.
async function reference(b: RealBrowser): Promise<Picture[]> {
  await b.goto(`${baseUrl}/outcomes?still`, 400);
  const ref = (await state(b)).map(picture);
  expect(ref.length, 'two diagrams on /outcomes').toBe(2);
  expect(ref.map((d) => d.nodes.length), 'eight nodes in the first diagram, four in the second').toEqual([8, 4]);
  return ref;
}

async function scrollBottom(b: RealBrowser): Promise<void> {
  await b.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)');
}

async function waitFinished(b: RealBrowser, ms: number): Promise<DiagramState[]> {
  const until = Date.now() + ms;
  let s = await state(b);
  while (s.length > 0 && Date.now() < until) {
    if (s.length > 0 && s.every((d) => d.replayShown)) return s;
    await sleep(250);
    s = await state(b);
  }
  return s;
}

// A real click: scrolled to the middle of the screen, then a mouse press
// and release at the element's centre, so a control covered by anything
// else would not receive it.
async function clickCentre(b: RealBrowser, expr: string): Promise<void> {
  await b.evaluate(`(${expr}).scrollIntoView({ block: 'center' })`);
  await sleep(150);
  const q = await b.evaluate<{ x: number; y: number }>(`
    (function () { var r = (${expr}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()
  `);
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: q.x, y: q.y, button: 'left', clickCount: 1 });
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: q.x, y: q.y, button: 'left', clickCount: 1 });
}

// spec/wireframe carries its own copy of the component, because the
// wireframe folder is served as its own root and cannot reach src/web. A
// copy that drifts is a design record describing a component nobody ships.
describe('the wireframe copies of the component', () => {
  it.each([
    ['spec/wireframe/diagrams.js', 'src/web/public/js/diagrams.js'],
    ['spec/wireframe/diagrams.css', 'src/web/public/css/diagrams.css'],
  ])('%s is byte-identical to %s', (copy, shipped) => {
    const a = readFileSync(join(root, copy));
    const b = readFileSync(join(root, shipped));
    expect(b.length, `${shipped} is not empty`).toBeGreaterThan(1000);
    expect(a.equals(b), `${copy} differs from ${shipped}`).toBe(true);
  });
});

function skipWithoutChrome(): boolean {
  if (hasRealBrowser()) return false;
  console.warn('no Chrome found for the diagram tests; skipping (see CHROME_BIN)');
  return true;
}

describe('(a) the diagram plays once as it scrolls into view, and Replay plays it again', () => {
  it('the lower diagram waits unplayed below the fold, both finish on the finished picture, scrolling back moves nothing, Replay replays', async () => {
    if (skipWithoutChrome()) return;
    const b = await openBrowser({ width: 1280, height: 720 });
    try {
      const ref = await reference(b);
      expect(ref.length, 'two diagrams on /outcomes').toBe(2);

      await b.goto(`${baseUrl}/outcomes`, 300);
      const s0 = await state(b);
      const vh = await b.evaluate<number>('window.innerHeight');
      // The lower diagram has to start past the observer's 120 px margin,
      // or "it waits for the reader" is not under test.
      expect(s0[1]!.top, 'the second diagram starts below the fold at 1280x720').toBeGreaterThan(vh + 120);
      expect(picture(s0[0]!), 'the first diagram is playing at load, not finished').not.toEqual(ref[0]);
      expect(s0.map((d) => d.replayShown), 'no Replay while nothing has finished').toEqual([false, false]);

      await sleep(1500);
      const s1 = await state(b);
      expect(picture(s1[1]!), 'the second diagram has not moved while nobody could see it').toEqual(picture(s0[1]!));
      expect(picture(s1[1]!), 'and it waits dimmed, not finished').not.toEqual(ref[1]);

      await scrollBottom(b);
      const done = await waitFinished(b, 40_000);
      expect(done.map((d) => d.replayShown), 'both diagrams finish and offer Replay').toEqual([true, true]);
      expect(done.map(picture), 'each ends on the finished picture').toEqual(ref);

      // Away and back, twice, after the end: nothing plays on its own.
      for (const y of ['0', 'document.documentElement.scrollHeight', '0', 'document.documentElement.scrollHeight / 2']) {
        await b.evaluate(`window.scrollTo(0, ${y})`);
        await sleep(400);
        expect((await state(b)).map(picture), `after scrolling to ${y}`).toEqual(ref);
      }
      await sleep(1200);
      expect((await state(b)).map(picture), 'still the finished picture after scrolling back into view').toEqual(ref);

      await clickCentre(b, "document.querySelectorAll('[data-diagram]')[1].querySelector('.dg-replay')");
      await sleep(250);
      const replaying = await state(b);
      expect(picture(replaying[1]!), 'Replay starts the second diagram again').not.toEqual(ref[1]);
      expect(replaying[1]!.replayShown, 'Replay hides itself while it plays').toBe(false);
      expect(picture(replaying[0]!), 'the other diagram is untouched').toEqual(ref[0]);
      const again = await waitFinished(b, 15_000);
      expect(again.map(picture), 'and it ends on the finished picture again').toEqual(ref);
    } finally {
      await b.close();
    }
  }, T_MS);
});

describe('(b) under reduced motion and with scripts off, the finished picture shows at load', () => {
  it('reduced motion: every node, label and wire fully shown at load, nothing moves, no Replay', async () => {
    if (skipWithoutChrome()) return;
    const b = await openBrowser({ width: 1280, height: 720 });
    try {
      const ref = await reference(b);
      await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await b.goto(`${baseUrl}/outcomes`, 300);
      const s0 = await state(b);
      expect(s0.map(picture), 'the finished picture at load').toEqual(ref);
      expect(s0[0]!.wires.length, 'the first diagram draws its seven wires').toBe(7);
      expect(s0[0]!.vias.length, 'and its six via labels').toBe(6);
      expect(s0.map((d) => d.replayShown), 'there is nothing to replay under reduced motion').toEqual([false, false]);
      await scrollBottom(b);
      await sleep(1500);
      const s1 = await state(b);
      expect(s1.map(picture), 'nothing moves after scrolling').toEqual(ref);
      expect(s1.map((d) => d.replayShown), 'still no Replay').toEqual([false, false]);
    } finally {
      await b.close();
    }
  }, T_MS);

  it('scripts off: every node and label fully shown, the ending conditions in the cards, nothing moves', async () => {
    if (skipWithoutChrome()) return;
    const b = await openBrowser({ width: 1280, height: 720 });
    try {
      const ref = await reference(b);
      await b.send('Emulation.setScriptExecutionDisabled', { value: true });
      await b.goto(`${baseUrl}/outcomes`, 300);
      const s0 = await state(b);
      expect(s0.map((d) => d.nodes), 'every node as lit as in the finished picture').toEqual(ref.map((d) => d.nodes));
      expect(s0.map((d) => d.coins), 'every coin as in the finished picture').toEqual(ref.map((d) => d.coins));
      expect(s0.map((d) => d.replayShown), 'no Replay without script').toEqual([false, false]);
      const conditions = await b.evaluate<string[]>(`
        Array.from(document.querySelectorAll('.dg-if')).filter(function (e) {
          return e.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && e.getBoundingClientRect().width > 2;
        }).map(function (e) { return e.textContent; })
      `);
      // The wire labels are drawn by the script. Without it, each card
      // states its own condition in plain text.
      expect(conditions).toEqual([
        'If you decline it',
        'If you say nothing for 7 days',
        'If you merge it',
        'If you say nothing for 7 days',
        'If you close it and say why',
      ]);
      await sleep(1000);
      expect((await state(b)).map(picture), 'nothing moves').toEqual(s0.map(picture));
    } finally {
      await b.close();
    }
  }, T_MS);
});

describe('(Make 2) every way the script can fail lands on the finished picture', () => {
  const ERRORS = `window.__errs = []; window.addEventListener('error', function (e) { window.__errs.push(String(e.message)); });`;
  const cases: Array<[string, string, boolean]> = [
    ['no IntersectionObserver', 'delete window.IntersectionObserver;', true],
    ['no SVG geometry (as under jsdom)', 'delete SVGGeometryElement.prototype.getTotalLength; delete SVGGeometryElement.prototype.getPointAtLength;', false],
    ['a throw inside setup', "SVGGeometryElement.prototype.getTotalLength = function () { throw new Error('planted setup failure'); };", false],
  ];
  it.each(cases)('%s: every node lit, no wire half drawn, every ending condition readable', async (_name, plant, wires) => {
    if (skipWithoutChrome()) return;
    const b = await openBrowser({ width: 1280, height: 720 });
    try {
      const ref = await reference(b);
      await b.send('Page.addScriptToEvaluateOnNewDocument', { source: ERRORS + plant });
      await b.goto(`${baseUrl}/outcomes`, 400);
      const s0 = await state(b);
      expect(s0.map((d) => d.nodes), 'every node as lit as in the finished picture').toEqual(ref.map((d) => d.nodes));
      expect(s0.map((d) => d.coins), 'every coin as in the finished picture').toEqual(ref.map((d) => d.coins));
      expect(s0.map((d) => d.strikes), 'every strike drawn').toEqual(ref.map((d) => d.strikes));
      if (wires) {
        expect(s0.map(picture), 'with geometry intact the wires are drawn too').toEqual(ref);
      } else {
        expect(s0.map((d) => d.wires.length + d.vias.length), 'no wire or label is left half built').toEqual([0, 0]);
        const conditions = await b.evaluate<number>(`
          Array.from(document.querySelectorAll('.dg-if')).filter(function (e) { return e.getBoundingClientRect().width > 2; }).length
        `);
        expect(conditions, 'with no wire to carry them, all five cards state their condition').toBe(5);
      }
      const errs = await b.evaluate<string[]>('window.__errs');
      if (plant.includes('planted')) expect(errs.join(' '), 'a real throw is reported, not swallowed').toContain('planted setup failure');
      else expect(errs, 'a missing API is not an error').toEqual([]);
      await sleep(800);
      expect((await state(b)).map((d) => d.nodes), 'and nothing moves afterwards').toEqual(s0.map((d) => d.nodes));
    } finally {
      await b.close();
    }
  }, T_MS);
});

// ------------------------------------------------------------------ (c)
// Contrast measured the way tests/sweep/sweep-measure.ts measures it: the
// page photographed as painted and again with every glyph transparent, the
// background read from the second photograph under each text run, the ink
// from the computed colour composited through every ancestor's opacity, and
// a failure confirmed on the first photograph's own pixels.

function lum(c: readonly number[]): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c[0] ?? 0) + 0.7152 * f(c[1] ?? 0) + 0.0722 * f(c[2] ?? 0);
}
function ratio(a: readonly number[], b: readonly number[]): number {
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function needFor(px: number, weight: number): number {
  return px >= 23.5 || (px >= 18.5 && weight >= 700) ? 3 : 4.5;
}

interface Raw { data: Buffer; width: number; height: number; channels: number }
async function shot(b: RealBrowser): Promise<Raw> {
  const res = (await b.send('Page.captureScreenshot', { format: 'png' })) as { result?: { data?: string } };
  const png = Buffer.from(res.result?.data ?? '', 'base64');
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}
function pixel(img: Raw, x: number, y: number): [number, number, number] {
  const cx = Math.max(0, Math.min(img.width - 1, Math.round(x)));
  const cy = Math.max(0, Math.min(img.height - 1, Math.round(y)));
  const i = (cy * img.width + cx) * img.channels;
  return [img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0];
}

interface Run { key: string; t: string; el: string; px: number; weight: number; ink: number[]; a: number; rects: number[][] }

const RUNS = `
  (function () {
    var cv = document.createElement('canvas'); cv.width = cv.height = 1;
    var cx = cv.getContext('2d', { willReadFrequently: true });
    function rgba(c) { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); var d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; }
    function chain(e) { var a = 1; for (; e && e.nodeType === 1; e = e.parentElement) a *= parseFloat(getComputedStyle(e).opacity); return a; }
    var vh = window.innerHeight, vw = document.documentElement.clientWidth, out = [], transparent = [], i = 0;
    Array.prototype.forEach.call(document.querySelectorAll('[data-diagram]'), function (root) {
      var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (var n = w.nextNode(); n; n = w.nextNode()) {
        var key = String(i++);
        if (!/\\S/.test(n.nodeValue)) continue;
        var host = n.parentElement;
        if (!host.checkVisibility({ visibilityProperty: true })) continue;
        var r = document.createRange(); r.selectNodeContents(n);
        var rects = Array.prototype.slice.call(r.getClientRects()).filter(function (q) { return q.width > 1 && q.height > 1; });
        var inView = rects.filter(function (q) { return q.top >= 0 && q.bottom <= vh && q.left >= 0 && q.right <= vw; });
        if (!inView.length) continue;
        var st = getComputedStyle(host), ink = rgba(st.color), a = ink[3] * chain(host);
        var t = n.nodeValue.trim().replace(/\\s+/g, ' ').slice(0, 40);
        if (a < 0.05) { transparent.push(t); continue; }
        var q0 = inView[0], hit = document.elementFromPoint(q0.left + q0.width / 2, q0.top + q0.height / 2);
        if (!(hit && (hit === host || host.contains(hit) || hit.contains(host)))) continue;
        out.push({ key: key, t: t, el: host.tagName.toLowerCase() + '.' + String(host.className).split(' ').join('.'),
          px: parseFloat(st.fontSize), weight: parseInt(st.fontWeight, 10) || 400, ink: [ink[0], ink[1], ink[2]], a: a,
          rects: inView.slice(0, 3).map(function (q) { return [q.left, q.top, q.width, q.height]; }) });
      }
    });
    return { runs: out, transparent: transparent };
  })()
`;
const INKLESS_ON = `(function () { var s = document.createElement('style'); s.id = 'dg-inkless';
  s.textContent = '*,*::before,*::after{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important}';
  document.head.appendChild(s); return true; })()`;
const INKLESS_OFF = `(function () { var s = document.getElementById('dg-inkless'); if (s) s.remove(); return true; })()`;

async function contrastAt(b: RealBrowser, path: string): Promise<{ measured: number; transparent: string[]; failures: string[] }> {
  await b.goto(`${baseUrl}${path}`, 500);
  expect(await b.evaluate<number>("document.querySelectorAll('[data-diagram]').length"), 'two diagrams to measure').toBe(2);
  const span = await b.evaluate<{ a: number; z: number; vh: number; vw: number }>(`
    (function () { var d = document.querySelectorAll('[data-diagram]'); var a = d[0].getBoundingClientRect().top + scrollY, z = d[d.length - 1].getBoundingClientRect().bottom + scrollY;
      return { a: a, z: z, vh: innerHeight, vw: document.documentElement.clientWidth }; })()
  `);
  const measured = new Set<string>();
  const transparent = new Set<string>();
  const failures: string[] = [];
  const step = Math.floor(span.vh * 0.6);
  for (let y = Math.max(0, span.a - 120); y < span.z; y += step) {
    await b.evaluate(`window.scrollTo(0, ${y})`);
    await sleep(200);
    const got = await b.evaluate<{ runs: Run[]; transparent: string[] }>(RUNS);
    got.transparent.forEach((t) => transparent.add(t));
    const runs = got.runs.filter((r) => !measured.has(r.key));
    if (runs.length === 0) continue;
    const painted = await shot(b);
    await b.evaluate(INKLESS_ON);
    await sleep(80);
    const bare = await shot(b);
    await b.evaluate(INKLESS_OFF);
    const scale = painted.width / span.vw;
    for (const run of runs) {
      measured.add(run.key);
      const ratios: number[] = [];
      const bgs: Array<[number, number, number]> = [];
      for (const [x, yy, w, h] of run.rects as Array<[number, number, number, number]>) {
        for (let i = 1; i <= 5; i += 1) {
          for (let j = 1; j <= 3; j += 1) {
            const bg = pixel(bare, (x + (w * i) / 6) * scale, (yy + (h * j) / 4) * scale);
            bgs.push(bg);
            const ink = [0, 1, 2].map((k) => run.a * (run.ink[k] ?? 0) + (1 - run.a) * (bg[k] ?? 0));
            ratios.push(ratio(ink, bg));
          }
        }
      }
      ratios.sort((p, q) => p - q);
      const m = ratios[Math.floor(ratios.length * 0.25)] ?? 0;
      const need = needFor(run.px, run.weight);
      if (m >= need) continue;
      const lums = bgs.map(lum);
      const spread = Math.max(...lums) - Math.min(...lums);
      const medBg = bgs.slice().sort((p, q) => lum(p) - lum(q))[Math.floor(bgs.length / 2)] ?? [0, 0, 0];
      let best = 1;
      for (const [x, yy, w, h] of run.rects as Array<[number, number, number, number]>) {
        for (let py = Math.floor(yy * scale); py < Math.ceil((yy + h) * scale); py += 1) {
          for (let px = Math.floor(x * scale); px < Math.ceil((x + w) * scale); px += 1) {
            const r = ratio(pixel(painted, px, py), medBg);
            if (r > best) best = r;
          }
        }
      }
      if (best < need && spread <= 0.35) {
        failures.push(`${run.el} "${run.t}" ${run.px}px/${run.weight} measured ${m.toFixed(2)} (painted ${best.toFixed(2)}) against ${need}`);
      }
    }
  }
  return { measured: measured.size, transparent: [...transparent], failures };
}

describe('(c) every word inside the diagrams meets AA at every moment of the play', () => {
  // ?t=0 is every node waiting. 3.9 s is mid-play with the first ending
  // just arrived and the rest waiting; 4.6 s has a light on a wire, a via
  // label rising and a node mid-arrival.
  const moments: Array<[string, number, number]> = [
    ['?t=0', 390, 844],
    ['?t=3.9', 390, 844],
    ['?t=4.6', 390, 844],
    ['?t=0', 1280, 800],
    ['?t=4.6', 1280, 800],
  ];
  it.each(moments)('/outcomes%s @ %i x %i: every text run in the diagrams meets AA on painted pixels', async (q, width, height) => {
    if (skipWithoutChrome()) return;
    const b = await openBrowser({ width, height });
    try {
      const got = await contrastAt(b, `/outcomes${q}`);
      // Every run in both diagrams, as a floor: 68 were measured failing
      // on the unmodified component at 390, so fewer than that measured
      // means the walk missed text rather than that the text passed.
      expect(got.measured, 'the walk measured every text run in both diagrams').toBeGreaterThanOrEqual(68);
      expect(got.transparent, 'no word is hidden outright while it waits').toEqual([]);
      expect(got.failures, 'text runs under AA against the pixels behind them').toEqual([]);
    } finally {
      await b.close();
    }
  }, T_MS);
});

describe('(d) once the play ends, no frame callback runs', () => {
  it('requestAnimationFrame is called 0 times in the second after both diagrams finish', async () => {
    if (skipWithoutChrome()) return;
    const b = await openBrowser({
      width: 1280,
      height: 720,
      init: `(function () { var n = 0, raf = window.requestAnimationFrame;
        window.requestAnimationFrame = function (cb) { n += 1; return raf.call(window, cb); };
        window.__rafCount = function () { return n; }; })();`,
    });
    try {
      await b.goto(`${baseUrl}/outcomes`, 300);
      await scrollBottom(b);
      const done = await waitFinished(b, 40_000);
      expect(done.map((d) => d.replayShown), 'both diagrams finished').toEqual([true, true]);
      const during = await b.evaluate<number>('window.__rafCount()');
      expect(during, 'the counter saw the play run on frame callbacks').toBeGreaterThan(60);
      await sleep(1000);
      const after = await b.evaluate<number>('window.__rafCount()');
      expect(after - during, 'frame callbacks requested in the second after the end').toBe(0);
    } finally {
      await b.close();
    }
  }, T_MS);
});

describe('(e) the full wording sits behind one disclosure, closed on every visit', () => {
  const VIEW = `
    (function () {
      var btn = Array.from(document.querySelectorAll('main button[data-disclose]'));
      var panel = btn.length ? document.getElementById(btn[0].getAttribute('data-disclose')) : null;
      function shown(e) { return e.checkVisibility({ visibilityProperty: true }) && e.getBoundingClientRect().height > 0; }
      var fixed = Array.from(document.querySelectorAll('main .fixed'));
      return {
        buttons: btn.map(function (b) { return b.textContent.trim(); }),
        expanded: btn.length ? btn[0].getAttribute('aria-expanded') : null,
        panelHidden: panel ? panel.hidden : null,
        cards: Array.from(document.querySelectorAll('.oc')).filter(shown).map(function (c) { return c.querySelector('h3').textContent; }),
        cardsInPanel: panel ? panel.querySelectorAll('.oc').length : 0,
        lists: fixed.map(function (l) { return Array.from(l.querySelectorAll('li')).filter(shown).length; }),
        stored: localStorage.length + sessionStorage.length
      };
    })()
  `;
  it('closed at load, opens to all five endings, the two clocks and the four refusals, closed again on reload', async () => {
    if (skipWithoutChrome()) return;
    const b = await openBrowser({ width: 1280, height: 800 });
    try {
      await b.goto(`${baseUrl}/outcomes`, 400);
      const closed = await b.evaluate<Record<string, unknown>>(VIEW);
      expect(closed).toEqual({
        buttons: ['Show the full wording'],
        expanded: 'false',
        panelHidden: true,
        cards: [],
        cardsInPanel: 5,
        lists: [0, 0],
        stored: 0,
      });
      await clickCentre(b, "document.querySelector('main button[data-disclose]')");
      await sleep(400);
      const open = await b.evaluate<Record<string, unknown>>(VIEW);
      expect(open).toEqual({
        buttons: ['Hide the full wording'],
        expanded: 'true',
        panelHidden: false,
        cards: ['Completed', 'Completed without a decision', 'Closed with a reason', 'Declined', 'Lapsed'],
        cardsInPanel: 5,
        lists: [2, 4],
        stored: 0,
      });
      await b.goto(`${baseUrl}/outcomes`, 400);
      expect(await b.evaluate<Record<string, unknown>>(VIEW), 'closed again on reload').toEqual(closed);
    } finally {
      await b.close();
    }
  }, T_MS);
});

describe('(f) the deposit step fills MISSION.md\'s deposit share of four coins', () => {
  it('filled coins out of four on the deposit step equal MISSION.md\'s share, and the step states the same percentage', async () => {
    if (skipWithoutChrome()) return;
    const mission = readFileSync(join(root, 'MISSION.md'), 'utf8');
    const m = /(\d+) percent of the price at agreement/.exec(mission);
    expect(m, 'MISSION.md states the deposit share').not.toBeNull();
    const share = Number(m?.[1]);
    const b = await openBrowser({ width: 1280, height: 800 });
    try {
      await b.goto(`${baseUrl}/outcomes?still`, 400);
      const steps = await b.evaluate<Array<{ id: string; title: string; filled: number; total: number }>>(`
        Array.from(document.querySelectorAll('[data-diagram] .dg-node')).filter(function (n) { return n.querySelector('.dg-coins'); }).map(function (n) {
          var coins = Array.from(n.querySelectorAll('.dg-coin'));
          return {
            id: n.getAttribute('data-id'),
            title: n.querySelector('h3').textContent,
            filled: coins.filter(function (c) {
              var d = document.createElement('canvas').getContext('2d'); d.fillStyle = getComputedStyle(c).backgroundColor; d.fillRect(0, 0, 1, 1);
              return d.getImageData(0, 0, 1, 1).data[3] > 128;
            }).length,
            total: coins.length
          };
        })
      `);
      const deposit = steps[0];
      expect(deposit?.id, 'the first coin row is the first step').toBe('n1');
      expect(deposit?.total).toBe(4);
      expect(deposit?.filled, `${share}% of four coins`).toBe((4 * share) / 100);
      expect(deposit?.title).toBe(`You agree, and pay ${share}%`);
      // The rest of the money story stays consistent with the deposit.
      expect(steps.map((s) => `${s.id} ${s.filled}/${s.total}`)).toEqual([
        'n1 1/4', 'n2 1/4', 'e-declined 1/4', 'e-lapsed 1/4', 'n3 4/4', 'e-done 4/4', 'e-silent 4/4', 'e-closed 4/4',
      ]);
    } finally {
      await b.close();
    }
  }, T_MS);
});

describe('(g) on a touch phone and a touch desktop: no sideways scroll, 44 px controls, labels inside the page', () => {
  it.each([[320, 640], [390, 844], [1280, 800]])('@ %i: after the play, nothing past either edge, Replay and the disclosure clear 44 px, every via label inside the page', async (width, height) => {
    if (skipWithoutChrome()) return;
    const b = await openBrowser({ width, height, touch: true });
    try {
      await b.goto(`${baseUrl}/outcomes`, 300);
      await scrollBottom(b);
      const done = await waitFinished(b, 45_000);
      expect(done.map((d) => d.replayShown), 'both diagrams finished').toEqual([true, true]);
      await b.evaluate('window.scrollTo(0, 0)');
      await sleep(300);
      const out = await b.evaluate<{
        coarse: boolean;
        W: number;
        scrollWidth: number;
        past: string[];
        controls: Array<{ what: string; w: number; h: number }>;
        vias: Array<{ t: string; left: number; right: number }>;
      }>(`
        (function () {
          var W = document.documentElement.clientWidth, past = [];
          Array.from(document.querySelectorAll('main *')).forEach(function (e) {
            var r = e.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) return;
            if (r.right > W + 0.5 || r.left < -0.5) past.push(e.tagName + '.' + e.getAttribute('class') + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
          });
          var ctl = Array.from(document.querySelectorAll('.dg-replay, main button[data-disclose]')).map(function (e) {
            var r = e.getBoundingClientRect(); return { what: e.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height) };
          });
          var vias = Array.from(document.querySelectorAll('.dg-via')).filter(function (v) { return getComputedStyle(v).display !== 'none'; }).map(function (v) {
            var r = v.getBoundingClientRect(); return { t: v.textContent, left: Math.round(r.left), right: Math.round(r.right) };
          });
          return { coarse: matchMedia('(pointer: coarse)').matches, W: W, scrollWidth: document.documentElement.scrollWidth, past: past, controls: ctl, vias: vias };
        })()
      `);
      expect(out.coarse, 'the emulation reports a coarse pointer').toBe(true);
      expect(out.scrollWidth, 'no sideways scroll').toBe(out.W);
      expect(out.past, 'nothing past either edge').toEqual([]);
      expect(out.controls.map((c) => c.what)).toEqual(['Replay', 'Show the full wording', 'Replay']);
      for (const c of out.controls) {
        expect(c.h, `${c.what} height`).toBeGreaterThanOrEqual(44);
        expect(c.w, `${c.what} width`).toBeGreaterThanOrEqual(44);
      }
      expect(out.vias.length, 'the via labels are drawn').toBeGreaterThan(0);
      for (const v of out.vias) {
        expect(v.left, `${v.t} left edge`).toBeGreaterThanOrEqual(0);
        expect(v.right, `${v.t} right edge`).toBeLessThanOrEqual(out.W);
      }
    } finally {
      await b.close();
    }
  }, T_MS);
});
