// R-23: GET /capabilities is the conformance test that the declared boundary
// in src/domain/access.ts matches how the routes actually behave. Clause 3 of
// R-23's accept line ("the limit is stated before a user invests effort")
// means nothing if the document and the routes can drift apart, so this file
// checks both directions: the document is readable with no identity, and
// every route it describes actually behaves the way it says.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { ACCESS_NOTICE, CAPABILITIES, capabilityFor, requiresIdentity } from '../../src/domain/access.js';

// A valid body for each identified capability, minus its own identityField,
// so the test isolates what the missing identityField alone does. Every
// other field the route requires is present and well-formed.
const VALID_BODY_MINUS_IDENTITY: Record<string, Record<string, unknown>> = {
  'operator.register': { githubLogin: 'capabilities-test-operator' },
  'agent.list': { operator: 'did:abt:capabilities-test-operator', name: 'Capabilities Test Agent', skills: ['coding'] },
  'job.hire': {
    agentDid: 'did:abt:capabilities-test-agent',
    repository: 'buyer/target-repo',
    brief: 'A brief for the capabilities conformance test.',
  },
};

function listen(app: Express): Promise<Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}

function portOf(srv: Server): number {
  return (srv.address() as AddressInfo).port;
}

describe('GET /capabilities', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = await listen(createApp());
    baseUrl = `http://127.0.0.1:${portOf(server)}`;
  });

  afterAll(() => {
    server.close();
  });

  it('answers with no headers at all, states the notice, and lists every capability', async () => {
    // This is the assertion that fails on the base branch (the route 404s)
    // and passes with the change.
    const res = await fetch(`${baseUrl}/capabilities`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notice: string; capabilities: unknown[] };
    expect(body.notice).toBe(ACCESS_NOTICE);
    expect(body.capabilities).toHaveLength(7);
  });

  it('every declared public GET answers a caller with no identity', async () => {
    const publicGets = CAPABILITIES.filter((c) => c.access === 'public' && c.method === 'GET');
    expect(publicGets.length).toBeGreaterThan(0);
    for (const cap of publicGets) {
      const concretePath = cap.path.replace(/:[^/]+/g, 'capabilities-test-placeholder');
      const res = await fetch(`${baseUrl}${concretePath}`);
      // A 404 is a pass: it proves the refusal is about the row (an unknown
      // id), not about who asked.
      expect([401, 403]).not.toContain(res.status);
    }
  });

  it('every declared identified POST refuses a caller who names no one', async () => {
    const identifiedPosts = CAPABILITIES.filter((c) => c.access === 'identified' && c.method === 'POST');
    expect(identifiedPosts.length).toBeGreaterThan(0);
    for (const cap of identifiedPosts) {
      const body = VALID_BODY_MINUS_IDENTITY[cap.id];
      expect(body, `no fixture body registered for ${cap.id}`).toBeDefined();
      const res = await fetch(`${baseUrl}${cap.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status, `${cap.id} should refuse a body missing ${cap.identityField}`).toBe(400);
      const parsed = (await res.json()) as { error?: unknown };
      expect(typeof parsed.error).toBe('string');
      expect((parsed.error as string).length).toBeGreaterThan(0);
    }
  });

  it('the declaration and the domain helper agree', () => {
    expect(capabilityFor('POST', '/jobs')?.access).toBe('identified');
    expect(requiresIdentity('GET', '/agents/:agentDid')).toBe(false);
  });
});
