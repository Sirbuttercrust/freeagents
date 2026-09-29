// FIX-B60D (bugs.md B60, second half): before a submitted job past its
// review window is deemed complete, the platform asks GitHub once whether
// its pull request merged. A merge GitHub dates inside the window completes
// the job with the merge receipt (the work-history credential); only a pull
// request still unmerged when the window ends is deemed.
//
// Every case runs over real HTTP against createApp with the shared github
// fake (its calls.getPullRequest counts the reads). Jobs are planted
// directly as `submitted` rows with a submittedAt in the past, because the
// clocks read the stored timestamp, and each case then reads or acts on the
// job the way a person would: GET /jobs/:jobId, or a signed POST.
import type { Server } from 'node:http';

import { fromPublicKey } from '@arcblock/did';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import * as vc from '@digitalbazaar/vc';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import {
  isCompletedHireCredential,
  type CredentialsAdapter,
  type DeemedCompletionCredential,
  type VerifiableCredential,
} from '../../src/adapters/credentials/types.js';
import type { GithubAdapter, PullRequestRef } from '../../src/adapters/github/types.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import type { DidDocument, IdentityAdapter } from '../../src/adapters/identity/types.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
  MemoryMessageRepository,
} from '../../src/adapters/storage/memory.js';
import { createJob, type Job } from '../../src/domain/job.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { testSessionAdapter } from '../helpers/session-fixtures.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import {
  createStagingLifecycleGithubFake,
  registerAgentForkPullRequest,
  type StagingLifecycleFixture,
} from '../helpers/github-staging-fixtures.js';

const DAY_MS = 86_400_000;
const agentIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(151));
const buyerIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(152));
const AGENT_DID = agentIdentity.did;
const BUYER_DID = buyerIdentity.did;
const AGENT_GITHUB_LOGIN = 'scout-deem';
const PR_NUMBER = 7;
const MERGE_SHA = 'deem-merge-commit-sha';
const PR_URL = `https://github.com/buyer/target-repo/pull/${PR_NUMBER}`;
const PR_REF: PullRequestRef = { owner: 'buyer', repo: 'target-repo', number: PR_NUMBER };
const ISSUER_DID = 'did:abt:test-platform-issuer';
const ISSUER_SEED = new Uint8Array(32).fill(7);

interface Rig {
  readonly baseUrl: string;
  readonly jobRepo: MemoryJobRepository;
  readonly credentialRepo: MemoryCredentialRepository;
  readonly messageRepo: MemoryMessageRepository;
  readonly fixture: StagingLifecycleFixture;
  readonly failGithub: { value: boolean };
  readonly failIdentity: { value: boolean };
  readonly failIssuance: { value: boolean };
}

const servers: Server[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) server.close();
});

// Every failure switch below is off by default. github, identity and the
// signing adapter each reject while their own switch is on, so one rig can
// fail a leg and then recover it, the way a real outage clears.
async function boot(issuer: { did: string; seed: Uint8Array } = { did: ISSUER_DID, seed: ISSUER_SEED }): Promise<Rig> {
  const fixture = createStagingLifecycleGithubFake();
  const failGithub = { value: false };
  const failIdentity = { value: false };
  const failIssuance = { value: false };
  const github: GithubAdapter = {
    ...fixture.github,
    getPullRequest: (ref) =>
      failGithub.value ? Promise.reject(new Error('connection refused by github')) : fixture.github.getPullRequest(ref),
  };
  const identity: IdentityAdapter = {
    ...createIdentityAdapter(),
    resolveDid: (did: string): Promise<DidDocument> =>
      failIdentity.value
        ? Promise.reject(new Error('resolver unreachable'))
        : Promise.resolve({ id: did, controller: null, verificationMethod: [`${did}#key-1`], alsoKnownAs: null }),
  };
  const credentialRepo = new MemoryCredentialRepository();
  const real: CredentialsAdapter = createCredentialsAdapter(issuer, credentialRepo);
  const credentials: CredentialsAdapter = {
    ...real,
    issueWorkHistoryCredential: (subjectDid, claim) =>
      failIssuance.value
        ? Promise.reject(new Error('signing key unavailable'))
        : real.issueWorkHistoryCredential(subjectDid, claim),
  };
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: AGENT_DID,
    operatorDid: 'did:abt:op-deem',
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: AGENT_GITHUB_LOGIN,
    negotiatesOnOwnersBehalf: true,
  });
  await agentRepo.updateGithubBinding(AGENT_DID, { handle: AGENT_GITHUB_LOGIN, status: 'verified' });
  const accounts = new MemoryAccountRepository();
  await accounts.register({ did: BUYER_DID, githubLogin: 'buyer-deem' });
  const jobRepo = new MemoryJobRepository();
  const messageRepo = new MemoryMessageRepository();
  const server = createApp(
    accounts,
    agentRepo,
    identity,
    github,
    jobRepo,
    credentials,
    undefined,
    credentialRepo,
    undefined,
    undefined,
    undefined,
    testSessionAdapter(),
    undefined,
    alwaysSettledGate(),
    anyCommitStagingObserver(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    messageRepo,
  ).listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected server to listen on a port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    jobRepo,
    credentialRepo,
    messageRepo,
    fixture,
    failGithub,
    failIdentity,
    failIssuance,
  };
}

// A submitted row (the shape tests/api/job-merge.test.ts plants) whose
// submittedAt is `daysAgo` days before now, with the pull request it names
// registered open on the fixture at the attested commit.
async function plant(rig: Rig, id: string, daysAgo: number): Promise<Job> {
  const submittedAt = new Date(Date.now() - daysAgo * DAY_MS);
  const job: Job = {
    ...createJob(
      { id, buyerDid: BUYER_DID, agentDid: AGENT_DID, repository: 'buyer/target-repo', brief: 'Fix the login bug' },
      new Date(submittedAt.getTime() - DAY_MS),
    ),
    status: 'submitted',
    pullRequestUrl: PR_URL,
    submittedAt,
    stagedAt: new Date(submittedAt.getTime() - 6 * 3_600_000),
    stagedCommit: 'commit-sha-1',
    deadline: new Date(submittedAt.getTime() + 30 * DAY_MS),
    criteria: [
      { text: 'fixes the login bug', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
      { text: 'no new dependencies', proposedBy: 'buyer', acceptedByBuyer: true, acceptedByAgent: true },
    ],
    confirmedSpecHash: 'a'.repeat(64),
    confirmedAt: new Date(submittedAt.getTime() - 12 * 3_600_000),
    stagingRepo: { owner: 'freeagents-platform', repo: `staging-${id}` },
    baseCommit: 'buyer-target-repo-head-sha',
  };
  await rig.jobRepo.create(job);
  registerAgentForkPullRequest(rig.fixture, {
    repository: 'buyer/target-repo',
    jobId: id,
    stagedCommit: 'commit-sha-1',
    agentLogin: AGENT_GITHUB_LOGIN,
    number: PR_NUMBER,
  });
  return job;
}

// What GitHub reports for the planted pull request from here on.
function script(
  rig: Rig,
  jobId: string,
  state: 'open' | 'closed' | 'merged',
  extra: { mergedAt?: Date | null; headSha?: string; mergeCommitSha?: string | null } = {},
): void {
  rig.fixture.setPullRequest(PR_REF, {
    state,
    mergeCommitSha: state === 'merged' ? (extra.mergeCommitSha === undefined ? MERGE_SHA : extra.mergeCommitSha) : null,
    mergedAt: state === 'merged' ? (extra.mergedAt === undefined ? null : extra.mergedAt) : null,
    headSha: extra.headSha ?? 'commit-sha-1',
    additions: 412,
    deletions: 87,
    filesChanged: 9,
    repositoryPublic: true,
    headRepoOwner: AGENT_GITHUB_LOGIN,
    headRepoFullName: `${AGENT_GITHUB_LOGIN}/target-repo`,
    headRepoIsFork: true,
    baseRepoFullName: 'buyer/target-repo',
    authorLogin: AGENT_GITHUB_LOGIN,
    body: `Job: ${jobId}\n`,
  });
}

function mergedAfterSubmit(job: Job, days: number): Date {
  if (job.submittedAt === null) throw new Error('planted job has no submittedAt');
  return new Date(job.submittedAt.getTime() + days * DAY_MS);
}

async function read(rig: Rig, jobId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${rig.baseUrl}/jobs/${jobId}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function postSigned(
  rig: Rig,
  path: string,
  identity: SigningIdentity,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const bodyText = JSON.stringify({});
  const targetUri = `${rig.baseUrl}${path}`;
  const signed = signRequest(identity, 'POST', targetUri, { body: bodyText });
  const res = await fetch(targetUri, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
    body: bodyText,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function silenceErrors(): void {
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

async function completedMessages(rig: Rig, jobId: string): Promise<readonly unknown[]> {
  const rows = await rig.messageRepo.listByJobId(jobId);
  return rows.filter((row) => row.systemEvent?.type === 'completed').map((row) => row.systemEvent);
}

describe('a merge GitHub dates inside the window completes the job, even when the read comes after it (a)', () => {
  it('answers completed with GitHub\'s merge facts and the work-history credential, never a deemed one', async () => {
    const rig = await boot();
    const job = await plant(rig, 'j-deem-a', 8);
    const mergedAt = mergedAfterSubmit(job, 3);
    script(rig, job.id, 'merged', { mergedAt });

    const { status, body } = await read(rig, job.id);

    expect(status).toBe(200);
    expect(body.status).toBe('completed');
    expect(body.mergeCommit).toBe(MERGE_SHA);
    expect(body.mergedAt).toBe(mergedAt.toISOString());
    const credential = body.credential as VerifiableCredential;
    expect(isCompletedHireCredential(credential)).toBe(true);
    expect(credential.type).toEqual(['VerifiableCredential', 'CompletedHireCredential']);
    expect((credential.credentialSubject as unknown as { hire: { mergedAt: string } }).hire.mergedAt).toBe(
      mergedAt.toISOString(),
    );
    const stored = await rig.credentialRepo.findByDocumentId(job.id);
    expect(stored).toEqual(credential);
    expect(stored?.type).toEqual(['VerifiableCredential', 'CompletedHireCredential']);
    expect(await completedMessages(rig, job.id)).toEqual([{ type: 'completed', mergeCommit: MERGE_SHA }]);
    expect((await rig.jobRepo.findById(job.id))?.status).toBe('completed');
  });

  it('a merge exactly at the end of the window (7 days after submittedAt) is inside it', async () => {
    const rig = await boot();
    const job = await plant(rig, 'j-deem-a-edge', 8);
    script(rig, job.id, 'merged', { mergedAt: mergedAfterSubmit(job, 7) });

    const { status, body } = await read(rig, job.id);

    expect(status).toBe(200);
    expect(body.status).toBe('completed');
  });
});

describe('a pull request still unmerged when the window ends is deemed, as before (b, c, d, f)', () => {
  it('(b) open on GitHub: deemed with the deemed-completion credential, after exactly one GitHub read', async () => {
    const rig = await boot();
    const job = await plant(rig, 'j-deem-b', 8);
    script(rig, job.id, 'open');

    const { status, body } = await read(rig, job.id);

    expect(status).toBe(200);
    expect(body.status).toBe('deemed_completed');
    const credential = body.credential as DeemedCompletionCredential;
    expect(credential.type).toEqual(['VerifiableCredential', 'DeemedCompletionCredential']);
    expect(credential.credentialSubject.deemedCompletion).toEqual({
      stagedCommit: 'commit-sha-1',
      noMerge: true,
      buyer: BUYER_DID,
    });
    expect(rig.fixture.calls.getPullRequest).toEqual([PR_REF]);
  });

  it('(c) closed unmerged on GitHub: deemed, since only a cited close stops the credential', async () => {
    const rig = await boot();
    const job = await plant(rig, 'j-deem-c', 8);
    script(rig, job.id, 'closed');

    const { status, body } = await read(rig, job.id);

    expect(status).toBe(200);
    expect(body.status).toBe('deemed_completed');
    expect((body.credential as DeemedCompletionCredential).type).toEqual([
      'VerifiableCredential',
      'DeemedCompletionCredential',
    ]);
    expect(rig.fixture.calls.getPullRequest).toEqual([PR_REF]);
  });

  it('(d) merged 8 days after submittedAt, after the window: deemed, and no merge receipt', async () => {
    const rig = await boot();
    const job = await plant(rig, 'j-deem-d', 9);
    script(rig, job.id, 'merged', { mergedAt: mergedAfterSubmit(job, 8) });

    const { status, body } = await read(rig, job.id);

    expect(status).toBe(200);
    expect(body.status).toBe('deemed_completed');
    expect(body.mergeCommit).toBeUndefined();
    expect((body.credential as DeemedCompletionCredential).type).toEqual([
      'VerifiableCredential',
      'DeemedCompletionCredential',
    ]);
  });

  it('(d) merged with no date from GitHub has no instant inside the window: deemed, as the merge route would date it now', async () => {
    const rig = await boot();
    const job = await plant(rig, 'j-deem-d-null', 8);
    script(rig, job.id, 'merged', { mergedAt: null });

    const { body } = await read(rig, job.id);

    expect(body.status).toBe('deemed_completed');
  });

  it('(f) merged, but the head moved off the attested commit: deemed, a merge of other work is not this job\'s merge', async () => {
    const rig = await boot();
    const job = await plant(rig, 'j-deem-f', 8);
    script(rig, job.id, 'merged', { mergedAt: mergedAfterSubmit(job, 3), headSha: 'some-other-commit' });

    const { status, body } = await read(rig, job.id);

    expect(status).toBe(200);
    expect(body.status).toBe('deemed_completed');
    expect(body.mergeCommit).toBeUndefined();
  });

  it('(f) the attested-commit comparison ignores case, as the merge route does', async () => {
    const rig = await boot();
    const job = await plant(rig, 'j-deem-f-case', 8);
    script(rig, job.id, 'merged', { mergedAt: mergedAfterSubmit(job, 3), headSha: 'COMMIT-SHA-1' });

    const { body } = await read(rig, job.id);

    expect(body.status).toBe('completed');
  });
});

describe('GitHub, identity and signing failures leave the job submitted and answer 503 (e, g)', () => {
  it('(e) GitHub throws: 503 github unavailable, the row stays submitted, nothing is issued, the next read recovers', async () => {
    silenceErrors();
    const rig = await boot();
    const job = await plant(rig, 'j-deem-e', 8);
    const mergedAt = mergedAfterSubmit(job, 3);
    script(rig, job.id, 'merged', { mergedAt });
    rig.failGithub.value = true;

    const failed = await read(rig, job.id);

    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ error: 'github unavailable' });
    expect((await rig.jobRepo.findById(job.id))?.status).toBe('submitted');
    expect(await rig.credentialRepo.findByDocumentId(job.id)).toBeNull();

    rig.failGithub.value = false;
    const recovered = await read(rig, job.id);

    expect(recovered.status).toBe(200);
    expect(recovered.body.status).toBe('completed');
    expect(recovered.body.mergedAt).toBe(mergedAt.toISOString());
    expect(isCompletedHireCredential(recovered.body.credential as VerifiableCredential)).toBe(true);
  });

  it('GitHub reports a merge with no merge commit: 503 github unavailable, never an unhandled rejection, the row stays submitted', async () => {
    silenceErrors();
    const rig = await boot();
    const job = await plant(rig, 'j-deem-nosha', 8);
    script(rig, job.id, 'merged', { mergedAt: mergedAfterSubmit(job, 3), mergeCommitSha: null });

    const { status, body } = await read(rig, job.id);

    expect(status).toBe(503);
    expect(body).toEqual({ error: 'github unavailable' });
    expect((await rig.jobRepo.findById(job.id))?.status).toBe('submitted');
    expect(await rig.credentialRepo.findByDocumentId(job.id)).toBeNull();
  });

  it('(g) identity resolution throws on a merge inside the window: 503, still submitted, nothing issued, the next read completes it', async () => {
    silenceErrors();
    const rig = await boot();
    const job = await plant(rig, 'j-deem-g1', 8);
    script(rig, job.id, 'merged', { mergedAt: mergedAfterSubmit(job, 3) });
    rig.failIdentity.value = true;

    const failed = await read(rig, job.id);

    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ error: 'identity resolution unavailable' });
    expect((await rig.jobRepo.findById(job.id))?.status).toBe('submitted');
    expect(await rig.credentialRepo.findByDocumentId(job.id)).toBeNull();
    expect(await completedMessages(rig, job.id)).toEqual([]);

    rig.failIdentity.value = false;
    const recovered = await read(rig, job.id);

    expect(recovered.status).toBe(200);
    expect(recovered.body.status).toBe('completed');
    expect(isCompletedHireCredential(recovered.body.credential as VerifiableCredential)).toBe(true);
  });

  it('(g) issuing the work-history credential throws: 503, still submitted, nothing issued, the next read completes it', async () => {
    silenceErrors();
    const rig = await boot();
    const job = await plant(rig, 'j-deem-g2', 8);
    script(rig, job.id, 'merged', { mergedAt: mergedAfterSubmit(job, 3) });
    rig.failIssuance.value = true;

    const failed = await read(rig, job.id);

    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ error: 'credential issuance unavailable' });
    expect((await rig.jobRepo.findById(job.id))?.status).toBe('submitted');
    expect(await rig.credentialRepo.findByDocumentId(job.id)).toBeNull();
    expect(await completedMessages(rig, job.id)).toEqual([]);

    rig.failIssuance.value = false;
    const recovered = await read(rig, job.id);

    expect(recovered.status).toBe(200);
    expect(recovered.body.status).toBe('completed');
    expect(isCompletedHireCredential(recovered.body.credential as VerifiableCredential)).toBe(true);
  });
});

describe('GitHub is asked once per job, and only after the window has passed (h)', () => {
  it('after a completion, a second read makes no further GitHub call', async () => {
    const rig = await boot();
    const job = await plant(rig, 'j-deem-h-a', 8);
    script(rig, job.id, 'merged', { mergedAt: mergedAfterSubmit(job, 3) });

    const first = await read(rig, job.id);
    const second = await read(rig, job.id);

    expect(first.body.status).toBe('completed');
    expect(second.body).toEqual(first.body);
    expect(rig.fixture.calls.getPullRequest).toEqual([PR_REF]);
    expect(await completedMessages(rig, job.id)).toHaveLength(1);
  });

  it.each([
    ['open', 'open' as const],
    ['closed unmerged', 'closed' as const],
  ])('after a deem on a pull request GitHub reports %s, a second read makes no further GitHub call', async (_label, state) => {
    const rig = await boot();
    const job = await plant(rig, `j-deem-h-${state}`, 8);
    script(rig, job.id, state);

    const first = await read(rig, job.id);
    const second = await read(rig, job.id);

    expect(first.body.status).toBe('deemed_completed');
    expect(second.body).toEqual(first.body);
    expect(rig.fixture.calls.getPullRequest).toEqual([PR_REF]);
  });

  it('a submitted job inside its window (6 days old) makes no GitHub call at all, on two reads', async () => {
    const rig = await boot();
    const job = await plant(rig, 'j-deem-h-young', 6);
    script(rig, job.id, 'merged', { mergedAt: mergedAfterSubmit(job, 3) });

    const first = await read(rig, job.id);
    const second = await read(rig, job.id);

    expect(first.body.status).toBe('submitted');
    expect(second.body.status).toBe('submitted');
    expect(rig.fixture.calls.getPullRequest).toEqual([]);
  });
});

describe('the mutation door: a route that loads the job sees the merge too (i)', () => {
  it('a signed POST /merge by the buyer, 8 days after submittedAt, completes with the work-history credential', async () => {
    const rig = await boot();
    const job = await plant(rig, 'j-deem-i-merge', 8);
    const mergedAt = mergedAfterSubmit(job, 3);
    script(rig, job.id, 'merged', { mergedAt });

    const { status, body } = await postSigned(rig, `/jobs/${job.id}/merge`, buyerIdentity);

    expect(status).toBe(200);
    expect(body.status).toBe('completed');
    expect(body.mergeCommit).toBe(MERGE_SHA);
    expect(body.mergedAt).toBe(mergedAt.toISOString());
    const credential = body.credential as VerifiableCredential;
    expect(credential.type).toEqual(['VerifiableCredential', 'CompletedHireCredential']);
    expect(await rig.credentialRepo.findByDocumentId(job.id)).toEqual(credential);
    expect(await completedMessages(rig, job.id)).toHaveLength(1);
    expect(rig.fixture.calls.getPullRequest).toEqual([PR_REF]);
  });

  it('a signed POST /merge on an unmerged pull request past the window answers the deemed 409 after one GitHub read', async () => {
    const rig = await boot();
    const job = await plant(rig, 'j-deem-i-open', 8);
    script(rig, job.id, 'open');

    const { status, body } = await postSigned(rig, `/jobs/${job.id}/merge`, buyerIdentity);

    expect(status).toBe(409);
    expect(body).toEqual({ error: 'cannot merge a job in status "deemed_completed"' });
    expect(rig.fixture.calls.getPullRequest).toEqual([PR_REF]);
  });

  it('a signed POST /withdraw on the same job sees completed, never deemed_completed', async () => {
    const rig = await boot();
    const job = await plant(rig, 'j-deem-i-withdraw', 8);
    script(rig, job.id, 'merged', { mergedAt: mergedAfterSubmit(job, 3) });

    const { status, body } = await postSigned(rig, `/jobs/${job.id}/withdraw`, buyerIdentity);

    expect(status).toBe(409);
    expect(body).toEqual({ error: 'cannot transition from "completed" a job in status "completed"' });
    expect((await rig.jobRepo.findById(job.id))?.status).toBe('completed');
  });
});

// The same helper tests/api/job-merge-invariant2.test.ts uses: a stranger
// holding only the credential JSON, checked with the off-the-shelf W3C stack.
function didFromKey(key: Ed25519VerificationKey2020): string {
  const keyWithBuffer = key as unknown as { _publicKeyBuffer: Uint8Array };
  return `did:abt:${fromPublicKey(keyWithBuffer._publicKeyBuffer)}`;
}

async function generateKey(seed: Uint8Array): Promise<Ed25519VerificationKey2020> {
  const key = await Ed25519VerificationKey2020.generate({ seed, controller: 'did:abt:pending' });
  key.controller = didFromKey(key);
  return key;
}

async function verifyIndependent(credential: Record<string, unknown>): Promise<boolean> {
  try {
    const proof = credential.proof as Record<string, unknown>;
    const verificationMethod = String(proof.verificationMethod);
    const issuer = String(credential.issuer);

    const fingerprint = verificationMethod.slice(verificationMethod.indexOf('#') + 1);
    const key = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint });

    const keyWithBuffer = key as unknown as { _publicKeyBuffer: Uint8Array };
    if (fromPublicKey(keyWithBuffer._publicKeyBuffer) !== issuer.replace(/^did:abt:/, '')) {
      return false;
    }

    key.controller = issuer;
    key.id = verificationMethod;

    const loader = securityLoader();
    loader.addStatic(key.id, {
      '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
      ...key.export({ publicKey: true }),
    });
    loader.addStatic(issuer, {
      '@context': 'https://www.w3.org/ns/did/v1',
      id: issuer,
      assertionMethod: [key.id],
      verificationMethod: [
        {
          '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
          ...key.export({ publicKey: true }),
        },
      ],
    });
    const documentLoader = loader.build();

    const result = await vc.verifyCredential({
      credential,
      suite: new Ed25519Signature2020(),
      documentLoader,
    });
    return result.verified === true;
  } catch {
    return false;
  }
}

describe('invariant 2: the work-history credential issued on the deem path verifies without this service (j)', () => {
  it('verifies with the W3C stack alone, and a tampered copy fails', async () => {
    const issuerSeed = crypto.getRandomValues(new Uint8Array(32));
    const issuerKey = await generateKey(issuerSeed);
    const rig = await boot({ did: issuerKey.controller, seed: issuerSeed });
    const job = await plant(rig, 'j-deem-j', 8);
    script(rig, job.id, 'merged', { mergedAt: mergedAfterSubmit(job, 3) });

    const { body } = await read(rig, job.id);
    const credential = body.credential as unknown as Record<string, unknown>;

    expect(body.status).toBe('completed');
    expect(credential.issuer).toBe(issuerKey.controller);
    expect(await verifyIndependent(credential)).toBe(true);

    const tampered = JSON.parse(JSON.stringify(credential)) as Record<string, unknown>;
    const hire = (tampered.credentialSubject as Record<string, Record<string, unknown>>).hire as Record<string, unknown>;
    hire.additions = 999999;
    expect(await verifyIndependent(tampered)).toBe(false);
  });
});
