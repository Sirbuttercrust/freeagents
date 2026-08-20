import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { MemoryOperatorRepository } from '../../src/adapters/storage/memory.js';
import type { OperatorRepository } from '../../src/adapters/storage/types.js';

// An explicit memory repository: the existing its must stay deterministic
// under any runner environment, whether or not DATABASE_URL is exported.
describe('app', () => {
  let server: Server;
  let baseUrl: string;
  const repo = new MemoryOperatorRepository();

  beforeAll(async () => {
    server = createApp(repo).listen(0);
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
    const response = await fetch(`${baseUrl}/jobs`, { method: 'POST' });
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
});
