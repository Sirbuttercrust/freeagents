// R-26 (ENT-9): v1 designs settlement in, but ships no transfer, no custody,
// no balances (ENT-9.1). This is the "a test asserts that" half of the
// issue's Done means: the absence, not just the presence, of money movement.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { recordSettlementIntent, type SettlementState } from '../../src/domain/settlement.js';
import type { Job } from '../../src/domain/job.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '../../src');
const packageJsonPath = join(here, '../../package.json');
const schemaPath = join(here, '../../prisma/schema.prisma');

// Same anchoring rationale as tests/architecture/domain-purity.test.ts: a
// real import or require begins a line, so prose inside a template literal
// (e.g. an error message quoting "from") cannot false-positive here.
const IMPORT_PATTERN =
  /^[ \t]*(?:import|export)\b(?:[^'"\n]*?\bfrom)?\s*['"]([^'"\n]+)['"]|^[ \t]*(?:const|let|var)?[^'"\n]*?\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/gm;

const PAYMENT_PATTERN = /payment|stripe|paypal|braintree|adyen|@blocklet\/payment/i;
// No `settle\w*\(` here: settlement.ts and its callers legitimately use
// "settlement"/"Settlement" as identifiers. This block is about MOVING
// money, not about the reserved-space feature itself.
const MONEY_MOVEMENT_PATTERN = /transfer|payout|balance|custody|refund|charge/i;

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

describe('no money-movement vocabulary in a code line', () => {
  it.each(sourceFiles)('%s has no line using transfer/payout/balance/custody/refund/charge vocabulary', (file) => {
    const lines = readFileSync(file, 'utf8').split('\n');
    const offenders: string[] = [];
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      if (MONEY_MOVEMENT_PATTERN.test(line)) {
        offenders.push(`${file}:${index + 1}: ${trimmed.slice(0, 80)}`);
      }
    });
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('the settlement state is structurally singular (ENT-9.1)', () => {
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
      pullRequestUrl: null,
      mergeCommit: 'abc123',
      mergedAt: new Date('2026-01-02T00:00:00Z'),
      confirmedAt: new Date('2026-01-01T12:00:00Z'),
      submittedAt: new Date('2026-01-01T18:00:00Z'),
      deadline: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };
    const state: SettlementState = recordSettlementIntent(job).state;
    expect(state).toBe('recorded_intent');
  });
});
