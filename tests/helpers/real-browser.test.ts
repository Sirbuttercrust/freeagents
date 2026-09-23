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
import { RealBrowser, hasRealBrowser, LaunchGate, withLaunchRetry } from './real-browser.js';

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

// CI4: the "chrome debug port never came up" failure on run 35921744859
// showed three real-Chrome tests all timing out inside the same ~30s
// window of the same job. Two structural changes address that shape of
// failure: a concurrency gate so only a bounded number of Chrome
// processes spawn at once (spawning is the expensive, contended step
// measured on the runner), and a retry around a launch that does give up,
// since a launch failing once under contention is not evidence the whole
// test should fail. Both are plain, dependency-free logic, tested here
// without spawning real Chrome so the suite proves their behaviour in
// milliseconds.
describe('LaunchGate: bounds how many launches run at once', () => {
  it('lets launches under the limit run immediately', async () => {
    const gate = new LaunchGate(2);
    const order: string[] = [];
    const release1 = await gate.acquire();
    order.push('acquired-1');
    const release2 = await gate.acquire();
    order.push('acquired-2');
    expect(order).toEqual(['acquired-1', 'acquired-2']);
    release1();
    release2();
  });

  it('holds a launch past the limit until an earlier one releases', async () => {
    const gate = new LaunchGate(1);
    const order: string[] = [];
    const release1 = await gate.acquire();
    order.push('acquired-1');
    let acquired2 = false;
    const second = gate.acquire().then((release2) => {
      acquired2 = true;
      order.push('acquired-2');
      release2();
    });
    // The second acquire must still be waiting: nothing has released yet.
    await new Promise((r) => setTimeout(r, 10));
    expect(acquired2).toBe(false);
    release1();
    await second;
    expect(order).toEqual(['acquired-1', 'acquired-2']);
  });
});

describe('withLaunchRetry: retries a launch that gives up once', () => {
  it('returns the first successful result without retrying', async () => {
    let calls = 0;
    const result = await withLaunchRetry(async () => {
      calls += 1;
      return 'browser-1';
    }, 2);
    expect(result).toBe('browser-1');
    expect(calls).toBe(1);
  });

  it('retries once when the first attempt throws "chrome debug port never came up"', async () => {
    let calls = 0;
    const result = await withLaunchRetry(async () => {
      calls += 1;
      if (calls === 1) throw new Error('chrome debug port never came up');
      return 'browser-2';
    }, 2);
    expect(result).toBe('browser-2');
    expect(calls).toBe(2);
  });

  it('does not retry a failure unrelated to the port wait', async () => {
    let calls = 0;
    await expect(
      withLaunchRetry(async () => {
        calls += 1;
        throw new Error('no Chrome found for real-browser layout tests');
      }, 2),
    ).rejects.toThrow('no Chrome found');
    expect(calls).toBe(1);
  });

  it('gives up after exhausting the retry budget', async () => {
    let calls = 0;
    await expect(
      withLaunchRetry(async () => {
        calls += 1;
        throw new Error('chrome debug port never came up');
      }, 2),
    ).rejects.toThrow('chrome debug port never came up');
    expect(calls).toBe(2);
  });
});
