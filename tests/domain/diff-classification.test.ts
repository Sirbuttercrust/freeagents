// B14b: pure classification rules the real StagingObserver
// (src/adapters/staging/github.ts) needs to turn a GitHub compare
// response into lineShareByCategory, testsDeleted and testsSkipAdded.
// Kept in src/domain because they are pure string/number operations with
// no vendor import and no I/O -- exactly the CLAUDE.md domain-purity
// stance tests/architecture/domain-purity.test.ts enforces structurally.
import { describe, expect, it } from 'vitest';
import {
  addedLinesIntroduceSkipMarker,
  classifyPath,
  computeLineShareByCategory,
} from '../../src/domain/diff-classification.js';

describe('classifyPath: the five categories the design record names', () => {
  it('classifies a common lockfile as lockfile', () => {
    expect(classifyPath('package-lock.json')).toBe('lockfile');
    expect(classifyPath('yarn.lock')).toBe('lockfile');
    expect(classifyPath('pnpm-lock.yaml')).toBe('lockfile');
    expect(classifyPath('Gemfile.lock')).toBe('lockfile');
    expect(classifyPath('Cargo.lock')).toBe('lockfile');
    expect(classifyPath('go.sum')).toBe('lockfile');
    expect(classifyPath('poetry.lock')).toBe('lockfile');
    expect(classifyPath('composer.lock')).toBe('lockfile');
  });

  it('classifies a path under a vendored directory as vendored', () => {
    expect(classifyPath('vendor/lib/thing.go')).toBe('vendored');
    expect(classifyPath('node_modules/left-pad/index.js')).toBe('vendored');
    expect(classifyPath('third_party/protobuf/foo.proto')).toBe('vendored');
  });

  it('classifies a build/dist output path as generated', () => {
    expect(classifyPath('dist/index.js')).toBe('generated');
    expect(classifyPath('build/main.js')).toBe('generated');
    expect(classifyPath('src/generated/prisma/index.ts')).toBe('generated');
    expect(classifyPath('assets/app.min.js')).toBe('generated');
  });

  it('classifies a test file by name pattern as test', () => {
    expect(classifyPath('src/foo.test.ts')).toBe('test');
    expect(classifyPath('src/foo.spec.ts')).toBe('test');
    expect(classifyPath('tests/domain/attestation.test.ts')).toBe('test');
    expect(classifyPath('__tests__/thing.js')).toBe('test');
    expect(classifyPath('spec/models/user_spec.rb')).toBe('test');
  });

  it('classifies an ordinary source file as source, the default', () => {
    expect(classifyPath('src/domain/job.ts')).toBe('source');
    expect(classifyPath('README.md')).toBe('source');
    expect(classifyPath('packages/ui/src/index.ts')).toBe('source');
  });

  it('a vendored path wins over a test-looking name inside it (checked first)', () => {
    expect(classifyPath('vendor/pkg/thing.test.js')).toBe('vendored');
  });
});

describe('computeLineShareByCategory: weighted by lines changed per file', () => {
  it('splits share proportionally across categories', () => {
    const share = computeLineShareByCategory([
      { path: 'src/a.ts', linesChanged: 60 },
      { path: 'src/a.test.ts', linesChanged: 30 },
      { path: 'package-lock.json', linesChanged: 10 },
    ]);
    expect(share).toEqual({ source: 0.6, test: 0.3, lockfile: 0.1, generated: 0, vendored: 0 });
  });

  it('an empty file list is all zeros, never a divide-by-zero NaN', () => {
    expect(computeLineShareByCategory([])).toEqual({
      source: 0,
      test: 0,
      lockfile: 0,
      generated: 0,
      vendored: 0,
    });
  });

  it('a single-category diff reports 1 for that category and 0 for the rest', () => {
    const share = computeLineShareByCategory([{ path: 'src/only.ts', linesChanged: 5 }]);
    expect(share).toEqual({ source: 1, test: 0, lockfile: 0, generated: 0, vendored: 0 });
  });
});

describe('addedLinesIntroduceSkipMarker: static text scan, never an execution', () => {
  it('detects .skip( on an added line', () => {
    const patch = '@@ -1,3 +1,3 @@\n-it("works", () => {});\n+it.skip("works", () => {});\n context line';
    expect(addedLinesIntroduceSkipMarker(patch)).toBe(true);
  });

  it('detects xit( on an added line', () => {
    const patch = '@@ -1,1 +1,1 @@\n+xit("broken for now", () => {});';
    expect(addedLinesIntroduceSkipMarker(patch)).toBe(true);
  });

  it('detects xdescribe( on an added line', () => {
    const patch = '@@ -1,1 +1,1 @@\n+xdescribe("suite", () => {});';
    expect(addedLinesIntroduceSkipMarker(patch)).toBe(true);
  });

  it('detects @skip on an added line', () => {
    const patch = '@@ -1,1 +1,1 @@\n+  @skip\n+  def test_thing(self): pass';
    expect(addedLinesIntroduceSkipMarker(patch)).toBe(true);
  });

  it('a skip marker on a REMOVED line does not count: the diff added nothing new', () => {
    const patch = '@@ -1,1 +1,1 @@\n-it.skip("works", () => {});\n+it("works", () => {});';
    expect(addedLinesIntroduceSkipMarker(patch)).toBe(false);
  });

  it('a patch with no skip marker anywhere is false', () => {
    const patch = '@@ -1,1 +1,1 @@\n-it("works", () => {});\n+it("still works", () => {});';
    expect(addedLinesIntroduceSkipMarker(patch)).toBe(false);
  });

  it('the diff hunk header line (+++/---) is never mistaken for an added line', () => {
    const patch = '--- a/foo.test.ts\n+++ b/foo.test.ts\n@@ -1,1 +1,1 @@\n it("works", () => {});';
    expect(addedLinesIntroduceSkipMarker(patch)).toBe(false);
  });

  it('a null patch (binary file) is false, never a crash', () => {
    expect(addedLinesIntroduceSkipMarker(null)).toBe(false);
  });
});
