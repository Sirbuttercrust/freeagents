// SW1-09: the two job clocks (the seven-day deem and unpaid lapse, the
// thirty-day unstaged expiry) run on every read that reports a job, not only
// on GET /jobs/:jobId and the job mutations. A hire whose deadline passed
// reads as ended on the buyer's job list, both conversation lists and the
// public conduct record without anyone opening that one hire, and a deemed
// completion is recorded (with its credential) the first time any of those
// reads sees it.
//
// Every case runs over real HTTP against createApp. Jobs are planted as
// stored rows with a timestamp in the past, because the clocks read the
// stored timestamp. One rig per read where the read under test would
// otherwise find a lapse an earlier read in the same case had persisted.
import type { Server } from 'node:http';

import { fromPublicKey } from '@arcblock/did';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import * as vc from '@digitalbazaar/vc';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import type { CredentialsAdapter, DeemedCompletionCredential } from '../../src/adapters/credentials/types.js';
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
import { resolveAvatar } from '../../src/domain/avatar-spec.js';
import { createJob, type Job, type JobStatus } from '../../src/domain/job.js';
import { jobListBucketOf } from '../../src/domain/job-list.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { testSessionAdapter } from '../helpers/session-fixtures.js';
import { depositSettledGate } from '../helpers/settlement-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import {
  createStagingLifecycleGithubFake,
  registerAgentForkPullRequest,
  type StagingLifecycleFixture,
} from '../helpers/github-staging-fixtures.js';

const DAY_MS = 86_400_000;
const agentIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(161));
const gatedIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(162));
const buyerIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(163));
const ownerIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(164));
const AGENT_DID = agentIdentity.did;
const GATED_DID = gatedIdentity.did;
const BUYER_DID = buyerIdentity.did;
const OWNER_DID = ownerIdentity.did;
const AGENT_GITHUB_LOGIN = 'scout-clocks';
const BUYER_LOGIN = 'buyer-clocks';
const OWNER_LOGIN = 'owner-clocks';
const REPOSITORY = 'buyer/target-repo';
const STAGED_COMMIT = 'commit-sha-1';
const MERGE_SHA = 'clocks-merge-commit-sha';
const ISSUER_DID = 'did:abt:test-platform-issuer';
const ISSUER_SEED = new Uint8Array(32).fill(7);

interface Rig {
  readonly baseUrl: string;
  readonly jobRepo: MemoryJobRepository;
  readonly credentialRepo: MemoryCredentialRepository;
  readonly fixture: StagingLifecycleFixture;
  readonly failingPullRequests: Set<number>;
}

const servers: Server[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) server.close();
});

async function boot(issuer: { did: string; seed: Uint8Array } = { did: ISSUER_DID, seed: ISSUER_SEED }): Promise<Rig> {
  const fixture = createStagingLifecycleGithubFake();
  const failingPullRequests = new Set<number>();
  const github: GithubAdapter = {
    ...fixture.github,
    getPullRequest: (ref) =>
      failingPullRequests.has(ref.number)
        ? Promise.reject(new Error('connection refused by github'))
        : fixture.github.getPullRequest(ref),
  };
  // The merge receipt names the agent's key, which the resolver answers
  // for a signing agent.
  const identity: IdentityAdapter = {
    ...createIdentityAdapter(),
    resolveDid: (did: string): Promise<DidDocument> =>
      Promise.resolve({ id: did, controller: null, verificationMethod: [`${did}#key-1`], alsoKnownAs: null }),
  };
  const credentialRepo = new MemoryCredentialRepository();
  const credentials: CredentialsAdapter = createCredentialsAdapter(issuer, credentialRepo);
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: AGENT_DID,
    operatorDid: OWNER_DID,
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: AGENT_GITHUB_LOGIN,
    negotiatesOnOwnersBehalf: true,
  });
  await agentRepo.updateGithubBinding(AGENT_DID, { handle: AGENT_GITHUB_LOGIN, status: 'verified' });
  await agentRepo.create({
    did: GATED_DID,
    operatorDid: OWNER_DID,
    delegation: { fixture: true } as never,
    name: 'gated-scout',
    skills: ['triage'],
    githubLogin: null,
    minBuyerMerges: 1,
  });
  const accounts = new MemoryAccountRepository();
  await accounts.register({ did: BUYER_DID, githubLogin: BUYER_LOGIN });
  await accounts.register({ did: OWNER_DID, githubLogin: OWNER_LOGIN });
  const jobRepo = new MemoryJobRepository();
  const server = createApp(
    accounts,
    agentRepo,
    identity,
    github,
    jobRepo,
    credentials,
    undefined,
    credentialRepo,
    { verify: 100_000, read: 100_000, write: 100_000, upstream: 100_000 },
    undefined,
    undefined,
    testSessionAdapter(),
    undefined,
    depositSettledGate(),
    anyCommitStagingObserver(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    new MemoryMessageRepository(),
  ).listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected server to listen on a port');
  return { baseUrl: `http://127.0.0.1:${address.port}`, jobRepo, credentialRepo, fixture, failingPullRequests };
}

// One stored row whose clock timestamp sits `daysAgo` days before the
// moment the test took. The anchor is the row's own timestamp: submittedAt
// for a submitted job, stagedAt for a staged one, confirmedAt for a
// confirmed one.
function rowAt(id: string, status: Extract<JobStatus, 'submitted' | 'staged' | 'confirmed'>, daysAgo: number, now: Date, agentDid = AGENT_DID): Job {
  const anchor = new Date(now.getTime() - daysAgo * DAY_MS);
  const confirmedAt = status === 'confirmed' ? anchor : new Date(anchor.getTime() - 12 * 3_600_000);
  const base: Job = {
    ...createJob({ id, buyerDid: BUYER_DID, agentDid, repository: REPOSITORY, brief: 'Fix the login bug' }, new Date(confirmedAt.getTime() - DAY_MS)),
    status,
    criteria: [{ text: 'fixes the login bug', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
    confirmedSpecHash: 'a'.repeat(64),
    confirmedAt,
    stagingRepo: { owner: 'freeagents-platform', repo: `staging-${id}` },
    baseCommit: 'buyer-target-repo-head-sha',
  };
  if (status === 'confirmed') return base;
  const stagedAt = status === 'staged' ? anchor : new Date(anchor.getTime() - 6 * 3_600_000);
  const staged: Job = { ...base, stagedAt, stagedCommit: STAGED_COMMIT };
  if (status === 'staged') return staged;
  return { ...staged, submittedAt: anchor, deadline: new Date(anchor.getTime() + 30 * DAY_MS) };
}

function prUrl(number: number): string {
  return `https://github.com/${REPOSITORY}/pull/${String(number)}`;
}

// A submitted job with its pull request registered open at the attested
// commit on the fake, the case the deem clock is for.
async function plantSubmitted(rig: Rig, id: string, daysAgo: number, now: Date, number: number, agentDid = AGENT_DID): Promise<Job> {
  const job: Job = { ...rowAt(id, 'submitted', daysAgo, now, agentDid), pullRequestUrl: prUrl(number) };
  await rig.jobRepo.create(job);
  registerAgentForkPullRequest(rig.fixture, {
    repository: REPOSITORY,
    jobId: id,
    stagedCommit: STAGED_COMMIT,
    agentLogin: AGENT_GITHUB_LOGIN,
    number,
  });
  return job;
}

async function plantStaged(rig: Rig, id: string, daysAgo: number, now: Date): Promise<Job> {
  const job = rowAt(id, 'staged', daysAgo, now);
  await rig.jobRepo.create(job);
  return job;
}

async function plantConfirmed(rig: Rig, id: string, daysAgo: number, now: Date): Promise<Job> {
  const job = rowAt(id, 'confirmed', daysAgo, now);
  await rig.jobRepo.create(job);
  return job;
}

function mergeOnGithub(rig: Rig, jobId: string, number: number, mergedAt: Date): void {
  const ref: PullRequestRef = { owner: 'buyer', repo: 'target-repo', number };
  rig.fixture.setPullRequest(ref, {
    state: 'merged',
    mergeCommitSha: MERGE_SHA,
    mergedAt,
    headSha: STAGED_COMMIT,
    additions: 412,
    deletions: 87,
    filesChanged: 9,
    repositoryPublic: true,
    headRepoOwner: AGENT_GITHUB_LOGIN,
    headRepoFullName: `${AGENT_GITHUB_LOGIN}/target-repo`,
    headRepoIsFork: true,
    baseRepoFullName: REPOSITORY,
    authorLogin: AGENT_GITHUB_LOGIN,
    body: `Job: ${jobId}\n`,
  });
}

async function getSigned(rig: Rig, path: string, identity: SigningIdentity): Promise<Response> {
  const targetUri = `${rig.baseUrl}${path}`;
  const signed = signRequest(identity, 'GET', targetUri, { components: ['@method', '@target-uri', 'content-digest'] });
  return fetch(targetUri, {
    headers: {
      Accept: 'application/json',
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
  });
}

async function postJob(rig: Rig, body: Record<string, unknown>, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${rig.baseUrl}/jobs`;
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

interface ListRow {
  readonly id: string;
  readonly brief: string;
  readonly agentName: string;
  readonly repository: string;
  readonly status: string;
  readonly bucket: string;
  readonly date: string | null;
}

async function readJobList(rig: Rig): Promise<{ status: number; jobs: ListRow[] }> {
  const res = await getSigned(rig, `/accounts/${BUYER_DID}/jobs`, buyerIdentity);
  const body = (await res.json()) as { jobs: ListRow[] };
  return { status: res.status, jobs: body.jobs };
}

interface ThreadRow {
  readonly jobId: string;
  readonly status: string;
  readonly writable: boolean;
  readonly seat: string;
  readonly [key: string]: unknown;
}

async function readThreads(rig: Rig, seat: 'buyer' | 'agent'): Promise<{ status: number; threads: ThreadRow[]; unreadTotal: number }> {
  const identity = seat === 'buyer' ? buyerIdentity : ownerIdentity;
  const did = seat === 'buyer' ? BUYER_DID : OWNER_DID;
  const res = await getSigned(rig, `/accounts/${did}/threads`, identity);
  const body = (await res.json()) as { threads: ThreadRow[]; unreadTotal: number };
  return { status: res.status, threads: body.threads, unreadTotal: body.unreadTotal };
}

async function readConduct(rig: Rig, login: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${rig.baseUrl}/buyers/${login}/conduct`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function silenceErrors(): { readonly lines: () => string[] } {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { lines: () => spy.mock.calls.map((args: unknown[]) => args.map(String).join(' ')) };
}

// What a thread row reads for a planted job nobody has written a message on.
function expectedThread(job: Job, seat: 'buyer' | 'agent', status: string, writable: boolean): Record<string, unknown> {
  return {
    jobId: job.id,
    status,
    writable,
    seat,
    brief: 'Fix the login bug',
    createdAt: job.createdAt.toISOString(),
    agentDid: job.agentDid,
    agentName: 'scout',
    avatarSpec: resolveAvatar(null, job.agentDid),
    counterpartDid: seat === 'buyer' ? OWNER_DID : BUYER_DID,
    counterpartGithubLogin: seat === 'buyer' ? OWNER_LOGIN : BUYER_LOGIN,
    lastActivityAt: job.createdAt.toISOString(),
    lastMessage: null,
    // The agent seat has never read the thread, so the brief counts as one.
    unreadCount: seat === 'agent' ? 1 : 0,
  };
}

describe('(a) the buyer job list runs the clocks', () => {
  it('reads a submitted job 8 days old as deemed_completed, a staged job 9 days old unpaid as closed_unpaid and a confirmed job 31 days old as expired_unstaged', async () => {
    const rig = await boot();
    const now = new Date();
    await plantSubmitted(rig, 'j-clk-a-submitted', 8, now, 7);
    await plantStaged(rig, 'j-clk-a-staged', 9, now);
    await plantConfirmed(rig, 'j-clk-a-confirmed', 31, now);

    const before = Date.now();
    const { status, jobs } = await readJobList(rig);
    const after = Date.now();

    expect(status).toBe(200);
    // The deemed row's date is the instant the clock deemed it, which is
    // this read; every other lapsed status carries no date of its own.
    const deemed = jobs.find((j) => j.id === 'j-clk-a-submitted');
    const expected = (id: string, status: JobStatus, date: string | null): ListRow => ({
      id,
      brief: 'Fix the login bug',
      agentName: 'scout',
      repository: REPOSITORY,
      status,
      bucket: jobListBucketOf(status),
      date,
    });
    expect([...jobs].sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      expected('j-clk-a-confirmed', 'expired_unstaged', null),
      expected('j-clk-a-staged', 'closed_unpaid', null),
      expected('j-clk-a-submitted', 'deemed_completed', deemed?.date ?? null),
    ]);
    const deemedAt = Date.parse(deemed?.date ?? '');
    expect(deemedAt).toBeGreaterThanOrEqual(before);
    expect(deemedAt).toBeLessThanOrEqual(after);
  });
});

describe('(b) the thread list runs the clocks on both seats', () => {
  it('buyer seat: a submitted job 8 days old reads deemed_completed and not writable', async () => {
    const rig = await boot();
    const job = await plantSubmitted(rig, 'j-clk-b-buyer', 8, new Date(), 7);

    const { status, threads, unreadTotal } = await readThreads(rig, 'buyer');

    expect(status).toBe(200);
    expect(threads).toEqual([expectedThread(job, 'buyer', 'deemed_completed', false)]);
    expect(unreadTotal).toBe(0);
  });

  it('agent seat: a submitted job 8 days old reads deemed_completed and not writable', async () => {
    const rig = await boot();
    const job = await plantSubmitted(rig, 'j-clk-b-agent', 8, new Date(), 7);

    const { status, threads, unreadTotal } = await readThreads(rig, 'agent');

    expect(status).toBe(200);
    expect(threads).toEqual([expectedThread(job, 'agent', 'deemed_completed', false)]);
    expect(unreadTotal).toBe(1);
  });
});

describe('(c) the public conduct record runs the clocks', () => {
  it('read for the buyer login: a submitted job 8 days old counts under deemed and a staged job 9 days old unpaid under closedUnpaid', async () => {
    const rig = await boot();
    const now = new Date();
    await plantSubmitted(rig, 'j-clk-c-submitted', 8, now, 7);
    await plantStaged(rig, 'j-clk-c-staged', 9, now);

    const { status, body } = await readConduct(rig, BUYER_LOGIN);

    expect(status).toBe(200);
    expect(body).toEqual({
      githubLogin: BUYER_LOGIN,
      keyed: true,
      counts: {
        confirmed: 2,
        walkedAfterConfirm: 0,
        stagedDeclined: 0,
        closedUnpaid: 1,
        merged: 0,
        deemed: 1,
        closedUnmerged: 0,
        citedCloses: 0,
        redosRequested: 0,
        walkedAway: 1,
      },
      operatorCounts: { deliveredNeverPaid: 0, redosRefused: 0, walkedAfterDeposit: 0 },
    });
  });

  it('read for the agent owner login: operatorCounts count the unpaid staged job under deliveredNeverPaid and the confirmed job 31 days old under walkedAfterDeposit', async () => {
    const rig = await boot();
    const now = new Date();
    await plantStaged(rig, 'j-clk-c-op-staged', 9, now);
    await plantConfirmed(rig, 'j-clk-c-op-confirmed', 31, now);

    const { status, body } = await readConduct(rig, OWNER_LOGIN);

    expect(status).toBe(200);
    expect(body).toEqual({
      githubLogin: OWNER_LOGIN,
      keyed: true,
      counts: {
        confirmed: 0,
        walkedAfterConfirm: 0,
        stagedDeclined: 0,
        closedUnpaid: 0,
        merged: 0,
        deemed: 0,
        closedUnmerged: 0,
        citedCloses: 0,
        redosRequested: 0,
        walkedAway: 0,
      },
      operatorCounts: { deliveredNeverPaid: 1, redosRefused: 0, walkedAfterDeposit: 1 },
    });
  });
});

describe('(d) the deemed-completion credential is recorded by a list read', () => {
  it('exists in the credential store after the job list alone was read, and reading the list twice stores one', async () => {
    const rig = await boot();
    const job = await plantSubmitted(rig, 'j-clk-d', 8, new Date(), 7);
    expect(await rig.credentialRepo.findByDocumentId(job.id)).toBeNull();

    await readJobList(rig);
    const stored = await rig.credentialRepo.findByDocumentId(job.id);
    expect(stored?.type).toEqual(['VerifiableCredential', 'DeemedCompletionCredential']);
    expect((stored as DeemedCompletionCredential | null)?.credentialSubject.deemedCompletion).toEqual({
      stagedCommit: STAGED_COMMIT,
      noMerge: true,
      buyer: BUYER_DID,
    });

    await readJobList(rig);
    expect(await rig.credentialRepo.listBySubjectDid(AGENT_DID)).toHaveLength(1);
  });
});

describe('(e) the POST /jobs buyer-conduct threshold runs the clocks', () => {
  const hire = { agentDid: GATED_DID, repository: REPOSITORY, brief: 'A fresh job' };

  it('a submitted job past its window whose pull request merged inside it counts as the buyer\'s one merge, so the hire opens', async () => {
    const rig = await boot();
    const now = new Date();
    const job = await plantSubmitted(rig, 'j-clk-e-merged', 8, now, 7);
    mergeOnGithub(rig, job.id, 7, new Date((job.submittedAt as Date).getTime() + 3 * DAY_MS));

    const res = await postJob(rig, hire, buyerIdentity);

    expect(res.status).toBe(201);
    expect((await rig.jobRepo.findById(job.id))?.status).toBe('completed');
  });

  it('control: a job the clocks end as deemed_completed leaves the threshold answer unchanged (merged 0, the hire is refused)', async () => {
    const rig = await boot();
    await plantSubmitted(rig, 'j-clk-e-deemed', 8, new Date(), 7);

    const res = await postJob(rig, hire, buyerIdentity);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'this agent requires minBuyerMerges of at least 1; your account has 0' });
  });
});

describe('(f) one job whose live check cannot be answered does not take the list down', () => {
  it('the job list answers 200, the job keeps its stored status, every other job is clocked, and the kept row is logged', async () => {
    const rig = await boot();
    const logged = silenceErrors();
    const now = new Date();
    await plantSubmitted(rig, 'j-clk-f-broken', 8, now, 7);
    await plantSubmitted(rig, 'j-clk-f-fine', 8, now, 8);
    await plantStaged(rig, 'j-clk-f-staged', 9, now);
    rig.failingPullRequests.add(7);

    const { status, jobs } = await readJobList(rig);

    expect(status).toBe(200);
    expect(Object.fromEntries(jobs.map((j) => [j.id, j.status]))).toEqual({
      'j-clk-f-broken': 'submitted',
      'j-clk-f-fine': 'deemed_completed',
      'j-clk-f-staged': 'closed_unpaid',
    });
    expect((await rig.jobRepo.findById('j-clk-f-broken'))?.status).toBe('submitted');
    expect(await rig.credentialRepo.findByDocumentId('j-clk-f-broken')).toBeNull();
    const keptLines = logged
      .lines()
      .filter((line: string) => line.includes('j-clk-f-broken') && line.includes('GET /accounts/:did/jobs'));
    expect(keptLines).toHaveLength(1);
  });

  it('the thread list and the conduct record answer 200 the same way', async () => {
    const rig = await boot();
    silenceErrors();
    const now = new Date();
    await plantSubmitted(rig, 'j-clk-f2-broken', 8, now, 7);
    await plantSubmitted(rig, 'j-clk-f2-fine', 8, now, 8);
    rig.failingPullRequests.add(7);

    const threads = await readThreads(rig, 'buyer');
    expect(threads.status).toBe(200);
    expect(Object.fromEntries(threads.threads.map((t) => [t.jobId, t.status]))).toEqual({
      'j-clk-f2-broken': 'submitted',
      'j-clk-f2-fine': 'deemed_completed',
    });

    const conduct = await readConduct(rig, BUYER_LOGIN);
    expect(conduct.status).toBe(200);
    expect((conduct.body.counts as { deemed: number }).deemed).toBe(1);
  });
});

describe('(g) a job not past any deadline reads its stored status on every one of these reads', () => {
  it('a submitted, a staged and a confirmed job one day old read as stored, and GitHub is never asked', async () => {
    const rig = await boot();
    const now = new Date();
    await plantSubmitted(rig, 'j-clk-g-submitted', 1, now, 7);
    await plantStaged(rig, 'j-clk-g-staged', 1, now);
    await plantConfirmed(rig, 'j-clk-g-confirmed', 1, now);
    const stored = { 'j-clk-g-confirmed': 'confirmed', 'j-clk-g-staged': 'staged', 'j-clk-g-submitted': 'submitted' };

    const list = await readJobList(rig);
    expect(Object.fromEntries(list.jobs.map((j) => [j.id, j.status]))).toEqual(stored);
    for (const seat of ['buyer', 'agent'] as const) {
      const threads = await readThreads(rig, seat);
      expect(Object.fromEntries(threads.threads.map((t) => [t.jobId, t.status]))).toEqual(stored);
    }
    const buyerConduct = await readConduct(rig, BUYER_LOGIN);
    expect(buyerConduct.body.counts).toEqual({
      confirmed: 3,
      walkedAfterConfirm: 0,
      stagedDeclined: 0,
      closedUnpaid: 0,
      merged: 0,
      deemed: 0,
      closedUnmerged: 0,
      citedCloses: 0,
      redosRequested: 0,
      walkedAway: 0,
    });
    const ownerConduct = await readConduct(rig, OWNER_LOGIN);
    expect(ownerConduct.body.operatorCounts).toEqual({ deliveredNeverPaid: 0, redosRefused: 0, walkedAfterDeposit: 0 });
    expect(rig.fixture.calls.getPullRequest).toEqual([]);
    expect(await rig.credentialRepo.findByDocumentId('j-clk-g-submitted')).toBeNull();
  });
});

// The same helper tests/api/job-deem-asks-github.test.ts uses: a stranger
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

describe('(h) invariant 2: the deemed-completion credential a list read issues verifies without this service', () => {
  it('verifies with the W3C stack alone, and a tampered copy fails', async () => {
    const issuerSeed = crypto.getRandomValues(new Uint8Array(32));
    const issuerKey = await generateKey(issuerSeed);
    const rig = await boot({ did: issuerKey.controller, seed: issuerSeed });
    const job = await plantSubmitted(rig, 'j-clk-h', 8, new Date(), 7);

    await readJobList(rig);
    const stored = await rig.credentialRepo.findByDocumentId(job.id);
    const credential = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;

    expect(credential.type).toEqual(['VerifiableCredential', 'DeemedCompletionCredential']);
    expect(credential.issuer).toBe(issuerKey.controller);
    expect(await verifyIndependent(credential)).toBe(true);

    const tampered = JSON.parse(JSON.stringify(credential)) as Record<string, unknown>;
    const deemed = (tampered.credentialSubject as Record<string, Record<string, unknown>>).deemedCompletion as Record<string, unknown>;
    deemed.stagedCommit = 'some-other-commit';
    expect(await verifyIndependent(tampered)).toBe(false);
  });
});
