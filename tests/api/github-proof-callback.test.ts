// FIX-B47b2, Make 2: GET /auth/github/callback's proof branch. The
// callback the operator's browser returns to after github-proof/start,
// completing the one-click GitHub proof (MAP.md 2026-08-17, MISSION.md
// invariant 8, FIX-B47b decisions 1, 3, 5 and 6). Every case here is red
// against 153af84 (part one merged: peekOAuthStatePurpose,
// completeGitHubProofOAuth exist on the session adapter, but no route
// calls them yet).
import type { Server } from 'node:http';
import * as nodeCrypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';

import { createApp } from '../../src/api/app.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import { createKnownKeyStore } from '../../src/adapters/identity/did-abt-resolver.js';
import { MemoryAgentRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import type { SessionAdapter } from '../../src/adapters/identity/session.js';
import { fakeGitHubConfig, fakeGitHubFetch, failingGitHubFetch } from '../helpers/session-fixtures.js';
import { signingIdentityFromSeed, type SigningIdentity } from '../helpers/sign-request.js';
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import type { CreateGistInput, CreateGistResult, DeleteGistInput, DeleteGrantInput, Gist, GithubAdapter } from '../../src/adapters/github/types.js';
import { GistNotFoundError } from '../../src/adapters/github/types.js';
import type { Delegation } from '../../src/domain/agent.js';

const ORIGINAL_SEED = process.env.FREEAGENTS_PLATFORM_SEED;
let seedCounter = 0;
function freshSeed(): string {
  seedCounter += 1;
  return `b47b2cb${seedCounter}`.padEnd(64, '0');
}

async function postSigned(baseUrl: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const { signRequest } = await import('../helpers/sign-request.js');
  const bodyText = JSON.stringify(body);
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, 'POST', targetUri, { body: bodyText });
  return fetch(targetUri, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'signature-input': signed['signature-input'], signature: signed.signature, 'content-digest': signed['content-digest'] },
    body: bodyText,
  });
}

interface FakeProofGithubCalls {
  readonly createGist: CreateGistInput[];
  readonly deleteGist: DeleteGistInput[];
  readonly deleteGrant: DeleteGrantInput[];
  readonly order: string[]; // which call landed and in what order (QA r1, D2)
}

// A GithubAdapter stand-in that records every call the proof callback can
// make: publishing the gist AS THE CALLER (never the platform), reading it
// back for the shared check, and the two cleanup calls. tokenToLogin names
// which account a given exchanged token publishes as, mirroring what a
// real GitHub OAuth exchange would resolve. getPublicGistOverride lets a
// test force a specific check outcome (author-mismatch, unavailable, etc.)
// without hand-rolling a bad signature.
function fakeProofGithub(options: {
  readonly tokenToLogin: Record<string, string>;
  readonly getPublicGistOverride?: (ref: { readonly id: string }) => Promise<Gist>;
  readonly createGistShouldFail?: boolean;
}): { readonly github: GithubAdapter; readonly calls: FakeProofGithubCalls; readonly gists: Map<string, Gist> } {
  const gists = new Map<string, Gist>();
  const calls: { createGist: CreateGistInput[]; deleteGist: DeleteGistInput[]; deleteGrant: DeleteGrantInput[]; order: string[] } = {
    createGist: [],
    deleteGist: [],
    deleteGrant: [],
    order: [],
  };
  const github: GithubAdapter = {
    platformLogin: 'freeagents-platform',
    getPullRequest: () => Promise.reject(new NotImplementedError('github', 'getPullRequest')),
    getMergeCommitSignature: () => Promise.reject(new NotImplementedError('github', 'getMergeCommitSignature')),
    getPublicGist: (ref) => {
      if (options.getPublicGistOverride !== undefined) return options.getPublicGistOverride(ref);
      const gist = gists.get(ref.id);
      if (gist === undefined) return Promise.reject(new GistNotFoundError(ref.id));
      return Promise.resolve(gist);
    },
    createStagingRepository: () => Promise.reject(new NotImplementedError('github', 'createStagingRepository')),
    grantPush: () => Promise.reject(new NotImplementedError('github', 'grantPush')),
    getCommit: () => Promise.reject(new NotImplementedError('github', 'getCommit')),
    getCollaboratorPermission: () => Promise.reject(new NotImplementedError('github', 'getCollaboratorPermission')),
    readRepository: () => Promise.reject(new NotImplementedError('github', 'readRepository')),
    compareCommits: () => Promise.reject(new NotImplementedError('github', 'compareCommits')),
    createGist: (input: CreateGistInput): Promise<CreateGistResult> => {
      calls.createGist.push(input);
      calls.order.push('createGist');
      if (options.createGistShouldFail === true) return Promise.reject(new Error('github: createGist failed'));
      const id = `fake-gist-${randomUUID()}`;
      const owner = options.tokenToLogin[input.token] ?? null;
      gists.set(id, { id, owner, files: { [input.filename]: input.content } });
      return Promise.resolve({ id });
    },
    deleteGist: (input: DeleteGistInput): Promise<void> => {
      calls.deleteGist.push(input);
      calls.order.push('deleteGist');
      gists.delete(input.id);
      return Promise.resolve();
    },
    deleteGrant: (input: DeleteGrantInput): Promise<void> => {
      calls.deleteGrant.push(input);
      calls.order.push('deleteGrant');
      return Promise.resolve();
    },
  };
  return { github, calls, gists };
}

interface Booted {
  readonly server: Server;
  readonly baseUrl: string;
  readonly agentRepo: MemoryAgentRepository;
  readonly accountRepo: MemoryAccountRepository;
  readonly operator: SigningIdentity;
  readonly agentDid: string;
  readonly sessionAdapter: SessionAdapter;
  readonly githubFake: ReturnType<typeof fakeProofGithub>;
}

const FAKE_TOKEN = 'fake-access-token'; // fakeGitHubFetch's own hard-coded exchanged token.

// A delegation shaped like the site path's own (app.ts :3395), shared by
// every describe below that needs a derivable agent.
function platformDelegation(operatorDid: string, agentDid: string, credentialId: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: credentialId,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: agentDid, delegationSignedBy: 'platform' },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-01-01T00:00:00Z',
      verificationMethod: `${operatorDid}#zPlatformKeyHash`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zfixture-not-verified-here',
    },
  };
}

async function bootWithDerivableAgent(login: string, options: { readonly createGistShouldFail?: boolean; readonly fetchImpl?: typeof fetch } = {}): Promise<Booted> {
  process.env.FREEAGENTS_PLATFORM_SEED = freshSeed();
  const identity = createIdentityAdapter(createKnownKeyStore());
  const accountRepo = new MemoryAccountRepository();
  const agentRepo = new MemoryAgentRepository();
  const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(221));
  await accountRepo.register({ did: operator.did, githubLogin: 'github-proof-callback-operator' });

  const credentialId = `urn:uuid:${randomUUID()}`;
  const derived = await identity.createAgentDid(operator.did, credentialId);
  const agentDid = derived.did;
  await agentRepo.create({
    did: agentDid,
    operatorDid: operator.did,
    delegation: platformDelegation(operator.did, agentDid, credentialId),
    name: 'scout',
    skills: ['triage'],
    githubLogin: null,
  });

  const sessionAdapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: options.fetchImpl ?? fakeGitHubFetch({ login, id: 12345 }) });
  const githubFake = fakeProofGithub({ tokenToLogin: { [FAKE_TOKEN]: login }, ...(options.createGistShouldFail !== undefined ? { createGistShouldFail: options.createGistShouldFail } : {}) });
  const app = createApp(accountRepo, agentRepo, identity, githubFake.github, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, baseUrl, agentRepo, accountRepo, operator, agentDid, sessionAdapter, githubFake };
}

afterAll(() => {
  if (ORIGINAL_SEED === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
  else process.env.FREEAGENTS_PLATFORM_SEED = ORIGINAL_SEED;
});

describe('GET /auth/github/callback, the one-click proof branch: the whole click', () => {
  let booted: Booted;

  beforeAll(async () => {
    booted = await bootWithDerivableAgent('octo-full-click');
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => booted.server.close(() => resolve()));
  });

  it('200: start then callback ends verified, reads back proofStatus and githubLogin, exactly one createGist with the exchanged token, then one deleteGrant', async () => {
    const startRes = await postSigned(booted.baseUrl, `/agents/${booted.agentDid}/github-proof/start`, {}, booted.operator);
    expect(startRes.status).toBe(200);
    const { redirectUrl } = (await startRes.json()) as { redirectUrl: string };
    const state = new URL(redirectUrl).searchParams.get('state');
    expect(state).not.toBeNull();

    const callbackRes = await fetch(`${booted.baseUrl}/auth/github/callback?code=any-code&state=${encodeURIComponent(state!)}`);
    expect(callbackRes.status).toBe(200);
    const body = (await callbackRes.json()) as Record<string, unknown>;
    expect(body).toEqual({ outcome: 'verified', agentDid: booted.agentDid });

    expect(booted.githubFake.calls.createGist).toHaveLength(1);
    expect(booted.githubFake.calls.createGist[0]!.token).toBe(FAKE_TOKEN);
    expect(booted.githubFake.calls.deleteGrant).toHaveLength(1);
    expect(booted.githubFake.calls.deleteGrant[0]!.token).toBe(FAKE_TOKEN);
    expect(booted.githubFake.calls.deleteGist).toHaveLength(0);

    const read = await fetch(`${booted.baseUrl}/agents/${booted.agentDid}`);
    const readBody = (await read.json()) as Record<string, unknown>;
    expect(readBody.proofStatus).toBe('verified');
    expect(readBody.githubLogin).toBe('octo-full-click');
  });

  // Brief test (c): verified with a third-party parser, node:crypto only.
  it('the published gist verifies independently with a third-party parser, node:crypto, and the key line the gist itself carries; a flipped byte fails', async () => {
    const startRes = await postSigned(booted.baseUrl, `/agents/${booted.agentDid}/github-proof/start`, {}, booted.operator);
    const { redirectUrl } = (await startRes.json()) as { redirectUrl: string };
    const state = new URL(redirectUrl).searchParams.get('state')!;
    const callbackRes = await fetch(`${booted.baseUrl}/auth/github/callback?code=any-code&state=${encodeURIComponent(state)}`);
    expect((await callbackRes.json())).toEqual({ outcome: 'verified', agentDid: booted.agentDid });

    const publishedCalls = booted.githubFake.calls.createGist;
    const published = publishedCalls[publishedCalls.length - 1]!;
    const content = published.content;

    function thirdPartyReadsStatement(text: string): Record<string, string> {
      const fields: Record<string, string> = {};
      for (const line of text.split(/\r?\n/)) {
        const at = line.indexOf(':');
        if (at <= 0) continue;
        fields[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
      }
      return fields;
    }

    async function thirdPartyVerifies(text: string): Promise<boolean> {
      const fields = thirdPartyReadsStatement(text);
      const did = fields['did'];
      const account = fields['github'];
      const sig = fields['signature'];
      const keyMultibase = fields['key'];
      if (fields['version'] !== '1') return false;
      if (did === undefined || account === undefined || sig === undefined || keyMultibase === undefined) return false;
      const key = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint: keyMultibase });
      const raw = (key as unknown as { _publicKeyBuffer: Uint8Array })._publicKeyBuffer;
      const publicKey = nodeCrypto.createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') },
        format: 'jwk',
      });
      const bytes = `freeagents-github-proof v1\n${did}\n${account}\n`;
      return nodeCrypto.verify(null, Buffer.from(bytes, 'utf8'), publicKey, Buffer.from(sig, 'base64'));
    }

    expect(await thirdPartyVerifies(content)).toBe(true);
    const tampered = content.replace(booted.agentDid, `${booted.agentDid}x`);
    expect(tampered).not.toBe(content);
    expect(await thirdPartyVerifies(tampered)).toBe(false);
  });
});

describe('GET /auth/github/callback, the one-click proof branch: refusals and cleanup', () => {
  it("refused: error=access_denied with no code is 'refused' and exchanges nothing", async () => {
    const booted = await bootWithDerivableAgent('octo-declined');
    try {
      const startRes = await postSigned(booted.baseUrl, `/agents/${booted.agentDid}/github-proof/start`, {}, booted.operator);
      const { redirectUrl } = (await startRes.json()) as { redirectUrl: string };
      const state = new URL(redirectUrl).searchParams.get('state')!;

      const res = await fetch(`${booted.baseUrl}/auth/github/callback?error=access_denied&state=${encodeURIComponent(state)}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ outcome: 'refused', agentDid: booted.agentDid });
      expect(booted.githubFake.calls.createGist).toHaveLength(0);
      expect(booted.githubFake.calls.deleteGrant).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => booted.server.close(() => resolve()));
    }
  });

  it('400: a proof state with no code and no access_denied error keeps the missing-code 400, before any exchange', async () => {
    const booted = await bootWithDerivableAgent('octo-nocode');
    try {
      const startRes = await postSigned(booted.baseUrl, `/agents/${booted.agentDid}/github-proof/start`, {}, booted.operator);
      const { redirectUrl } = (await startRes.json()) as { redirectUrl: string };
      const state = new URL(redirectUrl).searchParams.get('state')!;

      const res = await fetch(`${booted.baseUrl}/auth/github/callback?state=${encodeURIComponent(state)}`);
      expect(res.status).toBe(400);
      expect(booted.githubFake.calls.createGist).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => booted.server.close(() => resolve()));
    }
  });

  it('401: an expired, reused or unknown state is the same 401 sign-in answers today', async () => {
    const booted = await bootWithDerivableAgent('octo-unknown-state');
    try {
      const res = await fetch(`${booted.baseUrl}/auth/github/callback?code=any-code&state=never-issued-proof-state`);
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => booted.server.close(() => resolve()));
    }
  });

  it('401: a reused (already-completed) proof state cannot complete twice', async () => {
    const booted = await bootWithDerivableAgent('octo-reused-proof');
    try {
      const startRes = await postSigned(booted.baseUrl, `/agents/${booted.agentDid}/github-proof/start`, {}, booted.operator);
      const { redirectUrl } = (await startRes.json()) as { redirectUrl: string };
      const state = new URL(redirectUrl).searchParams.get('state')!;

      const first = await fetch(`${booted.baseUrl}/auth/github/callback?code=any-code&state=${encodeURIComponent(state)}`);
      expect(first.status).toBe(200);

      const replay = await fetch(`${booted.baseUrl}/auth/github/callback?code=any-code&state=${encodeURIComponent(state)}`);
      expect(replay.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => booted.server.close(() => resolve()));
    }
  });

  it("failed: the fresh owner re-check refuses when the agent's operator changed since start, and never reaches identityAdapter.sign", async () => {
    process.env.FREEAGENTS_PLATFORM_SEED = freshSeed();
    const realIdentity = createIdentityAdapter(createKnownKeyStore());
    // A stub that spies on sign() calls and NEVER throws, so this test
    // isolates the owner re-check from a derivation-mismatch confound
    // (re-deriving with the CHANGED operator's DID would fail sign() on
    // its own, which would mask a missing re-check). createAgentDid stays
    // the real implementation, since /start needs a real re-derivable DID.
    const signCalls: Array<{ did: string; operatorDid: string; credentialId: string }> = [];
    const identity = {
      ...realIdentity,
      sign: async (did: string, payload: string, operatorDid: string, credentialId: string) => {
        signCalls.push({ did, operatorDid, credentialId });
        return { payload, signature: 'zfixture-signature-never-verified', signerDid: did };
      },
    };
    const accountRepo = new MemoryAccountRepository();
    const agentRepo = new MemoryAgentRepository();
    const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(224));
    await accountRepo.register({ did: operator.did, githubLogin: 'github-proof-callback-owner-recheck-operator' });
    const credentialId = `urn:uuid:${randomUUID()}`;
    const derived = await realIdentity.createAgentDid(operator.did, credentialId);
    const agentDid = derived.did;
    await agentRepo.create({
      did: agentDid,
      operatorDid: operator.did,
      delegation: platformDelegation(operator.did, agentDid, credentialId),
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const login = 'octo-owner-changed';
    const sessionAdapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login, id: 6001 }) });
    const githubFake = fakeProofGithub({ tokenToLogin: { [FAKE_TOKEN]: login } });
    const app = createApp(accountRepo, agentRepo, identity, githubFake.github, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const startRes = await postSigned(baseUrl, `/agents/${agentDid}/github-proof/start`, {}, operator);
      const { redirectUrl } = (await startRes.json()) as { redirectUrl: string };
      const state = new URL(redirectUrl).searchParams.get('state')!;

      // The agent's operator changes between start and callback (a real
      // storage mutation, not the route's own doing) -- decision 2's own
      // re-check must catch this at completion time, off a FRESH lookup,
      // not trust the state's stale binding.
      const otherOperator = await signingIdentityFromSeed(new Uint8Array(32).fill(225));
      await accountRepo.register({ did: otherOperator.did, githubLogin: 'github-proof-callback-other-operator' });
      const asAny = agentRepo as unknown as { rows: Map<string, unknown> };
      const stored = asAny.rows.get(agentDid) as Record<string, unknown>;
      asAny.rows.set(agentDid, { ...stored, operatorDid: otherOperator.did });

      const res = await fetch(`${baseUrl}/auth/github/callback?code=any-code&state=${encodeURIComponent(state)}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ outcome: 'failed', agentDid });
      expect(signCalls).toHaveLength(0);
      expect(githubFake.calls.createGist).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // Boots and proves one agent, then re-proves through the given override.
  async function reproveAfterVerified(secondLogin: string, getPublicGistOverride: (ref: { readonly id: string }) => Promise<Gist>): Promise<{
    readonly agentDid: string;
    readonly firstLogin: string;
    readonly baseUrl: string;
    readonly server: Server;
    readonly outcome: unknown;
    readonly calls: FakeProofGithubCalls;
  }> {
    process.env.FREEAGENTS_PLATFORM_SEED = freshSeed();
    const identity = createIdentityAdapter(createKnownKeyStore());
    const accountRepo = new MemoryAccountRepository();
    const agentRepo = new MemoryAgentRepository();
    const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(223));
    await accountRepo.register({ did: operator.did, githubLogin: 'github-proof-callback-r5-operator' });
    const credentialId = `urn:uuid:${randomUUID()}`;
    const derived = await identity.createAgentDid(operator.did, credentialId);
    const agentDid = derived.did;
    await agentRepo.create({
      did: agentDid,
      operatorDid: operator.did,
      delegation: platformDelegation(operator.did, agentDid, credentialId),
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    // First proof: a real, verifying login, so the binding starts verified.
    const firstLogin = 'octo-r5-first';
    const sessionAdapterFirst = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: firstLogin, id: 5001 }) });
    const githubFakeFirst = fakeProofGithub({ tokenToLogin: { [FAKE_TOKEN]: firstLogin } });
    const appFirst = createApp(accountRepo, agentRepo, identity, githubFakeFirst.github, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapterFirst);
    const serverFirst = appFirst.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => serverFirst.once('listening', resolve));
    const addressFirst = serverFirst.address();
    if (addressFirst === null || typeof addressFirst === 'string') throw new Error('expected a port');
    const baseUrlFirst = `http://127.0.0.1:${addressFirst.port}`;
    try {
      const startRes = await postSigned(baseUrlFirst, `/agents/${agentDid}/github-proof/start`, {}, operator);
      const { redirectUrl } = (await startRes.json()) as { redirectUrl: string };
      const state = new URL(redirectUrl).searchParams.get('state')!;
      const callbackRes = await fetch(`${baseUrlFirst}/auth/github/callback?code=any-code&state=${encodeURIComponent(state)}`);
      expect((await callbackRes.json())).toEqual({ outcome: 'verified', agentDid });
    } finally {
      await new Promise<void>((resolve) => serverFirst.close(() => resolve()));
    }

    // A DIFFERENT login, its published gist forced to the given override.
    const githubFakeSecond = fakeProofGithub({
      tokenToLogin: { [FAKE_TOKEN]: secondLogin },
      getPublicGistOverride,
    });
    const sessionAdapterSecond = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: secondLogin, id: 5002 }) });
    const appSecond = createApp(accountRepo, agentRepo, identity, githubFakeSecond.github, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapterSecond);
    const server = appSecond.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const startRes2 = await postSigned(baseUrl, `/agents/${agentDid}/github-proof/start`, {}, operator);
    const { redirectUrl: redirectUrl2 } = (await startRes2.json()) as { redirectUrl: string };
    const state2 = new URL(redirectUrl2).searchParams.get('state')!;
    const callbackRes2 = await fetch(`${baseUrl}/auth/github/callback?code=any-code&state=${encodeURIComponent(state2)}`);
    expect(callbackRes2.status).toBe(200);
    const outcome = await callbackRes2.json();

    return { agentDid, firstLogin, baseUrl, server, outcome, calls: githubFakeSecond.calls };
  }

  // QA proof r1, D1/D2: R-5 separation, both outcomes, and cleanup order.
  it.each([
    ['author mismatch', async (ref: { readonly id: string }) => ({ id: ref.id, owner: 'someone-else-entirely', files: { 'proof.txt': 'garbage' } })],
    ['not-found', async (ref: { readonly id: string }) => { throw new GistNotFoundError(ref.id); }],
  ] as const)('failed: a gist that publishes but the check reports %s is deleted with the same token before the grant, and the old binding is untouched (R-5 separation)', async (_label, override) => {
    const { agentDid, firstLogin, baseUrl, server, outcome, calls } = await reproveAfterVerified('octo-r5-second-failing', override);
    try {
      expect(outcome).toEqual({ outcome: 'failed', agentDid });
      expect(calls.createGist).toHaveLength(1);
      expect(calls.deleteGist).toHaveLength(1);
      expect(calls.deleteGist[0]!.token).toBe(FAKE_TOKEN);
      expect(calls.deleteGrant).toHaveLength(1);
      expect(calls.order.indexOf('deleteGist')).toBeLessThan(calls.order.indexOf('deleteGrant'));

      const read = await fetch(`${baseUrl}/agents/${agentDid}`);
      const readBody = (await read.json()) as Record<string, unknown>;
      expect(readBody.proofStatus).toBe('verified');
      expect(readBody.githubLogin).toBe(firstLogin);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('never leaks the exchanged token into the response, a redirect URL, or a log line', async () => {
    const booted = await bootWithDerivableAgent('octo-no-leak');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const startRes = await postSigned(booted.baseUrl, `/agents/${booted.agentDid}/github-proof/start`, {}, booted.operator);
      const { redirectUrl } = (await startRes.json()) as { redirectUrl: string };
      const state = new URL(redirectUrl).searchParams.get('state')!;

      const res = await fetch(`${booted.baseUrl}/auth/github/callback?code=any-code&state=${encodeURIComponent(state)}`);
      expect(res.status).toBe(200);
      const bodyText = await res.text();
      expect(bodyText).not.toContain(FAKE_TOKEN);
      expect(res.headers.get('location')).toBeNull();

      const loggedText = [...errSpy.mock.calls, ...warnSpy.mock.calls].map((args) => JSON.stringify(args)).join('\n');
      expect(loggedText).not.toContain(FAKE_TOKEN);
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
      await new Promise<void>((resolve) => booted.server.close(() => resolve()));
    }
  });

  // QA proof r1, D3: a failed exchange and a failed gist write (test (f)).
  it.each([
    ['a failed token exchange', { fetchImpl: failingGitHubFetch() }, 0, 0],
    ['a failed gist publish', { createGistShouldFail: true }, 1, 1],
  ] as const)("failed: %s gives 'failed' with no binding change and no token leak", async (_label, bootOptions, expectCreateGist, expectDeleteGrant) => {
    const booted = await bootWithDerivableAgent('octo-failure-case', bootOptions);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const startRes = await postSigned(booted.baseUrl, `/agents/${booted.agentDid}/github-proof/start`, {}, booted.operator);
      const { redirectUrl } = (await startRes.json()) as { redirectUrl: string };
      const state = new URL(redirectUrl).searchParams.get('state')!;

      const res = await fetch(`${booted.baseUrl}/auth/github/callback?code=any-code&state=${encodeURIComponent(state)}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ outcome: 'failed', agentDid: booted.agentDid });
      expect(booted.githubFake.calls.createGist).toHaveLength(expectCreateGist);
      expect(booted.githubFake.calls.deleteGrant).toHaveLength(expectDeleteGrant);

      const read = await fetch(`${booted.baseUrl}/agents/${booted.agentDid}`);
      const readBody = (await read.json()) as Record<string, unknown>;
      expect(readBody.proofStatus).toBe('unverified');
      expect(readBody.githubLogin).toBeNull();

      const loggedText = [...errSpy.mock.calls, ...warnSpy.mock.calls].map((args) => JSON.stringify(args)).join('\n');
      expect(loggedText).not.toContain(FAKE_TOKEN);
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
      await new Promise<void>((resolve) => booted.server.close(() => resolve()));
    }
  });
});

describe('GET /auth/github/callback, the one-click proof branch: HTML landing (decision 3)', () => {
  const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

  it("redirects an HTML caller to /agentsettings?agent=<did>&github=verified on success", async () => {
    const booted = await bootWithDerivableAgent('octo-html-verified');
    try {
      const startRes = await postSigned(booted.baseUrl, `/agents/${booted.agentDid}/github-proof/start`, {}, booted.operator);
      const { redirectUrl } = (await startRes.json()) as { redirectUrl: string };
      const state = new URL(redirectUrl).searchParams.get('state')!;

      const res = await fetch(`${booted.baseUrl}/auth/github/callback?code=any-code&state=${encodeURIComponent(state)}`, {
        headers: { Accept: HTML },
        redirect: 'manual',
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`/agentsettings?agent=${encodeURIComponent(booted.agentDid)}&github=verified`);
    } finally {
      await new Promise<void>((resolve) => booted.server.close(() => resolve()));
    }
  });

  it('redirects an HTML caller to ...&github=refused when the owner declined at GitHub', async () => {
    const booted = await bootWithDerivableAgent('octo-html-refused');
    try {
      const startRes = await postSigned(booted.baseUrl, `/agents/${booted.agentDid}/github-proof/start`, {}, booted.operator);
      const { redirectUrl } = (await startRes.json()) as { redirectUrl: string };
      const state = new URL(redirectUrl).searchParams.get('state')!;

      const res = await fetch(`${booted.baseUrl}/auth/github/callback?error=access_denied&state=${encodeURIComponent(state)}`, {
        headers: { Accept: HTML },
        redirect: 'manual',
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`/agentsettings?agent=${encodeURIComponent(booted.agentDid)}&github=refused`);
    } finally {
      await new Promise<void>((resolve) => booted.server.close(() => resolve()));
    }
  });

  it('still answers JSON to a plain fetch (no Accept header) with the exact same route', async () => {
    const booted = await bootWithDerivableAgent('octo-still-json-proof');
    try {
      const startRes = await postSigned(booted.baseUrl, `/agents/${booted.agentDid}/github-proof/start`, {}, booted.operator);
      const { redirectUrl } = (await startRes.json()) as { redirectUrl: string };
      const state = new URL(redirectUrl).searchParams.get('state')!;

      const res = await fetch(`${booted.baseUrl}/auth/github/callback?code=any-code&state=${encodeURIComponent(state)}`);
      expect(res.status).toBe(200);
      expect(String(res.headers.get('content-type'))).toContain('application/json');
    } finally {
      await new Promise<void>((resolve) => booted.server.close(() => resolve()));
    }
  });
});

// QA proof r1, D4/(d): route-level cross-over. Asserts zero gist writes
// on the proof side.
describe('GET /auth/github/callback, the one-click proof branch: route-level cross-over (decision 1)', () => {
  it('a sign-in state presented at the callback never completes a proof and mints no session-shaped body for a proof caller: falls through to the ordinary sign-in success shape', async () => {
    const booted = await bootWithDerivableAgent('octo-crossover-signin-state');
    try {
      const signInStart = await booted.sessionAdapter.beginGitHubOAuth();
      const res = await fetch(`${booted.baseUrl}/auth/github/callback?code=any-code&state=${encodeURIComponent(signInStart.state)}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      // The ordinary sign-in shape (a Session), never a proof outcome.
      expect(body).toEqual({
        subject: expect.any(String),
        method: 'github-oauth',
        token: expect.any(String),
        issuedAt: expect.any(String),
        expiresAt: expect.any(String),
      });
      expect(booted.githubFake.calls.createGist).toHaveLength(0);
      expect(booted.githubFake.calls.deleteGrant).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => booted.server.close(() => resolve()));
    }
  });

  it('a proof state presented at the callback never mints a session: the proof branch runs and answers an outcome shape, never {subject, method, token}', async () => {
    const booted = await bootWithDerivableAgent('octo-crossover-proof-state');
    try {
      const startRes = await postSigned(booted.baseUrl, `/agents/${booted.agentDid}/github-proof/start`, {}, booted.operator);
      const { redirectUrl } = (await startRes.json()) as { redirectUrl: string };
      const state = new URL(redirectUrl).searchParams.get('state')!;

      const res = await fetch(`${booted.baseUrl}/auth/github/callback?code=any-code&state=${encodeURIComponent(state)}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ outcome: 'verified', agentDid: booted.agentDid });
      expect(Object.keys(body).sort()).toEqual(['agentDid', 'outcome']);
      expect(body).not.toHaveProperty('token');
    } finally {
      await new Promise<void>((resolve) => booted.server.close(() => resolve()));
    }
  });
});
