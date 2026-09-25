// R-11 (#18): observe the pull request's merge from GitHub's API and
// complete the job, driven end to end over HTTP.
//
// THE accept line this issue exists to prove (ENT-7.1): the completion fact
// - mergeCommit and mergedAt - comes from what GitHub reports, never from
// either party's claim. Every test scripts what the fake github adapter
// reports and checks that the job only ever completes when that report says
// merged.
//
// STG2: the platform no longer opens the pull request itself. The agent
// opens it from its own fork and reports the URL to POST
// /jobs/:jobId/pull-request, which reads it back and records `submitted`
// only when five facts hold (base repo, head fork ownership, head sha,
// open state, Job trailer). Every test that walks a job to `submitted`
// registers a plausible agent-fork PR on the shared github fixture first
// (registerAgentForkPullRequest), matching the exact jobId under test so
// the Job-trailer check passes, then mutates that same registration to
// simulate the PR's later state (merged, closed, head moved) before
// calling /merge -- mirroring how a real PR starts open and is observed
// again later.
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
import type { GithubAdapter, PullRequestRef } from '../../src/adapters/github/types.js';
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
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import {
  createStagingLifecycleGithubFake,
  registerAgentForkPullRequest,
  type StagingLifecycleFixture,
} from '../helpers/github-staging-fixtures.js';

const agentIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(91));
const buyerIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(92));
const AGENT_DID = agentIdentity.did;
const BUYER_DID = buyerIdentity.did;
const AGENT_GITHUB_LOGIN = 'scout-merge';
const FORK_OWNER = 'buyer';
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

function prRef(): PullRequestRef {
  return { owner: FORK_OWNER, repo: FORK_REPO, number: PR_NUMBER };
}

function prUrl(): string {
  return `https://github.com/${FORK_OWNER}/${FORK_REPO}/pull/${PR_NUMBER}`;
}

// STG2: registers a fresh, submittable agent-fork PR on the fixture --
// open, headSha matching the job's staged commit, owned and authored by
// the agent's verified login, base repo matching, and a body carrying
// the given job's own Job trailer. Every walkToSubmitted call needs this
// immediately before POSTing to /pull-request, because the route now
// reads this PR back and checks all five facts before recording
// `submitted`.
function registerSubmittablePr(fixture: StagingLifecycleFixture, jobId: string): { readonly url: string } {
  return registerAgentForkPullRequest(fixture, {
    repository: `${FORK_OWNER}/${FORK_REPO}`,
    jobId,
    stagedCommit: 'commit-sha-1',
    agentLogin: AGENT_GITHUB_LOGIN,
    number: PR_NUMBER,
  });
}

// A github double whose getPullRequest can be switched to reject on
// demand, for the "github unavailable at merge time" leg: the submission
// read must still succeed (registerSubmittablePr's fixture answers it),
// and only the LATER merge-time read fails.
function switchableGithub(fixture: StagingLifecycleFixture): { readonly github: GithubAdapter; setFailing: (value: boolean) => void } {
  let failing = false;
  const github: GithubAdapter = {
    ...fixture.github,
    getPullRequest: (ref) => (failing ? Promise.reject(new Error('connection refused by github')) : fixture.github.getPullRequest(ref)),
  };
  return { github, setFailing: (value: boolean) => { failing = value; } };
}

// A row already in submitted, with a URL in the exact shape submitPullRequest
// itself writes, so the route's own regex parses it. Used by the scripted
// legs below, which script storage or the row directly rather than walking
// the whole HTTP exchange. The deadline is the one submitPullRequest writes
// (R-12): submittedAt + 30 days.
//
// P4: submittedAt is anchored to "now" rather than a fixed historical date.
// GET /jobs/:jobId applies the lapse clocks on every read (brief section 4:
// "a job that lapsed while nobody was looking reports the truth"), and
// deemCompleted fires 7 days after submittedAt -- a fixed date from early
// in this project's history would silently read back as deemed_completed
// by the time this suite runs, in every test that plants this row for a
// reason that has nothing to do with the clock (identity resolution,
// credential issuance, a stale-record persistence failure).
function submittedJob(id: string): Job {
  const submittedAt = new Date(Date.now() - 60 * 60 * 1000);
  return {
    ...createJob(
      { id, buyerDid: BUYER_DID, agentDid: AGENT_DID, repository: 'buyer/target-repo', brief: 'Fix the login bug' },
      new Date(submittedAt.getTime() - 24 * 60 * 60 * 1000),
    ),
    status: 'submitted',
    pullRequestUrl: prUrl(),
    submittedAt,
    stagedAt: new Date(submittedAt.getTime() - 6 * 60 * 60 * 1000),
    stagedCommit: 'commit-sha-1',
    deadline: new Date(submittedAt.getTime() + 30 * 86_400_000),
    // The scripted legs project the full submitted keyset, so the row is
    // fully confirmed, like the walked jobs: the hash's presence, not its
    // value, is what the projection asserts.
    criteria: [
      { text: 'fixes the login bug', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
      { text: 'no new dependencies', proposedBy: 'buyer', acceptedByBuyer: true, acceptedByAgent: true },
    ],
    confirmedSpecHash: 'a'.repeat(64),
    confirmedAt: new Date(submittedAt.getTime() - 12 * 60 * 60 * 1000),
    // B14a: a scripted submitted/completed row already carries the
    // platform-created staging repository confirm would have attached --
    // stagingRepo and baseCommit ride together, the same one-writer pair
    // attachStagingRepository itself always sets.
    stagingRepo: { owner: 'freeagents-platform', repo: `staging-${id}` },
    baseCommit: 'buyer-target-repo-head-sha',
  };
}

// The PR summary a directly-planted submittedJob() row needs registered
// on the fixture so the merge route's own read succeeds -- matching
// headSha (== 'commit-sha-1'), fork ownership and Job trailer, so only
// the field under test (state, merge facts) varies between callers.
function registerMatchingPrFor(fixture: StagingLifecycleFixture, id: string, overrides: Partial<Parameters<StagingLifecycleFixture['setPullRequest']>[1]> = {}): void {
  registerAgentForkPullRequest(fixture, {
    repository: 'buyer/target-repo',
    jobId: id,
    stagedCommit: 'commit-sha-1',
    agentLogin: AGENT_GITHUB_LOGIN,
    number: PR_NUMBER,
  });
  if (Object.keys(overrides).length > 0) {
    fixture.setPullRequest(prRef(), {
      state: 'open',
      mergeCommitSha: null,
      mergedAt: null,
      headSha: 'commit-sha-1',
      additions: 1,
      deletions: 0,
      filesChanged: 1,
      repositoryPublic: true,
      headRepoOwner: AGENT_GITHUB_LOGIN,
      headRepoFullName: `${AGENT_GITHUB_LOGIN}/${FORK_REPO}`,
      headRepoIsFork: true,
      baseRepoFullName: `${FORK_OWNER}/${FORK_REPO}`,
      authorLogin: AGENT_GITHUB_LOGIN,
      body: `Job: ${id}\n`,
      ...overrides,
    });
  }
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
    extraAccounts?: readonly { did: string; githubLogin: string }[];
  } = {},
): Promise<{ server: Server; baseUrl: string; credentialRepo: CredentialRepository; authHeader: Record<string, string> }> {
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: AGENT_DID,
    operatorDid: 'did:abt:op-merge',
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: AGENT_GITHUB_LOGIN,
  });
  await agentRepo.updateGithubBinding(AGENT_DID, { handle: AGENT_GITHUB_LOGIN, status: 'verified' });
  const credentialRepo = extras.credentialRepo ?? new MemoryCredentialRepository();
  const credentials =
    extras.credentials ?? createCredentialsAdapter({ did: ISSUER_DID, seed: ISSUER_SEED }, credentialRepo);
  const operatorRepo = new MemoryAccountRepository();
  await operatorRepo.register({ did: BUYER_DID, githubLogin: 'buyer-merge-scripted' });
  for (const extra of extras.extraAccounts ?? []) await operatorRepo.register(extra);
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
    undefined,
    alwaysSettledGate(),
    anyCommitStagingObserver(),
  ).listen(0, '127.0.0.1');
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
// stage, open the pull request. Returns the submitted body so the merge
// tests can compare against it. P1: confirm needs an agreed price too, so
// the price rides the proposal and both parties accept it alongside the
// criteria. STG2: registers a matching agent-fork PR on the fixture right
// before submitting it, so the route's five-fact check passes.
async function walkToSubmitted(jobId: string, fixture: StagingLifecycleFixture, base: string = baseUrl): Promise<Record<string, unknown>> {
  expect(
    (await postSigned(`/jobs/${jobId}/criteria`, { criteria: proposal, priceUsd: '500.00', rail: 'abt' }, agentIdentity, base))
      .status,
  ).toBe(200);
  expect((await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, buyerIdentity, base)).status).toBe(200);
  expect((await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, agentIdentity, base)).status).toBe(200);
  expect((await postSigned(`/jobs/${jobId}/criteria/1/accept`, {}, buyerIdentity, base)).status).toBe(200);
  expect((await postSigned(`/jobs/${jobId}/criteria/1/accept`, {}, agentIdentity, base)).status).toBe(200);
  expect((await postSigned(`/jobs/${jobId}/price/accept`, {}, buyerIdentity, base)).status).toBe(200);
  expect((await postSigned(`/jobs/${jobId}/price/accept`, {}, agentIdentity, base)).status).toBe(200);
  expect((await postSigned(`/jobs/${jobId}/confirm`, {}, buyerIdentity, base)).status).toBe(200);
  expect((await postSigned(`/jobs/${jobId}/stage`, { stagedCommit: 'commit-sha-1' }, agentIdentity, base)).status).toBe(200);
  const { url } = registerSubmittablePr(fixture, jobId);
  const pr = await postSigned(`/jobs/${jobId}/pull-request`, { pullRequestUrl: url }, agentIdentity, base);
  expect(pr.status).toBe(200);
  return (await pr.json()) as Record<string, unknown>;
}

// A submitted job projects the base eight plus criteria, specHash and
// confirmedAt, then the submit pair (R-10) plus deadline (R-12): one writer
// per group. A completed job adds exactly mergeCommit and mergedAt (R-11).
// An outcome job (R-12) projects the submitted keyset and nothing more.
// STG2: pullRequestTemplate rides alongside stagedCommit/stagedAt, so it
// joins every submitted-or-later keyset too.
const SUBMITTED_KEYS = [
  'agentDid',
  'baseCommit',
  'brief',
  'briefHash',
  'buyerDid',
  'confirmedAt',
  'createdAt',
  'criteria',
  'deadline',
  'id',
  'pullRequestTemplate',
  'pullRequestUrl',
  'repository',
  'specHash',
  'stagedAt',
  'stagedCommit',
  'stagingRepo',
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
  const fixture = createStagingLifecycleGithubFake();
  // Set by the happy-path walk; the lock test posts that same id again.
  let happyJobId: string;
  let happyCredentialRepo: CredentialRepository;

  beforeAll(async () => {
    ({ server, baseUrl, credentialRepo: happyCredentialRepo, authHeader } = await startWith(jobRepo, fixture.github));
  });

  afterAll(() => {
    server.close();
  });

  it('walks submitted -> merge on ONE row and projects the completed keys', async () => {
    happyJobId = await openDraft('Fix the login bug on the checkout page');
    const submittedBody = await walkToSubmitted(happyJobId, fixture);
    expect(submittedBody.status).toBe('submitted');

    // The PR merges: same ref, same head sha, now reported merged.
    fixture.setPullRequest(prRef(), {
      state: 'merged',
      mergeCommitSha: MERGE_SHA,
      mergedAt: MERGED_AT,
      headSha: 'commit-sha-1',
      additions: 412,
      deletions: 87,
      filesChanged: 9,
      repositoryPublic: true,
      headRepoOwner: AGENT_GITHUB_LOGIN,
      headRepoFullName: `${AGENT_GITHUB_LOGIN}/${FORK_REPO}`,
      headRepoIsFork: true,
      baseRepoFullName: `${FORK_OWNER}/${FORK_REPO}`,
      authorLogin: AGENT_GITHUB_LOGIN,
      body: `Job: ${happyJobId}\n`,
    });

    const merge = await postSigned(`/jobs/${happyJobId}/merge`, {}, buyerIdentity);
    expect(merge.status).toBe(200);
    const mergedBody = (await merge.json()) as Record<string, unknown>;
    expect(mergedBody.id).toBe(happyJobId);
    expect(mergedBody.status).toBe('completed');
    // The values came from github, not this service's clock.
    expect(mergedBody.mergeCommit).toBe(MERGE_SHA);
    expect(mergedBody.mergedAt).toBe(MERGED_AT.toISOString());
    expect(Object.keys(mergedBody).sort()).toEqual([...COMPLETED_WITH_CREDENTIAL_KEYS, 'price'].sort());

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
    expect(fixture.calls.getPullRequest.length).toBeGreaterThanOrEqual(1);
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
    const before = fixture.calls.getPullRequest.length;
    const again = await postSigned(`/jobs/${happyJobId}/merge`, {}, buyerIdentity);
    expect(again.status).toBe(409);
    // The terminal state is checked before github is asked again: the count
    // stays at whatever it already was.
    expect(fixture.calls.getPullRequest.length).toBe(before);
  });

  it('answers 404 for an unknown id, with zero adapter or storage-complete calls', async () => {
    const before = fixture.calls.getPullRequest.length;
    const completeSpy = vi.spyOn(jobRepo, 'complete');
    const nowhere = await post('/jobs/j-nowhere/merge');
    expect(nowhere.status).toBe(404);
    expect(await nowhere.json()).toEqual({ error: 'not found' });
    expect(fixture.calls.getPullRequest.length).toBe(before);
    expect(completeSpy).not.toHaveBeenCalled();
    completeSpy.mockRestore();
  });

  it('answers 409 for a fresh draft, without asking github once', async () => {
    const draftId = await openDraft('A draft nobody confirmed');
    const before = fixture.calls.getPullRequest.length;

    const early = await postSigned(`/jobs/${draftId}/merge`, {}, buyerIdentity);
    expect(early.status).toBe(409);
    expect(((await early.json()) as { error: string }).error).toContain('status "draft"');
    expect(fixture.calls.getPullRequest.length).toBe(before);
  });
});

// GET /jobs/:jobId's credential field is absent, not null, when no credential
// row exists for a completed job - a row completed before this lap shipped,
// or the crash-between-two-writes residual named in the merge route.
describe('GET /jobs/:jobId, no credential row (R-36)', () => {
  it('omits the credential field for a completed job with no stored credential', async () => {
    const repo = new MemoryJobRepository();
    const fixture = createStagingLifecycleGithubFake();
    const row = submittedJob('j-no-cred');
    registerMatchingPrFor(fixture, row.id, { state: 'merged', mergeCommitSha: MERGE_SHA, mergedAt: MERGED_AT });
    await repo.create({
      ...row,
      status: 'completed',
      mergeCommit: MERGE_SHA,
      mergedAt: MERGED_AT,
    });
    const scripted = await startWith(repo, fixture.github);
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
    const fixture = createStagingLifecycleGithubFake();
    const row = submittedJob('j-unmerged-no-lookup');
    registerMatchingPrFor(fixture, row.id, { state: 'merged', mergeCommitSha: MERGE_SHA, mergedAt: MERGED_AT });
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
    const scripted = await startWith(repo, fixture.github, {
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
    const fixture = createStagingLifecycleGithubFake();
    const row = submittedJob('j-cred-lookup-fails');
    registerMatchingPrFor(fixture, row.id, { state: 'merged', mergeCommitSha: MERGE_SHA, mergedAt: MERGED_AT });
    await repo.create({
      ...row,
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
    const scripted = await startWith(repo, fixture.github, {
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
    const fixture = createStagingLifecycleGithubFake();
    const row = submittedJob('j-identity-fails');
    registerMatchingPrFor(fixture, row.id, { state: 'merged', mergeCommitSha: MERGE_SHA, mergedAt: MERGED_AT });
    const repo = new MemoryJobRepository();
    await repo.create(row);
    const scripted = await startWith(repo, fixture.github, {
      identity: fakeIdentity(() => Promise.reject(new Error('resolver unavailable'))),
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const merge = await postSigned(`/jobs/${row.id}/merge`, {}, buyerIdentity, scripted.baseUrl);
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
    const fixture = createStagingLifecycleGithubFake();
    const row = submittedJob('j-no-verification-method');
    registerMatchingPrFor(fixture, row.id, { state: 'merged', mergeCommitSha: MERGE_SHA, mergedAt: MERGED_AT });
    const repo = new MemoryJobRepository();
    await repo.create(row);
    const scripted = await startWith(repo, fixture.github, {
      identity: fakeIdentity((did) =>
        Promise.resolve({ id: did, controller: null, verificationMethod: [], alsoKnownAs: null }),
      ),
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const merge = await postSigned(`/jobs/${row.id}/merge`, {}, buyerIdentity, scripted.baseUrl);
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
    const fixture = createStagingLifecycleGithubFake();
    const row = submittedJob('j-issuance-fails');
    registerMatchingPrFor(fixture, row.id, { state: 'merged', mergeCommitSha: MERGE_SHA, mergedAt: MERGED_AT });
    const repo = new MemoryJobRepository();
    await repo.create(row);
    const failingCredentials: CredentialsAdapter = {
      issueWorkHistoryCredential: () => Promise.reject(new Error('signing key unavailable')),
      verifyCredential: () => Promise.reject(new NotImplementedError('credentials', 'verifyCredential')),
      getCredential: () => Promise.reject(new NotImplementedError('credentials', 'getCredential')),
      signAttestation: () => Promise.reject(new NotImplementedError('credentials', 'signAttestation')),
      issueDeemedCompletionCredential: () =>
        Promise.reject(new NotImplementedError('credentials', 'issueDeemedCompletionCredential')),
      describeIssuer: () => Promise.reject(new NotImplementedError('credentials', 'describeIssuer')),
    };
    const scripted = await startWith(repo, fixture.github, { credentials: failingCredentials });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const merge = await postSigned(`/jobs/${row.id}/merge`, {}, buyerIdentity, scripted.baseUrl);
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
    const fixture = createStagingLifecycleGithubFake();
    const row = submittedJob('j-cred-save-fails');
    registerMatchingPrFor(fixture, row.id, { state: 'merged', mergeCommitSha: MERGE_SHA, mergedAt: MERGED_AT });
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
    const scripted = await startWith(repo, fixture.github, {
      credentialRepo: new SaveFailingCredentialRepository(),
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const merge = await postSigned(`/jobs/${row.id}/merge`, {}, buyerIdentity, scripted.baseUrl);
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
    const fixture = createStagingLifecycleGithubFake();
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:op-merge-default',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: AGENT_GITHUB_LOGIN,
    });
    await agentRepo.updateGithubBinding(AGENT_DID, { handle: AGENT_GITHUB_LOGIN, status: 'verified' });
    const credentialRepo = new MemoryCredentialRepository();
    const operatorRepo = new MemoryAccountRepository();
    await operatorRepo.register({ did: BUYER_DID, githubLogin: 'buyer-merge-default' });
    const sessionAdapter = testSessionAdapter();
    const s = createApp(
      operatorRepo,
      agentRepo,
      fakeIdentity(),
      fixture.github,
      new MemoryJobRepository(),
      undefined,
      undefined,
      credentialRepo,
      undefined,
      undefined,
      undefined,
      sessionAdapter,
      undefined,
      alwaysSettledGate(),
      anyCommitStagingObserver(),
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => s.once('listening', resolve));
    const address = s.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const jobId = await openDraft('Fix the login bug on the checkout page', base);
      await walkToSubmitted(jobId, fixture, base);
      fixture.setPullRequest(prRef(), {
        state: 'merged',
        mergeCommitSha: MERGE_SHA,
        mergedAt: MERGED_AT,
        headSha: 'commit-sha-1',
        additions: 1,
        deletions: 0,
        filesChanged: 1,
        repositoryPublic: true,
        headRepoOwner: AGENT_GITHUB_LOGIN,
        headRepoFullName: `${AGENT_GITHUB_LOGIN}/${FORK_REPO}`,
        headRepoIsFork: true,
        baseRepoFullName: `${FORK_OWNER}/${FORK_REPO}`,
        authorLogin: AGENT_GITHUB_LOGIN,
        body: `Job: ${jobId}\n`,
      });
      const merge = await postSigned(`/jobs/${jobId}/merge`, {}, buyerIdentity, base);
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
    const fixture = createStagingLifecycleGithubFake();
    const scripted = await startWith(new MemoryJobRepository(), fixture.github);
    try {
      const jobId = await openDraft('A PR still under review', scripted.baseUrl);
      const submittedBody = await walkToSubmitted(jobId, fixture, scripted.baseUrl);
      expect(submittedBody.status).toBe('submitted');

      // Left as-is: still open, headSha unchanged from submission.
      const merge = await postSigned(`/jobs/${jobId}/merge`, {}, buyerIdentity, scripted.baseUrl);
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
    const fixture = createStagingLifecycleGithubFake();
    const scripted = await startWith(new MemoryJobRepository(), fixture.github);
    try {
      const jobId = await openDraft('A PR that was closed unmerged', scripted.baseUrl);
      await walkToSubmitted(jobId, fixture, scripted.baseUrl);
      fixture.setPullRequest(prRef(), {
        state: 'closed',
        mergeCommitSha: null,
        mergedAt: null,
        headSha: 'commit-sha-1',
        additions: 0,
        deletions: 0,
        filesChanged: 0,
        repositoryPublic: true,
        headRepoOwner: AGENT_GITHUB_LOGIN,
        headRepoFullName: `${AGENT_GITHUB_LOGIN}/${FORK_REPO}`,
        headRepoIsFork: true,
        baseRepoFullName: `${FORK_OWNER}/${FORK_REPO}`,
        authorLogin: AGENT_GITHUB_LOGIN,
        body: `Job: ${jobId}\n`,
      });

      const merge = await postSigned(`/jobs/${jobId}/merge`, {}, buyerIdentity, scripted.baseUrl);
      expect(merge.status).toBe(200);
      const body = (await merge.json()) as Record<string, unknown>;
      expect(body.id).toBe(jobId);
      expect(body.status).toBe('closed_unmerged');
      expect(Object.keys(body).sort()).toEqual([...SUBMITTED_KEYS, 'price'].sort());
      expect(body.mergeCommit).toBeUndefined();
      expect(body.mergedAt).toBeUndefined();
      expect(typeof body.deadline).toBe('string');

      // The outcome stays on record: the read-back is the recorded row.
      const read = await get(`/jobs/${jobId}`, scripted.baseUrl);
      expect(await read.json()).toEqual(body);
      const callsAfterFirstMerge = fixture.calls.getPullRequest.length;

      // Second observation: the terminal state is checked before github is
      // asked again, and it is a conflict, not a rewrite.
      const again = await postSigned(`/jobs/${jobId}/merge`, {}, buyerIdentity, scripted.baseUrl);
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: string }).error).toContain('closed_unmerged');
      expect(fixture.calls.getPullRequest.length).toBe(callsAfterFirstMerge);
    } finally {
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('answers 503 when github fails, and logs the cause', async () => {
    const fixture = createStagingLifecycleGithubFake();
    const { github, setFailing } = switchableGithub(fixture);
    const scripted = await startWith(new MemoryJobRepository(), github);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const jobId = await openDraft('A PR github cannot be reached for', scripted.baseUrl);
      await walkToSubmitted(jobId, fixture, scripted.baseUrl);
      setFailing(true);

      const merge = await postSigned(`/jobs/${jobId}/merge`, {}, buyerIdentity, scripted.baseUrl);
      expect(merge.status).toBe(503);
      expect(await merge.json()).toEqual({ error: 'github unavailable' });
      expect(errorLog).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('answers 404 when the row vanishes between the read and the write', async () => {
    const fixture = createStagingLifecycleGithubFake();
    const row = submittedJob('j-vanish');
    registerMatchingPrFor(fixture, row.id, { state: 'merged', mergeCommitSha: MERGE_SHA, mergedAt: MERGED_AT });
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
    const scripted = await startWith(new VanishingCompleteRepository(), fixture.github);
    try {
      const merge = await postSigned(`/jobs/${row.id}/merge`, {}, buyerIdentity, scripted.baseUrl);
      expect(merge.status).toBe(404);
      expect(await merge.json()).toEqual({ error: 'not found' });
    } finally {
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('answers 503 when storage fails to persist the completion, and logs the cause', async () => {
    const fixture = createStagingLifecycleGithubFake();
    const row = submittedJob('j-throw');
    registerMatchingPrFor(fixture, row.id, { state: 'merged', mergeCommitSha: MERGE_SHA, mergedAt: MERGED_AT });
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
    const scripted = await startWith(new ThrowingCompleteRepository(), fixture.github);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const merge = await postSigned(`/jobs/${row.id}/merge`, {}, buyerIdentity, scripted.baseUrl);
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
    const fixture = createStagingLifecycleGithubFake();
    registerMatchingPrFor(fixture, row.id, { state: 'merged', mergeCommitSha: MERGE_SHA, mergedAt: MERGED_AT });
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
    const scripted = await startWith(new ScriptedRow(), fixture.github);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const merge = await postSigned(`/jobs/${row.id}/merge`, {}, buyerIdentity, scripted.baseUrl);
      expect(merge.status).toBe(500);
      expect(await merge.json()).toEqual({ error: 'internal error' });
      expect(errorLog).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });
});

// STG2: the head-moved 409, before ANY outcome is recorded. The agent
// forked the buyer's repository itself and holds push on that fork, so
// nothing stops it from resetting the branch after the platform attested
// a commit; the merge route's own check catches that, for both an open
// and a merged PR (the card's own two cases).
describe('job merge, head moved off the attested commit (STG2)', () => {
  it('answers 409 and records nothing when the PR is open but its head sha no longer matches the attested commit', async () => {
    const fixture = createStagingLifecycleGithubFake();
    const row = submittedJob('j-head-moved-open');
    registerMatchingPrFor(fixture, row.id, { state: 'open', headSha: 'moved-off-the-attested-commit' });
    const repo = new MemoryJobRepository();
    await repo.create(row);
    const scripted = await startWith(repo, fixture.github);
    try {
      const merge = await postSigned(`/jobs/${row.id}/merge`, {}, buyerIdentity, scripted.baseUrl);
      expect(merge.status).toBe(409);
      const body = (await merge.json()) as Record<string, unknown>;
      expect(body.error).toBe('the pull request head moved off the attested commit');
      expect(body.attested).toBe('commit-sha-1');
      expect(body.head).toBe('moved-off-the-attested-commit');

      const read = await get(`/jobs/${row.id}`, scripted.baseUrl);
      const readBack = (await read.json()) as Record<string, unknown>;
      expect(readBack.status).toBe('submitted');
      expect(readBack.mergeCommit).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('answers 409 and records nothing when the PR merged but its head sha no longer matches the attested commit', async () => {
    const fixture = createStagingLifecycleGithubFake();
    const row = submittedJob('j-head-moved-merged');
    registerMatchingPrFor(fixture, row.id, {
      state: 'merged',
      mergeCommitSha: MERGE_SHA,
      mergedAt: MERGED_AT,
      headSha: 'moved-off-the-attested-commit',
    });
    const repo = new MemoryJobRepository();
    await repo.create(row);
    const scripted = await startWith(repo, fixture.github);
    try {
      const merge = await postSigned(`/jobs/${row.id}/merge`, {}, buyerIdentity, scripted.baseUrl);
      expect(merge.status).toBe(409);
      const body = (await merge.json()) as Record<string, unknown>;
      expect(body.error).toBe('the pull request head moved off the attested commit');
      expect(body.attested).toBe('commit-sha-1');
      expect(body.head).toBe('moved-off-the-attested-commit');

      const read = await get(`/jobs/${row.id}`, scripted.baseUrl);
      const readBack = (await read.json()) as Record<string, unknown>;
      expect(readBack.status).toBe('submitted');
      expect(readBack.mergeCommit).toBeUndefined();
      expect(readBack.mergedAt).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('answers 409 and records nothing when the PR closed unmerged but its head sha no longer matches the attested commit', async () => {
    const fixture = createStagingLifecycleGithubFake();
    const row = submittedJob('j-head-moved-closed');
    registerMatchingPrFor(fixture, row.id, { state: 'closed', headSha: 'moved-off-the-attested-commit' });
    const repo = new MemoryJobRepository();
    await repo.create(row);
    const scripted = await startWith(repo, fixture.github);
    try {
      const merge = await postSigned(`/jobs/${row.id}/merge`, {}, buyerIdentity, scripted.baseUrl);
      expect(merge.status).toBe(409);
      const body = (await merge.json()) as Record<string, unknown>;
      expect(body.error).toBe('the pull request head moved off the attested commit');

      const read = await get(`/jobs/${row.id}`, scripted.baseUrl);
      const readBack = (await read.json()) as Record<string, unknown>;
      expect(readBack.status).toBe('submitted');
    } finally {
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
    const fixture = createStagingLifecycleGithubFake();
    const row = { ...submittedJob('j-stale'), deadline: pastDeadline() };
    registerMatchingPrFor(fixture, row.id, { state: 'open' });
    const repo = new ScriptedOutcomeRepository(
      row,
      (r) => Promise.resolve(r),
      () => Promise.reject(new Error('unreachable')),
    );
    const scripted = await startWith(repo, fixture.github);
    try {
      const merge = await postSigned(`/jobs/${row.id}/merge`, {}, buyerIdentity, scripted.baseUrl);
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
    } finally {
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('answers 409 on a stale row whose PR is still open, without recording again', async () => {
    const fixture = createStagingLifecycleGithubFake();
    const row: Job = { ...submittedJob('j-stale-open'), status: 'stale', deadline: pastDeadline() };
    registerMatchingPrFor(fixture, row.id, { state: 'open' });
    const repo = new ScriptedOutcomeRepository(
      row,
      () => Promise.reject(new Error('unreachable')),
      () => Promise.reject(new Error('unreachable')),
    );
    const scripted = await startWith(repo, fixture.github);
    try {
      const merge = await postSigned(`/jobs/${row.id}/merge`, {}, buyerIdentity, scripted.baseUrl);
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
    const fixture = createStagingLifecycleGithubFake();
    const row: Job = { ...submittedJob('j-stale-merged'), status: 'stale', deadline: pastDeadline() };
    registerMatchingPrFor(fixture, row.id, { state: 'merged', mergeCommitSha: MERGE_SHA, mergedAt: MERGED_AT });
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
    const scripted = await startWith(repo, fixture.github);
    try {
      const merge = await postSigned(`/jobs/${row.id}/merge`, {}, buyerIdentity, scripted.baseUrl);
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
    const fixture = createStagingLifecycleGithubFake();
    const row: Job = { ...submittedJob('j-stale-closed'), status: 'stale', deadline: pastDeadline() };
    registerMatchingPrFor(fixture, row.id, { state: 'closed' });
    const repo = new ScriptedOutcomeRepository(
      row,
      (r) => Promise.resolve(r),
      (job) =>
        Promise.resolve({
          ...job,
          status: 'closed_unmerged' as const,
        }),
    );
    const scripted = await startWith(repo, fixture.github);
    try {
      const merge = await postSigned(`/jobs/${row.id}/merge`, {}, buyerIdentity, scripted.baseUrl);
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
    const fixture = createStagingLifecycleGithubFake();
    const row = { ...submittedJob('j-stale-503'), deadline: pastDeadline() };
    registerMatchingPrFor(fixture, row.id, { state: 'open' });
    const repo = new ScriptedOutcomeRepository(
      row,
      () => Promise.reject(new Error('connection refused')),
      () => Promise.reject(new Error('unreachable')),
    );
    const scripted = await startWith(repo, fixture.github);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const merge = await postSigned(`/jobs/${row.id}/merge`, {}, buyerIdentity, scripted.baseUrl);
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
    const fixture = createStagingLifecycleGithubFake();
    const row = submittedJob('j-closed-404');
    registerMatchingPrFor(fixture, row.id, { state: 'closed' });
    const repo = new ScriptedOutcomeRepository(
      row,
      () => Promise.resolve(null),
      () => Promise.reject(new Error('unreachable')),
    );
    const scripted = await startWith(repo, fixture.github);
    try {
      const merge = await postSigned(`/jobs/${row.id}/merge`, {}, buyerIdentity, scripted.baseUrl);
      expect(merge.status).toBe(404);
      expect(await merge.json()).toEqual({ error: 'not found' });
    } finally {
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });
});

describe('job merge, who may (B8, 2026-09-01)', () => {
  // D2 from review on t_66170f30: the merge guard was live but pinned by no
  // test, so reinstating the pre-B8 unauthenticated route passed the whole
  // suite. This block exists to make that mutation fail. Same shape as the
  // B6 and B7 blocks: unsigned 401, stranger 403, zero GitHub calls on the
  // refused legs, then both parties 200.
  const jobRepo = new MemoryJobRepository();
  const fixture = createStagingLifecycleGithubFake();
  let stranger: SigningIdentity;

  beforeAll(async () => {
    stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(93));
    // Registered, so the signature resolves and the refusal is the party
    // check (403), not an unknown key (401).
    ({ server, baseUrl, authHeader } = await startWith(jobRepo, fixture.github, {
      extraAccounts: [{ did: stranger.did, githubLogin: 'stranger-merge' }],
    }));
  });

  afterAll(() => {
    server.close();
  });

  it('refuses an unsigned merge with 401 and a stranger with 403, firing github zero times', async () => {
    const jobId = await openDraft('Fix the login bug on the checkout page');
    await walkToSubmitted(jobId, fixture);
    const before = fixture.calls.getPullRequest.length;
    const unsigned = await fetch(`${baseUrl}/jobs/${jobId}/merge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(unsigned.status).toBe(401);
    expect((await postSigned(`/jobs/${jobId}/merge`, {}, stranger)).status).toBe(403);
    expect(fixture.calls.getPullRequest.length).toBe(before);
    const job = (await (await get(`/jobs/${jobId}`)).json()) as { status: string };
    expect(job.status).toBe('submitted');
  });

  it('lets the buyer merge, and on a second job the agent', async () => {
    const buyerJob = await openDraft('Fix the login bug on the checkout page');
    await walkToSubmitted(buyerJob, fixture);
    fixture.setPullRequest(prRef(), {
      state: 'merged',
      mergeCommitSha: MERGE_SHA,
      mergedAt: MERGED_AT,
      headSha: 'commit-sha-1',
      additions: 1,
      deletions: 0,
      filesChanged: 1,
      repositoryPublic: true,
      headRepoOwner: AGENT_GITHUB_LOGIN,
      headRepoFullName: `${AGENT_GITHUB_LOGIN}/${FORK_REPO}`,
      headRepoIsFork: true,
      baseRepoFullName: `${FORK_OWNER}/${FORK_REPO}`,
      authorLogin: AGENT_GITHUB_LOGIN,
      body: `Job: ${buyerJob}\n`,
    });
    expect((await postSigned(`/jobs/${buyerJob}/merge`, {}, buyerIdentity)).status).toBe(200);

    const agentJob = await openDraft('Fix the login bug on the checkout page');
    await walkToSubmitted(agentJob, fixture);
    fixture.setPullRequest(prRef(), {
      state: 'merged',
      mergeCommitSha: `${MERGE_SHA}-2`,
      mergedAt: MERGED_AT,
      headSha: 'commit-sha-1',
      additions: 1,
      deletions: 0,
      filesChanged: 1,
      repositoryPublic: true,
      headRepoOwner: AGENT_GITHUB_LOGIN,
      headRepoFullName: `${AGENT_GITHUB_LOGIN}/${FORK_REPO}`,
      headRepoIsFork: true,
      baseRepoFullName: `${FORK_OWNER}/${FORK_REPO}`,
      authorLogin: AGENT_GITHUB_LOGIN,
      body: `Job: ${agentJob}\n`,
    });
    expect((await postSigned(`/jobs/${agentJob}/merge`, {}, agentIdentity)).status).toBe(200);
  });
});
