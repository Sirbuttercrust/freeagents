// FIX-B41a: list an agent from a site account, nothing to sign. bugs.md
// B41. Before this card, POST /agents required a delegation credential
// signed by the owner's own key, so a GitHub or passkey account (which
// holds no key of its own) could never list at all. This is the site
// path: a signed-in owner names no `did` and no `delegation`, and the
// platform derives the agent DID and signs the delegation itself, with
// the owner's own platform-derived key (P-19, 2026-08-17 ruling: "the
// person is never asked to sign anything").
import type { Server } from 'node:http';
import { sign as nodeSign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import { createKnownKeyStore } from '../../src/adapters/identity/did-abt-resolver.js';
import { MemoryAgentRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSessionToken, testSessionAdapter } from '../helpers/session-fixtures.js';
import { createPasskeyFixture } from '../helpers/webauthn-fixtures.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

const ORIGINAL_SEED = process.env.FREEAGENTS_PLATFORM_SEED;

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function postSigned(baseUrl: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, 'POST', targetUri, { body: bodyText });
  return fetch(targetUri, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
    body: bodyText,
  });
}

describe('POST /agents, site listing path (FIX-B41a), GitHub session', () => {
  let server: Server;
  let baseUrl: string;
  let agentRepo: MemoryAgentRepository;
  let accountRepo: MemoryAccountRepository;
  const sessionAdapter = testSessionAdapter();
  let sessionToken: string;

  beforeAll(async () => {
    process.env.FREEAGENTS_PLATFORM_SEED = 'b41'.padEnd(64, '0');
    agentRepo = new MemoryAgentRepository();
    accountRepo = new MemoryAccountRepository();
    const identity = createIdentityAdapter(createKnownKeyStore());
    const app = createApp(accountRepo, agentRepo, identity, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected server to listen on a port');
    baseUrl = `http://127.0.0.1:${address.port}`;
    sessionToken = await mintSessionToken(sessionAdapter);
  });

  afterAll(() => {
    server.close();
    if (ORIGINAL_SEED === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
    else process.env.FREEAGENTS_PLATFORM_SEED = ORIGINAL_SEED;
  });

  it('201s with no did and no delegation; the stored delegation is signed by the platform', async () => {
    const res = await postJson(
      baseUrl,
      '/agents',
      { name: 'scout', skills: ['triage'] },
      { authorization: `Bearer ${sessionToken}` },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.did).toBe('string');
    const delegation = body.delegation as Record<string, unknown>;
    const credentialSubject = delegation.credentialSubject as Record<string, unknown>;
    expect(delegation.issuer).toBe(body.operatorDid);
    expect(credentialSubject.id).toBe(body.did);
    expect(credentialSubject.delegationSignedBy).toBe('platform');

    // GET /agents/:agentDid serves it back.
    const read = await fetch(`${baseUrl}/agents/${body.did as string}`);
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as Record<string, unknown>;
    expect(readBody.did).toBe(body.did);
  });

  it('a GitHub owner naming their own login gets proofStatus verified (G1)', async () => {
    const live = await sessionAdapter.getSession(sessionToken);
    if (live === null) throw new Error('expected a live session');
    const res = await postJson(
      baseUrl,
      '/agents',
      { name: 'scout-github', skills: ['triage'], githubLogin: live.subject },
      { authorization: `Bearer ${sessionToken}` },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.proofStatus).toBe('verified');
  });
});

describe('POST /agents, site listing path (FIX-B41a), passkey session', () => {
  let server: Server;
  let baseUrl: string;
  const passkeySessionAdapter = createSessionAdapter({
    github: fakeGitHubConfig(),
    passkey: { rpName: 'FreeAgents test', rpID: 'localhost', origin: 'http://localhost:3000' },
  });

  beforeAll(async () => {
    process.env.FREEAGENTS_PLATFORM_SEED = 'b41'.padEnd(64, '1');
    const identity = createIdentityAdapter(createKnownKeyStore());
    const app = createApp(
      new MemoryAccountRepository(),
      new MemoryAgentRepository(),
      identity,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      passkeySessionAdapter,
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected server to listen on a port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    server.close();
    if (ORIGINAL_SEED === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
    else process.env.FREEAGENTS_PLATFORM_SEED = ORIGINAL_SEED;
  });

  it('201s with no GitHub login anywhere', async () => {
    const subject = 'passkey-owner-1';
    const { optionsJson } = await passkeySessionAdapter.registerPasskey(subject);
    const { challenge } = JSON.parse(optionsJson) as { challenge: string };
    const fixture = createPasskeyFixture();
    const response = fixture.registrationResponse(challenge, 'localhost');
    const session = await passkeySessionAdapter.verifyPasskey(JSON.stringify({ subject, response }));
    if (session === null) throw new Error('expected a passkey session');

    const res = await postJson(
      baseUrl,
      '/agents',
      { name: 'passkey-scout', skills: ['triage'] },
      { authorization: `Bearer ${session.token}` },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.githubLogin).toBeNull();
    expect(typeof body.did).toBe('string');
  });
});

describe('POST /agents, site path bringing its own agent DID (FIX-B41a item 5)', () => {
  let server: Server;
  let baseUrl: string;
  const sessionAdapter = testSessionAdapter();
  let sessionToken: string;

  beforeAll(async () => {
    process.env.FREEAGENTS_PLATFORM_SEED = 'b41'.padEnd(64, '2');
    const identity = createIdentityAdapter(createKnownKeyStore());
    const app = createApp(
      new MemoryAccountRepository(),
      new MemoryAgentRepository(),
      identity,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      sessionAdapter,
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected server to listen on a port');
    baseUrl = `http://127.0.0.1:${address.port}`;
    sessionToken = await mintSessionToken(sessionAdapter);
  });

  afterAll(() => {
    server.close();
    if (ORIGINAL_SEED === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
    else process.env.FREEAGENTS_PLATFORM_SEED = ORIGINAL_SEED;
  });

  async function ownerDid(): Promise<string> {
    const res = await postJson(
      baseUrl,
      '/agents',
      { name: 'owner-probe', skills: ['triage'] },
      { authorization: `Bearer ${sessionToken}` },
    );
    const body = (await res.json()) as Record<string, unknown>;
    return body.operatorDid as string;
  }

  it('a correct agentProof lists an agent at that exact DID', async () => {
    const owner = await ownerDid();
    const agentSigning = await signingIdentityFromSeed(new Uint8Array(32).fill(211));
    const payload = `freeagents:list-agent:v1:${agentSigning.did}:${owner}`;
    const signature = nodeSign(null, Buffer.from(payload, 'utf8'), agentSigning.privateKey).toString('base64');
    const publicKeyMultibase = agentSigning.keyid.slice(agentSigning.keyid.indexOf('#') + 1);

    const res = await postJson(
      baseUrl,
      '/agents',
      {
        name: 'own-key-agent',
        skills: ['triage'],
        did: agentSigning.did,
        agentProof: { signature, publicKeyMultibase },
      },
      { authorization: `Bearer ${sessionToken}` },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.did).toBe(agentSigning.did);
  });

  it('a proof over the wrong agent DID is 400 and stores nothing', async () => {
    const owner = await ownerDid();
    const agentSigning = await signingIdentityFromSeed(new Uint8Array(32).fill(212));
    const otherSigning = await signingIdentityFromSeed(new Uint8Array(32).fill(213));
    const wrongPayload = `freeagents:list-agent:v1:${otherSigning.did}:${owner}`;
    const signature = nodeSign(null, Buffer.from(wrongPayload, 'utf8'), agentSigning.privateKey).toString('base64');
    const publicKeyMultibase = agentSigning.keyid.slice(agentSigning.keyid.indexOf('#') + 1);

    const res = await postJson(
      baseUrl,
      '/agents',
      {
        name: 'wrong-payload-agent',
        skills: ['triage'],
        did: agentSigning.did,
        agentProof: { signature, publicKeyMultibase },
      },
      { authorization: `Bearer ${sessionToken}` },
    );
    expect(res.status).toBe(400);

    const read = await fetch(`${baseUrl}/agents/${agentSigning.did}`);
    expect(read.status).toBe(404);
  });

  it('a proof over the wrong owner DID is 400', async () => {
    await ownerDid();
    const agentSigning = await signingIdentityFromSeed(new Uint8Array(32).fill(214));
    const wrongPayload = `freeagents:list-agent:v1:${agentSigning.did}:did:abt:zSomeoneElseEntirely`;
    const signature = nodeSign(null, Buffer.from(wrongPayload, 'utf8'), agentSigning.privateKey).toString('base64');
    const publicKeyMultibase = agentSigning.keyid.slice(agentSigning.keyid.indexOf('#') + 1);

    const res = await postJson(
      baseUrl,
      '/agents',
      {
        name: 'wrong-owner-agent',
        skills: ['triage'],
        did: agentSigning.did,
        agentProof: { signature, publicKeyMultibase },
      },
      { authorization: `Bearer ${sessionToken}` },
    );
    expect(res.status).toBe(400);
  });

  it('a proof from a key that does not derive the named DID is 400', async () => {
    const owner = await ownerDid();
    const agentSigning = await signingIdentityFromSeed(new Uint8Array(32).fill(215));
    const otherSigning = await signingIdentityFromSeed(new Uint8Array(32).fill(216));
    const payload = `freeagents:list-agent:v1:${agentSigning.did}:${owner}`;
    // Signed by a DIFFERENT key than the one named in the DID.
    const signature = nodeSign(null, Buffer.from(payload, 'utf8'), otherSigning.privateKey).toString('base64');
    const otherPublicKeyMultibase = otherSigning.keyid.slice(otherSigning.keyid.indexOf('#') + 1);

    const res = await postJson(
      baseUrl,
      '/agents',
      {
        name: 'mismatched-key-agent',
        skills: ['triage'],
        did: agentSigning.did,
        agentProof: { signature, publicKeyMultibase: otherPublicKeyMultibase },
      },
      { authorization: `Bearer ${sessionToken}` },
    );
    expect(res.status).toBe(400);
  });

  it('a missing agentProof, when did is named, is 400 naming what to sign', async () => {
    await ownerDid();
    const agentSigning = await signingIdentityFromSeed(new Uint8Array(32).fill(217));
    const res = await postJson(
      baseUrl,
      '/agents',
      { name: 'no-proof-agent', skills: ['triage'], did: agentSigning.did },
      { authorization: `Bearer ${sessionToken}` },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain('sign the exact string');
  });
});

describe('POST /agents, site path refusals (FIX-B41a)', () => {
  let server: Server;
  let baseUrl: string;
  let accountRepo: MemoryAccountRepository;
  const sessionAdapter = testSessionAdapter();

  beforeAll(async () => {
    process.env.FREEAGENTS_PLATFORM_SEED = 'b41'.padEnd(64, '3');
    accountRepo = new MemoryAccountRepository();
    const identity = createIdentityAdapter(createKnownKeyStore());
    const app = createApp(
      accountRepo,
      new MemoryAgentRepository(),
      identity,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      sessionAdapter,
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected server to listen on a port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    server.close();
    if (ORIGINAL_SEED === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
    else process.env.FREEAGENTS_PLATFORM_SEED = ORIGINAL_SEED;
  });

  it('no session and no delegation is 401', async () => {
    const res = await postJson(baseUrl, '/agents', { name: 'nobody', skills: ['triage'] });
    expect(res.status).toBe(401);
  });

  it('a signature-only caller with no delegation is 400 naming the delegation', async () => {
    const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(218));
    await accountRepo.register({ did: identity.did, githubLogin: 'sig-only-owner' });
    const res = await postSigned(baseUrl, '/agents', { name: 'sig-only', skills: ['triage'] }, identity);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain('delegation');
  });

  it('an account not derived by the platform is 409 naming the wallet path', async () => {
    // A wallet-registered account: no session ever provisioned this DID,
    // so its DID cannot equal what createOperatorDid derives from any
    // session subject. Since resolveActingParty only ever returns a
    // wallet-registered DID for a genuine R-34 signature (never a
    // session), the site path (delegation === undefined) can only be
    // reached by a session here -- so this refusal is exercised by
    // provisioning a session account first, then independently proving
    // the 409 message exists for a mismatched derivation via a direct
    // account whose DID differs from the session-derived one is not
    // reachable through this route's session branch. This test instead
    // pins the sentence directly against the identity adapter's own
    // derivation mismatch, exercised through the route with a forged
    // session subject that cannot resolve to the pre-registered wallet
    // account: registering a wallet account, then asking a DIFFERENT
    // session (with its own provisioned DID) to act as it is refused
    // earlier (403), so the affirmative 409 case is proven at the
    // identity-adapter level in tests/adapters/identity/identity.test.ts
    // and the message text is pinned by reading the route source; this
    // sentence-level proof runs the actual mismatch by directly forcing
    // resolveActingParty's account lookup to return a wallet-registered
    // account for the live session's own subject.
    const walletDid = 'did:abt:zWalletOnlyOperator';
    await accountRepo.register({ did: walletDid, githubLogin: 'wallet-only-login' });
    const walletSessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'wallet-only-login', id: 424242 }),
    });
    const walletApp = createApp(
      accountRepo,
      new MemoryAgentRepository(),
      createIdentityAdapter(createKnownKeyStore()),
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      walletSessionAdapter,
    );
    const walletServer = walletApp.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => walletServer.once('listening', resolve));
    const address = walletServer.address();
    if (address === null || typeof address === 'string') throw new Error('expected server to listen on a port');
    const walletBaseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const token = await mintSessionToken(walletSessionAdapter);
      const res = await postJson(
        walletBaseUrl,
        '/agents',
        { name: 'wallet-owner-agent', skills: ['triage'] },
        { authorization: `Bearer ${token}` },
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body.error)).toContain('wallet path');
    } finally {
      await new Promise<void>((resolve) => walletServer.close(() => resolve()));
    }
  });

  it('the platform seed unset is 503, nothing stored', async () => {
    const original = process.env.FREEAGENTS_PLATFORM_SEED;
    delete process.env.FREEAGENTS_PLATFORM_SEED;
    try {
      const noSeedAccountRepo = new MemoryAccountRepository();
      const noSeedAgentRepo = new MemoryAgentRepository();
      const noSeedSession = createSessionAdapter({
        github: fakeGitHubConfig(),
        fetchImpl: fakeGitHubFetch({ login: 'no-seed-owner', id: 777 }),
      });
      const noSeedApp = createApp(
        noSeedAccountRepo,
        noSeedAgentRepo,
        createIdentityAdapter(createKnownKeyStore()),
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        noSeedSession,
      );
      const noSeedServer = noSeedApp.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => noSeedServer.once('listening', resolve));
      const address = noSeedServer.address();
      if (address === null || typeof address === 'string') throw new Error('expected server to listen on a port');
      const noSeedBaseUrl = `http://127.0.0.1:${address.port}`;
      try {
        const token = await mintSessionToken(noSeedSession);
        const res = await postJson(
          noSeedBaseUrl,
          '/agents',
          { name: 'no-seed-agent', skills: ['triage'] },
          { authorization: `Bearer ${token}` },
        );
        expect(res.status).toBe(503);
        const listed = await noSeedAgentRepo.listAll?.();
        expect(listed).toEqual([]);
      } finally {
        await new Promise<void>((resolve) => noSeedServer.close(() => resolve()));
      }
    } finally {
      if (original === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
      else process.env.FREEAGENTS_PLATFORM_SEED = original;
    }
  });
});
