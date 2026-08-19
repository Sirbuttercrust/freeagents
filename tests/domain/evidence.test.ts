import { describe, expect, it } from 'vitest';
import { evidenceTier } from '../../src/domain/evidence.js';
import type { EvidenceFacts, EvidenceTier } from '../../src/domain/evidence.js';

const TIERS: readonly EvidenceTier[] = ['verified-hire', 'verified-prior-work', 'portfolio'];

function facts(overrides: Partial<EvidenceFacts> = {}): EvidenceFacts {
  return {
    platformBrokered: false,
    pullRequestMerged: false,
    signedCommit: false,
    repositoryPublic: false,
    ownerSubmitted: false,
    ...overrides,
  };
}

describe('evidenceTier', () => {
  it('promotes a platform job that merged into a public repository to verified-hire', () => {
    const tier = evidenceTier(
      facts({
        platformBrokered: true,
        pullRequestMerged: true,
        repositoryPublic: true,
      }),
    );
    expect(tier).toBe('verified-hire');
  });

  it('promotes a signed commit in a public repository with no brief to verified-prior-work', () => {
    const tier = evidenceTier(
      facts({
        platformBrokered: false,
        signedCommit: true,
        repositoryPublic: true,
      }),
    );
    expect(tier).toBe('verified-prior-work');
  });

  it('keeps owner-submitted links and screenshots at portfolio', () => {
    expect(evidenceTier(facts({ ownerSubmitted: true }))).toBe('portfolio');
  });

  it('never returns verified-hire for a private repository, even a merged platform job', () => {
    const tier = evidenceTier(
      facts({
        platformBrokered: true,
        pullRequestMerged: true,
        signedCommit: true,
        repositoryPublic: false,
      }),
    );
    expect(tier).toBe('portfolio');
    expect(tier).not.toBe('verified-hire');
  });

  it('is total: every input yields exactly one of the three tiers, and no evidence is portfolio', () => {
    const cases = [
      evidenceTier(facts()),
      evidenceTier(facts({ platformBrokered: true, pullRequestMerged: true, repositoryPublic: true })),
      evidenceTier(facts({ signedCommit: true, repositoryPublic: true })),
      evidenceTier(facts({ ownerSubmitted: true })),
      evidenceTier(facts({ platformBrokered: true, pullRequestMerged: true, signedCommit: true })),
    ];
    for (const tier of cases) {
      expect(TIERS).toContain(tier);
    }
    expect(cases[0]).toBe('portfolio');
  });
});
