// P8b: the session adapter, wired to HTTP. Before this file, SessionAdapter
// was fully implemented and fully unreachable (session.test.ts exercises it
// directly, never over a route). This file drives every new route the same
// way the rest of this suite drives the API: real HTTP, against the real
// app, never by importing the adapter's methods straight into an assertion.
//
// The anchor this card exists to prove sits in the last describe block: a
// person signs in, takes the token, and drives a hire-loop route with it.
import type { Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import type { SessionAdapter } from '../../src/adapters/identity/session.js';
import { createRateLimiter } from '../../src/adapters/identity/verify-rate-limit.js';
import { fakeGitHubConfig, fakeGitHubFetch, failingGitHubFetch } from '../helpers/session-fixtures.js';
import { createPasskeyFixture } from '../helpers/webauthn-fixtures.js';
import { MemoryAgentRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';

function delegationFixture(agentDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-auth-routes-test',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: 'did:abt:op-auth-routes-test',
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

let server: Server | null = null;

async function listen(app: ReturnType<typeof createApp>): Promise<string> {
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return `http://127.0.0.1:${address.port}`;
}

function passkeyAdapter(): SessionAdapter {
  return createSessionAdapter({
    github: fakeGitHubConfig(),
    passkey: { rpName: 'FreeAgents test', rpID: 'localhost', origin: 'http://localhost:3000' },
  });
}

describe('GET /auth/github/start', () => {
  afterEach(async () => {
    if (server !== null) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('answers a redirectUrl pointing at the GitHub authorize endpoint, carrying a state', async () => {
    const sessionAdapter = createSessionAdapter({ github: fakeGitHubConfig() });
    const baseUrl = await listen(
      createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
    );

    const res = await fetch(`${baseUrl}/auth/github/start`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { redirectUrl: string };
    expect(body.redirectUrl).toContain('https://github.com/login/oauth/authorize');
    expect(body.redirectUrl).toMatch(/[?&]state=/);
  });
});

describe('GET /auth/github/callback', () => {
  afterEach(async () => {
    if (server !== null) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('answers the Session that completeGitHubOAuth produces, for a good code and state', async () => {
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'octo-callback', id: 1001 }),
    });
    const baseUrl = await listen(
      createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
    );

    const start = await sessionAdapter.beginGitHubOAuth();
    const res = await fetch(`${baseUrl}/auth/github/callback?code=good-code&state=${encodeURIComponent(start.state)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      subject: 'octo-callback',
      method: 'github-oauth',
      token: expect.any(String),
      issuedAt: expect.any(String),
      expiresAt: expect.any(String),
    });
  });

  it('400s when code is missing, before any adapter call', async () => {
    const sessionAdapter = createSessionAdapter({ github: fakeGitHubConfig() });
    const baseUrl = await listen(
      createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
    );
    const start = await sessionAdapter.beginGitHubOAuth();

    const res = await fetch(`${baseUrl}/auth/github/callback?state=${encodeURIComponent(start.state)}`);
    expect(res.status).toBe(400);
  });

  it('400s when state is missing, before any adapter call', async () => {
    const sessionAdapter = createSessionAdapter({ github: fakeGitHubConfig() });
    const baseUrl = await listen(
      createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
    );

    const res = await fetch(`${baseUrl}/auth/github/callback?code=good-code`);
    expect(res.status).toBe(400);
  });

  it('400s when code or state is present but non-string (repeated query param)', async () => {
    const sessionAdapter = createSessionAdapter({ github: fakeGitHubConfig() });
    const baseUrl = await listen(
      createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
    );

    const res = await fetch(`${baseUrl}/auth/github/callback?code=a&code=b&state=s`);
    expect(res.status).toBe(400);
  });

  it('401s a state that was never issued, without inspecting any error message', async () => {
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'octo-callback', id: 1002 }),
    });
    const baseUrl = await listen(
      createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
    );

    const res = await fetch(`${baseUrl}/auth/github/callback?code=good-code&state=never-issued-state`);
    expect(res.status).toBe(401);
  });

  it('401s a replayed (already-used) state', async () => {
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'octo-callback', id: 1003 }),
    });
    const baseUrl = await listen(
      createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
    );
    const start = await sessionAdapter.beginGitHubOAuth();

    const first = await fetch(`${baseUrl}/auth/github/callback?code=good-code&state=${encodeURIComponent(start.state)}`);
    expect(first.status).toBe(200);

    const replay = await fetch(`${baseUrl}/auth/github/callback?code=good-code&state=${encodeURIComponent(start.state)}`);
    expect(replay.status).toBe(401);
  });

  it('401s an expired state', async () => {
    let now = new Date('2026-08-27T00:00:00Z').getTime();
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'octo-callback', id: 1004 }),
      oauthStateTtlMs: 1000,
      now: () => now,
    });
    const baseUrl = await listen(
      createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
    );
    const start = await sessionAdapter.beginGitHubOAuth();

    now += 1001;
    const res = await fetch(`${baseUrl}/auth/github/callback?code=good-code&state=${encodeURIComponent(start.state)}`);
    expect(res.status).toBe(401);
  });

  it('401s a provider refusal, without leaking any error message', async () => {
    const sessionAdapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: failingGitHubFetch() });
    const baseUrl = await listen(
      createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
    );
    const start = await sessionAdapter.beginGitHubOAuth();

    const res = await fetch(`${baseUrl}/auth/github/callback?code=bad-code&state=${encodeURIComponent(start.state)}`);
    expect(res.status).toBe(401);
  });

  it('is mounted behind the verify rate limiter, never widened beyond it', async () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 });
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'octo-limited', id: 1005 }),
    });
    const baseUrl = await listen(
      createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, limiter, undefined, undefined, sessionAdapter),
    );

    const first = await fetch(`${baseUrl}/auth/github/callback?code=x&state=never-issued-1`);
    const second = await fetch(`${baseUrl}/auth/github/callback?code=x&state=never-issued-2`);
    const third = await fetch(`${baseUrl}/auth/github/callback?code=x&state=never-issued-3`);

    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    expect(third.status).toBe(429);
  });
});

describe('POST /auth/passkey/register', () => {
  afterEach(async () => {
    if (server !== null) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('answers optionsJson for a well-formed subject', async () => {
    const sessionAdapter = passkeyAdapter();
    const baseUrl = await listen(
      createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
    );

    const res = await fetch(`${baseUrl}/auth/passkey/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'a-real-subject' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { optionsJson: string };
    expect(typeof body.optionsJson).toBe('string');
    const parsed = JSON.parse(body.optionsJson) as { challenge: string };
    expect(typeof parsed.challenge).toBe('string');
    expect(parsed.challenge.length).toBeGreaterThan(0);
  });

  it('400s a missing subject, before any adapter call', async () => {
    const sessionAdapter = passkeyAdapter();
    const baseUrl = await listen(
      createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
    );

    const res = await fetch(`${baseUrl}/auth/passkey/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('400s a non-string subject, before any adapter call', async () => {
    const sessionAdapter = passkeyAdapter();
    const baseUrl = await listen(
      createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
    );

    const res = await fetch(`${baseUrl}/auth/passkey/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 42 }),
    });
    expect(res.status).toBe(400);
  });

  // qa (review round 1, D2, guard-without-a-test): registerPasskey throws
  // when options.passkey is undefined (FREEAGENTS_PASSKEY_RP_ID unset), and
  // that throw maps to 503, not a 200 with an empty options object. Mutation
  // proof (run by hand and reverted): swapping the 503 branch for
  // res.status(200).json({ optionsJson: '{}' }) left the full suite green
  // before this test existed. This test goes red under that exact mutation.
  it('503s when passkey is not configured on this deployment', async () => {
    const sessionAdapter = createSessionAdapter({ github: fakeGitHubConfig() });
    const baseUrl = await listen(
      createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
    );

    const res = await fetch(`${baseUrl}/auth/passkey/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'a-real-subject' }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: 'passkey sign-in is not configured on this deployment' });
  });
});

describe('POST /auth/passkey/verify', () => {
  afterEach(async () => {
    if (server !== null) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('answers the Session that verifyPasskey produces, for a real registration ceremony', async () => {
    const sessionAdapter = passkeyAdapter();
    const baseUrl = await listen(
      createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
    );
    const subject = 'passkey-route-subject-1';

    const registered = await fetch(`${baseUrl}/auth/passkey/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject }),
    });
    const { optionsJson } = (await registered.json()) as { optionsJson: string };
    const { challenge } = JSON.parse(optionsJson) as { challenge: string };
    const fixture = createPasskeyFixture();
    const response = fixture.registrationResponse(challenge, 'localhost');

    const res = await fetch(`${baseUrl}/auth/passkey/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ responseJson: JSON.stringify({ subject, response }) }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      subject,
      method: 'passkey',
      token: expect.any(String),
      issuedAt: expect.any(String),
      expiresAt: expect.any(String),
    });
  });

  it('400s a missing responseJson, before any adapter call', async () => {
    const sessionAdapter = passkeyAdapter();
    const baseUrl = await listen(
      createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
    );

    const res = await fetch(`${baseUrl}/auth/passkey/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('400s a non-string responseJson, before any adapter call', async () => {
    const sessionAdapter = passkeyAdapter();
    const baseUrl = await listen(
      createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
    );

    const res = await fetch(`${baseUrl}/auth/passkey/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ responseJson: 42 }),
    });
    expect(res.status).toBe(400);
  });

  it('401s a well-formed but unverifiable responseJson, never a throw', async () => {
    const sessionAdapter = passkeyAdapter();
    const baseUrl = await listen(
      createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
    );

    const res = await fetch(`${baseUrl}/auth/passkey/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ responseJson: JSON.stringify({ subject: 'never-registered', response: {} }) }),
    });
    expect(res.status).toBe(401);
  });

  it('is mounted behind the verify rate limiter, never widened beyond it', async () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 });
    const sessionAdapter = passkeyAdapter();
    const baseUrl = await listen(
      createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, limiter, undefined, undefined, sessionAdapter),
    );

    const attempt = () =>
      fetch(`${baseUrl}/auth/passkey/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ responseJson: JSON.stringify({ subject: 'never-registered', response: {} }) }),
      });

    const first = await attempt();
    const second = await attempt();
    const third = await attempt();

    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    expect(third.status).toBe(429);
  });
});

describe('POST /auth/signout', () => {
  afterEach(async () => {
    if (server !== null) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('invalidates a live token: 204, and the same hire-loop route now answers 401 for it', async () => {
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'octo-signout', id: 2001 }),
    });
    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: 'did:abt:signout-buyer', githubLogin: 'octo-signout' });
    const agentRepo = new MemoryAgentRepository();
    const agentDid = 'did:abt:signout-agent';
    await agentRepo.create({
      did: agentDid,
      operatorDid: 'did:abt:signout-operator',
      delegation: delegationFixture(agentDid),
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const baseUrl = await listen(
      createApp(accountRepo, agentRepo, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
    );
    const start = await sessionAdapter.beginGitHubOAuth();
    const session = await sessionAdapter.completeGitHubOAuth({ code: 'good-code', state: start.state });
    const token = session!.token;

    const jobBody = { agentDid, repository: 'buyer/target-repo', brief: 'Fix the login bug' };
    const before = await fetch(`${baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(jobBody),
    });
    expect(before.status).toBe(201);

    const signedOut = await fetch(`${baseUrl}/auth/signout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(signedOut.status).toBe(204);

    const after = await fetch(`${baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(jobBody),
    });
    expect(after.status).toBe(401);
  });

  it('signing out twice is still 204, never an error', async () => {
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'octo-signout-2', id: 2002 }),
    });
    const baseUrl = await listen(
      createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
    );
    const start = await sessionAdapter.beginGitHubOAuth();
    const session = await sessionAdapter.completeGitHubOAuth({ code: 'good-code', state: start.state });
    const token = session!.token;

    const first = await fetch(`${baseUrl}/auth/signout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    expect(first.status).toBe(204);
    const second = await fetch(`${baseUrl}/auth/signout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    expect(second.status).toBe(204);
  });

  it('signing out with a dead token is still 204, never a 401', async () => {
    const sessionAdapter = createSessionAdapter({ github: fakeGitHubConfig() });
    const baseUrl = await listen(
      createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
    );

    const res = await fetch(`${baseUrl}/auth/signout`, {
      method: 'POST',
      headers: { authorization: 'Bearer never-issued-token' },
    });
    expect(res.status).toBe(204);
  });

  it('signing out with no bearer token at all is still 204: asking to be signed out is not a claim', async () => {
    const sessionAdapter = createSessionAdapter({ github: fakeGitHubConfig() });
    const baseUrl = await listen(
      createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
    );

    const res = await fetch(`${baseUrl}/auth/signout`, { method: 'POST' });
    expect(res.status).toBe(204);
  });
});

// THE ANCHOR: a person lands on /signin, chooses GitHub, and comes back
// holding a session token the hire loop accepts. Every step below goes
// over real HTTP against the real app: start the flow, take the state,
// present it at the callback, take the token, drive one requireSessionOrSignature
// route (POST /jobs) and one didSignature+populateSessionSubject route
// (POST /jobs/:jobId/withdraw) with it. Both gate shapes, proved from one
// real sign-in, is the assertion no test made before this card.
describe('P8b anchor: sign in over HTTP, then drive both hire-loop gate shapes with the token', () => {
  afterEach(async () => {
    if (server !== null) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('GitHub sign-in end to end: start -> callback -> token accepted by requireSessionOrSignature and by didSignature+populateSessionSubject', async () => {
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'octo-anchor', id: 3001 }),
    });
    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: 'did:abt:anchor-buyer', githubLogin: 'octo-anchor' });
    const agentRepo = new MemoryAgentRepository();
    const agentDid = 'did:abt:anchor-agent';
    await agentRepo.create({
      did: agentDid,
      operatorDid: 'did:abt:anchor-operator',
      delegation: delegationFixture(agentDid),
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const baseUrl = await listen(
      createApp(accountRepo, agentRepo, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
    );

    // A person lands on /signin and chooses GitHub: the browser would be
    // redirected to this URL. Driven exactly as a browser would drive it,
    // over HTTP, against the real route.
    const startRes = await fetch(`${baseUrl}/auth/github/start`);
    expect(startRes.status).toBe(200);
    const { redirectUrl } = (await startRes.json()) as { redirectUrl: string };
    expect(redirectUrl).toContain('https://github.com/login/oauth/authorize');
    const state = new URL(redirectUrl).searchParams.get('state');
    expect(state).not.toBeNull();

    // GitHub redirects back with a code and the same state.
    const callbackRes = await fetch(`${baseUrl}/auth/github/callback?code=any-code&state=${encodeURIComponent(state!)}`);
    expect(callbackRes.status).toBe(200);
    const session = (await callbackRes.json()) as { token: string };
    expect(typeof session.token).toBe('string');
    expect(session.token.length).toBeGreaterThan(0);
    const auth = { authorization: `Bearer ${session.token}` };

    // requireSessionOrSignature: POST /jobs.
    const created = await fetch(`${baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ agentDid, repository: 'buyer/target-repo', brief: 'Fix the login bug' }),
    });
    expect(created.status).toBe(201);
    const jobId = String(((await created.json()) as Record<string, unknown>).id);

    // didSignature + populateSessionSubject: POST /jobs/:jobId/withdraw.
    const withdrawn = await fetch(`${baseUrl}/jobs/${jobId}/withdraw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
    });
    expect(withdrawn.status).toBe(200);
    expect(((await withdrawn.json()) as Record<string, unknown>).status).toBe('withdrawn');
  });

  it('passkey sign-in end to end: register -> verify -> token accepted the same way', async () => {
    const sessionAdapter = passkeyAdapter();
    const accountRepo = new MemoryAccountRepository();
    const subject = 'anchor-passkey-subject';
    await accountRepo.register({ did: 'did:abt:anchor-passkey-buyer', githubLogin: 'anchor-passkey-buyer-login', passkeySubject: subject });
    const agentRepo = new MemoryAgentRepository();
    const agentDid = 'did:abt:anchor-passkey-agent';
    await agentRepo.create({
      did: agentDid,
      operatorDid: 'did:abt:anchor-passkey-operator',
      delegation: delegationFixture(agentDid),
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const baseUrl = await listen(
      createApp(accountRepo, agentRepo, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
    );

    const registered = await fetch(`${baseUrl}/auth/passkey/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject }),
    });
    expect(registered.status).toBe(200);
    const { optionsJson } = (await registered.json()) as { optionsJson: string };
    const { challenge } = JSON.parse(optionsJson) as { challenge: string };
    const fixture = createPasskeyFixture();
    const response = fixture.registrationResponse(challenge, 'localhost');

    const verified = await fetch(`${baseUrl}/auth/passkey/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ responseJson: JSON.stringify({ subject, response }) }),
    });
    expect(verified.status).toBe(200);
    const session = (await verified.json()) as { token: string };
    const auth = { authorization: `Bearer ${session.token}` };

    const created = await fetch(`${baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ agentDid, repository: 'buyer/target-repo', brief: 'Fix the login bug' }),
    });
    expect(created.status).toBe(201);
  });
});
