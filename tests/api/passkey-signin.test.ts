// FIX-B61a: before this card a passkey sign-in was a fresh registration
// under a name the caller chose, and that name was public on
// GET /accounts/:did, so a stranger could register their own passkey under
// a victim's name and be signed in as the victim. (FIX-B61c later took the
// name off the public read.) Pinned here: the server
// makes the name at register, the credential is stored once per credential
// id, and every later sign-in is a WebAuthn authentication checked against
// the stored key while the browser names nobody. Real HTTP, real WebAuthn
// bytes (tests/helpers/webauthn-fixtures.ts), never a stubbed verifier.
import type { Server } from 'node:http';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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

// The generated Prisma client, with one in-memory passkeyCredential table, so
// the deployed adapter's storage choice can be observed without a database.
const dbRows = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock('../../src/generated/prisma/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/generated/prisma/index.js')>(
    '../../src/generated/prisma/index.js',
  );
  return {
    Prisma: actual.Prisma,
    PrismaClient: class {
      passkeyCredential = {
        create: async ({ data }: { data: { id: string } }) => void dbRows.set(data.id, { ...data, lastUsedAt: null }),
        findUnique: async ({ where }: { where: { id: string } }) => dbRows.get(where.id) ?? null,
        update: async ({ where, data }: { where: { id: string }; data: object }) =>
          void dbRows.set(where.id, { ...dbRows.get(where.id), ...data }),
      };
    },
  };
});

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter, sessionAdapterFromEnv } from '../../src/adapters/identity/session-github-passkey.js';
import type { Session, SessionAdapter } from '../../src/adapters/identity/session.js';
import { MemoryAccountRepository, MemoryPasskeyCredentialRepository } from '../../src/adapters/storage/memory.js';
import type { PasskeyCredentialRepository, StoredPasskeyCredential } from '../../src/adapters/storage/types.js';
import { fakeGitHubConfig } from '../helpers/session-fixtures.js';
import { createPasskeyFixture, type AssertionOptions, type PasskeyFixture } from '../helpers/webauthn-fixtures.js';

const RP_ID = 'localhost';
const REFUSED = { error: 'invalid or expired sign-in attempt' };
const CHALLENGE_TTL_MS = 60_000;

let server: Server | null = null;

// GET /accounts/me provisions the account row on the first signed-in
// request, and that derives an operator DID from the platform seed.
beforeAll(() => {
  vi.stubEnv('FREEAGENTS_PLATFORM_SEED', 'f'.repeat(64));
});
afterAll(() => {
  vi.unstubAllEnvs();
});

afterEach(async () => {
  if (server !== null) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

// A real in-memory passkey store whose reads or writes can be made to fail.
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

  recordUse(id: string, newCounter: number): Promise<void> {
    return this.inner.recordUse(id, newCounter);
  }
}

interface Rig {
  readonly baseUrl: string;
  readonly adapter: SessionAdapter;
  readonly clock: { now: number };
  readonly accounts: MemoryAccountRepository;
}

interface RigOptions {
  readonly store?: PasskeyCredentialRepository;
  readonly accounts?: MemoryAccountRepository;
  readonly passkeyConfigured?: boolean;
}

async function startRig(options: RigOptions = {}): Promise<Rig> {
  const clock = { now: 1_800_000_000_000 };
  const adapter = createSessionAdapter({
    github: fakeGitHubConfig(),
    ...(options.passkeyConfigured === false
      ? {}
      : { passkey: { rpName: 'FreeAgents test', rpID: RP_ID, origin: 'http://localhost:3000' } }),
    passkeyCredentials: options.store ?? new MemoryPasskeyCredentialRepository(),
    passkeyChallengeTtlMs: CHALLENGE_TTL_MS,
    now: () => clock.now,
  });
  const accounts = options.accounts ?? new MemoryAccountRepository();
  const app = createApp(accounts, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, adapter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected server to listen on a port');
  return { baseUrl: `http://127.0.0.1:${address.port}`, adapter, clock, accounts };
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

async function accountOf(rig: Rig, token: string): Promise<{ status: number; did: string }> {
  const res = await fetch(`${rig.baseUrl}/accounts/me`, { headers: { authorization: ['Bearer', token].join(' ') } });
  const body = (await res.json()) as { did?: string };
  return { status: res.status, did: String(body.did) };
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

// A person makes a passkey: register (no name sent), verify. The
// authenticator remembers the user handle the server chose.
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
  it('(a) B reads A\'s passkeySubject, sends it at register and in the verify envelope, and still lands on B\'s own account, under the server\'s name', async () => {
    const rig = await startRig();
    const a = await signUp(rig, createPasskeyFixture());

    // B61c: the passkey's name is private to the account, so the public read
    // carries no passkeySubject key at all, and the attacker's copy of the
    // name comes from the repository row, the one place it still lives.
    const publicRow = await fetch(`${rig.baseUrl}/accounts/${a.did}`);
    expect(publicRow.status).toBe(200);
    expect('passkeySubject' in ((await publicRow.json()) as object)).toBe(false);
    const stolenName = String((await rig.accounts.findByDid(a.did))?.passkeySubject);
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
    // The name in the envelope is never read: the session carries the name
    // the server put in user.id, not A's.
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
    // A second sign-in is a fresh challenge and a counter that grew.
    expectSession(await signIn(rig, fixture), a.name);
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

  it('(c) B\'s own passkey signs B in, never A', async () => {
    const rig = await startRig();
    const a = await signUp(rig, createPasskeyFixture());
    const fixtureB = createPasskeyFixture();
    const b = await signUp(rig, fixtureB);
    expect(b.did).not.toBe(a.did);

    const session = expectSession(await signIn(rig, fixtureB), b.name);

    expect((await accountOf(rig, session.token)).did).toBe(b.did);
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
    const session = expectSession(await signIn(second, fixture), a.name);

    expect((await accountOf(second, session.token)).did).toBe(a.did);
  });
});

// One refused sign-in: 401 with the one sentence, and the real passkey
// still signs in afterwards.
async function expectRefused(rig: Rig, fixture: PasskeyFixture, name: string, options?: AssertionOptions): Promise<void> {
  const reply = await signIn(rig, fixture, options);
  expect(reply.status).toBe(401);
  expect(reply.body).toEqual(REFUSED);
  expectSession(await signIn(rig, fixture, options?.counter === undefined ? undefined : { counter: options.counter + 3 }), name);
}

describe('(d) a sign-in that is not the stored passkey is refused, and no session is minted', () => {
  it('an unknown credential id', async () => {
    const rig = await startRig();
    const fixture = createPasskeyFixture();
    const a = await signUp(rig, fixture);
    await expectRefused(rig, fixture, a.name, { credentialId: createPasskeyFixture().credentialId });
  });

  it('A\'s credential id with a signature from a different key', async () => {
    const rig = await startRig();
    const fixture = createPasskeyFixture();
    const a = await signUp(rig, fixture);
    await expectRefused(rig, fixture, a.name, { signWith: createPasskeyFixture() });
  });

  it('a userHandle naming another account', async () => {
    const rig = await startRig();
    const fixtureA = createPasskeyFixture();
    const a = await signUp(rig, fixtureA);
    const b = await signUp(rig, createPasskeyFixture());
    await expectRefused(rig, fixtureA, a.name, { userHandle: b.userHandle });
  });

  it('a missing userHandle', async () => {
    const rig = await startRig();
    const fixture = createPasskeyFixture();
    const a = await signUp(rig, fixture);
    await expectRefused(rig, fixture, a.name, { userHandle: null });
  });

  it('the same assertion sent twice: the second is refused on the challenge alone (counter 0 both times)', async () => {
    const rig = await startRig();
    const fixture = createPasskeyFixture();
    await signUp(rig, fixture);
    const challenge = await beginSignIn(rig);
    // Counter 0 twice is accepted by the library, so only the single-use
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
    const assertion = fixture.assertionResponse(await beginSignIn(rig), RP_ID);
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

    await expectRefused(rig, fixture, a.name, { counter: 3 });
  });

  it('the user-verified flag off', async () => {
    const rig = await startRig();
    const fixture = createPasskeyFixture();
    const a = await signUp(rig, fixture);
    await expectRefused(rig, fixture, a.name, { userVerified: false });
  });

  it('a registration challenge cannot be used as a sign-in challenge', async () => {
    const rig = await startRig();
    const fixture = createPasskeyFixture();
    await signUp(rig, fixture);
    const options = await beginRegistration(rig);

    const reply = await sendAssertion(rig, fixture.assertionResponse(options.challenge, RP_ID));

    expect([reply.status, reply.body]).toEqual([401, REFUSED]);
  });

  it('a body that is not JSON', async () => {
    const rig = await startRig();

    const reply = await post(rig, '/auth/passkey/signin', { responseJson: 'not json {' });

    expect([reply.status, reply.body]).toEqual([401, REFUSED]);
  });
});

describe('the sign-in routes guard their bodies and their configuration', () => {
  it('400s a missing or non-string responseJson, before any adapter call', async () => {
    const rig = await startRig();

    for (const body of [{}, { responseJson: 42 }]) {
      const reply = await post(rig, '/auth/passkey/signin', body);
      expect(reply.status).toBe(400);
      expect(reply.body).toEqual({ error: 'body must be { responseJson }, a non-empty string' });
    }
  });

  it('503s the sign-in start when passkeys are not configured, with the existing sentence; a sign-in attempt is refused like any other', async () => {
    const rig = await startRig({ passkeyConfigured: false });

    const started = await post(rig, '/auth/passkey/signin/start');
    const completed = await post(rig, '/auth/passkey/signin', { responseJson: '{}' });

    expect([started.status, started.body]).toEqual([503, { error: 'passkey sign-in is not configured on this deployment' }]);
    expect([completed.status, completed.body]).toEqual([401, REFUSED]);
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

    expect([reply.status, reply.body]).toEqual([503, { error: 'storage unavailable' }]);
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

    expect([reply.status, reply.body]).toEqual([503, { error: 'storage unavailable' }]);
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
    // The library adds requireResidentKey beside residentKey.
    expect(options.authenticatorSelection).toEqual({
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    });
  });

  it('a body naming any subject changes nothing: the name is still the server\'s, and each register makes a new one', async () => {
    const rig = await startRig();

    const named = await beginRegistration(rig, { subject: 'attacker-chosen-name' });
    const other = await beginRegistration(rig, { subject: 'attacker-chosen-name' });

    expect(decodeUserId(named.user.id)).not.toBe('attacker-chosen-name');
    expect(decodeUserId(named.user.id)).not.toBe(decodeUserId(other.user.id));
    expect(named.user.name).not.toContain('attacker-chosen-name');
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

    // A "none" attestation lets anyone claim any credential id.
    const claimer = createPasskeyFixture({ credentialId: fixtureA.credentialId });
    const options = await beginRegistration(rig);
    claimer.rememberUserHandle(options.user.id);
    const response = claimer.registrationResponse(options.challenge, RP_ID);
    const claimed = await post(rig, '/auth/passkey/verify', { responseJson: JSON.stringify({ response }) });

    expect([claimed.status, claimed.body]).toEqual([401, REFUSED]);
    expect(await store.findById(fixtureA.credentialId)).toEqual(before);

    // The claimer's key, with A's credential id and A's name as the user handle.
    const forged = await signIn(rig, claimer, { userHandle: a.userHandle });
    expect([forged.status, forged.body]).toEqual([401, REFUSED]);

    expectSession(await signIn(rig, fixtureA), a.name);
  });
});

describe('a sign-up whose authenticator did not verify the user', () => {
  it('is refused at register-verify with the one sentence, stores nothing and mints no session', async () => {
    const store = new MemoryPasskeyCredentialRepository();
    const rig = await startRig({ store });
    const fixture = createPasskeyFixture();
    const options = await beginRegistration(rig);
    fixture.rememberUserHandle(options.user.id);
    const response = fixture.registrationResponse(options.challenge, RP_ID, { userVerified: false });
    drawn.tokens.length = 0;

    const reply = await post(rig, '/auth/passkey/verify', { responseJson: JSON.stringify({ response }) });

    expect([reply.status, reply.body]).toEqual([401, REFUSED]);
    expect(await store.findById(fixture.credentialId)).toBeNull();
    for (const token of drawn.tokens) {
      expect(await rig.adapter.getSession(token)).toBeNull();
    }
  });
});

describe('the deployed adapter keeps passkeys in the database', () => {
  it('sessionAdapterFromEnv with DATABASE_URL set stores a sign-up through the Prisma driver, and a second adapter signs in from it', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pw@127.0.0.1:5432/freeagents');
    vi.stubEnv('FREEAGENTS_PASSKEY_RP_ID', RP_ID);
    vi.stubEnv('FREEAGENTS_PASSKEY_ORIGIN', 'http://localhost:3000');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    dbRows.clear();
    const fixture = createPasskeyFixture();

    const first = sessionAdapterFromEnv();
    const registration = JSON.parse((await first.registerPasskey('deployed-name')).optionsJson) as RegistrationOptions;
    fixture.rememberUserHandle(registration.user.id);
    const signedUp = await first.verifyPasskey(
      JSON.stringify({ response: fixture.registrationResponse(registration.challenge, RP_ID) }),
    );

    expect(signedUp?.subject).toBe('deployed-name');
    expect([...dbRows.keys()]).toEqual([fixture.credentialId]);
    const second = sessionAdapterFromEnv();
    const started = JSON.parse((await second.beginPasskeySignIn()).optionsJson) as { challenge: string };
    const back = await second.completePasskeySignIn(JSON.stringify(fixture.assertionResponse(started.challenge, RP_ID)));
    expect(back?.subject).toBe('deployed-name');
    vi.restoreAllMocks();
  });
});
