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
  readonly headSha: string;
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

export interface GithubAdapter {
  getPullRequest(ref: PullRequestRef): Promise<PullRequestSummary>;
  getMergeCommitSignature(ref: PullRequestRef): Promise<CommitSignatureStatus>;
  forkAndOpenPullRequest(input: ForkAndOpenPullRequestInput): Promise<PullRequestRef>;
}
