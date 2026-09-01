// R-9 (#16): confirm, and hash the spec, driven end to end over HTTP.
//
// THE accept line this issue exists to prove: "on confirm the job exists with
// an immutable specHash; editing the criteria afterwards is impossible through
// any API path." One job walks propose -> accept -> accept -> confirm; after
// confirm every editing route answers 409 and nothing moves.
//
// The second describe holds ONLY the HTTP responses - criteria plus specHash -
// and recomputes the digest with node:crypto and an independently written
// normalisation, never an import of the service's hashing module (verifying a
// hash with the code that produced it proves nothing).
//
// runExchange's storage-fault legs are NOT re-covered per route:
// tests/api/job-criteria.test.ts pins each leg of the skeleton these routes
// share; repeating them here adds lines, not killable mutants.
//
// ENT-6.2's caller-identity gate: every exchange call below carries a
// verified request signature (R-34) naming the party acting, and confirm
// itself needs BOTH parties to have accepted every criterion before it
// succeeds.
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import * as vc from '@digitalbazaar/vc';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import { fromRandom, type WalletObject } from '@ocap/wallet';

import { createApp } from '../../src/api/app.js';
import {
  MemoryAgentRepository,
  MemoryJobRepository,
  MemoryOperatorRepository,
} from '../../src/adapters/storage/memory.js';
import type { JobRepository } from '../../src/adapters/storage/types.js';
import { DELEGATION_TYPE } from '../../src/domain/agent.js';
import { createJob, type Job } from '../../src/domain/job.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { mintSessionToken, testSessionAdapter } from '../helpers/session-fixtures.js';

const proposal = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
];

function delegationFixture(agentDid: string): Record<string, unknown> {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-confirm',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: 'did:abt:op-confirm',
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-01-01T00:00:00Z',
      verificationMethod: `${agentDid}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zfixture-not-verified-here',
    },
  };
}

// Rebound by each describe's beforeAll; suites inside one file run in order,
// so handing the helpers below to whichever suite is current is safe.
let server: Server;
let baseUrl: string;
const jobRepo = new MemoryJobRepository();
let buyer: SigningIdentity;
let agent: SigningIdentity;
let stranger: SigningIdentity;
// Set by the happy-path walk; the lock test edits that same row afterwards,
// which is the point: one job id, every path tried against it.
let confirmedJobId: string;

async function post(path: string, body: unknown = {}, authHeader: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeader },
    body: JSON.stringify(body),
  });
}

async function postSignedTo(base: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${base}${path}`;
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

async function postSigned(path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  return postSignedTo(baseUrl, path, body, identity);
}

async function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

function draftRow(id: string): Job {
  return createJob(
    { id, buyerDid: buyer.did, agentDid: agent.did, repository: 'buyer/target-repo', brief: 'Fix the login bug' },
    new Date('2026-01-01T00:00:00Z'),
  );
}

// Scripts findById: a zero-criteria proposed row no honest API path can
// produce (proposeCriteria enforces non-empty) - exactly why the emptiness
// gate needs a planted row as its only possible witness.
class ScriptedRow implements JobRepository {
  constructor(private readonly row: Job) {}
  async create(): Promise<never> {
    throw new Error('unreachable');
  }
  async findById(): Promise<Job> {
    return this.row;
  }
  async update(): Promise<null> {
    return null;
  }
  async complete(): Promise<null> {
    return null;
  }
  async findCompletedByJobId(): Promise<null> {
    return null;
  }
}

async function startWith(repo: JobRepository): Promise<{ server: Server; baseUrl: string }> {
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: agent.did,
    operatorDid: 'did:abt:op-confirm',
    delegation: delegationFixture(agent.did) as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: null,
  });
  const operatorRepo = new MemoryOperatorRepository();
  await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-confirm-scripted' });
  const s = createApp(operatorRepo, agentRepo, undefined, undefined, repo).listen(0);
  await new Promise<void>((resolve) => s.once('listening', resolve));
  const address = s.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return { server: s, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe('job confirm (R-9)', () => {
  beforeAll(async () => {
    buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(71));
    agent = await signingIdentityFromSeed(new Uint8Array(32).fill(72));
    stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(73));

    const operatorRepo = new MemoryOperatorRepository();
    await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-confirm' });
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: 'did:abt:op-confirm',
      delegation: delegationFixture(agent.did) as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    await agentRepo.create({
      did: stranger.did,
      operatorDid: 'did:abt:op-confirm',
      delegation: delegationFixture(stranger.did) as never,
      name: 'stranger',
      skills: ['triage'],
      githubLogin: null,
    });
    server = createApp(operatorRepo, agentRepo, undefined, undefined, jobRepo).listen(0);
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

  it('walks propose -> accept x2 (both parties) -> confirm on ONE row and projects the confirmed keys', async () => {
    const created = await postSigned('/jobs', {
      buyerDid: buyer.did,
      agentDid: agent.did,
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug on the checkout page',
    }, buyer);
    expect(created.status).toBe(201);
    const draftBody = (await created.json()) as Record<string, unknown>;
    const jobId = String(draftBody.id);

    expect((await postSigned(`/jobs/${jobId}/criteria`, { criteria: proposal }, agent)).status).toBe(200);

    // Each accept flips exactly its own party's flag on its own criterion,
    // visible on the wire.
    const first = await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, buyer);
    expect(first.status).toBe(200);
    expect(((await first.json()) as Record<string, unknown>).criteria).toEqual([
      { text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: false },
      { text: 'Checkout e2e test passes', proposedBy: 'buyer', acceptedByBuyer: false, acceptedByAgent: false },
    ]);
    expect((await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, agent)).status).toBe(200);
    expect((await postSigned(`/jobs/${jobId}/criteria/1/accept`, {}, buyer)).status).toBe(200);
    expect((await postSigned(`/jobs/${jobId}/criteria/1/accept`, {}, agent)).status).toBe(200);

    const confirmed = await postSigned(`/jobs/${jobId}/confirm`, {}, buyer);
    expect(confirmed.status).toBe(200);
    const confirmedBody = (await confirmed.json()) as Record<string, unknown>;
    expect(confirmedBody.id).toBe(jobId);
    expect(confirmedBody.status).toBe('confirmed');
    expect(String(confirmedBody.specHash)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(typeof confirmedBody.confirmedAt).toBe('string');
    // A confirmed job projects base eight + criteria + specHash + confirmedAt,
    // and nothing else.
    expect(Object.keys(confirmedBody).sort()).toEqual([
      'agentDid',
      'brief',
      'briefHash',
      'buyerDid',
      'confirmedAt',
      'createdAt',
      'criteria',
      'id',
      'repository',
      'specHash',
      'status',
    ]);
    // The brief's own verifiable fact rides through unchanged.
    expect(confirmedBody.briefHash).toBe(draftBody.briefHash);
    confirmedJobId = jobId;
  });

  it('answers 400 while a criterion is unaccepted by either party, and for junk accept indexes', async () => {
    const created = await postSigned('/jobs', {
      buyerDid: buyer.did,
      agentDid: agent.did,
      repository: 'buyer/target-repo',
      brief: 'Another brief',
    }, buyer);
    const jobId = String(((await created.json()) as Record<string, unknown>).id);
    await postSigned(`/jobs/${jobId}/criteria`, { criteria: proposal }, agent);
    await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, buyer);
    await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, agent);
    await postSigned(`/jobs/${jobId}/criteria/1/accept`, {}, buyer);
    // Criterion 1 is missing the agent's acceptance.

    const early = await postSigned(`/jobs/${jobId}/confirm`, {}, buyer);
    expect(early.status).toBe(400);
    const body = (await early.json()) as { error: string };
    expect(body.error).toContain('1 of 2 outstanding');

    // Out of range reaches the domain and comes back 400...
    expect((await postSigned(`/jobs/${jobId}/criteria/99/accept`, {}, buyer)).status).toBe(400);
    // ...and so does Number('abc') = NaN: the domain's integer guard decides.
    expect((await postSigned(`/jobs/${jobId}/criteria/abc/accept`, {}, buyer)).status).toBe(400);
  });

  it('one party accepting every criterion and calling confirm is REFUSED', async () => {
    const created = await postSigned('/jobs', {
      buyerDid: buyer.did,
      agentDid: agent.did,
      repository: 'buyer/target-repo',
      brief: 'A buyer-only accept attempt',
    }, buyer);
    const jobId = String(((await created.json()) as Record<string, unknown>).id);
    await postSigned(`/jobs/${jobId}/criteria`, { criteria: proposal }, agent);
    // The buyer alone accepts every criterion.
    await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, buyer);
    await postSigned(`/jobs/${jobId}/criteria/1/accept`, {}, buyer);

    const confirm = await postSigned(`/jobs/${jobId}/confirm`, {}, buyer);
    expect(confirm.status).toBe(400);
    const body = (await confirm.json()) as { error: string };
    expect(body.error).toContain('2 of 2 outstanding');

    const read = await get(`/jobs/${jobId}`);
    expect(((await read.json()) as Record<string, unknown>).status).toBe('proposed');
  });

  it('a caller with no signature at all is refused 401, and a signed stranger is refused 403, on every exchange route', async () => {
    const created = await postSigned('/jobs', {
      buyerDid: buyer.did,
      agentDid: agent.did,
      repository: 'buyer/target-repo',
      brief: 'A stranger tries every route',
    }, buyer);
    const jobId = String(((await created.json()) as Record<string, unknown>).id);

    expect((await post(`/jobs/${jobId}/criteria`, { criteria: proposal })).status).toBe(401);
    expect((await postSigned(`/jobs/${jobId}/criteria`, { criteria: proposal }, stranger)).status).toBe(403);
    await postSigned(`/jobs/${jobId}/criteria`, { criteria: proposal }, agent);
    expect((await post(`/jobs/${jobId}/request-changes`, {})).status).toBe(401);
    expect((await postSigned(`/jobs/${jobId}/request-changes`, {}, stranger)).status).toBe(403);
    expect((await post(`/jobs/${jobId}/criteria/0/accept`, {})).status).toBe(401);
    expect((await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, stranger)).status).toBe(403);
    expect((await post(`/jobs/${jobId}/confirm`, {})).status).toBe(401);
    expect((await postSigned(`/jobs/${jobId}/confirm`, {}, stranger)).status).toBe(403);
  });

  it('answers 409 confirming a fresh draft, and 404 for an unknown id', async () => {
    const created = await postSigned('/jobs', {
      buyerDid: buyer.did,
      agentDid: agent.did,
      repository: 'buyer/target-repo',
      brief: 'A third brief',
    }, buyer);
    const jobId = String(((await created.json()) as Record<string, unknown>).id);
    expect((await postSigned(`/jobs/${jobId}/confirm`, {}, buyer)).status).toBe(409);

    const nowhere = await postSigned('/jobs/j-nowhere/confirm', {}, buyer);
    expect(nowhere.status).toBe(404);
    expect(await nowhere.json()).toEqual({ error: 'not found' });
  });

  it('answers 400 when a proposed row somehow holds no criteria', async () => {
    const scripted = await startWith(new ScriptedRow({ ...draftRow('j-empty'), status: 'proposed', criteria: [] }));
    try {
      const res = await postSignedTo(scripted.baseUrl, '/jobs/j-empty/confirm', {}, buyer);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('nothing was agreed');
    } finally {
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('locks the job after confirm: every editing path is a 409, nothing moves', async () => {
    // The issue's accept line, over every editing API path there is.
    expect((await postSigned(`/jobs/${confirmedJobId}/criteria`, { criteria: proposal }, agent)).status).toBe(409);
    expect((await postSigned(`/jobs/${confirmedJobId}/request-changes`, {}, buyer)).status).toBe(409);
    expect((await postSigned(`/jobs/${confirmedJobId}/criteria/0/accept`, {}, buyer)).status).toBe(409);
    expect((await postSigned(`/jobs/${confirmedJobId}/confirm`, {}, buyer)).status).toBe(409);

    // And a read proves the row did not budge: same criteria, same digest.
    const read = await get(`/jobs/${confirmedJobId}`);
    expect(read.status).toBe(200);
    const readBack = (await read.json()) as Record<string, unknown>;
    expect(readBack.status).toBe('confirmed');
    expect(readBack.criteria).toEqual([
      { text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
      { text: 'Checkout e2e test passes', proposedBy: 'buyer', acceptedByBuyer: true, acceptedByAgent: true },
    ]);
    expect(String(readBack.specHash)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('confirm, invariant 2 (R-9): the spec hash is verifiable off-platform', () => {
  // A fresh app and fresh wallets, so this flow stands on its own routes
  // end to end - registration, signed delegation and all.
  const operatorWallet = fromRandom();
  const agentWallet = fromRandom();
  let confirmedBody: Record<string, unknown>;
  let authHeader: Record<string, string>;

  beforeAll(async () => {
    const sessionAdapter = testSessionAdapter();
    server = createApp(
      new MemoryOperatorRepository(),
      new MemoryAgentRepository(),
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

    expect(
      (await post('/operators', { did: operatorWallet.toDid(), githubLogin: 'operator-confirm' }, authHeader)).status,
    ).toBe(201);
    expect(
      (
        await post('/agents', {
          did: agentWallet.toDid(),
          operator: operatorWallet.toDid(),
          delegation: await signW3CDelegation(operatorWallet, agentWallet),
          name: 'scout',
          skills: ['triage'],
        }, authHeader)
      ).status,
    ).toBe(201);
  });

  afterAll(() => {
    server.close();
  });

  it('a stranger recomputes specHash from the response alone, no call to this service', async () => {
    // An interior CRLF survives proposeCriteria's trim, so join AND
    // normalisation both have to be right for the digest to match.
    const created = await post('/jobs', {
      buyerDid: operatorWallet.toDid(),
      agentDid: agentWallet.toDid(),
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug\r\nthen deploy\n  ',
    }, authHeader);
    expect(created.status).toBe(201);
    const jobId = String(((await created.json()) as Record<string, unknown>).id);

    const walletSigningIdentity = async (wallet: WalletObject): Promise<SigningIdentity> => {
      const seed = hexToBytes(wallet.secretKey).slice(0, 32);
      const key = await Ed25519VerificationKey2020.generate({ seed, controller: wallet.toDid() });
      const keyid = `${wallet.toDid()}#${key.publicKeyMultibase}`;
      const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
      const { createPrivateKey } = await import('node:crypto');
      const privateKey = createPrivateKey({
        key: Buffer.concat([pkcs8Prefix, Buffer.from(seed)]),
        format: 'der',
        type: 'pkcs8',
      });
      return { did: wallet.toDid(), keyid, privateKey };
    };
    const operatorIdentity = await walletSigningIdentity(operatorWallet);
    const agentIdentity = await walletSigningIdentity(agentWallet);

    expect(
      (
        await postSigned(
          `/jobs/${jobId}/criteria`,
          {
            criteria: [
              { text: 'The login bug is fixed', proposedBy: 'agent' },
              { text: 'Checkout e2e passes\r\non staging', proposedBy: 'buyer' },
            ],
          },
          agentIdentity,
        )
      ).status,
    ).toBe(200);
    await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, operatorIdentity);
    await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, agentIdentity);
    await postSigned(`/jobs/${jobId}/criteria/1/accept`, {}, operatorIdentity);
    await postSigned(`/jobs/${jobId}/criteria/1/accept`, {}, agentIdentity);

    const confirmed = await postSigned(`/jobs/${jobId}/confirm`, {}, operatorIdentity);
    expect(confirmed.status).toBe(200);
    confirmedBody = (await confirmed.json()) as Record<string, unknown>;

    // Everything below holds only this response plus node:crypto - nothing
    // from src/, no import of the hashing module.
    const criteria = confirmedBody.criteria as Array<{ text: string }>;
    const joined = criteria.map((criterion) => criterion.text).join('\n');

    // The documented serialization (A1), written out independently:
    // \n endings, trailing whitespace stripped per line, no final newline.
    let normalised = joined
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n');
    if (normalised.endsWith('\n')) {
      normalised = normalised.slice(0, -1);
    }
    const recomputed = 'sha256:' + createHash('sha256').update(normalised).digest('hex');

    expect(recomputed).toBe(confirmedBody.specHash);
    expect(String(confirmedBody.specHash)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('negative control: an altered criterion hashes differently, so this test can fail', () => {
    // If the recomputation above could not disagree with the service, it
    // would prove nothing. One changed word must move the digest.
    const criteria = confirmedBody.criteria as Array<{ text: string }>;
    const tampered = criteria.map((criterion, i) =>
      i === 0 ? { ...criterion, text: criterion.text.replace('fixed', 'broken') } : criterion,
    );
    const joined = tampered.map((criterion) => criterion.text).join('\n');
    const normalise = (s: string): string =>
      s
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .map((line) => line.trimEnd())
        .join('\n')
        .replace(/\n$/, '');
    const asTampered = 'sha256:' + createHash('sha256').update(normalise(joined)).digest('hex');

    expect(asTampered).not.toBe(confirmedBody.specHash);
    expect(asTampered).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

function hexToBytes(h: string): Uint8Array {
  return Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
}

async function signW3CDelegation(operator: WalletObject, agent: WalletObject): Promise<Record<string, unknown>> {
  const operatorDid = operator.toDid();
  const seed = hexToBytes(operator.secretKey).slice(0, 32);
  const key = await Ed25519VerificationKey2020.generate({ seed, controller: operatorDid });
  key.id = `${operatorDid}#${key.publicKeyMultibase}`;
  const suite = new Ed25519Signature2020({ key });

  const credential = {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
      { '@vocab': 'https://freeagents.dev/terms#' },
    ],
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: ['VerifiableCredential', DELEGATION_TYPE],
    issuer: operatorDid,
    issuanceDate: new Date().toISOString(),
    credentialSubject: { id: agent.toDid(), delegatedBy: operatorDid },
  };

  const publicKey = {
    '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
    ...key.export({ publicKey: true }),
  };
  const loader = securityLoader();
  loader.addStatic(key.id, publicKey);
  loader.addStatic(operatorDid, {
    '@context': 'https://w3id.org/ns/did/v1',
    id: operatorDid,
    assertionMethod: [key.id],
    verificationMethod: [publicKey],
  });

  return vc.issue({ credential, suite, documentLoader: loader.build() });
}
