// Invariant 2 (MISSION.md), Gate 2 for R-33: a third party can confirm the
// buyer-diversity counts and self-hire labels without calling this service,
// off only the published hire rows - the same buyerDid / agentDid /
// mergeCommit / completedAt a work-history credential already carries. And
// invariant 3 (credentials carry facts, never opinions): a derived label
// like "self-hire" is not a fact a signature should carry, so it must never
// enter a credential or a stored column - both are things that would make it
// look like observed evidence rather than a read-time derivation.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buyerDiversity } from '../../src/domain/buyer-diversity.js';
import type { HireFacts } from '../../src/domain/buyer-diversity.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../..');

describe('buyer diversity, invariant 2 (R-33)', () => {
  it('is recomputable off-platform: two independently constructed but equal fact arrays produce identical results', () => {
    const operatorDid = 'did:abt:zOperator';

    const first = buyerDiversity(
      [
        {
          jobId: 'job-1',
          buyerDid: 'did:abt:zOperator',
          agentDid: 'did:abt:zAgent1',
          mergeCommit: 'abc123',
          completedAt: '2026-06-01T00:00:00.000Z',
        },
        {
          jobId: 'job-2',
          buyerDid: 'did:abt:zOtherBuyer',
          agentDid: 'did:abt:zAgent1',
          mergeCommit: 'def456',
          completedAt: '2026-06-02T00:00:00.000Z',
        },
      ],
      operatorDid,
    );

    // A skeptic holding the published hire rows reconstructs the same
    // objects from scratch - not the same reference as `first`.
    const second: HireFacts[] = [
      {
        jobId: 'job-1',
        buyerDid: 'did:abt:zOperator',
        agentDid: 'did:abt:zAgent1',
        mergeCommit: 'abc123',
        completedAt: '2026-06-01T00:00:00.000Z',
      },
      {
        jobId: 'job-2',
        buyerDid: 'did:abt:zOtherBuyer',
        agentDid: 'did:abt:zAgent1',
        mergeCommit: 'def456',
        completedAt: '2026-06-02T00:00:00.000Z',
      },
    ];
    const third = buyerDiversity(second, 'did:abt:zOperator');

    expect(first).toStrictEqual(third);
  });

  it('the words "selfhire" and "buyerdiversity" appear in none of the credential-issuance sources', () => {
    const CREDENTIAL_SOURCES = [
      'src/domain/credential.ts',
      'src/adapters/credentials/credentials.ts',
      'src/adapters/identity/w3c-credentials.ts',
    ];
    for (const relativePath of CREDENTIAL_SOURCES) {
      const source = readFileSync(join(repoRoot, relativePath), 'utf8').toLowerCase();
      expect(source, `${relativePath} must not mention selfhire`).not.toContain('selfhire');
      expect(source, `${relativePath} must not mention buyerdiversity`).not.toContain('buyerdiversity');
    }
  });

  it('prisma/schema.prisma stores none of selfhire, buyerdiversity, distinctbuyers, buyercount: derived at read time, never a column', () => {
    const schema = readFileSync(join(repoRoot, 'prisma/schema.prisma'), 'utf8').toLowerCase();
    for (const stem of ['selfhire', 'buyerdiversity', 'distinctbuyers', 'buyercount']) {
      expect(schema, `schema.prisma must not mention ${stem}`).not.toContain(stem);
    }
  });
});
