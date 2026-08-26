import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Invariant 9, portability (MISSION.md): blocklet.yml and
// src/adapters/runtime/runtime.ts must be deletable in one pass with the
// product still running. This asserts that structurally, the same way
// domain-purity.test.ts asserts import purity: by reading files rather than
// trusting convention.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../..');
const manifestPath = join(repoRoot, 'blocklet.yml');
const packageJsonPath = join(repoRoot, 'package.json');
const srcDir = join(repoRoot, 'src');
const domainDir = join(srcDir, 'domain');
const runtimeAdapterPath = join(srcDir, 'adapters/runtime/runtime.ts');

// This is a line scanner, not a YAML parser. No YAML dependency exists in
// this package and none is being added for packaging alone, so blocklet.yml's
// flat top-level shape (every key starts at column 0) is load bearing: indent
// a key or write folded style and this stops seeing it.
const TOP_LEVEL_SCALAR = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]+(.+?)[ \t]*$/;

function topLevelScalars(source: string): Map<string, string> {
  const scalars = new Map<string, string>();
  for (const line of source.split('\n')) {
    const match = TOP_LEVEL_SCALAR.exec(line);
    if (match?.[1] && match[2] !== undefined) scalars.set(match[1], match[2]);
  }
  return scalars;
}

// Same line-scanner approach as topLevelScalars, but for a top-level key
// whose value is a block (a list or nested mapping) rather than a scalar:
// `key:` with nothing after the colon, followed by indented lines up to the
// next column-0 key.
function topLevelBlock(source: string, key: string): string {
  const lines = source.split('\n');
  const startPattern = new RegExp(`^${key}:[ \\t]*$`);
  const start = lines.findIndex((line) => startPattern.test(line));
  if (start === -1) return '';
  const block: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^[A-Za-z]/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'generated') return [];
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('blocklet packaging', () => {
  const manifest = readFileSync(manifestPath, 'utf8');
  const scalars = topLevelScalars(manifest);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    name: string;
    version: string;
    scripts: Record<string, string>;
  };

  it('has a manifest at the repo root with the required top-level keys', () => {
    expect(existsSync(manifestPath)).toBe(true);
    for (const key of ['name', 'title', 'description', 'version', 'group', 'main']) {
      expect(scalars.has(key), `blocklet.yml is missing top-level key: ${key}`).toBe(true);
    }
  });

  it('agrees with package.json on name and version', () => {
    expect(scalars.get('name')).toBe(packageJson.name);
    expect(scalars.get('version')).toBe(packageJson.version);
  });

  it('points at an entry point that is real and reachable three ways', () => {
    const main = scalars.get('main');
    expect(main).toBe('dist/src/api/server.js');

    // Derived, not hardcoded twice, so renaming the entry breaks one place.
    const sourcePath = (main ?? '').replace(/^dist\//, '').replace(/\.js$/, '.ts');
    expect(existsSync(join(repoRoot, sourcePath)), `entry source missing: ${sourcePath}`).toBe(true);

    expect(packageJson.scripts['start']).toContain(main);
  });

  it('has no secret and no personal data in the manifest (invariant 10)', () => {
    expect(manifest, 'invariant 10: no connection string in blocklet.yml').not.toMatch(/postgres(ql)?:\/\//i);

    const defaultValues = [...manifest.matchAll(/^[ \t]*default:[ \t]*(.*)$/gm)].map((match) => match[1]?.trim() ?? '');
    const isGeneric = (value: string) => value === '' || value === "''" || value === '""';
    const offenders = defaultValues.filter((value) => !isGeneric(value));
    expect(offenders, 'invariant 10: every default: value in blocklet.yml must be empty or generic').toEqual([]);
  });

  it('keeps BLOCKLET_ inside the runtime adapter only (invariant 9)', () => {
    const files = listSourceFiles(srcDir);
    const offenders = files.filter(
      (file) => file !== runtimeAdapterPath && readFileSync(file, 'utf8').includes('BLOCKLET_'),
    );
    expect(
      offenders,
      'invariant 9: BLOCKLET_ leaked outside src/adapters/runtime/runtime.ts, so deleting the adapter would no longer leave a working product',
    ).toEqual([]);
  });

  it('never mentions blocklet in src/domain (invariant 9)', () => {
    const files = listSourceFiles(domainDir);
    const offenders = files.filter((file) => /blocklet/i.test(readFileSync(file, 'utf8')));
    expect(offenders, 'invariant 9: src/domain must not mention blocklet in any case').toEqual([]);
  });

  it('declares an interfaces block that binds the runtime port to BLOCKLET_PORT', () => {
    const block = topLevelBlock(manifest, 'interfaces');
    expect(block, 'blocklet.yml is missing an interfaces: block').not.toBe('');
    expect(block, 'interfaces: must bind port to BLOCKLET_PORT, the only env var runtime.ts reads').toMatch(
      /port:[ \t]*BLOCKLET_PORT/,
    );
    expect(block, 'interfaces: entry is missing a path').toMatch(/path:/);
    expect(block, 'interfaces: entry is missing a prefix').toMatch(/prefix:/);
  });

  it('declares environments with a required DATABASE_URL entry', () => {
    const block = topLevelBlock(manifest, 'environments');
    expect(block, 'blocklet.yml is missing an environments: block').not.toBe('');
    expect(
      block,
      'environments: must declare DATABASE_URL, the env var src/adapters/storage/storage.ts reads to select the storage driver',
    ).toMatch(/name:[ \t]*DATABASE_URL/);
    expect(block, 'the DATABASE_URL entry must be marked required').toMatch(/required:[ \t]*true/);
  });

  it('declares every FREEAGENTS_* env var that src actually reads', () => {
    // The gap this closes: platformIssuerFromEnv read FREEAGENTS_PLATFORM_DID
    // and FREEAGENTS_PLATFORM_SEED while environments: declared neither, so a
    // deployed blocklet silently ran on the ephemeral dev key. Scan src for
    // reads; each one must appear in the manifest.
    const block = topLevelBlock(manifest, 'environments');
    const declared = new Set([...block.matchAll(/name:[ \t]*([A-Z0-9_]+)/g)].map((m) => m[1]));
    const readVars = new Set<string>();
    for (const file of listSourceFiles(srcDir)) {
      const source = readFileSync(file, 'utf8');
      for (const m of source.matchAll(/process\.env(?:\.|\[['"])(FREEAGENTS_[A-Z0-9_]+)/g)) {
        if (m[1]) readVars.add(m[1]);
      }
      for (const m of source.matchAll(/env\[['"](FREEAGENTS_[A-Z0-9_]+)['"]\]/g)) {
        if (m[1]) readVars.add(m[1]);
      }
    }
    const undeclared = [...readVars].filter((name) => !declared.has(name)).sort();
    expect(
      undeclared,
      'every FREEAGENTS_* env var read in src must be declared under environments: in blocklet.yml',
    ).toEqual([]);
  });
});
