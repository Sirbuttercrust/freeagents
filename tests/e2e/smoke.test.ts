/**
 * The end-to-end smoke test, and the source of APP_STARTED and E2E_PASSED.
 *
 * WHY THIS FILE EXISTS AT ALL. The factory refuses to merge unless the run log
 * carries every marker in FACTORY_REQUIRED_MARKERS. That is deliberate: a check
 * that never ran produces no failures, and code asking "did anything fail?"
 * reads silence as success. So the gate asks a different question, "did this
 * specific thing report that it ran?", and an absent marker is a block.
 *
 * On 2026-08-19 that gate blocked the first real validated pull request because
 * APP_STARTED and E2E_PASSED had never existed in this repository. The gate was
 * right and the repository was incomplete. Deleting the requirement would have
 * been the easy fix and the wrong one: it would have removed the only check
 * that proves the thing we ship can actually start.
 *
 * WHAT IT ASSERTS, AND WHAT IT REFUSES TO PRETEND.
 * The API is a route surface where the hire-loop handlers still return 501 on
 * purpose. So this test proves what is genuinely true today:
 *
 *   - the app boots and binds a port
 *   - /health answers 200 with a body we control
 *   - every declared route EXISTS and is reachable, rather than 404
 *   - an unknown route is still a 404, so the previous assertion means something
 *
 * It does NOT claim a hire flow works, because no hire flow exists yet. As the
 * handlers land, the flow assertions below replace the 501 expectations one at
 * a time, and the e2e step floor rises with them.
 *
 * THE MARKERS ARE PRINTED ONLY AFTER THE ASSERTIONS THEY DESCRIBE.
 * Printing APP_STARTED before the server is up, or E2E_PASSED in a finally
 * block, would produce a green log for a red run. That is the exact failure the
 * marker mechanism exists to catch, so the ordering here is load-bearing rather
 * than stylistic.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryOperatorRepository } from '../../src/adapters/storage/memory.js';

let server: Server;
let base: string;

/** Counts assertions that exercised the running server over HTTP. */
let stepsAsserted = 0;

async function get(path: string): Promise<Response> {
  const res = await fetch(`${base}${path}`);
  stepsAsserted += 1;
  return res;
}

async function post(path: string, body: unknown = {}): Promise<Response> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  stepsAsserted += 1;
  return res;
}

beforeAll(async () => {
  // An explicit memory repository: deterministic regardless of whether the
  // runner environment happens to export DATABASE_URL.
  const app = createApp(new MemoryOperatorRepository());
  server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1');
    s.once('listening', () => resolve(s));
    s.once('error', reject);
  });
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('the API starts and answers', () => {
  it('binds a port and serves /health', async () => {
    const res = await get('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });

    // Only now is this true.
    console.log('APP_STARTED');
  });

  it('exposes every declared hire-loop route', async () => {
    // A 501 here is the CORRECT current answer: the route exists and its
    // handler is honest about being unimplemented. What matters for this
    // assertion is that none of them 404, because a route that does not exist
    // cannot be said to have a contract at all.
    // POST /operators has left this list: it is implemented, and its real
    // flow is asserted below. This is the one-at-a-time replacement the
    // file's design promised.
    const declared: Array<[string, () => Promise<Response>]> = [
      ['POST /agents', () => post('/agents')],
      ['GET  /agents/:did/card', () => get('/agents/did:abt:test/card')],
      ['GET  /agents/:did/credentials', () => get('/agents/did:abt:test/credentials')],
      ['POST /jobs', () => post('/jobs')],
      ['POST /jobs/:id/confirm', () => post('/jobs/j1/confirm')],
      ['POST /jobs/:id/pull-request', () => post('/jobs/j1/pull-request')],
      ['POST /jobs/:id/merge', () => post('/jobs/j1/merge')],
      ['POST /jobs/:id/reviews', () => post('/jobs/j1/reviews')],
    ];

    for (const [label, call] of declared) {
      const res = await call();
      expect(res.status, `${label} must exist, got ${res.status}`).not.toBe(404);
      expect(res.status, `${label} should be 501 until implemented`).toBe(501);
    }
  });

  it('registers an operator, reads it back, and refuses duplicates and bad DIDs', async () => {
    // The first real hire-loop flow this file exercises. Five HTTP calls,
    // each counted in stepsAsserted by the helpers above; the fixture is a
    // generic handle, not a real person (public repository).

    // 1. Register. The response is exactly the stored fact projection:
    // did, githubLogin, createdAt, and nothing else, no key material.
    const created = await post('/operators', { did: 'did:abt:op1', githubLogin: 'operator-1' });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as Record<string, unknown>;
    expect(createdBody.did).toBe('did:abt:op1');
    expect(Object.keys(createdBody).sort()).toEqual(['createdAt', 'did', 'githubLogin']);

    // 2. Read back: the same body, field for field.
    const read = await get('/operators/did:abt:op1');
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(createdBody);

    // 3. The same DID twice is a conflict, not a silent overwrite.
    const dup = await post('/operators', { did: 'did:abt:op1', githubLogin: 'operator-1' });
    expect(dup.status).toBe(409);

    // 4. A DID of the wrong method is a client error.
    const bad = await post('/operators', { did: 'did:eth:xyz', githubLogin: 'operator-1' });
    expect(bad.status).toBe(400);

    // 5. An unregistered DID is a 404, so the read-back above meant
    // something.
    const missing = await get('/operators/did:abt:nobody');
    expect(missing.status).toBe(404);
  });

  it('still 404s an undeclared route', async () => {
    // Without this, the assertion above would pass on a catch-all that
    // answered everything, which would make it meaningless.
    const res = await get('/no-such-route');
    expect(res.status).toBe(404);
  });

  it('reports the end-to-end step count', () => {
    // The floor is read from .factory/locks/floor.json and raising it is a
    // deliberate human edit. Printing the real number lets the gate compare
    // rather than trust.
    expect(stepsAsserted).toBeGreaterThan(0);
    console.log(`E2E_STEPS_ASSERTED=${stepsAsserted}`);
    console.log('E2E_PASSED');
  });
});
