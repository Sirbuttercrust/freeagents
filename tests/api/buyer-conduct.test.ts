// P7: the buyer conduct record, keyed to the buyer's verified GitHub
// account, plus the operator's two listing filters on POST /jobs and the
// public conduct read route. This is the HTTP acceptance test; the pure
// rule is pinned in tests/domain/buyer-conduct.test.ts and
// tests/domain/buyer-diversity.test.ts.
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import * as vc from '@digitalbazaar/vc';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import { fromRandom, type WalletObject } from '@ocap/wallet';

import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryJobRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { DELEGATION_TYPE, didSuffix } from '../../src/domain/agent.js';
import { signingIdentityFromSeed, signingIdentityFromWallet, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';

// The ArcBlock wallet's secretKey is seed(32)||public(32) in hex.
function hexToBytes(h: string): Uint8Array {
  return Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
}

// Sign a real W3C delegation credential, the house construction shared by
// tests/api/agent-invariant2.test.ts and tests/api/job-invariant2.test.ts:
// POST /agents runs real cryptographic verification, so a hand-typed
// proofValue is refused with 400 before this suite's own assertions ever
// run.
async function signW3CDelegation(operator: WalletObject, agent: WalletObject): Promise<Record<string, unknown>> {
  const operatorDid = operator.toDid();
  const agentDid = agent.toDid();

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
    credentialSubject: { id: agentDid, delegatedBy: operatorDid },
  };

  const loader = securityLoader();
  loader.addStatic(key.id, {
    '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
    ...key.export({ publicKey: true }),
  });
  loader.addStatic(operatorDid, {
    '@context': 'https://www.w3.org/ns/did/v1',
    id: operatorDid,
    assertionMethod: [key.id],
    verificationMethod: [
      {
        '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
        ...key.export({ publicKey: true }),
      },
    ],
  });
  const documentLoader = loader.build();

  return vc.issue({ credential, suite, documentLoader });
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

async function postJsonAsWallet(baseUrl: string, path: string, body: Record<string, unknown>, wallet: WalletObject): Promise<Response> {
  const identity = await signingIdentityFromWallet(wallet);
  return postSigned(baseUrl, path, body, identity);
}

async function listen(app: ReturnType<typeof createApp>): Promise<{ server: Server; baseUrl: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function delegationFixture(agentDid: string, operatorDid: string): Record<string, unknown> {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-buyer-conduct',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
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

// Scope item 4: POST /agents accepts the two thresholds, validates them as
// non-negative integers, and surfaces them on the agent's public
// representation. Uses real W3C-signed delegation credentials, since
// createApp's default identity adapter runs genuine cryptographic
// verification on this route.
describe('POST /agents: the operator listing filters (P7)', () => {
  let server: Server;
  let baseUrl: string;
  const operatorWallet = fromRandom();

  beforeAll(async () => {
    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: operatorWallet.toDid(), githubLogin: 'operator-buyer-conduct' });
    const agentRepo = new MemoryAgentRepository();
    ({ server, baseUrl } = await listen(
      createApp(accountRepo, agentRepo, undefined, undefined, new MemoryJobRepository()),
    ));
  });

  afterAll(() => server.close());

  it('accepts both thresholds at delegation and surfaces them on the projection', async () => {
    const agentWallet = fromRandom();
    const res = await postJsonAsWallet(baseUrl, '/agents', {
      did: agentWallet.toDid(),
      delegation: await signW3CDelegation(operatorWallet, agentWallet),
      name: 'scout',
      skills: ['triage'],
      minBuyerMerges: 2,
      maxWalkedAfterConfirm: 0,
    }, operatorWallet);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.minBuyerMerges).toBe(2);
    expect(body.maxWalkedAfterConfirm).toBe(0);
  });

  it('defaults both thresholds to null when the operator sets neither', async () => {
    const agentWallet = fromRandom();
    const res = await postJsonAsWallet(baseUrl, '/agents', {
      did: agentWallet.toDid(),
      delegation: await signW3CDelegation(operatorWallet, agentWallet),
      name: 'scout',
      skills: ['triage'],
    }, operatorWallet);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.minBuyerMerges).toBeNull();
    expect(body.maxWalkedAfterConfirm).toBeNull();
  });

  it('refuses a negative minBuyerMerges with 400', async () => {
    const agentWallet = fromRandom();
    const res = await postJsonAsWallet(baseUrl, '/agents', {
      did: agentWallet.toDid(),
      delegation: await signW3CDelegation(operatorWallet, agentWallet),
      name: 'scout',
      skills: ['triage'],
      minBuyerMerges: -1,
    }, operatorWallet);
    expect(res.status).toBe(400);
  });

  it('refuses a non-integer maxWalkedAfterConfirm with 400', async () => {
    const agentWallet = fromRandom();
    const res = await postJsonAsWallet(baseUrl, '/agents', {
      did: agentWallet.toDid(),
      delegation: await signW3CDelegation(operatorWallet, agentWallet),
      name: 'scout',
      skills: ['triage'],
      maxWalkedAfterConfirm: 1.5,
    }, operatorWallet);
    expect(res.status).toBe(400);
  });

  it('reads back the same thresholds on GET /agents/:agentDid', async () => {
    const agentWallet = fromRandom();
    await postJsonAsWallet(baseUrl, '/agents', {
      did: agentWallet.toDid(),
      delegation: await signW3CDelegation(operatorWallet, agentWallet),
      name: 'scout',
      skills: ['triage'],
      minBuyerMerges: 3,
      maxWalkedAfterConfirm: 1,
    }, operatorWallet);
    const read = await fetch(`${baseUrl}/agents/${agentWallet.toDid()}`);
    const body = (await read.json()) as Record<string, unknown>;
    expect(body.minBuyerMerges).toBe(3);
    expect(body.maxWalkedAfterConfirm).toBe(1);
  });
});

// Scope item 4: enforcement in POST /jobs, after the acting party resolves
// and after the agent row loads. The three rules, each pinned by its own
// test: null means no filter; an unkeyed buyer fails any set threshold;
// the platform sets no default. Agents here are registered directly
// through the repository (bypassing POST /agents' own cryptographic
// verification, exactly the way tests/api/job-price.test.ts already
// does), since this suite's target is the hire-time gate, not delegation.
describe('POST /jobs: the buyer-conduct threshold gate (P7)', () => {
  async function buildApp(): Promise<{
    server: Server;
    baseUrl: string;
    accountRepo: MemoryAccountRepository;
    agentRepo: MemoryAgentRepository;
    jobRepo: MemoryJobRepository;
  }> {
    const accountRepo = new MemoryAccountRepository();
    const agentRepo = new MemoryAgentRepository();
    const jobRepo = new MemoryJobRepository();
    const app = createApp(
      accountRepo,
      agentRepo,
      undefined,
      undefined,
      jobRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      alwaysSettledGate(),
    );
    const { server, baseUrl } = await listen(app);
    return { server, baseUrl, accountRepo, agentRepo, jobRepo };
  }

  it('null means no filter: an operator who set nothing refuses nobody, even a buyer with a bad count', async () => {
    const { server, baseUrl, accountRepo, agentRepo } = await buildApp();
    try {
      const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(11));
      const agentIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(12));
      const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(13));
      await accountRepo.register({ did: operator.did, githubLogin: 'operator-p7-null' });
      await accountRepo.register({ did: buyer.did, githubLogin: 'buyer-p7-null' });
      await agentRepo.create({
        did: agentIdentity.did,
        operatorDid: operator.did,
        delegation: delegationFixture(agentIdentity.did, operator.did) as never,
        name: 'scout',
        skills: ['triage'],
        githubLogin: null,
      });
      const res = await postSigned(baseUrl, '/jobs', {
        agentDid: agentIdentity.did,
        repository: 'buyer/target-repo',
        brief: 'Fix the login bug',
      }, buyer);
      expect(res.status).toBe(201);
    } finally {
      server.close();
    }
  });

  it('a buyer below minBuyerMerges (a keyed buyer with too few merges) fails with 403, naming the threshold and the actual count', async () => {
    const { server, baseUrl, accountRepo, agentRepo } = await buildApp();
    try {
      const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(14));
      const agentIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(15));
      const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(16));
      await accountRepo.register({ did: operator.did, githubLogin: 'operator-p7-below-min' });
      await accountRepo.register({ did: buyer.did, githubLogin: 'buyer-p7-below-min' });
      await agentRepo.create({
        did: agentIdentity.did,
        operatorDid: operator.did,
        delegation: delegationFixture(agentIdentity.did, operator.did) as never,
        name: 'scout',
        skills: ['triage'],
        githubLogin: null,
        minBuyerMerges: 1,
      });
      const res = await postSigned(baseUrl, '/jobs', {
        agentDid: agentIdentity.did,
        repository: 'buyer/target-repo',
        brief: 'Fix the login bug',
      }, buyer);
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body.error)).toContain('minBuyerMerges');
      expect(String(body.error)).toContain('0');
    } finally {
      server.close();
    }
  });

  // A DID that is registered as an AGENT but never as an Account can still
  // sign a request directly (R-34: the signer's own DID IS the acting
  // party, with no Account lookup in between). That DID resolves to no
  // Account row and therefore no githubLogin at all - the unkeyed buyer
  // this whole card exists to raise the cost of.
  it('a buyer DID with no registered Account at all (no verified GitHub account) fails any set threshold: not an exemption, not a pass, not a crash', async () => {
    const { server, baseUrl, accountRepo, agentRepo } = await buildApp();
    try {
      const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(17));
      const agentIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(18));
      const unkeyedBuyer = await signingIdentityFromSeed(new Uint8Array(32).fill(19));
      await accountRepo.register({ did: operator.did, githubLogin: 'operator-p7-unkeyed' });
      // The unkeyed buyer is registered ONLY as an agent (a cheap,
      // GitHub-free registration), never as an Account.
      await agentRepo.create({
        did: unkeyedBuyer.did,
        operatorDid: operator.did,
        delegation: delegationFixture(unkeyedBuyer.did, operator.did) as never,
        name: 'throwaway-buyer-identity',
        skills: ['triage'],
        githubLogin: null,
      });
      await agentRepo.create({
        did: agentIdentity.did,
        operatorDid: operator.did,
        delegation: delegationFixture(agentIdentity.did, operator.did) as never,
        name: 'scout',
        skills: ['triage'],
        githubLogin: null,
        minBuyerMerges: 1,
      });
      const res = await postSigned(baseUrl, '/jobs', {
        agentDid: agentIdentity.did,
        repository: 'buyer/target-repo',
        brief: 'Fix the login bug',
      }, unkeyedBuyer);
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body.error)).toContain('minBuyerMerges');
      expect(String(body.error)).toContain('no verified GitHub account');
    } finally {
      server.close();
    }
  });

  it('a buyer who meets minBuyerMerges after enough completed hires (against an unfiltered agent) passes', async () => {
    const { server, baseUrl, accountRepo, agentRepo, jobRepo } = await buildApp();
    try {
      const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(21));
      const helperAgent = await signingIdentityFromSeed(new Uint8Array(32).fill(22));
      const gatedAgent = await signingIdentityFromSeed(new Uint8Array(32).fill(23));
      const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(24));
      await accountRepo.register({ did: operator.did, githubLogin: 'operator-p7-met' });
      await accountRepo.register({ did: buyer.did, githubLogin: 'buyer-p7-met' });
      // The helper agent carries no filter: the buyer builds up its merge
      // count against it first, since the gated agent below would refuse
      // the buyer's own history-building hires the same way it refuses
      // the final one.
      await agentRepo.create({
        did: helperAgent.did,
        operatorDid: operator.did,
        delegation: delegationFixture(helperAgent.did, operator.did) as never,
        name: 'helper',
        skills: ['triage'],
        githubLogin: null,
      });
      await agentRepo.create({
        did: gatedAgent.did,
        operatorDid: operator.did,
        delegation: delegationFixture(gatedAgent.did, operator.did) as never,
        name: 'scout',
        skills: ['triage'],
        githubLogin: null,
        minBuyerMerges: 1,
      });
      const draft = await postSigned(baseUrl, '/jobs', {
        agentDid: helperAgent.did,
        repository: 'buyer/target-repo',
        brief: 'Fix a prior bug',
      }, buyer);
      expect(draft.status).toBe(201);
      const draftBody = (await draft.json()) as Record<string, unknown>;
      const priorJob = await jobRepo.findById(String(draftBody.id));
      if (priorJob === null) throw new Error('expected the drafted job to be stored');
      await jobRepo.complete(
        { ...priorJob, status: 'completed', mergeCommit: 'merge-prior', mergedAt: new Date() },
        { jobId: priorJob.id, buyerDid: buyer.did, agentDid: helperAgent.did, mergeCommit: 'merge-prior', completedAt: new Date() },
      );

      const res = await postSigned(baseUrl, '/jobs', {
        agentDid: gatedAgent.did,
        repository: 'buyer/target-repo',
        brief: 'A fresh job after one merge',
      }, buyer);
      expect(res.status).toBe(201);
    } finally {
      server.close();
    }
  });

  it('a buyer over maxWalkedAfterConfirm fails with 403, naming the threshold and the actual count', async () => {
    const { server, baseUrl, accountRepo, agentRepo, jobRepo } = await buildApp();
    try {
      const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(25));
      const agentIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(26));
      const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(27));
      await accountRepo.register({ did: operator.did, githubLogin: 'operator-p7-walked' });
      await accountRepo.register({ did: buyer.did, githubLogin: 'buyer-p7-walked' });
      await agentRepo.create({
        did: agentIdentity.did,
        operatorDid: operator.did,
        delegation: delegationFixture(agentIdentity.did, operator.did) as never,
        name: 'scout',
        skills: ['triage'],
        githubLogin: null,
        maxWalkedAfterConfirm: 0,
      });

      // A confirmed job the buyer then withdrew from, planted directly
      // (the withdraw route itself is out of this suite's scope).
      const draft = await postSigned(baseUrl, '/jobs', {
        agentDid: agentIdentity.did,
        repository: 'buyer/target-repo',
        brief: 'Fix a bug then walk away',
      }, buyer);
      const draftBody = (await draft.json()) as Record<string, unknown>;
      const walkedJob = await jobRepo.findById(String(draftBody.id));
      if (walkedJob === null) throw new Error('expected the drafted job to be stored');
      await jobRepo.update({ ...walkedJob, status: 'withdrawn', confirmedAt: new Date() });

      const res = await postSigned(baseUrl, '/jobs', {
        agentDid: agentIdentity.did,
        repository: 'buyer/target-repo',
        brief: 'A second job attempt',
      }, buyer);
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body.error)).toContain('maxWalkedAfterConfirm');
    } finally {
      server.close();
    }
  });
});

// Scope item 6: the public read route serving a buyer's conduct record by
// GitHub login. Counts only, never job ids, repositories, briefs, or
// counterparties.
describe('GET /buyers/:githubLogin/conduct (P7)', () => {
  async function buildApp(): Promise<{
    server: Server;
    baseUrl: string;
    accountRepo: MemoryAccountRepository;
    agentRepo: MemoryAgentRepository;
    jobRepo: MemoryJobRepository;
  }> {
    const accountRepo = new MemoryAccountRepository();
    const agentRepo = new MemoryAgentRepository();
    const jobRepo = new MemoryJobRepository();
    const app = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo);
    const { server, baseUrl } = await listen(app);
    return { server, baseUrl, accountRepo, agentRepo, jobRepo };
  }

  it('a buyer with no verified GitHub account reads as not-keyed, never as clean counts', async () => {
    const { server, baseUrl } = await buildApp();
    try {
      const res = await fetch(`${baseUrl}/buyers/never-registered-login/conduct`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.keyed).toBe(false);
      expect(body.counts).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('a keyed buyer with jobs reports the counts, and nothing else (no job ids, repos, briefs, counterparties)', async () => {
    const { server, baseUrl, accountRepo, agentRepo, jobRepo } = await buildApp();
    try {
      const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(31));
      const agentIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(32));
      const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(33));
      await accountRepo.register({ did: operator.did, githubLogin: 'operator-p7-read' });
      await accountRepo.register({ did: buyer.did, githubLogin: 'buyer-p7-read' });
      await agentRepo.create({
        did: agentIdentity.did,
        operatorDid: operator.did,
        delegation: delegationFixture(agentIdentity.did, operator.did) as never,
        name: 'scout',
        skills: ['triage'],
        githubLogin: null,
      });
      const draft = await postSigned(baseUrl, '/jobs', {
        agentDid: agentIdentity.did,
        repository: 'buyer/target-repo',
        brief: 'A brief nobody should see on the conduct read',
      }, buyer);
      const draftBody = (await draft.json()) as Record<string, unknown>;
      const job = await jobRepo.findById(String(draftBody.id));
      if (job === null) throw new Error('expected the drafted job to be stored');
      await jobRepo.complete(
        { ...job, status: 'completed', mergeCommit: 'merge-conduct-read', mergedAt: new Date() },
        { jobId: job.id, buyerDid: buyer.did, agentDid: agentIdentity.did, mergeCommit: 'merge-conduct-read', completedAt: new Date() },
      );

      const res = await fetch(`${baseUrl}/buyers/buyer-p7-read/conduct`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.keyed).toBe(true);
      expect((body.counts as Record<string, unknown>).merged).toBe(1);
      expect(JSON.stringify(body)).not.toContain('target-repo');
      expect(JSON.stringify(body)).not.toContain('A brief nobody should see');
      expect(JSON.stringify(body)).not.toContain(agentIdentity.did);
      expect(JSON.stringify(body)).not.toContain(String(draftBody.id));
    } finally {
      server.close();
    }
  });

  it('503 when the job repository throws', async () => {
    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: 'did:abt:zBuyer503', githubLogin: 'buyer-p7-503' });
    const failingJobRepo = {
      create: () => Promise.reject(new Error('unused')),
      update: () => Promise.reject(new Error('unused')),
      findById: () => Promise.reject(new Error('unused')),
      complete: () => Promise.reject(new Error('unused')),
      findCompletedByJobId: () => Promise.reject(new Error('unused')),
      findByBuyerDid: () => Promise.reject(new Error('db down')),
    };
    const app = createApp(accountRepo, new MemoryAgentRepository(), undefined, undefined, failingJobRepo as never);
    const { server, baseUrl } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/buyers/buyer-p7-503/conduct`);
      expect(res.status).toBe(503);
    } finally {
      server.close();
    }
  });

  // P8r scope item 3: the operator half joins the same route. keyed:
  // false still answers neither counts object at all.
  it('an unkeyed login answers neither counts nor operatorCounts', async () => {
    const { server, baseUrl } = await buildApp();
    try {
      const res = await fetch(`${baseUrl}/buyers/never-registered-login-p8r/conduct`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.keyed).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(body, 'counts')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(body, 'operatorCounts')).toBe(false);
    } finally {
      server.close();
    }
  });

  // Done-means item 9: an account that operates no agents at all still
  // answers keyed: true with both operator counts at zero, a real zero
  // distinct from the unkeyed answer above.
  it('a keyed account with no agents of its own answers operatorCounts at zero, distinct from unkeyed', async () => {
    const { server, baseUrl, accountRepo } = await buildApp();
    try {
      await accountRepo.register({ did: 'did:abt:zNoAgents', githubLogin: 'buyer-p8r-no-agents' });
      const res = await fetch(`${baseUrl}/buyers/buyer-p8r-no-agents/conduct`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.keyed).toBe(true);
      expect(body.operatorCounts).toEqual({ deliveredNeverPaid: 0, redosRefused: 0 });
    } finally {
      server.close();
    }
  });

  // Done-means item 7: operatorCounts sits beside counts, never merged
  // into one object, and no field blends the two sides.
  it('a keyed account with a job as buyer AND an agent it operates reports both objects, never merged', async () => {
    const { server, baseUrl, accountRepo, agentRepo, jobRepo } = await buildApp();
    try {
      const account = await signingIdentityFromSeed(new Uint8Array(32).fill(41));
      const otherOperator = await signingIdentityFromSeed(new Uint8Array(32).fill(42));
      const ownAgent = await signingIdentityFromSeed(new Uint8Array(32).fill(43));
      const hiringAgent = await signingIdentityFromSeed(new Uint8Array(32).fill(44));
      await accountRepo.register({ did: account.did, githubLogin: 'buyer-and-operator-p8r' });
      await accountRepo.register({ did: otherOperator.did, githubLogin: 'other-operator-p8r' });

      // The account's OWN agent, which gets hired and delivers work the
      // buyer on that job never pays for.
      await agentRepo.create({
        did: ownAgent.did,
        operatorDid: account.did,
        delegation: delegationFixture(ownAgent.did, account.did) as never,
        name: 'own-agent',
        skills: ['triage'],
        githubLogin: null,
      });
      // A stranger's agent the account hires as a BUYER, unrelated to the
      // operator side.
      await agentRepo.create({
        did: hiringAgent.did,
        operatorDid: otherOperator.did,
        delegation: delegationFixture(hiringAgent.did, otherOperator.did) as never,
        name: 'hiring-agent',
        skills: ['triage'],
        githubLogin: null,
      });

      const buyerJobDraft = await postSigned(baseUrl, '/jobs', {
        agentDid: hiringAgent.did,
        repository: 'buyer/target-repo',
        brief: 'The buyer side of this account',
      }, account);
      const buyerJobBody = (await buyerJobDraft.json()) as Record<string, unknown>;
      const buyerJob = await jobRepo.findById(String(buyerJobBody.id));
      if (buyerJob === null) throw new Error('expected the buyer-side job to be stored');
      await jobRepo.complete(
        { ...buyerJob, status: 'completed', mergeCommit: 'merge-buyer-side', mergedAt: new Date() },
        { jobId: buyerJob.id, buyerDid: account.did, agentDid: hiringAgent.did, mergeCommit: 'merge-buyer-side', completedAt: new Date() },
      );

      const operatorJobDraft = await postSigned(baseUrl, '/jobs', {
        agentDid: ownAgent.did,
        repository: 'stranger/target-repo',
        brief: 'The operator side of this account',
      }, otherOperator);
      const operatorJobBody = (await operatorJobDraft.json()) as Record<string, unknown>;
      const operatorJob = await jobRepo.findById(String(operatorJobBody.id));
      if (operatorJob === null) throw new Error('expected the operator-side job to be stored');
      await jobRepo.update({ ...operatorJob, status: 'staged_declined' });

      const res = await fetch(`${baseUrl}/buyers/buyer-and-operator-p8r/conduct`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.keyed).toBe(true);
      expect((body.counts as Record<string, unknown>).merged).toBe(1);
      expect(body.operatorCounts).toEqual({ deliveredNeverPaid: 1, redosRefused: 0 });
      // The two sides are never summed and never share a field: neither
      // object carries a key that belongs to the other.
      expect(Object.keys(body.counts as Record<string, unknown>).sort()).toEqual(
        [
          'confirmed',
          'walkedAfterConfirm',
          'stagedDeclined',
          'closedUnpaid',
          'merged',
          'deemed',
          'closedUnmerged',
          'citedCloses',
          'redosRequested',
        ].sort(),
      );
      expect(Object.keys(body).sort()).toEqual(['counts', 'githubLogin', 'keyed', 'operatorCounts'].sort());
    } finally {
      server.close();
    }
  });

  // Done-means item 10: a driver missing listAll or findByAgentDid is
  // 503, never a silent zeroed record.
  it('503, not a zeroed record, when the agent driver has no listAll', async () => {
    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: 'did:abt:zNoListAll', githubLogin: 'buyer-p8r-no-listall' });
    const agentRepoWithoutListAll = {
      create: () => Promise.reject(new Error('unused')),
      findByDid: () => Promise.reject(new Error('unused')),
      updateGithubBinding: () => Promise.reject(new Error('unused')),
      recordKeyRotation: () => Promise.reject(new Error('unused')),
    };
    const app = createApp(accountRepo, agentRepoWithoutListAll as never, undefined, undefined, new MemoryJobRepository());
    const { server, baseUrl } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/buyers/buyer-p8r-no-listall/conduct`);
      expect(res.status).toBe(503);
    } finally {
      server.close();
    }
  });

  it('503, not a zeroed record, when the job driver has no findByAgentDid', async () => {
    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: 'did:abt:zNoFindByAgent', githubLogin: 'buyer-p8r-no-findbyagent' });
    const jobRepoWithoutFindByAgentDid = {
      create: () => Promise.reject(new Error('unused')),
      update: () => Promise.reject(new Error('unused')),
      findById: () => Promise.reject(new Error('unused')),
      complete: () => Promise.reject(new Error('unused')),
      findCompletedByJobId: () => Promise.reject(new Error('unused')),
      findByBuyerDid: () => Promise.resolve([]),
    };
    const app = createApp(accountRepo, new MemoryAgentRepository(), undefined, undefined, jobRepoWithoutFindByAgentDid as never);
    const { server, baseUrl } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/buyers/buyer-p8r-no-findbyagent/conduct`);
      expect(res.status).toBe(503);
    } finally {
      server.close();
    }
  });

  // Mutation proof 4: the roster filter must be the exact operatorDid
  // comparison GET /accounts/:did/agents already uses, never
  // isAgentOperator's didSuffix match. Two accounts whose DID suffixes
  // collide (one with the did:abt: prefix, one without) must never let
  // the second account's agent leak into the first account's roster.
  it('the roster filter is exact operatorDid equality: a suffix-colliding operatorDid never joins the roster', async () => {
    const { server, baseUrl, accountRepo, agentRepo, jobRepo } = await buildApp();
    try {
      const realOperator = await signingIdentityFromSeed(new Uint8Array(32).fill(45));
      const suffixOnlyDid = didSuffix(realOperator.did);
      await accountRepo.register({ did: realOperator.did, githubLogin: 'operator-p8r-suffix-real' });

      // An agent whose stored operatorDid is the SUFFIX form, not the
      // full did:abt: form the account actually holds. isAgentOperator
      // would match this (didSuffix comparison); the exact comparison
      // this route is required to use must not.
      const impostorAgent = await signingIdentityFromSeed(new Uint8Array(32).fill(46));
      await agentRepo.create({
        did: impostorAgent.did,
        operatorDid: suffixOnlyDid,
        delegation: delegationFixture(impostorAgent.did, suffixOnlyDid) as never,
        name: 'impostor',
        skills: ['triage'],
        githubLogin: null,
      });
      const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(47));
      await accountRepo.register({ did: buyer.did, githubLogin: 'buyer-p8r-suffix-collision' });
      const draft = await postSigned(baseUrl, '/jobs', {
        agentDid: impostorAgent.did,
        repository: 'buyer/target-repo',
        brief: 'A job on the impostor agent',
      }, buyer);
      const draftBody = (await draft.json()) as Record<string, unknown>;
      const impostorJob = await jobRepo.findById(String(draftBody.id));
      if (impostorJob === null) throw new Error('expected the impostor job to be stored');
      await jobRepo.update({ ...impostorJob, status: 'closed_unpaid' });

      const res = await fetch(`${baseUrl}/buyers/operator-p8r-suffix-real/conduct`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.keyed).toBe(true);
      expect(body.operatorCounts).toEqual({ deliveredNeverPaid: 0, redosRefused: 0 });
    } finally {
      server.close();
    }
  });

  // Done-means item 11: one account's operator counts read only jobs on
  // agents it operates. A second account whose agent also has jobs must
  // never leak into the first account's operatorCounts.
  it("one account's operator counts never include a second account's agent's jobs", async () => {
    const { server, baseUrl, accountRepo, agentRepo, jobRepo } = await buildApp();
    try {
      const operatorA = await signingIdentityFromSeed(new Uint8Array(32).fill(51));
      const operatorB = await signingIdentityFromSeed(new Uint8Array(32).fill(52));
      const agentA = await signingIdentityFromSeed(new Uint8Array(32).fill(53));
      const agentB = await signingIdentityFromSeed(new Uint8Array(32).fill(54));
      const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(55));
      await accountRepo.register({ did: operatorA.did, githubLogin: 'operator-a-p8r' });
      await accountRepo.register({ did: operatorB.did, githubLogin: 'operator-b-p8r' });
      await accountRepo.register({ did: buyer.did, githubLogin: 'buyer-for-isolation-p8r' });
      await agentRepo.create({
        did: agentA.did,
        operatorDid: operatorA.did,
        delegation: delegationFixture(agentA.did, operatorA.did) as never,
        name: 'agent-a',
        skills: ['triage'],
        githubLogin: null,
      });
      await agentRepo.create({
        did: agentB.did,
        operatorDid: operatorB.did,
        delegation: delegationFixture(agentB.did, operatorB.did) as never,
        name: 'agent-b',
        skills: ['triage'],
        githubLogin: null,
      });

      const draftB = await postSigned(baseUrl, '/jobs', {
        agentDid: agentB.did,
        repository: 'buyer/target-repo-b',
        brief: 'A job on operator B agent',
      }, buyer);
      const draftBBody = (await draftB.json()) as Record<string, unknown>;
      const jobB = await jobRepo.findById(String(draftBBody.id));
      if (jobB === null) throw new Error('expected job B to be stored');
      await jobRepo.update({ ...jobB, status: 'closed_unpaid' });

      const res = await fetch(`${baseUrl}/buyers/operator-a-p8r/conduct`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.keyed).toBe(true);
      expect(body.operatorCounts).toEqual({ deliveredNeverPaid: 0, redosRefused: 0 });
    } finally {
      server.close();
    }
  });
});
