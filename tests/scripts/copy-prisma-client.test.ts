// Pins the build step that carries the generated Prisma client into dist.
//
// THE SHAPE OF THE BUG. `prisma generate` writes to src/generated/prisma
// (gitignored). `tsc` compiles .ts and copies nothing else, so it creates
// no dist/src/generated at all: there is no .ts file under src/generated
// for it to emit. `npm start` runs `node dist/src/api/server.js`, and
// src/adapters/storage/prisma.ts imports the client by relative path, so a
// clean `npm run build && npm start` throws ERR_MODULE_NOT_FOUND on the
// first import. `npm run dev` never sees it: tsx runs from source and
// resolves the import against the real src/generated/prisma on disk.
//
// This mirrors tests/web/static.test.ts's resolveWebDir coverage: it pins
// the SHIPPED layout, not the development one, against a scratch directory
// rather than the real dist (so it stays green whether or not a local
// build has been run) and asserts the build script actually wires the copy
// in, so the step cannot be dropped from package.json without a red test.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { copyPrismaClient, PrismaClientNotFoundError } from '../../scripts/copy-prisma-client.mjs';

function scratchRoot(): string {
  return mkdtempSync(join(tmpdir(), 'fa-prisma-dist-'));
}

describe('copyPrismaClient', () => {
  it('throws rather than silently doing nothing when the generated client is missing', () => {
    const root = scratchRoot();
    // No src/generated/prisma at all: the state of a tree where
    // `prisma generate` has not run yet.
    expect(() => copyPrismaClient(root)).toThrow(PrismaClientNotFoundError);
  });

  it('copies every file from src/generated/prisma into dist/src/generated/prisma', () => {
    const root = scratchRoot();
    const from = join(root, 'src', 'generated', 'prisma');
    mkdirSync(from, { recursive: true });
    writeFileSync(join(from, 'index.js'), '// generated client entry\n');
    writeFileSync(join(from, 'index.d.ts'), '// generated client types\n');
    mkdirSync(join(from, 'runtime'), { recursive: true });
    writeFileSync(join(from, 'runtime', 'library.js'), '// runtime\n');

    // dist/src/generated does not exist yet: unlike dist/src/web (created
    // by tsc compiling files that sit beside it), nothing else creates
    // this directory. The function must make it.
    const to = copyPrismaClient(root);

    expect(to).toBe(join(root, 'dist', 'src', 'generated', 'prisma'));
    expect(existsSync(join(to, 'index.js'))).toBe(true);
    expect(existsSync(join(to, 'index.d.ts'))).toBe(true);
    expect(existsSync(join(to, 'runtime', 'library.js'))).toBe(true);
    expect(readFileSync(join(to, 'index.js'), 'utf8')).toContain('generated client entry');
  });

  it('the build script carries the copy step, so it cannot be dropped silently', () => {
    // The mechanism is one line in package.json, and a refactor that
    // rewrites the build command is exactly when it gets lost, the same
    // risk tests/web/static.test.ts pins for copy-web-assets.
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const build = pkg.scripts['build'] ?? '';
    expect(build).toContain('copy-prisma-client');
    // Generation has to happen before the copy, or the copy runs against a
    // stale or absent source directory.
    expect(build.indexOf('prisma:generate')).toBeLessThan(build.indexOf('copy-prisma-client'));
  });
});
