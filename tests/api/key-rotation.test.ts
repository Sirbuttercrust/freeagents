// R-30 (ENT-8.4): POST /agents/:agentDid/key-rotation supersedes an
// agent's key. The route is storage-only, so it runs on the real identity
// and github adapters (never called) and the real logic; the storage
// branches the real repository never exercises (a failing lookup, a
// failing write, and a write that reports the agent as not stored after
// the lookup succeeded) are exercised with wrapped repositories, the same
// way tests/api/app.test.ts and account-proof.test.ts do it.
import type { Express } from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryOperatorRepository } from '../../src/adapters/storage/memory.js';
import type { AgentRepository, KeyRotationInput } from '../../src/adapters/storage/types.js';
import type { Agent, Delegation } from '../../src/domain/agent.js';

const AGENT_DID = 'did:abt:zAgentKeyHash';

// The stored delegation only needs its shape: create() does not re-verify
// (same fixture stance as tests/api/account-proof.test.ts).
const delegation: Delegation = {
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  id: 'urn:uuid:key-rotation-test',
  type: ['VerifiableCredential', 'AgentDelegation'],
  issuer: 'did:abt:zOperatorKeyHash',
  issuanceDate: '2026-08-21T05:00:00.000Z',
  credentialSubject: { id: AGENT_DID },
  proof: {
    type: 'Ed25519Signature2020',
    created: '2026-08-21T05:00:00.000Z',
    verificationMethod: 'did:abt:zOperatorKeyHash#zOperatorKeyHash',
    proofPurpose: 'assertionMethod',
    proofValue: 'zMockProofValue',
  },
};

async function postJson(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// The projection shape of a stored keyRotations array, so a read-back
// assertion can compare against the driver's own stamp rather than a
// fabricated timestamp.
type KeyRotationProjection = { fromKey: string; toKey: string; rotatedAt: string };

describe('POST /agents/:agentDid/key-rotation (R-30, ENT-8.4)', () => {
  let server: Server;
  let baseUrl: string;
  const agentRepo = new MemoryAgentRepository();

  beforeAll(async () => {
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:zOperatorKeyHash',
      delegation,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const app = createApp(new MemoryOperatorRepository(), agentRepo);
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

  it('200: a real rotation is recorded and shows in the read-back with dates', async () => {
    const fromKey = `${AGENT_DID}#zOld`;
    const toKey = `${AGENT_DID}#zNew`;
    const res = await postJson(baseUrl, `/agents/${AGENT_DID}/key-rotation`, { fromKey, toKey });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // The rotation rides the response and every other projection key is
    // still present (spot-check the base key).
    expect(body.did).toBe(AGENT_DID);
    const rotations = body.keyRotations as KeyRotationProjection[];
    expect(rotations).toHaveLength(1);
    const first = rotations[0] as KeyRotationProjection;
    expect(first.fromKey).toBe(fromKey);
    expect(first.toKey).toBe(toKey);
    expect(Number.isNaN(Date.parse(first.rotatedAt))).toBe(false);

    // R-6: the profile shows the rotation with dates on the read-back.
    const read = await fetch(`${baseUrl}/agents/${AGENT_DID}`);
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as Record<string, unknown>;
    const readRotations = readBody.keyRotations as KeyRotationProjection[];
    expect(readRotations).toHaveLength(1);
    const readFirst = readRotations[0] as KeyRotationProjection;
    expect(readFirst.fromKey).toBe(fromKey);
    expect(readFirst.rotatedAt).toBe(first.rotatedAt);
  });

  it('200: a second rotation appends in order, it never replaces', async () => {
    const res = await postJson(baseUrl, `/agents/${AGENT_DID}/key-rotation`, {
      fromKey: `${AGENT_DID}#zNew`,
      toKey: `${AGENT_DID}#zNewer`,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const rotations = body.keyRotations as KeyRotationProjection[];
    expect(rotations).toHaveLength(2);
    const [first, second] = rotations as [KeyRotationProjection, KeyRotationProjection];
    expect(first.toKey).toBe(`${AGENT_DID}#zNew`);
    expect(second.fromKey).toBe(`${AGENT_DID}#zNew`);
    expect(second.toKey).toBe(`${AGENT_DID}#zNewer`);
  });

  it.each([
    ['an empty body', {}],
    ['a numeric fromKey', { fromKey: 42 }],
    ['a null fromKey', { fromKey: null }],
    ['an empty fromKey', { fromKey: '' }],
    ['a fromKey without a fragment', { fromKey: AGENT_DID }],
    ['a numeric toKey', { fromKey: `${AGENT_DID}#zA`, toKey: 42 }],
    ['an empty toKey', { fromKey: `${AGENT_DID}#zA`, toKey: '' }],
    ['a toKey without a fragment', { fromKey: `${AGENT_DID}#zA`, toKey: AGENT_DID }],
  ])('400: a malformed body (%s) records nothing', async (_label, body) => {
    const before = (await agentRepo.findByDid(AGENT_DID))?.keyRotations.length ?? 0;
    const res = await postJson(baseUrl, `/agents/${AGENT_DID}/key-rotation`, body);
    expect(res.status).toBe(400);
    const after = (await agentRepo.findByDid(AGENT_DID))?.keyRotations.length ?? 0;
    expect(after).toBe(before);
  });

  it('400: an identity rotation (fromKey === toKey) records nothing', async () => {
    const before = (await agentRepo.findByDid(AGENT_DID))?.keyRotations.length ?? 0;
    const key = `${AGENT_DID}#zSame`;
    const res = await postJson(baseUrl, `/agents/${AGENT_DID}/key-rotation`, {
      fromKey: key,
      toKey: key,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain('same key');
    const after = (await agentRepo.findByDid(AGENT_DID))?.keyRotations.length ?? 0;
    expect(after).toBe(before);
  });

  it('404: a well-formed body for an unknown agent', async () => {
    const res = await postJson(baseUrl, '/agents/did:abt:nobody/key-rotation', {
      fromKey: 'did:abt:nobody#zA',
      toKey: 'did:abt:nobody#zB',
    });
    expect(res.status).toBe(404);
  });
});

// The three storage branches of the route, which the real repository never
// exercises: a failing lookup, a failing write, and a write that reports the
// agent as not stored even though the lookup succeeded. Each gets its own app
// with a wrapped repository, the same way the R-1/R-2 tests inject them.
describe('POST /agents/:agentDid/key-rotation, storage branches', () => {
  function makeApp(overrides: {
    findByDid?: (did: string) => Promise<Agent | null>;
    recordKeyRotation?: (did: string, input: KeyRotationInput) => Promise<Agent | null>;
  }): Express {
    const base = new MemoryAgentRepository();
    const repo: AgentRepository = {
      create: (input) => base.create(input),
      findByDid: overrides.findByDid ?? ((did) => base.findByDid(did)),
      updateGithubBinding: (did, input) => base.updateGithubBinding(did, input),
      recordKeyRotation:
        overrides.recordKeyRotation ?? ((did, input) => base.recordKeyRotation(did, input)),
    };
    return createApp(new MemoryOperatorRepository(), repo);
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

  it('503: the agent lookup throws', async () => {
    const app = makeApp({
      findByDid: () => Promise.reject(new Error('db down')),
    });
    await withApp(app, async (url) => {
      const res = await postJson(url, `/agents/${AGENT_DID}/key-rotation`, {
        fromKey: `${AGENT_DID}#zA`,
        toKey: `${AGENT_DID}#zB`,
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('storage unavailable');
    });
  });

  it('503: the write throws and the read-back shows no new record', async () => {
    const base = new MemoryAgentRepository();
    await base.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:zOperatorKeyHash',
      delegation,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const repo: AgentRepository = {
      create: (input) => base.create(input),
      findByDid: (did) => base.findByDid(did),
      updateGithubBinding: (did, input) => base.updateGithubBinding(did, input),
      recordKeyRotation: () => Promise.reject(new Error('db down')),
    };
    const app = createApp(new MemoryOperatorRepository(), repo);
    await withApp(app, async (url) => {
      const res = await postJson(url, `/agents/${AGENT_DID}/key-rotation`, {
        fromKey: `${AGENT_DID}#zA`,
        toKey: `${AGENT_DID}#zB`,
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('storage unavailable');
      expect((await base.findByDid(AGENT_DID))?.keyRotations.length ?? 0).toBe(0);
    });
  });

  it('404: the write reports the agent as not stored, after the lookup succeeded', async () => {
    const app = makeApp({
      recordKeyRotation: () => Promise.resolve(null),
    });
    await withApp(app, async (url) => {
      const res = await postJson(url, `/agents/${AGENT_DID}/key-rotation`, {
        fromKey: `${AGENT_DID}#zA`,
        toKey: `${AGENT_DID}#zB`,
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe(`agent ${AGENT_DID} is not registered`);
    });
  });
});
