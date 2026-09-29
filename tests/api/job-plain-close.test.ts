// FIX-B71 (bugs.md B71): a plain close on GitHub, with no cited reason, does
// not end a paid job. MISSION.md: "Completion is deemed if the buyer neither
// merges nor closes with a cited reason within the review window." The merge
// route used to record a closed, unmerged pull request as the terminal
// closed_unmerged, which stopped the deem clock and left the agent with no
// record for work the buyer paid for in full. Now a submitted job stays
// submitted, the window keeps running, and only a cited close stops it. A
// legacy `stale` row still records closed_unmerged (R-31).
//
// Every case runs over real HTTP against createApp with the shared github
// fake (its calls.getPullRequest counts the reads). Jobs are planted directly
// as rows with a submittedAt in the past, because the clocks read the stored
// timestamp.
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
import type { PullRequestRef } from '../../src/adapters/github/types.js';
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
const agentIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(161));
const buyerIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(162));
const AGENT_DID = agentIdentity.did;
const BUYER_DID = buyerIdentity.did;
const AGENT_GITHUB_LOGIN = 'scout-plain-close';
const PR_NUMBER = 9;
const MERGE_SHA = 'plain-close-merge-commit-sha';
const PR_URL = `https://github.com/buyer/target-repo/pull/${PR_NUMBER}`;
const PR_REF: PullRequestRef = { owner: 'buyer', repo: 'target-repo', number: PR_NUMBER };
const ISSUER_DID = 'did:abt:test-platform-issuer';
const ISSUER_SEED = new Uint8Array(32).fill(7);

// The route's own sentence: it names what a person can do next.
const CLOSED_409 =
  'the pull request is closed but not merged; the hire stays open until the review window ends, unless the buyer merges it or closes the hire with a cited reason';

interface Rig {
  readonly baseUrl: string;
  readonly jobRepo: MemoryJobRepository;
  readonly credentialRepo: MemoryCredentialRepository;
  readonly fixture: StagingLifecycleFixture;
}

const servers: Server[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) server.close();
});

async function boot(issuer: { did: string; seed: Uint8Array } = { did: ISSUER_DID, seed: ISSUER_SEED }): Promise<Rig> {
  const fixture = createStagingLifecycleGithubFake();
  // The completion path resolves the agent's DID; the planted DIDs have no
  // network document, so the resolver answers a minimal one.
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
    operatorDid: 'did:abt:op-plain-close',
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: AGENT_GITHUB_LOGIN,
    negotiatesOnOwnersBehalf: true,
  });
  await agentRepo.updateGithubBinding(AGENT_DID, { handle: AGENT_GITHUB_LOGIN, status: 'verified' });
  const accounts = new MemoryAccountRepository();
  await accounts.register({ did: BUYER_DID, githubLogin: 'buyer-plain-close' });
  const jobRepo = new MemoryJobRepository();
  const server = createApp(
    accounts,
    agentRepo,
    identity,
    fixture.github,
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
    new MemoryMessageRepository(),
  ).listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected server to listen on a port');
  return { baseUrl: `http://127.0.0.1:${address.port}`, jobRepo, credentialRepo, fixture };
}

// A submitted row (the shape tests/api/job-merge.test.ts plants) whose
// submittedAt is `daysAgo` days before now, with the pull request it names
// registered open on the fixture at the attested commit. `status: 'stale'`
// plants the legacy row the pre-P4 merge route could write.
async function plant(rig: Rig, id: string, daysAgo: number, status: 'submitted' | 'stale' = 'submitted'): Promise<Job> {
  const submittedAt = new Date(Date.now() - daysAgo * DAY_MS);
  const job: Job = {
    ...createJob(
      { id, buyerDid: BUYER_DID, agentDid: AGENT_DID, repository: 'buyer/target-repo', brief: 'Fix the login bug' },
      new Date(submittedAt.getTime() - DAY_MS),
    ),
    status,
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
  extra: { mergedAt?: Date | null } = {},
): void {
  rig.fixture.setPullRequest(PR_REF, {
    state,
    mergeCommitSha: state === 'merged' ? MERGE_SHA : null,
    mergedAt: state === 'merged' ? (extra.mergedAt ?? null) : null,
    headSha: 'commit-sha-1',
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

async function read(rig: Rig, jobId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${rig.baseUrl}/jobs/${jobId}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function postSigned(
  rig: Rig,
  path: string,
  identity: SigningIdentity,
  body: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const bodyText = JSON.stringify(body);
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

// The window has run out: the stored submittedAt moves back 8 days, which is
// what the clocks read.
async function runOutTheWindow(rig: Rig, jobId: string): Promise<void> {
  const row = await rig.jobRepo.findById(jobId);
  if (row === null) throw new Error('planted job vanished');
  await rig.jobRepo.update({ ...row, submittedAt: new Date(Date.now() - 8 * DAY_MS) });
}

async function noCredentialOfEitherType(rig: Rig, jobId: string): Promise<void> {
  expect(await rig.credentialRepo.findByDocumentId(jobId)).toBeNull();
}

describe('a plain close inside the window leaves the paid job submitted (a)', () => {
  it.each([
    ['the buyer', buyerIdentity],
    ['the agent', agentIdentity],
  ])('a signed merge call by %s on a closed, unmerged pull request answers 409 with the route\'s sentence and records nothing', async (_who, caller) => {
    const rig = await boot();
    const job = await plant(rig, 'j-plain-a', 2);
    script(rig, job.id, 'closed');
    const before = await read(rig, job.id);

    const { status, body } = await postSigned(rig, `/jobs/${job.id}/merge`, caller);

    expect(status).toBe(409);
    expect(body).toEqual({ error: CLOSED_409 });
    expect(rig.fixture.calls.getPullRequest).toEqual([PR_REF]);
    expect(await rig.jobRepo.findById(job.id)).toEqual(job);
    const after = await read(rig, job.id);
    expect(after.body.status).toBe('submitted');
    expect(after.body).toEqual(before.body);
    await noCredentialOfEitherType(rig, job.id);
  });
});

describe('after a plain close, reads inside the window make no GitHub call (b)', () => {
  it('GET /jobs/:jobId answers submitted and asks GitHub nothing', async () => {
    const rig = await boot();
    const job = await plant(rig, 'j-plain-b', 2);
    script(rig, job.id, 'closed');
    await postSigned(rig, `/jobs/${job.id}/merge`, buyerIdentity);
    expect(rig.fixture.calls.getPullRequest).toEqual([PR_REF]);

    const { status, body } = await read(rig, job.id);

    expect(status).toBe(200);
    expect(body.status).toBe('submitted');
    expect(rig.fixture.calls.getPullRequest).toEqual([PR_REF]);
  });
});

describe('the window runs out after a plain close (c)', () => {
  it('deems the job with the deemed-completion credential, after exactly one more GitHub read', async () => {
    const rig = await boot();
    const job = await plant(rig, 'j-plain-c', 2);
    script(rig, job.id, 'closed');
    await postSigned(rig, `/jobs/${job.id}/merge`, buyerIdentity);
    await runOutTheWindow(rig, job.id);

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
    expect(await rig.credentialRepo.findByDocumentId(job.id)).toEqual(credential);
    expect(rig.fixture.calls.getPullRequest).toEqual([PR_REF, PR_REF]);
  });
});

describe('a cited close still stops the credential after a plain close (d)', () => {
  it('answers 200 cited_closed, and when the window passes the job is still cited_closed with no credential', async () => {
    const rig = await boot();
    const job = await plant(rig, 'j-plain-d', 2);
    script(rig, job.id, 'closed');
    await postSigned(rig, `/jobs/${job.id}/merge`, buyerIdentity);

    const cited = await postSigned(rig, `/jobs/${job.id}/cited-close`, buyerIdentity, {
      criterionIndex: 0,
      reasonText: 'The login bug is not actually fixed.',
    });

    expect(cited.status).toBe(200);
    expect(cited.body.status).toBe('cited_closed');

    await runOutTheWindow(rig, job.id);
    const { status, body } = await read(rig, job.id);

    expect(status).toBe(200);
    expect(body.status).toBe('cited_closed');
    expect(body.credential).toBeUndefined();
    await noCredentialOfEitherType(rig, job.id);
    expect((await rig.jobRepo.findById(job.id))?.status).toBe('cited_closed');
  });
});

describe('a closed pull request reopened and merged inside the window completes the job (e)', () => {
  it('answers 409 on the close, then 200 completed with the work-history credential on the merge', async () => {
    const rig = await boot();
    const job = await plant(rig, 'j-plain-e', 5);
    script(rig, job.id, 'closed');

    const closed = await postSigned(rig, `/jobs/${job.id}/merge`, buyerIdentity);

    expect(closed.status).toBe(409);
    expect(closed.body).toEqual({ error: CLOSED_409 });
    expect((await rig.jobRepo.findById(job.id))?.status).toBe('submitted');

    const mergedAt = new Date(Date.now() - DAY_MS);
    script(rig, job.id, 'merged', { mergedAt });
    const merged = await postSigned(rig, `/jobs/${job.id}/merge`, buyerIdentity);

    expect(merged.status).toBe(200);
    expect(merged.body.status).toBe('completed');
    expect(merged.body.mergeCommit).toBe(MERGE_SHA);
    expect(merged.body.mergedAt).toBe(mergedAt.toISOString());
    const credential = merged.body.credential as VerifiableCredential;
    expect(isCompletedHireCredential(credential)).toBe(true);
    expect(credential.type).toEqual(['VerifiableCredential', 'CompletedHireCredential']);
    expect(rig.fixture.calls.getPullRequest).toEqual([PR_REF, PR_REF]);
  });
});

describe('a legacy stale row still records closed_unmerged (f, R-31)', () => {
  it('answers 200 closed_unmerged, and a second merge call answers 409 without asking GitHub', async () => {
    const rig = await boot();
    const job = await plant(rig, 'j-plain-f', 2, 'stale');
    script(rig, job.id, 'closed');

    const first = await postSigned(rig, `/jobs/${job.id}/merge`, buyerIdentity);

    expect(first.status).toBe(200);
    expect(first.body.status).toBe('closed_unmerged');
    expect('mergeCommit' in first.body).toBe(false);
    expect('mergedAt' in first.body).toBe(false);
    expect((await rig.jobRepo.findById(job.id))?.status).toBe('closed_unmerged');
    expect(rig.fixture.calls.getPullRequest).toEqual([PR_REF]);

    const second = await postSigned(rig, `/jobs/${job.id}/merge`, buyerIdentity);

    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: 'cannot merge a job in status "closed_unmerged"' });
    expect(rig.fixture.calls.getPullRequest).toEqual([PR_REF]);
  });
});

// The same helper tests/adapters/credentials/deemed-completion-invariant2.test.ts
// uses: a stranger holding only the credential JSON, checked with the
// off-the-shelf W3C stack.
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
        { '@context': 'https://w3id.org/security/suites/ed25519-2020/v1', ...key.export({ publicKey: true }) },
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

describe('invariant 2: the deemed-completion credential after a plain close verifies without this service (g)', () => {
  it('verifies with the W3C stack alone, and a tampered copy fails', async () => {
    const issuerSeed = crypto.getRandomValues(new Uint8Array(32));
    const issuerKey = await generateKey(issuerSeed);
    const rig = await boot({ did: issuerKey.controller, seed: issuerSeed });
    const job = await plant(rig, 'j-plain-g', 2);
    script(rig, job.id, 'closed');
    await postSigned(rig, `/jobs/${job.id}/merge`, buyerIdentity);
    await runOutTheWindow(rig, job.id);

    const { body } = await read(rig, job.id);
    const credential = body.credential as unknown as Record<string, unknown>;

    expect(body.status).toBe('deemed_completed');
    expect(credential.type).toEqual(['VerifiableCredential', 'DeemedCompletionCredential']);
    expect(credential.issuer).toBe(issuerKey.controller);
    expect(await verifyIndependent(credential)).toBe(true);

    const tampered = JSON.parse(JSON.stringify(credential)) as Record<string, unknown>;
    const subject = tampered.credentialSubject as Record<string, Record<string, unknown>>;
    subject.deemedCompletion = { ...subject.deemedCompletion, noMerge: false };
    expect(await verifyIndependent(tampered)).toBe(false);
  });
});
