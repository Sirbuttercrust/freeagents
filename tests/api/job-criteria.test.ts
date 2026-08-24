// R-8 (#15): the acceptance-criteria exchange, driven end to end over HTTP.
//
// THE acceptance line this issue exists to prove: "the agent proposes
// criteria, the buyer may request changes, and the loop can run more than
// once without creating a job." One job id is walked through
// propose -> request-changes -> re-propose, and the id, the createdAt and the
// single create() call together show the loop ran twice on the same row.
//
// The draft's response key set is asserted here too, because the projection
// contract pinned at tests/api/job-invariant2.test.ts must survive R-8: a
// draft projects exactly the eight keys, criteria joins only when non-empty,
// and briefHash keeps its verifiable-brief contract untouched.
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryJobRepository, MemoryOperatorRepository } from '../../src/adapters/storage/memory.js';
import type { JobRepository } from '../../src/adapters/storage/types.js';
import {
  acceptCriterion,
  confirmSpec,
  createJob,
  proposeCriteria,
  type Job,
} from '../../src/domain/job.js';

const AGENT_DID = 'did:abt:agent-criteria';
const BUYER_DID = 'did:abt:buyer-criteria';

function delegationFixture(): Record<string, unknown> {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-criteria',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: 'did:abt:op-criteria',
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: AGENT_DID },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-01-01T00:00:00Z',
      verificationMethod: `${AGENT_DID}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zfixture-not-verified-here',
    },
  };
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

// A valid draft row as storage would hold it, for scripting findById.
function draftRow(id: string): Job {
  return createJob(
    { id, buyerDid: BUYER_DID, agentDid: AGENT_DID, repository: 'buyer/target-repo', brief: 'Fix the login bug' },
    new Date('2026-01-01T00:00:00Z'),
  );
}

// The exchange's storage-fault branches need a repository that decides what
// it returns per call, so each fault gets its own server built around a
// scripted repo - the same shape as the FailingRead test below.
async function startWith(jobRepo: JobRepository): Promise<{ server: Server; baseUrl: string }> {
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: AGENT_DID,
    operatorDid: 'did:abt:op-criteria',
    delegation: delegationFixture() as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: null,
  });
  const server = createApp(new MemoryOperatorRepository(), agentRepo, undefined, undefined, jobRepo).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

const firstProposal = [
  { text: '  The login bug is fixed  ', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'agent' },
];
const revisedProposal = [
  { text: 'One sharper criterion', proposedBy: 'agent' },
  { text: 'Deploy notes updated', proposedBy: 'buyer' },
];

let server: Server;
let baseUrl: string;
const jobRepo = new MemoryJobRepository();

describe('job criteria exchange (R-8)', () => {
  beforeAll(async () => {
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:op-criteria',
      delegation: delegationFixture() as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    server = createApp(new MemoryOperatorRepository(), agentRepo, undefined, undefined, jobRepo).listen(0);
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

  it('loops propose -> request-changes -> re-propose on ONE job row', async () => {
    const createSpy = vi.spyOn(jobRepo, 'create');

    // 1. The draft opens with exactly the pinned eight-key projection.
    const draft = await post('/jobs', {
      buyerDid: BUYER_DID,
      agentDid: AGENT_DID,
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug on the checkout page',
    });
    expect(draft.status).toBe(201);
    const draftBody = (await draft.json()) as Record<string, unknown>;
    expect(draftBody.status).toBe('draft');
    expect(Object.keys(draftBody).sort()).toEqual([
      'agentDid',
      'brief',
      'briefHash',
      'buyerDid',
      'createdAt',
      'id',
      'repository',
      'status',
    ]);
    const jobId = String(draftBody.id);

    // 2. The agent proposes: draft -> proposed, texts trimmed, nothing
    // accepted yet, same id.
    const proposed = await post(`/jobs/${jobId}/criteria`, { criteria: firstProposal });
    expect(proposed.status).toBe(200);
    const proposedBody = (await proposed.json()) as Record<string, unknown>;
    expect(proposedBody.id).toBe(jobId);
    expect(proposedBody.status).toBe('proposed');
    expect(proposedBody.criteria).toEqual([
      { text: 'The login bug is fixed', proposedBy: 'agent', accepted: false },
      { text: 'Checkout e2e test passes', proposedBy: 'agent', accepted: false },
    ]);

    // 3. The buyer pushes back: still proposed, still the same job.
    const pushback = await post(`/jobs/${jobId}/request-changes`, {});
    expect(pushback.status).toBe(200);
    const pushbackBody = (await pushback.json()) as Record<string, unknown>;
    expect(pushbackBody.id).toBe(jobId);
    expect(pushbackBody.status).toBe('proposed');
    expect(pushbackBody.criteria).toEqual(proposedBody.criteria);

    // 4. The agent re-proposes: still proposed, same id, list replaced -
    // the loop ran twice without creating a job.
    const again = await post(`/jobs/${jobId}/criteria`, { criteria: revisedProposal });
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as Record<string, unknown>;
    expect(againBody.id).toBe(jobId);
    expect(againBody.status).toBe('proposed');
    expect(againBody.criteria).toEqual([
      { text: 'One sharper criterion', proposedBy: 'agent', accepted: false },
      { text: 'Deploy notes updated', proposedBy: 'buyer', accepted: false },
    ]);

    // 5. Read-back: every identity field is the draft's own - same id, same
    // createdAt - apart from status and the criteria now riding along. A
    // second row would carry a later createdAt or a different id.
    const read = await get(`/jobs/${jobId}`);
    expect(read.status).toBe(200);
    const readBack = (await read.json()) as Record<string, unknown>;
    expect(readBack).toEqual({
      ...draftBody,
      status: 'proposed',
      criteria: againBody.criteria,
    });

    // 6. And storage agrees: exactly one create across the whole loop.
    expect(createSpy).toHaveBeenCalledTimes(1);
    createSpy.mockRestore();
  });

  it('rejects a malformed body with 400', async () => {
    const seed = await post('/jobs', {
      buyerDid: BUYER_DID,
      agentDid: AGENT_DID,
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug',
    });
    const jobId = String(((await seed.json()) as Record<string, unknown>).id);

    const missingField = await post(`/jobs/${jobId}/criteria`, {});
    expect(missingField.status).toBe(400);

    const notAnArray = await post(`/jobs/${jobId}/criteria`, { criteria: 'fix it' });
    expect(notAnArray.status).toBe(400);

    const missingText = await post(`/jobs/${jobId}/criteria`, { criteria: [{ proposedBy: 'agent' }] });
    expect(missingText.status).toBe(400);

    const numericText = await post(`/jobs/${jobId}/criteria`, { criteria: [{ text: 7, proposedBy: 'agent' }] });
    expect(numericText.status).toBe(400);

    const badProposerShape = await post(`/jobs/${jobId}/criteria`, { criteria: [{ text: 'ok', proposedBy: 9 }] });
    expect(badProposerShape.status).toBe(400);

    // The element guard is a conjunction of five conditions, and each one
    // gets a named input here. null is typeof "object", so only the c !==
    // null conjunct rejects it - without that conjunct the request reaches
    // .text on null and crashes the handler instead of answering 400. A
    // nested array is an object and non-null, so only !Array.isArray(c)
    // rejects it. A number fails typeof c === 'object', the guard's first
    // conjunct.
    const nullElement = await post(`/jobs/${jobId}/criteria`, { criteria: [null] });
    expect(nullElement.status).toBe(400);

    const nestedArrayElement = await post(`/jobs/${jobId}/criteria`, {
      criteria: [[{ text: 'ok', proposedBy: 'agent' }]],
    });
    expect(nestedArrayElement.status).toBe(400);

    const numberElement = await post(`/jobs/${jobId}/criteria`, { criteria: [7] });
    expect(numberElement.status).toBe(400);

    // An empty list is well-shaped but fails the domain's own rule, which
    // the route maps to 400 with the domain's wording.
    const emptyList = await post(`/jobs/${jobId}/criteria`, { criteria: [] });
    expect(emptyList.status).toBe(400);
    const body = (await emptyList.json()) as { error: string };
    expect(body.error).toBe('a proposal needs at least one acceptance criterion');
  });

  it('answers 404 for an unknown job id on both routes', async () => {
    const propose = await post('/jobs/j-nowhere/criteria', { criteria: firstProposal });
    expect(propose.status).toBe(404);
    expect(await propose.json()).toEqual({ error: 'not found' });

    const pushback = await post('/jobs/j-nowhere/request-changes', {});
    expect(pushback.status).toBe(404);
    expect(await pushback.json()).toEqual({ error: 'not found' });
  });

  it('answers 409 when the exchange runs against a job not in the exchange', async () => {
    // A confirmed job's criteria are immutable (D2), so proposing is a
    // conflict. The row is seeded straight into storage as the fixture for
    // that state.
    const draft = createJob(
      { id: 'j-conflicted', buyerDid: BUYER_DID, agentDid: AGENT_DID, repository: 'buyer/target-repo', brief: 'Fix the login bug' },
      new Date('2026-01-01T00:00:00Z'),
    );
    const proposedJob: Job = proposeCriteria(draft, firstProposal);
    await jobRepo.create(confirmSpec(acceptCriterion(acceptCriterion(proposedJob, 0), 1), new Date()));

    const proposeOnConfirmed = await post('/jobs/j-conflicted/criteria', { criteria: firstProposal });
    expect(proposeOnConfirmed.status).toBe(409);

    // A draft has no proposal to push back on: also a conflict.
    const draftRow = await post('/jobs', {
      buyerDid: BUYER_DID,
      agentDid: AGENT_DID,
      repository: 'buyer/target-repo',
      brief: 'Another brief',
    });
    const draftId = String(((await draftRow.json()) as Record<string, unknown>).id);
    const pushbackOnDraft = await post(`/jobs/${draftId}/request-changes`, {});
    expect(pushbackOnDraft.status).toBe(409);
  });

  it('answers 503 with the same wording as POST /jobs when storage fails', async () => {
    class FailingRead implements JobRepository {
      async create(): Promise<never> {
        throw new Error('db down');
      }
      async update(): Promise<null> {
        return null;
      }
      async complete(): Promise<null> {
        return null;
      }
      async findCompletedByJobId(): Promise<null> {
        return null;
      }
      async findById(): Promise<never> {
        throw new Error('db down');
      }
    }
    const failingServer = createApp(
      new MemoryOperatorRepository(),
      new MemoryAgentRepository(),
      undefined,
      undefined,
      new FailingRead(),
    ).listen(0);
    await new Promise<void>((resolve) => failingServer.once('listening', resolve));
    const address = failingServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }

    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/jobs/j-any/criteria`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ criteria: firstProposal }),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'storage unavailable' });
      expect(errorLog).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve) => failingServer.close(() => resolve()));
    }
  });

  // The write leg has its own two outcomes, and each gets a scripted repo:
  // update reporting the row gone is a 404, update throwing is a 503. The
  // read-fault test above never reaches either, so without these the whole
  // second half of runExchange could be deleted and every existing test
  // would stay green.
  it('answers 404 when the row vanishes between read and update', async () => {
    class VanishingUpdate implements JobRepository {
      readonly calls: string[] = [];
      constructor(private readonly row: Job) {}
      async create(job: Job): Promise<Job> {
        return job;
      }
      async findById(): Promise<Job> {
        this.calls.push('findById');
        return this.row;
      }
      async update(): Promise<null> {
        this.calls.push('update');
        return null;
      }
      async complete(): Promise<null> {
        return null;
      }
      async findCompletedByJobId(): Promise<null> {
        return null;
      }
    }
    const repo = new VanishingUpdate(draftRow('j-vanish'));
    const { server: vanishingServer, baseUrl: vanishingUrl } = await startWith(repo);
    try {
      const res = await fetch(`${vanishingUrl}/jobs/j-vanish/criteria`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ criteria: firstProposal }),
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not found' });
      // Both legs ran: findById found the row, then update reported it gone.
      // A request for an unknown id stops after findById, so the call log is
      // what pins this response to the vanished-at-update branch rather than
      // the unknown-id one - same status, different branch, and deleting
      // this one changes nothing else observable.
      expect(repo.calls).toEqual(['findById', 'update']);
    } finally {
      await new Promise<void>((resolve) => vanishingServer.close(() => resolve()));
    }
  });

  it('answers 503 when update throws after a successful read', async () => {
    class ThrowingUpdate implements JobRepository {
      async create(): Promise<never> {
        throw new Error('db down');
      }
      async update(): Promise<never> {
        throw new Error('db down');
      }
      async complete(): Promise<never> {
        throw new Error('unreachable');
      }
      async findCompletedByJobId(): Promise<never> {
        throw new Error('unreachable');
      }
      async findById(): Promise<Job> {
        return draftRow('j-throws');
      }
    }
    const { server: throwingServer, baseUrl: throwingUrl } = await startWith(new ThrowingUpdate());
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await fetch(`${throwingUrl}/jobs/j-throws/criteria`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ criteria: firstProposal }),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'storage unavailable' });
      // The read succeeded here (the test above faults the read), so this
      // log entry can only come from the write leg's catch. With both legs
      // covered, neither catch is deletable by anyone.
      expect(errorLog).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve) => throwingServer.close(() => resolve()));
    }
  });

  // The rethrow for a fault that is neither a JobError nor a
  // JobTransitionError. A stored row that is not really a Job makes
  // requestChanges throw a TypeError mapping its criteria, which no route
  // input could otherwise produce; express 4 cannot route such a rejection
  // on its own, so the forwarded handler hands it to the terminal error
  // layer, which answers 500 with nothing of the cause in the body.
  it('rethrows an unexpected domain fault as a 500 through the error layer', async () => {
    class CorruptedRow implements JobRepository {
      async create(): Promise<never> {
        throw new Error('unreachable');
      }
      async update(): Promise<null> {
        return null;
      }
      async complete(): Promise<null> {
        return null;
      }
      async findCompletedByJobId(): Promise<null> {
        return null;
      }
      async findById(): Promise<Job> {
        return { ...draftRow('j-corrupt'), status: 'proposed', criteria: null } as unknown as Job;
      }
    }
    const { server: corruptedServer, baseUrl: corruptedUrl } = await startWith(new CorruptedRow());
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await fetch(`${corruptedUrl}/jobs/j-corrupt/request-changes`, { method: 'POST' });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal error' });
      // Same terms as every other unmapped fault: cause in the log, not the
      // body.
      expect(errorLog).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve) => corruptedServer.close(() => resolve()));
    }
  });
});
