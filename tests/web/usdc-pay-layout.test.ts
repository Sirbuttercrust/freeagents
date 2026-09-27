// USDC-WEBb Make 7: every open state of the USDC pay sheet, measured in a
// real Chrome at 320, 390 and 1280. jsdom has no layout, so this is the
// one place the picker, a running payment and each outcome are checked
// for sideways overflow, a target under 44px, and anything drawn over a
// control or the sentence. The engine is stubbed IN THE BROWSER for this
// file only: its states are driven here to be measured, and what each
// state does is proven against the real routes in usdc-pay-pages.test.ts.
// Set USDC_CAPTURE_DIR to also save a screenshot of every state.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';
import { buildPageHarness, UNPAID_AGENT_DID, type PageHarness } from '../helpers/usdc-page-fixtures.js';

const captureDir = process.env.USDC_CAPTURE_DIR ?? '';

const RECENT = new Date(Date.now() - 60 * 60 * 1000);
const ICON = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" rx="6" fill="gray"/></svg>').toString('base64');

// The engine in the page: window.__usdcNext names the state the next call
// lands in. "pick" answers two wallets; "run" never settles (a payment in
// flight); anything else settles with the longest real sentence for it.
const STUB = `
  (function () {
    var SENTENCES = {
      paid: 'This payment is confirmed.',
      already_paid: 'the deposit leg has already been paid; reload this page to see the confirmed payment',
      price_due: 'The fee transfer landed, but the price transfer did not. Send the price transfer again.',
      waiting_network: 'The network has not confirmed this payment yet. Check again shortly.',
      no_wallet: 'No wallet was found. Install a wallet extension, or open this page inside your wallet app.',
      mismatched: 'One of the transfers did not pay what this job expects. Do not send anything else yet.'
    };
    var stub = {
      discover: function () {
        var w = { provider: {} };
        return Promise.resolve(window.__usdcNext === 'pick'
          ? [Object.assign({ id: 'a', name: 'A wallet with a rather long name', icon: '${ICON}' }, w), Object.assign({ id: 'b', name: 'Another wallet', icon: '' }, w)]
          : [Object.assign({ id: 'a', name: 'Wallet', icon: '' }, w)]);
      },
      pay: function () {
        if (window.__usdcNext === 'run') return new Promise(function () {});
        return Promise.resolve({ outcome: window.__usdcNext, leg: 'price', message: SENTENCES[window.__usdcNext] });
      },
      check: function () { return stub.pay(); }
    };
    Object.defineProperty(window, 'FAUsdcWallet', { configurable: true, get: function () { return stub; }, set: function () {} });
  })();
`;

// Every visible control in the open sheet, and the sentence: its box, and
// whether the topmost element at its centre is itself (nothing on top).
const MEASURE = `
  (function () {
    var doc = document.documentElement;
    var sheet = document.querySelector('dialog[open]');
    var root = sheet || document.querySelector('main');
    var targets = [].filter.call(root.querySelectorAll('button, a[href], [role=status]'), function (el) {
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    return {
      open: !!sheet,
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      sheetOverflow: sheet ? sheet.scrollWidth - sheet.clientWidth : 0,
      measured: targets.length,
      status: (document.getElementById('usdc-status') || {}).textContent || '',
      small: targets.filter(function (el) {
        if (el.getAttribute('role') === 'status') return false;
        var r = el.getBoundingClientRect();
        return r.width < 44 || r.height < 44;
      }).map(function (el) { var r = el.getBoundingClientRect(); return (el.id || el.textContent.trim()) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); }),
      // Text or an icon running out of its own control, or an icon
      // squeezed below the size it was given.
      clipped: targets.filter(function (el) {
        if (el.scrollWidth > el.clientWidth + 1) return true;
        return [].some.call(el.querySelectorAll('img'), function (img) { return img.getBoundingClientRect().width < 20; });
      }).map(function (el) { return (el.id || el.textContent.trim().slice(0, 30)) + ' ' + el.scrollWidth + '/' + el.clientWidth; }),
      covered: targets.filter(function (el) {
        var r = el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) el.scrollIntoView({ block: 'center' });
        r = el.getBoundingClientRect();
        var top = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 10));
        return !(top && (top === el || el.contains(top)));
      }).map(function (el) { return el.id || el.textContent.trim().slice(0, 30); })
    };
  })()
`;
interface Measure { open: boolean; scrollWidth: number; clientWidth: number; sheetOverflow: number; measured: number; status: string; small: string[]; clipped: string[]; covered: string[] }

// The states, each reached from a fresh load by one Pay press.
const STATES = ['pick', 'run', 'paid', 'already_paid', 'price_due', 'waiting_network', 'no_wallet', 'mismatched'];
const WIDTHS = [320, 390, 1280];

let h: PageHarness;
const pages: Record<string, string> = {};
beforeAll(async () => {
  h = await buildPageHarness();
  await h.addJob({ id: 'layout-deposit', rail: 'usdc' });
  await h.addJob({ id: 'layout-none', agentDid: UNPAID_AGENT_DID });
  await h.addJob({ id: 'layout-staged', status: 'staged', rail: 'usdc', stagedAt: RECENT, stagedCommit: 'commit-layout', confirmedAt: RECENT, confirmedSpecHash: 'sha256:layout' });
  pages.deposit = '/deposit?job=layout-deposit';
  pages.staged = '/staged?job=layout-staged';
});
afterAll(async () => { await h.close(); });

async function open(width: number): Promise<RealBrowser> {
  const browser = await RealBrowser.launch({ width, height: 800 });
  if (width < 760) {
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 740, deviceScaleFactor: 2, mobile: true });
    await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  }
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(h.session))});` + STUB });
  return browser;
}

describe('the USDC pay sheet in every open state, in real Chrome', () => {
  for (const width of WIDTHS) {
    for (const page of ['deposit', 'staged']) {
      it(`${width}px: ${page}`, async () => {
        if (!hasRealBrowser()) { console.warn('no Chrome found; skipping (see CHROME_BIN)'); return; }
        const browser = await open(width);
        try {
          for (const state of STATES) {
            await browser.goto(`${h.baseUrl}${pages[page]}`, 900);
            await browser.evaluate(`window.__usdcNext = ${JSON.stringify(state)}; document.getElementById('pay-btn').click()`);
            await new Promise((r) => setTimeout(r, 450));
            const m = await browser.evaluate<Measure>(MEASURE);
            const where = `${page} ${state} at ${width}`;
            console.log(`${where}: scroll ${m.scrollWidth}/${m.clientWidth}, sheet overflow ${m.sheetOverflow}, ${m.measured} targets, small [${m.small.join(', ')}], clipped [${m.clipped.join(', ')}], covered [${m.covered.join(', ')}]`);
            expect(m.open, `${where}: the sheet did not open`).toBe(true);
            expect(m.measured, `${where}: nothing measured`).toBeGreaterThan(1);
            expect(m.scrollWidth, `${where}: sideways scroll`).toBe(m.clientWidth);
            expect(m.sheetOverflow, `${where}: the sheet scrolls sideways`).toBe(0);
            expect(m.small, `${where}: under 44px`).toEqual([]);
            expect(m.clipped, `${where}: clipped`).toEqual([]);
            expect(m.covered, `${where}: drawn over`).toEqual([]);
            if (captureDir !== '') {
              mkdirSync(captureDir, { recursive: true });
              const shot = (await browser.send('Page.captureScreenshot', { format: 'png' })) as { result?: { data?: string } };
              if (shot.result?.data) writeFileSync(join(captureDir, `${page}-${state}-${width}.png`), Buffer.from(shot.result.data, 'base64'));
            }
          }
        } finally {
          await browser.close();
        }
      }, 90_000);
    }
    it(`${width}px: deposit with no way to pay`, async () => {
      if (!hasRealBrowser()) { console.warn('no Chrome found; skipping (see CHROME_BIN)'); return; }
      const browser = await open(width);
      try {
        await browser.goto(`${h.baseUrl}/deposit?job=layout-none`, 900);
        const m = await browser.evaluate<Measure & { link: number[] }>(`(function () { var m = ${MEASURE}; var r = document.getElementById('no-rails-link').getBoundingClientRect(); m.link = [r.width, r.height]; return m; })()`);
        console.log(`deposit none at ${width}: scroll ${m.scrollWidth}/${m.clientWidth}, link ${m.link.map(Math.round).join('x')}`);
        expect(m.scrollWidth).toBe(m.clientWidth);
        expect(m.link[0]).toBeGreaterThanOrEqual(44);
        expect(m.link[1]).toBeGreaterThanOrEqual(44);
      } finally {
        await browser.close();
      }
    }, 60_000);
  }
});
