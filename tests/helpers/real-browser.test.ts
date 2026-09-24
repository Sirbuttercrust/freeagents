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
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RealBrowser, hasRealBrowser, CrossProcessLaunchGate, withLaunchRetry } from './real-browser.js';

const realBrowserModulePath = fileURLToPath(new URL('./real-browser.ts', import.meta.url));
const realBrowserModuleUrl = pathToFileURL(realBrowserModulePath).href;

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
// test should fail. This block proves CrossProcessLaunchGate's queueing
// contract in-process, in milliseconds; the CrossProcessLaunchGate
// describe block further down proves the part that actually matters for
// CI4, that the same fence also holds ACROSS separate OS processes.
describe('CrossProcessLaunchGate: bounds how many launches run at once, in a single process', () => {
  it('lets launches under the limit run immediately', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fa-launch-gate-inproc-'));
    try {
      const gate = new CrossProcessLaunchGate(2, dir);
      const order: string[] = [];
      const release1 = await gate.acquire();
      order.push('acquired-1');
      const release2 = await gate.acquire();
      order.push('acquired-2');
      expect(order).toEqual(['acquired-1', 'acquired-2']);
      release1();
      release2();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('holds a launch past the limit until an earlier one releases', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fa-launch-gate-inproc-'));
    try {
      const gate = new CrossProcessLaunchGate(1, dir);
      const order: string[] = [];
      const release1 = await gate.acquire();
      order.push('acquired-1');
      let acquired2 = false;
      const second = gate.acquire().then((release2: () => void) => {
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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

// CI4 round 2 (review round 1): vitest's default pool is "forks", a separate
// child process per test file (node_modules/vitest/dist/config.js:99), so a
// module-level counter like the LaunchGate above only bounds launches
// inside ONE file. The review round's own repro showed two files' launches acquiring
// an in-process limit-1 gate 1ms apart, 20 Chrome processes alive, because
// each file's counter starts at zero. The fence has to live somewhere every
// worker process can see it: a directory of numbered slot files under
// os.tmpdir(), claimed with the O_EXCL exclusivity node:fs already gives
// mkdirSync (EEXIST when another process holds the slot), which is real
// cross-process mutual exclusion, not an in-memory count.
describe('CrossProcessLaunchGate: bounds concurrent launches across separate OS processes, not just one', () => {
  it('makes two launches in two separate child processes wait for each other when the limit is 1', async () => {
    const gateDir = mkdtempSync(join(tmpdir(), 'fa-launch-gate-probe-'));
    const resultsPath = join(gateDir, 'results.jsonl');
    writeFileSync(resultsPath, '');
    const childScript = join(gateDir, 'probe-child.mjs');
    writeFileSync(
      childScript,
      [
        "import { appendFileSync } from 'node:fs';",
        `const mod = await import(${JSON.stringify(realBrowserModuleUrl)});`,
        `const gate = new mod.CrossProcessLaunchGate(1, ${JSON.stringify(gateDir)});`,
        'const release = await gate.acquire();',
        `appendFileSync(${JSON.stringify(resultsPath)}, JSON.stringify({ pid: process.pid, event: 'start', t: Date.now() }) + '\\n');`,
        'await new Promise((r) => setTimeout(r, 400));',
        `appendFileSync(${JSON.stringify(resultsPath)}, JSON.stringify({ pid: process.pid, event: 'end', t: Date.now() }) + '\\n');`,
        'release();',
      ].join('\n'),
    );
    const runChild = (): Promise<void> =>
      new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, ['--import', 'tsx', childScript]);
        let stderr = '';
        proc.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });
        proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`probe child exited ${code}: ${stderr}`))));
      });
    try {
      await Promise.all([runChild(), runChild()]);
      const lines = readFileSync(resultsPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { pid: number; event: 'start' | 'end'; t: number });
      const byPid = new Map<number, { start: number; end: number }>();
      for (const line of lines) {
        const entry = byPid.get(line.pid) ?? { start: 0, end: 0 };
        entry[line.event] = line.t;
        byPid.set(line.pid, entry);
      }
      const windows = [...byPid.values()];
      expect(windows.length, 'both child processes must have run').toBe(2);
      const [first, second] = windows.sort((a, b) => a.start - b.start) as [
        { start: number; end: number },
        { start: number; end: number },
      ];
      expect(
        second.start,
        'with a limit of 1, the second process must not hold the slot before the first releases it',
      ).toBeGreaterThanOrEqual(first.end);
    } finally {
      rmSync(gateDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('reclaims a slot left behind by a process that is no longer running', async () => {
    const gateDir = mkdtempSync(join(tmpdir(), 'fa-launch-gate-stale-'));
    try {
      const mod = (await import(realBrowserModuleUrl)) as {
        CrossProcessLaunchGate: new (limit: number, dir: string) => { acquire(): Promise<() => void> };
      };
      // A pid this large is not a running process on any machine this
      // suite runs on; process.kill(pid, 0) on it throws ESRCH, which is
      // exactly the signal a stale slot from a crashed or killed worker
      // leaves behind.
      const deadPid = 2_147_483_000;
      writeFileSync(join(gateDir, 'slot-0.lock'), String(deadPid));
      const gate = new mod.CrossProcessLaunchGate(1, gateDir);
      const started = Date.now();
      const release = await gate.acquire();
      expect(Date.now() - started, 'a stale slot must be reclaimed on sight, not polled until some timeout').toBeLessThan(2_000);
      release();
    } finally {
      rmSync(gateDir, { recursive: true, force: true });
    }
  });
});

// CI4 round 2 (review round 1, defect 2): every real launch site sets
// BROWSER_TIMEOUT_MS = 30_000 (17 of the 25 files that call
// RealBrowser.launch, including the three that failed together in run
// 35921744859). A retry whose own per-attempt deadline is 30s cannot
// complete two attempts before vitest kills the test at 30s: the review
// round's stub showed 1 spawn and "Test timed out" at a 30s test timeout,
// needing a 120s test timeout to ever reach attempt 2. The port-wait
// budget shrinks so the whole retried launch, gate wait included, still
// finishes inside the timeout every caller actually uses (see
// PORT_WAIT_MS's own comment for how it was finally sized, after the
// cross-process gate itself was fixed to hold its slot for a browser's
// whole lifetime, not just its launch).
describe('RealBrowser.launch: a launch that never opens its port gives up within a 30s test timeout', () => {
  it('rejects with the give-up message well inside 30s, leaving room for a caller to still use the result', async () => {
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
      expect(
        elapsed,
        'the retried launch (gate wait plus every attempt) must finish well inside the 30s timeout every real caller sets',
      ).toBeLessThan(28_000);
    } finally {
      if (previousChromeBin === undefined) delete process.env.CHROME_BIN;
      else process.env.CHROME_BIN = previousChromeBin;
      rmSync(stubDir, { recursive: true, force: true });
    }
  }, 30_000);
});

// CI4 round 2 measurement fallout: the runner numbers from both pushes
// (35935765272 and 35936931195) showed chrome-procs-after staying at
// 11-18 for the ENTIRE run, not just during launches, while gate-wait was
// always near 0ms. That means the gate was never the bottleneck for
// SPAWNING; the bottleneck is how many Chrome processes run
// SIMULTANEOUSLY, competing for the runner's CPU for their whole
// lifetime. The round 2 gate released its slot right after the CDP
// handshake, so it bounded concurrent launches but not concurrent live
// browsers, which is what actually starves a legitimate launch of CPU
// long enough to miss even a 25s deadline (run 35936931195, node 24, two
// give-ups past 12s of open attempts already alive).
//
// The fix: RealBrowser.close() releases the gate slot, not launch()
// finishing. Proven here with two REAL child processes, each launching a
// real Chrome and holding it open for 3 seconds before closing: with the
// gate limit at 1, the second process's launch must not even begin until
// the first process's browser has closed. A shorter hold (600ms) was
// tried first and did not reliably separate the two windows on a fast
// local run; 3s gives enough margin that the assertion is not itself
// racy.
describe('RealBrowser.launch: the gate slot is held for the whole browser lifetime, not just launch', () => {
  it('a second launch in another process does not even spawn until the first browser closes, with the gate limit at 1', async () => {
    if (!hasRealBrowser()) return;
    const gateDir = mkdtempSync(join(tmpdir(), 'fa-lifetime-gate-probe-'));
    const resultsPath = join(gateDir, 'results.jsonl');
    writeFileSync(resultsPath, '');
    const childScript = join(gateDir, 'lifetime-child.mjs');
    writeFileSync(
      childScript,
      [
        "import { appendFileSync } from 'node:fs';",
        `const mod = await import(${JSON.stringify(realBrowserModuleUrl)});`,
        `appendFileSync(${JSON.stringify(resultsPath)}, JSON.stringify({ pid: process.pid, event: 'before-launch', t: Date.now() }) + '\\n');`,
        'const browser = await mod.RealBrowser.launch({ width: 1280, height: 900 });',
        `appendFileSync(${JSON.stringify(resultsPath)}, JSON.stringify({ pid: process.pid, event: 'launched', t: Date.now() }) + '\\n');`,
        'await new Promise((r) => setTimeout(r, 3000));',
        'await browser.close();',
        `appendFileSync(${JSON.stringify(resultsPath)}, JSON.stringify({ pid: process.pid, event: 'closed', t: Date.now() }) + '\\n');`,
      ].join('\n'),
    );
    const runChild = (): Promise<void> =>
      new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, ['--import', 'tsx', childScript], {
          env: { ...process.env, FA_LAUNCH_GATE_DIR: gateDir, FA_LAUNCH_GATE_LIMIT: '1' },
        });
        let stderr = '';
        proc.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });
        proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`probe child exited ${code}: ${stderr}`))));
      });
    try {
      await Promise.all([runChild(), runChild()]);
      const lines = readFileSync(resultsPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { pid: number; event: string; t: number });
      const byPid = new Map<number, Record<string, number>>();
      for (const line of lines) {
        const entry = byPid.get(line.pid) ?? {};
        entry[line.event] = line.t;
        byPid.set(line.pid, entry);
      }
      const windows = [...byPid.values()];
      expect(windows.length, 'both child processes must have run').toBe(2);
      const sorted = windows.sort((a, b) => (a['launched'] ?? 0) - (b['launched'] ?? 0));
      const [first, second] = sorted as [Record<string, number>, Record<string, number>];
      expect(
        second['launched'],
        'with the gate limit at 1, the second browser must not launch until the first one closes',
      ).toBeGreaterThanOrEqual(first['closed']!);
    } finally {
      rmSync(gateDir, { recursive: true, force: true });
    }
  }, 30_000);
});
