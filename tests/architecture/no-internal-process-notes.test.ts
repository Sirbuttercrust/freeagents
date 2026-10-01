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

// Files other open work is editing, or that the second half of this cleanup
// has yet to reach. Each path leaves this set when its own cleanup lands.
// Adding a path here is never how a red line is fixed: fix the line.
const PENDING: readonly string[] = [
  'src/adapters/config/report.ts',
  'src/adapters/identity/did-abt-resolver.ts',
  'src/adapters/payment/abt-did-connect.ts',
  'src/adapters/payment/abt-usd-rate.ts',
  'src/adapters/payment/abt.ts',
  'src/adapters/payment/route-support.ts',
  'src/adapters/payment/types.ts',
  'src/adapters/payment/usdc-half-paid-storage-prisma.ts',
  'src/adapters/payment/usdc-half-paid-storage-types.ts',
  'src/adapters/payment/usdc.ts',
  'src/adapters/storage/memory.ts',
  'src/adapters/storage/prisma.ts',
  'src/adapters/storage/storage.ts',
  'src/adapters/storage/types.ts',
  'src/api/app.ts',
  'src/api/rate-limit-classes.ts',
  'src/api/rate-limit-middleware.ts',
  'src/api/server.ts',
  'src/api/stream-caps.ts',
  'src/domain/job.ts',
  'src/domain/message.ts',
  'src/domain/payment.ts',
  'src/web/pages/agent.html',
  'src/web/pages/agentsettings.html',
  'src/web/pages/agreement.html',
  'src/web/pages/browse.html',
  'src/web/pages/conduct.html',
  'src/web/pages/credential.html',
  'src/web/pages/dashboard.html',
  'src/web/pages/deposit.html',
  'src/web/pages/hire.html',
  'src/web/pages/how.html',
  'src/web/pages/incoming.html',
  'src/web/pages/job.html',
  'src/web/pages/landing.html',
  'src/web/pages/listagent.html',
  'src/web/pages/messages.html',
  'src/web/pages/myagents.html',
  'src/web/pages/myjobs.html',
  'src/web/pages/notfound.html',
  'src/web/pages/notifications.html',
  'src/web/pages/operator.html',
  'src/web/pages/operatorjob.html',
  'src/web/pages/outcomes.html',
  'src/web/pages/private-repos.html',
  'src/web/pages/pullrequest.html',
  'src/web/pages/review.html',
  'src/web/pages/settings.html',
  'src/web/pages/signin.html',
  'src/web/pages/staged.html',
  'src/web/pages/verify.html',
  'src/web/public/css/league.css',
  'src/web/public/js/pages/api.js',
  'src/web/public/js/pages/job.js',
  'src/web/public/js/pages/nav.js',
  'src/web/public/js/pages/operator.js',
  'src/web/public/js/pages/operatorjob.js',
  'src/web/public/js/pages/staged.js',
  'src/web/public/js/usdc-wallet.js',
  'tests/adapters/config/report.test.ts',
  'tests/adapters/payment/abt.test.ts',
  'tests/adapters/payment/rail-door-eligibility.test.ts',
  'tests/adapters/payment/usdc.test.ts',
  'tests/adapters/prisma.test.ts',
  'tests/adapters/schema.test.ts',
  'tests/api/job-attestation.test.ts',
  'tests/api/job-cited-close.test.ts',
  'tests/api/job-confirm-github-unverified.test.ts',
  'tests/api/job-confirm-moved-repository.test.ts',
  'tests/api/job-confirm-repository-inaccessible.test.ts',
  'tests/api/job-confirm-staging-invited.test.ts',
  'tests/api/job-confirm.test.ts',
  'tests/api/job-criteria.test.ts',
  'tests/api/job-deem-asks-github.test.ts',
  'tests/api/job-deemed-completion.test.ts',
  'tests/api/job-deposit-locks-terms.test.ts',
  'tests/api/job-deposit-readiness.test.ts',
  'tests/api/job-deposit-repository-check.test.ts',
  'tests/api/job-github-access-needed.test.ts',
  'tests/api/job-invariant2.test.ts',
  'tests/api/job-lapse-enforcement.test.ts',
  'tests/api/job-merge-restart.test.ts',
  'tests/api/job-merge.test.ts',
  'tests/api/job-multi-agent-request.test.ts',
  'tests/api/job-open-rail.test.ts',
  'tests/api/job-operator-acts.test.ts',
  'tests/api/job-payment-abt.test.ts',
  'tests/api/job-payment-already-paid.test.ts',
  'tests/api/job-payment-rail-door-eligibility.test.ts',
  'tests/api/job-payment-status-and-rail-guards.test.ts',
  'tests/api/job-payment-usdc.test.ts',
  'tests/api/job-plain-close.test.ts',
  'tests/api/job-pull-request.test.ts',
  'tests/api/job-redo.test.ts',
  'tests/api/job-stage-default-observer.test.ts',
  'tests/api/job-stage-repo.test.ts',
  'tests/api/job-staged-paid.test.ts',
  'tests/api/job-withdraw.test.ts',
  'tests/api/rate-limit-classes.test.ts',
  'tests/api/rate-limit-e2e.test.ts',
  'tests/domain/job-open-rail.test.ts',
  'tests/domain/payment.test.ts',
  'tests/helpers/abt-fixtures.ts',
  'tests/helpers/open-rail-fixtures.ts',
  'tests/web/bots-motion.test.ts',
  'tests/web/conduct.test.ts',
  'tests/web/dashboard.test.ts',
  'tests/web/deposit.test.ts',
  'tests/web/hire-flow.test.ts',
  'tests/web/hire-journey-simple.test.ts',
  'tests/web/incoming.test.ts',
  'tests/web/job-wireframe.test.ts',
  'tests/web/nav-auth.test.ts',
  'tests/web/operator-roster.test.ts',
  'tests/web/operatorjob.test.ts',
  'tests/web/outcomes.test.ts',
  'tests/web/staged.test.ts',
  'tests/web/usdc-wallet.test.ts',
  'tests/web/wireframe-conformance.test.ts',
];

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

    it('PENDING takes some files out of the listing and leaves the rest scanned', () => {
      expect(scanned.length).toBe(listing.length - PENDING.filter((p) => listing.includes(p)).length);
      expect(scanned.length).toBeGreaterThan(300);
    });
  });
});
