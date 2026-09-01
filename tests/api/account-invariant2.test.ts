// Invariant 2 (MISSION.md): a third party can verify what this service stores
// without calling it. R-1 registers facts, issues no verified claim (the
// verifiable artifact lands with R-3). The strongest honest evidence this PR
// can offer: everything stored and returned is a fact the operator itself
// supplied, a third party holding one copy can check every field against the
// other, and no key material is present in either. The holdout repeats these
// checks from outside the build loop.
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { mintSessionToken, testSessionAdapter } from '../helpers/session-fixtures.js';

// The exact field set the service is allowed to keep, from the Operator domain
// record: no field beyond this set, so one copy verifies against the other.
const ALLOWED_FIELDS = new Set(['did', 'githubLogin', 'passkeySubject', 'createdAt']);

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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sessionAdapter,
    ).listen(0);
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
  it('read-back is field-for-field equal to the stored row', async () => {
    // Register, then read back over HTTP, then read the repository
    // directly. A third party holding only the read-back response can
    // verify every stored fact against it, because the two agree on every
    // field and the stored row has no fields beyond the response.
    const did = 'did:abt:op-inv2';
    const login = 'operator-inv2';
    const created = await fetch(`${baseUrl}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader },
      body: JSON.stringify({ did, githubLogin: login }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as Record<string, unknown>;

    const readBack = await fetch(`${baseUrl}/accounts/${did}`);
    expect(readBack.status).toBe(200);
    const readBackBody = (await readBack.json()) as Record<string, unknown>;

    const stored = await repo.findByDid(did);
    expect(stored).not.toBeNull();
    expect(readBackBody).toEqual({
      did: stored?.did,
      githubLogin: stored?.githubLogin,
      passkeySubject: stored?.passkeySubject ?? null,
      createdAt: stored?.createdAt.toISOString(),
    });
    expect(createdBody).toEqual(readBackBody);
  });

  it('stores exactly { did, githubLogin, createdAt } and no key material', async () => {
    const did = 'did:abt:op-fields';
    await fetch(`${baseUrl}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader },
      body: JSON.stringify({ did, githubLogin: 'operator-fields' }),
    });
    const stored = await repo.findByDid(did);
    expect(stored).not.toBeNull();
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
    const did = 'did:abt:op-keydrop';
    const res = await fetch(`${baseUrl}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader },
      body: JSON.stringify({
        did,
        githubLogin: 'operator-keydrop',
        publicKeyMultibase: 'z6MkPublicKeyThatMustNotBeStored',
        privateKey: 'must-not-even-echo',
        keyPair: { publicKey: 'z6MkAnother', secret: 'no' },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([...ALLOWED_FIELDS].sort());
    expect(findKeyMaterialFields(body)).toEqual([]);

    const stored = await repo.findByDid(did);
    expect(Object.keys(stored as object).sort()).toEqual(
      [...ALLOWED_FIELDS].sort()
    );
    expect(findKeyMaterialFields(stored)).toEqual([]);
  });
});
