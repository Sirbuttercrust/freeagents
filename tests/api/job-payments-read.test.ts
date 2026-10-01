// GET /jobs/:jobId/payments tells either side of a hire which payments
// settled. Every assertion here fails without the route, the party check, the
// four-key leg shape, the per-leg read, the 503 on a storage failure or the
// rule that a plain read moves nothing.
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import type { SessionAdapter } from '../../src/adapters/identity/session.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryJobRepository,
  MemorySettlementRepository,
} from '../../src/adapters/storage/memory.js';
import type { ObservedSettlementRecord } from '../../src/adapters/storage/types.js';
import { createJob } from '../../src/domain/job.js';
import type { Job } from '../../src/domain/job.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSessionToken } from '../helpers/session-fixtures.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { depositSettledGate } from '../helpers/settlement-fixtures.js';

const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(211));
const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(212));
const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(213));

const OWNER_DID = 'did:abt:op-payments-read';
const BUYER_LOGIN = 'payments-read-buyer';
const OWNER_LOGIN = 'payments-read-owner';
const STRANGER_LOGIN = 'payments-read-stranger';

// The sentences resolveJobActingParty answers with.
const UNSIGNED_SENTENCE =
  "this route requires a session (sign in with GitHub OAuth or a passkey) or a verified request signature (R-34); sign in, or sign the request naming this job's buyer or agent DID";
const NOT_A_PARTY_BY_SIGNATURE = 'signature does not name a party to this job';
const NOT_A_PARTY_BY_SESSION = 'the authenticated party is not a party to this job';

const DEPOSIT_RECORD: ObservedSettlementRecord = {
  jobId: 'set-per-test',
  leg: 'deposit',
  rail: 'usdc',
  hash: '0xdeposit-transfer-hash',
  secondaryHash: '0xdeposit-fee-hash',
  operatorAddress: '0xAbCdEf0000000000000000000000000000000001',
  feeAddress: '0xFee0000000000000000000000000000000000001',
  amountUsd: '300.00',
  observedAt: new Date('2026-09-30T12:00:00.000Z'),
};
const REMAINDER_RECORD: ObservedSettlementRecord = {
  jobId: 'set-per-test',
  leg: 'remainder',
  rail: 'usdc',
  hash: '0xremainder-transfer-hash',
  secondaryHash: '0xremainder-fee-hash',
  operatorAddress: '0xAbCdEf0000000000000000000000000000000002',
  feeAddress: '0xFee0000000000000000000000000000000000002',
  amountUsd: '700.00',
  observedAt: new Date('2026-10-01T08:30:00.000Z'),
};

// The wire shape of a leg: the four facts and nothing else.
const DEPOSIT_LEG = {
  rail: 'usdc',
  amountUsd: '300.00',
  operatorAddress: '0xAbCdEf0000000000000000000000000000000001',
  observedAt: '2026-09-30T12:00:00.000Z',
};
const REMAINDER_LEG = {
  rail: 'usdc',
  amountUsd: '700.00',
  operatorAddress: '0xAbCdEf0000000000000000000000000000000002',
  observedAt: '2026-10-01T08:30:00.000Z',
};

// GET /jobs/:jobId answers these keys, measured on the read as it stood
// before the payments route existed, for a staged job and for a proposed job
// with a price. They are written out so a third party's read is held to what
// it answered then: nothing about a payment joins it.
const PUBLIC_KEYS_STAGED = [
  'agentDid', 'brief', 'briefHash', 'buyerDid', 'createdAt', 'githubAccessNeeded', 'id', 'price',
  'pullRequestTemplate', 'repository', 'stagedAt', 'stagedCommit', 'status',
];
const PUBLIC_KEYS_PROPOSED = [
  'agentDid', 'brief', 'briefHash', 'buyerDid', 'createdAt', 'depositSettled', 'githubAccessNeeded', 'id',
  'payableRails', 'price', 'repository', 'status',
];

interface Started {
  readonly server: Server;
  readonly baseUrl: string;
  readonly jobRepo: MemoryJobRepository;
  readonly settlementRepo: MemorySettlementRepository;
  readonly sessionFor: (login: string) => Promise<{ authorization: string }>;
}

class ControlledJobRepository extends MemoryJobRepository {
  throwOnFind = false;
  override async findById(id: string): Promise<Job | null> {
    if (this.throwOnFind) throw new Error('job storage down');
    return super.findById(id);
  }
}

class ControlledSettlementRepository extends MemorySettlementRepository {
  throwOnLeg: 'deposit' | 'remainder' | null = null;
  override async findByJobAndLeg(jobId: string, leg: 'deposit' | 'remainder'): Promise<ObservedSettlementRecord | null> {
    if (this.throwOnLeg === leg) throw new Error('settlement storage down');
    return super.findByJobAndLeg(jobId, leg);
  }
}

async function getSigned(baseUrl: string, path: string, identity: SigningIdentity): Promise<Response> {
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, 'GET', targetUri, {});
  return fetch(targetUri, {
    headers: {
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
  });
}

async function startApp(): Promise<Started & { readonly controlledJobs: ControlledJobRepository; readonly controlledSettlement: ControlledSettlementRepository }> {
  const accountRepo = new MemoryAccountRepository();
  await accountRepo.register({ did: buyer.did, githubLogin: BUYER_LOGIN });
  await accountRepo.register({ did: stranger.did, githubLogin: STRANGER_LOGIN });
  await accountRepo.register({ did: OWNER_DID, githubLogin: OWNER_LOGIN });
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: agent.did,
    operatorDid: OWNER_DID,
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: 'scout-payments-read',
    negotiatesOnOwnersBehalf: true,
  });
  await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-payments-read', status: 'verified' });
  const jobRepo = new ControlledJobRepository();
  const settlementRepo = new ControlledSettlementRepository();

  // One session adapter, signed in as whichever login the test names, so the
  // buyer's, the owner's and a stranger's sessions all resolve in one app.
  let signingInAs = BUYER_LOGIN;
  const sessionAdapter: SessionAdapter = createSessionAdapter({
    github: fakeGitHubConfig(),
    fetchImpl: ((input: string | URL | Request, init?: RequestInit) =>
      fakeGitHubFetch({ login: signingInAs, id: 1 + signingInAs.length })(input, init)) as typeof fetch,
  });
  const sessionFor = async (login: string): Promise<{ authorization: string }> => {
    signingInAs = login;
    return { authorization: `Bearer ${await mintSessionToken(sessionAdapter)}` };
  };

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
    sessionAdapter,
    undefined,
    depositSettledGate(),
    undefined,
    undefined,
    undefined,
    null,
    settlementRepo,
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    jobRepo,
    settlementRepo,
    sessionFor,
    controlledJobs: jobRepo,
    controlledSettlement: settlementRepo,
  };
}

let jobCounter = 0;
async function plantJob(
  started: Started,
  overrides: Partial<Job> = {},
): Promise<string> {
  jobCounter += 1;
  const id = `payments-read-job-${jobCounter}`;
  const base = createJob(
    { id, buyerDid: buyer.did, agentDid: agent.did, repository: 'buyer/target-repo', brief: 'Fix the login bug' },
    new Date(),
  );
  await started.jobRepo.create({ ...base, ...overrides });
  return id;
}

function stagedOverrides(stagedAt: Date): Partial<Job> {
  return {
    status: 'staged',
    priceUsd: '1000.00',
    rail: 'usdc',
    priceAcceptedByBuyer: true,
    priceAcceptedByAgent: true,
    confirmedAt: new Date(stagedAt.getTime() - 86_400_000),
    stagedAt,
    stagedCommit: 'commit-payments-read',
  };
}

async function settle(started: Started, jobId: string, ...records: ObservedSettlementRecord[]): Promise<void> {
  for (const record of records) await started.settlementRepo.record({ ...record, jobId });
}

let active: Awaited<ReturnType<typeof startApp>> | null = null;
afterEach(async () => {
  if (active !== null) {
    await new Promise<void>((resolve) => active!.server.close(() => resolve()));
    active = null;
  }
});

describe('GET /jobs/:jobId/payments: who may ask', () => {
  it('(a) an unknown job is a JSON 404', async () => {
    active = await startApp();
    const res = await getSigned(active.baseUrl, '/jobs/never-existed/payments', buyer);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('(b) no session and no signature is 401 with the whole sentence', async () => {
    active = await startApp();
    const jobId = await plantJob(active, stagedOverrides(new Date()));
    const res = await fetch(`${active.baseUrl}/jobs/${jobId}/payments`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: UNSIGNED_SENTENCE });
  });

  it('(c) a registered account that is not a party is 403 by signature', async () => {
    active = await startApp();
    const jobId = await plantJob(active, stagedOverrides(new Date()));
    await settle(active, jobId, DEPOSIT_RECORD);
    const res = await getSigned(active.baseUrl, `/jobs/${jobId}/payments`, stranger);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: NOT_A_PARTY_BY_SIGNATURE });
  });

  it('(c) a registered account that is not a party is 403 by session', async () => {
    active = await startApp();
    const jobId = await plantJob(active, stagedOverrides(new Date()));
    await settle(active, jobId, DEPOSIT_RECORD);
    const res = await fetch(`${active.baseUrl}/jobs/${jobId}/payments`, { headers: await active.sessionFor(STRANGER_LOGIN) });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: NOT_A_PARTY_BY_SESSION });
  });

  it("(d) the buyer's session gets 200", async () => {
    active = await startApp();
    const jobId = await plantJob(active, stagedOverrides(new Date()));
    const res = await fetch(`${active.baseUrl}/jobs/${jobId}/payments`, { headers: await active.sessionFor(BUYER_LOGIN) });
    expect(res.status).toBe(200);
  });

  it("(d) the agent's owner's session gets 200", async () => {
    active = await startApp();
    const jobId = await plantJob(active, stagedOverrides(new Date()));
    const res = await fetch(`${active.baseUrl}/jobs/${jobId}/payments`, { headers: await active.sessionFor(OWNER_LOGIN) });
    expect(res.status).toBe(200);
  });

  it("(d) the agent's own key gets 200", async () => {
    active = await startApp();
    const jobId = await plantJob(active, stagedOverrides(new Date()));
    const res = await getSigned(active.baseUrl, `/jobs/${jobId}/payments`, agent);
    expect(res.status).toBe(200);
  });
});

describe('GET /jobs/:jobId/payments: what it answers', () => {
  it('(e) nothing settled is both legs null', async () => {
    active = await startApp();
    const jobId = await plantJob(active, stagedOverrides(new Date()));
    const res = await getSigned(active.baseUrl, `/jobs/${jobId}/payments`, buyer);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deposit: null, remainder: null });
  });

  it('(f) a settled USDC deposit is the deposit leg exactly, with the remainder null', async () => {
    active = await startApp();
    const jobId = await plantJob(active, stagedOverrides(new Date()));
    await settle(active, jobId, DEPOSIT_RECORD);
    const res = await getSigned(active.baseUrl, `/jobs/${jobId}/payments`, buyer);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deposit: DEPOSIT_LEG, remainder: null });
  });

  it('(g) both legs settled: each leg is its own record, the remainder never the deposit', async () => {
    active = await startApp();
    const jobId = await plantJob(active, stagedOverrides(new Date()));
    await settle(active, jobId, DEPOSIT_RECORD, REMAINDER_RECORD);
    const res = await getSigned(active.baseUrl, `/jobs/${jobId}/payments`, agent);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deposit: DEPOSIT_LEG, remainder: REMAINDER_LEG });
  });

  it("another job's settled legs never show on this job", async () => {
    active = await startApp();
    const other = await plantJob(active, stagedOverrides(new Date()));
    const jobId = await plantJob(active, stagedOverrides(new Date()));
    await settle(active, other, DEPOSIT_RECORD, REMAINDER_RECORD);
    const res = await getSigned(active.baseUrl, `/jobs/${jobId}/payments`, buyer);
    expect(await res.json()).toEqual({ deposit: null, remainder: null });
  });
});

describe('GET /jobs/:jobId/payments: a storage failure is never a guess', () => {
  it('(h) the job read throwing is 503', async () => {
    active = await startApp();
    const jobId = await plantJob(active, stagedOverrides(new Date()));
    active.controlledJobs.throwOnFind = true;
    const res = await getSigned(active.baseUrl, `/jobs/${jobId}/payments`, buyer);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'storage unavailable' });
  });

  it('(h) the deposit settlement read throwing is 503', async () => {
    active = await startApp();
    const jobId = await plantJob(active, stagedOverrides(new Date()));
    await settle(active, jobId, DEPOSIT_RECORD, REMAINDER_RECORD);
    active.controlledSettlement.throwOnLeg = 'deposit';
    const res = await getSigned(active.baseUrl, `/jobs/${jobId}/payments`, buyer);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'storage unavailable' });
  });

  it('(h) the remainder settlement read throwing is 503', async () => {
    active = await startApp();
    const jobId = await plantJob(active, stagedOverrides(new Date()));
    await settle(active, jobId, DEPOSIT_RECORD, REMAINDER_RECORD);
    active.controlledSettlement.throwOnLeg = 'remainder';
    const res = await getSigned(active.baseUrl, `/jobs/${jobId}/payments`, buyer);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'storage unavailable' });
  });
});

describe('GET /jobs/:jobId/payments: a plain read moves nothing', () => {
  const EIGHT_DAYS_AGO = (): Date => new Date(Date.now() - 8 * 86_400_000);

  it('(i) a staged job past its window is read with 200 and keeps its stored status', async () => {
    active = await startApp();
    const jobId = await plantJob(active, stagedOverrides(EIGHT_DAYS_AGO()));
    const before = structuredClone(await active.jobRepo.findById(jobId));
    const res = await getSigned(active.baseUrl, `/jobs/${jobId}/payments`, buyer);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deposit: null, remainder: null });
    expect((await active.jobRepo.findById(jobId))?.status).toBe('staged');
    expect(await active.jobRepo.findById(jobId)).toEqual(before);
  });

  it('(i) the same job is genuinely past its window: the public read lapses it', async () => {
    active = await startApp();
    const jobId = await plantJob(active, stagedOverrides(EIGHT_DAYS_AGO()));
    const res = await fetch(`${active.baseUrl}/jobs/${jobId}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('closed_unpaid');
    expect((await active.jobRepo.findById(jobId))?.status).toBe('closed_unpaid');
  });
});

describe('invariant 2: the public GET /jobs/:jobId is what it was', () => {
  it('(j) answers the same keys on a staged job, whatever has settled', async () => {
    active = await startApp();
    const none = await plantJob(active, stagedOverrides(new Date()));
    const depositOnly = await plantJob(active, stagedOverrides(new Date()));
    const both = await plantJob(active, stagedOverrides(new Date()));
    await settle(active, depositOnly, DEPOSIT_RECORD);
    await settle(active, both, DEPOSIT_RECORD, REMAINDER_RECORD);
    for (const jobId of [none, depositOnly, both]) {
      await getSigned(active.baseUrl, `/jobs/${jobId}/payments`, buyer);
      const res = await fetch(`${active.baseUrl}/jobs/${jobId}`);
      expect(res.status).toBe(200);
      expect(Object.keys((await res.json()) as object).sort()).toEqual(PUBLIC_KEYS_STAGED);
    }
  });

  it('(j) a proposed job still answers its own extra keys and no payment key', async () => {
    active = await startApp();
    const jobId = await plantJob(active, { status: 'proposed', priceUsd: '1000.00', rail: 'usdc' });
    await settle(active, jobId, DEPOSIT_RECORD);
    const res = await fetch(`${active.baseUrl}/jobs/${jobId}`);
    expect(res.status).toBe(200);
    const keys = Object.keys((await res.json()) as object).sort();
    expect(keys).toEqual(PUBLIC_KEYS_PROPOSED);
  });
});
