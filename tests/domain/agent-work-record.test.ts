// R-17 (ENT-8, ENT-2.4): assembly over evidence.ts's tier decision, not a
// second tier function. A credential this platform issued exists only
// because completeJob's merge route issued it, so every row is a
// platform-brokered, merged hire; the only fact that varies per row is
// repositoryPublic, read off the stored record, never hardcoded.
import { describe, expect, it } from 'vitest';
import { agentWorkRecord } from '../../src/domain/agent-work-record.js';
import type { CredentialEvidence } from '../../src/domain/agent-work-record.js';

function credential(overrides: Partial<CredentialEvidence> = {}): CredentialEvidence {
  return {
    credentialId: 'https://platform.example/v1/credentials/job-1',
    repository: 'buyer/target-repo',
    pullRequest: 'https://github.com/buyer/target-repo/pull/1',
    mergedAt: '2026-01-03T00:00:00.000Z',
    mergeCommit: 'deadbeef',
    buyerDid: 'did:example:buyer',
    repositoryPublic: true,
    ...overrides,
  };
}

describe('agentWorkRecord', () => {
  it('a platform-brokered merge into a public repository becomes a verified hire, carrying the id R-40 emitted', () => {
    const record = agentWorkRecord([credential({ repositoryPublic: true })]);

    expect(record.verifiedHires).toEqual([
      {
        credentialId: 'https://platform.example/v1/credentials/job-1',
        repository: 'buyer/target-repo',
        pullRequest: 'https://github.com/buyer/target-repo/pull/1',
        mergedAt: '2026-01-03T00:00:00.000Z',
        mergeCommit: 'deadbeef',
        buyerDid: 'did:example:buyer',
      },
    ]);
    expect(record.portfolio).toEqual([]);
  });

  it('a platform-brokered merge into a PRIVATE repository never reaches verified-hire (invariant 4, PR 70 finding)', () => {
    const record = agentWorkRecord([credential({ repositoryPublic: false })]);

    expect(record.verifiedHires).toEqual([]);
    expect(record.portfolio).toEqual([
      {
        credentialId: 'https://platform.example/v1/credentials/job-1',
        repository: 'buyer/target-repo',
        pullRequest: 'https://github.com/buyer/target-repo/pull/1',
        mergedAt: '2026-01-03T00:00:00.000Z',
        mergeCommit: 'deadbeef',
        buyerDid: 'did:example:buyer',
      },
    ]);
  });

  it('an agent with no credentials at all renders three empty tiers (ENT-2.4), not an absence', () => {
    const record = agentWorkRecord([]);

    expect(record).toEqual({ verifiedHires: [], verifiedPriorWork: [], portfolio: [] });
  });
});
