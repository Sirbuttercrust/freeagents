import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { hashSpec } from '../../src/domain/hashing.js';

/**
 * WHY THESE TESTS LOOK LIKE THIS.
 *
 * The first version of this file asserted "known-answer vectors" that were
 * fabricated: expected values matching no transform of the input, so four
 * tests failed against a correct implementation. A hash cannot be computed by
 * hand or recalled from memory, and a literal nobody produced is worse than no
 * test at all, because the cheapest way to make it pass is to bend the
 * implementation toward a meaningless number.
 *
 * So the assertions here are of two kinds only:
 *
 *   PROPERTIES, which cannot be faked. Determinism, collision resistance on
 *   inputs that differ, shape, and the normalisation rules stated as
 *   equivalences rather than as constants.
 *
 *   INDEPENDENTLY DERIVED VECTORS, computed in the test by a path that does
 *   not call hashSpec. `expectedFor()` below reimplements the documented
 *   normalisation and hashes it with node:crypto, so if the implementation
 *   drifts from the spec the test fails, and no literal is trusted.
 *
 * The one exception is the empty-string digest, which is the most widely
 * published SHA-256 value in existence and is verifiable against any reference.
 */

/** The normalisation the issue specifies, implemented independently here. */
function normalise(spec: string): string {
  const unixEndings = spec.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const trimmedPerLine = unixEndings.split('\n').map((line) => line.trimEnd());
  const joined = trimmedPerLine.join('\n');
  return joined.endsWith('\n') ? joined.slice(0, -1) : joined;
}

/** A vector derived here, not recalled. */
function expectedFor(spec: string): string {
  return `sha256:${createHash('sha256').update(normalise(spec)).digest('hex')}`;
}

describe('hashSpec', () => {
  it('returns the sha256: prefix and 64 lowercase hex characters', () => {
    expect(hashSpec('some spec')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    const spec = 'line1\nline2';
    expect(hashSpec(spec)).toBe(hashSpec(spec));
  });

  it('agrees with an independently computed digest', () => {
    for (const spec of ['  line1  \n  line2  \n', 'line1\r\nline2\r\nline3\n', 'a', '']) {
      expect(hashSpec(spec)).toBe(expectedFor(spec));
    }
  });

  it('hashes the empty string to the published SHA-256 of empty input', () => {
    // The one literal in this file. Verifiable against any reference
    // implementation, and the standard smoke test that the digest is real
    // SHA-256 rather than something merely shaped like it.
    expect(hashSpec('')).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  describe('normalisation, stated as equivalences', () => {
    it('treats CRLF, CR and LF line endings as the same spec', () => {
      const lf = hashSpec('line1\nline2\n');
      expect(hashSpec('line1\r\nline2\r\n')).toBe(lf);
      expect(hashSpec('line1\rline2\n')).toBe(lf);
    });

    it('ignores trailing whitespace on each line', () => {
      expect(hashSpec('line1   \nline2\t\n')).toBe(hashSpec('line1\nline2\n'));
    });

    it('ignores a single trailing newline', () => {
      expect(hashSpec('line1\nline2\n')).toBe(hashSpec('line1\nline2'));
    });

    it('does NOT ignore leading whitespace, which is meaningful', () => {
      // Indentation can carry meaning in a spec, so stripping it would let two
      // materially different agreements hash the same. This asserts the
      // boundary of the rule rather than only its happy path.
      expect(hashSpec('  line1')).not.toBe(hashSpec('line1'));
    });

    it('does NOT collapse blank lines', () => {
      expect(hashSpec('a\n\nb')).not.toBe(hashSpec('a\nb'));
    });
  });

  describe('collision resistance on inputs that differ', () => {
    it('differs when a line is added', () => {
      expect(hashSpec('line1\nline2\n')).not.toBe(hashSpec('line1\nline2\nline3\n'));
    });

    it('differs when a single character changes', () => {
      expect(hashSpec('deliver feature A')).not.toBe(hashSpec('deliver feature B'));
    });

    it('differs when line order changes', () => {
      expect(hashSpec('a\nb')).not.toBe(hashSpec('b\na'));
    });
  });
});
