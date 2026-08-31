// Copy the generated Prisma client into the build output.
//
// WHY THIS SCRIPT EXISTS. `prisma generate` writes the client to
// src/generated/prisma (see prisma/schema.prisma's generator block), which
// is gitignored: it is machine-specific build output, not source. `tsc`
// compiles .ts and copies nothing else, so a plain `npm run build` produces
// dist/src/adapters, dist/src/api, dist/src/domain and no
// dist/src/generated at all -- there is no .ts file under src/generated for
// tsc to compile in the first place, so it never creates the directory.
// src/adapters/storage/prisma.ts imports the client by relative path
// ('../../generated/prisma/index.js'), and Node's ESM resolution has
// nothing to find there once the process is running from dist alone.
//
// It stays invisible in development because `npm run dev` runs from source
// via tsx, which resolves the import against the real src/generated/prisma
// on disk. `npm start` runs `node dist/src/api/server.js`, and
// blocklet.yml's `main` points there too, so a deploy from a clean checkout
// hits ERR_MODULE_NOT_FOUND on the first request that touches storage.
//
// Reproduced 2026-08-30 against a clean worktree with no prior dist:
// `npm run build && npm start` throws
// `Cannot find module '.../dist/src/generated/prisma/index.js'`.
//
// Node's own fs.cp does the work, matching scripts/copy-web-assets.mjs's
// approach for the same reason: a shell `cp -R` in the npm script would be
// shorter and would break on Windows.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export class PrismaClientNotFoundError extends Error {}

// Exported so a test can pin the copy behaviour against a scratch
// directory, the same way src/web/static.ts's resolveWebDir takes a root
// argument rather than only running as an untestable side effect.
export function copyPrismaClient(root) {
  const from = join(root, 'src', 'generated', 'prisma');
  const to = join(root, 'dist', 'src', 'generated', 'prisma');

  if (!existsSync(from)) {
    // `prisma generate` runs before this script in the build chain, so a
    // missing source means the build was assembled out of order or the
    // generator's output path moved. Failing loud here is what stops a
    // deploy from shipping a dist tree that looks complete but throws on
    // the first storage call.
    throw new PrismaClientNotFoundError(
      `copy-prisma-client: ${from} does not exist. Run prisma generate first.`,
    );
  }

  // Unlike dist/src/web (created by tsc compiling src/web/*.ts alongside
  // it), nothing creates dist/src/generated: there is no .ts file under
  // src/generated for tsc to emit next to. This script has to make the
  // directory itself.
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
  return to;
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = dirname(here);
  try {
    const to = copyPrismaClient(root);
    // A silent success here is exactly the failure this script exists to
    // stop being silent: a build log should show the client landed, not
    // imply it.
    console.log(`copy-prisma-client: generated client copied into ${to}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
