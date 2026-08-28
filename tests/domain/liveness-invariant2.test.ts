// Invariant 2 (MISSION.md), Gate 2 for R-32: a third party can confirm the
// liveness label without calling this service, off only what a profile
// publishes plus a caller-supplied `now`. And invariant 3 (credentials carry
// facts, never opinions): a derived label like "quiet" is not a fact a
// signature should carry, so it must never enter a credential or a stored
// column - both are things that would make it look like observed evidence
// rather than a read-time derivation.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { profileLiveness } from '../../src/domain/liveness.js';
import type { ObservedActivity } from '../../src/domain/liveness.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../..');

describe('liveness, invariant 2 (R-32)', () => {
  it('is recomputable off-platform: identical facts and a fixed now produce identical, repeatable results', () => {
    const activity: ObservedActivity = {
      lastCompletedHireAt: '2026-06-01T00:00:00.000Z',
      lastHireActivityAt: null,
      lastSignedRequestAt: null,
    };
    const now = new Date('2026-08-28T00:00:00.000Z');

    const first = profileLiveness(activity, null, now);
    const second = profileLiveness(activity, null, now);
    // Two independently constructed but equal facts objects, not the same
    // reference - a skeptic reconstructs the object from the published
    // instants, they do not reuse this one.
    const third = profileLiveness(
      { lastCompletedHireAt: '2026-06-01T00:00:00.000Z', lastHireActivityAt: null, lastSignedRequestAt: null },
      null,
      new Date('2026-08-28T00:00:00.000Z'),
    );

    expect(first).toStrictEqual(second);
    expect(first).toStrictEqual(third);
  });

  it('the word "liveness" appears in none of the credential-issuance sources: a derived label never enters a signed credential', () => {
    const CREDENTIAL_SOURCES = [
      'src/domain/credential.ts',
      'src/adapters/credentials/credentials.ts',
      'src/adapters/identity/w3c-credentials.ts',
    ];
    for (const relativePath of CREDENTIAL_SOURCES) {
      const source = readFileSync(join(repoRoot, relativePath), 'utf8');
      expect(source.toLowerCase(), `${relativePath} must not mention liveness`).not.toContain('liveness');
    }
  });

  it('prisma/schema.prisma stores no liveness field: the label is derived at read time, never a column somebody can set', () => {
    const schema = readFileSync(join(repoRoot, 'prisma/schema.prisma'), 'utf8').toLowerCase();
    for (const stem of ['liveness', 'dormant', 'quietsince']) {
      expect(schema, `schema.prisma must not mention ${stem}`).not.toContain(stem);
    }
  });
});
