// R-3, direction one: POST /agents/:agentDid/account-proof resolves the
// agent's DID document, checks the standard alsoKnownAs field against the
// claimed GitHub account, and records the binding as pending.
//
// The identity adapter is injected: the real one throws NotImplementedError
// from resolveDid until a resolver is wired, and the production 503 branch is
// exactly what that exercises. Everything else runs on the real logic, the
// same way the R-1/R-2 tests inject repositories.
import type { Express } from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryOperatorRepository } from '../../src/adapters/storage/memory.js';
import type { AgentRepository } from '../../src/adapters/storage/types.js';
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import type { DidDocument, IdentityAdapter } from '../../src/adapters/identity/types.js';
import type { Agent, Delegation, ProofStatus } from '../../src/domain/agent.js';

// The stored delegation only needs its shape here: create() does not
// re-verify, and the proof under test in this file is the DID document.
const delegation: Delegation = {
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  id: 'urn:uuid:account-proof-test',
  type: ['VerifiableCredential', 'AgentDelegation'],
  issuer: 'did:abt:zOperatorKeyHash',
  issuanceDate: '2026-08-20T05:00:00.000Z',
  credentialSubject: { id: 'did:abt:zAgentKeyHash' },
  proof: {
    type: 'Ed25519Signature2020',
    created: '2026-08-20T05:00:00.000Z',
    verificationMethod: 'did:abt:zOperatorKeyHash#zOperatorKeyHash',
    proofPurpose: 'assertionMethod',
    proofValue: 'zMockProofValue',
  },
};

function standardDocument(id: string, alsoKnownAs: readonly string[] | null): DidDocument {
  return {
    id,
    controller: null,
    verificationMethod: [`${id}#key-1`],
    alsoKnownAs,
  };
}

// The only capability under test is resolveDid; everything else is a stub
// that throws NotImplementedError, the same honest shape as the real adapter.
function fakeIdentity(documents: Map<string, DidDocument>): IdentityAdapter {
  return {
    createOperatorDid: () => Promise.reject(new NotImplementedError('identity', 'createOperatorDid')),
    createAgentDid: () => Promise.reject(new NotImplementedError('identity', 'createAgentDid')),
    resolveDid: (did: string) => {
      const doc = documents.get(did);
      if (doc === undefined) {
        return Promise.reject(new NotImplementedError('identity', 'resolveDid'));
      }
      return Promise.resolve(doc);
    },
    sign: () => Promise.reject(new NotImplementedError('identity', 'sign')),
    verify: () => Promise.resolve(false),
    verifyDelegation: () => Promise.resolve(true),
  };
}

async function postJson(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /agents/:agentDid/account-proof (R-3, direction one)', () => {
  let server: Server;
  let baseUrl: string;
  const repo = new MemoryOperatorRepository();
  const agentRepo = new MemoryAgentRepository();

  const documents = new Map<string, DidDocument>();

  beforeAll(async () => {
    const app = createApp(repo, agentRepo, fakeIdentity(documents));
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    server.close();
  });

  async function registerAgent(did: string): Promise<void> {
    const created = await agentRepo.create({
      did,
      operatorDid: 'did:abt:zOperatorKeyHash',
      delegation,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    expect(created.proofStatus).toBe('unverified');
  }

  it('200: the document points at the account; the binding is recorded as pending', async () => {
    const did = 'did:abt:zAgentProof1';
    await registerAgent(did);
    // The operator's wallet tooling wrote the entry with a trailing slash
    // and mixed case: both name the same account and must be tolerated.
    documents.set(did, standardDocument(did, ['https://github.com/Scout-Agent/']));

    const res = await postJson(baseUrl, `/agents/${did}/account-proof`, { handle: 'scout-agent' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.did).toBe(did);
    expect(body.githubLogin).toBe('scout-agent');
    // ENT-5.1: direction one alone is pending, never verified.
    expect(body.proofStatus).toBe('pending');

    // Read-back is the existing projection, so the binding survives the round trip.
    const read = await fetch(`${baseUrl}/agents/${did}`);
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as Record<string, unknown>;
    expect(readBody.githubLogin).toBe('scout-agent');
    expect(readBody.proofStatus).toBe('pending');
  });

  it('400: malformed handles', async () => {
    const did = 'did:abt:zAgentProof1';
    for (const body of [{}, { handle: '' }, { handle: 'a b' }, { handle: 42 }, { handle: null }]) {
      const res = await postJson(baseUrl, `/agents/${did}/account-proof`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    // Nothing was recorded by the rejected attempts.
    const stored = await agentRepo.findByDid(did);
    expect(stored?.githubLogin).toBe('scout-agent');
    expect(stored?.proofStatus).toBe('pending');
  });

  it('404: an unknown agent', async () => {
    const res = await postJson(baseUrl, '/agents/did:abt:zNobody/account-proof', {
      handle: 'scout-agent',
    });
    expect(res.status).toBe(404);
  });

  it('409: a document without any alsoKnownAs entry', async () => {
    const did = 'did:abt:zAgentNoEntry';
    await registerAgent(did);
    documents.set(did, standardDocument(did, null));

    const res = await postJson(baseUrl, `/agents/${did}/account-proof`, { handle: 'scout-agent' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    // The message names the DID and the exact URL to author.
    expect(String(body.error)).toContain(did);
    expect(String(body.error)).toContain('https://github.com/scout-agent');
  });

  it('409: a document pointing at a different account', async () => {
    const did = 'did:abt:zAgentWrongAccount';
    await registerAgent(did);
    documents.set(did, standardDocument(did, ['https://github.com/someone-else']));

    const res = await postJson(baseUrl, `/agents/${did}/account-proof`, { handle: 'scout-agent' });
    expect(res.status).toBe(409);

    // The failed check recorded nothing.
    const stored = await agentRepo.findByDid(did);
    expect(stored?.githubLogin).toBeNull();
    expect(stored?.proofStatus).toBe('unverified');
  });

  it('503: resolution unavailable (the real adapter throws NotImplementedError until a resolver is wired)', async () => {
    const did = 'did:abt:zAgentUnresolved';
    await registerAgent(did);
    // No document registered: the fake throws NotImplementedError, the same
    // shape the production adapter has today.

    const res = await postJson(baseUrl, `/agents/${did}/account-proof`, { handle: 'scout-agent' });
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('identity resolution unavailable');
  });
});

// The three storage branches of the route, which the real repository never
// exercises: a failing lookup, a failing update, and an update that reports
// the agent as not stored even though the lookup succeeded. Each gets its own
// app with a wrapped repository, the same way the R-1/R-2 tests inject them.
describe('POST /agents/:agentDid/account-proof, storage branches', () => {
  const documents = new Map<string, DidDocument>();
  const base = new MemoryAgentRepository();

  function makeApp(overrides: {
    findByDid?: (did: string) => Promise<Agent | null>;
    updateGithubBinding?: (
      did: string,
      input: { readonly handle: string; readonly status: ProofStatus },
    ) => Promise<Agent | null>;
  }): Express {
    const repo: AgentRepository = {
      create: (input) => base.create(input),
      findByDid: overrides.findByDid ?? ((did) => base.findByDid(did)),
      updateGithubBinding:
        overrides.updateGithubBinding ?? ((did, input) => base.updateGithubBinding(did, input)),
    };
    return createApp(new MemoryOperatorRepository(), repo, fakeIdentity(documents));
  }

  // A storage failure is a logged operator concern, not output the test
  // needs; silence it so the branch under test is the response, not the log.
  async function withApp(app: Express, run: (url: string) => Promise<void>): Promise<void> {
    const server = app.listen(0);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected server to listen on a port');
      }
      await run(`http://127.0.0.1:${address.port}`);
    } finally {
      errSpy.mockRestore();
      server.close();
    }
  }

  async function registerAgent(did: string): Promise<void> {
    await base.create({
      did,
      operatorDid: 'did:abt:zOperatorKeyHash',
      delegation,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
  }

  it('503: the agent lookup throws', async () => {
    const did = 'did:abt:zAgentLookupFail';
    const app = makeApp({
      findByDid: () => Promise.reject(new Error('storage down')),
    });
    await withApp(app, async (url) => {
      const res = await postJson(url, `/agents/${did}/account-proof`, { handle: 'scout-agent' });
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('storage unavailable');
    });
  });

  it('404: the update reports the agent as not stored, after the lookup succeeded', async () => {
    const did = 'did:abt:zAgentUpdateNull';
    await registerAgent(did);
    documents.set(did, standardDocument(did, ['https://github.com/scout-agent']));
    const app = makeApp({
      updateGithubBinding: () => Promise.resolve(null),
    });
    await withApp(app, async (url) => {
      const res = await postJson(url, `/agents/${did}/account-proof`, { handle: 'scout-agent' });
      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe(`agent ${did} is not registered`);
    });
  });

  it('503: the binding update throws', async () => {
    const did = 'did:abt:zAgentUpdateFail';
    await registerAgent(did);
    documents.set(did, standardDocument(did, ['https://github.com/scout-agent']));
    const app = makeApp({
      updateGithubBinding: () => Promise.reject(new Error('storage down')),
    });
    await withApp(app, async (url) => {
      const res = await postJson(url, `/agents/${did}/account-proof`, { handle: 'scout-agent' });
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('storage unavailable');
    });
  });
});
