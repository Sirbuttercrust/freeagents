// Runs `prisma migrate deploy` before the server accepts a request. This is
// the fix for B1: the deploy path built a Prisma client (npm run build runs
// prisma generate) but never applied a migration, so a fresh Postgres
// database had no schema and every write returned 503.
//
// Deliberately not `migrate dev` (interactive, can reset a database) and not
// `db push` (ignores migration history entirely, which is the exact state
// the live rehearsal database is already stuck in: tables exist, zero rows
// in _prisma_migrations).
//
// Skips entirely when DATABASE_URL is unset or empty. The in-memory storage
// driver (src/adapters/storage/storage.ts) is a supported mode and the whole
// suite runs as `DATABASE_URL= npm test`; a migration step that hard-fails
// without a database would break that mode.
//
// Concurrency: `prisma migrate deploy` takes a Postgres advisory lock for
// the duration of the apply, so two instances booting at once serialize
// rather than racing the same schema (Prisma's own migration engine
// behaviour, unrelated to anything this file does).
import { spawnSync } from 'node:child_process';

export class MigrationFailedError extends Error {}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

type Runner = (env: NodeJS.ProcessEnv) => CommandResult;

// The real runner, split out so the test can substitute a fake process
// result instead of touching an actual database. Uses spawnSync so the
// caller (src/api/server.ts) can treat this as a synchronous boot gate: the
// migration either finishes before the first request is served or the
// process exits non-zero before ever calling .listen().
export function runPrismaMigrateDeploy(env: NodeJS.ProcessEnv): CommandResult {
  const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
    env,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

const BASELINE_HINT =
  'the database has tables but no migration history (P3005). Baseline it: for ' +
  'each migration under prisma/migrations whose effects the database already ' +
  "has, run `prisma migrate resolve --applied <migration_name>`, then re-run " +
  'this step. See the deployment section of README.md.';

// Exported so a test can pin the skip/run/fail behaviour against a fake
// runner, the same shape as copyPrismaClient in
// scripts/copy-prisma-client.mjs.
export function runMigrations(env: NodeJS.ProcessEnv, runner: Runner = runPrismaMigrateDeploy): void {
  if (!env['DATABASE_URL']) {
    console.log('migrate: DATABASE_URL is not set; skipping schema migration (in-memory storage mode).');
    return;
  }

  console.log('migrate: applying pending Prisma migrations...');
  const result = runner(env);

  if (result.status === 0) {
    console.log('migrate: schema is up to date.');
    return;
  }

  if (/P3005/.test(result.stderr)) {
    throw new MigrationFailedError(`migrate: the database schema is not empty and ${BASELINE_HINT}`);
  }

  // Fail loud, fail the boot: invariant 9's fail-closed rule. A server that
  // starts on an unmigrated schema is the 503 storm B1 names, only with a
  // smaller window. Never print the raw env, only Prisma's own stderr,
  // which already avoids the connection string in normal operation.
  throw new MigrationFailedError(
    `migrate: prisma migrate deploy exited with status ${result.status}. ${result.stderr.trim()}`,
  );
}
