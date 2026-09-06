// P5: the stage route publishes an attestation, and the read route serves
// it party-gated. Every assertion here fails without: the stage route
// generating, signing and storing the attestation before the job persists
// as staged; the default refusing observer failing the whole stage; and
// GET /jobs/:jobId/attestation refusing a stranger.
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { anyCommitStagingObserver, fixedStagingObserverFor } from '../helpers/staging-fixtures.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import { createUnwiredStagingObserver } from '../../src/adapters/staging/types.js';
import {
  MemoryAgentRepository,
  MemoryAccountRepository,
  MemoryJobRepository,
  MemoryAttestationRepository,
  MemoryCredentialRepository,
} from '../../src/adapters/storage/memory.js';
import type { CredentialsAdapter } from '../../src/adapters/credentials/types.js';

const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(201));
const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(202));
const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(203));

const proposal = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
];

async function postSigned(baseUrl: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${baseUrl}${path}`;
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

async function getSigned(baseUrl: string, path: string, identity: SigningIdentity): Promise<Response> {
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, 'GET', targetUri, {});
  return fetch(targetUri, {
    headers: {
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
  });
}

interface Started {
  readonly server: Server;
  readonly baseUrl: string;
  readonly jobRepo: MemoryJobRepository;
  readonly attestationRepo: MemoryAttestationRepository;
}

async function startApp(options: {
  readonly stagingObserver?: ReturnType<typeof createUnwiredStagingObserver>;
  readonly credentials?: CredentialsAdapter;
} = {}): Promise<Started> {
  const operatorRepo = new MemoryAccountRepository();
  await operatorRepo.register({ did: buyer.did, githubLogin: `buyer-att-${Math.random()}` });
  // The stranger IS a registered account (a real DID this process can
  // verify a signature against), just not a party to any job this file
  // stages -- that is what pins the 403 leg. An unregistered DID's
  // signature cannot be resolved at all and 401s before this route's own
  // party check ever runs, which is a different leg (didSignature's own
  // "invalid signature" branch), not the one this describe block tests.
  await operatorRepo.register({ did: stranger.did, githubLogin: `stranger-att-${Math.random()}` });
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: agent.did,
    operatorDid: 'did:abt:op-attestation',
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: 'scout-attestation',
  });
  await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-attestation', status: 'verified' });
  const jobRepo = new MemoryJobRepository();
  const attestationRepo = new MemoryAttestationRepository();
  const credentialRepo = new MemoryCredentialRepository();
  const credentials = options.credentials ?? createCredentialsAdapter(undefined, credentialRepo);
  const { github } = createStagingLifecycleGithubFake();
  const app = createApp(
    operatorRepo,
    agentRepo,
    undefined,
    github,
    jobRepo,
    credentials,
    undefined,
    credentialRepo,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    alwaysSettledGate(),
    options.stagingObserver ?? createUnwiredStagingObserver(),
    attestationRepo,
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, jobRepo, attestationRepo };
}

async function walkToConfirmed(baseUrl: string): Promise<string> {
  const created = await postSigned(baseUrl, '/jobs', {
    buyerDid: buyer.did,
    agentDid: agent.did,
    repository: 'buyer/target-repo',
    brief: 'Fix the login bug',
  }, buyer);
  const jobId = String(((await created.json()) as Record<string, unknown>).id);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria`, { criteria: proposal, priceUsd: '500.00', rail: 'abt' }, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
  return jobId;
}

let active: Started | null = null;
afterEach(async () => {
  if (active !== null) {
    await new Promise<void>((resolve) => active!.server.close(() => resolve()));
    active = null;
  }
});

describe('the default (unwired) staging observer refuses, and the stage fails loudly', () => {
  it('503s the stage, leaves the job confirmed, and stores no attestation', async () => {
    active = await startApp();
    const jobId = await walkToConfirmed(active.baseUrl);

    const stage = await postSigned(active.baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-1' }, agent);
    expect(stage.status).toBe(503);

    const stored = await active.jobRepo.findById(jobId);
    expect(stored?.status).toBe('confirmed');
    expect(stored?.stagedCommit).toBeNull();
    expect(await active.attestationRepo.findByJobId(jobId)).toBeNull();
  });
});

describe('a wired staging observer publishes the attestation before the job reaches staged', () => {
  it('200s the stage, moves the job to staged, and stores the attestation', async () => {
    const stagedCommit = 'commit-real-1';
    active = await startApp({ stagingObserver: fixedStagingObserverFor(stagedCommit) });
    const jobId = await walkToConfirmed(active.baseUrl);

    const stage = await postSigned(active.baseUrl, `/jobs/${jobId}/stage`, { stagedCommit }, agent);
    expect(stage.status).toBe(200);
    const body = (await stage.json()) as Record<string, unknown>;
    expect(body.status).toBe('staged');

    const stored = await active.jobRepo.findById(jobId);
    expect(stored?.status).toBe('staged');
    const attestation = await active.attestationRepo.findByJobId(jobId);
    expect(attestation).not.toBeNull();
    expect(attestation?.attestation.stagedCommit).toBe(stagedCommit);
  });

  it('every accepted field survives the round trip through storage, read back over the wire', async () => {
    const stagedCommit = 'commit-real-2';
    active = await startApp({ stagingObserver: fixedStagingObserverFor(stagedCommit) });
    const jobId = await walkToConfirmed(active.baseUrl);
    await postSigned(active.baseUrl, `/jobs/${jobId}/stage`, { stagedCommit }, agent);

    const read = await getSigned(active.baseUrl, `/jobs/${jobId}/attestation`, buyer);
    expect(read.status).toBe(200);
    const wire = (await read.json()) as Record<string, unknown>;
    const subject = wire.credentialSubject as Record<string, unknown>;
    const attestation = subject.attestation as Record<string, unknown>;
    expect(attestation.stagedCommit).toBe(stagedCommit);
    expect(attestation.diffHash).toBeDefined();
    expect(attestation.filesChanged).toBeDefined();
    expect(attestation.linesAdded).toBeDefined();
    expect(attestation.linesRemoved).toBeDefined();
    expect(attestation.changedPaths).toBeDefined();
    expect(attestation.lineShareByCategory).toBeDefined();
    expect(attestation.testsDeleted).toBeDefined();
    expect(attestation.testsSkipAdded).toBeDefined();
    expect(attestation.buyerTestRun).toBeDefined();
    expect(attestation.outOfCriteriaPathCount).toBeDefined();
    expect(attestation.commitSigners).toBeDefined();
  });

  it('a second stage attempt on the same job (already staged) is refused before a second attestation is built', async () => {
    const stagedCommit = 'commit-real-3';
    active = await startApp({ stagingObserver: fixedStagingObserverFor(stagedCommit) });
    const jobId = await walkToConfirmed(active.baseUrl);
    const first = await postSigned(active.baseUrl, `/jobs/${jobId}/stage`, { stagedCommit }, agent);
    expect(first.status).toBe(200);

    const second = await postSigned(active.baseUrl, `/jobs/${jobId}/stage`, { stagedCommit }, agent);
    expect(second.status).toBe(409);
  });
});

describe('GET /jobs/:jobId/attestation: party-gated, the document the buyer pays against', () => {
  async function stagedJob(): Promise<{ started: Started; jobId: string }> {
    const stagedCommit = 'commit-party-1';
    const started = await startApp({ stagingObserver: fixedStagingObserverFor(stagedCommit) });
    const jobId = await walkToConfirmed(started.baseUrl);
    await postSigned(started.baseUrl, `/jobs/${jobId}/stage`, { stagedCommit }, agent);
    return { started, jobId };
  }

  it('the buyer reads it', async () => {
    const { started, jobId } = await stagedJob();
    active = started;
    const res = await getSigned(started.baseUrl, `/jobs/${jobId}/attestation`, buyer);
    expect(res.status).toBe(200);
  });

  it('the agent reads it', async () => {
    const { started, jobId } = await stagedJob();
    active = started;
    const res = await getSigned(started.baseUrl, `/jobs/${jobId}/attestation`, agent);
    expect(res.status).toBe(200);
  });

  it('a stranger cannot read it: 403', async () => {
    const { started, jobId } = await stagedJob();
    active = started;
    const res = await getSigned(started.baseUrl, `/jobs/${jobId}/attestation`, stranger);
    expect(res.status).toBe(403);
  });

  it('an unsigned request is refused: 401', async () => {
    const { started, jobId } = await stagedJob();
    active = started;
    const res = await fetch(`${started.baseUrl}/jobs/${jobId}/attestation`);
    expect(res.status).toBe(401);
  });

  it('an unknown job is 404', async () => {
    active = await startApp();
    const res = await getSigned(active.baseUrl, '/jobs/never-existed/attestation', buyer);
    expect(res.status).toBe(404);
  });

  it('a confirmed job with no attestation yet is 404, not an empty document', async () => {
    active = await startApp();
    const jobId = await walkToConfirmed(active.baseUrl);
    const res = await getSigned(active.baseUrl, `/jobs/${jobId}/attestation`, buyer);
    expect(res.status).toBe(404);
  });
});

describe('attestation signing failure fails the whole stage (P5 anchor: staged means there is something to read)', () => {
  it('the stage 503s, the job stays confirmed, and nothing is stored when signing fails', async () => {
    const failingCredentials: CredentialsAdapter = {
      issueWorkHistoryCredential: () => Promise.reject(new Error('unused')),
      verifyCredential: () => Promise.reject(new Error('unused')),
      getCredential: () => Promise.reject(new Error('unused')),
      signAttestation: () => Promise.reject(new Error('signing key unavailable')),
      issueDeemedCompletionCredential: () => Promise.reject(new Error('unused')),
    };
    const stagedCommit = 'commit-sign-fail';
    active = await startApp({
      stagingObserver: fixedStagingObserverFor(stagedCommit),
      credentials: failingCredentials,
    });
    const jobId = await walkToConfirmed(active.baseUrl);

    const stage = await postSigned(active.baseUrl, `/jobs/${jobId}/stage`, { stagedCommit }, agent);
    expect(stage.status).toBe(503);

    const stored = await active.jobRepo.findById(jobId);
    expect(stored?.status).toBe('confirmed');
    expect(await active.attestationRepo.findByJobId(jobId)).toBeNull();
  });

  it('a job never reaches staged when attestation storage fails, even though the attestation was built and signed (the ordering the anchor requires)', async () => {
    const stagedCommit = 'commit-storage-fail';
    active = await startApp({ stagingObserver: fixedStagingObserverFor(stagedCommit) });
    const jobId = await walkToConfirmed(active.baseUrl);

    // Sabotage the attestation repository AFTER confirm/build succeeds but
    // before the stage route's own save call: a repository whose save
    // always throws proves storage failing closed independent of which
    // step failed.
    const originalSave = active.attestationRepo.save.bind(active.attestationRepo);
    active.attestationRepo.save = () => Promise.reject(new Error('attestation storage down'));

    const stage = await postSigned(active.baseUrl, `/jobs/${jobId}/stage`, { stagedCommit }, agent);
    expect(stage.status).toBe(503);

    const stored = await active.jobRepo.findById(jobId);
    expect(stored?.status).toBe('confirmed');
    expect(await active.attestationRepo.findByJobId(jobId)).toBeNull();

    active.attestationRepo.save = originalSave;
  });
});

// This card (t_767701e6, follow-up from the P6 audit at t_604e3f2a review
// round 4): storage already keeps every attestation row after a redo
// restages, but the only HTTP surface (GET /jobs/:jobId/attestation)
// served just the latest, so the pre-redo document was durable but
// buyer-unreachable through the platform. GET /jobs/:jobId/attestations
// is the fix; these tests exercise it as a ROUTE, not through the
// repository, which is exactly what the shipped pin
// (tests/api/job-redo.test.ts's "still readable after a redo restages"
// test) did not do.
describe('GET /jobs/:jobId/attestations: the full history, party-gated, reachable after a redo', () => {
  it('after a redo restages, a signed buyer request retrieves the sequence-1 document and its stagedCommit is the pre-redo commit', async () => {
    active = await startApp({ stagingObserver: anyCommitStagingObserver() });
    const jobId = await walkToConfirmed(active.baseUrl);
    expect((await postSigned(active.baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-sha-1' }, agent)).status).toBe(200);
    expect((await postSigned(active.baseUrl, `/jobs/${jobId}/redo`, { criterionIndex: 0 }, buyer)).status).toBe(200);
    expect((await postSigned(active.baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-sha-2' }, agent)).status).toBe(200);

    const res = await getSigned(active.baseUrl, `/jobs/${jobId}/attestations`, buyer);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attestations: Array<{ sequence: number; document: Record<string, unknown> }> };
    expect(body.attestations).toHaveLength(2);
    expect(body.attestations[0]?.sequence).toBe(1);
    const firstSubject = body.attestations[0]?.document.credentialSubject as Record<string, unknown>;
    const firstAttestation = firstSubject.attestation as Record<string, unknown>;
    expect(firstAttestation.stagedCommit).toBe('commit-sha-1');
    expect(body.attestations[1]?.sequence).toBe(2);
    const secondSubject = body.attestations[1]?.document.credentialSubject as Record<string, unknown>;
    const secondAttestation = secondSubject.attestation as Record<string, unknown>;
    expect(secondAttestation.stagedCommit).toBe('commit-sha-2');
  });

  it('the agent (the other party on the job) reads the full history too', async () => {
    active = await startApp({ stagingObserver: anyCommitStagingObserver() });
    const jobId = await walkToConfirmed(active.baseUrl);
    expect((await postSigned(active.baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-sha-1' }, agent)).status).toBe(200);
    expect((await postSigned(active.baseUrl, `/jobs/${jobId}/redo`, { criterionIndex: 0 }, buyer)).status).toBe(200);
    expect((await postSigned(active.baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-sha-2' }, agent)).status).toBe(200);

    const res = await getSigned(active.baseUrl, `/jobs/${jobId}/attestations`, agent);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attestations: Array<{ sequence: number }> };
    expect(body.attestations).toHaveLength(2);
  });

  it('a stranger is refused with 403 on the new surface', async () => {
    active = await startApp({ stagingObserver: fixedStagingObserverFor('commit-hist-stranger') });
    const jobId = await walkToConfirmed(active.baseUrl);
    await postSigned(active.baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-hist-stranger' }, agent);

    const res = await getSigned(active.baseUrl, `/jobs/${jobId}/attestations`, stranger);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'signature does not name a party to this job' });
  });

  it('an unsigned request is refused: 401', async () => {
    active = await startApp({ stagingObserver: fixedStagingObserverFor('commit-hist-unsigned') });
    const jobId = await walkToConfirmed(active.baseUrl);
    await postSigned(active.baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-hist-unsigned' }, agent);

    const res = await fetch(`${active.baseUrl}/jobs/${jobId}/attestations`);
    expect(res.status).toBe(401);
  });

  it('an unknown job is 404', async () => {
    active = await startApp();
    const res = await getSigned(active.baseUrl, '/jobs/never-existed/attestations', buyer);
    expect(res.status).toBe(404);
  });

  it('a confirmed job with no attestation yet returns an empty list, not 404', async () => {
    active = await startApp();
    const jobId = await walkToConfirmed(active.baseUrl);
    const res = await getSigned(active.baseUrl, `/jobs/${jobId}/attestations`, buyer);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ attestations: [] });
  });

  it('GET /jobs/:jobId/attestation (singular) still serves only the latest, unchanged, after a redo', async () => {
    active = await startApp({ stagingObserver: anyCommitStagingObserver() });
    const jobId = await walkToConfirmed(active.baseUrl);
    expect((await postSigned(active.baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-sha-1' }, agent)).status).toBe(200);
    expect((await postSigned(active.baseUrl, `/jobs/${jobId}/redo`, { criterionIndex: 0 }, buyer)).status).toBe(200);
    expect((await postSigned(active.baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-sha-2' }, agent)).status).toBe(200);

    const res = await getSigned(active.baseUrl, `/jobs/${jobId}/attestation`, buyer);
    expect(res.status).toBe(200);
    const wire = (await res.json()) as Record<string, unknown>;
    const subject = wire.credentialSubject as Record<string, unknown>;
    const attestation = subject.attestation as Record<string, unknown>;
    expect(attestation.stagedCommit).toBe('commit-sha-2');
  });
});
