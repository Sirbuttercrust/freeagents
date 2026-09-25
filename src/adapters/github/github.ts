import { NotImplementedError } from '../not-implemented.js';
import {
  GistNotFoundError,
  NotPlatformOwnerError,
  RepositoryNotAccessibleError,
  StagingComparisonTruncatedError,
  UnverifiedGithubLoginError,
  type CommitInfo,
  type CommitSignatureStatus,
  type CompareCommitsInput,
  type CompareCommitsResult,
  type CreateStagingRepositoryInput,
  type CreateStagingRepositoryResult,
  type DefaultBranchHead,
  type Gist,
  type GetCommitInput,
  type GithubAdapter,
  type GrantPushInput,
  type PullRequestRef,
  type PullRequestSummary,
  type StagingRepoRef,
} from './types.js';

const CAPABILITY = 'github';
const DEFAULT_API_BASE = 'https://api.github.com';

// This card builds the read methods and the staging repository lifecycle
// (B14a) for real; getMergeCommitSignature has no caller on main yet, so
// it stays a named NotImplementedError rather than a guessed-ahead
// implementation (FACTORY_RULES.md 2.5: never build beyond what the issue
// asked for).
//
// Token scope the platform account needs, for whoever mints
// FREEAGENTS_GITHUB_TOKEN: a classic PAT needs the `repo` scope (not
// `public_repo`), because B14a's staging repository lifecycle creates a
// PRIVATE repository and adds a collaborator to it -- `public_repo`
// cannot create a private repo and cannot add a collaborator to any
// repository. `repo` covers creating a repository for the authenticated
// user (POST /user/repos), adding a collaborator (PUT
// .../collaborators/{username}), and reading a pull request the AGENT
// opened on the buyer's repository (GET .../pulls/{n}) -- never write
// access to the buyer's repository or the agent's fork (STG2, invariant
// 1: the platform never opens a pull request and never pushes to a
// repository it does not own). A fine-grained PAT is the same shape:
// "Contents" (read and write) and "Administration" (write, for
// repository creation and collaborator management) on the platform
// account's own repositories, "Pull requests" (read) on the buyer's
// repository. See docs.github.com/en/rest/repos/repos,
// docs.github.com/en/rest/collaborators/collaborators,
// docs.github.com/en/rest/pulls/pulls, docs.github.com/en/rest/gists/gists
// (apiVersion=2022-11-28).

export interface CreateGithubAdapterOptions {
  /** Defaults to FREEAGENTS_GITHUB_TOKEN from the environment. */
  readonly token?: string;
  /** Injected for tests; defaults to the real fetch (no network in the test suite otherwise). */
  readonly fetchImpl?: typeof fetch;
  /** Defaults to FREEAGENTS_GITHUB_API_BASE from the environment, or the real GitHub API. */
  readonly apiBase?: string;
  // B14a: the platform's own GitHub login, the ONLY owner every mutating
  // staging-lifecycle call may target (invariant 1's adapter-level
  // fence). Defaults to FREEAGENTS_GITHUB_PLATFORM_LOGIN from the
  // environment.
  readonly platformLogin?: string;
}

interface GitHubErrorBody {
  readonly message?: unknown;
}

async function githubRequest(
  fetchImpl: typeof fetch,
  apiBase: string,
  token: string,
  path: string,
  init: { readonly method?: string; readonly body?: unknown } = {},
): Promise<Response> {
  const response = await fetchImpl(`${apiBase}${path}`, {
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
  readonly head: {
    readonly sha: string;
    readonly repo: { readonly full_name: string; readonly fork: boolean; readonly owner: { readonly login: string } } | null;
  };
  readonly additions: number;
  readonly deletions: number;
  readonly changed_files: number;
  readonly base: { readonly repo: { readonly private: boolean; readonly full_name: string } };
  readonly user: { readonly login: string } | null;
  readonly body: string | null;
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

// B14b: the compare-two-commits response shape, narrowed to the fields
// this adapter's compareCommits projects (docs.github.com/en/rest/commits
// /commits#compare-two-commits). `files` is optional on the wire when a
// comparison has zero changed files (GitHub omits the key rather than
// sending an empty array in that case).
interface RawCompareFile {
  readonly filename: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patch?: string;
}

interface RawCompareCommit {
  readonly sha: string;
  readonly author: { readonly login?: string } | null;
  readonly commit: { readonly verification?: { readonly verified: boolean } };
}

interface RawCompareResponse {
  readonly commits: readonly RawCompareCommit[];
  readonly files?: readonly RawCompareFile[];
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
  // B4: this is what let the rehearsal run against a GitHub double only by
  // patching dist, which must never be necessary again. Same `||` stance as
  // every other env-derived default in this file.
  const apiBase = options.apiBase ?? (process.env.FREEAGENTS_GITHUB_API_BASE || DEFAULT_API_BASE);
  // B14a: the platform's own GitHub login, checked before every mutating
  // staging-lifecycle call.
  const platformLogin = options.platformLogin ?? (process.env.FREEAGENTS_GITHUB_PLATFORM_LOGIN || '');

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

  // B14a, invariant 1's adapter-level fence: every mutating staging-repo
  // call names its owner up front and this refuses before any network call
  // when that owner is not the platform account. An unconfigured
  // platformLogin fails the SAME way an absent token does -- there is no
  // owner this adapter could safely assume.
  function requirePlatformOwner(owner: string): void {
    if (platformLogin === '' || owner !== platformLogin) {
      throw new NotPlatformOwnerError(owner);
    }
  }

  return {
    async getPullRequest(ref: PullRequestRef): Promise<PullRequestSummary> {
      const tok = requireToken();
      const response = await githubRequest(fetchImpl, apiBase, tok, `/repos/${ref.owner}/${ref.repo}/pulls/${String(ref.number)}`);
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
        // STG2: the fork-delivery facts, straight off the same PR object.
        // head.repo is null when GitHub reports the head repository gone
        // (e.g. a deleted fork) -- projected as null throughout, never
        // guessed at.
        headRepoOwner: raw.head.repo === null ? null : raw.head.repo.owner.login,
        headRepoFullName: raw.head.repo === null ? null : raw.head.repo.full_name,
        headRepoIsFork: raw.head.repo === null ? false : raw.head.repo.fork,
        baseRepoFullName: raw.base.repo.full_name,
        authorLogin: raw.user === null ? null : raw.user.login,
        body: raw.body ?? '',
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
      const response = await githubRequest(fetchImpl, apiBase, tok, `/gists/${ref.id}`);
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

    // B14a, STG2: creates an EMPTY private repository under the platform
    // account -- no auto_init, no seeded blob/tree/commit, no root
    // commit. The agent seeds it itself by cloning the buyer's repository
    // and pushing (real history, real SHAs), so baseCommit ends up living
    // in staging with its true SHA rather than a platform-authored copy.
    // A fork is not used (card brief): forks of a public repo cannot be
    // private, and a fork carries the buyer's history, which the agent
    // has no business rewriting.
    async createStagingRepository(input: CreateStagingRepositoryInput): Promise<CreateStagingRepositoryResult> {
      const tok = requireToken();

      const repoResponse = await githubRequest(fetchImpl, apiBase, tok, '/user/repos', {
        method: 'POST',
        body: { name: `staging-${input.jobId}`, private: true, auto_init: false },
      });
      await requireOk(repoResponse, 'create staging repository');
      const repo = (await repoResponse.json()) as {
        readonly owner: { readonly login: string };
        readonly name: string;
        readonly default_branch: string;
      };

      return { owner: repo.owner.login, repo: repo.name, defaultBranch: repo.default_branch, baseCommit: input.baseCommit };
    },

    // B14a: adds the agent's verified GitHub login as a push collaborator
    // on a staging repository the platform owns. Refuses (before any
    // network call) when the login named is not the agent's verified
    // login, or when the owner is not the platform account.
    async grantPush(input: GrantPushInput): Promise<void> {
      requirePlatformOwner(input.owner);
      if (input.githubLogin !== input.verifiedGithubLogin) {
        throw new UnverifiedGithubLoginError(input.githubLogin);
      }
      const tok = requireToken();
      const response = await githubRequest(
        fetchImpl,
        apiBase,
        tok,
        `/repos/${input.owner}/${input.repo}/collaborators/${input.githubLogin}`,
        { method: 'PUT', body: { permission: 'push' } },
      );
      await requireOk(response, 'grant push');
    },

    // B14a: reads a commit so the stage route can prove a SHA exists in
    // the staging repository and descends from baseCommit. Read-only:
    // never subject to the owner check (a caller may read a commit from
    // any repository the token can see, including the buyer's).
    async getCommit(input: GetCommitInput): Promise<CommitInfo> {
      const tok = requireToken();
      const response = await githubRequest(fetchImpl, apiBase, tok, `/repos/${input.owner}/${input.repo}/git/commits/${input.sha}`);
      await requireOk(response, 'get commit');
      const raw = (await response.json()) as {
        readonly sha: string;
        readonly parents: ReadonlyArray<{ readonly sha: string }>;
        readonly tree: { readonly sha: string };
        readonly verification?: { readonly verified: boolean };
      };
      return {
        sha: raw.sha,
        parents: raw.parents.map((parent) => parent.sha),
        treeSha: raw.tree.sha,
        signed: raw.verification?.verified ?? false,
      };
    },

    // B14a: reads the buyer's repository's own default branch name and
    // its current head sha -- the confirm route pins this as baseCommit
    // before creating the staging repository. Read-only.
    //
    // ORG1: a 404 or 403 reading the repository itself means the
    // platform's account cannot see it at all -- most commonly a
    // personal-account private repository, where GitHub offers no
    // read-only role (docs.github.com, permission levels for a personal
    // account repository). That is a fact about the repository, not a
    // transient failure, so it throws the typed
    // RepositoryNotAccessibleError rather than the generic Error every
    // other non-2xx response here throws; the confirm route maps it to
    // 409 with an actionable message instead of 503. The SECOND request
    // (the branch ref) is not specially handled: if the repository read
    // above succeeded, the platform can see the repository, so a failure
    // reading its ref is a real anomaly, not an access question.
    async getDefaultBranchHead(ref: StagingRepoRef): Promise<DefaultBranchHead> {
      const tok = requireToken();
      const repoResponse = await githubRequest(fetchImpl, apiBase, tok, `/repos/${ref.owner}/${ref.repo}`);
      if (repoResponse.status === 404 || repoResponse.status === 403) {
        throw new RepositoryNotAccessibleError(ref.owner, ref.repo, repoResponse.status);
      }
      await requireOk(repoResponse, 'read repository');
      const repo = (await repoResponse.json()) as { readonly default_branch: string };
      const refResponse = await githubRequest(
        fetchImpl,
        apiBase,
        tok,
        `/repos/${ref.owner}/${ref.repo}/git/ref/heads/${repo.default_branch}`,
      );
      await requireOk(refResponse, 'read default branch head');
      const headRef = (await refResponse.json()) as { readonly object: { readonly sha: string } };
      return { defaultBranch: repo.default_branch, sha: headRef.object.sha };
    },

    // B14b: compares two commits within one repository (the staging
    // repository, per invariant 1 -- this adapter never calls compare
    // cross-repo) via GET /repos/{owner}/{repo}/compare/{base}...{head}
    // (docs.github.com/en/rest/commits/commits#compare-two-commits).
    // Read-only, no owner check: comparing is not a write.
    async compareCommits(input: CompareCommitsInput): Promise<CompareCommitsResult> {
      const tok = requireToken();
      const response = await githubRequest(
        fetchImpl,
        apiBase,
        tok,
        `/repos/${input.owner}/${input.repo}/compare/${input.base}...${input.head}`,
      );
      await requireOk(response, 'compare commits');
      const raw = (await response.json()) as RawCompareResponse;

      // GitHub's own documented cap: the files array reports "up to 300
      // changed files for the entire comparison", with no separate
      // truncated flag on this endpoint (unlike the git tree API's
      // `truncated` boolean). Hitting exactly 300 is the only signal
      // available that more files exist than were returned, so this
      // fails closed rather than attesting a partial diff.
      if (raw.files !== undefined && raw.files.length >= 300) {
        throw new StagingComparisonTruncatedError(input.owner, input.repo, input.base, input.head);
      }

      return {
        files: (raw.files ?? []).map((file) => ({
          path: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          patch: file.patch ?? null,
        })),
        commits: raw.commits.map((commit) => ({
          sha: commit.sha,
          authorLogin: commit.author?.login ?? null,
          verified: commit.commit.verification?.verified ?? false,
        })),
      };
    },
  };
}
