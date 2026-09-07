// B14b: the real StagingObserver, built entirely on the GitHub REST API
// through the existing github adapter's compareCommits (no clone, no
// checkout, no process spawn -- the anchor is "the platform reports what
// git plainly says about the staged commit and never executes a line of
// the agent's code", Keaton 2026-09-07). Driven against a fake
// GithubAdapter; no call in this file ever reaches the real GitHub API.
import { describe, expect, it } from 'vitest';
import { createGithubStagingObserver } from '../../../src/adapters/staging/github.js';
import { StagingComparisonTruncatedError } from '../../../src/adapters/github/types.js';
import type {
  CompareCommitsInput,
  CompareCommitsResult,
  GithubAdapter,
} from '../../../src/adapters/github/types.js';
import { NotImplementedError } from '../../../src/adapters/not-implemented.js';

function fakeGithub(overrides: Partial<GithubAdapter> = {}): GithubAdapter {
  return {
    getPullRequest: () => Promise.reject(new NotImplementedError('github', 'getPullRequest')),
    getMergeCommitSignature: () => Promise.reject(new NotImplementedError('github', 'getMergeCommitSignature')),
    getPublicGist: () => Promise.reject(new NotImplementedError('github', 'getPublicGist')),
    createStagingRepository: () => Promise.reject(new NotImplementedError('github', 'createStagingRepository')),
    grantPush: () => Promise.reject(new NotImplementedError('github', 'grantPush')),
    getCommit: () => Promise.reject(new NotImplementedError('github', 'getCommit')),
    getDefaultBranchHead: () => Promise.reject(new NotImplementedError('github', 'getDefaultBranchHead')),
    openStagedPullRequest: () => Promise.reject(new NotImplementedError('github', 'openStagedPullRequest')),
    compareCommits: () => Promise.reject(new NotImplementedError('github', 'compareCommits')),
    ...overrides,
  };
}

const INPUT = {
  owner: 'freeagents-platform',
  repo: 'staging-job_1',
  stagedCommit: 'staged-sha',
  baseCommit: 'base-sha',
  criteriaPaths: ['src/allowed.ts'],
  verifiedAgentGithubLogin: 'scout-agent',
};

describe('createGithubStagingObserver: git facts, no execution', () => {
  it('calls compareCommits with the staging repo, base and staged commit -- never the buyer repository', async () => {
    let seen: CompareCommitsInput | null = null;
    const github = fakeGithub({
      compareCommits: (input: CompareCommitsInput): Promise<CompareCommitsResult> => {
        seen = input;
        return Promise.resolve({ files: [], commits: [] });
      },
    });
    const observer = createGithubStagingObserver(github);

    await observer.observe(INPUT);

    expect(seen).toEqual({ owner: 'freeagents-platform', repo: 'staging-job_1', base: 'base-sha', head: 'staged-sha' });
  });

  it('filesChanged, linesAdded, linesRemoved and changedPaths come straight off the compare files', async () => {
    const github = fakeGithub({
      compareCommits: () =>
        Promise.resolve({
          files: [
            { path: 'src/a.ts', status: 'modified', additions: 5, deletions: 1, patch: '@@ -1 +1,5 @@\n+x' },
            { path: 'src/b.ts', status: 'added', additions: 3, deletions: 0, patch: '@@ -0,0 +1,3 @@\n+y' },
          ],
          commits: [],
        }),
    });
    const observer = createGithubStagingObserver(github);

    const observation = await observer.observe(INPUT);

    expect(observation.filesChanged).toBe(2);
    expect(observation.linesAdded).toBe(8);
    expect(observation.linesRemoved).toBe(1);
    expect(observation.changedPaths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('lineShareByCategory classifies changed files by path (source vs test vs lockfile)', async () => {
    const github = fakeGithub({
      compareCommits: () =>
        Promise.resolve({
          files: [
            { path: 'src/a.ts', status: 'modified', additions: 6, deletions: 0, patch: null },
            { path: 'src/a.test.ts', status: 'added', additions: 3, deletions: 0, patch: null },
            { path: 'package-lock.json', status: 'modified', additions: 1, deletions: 0, patch: null },
          ],
          commits: [],
        }),
    });
    const observer = createGithubStagingObserver(github);

    const observation = await observer.observe(INPUT);

    expect(observation.lineShareByCategory).toEqual({ source: 0.6, test: 0.3, lockfile: 0.1, generated: 0, vendored: 0 });
  });

  it('testsDeleted lists removed files matching the test pattern, and only those', async () => {
    const github = fakeGithub({
      compareCommits: () =>
        Promise.resolve({
          files: [
            { path: 'tests/old.test.ts', status: 'removed', additions: 0, deletions: 20, patch: null },
            { path: 'src/old-helper.ts', status: 'removed', additions: 0, deletions: 5, patch: null },
            { path: 'src/kept.test.ts', status: 'modified', additions: 1, deletions: 1, patch: null },
          ],
          commits: [],
        }),
    });
    const observer = createGithubStagingObserver(github);

    const observation = await observer.observe(INPUT);

    expect(observation.testsDeleted).toEqual(['tests/old.test.ts']);
  });

  it('testsSkipAdded lists test files whose patch adds a skip marker on an ADDED line', async () => {
    const github = fakeGithub({
      compareCommits: () =>
        Promise.resolve({
          files: [
            {
              path: 'tests/flaky.test.ts',
              status: 'modified',
              additions: 1,
              deletions: 0,
              patch: '@@ -1,1 +1,1 @@\n-it("works", () => {});\n+it.skip("works", () => {});',
            },
            {
              path: 'tests/clean.test.ts',
              status: 'modified',
              additions: 1,
              deletions: 1,
              patch: '@@ -1,1 +1,1 @@\n-it("a", () => {});\n+it("b", () => {});',
            },
          ],
          commits: [],
        }),
    });
    const observer = createGithubStagingObserver(github);

    const observation = await observer.observe(INPUT);

    expect(observation.testsSkipAdded).toEqual(['tests/flaky.test.ts']);
  });

  it('outOfCriteriaPathCount counts changed paths outside the job criteria paths', async () => {
    const github = fakeGithub({
      compareCommits: () =>
        Promise.resolve({
          files: [
            { path: 'src/allowed.ts', status: 'modified', additions: 1, deletions: 0, patch: null },
            { path: 'src/not-agreed.ts', status: 'modified', additions: 1, deletions: 0, patch: null },
            { path: 'other/also-not-agreed.ts', status: 'modified', additions: 1, deletions: 0, patch: null },
          ],
          commits: [],
        }),
    });
    const observer = createGithubStagingObserver(github);

    const observation = await observer.observe(INPUT);

    expect(observation.outOfCriteriaPathCount).toBe(2);
  });

  it('an empty criteriaPaths list makes every changed path out of criteria', async () => {
    const github = fakeGithub({
      compareCommits: () =>
        Promise.resolve({
          files: [{ path: 'src/anything.ts', status: 'modified', additions: 1, deletions: 0, patch: null }],
          commits: [],
        }),
    });
    const observer = createGithubStagingObserver(github);

    const observation = await observer.observe({ ...INPUT, criteriaPaths: [] });

    expect(observation.outOfCriteriaPathCount).toBe(1);
  });

  it('commitSigners: matchesAgentDid true when the commit is GitHub-verified AND authored by the verified agent login', async () => {
    const github = fakeGithub({
      compareCommits: () =>
        Promise.resolve({
          files: [],
          commits: [
            { sha: 'c1', authorLogin: 'scout-agent', verified: true },
            { sha: 'c2', authorLogin: 'scout-agent', verified: false },
            { sha: 'c3', authorLogin: 'someone-else', verified: true },
          ],
        }),
    });
    const observer = createGithubStagingObserver(github);

    const observation = await observer.observe(INPUT);

    expect(observation.commitSigners).toEqual([
      { matchesAgentDid: true },
      { matchesAgentDid: false },
      { matchesAgentDid: false },
    ]);
  });

  it('diffHash is deterministic and recomputable by a stranger from (path, patch) pairs alone', async () => {
    const files = [
      { path: 'src/b.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n+b' },
      { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n+a' },
    ];
    const github = fakeGithub({ compareCommits: () => Promise.resolve({ files, commits: [] }) });
    const observer = createGithubStagingObserver(github);

    const a = await observer.observe(INPUT);
    const b = await observer.observe(INPUT);
    expect(a.diffHash).toBe(b.diffHash);
    expect(a.diffHash.startsWith('sha256:')).toBe(true);
  });

  it('diffHash is invariant to the ORDER the compare response listed files in', async () => {
    const filesA = [
      { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n+a' },
      { path: 'src/b.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n+b' },
    ];
    const filesB = [filesA[1]!, filesA[0]!];
    const githubA = fakeGithub({ compareCommits: () => Promise.resolve({ files: filesA, commits: [] }) });
    const githubB = fakeGithub({ compareCommits: () => Promise.resolve({ files: filesB, commits: [] }) });
    const observerA = createGithubStagingObserver(githubA);
    const observerB = createGithubStagingObserver(githubB);

    const a = await observerA.observe(INPUT);
    const b = await observerB.observe(INPUT);
    expect(a.diffHash).toBe(b.diffHash);
  });

  // MUTATION PROOF: the diffHash input ordering matters. Changing which
  // field sorts the (path, patch) pairs must change the hash for
  // differently-ordered-but-same-content input, proving the sort is load
  // bearing rather than decorative.
  it('MUTATION: a diffHash built by sorting on patch text instead of path would collide differently -- this pins sort-by-path as the contract', async () => {
    // Two files whose PATCH TEXT sorts in the opposite order from their
    // PATH. Sorting by path gives a fixed byte order; sorting by patch
    // text would give the reverse. The hash from this observer must
    // match a manually sha256'd sort-by-path pin, not a sort-by-patch one.
    const files = [
      { path: 'z-file.ts', status: 'modified', additions: 1, deletions: 0, patch: 'AAA' },
      { path: 'a-file.ts', status: 'modified', additions: 1, deletions: 0, patch: 'ZZZ' },
    ];
    const github = fakeGithub({ compareCommits: () => Promise.resolve({ files, commits: [] }) });
    const observer = createGithubStagingObserver(github);
    const observation = await observer.observe(INPUT);

    const { createHash } = await import('node:crypto');
    const sortedByPath = [...files].sort((x, y) => x.path.localeCompare(y.path));
    const expected = `sha256:${createHash('sha256').update(JSON.stringify(sortedByPath.map((f) => [f.path, f.patch]))).digest('hex')}`;
    expect(observation.diffHash).toBe(expected);
  });

  it('fails closed with StagingComparisonTruncatedError, unchanged, when the adapter reports it', async () => {
    const github = fakeGithub({
      compareCommits: () =>
        Promise.reject(new StagingComparisonTruncatedError('freeagents-platform', 'staging-job_1', 'base-sha', 'staged-sha')),
    });
    const observer = createGithubStagingObserver(github);

    await expect(observer.observe(INPUT)).rejects.toBeInstanceOf(StagingComparisonTruncatedError);
  });
});
