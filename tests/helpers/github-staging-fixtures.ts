// B14a, STG2: a shared, working fake GithubAdapter for API-level tests
// that walk a job through confirm -> stage -> pull-request without
// themselves being about the staging repository mechanics (those are
// covered exactly and strictly by
// tests/adapters/github/github-staging.test.ts's unit suite, and by
// tests/api/job-confirm-staging.test.ts / job-stage-repo.test.ts /
// job-pull-request.test.ts at the route level).
//
// STG2 refined shape: the platform never opens a pull request itself.
// createStagingRepository returns an EMPTY repository (this fixture
// plants baseCommit as the sole known commit, mirroring the real
// adapter's contract that baseCommit exists once the agent seeds it --
// this fake never actually performs a clone/push, so it starts the
// staging repo's commit set with exactly that one entry). Every other
// commit an agent posts to a staging repo THIS fixture created is
// accepted as a fresh child of the base commit in GENEROUS mode (the
// same deliberately permissive stance as before), or refused if nobody
// registered it, in STRICT mode.
//
// getPullRequest is scriptable per test via setPullRequest -- the
// pull-request and merge routes now read a PR the agent opened OUTSIDE
// this adapter, so a route-level test scripts what github reports for a
// given ref rather than asserting what this fixture wrote.
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import {
  type CommitInfo,
  type CreateStagingRepositoryInput,
  type CreateStagingRepositoryResult,
  type DefaultBranchHead,
  type GetCommitInput,
  type GithubAdapter,
  type GrantPushInput,
  type PullRequestRef,
  type PullRequestSummary,
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
  readonly getPullRequest: PullRequestRef[];
}

export interface StagingLifecycleFixture {
  readonly github: GithubAdapter;
  readonly calls: StagingLifecycleCalls;
  // Configures the source repository's default branch and head sha
  // (what getDefaultBranchHead answers). Defaults to main /
  // `${owner}-${repo}-head-sha` when never configured.
  setDefaultBranchHead(owner: string, repo: string, head: DefaultBranchHead): void;
  // Plants a commit directly into a staging repository this fixture
  // already created, with the parents a test wants -- so a route-level
  // test can construct a forged commit (no parent chain to base) or a
  // real descendant chain without ever calling createStagingRepository
  // again. Only meaningful in strict mode (see below); in generous mode
  // getCommit never needs a planted commit because it mints one on
  // first sight.
  registerCommit(owner: string, repo: string, sha: string, parents: readonly string[]): void;
  // STG2: scripts what github.getPullRequest answers for a given ref, by
  // owner/repo/number. A test that never calls this gets NotImplementedError,
  // the same honest-about-the-gap stub every other uncalled capability here
  // uses.
  setPullRequest(ref: PullRequestRef, summary: Omit<PullRequestSummary, 'ref'>): void;
}

export interface CreateStagingLifecycleGithubFakeOptions {
  // Generous (default, false): a sha getCommit has never seen before is
  // minted as a fresh child of the repo's base commit, the same
  // deliberately permissive stance anyCommitStagingObserver already
  // takes -- for tests that only care about a job reaching `submitted`,
  // not about pinning the stage route's own verification.
  //
  // Strict (true): getCommit throws on a sha nobody registered, the same
  // shape the real adapter's 404 takes. Route-level tests that pin B14a's
  // commit-existence check and ancestry walk (job-stage-repo.test.ts) need
  // this -- the generous default makes both checks structurally
  // unreachable, since every sha an agent posts is auto-accepted as a
  // descendant.
  readonly strict?: boolean;
}

function defaultHeadFor(owner: string, repo: string): DefaultBranchHead {
  return { defaultBranch: 'main', sha: `${owner}-${repo}-head-sha` };
}

function prKey(ref: PullRequestRef): string {
  return `${ref.owner}/${ref.repo}#${String(ref.number)}`;
}

// Every capability this GithubAdapter does not implement for real throws
// NotImplementedError, the same shape the real adapter's own unbuilt
// method (getMergeCommitSignature) throws -- callers layer getPullRequest
// on top via object spread when a test also needs merge observation.
export function createStagingLifecycleGithubFake(
  options: CreateStagingLifecycleGithubFakeOptions = {},
): StagingLifecycleFixture {
  const strict = options.strict ?? false;
  const sourceHeads = new Map<string, DefaultBranchHead>();
  const repos = new Map<string, RepoState>();
  const pullRequests = new Map<string, PullRequestSummary>();
  const calls: StagingLifecycleCalls = {
    createStagingRepository: [],
    grantPush: [],
    getCommit: [],
    getDefaultBranchHead: [],
    getPullRequest: [],
  };

  function repoKey(owner: string, repo: string): string {
    return `${owner}/${repo}`;
  }

  const github: GithubAdapter = {
    getPullRequest: (ref: PullRequestRef) => {
      calls.getPullRequest.push(ref);
      const found = pullRequests.get(prKey(ref));
      if (found === undefined) {
        return Promise.reject(new NotImplementedError('github', 'getPullRequest'));
      }
      return Promise.resolve({ ...found, ref });
    },
    getMergeCommitSignature: () => Promise.reject(new NotImplementedError('github', 'getMergeCommitSignature')),
    getPublicGist: () => Promise.reject(new NotImplementedError('github', 'getPublicGist')),

    // STG2: an EMPTY repository -- no seeded commits at all. baseCommit
    // is recorded as the fixture's own notion of "what the agent will
    // have seeded staging with", so getCommit's generous/strict modes
    // below have a base to walk ancestry from, mirroring the real
    // contract (the agent clones and pushes outside this adapter, so
    // baseCommit ends up existing in staging with its true SHA) without
    // this fake actually performing a clone/push.
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
        if (strict) {
          // Strict: a sha nobody planted does not exist, the same shape
          // the real adapter's 404 takes -- this is what lets a
          // route-level test pin the stage route's own existence check.
          throw new Error(`fake github (strict): commit ${input.sha} does not exist in ${input.owner}/${input.repo}`);
        }
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

    // B14b: this fixture's own tests all inject a MemoryStagingObserver
    // directly (tests/helpers/staging-fixtures.ts) rather than exercising
    // the real GitHub-backed observer, so compareCommits is never called
    // through this fake -- the same honest-about-the-gap stub every other
    // uncalled capability here uses.
    compareCommits: () => Promise.reject(new NotImplementedError('github', 'compareCommits')),
  };

  return {
    github,
    calls,
    setDefaultBranchHead(owner: string, repo: string, head: DefaultBranchHead): void {
      sourceHeads.set(repoKey(owner, repo), head);
    },
    registerCommit(owner: string, repo: string, sha: string, parents: readonly string[]): void {
      const state = repos.get(repoKey(owner, repo));
      if (state === undefined) {
        throw new Error(`fake github: no repository ${owner}/${repo} to register a commit into`);
      }
      state.commits.set(sha, { parents });
    },
    setPullRequest(ref: PullRequestRef, summary: Omit<PullRequestSummary, 'ref'>): void {
      pullRequests.set(prKey(ref), { ...summary, ref });
    },
  };
}

// STG2: the common case across route-level tests that walk a job all the
// way to `submitted` -- construct the PR URL the agent's own fork would
// carry, script github.getPullRequest to answer with every one of the
// five facts the route checks satisfied, and hand back the URL to POST.
// Individual facts are overridable so a test can deliberately break one.
export interface AgentForkPullRequestInput {
  readonly repository: string;
  readonly jobId: string;
  readonly stagedCommit: string;
  readonly agentLogin: string;
  readonly number?: number;
  readonly state?: PullRequestSummary['state'];
  readonly headSha?: string;
  readonly headRepoOwner?: string | null;
  readonly headRepoIsFork?: boolean;
  readonly authorLogin?: string | null;
  readonly bodyOverride?: string;
}

export function registerAgentForkPullRequest(
  fixture: StagingLifecycleFixture,
  input: AgentForkPullRequestInput,
): { readonly url: string; readonly ref: PullRequestRef } {
  const slashAt = input.repository.indexOf('/');
  const sourceOwner = input.repository.slice(0, slashAt);
  const sourceRepo = input.repository.slice(slashAt + 1);
  const number = input.number ?? 1;
  const ref: PullRequestRef = { owner: sourceOwner, repo: sourceRepo, number };
  const url = `https://github.com/${sourceOwner}/${sourceRepo}/pull/${String(number)}`;
  fixture.setPullRequest(ref, {
    state: input.state ?? 'open',
    mergeCommitSha: null,
    mergedAt: null,
    headSha: input.headSha ?? input.stagedCommit,
    additions: 1,
    deletions: 0,
    filesChanged: 1,
    repositoryPublic: true,
    headRepoOwner: input.headRepoOwner === undefined ? input.agentLogin : input.headRepoOwner,
    headRepoFullName: `${input.agentLogin}/${sourceRepo}`,
    headRepoIsFork: input.headRepoIsFork ?? true,
    baseRepoFullName: input.repository,
    authorLogin: input.authorLogin === undefined ? input.agentLogin : input.authorLogin,
    body: input.bodyOverride ?? `Job: ${input.jobId}\n`,
  });
  return { url, ref };
}
