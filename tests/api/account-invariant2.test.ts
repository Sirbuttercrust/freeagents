// Invariant 2 (MISSION.md): a third party can verify what this service stores
// without calling it. R-1 registers facts, issues no verified claim (the
// verifiable artifact lands with R-3). The strongest honest evidence this PR
// can offer: everything stored and returned is a fact the operator itself
// supplied, a third party holding one copy can check every field against the
// other, and no key material is present in either. The holdout repeats these
// checks from outside the build loop.
import type { Server } from 'node:http';
import * as nodeCrypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import type { Gist, GithubAdapter } from '../../src/adapters/github/types.js';
import { MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { mintSessionToken, testSessionAdapter } from '../helpers/session-fixtures.js';
import { signingIdentityFromSeed } from '../helpers/sign-request.js';

// FIX-B62a: a GitHub login is stored only with a signed gist, so the
// registrations below that need a login on the row publish one in this
// fake GitHub and send its URL. Only getPublicGist is ever called.
const gists = new Map<string, Gist>();
const fakeGithub = {
  getPublicGist: (ref: { id: string }) => {
    const gist = gists.get(ref.id);
    return gist === undefined ? Promise.reject(new Error(`gist ${ref.id} unreachable`)) : Promise.resolve(gist);
  },
} as unknown as GithubAdapter;

// A real did:abt identity signs the canonical proof bytes for (did, login)
// and the statement carries its key line, as a wallet tool would publish it.
async function provedRegistration(seedByte: number, login: string): Promise<{ did: string; githubLogin: string; gist: string }> {
  const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(seedByte));
  const bytes = `freeagents-github-proof v1\n${identity.did}\nhttps://github.com/${login}\n`;
  const signature = nodeCrypto.sign(null, Buffer.from(bytes, 'utf8'), identity.privateKey).toString('base64');
  const id = `gist-${login}`;
  gists.set(id, {
    id,
    owner: login,
    files: {
      'proof.txt': [
        'version: 1',
        `did: ${identity.did}`,
        `github: https://github.com/${login}`,
        `signature: ${signature}`,
        `key: ${identity.keyid.slice(identity.keyid.indexOf('#') + 1)}`,
      ].join('\n'),
    },
  });
  return { did: identity.did, githubLogin: login, gist: `https://gist.github.com/${login}/${id}` };
}

// The exact field set the service is allowed to keep, from the Operator domain
// record: no stored field beyond this set. The public read shows all of it
// except passkeySubject (see PUBLIC_FIELDS below).
const ALLOWED_FIELDS = new Set(['did', 'githubLogin', 'passkeySubject', 'createdAt', 'operatorAddressEvm', 'operatorAddressAbt']);

// B61c: the passkey's name is private to the account, so the public answer
// is the stored set without passkeySubject.
const PUBLIC_FIELDS = [...ALLOWED_FIELDS].filter((field) => field !== 'passkeySubject');

// Names that would mean key material leaked into storage or the wire.
// Matched by substring, so publicKeyMultibase / privateKeyMultibase and the
// like are all caught by their stems.
const KEY_MATERIAL_STEMS = ['publicKey', 'privateKey', 'secret', 'keyPair', 'mnemonic'];
function findKeyMaterialFields(obj: unknown, path = ''): string[] {
  const hits: string[] = [];
  if (obj === null || typeof obj !== 'object') return hits;
  for (const [key, value] of Object.entries(obj)) {
    const here = path === '' ? key : `${path}.${key}`;
    if (KEY_MATERIAL_STEMS.some((stem) => key.toLowerCase().includes(stem.toLowerCase()))) {
      hits.push(here);
    }
    if (value !== null && typeof value === 'object') {
      hits.push(...findKeyMaterialFields(value, here));
    }
  }
  return hits;
}

describe('operator registration, invariant 2', () => {
  let server: Server;
  let baseUrl: string;
  const repo = new MemoryAccountRepository();
  let authHeader: Record<string, string>;
  beforeAll(async () => {
    const sessionAdapter = testSessionAdapter();
    server = createApp(
      repo,
      undefined,
      undefined,
      fakeGithub,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sessionAdapter,
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    const token = await mintSessionToken(sessionAdapter);
    authHeader = { authorization: `Bearer ${token}` };
  });

  afterAll(() => {
    server.close();
  });
  it('read-back is field-for-field equal to the stored row on every public field', async () => {
    // Register, then read back over HTTP, then read the repository
    // directly. A third party holding only the read-back response can
    // verify every stored public fact against it, because the two agree on
    // every public field. passkeySubject is the one stored field the
    // read-back leaves out (B61c).
    const proved = await provedRegistration(61, 'operator-inv2');
    const did = proved.did;
    const created = await fetch(`${baseUrl}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader },
      body: JSON.stringify(proved),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as Record<string, unknown>;

    const readBack = await fetch(`${baseUrl}/accounts/${did}`);
    expect(readBack.status).toBe(200);
    const readBackBody = (await readBack.json()) as Record<string, unknown>;

    const stored = await repo.findByDid(did);
    expect(stored).not.toBeNull();
    // B61c: the passkey's name is private to the account, so the public read-back omits it.
    expect(readBackBody).toEqual({
      did: stored?.did,
      githubLogin: stored?.githubLogin,
      createdAt: stored?.createdAt.toISOString(),
      operatorAddressEvm: stored?.operatorAddressEvm ?? null,
      operatorAddressAbt: stored?.operatorAddressAbt ?? null,
    });
    expect(createdBody).toEqual(readBackBody);
  });

  it('stores exactly the six allowed fields and no key material', async () => {
    const proved = await provedRegistration(62, 'operator-fields');
    const did = proved.did;
    await fetch(`${baseUrl}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader },
      body: JSON.stringify(proved),
    });
    const stored = await repo.findByDid(did);
    expect(stored).not.toBeNull();
    expect(stored?.githubLogin).toBe('operator-fields');
    // Exact field set, not a subset.
    expect(Object.keys(stored as object).sort()).toEqual(
      [...ALLOWED_FIELDS].sort()
    );
    expect(findKeyMaterialFields(stored)).toEqual([]);
  });

  it('key material sent in the request is dropped, kept only by did and login', async () => {
    // The operator sends a DID it already has. If it also sends its key,
    // we do not store it: we never hold the key (ENT-1.1), and a field
    // that arrives here would end up in the wire response by construction.
    const proved = await provedRegistration(63, 'operator-keydrop');
    const did = proved.did;
    const res = await fetch(`${baseUrl}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader },
      body: JSON.stringify({
        ...proved,
        publicKeyMultibase: 'z6MkPublicKeyThatMustNotBeStored',
        privateKey: 'must-not-even-echo',
        keyPair: { publicKey: 'z6MkAnother', secret: 'no' },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    // B61c: the passkey's name is private to the account, so it is not in the answer.
    expect(Object.keys(body).sort()).toEqual([...PUBLIC_FIELDS].sort());
    expect(findKeyMaterialFields(body)).toEqual([]);

    const stored = await repo.findByDid(did);
    expect(Object.keys(stored as object).sort()).toEqual(
      [...ALLOWED_FIELDS].sort()
    );
    expect(findKeyMaterialFields(stored)).toEqual([]);
  });
});
