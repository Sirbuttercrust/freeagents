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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import * as vc from '@digitalbazaar/vc';
import { securityLoader } from '@digitalbazaar/security-document-loader';

import { createApp } from '../../src/api/app.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import { createKnownKeyStore } from '../../src/adapters/identity/did-abt-resolver.js';
import { MemoryAgentRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSessionToken, testSessionAdapter } from '../helpers/session-fixtures.js';
import { createPasskeyFixture } from '../helpers/webauthn-fixtures.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

// Invariant 2 (MISSION.md): verify a W3C credential using ONLY
// @digitalbazaar/* and the credential itself, exactly as
// tests/api/agent-invariant2.test.ts's own verifyIndependent does for the
// wallet path. Copied here (not imported across test files) so the
// site-path proof stands alone: given only the stored delegation, a
// stranger reaches the same verdict this service does, with no call back
// to this service and no @arcblock/vc.
async function verifyIndependent(credential: Record<string, unknown>): Promise<boolean> {
  try {
    const proof = credential.proof as Record<string, unknown>;
    const verificationMethod = String(proof.verificationMethod);
    const issuer = String(credential.issuer);

    const hashIndex = verificationMethod.indexOf('#');
    if (hashIndex === -1) return false;
    const fingerprint = verificationMethod.slice(hashIndex + 1);

    const key = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint });

    const { fromPublicKey } = await import('@arcblock/did');
    const keyWithBuffer = key as unknown as { _publicKeyBuffer: Uint8Array };
    const derivedDidSuffix = fromPublicKey(keyWithBuffer._publicKeyBuffer);
    const issuerSuffix = issuer.replace(/^did:abt:/, '');
    if (derivedDidSuffix !== issuerSuffix) return false;

    key.controller = issuer;
    key.id = verificationMethod;

    const loader = securityLoader();
    loader.addStatic(key.id, {
      '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
      ...key.export({ publicKey: true }),
    });
    loader.addStatic(issuer, {
      '@context': 'https://www.w3.org/ns/did/v1',
      id: issuer,
      assertionMethod: [key.id],
      verificationMethod: [
        {
          '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
          ...key.export({ publicKey: true }),
        },
      ],
    });
    const documentLoader = loader.build();

    const suite = new Ed25519Signature2020();
    const result = await vc.verifyCredential({ credential, suite, documentLoader });
    return result.verified === true;
  } catch {
    return false;
  }
}

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

  // FIX-B41a item 2: "A test re-derives the stored agent's DID from its
  // stored delegation." Nothing new is stored beside the agent to make
  // this true: the credential's own `id` (a fresh urn:uuid the route
  // generated before calling createAgentDid) plus the owner's DID plus
  // the platform seed reproduce the exact same agent DID. A real
  // mutation guard: if the route ever passed a DIFFERENT id to
  // createAgentDid than the one it stored on the delegation, this
  // re-derivation would land on a different DID than the row's own
  // `did`, and this assertion would fail. The second half proves the id
  // is load-bearing, not incidental: tampering it derives a DIFFERENT
  // DID, so re-derivation is not a coincidence of a fixed id.
  it('re-derives the stored agent DID from nothing but the seed, the owner DID and the stored delegation id', async () => {
    const res = await postJson(
      baseUrl,
      '/agents',
      { name: 'rederive-me', skills: ['triage'] },
      { authorization: `Bearer ${sessionToken}` },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;

    const stored = await agentRepo.findByDid(body.did as string);
    expect(stored).not.toBeNull();
    const storedCredentialId = stored?.delegation.id as string;

    // A fresh adapter instance, standing in for a re-derivation performed
    // after a restart: no in-process state survives, only the seed
    // (an env var) and the stored row's own fields.
    const freshIdentity = createIdentityAdapter(createKnownKeyStore());
    const rederived = await freshIdentity.createAgentDid(stored?.operatorDid as string, storedCredentialId);
    expect(rederived.did).toBe(body.did);

    const wrongId = await freshIdentity.createAgentDid(stored?.operatorDid as string, `${storedCredentialId}-tampered`);
    expect(wrongId.did).not.toBe(body.did);
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

  // Invariant 2 for the SITE path specifically (Proof round 1: the
  // wallet path already has this proof in agent-invariant2.test.ts, but
  // nothing checked the site-signed delegation the same way). The
  // credential's signer here is the PLATFORM's own derived key, not an
  // operator's wallet -- proving invariant 2 holds for that credential
  // too is the whole point of item 4 (delegationSignedBy: "platform").
  it('the stored site-path delegation verifies with @digitalbazaar/vc and the did:abt loader alone, no call to this service, and a tampered copy fails', async () => {
    const res = await postJson(
      baseUrl,
      '/agents',
      { name: 'invariant2-site-scout', skills: ['triage'] },
      { authorization: `Bearer ${sessionToken}` },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;

    const stored = await agentRepo.findByDid(body.did as string);
    expect(stored).not.toBeNull();
    const strangerCopy = JSON.parse(JSON.stringify(stored?.delegation)) as Record<string, unknown>;
    expect(await verifyIndependent(strangerCopy)).toBe(true);

    const tampered = JSON.parse(JSON.stringify(stored?.delegation)) as Record<string, unknown>;
    (tampered.credentialSubject as Record<string, unknown>).id = 'did:abt:zTamperedSiteAgent';
    expect(await verifyIndependent(tampered)).toBe(false);
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
    // Distinguishes the missing/malformed-shape refusal from the
    // "does not check out" refusal below (M5, Proof round 1): both
    // sentences happen to contain "sign the exact string", so that
    // substring alone cannot tell a removed missing-agentProof guard
    // from the still-present signature-verification guard. Only the
    // missing/malformed branch names the required shape.
    expect(String(body.error)).toContain('agentProof must be { signature, publicKeyMultibase }');

    const read = await fetch(`${baseUrl}/agents/${agentSigning.did}`);
    expect(read.status).toBe(404);
  });

  it('a malformed agentProof (signature present, publicKeyMultibase missing) is 400 naming the required shape', async () => {
    await ownerDid();
    const agentSigning = await signingIdentityFromSeed(new Uint8Array(32).fill(219));
    const res = await postJson(
      baseUrl,
      '/agents',
      {
        name: 'malformed-proof-agent',
        skills: ['triage'],
        did: agentSigning.did,
        agentProof: { signature: 'not-empty-but-key-missing' },
      },
      { authorization: `Bearer ${sessionToken}` },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain('agentProof must be { signature, publicKeyMultibase }');
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
    // A wallet-registered account: `walletDid` is a hand-picked string,
    // never anything createOperatorDid produced. It is pre-registered
    // under the login 'wallet-only-login' BEFORE any session exists, so
    // when the session below authenticates as that same GitHub login,
    // resolveActingParty's findByGithubLogin lookup finds this row and
    // returns walletDid directly -- provisionAccountForSession is never
    // called, because the account already exists. The route then
    // re-derives what a session for this subject WOULD own
    // (createOperatorDid('wallet-only-login')), which is some other DID
    // entirely (a real HKDF derivation, not a stand-in), and compares it
    // against walletDid. They differ, which is exactly the condition
    // this refusal exists for: an account whose DID a wallet key
    // produced, not one this platform ever derived. This test drives a
    // real request through the live route and reads the live response;
    // nothing here is asserted at the identity-adapter level or by
    // reading the route source.
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

  // FIX-B41a: "the server log names FREEAGENTS_PLATFORM_SEED (an
  // operator-only cause)". The account already exists (registered
  // directly, never through a session), so resolveActingParty resolves
  // it via the plain findByGithubLogin lookup and never calls
  // provisionAccountForSession at all -- this reaches the ROUTE's OWN
  // second createOperatorDid call (re-deriving the owner's signing key),
  // a distinct code path and a distinct console.error call from the one
  // the prior test exercises through provisioning.
  it("the seed-unset 503 logs the exact environment variable name, from the route's own key re-derivation", async () => {
    const original = process.env.FREEAGENTS_PLATFORM_SEED;
    process.env.FREEAGENTS_PLATFORM_SEED = 'b41'.padEnd(64, '9');
    try {
      const seededAccountRepo = new MemoryAccountRepository();
      const seededSession = createSessionAdapter({
        github: fakeGitHubConfig(),
        fetchImpl: fakeGitHubFetch({ login: 'already-registered-owner', id: 888 }),
      });
      const seededApp = createApp(
        seededAccountRepo,
        new MemoryAgentRepository(),
        createIdentityAdapter(createKnownKeyStore()),
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        seededSession,
      );
      const identityForDid = createIdentityAdapter(createKnownKeyStore());
      const { did: preRegisteredDid } = await identityForDid.createOperatorDid('already-registered-owner');
      await seededAccountRepo.register({ did: preRegisteredDid, githubLogin: 'already-registered-owner' });

      const seededServer = seededApp.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => seededServer.once('listening', resolve));
      const address = seededServer.address();
      if (address === null || typeof address === 'string') throw new Error('expected server to listen on a port');
      const seededBaseUrl = `http://127.0.0.1:${address.port}`;
      try {
        const token = await mintSessionToken(seededSession);

        // Only now does the seed disappear, so the account lookup above
        // (an ordinary read, not a derivation) already succeeded.
        delete process.env.FREEAGENTS_PLATFORM_SEED;
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          const res = await postJson(
            seededBaseUrl,
            '/agents',
            { name: 'seed-vanishes-agent', skills: ['triage'] },
            { authorization: `Bearer ${token}` },
          );
          expect(res.status).toBe(503);
          const loggedNamesTheVariable = errorSpy.mock.calls.some((call: unknown[]) =>
            call.some((arg: unknown) => String(arg).includes('FREEAGENTS_PLATFORM_SEED')),
          );
          expect(loggedNamesTheVariable).toBe(true);
        } finally {
          errorSpy.mockRestore();
        }
      } finally {
        await new Promise<void>((resolve) => seededServer.close(() => resolve()));
      }
    } finally {
      if (original === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
      else process.env.FREEAGENTS_PLATFORM_SEED = original;
    }
  });
});

// The remaining guards the site path and bring-your-own-DID path enforce,
// each with its own test that goes red when that specific check is
// removed (Proof round 1 mutation list): a malformed brought DID, a
// brought DID that collides with an existing account, an identity
// adapter that lacks issueSiteDelegation, and the wallet path's own
// did-required check (unchanged behavior, still needing its own pin
// since it sits right beside the new site-path branch this card added).
interface GuardApp {
  readonly baseUrl: string;
  readonly server: Server;
  readonly accountRepo: MemoryAccountRepository;
  readonly agentRepo: MemoryAgentRepository;
  readonly token: string;
  readonly sessionAdapter: ReturnType<typeof testSessionAdapter>;
}

async function startGuardApp(seedSuffix: string, identityOverride?: unknown): Promise<GuardApp> {
  process.env.FREEAGENTS_PLATFORM_SEED = 'b41'.padEnd(64, seedSuffix);
  const accountRepo = new MemoryAccountRepository();
  const agentRepo = new MemoryAgentRepository();
  const sessionAdapter = testSessionAdapter();
  const identity = (identityOverride as ReturnType<typeof createIdentityAdapter>) ?? createIdentityAdapter(createKnownKeyStore());
  const app = createApp(
    accountRepo,
    agentRepo,
    identity,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    sessionAdapter,
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const token = await mintSessionToken(sessionAdapter);
  return { baseUrl, server, accountRepo, agentRepo, token, sessionAdapter };
}

async function stopGuardApp(started: GuardApp): Promise<void> {
  await new Promise<void>((resolve) => started.server.close(() => resolve()));
  if (ORIGINAL_SEED === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
  else process.env.FREEAGENTS_PLATFORM_SEED = ORIGINAL_SEED;
}

describe('POST /agents, remaining guards (FIX-B41a)', () => {
  it('a brought DID that does not look like did:abt:<suffix> is 400', async () => {
    const started = await startGuardApp('4');
    try {
      const res = await postJson(
        started.baseUrl,
        '/agents',
        { name: 'bad-did-agent', skills: ['triage'], did: 'not-a-did-at-all', agentProof: { signature: 'x', publicKeyMultibase: 'y' } },
        { authorization: `Bearer ${started.token}` },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body.error)).toBe('did must look like did:abt:<suffix>, non-empty suffix, no whitespace');
    } finally {
      await stopGuardApp(started);
    }
  });

  it('a brought DID already registered as an account is 409, and nothing is stored as an agent', async () => {
    const started = await startGuardApp('5');
    try {
      const agentSigning = await signingIdentityFromSeed(new Uint8Array(32).fill(220));
      // Pre-register the AGENT's own DID as an account, simulating the
      // ordering P8a already guards on the wallet path.
      await started.accountRepo.register({ did: agentSigning.did, githubLogin: 'someone-elses-account' });

      const ownerRes = await postJson(
        started.baseUrl,
        '/agents',
        { name: 'owner-probe-collision', skills: ['triage'] },
        { authorization: `Bearer ${started.token}` },
      );
      const owner = ((await ownerRes.json()) as Record<string, unknown>).operatorDid as string;

      const payload = `freeagents:list-agent:v1:${agentSigning.did}:${owner}`;
      const signature = nodeSign(null, Buffer.from(payload, 'utf8'), agentSigning.privateKey).toString('base64');
      const publicKeyMultibase = agentSigning.keyid.slice(agentSigning.keyid.indexOf('#') + 1);

      const res = await postJson(
        started.baseUrl,
        '/agents',
        { name: 'colliding-agent', skills: ['triage'], did: agentSigning.did, agentProof: { signature, publicKeyMultibase } },
        { authorization: `Bearer ${started.token}` },
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body.error)).toContain('already registered as an account');
      expect(await started.agentRepo.findByDid(agentSigning.did)).toBeNull();
    } finally {
      await stopGuardApp(started);
    }
  });

  it('an identity adapter without issueSiteDelegation answers 503, nothing stored', async () => {
    process.env.FREEAGENTS_PLATFORM_SEED = 'b41'.padEnd(64, '6');
    const realIdentity = createIdentityAdapter(createKnownKeyStore());
    // A stand-in that forwards everything EXCEPT issueSiteDelegation, the
    // same "hand-rolled adapter omitting one optional method" pattern
    // the brief's own storage seam (item 6) uses.
    const noIssueIdentity = {
      createOperatorDid: realIdentity.createOperatorDid.bind(realIdentity),
      createAgentDid: realIdentity.createAgentDid.bind(realIdentity),
      resolveDid: realIdentity.resolveDid.bind(realIdentity),
      sign: realIdentity.sign.bind(realIdentity),
      verify: realIdentity.verify.bind(realIdentity),
      verifyDelegation: realIdentity.verifyDelegation.bind(realIdentity),
      // issueSiteDelegation deliberately omitted.
    };
    const started = await startGuardApp('6', noIssueIdentity);
    try {
      const res = await postJson(
        started.baseUrl,
        '/agents',
        { name: 'no-issue-delegation-agent', skills: ['triage'] },
        { authorization: `Bearer ${started.token}` },
      );
      expect(res.status).toBe(503);
      expect(await started.agentRepo.listAll?.()).toEqual([]);
    } finally {
      await stopGuardApp(started);
    }
  });

  it('the wallet path still requires did when delegation is present (unchanged, pinned beside the new site branch)', async () => {
    const started = await startGuardApp('7');
    try {
      const res = await postJson(
        started.baseUrl,
        '/agents',
        { name: 'wallet-no-did-agent', skills: ['triage'], delegation: { fake: 'credential' } },
        { authorization: `Bearer ${started.token}` },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body.error)).toContain('did is required when delegation is present');
    } finally {
      await stopGuardApp(started);
    }
  });
});
