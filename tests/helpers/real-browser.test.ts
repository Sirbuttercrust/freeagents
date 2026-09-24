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
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RealBrowser, hasRealBrowser, warmUpChrome } from './real-browser.js';

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

// CI4 round 3: rounds 1 and 2 both tried to bound CONCURRENCY (a launch
// gate, first spawn-only then lifetime-holding). Proof round 2 measured
// that gate directly (run 35938128610, the lifetime-holding push) and
// found it never once made a launch wait: gate-wait maxed at 3-6ms across
// 157 acquires per job. Proof's own log parse also showed every slow open
// and every real give-up landing in the first handful of log lines of a
// job, at chrome-procs-after of 1 to 4, not the 11-18 the "sustained
// contention" theory needed. That is the signature of a one-time cost,
// not a concurrency problem: the OS has never read Chrome's ~200MB binary
// and shared libraries off disk before, so the first real launch in a job
// pays for populating the page cache, and every later launch in that same
// job reads the now-cached pages and opens its port in a few hundred
// milliseconds, matching the review's own log timeline (8925-18961ms for
// a job's first launch, 300-900ms for every launch after).
//
// warmUpChrome pays that one-time cost itself, once, before any test file
// is even collected (see vitest.config.ts's globalSetup, which the vitest
// docs guarantee runs before workers are created). By the time the first
// real test file launches its own Chrome, the pages are already resident
// and that launch is cheap too. It errors nothing when Chrome cannot be
// found, the same fact hasRealBrowser() already lets every real-Chrome
// test skip instead of fail.
describe('warmUpChrome: absorbs the first-launch page-cache cost once, outside any test timeout', () => {
  it('resolves without throwing when no Chrome binary can be found', async () => {
    const previousChromeBin = process.env.CHROME_BIN;
    process.env.CHROME_BIN = join(tmpdir(), 'fa-warmup-missing-chrome-binary-that-does-not-exist');
    try {
      await expect(warmUpChrome()).resolves.toBeUndefined();
    } finally {
      if (previousChromeBin === undefined) delete process.env.CHROME_BIN;
      else process.env.CHROME_BIN = previousChromeBin;
    }
  });

  it('launches and closes a real Chrome when one is available, leaving no process behind', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    await expect(warmUpChrome()).resolves.toBeUndefined();
    // A real launch straight after warm-up must be fast: this is the
    // actual behaviour warmUpChrome exists to produce, not an
    // implementation detail of how it gets there.
    const started = Date.now();
    const browser = await RealBrowser.launch({ width: 1280, height: 900 });
    try {
      const elapsed = Date.now() - started;
      expect(elapsed, 'a launch right after warm-up should not pay a fresh page-cache-miss cost').toBeLessThan(5_000);
    } finally {
      await browser.close();
    }
  }, 30_000);
});

// CI4 round 3: rounds 1 and 2's retry (withLaunchRetry) assumed a give-up
// was an unlucky single loss. Proof round 2's own data contradicts that:
// run 35935765272 shows the SAME test's two consecutive attempts both
// giving up at the deadline, 1ms apart in wall time, meaning whatever
// starved attempt 1 was still starving attempt 2. A retry only helps
// against a transient loss; the round 1/2 failure was not transient, so
// there is no retry left to test here. What matters instead is that a
// single attempt, launched after warm-up, finishes well inside the
// timeout every real caller sets, and that a launch which genuinely never
// opens its port still gives up inside that same budget rather than
// hanging past it.
describe('RealBrowser.launch: a launch that never opens its port gives up within a 30s test timeout', () => {
  it('rejects with the give-up message well inside 30s', async () => {
    const stubDir = mkdtempSync(join(tmpdir(), 'fa-stub-chrome-'));
    const stubPath = join(stubDir, 'stub-chrome.sh');
    writeFileSync(stubPath, '#!/bin/sh\nsleep 200\n');
    chmodSync(stubPath, 0o755);
    const previousChromeBin = process.env.CHROME_BIN;
    process.env.CHROME_BIN = stubPath;
    const started = Date.now();
    try {
      await expect(RealBrowser.launch({ width: 1280, height: 900 })).rejects.toThrow('chrome debug port never came up');
      const elapsed = Date.now() - started;
      expect(elapsed, 'the give-up itself must land well inside the 30s timeout every real caller sets').toBeLessThan(28_000);
    } finally {
      if (previousChromeBin === undefined) delete process.env.CHROME_BIN;
      else process.env.CHROME_BIN = previousChromeBin;
      rmSync(stubDir, { recursive: true, force: true });
    }
  }, 30_000);
});
