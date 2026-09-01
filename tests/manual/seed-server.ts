// A dev server with REAL storage and a stubbed GitHub adapter, so the whole
// hire loop can be driven end to end and the pages looked at with data the
// API actually produced.
//
// The GitHub adapter is the only thing replaced. Everything else is the
// production wiring: the same createApp, the same domain rules, the same
// credential issuance. A page rendering something here is a page rendering
// what the service really serves.
import { createApp } from '../../src/api/app.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import type { GithubAdapter, PullRequestRef, PullRequestSummary } from '../../src/adapters/github/types.js';
import {
  MemoryAgentRepository,
  MemoryCompromiseRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
  MemoryAccountRepository,
} from '../../src/adapters/storage/memory.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';

const PORT = Number(process.env['PORT'] ?? 3141);
const MERGE_SHA = 'a3f91c7d5e2b48c1f0a97d63b8e254c1f9a02d7b';

function stubbedGithub(): GithubAdapter {
  return {
    forkAndOpenPullRequest: () => Promise.resolve({ owner: 'northsound', repo: 'commerce', number: 4471 }),
    getPullRequest: (ref: PullRequestRef): Promise<PullRequestSummary> =>
      Promise.resolve({
        ref,
        state: 'merged',
        mergeCommitSha: MERGE_SHA,
        mergedAt: new Date('2026-08-28T14:22:08Z'),
        headSha: 'b71c04d9e3a5',
        additions: 412,
        deletions: 88,
        filesChanged: 7,
        // R-17: GitHub reports base repo visibility; the seed repo is public.
        repositoryPublic: true,
      }),
    getMergeCommitSignature: () => Promise.reject(new NotImplementedError('github', 'getMergeCommitSignature')),
    getPublicGist: () => Promise.reject(new NotImplementedError('github', 'getPublicGist')),
  };
}

const credentialRepo = new MemoryCredentialRepository();

// The identity adapter with only resolveDid replaced. The merge leg reads
// the agent's DID document to name the key that signed the merge commit, and
// the real resolver needs an ArcBlock endpoint this dev box does not have,
// so it answers 503 and the loop stops one step from the end. Everything
// else about identity, including delegation verification, stays real: a
// delegation that does not verify is still refused.
function resolvableIdentity() {
  return {
    ...createIdentityAdapter(),
    resolveDid: (did: string) =>
      Promise.resolve({
        id: did,
        controller: null,
        verificationMethod: [`${did}#key-1`],
        alsoKnownAs: null,
      }),
  };
}

const app = createApp(
  new MemoryAccountRepository(),
  new MemoryAgentRepository(),
  resolvableIdentity(),
  stubbedGithub(),
  new MemoryJobRepository(),
  createCredentialsAdapter(undefined, credentialRepo),
  new MemoryCompromiseRepository(),
  credentialRepo,
);

app.listen(PORT, () => {
  console.log(`seed server listening on port ${PORT}`);
});
