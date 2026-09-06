// P5: a staging observer fixture for API tests that exercise the stage
// route but do not themselves care about the attestation's exact facts
// (payment gating, party rules, transition guards). Mirrors
// settlement-fixtures.ts's own alwaysSettledGate: a test-only convenience
// the real fail-closed default deliberately does not offer. Tests that
// specifically pin attestation content build their own
// createMemoryStagingObserver directly instead.
import { createMemoryStagingObserver, type StagingObserver } from '../../src/adapters/staging/types.js';
import type { StagingObservation } from '../../src/domain/attestation.js';

const FIXED_OBSERVATION: StagingObservation = {
  diffHash: 'sha256:fixture-diff-hash',
  filesChanged: 1,
  linesAdded: 1,
  linesRemoved: 0,
  changedPaths: ['src/fixture.ts'],
  lineShareByCategory: { source: 1, test: 0, lockfile: 0, generated: 0, vendored: 0 },
  testsDeleted: [],
  testsSkipAdded: [],
  buyerTestRun: {
    command: 'npm test',
    exitCode: 0,
    passCount: 1,
    failCount: 0,
    skipCount: 0,
    failingTestNames: [],
  },
  outOfCriteriaPathCount: 0,
  commitSigners: [{ matchesAgentDid: true }],
};

// Answers the same fixed observation for ANY staged commit, unlike
// createMemoryStagingObserver's own exact-match refusal: these tests
// stage jobs under commit shas chosen for readability, not to probe the
// observer itself.
export function anyCommitStagingObserver(): StagingObserver {
  return {
    async observe(): Promise<StagingObservation> {
      return FIXED_OBSERVATION;
    },
  };
}

export function fixedStagingObserverFor(stagedCommit: string): StagingObserver {
  return createMemoryStagingObserver(new Map([[stagedCommit, FIXED_OBSERVATION]]));
}
