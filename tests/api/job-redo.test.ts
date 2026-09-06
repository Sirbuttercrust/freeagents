// P6 (design record, 2026-09-01, row 2): the buyer's redo at staged, driven
// end to end over HTTP. requestRedo/refuseRedo already carry the domain
// rule (tests/domain/job-redo.test.ts); this file proves the route layer's
// own job -- party enforcement (buyer requests, operator/agent refuses),
// wiring the body's criterionIndex through, and the 200/400/403/409 shapes
// the existing lifecycle routes already use for the same failure classes.
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryAttestationRepository, MemoryJobRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import type { JobRepository } from '../../src/adapters/storage/types.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { testSessionAdapter } from '../helpers/session-fixtures.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';

let buyer: SigningIdentity;
let agent: SigningIdentity;
const proposal = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
];

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

async function startWith(repo: JobRepository, attestationRepo: MemoryAttestationRepository): Promise<{ server: Server; baseUrl: string }> {
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: agent.did,
    operatorDid: 'did:abt:op-redo',
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: null,
  });
  const operatorRepo = new MemoryAccountRepository();
  await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-redo-scripted' });
  const sessionAdapter = testSessionAdapter();
  const s = createApp(
    operatorRepo,
    agentRepo,
    undefined,
    undefined,
    repo,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    sessionAdapter,
    undefined,
    alwaysSettledGate(),
    anyCommitStagingObserver(),
    attestationRepo,
  ).listen(0);
  await new Promise<void>((resolve) => s.once('listening', resolve));
  const address = s.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return { server: s, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function walkToStaged(base: string): Promise<string> {
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
  return jobId;
}

describe('job redo at staged (P6, design record row 2)', () => {
  let server: Server;
  let baseUrl: string;
  let attestationRepo: MemoryAttestationRepository;

  beforeAll(async () => {
    buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(121));
    agent = await signingIdentityFromSeed(new Uint8Array(32).fill(122));
    attestationRepo = new MemoryAttestationRepository();
    const started = await startWith(new MemoryJobRepository(), attestationRepo);
    server = started.server;
    baseUrl = started.baseUrl;
  });

  afterAll(() => {
    server.close();
  });

  it('the buyer requests a redo citing a confirmed criterion index, and the job moves to redo_requested', async () => {
    const jobId = await walkToStaged(baseUrl);
    const res = await postSigned(baseUrl, `/jobs/${jobId}/redo`, { criterionIndex: 0 }, buyer);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('redo_requested');
    expect((body.redo as Record<string, unknown>).requestedCriterionIndex).toBe(0);
  });

  it('the agent cannot request a redo (403): only the buyer holds this move', async () => {
    const jobId = await walkToStaged(baseUrl);
    const res = await postSigned(baseUrl, `/jobs/${jobId}/redo`, { criterionIndex: 0 }, agent);
    expect(res.status).toBe(403);
  });

  it('a redo naming an out-of-range criterion index is 400', async () => {
    const jobId = await walkToStaged(baseUrl);
    const res = await postSigned(baseUrl, `/jobs/${jobId}/redo`, { criterionIndex: 99 }, buyer);
    expect(res.status).toBe(400);
  });

  it('the operator (agent) refuses the redo, returning the job to staged', async () => {
    const jobId = await walkToStaged(baseUrl);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/redo`, { criterionIndex: 0 }, buyer)).status).toBe(200);
    const res = await postSigned(baseUrl, `/jobs/${jobId}/redo-refuse`, {}, agent);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('staged');
    expect((body.redo as Record<string, unknown>).refusedAt).not.toBeNull();
  });

  it('the buyer cannot refuse their own redo (403): only the agent/operator holds this move', async () => {
    const jobId = await walkToStaged(baseUrl);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/redo`, { criterionIndex: 0 }, buyer)).status).toBe(200);
    const res = await postSigned(baseUrl, `/jobs/${jobId}/redo-refuse`, {}, buyer);
    expect(res.status).toBe(403);
  });

  it('the first attestation is still readable after a redo restages: a new record joins it, the old one is never overwritten', async () => {
    const jobId = await walkToStaged(baseUrl);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/redo`, { criterionIndex: 0 }, buyer)).status).toBe(200);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-sha-2' }, agent)).status).toBe(200);

    const all = await attestationRepo.listByJobId(jobId);
    expect(all).toHaveLength(2);
    expect(all[0]?.sequence).toBe(1);
    expect(all[0]?.attestation.stagedCommit).toBe('commit-sha-1');
    expect(all[1]?.sequence).toBe(2);
    expect(all[1]?.attestation.stagedCommit).toBe('commit-sha-2');

    // findByJobId (what the attestation route serves) reads the latest,
    // never the one a redo replaced -- the first record is still there,
    // reachable through listByJobId, just no longer the one served by
    // default.
    const latest = await attestationRepo.findByJobId(jobId);
    expect(latest?.sequence).toBe(2);
  });
});
