// R-30 (ENT-8.4): POST /agents/:agentDid/key-rotation supersedes an
// agent's key. The route is storage-only, so it runs on the real identity
// and github adapters (never called) and the real logic; the storage
// branches the real repository never exercises (a failing lookup, a
// failing write, and a write that reports the agent as not stored after
// the lookup succeeded) are exercised with wrapped repositories, the same
// way tests/api/app.test.ts and account-proof.test.ts do it.
//
// S3 (security sweep, high): the route mounted no authentication at all.
// Every positive-path test below now signs as the agent's own operator
// (R-34, the same requireSessionOrSignature path the hire routes use after
// P8a), and a dedicated caller-gating block pins the refusal shapes: no
// proof at all, a registered stranger, and the enumeration-safe ordering.
import type { Express } from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import type { AgentRepository } from '../../src/adapters/storage/types.js';
import type { Agent, Delegation } from '../../src/domain/agent.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

async function postJson(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function postSigned(baseUrl: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, 'POST', targetUri, { body: bodyText });
  return fetch(targetUri, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
    body: bodyText,
  });
}

function delegationFor(agentDid: string, operatorDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:key-rotation-test',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-08-21T05:00:00.000Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-08-21T05:00:00.000Z',
      verificationMethod: `${operatorDid}#zOperatorKeyHash`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zMockProofValue',
    },
  };
}

// The projection shape of a stored keyRotations array, so a read-back
// assertion can compare against the driver's own stamp rather than a
// fabricated timestamp.
type KeyRotationProjection = { fromKey: string; toKey: string; rotatedAt: string };

describe('POST /agents/:agentDid/key-rotation (R-30, ENT-8.4)', () => {
  let server: Server;
  let baseUrl: string;
  const agentRepo = new MemoryAgentRepository();
  let operator: SigningIdentity;
  let agentDid: string;

  beforeAll(async () => {
    const accountRepo = new MemoryAccountRepository();
    operator = await signingIdentityFromSeed(new Uint8Array(32).fill(221));
    // R-34 signature verification requires the signer DID to be a
    // registered Agent or Account; the operator here is neither by
    // default, so it registers as an Account, the same shape a real
    // operator's wallet would hold.
    await accountRepo.register({ did: operator.did, githubLogin: 'key-rotation-operator' });
    agentDid = 'did:abt:zAgentKeyHash';
    await agentRepo.create({
      did: agentDid,
      operatorDid: operator.did,
      delegation: delegationFor(agentDid, operator.did),
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const app = createApp(accountRepo, agentRepo);
    server = app.listen(0, '127.0.0.1');
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
    const fromKey = `${agentDid}#zOld`;
    const toKey = `${agentDid}#zNew`;
    const res = await postSigned(baseUrl, `/agents/${agentDid}/key-rotation`, { fromKey, toKey }, operator);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // The rotation rides the response and every other projection key is
    // still present (spot-check the base key).
    expect(body.did).toBe(agentDid);
    const rotations = body.keyRotations as KeyRotationProjection[];
    expect(rotations).toHaveLength(1);
    const first = rotations[0] as KeyRotationProjection;
    expect(first.fromKey).toBe(fromKey);
    expect(first.toKey).toBe(toKey);
    expect(Number.isNaN(Date.parse(first.rotatedAt))).toBe(false);

    // R-6: the profile shows the rotation with dates on the read-back.
    const read = await fetch(`${baseUrl}/agents/${agentDid}`);
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as Record<string, unknown>;
    const readRotations = readBody.keyRotations as KeyRotationProjection[];
    expect(readRotations).toHaveLength(1);
    const readFirst = readRotations[0] as KeyRotationProjection;
    expect(readFirst.fromKey).toBe(fromKey);
    expect(readFirst.rotatedAt).toBe(first.rotatedAt);
  });

  it('200: a second rotation appends in order, it never replaces', async () => {
    const res = await postSigned(baseUrl, `/agents/${agentDid}/key-rotation`, {
      fromKey: `${agentDid}#zNew`,
      toKey: `${agentDid}#zNewer`,
    }, operator);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const rotations = body.keyRotations as KeyRotationProjection[];
    expect(rotations).toHaveLength(2);
    const [first, second] = rotations as [KeyRotationProjection, KeyRotationProjection];
    expect(first.toKey).toBe(`${agentDid}#zNew`);
    expect(second.fromKey).toBe(`${agentDid}#zNew`);
    expect(second.toKey).toBe(`${agentDid}#zNewer`);
  });

  it('400: a malformed body is refused before authentication is ever checked (no signature on this request)', async () => {
    const before = (await agentRepo.findByDid(agentDid))?.keyRotations.length ?? 0;
    const res = await postJson(baseUrl, `/agents/${agentDid}/key-rotation`, {});
    expect(res.status).toBe(400);
    const after = (await agentRepo.findByDid(agentDid))?.keyRotations.length ?? 0;
    expect(after).toBe(before);
  });

  it.each([
    ['an empty body', {}],
    ['a numeric fromKey', { fromKey: 42 }],
    ['a null fromKey', { fromKey: null }],
    ['an empty fromKey', { fromKey: '' }],
    ['a fromKey without a fragment', () => ({ fromKey: agentDid })],
    ['a numeric toKey', () => ({ fromKey: `${agentDid}#zA`, toKey: 42 })],
    ['an empty toKey', () => ({ fromKey: `${agentDid}#zA`, toKey: '' })],
    ['a toKey without a fragment', () => ({ fromKey: `${agentDid}#zA`, toKey: agentDid })],
  ])('400: a malformed body (%s), signed as the operator, records nothing', async (_label, bodyOrFn) => {
    const body = typeof bodyOrFn === 'function' ? (bodyOrFn as () => Record<string, unknown>)() : bodyOrFn;
    const before = (await agentRepo.findByDid(agentDid))?.keyRotations.length ?? 0;
    const res = await postSigned(baseUrl, `/agents/${agentDid}/key-rotation`, body, operator);
    expect(res.status).toBe(400);
    const after = (await agentRepo.findByDid(agentDid))?.keyRotations.length ?? 0;
    expect(after).toBe(before);
  });

  it('400: no body at all is a malformed request, not a crash', async () => {
    // Express leaves req.body undefined when no JSON arrives; the route's
    // `req.body ?? {}` fallback is the only thing between that and a throw.
    // This is the one request in the file that sends no content-type and no
    // payload, so deleting the fallback fails here and nowhere else.
    const before = (await agentRepo.findByDid(agentDid))?.keyRotations.length ?? 0;
    const res = await fetch(`${baseUrl}/agents/${agentDid}/key-rotation`, { method: 'POST' });
    expect(res.status).toBe(400);
    const after = (await agentRepo.findByDid(agentDid))?.keyRotations.length ?? 0;
    expect(after).toBe(before);
  });

  it('400: an identity rotation (fromKey === toKey), signed as the operator, records nothing', async () => {
    const before = (await agentRepo.findByDid(agentDid))?.keyRotations.length ?? 0;
    const key = `${agentDid}#zSame`;
    const res = await postSigned(baseUrl, `/agents/${agentDid}/key-rotation`, {
      fromKey: key,
      toKey: key,
    }, operator);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain('same key');
    const after = (await agentRepo.findByDid(agentDid))?.keyRotations.length ?? 0;
    expect(after).toBe(before);
  });

  it('404: a well-formed body, signed by a real caller, for an unknown agent', async () => {
    const res = await postSigned(baseUrl, '/agents/did:abt:nobody/key-rotation', {
      fromKey: 'did:abt:nobody#zA',
      toKey: 'did:abt:nobody#zB',
    }, operator);
    expect(res.status).toBe(404);
  });
});

// S3 (security sweep, high): no authentication mounted at all, so an
// unsigned stranger could fabricate rotation history on any listed agent.
// The route now requires the agent's own operator, resolved the same way
// the hire routes resolve a caller after P8a (authentication first, then
// resolveActingParty, matched against Agent.operatorDid by suffix).
describe('POST /agents/:agentDid/key-rotation, caller gating (S3)', () => {
  let server: Server;
  let baseUrl: string;
  let agentRepo: MemoryAgentRepository;
  let operator: SigningIdentity;
  let stranger: SigningIdentity;
  let did: string;

  beforeAll(async () => {
    operator = await signingIdentityFromSeed(new Uint8Array(32).fill(222));
    stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(223));
    did = 'did:abt:zS3GateAgent';
    agentRepo = new MemoryAgentRepository();
    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: operator.did, githubLogin: 'key-rotation-s3-operator' });
    await accountRepo.register({ did: stranger.did, githubLogin: 'key-rotation-s3-stranger' });
    await agentRepo.create({
      did,
      operatorDid: operator.did,
      delegation: delegationFor(did, operator.did),
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const app = createApp(accountRepo, agentRepo);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('401: a request with no session and no signature is refused, and stores nothing', async () => {
    const res = await postJson(baseUrl, `/agents/${did}/key-rotation`, {
      fromKey: `${did}#zOld`,
      toKey: `${did}#zNew`,
    });
    expect(res.status).toBe(401);
    const stored = await agentRepo.findByDid(did);
    expect(stored?.keyRotations.length ?? 0).toBe(0);
  });

  it('403: a registered stranger (not this agent\'s operator) is refused, and stores nothing', async () => {
    const res = await postSigned(baseUrl, `/agents/${did}/key-rotation`, {
      fromKey: `${did}#zOld`,
      toKey: `${did}#zNew`,
    }, stranger);
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    // The refusal never names the real operator.
    expect(String(body.error)).not.toContain(operator.did);
    const stored = await agentRepo.findByDid(did);
    expect(stored?.keyRotations.length ?? 0).toBe(0);
  });

  it('60 unsigned requests against one agent all refuse and store nothing (the bulk case)', async () => {
    const results = await Promise.all(
      Array.from({ length: 60 }, () =>
        postJson(baseUrl, `/agents/${did}/key-rotation`, { fromKey: `${did}#zA`, toKey: `${did}#zB` }),
      ),
    );
    for (const res of results) expect(res.status).toBe(401);
    const stored = await agentRepo.findByDid(did);
    expect(stored?.keyRotations.length ?? 0).toBe(0);
  });

  it('an unauthenticated request cannot tell a real agent from a nonexistent one: both are 401', async () => {
    const real = await postJson(baseUrl, `/agents/${did}/key-rotation`, {
      fromKey: `${did}#zA`,
      toKey: `${did}#zB`,
    });
    const fake = await postJson(baseUrl, '/agents/did:abt:zDoesNotExist/key-rotation', {
      fromKey: 'did:abt:zDoesNotExist#zA',
      toKey: 'did:abt:zDoesNotExist#zB',
    });
    expect(real.status).toBe(401);
    expect(fake.status).toBe(401);
  });

  it('the operator setting their own key rotation still succeeds (positive control unchanged)', async () => {
    const res = await postSigned(baseUrl, `/agents/${did}/key-rotation`, {
      fromKey: `${did}#zOld`,
      toKey: `${did}#zNew`,
    }, operator);
    expect(res.status).toBe(200);
    const stored = await agentRepo.findByDid(did);
    expect(stored?.keyRotations.length ?? 0).toBe(1);
  });

  it('the operator matches by DID suffix: a short-form stored operatorDid still accepts the operator\'s full-form signature', async () => {
    // Mutation proof 4: the operator match must reconcile did:abt:<suffix>
    // against the bare suffix, the same way delegationConsistent already
    // does in src/domain/agent.ts. A raw string compare would refuse this
    // legitimate operator outright.
    const suffixOnlyOperator = await signingIdentityFromSeed(new Uint8Array(32).fill(227));
    const shortFormDid = suffixOnlyOperator.did.replace(/^did:abt:/, '');
    const suffixAgentRepo = new MemoryAgentRepository();
    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: suffixOnlyOperator.did, githubLogin: 'key-rotation-suffix-operator' });
    const suffixAgentDid = 'did:abt:zSuffixReconcileAgent';
    await suffixAgentRepo.create({
      did: suffixAgentDid,
      // Stored in short form, as a delegation authored off a bare suffix would record it.
      operatorDid: shortFormDid,
      delegation: delegationFor(suffixAgentDid, shortFormDid),
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const app = createApp(accountRepo, suffixAgentRepo);
    const server2 = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server2.once('listening', resolve));
    const address2 = server2.address();
    if (address2 === null || typeof address2 === 'string') throw new Error('expected a port');
    const url2 = `http://127.0.0.1:${address2.port}`;
    try {
      // The signature names the full-form DID (the resolver's own output);
      // the stored operatorDid is short-form. Only the suffix reconciliation
      // makes these the same operator.
      const res = await postSigned(url2, `/agents/${suffixAgentDid}/key-rotation`, {
        fromKey: `${suffixAgentDid}#zOld`,
        toKey: `${suffixAgentDid}#zNew`,
      }, suffixOnlyOperator);
      expect(res.status).toBe(200);
    } finally {
      server2.close();
    }
  });
});

// The three storage branches of the route, which the real repository never
// exercises: a failing lookup, a failing write, and a write that reports the
// agent as not stored even though the lookup succeeded. Each gets its own app
// with a wrapped repository, the same way the R-1/R-2 tests inject them. The
// caller in each case is a real R-34 signature naming the agent's operator,
// so the branch under test is reached past the caller gate.
describe('POST /agents/:agentDid/key-rotation, storage branches', () => {
  // A storage failure is a logged operator concern, not output the test
  // needs; silence it so the branch under test is the response, not the log.
  async function withApp(app: Express, run: (url: string) => Promise<void>): Promise<void> {
    const server = app.listen(0, '127.0.0.1');
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
    const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(224));
    const agentDid = 'did:abt:zAgentKeyHash';
    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: operator.did, githubLogin: 'key-rotation-branch-1' });
    const base = new MemoryAgentRepository();
    // Only the rotation target's own lookup fails: the signing-key
    // resolver's isRegistered check calls findByDid(operator.did) first
    // (to confirm the signer holds a registered identity), and that call
    // must succeed so the request reaches the route's own failing lookup.
    const repo: AgentRepository = {
      create: (input) => base.create(input),
      findByDid: (did) => (did === agentDid ? Promise.reject(new Error('db down')) : base.findByDid(did)),
      updateGithubBinding: (did, input) => base.updateGithubBinding(did, input),
      recordKeyRotation: (did, input) => base.recordKeyRotation(did, input),
    };
    const app = createApp(accountRepo, repo);
    await withApp(app, async (url) => {
      const res = await postSigned(url, `/agents/${agentDid}/key-rotation`, {
        fromKey: `${agentDid}#zA`,
        toKey: `${agentDid}#zB`,
      }, operator);
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('storage unavailable');
    });
  });

  it('503: the write throws and the read-back shows no new record', async () => {
    const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(225));
    const agentDid = 'did:abt:zAgentKeyHash';
    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: operator.did, githubLogin: 'key-rotation-branch-2' });
    const base = new MemoryAgentRepository();
    await base.create({
      did: agentDid,
      operatorDid: operator.did,
      delegation: delegationFor(agentDid, operator.did),
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
    const app = createApp(accountRepo, repo);
    await withApp(app, async (url) => {
      const res = await postSigned(url, `/agents/${agentDid}/key-rotation`, {
        fromKey: `${agentDid}#zA`,
        toKey: `${agentDid}#zB`,
      }, operator);
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('storage unavailable');
      expect((await base.findByDid(agentDid))?.keyRotations.length ?? 0).toBe(0);
    });
  });

  it('404: the write reports the agent as not stored, after the lookup succeeded', async () => {
    // findByDid must succeed for the request to reach recordKeyRotation:
    // with only the empty base repository, the route 404s at the lookup and
    // the updated === null branch is never executed.
    const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(226));
    const agentDid = 'did:abt:zAgentKeyHash';
    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: operator.did, githubLogin: 'key-rotation-branch-3' });
    const stored: Agent = {
      did: agentDid,
      operatorDid: operator.did,
      delegation: delegationFor(agentDid, operator.did),
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
      githubBinding: null,
      keyRotations: [],
    } as unknown as Agent;
    const base = new MemoryAgentRepository();
    const repo: AgentRepository = {
      create: (input) => base.create(input),
      findByDid: () => Promise.resolve(stored),
      updateGithubBinding: (did, input) => base.updateGithubBinding(did, input),
      recordKeyRotation: () => Promise.resolve(null),
    };
    const app = createApp(accountRepo, repo);
    await withApp(app, async (url) => {
      const res = await postSigned(url, `/agents/${agentDid}/key-rotation`, {
        fromKey: `${agentDid}#zA`,
        toKey: `${agentDid}#zB`,
      }, operator);
      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe(`agent ${agentDid} is not registered`);
    });
  });
});
