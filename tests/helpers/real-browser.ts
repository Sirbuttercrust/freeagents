// P8n repair round 1: jsdom performs no layout, so a test built on it can
// declare a media query fired or read a static computed style, and never
// once know whether a row actually overflows a real 320px screen. That is
// the vacuous-gate defect the P8n review round 1 found in
// tests/web/myagents.test.ts, and it is the same shape as the P8j, P8l and
// P8m defects already on the standing ledger.
//
// This drives one throwaway headless Chrome over the DevTools protocol, the
// same driver shape as spec/wireframe/wirebrowse.py, kept to Node's own
// built-ins (node:child_process, the global WebSocket Node 22 ships) so no
// test dependency is added for it. It cannot be wedged by, and cannot wedge,
// anything else running on the machine: a fresh remote-debugging port and a
// fresh throwaway profile directory per instance.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const CHROME_ENV = 'CHROME_BIN';

// base.css's own phone/coarse-pointer gate is `(max-width: 760px), (pointer:
// coarse)` (base.css:541), and this suite's own "phone widths" (320 in every
// caller) sit well inside it. 760 is the same threshold: a launch at that
// width or narrower is a phone-shaped viewport, and a real phone's
// scrollbar is an overlay that consumes no layout width. Wider launches are
// desktop-shaped, where a real scrollbar DOES consume layout width, so
// those keep the platform's own scrollbar behaviour rather than hiding it.
const PHONE_WIDTH_MAX = 760;

function isPhoneWidth(width: number): boolean {
  return width <= PHONE_WIDTH_MAX;
}

// Ordered the same way wirebrowse.py orders them: most likely first. Globs
// are resolved by hand below since this file adds no glob dependency.
function candidateDirs(): { agentBrowsers: string; puppeteerChrome: string } {
  const home = process.env.HOME ?? '';
  return {
    agentBrowsers: join(home, '.agent-browser', 'browsers'),
    puppeteerChrome: join(home, '.cache', 'puppeteer', 'chrome'),
  };
}

function findVersionedChrome(base: string, appPathParts: string[]): string | null {
  if (!existsSync(base)) return null;
  const entries = readdirSync(base).filter((n) => n.startsWith('chrome-')).sort();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const candidate = join(base, entry, ...appPathParts);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function findChromeBinary(): string | null {
  const explicit = process.env[CHROME_ENV];
  if (explicit) return existsSync(explicit) ? explicit : null;

  const macApp = ['Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'];
  const linuxApp = ['chrome-linux64', 'chrome'];
  const { agentBrowsers, puppeteerChrome } = candidateDirs();

  const fromAgentBrowsers = findVersionedChrome(agentBrowsers, macApp);
  if (fromAgentBrowsers) return fromAgentBrowsers;

  const fromPuppeteerMac = findVersionedChrome(puppeteerChrome, macApp);
  if (fromPuppeteerMac) return fromPuppeteerMac;

  const fromPuppeteerLinux = findVersionedChrome(puppeteerChrome, linuxApp);
  if (fromPuppeteerLinux) return fromPuppeteerLinux;

  const fixedCandidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const c of fixedCandidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('could not allocate a free port')));
      }
    });
  });
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

// CI4: bounds how many Chrome processes spawn at once. Two independent
// runner samples (312 launches each, both node 22 and node 24) put the
// worst single-launch spawn-to-port-open at 11780ms with never more than
// 18 Chrome-related processes alive at once, none of it from this test
// suite launching more than one browser concurrently per worker: vitest's
// own worker pool is what stacks several files' launches into the same
// window. A gate that only lets a bounded number of launches spawn at
// once turns that pile-up into a queue instead of every held-back launch
// re-polling the same 300ms loop against a runner that is still booting
// several Chromes at once.
export class LaunchGate {
  private readonly limit: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const tryAcquire = (): void => {
        if (this.active < this.limit) {
          this.active += 1;
          resolve(() => this.release());
        } else {
          this.waiters.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}

// CI4: the runner samples above never reproduced the >30s "chrome debug
// port never came up" failure from run 35921744859, so nothing measured
// justifies raising launch()'s own 30s deadline past what four earlier
// samples (CI2 D1, max 11795ms) and these two (max 11780ms) already show
// as headroom. What a longer deadline cannot fix is a launch that loses
// the race entirely on a contended runner; a bounded retry does, at the
// cost of one more spawn attempt, and only for the specific failure this
// card is about, never for an unrelated error (a missing Chrome binary,
// for instance, retrying that just wastes the same 30s deadline twice).
const GIVEUP_MESSAGE = 'chrome debug port never came up';

export async function withLaunchRetry<T>(attempt: () => Promise<T>, maxAttempts: number): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      return await attempt();
    } catch (err) {
      lastError = err;
      const isGiveup = err instanceof Error && err.message === GIVEUP_MESSAGE;
      if (!isGiveup) throw err;
    }
  }
  throw lastError;
}

// A launch that spawns Chrome is the expensive, contended step the runner
// numbers point at; two files landing in the same vitest worker window
// both spawning at once is what stacks up. 4 keeps a modest queue depth
// (roughly matching the highest concurrent chrome-procs-after seen, 18,
// divided by the 4-5 CDP-relevant processes a single headless launch
// spawns) without serialising the whole suite down to one launch at a
// time, which would multiply total suite time by the number of
// real-Chrome test files instead of just smoothing the spawn contention.
const launchGate = new LaunchGate(4);

// One throwaway headless Chrome tab, driven over CDP. Deliberately small:
// goto + evaluate + close. A test that needs more speaks CDP directly via
// `send`, which keeps this file from growing a second test framework.
export class RealBrowser {
  private proc: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private profile: string;
  private port = 0;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: CdpMessage) => void; reject: (e: Error) => void }>();

  private constructor(profile: string) {
    this.profile = profile;
  }

  static async launch(opts: { width?: number; height?: number } = {}): Promise<RealBrowser> {
    const chrome = findChromeBinary();
    if (!chrome) {
      throw new Error(
        `no Chrome found for real-browser layout tests. Set ${CHROME_ENV} to a Chrome/Chromium binary.`,
      );
    }
    // CI4: the gate bounds how many launches spawn Chrome at once (see
    // LaunchGate's own comment for the runner numbers behind the limit).
    // The retry covers the one failure mode those numbers cannot rule
    // out: a specific launch losing the spawn/port race outright under
    // contention, which a longer deadline does not fix since nothing
    // measured shows the deadline itself was close to firing.
    return withLaunchRetry(async () => {
      const release = await launchGate.acquire();
      try {
        return await RealBrowser.attemptLaunch(chrome, opts);
      } finally {
        release();
      }
    }, 2);
  }

  private static async attemptLaunch(chrome: string, opts: { width?: number; height?: number }): Promise<RealBrowser> {
    const width = opts.width ?? 1280;
    const height = opts.height ?? 900;
    const overlay = isPhoneWidth(width);
    const profile = mkdtempSync(join(tmpdir(), 'fa-real-browser-'));
    const browser = new RealBrowser(profile);
    browser.port = await freePort();

    const args = [
      '--headless=new',
      '--disable-gpu',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--remote-allow-origins=*',
      `--remote-debugging-port=${browser.port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      'about:blank',
    ];
    browser.proc = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const proc = browser.proc;

    let wsUrl: string | null = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      if (proc.exitCode !== null) {
        throw new Error(`chrome exited immediately (code ${proc.exitCode})`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${browser.port}/json/list`);
        if (res.ok) {
          const tabs = (await res.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
          const page = tabs.find((t) => t.type === 'page');
          if (page) {
            wsUrl = page.webSocketDebuggerUrl;
            break;
          }
        }
      } catch {
        // debug port not up yet
      }
    }
    if (!wsUrl) {
      await browser.close();
      throw new Error('chrome debug port never came up');
    }

    browser.ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      browser.ws!.addEventListener('open', () => resolve(), { once: true });
      browser.ws!.addEventListener('error', () => reject(new Error('CDP websocket failed to open')), { once: true });
    });
    browser.ws.addEventListener('message', (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as CdpMessage;
      if (msg.id !== undefined) {
        const waiter = browser.pending.get(msg.id);
        if (waiter) {
          browser.pending.delete(msg.id);
          if (msg.error) waiter.reject(new Error(msg.error.message ?? 'CDP error'));
          else waiter.resolve(msg);
        }
      }
    });

    await browser.send('Page.enable');
    await browser.send('Runtime.enable');
    await browser.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // Real phones draw an overlay scrollbar: it paints over the content and
    // consumes no layout width. Headless Chrome on Linux (the GitHub
    // Actions runner) draws the classic, space-consuming scrollbar by
    // default, so a scrollable phone-width page measured clientWidth 15px
    // narrower there than on a Mac, which drew the overlay style already.
    // Forcing the overlay behaviour at phone widths makes the measurement
    // match a real phone on every platform, rather than papering over the
    // mismatch with a fudged expected value.
    if (overlay) {
      await browser.send('Emulation.setScrollbarsHidden', { hidden: true });
    }
    return browser;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> {
    if (!this.ws) throw new Error('browser not launched');
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise<CdpMessage>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // Same overlay-vs-classic reasoning as launch(): a mid-session resize
    // to a phone width has to apply the same platform-independent
    // scrollbar behaviour, or a test that resizes down to 320px (the
    // dashboard dspan-6 pair test does exactly this) would pass at launch
    // and still read a shrunk clientWidth after the resize.
    await this.send('Emulation.setScrollbarsHidden', { hidden: isPhoneWidth(width) });
  }

  async goto(url: string, waitMs = 500): Promise<void> {
    await this.send('Page.navigate', { url });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      const state = await this.evaluate<string>('document.readyState');
      if (state === 'complete') break;
    }
    await new Promise((r) => setTimeout(r, waitMs));
  }

  // Real geometry, real hit-testing, real click dispatch: what jsdom cannot
  // provide at all. Returned values are JSON round tripped, matching what
  // returnByValue already gives back.
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const result = res.result as { exceptionDetails?: unknown; result?: { value?: T } };
    if (result.exceptionDetails) {
      throw new Error(`page script threw: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result?.value as T;
  }

  async close(): Promise<void> {
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill();
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      rmSync(this.profile, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
}

// True when a real Chrome could be found. Layout-geometry tests skip
// (rather than fail) when this is false, because a missing browser is a
// different fact than a broken layout, the same distinction
// spec/wireframe/wirebrowse.py's exit-3 convention draws.
export function hasRealBrowser(): boolean {
  return findChromeBinary() !== null;
}
