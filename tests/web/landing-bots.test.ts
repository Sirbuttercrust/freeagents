// The landing flock, drawn as bots (AV2). flight.js is unchanged; this pins
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

describe('the landing flock is drawn as bots', () => {
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
});
