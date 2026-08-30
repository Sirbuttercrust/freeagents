// Copy the web surface's non-TypeScript files into the build output.
//
// WHY THIS SCRIPT EXISTS. `tsc` compiles .ts and copies nothing else, so a
// plain `npm run build` produces dist/src/web/static.js with no pages/ and
// no public/ beside it. resolveWebDir then walks UP looking for its marker,
// finds the SOURCE tree two levels above dist, and serves happily. That is
// why the gap is invisible in development and fatal in a package that ships
// only dist: blocklet.yml points main at dist/src/api/server.js, and there
// the walk runs out of tree and throws.
//
// Measured 2026-08-30 with tests/manual/dist-layout-probe.ts against a
// temporary dist-only tree: WebAssetsNotFoundError, every time.
//
// Node's own fs.cp does the work. A shell `cp -R` in the npm script would be
// shorter and would break on Windows, and this repo's package.json is the
// only place a contributor on another platform meets the build.
import { cpSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);

const from = join(root, 'src', 'web');
const to = join(root, 'dist', 'src', 'web');

if (!existsSync(to)) {
  // tsc runs first, so its output directory must already be there. Missing
  // means the build was skipped or the layout moved, and copying into a
  // directory that should exist but does not would hide that.
  console.error(`copy-web-assets: ${to} does not exist. Run tsc first.`);
  process.exit(1);
}

for (const dir of ['pages', 'public']) {
  const src = join(from, dir);
  if (!existsSync(src)) {
    console.error(`copy-web-assets: ${src} is missing. The web surface is incomplete.`);
    process.exit(1);
  }
  cpSync(src, join(to, dir), { recursive: true });
}

// Report what landed, so a build log shows the assets rather than implying
// them. A silent success here is exactly the failure this script exists to
// stop being silent.
const pages = readdirSync(join(to, 'pages')).length;
console.log(`copy-web-assets: ${pages} pages and the public tree copied into dist/src/web`);
