// The landing flock, drawn as bots (AV2). flight.js keeps its choreography; this pins
// what bot-flight.js and cast.js put on the page, in real Chrome, because a
// canvas's pixels are exactly what jsdom cannot see.
//
//   five agents, each a canvas with real pixels, in the two agent layers
//   each agent wears the spec cast.js names, so no two look alike
//   the nav mark is the lead bot, drawn still
//   no script error, in either motion mode
//   under reduced motion every agent is still drawn: the static end is the
//   flock parked at its perches, not an empty page
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAccountRepository, MemoryAgentRepository } from '../../src/adapters/storage/memory.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

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

type Agent = { layer: string; w: number; h: number; painted: number; hue: number | null };
type Report = {
  errors: string[];
  agents: Agent[];
  mark: { canvases: number; painted: number };
  swarmLeft: number;
  overflow: number;
};

const PROBE = `
  (function () {
    function painted(c) {
      if (!c || !c.width) return 0;
      var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, n = 0;
      for (var i = 3; i < d.length; i += 4) if (d[i] > 200) n += 1;
      return n;
    }
    function hue(c) {
      var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, bins = {};
      for (var i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 250) continue;
        var r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), df = mx - mn;
        if (df < 40) continue;
        var h = mx === r ? ((g - b) / df) % 6 : mx === g ? (b - r) / df + 2 : (r - g) / df + 4;
        var k = Math.round((((h * 60) + 360) % 360) / 20);
        bins[k] = (bins[k] || 0) + 1;
      }
      var best = null, n = 0;
      Object.keys(bins).forEach(function (k) { if (bins[k] > n) { n = bins[k]; best = +k * 20; } });
      return best;
    }
    var agents = [].map.call(document.querySelectorAll('.agent-layer > div[aria-hidden] > canvas'), function (c) {
      var r = c.getBoundingClientRect();
      return { layer: c.closest('.agent-layer').id, w: Math.round(r.width), h: Math.round(r.height), painted: painted(c), hue: hue(c) };
    });
    var mark = document.getElementById('navmark');
    var mc = mark ? mark.querySelector('canvas') : null;
    return {
      errors: window.__errs || [],
      agents: agents,
      mark: { canvases: mark ? mark.querySelectorAll('canvas').length : 0, painted: painted(mc) },
      swarmLeft: document.querySelectorAll('.agent-layer svg[viewBox], #navmark svg').length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  })()
`;

async function landing(width: number, motion: 'reduce' | 'no-preference'): Promise<Report> {
  const browser = await RealBrowser.launch({ width, height: 900 });
  try {
    await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion }] });
    // Collect page errors from the first script on.
    await browser.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__errs = []; addEventListener('error', function (e) { window.__errs.push(String(e.message)); });`,
    });
    await browser.goto(`${baseUrl}/`, 1500);
    return await browser.evaluate<Report>(PROBE);
  } finally {
    await browser.close();
  }
}

describe('the landing flock is drawn as bots', { timeout: 60000 }, () => {
  for (const [width, motion] of [[1280, 'no-preference'], [320, 'reduce']] as const) {
    it(`${width}px, ${motion}: five bots with real pixels, distinct colours, a drawn nav mark, no error`, async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found; skipping (see CHROME_BIN)');
        return;
      }
      const r = await landing(width, motion);
      expect(r.errors, 'the landing page threw').toEqual([]);
      expect(r.swarmLeft, 'an svg creature from the retired swarm is still on the page').toBe(0);
      expect(r.agents.length, 'the cast is five agents').toBe(5);
      for (const [i, a] of r.agents.entries()) {
        expect(['layer-back', 'layer-front'], `agent ${i} outside the agent layers`).toContain(a.layer);
        expect(a.painted, `agent ${i} is an empty canvas`).toBeGreaterThan(200);
      }
      // Five specs, five colours: the flock must not read as one bot five
      // times. Hue bins are 20 degrees wide, so this is a real difference.
      const hues = r.agents.map((a) => a.hue);
      expect(hues.every((h) => h !== null), `a bot drew no saturated pixel: ${JSON.stringify(hues)}`).toBe(true);
      expect(new Set(hues).size, `hues ${JSON.stringify(hues)}`).toBeGreaterThanOrEqual(4);
      expect(r.mark.canvases, 'the nav mark is not one canvas').toBe(1);
      expect(r.mark.painted, 'the nav mark is blank').toBeGreaterThan(20);
      expect(r.overflow, 'the landing page scrolls sideways').toBe(0);
    });
  }

  // Review round 1: bot-flight.js read the setting once at load, so a switch while
  // the page was open left all five bots flying. Here the switch happens
  // after load, with no reload. The frame counter wraps requestAnimationFrame
  // from the first script, so it sees the smooth-scroll loop the flock rides.
  it('switching to reduced motion while the landing page is open parks the flock, and switching back frees it', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found; skipping (see CHROME_BIN)');
      return;
    }
    const b = await RealBrowser.launch({ width: 1280, height: 900 });
    const SUMS = `[].map.call(document.querySelectorAll('.agent-layer > div[aria-hidden]'), function (h) {
      var c = h.querySelector('canvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, s = 0;
      for (var i = 0; i < d.length; i += 7) s = (s * 31 + d[i]) >>> 0;
      return s + ':' + h.style.transform;
    })`;
    try {
      await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
      await b.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `window.__errs = []; addEventListener('error', function (e) { window.__errs.push(String(e.message)); });
          window.__frames = 0;
          (function (raf) {
            window.requestAnimationFrame = function (cb) {
              return raf.call(window, function (t) { window.__frames += 1; cb(t); });
            };
          })(window.requestAnimationFrame);`,
      });
      await b.goto(`${baseUrl}/`, 1500);

      const m0 = await b.evaluate<string[]>(SUMS);
      await new Promise((r) => setTimeout(r, 800));
      const m1 = await b.evaluate<string[]>(SUMS);
      expect(m0.length, 'the cast is five agents').toBe(5);
      expect(m1, 'the flock was not moving before the switch, so this proves nothing').not.toEqual(m0);

      await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await new Promise((r) => setTimeout(r, 300));
      const a = await b.evaluate<string[]>(SUMS);
      const fa = await b.evaluate<number>('window.__frames');
      await new Promise((r) => setTimeout(r, 2000));
      const z = await b.evaluate<string[]>(SUMS);
      const fz = await b.evaluate<number>('window.__frames');
      expect(z, 'a flock bot kept moving or repainting after the switch').toEqual(a);
      expect(fz - fa, 'the landing page still asks for animation frames after the switch').toBe(0);
      const dust = await b.evaluate<number>(
        `[].filter.call(document.querySelectorAll('.agent-layer .dust circle'), function (c) { return c.getAttribute('opacity') !== '0'; }).length`,
      );
      expect(dust, 'dust left hanging in the air after the switch').toBe(0);

      await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
      await new Promise((r) => setTimeout(r, 300));
      const back0 = await b.evaluate<string[]>(SUMS);
      await new Promise((r) => setTimeout(r, 800));
      const back1 = await b.evaluate<string[]>(SUMS);
      expect(back1, 'the flock never came back to life after motion was allowed again').not.toEqual(back0);
      expect(await b.evaluate<string[]>('window.__errs'), 'the landing page threw').toEqual([]);
    } finally {
      await b.close();
    }
  });

  // AV2b. Reported 2026-09-23: the lead bot is amber but threw violet
  // sparkles, because cast.js gave it the page accent as its glow and
  // flight.js paints a glowing bot's sparkles in its glow. This pokes each bot
  // and reads the sparkles back as SCREEN PIXELS, not as fill attributes:
  // a screenshot of the bot's neighbourhood before the poke and one just
  // after, with every bot (and its halo) hidden in both, so the only pixels
  // that change are the sparkles. The hue of those pixels must be the bot's
  // own hue, read from the bot's own canvas.
  it('a poked bot throws sparkles in its own colour, measured from screen pixels', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found; skipping (see CHROME_BIN)');
      return;
    }
    const r = await sparkles('no-preference');
    console.log(`sparkle sample: ${JSON.stringify(r.bots)}`);
    console.log(`glows: ${JSON.stringify(r.glows)}`);
    expect(r.errors, 'the landing page threw').toEqual([]);
    // The one glowing bot is the lead, and its halo is its own amber
    // (#E0A24E is rgb(224, 162, 78)), not the page accent (#7C7CFF).
    expect(r.glows.length, 'the lead has no halo').toBe(1);
    expect(r.glows[0], 'the halo is not the lead colour').toContain('rgba(224, 162, 78');
    expect(r.glows[0], 'the halo is still the page accent').not.toContain('124, 124, 255');
    expect(r.bots.length, 'the cast is five agents').toBe(5);
    expect(new Set(r.bots.map((x) => x.name)).size, 'each cast colour is found once').toBe(5);
    for (const bot of r.bots) {
      expect(bot.botHue, `${bot.name} drew no saturated pixel`).not.toBeNull();
      expect(bot.changed, `${bot.name}: no sparkle pixel reached the screen`).toBeGreaterThan(20);
      expect(bot.sparkleHue, `${bot.name}: sparkle pixels carry no hue`).not.toBeNull();
      expect(
        hueGap(bot.sparkleHue!, bot.botHue!),
        `${bot.name}: sparkles at ${bot.sparkleHue}deg, bot at ${bot.botHue}deg (${bot.sparkleRgb})`,
      ).toBeLessThanOrEqual(25);
    }
  });

  it('under reduced motion a poke throws no sparkles at all', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found; skipping (see CHROME_BIN)');
      return;
    }
    const r = await sparkles('reduce');
    expect(r.errors, 'the landing page threw').toEqual([]);
    expect(r.bots.length, 'the cast is five agents').toBe(5);
    for (const bot of r.bots) {
      expect(bot.visibleDust, `${bot.name}: a sparkle node is visible`).toBe(0);
      expect(bot.changed, `${bot.name}: pixels changed after a poke under reduced motion`).toBe(0);
    }
  });
});

type SparkleBot = {
  name: string;
  botHue: number | null;
  sparkleHue: number | null;
  sparkleRgb: string;
  changed: number;
  visibleDust: number;
};

function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// In-page helpers. The screenshot comes back from CDP as a PNG and is decoded
// by the page itself (an Image drawn to a canvas), so no PNG decoder is needed
// on the Node side.
const SPARKLE_LIB = `
  window.__sp = {
    hosts: function () { return [].slice.call(document.querySelectorAll('.agent-layer > div[aria-hidden]')); },
    hide: function (on) {
      this.hosts().forEach(function (h) { h.style.visibility = on ? 'hidden' : ''; });
      var v = document.getElementById('herovid');
      if (v) { v.pause(); }
    },
    centre: function (i) {
      var r = this.hosts()[i].getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
    },
    hueOfCanvas: function (i) {
      var c = this.hosts()[i].querySelector('canvas');
      var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, sx = 0, sy = 0, n = 0;
      for (var k = 0; k < d.length; k += 4) {
        if (d[k + 3] < 250) continue;
        var h = this.hue(d[k], d[k + 1], d[k + 2], 40);
        if (h === null) continue;
        sx += Math.cos(h * Math.PI / 180); sy += Math.sin(h * Math.PI / 180); n += 1;
      }
      return n ? Math.round(((Math.atan2(sy, sx) * 180 / Math.PI) + 360) % 360) : null;
    },
    hue: function (r, g, b, minDf) {
      var mx = Math.max(r, g, b), mn = Math.min(r, g, b), df = mx - mn;
      if (df < minDf) return null;
      var h = mx === r ? ((g - b) / df) % 6 : mx === g ? (b - r) / df + 2 : (r - g) / df + 4;
      return ((h * 60) + 360) % 360;
    },
    load: function (b64) {
      return new Promise(function (res) {
        var img = new Image();
        img.onload = function () {
          var c = document.createElement('canvas');
          c.width = img.width; c.height = img.height;
          var x = c.getContext('2d');
          x.drawImage(img, 0, 0);
          res(x.getImageData(0, 0, c.width, c.height).data);
        };
        img.src = 'data:image/png;base64,' + b64;
      });
    },
    diff: function (a64, b64) {
      var self = this;
      return Promise.all([this.load(a64), this.load(b64)]).then(function (p) {
        var A = p[0], B = p[1], n = 0, sx = 0, sy = 0, hn = 0, rr = 0, gg = 0, bb = 0;
        for (var k = 0; k < A.length; k += 4) {
          var d = Math.abs(A[k] - B[k]) + Math.abs(A[k + 1] - B[k + 1]) + Math.abs(A[k + 2] - B[k + 2]);
          if (d < 45) continue;
          n += 1; rr += B[k]; gg += B[k + 1]; bb += B[k + 2];
          var h = self.hue(B[k], B[k + 1], B[k + 2], 10);
          if (h === null) continue;
          sx += Math.cos(h * Math.PI / 180); sy += Math.sin(h * Math.PI / 180); hn += 1;
        }
        return {
          changed: n,
          sparkleHue: hn ? Math.round(((Math.atan2(sy, sx) * 180 / Math.PI) + 360) % 360) : null,
          sparkleRgb: n ? 'rgb(' + Math.round(rr / n) + ',' + Math.round(gg / n) + ',' + Math.round(bb / n) + ')' : ''
        };
      });
    },
    poke: function (x, y) {
      document.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true, cancelable: true }));
    },
    visibleDust: function () {
      return [].filter.call(document.querySelectorAll('.agent-layer .dust circle'), function (c) { return c.getAttribute('opacity') !== '0'; }).length;
    },
    glows: function () {
      return this.hosts().map(function (h) {
        var g = h.firstElementChild;
        return g && g.tagName === 'DIV' ? g.style.background : null;
      }).filter(function (b) { return b; });
    }
  };
`;

// The cast's own colours (cast.js spec -> bots.js COLOURS). The agent layers
// hold back-layer bots first, so DOM order is not cast order: each bot is
// named by the cast colour nearest its measured hue instead.
const CAST_COLOURS: Record<string, string> = {
  lead: '#E0A24E',
  scout: '#9BE85A',
  drift: '#1CC4DA',
  anchorite: '#B06BFF',
  tag: '#F25CD4',
};

function hexHue(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), df = mx - mn;
  const h = mx === r ? ((g - b) / df) % 6 : mx === g ? (b - r) / df + 2 : (r - g) / df + 4;
  return (h * 60 + 360) % 360;
}

function castName(hue: number | null): string {
  if (hue === null) return '?';
  let best = '?', gap = Infinity;
  for (const [name, hex] of Object.entries(CAST_COLOURS)) {
    const d = hueGap(hue, hexHue(hex));
    if (d < gap) { gap = d; best = name; }
  }
  return best;
}

async function sparkles(
  motion: 'reduce' | 'no-preference',
): Promise<{ errors: string[]; glows: string[]; bots: SparkleBot[] }> {
  const b = await RealBrowser.launch({ width: 1280, height: 900 });
  try {
    await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion }] });
    await b.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__errs = []; addEventListener('error', function (e) { window.__errs.push(String(e.message)); });`,
    });
    await b.goto(`${baseUrl}/`, 1500);
    await b.evaluate(SPARKLE_LIB);
    const bots: SparkleBot[] = [];
    const count = await b.evaluate<number>('__sp.hosts().length');
    for (let i = 0; i < count; i++) {
      const botHue = await b.evaluate<number | null>(`__sp.hueOfCanvas(${i})`);
      const name = castName(botHue);
      // Let any sparkle from the previous poke die out (the longest lives 0.85s).
      await new Promise((r) => setTimeout(r, 1100));
      await b.evaluate('__sp.hide(true)');
      await new Promise((r) => setTimeout(r, 120));
      const c = await b.evaluate<{ x: number; y: number; w: number }>(`__sp.centre(${i})`);
      const half = 150;
      const clip = { x: Math.max(0, c.x - half), y: Math.max(0, c.y - half), width: half * 2, height: half * 2, scale: 1 };
      const shot = async (): Promise<string> =>
        ((await b.send('Page.captureScreenshot', { format: 'png', clip })).result as { data: string }).data;
      const before = await shot();
      await b.evaluate(`__sp.poke(${c.x}, ${c.y})`);
      await new Promise((r) => setTimeout(r, 140));
      const after = await shot();
      const visibleDust = await b.evaluate<number>('__sp.visibleDust()');
      const d = await b.evaluate<{ changed: number; sparkleHue: number | null; sparkleRgb: string }>(
        `__sp.diff(${JSON.stringify(before)}, ${JSON.stringify(after)})`,
      );
      await b.evaluate('__sp.hide(false)');
      bots.push({ name, botHue, visibleDust, ...d });
    }
    return { errors: await b.evaluate<string[]>('window.__errs'), glows: await b.evaluate<string[]>('__sp.glows()'), bots };
  } finally {
    await b.close();
  }
}
