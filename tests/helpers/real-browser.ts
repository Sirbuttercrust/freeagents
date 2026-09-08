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
    const width = opts.width ?? 1280;
    const height = opts.height ?? 900;
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
