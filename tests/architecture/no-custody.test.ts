// Invariant 12 (MISSION.md, 2026-09-05): buyer to operator, never through
// us. Until 2026-09-05 this file asserted the v1 stance that no money moved
// at all (R-26, ENT-9.1). The rail is now decided and verified on chain, so
// the assertion narrows to what must stay true forever: the platform never
// holds funds, never builds payment infrastructure, and never appears as an
// input owner on any transaction the code can build.
//
// Three fences remain mechanical:
//   1. no payment-processor dependency (Stripe and friends, Payment Kit);
//   2. no custody vocabulary in src outside the payment adapter directory,
//      and inside it, no hold/escrow/refund/payout at all;
//   3. every transaction builder in src/adapters/payment lists the platform
//      only as an output owner (checked by tests/adapters/payment, which
//      this file asserts exists once the adapter does).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { recordSettlementIntent, type SettlementState } from '../../src/domain/settlement.js';
import type { Job } from '../../src/domain/job.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '../../src');
const paymentDir = join(srcDir, 'adapters/payment');
const packageJsonPath = join(here, '../../package.json');
const schemaPath = join(here, '../../prisma/schema.prisma');

// Same anchoring rationale as tests/architecture/domain-purity.test.ts: a
// real import or require begins a line, so prose inside a template literal
// (e.g. an error message quoting "from") cannot false-positive here.
const IMPORT_PATTERN =
  /^[ \t]*(?:import|export)\b(?:[^'"\n]*?\bfrom)?\s*['"]([^'"\n]+)['"]|^[ \t]*(?:const|let|var)?[^'"\n]*?\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/gm;

// Payment processors and Payment Kit: examined 2026-09-01 and set aside
// (no escrow primitive; staking is merchant custody). The chain client
// packages (@ocap/*, @arcblock/did-connect-*) are allowed; they build a
// transaction the buyer signs, they do not process payments.
const PAYMENT_PATTERN = /stripe|paypal|braintree|adyen|@blocklet\/payment|payment-js/i;
// Outside src/adapters/payment nothing may speak of moving money. Inside it,
// the words that would mean the platform holds or returns funds are still
// forbidden: there is no such code path to name.
const MONEY_MOVEMENT_PATTERN = /transfer|payout|balance|custody|refund|charge|escrow/i;
const CUSTODY_PATTERN = /custody|escrow|refund|payout|hold\s*funds|withhold/i;

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.name === 'generated') return [];
    if (entry.isDirectory()) return listSourceFiles(full);
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

const sourceFiles = listSourceFiles(srcDir);

describe('no payment dependency is imported', () => {
  it('found source files to check', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it.each(sourceFiles)('%s imports no payment package', (file) => {
    const offenders = importsIn(file).filter((specifier) => PAYMENT_PATTERN.test(specifier));
    expect(offenders, `${file} imports: ${offenders.join(', ')}`).toEqual([]);
  });
});

describe('no payment dependency is installed', () => {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it('no dependency name matches the payment pattern', () => {
    const names = [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
    ];
    const offenders = names.filter((name) => PAYMENT_PATTERN.test(name));
    expect(offenders).toEqual([]);
  });
});

function offendingLines(file: string, pattern: RegExp): string[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const offenders: string[] = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    if (pattern.test(line)) {
      offenders.push(`${file}:${index + 1}: ${trimmed.slice(0, 80)}`);
    }
  });
  return offenders;
}

const outsidePayment = sourceFiles.filter((file) => !file.startsWith(paymentDir));
const insidePayment = sourceFiles.filter((file) => file.startsWith(paymentDir));

describe('money moves only inside src/adapters/payment', () => {
  it.each(outsidePayment)('%s has no line using money-movement vocabulary', (file) => {
    const offenders = offendingLines(file, MONEY_MOVEMENT_PATTERN);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('the payment adapter directory, when present, never speaks of custody, escrow, refund or payout', () => {
    for (const file of insidePayment) {
      const offenders = offendingLines(file, CUSTODY_PATTERN);
      expect(offenders, offenders.join('\n')).toEqual([]);
    }
  });

  it('a payment adapter ships with its own never-an-input-owner test (invariant 12)', () => {
    if (!existsSync(paymentDir)) return;
    const testDir = join(here, '../adapters/payment');
    expect(existsSync(testDir), 'tests/adapters/payment must exist beside src/adapters/payment').toBe(true);
    const tests = readdirSync(testDir).filter((name) => name.endsWith('.test.ts'));
    const pinned = tests.some((name) => /input-owner|invariant-12|never-input/.test(name));
    expect(pinned, `no test in tests/adapters/payment pins the platform-never-an-input-owner rule: ${tests.join(', ')}`).toBe(true);
  });
});

// The singular settlement state was the v1 fence. P4 (the payment state
// machine) is expected to widen this enum; when it does, it replaces this
// block with the new members and their legal transitions. Until then the
// single member stays pinned so nothing widens it by accident.
describe('the settlement state is structurally singular until the payment state machine lands (ENT-9.1)', () => {
  function enumBody(enumName: string): string {
    const schema = readFileSync(schemaPath, 'utf8');
    const start = schema.indexOf(`enum ${enumName} {`);
    if (start === -1) {
      throw new Error(`enum ${enumName} not found in schema.prisma`);
    }
    const bodyStart = schema.indexOf('{', start) + 1;
    const bodyEnd = schema.indexOf('\n}', bodyStart);
    return schema.slice(bodyStart, bodyEnd);
  }

  it('the database enum has exactly one member: recorded_intent', () => {
    const members = enumBody('SettlementState')
      .split(/\s+/)
      .filter((token) => token.length > 0);
    expect(members).toEqual(['recorded_intent']);
  });

  it('the TypeScript union and the database enum agree at runtime', () => {
    const job: Job = {
      id: 'job_1',
      buyerDid: 'did:example:buyer',
      agentDid: 'did:example:agent',
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug',
      briefHash: 'sha256:brief',
      confirmedSpecHash: 'sha256:spec',
      status: 'completed',
      criteria: [],
      priceUsd: '500.00',
      rail: 'abt',
      priceAcceptedByBuyer: true,
      priceAcceptedByAgent: true,
      depositPercent: 25,
      redoAllowance: 1,
      redoUsedCount: 0,
      redoRequestedCriterionIndex: null,
      redoRequestedAt: null,
      redoRefusedAt: null,
      stagedLapseExtensionDays: 0,
      deliveryWindowDays: 14,
      pullRequestUrl: null,
      mergeCommit: 'abc123',
      mergedAt: new Date('2026-01-02T00:00:00Z'),
      confirmedAt: new Date('2026-01-01T12:00:00Z'),
      submittedAt: new Date('2026-01-01T18:00:00Z'),
      deadline: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      stagedAt: null,
      stagedCommit: null,
      stagingRepo: null,
      baseCommit: null,
      stagingRepoDeleteAfter: null,
      citedCloseCriterionIndex: null,
      citedCloseReasonText: null,
      citedCloseAuthorDid: null,
      citedCloseAt: null,
      deemedCompletedAt: null,
    };
    const state: SettlementState = recordSettlementIntent(job).state;
    expect(state).toBe('recorded_intent');
  });
});
