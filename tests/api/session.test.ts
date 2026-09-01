// R-39 acceptance, human-seeded 2026-08-27. These are the RED contract for
// src/adapters/identity/session.ts: each case is declared with `it.fails`,
// so the suite stays green while the adapter is a stub, and the moment a
// real implementation makes a case pass, `it.fails` itself fails. The
// implementer's first move is therefore forced and mechanical: replace
// `it.fails` with `it` and make the assertions real. The assertions below
// are placeholders for the acceptance lines in the comments, not the final
// tests.
//
// The boundary under test is the operator decision on issue #30
// (2026-08-26): browse and verify public, hire and list behind a session,
// anonymous verify rate limited. Invariants 7 and 8 bind: a wallet is never
// required, and OAuth or a passkey reaches every capability.
import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { fakeGitHubConfig, fakeGitHubFetch, failingGitHubFetch, mintSessionToken } from '../helpers/session-fixtures.js';
import { createPasskeyFixture } from '../helpers/webauthn-fixtures.js';
import { signingIdentityFromSeed, signRequest } from '../helpers/sign-request.js';
import { createApp } from '../../src/api/app.js';
import { createRateLimiter } from '../../src/adapters/identity/verify-rate-limit.js';
import { MemoryAgentRepository, MemoryOperatorRepository } from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';

function delegationFixture(agentDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-session-test',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: 'did:abt:op-session-test',
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
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return `http://127.0.0.1:${address.port}`;
}

describe('base session: GitHub OAuth and passkey (R-39)', () => {
  afterEach(async () => {
    if (server !== null) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('GitHub OAuth round trip yields a session with the one Session shape', async () => {
    // begin -> provider redirect + single-use state; complete with the
    // callback code and the SAME state -> Session { subject, method:
    // 'github-oauth', token, issuedAt, expiresAt }.
    const real = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'octo-cat', id: 42 }),
    });

    const start = await real.beginGitHubOAuth();
    expect(start.redirectUrl).toContain('https://github.com/login/oauth/authorize');
    expect(start.redirectUrl).toContain(`state=${start.state}`);
    // Minimum scope: no `scope` parameter at all (GitHub defaults to
    // identifying-the-user-only when it is omitted).
    expect(start.redirectUrl).not.toContain('scope=');
    expect(start.state.length).toBeGreaterThan(0);

    const session = await real.completeGitHubOAuth({ code: 'valid-code', state: start.state });

    expect(session).not.toBeNull();
    expect(session).toMatchObject({ method: 'github-oauth' });
    expect(typeof session!.subject).toBe('string');
    expect(session!.subject.length).toBeGreaterThan(0);
    expect(typeof session!.token).toBe('string');
    expect(session!.token.length).toBeGreaterThan(0);
    expect(new Date(session!.issuedAt).toString()).not.toBe('Invalid Date');
    expect(new Date(session!.expiresAt).toString()).not.toBe('Invalid Date');
    expect(new Date(session!.expiresAt).getTime()).toBeGreaterThan(new Date(session!.issuedAt).getTime());

    // A second completion with the SAME (now-used) state fails closed.
    const replay = await real.completeGitHubOAuth({ code: 'valid-code', state: start.state });
    expect(replay).toBeNull();
  });

  it('OAuth completion with a reused or unknown state yields null, not a throw', async () => {
    const real = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'octo-cat', id: 7 }),
    });

    // A state this adapter never issued.
    await expect(real.completeGitHubOAuth({ code: 'valid-code', state: 'never-issued-state' })).resolves.toBeNull();

    // A state issued and already consumed.
    const start = await real.beginGitHubOAuth();
    const first = await real.completeGitHubOAuth({ code: 'valid-code', state: start.state });
    expect(first).not.toBeNull();
    await expect(real.completeGitHubOAuth({ code: 'valid-code', state: start.state })).resolves.toBeNull();

    // A provider-side failure (bad code) also resolves to null, never a throw.
    const failing = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: failingGitHubFetch() });
    const failingStart = await failing.beginGitHubOAuth();
    await expect(
      failing.completeGitHubOAuth({ code: 'bad-code', state: failingStart.state }),
    ).resolves.toBeNull();
  });

  it('passkey round trip yields a session with the SAME shape as OAuth', async () => {
    // register -> WebAuthn options with a single-use expiring challenge;
    // verify -> Session { method: 'passkey' }. Every other field identical
    // in shape to the OAuth session: one session model, no second account.
    const real = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'octo-cat', id: 1 }),
      passkey: { rpName: 'FreeAgents test', rpID: 'localhost', origin: 'http://localhost:3000' },
    });
    const subject = 'passkey-subject-1';

    const { optionsJson } = await real.registerPasskey(subject);
    const registrationOptions = JSON.parse(optionsJson) as { challenge: string };
    expect(typeof registrationOptions.challenge).toBe('string');
    expect(registrationOptions.challenge.length).toBeGreaterThan(0);

    const fixture = createPasskeyFixture();
    const response = fixture.registrationResponse(registrationOptions.challenge, 'localhost');

    const session = await real.verifyPasskey(JSON.stringify({ subject, response }));

    expect(session).not.toBeNull();
    expect(session!.method).toBe('passkey');
    expect(session!.subject).toBe(subject);
    expect(typeof session!.token).toBe('string');
    expect(session!.token.length).toBeGreaterThan(0);
    expect(new Date(session!.issuedAt).toString()).not.toBe('Invalid Date');
    expect(new Date(session!.expiresAt).toString()).not.toBe('Invalid Date');
    // Exactly the OAuth session's field set: same keys, same shapes.
    expect(Object.keys(session!).sort()).toEqual(['expiresAt', 'issuedAt', 'method', 'subject', 'token']);

    // The registration challenge is single-use: replaying the same response
    // (same, now-consumed challenge) fails closed.
    const replay = await real.verifyPasskey(JSON.stringify({ subject, response }));
    expect(replay).toBeNull();
  });

  it('a hire-loop route returns 401 without a session and works with one', async () => {
    // POST /jobs with no bearer token -> 401. Same request with a live
    // session token -> not 401. The route list that requires a session is
    // exactly the hire-and-list set from src/domain/access.ts.
    const real = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'octo-cat', id: 501 }),
    });
    const token = await mintSessionToken(real);

    const agentRepo = new MemoryAgentRepository();
    const agentDid = 'did:abt:session-gate-agent';
    await agentRepo.create({
      did: agentDid,
      operatorDid: 'did:abt:op-session-gate',
      delegation: delegationFixture(agentDid),
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const baseUrl = await listen(createApp(undefined, agentRepo, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, real));

    const jobBody = {
      buyerDid: 'did:abt:session-gate-buyer',
      agentDid,
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug',
    };

    const anonymous = await fetch(`${baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(jobBody),
    });
    expect(anonymous.status).toBe(401);

    const withSession = await fetch(`${baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(jobBody),
    });
    expect(withSession.status).toBe(201);
  });

  it('the agent-listing route returns 401 without a session, and passes with one', async () => {
    // POST /agents is the other list-and-hire route the operator decision on
    // #30 names. Same shape as the /jobs case above: no bearer token is a
    // 401, a live session token reaches the handler.
    const real = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'octo-cat', id: 502 }),
    });
    const token = await mintSessionToken(real);
    const baseUrl = await listen(createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, real));

    const agentBody = {
      did: 'did:abt:session-gate-listed-agent',
      operator: 'did:abt:session-gate-operator',
      delegation: delegationFixture('did:abt:session-gate-listed-agent'),
      name: 'scout',
      skills: ['triage'],
    };

    const anonymous = await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(agentBody),
    });
    expect(anonymous.status).toBe(401);
    expect(((await anonymous.json()) as { error: string }).error).toContain('session');

    // The session gate itself is what is under test here, not the domain
    // rule behind it: an unregistered operator is a 404 from the handler,
    // reached only because the session satisfied the gate in front of it.
    const withSession = await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(agentBody),
    });
    expect(withSession.status).not.toBe(401);
  });

  it('refuses a signature naming an operator different from the one who signed, with 403', async () => {
    // Proof (t_8b63ee9e, D2/credential-not-bound-to-party): the signature
    // path on POST /agents never called signerDidOf(), so a registered
    // operator could sign a body naming a DIFFERENT operator DID and still
    // get 201 -- the same party-binding rule POST /jobs already enforces
    // for buyerDid was simply missing here. Both operators are registered
    // (so the 404 unregistered-operator check cannot explain a refusal);
    // only the signer/operator mismatch can.
    const signer = await signingIdentityFromSeed(new Uint8Array(32).fill(61));
    const victim = await signingIdentityFromSeed(new Uint8Array(32).fill(62));
    const operatorRepo = new MemoryOperatorRepository();
    await operatorRepo.register({ did: signer.did, githubLogin: 'signer-operator' });
    await operatorRepo.register({ did: victim.did, githubLogin: 'victim-operator' });

    const baseUrl = await listen(createApp(operatorRepo));
    const agentDid = 'did:abt:session-forged-listed-agent';
    const body = {
      did: agentDid,
      operator: victim.did,
      delegation: delegationFixture(agentDid),
      name: 'scout',
      skills: ['triage'],
    };
    const bodyText = JSON.stringify(body);
    const targetUri = `${baseUrl}/agents`;
    const signed = signRequest(signer, 'POST', targetUri, { body: bodyText });

    const response = await fetch(targetUri, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'signature-input': signed['signature-input'],
        signature: signed.signature,
        'content-digest': signed['content-digest'],
      },
      body: bodyText,
    });

    expect(response.status).toBe(403);
  });

  it('refuses an invalid signature outright, even when a live session is also present', async () => {
    // Proof (t_8b63ee9e, D3): requireSessionOrSignature's own comment says
    // an invalid signature is "refused outright... rather than silently
    // falling back to a session check that might also fail". Mutation
    // proof at t_80cd7d4e found that swapping the early return for a
    // fall-through to the session check left the FULL SUITE GREEN --
    // meaning no test actually exercised "signature present but invalid,
    // AND a live session is also on the request". This one does: the
    // signature bytes are corrupted (present, well-formed headers, wrong
    // signature value) while a genuinely live session token rides along.
    // If the early return were ever weakened to a fall-through, this test
    // is what would catch it going from 401 to 201.
    const real = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'octo-cat', id: 909 }),
    });
    const token = await mintSessionToken(real);
    const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(71));

    const agentRepo = new MemoryAgentRepository();
    const agentDid = 'did:abt:session-invalid-sig-agent';
    await agentRepo.create({
      did: agentDid,
      operatorDid: 'did:abt:op-session-invalid-sig',
      delegation: delegationFixture(agentDid),
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const baseUrl = await listen(createApp(undefined, agentRepo, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, real));

    const jobBody = {
      buyerDid: buyer.did,
      agentDid,
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug',
    };
    const bodyText = JSON.stringify(jobBody);
    const targetUri = `${baseUrl}/jobs`;
    const signed = signRequest(buyer, 'POST', targetUri, { body: bodyText });
    // Corrupt the signature value itself: well-formed Signature-Input and
    // Content-Digest, but the signature no longer verifies against either.
    const corruptedSignature = signed.signature.slice(0, -8) + 'AAAAAAAA:';

    const response = await fetch(targetUri, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'signature-input': signed['signature-input'],
        signature: corruptedSignature,
        'content-digest': signed['content-digest'],
        authorization: `Bearer ${token}`,
      },
      body: bodyText,
    });

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toContain('invalid signature');
  });

  it('a hire-loop route returns 401 for an expired or a merely malformed bearer token, never an anonymous fallthrough', async () => {
    // A gated route must refuse an invalid credential exactly as it refuses
    // an absent one -- 401 either way, never treated as if no Authorization
    // header were sent at all. getSession resolves expired and unknown
    // tokens to null indistinguishably (pinned above); this proves the HTTP
    // gate honours that null the same way for every kind of bad token.
    let now = new Date('2026-08-27T00:00:00Z').getTime();
    const real = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'octo-cat', id: 777 }),
      sessionTtlMs: 1000,
      now: () => now,
    });
    const start = await real.beginGitHubOAuth();
    const session = await real.completeGitHubOAuth({ code: 'irrelevant-code', state: start.state });
    const token = session!.token;

    const agentRepo = new MemoryAgentRepository();
    const agentDid = 'did:abt:session-invalid-agent';
    await agentRepo.create({
      did: agentDid,
      operatorDid: 'did:abt:op-session-invalid',
      delegation: delegationFixture(agentDid),
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const baseUrl = await listen(createApp(undefined, agentRepo, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, real));

    const jobBody = {
      buyerDid: 'did:abt:session-invalid-buyer',
      agentDid,
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug',
    };

    // Live, right before expiry: the session gate accepts it.
    now += 999;
    const live = await fetch(`${baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(jobBody),
    });
    expect(live.status).toBe(201);

    // Past the TTL: the same token is now expired, and the route refuses.
    now += 2;
    const expired = await fetch(`${baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(jobBody),
    });
    expect(expired.status).toBe(401);

    // A token this adapter never issued: 401, not treated as anonymous.
    const unknown = await fetch(`${baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer never-issued-token' },
      body: JSON.stringify(jobBody),
    });
    expect(unknown.status).toBe(401);

    // A malformed Authorization header (wrong scheme entirely): same 401.
    const malformed = await fetch(`${baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Basic not-a-bearer-token' },
      body: JSON.stringify(jobBody),
    });
    expect(malformed.status).toBe(401);
  });

  it('a fresh deployment can onboard its first operator with no session and no signature', async () => {
    // Proof (t_8b63ee9e, D1/bootstrap-deadlock): createApp() with EVERY
    // default is exactly what src/api/server.ts runs. POST /operators is
    // account CREATION (issue 83's anchor names hire and list, not
    // registration), and a route that mints the only credential a caller
    // could later present cannot itself demand one -- gating it made a
    // fresh deployment unable to onboard anyone at all. No session
    // adapter, no agent repository, no operator repository: the exact
    // shape a first boot has.
    const baseUrl = await listen(createApp());

    const anonymous = await fetch(`${baseUrl}/operators`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: 'did:abt:bootstrap-first-operator', githubLogin: 'bootstrap-first-operator' }),
    });
    expect(anonymous.status).toBe(201);
  });

  it('browse and verify routes succeed with no session and no account', async () => {
    // GET /agents/:agentDid and GET /v1/credentials/:credentialId answer a
    // stranger. This is the product's trust story; a session requirement
    // here is a regression, not a hardening.
    const agentRepo = new MemoryAgentRepository();
    const agentDid = 'did:abt:session-browse-agent';
    await agentRepo.create({
      did: agentDid,
      operatorDid: 'did:abt:op-session-test',
      delegation: delegationFixture(agentDid),
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const baseUrl = await listen(createApp(undefined, agentRepo));

    // No Authorization header, no cookie, no bearer token anywhere.
    const browsed = await fetch(`${baseUrl}/agents/${agentDid}`);
    expect(browsed.status).toBe(200);

    // An unknown credential id still answers with a real 404, not a 401 --
    // the route itself never demands identity, whatever it returns.
    const verified = await fetch(`${baseUrl}/v1/credentials/never-issued`);
    expect(verified.status).toBe(404);
    expect(verified.status).not.toBe(401);
  });

  it('anonymous verify routes are rate limited', async () => {
    // Public does not mean scrapeable-to-death (#30 addendum). Repeated
    // anonymous hits on a verify route eventually answer 429; a session
    // does not lift the product boundary, only the limit bucket.
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 });
    const agentRepo = new MemoryAgentRepository();
    const agentDid = 'did:abt:session-rate-agent';
    await agentRepo.create({
      did: agentDid,
      operatorDid: 'did:abt:op-session-test',
      delegation: delegationFixture(agentDid),
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const app = createApp(undefined, agentRepo, undefined, undefined, undefined, undefined, undefined, undefined, limiter);
    const baseUrl = await listen(app);

    const first = await fetch(`${baseUrl}/agents/${agentDid}`);
    const second = await fetch(`${baseUrl}/agents/${agentDid}`);
    const third = await fetch(`${baseUrl}/agents/${agentDid}`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
  });

  it('getSession resolves expired and ended tokens to null, indistinguishably', async () => {
    let now = new Date('2026-08-27T00:00:00Z').getTime();
    const real = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'octo-cat', id: 900 }),
      sessionTtlMs: 1000,
      now: () => now,
    });

    const start = await real.beginGitHubOAuth();
    const session = await real.completeGitHubOAuth({ code: 'irrelevant-code', state: start.state });
    expect(session).not.toBeNull();
    const token = session!.token;

    // Still live, just before expiry.
    now += 999;
    expect(await real.getSession(token)).not.toBeNull();

    // Past the TTL: expired, resolves to null.
    now += 2;
    const expired = await real.getSession(token);
    expect(expired).toBeNull();

    // A second, independent session, ended explicitly instead of expiring.
    now = new Date('2026-08-27T00:00:00Z').getTime();
    const secondStart = await real.beginGitHubOAuth();
    const secondSession = await real.completeGitHubOAuth({ code: 'irrelevant-code-2', state: secondStart.state });
    const secondToken = secondSession!.token;
    expect(await real.getSession(secondToken)).not.toBeNull();

    await real.endSession(secondToken);
    const ended = await real.getSession(secondToken);
    expect(ended).toBeNull();

    // The two null outcomes are indistinguishable by shape: both are exactly null.
    expect(expired).toBe(null);
    expect(ended).toBe(null);

    // endSession is idempotent: ending an already-dead session is a no-op,
    // never a throw.
    await expect(real.endSession(secondToken)).resolves.toBeUndefined();
    await expect(real.endSession('token-that-never-existed')).resolves.toBeUndefined();
  });
});
