// R-11 (#18): observe the pull request's merge from GitHub's API and
// complete the job, driven end to end over HTTP.
//
// THE accept line this issue exists to prove (ENT-7.1): the completion fact
// - mergeCommit and mergedAt - comes from what GitHub reports, never from
// either party's claim. Every test scripts what the fake github adapter
// reports and checks that the job only ever completes when that report says
// merged.
//
// runExchange's storage-fault legs are NOT re-covered per route:
// tests/api/job-criteria.test.ts pins each leg of that shared skeleton. The
// legs new to THIS route - the state pre-check, github's three answers,
// storage faults on complete, and the corrupted-status leg - are covered
// here, mirroring tests/api/job-pull-request.test.ts's structure.
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import type { CredentialsAdapter, VerifiableCredential } from '../../src/adapters/credentials/types.js';
import type { GithubAdapter, PullRequestRef, PullRequestSummary } from '../../src/adapters/github/types.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import type { DidDocument, IdentityAdapter } from '../../src/adapters/identity/types.js';
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import {
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
  MemoryAccountRepository,
} from '../../src/adapters/storage/memory.js';
import type { CredentialRepository, JobRepository } from '../../src/adapters/storage/types.js';
import { createJob, type CompletedJob, type Job, type JobStatus } from '../../src/domain/job.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { mintSessionToken, testSessionAdapter } from '../helpers/session-fixtures.js';

const agentIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(91));
const buyerIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(92));
const AGENT_DID = agentIdentity.did;
const BUYER_DID = buyerIdentity.did;
const FORK_OWNER = 'freeagents-platform';
const FORK_REPO = 'target-repo';
const PR_NUMBER = 7;
const MERGE_SHA = 'merge-commit-sha-abc123';
const MERGED_AT = new Date('2026-08-20T12:00:00Z');
const proposal = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
];

// A fixed issuer, so the assertions below read against a known DID. Nothing
// here verifies a proof - tests/api/job-merge-invariant2.test.ts does that,
// with an issuer DID derived from its key as the binding check requires.
const ISSUER_DID = 'did:abt:test-platform-issuer';
const ISSUER_SEED = new Uint8Array(32).fill(7);

// The real resolveDid throws NotImplementedError, so the merge route's
// identity leg is exercised through a wrapped adapter, exactly as
// tests/e2e/smoke.test.ts does.
function fakeIdentity(
  resolve: (did: string) => Promise<DidDocument> = (did) =>
    Promise.resolve({ id: did, controller: null, verificationMethod: [`${did}#key-1`], alsoKnownAs: null }),
): IdentityAdapter {
  return { ...createIdentityAdapter(), resolveDid: resolve };
}

interface RecordedCalls {
  getPullRequest: PullRequestRef[];
}

function emptyRecordings(): RecordedCalls {
  return { getPullRequest: [] };
}

// Only getPullRequest and forkAndOpenPullRequest ever resolve; the other two
// reject with the same honest shape as the real adapter, matching
// tests/api/job-pull-request.test.ts's fake.
function fakeGithub(
  recorded: RecordedCalls,
  script: (ref: PullRequestRef) => Promise<PullRequestSummary>,
): GithubAdapter {
  return {
    getPullRequest: (ref) => {
      recorded.getPullRequest.push(ref);
      return script(ref);
    },
    getMergeCommitSignature: () => Promise.reject(new NotImplementedError('github', 'getMergeCommitSignature')),
    getPublicGist: () => Promise.reject(new NotImplementedError('github', 'getPublicGist')),
    // Every job in this file walks through the same fork, so the fake merge
    // route can always parse the ref straight back out of pullRequestUrl.
    forkAndOpenPullRequest: () => Promise.resolve({ owner: FORK_OWNER, repo: FORK_REPO, number: PR_NUMBER }),
  };
}

function mergedGithub(recorded: RecordedCalls): GithubAdapter {
  return fakeGithub(recorded, (ref) =>
    Promise.resolve({
      ref,
      state: 'merged',
      mergeCommitSha: MERGE_SHA,
      mergedAt: MERGED_AT,
      headSha: 'head-sha-1',
      additions: 412,
      deletions: 87,
      filesChanged: 9,
      repositoryPublic: true,
    }),
  );
}

function openGithub(recorded: RecordedCalls): GithubAdapter {
  return fakeGithub(recorded, (ref) =>
    Promise.resolve({
      ref,
      state: 'open',
      mergeCommitSha: null,
      mergedAt: null,
      headSha: 'head-sha-1',
      additions: 0,
      deletions: 0,
      filesChanged: 0,
      repositoryPublic: true,
    }),
  );
}

function closedGithub(recorded: RecordedCalls): GithubAdapter {
  return fakeGithub(recorded, (ref) =>
    Promise.resolve({
      ref,
      state: 'closed',
      mergeCommitSha: null,
      mergedAt: null,
      headSha: 'head-sha-1',
      additions: 0,
      deletions: 0,
      filesChanged: 0,
      repositoryPublic: true,
    }),
  );
}

function rejectingGithub(recorded: RecordedCalls): GithubAdapter {
  return fakeGithub(recorded, () => Promise.reject(new Error('connection refused by github')));
}

// A row already in submitted, with a URL in the exact shape submitPullRequest
// itself writes, so the route's own regex parses it. Used by the scripted
// legs below, which script storage or the row directly rather than walking
// the whole HTTP exchange. The deadline is the one submitPullRequest writes
// (R-12): submittedAt + 30 days.
function submittedJob(id: string): Job {
  const submittedAt = new Date('2026-01-02T00:00:00Z');
  return {
    ...createJob(
      { id, buyerDid: BUYER_DID, agentDid: AGENT_DID, repository: 'buyer/target-repo', brief: 'Fix the login bug' },
      new Date('2026-01-01T00:00:00Z'),
    ),
    status: 'submitted',
    pullRequestUrl: `https://github.com/${FORK_OWNER}/${FORK_REPO}/pull/${PR_NUMBER}`,
    submittedAt,
    deadline: new Date(submittedAt.getTime() + 30 * 86_400_000),
    // The scripted legs project the full submitted keyset, so the row is
    // fully confirmed, like the walked jobs: the hash's presence, not its
    // value, is what the projection asserts.
    criteria: [
      { text: 'fixes the login bug', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
      { text: 'no new dependencies', proposedBy: 'buyer', acceptedByBuyer: true, acceptedByAgent: true },
    ],
    confirmedSpecHash: 'a'.repeat(64),
    confirmedAt: new Date('2026-01-01T12:00:00Z'),
  };
}

let server: Server;
let baseUrl: string;
let authHeader: Record<string, string> = {};

async function post(
  path: string,
  body: unknown = {},
  base: string = baseUrl,
  header: Record<string, string> = authHeader,
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...header },
    body: JSON.stringify(body),
  });
}

async function postSigned(path: string, body: unknown, identity: SigningIdentity, base: string = baseUrl): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${base}${path}`;
  const signed = signRequest(identity, 'POST', targetUri, { body: bodyText });
  return fetch(targetUri, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
    body: bodyText,
  });
}

async function get(path: string, base: string = baseUrl): Promise<Response> {
  return fetch(`${base}${path}`);
}

async function startWith(
  repo: JobRepository,
  github: GithubAdapter,
  extras: {
    identity?: IdentityAdapter;
    credentials?: CredentialsAdapter;
    credentialRepo?: CredentialRepository;
  } = {},
): Promise<{ server: Server; baseUrl: string; credentialRepo: CredentialRepository; authHeader: Record<string, string> }> {
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: AGENT_DID,
    operatorDid: 'did:abt:op-merge',
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: null,
  });
  const credentialRepo = extras.credentialRepo ?? new MemoryCredentialRepository();
  const credentials =
    extras.credentials ?? createCredentialsAdapter({ did: ISSUER_DID, seed: ISSUER_SEED }, credentialRepo);
  const operatorRepo = new MemoryAccountRepository();
  await operatorRepo.register({ did: BUYER_DID, githubLogin: 'buyer-merge-scripted' });
  const sessionAdapter = testSessionAdapter();
  const s = createApp(
    operatorRepo,
    agentRepo,
    extras.identity ?? fakeIdentity(),
    github,
    repo,
    credentials,
    undefined,
    credentialRepo,
    undefined,
    undefined,
    undefined,
    sessionAdapter,
  ).listen(0);
  await new Promise<void>((resolve) => s.once('listening', resolve));
  const address = s.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return { server: s, baseUrl: `http://127.0.0.1:${address.port}`, credentialRepo, authHeader: { authorization: `Bearer ${await mintSessionToken(sessionAdapter)}` } };
}

async function openDraft(
  brief: string,
  base: string = baseUrl,
): Promise<string> {
  const created = await postSigned(
    '/jobs',
    { agentDid: AGENT_DID, repository: 'buyer/target-repo', brief },
    buyerIdentity,
    base,
  );
  expect(created.status).toBe(201);
  const body = (await created.json()) as Record<string, unknown>;
  return String(body.id);
}

// One job walked draft -> submitted over HTTP: propose, accept both, confirm,
// open the pull request. Returns the submitted body so the merge tests can
// compare against it.
async function walkToSubmitted(jobId: string, base: string = baseUrl): Promise<Record<string, unknown>> {
  expect((await postSigned(`/jobs/${jobId}/criteria`, { criteria: proposal }, agentIdentity, base)).status).toBe(200);
  expect((await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, buyerIdentity, base)).status).toBe(200);
  expect((await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, agentIdentity, base)).status).toBe(200);
  expect((await postSigned(`/jobs/${jobId}/criteria/1/accept`, {}, buyerIdentity, base)).status).toBe(200);
  expect((await postSigned(`/jobs/${jobId}/criteria/1/accept`, {}, agentIdentity, base)).status).toBe(200);
  expect((await postSigned(`/jobs/${jobId}/confirm`, {}, buyerIdentity, base)).status).toBe(200);
  const pr = await post(`/jobs/${jobId}/pull-request`, {}, base);
  expect(pr.status).toBe(200);
  return (await pr.json()) as Record<string, unknown>;
}

// A submitted job projects the base eight plus criteria, specHash and
// confirmedAt, then the submit pair (R-10) plus deadline (R-12): one writer
// per group. A completed job adds exactly mergeCommit and mergedAt (R-11).
// An outcome job (R-12) projects the submitted keyset and nothing more.
const SUBMITTED_KEYS = [
  'agentDid',
  'brief',
  'briefHash',
  'buyerDid',
  'confirmedAt',
  'createdAt',
  'criteria',
  'deadline',
  'id',
  'pullRequestUrl',
  'repository',
  'specHash',
  'status',
  'submittedAt',
];
const COMPLETED_KEYS = [...SUBMITTED_KEYS, 'mergeCommit', 'mergedAt'].sort();
// A completed job that also carries a credential (R-36): every merge that
// actually completes issues one, so this is what the merge response's own
// key set looks like from here on. COMPLETED_KEYS itself stays - it still
// describes GET on a completed job with no credential row.
const COMPLETED_WITH_CREDENTIAL_KEYS = [...COMPLETED_KEYS, 'credential'].sort();

describe('job merge (R-11)', () => {
  const jobRepo = new MemoryJobRepository();
  const recorded = emptyRecordings();
  // Set by the happy-path walk; the lock test posts that same id again.
  let happyJobId: string;
  let happyCredentialRepo: CredentialRepository;

  beforeAll(async () => {
    ({ server, baseUrl, credentialRepo: happyCredentialRepo, authHeader } = await startWith(jobRepo, mergedGithub(recorded)));
  });

  afterAll(() => {
    server.close();
  });

  it('walks submitted -> merge on ONE row and projects the completed keys', async () => {
    happyJobId = await openDraft('Fix the login bug on the checkout page');
    const submittedBody = await walkToSubmitted(happyJobId);
    expect(submittedBody.status).toBe('submitted');

    const merge = await post(`/jobs/${happyJobId}/merge`);
    expect(merge.status).toBe(200);
    const mergedBody = (await merge.json()) as Record<string, unknown>;
    expect(mergedBody.id).toBe(happyJobId);
    expect(mergedBody.status).toBe('completed');
    // The values came from github, not this service's clock.
    expect(mergedBody.mergeCommit).toBe(MERGE_SHA);
    expect(mergedBody.mergedAt).toBe(MERGED_AT.toISOString());
    expect(Object.keys(mergedBody).sort()).toEqual(COMPLETED_WITH_CREDENTIAL_KEYS);

    // R-36: the merge issued a work-history credential, riding the response
    // as a sibling of the job projection.
    const credential = mergedBody.credential as Record<string, unknown>;
    expect(credential.issuer).toBe(ISSUER_DID);
    const credentialSubject = credential.credentialSubject as Record<string, unknown>;
    expect(credentialSubject.id).toBe(AGENT_DID);
    const hire = credentialSubject.hire as Record<string, unknown>;
    expect(hire.mergeCommit).toBe(MERGE_SHA);
    expect(hire.additions).toBe(412);
    expect(hire.deletions).toBe(87);
    expect(hire.filesChanged).toBe(9);
    expect(hire.repository).toBe('buyer/target-repo');
    expect(hire.signedBy).toBe(`${AGENT_DID}#key-1`);
    expect((credential.proof as Record<string, unknown>).type).toBe('Ed25519Signature2020');

    const read = await get(`/jobs/${happyJobId}`);
    expect(await read.json()).toEqual(mergedBody);
    expect(recorded.getPullRequest.length).toBe(1);
  });

  it('stores the same credential document it returns', async () => {
    const stored = await happyCredentialRepo.findByDocumentId(happyJobId);
    const merge = await get(`/jobs/${happyJobId}`);
    const body = (await merge.json()) as Record<string, unknown>;
    expect(stored).toEqual(body.credential as VerifiableCredential);
  });

  it('resolves the merge-issued credential by its own id (R-15)', async () => {
    const merge = await get(`/jobs/${happyJobId}`);
    const body = (await merge.json()) as Record<string, unknown>;
    const credential = body.credential as VerifiableCredential;

    // The credential's own id is the address a third party resolves it at
    // (ENT-8): a path on this same service, not a bare urn:uuid disconnected
    // from the completed-job lookup key it was actually stored under.
    const resolved = await get(new URL(credential.id).pathname);
    expect(resolved.status).toBe(200);
    expect(String(resolved.headers.get('content-type'))).toContain('application/ld+json');
    expect(await resolved.json()).toEqual(credential);
  });

  it('answers 409 on an already-completed job, without observing github a second time', async () => {
    const again = await post(`/jobs/${happyJobId}/merge`);
    expect(again.status).toBe(409);
    // The terminal state is checked before github is asked again: the count
    // stays at the one call the happy-path walk made.
    expect(recorded.getPullRequest.length).toBe(1);
  });

  it('answers 404 for an unknown id, with zero adapter or storage-complete calls', async () => {
    const before = recorded.getPullRequest.length;
    const completeSpy = vi.spyOn(jobRepo, 'complete');
    const nowhere = await post('/jobs/j-nowhere/merge');
    expect(nowhere.status).toBe(404);
    expect(await nowhere.json()).toEqual({ error: 'not found' });
    expect(recorded.getPullRequest.length).toBe(before);
    expect(completeSpy).not.toHaveBeenCalled();
    completeSpy.mockRestore();
  });

  it('answers 409 for a fresh draft, without asking github once', async () => {
    const draftId = await openDraft('A draft nobody confirmed');
    const before = recorded.getPullRequest.length;

    const early = await post(`/jobs/${draftId}/merge`);
    expect(early.status).toBe(409);
    expect(((await early.json()) as { error: string }).error).toContain('status "draft"');
    expect(recorded.getPullRequest.length).toBe(before);
  });
});

// GET /jobs/:jobId's credential field is absent, not null, when no credential
// row exists for a completed job - a row completed before this lap shipped,
// or the crash-between-two-writes residual named in the merge route.
describe('GET /jobs/:jobId, no credential row (R-36)', () => {
  it('omits the credential field for a completed job with no stored credential', async () => {
    const repo = new MemoryJobRepository();
    await repo.create({
      ...submittedJob('j-no-cred'),
      status: 'completed',
      mergeCommit: MERGE_SHA,
      mergedAt: MERGED_AT,
    });
    const scripted = await startWith(repo, mergedGithub(emptyRecordings()));
    try {
      const read = await get('/jobs/j-no-cred', scripted.baseUrl);
      expect(read.status).toBe(200);
      const body = (await read.json()) as Record<string, unknown>;
      expect('credential' in body).toBe(false);
      expect(Object.keys(body).sort()).toEqual(COMPLETED_KEYS);
    } finally {
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('never looks up a credential for an unmerged job (the mergeCommit guard)', async () => {
    const repo = new MemoryJobRepository();
    const row = submittedJob('j-unmerged-no-lookup');
    await repo.create(row);
    class ThrowingCredentialRepository implements CredentialRepository {
      async save(): Promise<never> {
        throw new Error('unreachable');
      }
      async findByDocumentId(): Promise<never> {
        throw new Error('should never be called for an unmerged job');
      }
      async listBySubjectDid(): Promise<never> {
        throw new Error('should never be called for an unmerged job');
      }
    }
    const scripted = await startWith(repo, mergedGithub(emptyRecordings()), {
      credentialRepo: new ThrowingCredentialRepository(),
    });
    try {
      const read = await get(`/jobs/${row.id}`, scripted.baseUrl);
      expect(read.status).toBe(200);
      const body = (await read.json()) as Record<string, unknown>;
      expect(body.status).toBe('submitted');
      expect('credential' in body).toBe(false);
    } finally {
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('answers 503 when the credential lookup fails, and logs the cause', async () => {
    const repo = new MemoryJobRepository();
    await repo.create({
      ...submittedJob('j-cred-lookup-fails'),
      status: 'completed',
      mergeCommit: MERGE_SHA,
      mergedAt: MERGED_AT,
    });
    class ThrowingCredentialRepository implements CredentialRepository {
      async save(): Promise<never> {
        throw new Error('unreachable');
      }
      async findByDocumentId(): Promise<never> {
        throw new Error('storage down');
      }
      async listBySubjectDid(): Promise<never> {
        throw new Error('storage down');
      }
    }
    const scripted = await startWith(repo, mergedGithub(emptyRecordings()), {
      credentialRepo: new ThrowingCredentialRepository(),
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const read = await get('/jobs/j-cred-lookup-fails', scripted.baseUrl);
      expect(read.status).toBe(503);
      expect(await read.json()).toEqual({ error: 'storage unavailable' });
      expect(errorLog).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });
});

// New 503 legs the credential-issuing merge route introduces: identity
// resolution, credential issuance, and the credential-repo write. Each runs
// on its own server, each asserting the body message AND the job's resulting
// status - the 409/404/open/closed/stale legs above are unchanged and not
// re-covered here.
describe('job merge, credential-issuance faulted legs (R-36)', () => {
  it('answers 503 when identity resolution fails, and leaves the job submitted', async () => {
    const faults = emptyRecordings();
    const row = submittedJob('j-identity-fails');
    const repo = new MemoryJobRepository();
    await repo.create(row);
    const scripted = await startWith(repo, mergedGithub(faults), {
      identity: fakeIdentity(() => Promise.reject(new Error('resolver unavailable'))),
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const merge = await post(`/jobs/${row.id}/merge`, {}, scripted.baseUrl);
      expect(merge.status).toBe(503);
      expect(await merge.json()).toEqual({ error: 'identity resolution unavailable' });
      expect(errorLog).toHaveBeenCalled();

      const read = await get(`/jobs/${row.id}`, scripted.baseUrl);
      expect(((await read.json()) as Record<string, unknown>).status).toBe('submitted');
      expect(await scripted.credentialRepo.findByDocumentId(row.id)).toBeNull();
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('answers 503 when the resolved DID document carries no verification method, and leaves the job submitted', async () => {
    const faults = emptyRecordings();
    const row = submittedJob('j-no-verification-method');
    const repo = new MemoryJobRepository();
    await repo.create(row);
    const scripted = await startWith(repo, mergedGithub(faults), {
      identity: fakeIdentity((did) =>
        Promise.resolve({ id: did, controller: null, verificationMethod: [], alsoKnownAs: null }),
      ),
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const merge = await post(`/jobs/${row.id}/merge`, {}, scripted.baseUrl);
      expect(merge.status).toBe(503);
      expect(await merge.json()).toEqual({ error: 'identity resolution unavailable' });
      expect(errorLog).toHaveBeenCalled();

      const read = await get(`/jobs/${row.id}`, scripted.baseUrl);
      expect(((await read.json()) as Record<string, unknown>).status).toBe('submitted');
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('answers 503 when credential issuance fails, and leaves the job submitted', async () => {
    const faults = emptyRecordings();
    const row = submittedJob('j-issuance-fails');
    const repo = new MemoryJobRepository();
    await repo.create(row);
    const failingCredentials: CredentialsAdapter = {
      issueWorkHistoryCredential: () => Promise.reject(new Error('signing key unavailable')),
      verifyCredential: () => Promise.reject(new NotImplementedError('credentials', 'verifyCredential')),
      getCredential: () => Promise.reject(new NotImplementedError('credentials', 'getCredential')),
    };
    const scripted = await startWith(repo, mergedGithub(faults), { credentials: failingCredentials });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const merge = await post(`/jobs/${row.id}/merge`, {}, scripted.baseUrl);
      expect(merge.status).toBe(503);
      expect(await merge.json()).toEqual({ error: 'credential issuance unavailable' });
      expect(errorLog).toHaveBeenCalled();

      const read = await get(`/jobs/${row.id}`, scripted.baseUrl);
      expect(((await read.json()) as Record<string, unknown>).status).toBe('submitted');
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('answers 503 when the credential-repo write fails, but the job has already completed (the named residual)', async () => {
    const faults = emptyRecordings();
    const row = submittedJob('j-cred-save-fails');
    const repo = new MemoryJobRepository();
    await repo.create(row);
    class SaveFailingCredentialRepository implements CredentialRepository {
      async save(): Promise<never> {
        throw new Error('connection refused');
      }
      async findByDocumentId(): Promise<null> {
        return null;
      }
      async listBySubjectDid(): Promise<readonly never[]> {
        return [];
      }
    }
    const scripted = await startWith(repo, mergedGithub(faults), {
      credentialRepo: new SaveFailingCredentialRepository(),
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const merge = await post(`/jobs/${row.id}/merge`, {}, scripted.baseUrl);
      expect(merge.status).toBe(503);
      expect(await merge.json()).toEqual({ error: 'storage unavailable' });
      expect(errorLog).toHaveBeenCalled();

      // Honest about the residual: the job DID complete, even though the
      // credential write that should have accompanied it failed.
      const read = await get(`/jobs/${row.id}`, scripted.baseUrl);
      expect(((await read.json()) as Record<string, unknown>).status).toBe('completed');
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });
});

// createApp's own default (undefined credentials, an explicit credentialRepo)
// is what src/api/app.ts's comment calls credentials_default_shares_repo: the
// merge route's issuance and the resolve route's lookup must land on the SAME
// repository, or a caller that hands createApp only a credentialRepo (the
// shape a real deployment uses) would issue credentials the app can never
// read back. startWith always passes an explicit credentials adapter, so this
// exercises the branch startWith's own default papers over.
describe("createApp's credentials default, no credentials adapter given (R-36)", () => {
  it('shares state with the given credential repository', async () => {
    const faults = emptyRecordings();
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:op-merge-default',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const credentialRepo = new MemoryCredentialRepository();
    const operatorRepo = new MemoryAccountRepository();
    await operatorRepo.register({ did: BUYER_DID, githubLogin: 'buyer-merge-default' });
    const sessionAdapter = testSessionAdapter();
    const s = createApp(
      operatorRepo,
      agentRepo,
      fakeIdentity(),
      mergedGithub(faults),
      new MemoryJobRepository(),
      undefined,
      undefined,
      credentialRepo,
      undefined,
      undefined,
      undefined,
      sessionAdapter,
    ).listen(0);
    await new Promise<void>((resolve) => s.once('listening', resolve));
    const address = s.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const jobId = await openDraft('Fix the login bug on the checkout page', base);
      await walkToSubmitted(jobId, base);
      const merge = await post(`/jobs/${jobId}/merge`, {}, base);
      expect(merge.status).toBe(200);
      const body = (await merge.json()) as Record<string, unknown>;
      const credential = body.credential as VerifiableCredential;
      expect(await credentialRepo.findByDocumentId(jobId)).toEqual(credential);
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });
});

// The github-answer and storage-fault legs each need a server whose adapter
// or repository misbehaves in one specific way, so they script their own -
// the same pattern tests/api/job-pull-request.test.ts uses.
describe('job merge, faulted legs (R-11)', () => {
  it('answers 409 with the open wording when github reports the PR still open, and records nothing', async () => {
    const faults = emptyRecordings();
    const scripted = await startWith(new MemoryJobRepository(), openGithub(faults));
    try {
      const jobId = await openDraft('A PR still under review', scripted.baseUrl);
      const submittedBody = await walkToSubmitted(jobId, scripted.baseUrl);
      expect(submittedBody.status).toBe('submitted');

      const merge = await post(`/jobs/${jobId}/merge`, {}, scripted.baseUrl);
      expect(merge.status).toBe(409);
      expect(((await merge.json()) as { error: string }).error).toBe('pull request is open; it has not merged yet');

      const read = await get(`/jobs/${jobId}`, scripted.baseUrl);
      const readBack = (await read.json()) as Record<string, unknown>;
      expect(readBack.status).toBe('submitted');
      expect(readBack.mergeCommit).toBeUndefined();
      expect(readBack.mergedAt).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  // R-12 (ENT-7.2): a closed-unmerged PR is recorded, not hidden. The
  // outcome projects the submitted keyset, with no merge facts to read it as
  // a hire (the invariant-2 legs in tests/api/job-invariant2.test.ts pin the
  // absence half off-platform).
  it('records closed_unmerged when github reports the PR closed unmerged', async () => {
    const faults = emptyRecordings();
    const scripted = await startWith(new MemoryJobRepository(), closedGithub(faults));
    try {
      const jobId = await openDraft('A PR that was closed unmerged', scripted.baseUrl);
      await walkToSubmitted(jobId, scripted.baseUrl);

      const merge = await post(`/jobs/${jobId}/merge`, {}, scripted.baseUrl);
      expect(merge.status).toBe(200);
      const body = (await merge.json()) as Record<string, unknown>;
      expect(body.id).toBe(jobId);
      expect(body.status).toBe('closed_unmerged');
      expect(Object.keys(body).sort()).toEqual(SUBMITTED_KEYS);
      expect(body.mergeCommit).toBeUndefined();
      expect(body.mergedAt).toBeUndefined();
      expect(typeof body.deadline).toBe('string');

      // The outcome stays on record: the read-back is the recorded row.
      const read = await get(`/jobs/${jobId}`, scripted.baseUrl);
      expect(await read.json()).toEqual(body);
      expect(faults.getPullRequest.length).toBe(1);

      // Second observation: the terminal state is checked before github is
      // asked again, and it is a conflict, not a rewrite.
      const again = await post(`/jobs/${jobId}/merge`, {}, scripted.baseUrl);
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: string }).error).toContain('closed_unmerged');
      expect(faults.getPullRequest.length).toBe(1);
    } finally {
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('answers 503 when github fails, and logs the cause', async () => {
    const faults = emptyRecordings();
    const scripted = await startWith(new MemoryJobRepository(), rejectingGithub(faults));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const jobId = await openDraft('A PR github cannot be reached for', scripted.baseUrl);
      await walkToSubmitted(jobId, scripted.baseUrl);

      const merge = await post(`/jobs/${jobId}/merge`, {}, scripted.baseUrl);
      expect(merge.status).toBe(503);
      expect(await merge.json()).toEqual({ error: 'github unavailable' });
      expect(errorLog).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('answers 404 when the row vanishes between the read and the write', async () => {
    const faults = emptyRecordings();
    const row = submittedJob('j-vanish');
    class VanishingCompleteRepository implements JobRepository {
      async create(): Promise<never> {
        throw new Error('unreachable');
      }
      async update(): Promise<never> {
        throw new Error('unreachable');
      }
      async findById(): Promise<Job> {
        return row;
      }
      async complete(): Promise<null> {
        return null;
      }
      async findCompletedByJobId(): Promise<null> {
        return null;
      }
    }
    const scripted = await startWith(new VanishingCompleteRepository(), mergedGithub(faults));
    try {
      const merge = await post(`/jobs/${row.id}/merge`, {}, scripted.baseUrl);
      expect(merge.status).toBe(404);
      expect(await merge.json()).toEqual({ error: 'not found' });
    } finally {
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('answers 503 when storage fails to persist the completion, and logs the cause', async () => {
    const faults = emptyRecordings();
    const row = submittedJob('j-throw');
    const failure = new Error('connection refused');
    class ThrowingCompleteRepository implements JobRepository {
      async create(): Promise<never> {
        throw new Error('unreachable');
      }
      async update(): Promise<never> {
        throw new Error('unreachable');
      }
      async findById(): Promise<Job> {
        return row;
      }
      async complete(): Promise<never> {
        throw failure;
      }
      async findCompletedByJobId(): Promise<null> {
        return null;
      }
    }
    const scripted = await startWith(new ThrowingCompleteRepository(), mergedGithub(faults));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const merge = await post(`/jobs/${row.id}/merge`, {}, scripted.baseUrl);
      expect(merge.status).toBe(503);
      expect(await merge.json()).toEqual({ error: 'storage unavailable' });
      expect(errorLog).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('fails closed on a corrupted status instead of completing', async () => {
    // No honest API path produces a status outside the state machine's own
    // enum, so the only witness is a planted row - the well-formed URL
    // proves the 500 comes from completeJob's validator, not the URL guard.
    const row: Job = { ...submittedJob('j-corrupt-merge'), status: 'corrupted' as JobStatus };
    class ScriptedRow implements JobRepository {
      async create(): Promise<never> {
        throw new Error('unreachable');
      }
      async update(): Promise<never> {
        throw new Error('unreachable');
      }
      async findById(): Promise<Job> {
        return row;
      }
      async complete(): Promise<never> {
        throw new Error('unreachable');
      }
      async findCompletedByJobId(): Promise<null> {
        return null;
      }
    }
    const faults = emptyRecordings();
    const scripted = await startWith(new ScriptedRow(), mergedGithub(faults));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const merge = await post(`/jobs/${row.id}/merge`, {}, scripted.baseUrl);
      expect(merge.status).toBe(500);
      expect(await merge.json()).toEqual({ error: 'internal error' });
      expect(errorLog).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });
});

// R-12 (ENT-7.2): the unhappy outcomes, observed at the merge route. The
// stale legs script storage directly, because no honest HTTP path can write
// a submitted row with a deadline in the past - submitPullRequest always
// writes one 30 days out, and the detection is deliberately lazy (A4):
// this route is the only observation point this codebase has.
class ScriptedOutcomeRepository implements JobRepository {
  private row: Job;
  readonly updateCalls: Job[] = [];

  constructor(
    row: Job,
    private readonly updateImpl: (row: Job) => Promise<Job | null>,
    private readonly completeImpl: (job: Job, anchor: Omit<CompletedJob, 'id'>) => Promise<Job | null>,
  ) {
    this.row = row;
  }

  async create(): Promise<never> {
    throw new Error('unreachable');
  }

  async findById(id: string): Promise<Job | null> {
    return this.row.id === id ? this.row : null;
  }

  async update(row: Job): Promise<Job | null> {
    this.updateCalls.push(row);
    // The row only moves when the write resolves: a write that fails left
    // nothing on record, the way the 503 leg below asserts.
    const result = await this.updateImpl(row);
    if (result !== null) {
      this.row = result;
    }
    return result;
  }

  async complete(job: Job, anchor: Omit<CompletedJob, 'id'>): Promise<Job | null> {
    const row = await this.completeImpl(job, anchor);
    if (row !== null) {
      this.row = row;
    }
    return row;
  }

  async findCompletedByJobId(): Promise<null> {
    return null;
  }
}

describe('job merge, outcomes (R-12)', () => {
  // Relative to the wall clock on purpose: the leg must hold under any run
  // date, and the value is derived, not asserted from memory.
  const dayInMs = 86_400_000;
  const pastDeadline = () => new Date(Date.now() - dayInMs);

  it('records stale when github reports the PR open past the deadline', async () => {
    const faults = emptyRecordings();
    const row = { ...submittedJob('j-stale'), deadline: pastDeadline() };
    const repo = new ScriptedOutcomeRepository(
      row,
      (r) => Promise.resolve(r),
      () => Promise.reject(new Error('unreachable')),
    );
    const scripted = await startWith(repo, openGithub(faults));
    try {
      const merge = await post(`/jobs/${row.id}/merge`, {}, scripted.baseUrl);
      expect(merge.status).toBe(200);
      const body = (await merge.json()) as Record<string, unknown>;
      expect(body.id).toBe(row.id);
      expect(body.status).toBe('stale');
      expect(Object.keys(body).sort()).toEqual(SUBMITTED_KEYS);
      expect(typeof body.deadline).toBe('string');

      // The writer is the domain's recordStale, not the route: the row the
      // route persisted keeps the deadline and moves only the status.
      expect(repo.updateCalls).toHaveLength(1);
      expect(repo.updateCalls[0]?.status).toBe('stale');
      expect(repo.updateCalls[0]?.deadline).toEqual(row.deadline);

      const read = await get(`/jobs/${row.id}`, scripted.baseUrl);
      expect(await read.json()).toEqual(body);
      expect(faults.getPullRequest.length).toBe(1);
    } finally {
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('answers 409 on a stale row whose PR is still open, without recording again', async () => {
    const faults = emptyRecordings();
    const row: Job = { ...submittedJob('j-stale-open'), status: 'stale', deadline: pastDeadline() };
    const repo = new ScriptedOutcomeRepository(
      row,
      () => Promise.reject(new Error('unreachable')),
      () => Promise.reject(new Error('unreachable')),
    );
    const scripted = await startWith(repo, openGithub(faults));
    try {
      const merge = await post(`/jobs/${row.id}/merge`, {}, scripted.baseUrl);
      expect(merge.status).toBe(409);
      expect(((await merge.json()) as { error: string }).error).toBe(
        'the job is already recorded stale and the pull request is still open',
      );
      expect(repo.updateCalls).toHaveLength(0);

      const read = await get(`/jobs/${row.id}`, scripted.baseUrl);
      const readBack = (await read.json()) as Record<string, unknown>;
      expect(readBack.status).toBe('stale');
    } finally {
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('still completes a stale job when github reports the merge (D3 2026-08-22)', async () => {
    const faults = emptyRecordings();
    const row: Job = { ...submittedJob('j-stale-merged'), status: 'stale', deadline: pastDeadline() };
    const repo = new ScriptedOutcomeRepository(
      row,
      () => Promise.reject(new Error('unreachable')),
      (job, anchor) =>
        Promise.resolve({
          ...job,
          status: 'completed' as const,
          mergeCommit: anchor.mergeCommit,
          mergedAt: anchor.completedAt,
        }),
    );
    const scripted = await startWith(repo, mergedGithub(faults));
    try {
      const merge = await post(`/jobs/${row.id}/merge`, {}, scripted.baseUrl);
      expect(merge.status).toBe(200);
      const body = (await merge.json()) as Record<string, unknown>;
      expect(body.status).toBe('completed');
      expect(body.mergeCommit).toBe(MERGE_SHA);
      expect(body.mergedAt).toBe(MERGED_AT.toISOString());
      expect(Object.keys(body).sort()).toEqual(COMPLETED_WITH_CREDENTIAL_KEYS);
    } finally {
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('records closed_unmerged when a stale row is observed closed (R-31: an outcome update)', async () => {
    // stale -> closed_unmerged is legal since R-31: an outcome update after
    // stale, the same closed_unmerged state, no new field.
    const faults = emptyRecordings();
    const row: Job = { ...submittedJob('j-stale-closed'), status: 'stale', deadline: pastDeadline() };
    const repo = new ScriptedOutcomeRepository(
      row,
      (r) => Promise.resolve(r),
      (job) =>
        Promise.resolve({
          ...job,
          status: 'closed_unmerged' as const,
        }),
    );
    const scripted = await startWith(repo, closedGithub(faults));
    try {
      const merge = await post(`/jobs/${row.id}/merge`, {}, scripted.baseUrl);
      expect(merge.status).toBe(200);
      const body = (await merge.json()) as Record<string, unknown>;
      expect(body.status).toBe('closed_unmerged');
      expect(Object.keys(body).sort()).toEqual(SUBMITTED_KEYS);
      expect(typeof body.deadline).toBe('string');
      expect('mergeCommit' in body).toBe(false);
      expect('mergedAt' in body).toBe(false);
      expect(repo.updateCalls).toHaveLength(1);
      expect(repo.updateCalls[0]?.status).toBe('closed_unmerged');

      // Read-back: the recorded row, not the request.
      const read = await get(`/jobs/${row.id}`, scripted.baseUrl);
      expect((await read.json()) as Record<string, unknown>).toEqual(body);
    } finally {
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('answers 503 when storage fails to persist the stale record, and logs the cause', async () => {
    const faults = emptyRecordings();
    const row = { ...submittedJob('j-stale-503'), deadline: pastDeadline() };
    const repo = new ScriptedOutcomeRepository(
      row,
      () => Promise.reject(new Error('connection refused')),
      () => Promise.reject(new Error('unreachable')),
    );
    const scripted = await startWith(repo, openGithub(faults));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const merge = await post(`/jobs/${row.id}/merge`, {}, scripted.baseUrl);
      expect(merge.status).toBe(503);
      expect(await merge.json()).toEqual({ error: 'storage unavailable' });
      expect(errorLog).toHaveBeenCalledWith(
        'POST /jobs/:jobId/merge: storage failed',
        expect.any(Error),
      );

      // Nothing was persisted: the row reads back submitted.
      const read = await get(`/jobs/${row.id}`, scripted.baseUrl);
      const readBack = (await read.json()) as Record<string, unknown>;
      expect(readBack.status).toBe('submitted');
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('answers 404 when the row vanishes on the closed record', async () => {
    const faults = emptyRecordings();
    const row = submittedJob('j-closed-404');
    const repo = new ScriptedOutcomeRepository(
      row,
      () => Promise.resolve(null),
      () => Promise.reject(new Error('unreachable')),
    );
    const scripted = await startWith(repo, closedGithub(faults));
    try {
      const merge = await post(`/jobs/${row.id}/merge`, {}, scripted.baseUrl);
      expect(merge.status).toBe(404);
      expect(await merge.json()).toEqual({ error: 'not found' });
    } finally {
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });
});
