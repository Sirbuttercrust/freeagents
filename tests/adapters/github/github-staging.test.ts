// B14a: the staging repository half of the hire loop (bugs.md B14/B14a).
// createStagingRepository, grantPush, getCommit and openStagedPullRequest,
// driven against a fake fetch exactly like tests/adapters/github/github.test.ts
// drives the rest of this adapter. No call in this file ever reaches the
// real GitHub API.
import { describe, expect, it } from 'vitest';

import { createGithubAdapter } from '../../../src/adapters/github/github.js';
import {
  NotPlatformOwnerError,
  UnverifiedGithubLoginError,
  type CreateStagingRepositoryInput,
  type OpenStagedPullRequestInput,
} from '../../../src/adapters/github/types.js';

const TOKEN = 'ghp_test_token_not_real';
const PLATFORM_LOGIN = 'freeagents-platform';

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function scriptedFetch(responses: readonly Response[]): { fetchImpl: typeof fetch; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  let index = 0;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ url, method, body });
    const response = responses[index];
    index += 1;
    if (response === undefined) {
      throw new Error(`scriptedFetch: no response scripted for call ${String(index)} (${method} ${url})`);
    }
    return response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('createGithubAdapter, createStagingRepository (B14a)', () => {
  const input: CreateStagingRepositoryInput = {
    jobId: 'job_1',
    sourceOwner: 'buyer',
    sourceRepo: 'target-repo',
    baseCommit: 'base-commit-sha',
  };

  function scriptHappyPath(): { fetchImpl: typeof fetch; calls: RecordedRequest[] } {
    return scriptedFetch([
      // 1. create the private repo under the platform account, auto_init
      //    so the empty-repository ref restriction never applies.
      jsonResponse(201, { owner: { login: PLATFORM_LOGIN }, name: 'staging-job_1', default_branch: 'main' }),
      // 2. read the base commit to learn its tree sha.
      jsonResponse(200, { sha: 'base-commit-sha', tree: { sha: 'source-tree-sha' }, parents: [] }),
      // 3. read the source tree recursively.
      jsonResponse(200, {
        truncated: false,
        tree: [
          { path: 'a.txt', mode: '100644', type: 'blob', sha: 'blob-a-sha' },
          { path: 'b.txt', mode: '100644', type: 'blob', sha: 'blob-b-sha' },
        ],
      }),
      // 4. copy each blob (read from source, write to staging).
      jsonResponse(200, { content: 'YQo=', encoding: 'base64' }),
      jsonResponse(201, { sha: 'blob-a-sha' }),
      jsonResponse(200, { content: 'Ygo=', encoding: 'base64' }),
      jsonResponse(201, { sha: 'blob-b-sha' }),
      // 5. build the same tree in the staging repository.
      jsonResponse(201, { sha: 'staging-tree-sha' }),
      // 6. a root commit, no parents.
      jsonResponse(201, { sha: 'staging-root-commit-sha' }),
      // 7. repoint the default branch at the seeded root commit.
      jsonResponse(200, { object: { sha: 'staging-root-commit-sha' } }),
    ]);
  }

  it('creates a private repo, seeds it from the source at baseCommit, and returns owner/repo/defaultBranch/baseCommit', async () => {
    const { fetchImpl, calls } = scriptHappyPath();
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    const result = await adapter.createStagingRepository(input);

    expect(result).toEqual({
      owner: PLATFORM_LOGIN,
      repo: 'staging-job_1',
      defaultBranch: 'main',
      baseCommit: 'base-commit-sha',
    });
    expect(calls[0]).toEqual({
      url: 'https://api.github.com/user/repos',
      method: 'POST',
      body: { name: 'staging-job_1', private: true, auto_init: true },
    });
  });

  it('reads the source tree recursively and copies every blob into the staging repository', async () => {
    const { fetchImpl, calls } = scriptHappyPath();
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    await adapter.createStagingRepository(input);

    expect(calls[1]).toEqual({
      url: 'https://api.github.com/repos/buyer/target-repo/git/commits/base-commit-sha',
      method: 'GET',
      body: undefined,
    });
    expect(calls[2]).toEqual({
      url: 'https://api.github.com/repos/buyer/target-repo/git/trees/source-tree-sha?recursive=1',
      method: 'GET',
      body: undefined,
    });
    // Blob a: read from source, then written to the staging repo.
    expect(calls[3]).toEqual({
      url: 'https://api.github.com/repos/buyer/target-repo/git/blobs/blob-a-sha',
      method: 'GET',
      body: undefined,
    });
    expect(calls[4]).toEqual({
      url: 'https://api.github.com/repos/freeagents-platform/staging-job_1/git/blobs',
      method: 'POST',
      body: { content: 'YQo=', encoding: 'base64' },
    });
  });

  it('creates the destination tree from the copied blob shas, then a root commit with no parents', async () => {
    const { fetchImpl, calls } = scriptHappyPath();
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    await adapter.createStagingRepository(input);

    expect(calls[7]).toEqual({
      url: 'https://api.github.com/repos/freeagents-platform/staging-job_1/git/trees',
      method: 'POST',
      body: {
        tree: [
          { path: 'a.txt', mode: '100644', type: 'blob', sha: 'blob-a-sha' },
          { path: 'b.txt', mode: '100644', type: 'blob', sha: 'blob-b-sha' },
        ],
      },
    });
    const commitCall = calls[8];
    expect(commitCall?.method).toBe('POST');
    expect(commitCall?.url).toBe('https://api.github.com/repos/freeagents-platform/staging-job_1/git/commits');
    expect((commitCall?.body as { tree: string }).tree).toBe('staging-tree-sha');
    // A ROOT commit: no parents, per the brief -- staging history never
    // inherits the buyer's.
    expect((commitCall?.body as { parents: string[] }).parents).toEqual([]);
  });

  it('force-repoints the auto_init default branch at the seeded root commit', async () => {
    const { fetchImpl, calls } = scriptHappyPath();
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    await adapter.createStagingRepository(input);

    expect(calls[9]).toEqual({
      url: 'https://api.github.com/repos/freeagents-platform/staging-job_1/git/refs/heads/main',
      method: 'PATCH',
      body: { sha: 'staging-root-commit-sha', force: true },
    });
  });

  it('never issues a write against the buyer repository: every call to buyer/target-repo is a GET', async () => {
    const { fetchImpl, calls } = scriptHappyPath();
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    await adapter.createStagingRepository(input);

    const sourceCalls = calls.filter((c) => c.url.includes('/repos/buyer/target-repo'));
    expect(sourceCalls.length).toBeGreaterThan(0);
    expect(sourceCalls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('fails closed with no token, before any network call', async () => {
    const { fetchImpl, calls } = scriptedFetch([]);
    const adapter = createGithubAdapter({ token: '', fetchImpl, platformLogin: PLATFORM_LOGIN });

    await expect(adapter.createStagingRepository(input)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('refuses a truncated source tree rather than seeding a partial repository', async () => {
    const { fetchImpl } = scriptedFetch([
      jsonResponse(201, { owner: { login: PLATFORM_LOGIN }, name: 'staging-job_1', default_branch: 'main' }),
      jsonResponse(200, { sha: 'base-commit-sha', tree: { sha: 'source-tree-sha' }, parents: [] }),
      jsonResponse(200, { truncated: true, tree: [] }),
    ]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    await expect(adapter.createStagingRepository(input)).rejects.toThrow();
  });
});

describe('createGithubAdapter, grantPush (B14a)', () => {
  it('adds the verified GitHub login as a push collaborator on a platform-owned repo', async () => {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse(201, {})]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    await adapter.grantPush({
      owner: PLATFORM_LOGIN,
      repo: 'staging-job_1',
      githubLogin: 'agent-scout',
      verifiedGithubLogin: 'agent-scout',
    });

    expect(calls).toEqual([
      {
        url: 'https://api.github.com/repos/freeagents-platform/staging-job_1/collaborators/agent-scout',
        method: 'PUT',
        body: { permission: 'push' },
      },
    ]);
  });

  it('refuses a login that is not the agent\'s verified GitHub login, before any network call', async () => {
    const { fetchImpl, calls } = scriptedFetch([]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    await expect(
      adapter.grantPush({
        owner: PLATFORM_LOGIN,
        repo: 'staging-job_1',
        githubLogin: 'imposter',
        verifiedGithubLogin: 'agent-scout',
      }),
    ).rejects.toBeInstanceOf(UnverifiedGithubLoginError);
    expect(calls).toHaveLength(0);
  });

  // MUTATION PROOF (invariant 1): a write whose owner is not the platform
  // account is refused before any network call, for every mutating method
  // that accepts an explicit owner.
  it('refuses to grant push on a repository the platform does not own', async () => {
    const { fetchImpl, calls } = scriptedFetch([]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    await expect(
      adapter.grantPush({
        owner: 'someone-else',
        repo: 'their-repo',
        githubLogin: 'agent-scout',
        verifiedGithubLogin: 'agent-scout',
      }),
    ).rejects.toBeInstanceOf(NotPlatformOwnerError);
    expect(calls).toHaveLength(0);
  });
});

describe('createGithubAdapter, getCommit (B14a)', () => {
  it('reads a commit and projects sha, parents, treeSha and signed', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      jsonResponse(200, {
        sha: 'commit-sha-1',
        parents: [{ sha: 'parent-sha-1' }],
        tree: { sha: 'tree-sha-1' },
        verification: { verified: true },
      }),
    ]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    const commit = await adapter.getCommit({ owner: PLATFORM_LOGIN, repo: 'staging-job_1', sha: 'commit-sha-1' });

    expect(calls).toEqual([
      {
        url: 'https://api.github.com/repos/freeagents-platform/staging-job_1/git/commits/commit-sha-1',
        method: 'GET',
        body: undefined,
      },
    ]);
    expect(commit).toEqual({
      sha: 'commit-sha-1',
      parents: ['parent-sha-1'],
      treeSha: 'tree-sha-1',
      signed: true,
    });
  });

  it('projects an unsigned commit (no verification object) as signed: false', async () => {
    const { fetchImpl } = scriptedFetch([
      jsonResponse(200, { sha: 'commit-sha-2', parents: [], tree: { sha: 'tree-sha-2' } }),
    ]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    const commit = await adapter.getCommit({ owner: 'buyer', repo: 'target-repo', sha: 'commit-sha-2' });
    expect(commit.signed).toBe(false);
    expect(commit.parents).toEqual([]);
  });

  it('is read-only against a non-platform owner: no owner check applies', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      jsonResponse(200, { sha: 'commit-sha-3', parents: [], tree: { sha: 'tree-sha-3' } }),
    ]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    await expect(
      adapter.getCommit({ owner: 'buyer', repo: 'target-repo', sha: 'commit-sha-3' }),
    ).resolves.toBeDefined();
    expect(calls).toHaveLength(1);
  });

  it('a non-2xx response rejects rather than returning a half-built commit', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse(404, { message: 'Not Found' })]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    await expect(
      adapter.getCommit({ owner: PLATFORM_LOGIN, repo: 'staging-job_1', sha: 'missing' }),
    ).rejects.toThrow();
  });
});

describe('createGithubAdapter, getDefaultBranchHead (B14a)', () => {
  it('reads the repository, then its default branch head sha', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      jsonResponse(200, { default_branch: 'main' }),
      jsonResponse(200, { object: { sha: 'buyer-head-sha' } }),
    ]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    const head = await adapter.getDefaultBranchHead({ owner: 'buyer', repo: 'target-repo' });

    expect(calls).toEqual([
      { url: 'https://api.github.com/repos/buyer/target-repo', method: 'GET', body: undefined },
      { url: 'https://api.github.com/repos/buyer/target-repo/git/ref/heads/main', method: 'GET', body: undefined },
    ]);
    expect(head).toEqual({ defaultBranch: 'main', sha: 'buyer-head-sha' });
  });

  it('a non-2xx response rejects rather than returning a half-built head', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse(404, { message: 'Not Found' })]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    await expect(adapter.getDefaultBranchHead({ owner: 'buyer', repo: 'gone' })).rejects.toThrow();
  });
});

describe('createGithubAdapter, openStagedPullRequest (B14a, invariant 1)', () => {
  const input: OpenStagedPullRequestInput = {
    stagingOwner: PLATFORM_LOGIN,
    stagingRepo: 'staging-job_1',
    stagedCommit: 'staged-commit-sha',
    sourceOwner: 'buyer',
    sourceRepo: 'target-repo',
    branch: 'freeagents/job_1',
    title: 'FreeAgents job job_1',
    body: 'Job: job_1',
  };

  function scriptHappyPath(): { fetchImpl: typeof fetch; calls: RecordedRequest[] } {
    return scriptedFetch([
      // 1. create the branch on the staging repo at the attested commit.
      jsonResponse(201, { ref: 'refs/heads/freeagents/job_1', object: { sha: 'staged-commit-sha' } }),
      // 2. read the source repository's own default branch.
      jsonResponse(200, { default_branch: 'main' }),
      // 3. open the pull request.
      jsonResponse(201, { number: 12 }),
    ]);
  }

  it('creates the branch at the attested commit, reads the source default branch, and opens the PR with head_repo naming the staging repo', async () => {
    const { fetchImpl, calls } = scriptHappyPath();
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    const ref = await adapter.openStagedPullRequest(input);

    expect(calls[0]).toEqual({
      url: `https://api.github.com/repos/${PLATFORM_LOGIN}/staging-job_1/git/refs`,
      method: 'POST',
      body: { ref: 'refs/heads/freeagents/job_1', sha: 'staged-commit-sha' },
    });
    expect(calls[1]).toEqual({
      url: 'https://api.github.com/repos/buyer/target-repo',
      method: 'GET',
      body: undefined,
    });
    expect(calls[2]).toEqual({
      url: 'https://api.github.com/repos/buyer/target-repo/pulls',
      method: 'POST',
      body: {
        title: input.title,
        body: input.body,
        head: `${PLATFORM_LOGIN}:freeagents/job_1`,
        head_repo: 'staging-job_1',
        base: 'main',
      },
    });
    // R-10: the PR number resolves at the SOURCE repository, GitHub's own
    // namespace for a cross-repo PR (proven live 2026-09-06).
    expect(ref).toEqual({ owner: 'buyer', repo: 'target-repo', number: 12 });
  });

  // MUTATION PROOF (invariant 1): refuses before any network call when the
  // staging owner named is not the platform account.
  it('refuses to open from a staging repo the platform does not own', async () => {
    const { fetchImpl, calls } = scriptedFetch([]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    await expect(
      adapter.openStagedPullRequest({ ...input, stagingOwner: 'someone-else' }),
    ).rejects.toBeInstanceOf(NotPlatformOwnerError);
    expect(calls).toHaveLength(0);
  });

  it('never writes to the source repository except the pull request itself', async () => {
    const { fetchImpl, calls } = scriptHappyPath();
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    await adapter.openStagedPullRequest(input);

    const sourceCalls = calls.filter((c) => c.url.startsWith('https://api.github.com/repos/buyer/target-repo'));
    const sourceWrites = sourceCalls.filter((c) => c.method !== 'GET');
    expect(sourceWrites.map((c) => c.url)).toEqual(['https://api.github.com/repos/buyer/target-repo/pulls']);
  });

  it('propagates a branch-creation failure without reading the source repo or opening a pull request', async () => {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse(422, { message: 'Reference already exists' })]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    await expect(adapter.openStagedPullRequest(input)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});
