// CI1: the real-browser layout tests must measure the same thing on every
// platform. headless Chrome on the GitHub Actions Linux runner draws
// classic (space-consuming) scrollbars; the Mac dev machines it was written
// on draw overlay scrollbars that consume no layout width. A page at 320px
// with a vertical scrollbar therefore reported a 305px clientWidth on CI
// and a 320px clientWidth locally, and every "no horizontal overflow"
// assertion at phone widths broke on the mismatch (tests/web/myagents.test.ts
// "at 320px there is no horizontal overflow", CI1 brief).
//
// Real phones use overlay scrollbars (the content never shrinks to make
// room for one), so forcing the overlay behaviour at phone widths is
// correct, not a workaround: it makes the measurement match what a phone
// user actually sees, on every platform the suite runs on.
import { describe, expect, it } from 'vitest';
import { RealBrowser, hasRealBrowser } from './real-browser.js';

// A page whose body is taller than the viewport on every launch below, so a
// platform that draws a space-consuming scrollbar has one to draw. Without
// this, the assertions pass vacuously: no scrollbar means nothing to hide.
const TALL_PAGE = 'data:text/html,<!doctype html><html><body style="margin:0;height:2000px"></body></html>';

describe('RealBrowser: phone-width launches read the same clientWidth on every platform', () => {
  it('at a phone width (320px), a vertically-overflowing page still reports clientWidth equal to the launched width', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 320, height: 400 });
    try {
      await browser.goto(TALL_PAGE);
      const metrics = await browser.evaluate<{ clientWidth: number; innerWidth: number }>(`
        ({ clientWidth: document.documentElement.clientWidth, innerWidth: window.innerWidth })
      `);
      expect(metrics.clientWidth, 'a phone-width launch must not let a scrollbar shrink the measured width').toBe(320);
      expect(metrics.innerWidth).toBe(320);
    } finally {
      await browser.close();
    }
  }, 20_000);

  it('setViewport to a phone width mid-session applies the same overlay behaviour as launch', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 1280, height: 900 });
    try {
      await browser.setViewport(320, 400);
      await browser.goto(TALL_PAGE);
      const metrics = await browser.evaluate<{ clientWidth: number }>(`
        ({ clientWidth: document.documentElement.clientWidth })
      `);
      expect(metrics.clientWidth, 'setViewport to a phone width must also apply the overlay behaviour').toBe(320);
    } finally {
      await browser.close();
    }
  }, 20_000);
});
