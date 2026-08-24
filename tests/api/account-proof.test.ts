// R-3, direction one: POST /agents/:agentDid/account-proof resolves the
// agent's DID document, checks the standard alsoKnownAs field against the
// claimed GitHub account, and records the binding as pending.
//
// The identity adapter is injected: the real one throws NotImplementedError
// from resolveDid until a resolver is wired, and the production 503 branch is
// exactly what that exercises. Everything else runs on the real logic, the
// same way the R-1/R-2 tests inject repositories.
import type { Express } from 'express';
import * as nodeCrypto from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { GistNotFoundError } from '../../src/adapters/github/types.js';
import type { Gist, GithubAdapter } from '../../src/adapters/github/types.js';
import { MemoryAgentRepository, MemoryOperatorRepository } from '../../src/adapters/storage/memory.js';
import type { AgentRepository } from '../../src/adapters/storage/types.js';
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import type { DidDocument, IdentityAdapter, SignedPayload } from '../../src/adapters/identity/types.js';
import { gistProofPayload } from '../../src/domain/account-proof.js';
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

// Real ed25519 keypairs, generated at run time so no key material is
// fabricated or memorized in the repository. The statement is signed with
// the private key and the fake verify checks it out against the public key
// with the same primitive the implementation calls, so the 200-verified path
// exercises a genuine signature round trip.
const agentKeyPair = nodeCrypto.generateKeyPairSync('ed25519');
const otherKeyPair = nodeCrypto.generateKeyPairSync('ed25519');

function signPayload(payload: string, privateKey: nodeCrypto.KeyObject): string {
  return nodeCrypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64');
}

function gistStatementContent(did: string, github: string, signature: string): string {
  return [
    'FreeAgents GitHub proof',
    'version: 1',
    `did: ${did}`,
    `github: ${github}`,
    `signature: ${signature}`,
  ].join('\n');
}

// The agent's key signs the canonical payload for this DID and account, as
// the operator's wallet tooling would. Deriving the bytes through the same
// primitive the implementation calls is the recommended test shape.
function signedStatementFor(did: string, accountUrl: string): string {
  return gistStatementContent(did, accountUrl, signPayload(gistProofPayload(did, accountUrl), agentKeyPair.privateKey));
}

// The only capabilities under test are resolveDid and verify; everything
// else is a stub that throws NotImplementedError, the same honest shape as
// the real adapter. verify does the real ed25519 check by default, and a
// test that needs a failing verifier passes its own implementation.
function fakeIdentity(
  documents: Map<string, DidDocument>,
  verifyImpl?: (signed: SignedPayload) => Promise<boolean> | boolean,
): IdentityAdapter {
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
    verify: (signed) =>
      Promise.resolve(
        verifyImpl !== undefined
          ? verifyImpl(signed)
          : nodeCrypto.verify(
              null,
              Buffer.from(signed.payload, 'utf8'),
              agentKeyPair.publicKey,
              Buffer.from(signed.signature, 'base64'),
            ),
      ),
    verifyDelegation: () => Promise.resolve(true),
  };
}

// The only capability under test is getPublicGist; everything else throws
// NotImplementedError, the same honest shape as the real adapter. A mapped
// null is a deleted gist (GistNotFoundError); an id not in the map rejects
// generically, so the route's github-unavailable branch is reachable.
function fakeGithub(gists: Map<string, Gist | null>): GithubAdapter {
  return {
    getPullRequest: () => Promise.reject(new NotImplementedError('github', 'getPullRequest')),
    getMergeCommitSignature: () => Promise.reject(new NotImplementedError('github', 'getMergeCommitSignature')),
    getPublicGist: (ref) => {
      const gist = gists.get(ref.id);
      if (gist === null) {
        return Promise.reject(new GistNotFoundError(ref.id));
      }
      if (gist === undefined) {
        return Promise.reject(new Error(`gist ${ref.id} not found`));
      }
      return Promise.resolve(gist);
    },
    forkAndOpenPullRequest: () => Promise.reject(new NotImplementedError('github', 'forkAndOpenPullRequest')),
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
  const gists = new Map<string, Gist | null>();

  beforeAll(async () => {
    const app = createApp(repo, agentRepo, fakeIdentity(documents), fakeGithub(gists));
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

  it('200: with a valid signed gist both directions hold and the binding is verified', async () => {
    const did = 'did:abt:zAgentProof2';
    await registerAgent(did);
    documents.set(did, standardDocument(did, ['https://github.com/scout-agent']));
    gists.set('abc123', {
      id: 'abc123',
      owner: 'scout-agent',
      files: { 'proof.txt': signedStatementFor(did, 'https://github.com/scout-agent') },
    });

    const res = await postJson(baseUrl, `/agents/${did}/account-proof`, {
      handle: 'scout-agent',
      gist: 'https://gist.github.com/scout-agent/abc123',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // ENT-5.1: verified is the whole point of direction two.
    expect(body.proofStatus).toBe('verified');
    expect(body.githubLogin).toBe('scout-agent');

    // Read-back: the verified binding survives the round trip.
    const read = await fetch(`${baseUrl}/agents/${did}`);
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as Record<string, unknown>;
    expect(readBody.proofStatus).toBe('verified');
  });

  it('200: a re-check whose gist no longer resolves drops a verified binding to unverified (R-5)', async () => {
    const did = 'did:abt:zAgentProof13';
    await registerAgent(did);
    documents.set(did, standardDocument(did, ['https://github.com/scout-agent']));
    gists.set('rsv321', {
      id: 'rsv321',
      owner: 'scout-agent',
      files: { 'proof.txt': signedStatementFor(did, 'https://github.com/scout-agent') },
    });

    const first = await postJson(baseUrl, `/agents/${did}/account-proof`, {
      handle: 'scout-agent',
      gist: 'https://gist.github.com/scout-agent/rsv321',
    });
    expect(first.status).toBe(200);
    let body = (await first.json()) as Record<string, unknown>;
    expect(body.proofStatus).toBe('verified');

    // The operator deleted the gist; the next check must not read that as an
    // outage but as the proof no longer standing.
    gists.set('rsv321', null);
    const res = await postJson(baseUrl, `/agents/${did}/account-proof`, {
      handle: 'scout-agent',
      gist: 'https://gist.github.com/scout-agent/rsv321',
    });
    expect(res.status).toBe(200);
    body = (await res.json()) as Record<string, unknown>;
    expect(body.proofStatus).toBe('unverified');
    // The handle is kept: the claim was made, it no longer holds.
    expect(body.githubLogin).toBe('scout-agent');

    // Read-back: the downgrade survives the round trip.
    const read = await fetch(`${baseUrl}/agents/${did}`);
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as Record<string, unknown>;
    expect(readBody.proofStatus).toBe('unverified');
    expect(readBody.githubLogin).toBe('scout-agent');
  });

  it('409: a dead-gist re-check of a pending binding records nothing (R-5)', async () => {
    const did = 'did:abt:zAgentProof14';
    await registerAgent(did);
    documents.set(did, standardDocument(did, ['https://github.com/scout-agent']));

    // Direction one alone: the binding is pending, never verified.
    const first = await postJson(baseUrl, `/agents/${did}/account-proof`, { handle: 'scout-agent' });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody.proofStatus).toBe('pending');

    // Now the same re-check arrives with a gist that no longer resolves.
    gists.set('tuv543', null);
    const res = await postJson(baseUrl, `/agents/${did}/account-proof`, {
      handle: 'scout-agent',
      gist: 'https://gist.github.com/scout-agent/tuv543',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    // A missing gist is operator-fixable: the message says recreate it.
    expect(String(body.error)).toContain('direction two (signed gist)');
    expect(String(body.error)).toContain('recreate');

    // Nothing changed: still pending, same handle.
    const stored = await agentRepo.findByDid(did);
    expect(stored?.githubLogin).toBe('scout-agent');
    expect(stored?.proofStatus).toBe('pending');
  });

  it('400: a gist that is not a parseable gist URL', async () => {
    const did = 'did:abt:zAgentProof1';
    for (const gist of [42, 'https://github.com/scout-agent/x', 'https://gist.github.com/only-owner', 'not a url']) {
      const res = await postJson(baseUrl, `/agents/${did}/account-proof`, { handle: 'scout-agent', gist });
      expect(res.status, JSON.stringify(gist)).toBe(400);
    }
  });

  it('409 direction one: the document does not point at the account, a valid gist present', async () => {
    const did = 'did:abt:zAgentProof3';
    await registerAgent(did);
    documents.set(did, standardDocument(did, null));
    gists.set('def456', {
      id: 'def456',
      owner: 'scout-agent',
      files: { 'proof.txt': signedStatementFor(did, 'https://github.com/scout-agent') },
    });

    const res = await postJson(baseUrl, `/agents/${did}/account-proof`, {
      handle: 'scout-agent',
      gist: 'https://gist.github.com/scout-agent/def456',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain('direction one (DID document)');
    expect(String(body.error)).toContain(did);

    // The failed check recorded nothing.
    const stored = await agentRepo.findByDid(did);
    expect(stored?.githubLogin).toBeNull();
    expect(stored?.proofStatus).toBe('unverified');
  });

  it('409 direction two: the gist URL owner does not match the claimed handle', async () => {
    const did = 'did:abt:zAgentProof4';
    await registerAgent(did);
    documents.set(did, standardDocument(did, ['https://github.com/scout-agent']));

    const res = await postJson(baseUrl, `/agents/${did}/account-proof`, {
      handle: 'scout-agent',
      gist: 'https://gist.github.com/someone-else/abc123',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain('direction two (signed gist)');
  });

  it('409 direction two: the gist author does not match the claimed handle', async () => {
    const did = 'did:abt:zAgentProof5';
    await registerAgent(did);
    documents.set(did, standardDocument(did, ['https://github.com/scout-agent']));
    gists.set('ghi789', {
      id: 'ghi789',
      owner: 'someone-else',
      files: { 'proof.txt': signedStatementFor(did, 'https://github.com/scout-agent') },
    });

    const res = await postJson(baseUrl, `/agents/${did}/account-proof`, {
      handle: 'scout-agent',
      gist: 'https://gist.github.com/scout-agent/ghi789',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain('direction two (signed gist)');
  });

  it('409 direction two: the gist holds no well-formed statement', async () => {
    const did = 'did:abt:zAgentProof6';
    await registerAgent(did);
    documents.set(did, standardDocument(did, ['https://github.com/scout-agent']));
    gists.set('jkl012', {
      id: 'jkl012',
      owner: 'scout-agent',
      files: { 'readme.md': 'some notes without any statement keys' },
    });

    const res = await postJson(baseUrl, `/agents/${did}/account-proof`, {
      handle: 'scout-agent',
      gist: 'https://gist.github.com/scout-agent/jkl012',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain('direction two (signed gist)');
  });

  it('409 direction two: the statement binds a different DID', async () => {
    const did = 'did:abt:zAgentProof7';
    await registerAgent(did);
    documents.set(did, standardDocument(did, ['https://github.com/scout-agent']));
    // The signature itself is genuine: it checks out against the payload it
    // was made for, but that payload names the other agent.
    gists.set('mno345', {
      id: 'mno345',
      owner: 'scout-agent',
      files: { 'proof.txt': signedStatementFor('did:abt:zSomeOtherAgent', 'https://github.com/scout-agent') },
    });

    const res = await postJson(baseUrl, `/agents/${did}/account-proof`, {
      handle: 'scout-agent',
      gist: 'https://gist.github.com/scout-agent/mno345',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain('direction two (signed gist)');
  });

  it('409 direction two: the statement binds a different account', async () => {
    const did = 'did:abt:zAgentProof8';
    await registerAgent(did);
    documents.set(did, standardDocument(did, ['https://github.com/scout-agent']));
    gists.set('pqr678', {
      id: 'pqr678',
      owner: 'scout-agent',
      files: { 'proof.txt': signedStatementFor(did, 'https://github.com/someone-else') },
    });

    const res = await postJson(baseUrl, `/agents/${did}/account-proof`, {
      handle: 'scout-agent',
      gist: 'https://gist.github.com/scout-agent/pqr678',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain('direction two (signed gist)');
  });

  it('409 direction two: the signature does not check out against the agent key', async () => {
    const did = 'did:abt:zAgentProof9';
    await registerAgent(did);
    documents.set(did, standardDocument(did, ['https://github.com/scout-agent']));
    // A genuine signature, but made by a different key: the statement is
    // well-formed and binds the right DID and account, only the signature
    // is not the agent's.
    const forged = gistStatementContent(
      did,
      'https://github.com/scout-agent',
      signPayload(gistProofPayload(did, 'https://github.com/scout-agent'), otherKeyPair.privateKey),
    );
    gists.set('stu901', {
      id: 'stu901',
      owner: 'scout-agent',
      files: { 'proof.txt': forged },
    });

    const res = await postJson(baseUrl, `/agents/${did}/account-proof`, {
      handle: 'scout-agent',
      gist: 'https://gist.github.com/scout-agent/stu901',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain('direction two (signed gist)');

    // Nothing was recorded by the rejected attempt.
    const stored = await agentRepo.findByDid(did);
    expect(stored?.githubLogin).toBeNull();
    expect(stored?.proofStatus).toBe('unverified');
  });

  it.each([
    ['characters outside base64', 'did:abt:zAgentProof11', 'vwx234x', '@@@@'],
    ['decodable base64 of the wrong length', 'did:abt:zAgentProof12', 'yza345', 'c2lnbmF0dXJl'],
  ])(
    '409 direction two: a signature of %s is malformed input, not an outage',
    async (_label, did, gistId, signature) => {
      await registerAgent(did);
      documents.set(did, standardDocument(did, ['https://github.com/scout-agent']));
      // The statement is well-formed except the signature field: garbage no
      // ed25519 library can decode. A real verify primitive throws on it,
      // which must read as a rejection (409), never as platform unavailability.
      gists.set(gistId, {
        id: gistId,
        owner: 'scout-agent',
        files: { 'proof.txt': gistStatementContent(did, 'https://github.com/scout-agent', signature) },
      });

      const res = await postJson(baseUrl, `/agents/${did}/account-proof`, {
        handle: 'scout-agent',
        gist: `https://gist.github.com/scout-agent/${gistId}`,
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      // The message names what the operator can fix; asserting it also kills
      // the branch: without the decode check this request falls through to
      // the verifier and lands on the generic wrong-key message instead.
      expect(String(body.error)).toContain('direction two (signed gist)');
      expect(String(body.error)).toContain('well-formed ed25519 signature');

      // The rejected attempt recorded nothing.
      const stored = await agentRepo.findByDid(did);
      expect(stored?.githubLogin).toBeNull();
      expect(stored?.proofStatus).toBe('unverified');
    },
  );

  it('503: github unavailable (fetching the gist fails)', async () => {
    const did = 'did:abt:zAgentProof10';
    await registerAgent(did);
    documents.set(did, standardDocument(did, ['https://github.com/scout-agent']));
    // The id is not in the fake's map, so getPublicGist rejects.

    const res = await postJson(baseUrl, `/agents/${did}/account-proof`, {
      handle: 'scout-agent',
      gist: 'https://gist.github.com/scout-agent/does-not-exist',
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('github unavailable');
  });
});

// The identity verification branch that is unreachable with the default
// fake: a verifier that throws is platform unavailability, not an operator
// error, so it is a 503 and records nothing.
describe('POST /agents/:agentDid/account-proof, identity verification failure', () => {
  const documents = new Map<string, DidDocument>();
  const gists = new Map<string, Gist | null>();
  const base = new MemoryAgentRepository();
  const app = createApp(
    new MemoryOperatorRepository(),
    base,
    fakeIdentity(documents, () => {
      throw new Error('verify down');
    }),
    fakeGithub(gists),
  );

  it('503: the verifier throws', async () => {
    const did = 'did:abt:zAgentVerifyDown';
    await base.create({
      did,
      operatorDid: 'did:abt:zOperatorKeyHash',
      delegation,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    documents.set(did, standardDocument(did, ['https://github.com/scout-agent']));
    gists.set('vwx234', {
      id: 'vwx234',
      owner: 'scout-agent',
      files: { 'proof.txt': signedStatementFor(did, 'https://github.com/scout-agent') },
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected server to listen on a port');
      }
      const res = await postJson(`http://127.0.0.1:${address.port}`, `/agents/${did}/account-proof`, {
        handle: 'scout-agent',
        gist: 'https://gist.github.com/scout-agent/vwx234',
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('identity verification unavailable');
    } finally {
      errSpy.mockRestore();
      server.close();
    }
  });
});

// The storage branches of the route, which the real repository never
// exercises: a failing lookup, a failing update, and an update that reports
// the agent as not stored even though the lookup succeeded, on both the
// normal and the R-5 downgrade write. Each gets its own app with a wrapped
// repository, the same way the R-1/R-2 tests inject them.
describe('POST /agents/:agentDid/account-proof, storage branches', () => {
  const documents = new Map<string, DidDocument>();
  const gists = new Map<string, Gist | null>();
  const base = new MemoryAgentRepository();

  function makeApp(overrides: {
    findByDid?: (did: string) => Promise<Agent | null>;
    updateGithubBinding?: (
      did: string,
      input: { readonly handle: string; readonly status: ProofStatus },
    ) => Promise<Agent | null>;
  } = {}): Express {
    const repo: AgentRepository = {
      create: (input) => base.create(input),
      findByDid: overrides.findByDid ?? ((did) => base.findByDid(did)),
      updateGithubBinding:
        overrides.updateGithubBinding ?? ((did, input) => base.updateGithubBinding(did, input)),
      recordKeyRotation: (did, input) => base.recordKeyRotation(did, input),
    };
    return createApp(new MemoryOperatorRepository(), repo, fakeIdentity(documents), fakeGithub(gists));
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

  // R-5: the downgrade write has its own storage branches. A dead gist is a
  // fact, so a failing downgrade write must read as storage unavailability,
  // not as a github outage, and a write that reports the agent as not stored
  // is a 404 like the normal path.

  it('503: the downgrade write throws on a dead-gist re-check (R-5)', async () => {
    const did = 'did:abt:zAgentDowngradeFail';
    await registerAgent(did);
    documents.set(did, standardDocument(did, ['https://github.com/scout-agent']));
    gists.set('xyz789', {
      id: 'xyz789',
      owner: 'scout-agent',
      files: { 'proof.txt': signedStatementFor(did, 'https://github.com/scout-agent') },
    });

    // First check verifies the binding, through the same wrapped repository.
    const app = makeApp();
    await withApp(app, async (url) => {
      const res = await postJson(url, `/agents/${did}/account-proof`, {
        handle: 'scout-agent',
        gist: 'https://gist.github.com/scout-agent/xyz789',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.proofStatus).toBe('verified');
    });

    // The gist is deleted and the downgrade write itself fails.
    gists.set('xyz789', null);
    const failingApp = makeApp({
      updateGithubBinding: () => Promise.reject(new Error('storage down')),
    });
    await withApp(failingApp, async (url) => {
      const res = await postJson(url, `/agents/${did}/account-proof`, {
        handle: 'scout-agent',
        gist: 'https://gist.github.com/scout-agent/xyz789',
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('storage unavailable');
    });
  });

  it('404: the downgrade write reports the agent as not stored (R-5)', async () => {
    const did = 'did:abt:zAgentDowngradeNull';
    await registerAgent(did);
    documents.set(did, standardDocument(did, ['https://github.com/scout-agent']));
    gists.set('uvw321', {
      id: 'uvw321',
      owner: 'scout-agent',
      files: { 'proof.txt': signedStatementFor(did, 'https://github.com/scout-agent') },
    });

    const app = makeApp();
    await withApp(app, async (url) => {
      const res = await postJson(url, `/agents/${did}/account-proof`, {
        handle: 'scout-agent',
        gist: 'https://gist.github.com/scout-agent/uvw321',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.proofStatus).toBe('verified');
    });

    gists.set('uvw321', null);
    const nullApp = makeApp({
      updateGithubBinding: () => Promise.resolve(null),
    });
    await withApp(nullApp, async (url) => {
      const res = await postJson(url, `/agents/${did}/account-proof`, {
        handle: 'scout-agent',
        gist: 'https://gist.github.com/scout-agent/uvw321',
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe(`agent ${did} is not registered`);
    });
  });
});
