import { NotImplementedError } from '../not-implemented.js';
import type {
  CommitSignatureStatus,
  ForkAndOpenPullRequestInput,
  GithubAdapter,
  PullRequestRef,
  PullRequestSummary,
} from './types.js';

const CAPABILITY = 'github';

// Named arcblock.ts to match the adapter convention in CLAUDE.md even though
// the real implementation will call GitHub's own API rather than an ArcBlock
// package: one implementation file per capability, one place that is allowed
// to know a vendor exists.
export function createGithubAdapter(): GithubAdapter {
  return {
    getPullRequest(_ref: PullRequestRef): Promise<PullRequestSummary> {
      throw new NotImplementedError(CAPABILITY, 'getPullRequest');
    },
    getMergeCommitSignature(_ref: PullRequestRef): Promise<CommitSignatureStatus> {
      throw new NotImplementedError(CAPABILITY, 'getMergeCommitSignature');
    },
    forkAndOpenPullRequest(_input: ForkAndOpenPullRequestInput): Promise<PullRequestRef> {
      throw new NotImplementedError(CAPABILITY, 'forkAndOpenPullRequest');
    },
  };
}
