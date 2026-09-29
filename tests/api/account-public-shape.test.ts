// FIX-B61c: the name a passkey was made under is private to the account.
// Before this card every account answer carried passkeySubject, and
// GET /accounts/:did needs no sign-in, so anyone who knew a DID could read
// it. Pinned here, over real HTTP and a real WebAuthn sign-up
// (tests/helpers/webauthn-fixtures.ts): the two answers that go to whoever
// asks (GET /accounts/:did and the POST /accounts 201) carry the five public
// keys and no passkeySubject key at all, while the two answers that go to
// the account itself (GET /accounts/me and the operator-address PATCH 200)
// keep it.
import type { Server } from 'node:http';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import type { Session } from '../../src/adapters/identity/session.js';
import { MemoryAccountRepository, MemoryPasskeyCredentialRepository } from '../../src/adapters/storage/memory.js';
import { fakeGitHubConfig } from '../helpers/session-fixtures.js';
import { createPasskeyFixture, type PasskeyFixture } from '../helpers/webauthn-fixtures.js';

const RP_ID = 'localhost';
const PUBLIC_KEYS = ['createdAt', 'did', 'githubLogin', 'operatorAddressAbt', 'operatorAddressEvm'];
const OWN_KEYS = [...PUBLIC_KEYS, 'passkeySubject'].sort();
const EVM_ADDRESS = '0x' + 'ab'.repeat(20);

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

interface Rig {
  readonly baseUrl: string;
  readonly accounts: MemoryAccountRepository;
}

async function startRig(): Promise<Rig> {
  const adapter = createSessionAdapter({
    github: fakeGitHubConfig(),
    passkey: { rpName: 'FreeAgents test', rpID: RP_ID, origin: 'http://localhost:3000' },
    passkeyCredentials: new MemoryPasskeyCredentialRepository(),
    now: () => 1_800_000_000_000,
  });
  const accounts = new MemoryAccountRepository();
  const app = createApp(accounts, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, adapter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected server to listen on a port');
  return { baseUrl: `http://127.0.0.1:${address.port}`, accounts };
}

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function send(rig: Rig, method: string, path: string, opts: { body?: unknown; token?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token !== undefined) headers.authorization = ['Bearer', opts.token].join(' ');
  const res = await fetch(`${rig.baseUrl}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// A person makes a passkey: register (no name sent), verify.
async function signUp(rig: Rig, fixture: PasskeyFixture): Promise<{ token: string; did: string }> {
  const started = await send(rig, 'POST', '/auth/passkey/register');
  expect(started.status).toBe(200);
  const options = JSON.parse(String(started.body.optionsJson)) as { challenge: string; user: { id: string } };
  fixture.rememberUserHandle(options.user.id);
  const response = fixture.registrationResponse(options.challenge, RP_ID);
  const verified = await send(rig, 'POST', '/auth/passkey/verify', { body: { responseJson: JSON.stringify({ response }) } });
  expect(verified.status).toBe(200);
  const token = (verified.body as unknown as Session).token;
  const me = await send(rig, 'GET', '/accounts/me', { token });
  expect(me.status).toBe(200);
  return { token, did: String(me.body.did) };
}

describe('what an account answer shows, by who is asking', () => {
  it('(a) GET /accounts/:did with no sign-in answers the five public keys and no passkeySubject key', async () => {
    const rig = await startRig();
    const a = await signUp(rig, createPasskeyFixture());
    const stored = await rig.accounts.findByDid(a.did);
    expect(stored?.passkeySubject).toEqual(expect.any(String));

    const res = await send(rig, 'GET', `/accounts/${a.did}`);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(PUBLIC_KEYS);
    expect('passkeySubject' in res.body).toBe(false);
  });

  it('(b) POST /accounts with a passkeySubject in the body answers 201 with the five public keys and no passkeySubject key', async () => {
    const rig = await startRig();

    const res = await send(rig, 'POST', '/accounts', {
      body: { did: 'did:abt:zpublicshape', githubLogin: 'public-shape-login', passkeySubject: 'public-shape-passkey' },
    });

    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(PUBLIC_KEYS);
    expect('passkeySubject' in res.body).toBe(false);
    // The subject is still stored: only the answer stops showing it.
    expect((await rig.accounts.findByDid('did:abt:zpublicshape'))?.passkeySubject).toBe('public-shape-passkey');
  });

  it('(c) GET /accounts/me for the passkey session carries passkeySubject, equal to the stored row', async () => {
    const rig = await startRig();
    const a = await signUp(rig, createPasskeyFixture());
    const stored = await rig.accounts.findByDid(a.did);

    const res = await send(rig, 'GET', '/accounts/me', { token: a.token });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(OWN_KEYS);
    expect(res.body.passkeySubject).toBe(stored?.passkeySubject);
    expect(res.body.passkeySubject).toEqual(expect.any(String));
  });

  it('(d) the operator-address PATCH 200 for a passkey account carries passkeySubject, equal to the stored row', async () => {
    const rig = await startRig();
    const a = await signUp(rig, createPasskeyFixture());

    const res = await send(rig, 'PATCH', `/accounts/${a.did}/operator-address`, {
      token: a.token,
      body: { operatorAddressEvm: EVM_ADDRESS },
    });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(OWN_KEYS);
    expect(res.body.operatorAddressEvm).toBe(EVM_ADDRESS);
    expect(res.body.passkeySubject).toBe((await rig.accounts.findByDid(a.did))?.passkeySubject);
    expect(res.body.passkeySubject).toEqual(expect.any(String));
  });
});
