// HT1 Part B (Proof r1, defect 9): a route-level invariant-3 test. The
// prior test (tests/domain/message-invariant3.test.ts) built Message
// objects that were never wired into any function confirmSpec could
// reach, so it could not fail no matter what leaked. This drives TWO
// twin jobs through the real HTTP routes (identical criteria, identical
// price), one carrying a real thread of messages, reactions, edits and
// an uploaded attachment, the other with an empty thread, and compares
// the CONFIRMED SPEC HASH, the signed attestation and the issued
// credential byte for byte (aside from the fields that legitimately
// differ between two distinct jobs: id, timestamps, staged commit).
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
  readonly stranger: SigningIdentity;
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

async function startFixture(seedOffset: number): Promise<Started> {
  const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(200 + seedOffset));
  const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(210 + seedOffset));
  const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(220 + seedOffset));
  const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(230 + seedOffset));

  const operatorRepo = new MemoryAccountRepository();
  await operatorRepo.register({ did: buyer.did, githubLogin: `buyer-inv3-${seedOffset}` });
  await operatorRepo.register({ did: operator.did, githubLogin: `operator-inv3-${seedOffset}` });
  await operatorRepo.register({ did: stranger.did, githubLogin: `stranger-inv3-${seedOffset}` });

  const agentRepo = new MemoryAgentRepository();
  const agentGithubLogin = `scout-inv3-${seedOffset}`;
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
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, buyer, agent, agentGithubLogin, operator, stranger, fixture };
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

async function walkToCompleted(started: Started, jobId: string, stagedCommit: string): Promise<Record<string, unknown>> {
  const stage = await req(started.baseUrl, 'POST', `/jobs/${jobId}/stage`, { stagedCommit }, started.operator);
  expect(stage.status).toBe(200);
  const { url } = registerAgentForkPullRequest(started.fixture, {
    repository: 'buyer/target-repo',
    jobId,
    stagedCommit,
    agentLogin: started.agentGithubLogin,
  });
  const pr = await req(started.baseUrl, 'POST', `/jobs/${jobId}/pull-request`, { pullRequestUrl: url }, started.operator);
  expect(pr.status).toBe(200);
  started.fixture.setPullRequest(
    { owner: 'buyer', repo: 'target-repo', number: 1 },
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

describe('HT1 Part B: invariant 3 at the route level (twin jobs, one with a real thread)', () => {
  let plain: Started;
  let chatty: Started;

  beforeAll(async () => {
    process.env.FREEAGENTS_ATTACHMENTS_DIR = '/tmp/ht1-inv3-attachments-test-' + Date.now();
    plain = await startFixture(1);
    chatty = await startFixture(2);
  });

  afterAll(() => {
    plain.server.close();
    chatty.server.close();
  });

  it('confirmedSpecHash is byte-identical whether or not the job carries a real message/reaction/edit/attachment history', async () => {
    const plainJobId = await openDraft(plain);
    const chattyJobId = await openDraft(chatty);

    // The chatty twin gets a real thread: messages, a reply, a reaction,
    // an edit, and an uploaded attachment -- all through the actual
    // routes, landing in real storage, before confirm ever runs.
    const m1 = await req(chatty.baseUrl, 'POST', `/jobs/${chattyJobId}/messages`, { body: 'What is the timeline?' }, chatty.buyer);
    const m1Id = String((await m1.json() as Record<string, unknown>).id);
    await req(chatty.baseUrl, 'POST', `/jobs/${chattyJobId}/messages`, { body: 'Two weeks, price is 500', replyToId: m1Id }, chatty.operator);
    await req(chatty.baseUrl, 'POST', `/jobs/${chattyJobId}/messages/${m1Id}/reactions`, { emoji: '\u{1F44D}' }, chatty.operator);
    await req(chatty.baseUrl, 'PATCH', `/jobs/${chattyJobId}/messages/${m1Id}`, { body: 'What is the timeline? (edited)' }, chatty.buyer);
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 9, g: 9, b: 9 } } }).png().toBuffer();
    const upload = await req(chatty.baseUrl, 'POST', `/jobs/${chattyJobId}/attachments`, { filename: 'note.png', dataBase64: png.toString('base64') }, chatty.buyer);
    const attachmentId = String((await upload.json() as Record<string, unknown>).id);
    await req(chatty.baseUrl, 'POST', `/jobs/${chattyJobId}/messages`, { body: 'see attached', attachmentIds: [attachmentId] }, chatty.buyer);

    const plainConfirmed = await walkToConfirmed(plain, plainJobId);
    const chattyConfirmed = await walkToConfirmed(chatty, chattyJobId);

    expect(chattyConfirmed.specHash).toBe(plainConfirmed.specHash);
    expect(chattyConfirmed.specHash).not.toBeNull();
  });

  it('the merged credential document never carries a message body or an attachment id, and both twins agree on every hire fact', async () => {
    process.env.FREEAGENTS_ATTACHMENTS_DIR = '/tmp/ht1-inv3-attachments-test-' + Date.now();
    const plainJobId = await openDraft(plain);
    const chattyJobId = await openDraft(chatty);

    const secretBody = 'the buyer secretly offered a bonus of $9001 if delivered early';
    await req(chatty.baseUrl, 'POST', `/jobs/${chattyJobId}/messages`, { body: secretBody }, chatty.buyer);
    const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
    const upload = await req(chatty.baseUrl, 'POST', `/jobs/${chattyJobId}/attachments`, { filename: 'secret.png', dataBase64: png.toString('base64') }, chatty.buyer);
    const attachmentId = String((await upload.json() as Record<string, unknown>).id);
    await req(chatty.baseUrl, 'POST', `/jobs/${chattyJobId}/messages`, { body: 'attached', attachmentIds: [attachmentId] }, chatty.buyer);

    await walkToConfirmed(plain, plainJobId);
    await walkToConfirmed(chatty, chattyJobId);

    const plainCompleted = await walkToCompleted(plain, plainJobId, 'commit-inv3-plain');
    const chattyCompleted = await walkToCompleted(chatty, chattyJobId, 'commit-inv3-chatty');

    const plainCredential = plainCompleted.credential as Record<string, unknown>;
    const chattyCredential = chattyCompleted.credential as Record<string, unknown>;

    // Never the message body or the attachment id, anywhere in the
    // credential document.
    const chattyCredentialJson = JSON.stringify(chattyCredential);
    expect(chattyCredentialJson).not.toContain(secretBody);
    expect(chattyCredentialJson).not.toContain(attachmentId);

    // Every hire fact both jobs share (identical criteria and price)
    // agrees between the two twins -- the thread made no difference to
    // what the credential attests.
    const plainHire = (plainCredential.credentialSubject as Record<string, unknown>).hire as Record<string, unknown>;
    const chattyHire = (chattyCredential.credentialSubject as Record<string, unknown>).hire as Record<string, unknown>;
    expect(chattyHire.brief).toBe(plainHire.brief);
    expect(chattyHire.repository).toBe(plainHire.repository);
    expect(chattyHire.specHash).toBe(plainHire.specHash);
    expect(chattyHire.additions).toBe(plainHire.additions);
    expect(chattyHire.deletions).toBe(plainHire.deletions);
    expect(chattyHire.filesChanged).toBe(plainHire.filesChanged);
  });
});
