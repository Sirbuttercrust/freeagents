import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryOperatorRepository } from '../../src/adapters/storage/memory.js';
import type { AgentRepository, JobRepository, OperatorRepository } from '../../src/adapters/storage/types.js';
import type { Delegation } from '../../src/domain/agent.js';

// The one agent every job test hires against. It is planted straight into
// the memory repository rather than walked through POST /agents, because
// delegation is R-2's surface with its own suite; what this file proves is
// that a job draft requires an agent that EXISTS (the driver asymmetry the
// route closes), not that delegation works again.
const AGENT_DID = 'did:abt:agent-jobs';

function delegationFixture(): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-jobs',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: 'did:abt:op-jobs',
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

async function postJob(baseUrl: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// An explicit memory repository: the existing its must stay deterministic
// under any runner environment, whether or not DATABASE_URL is exported.
describe('app', () => {
  let server: Server;
  let baseUrl: string;
  const repo = new MemoryOperatorRepository();
  const agentRepo = new MemoryAgentRepository();

  beforeAll(async () => {
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:op-jobs',
      delegation: delegationFixture(),
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    server = createApp(repo, agentRepo).listen(0);
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

  it('reports healthy', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('returns 501 for hire loop route stubs', async () => {
    // POST /jobs left this post when R-28 implemented it; the surviving
    // stubs stay honest, asserted through one of them.
    const confirmPath = '/jobs/j1/confirm';
    const response = await fetch(`${baseUrl}${confirmPath}`, { method: 'POST' });
    expect(response.status).toBe(501);
  });

  it('registers an operator and reads it back with the same body', async () => {
    const created = await fetch(`${baseUrl}/operators`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: 'did:abt:api-1', githubLogin: 'operator-api-1' }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as Record<string, unknown>;
    expect(body.did).toBe('did:abt:api-1');

    const read = await fetch(`${baseUrl}/operators/did:abt:api-1`);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(body);
  });

  it('returns 404 for an unregistered operator DID', async () => {
    const response = await fetch(`${baseUrl}/operators/did:abt:never-registered`);
    expect(response.status).toBe(404);
  });

  it('returns 400 for a DID of the wrong method', async () => {
    const response = await fetch(`${baseUrl}/operators`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: 'did:eth:api-2', githubLogin: 'operator-api-2' }),
    });
    expect(response.status).toBe(400);
  });

  it('returns 400 when githubLogin is missing', async () => {
    const response = await fetch(`${baseUrl}/operators`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: 'did:abt:api-3' }),
    });
    expect(response.status).toBe(400);
  });

  // The 400 guard is a conjunction of four conditions: typeof did,
  // typeof githubLogin, did.length, githubLogin.length. Each conjunct needs
  // its own test: with any one deleted, its input falls through to the next
  // check and the response changes (or the repository is called with the
  // wrong shape), so a test per conjunct is what makes the whole guard
  // non-deletable.
  it('returns 400 when did is not a string (number)', async () => {
    const response = await fetch(`${baseUrl}/operators`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: 42, githubLogin: 'operator-api-4' }),
    });
    expect(response.status).toBe(400);
  });

  it('returns 400 when did is not a string (null)', async () => {
    const response = await fetch(`${baseUrl}/operators`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: null, githubLogin: 'operator-api-5' }),
    });
    expect(response.status).toBe(400);
  });

  it('returns 400 when did is empty', async () => {
    // A well-typed string that fails the length conjunct: without the
    // did.length === 0 clause this would reach the DID-shape check and still
    // be a 400, but for a different reason with a different body.
    const response = await fetch(`${baseUrl}/operators`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: '', githubLogin: 'operator-api-6' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'body must be { did, githubLogin }; both are non-empty strings',
    });
  });

  it('returns 400 when githubLogin is not a string (number)', async () => {
    // The valid did here isolates the githubLogin conjunct: did passes both
    // its checks, so a 400 can only come from the login side of the guard.
    const response = await fetch(`${baseUrl}/operators`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: 'did:abt:api-7', githubLogin: 42 }),
    });
    expect(response.status).toBe(400);
  });

  it('returns 400 when githubLogin is empty', async () => {
    const response = await fetch(`${baseUrl}/operators`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: 'did:abt:api-8', githubLogin: '' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'body must be { did, githubLogin }; both are non-empty strings',
    });
  });

  it('returns 409 when the same DID is registered twice', async () => {
    const first = await fetch(`${baseUrl}/operators`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: 'did:abt:api-dup', githubLogin: 'operator-api-dup' }),
    });
    expect(first.status).toBe(201);

    const second = await fetch(`${baseUrl}/operators`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: 'did:abt:api-dup', githubLogin: 'operator-api-dup' }),
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      error: 'operator did:abt:api-dup is already registered',
    });

    // The original registration survives the conflict.
    const read = await fetch(`${baseUrl}/operators/did:abt:api-dup`);
    expect(read.status).toBe(200);
  });

  // The POST /jobs guard is a conjunction of eight conditions: typeof and
  // length for each of buyerDid, agentDid, repository, brief. Each conjunct
  // gets its own test: with any one deleted, its input falls through to a
  // later check that still rejects it, but for the wrong reason with a
  // different body - so a test per conjunct is what makes the whole guard
  // non-deletable.
  it('opens a draft job from a brief', async () => {
    const created = await postJob(baseUrl, {
      buyerDid: 'did:abt:buyer-jobs',
      agentDid: AGENT_DID,
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug on the checkout page',
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'agentDid',
      'brief',
      'briefHash',
      'buyerDid',
      'createdAt',
      'id',
      'repository',
      'status',
    ]);
    expect(body.status).toBe('draft');
    expect(typeof body.id).toBe('string');
    expect(body.id).toMatch(/^j-/);
  });

  it('returns 400 when buyerDid is not a string (number)', async () => {
    // Every other field is valid, so if the typeof buyerDid conjunct were
    // deleted this input would reach the DID-shape check and still be a 400,
    // but with the wrong body for the wrong reason.
    const response = await postJob(baseUrl, {
      buyerDid: 42,
      agentDid: AGENT_DID,
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug',
    });
    expect(response.status).toBe(400);
  });

  it('returns 400 when agentDid is not a string (null)', async () => {
    // null.length is a TypeError, not false, so deleting the typeof agentDid
    // conjunct would turn this request into a crashed handler rather than a
    // clean 400.
    const response = await postJob(baseUrl, {
      buyerDid: 'did:abt:buyer-jobs',
      agentDid: null,
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug',
    });
    expect(response.status).toBe(400);
  });

  it('returns 400 when repository is not a string (number)', async () => {
    // With the typeof repository conjunct deleted, 42 would fall to the
    // owner/name regex, whose .test would coerce it to '42' - no slash - and
    // reject it there. Same status, different rule: the test pins which rule.
    const response = await postJob(baseUrl, {
      buyerDid: 'did:abt:buyer-jobs',
      agentDid: AGENT_DID,
      repository: 42,
      brief: 'Fix the login bug',
    });
    expect(response.status).toBe(400);
  });

  it('returns 400 when brief is not a string (number)', async () => {
    // A numeric brief must stop at the shape guard: past it, createJob would
    // call hashSpec on it and store garbage under a hash of '[object
    // Object]'-adjacent coercions.
    const response = await postJob(baseUrl, {
      buyerDid: 'did:abt:buyer-jobs',
      agentDid: AGENT_DID,
      repository: 'buyer/target-repo',
      brief: 42,
    });
    expect(response.status).toBe(400);
  });

  it('returns 400 when brief is an empty string', async () => {
    const response = await postJob(baseUrl, {
      buyerDid: 'did:abt:buyer-jobs',
      agentDid: AGENT_DID,
      repository: 'buyer/target-repo',
      brief: '',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'body must be { buyerDid, agentDid, repository, brief }; all are non-empty strings',
    });
  });

  it('returns 400 when brief is whitespace-only, mapped from the domain rule', async () => {
    // This one passes every route-level check - well-typed, non-empty,
    // valid DIDs, parseable repository, existing agent - because '   ' has a
    // non-zero length. The 400 comes from createJob throwing JobError, the
    // delegated rule, proving the route delegates emptiness to the domain
    // instead of restating it: trim here and the domain rule becomes dead
    // code that no test can catch deleting.
    const response = await postJob(baseUrl, {
      buyerDid: 'did:abt:buyer-jobs',
      agentDid: AGENT_DID,
      repository: 'buyer/target-repo',
      brief: '   \n\t ',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'a job needs a brief: what should the agent do?',
    });
  });

  it('returns 400 when buyerDid is a DID of the wrong method', async () => {
    // did:eth:x passes the shape guard (non-empty string) so this input
    // isolates the isValidOperatorDid conjunct.
    const response = await postJob(baseUrl, {
      buyerDid: 'did:eth:x',
      agentDid: AGENT_DID,
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'buyerDid and agentDid must look like did:abt:<suffix>, non-empty suffix, no whitespace',
    });
  });

  it("returns 400 when repository is not owner/name ('not-a-repo')", async () => {
    // Syntactic only (ENT-4): the route makes no GitHub calls, but letting
    // 'not-a-repo' through would surface the mistake at PR time where it is
    // nobody's job.
    const response = await postJob(baseUrl, {
      buyerDid: 'did:abt:buyer-jobs',
      agentDid: AGENT_DID,
      repository: 'not-a-repo',
      brief: 'Fix the login bug',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'repository must be an owner/name pair like buyer/target-repo',
    });
  });

  it('returns 404 when the agent was never delegated, naming the DID', async () => {
    // Memory storage accepts an unknown agentDid happily while Prisma's
    // foreign key rejects it; the explicit pre-check here is what keeps the
    // two drivers answering identically (the asymmetry the route closes).
    const response = await postJob(baseUrl, {
      buyerDid: 'did:abt:buyer-jobs',
      agentDid: 'did:abt:no-such-agent',
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug',
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toContain('did:abt:no-such-agent');
  });
});

// The 503 branches and the default parameter need a repository that decides
// what it throws per call, so they get their own server, built with
// createApp(throwingRepo) and a scripted fault.
describe('app, storage failures', () => {
  const registerError = new Error('connection refused');

  class FailingRepository implements OperatorRepository {
    async register(): Promise<never> {
      throw registerError;
    }
    async findByDid(): Promise<never> {
      throw registerError;
    }
  }

  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createApp(new FailingRepository()).listen(0);
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

  it('POST /operators answers 503, not 400 or 409, when storage throws a non-duplicate error', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await fetch(`${baseUrl}/operators`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: 'did:abt:api-down', githubLogin: 'operator-api-down' }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'storage unavailable' });
    // The cause goes to the log, not the body: the body must not reveal
    // what the database said.
    expect(errorLog).toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it('GET /operators/:did answers 503, not 404, when storage throws', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await fetch(`${baseUrl}/operators/did:abt:api-down`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'storage unavailable' });
    expect(errorLog).toHaveBeenCalled();
    errorLog.mockRestore();
  });
});

// The job routes fail closed on the same terms as every other route: a dead
// database is a 503 with the cause in the log, never in the body, whichever
// leg failed - looking up the agent, writing the draft, or reading one back.
// Each fault gets its own server because the three legs live behind
// different repositories.
describe('app, job storage failures', () => {
  const failure = new Error('connection refused');

  class FailingAgentLookup implements AgentRepository {
    async create(): Promise<never> {
      throw failure;
    }
    async findByDid(): Promise<never> {
      throw failure;
    }
    async updateGithubBinding(): Promise<never> {
      throw failure;
    }
    async recordKeyRotation(): Promise<never> {
      throw failure;
    }
  }

  class FailingJobRepository implements JobRepository {
    async create(): Promise<never> {
      throw failure;
    }
    async update(): Promise<never> {
      throw failure;
    }
    async findById(): Promise<never> {
      throw failure;
    }
  }

  let lookupServer: Server;
  let createServer: Server;
  let readServer: Server;
  let lookupUrl: string;
  let createUrl: string;
  let readUrl: string;

  beforeAll(async () => {
    // The write-fault server needs an agent that EXISTS, so its healthy
    // memory agent repo is seeded; only jobRepo.create then can fail.
    const seededAgentRepo = new MemoryAgentRepository();
    await seededAgentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:op-jobs',
      delegation: delegationFixture(),
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });

    const start = async (app: ReturnType<typeof createApp>): Promise<[Server, string]> => {
      const s = app.listen(0);
      await new Promise<void>((resolve) => s.once('listening', resolve));
      const address = s.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected server to listen on a port');
      }
      return [s, `http://127.0.0.1:${address.port}`];
    };

    [lookupServer, lookupUrl] = await start(
      // undefined keeps the defaulted identity/github parameters; only the
      // agent repository is faulted.
      createApp(new MemoryOperatorRepository(), new FailingAgentLookup()),
    );
    [createServer, createUrl] = await start(
      createApp(
        new MemoryOperatorRepository(),
        seededAgentRepo,
        undefined,
        undefined,
        new FailingJobRepository(),
      ),
    );
    [readServer, readUrl] = await start(
      createApp(new MemoryOperatorRepository(), new MemoryAgentRepository(), undefined, undefined, new FailingJobRepository()),
    );
  });

  afterAll(() => {
    lookupServer.close();
    createServer.close();
    readServer.close();
  });

  it('POST /jobs answers 503 when looking up the agent throws', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await postJob(lookupUrl, {
      buyerDid: 'did:abt:buyer-jobs',
      agentDid: AGENT_DID,
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug',
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'storage unavailable' });
    errorLog.mockRestore();
  });

  it('POST /jobs answers 503 when writing the draft throws', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await postJob(createUrl, {
      buyerDid: 'did:abt:buyer-jobs',
      agentDid: AGENT_DID,
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug',
    });
    expect(response.status).toBe(503);
    // The body is exactly this pair of words: what the database said stays
    // in the log.
    expect(await response.json()).toEqual({ error: 'storage unavailable' });
    expect(errorLog).toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it('GET /jobs/:jobId answers 503 when reading back throws', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await fetch(`${readUrl}/jobs/j-does-not-matter`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'storage unavailable' });
    expect(errorLog).toHaveBeenCalled();
    errorLog.mockRestore();
  });
});

// createApp() with no argument is the path src/api/server.ts takes. Every
// other test injects an explicit repository, so the default parameter was
// previously dead code as far as the suite was concerned: a change that made
// the no-argument call throw, or selected a broken driver, would fail nothing.
describe('app, default storage parameter', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    // DATABASE_URL unset: the factory announces the in-memory choice and the
    // app must boot and serve with it, exactly as server.ts does in dev.
    const originalUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    server = createApp().listen(0);
    warn.mockRestore();
    if (originalUrl !== undefined) {
      process.env.DATABASE_URL = originalUrl;
    }
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

  it('boots without an injected repository and serves the operator flow', async () => {
    const created = await fetch(`${baseUrl}/operators`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: 'did:abt:default-1', githubLogin: 'operator-default-1' }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as Record<string, unknown>;
    expect(body.did).toBe('did:abt:default-1');

    const read = await fetch(`${baseUrl}/operators/did:abt:default-1`);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(body);
  });

  it('constructs the fifth storage parameter and serves the job routes with it', async () => {
    // createApp() builds jobRepo = createJobRepository() internally; the
    // read-back here is the proof its default was constructed and answers:
    // an unthrown 404 means findById ran against real (memory) storage.
    const missing = await fetch(`${baseUrl}/jobs/j-not-there`);
    expect(missing.status).toBe(404);

    // The draft path also runs end to end on default storage; it stops at
    // the agent pre-check because this server's agent repo is unreachable
    // from outside, which is the route working, not a fault.
    const noAgent = await postJob(baseUrl, {
      buyerDid: 'did:abt:buyer-default',
      agentDid: 'did:abt:no-such-agent',
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug',
    });
    expect(noAgent.status).toBe(404);
  });
});
