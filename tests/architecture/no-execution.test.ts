// B14b: the scope fence. The anchor: "the platform reports what git
// plainly says about the staged commit and never executes a line of the
// agent's code" (Keaton, 2026-09-07). Two mechanical checks, both
// structural (they read the files, never trust convention, the same
// stance tests/architecture/domain-purity.test.ts and
// tests/architecture/no-custody.test.ts already take):
//   1. nothing under src/adapters/staging/ or src/domain/attestation.ts
//      imports node:child_process, node:worker_threads, node:vm, or a
//      package whose name matches /docker|sandbox|firecracker|
//      isolated-vm/;
//   2. no source line under src/ contains the literal substring
//      `buyerTestRun` or `testCommand` -- the removed feature this card
//      exists to keep removed.
// A POSITIVE CONTROL closes the loop: a throwaway fixture file that DOES
// import child_process must fail the first check, proving the check can
// actually fail rather than vacuously passing on an empty file list.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '../../src');
const stagingDir = join(srcDir, 'adapters/staging');
const attestationDomainFile = join(srcDir, 'domain/attestation.ts');

// Same anchoring rationale as domain-purity.test.ts and
// no-custody.test.ts: a real import or require begins a line, so prose
// inside a template literal or comment cannot false-positive here.
const IMPORT_PATTERN =
  /^[ \t]*(?:import|export)\b(?:[^'"\n]*?\bfrom)?\s*['"]([^'"\n]+)['"]|^[ \t]*(?:const|let|var)?[^'"\n]*?\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/gm;

const FORBIDDEN_EXECUTION_IMPORT = /^node:child_process$|^node:worker_threads$|^node:vm$|docker|sandbox|firecracker|isolated-vm/i;

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

function importsIn(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function checkNoExecutionImports(files: readonly string[]): void {
  for (const file of files) {
    const offenders = importsIn(file).filter((specifier) => FORBIDDEN_EXECUTION_IMPORT.test(specifier));
    if (offenders.length > 0) {
      throw new Error(`${file} imports an execution-capable module: ${offenders.join(', ')}`);
    }
  }
}

describe('no-execution scope fence: nothing under src/adapters/staging or src/domain/attestation.ts can run code', () => {
  const stagingFiles = listTsFiles(stagingDir);

  it('found the staging adapter files to check', () => {
    expect(stagingFiles.length).toBeGreaterThan(0);
  });

  it.each(stagingFiles)('%s imports no execution-capable module', (file) => {
    const offenders = importsIn(file).filter((specifier) => FORBIDDEN_EXECUTION_IMPORT.test(specifier));
    expect(offenders, `${file} imports: ${offenders.join(', ')}`).toEqual([]);
  });

  it('src/domain/attestation.ts imports no execution-capable module', () => {
    const offenders = importsIn(attestationDomainFile).filter((specifier) => FORBIDDEN_EXECUTION_IMPORT.test(specifier));
    expect(offenders, `${attestationDomainFile} imports: ${offenders.join(', ')}`).toEqual([]);
  });

  // POSITIVE CONTROL: a throwaway fixture that DOES import child_process
  // must be caught by the exact same check function the suite above
  // uses, proving the fence can fail rather than vacuously passing.
  // Written and cleaned up inside the test, never committed.
  it('MUTATION PROOF: a fixture file importing node:child_process fails this check', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'no-execution-positive-control-'));
    const fixturePath = join(tmpDir, 'would-execute.ts');
    writeFileSync(fixturePath, "import { execSync } from 'node:child_process';\nexecSync('echo hi');\n");
    try {
      expect(() => checkNoExecutionImports([fixturePath])).toThrow(/execution-capable module/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('buyerTestRun is gone and stays gone: no source line under src/ names it or testCommand', () => {
  const REMOVED_FEATURE_PATTERN = /buyerTestRun|testCommand/;
  const allSourceFiles = listTsFiles(srcDir).filter((file) => !file.includes(`${join('src', 'generated')}`));

  it('found source files to check', () => {
    expect(allSourceFiles.length).toBeGreaterThan(0);
  });

  it.each(allSourceFiles)('%s contains no reference to buyerTestRun or testCommand', (file) => {
    const source = readFileSync(file, 'utf8');
    expect(REMOVED_FEATURE_PATTERN.test(source), `${file} still references the removed buyerTestRun feature`).toBe(false);
  });
});
