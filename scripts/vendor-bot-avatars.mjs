// Rebuild src/web/public/js/vendor/bot-avatars/bot-avatars.js from the
// upstream bot-avatars package at the pinned commit.
//
//   git clone --filter=blob:none --no-checkout https://github.com/Jakubantalik/Libraries.dev /tmp/ba
//   git -C /tmp/ba sparse-checkout set packages/bot-avatars
//   git -C /tmp/ba checkout 5a455ed8102ecb18b7b9800c73fa5be2ee9527ec
//   node scripts/vendor-bot-avatars.mjs /tmp/ba/packages/bot-avatars
//
// The repository URL lives here and not in VENDORED.md, because the vendor
// directory is served under /js and the site does not carry the upstream
// project's name (brief AV2). VENDORED.md names the package, the author and
// the commit, which pins the code exactly.
//
// WHY A BUNDLE AND NOT THE SOURCES. The pages are classic <script> tags with
// no module loader and no bundler, and the upstream core is TypeScript split
// across seven ES modules. tsc would compile .ts under src/ with this repo's
// strict settings (noUncheckedIndexedAccess, exactOptionalPropertyTypes) and
// the upstream code is not written to them, so the sources cannot live under
// src/. esbuild (already in node_modules through vitest and tsx; nothing is
// added to package.json) turns the non-React core into one IIFE that sets
// window.BotAvatars, which is the shape every other shared script here has
// (FAApi, FAIcon). Not minified, so the vendored file still reads as the
// upstream code it is.
//
// Every input is checked against its git blob id at the pinned commit before
// building, so a checkout at the wrong commit or a locally edited file fails
// here instead of shipping.
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const COMMIT = '5a455ed8102ecb18b7b9800c73fa5be2ee9527ec';

// git rev-parse <COMMIT>:packages/bot-avatars/<file>, recorded 2026-09-22.
export const BLOBS = {
  LICENSE: '0e9405a2ee75ce720c665c04568fedda3c07906a',
  'src/color.ts': '6d00e8dfce93abc48b1676fc953f467d53748a86',
  'src/draw.ts': '5d76332af550fe266e3118b28ce8751616a002a1',
  'src/engine.ts': '2c81f87ed1bfc8c929ec563539aba939f1ef1933',
  'src/plastic.ts': '11ceee190b2e3c338cc2576b2d862c32d5d6d5cd',
  'src/presets.ts': '7ad89aac587c0b97e4940c374834a5abf9352aae',
  'src/shapes.ts': '12260ab0be313303782206e17cdf64b9b829a1f2',
  'src/ticker.ts': 'f16f7314c9897cf027b5e03bb0cf8be05bfd2ab1',
  'src/types.ts': 'c818987be533d17aba2a8be3018e34ee76239e95',
};

export function gitBlobId(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

// The non-React surface of upstream src/index.ts, plus the shared frame loop
// (ticker.ts) that upstream's React component uses internally. BotAvatar.tsx
// is the one file left out: it imports React.
const ENTRY = `export { botAvatarPresets, botAvatarTypes, botAvatarFaces, botAvatarStates } from './presets';
export { SHAPE_PATHS as botAvatarShapes, SHAPE_PARTS as botAvatarParts } from './shapes';
export { autoInk, luminance, parseColor, shade } from './color';
export { Sim as BotAvatarSim, restPose } from './engine';
export { draw as drawBotAvatarFrame, OVERSCAN as BOT_AVATAR_OVERSCAN, RISE as BOT_AVATAR_RISE } from './draw';
export { warmPlastic as warmBotAvatarPlastic } from './plastic';
export { subscribe as subscribeBotAvatarTicker, pointer as botAvatarPointer } from './ticker';
`;

const BANNER = `/*! bot-avatars 0.1.1, the non-React core (src/ minus BotAvatar.tsx).
 * Copyright (c) 2026 Jakub Antalik. MIT License, full text in ./LICENSE.
 * Vendored at commit ${COMMIT}, bundled unmodified by
 * scripts/vendor-bot-avatars.mjs into one script that sets window.BotAvatars.
 * See ./VENDORED.md. */`;

async function main() {
  const pkg = process.argv[2];
  if (!pkg) {
    console.error('usage: node scripts/vendor-bot-avatars.mjs <path to packages/bot-avatars at the pinned commit>');
    process.exit(2);
  }
  const bad = Object.entries(BLOBS).filter(([file, want]) => gitBlobId(readFileSync(join(pkg, file))) !== want);
  if (bad.length > 0) {
    console.error(`vendor-bot-avatars: inputs differ from commit ${COMMIT}: ${bad.map(([f]) => f).join(', ')}`);
    process.exit(1);
  }

  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const out = join(root, 'src/web/public/js/vendor/bot-avatars');
  const entry = join(pkg, 'src', '__freeagents_entry.ts');
  writeFileSync(entry, ENTRY);
  try {
    const { buildSync } = await import('esbuild');
    buildSync({
      absWorkingDir: pkg,
      entryPoints: [entry], bundle: true, format: 'iife', globalName: 'BotAvatars', target: 'es2019',
      banner: { js: BANNER }, legalComments: 'inline', outfile: join(out, 'bot-avatars.js'), logLevel: 'info',
    });
  } finally {
    rmSync(entry, { force: true });
  }
  copyFileSync(join(pkg, 'LICENSE'), join(out, 'LICENSE'));
  console.log(`vendor-bot-avatars: rebuilt ${join(out, 'bot-avatars.js')} from ${COMMIT}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
