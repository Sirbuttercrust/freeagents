// FIX-B62a (bugs.md B62, part A): POST /accounts never stores a GitHub login
// nobody proved. A login rides the body only with a public gist, authored by
// that GitHub account, whose statement the DID's own key signed (the same
// proof POST /agents/:agentDid/account-proof takes for agents). Without a
// gist the login is refused and nothing is stored or fetched.
//
// Every registration here uses a real did:abt identity (a real ed25519 key
// bound to its DID), the real identity adapter verifies the gist signature,
// and a fake GitHub serves the gists.
import * as nodeCrypto from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { fromPublicKey } from '@arcblock/did';

import { createApp } from '../../src/api/app.js';
import { GistNotFoundError } from '../../src/adapters/github/types.js';
import type { Gist, GithubAdapter } from '../../src/adapters/github/types.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import { createKnownKeyStore } from '../../src/adapters/identity/did-abt-resolver.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import { MemoryAccountRepository, MemoryAgentRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import { createJob } from '../../src/domain/job.js';
import { fakeGitHubConfig, fakeGitHubFetch, sessionHeader } from '../helpers/session-fixtures.js';
import { signingIdentityFromSeed, type SigningIdentity } from '../helpers/sign-request.js';

const NEEDS_PROOF =
  "a GitHub login needs proof: publish a gist from that GitHub account, signed by this DID's key, and send its URL as gist; or leave githubLogin out";
const GIST_NEEDS_LOGIN = 'gist proves a githubLogin; send both or neither';
const PLATFORM_SEED = 'e'.repeat(64);

// A seed per identity, so no test shares a key with another.
let seedCounter = 100;
async function freshIdentity(): Promise<SigningIdentity> {
  seedCounter += 1;
  return signingIdentityFromSeed(new Uint8Array(32).fill(seedCounter));
}

function keyLine(identity: SigningIdentity): string {
  return identity.keyid.slice(identity.keyid.indexOf('#') + 1);
}

// The statement a wallet tool publishes: the four v1 fields plus the key
// line. The signed bytes are spelled out here rather than taken from the
// service's own helper, so a drift in the service's payload shows as red.
function signedStatement(opts: {
  readonly did: string;
  readonly github: string;
  readonly signer: SigningIdentity;
  readonly signedDid?: string;
  readonly signedGithub?: string;
  readonly key: string;
}): string {
  const bytes = `freeagents-github-proof v1\n${opts.signedDid ?? opts.did}\n${opts.signedGithub ?? opts.github}\n`;
  const signature = nodeCrypto.sign(null, Buffer.from(bytes, 'utf8'), opts.signer.privateKey).toString('base64');
  return [
    'FreeAgents GitHub proof',
    'version: 1',
    `did: ${opts.did}`,
    `github: ${opts.github}`,
    `signature: ${signature}`,
    `key: ${opts.key}`,
  ].join('\n');
}

function fakeGithub(gists: Map<string, Gist | null>, getPublicGist: ReturnType<typeof vi.fn>): GithubAdapter {
  getPublicGist.mockImplementation((ref: { id: string }) => {
    const gist = gists.get(ref.id);
    if (gist === null) return Promise.reject(new GistNotFoundError(ref.id));
    if (gist === undefined) return Promise.reject(new Error(`gist ${ref.id} unreachable`));
    return Promise.resolve(gist);
  });
  const no = (name: string) => () => Promise.reject(new NotImplementedError('github', name));
  return {
    platformLogin: 'freeagents-platform',
    getPullRequest: no('getPullRequest'),
    getMergeCommitSignature: no('getMergeCommitSignature'),
    getPublicGist,
    createStagingRepository: no('createStagingRepository'),
    grantPush: no('grantPush'),
    getCommit: no('getCommit'),
    getCollaboratorPermission: no('getCollaboratorPermission'),
    readRepository: no('readRepository'),
    compareCommits: no('compareCommits'),
    createGist: no('createGist'),
    deleteGist: no('deleteGist'),
    deleteGrant: no('deleteGrant'),
  } as GithubAdapter;
}

async function postJson(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

describe('POST /accounts: a GitHub login is stored only when a signed gist proves it (FIX-B62a)', () => {
  let server: Server;
  let baseUrl: string;
  let accountRepo: MemoryAccountRepository;
  let jobRepo: MemoryJobRepository;
  let gists: Map<string, Gist | null>;
  let getPublicGist: ReturnType<typeof vi.fn>;
  let sessionLogin: string;
  let session: ReturnType<typeof createSessionAdapter>;
  let originalSeed: string | undefined;

  beforeAll(() => {
    originalSeed = process.env.FREEAGENTS_PLATFORM_SEED;
    process.env.FREEAGENTS_PLATFORM_SEED = PLATFORM_SEED;
  });

  afterAll(() => {
    if (originalSeed === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
    else process.env.FREEAGENTS_PLATFORM_SEED = originalSeed;
  });

  // A fresh app per test: the store, the gists and the call count all start
  // empty, so "nothing stored" and "never fetched" mean this test's own call.
  async function start(login = 'session-user-unused', repo?: MemoryAccountRepository): Promise<void> {
    accountRepo = repo ?? new MemoryAccountRepository();
    jobRepo = new MemoryJobRepository();
    gists = new Map();
    getPublicGist = vi.fn();
    sessionLogin = login;
    session = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login, id: 42 }),
    });
    const app = createApp(
      accountRepo,
      new MemoryAgentRepository(),
      createIdentityAdapter(createKnownKeyStore()),
      fakeGithub(gists, getPublicGist),
      jobRepo,
      undefined,
      undefined,
      undefined,
      { write: 10_000, upstream: 10_000, read: 10_000 },
      undefined,
      undefined,
      session,
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  afterEach(() => {
    server.close();
  });

  async function sessionAuth(): Promise<{ readonly authorization: string }> {
    return sessionHeader(session);
  }

  async function readBack(did: string): Promise<Response> {
    return fetch(`${baseUrl}/accounts/${did}`);
  }

  // Publishes a well-formed, correctly signed gist for (identity, login).
  function publishGist(id: string, identity: SigningIdentity, login: string, owner = login): string {
    gists.set(id, {
      id,
      owner,
      files: {
        'proof.txt': signedStatement({
          did: identity.did,
          github: `https://github.com/${login}`,
          signer: identity,
          key: keyLine(identity),
        }),
      },
    });
    return `https://gist.github.com/${login}/${id}`;
  }

  it('(a) { did } alone registers with no login: 201, githubLogin null, and it reads back null', async () => {
    await start();
    const id = await freshIdentity();
    const res = await postJson(baseUrl, '/accounts', { did: id.did });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Record<string, unknown>).githubLogin).toBeNull();
    const read = await readBack(id.did);
    expect(read.status).toBe(200);
    expect(((await read.json()) as Record<string, unknown>).githubLogin).toBeNull();
  });

  it('(b) { did, githubLogin } with no gist is 400 with the whole sentence, stores nothing and never asks GitHub', async () => {
    await start();
    const id = await freshIdentity();
    const res = await postJson(baseUrl, '/accounts', { did: id.did, githubLogin: 'someone-typed' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe(NEEDS_PROOF);
    expect((await readBack(id.did)).status).toBe(404);
    expect(await accountRepo.findByGithubLogin('someone-typed')).toBeNull();
    expect(getPublicGist).not.toHaveBeenCalled();
  });

  it('a gist with no githubLogin is 400 with the whole sentence, stores nothing and never asks GitHub', async () => {
    await start();
    const id = await freshIdentity();
    const url = publishGist('g-nologin', id, 'nologin-user');
    const res = await postJson(baseUrl, '/accounts', { did: id.did, gist: url });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe(GIST_NEEDS_LOGIN);
    expect((await readBack(id.did)).status).toBe(404);
    expect(getPublicGist).not.toHaveBeenCalled();
  });

  it.each([
    ['a gist that is not a string', 'gist-shape-user', 42],
    ['an empty gist', 'gist-shape-user', ''],
    ['an empty githubLogin', '', 'https://gist.github.com/x/abc'],
    ['a githubLogin with whitespace', 'has space', 'https://gist.github.com/x/abc'],
  ])('%s is 400 and stores nothing', async (_name, githubLogin, gist) => {
    await start();
    const id = await freshIdentity();
    const res = await postJson(baseUrl, '/accounts', { did: id.did, githubLogin, gist });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe(
      'body must be { did, githubLogin?, gist?, passkeySubject? }; did and githubLogin are non-empty strings, githubLogin has no whitespace, gist is a URL',
    );
    expect((await readBack(id.did)).status).toBe(404);
    expect(getPublicGist).not.toHaveBeenCalled();
  });

  it('a malformed gist URL is 400 with the account-proof sentence and stores nothing', async () => {
    await start();
    const id = await freshIdentity();
    const res = await postJson(baseUrl, '/accounts', {
      did: id.did,
      githubLogin: 'proved-user',
      gist: 'https://github.com/proved-user/not-a-gist',
    });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe('gist must be a URL like https://gist.github.com/<owner>/<id>');
    expect((await readBack(id.did)).status).toBe(404);
    expect(getPublicGist).not.toHaveBeenCalled();
  });

  it('(c) a signed gist by that login for this DID registers the login, and a GitHub session for it acts as this DID', async () => {
    await start('proved-user-c');
    const id = await freshIdentity();
    const url = publishGist('g-c', id, 'proved-user-c');
    const res = await postJson(baseUrl, '/accounts', { did: id.did, githubLogin: 'proved-user-c', gist: url });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.did).toBe(id.did);
    expect(body.githubLogin).toBe('proved-user-c');
    const read = await readBack(id.did);
    expect(((await read.json()) as Record<string, unknown>).githubLogin).toBe('proved-user-c');

    const me = await fetch(`${baseUrl}/accounts/me`, { headers: await sessionAuth() });
    expect(me.status).toBe(200);
    expect(((await me.json()) as Record<string, unknown>).did).toBe(id.did);
  });

  it('(c) the login is stored as GitHub spells it (the gist author), so the taken check and sign-in match without case', async () => {
    await start();
    const id = await freshIdentity();
    const url = publishGist('g-case', id, 'Mixed-Case-User', 'mixed-case-user');
    const res = await postJson(baseUrl, '/accounts', { did: id.did, githubLogin: 'Mixed-Case-User', gist: url });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Record<string, unknown>).githubLogin).toBe('mixed-case-user');
    expect((await accountRepo.findByGithubLogin('mixed-case-user'))?.did).toBe(id.did);
  });

  it('(d) the gist URL owner matches the login without case: a URL spelled Lower-Owner registers lower-owner', async () => {
    await start();
    const id = await freshIdentity();
    publishGist('g-d0', id, 'lower-owner');
    const res = await postJson(baseUrl, '/accounts', {
      did: id.did,
      githubLogin: 'lower-owner',
      gist: 'https://gist.github.com/Lower-Owner/g-d0',
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Record<string, unknown>).githubLogin).toBe('lower-owner');
    expect((await accountRepo.findByGithubLogin('lower-owner'))?.did).toBe(id.did);
  });

  it('(d) a gist whose URL owner is not the login is 409 and stores nothing', async () => {
    await start();
    const id = await freshIdentity();
    // A genuine gist by the login, but the URL points at another owner's path.
    publishGist('g-d1', id, 'real-owner-d');
    const res = await postJson(baseUrl, '/accounts', {
      did: id.did,
      githubLogin: 'real-owner-d',
      gist: 'https://gist.github.com/someone-else/g-d1',
    });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('the gist URL owner someone-else does not match the claimed githubLogin real-owner-d');
    expect((await readBack(id.did)).status).toBe(404);
    expect(getPublicGist).not.toHaveBeenCalled();
  });

  it('(d) a gist authored by another GitHub account is 409 and stores nothing', async () => {
    await start();
    const id = await freshIdentity();
    const url = publishGist('g-d2', id, 'claimed-d', 'the-real-author');
    const res = await postJson(baseUrl, '/accounts', { did: id.did, githubLogin: 'claimed-d', gist: url });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('the gist author the-real-author does not match the claimed githubLogin claimed-d');
    expect((await readBack(id.did)).status).toBe(404);
    expect(await accountRepo.findByGithubLogin('claimed-d')).toBeNull();
  });

  it('(e) a statement that binds another DID is 409 and stores nothing', async () => {
    await start();
    const id = await freshIdentity();
    const other = await freshIdentity();
    gists.set('g-e1', {
      id: 'g-e1',
      owner: 'user-e1',
      files: {
        'proof.txt': signedStatement({
          did: other.did,
          github: 'https://github.com/user-e1',
          signer: other,
          key: keyLine(other),
        }),
      },
    });
    const res = await postJson(baseUrl, '/accounts', {
      did: id.did,
      githubLogin: 'user-e1',
      gist: 'https://gist.github.com/user-e1/g-e1',
    });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe(
      'the gist does not hold a well-formed statement binding this DID to this GitHub account',
    );
    expect((await readBack(id.did)).status).toBe(404);
    expect(await accountRepo.findByGithubLogin('user-e1')).toBeNull();
  });

  it('(e) a statement that binds another GitHub login is 409 and stores nothing', async () => {
    await start();
    const id = await freshIdentity();
    gists.set('g-e2', {
      id: 'g-e2',
      owner: 'user-e2',
      files: {
        'proof.txt': signedStatement({
          did: id.did,
          github: 'https://github.com/a-different-login',
          signer: id,
          key: keyLine(id),
        }),
      },
    });
    const res = await postJson(baseUrl, '/accounts', {
      did: id.did,
      githubLogin: 'user-e2',
      gist: 'https://gist.github.com/user-e2/g-e2',
    });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe(
      'the gist does not hold a well-formed statement binding this DID to this GitHub account',
    );
    expect((await readBack(id.did)).status).toBe(404);
    expect(await accountRepo.findByGithubLogin('user-e2')).toBeNull();
  });

  it("(f) a signature made by another key, under this DID's own key line, is 409 and stores nothing", async () => {
    await start();
    const id = await freshIdentity();
    const attacker = await freshIdentity();
    gists.set('g-f1', {
      id: 'g-f1',
      owner: 'user-f1',
      files: {
        'proof.txt': signedStatement({
          did: id.did,
          github: 'https://github.com/user-f1',
          signer: attacker,
          key: keyLine(id),
        }),
      },
    });
    const res = await postJson(baseUrl, '/accounts', {
      did: id.did,
      githubLogin: 'user-f1',
      gist: 'https://gist.github.com/user-f1/g-f1',
    });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("the signature does not check out against this DID's key");
    expect((await readBack(id.did)).status).toBe(404);
    expect(await accountRepo.findByGithubLogin('user-f1')).toBeNull();
  });

  it("(f) a key line that is not this DID's key is 409 and stores nothing", async () => {
    await start();
    const id = await freshIdentity();
    const attacker = await freshIdentity();
    gists.set('g-f2', {
      id: 'g-f2',
      owner: 'user-f2',
      files: {
        'proof.txt': signedStatement({
          did: id.did,
          github: 'https://github.com/user-f2',
          signer: attacker,
          key: keyLine(attacker),
        }),
      },
    });
    const res = await postJson(baseUrl, '/accounts', {
      did: id.did,
      githubLogin: 'user-f2',
      gist: 'https://gist.github.com/user-f2/g-f2',
    });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe(
      `the key line does not derive ${id.did}; check the publicKeyMultibase on the key line is this DID's own key`,
    );
    expect((await readBack(id.did)).status).toBe(404);
    expect(await accountRepo.findByGithubLogin('user-f2')).toBeNull();
  });

  it('a signature that is not base64 ed25519 is 409 and stores nothing', async () => {
    await start();
    const id = await freshIdentity();
    gists.set('g-f3', {
      id: 'g-f3',
      owner: 'user-f3',
      files: {
        'proof.txt': [
          'version: 1',
          `did: ${id.did}`,
          'github: https://github.com/user-f3',
          'signature: not-a-signature',
          `key: ${keyLine(id)}`,
        ].join('\n'),
      },
    });
    const res = await postJson(baseUrl, '/accounts', {
      did: id.did,
      githubLogin: 'user-f3',
      gist: 'https://gist.github.com/user-f3/g-f3',
    });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('the signature field is not a well-formed ed25519 signature (base64, 64 bytes)');
    expect((await readBack(id.did)).status).toBe(404);
  });

  it('a statement with no key line, for a DID this service has never seen sign, is 409 and stores nothing', async () => {
    await start();
    const id = await freshIdentity();
    const bytes = `freeagents-github-proof v1\n${id.did}\nhttps://github.com/user-nokey\n`;
    const signature = nodeCrypto.sign(null, Buffer.from(bytes, 'utf8'), id.privateKey).toString('base64');
    gists.set('g-nokey', {
      id: 'g-nokey',
      owner: 'user-nokey',
      files: {
        'proof.txt': `version: 1\ndid: ${id.did}\ngithub: https://github.com/user-nokey\nsignature: ${signature}\n`,
      },
    });
    const res = await postJson(baseUrl, '/accounts', {
      did: id.did,
      githubLogin: 'user-nokey',
      gist: 'https://gist.github.com/user-nokey/g-nokey',
    });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe(
      "this DID has no key on record yet; add a `key: <publicKeyMultibase>` line to the gist statement naming this DID's own key",
    );
    expect((await readBack(id.did)).status).toBe(404);
  });

  it('(g) a gist that does not exist is 409 and stores nothing', async () => {
    await start();
    const id = await freshIdentity();
    gists.set('g-gone', null);
    const res = await postJson(baseUrl, '/accounts', {
      did: id.did,
      githubLogin: 'user-g',
      gist: 'https://gist.github.com/user-g/g-gone',
    });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('the gist does not resolve: check the URL, and that the gist is public');
    expect((await readBack(id.did)).status).toBe(404);
    expect(await accountRepo.findByGithubLogin('user-g')).toBeNull();
  });

  it('(h) GitHub unavailable is 503 and stores nothing', async () => {
    await start();
    const id = await freshIdentity();
    // An id the fake does not know rejects with a generic error, as an outage would.
    const res = await postJson(baseUrl, '/accounts', {
      did: id.did,
      githubLogin: 'user-h',
      gist: 'https://gist.github.com/user-h/g-unreachable',
    });
    expect(getPublicGist).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toBe('github unavailable');
    expect((await readBack(id.did)).status).toBe(404);
    expect(await accountRepo.findByGithubLogin('user-h')).toBeNull();
  });

  it('(i) the attack: a stranger cannot register a name they do not hold, so the person signing in with it gets their own account and their own record', async () => {
    await start('victim-login');
    const stranger = await freshIdentity();

    // The stranger has hired someone, and wants that history under the victim's name.
    const strangerJob = createJob(
      { id: 'stranger-job-1', buyerDid: stranger.did, agentDid: 'did:abt:some-agent', repository: 'x/y', brief: 'b' },
      new Date(),
    );
    await jobRepo.create({ ...strangerJob, status: 'confirmed', confirmedAt: new Date() });

    const attack = await postJson(baseUrl, '/accounts', { did: stranger.did, githubLogin: 'victim-login' });
    expect(attack.status).toBe(400);
    expect(await errorOf(attack)).toBe(NEEDS_PROOF);
    expect((await readBack(stranger.did)).status).toBe(404);

    // The victim signs in with GitHub. They land in an account of their own.
    const me = await fetch(`${baseUrl}/accounts/me`, { headers: await sessionAuth() });
    expect(me.status).toBe(200);
    const mine = (await me.json()) as { did: string; githubLogin: string };
    expect(mine.githubLogin).toBe('victim-login');
    expect(mine.did).not.toBe(stranger.did);
    expect(sessionLogin).toBe('victim-login');

    // Their public record carries none of the stranger's jobs.
    const conduct = await fetch(`${baseUrl}/buyers/victim-login/conduct`);
    expect(conduct.status).toBe(200);
    const record = (await conduct.json()) as { keyed: boolean; counts: { confirmed: number } };
    expect(record.keyed).toBe(true);
    expect(record.counts.confirmed).toBe(0);
  });

  it('(j) a login already bound to another account is 409 with the true sentence, and the existing row is unchanged', async () => {
    await start();
    const first = await freshIdentity();
    const second = await freshIdentity();
    const firstUrl = publishGist('g-j1', first, 'shared-login');
    expect((await postJson(baseUrl, '/accounts', { did: first.did, githubLogin: 'shared-login', gist: firstUrl })).status).toBe(201);
    const before = await (await readBack(first.did)).json();

    const secondUrl = publishGist('g-j2', second, 'shared-login');
    const res = await postJson(baseUrl, '/accounts', { did: second.did, githubLogin: 'shared-login', gist: secondUrl });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('the GitHub login shared-login is already bound to another account');
    expect((await readBack(second.did)).status).toBe(404);
    expect(await (await readBack(first.did)).json()).toEqual(before);
    expect((await accountRepo.findByGithubLogin('shared-login'))?.did).toBe(first.did);
  });

  it('(j) the taken check ignores case: the same GitHub account spelled differently is still taken', async () => {
    await start();
    const first = await freshIdentity();
    const second = await freshIdentity();
    const firstUrl = publishGist('g-j3', first, 'Case-Taken', 'case-taken');
    expect((await postJson(baseUrl, '/accounts', { did: first.did, githubLogin: 'Case-Taken', gist: firstUrl })).status).toBe(201);

    const secondUrl = publishGist('g-j4', second, 'CASE-TAKEN', 'case-taken');
    const res = await postJson(baseUrl, '/accounts', { did: second.did, githubLogin: 'CASE-TAKEN', gist: secondUrl });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('the GitHub login case-taken is already bound to another account');
    expect((await readBack(second.did)).status).toBe(404);
  });

  // A row written before this rule may hold the login under any spelling; the taken check looks up the
  // spelling GitHub gave, the one the caller typed, and lower case.
  it.each([
    ['the spelling the caller typed', 'Legacy-Typed', 'Legacy-Typed', 'legacy-typed'],
    ['lower case, when GitHub spells the login in mixed case', 'mixed-author', 'MIXED-AUTHOR', 'Mixed-Author'],
  ])('(j) a row written before this rule under %s still counts as taken', async (_name, held, typed, github) => {
    await start();
    const legacy = await freshIdentity();
    const newcomer = await freshIdentity();
    await accountRepo.register({ did: legacy.did, githubLogin: held });
    const url = publishGist('g-legacy', newcomer, typed, github);
    const res = await postJson(baseUrl, '/accounts', { did: newcomer.did, githubLogin: typed, gist: url });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe(`the GitHub login ${github} is already bound to another account`);
    expect((await readBack(newcomer.did)).status).toBe(404);
    expect((await accountRepo.findByGithubLogin(held))?.did).toBe(legacy.did);
  });

  it('(j) storage failing during the taken-login check is 503 and stores nothing', async () => {
    class LookupFails extends MemoryAccountRepository {
      override async findByGithubLogin(): Promise<never> {
        throw new Error('database unreachable');
      }
    }
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await start('session-user-unused', new LookupFails());
      const id = await freshIdentity();
      const url = publishGist('g-j7', id, 'storage-user');
      const res = await postJson(baseUrl, '/accounts', { did: id.did, githubLogin: 'storage-user', gist: url });
      expect(res.status).toBe(503);
      expect(await errorOf(res)).toBe('storage unavailable');
      expect((await readBack(id.did)).status).toBe(404);
    } finally {
      quiet.mockRestore();
    }
  });

  it('(j) the same proved body sent twice: the second answers that the DID is registered, not that the login is bound to another account', async () => {
    await start();
    const id = await freshIdentity();
    const url = publishGist('g-j8', id, 'same-user');
    const body = { did: id.did, githubLogin: 'same-user', gist: url };
    expect((await postJson(baseUrl, '/accounts', body)).status).toBe(201);
    const again = await postJson(baseUrl, '/accounts', body);
    expect(again.status).toBe(409);
    expect(await errorOf(again)).toBe(`operator ${id.did} is already registered`);
    expect((await accountRepo.findByGithubLogin('same-user'))?.did).toBe(id.did);
  });

  it('a DID that is already registered still says so, for a DID with no login', async () => {
    await start();
    const id = await freshIdentity();
    expect((await postJson(baseUrl, '/accounts', { did: id.did })).status).toBe(201);
    const again = await postJson(baseUrl, '/accounts', { did: id.did });
    expect(again.status).toBe(409);
    expect(await errorOf(again)).toBe(`operator ${id.did} is already registered`);
  });

  it('(k) invariant 2: a third party re-checks the proof from the published gist and the DID alone, with no call to this service', async () => {
    await start();
    const id = await freshIdentity();
    const url = publishGist('g-k', id, 'third-party-user');
    const res = await postJson(baseUrl, '/accounts', { did: id.did, githubLogin: 'third-party-user', gist: url });
    expect(res.status).toBe(201);

    // From here on, nothing calls the service: the gist as GitHub publishes
    // it, and node's own crypto.
    const published = gists.get('g-k');
    expect(published).toBeDefined();
    const statement = Object.values(published!.files)[0]!;
    const field = (name: string): string => {
      const line = statement.split('\n').find((l) => l.startsWith(`${name}:`));
      return line!.slice(name.length + 1).trim();
    };
    expect(field('did')).toBe(id.did);

    // The key on the key line must derive the DID (binding the key to the DID).
    const publicKey = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint: field('key') });
    const raw = (publicKey as unknown as { _publicKeyBuffer: Uint8Array })._publicKeyBuffer;
    expect(`did:abt:${fromPublicKey(raw)}`).toBe(field('did'));

    const nodeKey = nodeCrypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') },
      format: 'jwk',
    });
    const canonical = `freeagents-github-proof v1\n${field('did')}\nhttps://github.com/third-party-user\n`;
    const signature = Buffer.from(field('signature'), 'base64');
    expect(nodeCrypto.verify(null, Buffer.from(canonical, 'utf8'), nodeKey, signature)).toBe(true);

    // The same signature does not vouch for a different account.
    const forged = `freeagents-github-proof v1\n${field('did')}\nhttps://github.com/someone-else\n`;
    expect(nodeCrypto.verify(null, Buffer.from(forged, 'utf8'), nodeKey, signature)).toBe(false);
  });
});
