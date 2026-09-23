// The vendored bot-avatars core (src/web/public/js/vendor/bot-avatars/).
//
// The LICENSE is compared against its git blob id at the pinned commit, the
// same id scripts/vendor-bot-avatars.mjs checks the upstream checkout
// against, so "byte for byte" is a hash rather than a promise. The rest of
// the checks keep the terms the MIT licence sets and the brief adds: the
// copyright line travels with the code, the commit is named, and the
// monorepo's own site name appears nowhere a visitor could read it.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// @ts-expect-error: a plain .mjs build script with no type declarations.
import { BLOBS, COMMIT } from '../../scripts/vendor-bot-avatars.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const vendor = join(here, '../../src/web/public/js/vendor/bot-avatars');
const webRoot = join(here, '../../src/web');

function gitBlobId(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('the vendored bot-avatars core', () => {
  it('ships exactly LICENSE, VENDORED.md and the one bundle', () => {
    expect(readdirSync(vendor).sort()).toEqual(['LICENSE', 'VENDORED.md', 'bot-avatars.js']);
  });

  it('LICENSE is upstream\u2019s, byte for byte, at the pinned commit', () => {
    expect(COMMIT).toBe('5a455ed8102ecb18b7b9800c73fa5be2ee9527ec');
    const license = readFileSync(join(vendor, 'LICENSE'));
    expect(gitBlobId(license)).toBe((BLOBS as Record<string, string>).LICENSE);
    expect(license.toString('utf8')).toMatch(/^MIT License/);
  });

  it('the bundle carries the copyright line and names the commit', () => {
    const head = readFileSync(join(vendor, 'bot-avatars.js'), 'utf8').slice(0, 600);
    expect(head).toContain('Copyright (c) 2026 Jakub Antalik');
    expect(head).toContain(COMMIT);
  });

  it('VENDORED.md names the commit, the licence and every input file', () => {
    const doc = readFileSync(join(vendor, 'VENDORED.md'), 'utf8');
    expect(doc).toContain(COMMIT);
    expect(doc).toContain('MIT');
    for (const file of Object.keys(BLOBS as Record<string, string>)) {
      if (file === 'LICENSE') continue;
      expect(doc, file).toContain(file.replace('src/', ''));
    }
  });

  it('the bundle loads as a classic script and exposes the core bots.js calls', () => {
    const sandbox: Record<string, unknown> = {};
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(join(vendor, 'bot-avatars.js'), 'utf8'), sandbox);
    const BA = sandbox.BotAvatars as Record<string, unknown> | undefined;
    expect(BA, 'window.BotAvatars was not defined').toBeTruthy();
    for (const name of ['drawBotAvatarFrame', 'BotAvatarSim', 'botAvatarPresets', 'autoInk']) {
      expect(BA![name], name).toBeTruthy();
    }
    expect(Object.keys(BA!.botAvatarPresets as object).length).toBe(18);
  });

  it('no file served to a browser says "Libraries.dev"', () => {
    const offenders = walk(webRoot)
      .filter((p) => /\.(html|js|css|svg|json|txt)$/.test(p))
      .filter((p) => /libraries\.dev/i.test(readFileSync(p, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
