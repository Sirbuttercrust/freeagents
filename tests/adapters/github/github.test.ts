// R-10/R-11/R-4: the real GitHub adapter, driven against a fake fetch. No
// call in this file ever reaches the real GitHub API (FACTORY_RULES.md and
// this card both require that). Each test records what the adapter asked
// for -- method, URL, body -- so the read-only posture on the buyer's repo
// (invariant 1) and the repositoryPublic derivation (R-17) are proved
// against real recorded calls, not assumed from the code.
import { describe, expect, it } from 'vitest';

import { createGithubAdapter } from '../../../src/adapters/github/github.js';
import { GistNotFoundError } from '../../../src/adapters/github/types.js';
import type { PullRequestRef } from '../../../src/adapters/github/types.js';
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
        adapter.createStagingRepository({
          jobId: 'job_1',
          sourceOwner: 'buyer',
          sourceRepo: 'target-repo',
          baseCommit: 'base-sha',
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

// forkAndOpenPullRequest's own coverage moved to
// tests/adapters/github/github-staging.test.ts's openStagedPullRequest
// suite (B14a): the fork mechanism this adapter used is gone -- a
// private repository under the platform account IS the platform's copy
// now, so there is no fork step left to fork, read a fork ref for, or
// branch on.

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
