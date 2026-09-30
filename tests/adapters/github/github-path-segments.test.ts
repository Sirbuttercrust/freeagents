// SW4-07: a caller's (or GitHub's own) string is one path segment of the
// request the platform token makes, never a path. These tests drive the
// real createGithubAdapter with a recording fetch and pin two things per
// call site: a string that would walk the URL (`..`, `.`, empty) is
// refused before any network call with InvalidPathSegmentError, and an
// ordinary string that needs encoding is fetched as exactly one encoded
// segment. No call here reaches the real GitHub API.
import { describe, expect, it } from 'vitest';

import { createGithubAdapter } from '../../../src/adapters/github/github.js';
import { InvalidPathSegmentError, NotPlatformOwnerError } from '../../../src/adapters/github/types.js';

const TOKEN = 'ghp_test_token_not_real';
const CALLER_TOKEN = 'gho_caller_token_not_real';
const API = 'https://api.github.com';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function recordingFetch(responses: readonly Response[]): { fetchImpl: typeof fetch; urls: string[]; methods: string[] } {
  const urls: string[] = [];
  const methods: string[] = [];
  let index = 0;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    urls.push(String(input));
    methods.push(init?.method ?? 'GET');
    const response = responses[index];
    index += 1;
    if (response === undefined) throw new Error(`recordingFetch: no response scripted for call ${String(index)}`);
    return response;
  }) as typeof fetch;
  return { fetchImpl, urls, methods };
}

const DEFAULTS = {
  owner: 'buyer-org',
  repo: 'buyer-repo',
  sha: 'abc123',
  githubLogin: 'scout-agent',
  id: 'g1',
  base: 'basesha',
  head: 'headsha',
} as const;

type Position = keyof typeof DEFAULTS;
type Values = Record<Position, string>;

const pullRequestBody = {
  state: 'open',
  merged: false,
  merge_commit_sha: null,
  merged_at: null,
  head: { sha: 'h1', repo: null },
  additions: 1,
  deletions: 0,
  changed_files: 1,
  base: { repo: { private: false, full_name: 'buyer-org/buyer-repo' } },
  user: null,
  body: '',
};

interface Site {
  readonly method: string;
  readonly positions: readonly Position[];
  readonly run: (values: Values, fetchImpl: typeof fetch) => Promise<unknown>;
  readonly responses: () => Response[];
  // Per position: an ordinary value that needs encoding, and the whole
  // list of URLs the adapter must then request.
  readonly encoded: Partial<Record<Position, { readonly value: string; readonly urls: readonly string[] }>>;
}

const sites: readonly Site[] = [
  {
    method: 'getPullRequest',
    positions: ['owner', 'repo'],
    run: (v, fetchImpl) =>
      createGithubAdapter({ token: TOKEN, fetchImpl }).getPullRequest({ owner: v.owner, repo: v.repo, number: 7 }),
    responses: () => [jsonResponse(200, pullRequestBody)],
    encoded: {
      owner: { value: 'a#b', urls: [`${API}/repos/a%23b/buyer-repo/pulls/7`] },
      repo: { value: 'r?x', urls: [`${API}/repos/buyer-org/r%3Fx/pulls/7`] },
    },
  },
  {
    method: 'getPublicGist',
    positions: ['id'],
    run: (v, fetchImpl) => createGithubAdapter({ token: TOKEN, fetchImpl }).getPublicGist({ id: v.id }),
    responses: () => [jsonResponse(200, { owner: null, files: {} })],
    encoded: { id: { value: 'g/1?x', urls: [`${API}/gists/g%2F1%3Fx`] } },
  },
  {
    // The owner check runs first, so the platform login is set to the
    // value under test: the segment check is then the only thing that can
    // refuse it.
    method: 'grantPush',
    positions: ['owner', 'repo', 'githubLogin'],
    run: (v, fetchImpl) =>
      createGithubAdapter({ token: TOKEN, fetchImpl, platformLogin: v.owner }).grantPush({
        owner: v.owner,
        repo: v.repo,
        githubLogin: v.githubLogin,
        verifiedGithubLogin: v.githubLogin,
      }),
    responses: () => [noContent()],
    encoded: {
      owner: { value: 'a b', urls: [`${API}/repos/a%20b/buyer-repo/collaborators/scout-agent`] },
      repo: { value: 'r#1', urls: [`${API}/repos/buyer-org/r%231/collaborators/scout-agent`] },
      githubLogin: { value: 'l%41', urls: [`${API}/repos/buyer-org/buyer-repo/collaborators/l%2541`] },
    },
  },
  {
    method: 'getCollaboratorPermission',
    positions: ['owner', 'repo', 'githubLogin'],
    run: (v, fetchImpl) =>
      createGithubAdapter({ token: TOKEN, fetchImpl }).getCollaboratorPermission({
        owner: v.owner,
        repo: v.repo,
        githubLogin: v.githubLogin,
      }),
    responses: () => [jsonResponse(200, { permission: 'write' })],
    encoded: {
      owner: { value: 'a?b', urls: [`${API}/repos/a%3Fb/buyer-repo/collaborators/scout-agent/permission`] },
      repo: { value: 'r%2F', urls: [`${API}/repos/buyer-org/r%252F/collaborators/scout-agent/permission`] },
      githubLogin: { value: 'l/x#y', urls: [`${API}/repos/buyer-org/buyer-repo/collaborators/l%2Fx%23y/permission`] },
    },
  },
  {
    method: 'getCommit',
    positions: ['owner', 'repo', 'sha'],
    run: (v, fetchImpl) =>
      createGithubAdapter({ token: TOKEN, fetchImpl }).getCommit({ owner: v.owner, repo: v.repo, sha: v.sha }),
    responses: () => [jsonResponse(200, { sha: 's1', parents: [], tree: { sha: 't1' } })],
    encoded: {
      owner: { value: 'a#b', urls: [`${API}/repos/a%23b/buyer-repo/git/commits/abc123`] },
      repo: { value: 'r b', urls: [`${API}/repos/buyer-org/r%20b/git/commits/abc123`] },
      sha: { value: '../x?y#z', urls: [`${API}/repos/buyer-org/buyer-repo/git/commits/..%2Fx%3Fy%23z`] },
    },
  },
  {
    method: 'readRepository',
    positions: ['owner', 'repo'],
    run: (v, fetchImpl) => createGithubAdapter({ token: TOKEN, fetchImpl }).readRepository({ owner: v.owner, repo: v.repo }),
    responses: () => [
      jsonResponse(200, {
        full_name: 'buyer-org/buyer-repo',
        private: false,
        allow_forking: true,
        default_branch: 'main',
        owner: { type: 'User' },
      }),
      jsonResponse(200, { object: { sha: 'h1' } }),
    ],
    encoded: {
      owner: {
        value: 'a#b',
        urls: [`${API}/repos/a%23b/buyer-repo`, `${API}/repos/a%23b/buyer-repo/git/ref/heads/main`],
      },
      repo: {
        value: 'r?x',
        urls: [`${API}/repos/buyer-org/r%3Fx`, `${API}/repos/buyer-org/r%3Fx/git/ref/heads/main`],
      },
    },
  },
  {
    method: 'compareCommits',
    positions: ['owner', 'repo', 'base', 'head'],
    run: (v, fetchImpl) =>
      createGithubAdapter({ token: TOKEN, fetchImpl }).compareCommits({
        owner: v.owner,
        repo: v.repo,
        base: v.base,
        head: v.head,
      }),
    responses: () => [jsonResponse(200, { commits: [] })],
    encoded: {
      owner: { value: 'a#b', urls: [`${API}/repos/a%23b/buyer-repo/compare/basesha...headsha`] },
      repo: { value: 'r?x', urls: [`${API}/repos/buyer-org/r%3Fx/compare/basesha...headsha`] },
      base: { value: 'ba/se', urls: [`${API}/repos/buyer-org/buyer-repo/compare/ba%2Fse...headsha`] },
      head: { value: 'he ad%', urls: [`${API}/repos/buyer-org/buyer-repo/compare/basesha...he%20ad%25`] },
    },
  },
  {
    method: 'deleteGist',
    positions: ['id'],
    run: (v, fetchImpl) => createGithubAdapter({ token: TOKEN, fetchImpl }).deleteGist({ token: CALLER_TOKEN, id: v.id }),
    responses: () => [noContent()],
    encoded: { id: { value: 'g/1#x', urls: [`${API}/gists/g%2F1%23x`] } },
  },
];

const WALKING_VALUES = ['..', '.', ''] as const;

function valuesWith(position: Position, value: string): Values {
  return { ...DEFAULTS, [position]: value };
}

describe('SW4-07 (a): a string that would walk the URL is refused before any network call', () => {
  for (const site of sites) {
    for (const position of site.positions) {
      for (const hostile of WALKING_VALUES) {
        // grantPush checks the owner against the platform login first, and an
        // unconfigured (empty) login refuses every owner with
        // NotPlatformOwnerError; that case has its own test below.
        if (site.method === 'grantPush' && position === 'owner' && hostile === '') continue;
        it(`${site.method} refuses ${position} of ${JSON.stringify(hostile)} with zero fetch calls`, async () => {
          const { fetchImpl, urls } = recordingFetch([]);
          await expect(site.run(valuesWith(position, hostile), fetchImpl)).rejects.toBeInstanceOf(InvalidPathSegmentError);
          expect(urls).toEqual([]);
        });
      }
    }
  }

  it('grantPush with an empty owner is refused as not the platform account, with zero fetch calls', async () => {
    const { fetchImpl, urls } = recordingFetch([]);
    await expect(sites.find((s) => s.method === 'grantPush')?.run(valuesWith('owner', ''), fetchImpl)).rejects.toBeInstanceOf(
      NotPlatformOwnerError,
    );
    expect(urls).toEqual([]);
  });

  it('the refusal carries the refused value for the operator log', async () => {
    const { fetchImpl } = recordingFetch([]);
    const error = await createGithubAdapter({ token: TOKEN, fetchImpl })
      .getCommit({ owner: 'buyer-org', repo: 'buyer-repo', sha: '..' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidPathSegmentError);
    expect((error as InvalidPathSegmentError).value).toBe('..');
  });
});

describe('SW4-07 (b): an ordinary string that needs encoding is fetched as exactly one encoded segment', () => {
  for (const site of sites) {
    for (const position of site.positions) {
      const pin = site.encoded[position];
      if (pin === undefined) throw new Error(`no encoded pin for ${site.method} ${position}`);
      it(`${site.method} sends ${position} of ${JSON.stringify(pin.value)} as one encoded segment`, async () => {
        const { fetchImpl, urls } = recordingFetch(site.responses());
        await site.run(valuesWith(position, pin.value), fetchImpl);
        expect(urls).toEqual(pin.urls);
      });
    }
  }
});

describe('SW4-07 (c): readRepository and the default branch GitHub answers with', () => {
  function repoBody(defaultBranch: string): Response {
    return jsonResponse(200, {
      full_name: 'buyer-org/buyer-repo',
      private: false,
      allow_forking: true,
      default_branch: defaultBranch,
      owner: { type: 'User' },
    });
  }

  it('a default_branch of release/1.0 keeps its slash in the ref read', async () => {
    const { fetchImpl, urls } = recordingFetch([repoBody('release/1.0'), jsonResponse(200, { object: { sha: 'h1' } })]);
    const facts = await createGithubAdapter({ token: TOKEN, fetchImpl }).readRepository({ owner: 'buyer-org', repo: 'buyer-repo' });
    expect(urls).toEqual([`${API}/repos/buyer-org/buyer-repo`, `${API}/repos/buyer-org/buyer-repo/git/ref/heads/release/1.0`]);
    expect(facts.defaultBranch).toBe('release/1.0');
  });

  it('a default_branch with characters that need encoding is encoded part by part', async () => {
    const { fetchImpl, urls } = recordingFetch([repoBody('rel#1/a b'), jsonResponse(200, { object: { sha: 'h1' } })]);
    await createGithubAdapter({ token: TOKEN, fetchImpl }).readRepository({ owner: 'buyer-org', repo: 'buyer-repo' });
    expect(urls[1]).toBe(`${API}/repos/buyer-org/buyer-repo/git/ref/heads/rel%231/a%20b`);
  });

  it('a default_branch of ../../user makes no second fetch and throws InvalidPathSegmentError', async () => {
    const { fetchImpl, urls } = recordingFetch([repoBody('../../user')]);
    await expect(
      createGithubAdapter({ token: TOKEN, fetchImpl }).readRepository({ owner: 'buyer-org', repo: 'buyer-repo' }),
    ).rejects.toBeInstanceOf(InvalidPathSegmentError);
    expect(urls).toEqual([`${API}/repos/buyer-org/buyer-repo`]);
  });

  it('a default_branch with an empty part makes no second fetch and throws InvalidPathSegmentError', async () => {
    const { fetchImpl, urls } = recordingFetch([repoBody('release//1.0')]);
    await expect(
      createGithubAdapter({ token: TOKEN, fetchImpl }).readRepository({ owner: 'buyer-org', repo: 'buyer-repo' }),
    ).rejects.toBeInstanceOf(InvalidPathSegmentError);
    expect(urls).toEqual([`${API}/repos/buyer-org/buyer-repo`]);
  });
});
