// The Blocklet Server preStart hook (blocklet.yml `scripts: preStart:`).
// Runs before `main` starts, so a missing or broken schema stops the boot
// instead of shipping a server that answers every write with 503 (bug B1).
//
// WHY THIS FILE LIVES BESIDE server.ts, NOT UNDER src/adapters/runtime.
// `blocklet bundle` in simple mode (the default for `group: dapp`, and this
// repo declares no `files:` field) only ever auto-includes the directory
// holding `main` -- @blocklet/cli's own bundler special-cases exactly that
// ("#5823, always include the entire main folder for dapps") and nothing
// else. Verified empirically against @blocklet/cli v1.17.12 on a throwaway
// fixture blocklet: a hook script placed anywhere other than main's own
// directory was silently absent from .blocklet/bundle, while one placed
// beside server.js was included with no `files:` entry at all. Colocating
// here is the cheapest correct answer without introducing a new mechanism
// (a `files:` declaration) that nothing else in this repository uses yet.
//
// The migration logic itself lives in ../adapters/runtime/migrate.js so it
// can be unit-tested against a fake command runner; this file is the thin
// process entry point Blocklet Server actually executes.
import { MigrationFailedError, runMigrations } from '../adapters/runtime/migrate.js';

try {
  runMigrations(process.env);
} catch (err) {
  if (err instanceof MigrationFailedError) {
    console.error(err.message);
  } else {
    console.error('migrate: unexpected failure', err);
  }
  process.exit(1);
}
