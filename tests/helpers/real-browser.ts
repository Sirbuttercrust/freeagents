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

// CI4 round 3: rounds 1 and 2 both tried to bound CONCURRENCY, first a
// per-process counter (round 1, proven vacuous across vitest's separate
// worker processes) then a cross-process slot directory held for a
// browser's whole lifetime (round 2). Review round 2 measured the lifetime
// gate directly on the runner (run 35938128610) and found it never once
// made a launch wait: gate-wait maxed at 3-6ms across 157 acquires per
// job. The real give-ups in every measurement push landed in the first
// handful of log lines of a job, at chrome-procs-after of 1 to 4, the
// opposite of what a concurrency theory needs. Bounding concurrency
// further would only slow every job down without touching the actual
// cause, so no launch gate remains: PORT_WAIT_MS alone, sized from the
// uncensored worst case the runner has actually shown (see its own
// comment), plus warmUpChrome (below) removing the cold-start cost that
// produced every give-up in the first place.
const GIVEUP_MESSAGE = 'chrome debug port never came up';

// CI4 round 3: what the runner logs show, and what they do not. Across
// every measurement push, the slow opens (6.5 to 19s) and every real
// give-up landed in the first seconds of a job, while several forks were
// launching Chrome cold at the same moment. Not every first launch was
// slow (919ms and 1994ms were both first launches), and some slow ones
// were not first (12453ms and 16045ms were a job's fourth to sixth open).
// So the pattern is "cold, in the opening seconds of a job", not "the
// first launch pays and every later one is fast". Why cold is slow is a
// hypothesis, not a measurement: the likeliest is the OS reading Chrome's
// binary and libraries off disk for the first time. Nothing here measured
// page-cache residency.
//
// warmUpChrome launches one throwaway Chrome before any test worker exists
// (vitest.config.ts globalSetup, which the Vitest docs say runs before
// workers are created: https://vitest.dev/config/globalsetup), so the
// cold start happens outside every per-test timeout. Under it, two runner
// measurement runs (36005035993 and 36005938897, both node versions) put
// all 628 test opens between 301 and 735ms, with no real give-up.
//
// Its own port wait is WARMUP_PORT_WAIT_MS, not the per-test budget:
// globalSetup has no 30s test timeout, and the runner has shown a cold
// launch with no port at 25023ms. A warm-up that still gives up is logged
// to stderr, never swallowed silently, because the first tests are then
// back to paying the cold start themselves and CI output should say so.
// It returns whether a Chrome actually ran, so its test can fail when it
// does nothing.
export const WARMUP_PORT_WAIT_MS = 60_000;

export async function warmUpChrome(log: (msg: string) => void = (m) => console.warn(m)): Promise<boolean> {
  if (!findChromeBinary()) return false;
  const started = Date.now();
  try {
    const browser = await RealBrowser.launch({ width: 1280, height: 900, portWaitMs: WARMUP_PORT_WAIT_MS });
    await browser.close();
    return true;
  } catch (err) {
    log(
      `[real-browser] Chrome warm-up gave up after ${Date.now() - started}ms (${(err as Error).message}); ` +
        'the first real-browser tests will pay the cold start inside their own timeout.',
    );
    return false;
  }
}

// CI4 round 3 sizing: with warmUpChrome taking the cold start (see its
// own comment), the worst SINGLE legitimate
// open across the whole diagnostic history, warmed or not, was 18961ms
// (round 2 review push, run 35936931195, node 24, the uncensored
// 25s-deadline push). PORT_WAIT_MS stays above that uncensored worst
// case with real margin, rather than at a number already shown to fail
// outright (12000ms lost in run 35935765272), and comfortably inside the
// 30s test timeout every real caller sets. Two round-3 measurement runs
// under warmUpChrome (runs 36005035993 and 36005938897, both node
// versions) are consistent with it: the warm-up launch itself took 819ms
// to 16622ms, and every real test launch after it landed at 301-735ms
// with no real give-up on either node in either run. If a future
// runner sample under warm-up shows a non-first launch still running
// past this, warmUpChrome did not do its job and this number is the
// wrong lever to move.
const PORT_WAIT_MS = 22_000;

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

  // CI4 round 3: no launch gate and no retry. Review round 2 measured the
  // round 2 gate directly and found it never bound a single launch on the
  // runner (gate-wait maxed at 3-6ms across 157 acquires per job in the
  // run meant to justify it), and the round 1/2 retry could not help
  // against a give-up that repeats on the very next attempt (run
  // 35935765272: the same test's two consecutive attempts both gave up at
  // the deadline, 12046ms and 12047ms long, 12.2s apart). Launches were
  // slow while Chrome was cold in the opening seconds of a job, which
  // warmUpChrome now takes before any test's timeout starts, so a single
  // attempt with PORT_WAIT_MS's own margin is what the runner data calls
  // for.
  static async launch(opts: { width?: number; height?: number; portWaitMs?: number } = {}): Promise<RealBrowser> {
    const chrome = findChromeBinary();
    if (!chrome) {
      throw new Error(
        `no Chrome found for real-browser layout tests. Set ${CHROME_ENV} to a Chrome/Chromium binary.`,
      );
    }
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
    const deadline = Date.now() + (opts.portWaitMs ?? PORT_WAIT_MS);
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
      throw new Error(GIVEUP_MESSAGE);
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
