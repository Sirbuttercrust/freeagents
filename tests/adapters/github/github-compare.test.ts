// B14b: the compare endpoint this card's real StagingObserver is built
// on. Driven against a fake fetch exactly like every other suite in this
// directory -- no call in this file ever reaches the real GitHub API.
import { describe, expect, it } from 'vitest';

import { createGithubAdapter } from '../../../src/adapters/github/github.js';
import { StagingComparisonTruncatedError } from '../../../src/adapters/github/types.js';

const TOKEN = 'ghp_test_token_not_real';

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
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
    calls.push({ url, method });
    const response = responses[index];
    index += 1;
    if (response === undefined) {
      throw new Error(`scriptedFetch: no response scripted for call ${String(index)} (${method} ${url})`);
    }
    return response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function compareResponse(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse(200, {
    status: 'ahead',
    ahead_by: 2,
    behind_by: 0,
    total_commits: 2,
    commits: [
      {
        sha: 'commit-a',
        author: { login: 'scout-agent' },
        commit: { verification: { verified: true } },
      },
      {
        sha: 'commit-b',
        author: { login: 'someone-else' },
        commit: { verification: { verified: false } },
      },
    ],
    files: [
      { filename: 'src/a.ts', status: 'modified', additions: 5, deletions: 1, patch: '@@ -1 +1,5 @@\n+line' },
      { filename: 'src/a.test.ts', status: 'added', additions: 10, deletions: 0, patch: '@@ -0,0 +1,10 @@\n+it(...)' },
    ],
    ...overrides,
  });
}

describe('createGithubAdapter, compareCommits (B14b)', () => {
  it('requests the compare endpoint with the base...head basehead form', async () => {
    const { fetchImpl, calls } = scriptedFetch([compareResponse()]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

    await adapter.compareCommits({ owner: 'freeagents-platform', repo: 'staging-job_1', base: 'base-sha', head: 'staged-sha' });

    expect(calls).toEqual([
      { url: 'https://api.github.com/repos/freeagents-platform/staging-job_1/compare/base-sha...staged-sha', method: 'GET' },
    ]);
  });

  it('projects files (path, status, additions, deletions, patch) and commits (sha, author login, verified)', async () => {
    const { fetchImpl } = scriptedFetch([compareResponse()]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

    const result = await adapter.compareCommits({ owner: 'freeagents-platform', repo: 'staging-job_1', base: 'base-sha', head: 'staged-sha' });

    expect(result.files).toEqual([
      { path: 'src/a.ts', status: 'modified', additions: 5, deletions: 1, patch: '@@ -1 +1,5 @@\n+line' },
      { path: 'src/a.test.ts', status: 'added', additions: 10, deletions: 0, patch: '@@ -0,0 +1,10 @@\n+it(...)' },
    ]);
    expect(result.commits).toEqual([
      { sha: 'commit-a', authorLogin: 'scout-agent', verified: true },
      { sha: 'commit-b', authorLogin: 'someone-else', verified: false },
    ]);
  });

  it('a file with no patch (binary) projects patch: null, never a crash', async () => {
    const { fetchImpl } = scriptedFetch([
      compareResponse({ files: [{ filename: 'image.png', status: 'modified', additions: 0, deletions: 0 }] }),
    ]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

    const result = await adapter.compareCommits({ owner: 'freeagents-platform', repo: 'staging-job_1', base: 'base-sha', head: 'staged-sha' });
    expect(result.files[0]?.patch).toBeNull();
  });

  it('a commit with no author (no linked GitHub account) projects authorLogin: null', async () => {
    const { fetchImpl } = scriptedFetch([
      compareResponse({ commits: [{ sha: 'commit-c', author: null, commit: { verification: { verified: false } } }] }),
    ]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

    const result = await adapter.compareCommits({ owner: 'freeagents-platform', repo: 'staging-job_1', base: 'base-sha', head: 'staged-sha' });
    expect(result.commits[0]).toEqual({ sha: 'commit-c', authorLogin: null, verified: false });
  });

  // MUTATION PROOF: exactly 300 files in the response is GitHub's own
  // documented cap ("includes up to 300 changed files for the entire
  // comparison"), and the array length hitting that cap is the only
  // truncation signal this endpoint exposes -- there is no separate
  // `truncated` boolean the way the git tree API has one. Fewer than 300
  // is never truncated; exactly 300 always is, per this card's brief.
  it('throws StagingComparisonTruncatedError when the files array hits the 300-file cap', async () => {
    const files = Array.from({ length: 300 }, (_, i) => ({
      filename: `src/file-${String(i)}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: '@@ -1 +1 @@\n+x',
    }));
    const { fetchImpl } = scriptedFetch([compareResponse({ files })]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

    await expect(
      adapter.compareCommits({ owner: 'freeagents-platform', repo: 'staging-job_1', base: 'base-sha', head: 'staged-sha' }),
    ).rejects.toBeInstanceOf(StagingComparisonTruncatedError);
  });

  it('299 files is under the cap and does not throw', async () => {
    const files = Array.from({ length: 299 }, (_, i) => ({
      filename: `src/file-${String(i)}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: '@@ -1 +1 @@\n+x',
    }));
    const { fetchImpl } = scriptedFetch([compareResponse({ files })]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

    await expect(
      adapter.compareCommits({ owner: 'freeagents-platform', repo: 'staging-job_1', base: 'base-sha', head: 'staged-sha' }),
    ).resolves.toBeDefined();
  });

  it('a non-2xx response rejects rather than returning a half-built comparison', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse(404, { message: 'Not Found' })]);
    const adapter = createGithubAdapter({ token: TOKEN, fetchImpl });

    await expect(
      adapter.compareCommits({ owner: 'freeagents-platform', repo: 'staging-job_1', base: 'base-sha', head: 'missing-sha' }),
    ).rejects.toThrow();
  });

  it('fails closed with no token, before any network call', async () => {
    const { fetchImpl, calls } = scriptedFetch([]);
    const adapter = createGithubAdapter({ token: '', fetchImpl });

    await expect(
      adapter.compareCommits({ owner: 'freeagents-platform', repo: 'staging-job_1', base: 'base-sha', head: 'staged-sha' }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
