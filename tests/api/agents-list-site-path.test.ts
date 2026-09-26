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
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import * as vc from '@digitalbazaar/vc';
import { securityLoader } from '@digitalbazaar/security-document-loader';

import { createApp } from '../../src/api/app.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import { createKnownKeyStore } from '../../src/adapters/identity/did-abt-resolver.js';
import { MemoryAgentRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import type { SessionAdapter } from '../../src/adapters/identity/session.js';
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
    if (fromPublicKey(keyWithBuffer._publicKeyBuffer) !== issuer.replace(/^did:abt:/, '')) return false;
    key.controller = issuer;
    key.id = verificationMethod;
    const loader = securityLoader();
    loader.addStatic(key.id, { '@context': 'https://w3id.org/security/suites/ed25519-2020/v1', ...key.export({ publicKey: true }) });
    loader.addStatic(issuer, {
      '@context': 'https://www.w3.org/ns/did/v1',
      id: issuer,
      assertionMethod: [key.id],
      verificationMethod: [{ '@context': 'https://w3id.org/security/suites/ed25519-2020/v1', ...key.export({ publicKey: true }) }],
    });
    const result = await vc.verifyCredential({ credential, suite: new Ed25519Signature2020(), documentLoader: loader.build() });
    return result.verified === true;
  } catch {
    return false;
  }
}

const ORIGINAL_SEED = process.env.FREEAGENTS_PLATFORM_SEED;
let seedCounter = 0;

async function postJson(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

async function postSigned(baseUrl: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, 'POST', targetUri, { body: bodyText });
  return fetch(targetUri, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'signature-input': signed['signature-input'], signature: signed.signature, 'content-digest': signed['content-digest'] },
    body: bodyText,
  });
}

// Shared server-boot helper. Every describe block below needs a live app
// on a real port with a fresh, unique platform seed (each test file that
// touches FREEAGENTS_PLATFORM_SEED runs its own suites in the same
// process, so a distinct seed per boot keeps derivations from colliding
// across describes). `seedCounter` guarantees a fresh 64-hex-char value
// each call without every call site inventing its own padding digit.
interface Booted {
  readonly server: Server;
  readonly baseUrl: string;
  readonly accountRepo: MemoryAccountRepository;
  readonly agentRepo: MemoryAgentRepository;
  readonly sessionAdapter: SessionAdapter;
  readonly sessionToken: string;
}

async function bootApp(opts: { sessionAdapter?: SessionAdapter; identityOverride?: unknown; accountRepo?: MemoryAccountRepository } = {}): Promise<Booted> {
  seedCounter += 1;
  process.env.FREEAGENTS_PLATFORM_SEED = `b41${seedCounter}`.padEnd(64, '0');
  const accountRepo = opts.accountRepo ?? new MemoryAccountRepository();
  const agentRepo = new MemoryAgentRepository();
  const sessionAdapter = opts.sessionAdapter ?? testSessionAdapter();
  const identity = (opts.identityOverride as ReturnType<typeof createIdentityAdapter>) ?? createIdentityAdapter(createKnownKeyStore());
  const app = createApp(accountRepo, agentRepo, identity, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const sessionToken = await mintSessionToken(sessionAdapter);
  return { server, baseUrl, accountRepo, agentRepo, sessionAdapter, sessionToken };
}

async function shutdownApp(booted: Booted): Promise<void> {
  await new Promise<void>((resolve) => booted.server.close(() => resolve()));
}

afterAll(() => {
  if (ORIGINAL_SEED === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
  else process.env.FREEAGENTS_PLATFORM_SEED = ORIGINAL_SEED;
});

describe('POST /agents, site listing path (FIX-B41a), GitHub session', () => {
  it('201s with no did and no delegation; the stored delegation is signed by the platform, and it re-derives, verifies independently and reads back', async () => {
    const booted = await bootApp();
    try {
      const res = await postJson(booted.baseUrl, '/agents', { name: 'scout', skills: ['triage'] }, { authorization: `Bearer ${booted.sessionToken}` });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(typeof body.did).toBe('string');
      const delegation = body.delegation as Record<string, unknown>;
      const credentialSubject = delegation.credentialSubject as Record<string, unknown>;
      expect(delegation.issuer).toBe(body.operatorDid);
      expect(credentialSubject.id).toBe(body.did);
      expect(credentialSubject.delegationSignedBy).toBe('platform');

      // GET /agents/:agentDid serves it back.
      const read = await fetch(`${booted.baseUrl}/agents/${body.did as string}`);
      expect(read.status).toBe(200);
      expect(((await read.json()) as Record<string, unknown>).did).toBe(body.did);

      // FIX-B41a item 2: "A test re-derives the stored agent's DID from
      // its stored delegation." Nothing new is stored beside the agent
      // to make this true: the credential's own `id` (a fresh urn:uuid
      // generated before calling createAgentDid) plus the owner's DID
      // plus the platform seed reproduce the exact same agent DID. A
      // real mutation guard: if the route ever passed a DIFFERENT id to
      // createAgentDid than the one it stored, this would land on a
      // different DID than the row's own `did`. The tampered-id case
      // proves the id is load-bearing, not incidental.
      const stored = await booted.agentRepo.findByDid(body.did as string);
      expect(stored).not.toBeNull();
      const storedCredentialId = stored?.delegation.id as string;
      const freshIdentity = createIdentityAdapter(createKnownKeyStore());
      const rederived = await freshIdentity.createAgentDid(stored?.operatorDid as string, storedCredentialId);
      expect(rederived.did).toBe(body.did);
      const wrongId = await freshIdentity.createAgentDid(stored?.operatorDid as string, `${storedCredentialId}-tampered`);
      expect(wrongId.did).not.toBe(body.did);

      // Invariant 2 for the SITE path (the wallet path already has this
      // proof in agent-invariant2.test.ts; the site-signed delegation
      // had nothing checking it the same way). The credential's signer
      // here is the PLATFORM's own derived key, not an operator's
      // wallet -- item 4 (delegationSignedBy: "platform") only means
      // anything if the credential still verifies independently.
      const strangerCopy = JSON.parse(JSON.stringify(stored?.delegation)) as Record<string, unknown>;
      expect(await verifyIndependent(strangerCopy)).toBe(true);
      const tampered = JSON.parse(JSON.stringify(stored?.delegation)) as Record<string, unknown>;
      (tampered.credentialSubject as Record<string, unknown>).id = 'did:abt:zTamperedSiteAgent';
      expect(await verifyIndependent(tampered)).toBe(false);
    } finally {
      await shutdownApp(booted);
    }
  });

  it('a GitHub owner naming their own login gets proofStatus verified (G1)', async () => {
    const booted = await bootApp();
    try {
      const live = await booted.sessionAdapter.getSession(booted.sessionToken);
      if (live === null) throw new Error('expected a live session');
      const res = await postJson(
        booted.baseUrl,
        '/agents',
        { name: 'scout-github', skills: ['triage'], githubLogin: live.subject },
        { authorization: `Bearer ${booted.sessionToken}` },
      );
      expect(res.status).toBe(201);
      expect(((await res.json()) as Record<string, unknown>).proofStatus).toBe('verified');
    } finally {
      await shutdownApp(booted);
    }
  });
});

describe('POST /agents, site listing path (FIX-B41a), passkey session', () => {
  it('201s with no GitHub login anywhere', async () => {
    seedCounter += 1;
    process.env.FREEAGENTS_PLATFORM_SEED = `b41${seedCounter}`.padEnd(64, '1');
    const passkeySessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      passkey: { rpName: 'FreeAgents test', rpID: 'localhost', origin: 'http://localhost:3000' },
    });
    const app = createApp(new MemoryAccountRepository(), new MemoryAgentRepository(), createIdentityAdapter(createKnownKeyStore()), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, passkeySessionAdapter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const subject = 'passkey-owner-1';
      const { optionsJson } = await passkeySessionAdapter.registerPasskey(subject);
      const { challenge } = JSON.parse(optionsJson) as { challenge: string };
      const response = createPasskeyFixture().registrationResponse(challenge, 'localhost');
      const session = await passkeySessionAdapter.verifyPasskey(JSON.stringify({ subject, response }));
      if (session === null) throw new Error('expected a passkey session');

      const res = await postJson(baseUrl, '/agents', { name: 'passkey-scout', skills: ['triage'] }, { authorization: `Bearer ${session.token}` });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.githubLogin).toBeNull();
      expect(typeof body.did).toBe('string');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('POST /agents, site path bringing its own agent DID (FIX-B41a item 5)', () => {
  async function ownerDid(baseUrl: string, sessionToken: string): Promise<string> {
    const res = await postJson(baseUrl, '/agents', { name: 'owner-probe', skills: ['triage'] }, { authorization: `Bearer ${sessionToken}` });
    return ((await res.json()) as Record<string, unknown>).operatorDid as string;
  }

  it('a correct agentProof lists an agent at that exact DID; wrong agent DID, wrong owner DID, mismatched key, missing proof and malformed proof are each 400', async () => {
    const booted = await bootApp();
    try {
      const owner = await ownerDid(booted.baseUrl, booted.sessionToken);
      const auth = { authorization: `Bearer ${booted.sessionToken}` };

      const good = await signingIdentityFromSeed(new Uint8Array(32).fill(211));
      const goodPayload = `freeagents:list-agent:v1:${good.did}:${owner}`;
      const goodSig = nodeSign(null, Buffer.from(goodPayload, 'utf8'), good.privateKey).toString('base64');
      const goodKey = good.keyid.slice(good.keyid.indexOf('#') + 1);
      const okRes = await postJson(booted.baseUrl, '/agents', { name: 'own-key-agent', skills: ['triage'], did: good.did, agentProof: { signature: goodSig, publicKeyMultibase: goodKey } }, auth);
      expect(okRes.status).toBe(201);
      expect(((await okRes.json()) as Record<string, unknown>).did).toBe(good.did);

      const wrongAgent = await signingIdentityFromSeed(new Uint8Array(32).fill(212));
      const otherAgent = await signingIdentityFromSeed(new Uint8Array(32).fill(213));
      const wrongAgentPayload = `freeagents:list-agent:v1:${otherAgent.did}:${owner}`;
      const wrongAgentSig = nodeSign(null, Buffer.from(wrongAgentPayload, 'utf8'), wrongAgent.privateKey).toString('base64');
      const wrongAgentKey = wrongAgent.keyid.slice(wrongAgent.keyid.indexOf('#') + 1);
      const wrongAgentRes = await postJson(booted.baseUrl, '/agents', { name: 'wrong-payload-agent', skills: ['triage'], did: wrongAgent.did, agentProof: { signature: wrongAgentSig, publicKeyMultibase: wrongAgentKey } }, auth);
      expect(wrongAgentRes.status).toBe(400);
      expect((await fetch(`${booted.baseUrl}/agents/${wrongAgent.did}`)).status).toBe(404);

      const wrongOwnerAgent = await signingIdentityFromSeed(new Uint8Array(32).fill(214));
      const wrongOwnerPayload = `freeagents:list-agent:v1:${wrongOwnerAgent.did}:did:abt:zSomeoneElseEntirely`;
      const wrongOwnerSig = nodeSign(null, Buffer.from(wrongOwnerPayload, 'utf8'), wrongOwnerAgent.privateKey).toString('base64');
      const wrongOwnerKey = wrongOwnerAgent.keyid.slice(wrongOwnerAgent.keyid.indexOf('#') + 1);
      const wrongOwnerRes = await postJson(booted.baseUrl, '/agents', { name: 'wrong-owner-agent', skills: ['triage'], did: wrongOwnerAgent.did, agentProof: { signature: wrongOwnerSig, publicKeyMultibase: wrongOwnerKey } }, auth);
      expect(wrongOwnerRes.status).toBe(400);

      const mismatchAgent = await signingIdentityFromSeed(new Uint8Array(32).fill(215));
      const mismatchOther = await signingIdentityFromSeed(new Uint8Array(32).fill(216));
      const mismatchPayload = `freeagents:list-agent:v1:${mismatchAgent.did}:${owner}`;
      // Signed by a DIFFERENT key than the one named in the DID.
      const mismatchSig = nodeSign(null, Buffer.from(mismatchPayload, 'utf8'), mismatchOther.privateKey).toString('base64');
      const mismatchKey = mismatchOther.keyid.slice(mismatchOther.keyid.indexOf('#') + 1);
      const mismatchRes = await postJson(booted.baseUrl, '/agents', { name: 'mismatched-key-agent', skills: ['triage'], did: mismatchAgent.did, agentProof: { signature: mismatchSig, publicKeyMultibase: mismatchKey } }, auth);
      expect(mismatchRes.status).toBe(400);

      const noProofAgent = await signingIdentityFromSeed(new Uint8Array(32).fill(217));
      const noProofRes = await postJson(booted.baseUrl, '/agents', { name: 'no-proof-agent', skills: ['triage'], did: noProofAgent.did }, auth);
      expect(noProofRes.status).toBe(400);
      const noProofBody = (await noProofRes.json()) as Record<string, unknown>;
      expect(String(noProofBody.error)).toContain('sign the exact string');
      // Distinguishes the missing/malformed-shape refusal from the
      // "does not check out" refusal (both sentences happen to contain
      // "sign the exact string", so that substring alone cannot tell a
      // removed missing-agentProof guard from the still-present
      // signature-verification guard). Only the missing/malformed
      // branch names the required shape.
      expect(String(noProofBody.error)).toContain('agentProof must be { signature, publicKeyMultibase }');
      expect((await fetch(`${booted.baseUrl}/agents/${noProofAgent.did}`)).status).toBe(404);

      const malformedAgent = await signingIdentityFromSeed(new Uint8Array(32).fill(219));
      const malformedRes = await postJson(booted.baseUrl, '/agents', { name: 'malformed-proof-agent', skills: ['triage'], did: malformedAgent.did, agentProof: { signature: 'not-empty-but-key-missing' } }, auth);
      expect(malformedRes.status).toBe(400);
      expect(String((await malformedRes.json() as Record<string, unknown>).error)).toContain('agentProof must be { signature, publicKeyMultibase }');
    } finally {
      await shutdownApp(booted);
    }
  });
});

describe('POST /agents, site path refusals (FIX-B41a)', () => {
  it('no session and no delegation is 401', async () => {
    const booted = await bootApp();
    try {
      expect((await postJson(booted.baseUrl, '/agents', { name: 'nobody', skills: ['triage'] })).status).toBe(401);
    } finally {
      await shutdownApp(booted);
    }
  });

  it('a signature-only caller with no delegation is 400 naming the delegation', async () => {
    const booted = await bootApp();
    try {
      const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(218));
      await booted.accountRepo.register({ did: identity.did, githubLogin: 'sig-only-owner' });
      const res = await postSigned(booted.baseUrl, '/agents', { name: 'sig-only', skills: ['triage'] }, identity);
      expect(res.status).toBe(400);
      expect(String((await res.json() as Record<string, unknown>).error)).toContain('delegation');
    } finally {
      await shutdownApp(booted);
    }
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
    // (createOperatorDid('wallet-only-login')), a real HKDF derivation
    // that lands on some other DID entirely, and compares it against
    // walletDid: they differ, exactly the condition this refusal exists
    // for. This test drives a real request through the live route and
    // reads the live response; nothing is asserted at the
    // identity-adapter level or by reading the route source.
    const accountRepo = new MemoryAccountRepository();
    const walletDid = 'did:abt:zWalletOnlyOperator';
    await accountRepo.register({ did: walletDid, githubLogin: 'wallet-only-login' });
    const walletSessionAdapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'wallet-only-login', id: 424242 }) });
    const booted = await bootApp({ sessionAdapter: walletSessionAdapter, accountRepo });
    try {
      const res = await postJson(booted.baseUrl, '/agents', { name: 'wallet-owner-agent', skills: ['triage'] }, { authorization: `Bearer ${booted.sessionToken}` });
      expect(res.status).toBe(409);
      expect(String((await res.json() as Record<string, unknown>).error)).toContain('wallet path');
    } finally {
      await shutdownApp(booted);
    }
  });

  it('the platform seed unset is 503, nothing stored, and (from the route\'s own key re-derivation for an ALREADY-registered account) the log names FREEAGENTS_PLATFORM_SEED', async () => {
    const noSeedSession = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'no-seed-owner', id: 777 }) });
    const booted = await bootApp({ sessionAdapter: noSeedSession });
    try {
      // Case 1: the seed is already gone when provisionAccountForSession
      // would need it (a brand-new subject, never seen before).
      delete process.env.FREEAGENTS_PLATFORM_SEED;
      const res = await postJson(booted.baseUrl, '/agents', { name: 'no-seed-agent', skills: ['triage'] }, { authorization: `Bearer ${booted.sessionToken}` });
      expect(res.status).toBe(503);
      expect(await booted.agentRepo.listAll?.()).toEqual([]);
    } finally {
      await shutdownApp(booted);
    }

    // Case 2: the account already exists (registered directly, never
    // through a session), so resolveActingParty resolves it via the
    // plain findByGithubLogin lookup and never calls
    // provisionAccountForSession at all -- this reaches the ROUTE's OWN
    // second createOperatorDid call (re-deriving the owner's signing
    // key), a distinct code path and a distinct console.error call from
    // case 1 above.
    seedCounter += 1;
    process.env.FREEAGENTS_PLATFORM_SEED = `b41${seedCounter}`.padEnd(64, '9');
    const seededAccountRepo = new MemoryAccountRepository();
    const seededSession = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'already-registered-owner', id: 888 }) });
    const identityForDid = createIdentityAdapter(createKnownKeyStore());
    const { did: preRegisteredDid } = await identityForDid.createOperatorDid('already-registered-owner');
    await seededAccountRepo.register({ did: preRegisteredDid, githubLogin: 'already-registered-owner' });
    const seededBooted = await bootApp({ sessionAdapter: seededSession, accountRepo: seededAccountRepo });
    try {
      delete process.env.FREEAGENTS_PLATFORM_SEED;
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await postJson(seededBooted.baseUrl, '/agents', { name: 'seed-vanishes-agent', skills: ['triage'] }, { authorization: `Bearer ${seededBooted.sessionToken}` });
        expect(res.status).toBe(503);
        const loggedNamesTheVariable = errorSpy.mock.calls.some((call: unknown[]) => call.some((arg: unknown) => String(arg).includes('FREEAGENTS_PLATFORM_SEED')));
        expect(loggedNamesTheVariable).toBe(true);
      } finally {
        errorSpy.mockRestore();
      }
    } finally {
      await shutdownApp(seededBooted);
    }
  });
});

// The remaining guards the site path and bring-your-own-DID path enforce,
// each with its own test that goes red when that specific check is
// removed: a malformed brought DID, a brought DID that collides with an
// existing account, an identity adapter that lacks issueSiteDelegation,
// and the wallet path's own did-required check (unchanged behavior,
// still needing its own pin since it sits right beside the new
// site-path branch this card added).
describe('POST /agents, remaining guards (FIX-B41a)', () => {
  it('a brought DID that does not look like did:abt:<suffix> is 400', async () => {
    const booted = await bootApp();
    try {
      const res = await postJson(
        booted.baseUrl,
        '/agents',
        { name: 'bad-did-agent', skills: ['triage'], did: 'not-a-did-at-all', agentProof: { signature: 'x', publicKeyMultibase: 'y' } },
        { authorization: `Bearer ${booted.sessionToken}` },
      );
      expect(res.status).toBe(400);
      expect(String((await res.json() as Record<string, unknown>).error)).toBe('did must look like did:abt:<suffix>, non-empty suffix, no whitespace');
    } finally {
      await shutdownApp(booted);
    }
  });

  it('a brought DID already registered as an account is 409, and nothing is stored as an agent', async () => {
    const booted = await bootApp();
    try {
      const agentSigning = await signingIdentityFromSeed(new Uint8Array(32).fill(220));
      // Pre-register the AGENT's own DID as an account, simulating the
      // ordering P8a already guards on the wallet path.
      await booted.accountRepo.register({ did: agentSigning.did, githubLogin: 'someone-elses-account' });
      const auth = { authorization: `Bearer ${booted.sessionToken}` };
      const ownerRes = await postJson(booted.baseUrl, '/agents', { name: 'owner-probe-collision', skills: ['triage'] }, auth);
      const owner = ((await ownerRes.json()) as Record<string, unknown>).operatorDid as string;

      const payload = `freeagents:list-agent:v1:${agentSigning.did}:${owner}`;
      const signature = nodeSign(null, Buffer.from(payload, 'utf8'), agentSigning.privateKey).toString('base64');
      const publicKeyMultibase = agentSigning.keyid.slice(agentSigning.keyid.indexOf('#') + 1);
      const res = await postJson(booted.baseUrl, '/agents', { name: 'colliding-agent', skills: ['triage'], did: agentSigning.did, agentProof: { signature, publicKeyMultibase } }, auth);
      expect(res.status).toBe(409);
      expect(String((await res.json() as Record<string, unknown>).error)).toContain('already registered as an account');
      expect(await booted.agentRepo.findByDid(agentSigning.did)).toBeNull();
    } finally {
      await shutdownApp(booted);
    }
  });

  it('an identity adapter without issueSiteDelegation answers 503, nothing stored', async () => {
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
    const booted = await bootApp({ identityOverride: noIssueIdentity });
    try {
      const res = await postJson(booted.baseUrl, '/agents', { name: 'no-issue-delegation-agent', skills: ['triage'] }, { authorization: `Bearer ${booted.sessionToken}` });
      expect(res.status).toBe(503);
      expect(await booted.agentRepo.listAll?.()).toEqual([]);
    } finally {
      await shutdownApp(booted);
    }
  });

  it('the wallet path still requires did when delegation is present (unchanged, pinned beside the new site branch)', async () => {
    const booted = await bootApp();
    try {
      const res = await postJson(booted.baseUrl, '/agents', { name: 'wallet-no-did-agent', skills: ['triage'], delegation: { fake: 'credential' } }, { authorization: `Bearer ${booted.sessionToken}` });
      expect(res.status).toBe(400);
      expect(String((await res.json() as Record<string, unknown>).error)).toContain('did is required when delegation is present');
    } finally {
      await shutdownApp(booted);
    }
  });
});
