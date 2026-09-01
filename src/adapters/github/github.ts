import { NotImplementedError } from '../not-implemented.js';
import {
  GistNotFoundError,
  type CommitSignatureStatus,
  type ForkAndOpenPullRequestInput,
  type Gist,
  type GithubAdapter,
  type PullRequestRef,
  type PullRequestSummary,
} from './types.js';

const CAPABILITY = 'github';
const API_BASE = 'https://api.github.com';

// This card builds three of the four methods for real; the fourth
// (getMergeCommitSignature) has no caller on main yet, so it stays a named
// NotImplementedError rather than a guessed-ahead implementation
// (FACTORY_RULES.md 2.5: never build beyond what the issue asked for).
//
// Token scopes the platform account needs, for whoever mints
// FREEAGENTS_GITHUB_TOKEN: a classic PAT with the `public_repo` scope is
// sufficient for every call this adapter makes. `public_repo` covers
// forking a public repository (POST .../forks), creating a branch on the
// fork (POST .../git/refs), and opening a pull request against the source
// repository (POST .../pulls) -- write access to the fork, which this
// platform owns, plus the ability to open a PR against a repo it does not
// own, never write access to the buyer's repository itself (invariant 1).
// Reading pull requests and public gists needs no scope beyond the token's
// baseline read access. A fine-grained PAT is the same shape: "Contents"
// (write) and "Pull requests" (write) on the platform account's own
// repositories/forks, "Pull requests" (write) as the cross-repo grant that
// lets it open PRs elsewhere. See docs.github.com/en/rest/repos/forks,
// docs.github.com/en/rest/pulls/pulls, docs.github.com/en/rest/git/refs,
// docs.github.com/en/rest/gists/gists (apiVersion=2022-11-28).

export interface CreateGithubAdapterOptions {
  /** Defaults to FREEAGENTS_GITHUB_TOKEN from the environment. */
  readonly token?: string;
  /** Injected for tests; defaults to the real fetch (no network in the test suite otherwise). */
  readonly fetchImpl?: typeof fetch;
}

interface GitHubErrorBody {
  readonly message?: unknown;
}

async function githubRequest(
  fetchImpl: typeof fetch,
  token: string,
  path: string,
  init: { readonly method?: string; readonly body?: unknown } = {},
): Promise<Response> {
  const response = await fetchImpl(`${API_BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return response;
}

async function requireOk(response: Response, action: string): Promise<Response> {
  if (!response.ok) {
    let detail = '';
    try {
      const body = (await response.json()) as GitHubErrorBody;
      if (typeof body.message === 'string') detail = `: ${body.message}`;
    } catch {
      // Body was not JSON (or empty); the status code alone is still informative.
    }
    throw new Error(`github ${action} failed with status ${String(response.status)}${detail}`);
  }
  return response;
}

interface RawPullRequest {
  readonly state: string;
  readonly merged: boolean;
  readonly merge_commit_sha: string | null;
  readonly merged_at: string | null;
  readonly head: { readonly sha: string };
  readonly additions: number;
  readonly deletions: number;
  readonly changed_files: number;
  readonly base: { readonly repo: { readonly private: boolean } };
}

// merged wins over the raw `state` string: a merged PR reports state
// "closed" on the wire, and the domain distinguishes merged from
// closed_unmerged (R-12), so the boolean is checked first.
function pullRequestState(raw: RawPullRequest): PullRequestSummary['state'] {
  if (raw.merged) return 'merged';
  return raw.state === 'closed' ? 'closed' : 'open';
}

interface RawGistFile {
  readonly content?: unknown;
}

interface RawGist {
  readonly owner: { readonly login?: unknown } | null;
  readonly files: Record<string, RawGistFile>;
}

// One implementation file per capability, named for the capability rather
// than the vendor, so the filename survives a vendor swap. This is the only
// layer allowed to know which external service is being called.
export function createGithubAdapter(options: CreateGithubAdapterOptions = {}): GithubAdapter {
  // `||` and not `??`, matching every other env-derived factory in this
  // codebase (credentials.ts platformIssuerFromEnv, session-github-passkey.ts
  // sessionAdapterFromEnv): Blocklet Server materialises every declared env
  // var, so an unconfigured deployment delivers '' rather than undefined.
  const token = options.token ?? (process.env.FREEAGENTS_GITHUB_TOKEN || '');
  const fetchImpl = options.fetchImpl ?? fetch;

  // Fails closed BEFORE any network call: an absent or empty token cannot
  // authenticate, so every method rejects immediately rather than attempting
  // an unauthenticated call to GitHub. The API route maps this rejection to
  // 503 "github unavailable", the same honest behaviour an unconfigured
  // deployment already gives (storage.ts, credentials.ts follow this shape).
  function requireToken(): string {
    if (token === '') {
      throw new Error('github adapter: FREEAGENTS_GITHUB_TOKEN is not configured');
    }
    return token;
  }

  return {
    async getPullRequest(ref: PullRequestRef): Promise<PullRequestSummary> {
      const tok = requireToken();
      const response = await githubRequest(fetchImpl, tok, `/repos/${ref.owner}/${ref.repo}/pulls/${String(ref.number)}`);
      await requireOk(response, 'getPullRequest');
      const raw = (await response.json()) as RawPullRequest;
      return {
        ref,
        state: pullRequestState(raw),
        mergeCommitSha: raw.merge_commit_sha,
        mergedAt: raw.merged_at === null ? null : new Date(raw.merged_at),
        headSha: raw.head.sha,
        additions: raw.additions,
        deletions: raw.deletions,
        filesChanged: raw.changed_files,
        // R-17: base.repo.private, inverted. Never passed through, never
        // counted or asserted by this service (see types.ts's own comment).
        repositoryPublic: !raw.base.repo.private,
      };
    },

    getMergeCommitSignature(_ref: PullRequestRef): Promise<CommitSignatureStatus> {
      throw new NotImplementedError(CAPABILITY, 'getMergeCommitSignature');
    },

    // R-4: a public gist by id. No authentication required by GitHub for a
    // public gist, but this adapter still fails closed on a missing
    // platform token for consistency with every other method (and because
    // an unconfigured deployment should announce itself uniformly).
    async getPublicGist(ref: { readonly id: string }): Promise<Gist> {
      const tok = requireToken();
      const response = await githubRequest(fetchImpl, tok, `/gists/${ref.id}`);
      if (response.status === 404) {
        // R-5 (ENT-5.3): a deleted gist is not a platform outage, it is the
        // check's answer. The route maps this to the downgrade path.
        throw new GistNotFoundError(ref.id);
      }
      await requireOk(response, 'getPublicGist');
      const raw = (await response.json()) as RawGist;
      const files: Record<string, string> = {};
      for (const [name, file] of Object.entries(raw.files)) {
        files[name] = typeof file.content === 'string' ? file.content : '';
      }
      return {
        id: ref.id,
        owner: typeof raw.owner?.login === 'string' ? raw.owner.login : null,
        files,
      };
    },

    // R-10, invariant 1: fork the buyer's repo to the platform account,
    // branch on the fork, open the pull request from the fork against the
    // source. Every write against the SOURCE (buyer's) repository path is
    // one of exactly two calls: the fork request itself (GitHub's own
    // sanctioned "copy this repo to my account" action) and the pull
    // request (which targets the source only as the PR's base, the
    // standard cross-repo PR shape -- it grants no write access to the
    // source's contents). The branch that actually holds new commits is
    // created on the fork, never on the source.
    async forkAndOpenPullRequest(input: ForkAndOpenPullRequestInput): Promise<PullRequestRef> {
      const tok = requireToken();

      // 1. Fork to the platform account. Forking is asynchronous per
      // GitHub's own docs (a fork "happens asynchronously"), but the 202
      // response already names the fork's owner and default branch, which
      // is everything the next two steps need.
      const forkResponse = await githubRequest(fetchImpl, tok, `/repos/${input.sourceOwner}/${input.sourceRepo}/forks`, {
        method: 'POST',
      });
      await requireOk(forkResponse, 'fork');
      const fork = (await forkResponse.json()) as {
        readonly owner: { readonly login: string };
        readonly name: string;
        readonly default_branch: string;
      };
      const forkOwner = fork.owner.login;
      const forkRepo = fork.name;
      const forkDefaultBranch = fork.default_branch;

      // 2. Read the fork's own default-branch head. The fork, never the
      // source: the working branch has to start from a commit that exists
      // on the fork this platform actually controls.
      const refResponse = await githubRequest(
        fetchImpl,
        tok,
        `/repos/${forkOwner}/${forkRepo}/git/ref/heads/${forkDefaultBranch}`,
      );
      await requireOk(refResponse, 'read fork ref');
      const forkRef = (await refResponse.json()) as { readonly object: { readonly sha: string } };

      // 3. Create the working branch on the fork.
      const branchResponse = await githubRequest(fetchImpl, tok, `/repos/${forkOwner}/${forkRepo}/git/refs`, {
        method: 'POST',
        body: { ref: `refs/heads/${input.branch}`, sha: forkRef.object.sha },
      });
      await requireOk(branchResponse, 'create branch');

      // 4. Open the pull request: head names the fork owner and branch,
      // base is the fork's default branch (the branch the fork was cut
      // from), targeting the SOURCE repository as GitHub's cross-repo PR
      // convention requires.
      const prResponse = await githubRequest(fetchImpl, tok, `/repos/${input.sourceOwner}/${input.sourceRepo}/pulls`, {
        method: 'POST',
        body: {
          title: input.title,
          body: input.body,
          head: `${forkOwner}:${input.branch}`,
          base: forkDefaultBranch,
        },
      });
      await requireOk(prResponse, 'open pull request');
      const pr = (await prResponse.json()) as { readonly number: number };

      // D1 fix (Proof run 100, changes_requested): GitHub allocates the
      // pull request number in the BASE repository's namespace, not the
      // fork's. POST /repos/{source}/pulls returns a PR that resolves at
      // https://github.com/{source}/pull/{n} (GitHub's own docs use exactly
      // that shape: octocat/Hello-World/pull/1347). Returning the fork's
      // owner/repo here would hand back a ref that 404s the moment
      // getPullRequest tries to read it. Reading GitHub as a witness (the
      // card's anchor) means naming the address GitHub itself answers to.
      return { owner: input.sourceOwner, repo: input.sourceRepo, number: pr.number };
    },
  };
}
