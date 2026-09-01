// D1 fix (Proof round 1, task t_8a82c865): identity.resolveDid's real,
// local-only implementation cannot derive alsoKnownAs. It is authored by
// the operator's own wallet tooling, off-platform data no local derivation
// can produce (see identity.ts's resolveDid comment). Before this fix, the
// real adapter answered alsoKnownAs: null unconditionally, which the
// account-proof route read as "checked, and there is no claim" -- a 409
// naming an exact fix ("add ... to its alsoKnownAs field") the operator can
// never make this adapter see, on every single request. That is worse than
// the 503 it replaced: a 503 says the platform cannot do this yet, a 409
// says the operator is wrong when they are not. This test proves the real
// adapter now signals "cannot determine this field" distinctly from
// "checked, and it is empty", and the route maps that to an honest 503,
// never the unsatisfiable conflict.
import type { Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import { createKnownKeyStore } from '../../src/adapters/identity/did-abt-resolver.js';
import { MemoryAgentRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed } from '../helpers/sign-request.js';

async function post(base: string, path: string, body: unknown = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /agents/:agentDid/account-proof, the real identity adapter, direction one', () => {
  let server: Server;

  afterAll(() => {
    server?.close();
  });

  it('answers 503, not an unsatisfiable 409, when the key is observed but alsoKnownAs cannot be derived locally', async () => {
    const agentIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(111));
    const knownKeys = createKnownKeyStore();
    // The binding this DID document rests on: the same check the R-34
    // signing-key resolver performs before recording an entry (mirrors
    // tests/adapters/identity/identity.test.ts's own setup).
    knownKeys.record(agentIdentity.did, agentIdentity.keyid);

    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agentIdentity.did,
      operatorDid: 'did:abt:op-account-proof-real-identity',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });

    const app = createApp(new MemoryAccountRepository(), agentRepo, createIdentityAdapter(knownKeys));
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const res = await post(baseUrl, `/agents/${agentIdentity.did}/account-proof`, { handle: 'scout-agent' });
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('identity resolution unavailable');
    // Never the impossible remedy: the operator cannot make this adapter
    // read a field it has no path to derive.
    expect(String(body.error)).not.toContain('alsoKnownAs');

    // Nothing was recorded by the refused attempt.
    const stored = await agentRepo.findByDid(agentIdentity.did);
    expect(stored?.proofStatus).toBe('unverified');
  });
});
