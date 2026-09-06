// GitHub capability: read-only, plus the staging repository lifecycle
// (B14a) and opening the pull request from it. There is no method here
// that writes to a repository the caller does not own, by construction:
// createStagingRepository only ever creates a repository under the
// platform account, grantPush only ever adds a collaborator to a
// repository the platform owns, and openStagedPullRequest's only write
// against the buyer's (source) repository is the pull request itself --
// the standard cross-repo PR shape, which grants no write access to the
// source's contents (invariant 1).

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
}

export interface CommitSignatureStatus {
  readonly verified: boolean;
  readonly reason: string;
}

// B14a: the staging repository half of the hire loop (bugs.md B14/B14a).
// Every staged commit lives in a repository the platform created, at a
// base the platform pinned, and the pull request opens from that exact
// commit -- never from a fork of the buyer's repository, and never from
// a branch the adapter merely assumes exists.

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

// B14a: what the confirm route reads to learn WHAT to pin as baseCommit
// before it ever calls createStagingRepository -- "the base the platform
// pinned" (the card's own anchor) has to come from somewhere, and this is
// the one read this adapter makes against the buyer's own default
// branch, never a write.
export interface DefaultBranchHead {
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

// R-10, invariant 1: the pull request opens from the staging repository
// at the attested commit. stagingOwner/stagingRepo/stagedCommit name
// WHERE the platform's own copy of the work lives and WHICH commit was
// attested; sourceOwner/sourceRepo name the buyer's repository, read
// only as the PR's base -- never written to except by the PR-open call
// itself (the sanctioned cross-repo write NotPlatformOwnerError's own
// comment names).
export interface OpenStagedPullRequestInput {
  readonly stagingOwner: string;
  readonly stagingRepo: string;
  readonly stagedCommit: string;
  readonly sourceOwner: string;
  readonly sourceRepo: string;
  readonly branch: string;
  readonly title: string;
  readonly body: string;
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

export interface GithubAdapter {
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
  // B14a: reads the buyer's repository's own default branch and its
  // current head sha -- the fact the confirm route pins as baseCommit
  // before creating the staging repository. Read-only.
  getDefaultBranchHead(ref: StagingRepoRef): Promise<DefaultBranchHead>;
  // B14a: opens the pull request from the staging repository at the
  // attested commit. Creates a branch in the staging repo pointing at
  // stagedCommit (so the agent cannot move it after attestation), then
  // opens the PR with that branch as head and the source repository as
  // base -- the standard cross-repo PR shape, no write access granted
  // to the source's contents (invariant 1).
  openStagedPullRequest(input: OpenStagedPullRequestInput): Promise<PullRequestRef>;
}
