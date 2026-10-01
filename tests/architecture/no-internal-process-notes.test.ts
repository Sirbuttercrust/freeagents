import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// This repository is public (CLAUDE.md). A comment or a test title that points
// at the project's private build process, such as an internal reviewer, a
// private defect list, a private planning file, a review round or a private
// task board, tells a reader to look at something they cannot see. This check
// fails any line under src/ or tests/ that does. Keep the reason, drop the
// pointer, or cite a public file (MISSION.md, spec/entities.md,
// spec/wireframe/DESIGN.md, SITEMAP.md).

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SELF = 'tests/architecture/no-internal-process-notes.test.ts';
const EXTENSIONS = /\.(ts|js|mjs|cjs|html|css)$/;
const VENDOR_PREFIX = 'src/web/public/js/vendor/';

// The seat names must not appear anywhere in the public tree, this file
// included, so the seat class is a set of SHA-256 hashes of the lowercase
// names. Every capitalised word of a line is lowercased, hashed and looked up.
const SEAT_HASHES: ReadonlySet<string> = new Set([
  'ca98e82217aeefd8bc2bf062085f8b9aeac6c6ccec07173cf710eadf26d83786',
  '50bc66d8aae5ae9020e15d53a103ddf91de202b3af5aeb3fd124b6861cdd2405',
  'b15ef88da4c1c46c6c9e7483f8af075f8869f68d7a190ac38add53aa049f057f',
  'a8b51e95fe15708a5f253f567e72f00f052cd6c11f013b19c5b122bc52b98073',
  '4a9909a9516d02fd4c729a45922398fb41c398c235423a5304085bc923a8db67',
  '9b2153df65c7cba8a514938e2d3254a32cc0e75f6d032572e45f2b6bb124c970',
  '0a348ac4d94f9da05a7866a206ed7936ad3f5504e659ac1c814e63adfcebff81',
]);

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function hasSeatName(line: string, hashes: ReadonlySet<string>): boolean {
  const words = line.match(/\b[A-Z][a-z]+\b/g) ?? [];
  return words.some((word) => hashes.has(sha256(word.toLowerCase())));
}

// The other six classes, as the measure that scoped this cleanup defines them.
const PATTERNS: Record<string, RegExp[]> = {
  reviewer: [
    /\bProof\b(?='s|,? (r\d|round|review|defect|D\d|PASS|FAIL|audit|ran|found|said|replayed|caught|flagged|noted|measured)\b)|\(Proof\b|\bqa's\b/,
    /\bqa (proof|round|review|defect|d\d|r\d)\b/i,
  ],
  privfile: [/\bbugs\.md\b|\b(MAP|PLAN)\.md\b/],
  ledger: [
    /\b(bug|defect|standing|launch) ledger\b/i,
    /\bstrikes? (on|in) the ledger\b|\bthe ledger \(/,
  ],
  round: [
    /\b(review|audit|fix|repair|qa|gate) rounds?\b/i,
    /\bround \d+\b(?!\.\d)/,
    /\b(review|proof|qa|audit)\s+r\d\b/i,
    /\b[A-Z][A-Z0-9-]*\d[a-z]? r\d\b/,
  ],
  boardid: [/\bt_[0-9a-f]{8}\b|\bcomment \d{3,4}\b/],
  rehearsal: [/\brehearsal s\d+\b|\b[A-Z]\d rehearsal\b/],
};

// One planted line per pattern and per alternative, so a pattern that stops
// matching its own class turns a control red.
const PLANTED: Record<string, string[]> = {
  reviewer: [
    '// Proof round 2 found that the header is dropped',
    '// HEIC (Proof r1, defect 1): the binaries ship libvips',
    "// the qa's ruling on this route",
    '// QA round 3 asked for a second case',
  ],
  privfile: [
    '// see bugs.md B1',
    '// the rule in MAP.md says so',
    '// the sequence is in PLAN.md',
  ],
  ledger: [
    '// B23 (bug ledger): the retry',
    '// the defect ledger lists it',
    '// a strike on the ledger for this',
    '// the ledger (row 4) names it',
  ],
  round: [
    '// the review round asked for this',
    '// fix round 2 moved the check',
    '// raised in round 3',
    '// Proof r2 wanted the case',
    '// ORG1 r2 added the guard',
  ],
  boardid: [
    '// D2 (task t_8a82c865): the durable half',
    '// as in comment 561',
  ],
  rehearsal: [
    '// B29 (C1 rehearsal s7): a well-formed request',
    '// found at rehearsal s2',
  ],
};

// Sentences that look close to a pointer but are product words or arithmetic.
const PRODUCT_LINES = [
  'Proof comes in layers.',
  'GitHub proof is one click.',
  '// Proof the page did fill its identity strip',
  'Math.sqrt(r2)',
  'Math.round(2.5)',
  'a round 0.5 figure',
  'the review window ends',
  'the ArcBlock ledger confirms it',
];

function matchesClassPattern(line: string): boolean {
  return Object.values(PATTERNS).some((list) => list.some((re) => re.test(line)));
}

function pointsAtPrivateProcess(line: string): boolean {
  return matchesClassPattern(line) || hasSeatName(line, SEAT_HASHES);
}

// Files that another open change is editing right now. The list is empty: a
// path goes in only while such a change holds that file, and comes out when
// that change lands. Adding a path here is never how a red line is fixed: fix
// the line.
const PENDING: readonly string[] = [];

function gitList(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', 'src', 'tests'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
  return out.split('\0').filter(Boolean);
}

const tracked = gitList();
const listing = tracked.filter(
  (path) => EXTENSIONS.test(path) && !path.startsWith(VENDOR_PREFIX) && path !== SELF,
);
const pending = new Set(PENDING);
const scanned = listing.filter((path) => !pending.has(path));

function offendingLines(path: string): string[] {
  const text = readFileSync(resolve(root, path), 'utf8');
  const found: string[] = [];
  text.split('\n').forEach((line, index) => {
    if (pointsAtPrivateProcess(line)) found.push(`${path}:${index + 1}: ${line.trim().slice(0, 160)}`);
  });
  return found;
}

describe('no internal process notes in the public source', () => {
  it.each(scanned.map((path) => [path]))('%s has no pointer to the private build process', (path) => {
    const found = offendingLines(path);
    expect(
      found,
      [
        'These lines point at the project\'s private build process (an internal reviewer, a private defect list or planning file, a review round or a task board). Readers of this public repository cannot see any of those.',
        'Keep the reason in the sentence and drop the pointer, or cite a public file (MISSION.md, spec/entities.md, spec/wireframe/DESIGN.md, SITEMAP.md) when it states the rule.',
        ...found,
      ].join('\n'),
    ).toEqual([]);
  });

  describe('controls', () => {
    it('every pattern of every class matches a planted line of its class', () => {
      for (const [cls, list] of Object.entries(PATTERNS)) {
        expect(list.length, `class ${cls} has no pattern`).toBeGreaterThan(0);
        for (const re of list) {
          const hit = (PLANTED[cls] ?? []).some((line) => re.test(line));
          expect(hit, `no planted ${cls} line matches ${re}`).toBe(true);
        }
      }
    });

    it('every planted line is matched by a pattern of its own class', () => {
      for (const [cls, lines] of Object.entries(PLANTED)) {
        for (const line of lines) {
          const hit = (PATTERNS[cls] ?? []).some((re) => re.test(line));
          expect(hit, `planted ${cls} line not matched: ${line}`).toBe(true);
        }
      }
    });

    it('none of the patterns matches a product sentence', () => {
      for (const line of PRODUCT_LINES) {
        expect(pointsAtPrivateProcess(line), `matched a product sentence: ${line}`).toBe(false);
      }
    });

    it('the seat matcher flags a name once its hash is in the set, and flags nothing with the real set', () => {
      const probe = '// Zyxwv built this';
      const extended = new Set([...SEAT_HASHES, sha256('zyxwv')]);
      expect(hasSeatName(probe, extended)).toBe(true);
      expect(hasSeatName(probe, SEAT_HASHES)).toBe(false);
      expect(SEAT_HASHES.size).toBe(7);
    });

    it('the seat matcher only looks at capitalised words', () => {
      const extended = new Set([...SEAT_HASHES, sha256('zyxwv')]);
      expect(hasSeatName('// zyxwv built this', extended)).toBe(false);
    });

    it('the real hash set flags no word of the product sentences or the planted lines', () => {
      const lines = [...PRODUCT_LINES, ...Object.values(PLANTED).flat()];
      for (const line of lines) {
        expect(hasSeatName(line, SEAT_HASHES), line).toBe(false);
      }
    });

    it('PENDING is sorted and holds no duplicate', () => {
      expect([...PENDING]).toEqual([...new Set(PENDING)].sort());
    });

    it('every path in PENDING is tracked', () => {
      const trackedSet = new Set(tracked);
      const missing = PENDING.filter((path) => !trackedSet.has(path));
      expect(missing, 'PENDING paths that are not tracked files').toEqual([]);
    });

    it('the listing holds more than 400 files before PENDING is applied', () => {
      expect(listing.length).toBeGreaterThan(400);
    });

    it('the scanned set is the listing minus PENDING, and holds more than 300 files', () => {
      expect(scanned.length).toBe(listing.length - PENDING.filter((p) => listing.includes(p)).length);
      expect(scanned.length).toBeGreaterThan(300);
    });
  });
});
