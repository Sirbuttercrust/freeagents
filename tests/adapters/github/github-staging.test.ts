// B14a, STG2: the staging repository half of the hire loop (bugs.md
// B14/B14a) plus the fork-delivery facts getPullRequest now projects.
// createStagingRepository, grantPush and getCommit driven against a fake
// fetch exactly like tests/adapters/github/github.test.ts drives the
// rest of this adapter. No call in this file ever reaches the real
// GitHub API.
//
// STG2 refined shape: the platform creates an EMPTY private repository
// (no auto_init, no seeded tree, no root commit) and never opens a pull
// request itself. The agent seeds staging by cloning and pushing outside
// this adapter, then pushes the attested commit to its own fork and
// opens the PR itself -- also outside this adapter. What this adapter
// still owns on the pull-request side is reading one back
// (getPullRequest), projected with the fork-delivery facts the route
// checks.
import { describe, expect, it } from 'vitest';

import { createGithubAdapter } from '../../../src/adapters/github/github.js';
import {
  NotPlatformOwnerError,
  RepositoryNotAccessibleError,
  UnverifiedGithubLoginError,
  type CreateStagingRepositoryInput,
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

// ORG1 r2 fix, defect 1: confirm's getDefaultBranchHead and the pull-request
// route's getPullRequest both run on the PLATFORM's token, never the
// agent's. A message or field that names only the agent's account sends
// the buyer to grant read to the wrong login whenever the platform account
// differs from the agent account -- true of every real hire, since one
// account is the deployment's own GitHub identity and the other belongs to
// whichever agent was hired. The adapter is the one place that already
// knows the platform's configured login (requirePlatformOwner reads it);
// this exposes it read-only so app.ts can name it without re-deriving it
// from the environment a second time.
describe('createGithubAdapter: exposes its own configured platform login (ORG1 r2)', () => {
  it('platformLogin reflects the value passed in, unrelated to the token', () => {
    const { fetchImpl } = scriptedFetch([]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    expect(adapter.platformLogin).toBe(PLATFORM_LOGIN);
  });

  it('platformLogin is the empty string when unconfigured, never undefined or null', () => {
    const { fetchImpl } = scriptedFetch([]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

    expect(adapter.platformLogin).toBe('');
  });
});

describe('createGithubAdapter, createStagingRepository (B14a, STG2 empty repo)', () => {
  const input: CreateStagingRepositoryInput = {
    jobId: 'job_1',
    sourceOwner: 'buyer',
    sourceRepo: 'target-repo',
    baseCommit: 'base-commit-sha',
  };

  it('creates a private, EMPTY repo (auto_init: false) and returns owner/repo/defaultBranch/baseCommit, in exactly one call', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      jsonResponse(201, { owner: { login: PLATFORM_LOGIN }, name: 'staging-job_1', default_branch: 'main' }),
    ]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    const result = await adapter.createStagingRepository(input);

    expect(result).toEqual({
      owner: PLATFORM_LOGIN,
      repo: 'staging-job_1',
      defaultBranch: 'main',
      baseCommit: 'base-commit-sha',
    });
    expect(calls).toEqual([
      {
        url: 'https://api.github.com/user/repos',
        method: 'POST',
        body: { name: 'staging-job_1', private: true, auto_init: false },
      },
    ]);
  });

  it('never reads or writes anything against the source repository: repo creation is the only call', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      jsonResponse(201, { owner: { login: PLATFORM_LOGIN }, name: 'staging-job_1', default_branch: 'main' }),
    ]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    await adapter.createStagingRepository(input);

    const sourceCalls = calls.filter((c) => c.url.includes('/repos/buyer/target-repo'));
    expect(sourceCalls).toHaveLength(0);
  });

  it('fails closed with no token, before any network call', async () => {
    const { fetchImpl, calls } = scriptedFetch([]);
    const adapter = createGithubAdapter({ token: '', fetchImpl, platformLogin: PLATFORM_LOGIN });

    await expect(adapter.createStagingRepository(input)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('propagates a non-2xx repo-creation response rather than returning a half-built result', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse(422, { message: 'name already exists' })]);
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

  // ORG1: a 404 on the repository read means the platform cannot see the
  // buyer's repository at all (private, not shared with the platform's
  // account) -- distinct from a real GitHub outage. The confirm route
  // maps this to a 409 a buyer can act on, never the 503 an unreachable
  // API gets.
  it('throws RepositoryNotAccessibleError, not a bare Error, on a 404 reading the repository', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse(404, { message: 'Not Found' })]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    await expect(adapter.getDefaultBranchHead({ owner: 'buyer', repo: 'gone' })).rejects.toBeInstanceOf(
      RepositoryNotAccessibleError,
    );
  });

  // A private repository the platform's account was never invited to
  // reports 403, not 404, on some GitHub configurations -- both mean
  // the same thing to confirm (cannot see it), so both throw the same
  // typed error.
  it('throws RepositoryNotAccessibleError, not a bare Error, on a 403 reading the repository', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse(403, { message: 'Forbidden' })]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    await expect(adapter.getDefaultBranchHead({ owner: 'buyer', repo: 'private-repo' })).rejects.toBeInstanceOf(
      RepositoryNotAccessibleError,
    );
  });

  // A real outage (500) must NOT be mistaken for an inaccessible
  // repository -- it stays a bare Error, which confirm maps to 503.
  it('does not throw RepositoryNotAccessibleError on a 500 (a real outage stays a generic failure)', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse(500, { message: 'Internal Server Error' })]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    let caught: unknown;
    try {
      await adapter.getDefaultBranchHead({ owner: 'buyer', repo: 'target-repo' });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(RepositoryNotAccessibleError);
    expect(caught).toBeInstanceOf(Error);
  });
});

// STG2: getPullRequest now projects the fork-delivery facts the
// pull-request and merge routes check -- head repo owner/full name/fork
// flag, base repo full name, author login, and body -- straight off the
// same PR object, never asserted by either party.
describe('createGithubAdapter, getPullRequest (STG2 fork-delivery facts)', () => {
  it('projects headRepoOwner, headRepoFullName, headRepoIsFork, baseRepoFullName, authorLogin and body', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      jsonResponse(200, {
        state: 'open',
        merged: false,
        merge_commit_sha: null,
        merged_at: null,
        head: {
          sha: 'attested-sha',
          repo: { full_name: 'scout-agent/target-repo', fork: true, owner: { login: 'scout-agent' } },
        },
        additions: 5,
        deletions: 1,
        changed_files: 2,
        base: { repo: { private: false, full_name: 'buyer/target-repo' } },
        user: { login: 'scout-agent' },
        body: 'Job: job_1\n',
      }),
    ]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    const summary = await adapter.getPullRequest({ owner: 'buyer', repo: 'target-repo', number: 9 });

    expect(calls).toEqual([
      { url: 'https://api.github.com/repos/buyer/target-repo/pulls/9', method: 'GET', body: undefined },
    ]);
    expect(summary.headRepoOwner).toBe('scout-agent');
    expect(summary.headRepoFullName).toBe('scout-agent/target-repo');
    expect(summary.headRepoIsFork).toBe(true);
    expect(summary.baseRepoFullName).toBe('buyer/target-repo');
    expect(summary.authorLogin).toBe('scout-agent');
    expect(summary.body).toBe('Job: job_1\n');
  });

  it('projects a null head repo (deleted fork) as null owner/full name and headRepoIsFork: false, never guessed', async () => {
    const { fetchImpl } = scriptedFetch([
      jsonResponse(200, {
        state: 'closed',
        merged: false,
        merge_commit_sha: null,
        merged_at: null,
        head: { sha: 'orphaned-sha', repo: null },
        additions: 0,
        deletions: 0,
        changed_files: 0,
        base: { repo: { private: false, full_name: 'buyer/target-repo' } },
        user: { login: 'scout-agent' },
        body: null,
      }),
    ]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    const summary = await adapter.getPullRequest({ owner: 'buyer', repo: 'target-repo', number: 9 });

    expect(summary.headRepoOwner).toBeNull();
    expect(summary.headRepoFullName).toBeNull();
    expect(summary.headRepoIsFork).toBe(false);
    // A missing body projects as '', never null: the route's substring
    // check on the Job trailer must never throw on a PR with no description.
    expect(summary.body).toBe('');
  });

  it('projects a null PR author as authorLogin: null, never guessed', async () => {
    const { fetchImpl } = scriptedFetch([
      jsonResponse(200, {
        state: 'open',
        merged: false,
        merge_commit_sha: null,
        merged_at: null,
        head: { sha: 'sha', repo: { full_name: 'scout-agent/target-repo', fork: true, owner: { login: 'scout-agent' } } },
        additions: 0,
        deletions: 0,
        changed_files: 0,
        base: { repo: { private: false, full_name: 'buyer/target-repo' } },
        user: null,
        body: 'Job: job_1',
      }),
    ]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: PLATFORM_LOGIN });

    const summary = await adapter.getPullRequest({ owner: 'buyer', repo: 'target-repo', number: 9 });

    expect(summary.authorLogin).toBeNull();
  });
});
