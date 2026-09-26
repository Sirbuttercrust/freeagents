// HT1 Part B (Proof r1, defect 9; Proof r2, defect 2): a route-level
// invariant-3 test. The prior test (tests/domain/message-invariant3.test.ts)
// built Message objects that were never wired into any function confirmSpec
// could reach, so it could not fail no matter what leaked. This drives TWO
// twin jobs through the real HTTP routes (identical criteria, identical
// price, and now the SAME buyer/agent/operator identities on both twins),
// one carrying a real thread of messages, reactions, edits and an uploaded
// attachment, the other with an empty thread, and compares the CONFIRMED
// SPEC HASH, the signed attestation and the issued credential against each
// other after normalizing away exactly the fields that legitimately differ
// between two distinct jobs: the resolution id (rooted at the job id or the
// staged commit), every timestamp, the staged commit itself, the merge
// commit, and the platform's own signature (a distinct id/timestamp/staged
// commit makes the signed bytes distinct too, so the signature itself is a
// legitimately-differing field, not a leak). Using shared identities across
// both twins (Proof r2 fix) means signedBy, buyer and issuer are no longer
// separately excluded as "different agents" -- they are asserted equal
// because they must be, closing the gap the prior version papered over.
//
// Manual mutation check performed while writing this test (not shipped):
// temporarily made POST /jobs/:jobId/confirm append the thread's own
// message COUNT onto confirmedSpecHash after confirmSpec computed it.
// Both assertions below (the specHash comparison and the credential's
// specHash comparison) went red immediately, each naming the two
// different hash values, then passed again once the mutation was
// reverted -- proving this test is sensitive to exactly the leak class
// invariant 3 forbids, not vacuous.
import type { Server } from 'node:http';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import {
  MemoryAgentRepository,
  MemoryJobRepository,
  MemoryAccountRepository,
  MemoryCredentialRepository,
  MemoryAttestationRepository,
  MemoryMessageRepository,
  MemoryAttachmentRepository,
} from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { testSessionAdapter } from '../helpers/session-fixtures.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import {
  createStagingLifecycleGithubFake,
  registerAgentForkPullRequest,
  type StagingLifecycleFixture,
} from '../helpers/github-staging-fixtures.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import type { DidDocument, IdentityAdapter } from '../../src/adapters/identity/types.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';

function delegationFixture(agentDid: string, operatorDid: string): Record<string, unknown> {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-invariant3-route',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-01-01T00:00:00Z',
      verificationMethod: `${agentDid}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zfixture-not-verified-here',
    },
  };
}

function fakeIdentity(): IdentityAdapter {
  return {
    ...createIdentityAdapter(),
    resolveDid: (did: string) =>
      Promise.resolve({ id: did, controller: null, verificationMethod: [`${did}#key-1`], alsoKnownAs: null } satisfies DidDocument),
  };
}

interface Started {
  readonly server: Server;
  readonly baseUrl: string;
  readonly buyer: SigningIdentity;
  readonly agent: SigningIdentity;
  readonly agentGithubLogin: string;
  readonly operator: SigningIdentity;
  readonly fixture: StagingLifecycleFixture;
}

async function req(baseUrl: string, method: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = body === undefined ? '' : JSON.stringify(body);
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, method, targetUri, { body: bodyText });
  return fetch(targetUri, {
    method,
    headers: {
      'content-type': 'application/json',
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
    ...(body === undefined ? {} : { body: bodyText }),
  });
}

// A SINGLE fixture (one buyer, one agent, one operator, one github fake)
// shared by both twin jobs (Proof r2, defect 2). The prior version started
// two separate fixtures with two separate agent/buyer identities, which
// forced the credential comparison to skip signedBy and buyer as
// "legitimately different" when they were only different because the test
// harness made them so, not because the brief allows them to differ. A
// shared fixture makes every hire fact except the ones explicitly excluded
// below (id, timestamps, staged/merge commit, the platform's own
// signature) a genuine equality assertion.
async function startFixture(): Promise<Started> {
  const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(200));
  const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(210));
  const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(220));

  const operatorRepo = new MemoryAccountRepository();
  await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-inv3' });
  await operatorRepo.register({ did: operator.did, githubLogin: 'operator-inv3' });

  const agentRepo = new MemoryAgentRepository();
  const agentGithubLogin = 'scout-inv3';
  await agentRepo.create({
    did: agent.did,
    operatorDid: operator.did,
    delegation: delegationFixture(agent.did, operator.did) as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: agentGithubLogin,
    negotiatesOnOwnersBehalf: true,
  });
  await agentRepo.updateGithubBinding(agent.did, { handle: agentGithubLogin, status: 'verified' });

  const jobRepo = new MemoryJobRepository();
  const credentialRepo = new MemoryCredentialRepository();
  const credentials = createCredentialsAdapter({ did: 'did:abt:test-platform-issuer-inv3', seed: new Uint8Array(32).fill(7) }, credentialRepo);
  const attestationRepo = new MemoryAttestationRepository();
  const messageRepo = new MemoryMessageRepository();
  const attachmentRepo = new MemoryAttachmentRepository();
  const sessionAdapter = testSessionAdapter();
  const fixture = createStagingLifecycleGithubFake();

  const app = createApp(
    operatorRepo,
    agentRepo,
    fakeIdentity(),
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
    attestationRepo,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    messageRepo,
    undefined,
    undefined,
    attachmentRepo,
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, buyer, agent, agentGithubLogin, operator, fixture };
}

async function openDraft(started: Started): Promise<string> {
  const draft = await req(started.baseUrl, 'POST', '/jobs', {
    agentDid: started.agent.did,
    repository: 'buyer/target-repo',
    brief: 'Fix the login bug',
  }, started.buyer);
  const body = (await draft.json()) as Record<string, unknown>;
  return String(body.id);
}

// Walks a job to confirmed with the fixed, shared agreement (one
// criterion, one price) every twin in this file uses -- identical
// inputs are what makes the byte-identical hash comparison meaningful.
async function walkToConfirmed(started: Started, jobId: string): Promise<Record<string, unknown>> {
  await req(started.baseUrl, 'POST', `/jobs/${jobId}/criteria`, {
    criteria: [{ text: 'The bug is fixed', proposedBy: 'agent' }],
    priceUsd: '500.00',
    rail: 'abt',
  }, started.operator);
  await req(started.baseUrl, 'POST', `/jobs/${jobId}/criteria/0/accept`, undefined, started.buyer);
  await req(started.baseUrl, 'POST', `/jobs/${jobId}/criteria/0/accept`, undefined, started.operator);
  await req(started.baseUrl, 'POST', `/jobs/${jobId}/price/accept`, undefined, started.buyer);
  await req(started.baseUrl, 'POST', `/jobs/${jobId}/price/accept`, undefined, started.operator);
  const confirm = await req(started.baseUrl, 'POST', `/jobs/${jobId}/confirm`, undefined, started.buyer);
  expect(confirm.status).toBe(200);
  return (await confirm.json()) as Record<string, unknown>;
}

async function walkToStaged(started: Started, jobId: string, stagedCommit: string): Promise<Record<string, unknown>> {
  const stage = await req(started.baseUrl, 'POST', `/jobs/${jobId}/stage`, { stagedCommit }, started.operator);
  expect(stage.status).toBe(200);
  return (await stage.json()) as Record<string, unknown>;
}

async function readAttestation(started: Started, jobId: string): Promise<Record<string, unknown>> {
  const res = await req(started.baseUrl, 'GET', `/jobs/${jobId}/attestation`, undefined, started.buyer);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function walkToCompleted(
  started: Started,
  jobId: string,
  stagedCommit: string,
  prNumber: number,
): Promise<Record<string, unknown>> {
  const { url } = registerAgentForkPullRequest(started.fixture, {
    repository: 'buyer/target-repo',
    jobId,
    stagedCommit,
    agentLogin: started.agentGithubLogin,
    number: prNumber,
  });
  const pr = await req(started.baseUrl, 'POST', `/jobs/${jobId}/pull-request`, { pullRequestUrl: url }, started.operator);
  expect(pr.status).toBe(200);
  started.fixture.setPullRequest(
    { owner: 'buyer', repo: 'target-repo', number: prNumber },
    {
      state: 'merged',
      mergeCommitSha: `merge-${jobId}`,
      mergedAt: new Date('2026-01-05T00:00:00Z'),
      headSha: stagedCommit,
      additions: 1,
      deletions: 0,
      filesChanged: 1,
      repositoryPublic: true,
      headRepoOwner: started.agentGithubLogin,
      headRepoFullName: `${started.agentGithubLogin}/target-repo`,
      headRepoIsFork: true,
      baseRepoFullName: 'buyer/target-repo',
      authorLogin: started.agentGithubLogin,
      body: `Job: ${jobId}\n`,
    },
  );
  const merge = await req(started.baseUrl, 'POST', `/jobs/${jobId}/merge`, undefined, started.buyer);
  expect(merge.status).toBe(200);
  return (await merge.json()) as Record<string, unknown>;
}

// Deep-clones `value` and deletes every dotted path in `paths` that
// resolves (a missing path is a no-op, not an error -- some excluded
// paths only exist on one side, e.g. specHash being present/absent).
function withoutPaths(value: unknown, paths: readonly string[]): unknown {
  const clone = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  for (const path of paths) {
    const segments = path.split('.');
    let cursor: Record<string, unknown> | undefined = clone;
    for (let i = 0; i < segments.length - 1 && cursor !== undefined; i++) {
      cursor = cursor[segments[i]!] as Record<string, unknown> | undefined;
    }
    if (cursor !== undefined) {
      delete cursor[segments[segments.length - 1]!];
    }
  }
  return clone;
}

describe('HT1 Part B: invariant 3 at the route level (twin jobs sharing one identity set, one with a real thread)', () => {
  let started: Started;

  beforeAll(async () => {
    process.env.FREEAGENTS_ATTACHMENTS_DIR = '/tmp/ht1-inv3-attachments-test-' + Date.now();
    started = await startFixture();
  });

  afterAll(() => {
    started.server.close();
  });

  it('confirmedSpecHash is byte-identical whether or not the job carries a real message/reaction/edit/attachment history', async () => {
    const plainJobId = await openDraft(started);
    const chattyJobId = await openDraft(started);

    // The chatty twin gets a real thread: messages, a reply, a reaction,
    // an edit, and an uploaded attachment -- all through the actual
    // routes, landing in real storage, before confirm ever runs.
    const m1 = await req(started.baseUrl, 'POST', `/jobs/${chattyJobId}/messages`, { body: 'What is the timeline?' }, started.buyer);
    const m1Id = String((await m1.json() as Record<string, unknown>).id);
    await req(started.baseUrl, 'POST', `/jobs/${chattyJobId}/messages`, { body: 'Two weeks, price is 500', replyToId: m1Id }, started.operator);
    await req(started.baseUrl, 'POST', `/jobs/${chattyJobId}/messages/${m1Id}/reactions`, { emoji: '\u{1F44D}' }, started.operator);
    await req(started.baseUrl, 'PATCH', `/jobs/${chattyJobId}/messages/${m1Id}`, { body: 'What is the timeline? (edited)' }, started.buyer);
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 9, g: 9, b: 9 } } }).png().toBuffer();
    const upload = await req(started.baseUrl, 'POST', `/jobs/${chattyJobId}/attachments`, { filename: 'note.png', dataBase64: png.toString('base64') }, started.buyer);
    const attachmentId = String((await upload.json() as Record<string, unknown>).id);
    await req(started.baseUrl, 'POST', `/jobs/${chattyJobId}/messages`, { body: 'see attached', attachmentIds: [attachmentId] }, started.buyer);

    const plainConfirmed = await walkToConfirmed(started, plainJobId);
    const chattyConfirmed = await walkToConfirmed(started, chattyJobId);

    expect(chattyConfirmed.specHash).toBe(plainConfirmed.specHash);
    expect(chattyConfirmed.specHash).not.toBeNull();
  });

  it('the signed attestation and the issued credential are identical between the twins once id/timestamp/commit fields are normalized away, and neither ever carries a message body or an attachment id', async () => {
    const plainJobId = await openDraft(started);
    const chattyJobId = await openDraft(started);

    const secretBody = 'the buyer secretly offered a bonus of $9001 if delivered early';
    await req(started.baseUrl, 'POST', `/jobs/${chattyJobId}/messages`, { body: secretBody }, started.buyer);
    const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
    const upload = await req(started.baseUrl, 'POST', `/jobs/${chattyJobId}/attachments`, { filename: 'secret.png', dataBase64: png.toString('base64') }, started.buyer);
    const attachmentId = String((await upload.json() as Record<string, unknown>).id);
    await req(started.baseUrl, 'POST', `/jobs/${chattyJobId}/messages`, { body: 'attached', attachmentIds: [attachmentId] }, started.buyer);

    await walkToConfirmed(started, plainJobId);
    await walkToConfirmed(started, chattyJobId);

    const plainStagedCommit = 'commit-inv3-plain';
    const chattyStagedCommit = 'commit-inv3-chatty';
    await walkToStaged(started, plainJobId, plainStagedCommit);
    await walkToStaged(started, chattyJobId, chattyStagedCommit);

    // The signed attestation (P5): built and signed the instant each job
    // staged, entirely independent of the thread. Read through the real
    // GET /jobs/:jobId/attestation route as the buyer, on both twins.
    const plainAttestation = await readAttestation(started, plainJobId);
    const chattyAttestation = await readAttestation(started, chattyJobId);
    const attestationExclusions = [
      'id',
      'validFrom',
      'proof',
      'credentialSubject.id',
      'credentialSubject.attestation.stagedCommit',
      'credentialSubject.attestation.generatedAt',
    ];
    expect(withoutPaths(chattyAttestation, attestationExclusions)).toEqual(withoutPaths(plainAttestation, attestationExclusions));
    // The excluded fields really do differ (a sanity check that the
    // normalization above is not vacuously comparing two already-equal
    // documents): the staged commit is the whole reason the two
    // attestations carry a different id and a different subject id.
    expect(chattyAttestation.id).not.toBe(plainAttestation.id);

    const plainCompleted = await walkToCompleted(started, plainJobId, plainStagedCommit, 1);
    const chattyCompleted = await walkToCompleted(started, chattyJobId, chattyStagedCommit, 2);

    const plainCredential = plainCompleted.credential as Record<string, unknown>;
    const chattyCredential = chattyCompleted.credential as Record<string, unknown>;

    // Never the message body or the attachment id, anywhere in the
    // credential document.
    const chattyCredentialJson = JSON.stringify(chattyCredential);
    expect(chattyCredentialJson).not.toContain(secretBody);
    expect(chattyCredentialJson).not.toContain(attachmentId);

    // The full issued credential document, normalized against the same
    // twin, aside from the id (rooted at the job id), every timestamp,
    // the merge commit (rooted at the staged commit), the pull request
    // reference (a distinct PR per twin, by construction of this test),
    // and the platform's own signature over all of the above (a
    // different id/timestamp/mergeCommit produces a different signature
    // even with no leak at all). Every OTHER hire fact -- brief,
    // repository, buyer, signedBy, additions, deletions, filesChanged,
    // specHash -- must now be genuinely identical, since both twins
    // share the same buyer and agent identities.
    const credentialExclusions = [
      'id',
      'validFrom',
      'proof',
      'credentialSubject.hire.mergeCommit',
      'credentialSubject.hire.mergedAt',
      'credentialSubject.hire.pullRequest',
    ];
    expect(withoutPaths(chattyCredential, credentialExclusions)).toEqual(withoutPaths(plainCredential, credentialExclusions));
    expect(chattyCredential.id).not.toBe(plainCredential.id);
  });
});
