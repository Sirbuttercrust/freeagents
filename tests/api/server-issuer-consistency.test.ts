// ISS1 review round 1 defect (Proof FAIL, comment on t_9d676481): the
// startup configuration report can name a DID the process does not
// actually sign with. src/api/server.ts used to call platformIssuerFromEnv
// itself for the report line, while createApp's own default credentials
// adapter called platformIssuerFromEnv a second time inside itself --
// two separate calls, and platformIssuerFromEnv mints a fresh random
// ephemeral key on every call when no seed is configured (issuer.test.ts's
// own "two calls ... different ... DIDs" test holds that contract on
// purpose). Two calls at boot could therefore name two different DIDs for
// the one process, and the FREEAGENTS_PLATFORM_DID ignore warning (and the
// ephemeral-key warning) fired once per call instead of once per boot.
//
// tests/api/server.test.ts mocks createApp and the credentials module
// entirely, so it cannot see either defect -- it only proves the wiring
// calls the right mocked functions, never that two independent
// derivations in the REAL modules agree. This file boots the real
// process (tsx running src/api/server.ts, no mocks at all) and checks
// its own stdout/stderr and its own HTTP surface, the same way QA's
// manual repro on the card did.
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../..');
const tsxBin = join(repoRoot, 'node_modules/.bin/tsx');
const serverEntry = join(repoRoot, 'src/api/server.ts');

const BOOT_TIMEOUT_MS = 15_000;

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

// The report line reads "  credentials: configured, issuer did:abt:..."
// or "  credentials: not configured (...), issuer did:abt:...".
function issuerFromReportOutput(output: string): string | null {
  const match = /credentials:[^\n]*?issuer (did:abt:\S+)/.exec(output);
  return match?.[1] ?? null;
}

let child: ChildProcess | null = null;

afterEach(() => {
  if (child !== null && child.exitCode === null) {
    child.kill('SIGTERM');
  }
  child = null;
});

async function bootServer(env: Record<string, string>): Promise<{ port: number; output: string }> {
  const port = await freePort();
  let output = '';
  child = spawn(tsxBin, [serverEntry], {
    cwd: repoRoot,
    env: { ...process.env, ...env, PORT: String(port), DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const proc = child;
  if (proc.stdout === null || proc.stderr === null) {
    throw new Error('spawned process has no stdout/stderr pipes');
  }
  const stdout = proc.stdout;
  const stderr = proc.stderr;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`server did not boot in time; output so far:\n${output}`));
    }, BOOT_TIMEOUT_MS);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.includes(`freeagents listening on port ${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    stdout.on('data', onData);
    stderr.on('data', onData);
    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  // The config report and the github scope probe both resolve after the
  // listen callback fires (they are separate promise chains kicked off
  // earlier in the file); give them a turn to finish printing.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { port, output };
}

describe('src/api/server.ts real boot: the startup report issuer DID and the running app agree', () => {
  it(
    'with a configured seed, the report DID equals the DID the app actually serves at /.well-known',
    async () => {
      const seed = 'f7'.repeat(32);
      const { port, output } = await bootServer({ FREEAGENTS_PLATFORM_SEED: seed });

      const reportedDid = issuerFromReportOutput(output);
      expect(reportedDid).not.toBeNull();

      const wellKnown = await fetch(`http://127.0.0.1:${port}/.well-known/freeagents-issuer.json`);
      const body = (await wellKnown.json()) as { issuer: string };

      expect(reportedDid).toBe(body.issuer);
    },
    BOOT_TIMEOUT_MS + 5000,
  );

  it(
    'with no seed configured (ephemeral dev key), the report DID still equals the app-served /.well-known DID',
    async () => {
      const { port, output } = await bootServer({});

      const reportedDid = issuerFromReportOutput(output);
      expect(reportedDid).not.toBeNull();

      const wellKnown = await fetch(`http://127.0.0.1:${port}/.well-known/freeagents-issuer.json`);
      const body = (await wellKnown.json()) as { issuer: string };

      expect(reportedDid).toBe(body.issuer);
    },
    BOOT_TIMEOUT_MS + 5000,
  );

  it(
    'a still-set FREEAGENTS_PLATFORM_DID logs the ignore warning exactly once for the whole boot',
    async () => {
      const seed = 'a8'.repeat(32);
      const { output } = await bootServer({
        FREEAGENTS_PLATFORM_SEED: seed,
        FREEAGENTS_PLATFORM_DID: 'did:abt:zStaleConfiguredValue',
      });

      const occurrences = output.split('FREEAGENTS_PLATFORM_DID is set but is no longer used').length - 1;
      expect(occurrences).toBe(1);
    },
    BOOT_TIMEOUT_MS + 5000,
  );

  it(
    'with no seed configured, the ephemeral-key warning logs exactly once for the whole boot',
    async () => {
      const { output } = await bootServer({});

      const occurrences = output.split('issuing with a random ephemeral key').length - 1;
      expect(occurrences).toBe(1);
    },
    BOOT_TIMEOUT_MS + 5000,
  );
});
