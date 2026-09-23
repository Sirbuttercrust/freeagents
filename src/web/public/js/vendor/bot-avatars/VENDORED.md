# bot-avatars, vendored

| | |
|---|---|
| package | `bot-avatars` 0.1.1 (npm), `packages/bot-avatars` in its author's monorepo |
| author | Jakub Antalik |
| licence | MIT, full text in `LICENSE` here, copied byte for byte from the package |
| commit | `5a455ed8102ecb18b7b9800c73fa5be2ee9527ec` |
| what | the non-React core: `src/color.ts`, `draw.ts`, `engine.ts`, `plastic.ts`, `presets.ts`, `shapes.ts`, `ticker.ts`, `types.ts`. `BotAvatar.tsx` is left out because it imports React |
| form | one unminified IIFE, `bot-avatars.js`, that sets `window.BotAvatars` |
| changes | none. The upstream sources are bundled as they are |

## Why one bundled script

The pages load classic `<script>` tags with no module loader and no bundler,
and the upstream core is TypeScript split across eight ES modules. The sources
cannot live under `src/` either: `tsc` would compile them under this repo's
strict settings, which they are not written to. So the build does not touch
this directory at all. `scripts/copy-web-assets.mjs` copies it into `dist`
with the rest of `public/`, and the pages load it like any other shared script.

## Rebuilding

`scripts/vendor-bot-avatars.mjs` rebuilds the bundle from a checkout of the
package at the commit above. It checks every input file against its git blob
id at that commit first, so a checkout at the wrong commit, or a locally
edited file, fails instead of shipping. `tests/web/bot-avatars-vendor.test.ts`
pins the LICENSE bytes and the copyright line.

The FreeAgents side of the avatar (the palette, the DID default and the
mounting) is `../../bots.js`, which is ours and is not vendored.
