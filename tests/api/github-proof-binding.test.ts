// B76: a one-click GitHub proof completes only in the browser that began it.
// POST /agents/:agentDid/github-proof/start binds the proof's state to the
// caller with the same HttpOnly fa_oauth_state cookie the sign-in start sets
// (SW4-06), and the proof branch of GET /auth/github/callback completes a
// proof only when that cookie comes back equal to the state in the query.
// Every test drives the real routes over HTTP, signs the start as the
// agent's operator, and reads the real Set-Cookie header the way a browser
// would.
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import { createKnownKeyStore } from '../../src/adapters/identity/did-abt-resolver.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { MemoryAccountRepository, MemoryAgentRepository } from '../../src/adapters/storage/memory.js';
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import { GistNotFoundError } from '../../src/adapters/github/types.js';
import type { CreateGistInput, CreateGistResult, DeleteGistInput, DeleteGrantInput, Gist, GithubAdapter } from '../../src/adapters/github/types.js';
import type { Delegation } from '../../src/domain/agent.js';
import { fakeGitHubConfig, fakeGitHubFetch, startGitHubSignIn } from '../helpers/session-fixtures.js';
import { signRequest, signingIdentityFromSeed, type SigningIdentity } from '../helpers/sign-request.js';

const HTML = 'text/html';
const REFUSAL = { error: 'invalid or expired sign-in attempt' };
const FAKE_TOKEN = 'fake-access-token'; // fakeGitHubFetch's own exchanged token.
const LOGIN = 'octo-proof-binding';

const ORIGINAL_SEED = process.env.FREEAGENTS_PLATFORM_SEED;
let seedCounter = 0;

let server: Server | null = null;

afterEach(async () => {
  if (server !== null) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

afterAll(() => {
  if (ORIGINAL_SEED === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
  else process.env.FREEAGENTS_PLATFORM_SEED = ORIGINAL_SEED;
});

async function postSigned(baseUrl: string, path: string, identity: SigningIdentity): Promise<Response> {
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, 'POST', targetUri, { body: '{}' });
  return fetch(targetUri, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
    body: '{}',
  });
}

function delegation(operatorDid: string, agentDid: string, credentialId: string, platform: boolean): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: credentialId,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: agentDid, ...(platform ? { delegationSignedBy: 'platform' } : {}) },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-01-01T00:00:00Z',
      verificationMethod: `${operatorDid}#zKeyHash`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zfixture-not-verified-here',
    },
  };
}

interface Calls {
  readonly createGist: CreateGistInput[];
  readonly deleteGist: DeleteGistInput[];
  readonly deleteGrant: DeleteGrantInput[];
  // Every request the session adapter made to GitHub (the code exchange
  // and the user read), so a refused callback can be shown to exchange nothing.
  readonly fetches: string[];
}

function fakeGithub(calls: Calls): GithubAdapter {
  const gists = new Map<string, Gist>();
  const no = (name: string) => () => Promise.reject(new NotImplementedError('github', name));
  return {
    platformLogin: 'freeagents-platform',
    getPullRequest: no('getPullRequest'),
    getMergeCommitSignature: no('getMergeCommitSignature'),
    getPublicGist: (ref) => {
      const gist = gists.get(ref.id);
      return gist === undefined ? Promise.reject(new GistNotFoundError(ref.id)) : Promise.resolve(gist);
    },
    createStagingRepository: no('createStagingRepository'),
    grantPush: no('grantPush'),
    getCommit: no('getCommit'),
    getCollaboratorPermission: no('getCollaboratorPermission'),
    readRepository: no('readRepository'),
    compareCommits: no('compareCommits'),
    createGist: (input: CreateGistInput): Promise<CreateGistResult> => {
      calls.createGist.push(input);
      const id = `fake-gist-${randomUUID()}`;
      gists.set(id, { id, owner: LOGIN, files: { [input.filename]: input.content } });
      return Promise.resolve({ id });
    },
    deleteGist: (input: DeleteGistInput): Promise<void> => {
      calls.deleteGist.push(input);
      gists.delete(input.id);
      return Promise.resolve();
    },
    deleteGrant: (input: DeleteGrantInput): Promise<void> => {
      calls.deleteGrant.push(input);
      return Promise.resolve();
    },
  };
}

interface Booted {
  readonly baseUrl: string;
  readonly agentRepo: MemoryAgentRepository;
  readonly operator: SigningIdentity;
  readonly stranger: SigningIdentity;
  readonly agentDid: string;
  readonly walletAgentDid: string;
  readonly calls: Calls;
}

async function boot(redirectUri?: string): Promise<Booted> {
  seedCounter += 1;
  process.env.FREEAGENTS_PLATFORM_SEED = `b76b${seedCounter}`.padEnd(64, '0');
  const identity = createIdentityAdapter(createKnownKeyStore());
  const accountRepo = new MemoryAccountRepository();
  const agentRepo = new MemoryAgentRepository();
  const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(231));
  const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(232));
  await accountRepo.register({ did: operator.did, githubLogin: 'github-proof-binding-operator' });
  await accountRepo.register({ did: stranger.did, githubLogin: 'github-proof-binding-stranger' });

  // A site agent whose key the platform holds: its DID re-derives from the
  // operator and the delegation's own id.
  const credentialId = `urn:uuid:${randomUUID()}`;
  const agentDid = (await identity.createAgentDid(operator.did, credentialId)).did;
  await agentRepo.create({
    did: agentDid,
    operatorDid: operator.did,
    delegation: delegation(operator.did, agentDid, credentialId, true),
    name: 'scout',
    skills: ['triage'],
    githubLogin: null,
  });
  // A wallet-path agent: the platform never held its key.
  const walletAgentDid = 'did:abt:zWalletPathAgentB76';
  await agentRepo.create({
    did: walletAgentDid,
    operatorDid: operator.did,
    delegation: delegation(operator.did, walletAgentDid, 'urn:uuid:wallet-fixed', false),
    name: 'wallet-scout',
    skills: ['triage'],
    githubLogin: null,
  });

  const calls: Calls = { createGist: [], deleteGist: [], deleteGrant: [], fetches: [] };
  const inner = fakeGitHubFetch({ login: LOGIN, id: 9301 });
  const sessionAdapter = createSessionAdapter({
    github: { ...fakeGitHubConfig(), ...(redirectUri !== undefined ? { redirectUri } : {}) },
    fetchImpl: ((input: string | URL | Request, init?: RequestInit) => {
      calls.fetches.push(typeof input === 'string' ? input : input.toString());
      return inner(input, init);
    }) as typeof fetch,
  });
  const app = createApp(
    accountRepo, agentRepo, identity, fakeGithub(calls), undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter,
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected server to listen on a port');
  return { baseUrl: `http://127.0.0.1:${address.port}`, agentRepo, operator, stranger, agentDid, walletAgentDid, calls };
}

interface ParsedCookie {
  readonly name: string;
  readonly value: string;
  // Attribute names lower-cased; a flag attribute (HttpOnly, Secure) maps to ''.
  readonly attributes: ReadonlyMap<string, string>;
}

// Every Set-Cookie line the response carries for `name`, parsed attribute by
// attribute, so a test asserts each attribute and never a substring.
function cookiesNamed(res: Response, name: string): ParsedCookie[] {
  const parsed: ParsedCookie[] = [];
  for (const line of res.headers.getSetCookie()) {
    const [pair, ...rest] = line.split(';').map((part) => part.trim());
    const eq = pair!.indexOf('=');
    if (pair!.slice(0, eq) !== name) continue;
    const attributes = new Map<string, string>();
    for (const attr of rest) {
      const at = attr.indexOf('=');
      if (at === -1) attributes.set(attr.toLowerCase(), '');
      else attributes.set(attr.slice(0, at).toLowerCase(), attr.slice(at + 1));
    }
    parsed.push({ name, value: pair!.slice(eq + 1), attributes });
  }
  return parsed;
}

// Begins a proof through the real start and answers the state in its
// redirectUrl with the Cookie header a browser holding the start's cookie
// would send back. The cookie is built from the state here, not read from
// the start's answer, so a missing Set-Cookie fails (a) and the tests below
// keep failing or passing on what the callback does.
async function beginProof(booted: Booted): Promise<{ readonly state: string; readonly cookie: string }> {
  const res = await postSigned(booted.baseUrl, `/agents/${booted.agentDid}/github-proof/start`, booted.operator);
  expect(res.status).toBe(200);
  const { redirectUrl } = (await res.json()) as { redirectUrl: string };
  const state = stateOf(redirectUrl);
  return { state, cookie: `fa_oauth_state=${state}` };
}

function stateOf(redirectUrl: string): string {
  const state = new URL(redirectUrl).searchParams.get('state');
  if (state === null) throw new Error('the redirectUrl carries no state');
  return state;
}

function callback(baseUrl: string, state: string, init: { cookie?: string; accept?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.cookie !== undefined) headers['Cookie'] = init.cookie;
  if (init.accept !== undefined) headers['Accept'] = init.accept;
  return fetch(`${baseUrl}/auth/github/callback?code=good-code&state=${encodeURIComponent(state)}`, { headers, redirect: 'manual' });
}

function expectCleared(res: Response): void {
  const cleared = cookiesNamed(res, 'fa_oauth_state');
  expect(cleared).toHaveLength(1);
  expect(cleared[0]!.value).toBe('');
  expect(cleared[0]!.attributes.get('path')).toBe('/auth/github/callback');
  expect(new Date(cleared[0]!.attributes.get('expires')!).getTime()).toBeLessThan(Date.now());
}

function expectNothingHappened(booted: Booted): void {
  expect(booted.calls.fetches, 'no token exchange and no user read').toEqual([]);
  expect(booted.calls.createGist, 'no gist published').toEqual([]);
  expect(booted.calls.deleteGist).toEqual([]);
  expect(booted.calls.deleteGrant, 'no grant deleted').toEqual([]);
}

describe('(a) POST /agents/:agentDid/github-proof/start sets the binding cookie', () => {
  it('sets one fa_oauth_state cookie holding the state in redirectUrl, HttpOnly, SameSite=Lax, on the callback path, for 600 seconds, without Secure on an http redirect', async () => {
    const booted = await boot();
    const res = await postSigned(booted.baseUrl, `/agents/${booted.agentDid}/github-proof/start`, booted.operator);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['redirectUrl']);
    const state = stateOf(body.redirectUrl as string);
    expect(new URL(body.redirectUrl as string).searchParams.get('redirect_uri')).toMatch(/^http:\/\//);

    const cookies = cookiesNamed(res, 'fa_oauth_state');
    expect(cookies).toHaveLength(1);
    const cookie = cookies[0]!;
    expect(cookie.value).toBe(state);
    expect(cookie.attributes.has('httponly')).toBe(true);
    expect(cookie.attributes.get('samesite')).toBe('Lax');
    expect(cookie.attributes.get('path')).toBe('/auth/github/callback');
    expect(cookie.attributes.get('max-age')).toBe('600');
    expect(cookie.attributes.has('secure')).toBe(false);
    expect(res.headers.getSetCookie()).toHaveLength(1);
  });

  it('adds Secure when the redirect_uri in the answer is https', async () => {
    const booted = await boot('https://freeagents.example/auth/github/callback');
    const res = await postSigned(booted.baseUrl, `/agents/${booted.agentDid}/github-proof/start`, booted.operator);
    expect(res.status).toBe(200);
    const { redirectUrl } = (await res.json()) as { redirectUrl: string };
    expect(new URL(redirectUrl).searchParams.get('redirect_uri')).toMatch(/^https:\/\//);

    const cookies = cookiesNamed(res, 'fa_oauth_state');
    expect(cookies).toHaveLength(1);
    const cookie = cookies[0]!;
    expect(cookie.value).toBe(stateOf(redirectUrl));
    expect(cookie.attributes.has('secure')).toBe(true);
    expect(cookie.attributes.has('httponly')).toBe(true);
    expect(cookie.attributes.get('samesite')).toBe('Lax');
    expect(cookie.attributes.get('path')).toBe('/auth/github/callback');
    expect(cookie.attributes.get('max-age')).toBe('600');
  });

  it('sets no cookie on its 409 (a wallet-path agent)', async () => {
    const booted = await boot();
    const res = await postSigned(booted.baseUrl, `/agents/${booted.walletAgentDid}/github-proof/start`, booted.operator);
    expect(res.status).toBe(409);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('sets no cookie on its 403 (a stranger)', async () => {
    const booted = await boot();
    const res = await postSigned(booted.baseUrl, `/agents/${booted.agentDid}/github-proof/start`, booted.stranger);
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('sets no cookie on its 401 (no session, no signature)', async () => {
    const booted = await boot();
    const res = await fetch(`${booted.baseUrl}/agents/${booted.agentDid}/github-proof/start`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('sets no cookie on its 404 (an unknown agent)', async () => {
    const booted = await boot();
    const res = await postSigned(booted.baseUrl, '/agents/did:abt:zNeverListedB76/github-proof/start', booted.operator);
    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe("(b) the proof callback with the starting browser's cookie", () => {
  it('answers verified as JSON and clears the cookie on the callback path', async () => {
    const booted = await boot();
    const { state, cookie } = await beginProof(booted);

    const res = await callback(booted.baseUrl, state, { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'verified', agentDid: booted.agentDid });
    expectCleared(res);
    expect(await booted.agentRepo.findByDid(booted.agentDid)).toMatchObject({ githubLogin: LOGIN, proofStatus: 'verified' });
    expect(booted.calls.createGist.map((c) => c.token)).toEqual([FAKE_TOKEN]);
    expect(booted.calls.deleteGrant.map((c) => c.token)).toEqual([FAKE_TOKEN]);
  });

  it('answers a browser with the 302 to /agentsettings and clears the cookie on the callback path', async () => {
    const booted = await boot();
    const { state, cookie } = await beginProof(booted);

    const res = await callback(booted.baseUrl, state, { cookie, accept: HTML });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/agentsettings?agent=${encodeURIComponent(booted.agentDid)}&github=verified`);
    expectCleared(res);
  });
});

describe('(c) the proof callback with no cookie (another browser opened the link)', () => {
  it('answers 401 with the whole refusal body, exchanges and publishes nothing, leaves the agent alone, clears the cookie path, and the state still completes with its cookie', async () => {
    const booted = await boot();
    const { state, cookie } = await beginProof(booted);
    const before = await booted.agentRepo.findByDid(booted.agentDid);

    const refused = await callback(booted.baseUrl, state);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual(REFUSAL);
    expectCleared(refused);
    expectNothingHappened(booted);
    expect(await booted.agentRepo.findByDid(booted.agentDid)).toEqual(before);

    const completed = await callback(booted.baseUrl, state, { cookie });
    expect(completed.status).toBe(200);
    expect(await completed.json()).toEqual({ outcome: 'verified', agentDid: booted.agentDid });
    expect(booted.calls.createGist).toHaveLength(1);
  });

  it('answers a browser 401 with the error page, changes nothing, and the state still completes with its cookie', async () => {
    const booted = await boot();
    const { state, cookie } = await beginProof(booted);
    const before = await booted.agentRepo.findByDid(booted.agentDid);

    const refused = await callback(booted.baseUrl, state, { accept: HTML });
    expect(refused.status).toBe(401);
    expect(String(refused.headers.get('content-type'))).toContain('text/html');
    const page = await refused.text();
    expect(page).toContain('Sign-in did not go through');
    expectCleared(refused);
    expectNothingHappened(booted);
    expect(await booted.agentRepo.findByDid(booted.agentDid)).toEqual(before);

    const completed = await callback(booted.baseUrl, state, { cookie, accept: HTML });
    expect(completed.status).toBe(302);
    expect(completed.headers.get('location')).toBe(`/agentsettings?agent=${encodeURIComponent(booted.agentDid)}&github=verified`);
  });
});

describe('(d) the proof callback with a cookie holding a different state', () => {
  it('answers 401 when this browser began another proof, and consumes neither state', async () => {
    const booted = await boot();
    const first = await beginProof(booted);
    const second = await beginProof(booted);
    expect(second.state).not.toBe(first.state);

    const refused = await callback(booted.baseUrl, first.state, { cookie: second.cookie });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual(REFUSAL);
    expectCleared(refused);
    expectNothingHappened(booted);

    expect((await callback(booted.baseUrl, first.state, { cookie: first.cookie })).status).toBe(200);
    expect((await callback(booted.baseUrl, second.state, { cookie: second.cookie })).status).toBe(200);
  });

  it('answers 401 when this browser began a sign-in, and consumes neither state', async () => {
    const booted = await boot();
    const proof = await beginProof(booted);
    const signIn = await startGitHubSignIn(booted.baseUrl);

    const refused = await callback(booted.baseUrl, proof.state, { cookie: signIn.cookie });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual(REFUSAL);
    expectNothingHappened(booted);

    expect((await callback(booted.baseUrl, proof.state, { cookie: proof.cookie })).status).toBe(200);
    expect((await callback(booted.baseUrl, signIn.state, { cookie: signIn.cookie })).status).toBe(200);
  });

  it('compares the whole string exactly, with no case folding', async () => {
    const booted = await boot();
    const { state } = await beginProof(booted);
    const swapped = state.toUpperCase() === state ? state.toLowerCase() : state.toUpperCase();
    expect(swapped).not.toBe(state);

    const refused = await callback(booted.baseUrl, state, { cookie: `fa_oauth_state=${swapped}` });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual(REFUSAL);
    expectNothingHappened(booted);
  });
});

describe('(e) a proof state is single use', () => {
  it('answers 401 for a reused state even with its cookie', async () => {
    const booted = await boot();
    const { state, cookie } = await beginProof(booted);

    expect((await callback(booted.baseUrl, state, { cookie })).status).toBe(200);
    const replay = await callback(booted.baseUrl, state, { cookie });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual(REFUSAL);
    expect(booted.calls.createGist).toHaveLength(1);
  });
});

describe('(f) GitHub\'s decline (error=access_denied, no code)', () => {
  it('answers refused without the cookie, exchanges nothing, and clears the cookie', async () => {
    const booted = await boot();
    const { state } = await beginProof(booted);

    const res = await fetch(`${booted.baseUrl}/auth/github/callback?error=access_denied&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'refused', agentDid: booted.agentDid });
    expectNothingHappened(booted);
    expectCleared(res);
  });

  it('lands a browser on /agentsettings with github=refused without the cookie', async () => {
    const booted = await boot();
    const { state } = await beginProof(booted);

    const res = await fetch(`${booted.baseUrl}/auth/github/callback?error=access_denied&state=${encodeURIComponent(state)}`, {
      headers: { Accept: HTML },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/agentsettings?agent=${encodeURIComponent(booted.agentDid)}&github=refused`);
    expectCleared(res);
  });
});
