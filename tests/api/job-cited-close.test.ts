// P6 (design record, 2026-09-01, row 4): the buyer's cited close after
// paying, driven end to end over HTTP. recordCitedClose already carries the
// domain rule (tests/domain/job-cited-close.test.ts); this file proves the
// route layer's own job -- party enforcement (buyer only), wiring the body's
// criterionIndex and reasonText through, and the 200/400/403 shapes the
// existing lifecycle routes already use for the same failure classes.
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import type { GithubAdapter, PullRequestRef } from '../../src/adapters/github/types.js';
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import { MemoryAgentRepository, MemoryCredentialRepository, MemoryJobRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import type { JobRepository } from '../../src/adapters/storage/types.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { testSessionAdapter } from '../helpers/session-fixtures.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';

let buyer: SigningIdentity;
let agent: SigningIdentity;
const FORK_OWNER = 'freeagents-platform';
const FORK_REPO = 'target-repo';
const proposal = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
];

function fakeGithub(): GithubAdapter {
  return {
    getPullRequest: () => Promise.reject(new NotImplementedError('github', 'getPullRequest')),
    getMergeCommitSignature: () => Promise.reject(new NotImplementedError('github', 'getMergeCommitSignature')),
    getPublicGist: () => Promise.reject(new NotImplementedError('github', 'getPublicGist')),
    forkAndOpenPullRequest: (): Promise<PullRequestRef> =>
      Promise.resolve({ owner: FORK_OWNER, repo: FORK_REPO, number: 1 }),
  };
}

async function postSigned(base: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
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

async function startWith(repo: JobRepository, credentialRepo: MemoryCredentialRepository): Promise<{ server: Server; baseUrl: string }> {
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: agent.did,
    operatorDid: 'did:abt:op-cited-close',
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: null,
  });
  const operatorRepo = new MemoryAccountRepository();
  await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-cited-close-scripted' });
  const sessionAdapter = testSessionAdapter();
  const s = createApp(
    operatorRepo,
    agentRepo,
    undefined,
    fakeGithub(),
    repo,
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
  ).listen(0);
  await new Promise<void>((resolve) => s.once('listening', resolve));
  const address = s.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return { server: s, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function walkToSubmitted(base: string): Promise<string> {
  const created = await postSigned(base, '/jobs', { agentDid: agent.did, repository: 'buyer/target-repo', brief: 'Fix the login bug' }, buyer);
  expect(created.status).toBe(201);
  const jobId = String(((await created.json()) as Record<string, unknown>).id);
  expect((await postSigned(base, `/jobs/${jobId}/criteria`, { criteria: proposal, priceUsd: '500.00', rail: 'abt' }, agent)).status).toBe(200);
  expect((await postSigned(base, `/jobs/${jobId}/criteria/0/accept`, {}, buyer)).status).toBe(200);
  expect((await postSigned(base, `/jobs/${jobId}/criteria/0/accept`, {}, agent)).status).toBe(200);
  expect((await postSigned(base, `/jobs/${jobId}/criteria/1/accept`, {}, buyer)).status).toBe(200);
  expect((await postSigned(base, `/jobs/${jobId}/criteria/1/accept`, {}, agent)).status).toBe(200);
  expect((await postSigned(base, `/jobs/${jobId}/price/accept`, {}, buyer)).status).toBe(200);
  expect((await postSigned(base, `/jobs/${jobId}/price/accept`, {}, agent)).status).toBe(200);
  expect((await postSigned(base, `/jobs/${jobId}/confirm`, {}, buyer)).status).toBe(200);
  expect((await postSigned(base, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-sha-1' }, agent)).status).toBe(200);
  expect((await postSigned(base, `/jobs/${jobId}/pull-request`, {}, agent)).status).toBe(200);
  return jobId;
}

describe('job cited close after paying (P6, design record row 4)', () => {
  let server: Server;
  let baseUrl: string;
  let credentialRepo: MemoryCredentialRepository;

  beforeAll(async () => {
    buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(131));
    agent = await signingIdentityFromSeed(new Uint8Array(32).fill(132));
    credentialRepo = new MemoryCredentialRepository();
    const started = await startWith(new MemoryJobRepository(), credentialRepo);
    server = started.server;
    baseUrl = started.baseUrl;
  });

  afterAll(() => {
    server.close();
  });

  it('the buyer closes citing a confirmed criterion and a sentence of reasoning', async () => {
    const jobId = await walkToSubmitted(baseUrl);
    const res = await postSigned(baseUrl, `/jobs/${jobId}/cited-close`, { criterionIndex: 0, reasonText: 'The login bug is not actually fixed.' }, buyer);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('cited_closed');
    const citedClose = body.citedClose as Record<string, unknown>;
    expect(citedClose.criterionIndex).toBe(0);
    expect(citedClose.reasonText).toBe('The login bug is not actually fixed.');
    expect(citedClose.authorDid).toBe(buyer.did);
    expect(citedClose.moneyReturned).toBe(false);
  });

  it('the agent cannot cited-close (403): only the buyer holds this move', async () => {
    const jobId = await walkToSubmitted(baseUrl);
    const res = await postSigned(baseUrl, `/jobs/${jobId}/cited-close`, { criterionIndex: 0, reasonText: 'Not fixed.' }, agent);
    expect(res.status).toBe(403);
  });

  it('an empty reasonText is 400: a cited close needs at least one sentence', async () => {
    const jobId = await walkToSubmitted(baseUrl);
    const res = await postSigned(baseUrl, `/jobs/${jobId}/cited-close`, { criterionIndex: 0, reasonText: '   ' }, buyer);
    expect(res.status).toBe(400);
  });

  it('an out-of-range criterionIndex is 400', async () => {
    const jobId = await walkToSubmitted(baseUrl);
    const res = await postSigned(baseUrl, `/jobs/${jobId}/cited-close`, { criterionIndex: 99, reasonText: 'Not fixed.' }, buyer);
    expect(res.status).toBe(400);
  });

  it('issues no credential of any type: a cited-closed job has nothing in the credential repository', async () => {
    const jobId = await walkToSubmitted(baseUrl);
    const res = await postSigned(baseUrl, `/jobs/${jobId}/cited-close`, { criterionIndex: 0, reasonText: 'Not fixed.' }, buyer);
    expect(res.status).toBe(200);
    const stored = await credentialRepo.findByDocumentId(jobId);
    expect(stored).toBeNull();
  });
});
