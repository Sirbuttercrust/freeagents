import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Invariant 9, portability (MISSION.md): nothing in src/domain may import an
// adapter implementation or a vendor package. This is the structural
// guarantee behind that invariant, so it reads the files rather than trusting
// convention.

const here = dirname(fileURLToPath(import.meta.url));
const domainDir = join(here, '../../src/domain');

// The pattern must only match a REAL import or require, and the hard part is
// that `from "..."` is also ordinary English that appears inside strings.
//
// Measured 2026-08-19: a build added the error message
//
//     `transition from "${fromStatus}"`
//
// and this test failed claiming src/domain/job.ts imported `${fromStatus}`.
// The code was correct; the test was reading prose as a module specifier. A
// false failure in an architecture test is expensive out of proportion to its
// size, because it fails a build for a reason the builder cannot act on.
//
// Fixes, in order of importance:
//   1. Anchor to the start of a line (with `m`), optionally after whitespace.
//      A real import or require statement begins a line. Prose inside a
//      template literal does not.
//   2. Require a word boundary after the keyword, so `importantThing` and
//      `exportedValue` cannot match.
const IMPORT_PATTERN =
  /^[ \t]*(?:import|export)\b(?:[^'"\n]*?\bfrom)?\s*['"]([^'"\n]+)['"]|^[ \t]*(?:const|let|var)?[^'"\n]*?\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/gm;

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
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

describe('src/domain purity', () => {
  const files = listSourceFiles(domainDir);

  it('found the domain files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  // Two ways to break invariant 9, and an earlier version of this test only
  // caught the first. A bare specifier like '@ocap/wallet' is obvious. A
  // relative one like '../adapters/identity/identity.js' reaches straight into
  // vendor-backed code while looking like ordinary local import, and it was
  // passing silently. Resolve relative specifiers and reject anything landing
  // outside src/domain.
  //
  // NODE BUILTINS ARE ALLOWED, and the reasoning matters because this is the
  // one place the rule bends.
  //
  // Invariant 9 is about PORTABILITY: the domain must not depend on a vendor
  // or on an adapter, so it stays plain TypeScript that can be lifted into
  // another runtime or verified by someone who does not have our stack. A Node
  // builtin is not a vendor, has no version to pin, no licence to check, and
  // no service behind it.
  //
  // Refusing them costs more than it protects. A build on 2026-08-19
  // implemented `hashSpec` with `crypto.createHash('sha256')` and this test
  // failed it. The alternatives were all worse: hand-rolling SHA-256 in the
  // domain layer, or pushing hashing into an adapter so the rule that says a
  // confirmed spec is hashed would live outside the layer that owns the rules.
  //
  // The `node:` prefix is REQUIRED. Bare 'crypto' is ambiguous, since npm has
  // a package by that name and the import would silently resolve to it. The
  // prefixed form can only ever mean the builtin, which is exactly the
  // certainty an architecture test should demand.
  const NODE_BUILTIN = /^node:/;

  it.each(files)('%s imports nothing outside src/domain', (file) => {
    const offenders = importsIn(file).filter((specifier) => {
      if (NODE_BUILTIN.test(specifier)) return false;
      if (!specifier.startsWith('.')) return true;
      const resolved = resolve(dirname(file), specifier);
      return !resolved.startsWith(domainDir);
    });
    expect(offenders, `${relative(here, file)} imports: ${offenders.join(', ')}`).toEqual([]);
  });
});
