import { NotImplementedError } from '../not-implemented.js';
import {
  GistNotFoundError,
  NotPlatformOwnerError,
  UnverifiedGithubLoginError,
  type CommitInfo,
  type CommitSignatureStatus,
  type CreateStagingRepositoryInput,
  type CreateStagingRepositoryResult,
  type DefaultBranchHead,
  type Gist,
  type GetCommitInput,
  type GithubAdapter,
  type GrantPushInput,
  type OpenStagedPullRequestInput,
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
// PRIVATE repository, reads the buyer's repository's git objects, and
// adds a collaborator -- `public_repo` cannot create a private repo or
// read a private one, and cannot add a collaborator to any repository.
// `repo` covers creating a repository for the authenticated user (POST
// /user/repos), reading and writing git objects (trees, blobs, commits,
// refs) on both the buyer's repository and the platform's own staging
// repositories, adding a collaborator (PUT .../collaborators/{username}),
// and opening a pull request against a repository the platform does not
// own -- never write access to the buyer's repository's default branch or
// its own collaborator list (invariant 1). A fine-grained PAT is the same
// shape: "Contents" (read and write) and "Administration" (write, for
// repository creation and collaborator management) on the platform
// account's own repositories, "Contents" (read) plus "Pull requests"
// (write) as the cross-repo grant against the buyer's repository. See
// docs.github.com/en/rest/repos/repos, docs.github.com/en/rest/git/trees,
// docs.github.com/en/rest/git/blobs, docs.github.com/en/rest/git/commits,
// docs.github.com/en/rest/git/refs,
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

    // B14a: creates a private repository under the platform account,
    // seeded from the buyer's repository at baseCommit via the Git Data
    // API (read the source tree, create the same tree and a root commit
    // in the new repo). auto_init: true sidesteps GitHub's own
    // restriction that a ref cannot be created in a truly empty
    // repository (docs.github.com/en/rest/git/refs: "You are unable to
    // create new references for empty repositories"); the seeded root
    // commit then force-repoints the auto-initialised default branch,
    // discarding the throwaway initial commit auto_init made. A fork is
    // not used (card brief): forks of a public repo cannot be private,
    // and a fork carries the buyer's history, which the agent has no
    // business rewriting.
    async createStagingRepository(input: CreateStagingRepositoryInput): Promise<CreateStagingRepositoryResult> {
      const tok = requireToken();

      // 1. Create the private repo under the platform account.
      const repoResponse = await githubRequest(fetchImpl, apiBase, tok, '/user/repos', {
        method: 'POST',
        body: { name: `staging-${input.jobId}`, private: true, auto_init: true },
      });
      await requireOk(repoResponse, 'create staging repository');
      const repo = (await repoResponse.json()) as {
        readonly owner: { readonly login: string };
        readonly name: string;
        readonly default_branch: string;
      };
      const owner = repo.owner.login;
      const repoName = repo.name;
      const defaultBranch = repo.default_branch;

      // 2. Read the base commit to learn its tree. Read-only against the
      // source repository.
      const baseCommitResponse = await githubRequest(
        fetchImpl,
        apiBase,
        tok,
        `/repos/${input.sourceOwner}/${input.sourceRepo}/git/commits/${input.baseCommit}`,
      );
      await requireOk(baseCommitResponse, 'read base commit');
      const baseCommit = (await baseCommitResponse.json()) as { readonly tree: { readonly sha: string } };

      // 3. Read the source tree recursively (every path in one call).
      const sourceTreeResponse = await githubRequest(
        fetchImpl,
        apiBase,
        tok,
        `/repos/${input.sourceOwner}/${input.sourceRepo}/git/trees/${baseCommit.tree.sha}?recursive=1`,
      );
      await requireOk(sourceTreeResponse, 'read source tree');
      const sourceTree = (await sourceTreeResponse.json()) as {
        readonly truncated: boolean;
        readonly tree: ReadonlyArray<{
          readonly path: string;
          readonly mode: string;
          readonly type: string;
          readonly sha: string;
        }>;
      };
      // A truncated listing means GitHub did not return every entry;
      // seeding from a partial tree would silently drop files, so this
      // refuses rather than publishing an incomplete staging repository.
      if (sourceTree.truncated) {
        throw new Error(
          `github createStagingRepository: source tree at ${baseCommit.tree.sha} was truncated by the API; too large to seed in one call`,
        );
      }

      // 4. Copy every blob (files only; the recursive listing already
      // flattens subdirectories into path-qualified entries, so no tree
      // objects need copying, only blobs).
      const blobEntries = sourceTree.tree.filter((entry) => entry.type === 'blob');
      const seededTree: Array<{ path: string; mode: string; type: string; sha: string }> = [];
      for (const entry of blobEntries) {
        const blobResponse = await githubRequest(
          fetchImpl,
          apiBase,
          tok,
          `/repos/${input.sourceOwner}/${input.sourceRepo}/git/blobs/${entry.sha}`,
        );
        await requireOk(blobResponse, 'read source blob');
        const blob = (await blobResponse.json()) as { readonly content: string; readonly encoding: string };
        const createBlobResponse = await githubRequest(fetchImpl, apiBase, tok, `/repos/${owner}/${repoName}/git/blobs`, {
          method: 'POST',
          body: { content: blob.content, encoding: blob.encoding },
        });
        await requireOk(createBlobResponse, 'create staging blob');
        const createdBlob = (await createBlobResponse.json()) as { readonly sha: string };
        seededTree.push({ path: entry.path, mode: entry.mode, type: entry.type, sha: createdBlob.sha });
      }

      // 5. Build the same tree in the staging repository.
      const treeResponse = await githubRequest(fetchImpl, apiBase, tok, `/repos/${owner}/${repoName}/git/trees`, {
        method: 'POST',
        body: { tree: seededTree },
      });
      await requireOk(treeResponse, 'create staging tree');
      const stagingTree = (await treeResponse.json()) as { readonly sha: string };

      // 6. A ROOT commit, no parents: staging history never inherits the
      // buyer's (card brief, "a fork carries the buyer's history the
      // agent has no business rewriting").
      const commitResponse = await githubRequest(fetchImpl, apiBase, tok, `/repos/${owner}/${repoName}/git/commits`, {
        method: 'POST',
        body: { message: `Seed from ${input.sourceOwner}/${input.sourceRepo}@${input.baseCommit}`, tree: stagingTree.sha, parents: [] },
      });
      await requireOk(commitResponse, 'create staging root commit');
      const rootCommit = (await commitResponse.json()) as { readonly sha: string };

      // 7. Force-repoint the auto_init default branch at the seeded root
      // commit, discarding auto_init's own throwaway README commit.
      const refResponse = await githubRequest(fetchImpl, apiBase, tok, `/repos/${owner}/${repoName}/git/refs/heads/${defaultBranch}`, {
        method: 'PATCH',
        body: { sha: rootCommit.sha, force: true },
      });
      await requireOk(refResponse, 'repoint staging default branch');

      return { owner, repo: repoName, defaultBranch, baseCommit: input.baseCommit };
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
    async getDefaultBranchHead(ref: StagingRepoRef): Promise<DefaultBranchHead> {
      const tok = requireToken();
      const repoResponse = await githubRequest(fetchImpl, apiBase, tok, `/repos/${ref.owner}/${ref.repo}`);
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

    // R-10, invariant 1: opens the pull request from the staging
    // repository at the attested commit, never from a branch the adapter
    // merely assumes exists. Every write against the SOURCE (buyer's)
    // repository path is exactly one call: the pull request itself (the
    // standard cross-repo PR shape -- it grants no write access to the
    // source's contents). The branch that names the attested commit is
    // created on the staging repository, never on the source, so the
    // agent cannot move it after attestation.
    async openStagedPullRequest(input: OpenStagedPullRequestInput): Promise<PullRequestRef> {
      requirePlatformOwner(input.stagingOwner);
      const tok = requireToken();

      // 1. Create the branch on the staging repo, pointed at the
      // attested commit.
      const branchResponse = await githubRequest(fetchImpl, apiBase, tok, `/repos/${input.stagingOwner}/${input.stagingRepo}/git/refs`, {
        method: 'POST',
        body: { ref: `refs/heads/${input.branch}`, sha: input.stagedCommit },
      });
      await requireOk(branchResponse, 'create staged branch');

      // 2. Read the source repository's own default branch (read-only):
      // the PR's base is whatever the buyer's repository is actually on,
      // never assumed.
      const sourceRepoResponse = await githubRequest(fetchImpl, apiBase, tok, `/repos/${input.sourceOwner}/${input.sourceRepo}`);
      await requireOk(sourceRepoResponse, 'read source repository');
      const sourceRepo = (await sourceRepoResponse.json()) as { readonly default_branch: string };

      // 3. Open the pull request: head names the staging owner and
      // branch via head_repo (GitHub's own cross-repo shape for two
      // repositories that are not fork-related -- proven live 2026-09-06
      // against a genuine non-fork cross-repo PR), base is the source's
      // own default branch, targeting the SOURCE repository as GitHub's
      // cross-repo PR convention requires.
      const prResponse = await githubRequest(fetchImpl, apiBase, tok, `/repos/${input.sourceOwner}/${input.sourceRepo}/pulls`, {
        method: 'POST',
        body: {
          title: input.title,
          body: input.body,
          head: `${input.stagingOwner}:${input.branch}`,
          head_repo: input.stagingRepo,
          base: sourceRepo.default_branch,
        },
      });
      await requireOk(prResponse, 'open pull request');
      const pr = (await prResponse.json()) as { readonly number: number };

      // The pull request number is allocated in the BASE repository's
      // namespace (GitHub's own docs: POST /repos/{source}/pulls returns
      // a PR that resolves at https://github.com/{source}/pull/{n}), so
      // the ref this adapter hands back names the address GitHub itself
      // answers to.
      return { owner: input.sourceOwner, repo: input.sourceRepo, number: pr.number };
    },
  };
}
