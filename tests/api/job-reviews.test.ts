// R-22 (#29, ENT-10): reviews restricted to completed hires, driven end to
// end over HTTP. The old 501 stub (POST /jobs/:jobId/reviews) is replaced
// here.
//
// THE anchor this issue exists to prove: only a buyer who paid for and
// received the work may say anything about it, and what they say never
// becomes a number. Every refusal case the card names gets its own test:
// no completed hire, a hire against a different agent, closed_unmerged,
// stale, a second review on the same job, an anonymous caller, and a caller
// whose proven identity is not the job's buyer.
//
// Caller identity is R-34: a verified request signature naming the buyer,
// never a body field, mirroring how src/api/app.ts's runPartyExchange
// already refuses to trust a caller-supplied party identity.
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import {
  MemoryAgentRepository,
  MemoryJobRepository,
  MemoryOperatorRepository,
  MemoryReviewRepository,
} from '../../src/adapters/storage/memory.js';
import type { JobRepository, ReviewRepository } from '../../src/adapters/storage/types.js';
import { createJob, type Job, type JobStatus } from '../../src/domain/job.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

const AGENT_DID_SEED = new Uint8Array(32).fill(101);
const OTHER_AGENT_DID_SEED = new Uint8Array(32).fill(102);
const BUYER_SEED = new Uint8Array(32).fill(103);
const STRANGER_SEED = new Uint8Array(32).fill(104);

function delegationFixture(agentDid: string): Record<string, unknown> {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-review',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: 'did:abt:op-review',
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

// A row already in the requested status, fully shaped so the review route's
// own checks (status, buyer, agent) are the only thing under test. No
// honest API path can plant closed_unmerged or stale without walking the
// whole merge machinery, so these rows are constructed directly, the same
// stance tests/api/job-withdraw.test.ts and tests/api/job-merge.test.ts take.
function plantedJob(
  id: string,
  status: JobStatus,
  overrides: Partial<Job> & { buyerDid: string; agentDid: string },
): Job {
  return {
    ...createJob(
      { id, buyerDid: overrides.buyerDid, agentDid: overrides.agentDid, repository: 'buyer/target-repo', brief: 'Fix the login bug' },
      new Date('2026-01-01T00:00:00Z'),
    ),
    status,
    ...overrides,
  };
}

let server: Server;
let baseUrl: string;
let buyer: SigningIdentity;
let agent: SigningIdentity;
let otherAgent: SigningIdentity;
let stranger: SigningIdentity;
const jobRepo = new MemoryJobRepository();
const reviewRepo = new MemoryReviewRepository();

async function post(path: string, body: unknown = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function postSigned(path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
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

async function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

beforeAll(async () => {
  buyer = await signingIdentityFromSeed(BUYER_SEED);
  agent = await signingIdentityFromSeed(AGENT_DID_SEED);
  otherAgent = await signingIdentityFromSeed(OTHER_AGENT_DID_SEED);
  stranger = await signingIdentityFromSeed(STRANGER_SEED);

  const operatorRepo = new MemoryOperatorRepository();
  await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-review' });
  // Registered too, so its request signature verifies (R-34): the point of
  // this fixture is a caller who is somebody, just not THIS job's buyer.
  await operatorRepo.register({ did: stranger.did, githubLogin: 'stranger-review' });
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: agent.did,
    operatorDid: 'did:abt:op-review',
    delegation: delegationFixture(agent.did) as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: null,
  });
  await agentRepo.create({
    did: otherAgent.did,
    operatorDid: 'did:abt:op-review',
    delegation: delegationFixture(otherAgent.did) as never,
    name: 'rival',
    skills: ['triage'],
    githubLogin: null,
  });

  const app = createApp(
    operatorRepo,
    agentRepo,
    undefined,
    undefined,
    jobRepo,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    reviewRepo,
  );
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server.close();
});

describe('POST /jobs/:jobId/reviews (R-22, ENT-10, issue 29)', () => {
  it('201: a completed hire, reviewed by its actual buyer, is stored and projected', async () => {
    const completed = plantedJob('rv-happy', 'completed', {
      buyerDid: buyer.did,
      agentDid: agent.did,
      mergeCommit: 'deadbeef',
      mergedAt: new Date('2026-01-03T00:00:00Z'),
    });
    await jobRepo.create(completed);

    const res = await postSigned(`/jobs/${completed.id}/reviews`, { agentDid: agent.did, text: 'Delivered exactly what was agreed.' }, buyer);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      jobId: completed.id,
      authorDid: buyer.did,
      agentDid: agent.did,
      text: 'Delivered exactly what was agreed.',
      createdAt: expect.any(String),
    });
    expect(Object.keys(body).sort()).toEqual(['agentDid', 'authorDid', 'createdAt', 'jobId', 'text']);
  });

  it('the stored review reads back through GET /agents/:agentDid/reviews', async () => {
    const res = await get(`/agents/${agent.did}/reviews`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentDid: string; reviews: Array<Record<string, unknown>> };
    expect(body.agentDid).toBe(agent.did);
    expect(body.reviews.some((r) => r.jobId === 'rv-happy' && r.text === 'Delivered exactly what was agreed.')).toBe(true);
  });

  it('401: an anonymous caller (no request signature at all)', async () => {
    const completed = plantedJob('rv-anon', 'completed', {
      buyerDid: buyer.did,
      agentDid: agent.did,
      mergeCommit: 'deadbeef',
      mergedAt: new Date('2026-01-03T00:00:00Z'),
    });
    await jobRepo.create(completed);

    const res = await post(`/jobs/${completed.id}/reviews`, { agentDid: agent.did, text: 'Nice work.' });
    expect(res.status).toBe(401);
    expect((await reviewRepo.listByAgentDid(agent.did)).some((r) => r.jobId === 'rv-anon')).toBe(false);
  });

  it("403: a caller whose proven identity is not the job's buyer", async () => {
    const completed = plantedJob('rv-stranger', 'completed', {
      buyerDid: buyer.did,
      agentDid: agent.did,
      mergeCommit: 'deadbeef',
      mergedAt: new Date('2026-01-03T00:00:00Z'),
    });
    await jobRepo.create(completed);

    const res = await postSigned(`/jobs/${completed.id}/reviews`, { agentDid: agent.did, text: 'I was not the buyer.' }, stranger);
    expect(res.status).toBe(403);
    expect((await reviewRepo.listByAgentDid(agent.did)).some((r) => r.jobId === 'rv-stranger')).toBe(false);
  });

  it('409: no completed hire (job is still confirmed, never submitted or merged)', async () => {
    const confirmed = plantedJob('rv-not-completed', 'confirmed', { buyerDid: buyer.did, agentDid: agent.did });
    await jobRepo.create(confirmed);

    const res = await postSigned(`/jobs/${confirmed.id}/reviews`, { agentDid: agent.did, text: 'Too soon.' }, buyer);
    expect(res.status).toBe(409);
    expect(String(((await res.json()) as { error: string }).error)).toContain('confirmed');
  });

  it('409: closed_unmerged is not a completed hire', async () => {
    const closed = plantedJob('rv-closed-unmerged', 'closed_unmerged', { buyerDid: buyer.did, agentDid: agent.did });
    await jobRepo.create(closed);

    const res = await postSigned(`/jobs/${closed.id}/reviews`, { agentDid: agent.did, text: 'It never merged.' }, buyer);
    expect(res.status).toBe(409);
    expect(String(((await res.json()) as { error: string }).error)).toContain('closed_unmerged');
  });

  it('409: stale is not a completed hire', async () => {
    const stale = plantedJob('rv-stale', 'stale', { buyerDid: buyer.did, agentDid: agent.did });
    await jobRepo.create(stale);

    const res = await postSigned(`/jobs/${stale.id}/reviews`, { agentDid: agent.did, text: 'It went stale.' }, buyer);
    expect(res.status).toBe(409);
    expect(String(((await res.json()) as { error: string }).error)).toContain('stale');
  });

  it('409: a hire against a different agent than the one named refuses, the job record decides', async () => {
    const completed = plantedJob('rv-wrong-agent', 'completed', {
      buyerDid: buyer.did,
      agentDid: agent.did,
      mergeCommit: 'deadbeef',
      mergedAt: new Date('2026-01-03T00:00:00Z'),
    });
    await jobRepo.create(completed);

    // The buyer really did hire `agent`, but claims the review is against
    // `otherAgent`. The job record disagrees, so it is refused, not
    // reconciled to whichever agent the caller named.
    const res = await postSigned(`/jobs/${completed.id}/reviews`, { agentDid: otherAgent.did, text: 'Wrong agent.' }, buyer);
    expect(res.status).toBe(409);
    expect((await reviewRepo.listByAgentDid(otherAgent.did)).some((r) => r.jobId === 'rv-wrong-agent')).toBe(false);
  });

  it('409: a second review on the same job is refused, not appended', async () => {
    const completed = plantedJob('rv-second-attempt', 'completed', {
      buyerDid: buyer.did,
      agentDid: agent.did,
      mergeCommit: 'deadbeef',
      mergedAt: new Date('2026-01-03T00:00:00Z'),
    });
    await jobRepo.create(completed);

    const first = await postSigned(`/jobs/${completed.id}/reviews`, { agentDid: agent.did, text: 'First review.' }, buyer);
    expect(first.status).toBe(201);

    const second = await postSigned(`/jobs/${completed.id}/reviews`, { agentDid: agent.did, text: 'A second attempt.' }, buyer);
    expect(second.status).toBe(409);

    const stored = (await reviewRepo.listByAgentDid(agent.did)).filter((r) => r.jobId === 'rv-second-attempt');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.text).toBe('First review.');
  });

  it('400: a malformed body (missing text) is refused before any storage read', async () => {
    const completed = plantedJob('rv-malformed', 'completed', {
      buyerDid: buyer.did,
      agentDid: agent.did,
      mergeCommit: 'deadbeef',
      mergedAt: new Date('2026-01-03T00:00:00Z'),
    });
    await jobRepo.create(completed);

    const res = await postSigned(`/jobs/${completed.id}/reviews`, { agentDid: agent.did, text: '   ' }, buyer);
    expect(res.status).toBe(400);
    expect((await reviewRepo.listByAgentDid(agent.did)).some((r) => r.jobId === 'rv-malformed')).toBe(false);
  });

  it('404: an unknown job id', async () => {
    const res = await postSigned('/jobs/rv-nowhere/reviews', { agentDid: agent.did, text: 'Nothing here.' }, buyer);
    expect(res.status).toBe(404);
  });
});

describe('GET /agents/:agentDid/reviews (R-22)', () => {
  it('200: an agent with no reviews returns { agentDid, reviews: [] }, not a 404', async () => {
    const res = await get(`/agents/${otherAgent.did}/reviews`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agentDid: otherAgent.did, reviews: [] });
  });

  it('404: an unregistered agent', async () => {
    const res = await get('/agents/did:abt:znobody/reviews');
    expect(res.status).toBe(404);
  });

  it('never carries a numeric rating field anywhere on a review row (ENT-10.2)', async () => {
    const res = await get(`/agents/${agent.did}/reviews`);
    const body = (await res.json()) as { reviews: Array<Record<string, unknown>> };
    for (const review of body.reviews) {
      for (const value of Object.values(review)) {
        expect(typeof value).not.toBe('number');
      }
    }
  });
});

// Storage-fault legs, the same pattern tests/api/compromise.test.ts uses:
// a wrapped repository that decides what it returns per call.
describe('POST /jobs/:jobId/reviews and GET .../reviews, storage branches', () => {
  it('503: the review write fails', async () => {
    const failingReviewRepo: ReviewRepository = {
      save: () => Promise.reject(new Error('db down')),
      listByAgentDid: () => Promise.resolve([]),
    };
    const operatorRepo = new MemoryOperatorRepository();
    await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-review-fault' });
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: 'did:abt:op-review',
      delegation: delegationFixture(agent.did) as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const faultJobRepo: JobRepository = new MemoryJobRepository();
    const completed = plantedJob('rv-storage-fault', 'completed', {
      buyerDid: buyer.did,
      agentDid: agent.did,
      mergeCommit: 'deadbeef',
      mergedAt: new Date('2026-01-03T00:00:00Z'),
    });
    await faultJobRepo.create(completed);

    const app = createApp(
      operatorRepo,
      agentRepo,
      undefined,
      undefined,
      faultJobRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      failingReviewRepo,
    );
    const s = app.listen(0);
    await new Promise<void>((resolve) => s.once('listening', resolve));
    const address = s.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    const url = `http://127.0.0.1:${address.port}`;

    try {
      const bodyText = JSON.stringify({ agentDid: agent.did, text: 'Storage will fail.' });
      const signed = signRequest(buyer, 'POST', `${url}/jobs/${completed.id}/reviews`, { body: bodyText });
      const res = await fetch(`${url}/jobs/${completed.id}/reviews`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'signature-input': signed['signature-input'],
          signature: signed.signature,
          'content-digest': signed['content-digest'],
        },
        body: bodyText,
      });
      expect(res.status).toBe(503);
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  it('503: GET /agents/:agentDid/reviews when the read fails', async () => {
    const failingReviewRepo: ReviewRepository = {
      save: () => Promise.reject(new Error('unused')),
      listByAgentDid: () => Promise.reject(new Error('db down')),
    };
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: 'did:abt:op-review',
      delegation: delegationFixture(agent.did) as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const app = createApp(
      new MemoryOperatorRepository(),
      agentRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      failingReviewRepo,
    );
    const s = app.listen(0);
    await new Promise<void>((resolve) => s.once('listening', resolve));
    const address = s.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    const url = `http://127.0.0.1:${address.port}`;

    try {
      const res = await fetch(`${url}/agents/${agent.did}/reviews`);
      expect(res.status).toBe(503);
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });
});
