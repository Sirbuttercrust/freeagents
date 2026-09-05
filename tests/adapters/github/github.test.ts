// R-10/R-11/R-4: the real GitHub adapter, driven against a fake fetch. No
// call in this file ever reaches the real GitHub API (FACTORY_RULES.md and
// this card both require that). Each test records what the adapter asked
// for -- method, URL, body -- so the read-only posture on the buyer's repo
// (invariant 1) and the repositoryPublic derivation (R-17) are proved
// against real recorded calls, not assumed from the code.
import { describe, expect, it } from 'vitest';

import { createGithubAdapter } from '../../../src/adapters/github/github.js';
import { GistNotFoundError } from '../../../src/adapters/github/types.js';
import type { ForkAndOpenPullRequestInput, PullRequestRef } from '../../../src/adapters/github/types.js';
import { NotImplementedError } from '../../../src/adapters/not-implemented.js';

const TOKEN = 'ghp_test_token_not_real';

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// A scripted fetch: each call consumes the next entry in `responses`,
// recording what it was asked to do before answering, exactly like the
// route-level recordingFake in tests/api/job-pull-request.test.ts records
// adapter calls before resolving them.
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

describe('createGithubAdapter, fails closed with no token', () => {
  it('rejects rather than calling GitHub unauthenticated when no token is configured', async () => {
    const original = process.env.FREEAGENTS_GITHUB_TOKEN;
    delete process.env.FREEAGENTS_GITHUB_TOKEN;
    try {
      const { fetchImpl, calls } = scriptedFetch([]);
      const adapter = createGithubAdapter({ fetchImpl });

      await expect(adapter.getPublicGist({ id: 'g1' })).rejects.toThrow();
      await expect(
        adapter.forkAndOpenPullRequest({
          sourceOwner: 'buyer',
          sourceRepo: 'target-repo',
          branch: 'freeagents/j-1',
          title: 't',
          body: 'b',
        }),
      ).rejects.toThrow();
      await expect(
        adapter.getPullRequest({ owner: 'freeagents-platform', repo: 'target-repo', number: 1 }),
      ).rejects.toThrow();
      // Fails closed BEFORE touching the network: nothing was ever fetched.
      expect(calls).toHaveLength(0);
    } finally {
      if (original === undefined) delete process.env.FREEAGENTS_GITHUB_TOKEN;
      else process.env.FREEAGENTS_GITHUB_TOKEN = original;
    }
  });

  it('an explicit empty-string token also fails closed, even if the env var is set', async () => {
    const original = process.env.FREEAGENTS_GITHUB_TOKEN;
    process.env.FREEAGENTS_GITHUB_TOKEN = 'ghp_env_token';
    try {
      const { fetchImpl, calls } = scriptedFetch([]);
      const adapter = createGithubAdapter({ token: '', fetchImpl });

      await expect(adapter.getPublicGist({ id: 'g1' })).rejects.toThrow();
      expect(calls).toHaveLength(0);
    } finally {
      if (original === undefined) delete process.env.FREEAGENTS_GITHUB_TOKEN;
      else process.env.FREEAGENTS_GITHUB_TOKEN = original;
    }
  });
});

describe('createGithubAdapter, getPublicGist (R-4)', () => {
  it('fetches the gist by id and projects owner and file contents', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      jsonResponse(200, {
        owner: { login: 'scout-agent' },
        files: { 'proof.txt': { content: 'freeagents-github-proof v1\ndid:abt:agent\nhttps://github.com/scout-agent\n' } },
      }),
    ]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

    const gist = await adapter.getPublicGist({ id: 'abc123' });

    expect(calls).toEqual([{ url: 'https://api.github.com/gists/abc123', method: 'GET', body: undefined }]);
    expect(gist).toEqual({
      id: 'abc123',
      owner: 'scout-agent',
      files: { 'proof.txt': 'freeagents-github-proof v1\ndid:abt:agent\nhttps://github.com/scout-agent\n' },
    });
  });

  it('maps a 404 to GistNotFoundError: a deleted gist is the check answering, not an outage (R-5)', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse(404, { message: 'Not Found' })]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

    await expect(adapter.getPublicGist({ id: 'gone' })).rejects.toBeInstanceOf(GistNotFoundError);
  });

  it('projects a gist with no owner as owner: null', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse(200, { owner: null, files: {} })]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

    const gist = await adapter.getPublicGist({ id: 'anon' });
    expect(gist.owner).toBeNull();
    expect(gist.files).toEqual({});
  });

  it('a platform-side failure other than 404 rejects rather than answering GistNotFoundError', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse(500, { message: 'server error' })]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

    await expect(adapter.getPublicGist({ id: 'flaky' })).rejects.not.toBeInstanceOf(GistNotFoundError);
  });
});

describe('createGithubAdapter, getPullRequest (R-11 observation, R-17 repositoryPublic)', () => {
  const ref: PullRequestRef = { owner: 'freeagents-platform', repo: 'target-repo', number: 3 };

  function pullResponse(overrides: Record<string, unknown> = {}): Response {
    return jsonResponse(200, {
      state: 'closed',
      merged: true,
      merge_commit_sha: 'deadbeef',
      merged_at: '2026-08-25T09:00:00Z',
      head: { sha: 'headsha123' },
      additions: 55,
      deletions: 6,
      changed_files: 3,
      base: { repo: { private: false } },
      ...overrides,
    });
  }

  it('fetches the pull request and maps every GitHub-reported fact onto PullRequestSummary', async () => {
    const { fetchImpl, calls } = scriptedFetch([pullResponse()]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

    const summary = await adapter.getPullRequest(ref);

    expect(calls).toEqual([
      { url: 'https://api.github.com/repos/freeagents-platform/target-repo/pulls/3', method: 'GET', body: undefined },
    ]);
    expect(summary).toEqual({
      ref,
      state: 'merged',
      mergeCommitSha: 'deadbeef',
      mergedAt: new Date('2026-08-25T09:00:00Z'),
      headSha: 'headsha123',
      additions: 55,
      deletions: 6,
      filesChanged: 3,
      repositoryPublic: true,
    });
  });

  it('an open pull request reports state open and a null merge instant', async () => {
    const { fetchImpl } = scriptedFetch([
      pullResponse({ state: 'open', merged: false, merge_commit_sha: null, merged_at: null }),
    ]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

    const summary = await adapter.getPullRequest(ref);
    expect(summary.state).toBe('open');
    expect(summary.mergeCommitSha).toBeNull();
    expect(summary.mergedAt).toBeNull();
  });

  it('a closed, unmerged pull request reports state closed, never merged', async () => {
    const { fetchImpl } = scriptedFetch([
      pullResponse({ state: 'closed', merged: false, merge_commit_sha: null, merged_at: null }),
    ]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

    const summary = await adapter.getPullRequest(ref);
    expect(summary.state).toBe('closed');
  });

  // MUTATION PROOF (R-17): repositoryPublic is base.repo.private inverted,
  // never passed through. Both directions are pinned so a dropped `!`
  // (private true landing as public true, or the reverse) goes red either
  // way this card's mutation proof requires.
  it.each([
    [true, false],
    [false, true],
  ])('base.repo.private=%s becomes repositoryPublic=%s (inverted, never passed through)', async (isPrivate, expectedPublic) => {
    const { fetchImpl } = scriptedFetch([pullResponse({ base: { repo: { private: isPrivate } } })]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

    const summary = await adapter.getPullRequest(ref);
    expect(summary.repositoryPublic).toBe(expectedPublic);
  });

  it('a non-2xx response rejects rather than returning a half-built summary', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse(404, { message: 'Not Found' })]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

    await expect(adapter.getPullRequest(ref)).rejects.toThrow();
  });
});

describe('createGithubAdapter, forkAndOpenPullRequest (R-10, invariant 1: fork and PR, never write access)', () => {
  const input: ForkAndOpenPullRequestInput = {
    sourceOwner: 'buyer',
    sourceRepo: 'target-repo',
    branch: 'freeagents/j-1',
    title: 'FreeAgents job j-1',
    body: 'Job: j-1\nThis pull request was opened by FreeAgents against a fork it controls; the platform holds no write access to the source repository.',
  };

  function scriptHappyPath(): { fetchImpl: typeof fetch; calls: RecordedRequest[] } {
    return scriptedFetch([
      // 1. fork the source repo to the platform account (sanctioned write
      //    against the buyer's repo path: this IS the fork exception).
      jsonResponse(202, { owner: { login: 'freeagents-platform' }, name: 'target-repo', default_branch: 'main' }),
      // 2. read the fork's own default-branch head (the fork, never the source).
      jsonResponse(200, { object: { sha: 'fork-head-sha' } }),
      // 3. create the working branch on the fork (the fork, never the source).
      jsonResponse(201, { ref: 'refs/heads/freeagents/j-1', object: { sha: 'fork-head-sha' } }),
      // 4. open the pull request against the source (the second and only
      //    other sanctioned write against the buyer's repo path).
      jsonResponse(201, { number: 7 }),
    ]);
  }

  it('forks, branches on the fork, and opens the PR against the source, in that order', async () => {
    const { fetchImpl, calls } = scriptHappyPath();
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

    const ref = await adapter.forkAndOpenPullRequest(input);

    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', 'https://api.github.com/repos/buyer/target-repo/forks'],
      ['GET', 'https://api.github.com/repos/freeagents-platform/target-repo/git/ref/heads/main'],
      ['POST', 'https://api.github.com/repos/freeagents-platform/target-repo/git/refs'],
      ['POST', 'https://api.github.com/repos/buyer/target-repo/pulls'],
    ]);
    // R-10, D1 fix (Proof run 100, changes_requested): GitHub allocates the
    // pull request number in the BASE repository's namespace, not the
    // fork's - POST /repos/{source}/pulls returns a PR that resolves at
    // https://github.com/{source}/pull/{n}. Returning the fork's owner/repo
    // with that number names a ref that does not exist, which is exactly
    // why the merge route's getPullRequest 404s later. The ref this adapter
    // hands back has to be the one GitHub will actually answer to.
    expect(ref).toEqual({ owner: 'buyer', repo: 'target-repo', number: 7 });
  });

  // MUTATION PROOF (D1): forkAndOpenPullRequest's return value is not just
  // shaped right, it has to be the SAME address getPullRequest can read back
  // - chaining the two closes the gap Proof found, where the adapter suite
  // and the api-level fake each hard-coded the fork-owner ref and agreed
  // with each other instead of with GitHub. Here the second call is driven
  // by the first call's own output, through the same fetchImpl, so a
  // regression back to the fork-owner ref fails this test the same way it
  // failed against real GitHub (404, not merged).
  it('the ref returned by forkAndOpenPullRequest is the one getPullRequest can read back (chained, not assumed)', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      // fork, read fork ref, create branch, open PR - the same four calls
      // as the happy path above.
      jsonResponse(202, { owner: { login: 'freeagents-platform' }, name: 'target-repo', default_branch: 'main' }),
      jsonResponse(200, { object: { sha: 'fork-head-sha' } }),
      jsonResponse(201, { ref: 'refs/heads/freeagents/j-1', object: { sha: 'fork-head-sha' } }),
      jsonResponse(201, { number: 7 }),
      // The merge observation GitHub actually serves PR 7 at: the source
      // repo (buyer/target-repo), not the fork.
      jsonResponse(200, {
        state: 'closed',
        merged: true,
        merge_commit_sha: 'deadbeef',
        merged_at: '2026-08-25T09:00:00Z',
        head: { sha: 'headsha123' },
        additions: 1,
        deletions: 1,
        changed_files: 1,
        base: { repo: { private: false } },
      }),
    ]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

    const ref = await adapter.forkAndOpenPullRequest(input);
    const summary = await adapter.getPullRequest(ref);

    // The 5th call is the observation, driven entirely by what
    // forkAndOpenPullRequest handed back - if that ref still named the
    // fork, this URL would 404 against real GitHub.
    expect(calls[4]).toEqual({
      url: 'https://api.github.com/repos/buyer/target-repo/pulls/7',
      method: 'GET',
      body: undefined,
    });
    expect(summary.state).toBe('merged');
  });

  it('the pull request names head as fork-owner:branch and base as the fork default branch, carrying the title and body verbatim', async () => {
    const { fetchImpl, calls } = scriptHappyPath();
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

    await adapter.forkAndOpenPullRequest(input);

    expect(calls[3]?.body).toEqual({
      title: input.title,
      body: input.body,
      head: 'freeagents-platform:freeagents/j-1',
      base: 'main',
    });
  });

  it('the branch is created on the fork with the sha read from the fork itself, not invented', async () => {
    const { fetchImpl, calls } = scriptHappyPath();
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

    await adapter.forkAndOpenPullRequest(input);

    expect(calls[2]?.body).toEqual({ ref: 'refs/heads/freeagents/j-1', sha: 'fork-head-sha' });
  });

  // MUTATION PROOF (invariant 1): every write call (non-GET) against the
  // SOURCE (buyer's) repository path is one of the two sanctioned
  // exceptions the scope names -- forking it and opening the PR against it
  // -- and nothing else. A future change that routed the branch-ref write
  // at the buyer's repo instead of the fork goes red here.
  it('no write call targets the buyer repo except the fork request and the pull request', async () => {
    const { fetchImpl, calls } = scriptHappyPath();
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

    await adapter.forkAndOpenPullRequest(input);

    const buyerRepoPrefix = 'https://api.github.com/repos/buyer/target-repo';
    const writesAgainstBuyerRepo = calls.filter((c) => c.method !== 'GET' && c.url.startsWith(buyerRepoPrefix));
    expect(writesAgainstBuyerRepo.map((c) => c.url)).toEqual([`${buyerRepoPrefix}/forks`, `${buyerRepoPrefix}/pulls`]);

    // And the branch-creating write landed on the fork, never the buyer repo.
    const forkRepoPrefix = 'https://api.github.com/repos/freeagents-platform/target-repo';
    expect(calls.some((c) => c.method === 'POST' && c.url === `${forkRepoPrefix}/git/refs`)).toBe(true);
  });

  it('propagates a fork failure without reading a ref, creating a branch, or opening a pull request', async () => {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse(403, { message: 'blocked' })]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

    await expect(adapter.forkAndOpenPullRequest(input)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('propagates a pull-request-open failure after the fork and branch already happened', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      jsonResponse(202, { owner: { login: 'freeagents-platform' }, name: 'target-repo', default_branch: 'main' }),
      jsonResponse(200, { object: { sha: 'fork-head-sha' } }),
      jsonResponse(201, { ref: 'refs/heads/freeagents/j-1', object: { sha: 'fork-head-sha' } }),
      jsonResponse(422, { message: 'validation failed' }),
    ]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

    await expect(adapter.forkAndOpenPullRequest(input)).rejects.toThrow();
    expect(calls).toHaveLength(4);
  });
});

describe('createGithubAdapter, FREEAGENTS_GITHUB_API_BASE override (B4)', () => {
  it('honours the env override for every call the adapter makes', async () => {
    const original = process.env.FREEAGENTS_GITHUB_API_BASE;
    process.env.FREEAGENTS_GITHUB_API_BASE = 'https://github-double.internal.test';
    try {
      const { fetchImpl, calls } = scriptedFetch([
        jsonResponse(200, { owner: { login: 'scout-agent' }, files: {} }),
      ]);
      const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

      await adapter.getPublicGist({ id: 'abc123' });

      expect(calls).toEqual([
        { url: 'https://github-double.internal.test/gists/abc123', method: 'GET', body: undefined },
      ]);
    } finally {
      if (original === undefined) delete process.env.FREEAGENTS_GITHUB_API_BASE;
      else process.env.FREEAGENTS_GITHUB_API_BASE = original;
    }
  });

  it('defaults to the real GitHub API when the env var is unset', async () => {
    const original = process.env.FREEAGENTS_GITHUB_API_BASE;
    delete process.env.FREEAGENTS_GITHUB_API_BASE;
    try {
      const { fetchImpl, calls } = scriptedFetch([
        jsonResponse(200, { owner: { login: 'scout-agent' }, files: {} }),
      ]);
      const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

      await adapter.getPublicGist({ id: 'abc123' });

      expect(calls).toEqual([{ url: 'https://api.github.com/gists/abc123', method: 'GET', body: undefined }]);
    } finally {
      if (original === undefined) delete process.env.FREEAGENTS_GITHUB_API_BASE;
      else process.env.FREEAGENTS_GITHUB_API_BASE = original;
    }
  });

  it('an explicit empty-string env var also falls back to the real GitHub API (Blocklet Server materialises unset vars as \'\')', async () => {
    const original = process.env.FREEAGENTS_GITHUB_API_BASE;
    process.env.FREEAGENTS_GITHUB_API_BASE = '';
    try {
      const { fetchImpl, calls } = scriptedFetch([
        jsonResponse(200, { owner: { login: 'scout-agent' }, files: {} }),
      ]);
      const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

      await adapter.getPublicGist({ id: 'abc123' });

      expect(calls).toEqual([{ url: 'https://api.github.com/gists/abc123', method: 'GET', body: undefined }]);
    } finally {
      if (original === undefined) delete process.env.FREEAGENTS_GITHUB_API_BASE;
      else process.env.FREEAGENTS_GITHUB_API_BASE = original;
    }
  });
});

describe('createGithubAdapter, getMergeCommitSignature (unbuilt: nothing on main calls it yet)', () => {
  it('throws NotImplementedError, honest about the gap rather than a stub answer', () => {
    const { fetchImpl } = scriptedFetch([]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

    // Throws synchronously, the same shape as every other stub method in
    // this codebase (see tests/adapters/credentials/resolver.test.ts), so
    // the assertion wraps the call itself rather than awaiting a rejection.
    expect(() => adapter.getMergeCommitSignature({ owner: 'buyer', repo: 'target-repo', number: 1 })).toThrowError(
      NotImplementedError,
    );
  });
});
