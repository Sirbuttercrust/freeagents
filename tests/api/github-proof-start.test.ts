// FIX-B47b2, Make 1: POST /agents/:agentDid/github-proof/start. The
// operator's one click that begins the one-click GitHub proof (MISSION.md
// invariant 8). Every case here is red against
// 153af84 (part one merged, no route calls beginGitHubProofOAuth yet).
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import { createKnownKeyStore } from '../../src/adapters/identity/did-abt-resolver.js';
import { MemoryAgentRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import type { SessionAdapter } from '../../src/adapters/identity/session.js';
import { fakeGitHubConfig, fakeGitHubFetch } from '../helpers/session-fixtures.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import type { Delegation } from '../../src/domain/agent.js';

const ORIGINAL_SEED = process.env.FREEAGENTS_PLATFORM_SEED;
let seedCounter = 0;

function freshSeed(): string {
  seedCounter += 1;
  return `b47b2${seedCounter}`.padEnd(64, '0');
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

// A delegation shaped like the wallet path's own: issuer is the operator's
// bare DID and the credential id is some fixed value with NO relationship
// to createAgentDid's own HKDF derivation, so re-deriving from it never
// lands back on `did` (a wallet-path agent, or a site agent that brought
// its own DID -- the platform never held a key for either).
function walletDelegation(agentDid: string, operatorDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:wallet-delegation-fixed',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-01-01T00:00:00Z',
      verificationMethod: `${operatorDid}#zOperatorKeyHash`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zfixture-not-verified-here',
    },
  };
}

interface Booted {
  readonly server: Server;
  readonly baseUrl: string;
  readonly agentRepo: MemoryAgentRepository;
  readonly accountRepo: MemoryAccountRepository;
  readonly operator: SigningIdentity;
  readonly stranger: SigningIdentity;
}

// A site-listed agent whose key the platform genuinely holds: the DID is
// createAgentDid's own re-derivation from operatorDid and a fresh
// credentialId, and the stored delegation's own `id` IS that credentialId
// -- exactly the shape POST /agents' site path produces (app.ts :3395).
async function bootWithDerivableAgent(sessionAdapter?: SessionAdapter): Promise<Booted & { readonly agentDid: string }> {
  process.env.FREEAGENTS_PLATFORM_SEED = freshSeed();
  const identity = createIdentityAdapter(createKnownKeyStore());
  const accountRepo = new MemoryAccountRepository();
  const agentRepo = new MemoryAgentRepository();
  const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(211));
  const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(212));
  await accountRepo.register({ did: operator.did, githubLogin: 'github-proof-start-operator' });
  await accountRepo.register({ did: stranger.did, githubLogin: 'github-proof-start-stranger' });

  const credentialId = `urn:uuid:${randomUUID()}`;
  const derived = await identity.createAgentDid(operator.did, credentialId);
  const agentDid = derived.did;
  await agentRepo.create({
    did: agentDid,
    operatorDid: operator.did,
    delegation: {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      id: credentialId,
      type: ['VerifiableCredential', 'AgentDelegation'],
      issuer: operator.did,
      issuanceDate: '2026-01-01T00:00:00Z',
      credentialSubject: { id: agentDid, delegationSignedBy: 'platform' },
      proof: {
        type: 'Ed25519Signature2020',
        created: '2026-01-01T00:00:00Z',
        verificationMethod: `${operator.did}#zPlatformKeyHash`,
        proofPurpose: 'assertionMethod',
        proofValue: 'zfixture-not-verified-here',
      },
    },
    name: 'scout',
    skills: ['triage'],
    githubLogin: null,
  });

  const app = createApp(
    accountRepo, agentRepo, identity, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    sessionAdapter ?? createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'octo-proof-start', id: 9001 }) }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, baseUrl, agentRepo, accountRepo, operator, stranger, agentDid };
}

// A wallet-path (or self-chosen-DID) agent: the platform never held a key
// for it, so createAgentDid(row.operatorDid, row.delegation.id) can never
// re-derive row.did.
async function bootWithWalletAgent(): Promise<Booted & { readonly agentDid: string }> {
  process.env.FREEAGENTS_PLATFORM_SEED = freshSeed();
  const identity = createIdentityAdapter(createKnownKeyStore());
  const accountRepo = new MemoryAccountRepository();
  const agentRepo = new MemoryAgentRepository();
  const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(213));
  const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(214));
  await accountRepo.register({ did: operator.did, githubLogin: 'github-proof-start-wallet-operator' });
  await accountRepo.register({ did: stranger.did, githubLogin: 'github-proof-start-wallet-stranger' });

  const agentDid = 'did:abt:zWalletPathAgent';
  await agentRepo.create({
    did: agentDid,
    operatorDid: operator.did,
    delegation: walletDelegation(agentDid, operator.did),
    name: 'scout',
    skills: ['triage'],
    githubLogin: null,
  });

  const app = createApp(
    accountRepo, agentRepo, identity, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'octo-proof-start-wallet', id: 9002 }) }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, baseUrl, agentRepo, accountRepo, operator, stranger, agentDid };
}

afterAll(() => {
  if (ORIGINAL_SEED === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
  else process.env.FREEAGENTS_PLATFORM_SEED = ORIGINAL_SEED;
});

describe('POST /agents/:agentDid/github-proof/start', () => {
  let booted: Booted & { readonly agentDid: string };

  beforeAll(async () => {
    booted = await bootWithDerivableAgent();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => booted.server.close(() => resolve()));
  });

  it('200: the operator gets a redirectUrl carrying exactly the five documented parameters', async () => {
    const res = await postSigned(booted.baseUrl, `/agents/${booted.agentDid}/github-proof/start`, {}, booted.operator);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['redirectUrl']);
    const url = new URL(String(body.redirectUrl));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect([...url.searchParams.keys()].sort()).toEqual(['client_id', 'prompt', 'redirect_uri', 'scope', 'state']);
    expect(url.searchParams.get('scope')).toBe('gist');
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('state')).not.toBeNull();
  });

  it('401: an unauthenticated caller is refused, with no session and no signature', async () => {
    const res = await fetch(`${booted.baseUrl}/agents/${booted.agentDid}/github-proof/start`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it("403: a registered stranger (not this agent's operator) is refused, never naming the real operator", async () => {
    const res = await postSigned(booted.baseUrl, `/agents/${booted.agentDid}/github-proof/start`, {}, booted.stranger);
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).not.toContain(booted.operator.did);
  });

  it('404: an unknown agent DID is refused', async () => {
    const res = await postSigned(booted.baseUrl, '/agents/did:abt:zNeverListed/github-proof/start', {}, booted.operator);
    expect(res.status).toBe(404);
  });
});

describe('POST /agents/:agentDid/github-proof/start, decision 2 (the platform must hold the key)', () => {
  it('409: a wallet-path agent (the platform never held its key) is refused, naming path two', async () => {
    const booted = await bootWithWalletAgent();
    try {
      const res = await postSigned(booted.baseUrl, `/agents/${booted.agentDid}/github-proof/start`, {}, booted.operator);
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body.error)).toContain('/agents/:agentDid/account-proof');
    } finally {
      await new Promise<void>((resolve) => booted.server.close(() => resolve()));
    }
  });

  // The site-brought-own-DID shape (FIX-B41a item 5).
  it('409: a site agent that brought its own agent DID (the agentProof branch) is refused, naming path two', async () => {
    process.env.FREEAGENTS_PLATFORM_SEED = freshSeed();
    const identity = createIdentityAdapter(createKnownKeyStore());
    const accountRepo = new MemoryAccountRepository();
    const agentRepo = new MemoryAgentRepository();
    const ownerLogin = 'octo-brought-own-did-owner';
    const sessionAdapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: ownerLogin, id: 9101 }) });
    const app = createApp(accountRepo, agentRepo, identity, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const start = await sessionAdapter.beginGitHubOAuth();
      const session = await sessionAdapter.completeGitHubOAuth({ code: 'good-code', state: start.state });
      if (session === null) throw new Error('expected a session');
      const auth = { authorization: `Bearer ${session.token}` };
      const { did: ownerDid } = await identity.createOperatorDid(ownerLogin);

      const agentKey = await signingIdentityFromSeed(new Uint8Array(32).fill(216));
      const payload = `freeagents:list-agent:v1:${agentKey.did}:${ownerDid}`;
      const { sign } = await import('node:crypto');
      const signature = sign(null, Buffer.from(payload, 'utf8'), agentKey.privateKey).toString('base64');
      const publicKeyMultibase = agentKey.keyid.slice(agentKey.keyid.indexOf('#') + 1);

      const listRes = await fetch(`${baseUrl}/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ name: 'own-key-agent', skills: ['triage'], did: agentKey.did, agentProof: { signature, publicKeyMultibase } }),
      });
      expect(listRes.status).toBe(201);
      const agentDid = String(((await listRes.json()) as Record<string, unknown>).did);
      expect(agentDid).toBe(agentKey.did);

      const res = await fetch(`${baseUrl}/agents/${agentDid}/github-proof/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: '{}',
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body.error)).toContain('/agents/:agentDid/account-proof');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('409 fires even when GitHub OAuth is unconfigured on this deployment: a 503 must never mask it', async () => {
    process.env.FREEAGENTS_PLATFORM_SEED = freshSeed();
    const identity = createIdentityAdapter(createKnownKeyStore());
    const accountRepo = new MemoryAccountRepository();
    const agentRepo = new MemoryAgentRepository();
    const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(215));
    await accountRepo.register({ did: operator.did, githubLogin: 'github-proof-start-unconfigured-operator' });
    const agentDid = 'did:abt:zWalletPathAgentUnconfigured';
    await agentRepo.create({
      did: agentDid,
      operatorDid: operator.did,
      delegation: walletDelegation(agentDid, operator.did),
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    // No clientId/clientSecret at all: OAuth is unconfigured on this deployment.
    const sessionAdapter = createSessionAdapter({ github: { clientId: '', clientSecret: '', redirectUri: 'http://localhost:3000/auth/github/callback' } });
    const app = createApp(accountRepo, agentRepo, identity, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter);
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('expected a port');
      const res = await postSigned(`http://127.0.0.1:${address.port}`, `/agents/${agentDid}/github-proof/start`, {}, operator);
      expect(res.status).toBe(409);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('503: GitHub OAuth is unconfigured, for an agent whose key the platform DOES hold', async () => {
    const sessionAdapter = createSessionAdapter({ github: { clientId: '', clientSecret: '', redirectUri: 'http://localhost:3000/auth/github/callback' } });
    const booted = await bootWithDerivableAgent(sessionAdapter);
    try {
      const res = await postSigned(booted.baseUrl, `/agents/${booted.agentDid}/github-proof/start`, {}, booted.operator);
      expect(res.status).toBe(503);
    } finally {
      await new Promise<void>((resolve) => booted.server.close(() => resolve()));
    }
  });

  it('503: the platform seed is unset, so the platform cannot even attempt the re-derivation, naming the real cause', async () => {
    const booted = await bootWithDerivableAgent();
    const saved = process.env.FREEAGENTS_PLATFORM_SEED;
    delete process.env.FREEAGENTS_PLATFORM_SEED;
    try {
      const res = await postSigned(booted.baseUrl, `/agents/${booted.agentDid}/github-proof/start`, {}, booted.operator);
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body.error)).toContain('FREEAGENTS_PLATFORM_SEED');
    } finally {
      process.env.FREEAGENTS_PLATFORM_SEED = saved;
      await new Promise<void>((resolve) => booted.server.close(() => resolve()));
    }
  });
});
