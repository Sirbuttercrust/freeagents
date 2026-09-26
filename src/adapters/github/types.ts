// GitHub capability: read-only, plus the staging repository lifecycle
// (B14a) and, since STG2, plain reads of a pull request the AGENT opened
// itself from its own fork. There is no method here that writes to a
// repository the caller does not own, by construction: createStagingRepository
// only ever creates an empty repository under the platform account, and
// grantPush only ever adds a collaborator to a repository the platform
// owns. Nothing in this adapter ever opens a pull request or writes a
// single byte against the buyer's (source) repository or the agent's own
// fork -- the agent holds its own GitHub credentials and does that work
// itself, outside this service (invariant 1, STG2 refined shape).

export interface PullRequestRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export interface PullRequestSummary {
  readonly ref: PullRequestRef;
  readonly state: 'open' | 'closed' | 'merged';
  readonly mergeCommitSha: string | null;
  // ENT-7: the merge instant comes from GitHub's API, never asserted by a
  // party; null while the pull request is unmerged.
  readonly mergedAt: Date | null;
  readonly headSha: string;
  // ENT-8 diffSize: the pulls API reports these three on the PR object
  // itself, so the credential's diff facts come from GitHub's own report
  // rather than from anything this service counted.
  readonly additions: number;
  readonly deletions: number;
  readonly filesChanged: number;
  // MISSION invariant 4: the pulls API reports the base repository's
  // visibility on the same PR object (base.repo.private, inverted). This is
  // the one fact evidenceTier needs beyond a merge to decide verified-hire
  // versus portfolio, and it comes from GitHub's own report for the same
  // reason additions/deletions/filesChanged do above: never counted or
  // asserted by this service or by either party.
  readonly repositoryPublic: boolean;
  // STG2: the fork-delivery facts the pull-request route checks before it
  // will ever record `submitted`, and the merge route checks again before
  // it will record any outcome. All five come straight off GitHub's own
  // pull request object -- never asserted by either party.
  //
  // headRepoOwner/headRepoFullName/headRepoIsFork are null when GitHub
  // reports head.repo as null (the documented shape for a PR whose head
  // repository was since deleted -- e.g. the agent deleted its fork). A
  // null head repo can never be an agent-owned fork, so the route's own
  // fork check treats null the same as "not a match", never as "unknown".
  readonly headRepoOwner: string | null;
  readonly headRepoFullName: string | null;
  readonly headRepoIsFork: boolean;
  // The PR's base repository, full name (owner/repo). Compared against
  // job.repository by the pull-request route.
  readonly baseRepoFullName: string;
  // The PR's author login. Null when GitHub reports no user (a rare wire
  // shape; docs.github.com/en/rest/pulls/pulls does not guarantee `user`
  // is non-null on every response).
  readonly authorLogin: string | null;
  // The PR body, exactly as GitHub stores it. '' when GitHub reports null
  // (a PR opened with no description) -- never guessed at.
  readonly body: string;
}

export interface CommitSignatureStatus {
  readonly verified: boolean;
  readonly reason: string;
}

// B14a: the staging repository half of the hire loop (bugs.md B14/B14a).
// STG2: every staged commit lives in an EMPTY repository the platform
// created -- no seeded tree, no root commit, never any history the
// platform authored -- and the agent seeds it itself by pushing a real
// clone of the buyer's repository, so baseCommit exists in staging with
// its true SHA, the buyer's own commit ancestry intact.

export interface StagingRepoRef {
  readonly owner: string;
  readonly repo: string;
}

export interface CreateStagingRepositoryInput {
  readonly jobId: string;
  readonly sourceOwner: string;
  readonly sourceRepo: string;
  readonly baseCommit: string;
}

export interface CreateStagingRepositoryResult {
  readonly owner: string;
  readonly repo: string;
  readonly defaultBranch: string;
  readonly baseCommit: string;
}

export interface GrantPushInput {
  readonly owner: string;
  readonly repo: string;
  // The agent's VERIFIED GitHub login (R-3/R-4, ENT-5) -- grantPush
  // refuses a login that does not match, so a caller cannot use this
  // method to hand push access to an arbitrary account.
  readonly githubLogin: string;
  readonly verifiedGithubLogin: string;
}

export interface GetCommitInput {
  readonly owner: string;
  readonly repo: string;
  readonly sha: string;
}

export interface CommitInfo {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly treeSha: string;
  readonly signed: boolean;
}

// B14a, FIX-B36: what confirm reads to learn WHAT to pin as baseCommit
// before it ever calls createStagingRepository -- "the base the platform
// pinned" (the card's own anchor) has to come from somewhere -- and, since
// FIX-B36, the same facts the three deposit-start doors need to refuse a
// repository that is not ready before the deposit moves (the deposit goes
// buyer to owner and never comes back, MISSION invariant 12). fullName is
// GitHub's own canonical owner/repo, which follows a move (GitHub answers
// 301 to the repository's new location and this adapter's fetch follows
// it); private, allowForking and defaultBranch come from the same
// repository read; ownerIsOrganization is owner.type === 'Organization'
// (STEER 2026-09-26: a personal account's private repository has no
// read-only role on GitHub, so if the platform can see one at all,
// someone was given collaborator access, which carries write --
// MISSION invariant 1 forbids an agent holding write); sha is the
// default branch's current head, from the ref read that follows.
export interface RepositoryFacts {
  readonly fullName: string;
  readonly private: boolean;
  readonly allowForking: boolean;
  readonly ownerIsOrganization: boolean;
  readonly defaultBranch: string;
  readonly sha: string;
}

// Thrown by grantPush when the login named is not the agent's verified
// GitHub login: refuse to hand push access on an unverified assertion.
export class UnverifiedGithubLoginError extends Error {
  constructor(githubLogin: string) {
    super(`refusing to grant push to ${githubLogin}: not the agent's verified GitHub login`);
    this.name = 'UnverifiedGithubLoginError';
  }
}

// Invariant 1's adapter-level fence: thrown by any mutating call this
// adapter is asked to make against a repository owner that is not the
// platform account itself. The only two SANCTIONED exceptions -- writes
// this adapter is allowed to make against a repository it does not own
// -- are POST .../pulls (opening the pull request, the standard
// cross-repo PR shape, which grants no write access to the source's
// contents) and PATCH .../collaborators (never called against a
// non-platform owner in the first place, since only the platform's own
// staging repos ever grant a collaborator). Every other write this
// adapter can make -- creating a repository's tree/commit, creating or
// moving a branch ref, adding a collaborator -- is checked here.
export class NotPlatformOwnerError extends Error {
  constructor(owner: string) {
    super(`refusing to write to ${owner}: not the platform account`);
    this.name = 'NotPlatformOwnerError';
  }
}

// ORG1, FIX-B36: thrown by readRepository when the platform's own token
// cannot read the buyer's repository (404, or 403 on some GitHub
// configurations for a repository the account was never invited to).
// Distinct from every other failure this adapter can raise: a real
// outage (5xx, network) stays a bare Error, which the confirm route
// and the deposit-start doors still map to 503; this one names a fact
// about the repository itself (private, and the platform's account has
// no role on it), which those routes map to 409 with an actionable
// message instead.
export class RepositoryNotAccessibleError extends Error {
  constructor(owner: string, repo: string, status: number) {
    super(`repository ${owner}/${repo} is not accessible to the platform's GitHub account (status ${String(status)})`);
    this.name = 'RepositoryNotAccessibleError';
  }
}

// FIX-B36: thrown by readRepository when the buyer's repository has no
// commits at all -- the ref read (GET .../git/ref/heads/<default branch>)
// answers 409 "Git Repository is empty." on a repository with no root
// commit (measured 2026-09-26 against a real public empty repository).
// GitHub cannot open a pull request into a repository with no commits, so
// this is a fact about the repository, never a transient outage: the
// deposit-start doors map it to 409 with a message naming the fix
// (one starting commit) before any money moves.
export class RepositoryEmptyError extends Error {
  constructor(owner: string, repo: string) {
    super(`repository ${owner}/${repo} has no commits yet; a pull request cannot be opened into it`);
    this.name = 'RepositoryEmptyError';
  }
}

// A public gist, as far as the account-proof flow cares about it: the id, the
// GitHub login of its author, and the contents of its files by name.
export interface Gist {
  readonly id: string;
  readonly owner: string | null;
  readonly files: Record<string, string>;
}

// R-5 (ENT-5.3): a gist that no longer resolves (deleted, renamed) is not a
// platform outage - it is the fact that the proof no longer stands. The API
// maps this to the downgrade path and everything else to 503, without
// inspecting error messages.
export class GistNotFoundError extends Error {
  constructor(id: string) {
    super(`gist ${id} no longer resolves`);
    this.name = 'GistNotFoundError';
  }
}

// B14b: the compare endpoint the real StagingObserver
// (src/adapters/staging/github.ts) is built on. base and head are commit
// SHAs (or refs) within the SAME repository named by owner/repo -- the
// staging repository, per invariant 1 -- never a cross-repo comparison.
export interface CompareCommitsInput {
  readonly owner: string;
  readonly repo: string;
  readonly base: string;
  readonly head: string;
}

// One changed file from the compare response, projected to the four
// facts the observer needs. status is GitHub's own vocabulary verbatim
// ('added' | 'removed' | 'modified' | 'renamed' | ...): this adapter does
// not narrow it further, because the observer's own test-file-removed
// rule only cares whether status is 'removed'. patch is null for a
// binary file or any file GitHub declines to diff -- never guessed at.
export interface CompareFile {
  readonly path: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string | null;
}

// One commit between base and head, projected to the three facts the
// observer needs for commitSigners: the sha, the GitHub-linked author's
// login (null when the commit's author email resolves to no GitHub
// account), and GitHub's own verification verdict for that commit's
// signature.
export interface CompareCommit {
  readonly sha: string;
  readonly authorLogin: string | null;
  readonly verified: boolean;
}

export interface CompareCommitsResult {
  readonly files: readonly CompareFile[];
  readonly commits: readonly CompareCommit[];
}

// B14b: GitHub's compare endpoint silently caps the files array at 300
// entries with no separate `truncated` flag (the docs' own wording: "the
// list of changed files ... includes up to 300 changed files for the
// entire comparison"). A files array at exactly that cap is the only
// signal this endpoint gives that more files exist than were returned,
// and a comparison this large cannot be attested honestly -- the route
// this error surfaces through (POST /jobs/:jobId/stage) maps it to 422
// with a sentence telling the agent to split the work, per this card's
// brief.
export class StagingComparisonTruncatedError extends Error {
  constructor(owner: string, repo: string, base: string, head: string) {
    super(
      `the comparison ${owner}/${repo}@${base}...${head} reports 300 or more changed files, GitHub's own cap on this endpoint; the change is too large to attest`,
    );
    this.name = 'StagingComparisonTruncatedError';
  }
}

export interface GithubAdapter {
  // ORG1 r2 fix: exposes the resolved value directly, not the raw env
  // var, so a caller sees exactly what requirePlatformOwner compares
  // against (including the options.platformLogin override tests use).
  // Every method that runs on the platform's single token
  // (getPullRequest, readRepository) does so as this account, so a
  // caller naming "the account that needs read access" to a buyer must
  // name this one, not the agent's. '' when unconfigured, matching the
  // adapter's other env-derived defaults.
  readonly platformLogin: string;
  getPullRequest(ref: PullRequestRef): Promise<PullRequestSummary>;
  getMergeCommitSignature(ref: PullRequestRef): Promise<CommitSignatureStatus>;
  // R-4: a public gist by id. No authentication: the statement is public by
  // design, so anyone can fetch it without this service.
  getPublicGist(ref: { readonly id: string }): Promise<Gist>;
  // B14a: creates a PRIVATE repository under the platform account,
  // seeded from the buyer's repository at baseCommit. Refuses (via
  // NotPlatformOwnerError) on any attempt to seed from a base the
  // adapter cannot read, but never writes to sourceOwner/sourceRepo --
  // reading a tree at a commit is the only call this method makes
  // against the buyer's repository.
  createStagingRepository(input: CreateStagingRepositoryInput): Promise<CreateStagingRepositoryResult>;
  // B14a: adds the agent's verified GitHub login as a push collaborator
  // on a staging repository the platform owns. Throws
  // UnverifiedGithubLoginError when githubLogin does not match
  // verifiedGithubLogin, and NotPlatformOwnerError when owner is not the
  // platform account.
  grantPush(input: GrantPushInput): Promise<void>;
  // B14a: reads a commit from a repository (staging or otherwise) so the
  // stage route can prove a SHA exists and descends from baseCommit.
  // Read-only: never subject to the owner check.
  getCommit(input: GetCommitInput): Promise<CommitInfo>;
  // B14a, FIX-B36: reads the buyer's repository -- full name (follows a
  // move), private, allowForking, ownerIsOrganization, default branch and
  // its current head sha -- the facts confirm pins as baseCommit before
  // creating the staging repository, and the facts the three deposit-start
  // doors read before a deposit leg starts (FIX-B36 Make item 2). Read-only.
  // Throws RepositoryNotAccessibleError on a 404/403 reading the repository
  // itself, and RepositoryEmptyError on a 409 reading the default branch's
  // ref (an empty repository: no commits, so no pull request can ever open
  // into it).
  readRepository(ref: StagingRepoRef): Promise<RepositoryFacts>;
  // B14b: compares two commits in the SAME repository and returns the
  // changed files (path, status, additions, deletions, patch) and the
  // commits between them (sha, author login, verification verdict).
  // Read-only. Throws StagingComparisonTruncatedError when the files
  // array reports GitHub's own 300-file cap.
  compareCommits(input: CompareCommitsInput): Promise<CompareCommitsResult>;
}
