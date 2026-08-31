// GitHub capability: read-only, plus exactly one mutating action, fork and
// open a pull request. There is no method here that writes to a repository
// the caller does not own, by construction: forkAndOpenPullRequest only ever
// targets a fork this platform created (invariant 1).

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

export interface ForkAndOpenPullRequestInput {
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
  forkAndOpenPullRequest(input: ForkAndOpenPullRequestInput): Promise<PullRequestRef>;
}
