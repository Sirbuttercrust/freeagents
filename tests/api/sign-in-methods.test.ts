// Issue 84: GET /sign-in-methods is the conformance test that the declared
// data in src/domain/sign-in-methods.ts is what the route actually serves,
// mirroring tests/api/capabilities.test.ts for GET /capabilities.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { SIGN_IN_METHODS } from '../../src/domain/sign-in-methods.js';

function listen(app: Express): Promise<Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}

function portOf(srv: Server): number {
  return (srv.address() as AddressInfo).port;
}

describe('GET /sign-in-methods', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = await listen(createApp());
    baseUrl = `http://127.0.0.1:${portOf(server)}`;
  });

  afterAll(() => {
    server.close();
  });

  it('answers with no headers at all and lists every declared method', async () => {
    const res = await fetch(`${baseUrl}/sign-in-methods`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { methods: unknown[] };
    expect(body.methods).toHaveLength(SIGN_IN_METHODS.length);
  });

  it('pins the response key set exactly, not a subset', async () => {
    const res = await fetch(`${baseUrl}/sign-in-methods`);
    const body = (await res.json()) as { methods: Array<Record<string, unknown>> };
    expect(Object.keys(body).sort()).toEqual(['methods']);
    for (const method of body.methods) {
      expect(Object.keys(method).sort()).toEqual(['id', 'label', 'reason', 'required', 'walletBased']);
    }
  });

  it('serves the declared values verbatim, not just the declared key set', async () => {
    const res = await fetch(`${baseUrl}/sign-in-methods`);
    const body = (await res.json()) as { methods: unknown };
    expect(body.methods).toEqual(SIGN_IN_METHODS);
  });
});
