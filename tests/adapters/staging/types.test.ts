// P5: the staging observer port. The default MUST refuse, loudly, rather
// than publish an attestation full of zeroes -- silent-success-on-failure
// is exactly the defect class this test exists to prevent (see this
// file's sibling src/adapters/staging/types.ts header for the fuller
// reasoning on why the real observer is out of scope for this card).
import { describe, expect, it } from 'vitest';
import { NotImplementedError } from '../../../src/adapters/not-implemented.js';
import { createMemoryStagingObserver, createUnwiredStagingObserver } from '../../../src/adapters/staging/types.js';

const INPUT = { owner: 'freeagents-platform', repo: 'staging-job_1', stagedCommit: 'commit-1', baseCommit: 'base-1', criteriaPaths: ['src/a.ts'], verifiedAgentGithubLogin: 'scout-agent' };

describe('createUnwiredStagingObserver: the default, which refuses', () => {
  it('throws NotImplementedError rather than returning a zeroed observation', async () => {
    const observer = createUnwiredStagingObserver();
    await expect(observer.observe(INPUT)).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('names the capability and method in the error, matching the shared convention', async () => {
    const observer = createUnwiredStagingObserver();
    await expect(observer.observe(INPUT)).rejects.toThrow('observe is not implemented yet');
  });
});

describe('createMemoryStagingObserver: a test drives it directly with fixed observations', () => {
  it('returns exactly the observation it was seeded with, for the input it was keyed on', async () => {
    const observation = {
      diffHash: 'sha256:fixed',
      filesChanged: 1,
      linesAdded: 5,
      linesRemoved: 1,
      changedPaths: ['src/a.ts'],
      lineShareByCategory: { source: 1, test: 0, lockfile: 0, generated: 0, vendored: 0 },
      testsDeleted: [],
      testsSkipAdded: [],
      outOfCriteriaPathCount: 0,
      commitSigners: [{ matchesAgentDid: true }],
    };
    const observer = createMemoryStagingObserver(new Map([['commit-1', observation]]));
    expect(await observer.observe(INPUT)).toEqual(observation);
  });

  it('refuses (throws) for a staged commit it was not seeded with, rather than guessing', async () => {
    const observer = createMemoryStagingObserver(new Map());
    await expect(observer.observe(INPUT)).rejects.toThrow(/no fixed observation/);
  });
});
