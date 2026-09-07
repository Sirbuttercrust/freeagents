// B14b: pure classification rules the real StagingObserver
// (src/adapters/staging/github.ts) needs to turn a GitHub compare
// response into lineShareByCategory, testsDeleted and testsSkipAdded.
// Every function here is synchronous, takes no vendor import and does no
// I/O -- it is domain code by CLAUDE.md's own rule (adapters may import
// domain, never the reverse), and tests/architecture/domain-purity.test.ts
// enforces that structurally by scanning this file's own imports.
//
// This module never touches the diff CONTENT beyond a mechanical scan for
// a skip marker on an added line: no symbol name, no test body, no commit
// message ever leaves this file, matching the refused list
// src/domain/attestation.ts's header states (nothing here builds an
// Attestation field the design record's synthesis row 5 forbids).

import type { LineShareByCategory } from './attestation.js';

// The five categories, in classification-priority order. A path is
// checked against each rule in turn and the first match wins, so a path
// that could satisfy two rules (a test file sitting inside vendor/) is
// classified by the OUTER fact (it is vendored code, not ours to judge as
// a test), never the inner one.
export type PathCategory = keyof LineShareByCategory;

const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'npm-shrinkwrap.json',
  'composer.lock',
  'gemfile.lock',
  'cargo.lock',
  'poetry.lock',
  'pipfile.lock',
  'go.sum',
]);

// Directory segments that mark everything beneath them as code this
// service did not write and has no business classifying as source or
// test -- vendored, full stop, regardless of what the file inside looks
// like.
const VENDORED_DIR_SEGMENTS = ['vendor', 'vendored', 'node_modules', 'third_party', 'thirdparty'];

// Directory segments (or a filename suffix) that mark a path as a build
// artifact rather than something a person wrote by hand.
const GENERATED_DIR_SEGMENTS = ['dist', 'build', 'generated', 'out', '.next', 'target'];
const GENERATED_SUFFIXES = ['.min.js', '.min.css', '.map'];

// Test-file name patterns, covering the common conventions across the
// ecosystems a buyer's repository is likely to use: *.test.*, *.spec.*,
// a __tests__ directory, or a spec/ directory with a _spec suffix
// (Ruby's RSpec convention).
const TEST_NAME_PATTERN = /(^|\/)(__tests__\/.*|.*\.(test|spec)\.[^/.]+|.*_spec\.[^/.]+)$/;
const TEST_DIR_PATTERN = /(^|\/)(tests?|spec)\//;

function segments(path: string): readonly string[] {
  return path.split('/');
}

function hasSegment(path: string, names: readonly string[]): boolean {
  const parts = segments(path);
  return names.some((name) => parts.includes(name));
}

// Classifies one changed path into exactly one of the five categories,
// checked in a fixed priority order: lockfile (an exact well-known
// filename) and vendored (an exact directory segment) are checked first
// because they are facts about WHERE the file lives or WHAT it is,
// regardless of its own name; generated and test follow; source is the
// default for everything else. A test file that happens to sit inside
// vendor/ is vendored, never test -- see this file's own test suite for
// the pinned case.
export function classifyPath(path: string): PathCategory {
  const lower = path.toLowerCase();
  const basename = segments(lower).at(-1) ?? lower;

  if (hasSegment(lower, VENDORED_DIR_SEGMENTS)) return 'vendored';
  if (LOCKFILE_NAMES.has(basename)) return 'lockfile';
  if (hasSegment(lower, GENERATED_DIR_SEGMENTS) || GENERATED_SUFFIXES.some((suffix) => basename.endsWith(suffix))) {
    return 'generated';
  }
  if (TEST_NAME_PATTERN.test(lower) || TEST_DIR_PATTERN.test(lower)) return 'test';
  return 'source';
}

export interface ChangedFileLines {
  readonly path: string;
  readonly linesChanged: number;
}

// Weighted by lines changed per file (additions + deletions), not by
// file count: a single 400-line generated lockfile must not read as "20
// percent generated" beside four one-line source tweaks. Returns all
// zeros for an empty file list rather than dividing by zero.
export function computeLineShareByCategory(files: readonly ChangedFileLines[]): LineShareByCategory {
  const totals: Record<PathCategory, number> = {
    source: 0,
    test: 0,
    lockfile: 0,
    generated: 0,
    vendored: 0,
  };
  let totalLines = 0;
  for (const file of files) {
    const category = classifyPath(file.path);
    totals[category] += file.linesChanged;
    totalLines += file.linesChanged;
  }
  if (totalLines === 0) {
    return { source: 0, test: 0, lockfile: 0, generated: 0, vendored: 0 };
  }
  return {
    source: totals.source / totalLines,
    test: totals.test / totalLines,
    lockfile: totals.lockfile / totalLines,
    generated: totals.generated / totalLines,
    vendored: totals.vendored / totalLines,
  };
}

// Skip markers this service recognizes across the common test runners: a
// buyer's repository may use any of these, and the observer has to
// recognize the marker without knowing which framework is in play.
const SKIP_MARKER_PATTERN = /\.skip\(|(^|\W)xit\(|(^|\W)xdescribe\(|@skip\b/i;

// A patch's ADDED lines only (a unified diff line beginning with a single
// '+', never '++' which marks the `+++ b/path` file header) are scanned
// for a skip marker. A marker on a REMOVED line (a `-` line) means the
// diff took a skip away, the opposite fact, and does not count. This is
// a plain text scan over the patch GitHub's compare endpoint already
// returned -- no file is read, no test framework is invoked, no code
// runs.
export function addedLinesIntroduceSkipMarker(patch: string | null): boolean {
  if (patch === null) return false;
  for (const line of patch.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    if (SKIP_MARKER_PATTERN.test(line)) return true;
  }
  return false;
}

// A path counts as a test file for the testsDeleted/testsSkipAdded facts
// when its own name matches the test conventions classifyPath already
// recognizes -- reusing one rule rather than a second, slightly
// different one, so "is this a test file" never answers differently
// depending on which fact is being computed.
export function isTestFilePath(path: string): boolean {
  return classifyPath(path) === 'test';
}
