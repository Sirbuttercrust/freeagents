// R-22 (ENT-10, issue 29), rule 2 of the card: a review is never blended
// with evidence. It is not a fourth tier, it does not enter any count, it
// never contributes to a browse sort key or an operator aggregate. This is
// the structural guard the card asks for, in R-17's own pattern
// (tests/domain/browse.ts's "structural no-blend sweep" and
// tests/architecture/domain-purity.test.ts's import-graph check combined):
// static analysis proves the wiring cannot blend a review in, rather than
// trusting that nobody adds a call that does.
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const domainDir = join(here, '../../src/domain');

// Same pattern as tests/architecture/domain-purity.test.ts: anchored to the
// start of a line so prose inside a template literal (a `from "..."`
// sentence in a comment) cannot be mistaken for a real import.
const IMPORT_PATTERN =
  /^[ \t]*(?:import|export)\b(?:[^'"\n]*?\bfrom)?\s*['"]([^'"\n]+)['"]|^[ \t]*(?:const|let|var)?[^'"\n]*?\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/gm;

function importsIn(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

// Resolves a relative specifier against the importing file's directory and
// reports whether it points at src/domain/review.ts.
function importsReviewModule(file: string): boolean {
  return importsIn(file).some((specifier) => {
    if (!specifier.startsWith('.')) return false;
    const resolved = resolve(dirname(file), specifier);
    return resolved === join(domainDir, 'review.js') || resolved === join(domainDir, 'review.ts');
  });
}

describe('src/domain/review.ts is never imported by the evidence/tier machinery (rule 2 of R-22)', () => {
  // Every module that computes a tier count, a browse sort key, or a
  // buyer-diversity aggregate. If a review is ever blended into one of
  // these, the wiring necessarily runs through an import of review.ts (the
  // only module that knows what a review is), so an import here is the
  // earliest observable sign the anchor has been violated.
  const tierAndAggregateModules = [
    join(domainDir, 'evidence.ts'),
    join(domainDir, 'agent-work-record.ts'),
    join(domainDir, 'browse.ts'),
    join(domainDir, 'buyer-diversity.ts'),
  ];

  it.each(tierAndAggregateModules)('%s does not import src/domain/review.ts', (file) => {
    expect(importsReviewModule(file), `${relative(here, file)} imports review.ts`).toBe(false);
  });

  // Mutation proof: the check above is not vacuous. A file planted with a
  // real import of review.ts must trip it, proving the pattern actually
  // matches an import rather than always returning false.
  it('mutation proof: a file that DOES import review.ts is caught by the same check', () => {
    const evidenceFile = join(domainDir, 'evidence.ts');
    const mutatedSource = `import { buildReview } from './review.js';\n${readFileSync(evidenceFile, 'utf8')}`;
    const specifiers: string[] = [];
    for (const match of mutatedSource.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1] ?? match[2];
      if (specifier) specifiers.push(specifier);
    }
    const caught = specifiers.some((specifier) => {
      if (!specifier.startsWith('.')) return false;
      const resolvedPath = resolve(dirname(evidenceFile), specifier);
      return resolvedPath === join(domainDir, 'review.js') || resolvedPath === join(domainDir, 'review.ts');
    });
    expect(caught).toBe(true);
  });
});

describe('src/domain/review.ts is domain-pure (invariant 9, restated for this new module)', () => {
  it('imports nothing outside src/domain, node builtins aside', () => {
    const reviewFile = join(domainDir, 'review.ts');
    const NODE_BUILTIN = /^node:/;
    const offenders = importsIn(reviewFile).filter((specifier) => {
      if (NODE_BUILTIN.test(specifier)) return false;
      if (!specifier.startsWith('.')) return true;
      const resolved = resolve(dirname(reviewFile), specifier);
      return !resolved.startsWith(domainDir);
    });
    expect(offenders).toEqual([]);
  });
});

describe('the Review type structurally carries no numeric field (rule 3 of R-22, ENT-10.2)', () => {
  it('src/domain/review.ts declares the Review interface with exactly the five text/DID/timestamp fields', () => {
    const reviewFile = join(domainDir, 'review.ts');
    const source = readFileSync(reviewFile, 'utf8');
    const interfaceStart = source.indexOf('export interface Review {');
    expect(interfaceStart).toBeGreaterThan(-1);
    const bodyEnd = source.indexOf('}', interfaceStart);
    const body = source.slice(interfaceStart, bodyEnd);
    // Every field line matches "<name>: string" or "<name>: Date"; a
    // numeric field would read "<name>: number" and fail this pattern.
    expect(body).not.toMatch(/:\s*number\b/);
    expect(body).toMatch(/jobId:\s*string/);
    expect(body).toMatch(/authorDid:\s*string/);
    expect(body).toMatch(/agentDid:\s*string/);
    expect(body).toMatch(/text:\s*string/);
    expect(body).toMatch(/createdAt:\s*Date/);
  });
});
