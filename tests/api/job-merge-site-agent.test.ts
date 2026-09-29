// FIX-SW12b (SW1-05): an agent listed from the site completes its hire at
// merge. A site agent is listed with POST /agents and no delegation, so the
// platform derives its DID and holds its key, and the agent never signs a
// request. The merge (POST /jobs/:jobId/merge) and the deem path
// (GET /jobs/:jobId after the window) name the agent's key on the credential
// before anything is written; resolveDid only knows keys observed on a
// signed request, so a site agent answered 503 at every merge. The
// credential now names the key the platform re-derives for that agent, the
// same one github-proof/start re-derives.
//
// Every case runs over real HTTP against createApp with the real identity
// adapter and the real credentials adapter (only github is a fake). The
// agent is listed through the real site path, the job is planted as a
// submitted row, and the buyer merges with a signed request.
import type { Server } from 'node:http';

import { fromPublicKey } from '@arcblock/did';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import * as vc from '@digitalbazaar/vc';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';
import { createKnownKeyStore } from '../../src/adapters/identity/did-abt-resolver.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import type { IdentityAdapter } from '../../src/adapters/identity/types.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
  MemoryMessageRepository,
} from '../../src/adapters/storage/memory.js';
import { createJob, type Job } from '../../src/domain/job.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { mintSessionToken, testSessionAdapter } from '../helpers/session-fixtures.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import {
  createStagingLifecycleGithubFake,
  registerAgentForkPullRequest,
  type StagingLifecycleFixture,
} from '../helpers/github-staging-fixtures.js';

const DAY_MS = 86_400_000;
const SESSION_LOGIN = 'test-session-user';
const PR_NUMBER = 9;
const MERGE_SHA = 'site-agent-merge-commit-sha';
const REPOSITORY = 'buyer/target-repo';
const PR_URL = `https://github.com/${REPOSITORY}/pull/${PR_NUMBER}`;
const PR_REF = { owner: 'buyer', repo: 'target-repo', number: PR_NUMBER };
const IDENTITY_UNAVAILABLE = { error: 'identity resolution unavailable' };

const buyerIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(161));
const walletAgentIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(162));
const strangerIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(163));

const ORIGINAL_SEED = process.env.FREEAGENTS_PLATFORM_SEED;
let seedCounter = 0;
const servers: Server[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) server.close();
});

afterAll(() => {
  if (ORIGINAL_SEED === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
  else process.env.FREEAGENTS_PLATFORM_SEED = ORIGINAL_SEED;
});

interface Rig {
  readonly baseUrl: string;
  readonly agentRepo: MemoryAgentRepository;
  readonly jobRepo: MemoryJobRepository;
  readonly credentialRepo: MemoryCredentialRepository;
  readonly fixture: StagingLifecycleFixture;
  readonly sessionToken: string;
}

// identity undefined is the production wiring: createApp builds the real
// adapter over the same known-key store its request-signature resolver
// writes to. Each boot takes a fresh platform seed so two rigs never derive
// the same agent DID.
async function boot(identity?: IdentityAdapter): Promise<Rig> {
  seedCounter += 1;
  process.env.FREEAGENTS_PLATFORM_SEED = `5b12${seedCounter}`.padEnd(64, '0');
  const fixture = createStagingLifecycleGithubFake();
  const sessionAdapter = testSessionAdapter();
  const agentRepo = new MemoryAgentRepository();
  const accounts = new MemoryAccountRepository();
  await accounts.register({ did: buyerIdentity.did, githubLogin: 'buyer-site-agent' });
  const jobRepo = new MemoryJobRepository();
  const credentialRepo = new MemoryCredentialRepository();
  const credentials = createCredentialsAdapter(
    { did: 'did:abt:test-platform-issuer', seed: new Uint8Array(32).fill(7) },
    credentialRepo,
  );
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
    sessionAdapter,
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
  const sessionToken = await mintSessionToken(sessionAdapter);
  return { baseUrl: `http://127.0.0.1:${address.port}`, agentRepo, jobRepo, credentialRepo, fixture, sessionToken };
}

interface ListedAgent {
  readonly did: string;
  readonly operatorDid: string;
  readonly credentialId: string;
}

// The real site path: a session, no did, no delegation.
async function listSiteAgent(rig: Rig): Promise<ListedAgent> {
  const res = await fetch(`${rig.baseUrl}/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: ['Bearer', rig.sessionToken].join(' ') },
    body: JSON.stringify({ name: 'site-scout', skills: ['triage'], githubLogin: SESSION_LOGIN }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { did: string; operatorDid: string; delegation: { id: string } };
  return { did: body.did, operatorDid: body.operatorDid, credentialId: body.delegation.id };
}

// What a stranger, or the test, computes for the agent's own verification
// method from the same three inputs the listing used.
async function expectedSignedBy(agent: ListedAgent): Promise<string> {
  const derived = await createIdentityAdapter(createKnownKeyStore()).createAgentDid(agent.operatorDid, agent.credentialId);
  expect(derived.did).toBe(agent.did);
  return `${agent.did}#${derived.publicKeyMultibase}`;
}

// A submitted row (the shape tests/api/job-deem-asks-github.test.ts plants)
// with its pull request registered on the fixture at the attested commit.
async function plant(rig: Rig, id: string, agentDid: string, agentLogin: string, daysAgo: number): Promise<Job> {
  const submittedAt = new Date(Date.now() - daysAgo * DAY_MS);
  const job: Job = {
    ...createJob(
      { id, buyerDid: buyerIdentity.did, agentDid, repository: REPOSITORY, brief: 'Fix the login bug' },
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
    repository: REPOSITORY,
    jobId: id,
    stagedCommit: 'commit-sha-1',
    agentLogin,
    number: PR_NUMBER,
  });
  return job;
}

function scriptMerged(rig: Rig, jobId: string, agentLogin: string, mergedAt: Date): void {
  rig.fixture.setPullRequest(PR_REF, {
    state: 'merged',
    mergeCommitSha: MERGE_SHA,
    mergedAt,
    headSha: 'commit-sha-1',
    additions: 412,
    deletions: 87,
    filesChanged: 9,
    repositoryPublic: true,
    headRepoOwner: agentLogin,
    headRepoFullName: `${agentLogin}/target-repo`,
    headRepoIsFork: true,
    baseRepoFullName: REPOSITORY,
    authorLogin: agentLogin,
    body: `Job: ${jobId}\n`,
  });
}

async function mergeAsBuyer(rig: Rig, jobId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const bodyText = JSON.stringify({});
  const targetUri = `${rig.baseUrl}/jobs/${jobId}/merge`;
  const signed = signRequest(buyerIdentity as SigningIdentity, 'POST', targetUri, { body: bodyText });
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

function signedByOf(credential: VerifiableCredential): unknown {
  return (credential.credentialSubject as unknown as { hire: { signedBy: unknown } }).hire.signedBy;
}

// Invariant 2: the credential alone, checked with the off-the-shelf W3C
// stack and a static loader built from the credential's own proof, the way
// tests/api/job-merge-invariant2.test.ts does it. No call to this service.
async function verifyIndependent(credential: Record<string, unknown>): Promise<boolean> {
  try {
    const proof = credential.proof as Record<string, unknown>;
    const verificationMethod = String(proof.verificationMethod);
    const issuer = String(credential.issuer);
    const fingerprint = verificationMethod.slice(verificationMethod.indexOf('#') + 1);
    const key = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint });
    const raw = (key as unknown as { _publicKeyBuffer: Uint8Array })._publicKeyBuffer;
    if (fromPublicKey(raw) !== issuer.replace(/^did:abt:/, '')) return false;
    key.controller = issuer;
    key.id = verificationMethod;
    const loader = securityLoader();
    loader.addStatic(key.id, { '@context': 'https://w3id.org/security/suites/ed25519-2020/v1', ...key.export({ publicKey: true }) });
    loader.addStatic(issuer, {
      '@context': 'https://www.w3.org/ns/did/v1',
      id: issuer,
      assertionMethod: [key.id],
      verificationMethod: [{ '@context': 'https://w3id.org/security/suites/ed25519-2020/v1', ...key.export({ publicKey: true }) }],
    });
    const result = await vc.verifyCredential({ credential, suite: new Ed25519Signature2020(), documentLoader: loader.build() });
    return result.verified === true;
  } catch {
    return false;
  }
}

// The key a stranger reads off the credential's signedBy fragment: its
// public half must derive the agent's own DID.
async function fragmentDerivesDid(signedBy: string, agentDid: string): Promise<boolean> {
  const fragment = signedBy.slice(signedBy.indexOf('#') + 1);
  const key = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint: fragment });
  const raw = (key as unknown as { _publicKeyBuffer: Uint8Array })._publicKeyBuffer;
  return `did:abt:${fromPublicKey(raw)}` === agentDid;
}

async function expectNothingIssued(rig: Rig, jobId: string): Promise<void> {
  expect((await rig.jobRepo.findById(jobId))?.status).toBe('submitted');
  expect(await rig.credentialRepo.findByDocumentId(jobId)).toBeNull();
}

describe('a site-listed agent completes its hire at merge (SW1-05)', () => {
  it('(a) POST /jobs/:jobId/merge answers 200 completed, signedBy is the agent\'s own key, a stranger verifies it and a tampered copy fails', async () => {
    const rig = await boot();
    const agent = await listSiteAgent(rig);
    const job = await plant(rig, 'j-site-a', agent.did, SESSION_LOGIN, 1);
    scriptMerged(rig, job.id, SESSION_LOGIN, new Date());

    const { status, body } = await mergeAsBuyer(rig, job.id);

    expect(status).toBe(200);
    expect(body.status).toBe('completed');
    const credential = body.credential as VerifiableCredential;
    const signedBy = await expectedSignedBy(agent);
    expect(signedByOf(credential)).toBe(signedBy);
    expect(await fragmentDerivesDid(signedBy, agent.did)).toBe(true);
    expect(await verifyIndependent(credential as unknown as Record<string, unknown>)).toBe(true);
    const tampered = {
      ...credential,
      credentialSubject: {
        ...credential.credentialSubject,
        hire: { ...(credential.credentialSubject as unknown as { hire: object }).hire, signedBy: `${agent.did}#z6Mk-not-the-agents-key` },
      },
    };
    expect(await verifyIndependent(tampered as unknown as Record<string, unknown>)).toBe(false);
    expect((await rig.jobRepo.findById(job.id))?.status).toBe('completed');
    expect(await rig.credentialRepo.findByDocumentId(job.id)).toEqual(credential);
  });

  it('(b) the deem path: a merge inside the window, read with GET /jobs/:jobId after it, answers the completed job with the same signedBy', async () => {
    const rig = await boot();
    const agent = await listSiteAgent(rig);
    const job = await plant(rig, 'j-site-b', agent.did, SESSION_LOGIN, 8);
    scriptMerged(rig, job.id, SESSION_LOGIN, new Date((job.submittedAt as Date).getTime() + 3 * DAY_MS));

    const res = await fetch(`${rig.baseUrl}/jobs/${job.id}`);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.status).toBe('completed');
    expect(signedByOf(body.credential as VerifiableCredential)).toBe(await expectedSignedBy(agent));
    expect((await rig.jobRepo.findById(job.id))?.status).toBe('completed');
  });

  it('(c) a wallet-path agent that never signed a request answers 503 identity resolution unavailable, stays submitted, has no credential', async () => {
    silenceErrors();
    const rig = await boot();
    await rig.agentRepo.create({
      did: walletAgentIdentity.did,
      operatorDid: 'did:abt:op-wallet-c',
      delegation: { id: 'urn:uuid:wallet-c', fixture: true } as never,
      name: 'wallet-scout',
      skills: ['triage'],
      githubLogin: 'wallet-scout',
      negotiatesOnOwnersBehalf: true,
    });
    await rig.agentRepo.updateGithubBinding(walletAgentIdentity.did, { handle: 'wallet-scout', status: 'verified' });
    const job = await plant(rig, 'j-site-c', walletAgentIdentity.did, 'wallet-scout', 1);
    scriptMerged(rig, job.id, 'wallet-scout', new Date());

    const { status, body } = await mergeAsBuyer(rig, job.id);

    expect(status).toBe(503);
    expect(body).toEqual(IDENTITY_UNAVAILABLE);
    await expectNothingIssued(rig, job.id);
  });

  it('(d) with the platform seed unset at merge time, a site agent\'s merge answers 503 identity resolution unavailable, stays submitted, has no credential', async () => {
    silenceErrors();
    const rig = await boot();
    const agent = await listSiteAgent(rig);
    const job = await plant(rig, 'j-site-d', agent.did, SESSION_LOGIN, 1);
    scriptMerged(rig, job.id, SESSION_LOGIN, new Date());
    delete process.env.FREEAGENTS_PLATFORM_SEED;

    const { status, body } = await mergeAsBuyer(rig, job.id);

    expect(status).toBe(503);
    expect(body).toEqual(IDENTITY_UNAVAILABLE);
    await expectNothingIssued(rig, job.id);
  });

  it('(e) no agent row for the job\'s agentDid: 503 identity resolution unavailable, stays submitted, nothing issued', async () => {
    silenceErrors();
    const rig = await boot();
    const job = await plant(rig, 'j-site-e', strangerIdentity.did, 'ghost-scout', 1);
    scriptMerged(rig, job.id, 'ghost-scout', new Date());

    const { status, body } = await mergeAsBuyer(rig, job.id);

    expect(status).toBe(503);
    expect(body).toEqual(IDENTITY_UNAVAILABLE);
    await expectNothingIssued(rig, job.id);
  });

  it('(f) a site agent whose resolveDid rejects with a plain Error (an outage, not a missing key): 503 identity resolution unavailable, stays submitted, nothing issued', async () => {
    silenceErrors();
    const outage: IdentityAdapter = {
      ...createIdentityAdapter(createKnownKeyStore()),
      resolveDid: () => Promise.reject(new Error('resolver unreachable')),
    };
    const rig = await boot(outage);
    const agent = await listSiteAgent(rig);
    const job = await plant(rig, 'j-site-f', agent.did, SESSION_LOGIN, 1);
    scriptMerged(rig, job.id, SESSION_LOGIN, new Date());

    const { status, body } = await mergeAsBuyer(rig, job.id);

    expect(status).toBe(503);
    expect(body).toEqual(IDENTITY_UNAVAILABLE);
    await expectNothingIssued(rig, job.id);
  });
});

function silenceErrors(): void {
  vi.spyOn(console, 'error').mockImplementation(() => {});
}
