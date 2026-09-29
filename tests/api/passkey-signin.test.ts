// FIX-B61a: a passkey signs in only the account it was registered to.
//
// Before this card a passkey sign-in was a fresh registration under a name
// the caller chose, and that name was public on GET /accounts/:did. So a
// stranger could read a victim's passkeySubject, register their own passkey
// under it, and be signed in as the victim. The rules pinned here:
//   - the server makes the name at register and binds it to the ceremony;
//   - the credential is stored when it is created, once per credential id;
//   - every later sign-in is a WebAuthn authentication checked against the
//     stored key, and the browser names nobody.
// Everything runs over real HTTP against the real app with real WebAuthn
// bytes (tests/helpers/webauthn-fixtures.ts), never a stubbed verifier.
import type { Server } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

// Every 32-byte random value the code under test draws is recorded, so the
// storage-fault case can prove no session token was minted: a minted token
// is one of these, and getSession would resolve it.
const drawn = vi.hoisted(() => ({ tokens: [] as string[] }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  const recording = ((size: number) => {
    const bytes = actual.randomBytes(size);
    if (size === 32) drawn.tokens.push(bytes.toString('base64url'));
    return bytes;
  }) as typeof actual.randomBytes;
  return { ...actual, default: { ...actual, randomBytes: recording }, randomBytes: recording };
});

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import type { Session, SessionAdapter } from '../../src/adapters/identity/session.js';
import { MemoryAccountRepository, MemoryPasskeyCredentialRepository } from '../../src/adapters/storage/memory.js';
import type { PasskeyCredentialRepository, StoredPasskeyCredential } from '../../src/adapters/storage/types.js';
import { fakeGitHubConfig } from '../helpers/session-fixtures.js';
import { createPasskeyFixture, type AssertionOptions, type PasskeyFixture } from '../helpers/webauthn-fixtures.js';

const RP_ID = 'localhost';
const REFUSED = { error: 'invalid or expired sign-in attempt' };
const CHALLENGE_TTL_MS = 60_000;

let server: Server | null = null;

afterEach(async () => {
  if (server !== null) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

// A passkey store whose reads or writes can be made to fail, over a real
// in-memory store, for the storage-fault cases.
class FlakyPasskeyStore implements PasskeyCredentialRepository {
  readonly inner = new MemoryPasskeyCredentialRepository();
  failReads = false;
  failSave = false;

  async save(credential: StoredPasskeyCredential): Promise<void> {
    if (this.failSave) throw new Error('disk full');
    await this.inner.save(credential);
  }

  async findById(id: string): Promise<StoredPasskeyCredential | null> {
    if (this.failReads) throw new Error('connection refused');
    return this.inner.findById(id);
  }

  async recordUse(id: string, newCounter: number): Promise<void> {
    await this.inner.recordUse(id, newCounter);
  }
}

interface Rig {
  readonly baseUrl: string;
  readonly adapter: SessionAdapter;
  readonly clock: { now: number };
  readonly store: PasskeyCredentialRepository;
}

interface RigOptions {
  readonly store?: PasskeyCredentialRepository;
  readonly accounts?: MemoryAccountRepository;
  readonly clock?: { now: number };
  readonly passkeyConfigured?: boolean;
}

async function startRig(options: RigOptions = {}): Promise<Rig> {
  const clock = options.clock ?? { now: 1_800_000_000_000 };
  const store = options.store ?? new MemoryPasskeyCredentialRepository();
  const adapter = createSessionAdapter({
    github: fakeGitHubConfig(),
    ...(options.passkeyConfigured === false
      ? {}
      : { passkey: { rpName: 'FreeAgents test', rpID: RP_ID, origin: 'http://localhost:3000' } }),
    passkeyCredentials: store,
    passkeyChallengeTtlMs: CHALLENGE_TTL_MS,
    now: () => clock.now,
  });
  const accounts = options.accounts ?? new MemoryAccountRepository();
  const app = createApp(
    accounts,
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
    adapter,
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected server to listen on a port');
  return { baseUrl: `http://127.0.0.1:${address.port}`, adapter, clock, store };
}

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function post(rig: Rig, path: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${rig.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function accountOf(rig: Rig, token: string): Promise<{ status: number; did: string; passkeySubject: unknown }> {
  const res = await fetch(`${rig.baseUrl}/accounts/me`, { headers: { authorization: ['Bearer', token].join(' ') } });
  const body = (await res.json()) as { did?: string; passkeySubject?: unknown };
  return { status: res.status, did: String(body.did), passkeySubject: body.passkeySubject };
}

async function publicAccount(rig: Rig, did: string): Promise<{ status: number; passkeySubject: unknown }> {
  const res = await fetch(`${rig.baseUrl}/accounts/${did}`);
  const body = (await res.json()) as { passkeySubject?: unknown };
  return { status: res.status, passkeySubject: body.passkeySubject };
}

interface RegistrationOptions {
  readonly challenge: string;
  readonly user: { readonly id: string; readonly name: string };
  readonly authenticatorSelection: unknown;
}

function decodeUserId(userId: string): string {
  return Buffer.from(userId, 'base64url').toString('utf8');
}

async function beginRegistration(rig: Rig, body?: unknown): Promise<RegistrationOptions> {
  const started = await post(rig, '/auth/passkey/register', body);
  expect(started.status).toBe(200);
  return JSON.parse(String(started.body.optionsJson)) as RegistrationOptions;
}

interface SignedUp {
  readonly session: Session;
  readonly name: string;
  readonly userHandle: string;
  readonly did: string;
}

// A person makes a passkey: register (no name sent), the authenticator
// answers, verify. The authenticator remembers the user handle the server
// chose, as a real one does.
async function signUp(rig: Rig, fixture: PasskeyFixture): Promise<SignedUp> {
  const options = await beginRegistration(rig);
  fixture.rememberUserHandle(options.user.id);
  const response = fixture.registrationResponse(options.challenge, RP_ID);
  const verified = await post(rig, '/auth/passkey/verify', { responseJson: JSON.stringify({ response }) });
  expect(verified.status).toBe(200);
  const session = verified.body as unknown as Session;
  const account = await accountOf(rig, session.token);
  expect(account.status).toBe(200);
  return { session, name: decodeUserId(options.user.id), userHandle: options.user.id, did: account.did };
}

async function beginSignIn(rig: Rig): Promise<string> {
  const started = await post(rig, '/auth/passkey/signin/start');
  expect(started.status).toBe(200);
  const options = JSON.parse(String(started.body.optionsJson)) as { challenge: string };
  return options.challenge;
}

function sendAssertion(rig: Rig, assertion: unknown): Promise<Reply> {
  return post(rig, '/auth/passkey/signin', { responseJson: JSON.stringify(assertion) });
}

async function signIn(rig: Rig, fixture: PasskeyFixture, options?: AssertionOptions): Promise<Reply> {
  const challenge = await beginSignIn(rig);
  return sendAssertion(rig, fixture.assertionResponse(challenge, RP_ID, options));
}

function expectSession(reply: Reply, subject: string): Session {
  expect(reply.status).toBe(200);
  expect(reply.body).toEqual({
    subject,
    method: 'passkey',
    token: expect.any(String),
    issuedAt: expect.any(String),
    expiresAt: expect.any(String),
  });
  return reply.body as unknown as Session;
}

describe('a stranger cannot sign in as an account by naming it', () => {
  it('(a) B reads A\'s passkeySubject, sends it at register and in the verify envelope, and still lands on B\'s own account', async () => {
    const rig = await startRig();
    const a = await signUp(rig, createPasskeyFixture());

    // The name is public today: GET /accounts/:did needs no sign-in.
    const publicRow = await publicAccount(rig, a.did);
    expect(publicRow.status).toBe(200);
    const stolenName = String(publicRow.passkeySubject);
    expect(stolenName).toBe(a.name);

    const b = createPasskeyFixture();
    const options = await beginRegistration(rig, { subject: stolenName });
    b.rememberUserHandle(options.user.id);
    const response = b.registrationResponse(options.challenge, RP_ID);
    const verified = await post(rig, '/auth/passkey/verify', {
      responseJson: JSON.stringify({ subject: stolenName, response }),
    });

    const account = await accountOf(rig, String(verified.body.token));
    expect(account.status).toBe(200);
    expect(account.did).not.toBe(a.did);
  });

  it('(a) the name in a verify envelope is never read: a registration made for a different name is not filed under it', async () => {
    const rig = await startRig();
    const a = await signUp(rig, createPasskeyFixture());
    const b = createPasskeyFixture();
    const options = await beginRegistration(rig);
    b.rememberUserHandle(options.user.id);
    const response = b.registrationResponse(options.challenge, RP_ID);

    const verified = await post(rig, '/auth/passkey/verify', {
      responseJson: JSON.stringify({ subject: a.name, response }),
    });

    expectSession(verified, decodeUserId(options.user.id));
    expect(String(verified.body.subject)).not.toBe(a.name);
  });
});

describe('a returning person signs in with the passkey they made', () => {
  it('(b) start then signin, with no name sent, answers a session for the sign-up account', async () => {
    const rig = await startRig();
    const fixture = createPasskeyFixture();
    const a = await signUp(rig, fixture);

    const reply = await signIn(rig, fixture);

    const session = expectSession(reply, a.session.subject);
    expect(session.token).not.toBe(a.session.token);
    expect(a.session.subject).toBe(a.name);
    const account = await accountOf(rig, session.token);
    expect(account.did).toBe(a.did);
  });

  it('(b) the sign-in start needs no body and offers the site\'s passkeys: user verification required, no credential list', async () => {
    const rig = await startRig();

    const started = await post(rig, '/auth/passkey/signin/start');

    expect(started.status).toBe(200);
    expect(Object.keys(started.body)).toEqual(['optionsJson']);
    const options = JSON.parse(String(started.body.optionsJson)) as Record<string, unknown>;
    expect(options.rpId).toBe(RP_ID);
    expect(options.userVerification).toBe('required');
    expect(options.challenge).toEqual(expect.any(String));
    const allowed = options.allowCredentials as unknown[] | undefined;
    expect(allowed === undefined || allowed.length === 0).toBe(true);
  });

  it('(b) signing in twice in a row works: each sign-in is a fresh challenge and the counter grows', async () => {
    const rig = await startRig();
    const fixture = createPasskeyFixture();
    const a = await signUp(rig, fixture);

    expectSession(await signIn(rig, fixture), a.name);
    expectSession(await signIn(rig, fixture), a.name);
  });

  it('(c) B\'s own passkey signs B in, never A', async () => {
    const rig = await startRig();
    const fixtureA = createPasskeyFixture();
    const fixtureB = createPasskeyFixture();
    const a = await signUp(rig, fixtureA);
    const b = await signUp(rig, fixtureB);
    expect(b.did).not.toBe(a.did);

    const session = expectSession(await signIn(rig, fixtureB), b.name);

    const account = await accountOf(rig, session.token);
    expect(account.did).toBe(b.did);
    expect(account.did).not.toBe(a.did);
  });

  it('(e) restart: a passkey made on one adapter signs in on a second adapter built on the same store', async () => {
    const store = new MemoryPasskeyCredentialRepository();
    const accounts = new MemoryAccountRepository();
    const first = await startRig({ store, accounts });
    const fixture = createPasskeyFixture();
    const a = await signUp(first, fixture);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;

    const second = await startRig({ store, accounts });
    const reply = await signIn(second, fixture);

    const session = expectSession(reply, a.name);
    const account = await accountOf(second, session.token);
    expect(account.did).toBe(a.did);
  });
});

describe('(d) a sign-in that is not the stored passkey is refused, and no session is minted', () => {
  it('an unknown credential id', async () => {
    const rig = await startRig();
    const fixture = createPasskeyFixture();
    const a = await signUp(rig, fixture);
    const unknownId = createPasskeyFixture().credentialId;

    const reply = await signIn(rig, fixture, { credentialId: unknownId });

    expect(reply.status).toBe(401);
    expect(reply.body).toEqual(REFUSED);
    expectSession(await signIn(rig, fixture), a.name);
  });

  it('A\'s credential id with a signature from a different key', async () => {
    const rig = await startRig();
    const fixture = createPasskeyFixture();
    const a = await signUp(rig, fixture);
    const forger = createPasskeyFixture();

    const reply = await signIn(rig, fixture, { signWith: forger });

    expect(reply.status).toBe(401);
    expect(reply.body).toEqual(REFUSED);
    expectSession(await signIn(rig, fixture), a.name);
  });

  it('a userHandle naming another account', async () => {
    const rig = await startRig();
    const fixtureA = createPasskeyFixture();
    const a = await signUp(rig, fixtureA);
    const b = await signUp(rig, createPasskeyFixture());

    const reply = await signIn(rig, fixtureA, { userHandle: b.userHandle });

    expect(reply.status).toBe(401);
    expect(reply.body).toEqual(REFUSED);
    expectSession(await signIn(rig, fixtureA), a.name);
  });

  it('a missing userHandle', async () => {
    const rig = await startRig();
    const fixture = createPasskeyFixture();
    const a = await signUp(rig, fixture);

    const reply = await signIn(rig, fixture, { userHandle: null });

    expect(reply.status).toBe(401);
    expect(reply.body).toEqual(REFUSED);
    expectSession(await signIn(rig, fixture), a.name);
  });

  it('the same assertion sent twice: the second is refused on the challenge alone (counter 0 both times)', async () => {
    const rig = await startRig();
    const fixture = createPasskeyFixture();
    await signUp(rig, fixture);
    const challenge = await beginSignIn(rig);
    // Counter 0 is what many authenticators always report, and the library
    // accepts it while the stored counter is also 0, so only the single-use
    // challenge stands between this assertion and a replay.
    const assertion = fixture.assertionResponse(challenge, RP_ID, { counter: 0 });

    const first = await sendAssertion(rig, assertion);
    const second = await sendAssertion(rig, assertion);

    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
    expect(second.body).toEqual(REFUSED);
  });

  it('a challenge past its lifetime', async () => {
    const rig = await startRig();
    const fixture = createPasskeyFixture();
    const a = await signUp(rig, fixture);
    const challenge = await beginSignIn(rig);
    const assertion = fixture.assertionResponse(challenge, RP_ID);
    rig.clock.now += CHALLENGE_TTL_MS + 1;

    const reply = await sendAssertion(rig, assertion);

    expect(reply.status).toBe(401);
    expect(reply.body).toEqual(REFUSED);
    expectSession(await signIn(rig, fixture), a.name);
  });

  it('a counter that did not grow (a cloned authenticator)', async () => {
    const rig = await startRig();
    const fixture = createPasskeyFixture();
    const a = await signUp(rig, fixture);
    expectSession(await signIn(rig, fixture, { counter: 5 }), a.name);

    const clone = await signIn(rig, fixture, { counter: 3 });

    expect(clone.status).toBe(401);
    expect(clone.body).toEqual(REFUSED);
    expectSession(await signIn(rig, fixture, { counter: 6 }), a.name);
  });

  it('the user-verified flag off', async () => {
    const rig = await startRig();
    const fixture = createPasskeyFixture();
    const a = await signUp(rig, fixture);

    const reply = await signIn(rig, fixture, { userVerified: false });

    expect(reply.status).toBe(401);
    expect(reply.body).toEqual(REFUSED);
    expectSession(await signIn(rig, fixture), a.name);
  });

  it('a registration challenge cannot be used as a sign-in challenge', async () => {
    const rig = await startRig();
    const fixture = createPasskeyFixture();
    await signUp(rig, fixture);
    const options = await beginRegistration(rig);

    const reply = await sendAssertion(rig, fixture.assertionResponse(options.challenge, RP_ID));

    expect(reply.status).toBe(401);
    expect(reply.body).toEqual(REFUSED);
  });

  it('a body that is not JSON', async () => {
    const rig = await startRig();

    const reply = await post(rig, '/auth/passkey/signin', { responseJson: 'not json {' });

    expect(reply.status).toBe(401);
    expect(reply.body).toEqual(REFUSED);
  });
});

describe('the sign-in routes guard their bodies and their configuration', () => {
  it('400s a missing responseJson, before any adapter call', async () => {
    const rig = await startRig();

    const reply = await post(rig, '/auth/passkey/signin', {});

    expect(reply.status).toBe(400);
    expect(reply.body).toEqual({ error: 'body must be { responseJson }, a non-empty string' });
  });

  it('400s a non-string responseJson, before any adapter call', async () => {
    const rig = await startRig();

    const reply = await post(rig, '/auth/passkey/signin', { responseJson: 42 });

    expect(reply.status).toBe(400);
    expect(reply.body).toEqual({ error: 'body must be { responseJson }, a non-empty string' });
  });

  it('503s the sign-in start when passkeys are not configured, with the existing sentence; a sign-in attempt is refused like any other', async () => {
    const rig = await startRig({ passkeyConfigured: false });

    const started = await post(rig, '/auth/passkey/signin/start');
    const completed = await post(rig, '/auth/passkey/signin', { responseJson: '{}' });

    expect(started.status).toBe(503);
    expect(started.body).toEqual({ error: 'passkey sign-in is not configured on this deployment' });
    expect(completed.status).toBe(401);
    expect(completed.body).toEqual(REFUSED);
  });
});

describe('(f) storage faults answer 503 and mint nothing', () => {
  it('a store whose reads reject answers 503 storage unavailable on /auth/passkey/signin, not 401 and not 500', async () => {
    const store = new FlakyPasskeyStore();
    const rig = await startRig({ store });
    const fixture = createPasskeyFixture();
    const a = await signUp(rig, fixture);
    store.failReads = true;

    const reply = await signIn(rig, fixture);

    expect(reply.status).toBe(503);
    expect(reply.body).toEqual({ error: 'storage unavailable' });
    store.failReads = false;
    expectSession(await signIn(rig, fixture), a.name);
  });

  it('a store whose save rejects answers 503 storage unavailable on /auth/passkey/verify and mints no session', async () => {
    const store = new FlakyPasskeyStore();
    const rig = await startRig({ store });
    store.failSave = true;
    const fixture = createPasskeyFixture();
    const options = await beginRegistration(rig);
    fixture.rememberUserHandle(options.user.id);
    const response = fixture.registrationResponse(options.challenge, RP_ID);
    drawn.tokens.length = 0;

    const reply = await post(rig, '/auth/passkey/verify', { responseJson: JSON.stringify({ response }) });

    expect(reply.status).toBe(503);
    expect(reply.body).toEqual({ error: 'storage unavailable' });
    for (const token of drawn.tokens) {
      expect(await rig.adapter.getSession(token)).toBeNull();
    }
    expect(await store.inner.findById(fixture.credentialId)).toBeNull();
  });
});

describe('(g) register makes the name and binds it to the ceremony', () => {
  it('answers options whose user.id is a name the server made, with a plain label as user.name and passkeys required to be discoverable and user verified', async () => {
    const rig = await startRig();

    const options = await beginRegistration(rig);

    const name = decodeUserId(options.user.id);
    expect(name.length).toBeGreaterThan(0);
    expect(options.user.name).not.toBe(name);
    expect(options.user.name).not.toContain(name);
    expect(options.authenticatorSelection).toEqual({ residentKey: 'required', userVerification: 'required' });
  });

  it('a body naming any subject changes nothing: the name is still the server\'s, and each register makes a new one', async () => {
    const rig = await startRig();

    const named = await beginRegistration(rig, { subject: 'attacker-chosen-name' });
    const other = await beginRegistration(rig, { subject: 'attacker-chosen-name' });

    expect(decodeUserId(named.user.id)).not.toBe('attacker-chosen-name');
    expect(decodeUserId(named.user.id)).not.toBe(decodeUserId(other.user.id));
    expect(named.user.name).not.toContain('attacker-chosen-name');
  });

  it('the session the ceremony mints carries the name user.id carried', async () => {
    const rig = await startRig();
    const fixture = createPasskeyFixture();
    const options = await beginRegistration(rig);
    fixture.rememberUserHandle(options.user.id);
    const response = fixture.registrationResponse(options.challenge, RP_ID);

    const verified = await post(rig, '/auth/passkey/verify', { responseJson: JSON.stringify({ response }) });

    expectSession(verified, decodeUserId(options.user.id));
  });

  it('a registration finished twice mints one session: the second answer is refused', async () => {
    const rig = await startRig();
    const fixture = createPasskeyFixture();
    const options = await beginRegistration(rig);
    const response = fixture.registrationResponse(options.challenge, RP_ID);
    const body = { responseJson: JSON.stringify({ response }) };

    const first = await post(rig, '/auth/passkey/verify', body);
    const second = await post(rig, '/auth/passkey/verify', body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
    expect(second.body).toEqual(REFUSED);
  });
});

describe('(h) a credential id is bound once', () => {
  it('a second passkey claiming A\'s credential id is refused, stores nothing, and cannot sign in as A', async () => {
    const store = new MemoryPasskeyCredentialRepository();
    const rig = await startRig({ store });
    const fixtureA = createPasskeyFixture();
    const a = await signUp(rig, fixtureA);
    const before = await store.findById(fixtureA.credentialId);
    expect(before?.subject).toBe(a.name);

    // A "none" attestation lets anyone claim any credential id.
    const claimer = createPasskeyFixture({ credentialId: fixtureA.credentialId });
    const options = await beginRegistration(rig);
    claimer.rememberUserHandle(options.user.id);
    const response = claimer.registrationResponse(options.challenge, RP_ID);
    const claimed = await post(rig, '/auth/passkey/verify', { responseJson: JSON.stringify({ response }) });

    expect(claimed.status).toBe(401);
    expect(claimed.body).toEqual(REFUSED);
    const after = await store.findById(fixtureA.credentialId);
    expect(after).toEqual(before);

    // The claimer's key, presenting A's credential id and even A's public
    // name as the user handle, still cannot sign in as A.
    const forged = await signIn(rig, claimer, { userHandle: a.userHandle });
    expect(forged.status).toBe(401);
    expect(forged.body).toEqual(REFUSED);

    expectSession(await signIn(rig, fixtureA), a.name);
  });
});
