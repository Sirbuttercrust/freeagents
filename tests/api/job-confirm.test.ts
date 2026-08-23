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

const AGENT_DID = 'did:abt:agent-confirm';
const BUYER_DID = 'did:abt:buyer-confirm';
const proposal = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
];

// Rebound by each describe's beforeAll; suites inside one file run in order,
// so handing the helpers below to whichever suite is current is safe.
let server: Server;
let baseUrl: string;
const jobRepo = new MemoryJobRepository();
// Set by the happy-path walk; the lock test edits that same row afterwards,
// which is the point: one job id, every path tried against it.
let confirmedJobId: string;

async function post(path: string, body: unknown = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

function draftRow(id: string): Job {
  return createJob(
    { id, buyerDid: BUYER_DID, agentDid: AGENT_DID, repository: 'buyer/target-repo', brief: 'Fix the login bug' },
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
    did: AGENT_DID,
    operatorDid: 'did:abt:op-confirm',
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: null,
  });
  const s = createApp(new MemoryOperatorRepository(), agentRepo, undefined, undefined, repo).listen(0);
  await new Promise<void>((resolve) => s.once('listening', resolve));
  const address = s.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return { server: s, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe('job confirm (R-9)', () => {
  beforeAll(async () => {
    ({ server, baseUrl } = await startWith(jobRepo));
  });

  afterAll(() => {
    server.close();
  });

  it('walks propose -> accept x2 -> confirm on ONE row and projects the confirmed keys', async () => {
    const created = await post('/jobs', {
      buyerDid: BUYER_DID,
      agentDid: AGENT_DID,
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug on the checkout page',
    });
    expect(created.status).toBe(201);
    const draftBody = (await created.json()) as Record<string, unknown>;
    const jobId = String(draftBody.id);

    expect((await post(`/jobs/${jobId}/criteria`, { criteria: proposal })).status).toBe(200);

    // Each accept flips exactly its own flag, visible on the wire.
    const first = await post(`/jobs/${jobId}/criteria/0/accept`);
    expect(first.status).toBe(200);
    expect(((await first.json()) as Record<string, unknown>).criteria).toEqual([
      { text: 'The login bug is fixed', proposedBy: 'agent', accepted: true },
      { text: 'Checkout e2e test passes', proposedBy: 'buyer', accepted: false },
    ]);
    expect((await post(`/jobs/${jobId}/criteria/1/accept`)).status).toBe(200);

    const confirmed = await post(`/jobs/${jobId}/confirm`);
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

  it('answers 400 while a criterion is unaccepted, and for junk accept indexes', async () => {
    const created = await post('/jobs', {
      buyerDid: BUYER_DID,
      agentDid: AGENT_DID,
      repository: 'buyer/target-repo',
      brief: 'Another brief',
    });
    const jobId = String(((await created.json()) as Record<string, unknown>).id);
    await post(`/jobs/${jobId}/criteria`, { criteria: proposal });
    await post(`/jobs/${jobId}/criteria/0/accept`);

    const early = await post(`/jobs/${jobId}/confirm`);
    expect(early.status).toBe(400);
    const body = (await early.json()) as { error: string };
    expect(body.error).toContain('1 of 2 outstanding');

    // Out of range reaches the domain and comes back 400...
    expect((await post(`/jobs/${jobId}/criteria/99/accept`)).status).toBe(400);
    // ...and so does Number('abc') = NaN: the domain's integer guard decides.
    expect((await post(`/jobs/${jobId}/criteria/abc/accept`)).status).toBe(400);
  });

  it('answers 409 confirming a fresh draft, and 404 for an unknown id', async () => {
    const created = await post('/jobs', {
      buyerDid: BUYER_DID,
      agentDid: AGENT_DID,
      repository: 'buyer/target-repo',
      brief: 'A third brief',
    });
    const jobId = String(((await created.json()) as Record<string, unknown>).id);
    expect((await post(`/jobs/${jobId}/confirm`)).status).toBe(409);

    const nowhere = await post('/jobs/j-nowhere/confirm');
    expect(nowhere.status).toBe(404);
    expect(await nowhere.json()).toEqual({ error: 'not found' });
  });

  it('answers 400 when a proposed row somehow holds no criteria', async () => {
    const scripted = await startWith(new ScriptedRow({ ...draftRow('j-empty'), status: 'proposed', criteria: [] }));
    try {
      const res = await fetch(`${scripted.baseUrl}/jobs/j-empty/confirm`, { method: 'POST' });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('nothing was agreed');
    } finally {
      await new Promise<void>((resolve) => scripted.server.close(() => resolve()));
    }
  });

  it('locks the job after confirm: every editing path is a 409, nothing moves', async () => {
    // The issue's accept line, over every editing API path there is.
    expect((await post(`/jobs/${confirmedJobId}/criteria`, { criteria: proposal })).status).toBe(409);
    expect((await post(`/jobs/${confirmedJobId}/request-changes`)).status).toBe(409);
    expect((await post(`/jobs/${confirmedJobId}/criteria/0/accept`)).status).toBe(409);
    expect((await post(`/jobs/${confirmedJobId}/confirm`)).status).toBe(409);

    // And a read proves the row did not budge: same criteria, same digest.
    const read = await get(`/jobs/${confirmedJobId}`);
    expect(read.status).toBe(200);
    const readBack = (await read.json()) as Record<string, unknown>;
    expect(readBack.status).toBe('confirmed');
    expect(readBack.criteria).toEqual([
      { text: 'The login bug is fixed', proposedBy: 'agent', accepted: true },
      { text: 'Checkout e2e test passes', proposedBy: 'buyer', accepted: true },
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

  beforeAll(async () => {
    server = createApp(new MemoryOperatorRepository(), new MemoryAgentRepository()).listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    expect((await post('/operators', { did: operatorWallet.toDid(), githubLogin: 'operator-confirm' })).status).toBe(
      201,
    );
    expect(
      (
        await post('/agents', {
          did: agentWallet.toDid(),
          operator: operatorWallet.toDid(),
          delegation: await signW3CDelegation(operatorWallet, agentWallet),
          name: 'scout',
          skills: ['triage'],
        })
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
    });
    expect(created.status).toBe(201);
    const jobId = String(((await created.json()) as Record<string, unknown>).id);

    expect(
      (
        await post(`/jobs/${jobId}/criteria`, {
          criteria: [
            { text: 'The login bug is fixed', proposedBy: 'agent' },
            { text: 'Checkout e2e passes\r\non staging', proposedBy: 'buyer' },
          ],
        })
      ).status,
    ).toBe(200);
    await post(`/jobs/${jobId}/criteria/0/accept`);
    await post(`/jobs/${jobId}/criteria/1/accept`);

    const confirmed = await post(`/jobs/${jobId}/confirm`);
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
