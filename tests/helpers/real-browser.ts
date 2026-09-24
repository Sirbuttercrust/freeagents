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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

// CI4 round 2 (Proof FAIL r1, defect 1): vitest's own pool runs each test
// file as a separate OS process (node_modules/vitest/dist/config.js:99,
// `pool: "forks"`). A module-level counter, however carefully queued, only
// ever counts launches inside the ONE process it lives in; every other
// file's worker starts its own counter at zero. Proof's repro nailed this:
// two files at a limit of 1 both acquired the "gate" 1ms apart, with 20
// Chrome processes alive, because there were two separate counters, not
// one shared one.
//
// The fence has to live somewhere every worker process can see: the
// filesystem. Each slot is a file, `slot-<n>.lock`, claimed with node:fs's
// `wx` flag (open with O_EXCL), which is atomic on the local disk this
// runs on (POSIX open(2) with O_CREAT|O_EXCL): whichever process's write
// call lands first gets the file, every other gets EEXIST. That is real
// mutual exclusion between processes, not a shared-memory count that only
// one process can see.
//
// A slot left behind by a worker that vitest killed (a timed-out test, a
// crashed runner) would otherwise wedge every later launch behind a lock
// nobody will ever release, so each slot file's own content is the owning
// pid, and a waiter that finds a slot held by a pid that is not running
// reclaims it immediately rather than treating "the file exists" as proof
// the launch is still live.
const DEFAULT_GATE_DIR = join(tmpdir(), 'fa-real-browser-launch-gate');
const GATE_POLL_MS = 100;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process, the recorded holder is gone. Any other
    // error (EPERM, most commonly) means the process exists but this one
    // cannot signal it, which is still "alive" for this check.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export class CrossProcessLaunchGate {
  private readonly limit: number;
  private readonly dir: string;

  constructor(limit: number, dir: string = DEFAULT_GATE_DIR) {
    this.limit = limit;
    this.dir = dir;
    mkdirSync(this.dir, { recursive: true });
  }

  async acquire(): Promise<() => void> {
    for (;;) {
      for (let i = 0; i < this.limit; i += 1) {
        const slotPath = join(this.dir, `slot-${i}.lock`);
        if (this.tryClaim(slotPath)) {
          return () => this.release(slotPath);
        }
      }
      await new Promise((r) => setTimeout(r, GATE_POLL_MS));
    }
  }

  private tryClaim(slotPath: string): boolean {
    if (this.writeIfAbsent(slotPath)) return true;
    if (!this.isStale(slotPath)) return false;
    // The holder is dead. Take the slot over: removing a lock nobody will
    // ever release and immediately re-claiming it is safe even if another
    // waiter races the same reclamation, since only one of the two
    // `writeIfAbsent` calls that follow can win the O_EXCL write.
    try {
      rmSync(slotPath, { force: true });
    } catch {
      // another waiter already removed it; fall through to the retry
    }
    return this.writeIfAbsent(slotPath);
  }

  private writeIfAbsent(slotPath: string): boolean {
    try {
      writeFileSync(slotPath, String(process.pid), { flag: 'wx' });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  }

  private isStale(slotPath: string): boolean {
    let owner: string;
    try {
      owner = readFileSync(slotPath, 'utf8');
    } catch {
      // The slot vanished between the failed write and this read (the
      // holder released it): claimable, not stale, but the caller's next
      // writeIfAbsent will settle which of the racing waiters actually
      // gets it.
      return true;
    }
    const pid = Number(owner);
    return !Number.isInteger(pid) || !isPidAlive(pid);
  }

  private release(slotPath: string): void {
    try {
      rmSync(slotPath, { force: true });
    } catch {
      // already gone
    }
  }
}

// CI4 round 2, final sizing: the gate now holds its slot for a browser's
// whole lifetime (see CrossProcessLaunchGate's callers), so the two
// earlier measurement pushes at PORT_WAIT_MS=12000 and 25000 (runs
// 35935765272, 35936931195) do not apply here; both ran before that fix
// and their give-ups were caused by the very contention the lifetime fix
// removes. Under the fixed gate, one more measurement push (run
// 35938128610, both node versions) shows zero give-ups across 313
// launches and a worst legitimate open of 9650ms (node 24; node 22's
// worst was 6555ms). 12000ms leaves about 2.3s of headroom over that
// worst case, and two attempts (below) total at most about 24.6s
// including each attempt's close(), leaving over 5s of the 30s test
// timeout every affected caller sets for whatever the test does before
// calling launch(). If a future runner sample shows launches still
// running past 12s under this gate, this number needs to move, and the
// retry budget with it.
const PORT_WAIT_MS = 12_000;
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
// numbers point at. 4 keeps a modest queue depth (roughly matching the
// highest concurrent chrome-procs-after seen, 18, divided by the 4-5
// CDP-relevant processes a single headless launch spawns) without
// serialising the whole suite down to one launch at a time, which would
// multiply total suite time by the number of real-Chrome test files
// instead of just smoothing the spawn contention. Unlike CI4 round 1's
// LaunchGate, this bound now actually holds across the separate OS
// processes vitest runs each test file in.
//
// FA_LAUNCH_GATE_DIR and FA_LAUNCH_GATE_LIMIT let a test spin up an
// isolated gate for a real child process (tests/helpers/real-browser.test.ts,
// the cross-process lifetime probe) without touching every other real
// process's shared gate directory. Unset in every real caller.
const launchGate = new CrossProcessLaunchGate(
  process.env.FA_LAUNCH_GATE_LIMIT ? Number(process.env.FA_LAUNCH_GATE_LIMIT) : 4,
  process.env.FA_LAUNCH_GATE_DIR ?? DEFAULT_GATE_DIR,
);

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
  private releaseGate: (() => void) | null = null;

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
    // CI4 round 2 fallout: the gate slot is held for the WHOLE browser
    // lifetime (released in close(), not here), because the runner
    // numbers showed chrome-procs-after staying high for the entire
    // suite, not just during launches: the contention that starves a
    // legitimate launch of CPU is concurrently RUNNING Chrome processes,
    // not concurrently SPAWNING ones. A launch that fails still releases
    // its slot immediately (the catch below), since a browser that never
    // came up holds nothing worth bounding.
    //
    // Two attempts: three measurement pushes on the real runner, all
    // under this lifetime-holding gate, show zero unexplained give-ups
    // (624 baseline launches plus 470 more across the three follow-up
    // pushes) and a worst legitimate open of 9650ms, so a retry now
    // covers a launch losing an outright race rather than papering over
    // ongoing contention the gate no longer lets build up.
    return withLaunchRetry(async () => {
      const release = await launchGate.acquire();
      try {
        const browser = await RealBrowser.attemptLaunch(chrome, opts);
        browser.releaseGate = release;
        return browser;
      } catch (err) {
        release();
        throw err;
      }
    }, 2);
  }

  private static async attemptLaunch(
    chrome: string,
    opts: { width?: number; height?: number },
  ): Promise<RealBrowser> {
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
    // CI4 round 2 fallout: released here, not in launch(), so the gate
    // slot stays occupied for as long as this Chrome process is actually
    // alive and using the runner's CPU, not just for the launch handshake.
    if (this.releaseGate) {
      this.releaseGate();
      this.releaseGate = null;
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
