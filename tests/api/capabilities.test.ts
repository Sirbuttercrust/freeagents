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
import { mintSessionToken, testSessionAdapter } from '../helpers/session-fixtures.js';
import type { SessionAdapter } from '../../src/adapters/identity/session.js';

// A valid body for each identified capability, minus its own identityField,
// so the test isolates what the missing identityField alone does. Every
// other field the route requires is present and well-formed.
const VALID_BODY_MINUS_IDENTITY: Record<string, Record<string, unknown>> = {
  'operator.register': { githubLogin: 'capabilities-test-operator' },
  // agent.list's identityField is 'operator': every other required field,
  // including delegation, is present and well-formed here, so a 400 below
  // can only be explained by the missing operator - not by delegation also
  // being absent (that would prove nothing about operator specifically).
  'agent.list': {
    did: 'did:abt:capabilities-test-agent',
    name: 'Capabilities Test Agent',
    skills: ['coding'],
    delegation: {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      id: 'urn:uuid:capabilities-test-delegation',
      type: ['VerifiableCredential', 'AgentDelegation'],
      issuer: 'did:abt:capabilities-test-operator',
      issuanceDate: '2026-01-01T00:00:00Z',
      credentialSubject: { id: 'did:abt:capabilities-test-agent' },
      proof: {
        type: 'Ed25519Signature2020',
        created: '2026-01-01T00:00:00Z',
        verificationMethod: 'did:abt:capabilities-test-operator#key-1',
        proofPurpose: 'assertionMethod',
        proofValue: 'zfixture-not-verified-here',
      },
    },
  },
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
  let sessionAdapter: SessionAdapter;
  let authHeader: Record<string, string>;

  beforeAll(async () => {
    sessionAdapter = testSessionAdapter();
    server = await listen(
      createApp(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        sessionAdapter,
      ),
    );
    baseUrl = `http://127.0.0.1:${portOf(server)}`;
    const token = await mintSessionToken(sessionAdapter);
    authHeader = { authorization: `Bearer ${token}` };
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
    expect(body.capabilities).toHaveLength(8);
  });

  it('every declared public GET answers a caller with no identity', async () => {
    const publicGets = CAPABILITIES.filter((c) => c.access === 'public' && c.method === 'GET');
    expect(publicGets.length).toBeGreaterThan(0);
    for (const cap of publicGets) {
      const concretePath = cap.path.replace(/:[^/]+/g, 'capabilities-test-placeholder');
      const res = await fetch(`${baseUrl}${concretePath}`);
      // A 404 is a pass only when it comes from the route's own "row not
      // found" handling (a JSON body): that proves the refusal is about the
      // row (an unknown id), not about who asked. A path with no matching
      // route also 404s, but through Express's default handler, which
      // answers HTML - so a declared path that doesn't correspond to an
      // actual registered route (a typo like '/agent/:agentDid') still
      // fails this check instead of passing as a plausible "unknown row".
      expect([401, 403]).not.toContain(res.status);
      if (res.status === 404) {
        expect(res.headers.get('content-type')).toContain('application/json');
      }
    }
  });

  it('the bootstrap identified POST (account creation) refuses a caller who names no one', async () => {
    // R-39 completion: account.register is the only identified capability
    // that still declares an identityField (see access.ts's own doc
    // comment on the field): registering an account is how a party comes
    // to exist, so it is the one route that cannot derive its party from
    // a proof presupposing an account already exists. agent.list and
    // job.hire dropped out of this loop on purpose -- they no longer read
    // an identity field from the body at all (identityField: null), and
    // are covered instead by the session/signature-derivation tests in
    // tests/api/session.test.ts and tests/api/party-derivation.test.ts.
    const bootstrapPosts = CAPABILITIES.filter((c) => c.access === 'identified' && c.identityField !== null);
    expect(bootstrapPosts.map((c) => c.id)).toEqual(['operator.register']);
    for (const cap of bootstrapPosts) {
      const body = VALID_BODY_MINUS_IDENTITY[cap.id];
      expect(body, `no fixture body registered for ${cap.id}`).toBeDefined();
      const res = await fetch(`${baseUrl}${cap.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader },
        body: JSON.stringify(body),
      });
      expect(res.status, `${cap.id} should refuse a body missing ${cap.identityField}`).toBe(400);
      const parsed = (await res.json()) as { error?: unknown };
      expect(typeof parsed.error).toBe('string');
      expect((parsed.error as string).length).toBeGreaterThan(0);
    }
  });

  it('agent.list and job.hire no longer read an identity field from the body: posting without one still reaches party resolution, not a 400', async () => {
    // R-39 completion: these two routes used to 400 on a body missing
    // their old identityField (operator / buyerDid). Now the field is
    // simply not read for identity, so the same trimmed body reaches
    // resolveActingParty instead -- which refuses with 403 because this
    // describe block's session has no registered account behind it, never
    // with 400. The 403 (not 400) is the proof that the missing field
    // stopped being a shape requirement.
    for (const id of ['agent.list', 'job.hire']) {
      const cap = CAPABILITIES.find((c) => c.id === id);
      expect(cap, `${id} must be declared`).toBeDefined();
      const body = VALID_BODY_MINUS_IDENTITY[id];
      const res = await fetch(`${baseUrl}${cap!.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader },
        body: JSON.stringify(body),
      });
      expect(res.status, `${id} should reach party resolution (403), not a body-shape 400`).toBe(403);
    }
  });

  it('agent.list: operator is derived server-side and any body-supplied value is checked against it, never trusted', async () => {
    // R-39 completion: a body carrying no operator at all reaches party
    // resolution and is refused with 403 (this describe block's session
    // has no registered account behind it) -- proving operator dropped
    // out of the body-shape check entirely. A body naming an operator
    // that mismatches the (still-unresolved) derived party fails the
    // same way, for the same reason: the derived party is null either
    // way, so there is nothing to compare a claimed value against yet
    // and the null check fires first.
    const withoutOperator = await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader },
      body: JSON.stringify(VALID_BODY_MINUS_IDENTITY['agent.list']),
    });
    expect(withoutOperator.status).toBe(403);

    const withUnregisteredOperator = await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader },
      body: JSON.stringify({
        ...VALID_BODY_MINUS_IDENTITY['agent.list'],
        operator: 'did:abt:capabilities-test-operator-never-registered',
      }),
    });
    expect(withUnregisteredOperator.status).toBe(403);
  });

  it('the declaration and the domain helper agree', () => {
    expect(capabilityFor('POST', '/jobs')?.access).toBe('identified');
    expect(requiresIdentity('GET', '/agents/:agentDid')).toBe(false);
  });
});
