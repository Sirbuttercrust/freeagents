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
// browser's whole lifetime (round 2). Proof round 2 measured the lifetime
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

// CI4 round 3: the Proof round 2 log timeline shows a one-time cost, not
// sustained contention. A job's FIRST real Chrome launch took 8925 to
// 18961ms across every measurement push and every node version; every
// launch after it in the same job took 300-900ms, a 10-60x difference
// with nothing else that changed. That is what a page-cache miss looks
// like: the OS has not yet read Chrome's ~200MB binary and shared
// libraries off the runner's disk, so the first process that execs it
// blocks on real I/O, and every later exec of the same binary hits the
// now-resident pages instead. Concurrency numbers do not explain it
// (chrome-procs-after was 1 to 4 at every slow open, nowhere near the
// old gate's own limit), but "first exec of this binary in this job"
// matches every slow-open line without exception.
//
// warmUpChrome pays that cost once, outside every per-test timeout,
// before any test file's own launch ever runs (see vitest.config.ts's
// globalSetup, which the Vitest docs guarantee runs before test workers
// are created: https://vitest.dev/config/globalsetup). It launches a
// throwaway headless Chrome and closes it through the same launch()/
// close() path every real test uses; any failure (no Chrome binary, a
// port that never opens) is swallowed exactly the way hasRealBrowser()
// already lets every real-Chrome test skip rather than fail when Chrome
// is unavailable, since warm-up is an optimization, not a correctness
// requirement.
export async function warmUpChrome(): Promise<void> {
  if (!findChromeBinary()) return;
  try {
    const browser = await RealBrowser.launch({ width: 1280, height: 900, label: 'warmup' });
    await browser.close();
  } catch {
    // Best effort: a failed warm-up just means the first real test pays
    // the cold-start cost itself, the same as before this existed.
  }
}

// CI4 round 3 sizing: with warmUpChrome absorbing the first-launch
// page-cache cost (see its own comment), every measurement push's
// legitimate opens after a job's first launch land at 300-900ms. The
// worst SINGLE legitimate open across every push, warmed or not, was
// 18961ms (run 35936931195, node 24; the uncensored 25s-deadline push).
// PORT_WAIT_MS stays above that uncensored worst case with real margin,
// rather than at a number already shown to fail outright (12000ms lost
// in run 35935765272), and comfortably inside the 30s test timeout every
// real caller sets. If a future runner sample under warm-up shows a
// non-first launch still running past this, warmUpChrome did not do its
// job and this number is the wrong lever to move.
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

  // CI4 round 3: no launch gate and no retry. Proof round 2 measured the
  // round 2 gate directly and found it never bound a single launch on the
  // runner (gate-wait maxed at 3-6ms across 157 acquires per job in the
  // run meant to justify it), and the round 1/2 retry could not help
  // against a give-up that repeats on the very next attempt (run
  // 35935765272: the same test's two consecutive attempts both gave up at
  // the deadline, 1ms apart). The actual cause, a cold page-cache miss on
  // a job's first Chrome exec, is a one-time cost that warmUpChrome now
  // pays before any test's timeout starts, so a single attempt with
  // PORT_WAIT_MS's own margin is what the measured mechanism calls for.
  static async launch(opts: { width?: number; height?: number; label?: string } = {}): Promise<RealBrowser> {
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

    // CI4 round 3 measurement (temporary): tags each launch as the
    // warm-up or a real test launch, so the runner sample shows directly
    // whether warmUpChrome absorbed the cold-start cost or whether it
    // still lands on a later "test" launch. Removed once the round 3
    // numbers are in (see the handoff for the decision).
    const label = opts.label ?? 'test';
    const spawnStart = Date.now();
    let wsUrl: string | null = null;
    const deadline = Date.now() + PORT_WAIT_MS;
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
      console.log(`[CI4-TIMING] launch:label=${label} spawn-to-port-giveup=${Date.now() - spawnStart}ms`);
      throw new Error(GIVEUP_MESSAGE);
    }
    console.log(`[CI4-TIMING] launch:label=${label} spawn-to-port-open=${Date.now() - spawnStart}ms`);

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
