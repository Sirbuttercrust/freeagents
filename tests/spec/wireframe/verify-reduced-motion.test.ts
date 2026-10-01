import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// The reduced-motion check is kept because it is still run, so it has to be
// able to fail. These cases run the real script, in a temp copy of its
// directory so population.every_screen() sees only the pages written here,
// against the real devserver.py on a free port.
//
// Each case launches Chrome through wirebrowse. Run this file alone.

const here = dirname(fileURLToPath(import.meta.url));
const wireframeDir = resolve(here, '../../../spec/wireframe');
const SCRIPT_FILES = ['verify_reduced_motion.py', 'population.py', 'wirebrowse.py', 'devserver.py'];

const tempDirs: string[] = [];
const servers: ChildProcess[] = [];

afterAll(async () => {
  for (const server of servers) {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise((done) => server.once('exit', done));
      server.kill('SIGTERM');
      await exited;
    }
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

async function waitForHealthz(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((later) => setTimeout(later, 100));
  }
  throw new Error(`devserver did not answer on port ${port}`);
}

interface Setup {
  /** Pages the script's directory holds, so every_screen() lists them. */
  screens: Record<string, string>;
  /** Names from `screens` that the server also holds. Empty with serve false. */
  served: string[];
  /** false leaves the port with nothing listening on it. */
  serve: boolean;
}

interface Outcome {
  status: number | null;
  stdout: string;
  stderr: string;
  base: string;
}

async function runCheck(setup: Setup): Promise<Outcome> {
  const root = mkdtempSync(join(tmpdir(), 'reduced-motion-'));
  tempDirs.push(root);
  const scriptsDir = join(root, 'scripts');
  const servedDir = join(root, 'served');
  mkdirSync(scriptsDir);
  mkdirSync(servedDir);
  for (const file of SCRIPT_FILES) copyFileSync(join(wireframeDir, file), join(scriptsDir, file));
  for (const [name, html] of Object.entries(setup.screens)) {
    writeFileSync(join(scriptsDir, name), html);
    if (setup.served.includes(name)) writeFileSync(join(servedDir, name), html);
  }

  const port = await freePort();
  if (setup.serve) {
    const server = spawn(
      'python3',
      [join(scriptsDir, 'devserver.py'), String(port), '--dir', servedDir],
      { stdio: 'ignore' },
    );
    servers.push(server);
    await waitForHealthz(port);
  }

  const base = `http://127.0.0.1:${port}/`;
  const result = spawnSync('python3', ['verify_reduced_motion.py'], {
    cwd: scriptsDir,
    env: { ...process.env, WF_BASE: base },
    encoding: 'utf8',
    timeout: 170_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, base };
}

const lines = (text: string): string[] => text.split('\n').map((line) => line.trim());

const page = (body: string, head = ''): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>t</title>${head}</head><body>${body}</body></html>`;

const PLAIN = page('<p>nothing animated here</p>');
const VISIBLE = page('<div class="reveal">visible</div>');
const STRANDED = page('<div class="reveal">hidden</div>', '<style>.reveal{opacity:0}</style>');

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('verify_reduced_motion.py fails when it did not measure', () => {
  it('(a) exits 1 with the WF_BASE line and RESULT: FAIL alone when nothing listens', async () => {
    const out = await runCheck({ screens: { 'one.html': VISIBLE }, served: [], serve: false });
    expect(out.status).toBe(1);
    expect(out.stdout).toMatch(
      new RegExp(`^WF_BASE ${escapeRegExp(out.base)} did not answer: .+\\nRESULT: FAIL\\n$`),
    );
  }, 180_000);

  it('(b) exits 1 with the nothing-measured line when the served page has no measurable element', async () => {
    const out = await runCheck({ screens: { 'plain.html': PLAIN }, served: ['plain.html'], serve: true });
    expect(out.status).toBe(1);
    expect(lines(out.stdout)).toContain('nothing was measured: 0 elements checked across 1 screens');
    expect(lines(out.stdout)).toContain('RESULT: FAIL');
  }, 180_000);

  it('(c) exits 1 naming the page the server does not have, with its 404', async () => {
    const out = await runCheck({
      screens: { 'missing.html': VISIBLE, 'present.html': VISIBLE },
      served: ['present.html'],
      serve: true,
    });
    expect(out.status).toBe(1);
    expect(lines(out.stdout)).toContain(
      `missing.html: did not load (status 404, at ${out.base}missing.html)`,
    );
    expect(lines(out.stdout)).toContain('RESULT: FAIL');
  }, 180_000);

  it('(d) control: exits 0 with RESULT: PASS for a served page with a visible .reveal', async () => {
    const out = await runCheck({ screens: { 'one.html': VISIBLE }, served: ['one.html'], serve: true });
    expect(out.status).toBe(0);
    expect(lines(out.stdout)).toContain('screens: 1, elements checked: 1');
    expect(lines(out.stdout)).toContain('RESULT: PASS');
  }, 180_000);

  it('(e) control: exits 1 with the stranded line for a .reveal left at opacity 0', async () => {
    const out = await runCheck({ screens: { 'one.html': STRANDED }, served: ['one.html'], serve: true });
    expect(out.status).toBe(1);
    expect(lines(out.stdout)).toContain(
      "one.html: content stranded hidden ['reveal: opacity 0']",
    );
    expect(lines(out.stdout)).toContain('RESULT: FAIL');
  }, 180_000);
});
