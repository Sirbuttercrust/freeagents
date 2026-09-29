// FIX-B70b: the open ABT pay sheet with its rate block filled, measured in a
// real Chrome at 320, 390 and 1280 on /deposit and /staged. jsdom has no
// layout, so this is where the block is checked for sideways overflow,
// clipped text and anything drawn over it, and where the sheet's buttons
// are held to 44px with the block in it. The start answer is the real
// route's (the harness's ABT rail, its rate source set per test); what the
// block says is proven line by line in abt-rate-pages.test.ts.
// Set ABT_RATE_CAPTURE_DIR to also save a screenshot of every open sheet.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';
import { buildPageHarness, type PageHarness } from '../helpers/usdc-page-fixtures.js';

const captureDir = process.env.ABT_RATE_CAPTURE_DIR ?? '';
const RECENT = new Date(Date.now() - 60 * 60 * 1000);

// The sheet as a person meets it: every visible button and link in the
// open dialog, and the rate block's two lines.
const MEASURE = `
  (function () {
    var doc = document.documentElement;
    var sheet = document.querySelector('dialog[open]');
    var block = document.getElementById('abt-rate');
    var link = document.getElementById('abt-rate-source');
    function visible(el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
    function onTop(el) {
      var r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > innerHeight) { el.scrollIntoView({ block: 'center' }); r = el.getBoundingClientRect(); }
      var top = document.elementFromPoint(r.left + Math.min(r.width / 2, 12), r.top + r.height / 2);
      return !!top && (top === el || el.contains(top));
    }
    var controls = sheet ? [].filter.call(sheet.querySelectorAll('button, a[href]'), visible) : [];
    var buttons = controls.filter(function (el) { return el.tagName === 'BUTTON'; });
    var lines = block ? [].slice.call(block.querySelectorAll('p')) : [];
    var sr = sheet ? sheet.getBoundingClientRect() : { left: 0, right: 0 };
    var lr = link ? link.getBoundingClientRect() : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    return {
      open: !!sheet,
      blockShown: !!block && visible(block),
      text: lines.map(function (p) { return p.textContent.trim(); }),
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      sheetOverflow: sheet ? sheet.scrollWidth - sheet.clientWidth : -1,
      measured: controls.length,
      small: buttons.filter(function (el) {
        var r = el.getBoundingClientRect();
        return r.width < 44 || r.height < 44;
      }).map(function (el) { var r = el.getBoundingClientRect(); return (el.id || el.textContent.trim()) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); }),
      clipped: lines.concat(controls).filter(function (el) { return el.scrollWidth > el.clientWidth + 1; })
        .map(function (el) { return (el.id || el.textContent.trim().slice(0, 30)) + ' ' + el.scrollWidth + '/' + el.clientWidth; }),
      covered: lines.concat(controls).filter(function (el) { return !onTop(el); })
        .map(function (el) { return el.id || el.textContent.trim().slice(0, 30); }),
      lineFont: lines.map(function (p) { return parseFloat(getComputedStyle(p).fontSize); }),
      link: {
        inSheet: lr.left >= sr.left && lr.right <= sr.right && lr.width > 0 && lr.height > 0,
        lineBox: lr.height <= 24,
        onTop: link ? onTop(link) : false,
        fontSize: link ? parseFloat(getComputedStyle(link).fontSize) : 0
      }
    };
  })()
`;
interface Measure {
  open: boolean; blockShown: boolean; text: string[]; scrollWidth: number; clientWidth: number; sheetOverflow: number; measured: number;
  small: string[]; clipped: string[]; covered: string[]; lineFont: number[];
  link: { inSheet: boolean; lineBox: boolean; onTop: boolean; fontSize: number };
}

const WIDTHS = [320, 390, 1280];
let h: PageHarness;
const pages: Record<string, string> = {};
beforeAll(async () => {
  h = await buildPageHarness();
  // A long rate and a feed time, so the block is at its widest.
  h.setAbtRate({ usdPerToken: '12345.67890123', updatedAt: new Date(Date.now() - 7 * 60 * 1000) });
  await h.addJob({ id: 'abt-rate-layout-deposit', rail: 'abt' });
  await h.addJob({ id: 'abt-rate-layout-staged', status: 'staged', rail: 'abt', stagedAt: RECENT, stagedCommit: 'commit-abt-rate-layout', confirmedAt: RECENT, confirmedSpecHash: 'sha256:abt-rate-layout' });
  pages.deposit = '/deposit?job=abt-rate-layout-deposit';
  pages.staged = '/staged?job=abt-rate-layout-staged';
});
afterAll(async () => { h.resetAbtRate(); await h.close(); });

async function open(width: number): Promise<RealBrowser> {
  const browser = await RealBrowser.launch({ width, height: 800 });
  if (width < 760) {
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 740, deviceScaleFactor: 2, mobile: true });
    await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  }
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(h.session))});` });
  return browser;
}

describe('the open ABT sheet with its rate block, in real Chrome', () => {
  for (const width of WIDTHS) {
    for (const page of ['deposit', 'staged']) {
      it(`${width}px: ${page}`, async () => {
        if (!hasRealBrowser()) { console.warn('no Chrome found; skipping (see CHROME_BIN)'); return; }
        const browser = await open(width);
        try {
          await browser.goto(`${h.baseUrl}${pages[page]}`, 900);
          await browser.evaluate(`document.getElementById('pay-btn').click()`);
          await new Promise((r) => setTimeout(r, 450));
          const m = await browser.evaluate<Measure>(MEASURE);
          const where = `${page} at ${width}`;
          console.log(`${where}: [${m.text.join(' | ')}] scroll ${m.scrollWidth}/${m.clientWidth}, sheet overflow ${m.sheetOverflow}, ${m.measured} controls, small [${m.small.join(', ')}], clipped [${m.clipped.join(', ')}], covered [${m.covered.join(', ')}], link ${JSON.stringify(m.link)}`);
          expect(m.open, `${where}: the sheet did not open`).toBe(true);
          expect(m.blockShown, `${where}: the rate block is not showing`).toBe(true);
          expect(m.text[0], `${where}: the rate line`).toMatch(/^1 ABT = \$12345\.67890123, held until .+\.$/);
          expect(m.text[1], `${where}: the attribution line`).toMatch(/^Price data by CoinGecko, updated .+\.$/);
          expect(m.measured, `${where}: nothing measured`).toBeGreaterThan(2);
          expect(m.scrollWidth, `${where}: sideways scroll`).toBe(m.clientWidth);
          expect(m.sheetOverflow, `${where}: the sheet scrolls sideways`).toBe(0);
          expect(m.small, `${where}: under 44px`).toEqual([]);
          expect(m.clipped, `${where}: clipped`).toEqual([]);
          expect(m.covered, `${where}: drawn over`).toEqual([]);
          // CoinGecko's API terms: attribution no smaller than size 10.
          for (const size of [...m.lineFont, m.link.fontSize]) expect(size, `${where}: attribution font`).toBeGreaterThanOrEqual(10);
          // An inline link: its line box sits inside the sheet, on top.
          expect(m.link.inSheet, `${where}: the link leaves the sheet`).toBe(true);
          expect(m.link.lineBox, `${where}: the link is padded out of its line`).toBe(true);
          expect(m.link.onTop, `${where}: the link is drawn over`).toBe(true);
          if (captureDir !== '') {
            mkdirSync(captureDir, { recursive: true });
            await browser.evaluate(`document.getElementById('abt-rate').scrollIntoView({ block: 'center' })`);
            const shot = (await browser.send('Page.captureScreenshot', { format: 'png' })) as { result?: { data?: string } };
            if (shot.result?.data) writeFileSync(join(captureDir, `abt-rate-${page}-${width}.png`), Buffer.from(shot.result.data, 'base64'));
          }
        } finally {
          await browser.close();
        }
      }, 60_000);
    }
  }
});
