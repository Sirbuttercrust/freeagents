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
import { describe, expect, it, vi } from 'vitest';
import { RealBrowser, WARMUP_PORT_WAIT_MS, hasRealBrowser, warmUpChrome } from './real-browser.js';

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

// CI4 round 3: warmUpChrome launches one throwaway Chrome before any test
// worker exists, so the cold start that the runner logs show in the opening
// seconds of a job lands outside every per-test timeout (the mechanism and
// the evidence are in real-browser.ts, above warmUpChrome). These tests pin
// its contract: it reports whether a Chrome actually ran, it gives up
// loudly rather than silently, and it has its own port budget rather than
// the per-test one. A do-nothing warmUpChrome fails the "returns true" and
// "logs a give-up" tests; the budget test fails if warmUpChrome stops
// passing WARMUP_PORT_WAIT_MS to launch. The no-Chrome test pins only the
// early return and passes for a do-nothing function too.
describe('warmUpChrome: runs one real Chrome before the tests, and says so when it cannot', () => {
  it('returns false, launching nothing, when no Chrome binary can be found', async () => {
    const previousChromeBin = process.env.CHROME_BIN;
    process.env.CHROME_BIN = join(tmpdir(), 'fa-warmup-missing-chrome-binary-that-does-not-exist');
    try {
      await expect(warmUpChrome(() => {})).resolves.toBe(false);
    } finally {
      if (previousChromeBin === undefined) delete process.env.CHROME_BIN;
      else process.env.CHROME_BIN = previousChromeBin;
    }
  });

  it('returns true when a real Chrome is available, because it launched and closed one', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const logged: string[] = [];
    await expect(warmUpChrome((m) => logged.push(m))).resolves.toBe(true);
    expect(logged, 'a warm-up that succeeded logs nothing').toEqual([]);
  }, 90_000);

  it('logs a give-up instead of swallowing it, when Chrome never opens its port', async () => {
    const stubDir = mkdtempSync(join(tmpdir(), 'fa-stub-chrome-'));
    const stubPath = join(stubDir, 'stub-chrome.sh');
    // Exits at once, so the launch fails fast without waiting out the
    // warm-up's own 60s budget.
    writeFileSync(stubPath, '#!/bin/sh\nexit 3\n');
    chmodSync(stubPath, 0o755);
    const previousChromeBin = process.env.CHROME_BIN;
    process.env.CHROME_BIN = stubPath;
    const logged: string[] = [];
    try {
      await expect(warmUpChrome((m) => logged.push(m))).resolves.toBe(false);
      expect(logged.length, 'exactly one warm-up give-up line').toBe(1);
      expect(logged[0]).toContain('Chrome warm-up gave up');
    } finally {
      if (previousChromeBin === undefined) delete process.env.CHROME_BIN;
      else process.env.CHROME_BIN = previousChromeBin;
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it('waits longer for a cold Chrome than a test launch does, because it runs outside any test timeout', async () => {
    expect(WARMUP_PORT_WAIT_MS).toBeGreaterThan(30_000);
    // A stub path that exists, so findChromeBinary passes and warmUpChrome
    // reaches launch; the spy then records the budget it was handed.
    const stubDir = mkdtempSync(join(tmpdir(), 'fa-stub-chrome-'));
    const stubPath = join(stubDir, 'stub-chrome.sh');
    writeFileSync(stubPath, '#!/bin/sh\nexit 3\n');
    chmodSync(stubPath, 0o755);
    const previousChromeBin = process.env.CHROME_BIN;
    process.env.CHROME_BIN = stubPath;
    const launch = vi.spyOn(RealBrowser, 'launch').mockRejectedValue(new Error('stubbed launch'));
    try {
      await expect(warmUpChrome(() => {})).resolves.toBe(false);
      expect(launch).toHaveBeenCalledTimes(1);
      expect(launch.mock.calls[0]?.[0]?.portWaitMs, 'warm-up must use its own budget, not the per-test one').toBe(
        WARMUP_PORT_WAIT_MS,
      );
    } finally {
      launch.mockRestore();
      if (previousChromeBin === undefined) delete process.env.CHROME_BIN;
      else process.env.CHROME_BIN = previousChromeBin;
      rmSync(stubDir, { recursive: true, force: true });
    }
  });
});

// CI4 round 3: rounds 1 and 2's retry (withLaunchRetry) assumed a give-up
// was an unlucky single loss. Review round 2's own data contradicts that:
// run 35935765272 shows the SAME test's two consecutive attempts both
// giving up at the deadline (12046ms and 12047ms long, 12.2s apart),
// meaning whatever starved attempt 1 was still starving attempt 2. A retry only helps
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
