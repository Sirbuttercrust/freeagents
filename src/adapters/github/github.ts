import { NotImplementedError } from '../not-implemented.js';
import type {
  CommitSignatureStatus,
  ForkAndOpenPullRequestInput,
  Gist,
  GithubAdapter,
  PullRequestRef,
  PullRequestSummary,
} from './types.js';

const CAPABILITY = 'github';

// One implementation file per capability, named for the capability rather
// than the vendor, so the filename survives a vendor swap. This is the only
// layer allowed to know which external service is being called.
export function createGithubAdapter(): GithubAdapter {
  return {
    getPullRequest(_ref: PullRequestRef): Promise<PullRequestSummary> {
      throw new NotImplementedError(CAPABILITY, 'getPullRequest');
    },
    getMergeCommitSignature(_ref: PullRequestRef): Promise<CommitSignatureStatus> {
      throw new NotImplementedError(CAPABILITY, 'getMergeCommitSignature');
    },
    getPublicGist(_ref: { readonly id: string }): Promise<Gist> {
      throw new NotImplementedError(CAPABILITY, 'getPublicGist');
    },
    forkAndOpenPullRequest(_input: ForkAndOpenPullRequestInput): Promise<PullRequestRef> {
      throw new NotImplementedError(CAPABILITY, 'forkAndOpenPullRequest');
    },
  };
}
