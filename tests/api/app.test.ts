import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { MemoryOperatorRepository } from '../../src/adapters/storage/memory.js';

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
});
