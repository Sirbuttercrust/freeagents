// B14a: a shared, working fake GithubAdapter for API-level tests that walk
// a job through confirm -> stage -> pull-request without themselves being
// about the staging repository mechanics (those are covered exactly and
// strictly by tests/adapters/github/github-staging.test.ts's unit suite,
// and by tests/api/job-confirm-staging.test.ts / job-stage-repo.test.ts /
// job-pull-request.test.ts at the route level). This fixture is
// deliberately generous, the same stance anyCommitStagingObserver already
// takes in tests/helpers/staging-fixtures.ts: any commit sha an agent
// posts to a staging repo THIS fixture created is accepted as a fresh
// child of the base commit, so tests that only care about "the job
// reached submitted" do not have to fabricate a real git history.
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import {
  type CommitInfo,
  type CreateStagingRepositoryInput,
  type CreateStagingRepositoryResult,
  type DefaultBranchHead,
  type GetCommitInput,
  type GithubAdapter,
  type GrantPushInput,
  type OpenStagedPullRequestInput,
  type PullRequestRef,
  type StagingRepoRef,
} from '../../src/adapters/github/types.js';

export const PLATFORM_LOGIN = 'freeagents-platform';

interface RepoState {
  readonly defaultBranch: string;
  readonly commits: Map<string, { readonly parents: readonly string[] }>;
}

export interface StagingLifecycleCalls {
  readonly createStagingRepository: CreateStagingRepositoryInput[];
  readonly grantPush: GrantPushInput[];
  readonly getCommit: GetCommitInput[];
  readonly getDefaultBranchHead: StagingRepoRef[];
  readonly openStagedPullRequest: OpenStagedPullRequestInput[];
}

export interface StagingLifecycleFixture {
  readonly github: GithubAdapter;
  readonly calls: StagingLifecycleCalls;
  // Configures the source repository's default branch and head sha
  // (what getDefaultBranchHead answers). Defaults to main /
  // `${owner}-${repo}-head-sha` when never configured.
  setDefaultBranchHead(owner: string, repo: string, head: DefaultBranchHead): void;
}

function defaultHeadFor(owner: string, repo: string): DefaultBranchHead {
  return { defaultBranch: 'main', sha: `${owner}-${repo}-head-sha` };
}

// Every capability this GithubAdapter does not implement for real throws
// NotImplementedError, the same shape the real adapter's own unbuilt
// method (getMergeCommitSignature) throws -- callers layer getPullRequest
// on top via object spread when a test also needs merge observation.
export function createStagingLifecycleGithubFake(): StagingLifecycleFixture {
  const sourceHeads = new Map<string, DefaultBranchHead>();
  const repos = new Map<string, RepoState>();
  const calls: StagingLifecycleCalls = {
    createStagingRepository: [],
    grantPush: [],
    getCommit: [],
    getDefaultBranchHead: [],
    openStagedPullRequest: [],
  };
  let nextPrNumber = 1;

  function repoKey(owner: string, repo: string): string {
    return `${owner}/${repo}`;
  }

  const github: GithubAdapter = {
    getPullRequest: () => Promise.reject(new NotImplementedError('github', 'getPullRequest')),
    getMergeCommitSignature: () => Promise.reject(new NotImplementedError('github', 'getMergeCommitSignature')),
    getPublicGist: () => Promise.reject(new NotImplementedError('github', 'getPublicGist')),

    async createStagingRepository(input: CreateStagingRepositoryInput): Promise<CreateStagingRepositoryResult> {
      calls.createStagingRepository.push(input);
      const owner = PLATFORM_LOGIN;
      const repo = `staging-${input.jobId}`;
      const commits = new Map<string, { parents: readonly string[] }>();
      commits.set(input.baseCommit, { parents: [] });
      repos.set(repoKey(owner, repo), { defaultBranch: 'main', commits });
      return { owner, repo, defaultBranch: 'main', baseCommit: input.baseCommit };
    },

    async grantPush(input: GrantPushInput): Promise<void> {
      calls.grantPush.push(input);
      if (input.owner !== PLATFORM_LOGIN) {
        throw new Error(`fake github: refusing grantPush against non-platform owner ${input.owner}`);
      }
    },

    async getCommit(input: GetCommitInput): Promise<CommitInfo> {
      calls.getCommit.push(input);
      const state = repos.get(repoKey(input.owner, input.repo));
      if (state === undefined) {
        throw new Error(`fake github: no repository ${input.owner}/${input.repo}`);
      }
      let commit = state.commits.get(input.sha);
      if (commit === undefined) {
        // Generous: a sha never seen before in a staging repo this
        // fixture created is accepted as a fresh child of the base
        // commit (the first entry ever registered for this repo), so
        // an arbitrary agent-posted stagedCommit always descends.
        const base = [...state.commits.keys()][0];
        commit = { parents: base === undefined ? [] : [base] };
        state.commits.set(input.sha, commit);
      }
      return { sha: input.sha, parents: commit.parents, treeSha: `${input.sha}-tree`, signed: false };
    },

    async getDefaultBranchHead(ref: StagingRepoRef): Promise<DefaultBranchHead> {
      calls.getDefaultBranchHead.push(ref);
      return sourceHeads.get(repoKey(ref.owner, ref.repo)) ?? defaultHeadFor(ref.owner, ref.repo);
    },

    async openStagedPullRequest(input: OpenStagedPullRequestInput): Promise<PullRequestRef> {
      calls.openStagedPullRequest.push(input);
      if (input.stagingOwner !== PLATFORM_LOGIN) {
        throw new Error(`fake github: refusing openStagedPullRequest against non-platform staging owner ${input.stagingOwner}`);
      }
      const number = nextPrNumber;
      nextPrNumber += 1;
      return { owner: input.sourceOwner, repo: input.sourceRepo, number };
    },
  };

  return {
    github,
    calls,
    setDefaultBranchHead(owner: string, repo: string, head: DefaultBranchHead): void {
      sourceHeads.set(repoKey(owner, repo), head);
    },
  };
}
