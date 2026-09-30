// The three animated diagrams on /how (DIAG1b), measured in a real browser
// against createApp(), the way tests/web/diagrams.test.ts measures
// /outcomes. That file holds the component's own pins (the byte-identical
// wireframe copies, and every way the script can fail); this one holds what
// /how adds: two lanes, proof rows, and guide agents drawn by bots.js.
//
// "The finished picture" is read, never written down: every pin that asks
// whether a diagram is finished compares it against the same page loaded
// with ?still, the component's test hook for the finished frame, in the
// same browser at the same size.
//
//   (a) all three play once as they scroll into view; Replay replays each
//   (b) reduced motion and scripts off: finished at load, nothing moves;
//       the agents are drawn in their still pose, and the late-core path
//   (c) every word in the three diagrams meets AA at ?t=0 and mid-play
//   (d) one frame loop: the core's ticker is the only rAF owner
//   (e) both disclosures closed at load, each opens to main's words
//   (f) the deposit step's coins match MISSION.md's deposit share
//   (g) 320, 390 and 1280 on a touch profile: no sideways scroll, 44 px
//       controls, one column and the rail on a phone, labels in the page
//   (h) #evidence and #limits land on their diagram's heading
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

interface Opts { width: number; height: number; touch?: boolean; init?: string; reduce?: boolean }

async function openBrowser(o: Opts): Promise<RealBrowser> {
  const b = await RealBrowser.launch({ width: o.width, height: o.height });
  if (o.touch) {
    await b.send('Emulation.setDeviceMetricsOverride', {
      width: o.width, height: o.height, deviceScaleFactor: 2, mobile: true,
      screenOrientation: { angle: 0, type: 'portraitPrimary' },
    });
    await b.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: o.reduce ? 'reduce' : 'no-preference' }] });
  if (o.init) await b.send('Page.addScriptToEvaluateOnNewDocument', { source: o.init });
  return b;
}

function skipWithoutChrome(): boolean {
  if (hasRealBrowser()) return false;
  console.warn('no Chrome found for the /how diagram tests; skipping (see CHROME_BIN)');
  return true;
}

// One string per node, wire, label, coin and strike, per diagram. Two
// states are the same picture exactly when these are equal. The agents are
// read apart from the picture, because a drawn agent is the same picture
// whether or not it is blinking.
interface DiagramState {
  nodes: string[]; wires: string[]; vias: string[]; coins: string[]; strikes: string[];
  replayShown: boolean; top: number;
}
const STATE = `
  (function () {
    function cs(e) { return getComputedStyle(e); }
    return Array.from(document.querySelectorAll('[data-diagram]')).map(function (d) {
      var replay = d.querySelector('.dg-replay');
      return {
        nodes: Array.from(d.querySelectorAll('.dg-node')).map(function (n) {
          var h = n.querySelector('h3, .tier, b') || n;
          return [n.getAttribute('data-id'), cs(n).opacity, cs(n).transform, cs(n).boxShadow, cs(n).backgroundColor, cs(h).color].join('|');
        }),
        wires: Array.from(d.querySelectorAll('.dg-wires .dg-wire')).map(function (w) { return cs(w).strokeDashoffset; }),
        vias: Array.from(d.querySelectorAll('.dg-via')).map(function (v) { return [v.textContent, cs(v).opacity, cs(v).transform, cs(v).color].join('|'); }),
        coins: Array.from(d.querySelectorAll('.dg-coin')).map(function (c) { return cs(c).backgroundColor + '|' + cs(c).transform; }),
        strikes: Array.from(d.querySelectorAll('.dg-strike path')).map(function (p) { return cs(p).strokeDashoffset; }),
        replayShown: !!replay && !replay.hidden && cs(replay).display !== 'none',
        top: d.getBoundingClientRect().top
      };
    });
  })()
`;
type Picture = Omit<DiagramState, 'replayShown' | 'top'>;
const picture = (s: DiagramState): Picture => ({ nodes: s.nodes, wires: s.wires, vias: s.vias, coins: s.coins, strikes: s.strikes });
const state = (b: RealBrowser) => b.evaluate<DiagramState[]>(STATE);

// Each agent: whether a canvas is drawn, whether it is on the frame loop
// (bots.js sets data-avatar-live), and a digest of its pixels.
interface Agent { id: string; canvas: boolean; live: boolean; painted: number; digest: string; plate: number[] }
const AGENTS = `
  (function () {
    return Array.from(document.querySelectorAll('[data-diagram] .dg-bot')).map(function (h) {
      var c = h.querySelector('canvas'), node = h.closest('.dg-node'), pr = h.parentNode.getBoundingClientRect();
      var out = { id: node ? node.getAttribute('data-id') : '', canvas: !!c, live: h.getAttribute('data-avatar-live') === 'true', painted: 0, digest: '',
        plate: [Math.round(pr.width), Math.round(pr.height)] };
      if (c && c.width) {
        var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, sum = 0;
        for (var i = 3; i < d.length; i += 4) { if (d[i] > 8) out.painted++; sum = (sum * 31 + d[i - 3] + d[i - 2] * 7 + d[i - 1] * 13 + d[i]) % 1000000007; }
        out.digest = c.width + 'x' + c.height + ':' + sum;
      }
      return out;
    });
  })()
`;
const agents = (b: RealBrowser) => b.evaluate<Agent[]>(AGENTS);

// The finished picture, read off ?still at this browser's size. It must
// hold all three diagrams, or an empty page would equal an empty reference.
async function reference(b: RealBrowser): Promise<Picture[]> {
  await b.goto(`${baseUrl}/how?still`, 400);
  const ref = (await state(b)).map(picture);
  expect(ref.map((d) => d.nodes.length), 'six steps, three proof rows with seven small nodes, four refusals').toEqual([6, 10, 4]);
  return ref;
}

async function waitFinished(b: RealBrowser, ms: number): Promise<DiagramState[]> {
  const until = Date.now() + ms;
  let s = await state(b);
  while (Date.now() < until && !(s.length > 0 && s.every((d) => d.replayShown))) {
    await sleep(250);
    s = await state(b);
  }
  return s;
}

// Scrolls down a screen at a time, so each diagram meets the reader as it
// would, and the clock never waits on a node nobody has scrolled to.
async function readDown(b: RealBrowser): Promise<void> {
  const h = await b.evaluate<number>('document.documentElement.scrollHeight');
  const vh = await b.evaluate<number>('innerHeight');
  for (let y = 0; y < h; y += Math.floor(vh / 2)) {
    await b.evaluate(`window.scrollTo(0, ${y})`);
    await sleep(900);
  }
}

// A real click: scrolled to the middle of the screen, then a mouse press and
// release at the element's centre, so a covered control would not get it.
async function clickCentre(b: RealBrowser, expr: string): Promise<void> {
  await b.evaluate(`(${expr}).scrollIntoView({ block: 'center' })`);
  await sleep(150);
  const q = await b.evaluate<{ x: number; y: number }>(`
    (function () { var r = (${expr}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()
  `);
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: q.x, y: q.y, button: 'left', clickCount: 1 });
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: q.x, y: q.y, button: 'left', clickCount: 1 });
}

describe('(a) on /how, all three diagrams play once as they scroll into view, and Replay replays each', () => {
  it('the lower two wait unplayed below the fold, all three finish on the finished picture, scrolling back moves nothing, and each Replay replays only its own', async () => {
    if (skipWithoutChrome()) return;
    const b = await openBrowser({ width: 1280, height: 720 });
    try {
      const ref = await reference(b);
      await b.goto(`${baseUrl}/how`, 300);
      const s0 = await state(b);
      const vh = await b.evaluate<number>('innerHeight');
      expect(s0[1]!.top, 'the proof diagram starts below the observer margin at 1280x720').toBeGreaterThan(vh + 120);
      expect(picture(s0[0]!), 'the hiring diagram is playing at load, not finished').not.toEqual(ref[0]);
      expect(s0.map((d) => d.replayShown), 'no Replay while nothing has finished').toEqual([false, false, false]);
      await sleep(1500);
      const s1 = await state(b);
      for (const i of [1, 2]) {
        expect(picture(s1[i]!), `diagram ${i + 1} has not moved while nobody could see it`).toEqual(picture(s0[i]!));
        expect(picture(s1[i]!), `diagram ${i + 1} waits dimmed, not finished`).not.toEqual(ref[i]);
      }

      await readDown(b);
      const done = await waitFinished(b, 40_000);
      expect(done.map((d) => d.replayShown), 'all three finish and offer Replay').toEqual([true, true, true]);
      expect(done.map(picture), 'each ends on the finished picture').toEqual(ref);
      for (const y of ['0', 'document.documentElement.scrollHeight', '0', 'document.documentElement.scrollHeight / 2']) {
        await b.evaluate(`window.scrollTo(0, ${y})`);
        await sleep(400);
        expect((await state(b)).map(picture), `after scrolling to ${y}`).toEqual(ref);
      }

      for (const i of [0, 1, 2]) {
        await clickCentre(b, `document.querySelectorAll('[data-diagram]')[${i}].querySelector('.dg-replay')`);
        await sleep(250);
        const replaying = await state(b);
        expect(picture(replaying[i]!), `Replay starts diagram ${i + 1} again`).not.toEqual(ref[i]);
        expect(replaying[i]!.replayShown, `diagram ${i + 1}'s Replay hides itself while it plays`).toBe(false);
        for (const j of [0, 1, 2].filter((k) => k !== i)) {
          expect(picture(replaying[j]!), `diagram ${j + 1} is untouched by diagram ${i + 1}'s Replay`).toEqual(ref[j]);
        }
        await b.evaluate(`document.querySelectorAll('[data-diagram]')[${i}].scrollIntoView({ block: 'end' })`);
        const again = await waitFinished(b, 20_000);
        expect(again.map(picture), `diagram ${i + 1} ends on the finished picture again`).toEqual(ref);
      }
    } finally {
      await b.close();
    }
  }, 150_000);
});

describe('(b) under reduced motion and with scripts off, the finished picture shows at load and nothing moves', () => {
  it('reduced motion: every node, label, wire and agent plate shown at load, no Replay, and the three agents drawn in the same still pose as ?still, off the frame loop', async () => {
    if (skipWithoutChrome()) return;
    const b = await openBrowser({ width: 1280, height: 720 });
    try {
      const ref = await reference(b);
      const stillAgents = await agents(b);
      await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await b.goto(`${baseUrl}/how`, 600);
      const s0 = await state(b);
      expect(s0.map(picture), 'the finished picture at load').toEqual(ref);
      expect(s0.map((d) => d.wires.length), 'five wires between the steps, four between the small proof nodes, none on the refusals').toEqual([5, 4, 0]);
      expect(s0.map((d) => d.vias.length), 'one label on a wire, "Pay the rest"').toEqual([1, 0, 0]);
      expect(s0.map((d) => d.replayShown), 'nothing to replay').toEqual([false, false, false]);
      const a0 = await agents(b);
      expect(a0.map((a) => a.id), 'a guide agent on each of the agent\u2019s three steps').toEqual(['s2', 's3', 's5']);
      for (const a of a0) {
        expect(a.canvas && a.painted > 200, `${a.id}: the agent is drawn`).toBe(true);
        expect(a.live, `${a.id}: the agent is not on the frame loop`).toBe(false);
        expect(a.plate, `${a.id}: the plate is fully shown at 48 px`).toEqual([48, 48]);
      }
      expect(a0.map((a) => a.digest), 'the same still pose as the finished picture').toEqual(stillAgents.map((a) => a.digest));
      await b.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)');
      await sleep(1200);
      await b.evaluate('window.scrollTo(0, 0)');
      await sleep(600);
      expect((await state(b)).map(picture), 'nothing moves after scrolling').toEqual(ref);
      expect((await agents(b)).map((a) => [a.live, a.digest]), 'no agent moved').toEqual(a0.map((a) => [false, a.digest]));
    } finally {
      await b.close();
    }
  }, T_MS);

  it('scripts off: every node lit as in the finished picture, every coin and strike drawn, each agent plate standing at its size, no Replay, nothing moves', async () => {
    if (skipWithoutChrome()) return;
    const b = await openBrowser({ width: 1280, height: 720 });
    try {
      const ref = await reference(b);
      await b.send('Emulation.setScriptExecutionDisabled', { value: true });
      await b.goto(`${baseUrl}/how`, 400);
      const s0 = await state(b);
      expect(s0.map((d) => d.nodes), 'every node as lit as in the finished picture').toEqual(ref.map((d) => d.nodes));
      expect(s0.map((d) => d.coins), 'every coin as in the finished picture').toEqual(ref.map((d) => d.coins));
      expect(s0.map((d) => d.strikes), 'every strike drawn').toEqual(ref.map((d) => d.strikes));
      expect(s0.map((d) => d.replayShown), 'no Replay without script').toEqual([false, false, false]);
      // Nothing can draw an agent with scripts off, so each plate stands as
      // an ordinary plate of the size an icon plate has.
      const plates = await agents(b);
      expect(plates.map((a) => [a.id, a.canvas, a.plate]), 'three plates, shown, with no canvas').toEqual([
        ['s2', false, [36, 36]], ['s3', false, [36, 36]], ['s5', false, [36, 36]],
      ]);
      await sleep(1000);
      expect((await state(b)).map(picture), 'nothing moves').toEqual(s0.map(picture));
    } finally {
      await b.close();
    }
  }, T_MS);

  it('before the avatar core is on the page each agent plate shows its icon and the diagram still plays; when the core arrives the agents are drawn, with no second frame loop', async () => {
    if (skipWithoutChrome()) return;
    // Holds the core back: bots.js reads window.BotAvatars as it loads, so
    // it finds nothing and FABots can draw nothing. Released below, the way
    // office.js brings the core and bots.js to a page that lacks them.
    const hold = `(function () { var held; Object.defineProperty(window, 'BotAvatars', { configurable: true,
      get: function () { return window.__release ? held : undefined; }, set: function (v) { held = v; } }); })();`;
    const b = await openBrowser({ width: 1280, height: 720, init: hold });
    try {
      await b.goto(`${baseUrl}/how`, 600);
      const before = await b.evaluate<Array<{ canvas: boolean; icon: boolean; hasBot: boolean }>>(`
        Array.from(document.querySelectorAll('.dg-bot')).map(function (h) {
          return { canvas: !!h.querySelector('canvas'), icon: !!h.querySelector('.ico svg'), hasBot: h.parentNode.classList.contains('has-bot') };
        })
      `);
      expect(before, 'each plate shows its icon, not an agent').toEqual(Array(3).fill({ canvas: false, icon: true, hasBot: false }));
      await b.evaluate("document.querySelector('[data-diagram]').scrollIntoView({ block: 'end' })");
      const done = await waitFinished(b, 20_000);
      expect(done[0]!.replayShown, 'the hiring diagram played to the end without the core').toBe(true);
      await b.evaluate(`(function () { window.__release = true; var s = document.createElement('script'); s.src = '/js/bots.js?late'; document.head.appendChild(s); })()`);
      await sleep(1200);
      const after = await agents(b);
      expect(after.map((a) => [a.id, a.canvas, a.painted > 200, a.plate]), 'the three agents are drawn once the core arrives').toEqual([
        ['s2', true, true, [48, 48]], ['s3', true, true, [48, 48]], ['s5', true, true, [48, 48]],
      ]);
      expect(after.every((a) => a.live), 'and they come alive on the core\u2019s ticker').toBe(true);
    } finally {
      await b.close();
    }
  }, T_MS);
});

// ------------------------------------------------------------------ (c)
// Contrast measured as tests/web/diagrams.test.ts (c) and the sweep's L3
// measure it: the page photographed as painted and again with every glyph
// transparent, the background read from the second photograph under each
// text run, the ink from the computed colour composited through every
// ancestor's opacity, and a failure confirmed on the first photograph's own
// pixels.
function lum(c: readonly number[]): number {
  const f = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c[0] ?? 0) + 0.7152 * f(c[1] ?? 0) + 0.0722 * f(c[2] ?? 0);
}
function ratio(a: readonly number[], b: readonly number[]): number {
  const la = lum(a); const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
const needFor = (px: number, weight: number) => (px >= 23.5 || (px >= 18.5 && weight >= 700) ? 3 : 4.5);

interface Raw { data: Buffer; width: number; height: number; channels: number }
async function shot(b: RealBrowser): Promise<Raw> {
  const res = (await b.send('Page.captureScreenshot', { format: 'png' })) as { result?: { data?: string } };
  const { data, info } = await sharp(Buffer.from(res.result?.data ?? '', 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}
function pixel(img: Raw, x: number, y: number): [number, number, number] {
  const cx = Math.max(0, Math.min(img.width - 1, Math.round(x)));
  const cy = Math.max(0, Math.min(img.height - 1, Math.round(y)));
  const i = (cy * img.width + cx) * img.channels;
  return [img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0];
}

interface Run { key: string; t: string; el: string; px: number; weight: number; ink: number[]; a: number; rects: number[][] }
// Every text node inside the three diagrams that is on screen and
// visible, keyed by its order so each is measured once.
const RUNS = `
  (function () {
    var cv = document.createElement('canvas'); cv.width = cv.height = 1;
    var cx = cv.getContext('2d', { willReadFrequently: true });
    function rgba(c) { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); var d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; }
    function chain(e) { var a = 1; for (; e && e.nodeType === 1; e = e.parentElement) a *= parseFloat(getComputedStyle(e).opacity); return a; }
    var vh = window.innerHeight, vw = document.documentElement.clientWidth, out = [], transparent = [], total = 0, i = 0;
    Array.prototype.forEach.call(document.querySelectorAll('[data-diagram]'), function (root) {
      var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (var n = w.nextNode(); n; n = w.nextNode()) {
        var key = String(i++);
        if (!/\\S/.test(n.nodeValue)) continue;
        var host = n.parentElement;
        if (!host.checkVisibility({ visibilityProperty: true })) continue;
        total++;
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
    return { runs: out, transparent: transparent, total: total };
  })()
`;
const INKLESS_ON = `(function () { var s = document.createElement('style'); s.id = 'dg-inkless';
  s.textContent = '*,*::before,*::after{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important}';
  document.head.appendChild(s); return true; })()`;
const INKLESS_OFF = `(function () { var s = document.getElementById('dg-inkless'); if (s) s.remove(); return true; })()`;

async function contrastAt(b: RealBrowser, path: string): Promise<{ measured: number; total: number; transparent: string[]; failures: string[] }> {
  await b.goto(`${baseUrl}${path}`, 600);
  expect(await b.evaluate<number>("document.querySelectorAll('[data-diagram]').length"), 'three diagrams to measure').toBe(3);
  const span = await b.evaluate<{ a: number; z: number; vh: number; vw: number }>(`
    (function () { var d = document.querySelectorAll('[data-diagram]'); return { a: d[0].getBoundingClientRect().top + scrollY,
      z: d[d.length - 1].getBoundingClientRect().bottom + scrollY, vh: innerHeight, vw: document.documentElement.clientWidth }; })()
  `);
  const measured = new Set<string>();
  const transparent = new Set<string>();
  const failures: string[] = [];
  let total = 0;
  for (let y = Math.max(0, span.a - 120); y < span.z; y += Math.floor(span.vh * 0.6)) {
    await b.evaluate(`window.scrollTo(0, ${y})`);
    await sleep(200);
    const got = await b.evaluate<{ runs: Run[]; transparent: string[]; total: number }>(RUNS);
    total = got.total;
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
            ratios.push(ratio([0, 1, 2].map((k) => run.a * (run.ink[k] ?? 0) + (1 - run.a) * (bg[k] ?? 0)), bg));
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
      if (best < need && spread <= 0.35) failures.push(`${run.el} "${run.t}" ${run.px}px/${run.weight} measured ${m.toFixed(2)} (painted ${best.toFixed(2)}) against ${need}`);
    }
  }
  return { measured: measured.size, total, transparent: [...transparent], failures };
}

describe('(c) every word in the three diagrams meets AA at every moment of the play', () => {
  // ?t freezes every diagram at that many seconds into its own play. 0 is
  // every node waiting. 2.2: a proof row's small node mid-arrival and a
  // light on its wire, the deposit step arriving. 4.6: a step mid-arrival
  // with its arrival ring. 8.2: the light on the wire into the pull request
  // step and "Pay the rest" rising on it, with the proof rows all arrived.
  const moments: Array<[string, number, number]> = [
    ['?t=0', 390, 844], ['?t=2.2', 390, 844], ['?t=8.2', 390, 844],
    ['?t=0', 1280, 800], ['?t=4.6', 1280, 800], ['?t=8.2', 1280, 800],
  ];
  it.each(moments)('/how%s @ %i x %i: every text run in the diagrams meets AA on painted pixels', async (q, width, height) => {
    if (skipWithoutChrome()) return;
    const b = await openBrowser({ width, height });
    try {
      const got = await contrastAt(b, `/how${q}`);
      // 52 visible text runs: the hiring diagram's title, six steps of
      // eyebrow, title and line, "Pay the rest" and its note (21); the
      // proof diagram's title, three rows of tier, line, "Could it be
      // faked?" and answer, seven small nodes, its note and "Show the exact
      // terms" (22); the refusals' title and four cards of title and line
      // (9). Replay is hidden while a diagram is frozen by ?t.
      expect(got.total, 'the three diagrams hold 52 visible text runs').toBe(52);
      expect(got.measured, 'the walk measured every one of them').toBe(got.total);
      expect(got.transparent, 'no word is hidden outright while it waits').toEqual([]);
      expect(got.failures, 'text runs under AA against the pixels behind them').toEqual([]);
    } finally {
      await b.close();
    }
  }, T_MS);
});

// ------------------------------------------------------------------ (d)
// Every requestAnimationFrame call is recorded with the script that made
// it, and every subscription to the avatar core's shared ticker with the
// script that took it and whether it is still held. A second loop on the
// unwrapped requestAnimationFrame counts the frames the page actually got,
// so a pin compares the core's calls to that count instead of to a frame
// rate this host may not reach. That loop is never recorded as a caller.
const FRAMES = `(function () {
  var calls = {}, subs = [], seen = 0;
  function who() {
    var lines = String(new Error().stack).split('\\n').slice(2);
    for (var i = 0; i < lines.length; i++) { var m = /\\/js\\/(?:vendor\\/bot-avatars\\/)?([\\w.-]+\\.js)/.exec(lines[i]); if (m) return m[1]; }
    return 'unknown';
  }
  var raf = window.requestAnimationFrame;
  (function count() { seen += 1; raf.call(window, count); })();
  window.__window = function () { var r = { calls: calls, frames: seen }; calls = {}; seen = 0; return r; };
  window.requestAnimationFrame = function (cb) { var k = who(); calls[k] = (calls[k] || 0) + 1; return raf.call(window, cb); };
  var held;
  Object.defineProperty(window, 'BotAvatars', { configurable: true, get: function () { return held; }, set: function (v) {
    var o = {}; for (var k in v) o[k] = v[k];
    var sub = v.subscribeBotAvatarTicker;
    o.subscribeBotAvatarTicker = function (fn) { var rec = { by: who(), live: true }; subs.push(rec); var u = sub(fn); return function () { rec.live = false; u(); }; };
    held = o;
  } });
  window.__frames = function () { var c = calls; calls = {}; return c; };
  window.__subs = function () { var n = {}; subs.forEach(function (s) { if (s.live) n[s.by] = (n[s.by] || 0) + 1; }); return n; };
  // bots.js runs an agent only while it is on screen, so this is how many
  // should be riding the ticker at this scroll position.
  window.__agentsOnScreen = function () {
    return Array.from(document.querySelectorAll('.dg-bot canvas')).filter(function (c) { var r = c.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; }).length;
  };
})();`;

describe('(d) one frame loop: the avatar core\u2019s ticker is the only thing that schedules a frame', () => {
  it('while the hiring diagram plays with its agents alive, every frame is the core\u2019s and the play and the agents on screen both ride it; once all three finish only the agents hold it, and with them off screen no frame runs', async () => {
    if (skipWithoutChrome()) return;
    const b = await openBrowser({ width: 1280, height: 720, init: FRAMES });
    try {
      await b.goto(`${baseUrl}/how`, 300);
      await b.evaluate('window.__window()');
      await sleep(1000);
      const playing = await b.evaluate<{ calls: Record<string, number>; frames: number }>('window.__window()');
      const subs = await b.evaluate<Record<string, number>>('window.__subs()');
      const onScreen = await b.evaluate<number>('window.__agentsOnScreen()');
      expect(Object.keys(playing.calls), 'every frame in the second of play was scheduled by the core').toEqual(['bot-avatars.js']);
      expect(playing.frames, 'the page got frames in that second').toBeGreaterThan(0);
      // The core asks for one frame per frame it runs, so over the same
      // window its calls match the page's own frame count, whatever rate
      // this host runs at. One frame of slack covers the window's edges.
      expect(playing.calls['bot-avatars.js'], `the core asked for a frame on each of the ${playing.frames} frames the page got`).toBeGreaterThanOrEqual(playing.frames - 1);
      expect(onScreen, 'at least one agent is on the first screen').toBeGreaterThan(0);
      expect(subs, 'the play and each agent on screen ride the core\u2019s ticker').toEqual({ 'diagrams.js': 1, 'bots.js': onScreen });

      await readDown(b);
      const done = await waitFinished(b, 40_000);
      expect(done.map((d) => d.replayShown), 'all three finished').toEqual([true, true, true]);

      await b.evaluate("document.getElementById('evidence').scrollIntoView()");
      await sleep(700);
      const office = await b.evaluate<{ live: boolean; paused: boolean }>(`
        (function () { var o = document.querySelector('[data-office]'); return { live: o.classList.contains('is-live'), paused: o.classList.contains('is-paused') }; })()
      `);
      expect(office, 'the office footer is built and paused out of view').toEqual({ live: true, paused: true });
      expect(await b.evaluate('window.__subs()'), 'nothing holds the ticker with the agents and the office out of view').toEqual({});
      await b.evaluate('window.__frames()');
      await sleep(1000);
      expect(await b.evaluate('window.__frames()'), 'no frame was requested in a second').toEqual({});

      await b.evaluate('window.scrollTo(0, 0)');
      await sleep(700);
      await b.evaluate('window.__frames()');
      await sleep(1000);
      expect(Object.keys(await b.evaluate<Record<string, number>>('window.__frames()')), 'back in view, only the core\u2019s loop runs').toEqual(['bot-avatars.js']);
      const backOnScreen = await b.evaluate<number>('window.__agentsOnScreen()');
      expect(backOnScreen, 'the agents on the first screen are back in view').toBeGreaterThan(0);
      expect(await b.evaluate('window.__subs()'), 'and only the agents on screen hold it').toEqual({ 'bots.js': backOnScreen });
    } finally {
      await b.close();
    }
  }, 120_000);
});

// ------------------------------------------------------------------ (e)
// main's words, exactly as the page read before the diagrams.
const OLD_STEPS = [
  'You describe the work|Nothing exists yet. No record, no obligation.',
  'The agent proposes what done means|A checklist you can edit or reject, as many times as you need.',
  'You confirm|The job exists from here. Neither side can change the terms.',
  'The agent opens a pull request|From its own fork. It never gets write access to your repository.',
  'You merge it, or you do not|Merging creates the receipt. Closing it unmerged is recorded too.',
];
const OLD_EVIDENCE = [
  'Verified hire|We did. We saw the pull request merge on GitHub.|Nobody',
  'Verified prior work|GitHub did. The agent proved it owns the account.|Whoever holds both',
  'Portfolio claim|Nobody. Often the work is private.|Anyone',
];
const OLD_REFUSALS = [
  'No write access to your repository|The agent forks and opens a pull request. Merging is your click, on GitHub.',
  'We never run the agent|It runs on its owner\u2019s own setup. We witness hires, we do not perform them.',
  'No judgement on the work|We record whether it merged. A job that closed unmerged stays on the record.',
  'No score, ever|No stars, no percentage, no trust level. Reviews are tied to one real job.',
];
const TERMS = [
  '"your identity"|a DID',
  '"proof of this job" / "receipt"|a Verifiable Credential',
  '"GitHub account confirmed"|account proof, checked both directions',
  '"neither side can change this later"|specHash, fixed at confirm',
];
const VIEW = `
  (function () {
    function shown(e) { return e.checkVisibility({ visibilityProperty: true }) && e.getBoundingClientRect().height > 0; }
    function txt(e) { return e.textContent.replace(/\\s+/g, ' ').trim().replace(/'/g, '\\u2019'); }
    var btns = Array.from(document.querySelectorAll('main button[data-disclose]'));
    return {
      buttons: btns.map(function (b) { return [b.textContent.trim(), b.getAttribute('aria-expanded'), document.getElementById(b.getAttribute('data-disclose')).hidden]; }),
      lede: Array.from(document.querySelectorAll('#full-wording > p.sub')).filter(shown).map(txt),
      steps: Array.from(document.querySelectorAll('.rstep')).filter(shown).map(function (s) { return txt(s.querySelector('h3')) + '|' + txt(s.querySelector('p')); }),
      evidence: Array.from(document.querySelectorAll('.evrow')).filter(shown).map(function (r) { return Array.from(r.children).map(txt).join('|'); }),
      sentence: Array.from(document.querySelectorAll('.callout')).filter(shown).map(txt),
      refusals: Array.from(document.querySelectorAll('.nopecard')).filter(shown).map(function (c) { return txt(c.querySelector('h3')) + '|' + txt(c.querySelector('p')); }),
      terms: Array.from(document.querySelectorAll('#terms .kv')).filter(shown).map(function (k) { return txt(k.querySelector('dt')) + '|' + txt(k.querySelector('dd')); }),
      stored: localStorage.length + sessionStorage.length
    };
  })()
`;

describe('(e) the full wording and the exact terms each sit behind one disclosure, closed on every visit', () => {
  it('both closed at load; "Show the full wording" opens to main\u2019s lede, five steps, evidence table and sentence, and four refusal cards; "Show the exact terms" opens to its four pairs; both closed again on reload', async () => {
    if (skipWithoutChrome()) return;
    const b = await openBrowser({ width: 1280, height: 800 });
    try {
      await b.goto(`${baseUrl}/how`, 400);
      const closed = await b.evaluate<Record<string, unknown>>(VIEW);
      expect(closed).toEqual({
        buttons: [['Show the exact terms', 'false', true], ['Show the full wording', 'false', true]],
        lede: [], steps: [], evidence: [], sentence: [], refusals: [], terms: [], stored: 0,
      });
      await clickCentre(b, "document.querySelector('main button[data-disclose=\"full-wording\"]')");
      await sleep(400);
      expect(await b.evaluate(VIEW)).toEqual({
        buttons: [['Show the exact terms', 'false', true], ['Hide the full wording', 'true', false]],
        lede: ['FreeAgents is a place to hire an AI agent for real work, and to see exactly what one has actually finished before you do. No score, no star rating. What follows is the whole model, plainly.'],
        steps: OLD_STEPS,
        evidence: OLD_EVIDENCE,
        sentence: ['These never add up to one score. They are different kinds of evidence, not different amounts of the same thing.'],
        refusals: OLD_REFUSALS,
        terms: [],
        stored: 0,
      });
      await clickCentre(b, "document.querySelector('main button[data-disclose=\"terms\"]')");
      await sleep(400);
      const both = await b.evaluate<Record<string, unknown>>(VIEW);
      expect(both.buttons).toEqual([['Hide the exact terms', 'true', false], ['Hide the full wording', 'true', false]]);
      expect(both.terms, 'the four plain words and their exact terms, unchanged').toEqual(TERMS);
      await b.goto(`${baseUrl}/how`, 400);
      expect(await b.evaluate(VIEW), 'both closed again on reload').toEqual(closed);
    } finally {
      await b.close();
    }
  }, T_MS);
});

describe('(f) the deposit step fills MISSION.md\u2019s deposit share of four coins', () => {
  it('filled coins out of four on the deposit step equal MISSION.md\u2019s share, the step states the same percentage, and the pull request step is paid in full', async () => {
    if (skipWithoutChrome()) return;
    const mission = readFileSync(join(root, 'MISSION.md'), 'utf8');
    const m = /(\d+) percent of the price at agreement/.exec(mission);
    expect(m, 'MISSION.md states the deposit share').not.toBeNull();
    const share = Number(m?.[1]);
    const b = await openBrowser({ width: 1280, height: 800 });
    try {
      await b.goto(`${baseUrl}/how?still`, 400);
      const steps = await b.evaluate<Array<{ id: string; title: string; filled: number; total: number }>>(`
        Array.from(document.querySelectorAll('[data-diagram] .dg-node')).filter(function (n) { return n.querySelector('.dg-coins'); }).map(function (n) {
          var coins = Array.from(n.querySelectorAll('.dg-coin'));
          return { id: n.getAttribute('data-id'), title: n.querySelector('h3').textContent, total: coins.length,
            filled: coins.filter(function (c) {
              var d = document.createElement('canvas').getContext('2d'); d.fillStyle = getComputedStyle(c).backgroundColor; d.fillRect(0, 0, 1, 1);
              return d.getImageData(0, 0, 1, 1).data[3] > 128;
            }).length };
        })
      `);
      expect(steps[0]?.id, 'the first coin row is the deposit step').toBe('s2');
      expect(steps[0]?.total).toBe(4);
      expect(steps[0]?.filled, `${share}% of four coins`).toBe((4 * share) / 100);
      expect(steps[0]?.title).toBe(`Agree the job, pay ${share}%`);
      expect(steps.map((s) => `${s.id} ${s.filled}/${s.total}`)).toEqual(['s2 1/4', 's5 4/4']);
    } finally {
      await b.close();
    }
  }, T_MS);
});

describe('(g) on a touch phone and a touch desktop: no sideways scroll, 44 px controls, one column on a phone, labels inside the page', () => {
  it.each([[320, 640], [390, 844], [1280, 800]])('@ %i: after the play, nothing past either edge, every control clears 44 px, the lanes and wires take the right form, every via label inside the page', async (width, height) => {
    if (skipWithoutChrome()) return;
    const b = await openBrowser({ width, height, touch: true });
    try {
      await b.goto(`${baseUrl}/how`, 300);
      await readDown(b);
      const done = await waitFinished(b, 45_000);
      expect(done.map((d) => d.replayShown), 'all three finished').toEqual([true, true, true]);
      await b.evaluate('window.scrollTo(0, 0)');
      await sleep(300);
      const out = await b.evaluate<{
        coarse: boolean; W: number; scrollWidth: number; past: string[];
        controls: Array<{ what: string; w: number; h: number }>;
        vias: Array<{ t: string; left: number; right: number }>;
        stage: number[]; lanes: Array<{ id: string; side: string; left: number; right: number }>;
        wireXs: number[][];
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
          var first = document.querySelector('[data-diagram]'), st = first.querySelector('.dg-stage').getBoundingClientRect();
          var lanes = Array.from(first.querySelectorAll('.dg-step')).map(function (n) {
            var r = n.getBoundingClientRect(); return { id: n.getAttribute('data-id'), side: n.classList.contains('dg-lane-l') ? 'l' : 'r', left: Math.round(r.left), right: Math.round(r.right) };
          });
          var xs = Array.from(first.querySelectorAll('.dg-wires .dg-wire')).map(function (p) {
            var nums = p.getAttribute('d').match(/-?[0-9.]+/g).map(Number), out = [];
            for (var i = 0; i < nums.length; i += 2) out.push(Math.round(nums[i]));
            return out;
          });
          return { coarse: matchMedia('(pointer: coarse)').matches, W: W, scrollWidth: document.documentElement.scrollWidth, past: past,
            controls: ctl, vias: vias, stage: [Math.round(st.left), Math.round(st.right)], lanes: lanes, wireXs: xs };
        })()
      `);
      expect(out.coarse, 'the emulation reports a coarse pointer').toBe(true);
      expect(out.scrollWidth, 'no sideways scroll').toBe(out.W);
      expect(out.past, 'nothing past either edge').toEqual([]);
      expect(out.controls.map((c) => c.what)).toEqual(['Replay', 'Replay', 'Show the exact terms', 'Replay', 'Show the full wording']);
      for (const c of out.controls) {
        expect(c.h, `${c.what} height`).toBeGreaterThanOrEqual(44);
        expect(c.w, `${c.what} width`).toBeGreaterThanOrEqual(44);
      }
      expect(out.vias.map((v) => v.t), 'the one label on a wire is drawn').toEqual(['Pay the rest']);
      for (const v of out.vias) {
        expect(v.left, `${v.t} left edge`).toBeGreaterThanOrEqual(0);
        expect(v.right, `${v.t} right edge`).toBeLessThanOrEqual(out.W);
      }
      expect(out.lanes.map((l) => l.side).join(''), 'you, agent, agent, you, agent, you').toBe('lrrlrl');
      expect(out.wireXs.length, 'five wires join the six steps').toBe(5);
      if (width < 900) {
        for (const l of out.lanes) expect([l.left, l.right], `${l.id} spans the one column`).toEqual(out.stage);
        const rail = out.wireXs[0]![0]!;
        for (const xs of out.wireXs) expect(new Set(xs), 'every wire runs straight down the one rail').toEqual(new Set([rail]));
      } else {
        for (const l of out.lanes) {
          if (l.side === 'l') expect(l.left, `${l.id} sits in the left lane`).toBe(out.stage[0]);
          else expect(l.right, `${l.id} sits in the right lane`).toBe(out.stage[1]);
        }
        const left = out.lanes.find((l) => l.side === 'l')!;
        const right = out.lanes.find((l) => l.side === 'r')!;
        expect(left.right, 'the lanes are two columns apart').toBeLessThan(right.left);
        // A zig leaves the middle of one step and lands on the middle of
        // the next, whichever lane each sits in (s2 to s3 stays in the
        // agent's lane; the other four cross). A wire's points are in the
        // stage's own coordinates. Within 1 px of rounding.
        const mid = (l: { left: number; right: number }) => (l.left + l.right) / 2 - out.stage[0]!;
        out.wireXs.forEach((xs, i) => {
          const from = out.lanes[i]!;
          const to = out.lanes[i + 1]!;
          const ends = [xs[0]!, xs[xs.length - 1]!];
          expect(Math.abs(ends[0]! - mid(from)) <= 1 && Math.abs(ends[1]! - mid(to)) <= 1,
            `wire ${i + 1} runs from ${from.id}'s middle (${mid(from)}) to ${to.id}'s (${mid(to)}), got ${ends.join(' to ')}`).toBe(true);
        });
      }
    } finally {
      await b.close();
    }
  }, 120_000);
});

describe('(h) #evidence and #limits land on their diagram\u2019s heading', () => {
  it.each([
    ['evidence', 'Three kinds of proof, never mixed'],
    ['limits', 'What we deliberately do not do'],
  ])('/how#%s lands with "%s" on screen, below the sticky nav', async (id, heading) => {
    if (skipWithoutChrome()) return;
    const b = await openBrowser({ width: 390, height: 844 });
    try {
      await b.goto(`${baseUrl}/how#${id}`, 800);
      const at = await b.evaluate<{ isDiagram: boolean; title: string; top: number; bottom: number; nav: number; vh: number; scrolled: number }>(`
        (function () {
          var t = document.getElementById(${JSON.stringify(id)}), h = t ? t.querySelector('.dg-title') : null;
          var r = h ? h.getBoundingClientRect() : { top: -1, bottom: -1 };
          return { isDiagram: !!t && t.hasAttribute('data-diagram'), title: h ? h.textContent : '', top: r.top, bottom: r.bottom,
            nav: document.querySelector('nav.nav').getBoundingClientRect().bottom, vh: innerHeight, scrolled: scrollY };
        })()
      `);
      expect(at.isDiagram, `#${id} is the diagram`).toBe(true);
      expect(at.title).toBe(heading);
      expect(at.scrolled, 'the page scrolled to it').toBeGreaterThan(0);
      expect(at.top, 'the heading clears the sticky nav').toBeGreaterThanOrEqual(at.nav);
      expect(at.bottom, 'and sits in the top half of the screen').toBeLessThan(at.vh / 2);
    } finally {
      await b.close();
    }
  }, T_MS);
});
