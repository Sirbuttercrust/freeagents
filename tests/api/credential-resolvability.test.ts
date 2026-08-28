// R-15 / ENT-8 (T3, PR 85 fourth validator lap): pins the contract behind
// CREDENTIAL_ID_BASE in credentials.ts. The merge route issues a credential
// whose own id is the resolvable address GET /v1/credentials/:credentialId
// answers, because credentialLookupKey (storage/types.ts) strips that id
// back down to the completed job id it was stored under. A urn:uuid id
// shares no path with that lookup key, so this is what stops the finding
// coming back: the behaviour is pinned, not argued.
//
// Mirrors tests/api/credential-resolve.test.ts for style and for how it
// stands up the app; this file additionally drives a real merge instead of
// hand-assembling a stored document, so the id under test is the one the
// merge route actually produced.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';
import type { DidDocument, IdentityAdapter } from '../../src/adapters/identity/types.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import type { GithubAdapter, PullRequestRef, PullRequestSummary } from '../../src/adapters/github/types.js';
import { MemoryAgentRepository, MemoryCredentialRepository, MemoryJobRepository, MemoryOperatorRepository } from '../../src/adapters/storage/memory.js';
import { createJob, type Job } from '../../src/domain/job.js';

const ISSUER_DID = 'did:abt:test-platform-issuer';
const ISSUER_SEED = new Uint8Array(32).fill(9);
const AGENT_DID = 'did:abt:agent-resolvability';
const BUYER_DID = 'did:abt:buyer-resolvability';
const FORK_OWNER = 'freeagents-platform';
const FORK_REPO = 'target-repo';
const PR_NUMBER = 3;
const MERGE_SHA = 'merge-commit-sha-resolvability';
const JOB_ID = 'job-resolvability-1';

function fakeIdentity(): IdentityAdapter {
  const resolve = (did: string): Promise<DidDocument> =>
    Promise.resolve({ id: did, controller: null, verificationMethod: [`${did}#key-1`], alsoKnownAs: null });
  return { ...createIdentityAdapter(), resolveDid: resolve };
}

function mergedGithub(): GithubAdapter {
  return {
    getPullRequest: (ref: PullRequestRef): Promise<PullRequestSummary> =>
      Promise.resolve({
        ref,
        state: 'merged',
        mergeCommitSha: MERGE_SHA,
        mergedAt: new Date('2026-08-22T09:00:00Z'),
        headSha: 'head-sha-resolvability',
        additions: 5,
        deletions: 1,
        filesChanged: 1,
      }),
    getMergeCommitSignature: () => Promise.reject(new NotImplementedError('github', 'getMergeCommitSignature')),
    getPublicGist: () => Promise.reject(new NotImplementedError('github', 'getPublicGist')),
    forkAndOpenPullRequest: () => Promise.resolve({ owner: FORK_OWNER, repo: FORK_REPO, number: PR_NUMBER }),
  };
}

// A row already in submitted, in the exact shape submitPullRequest itself
// writes, so the merge route's own regex parses it (same pattern
// tests/api/job-merge.test.ts's scripted legs use).
function submittedJob(): Job {
  const submittedAt = new Date('2026-08-20T00:00:00Z');
  return {
    ...createJob(
      { id: JOB_ID, buyerDid: BUYER_DID, agentDid: AGENT_DID, repository: 'buyer/target-repo', brief: 'Fix the checkout bug' },
      new Date('2026-08-19T00:00:00Z'),
    ),
    status: 'submitted',
    pullRequestUrl: `https://github.com/${FORK_OWNER}/${FORK_REPO}/pull/${PR_NUMBER}`,
    submittedAt,
    deadline: new Date(submittedAt.getTime() + 30 * 86_400_000),
    confirmedSpecHash: 'b'.repeat(64),
    confirmedAt: new Date('2026-08-19T12:00:00Z'),
  };
}

function listen(app: ReturnType<typeof createApp>): Promise<Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}

function portOf(srv: Server): number {
  return (srv.address() as AddressInfo).port;
}

let server: Server;
let baseUrl: string;
let issuedCredential: VerifiableCredential;

beforeAll(async () => {
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: AGENT_DID,
    operatorDid: 'did:abt:op-resolvability',
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: null,
  });
  const jobRepo = new MemoryJobRepository();
  await jobRepo.create(submittedJob());
  const credentialRepo = new MemoryCredentialRepository();
  const credentials = createCredentialsAdapter({ did: ISSUER_DID, seed: ISSUER_SEED }, credentialRepo);

  const app = createApp(
    new MemoryOperatorRepository(),
    agentRepo,
    fakeIdentity(),
    mergedGithub(),
    jobRepo,
    credentials,
    undefined,
    credentialRepo,
  );
  server = await listen(app);
  baseUrl = `http://127.0.0.1:${portOf(server)}`;

  const merge = await fetch(`${baseUrl}/jobs/${JOB_ID}/merge`, { method: 'POST' });
  expect(merge.status).toBe(200);
  const body = (await merge.json()) as Record<string, unknown>;
  issuedCredential = body.credential as VerifiableCredential;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('credential id resolvability (ENT-8, R-15)', () => {
  it('resolves a merge-issued credential at the path its own id names', async () => {
    // The id the merge route stamped on the document, exactly as issued -
    // no test-side reconstruction of the URL.
    expect(issuedCredential.id).toBe(`https://freeagents.dev/v1/credentials/${JOB_ID}`);

    // issuedCredential.id carries a fixed host (CREDENTIAL_ID_BASE), not
    // this test server's ephemeral port, so the request goes to baseUrl
    // plus the id's own path - the same relationship a real client has to
    // reconstruct from CREDENTIAL_ID_BASE plus the id it was handed.
    const res = await fetch(`${baseUrl}${new URL(issuedCredential.id).pathname}`);
    expect(res.status).toBe(200);
    expect(String(res.headers.get('content-type'))).toContain('application/ld+json');
    expect(await res.json()).toEqual(issuedCredential);
  });

  it('404s a document id that credentialLookupKey cannot resolve to a stored credential', async () => {
    // A urn:uuid has no path segments credentialLookupKey can strip to the
    // job id it was stored under (the class of id this test guards
    // against reverting to): it is one opaque segment, unconnected to
    // anything the repository indexed.
    const unresolvable = `urn:uuid:${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`;
    const res = await fetch(`${baseUrl}/v1/credentials/${encodeURIComponent(unresolvable)}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });
});
