// FIX-B37 (bugs.md B37 + B42): every door that starts a deposit refuses
// what confirm would refuse, before any money moves. Confirm (app.ts
// POST /jobs/:jobId/confirm) has always checked more than the three
// deposit-start doors did: the agreement (confirmSpec's own criteria and
// price gates), the agent's verified GitHub login (B42), and a sibling
// from the same brief already confirmed (HT1 Part A2). This file pins
// the new shared check (route-support.ts's checkDepositReadiness) across
// all three doors -- POST /jobs/:jobId/payments/deposit/abt/start, POST
// /jobs/:jobId/payments/deposit/usdc/start, and the token-mint door on
// /api/did/pay/token -- plus the ABT wallet callback's own re-check
// (abt-did-connect.ts's onAuth), which asks the identical questions again
// right before it would settle.
//
// Every new case here is red on origin/main bc6f2d3 first: none of these
// checks existed on any door before this card, so every assertion below
// fails against the unmodified doors (a 200 instead of the expected 409,
// or a broadcast that never should have happened).
import type { Server } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { fromRandom } from '@ocap/wallet';

import { createApp } from '../../src/api/app.js';
import { PrismaSettlementGate } from '../../src/adapters/payment/gate.js';
import { createUsdcPaymentRail, type UsdcChainClient, type UsdcPaymentRailShim } from '../../src/adapters/payment/usdc.js';
import { createAbtPaymentRail, type AbtChainClient } from '../../src/adapters/payment/abt.js';
import { didSuffix } from '../../src/domain/agent.js';
import type { UsdcSpentTransferRow, UsdcSpentTransferStorage } from '../../src/adapters/payment/usdc-spent-transfer-storage-types.js';
import type { GithubAdapter } from '../../src/adapters/github/types.js';
import type { Job } from '../../src/domain/job.js';
import type { JobRepository } from '../../src/adapters/storage/types.js';
import { MemorySettlementRepository, MemoryAgentRepository, MemoryJobRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import { signingIdentityFromSeed, signingIdentityFromWallet, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { abtEnv, reservePort, withEnv, pureTxEncoder, getSigned, driveAbtPayment, fakeAbtChainClient as fakeAbtWalletChainClient } from '../helpers/abt-fixtures.js';
import { publicBaseUrlFromEnv } from '../../src/adapters/credentials/credentials.js';

const USDC_TOKEN = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const USDC_FEE_ADDRESS = '0xFeeAddress000000000000000000000000000';
const USDC_OPERATOR_ADDRESS = '0xOperator000000000000000000000000000000';
const USDC_CHAIN_ID = 421614;

// The buyer is a WALLET-derived signing identity (not a bare seed
// identity, unlike tests/api/job-deposit-repository-check.test.ts): the
// onAuth block below must complete the real ABT wallet protocol as the
// SAME buyer who started the session (onAuth's own buyerDid check would
// otherwise refuse for the wrong reason before the new deposit-readiness
// checks are ever reached), so this file needs the actual WalletObject,
// not only its did:abt identity.
const buyerWallet = fromRandom();
const buyer = await signingIdentityFromWallet(buyerWallet);
const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(172));
const platformWallet = fromRandom();
const ABT_TOKEN = fromRandom().address;
const ABT_FEE_ADDRESS = fromRandom().address;

const twoLineProposal = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'agent' },
];

function usdcEnvVars(): Record<string, string> {
  return {
    FREEAGENTS_USDC_RPC_URL: 'https://sepolia-rollup.arbitrum.io/rpc',
    FREEAGENTS_USDC_TOKEN_CONTRACT: USDC_TOKEN,
    FREEAGENTS_USDC_CHAIN_ID: String(USDC_CHAIN_ID),
    FREEAGENTS_USDC_FEE_ADDRESS: USDC_FEE_ADDRESS,
  };
}
function fakeUsdcChainClient(): UsdcChainClient {
  return {
    decimals: async () => 6,
    getTransactionReceipt: async () => null,
  };
}
function fakeSpentTransferStorage(): UsdcSpentTransferStorage {
  const rows = new Map<string, UsdcSpentTransferRow>();
  return {
    async record(row) {
      rows.set(row.hash, { ...row });
    },
    async findByHash(hash) {
      return rows.get(hash) ?? null;
    },
  };
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

interface Started {
  readonly server: Server;
  readonly baseUrl: string;
  readonly settlementRepo: MemorySettlementRepository;
  readonly jobRepo: JobRepository;
  readonly agentRepo: MemoryAgentRepository;
  readonly quoteSpy: ReturnType<typeof vi.fn>;
}

interface AgentConfig {
  readonly githubLogin: string | null;
  readonly verified: boolean;
}

const VERIFIED_AGENT: AgentConfig = { githubLogin: 'scout-deposit-readiness', verified: true };

// Storage stand-in that omits findByRequestId, the exact shape the brief's
// own 503 case needs: "a job with a requestId on a driver without
// findByRequestId answers 503 and logs the cause" -- the same hand-rolled
// shape tests/api/job-multi-agent-request.test.ts's own
// NoRequestIdLookupJobRepository takes (create/update/findById/complete/
// findCompletedByJobId only, findByRequestId deliberately OMITTED).
class JobRepoWithoutSiblingLookup {
  private readonly rows = new Map<string, Job>();
  async create(job: Job): Promise<Job> {
    this.rows.set(job.id, { ...job });
    return { ...job };
  }
  async update(job: Job): Promise<Job | null> {
    if (!this.rows.has(job.id)) return null;
    this.rows.set(job.id, { ...job });
    return { ...job };
  }
  async findById(id: string): Promise<Job | null> {
    return this.rows.get(id) ?? null;
  }
  async complete(job: Job): Promise<Job | null> {
    if (!this.rows.has(job.id)) return null;
    this.rows.set(job.id, { ...job });
    return { ...job };
  }
  async findCompletedByJobId(): Promise<null> {
    return null;
  }
  // findByRequestId is deliberately OMITTED.
}

async function startApp(
  github: GithubAdapter,
  agentConfig: AgentConfig = VERIFIED_AGENT,
  jobRepoOverride?: JobRepository,
  abtChainClient?: AbtChainClient,
): Promise<Started> {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  return withEnv({ ...usdcEnvVars(), ...abtEnv(baseUrl, platformWallet, ABT_TOKEN, ABT_FEE_ADDRESS) }, async () => {
    const realUsdcRail = createUsdcPaymentRail({
      chainClient: fakeUsdcChainClient(),
      rateSource: async () => '1',
      halfPaidStorage: { record: async () => {}, read: async () => null, clear: async () => {} },
      spentTransferStorage: fakeSpentTransferStorage(),
    });
    // The rail's quote spy: the brief's own accept line ("nothing
    // started, the rail's quote or session mint spy at zero").
    const quoteSpy = vi.fn(realUsdcRail.quote.bind(realUsdcRail));
    const usdcRail: UsdcPaymentRailShim = { ...realUsdcRail, quote: quoteSpy };

    const abtSpentRows = new Map<string, { hash: string; jobId: string; leg: 'deposit' | 'balance' }>();
    const abtRail = createAbtPaymentRail({
      chainClient: abtChainClient ?? fakeAbtChainClientNoop(),
      rateSource: async () => '1',
      spentTransferStorage: {
        async record(row) {
          abtSpentRows.set(row.hash, { ...row });
        },
        async findByHash(hash) {
          return abtSpentRows.get(hash) ?? null;
        },
      },
    });

    const operatorRepo = new MemoryAccountRepository();
    await operatorRepo.register({ did: buyer.did, githubLogin: `buyer-deposit-readiness-${Math.random()}` });
    await operatorRepo.setOperatorAddressEvm(buyer.did, USDC_OPERATOR_ADDRESS);
    await operatorRepo.setOperatorAddressAbt(buyer.did, didSuffix(buyer.did));
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: buyer.did,
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: agentConfig.githubLogin,
      negotiatesOnOwnersBehalf: true,
    });
    if (agentConfig.verified && agentConfig.githubLogin !== null) {
      await agentRepo.updateGithubBinding(agent.did, { handle: agentConfig.githubLogin, status: 'verified' });
    }
    const jobRepo = jobRepoOverride ?? new MemoryJobRepository();
    const settlementRepo = new MemorySettlementRepository();
    const gate = new PrismaSettlementGate(settlementRepo);
    const app = createApp(
      operatorRepo,
      agentRepo,
      undefined,
      github,
      jobRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      gate,
      anyCommitStagingObserver(),
      undefined,
      abtRail,
      usdcRail,
      settlementRepo,
      pureTxEncoder,
    );
    const server = app.listen(port, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    return { server, baseUrl, settlementRepo, jobRepo, agentRepo, quoteSpy };
  });
}

function fakeAbtChainClientNoop(): AbtChainClient {
  return { getTransaction: async () => null } as unknown as AbtChainClient;
}

function readyGithub(): GithubAdapter {
  const { github } = createStagingLifecycleGithubFake();
  return github;
}

async function openJob(baseUrl: string, repository = 'buyer/target-repo', requestId?: string): Promise<string> {
  const created = await postSigned(baseUrl, '/jobs', {
    buyerDid: buyer.did,
    agentDid: agent.did,
    repository,
    brief: 'Fix the login bug',
  }, buyer);
  const body = (await created.json()) as Record<string, unknown>;
  const jobId = String(body.id);
  void requestId;
  return jobId;
}

async function proposeTwoLineCriteria(baseUrl: string, jobId: string, rail: 'usdc' | 'abt' = 'usdc'): Promise<void> {
  await postSigned(baseUrl, `/jobs/${jobId}/criteria`, { criteria: twoLineProposal, priceUsd: '500.00', rail }, agent);
}

// Walks a job all the way to fully signed: two criteria lines, both
// accepted by both parties, price accepted by both. Ready for a deposit
// to start on any door.
async function walkToFullySigned(baseUrl: string, repository = 'buyer/target-repo', rail: 'usdc' | 'abt' = 'usdc'): Promise<string> {
  const jobId = await openJob(baseUrl, repository);
  await proposeTwoLineCriteria(baseUrl, jobId, rail);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, agent);
  return jobId;
}

interface DoorCase {
  readonly name: string;
  readonly rail: 'usdc' | 'abt';
  readonly start: (baseUrl: string, jobId: string) => Promise<Response>;
}

const doors: readonly DoorCase[] = [
  {
    name: 'POST /jobs/:jobId/payments/deposit/usdc/start',
    rail: 'usdc',
    start: (baseUrl, jobId) => postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, {}, buyer),
  },
  {
    name: 'POST /jobs/:jobId/payments/deposit/abt/start',
    rail: 'abt',
    start: (baseUrl, jobId) => postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/abt/start`, {}, buyer),
  },
  {
    name: 'the token-mint door, GET /api/did/pay/token',
    rail: 'abt',
    start: (baseUrl, jobId) => getSigned(baseUrl, `/api/did/pay/token?jobId=${jobId}&leg=deposit`, buyer),
  },
];

async function assertRefusalStartsNothing(
  res: Response,
  settlementRepo: MemorySettlementRepository,
  quoteSpy: ReturnType<typeof vi.fn>,
  jobId: string,
  wholeSentence: string,
): Promise<void> {
  expect(res.status).toBe(409);
  const body = (await res.json()) as { error: string };
  // Asserted WHOLE, never a substring two sentences share.
  expect(body.error).toBe(wholeSentence);
  expect(quoteSpy).not.toHaveBeenCalled();
  expect(await settlementRepo.findByJobAndLeg(jobId, 'deposit')).toBeNull();
}

describe.each(doors)('$name: refuses criteria outstanding, 409, nothing started', (door) => {
  it('one line accepted by one party only answers 409 with the criteria-outstanding sentence, whole, and starts nothing', async () => {
    const { server, baseUrl, settlementRepo, quoteSpy } = await startApp(readyGithub());
    try {
      const jobId = await openJob(baseUrl);
      await proposeTwoLineCriteria(baseUrl, jobId, door.rail);
      // Only line 0, only the buyer's side.
      await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, buyer);
      await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, buyer);
      await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, agent);
      const res = await door.start(baseUrl, jobId);
      await assertRefusalStartsNothing(
        res,
        settlementRepo,
        quoteSpy,
        jobId,
        `the deposit can start only once both parties have signed every line of the agreement; ` +
          `2 of 2 lines still need both signatures: ${publicBaseUrlFromEnv()}/agreement?job=${jobId}`,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe.each(doors)('$name: refuses a price accepted by the buyer only, 409, nothing started', (door) => {
  it('answers 409 naming the agent still to sign, whole, and starts nothing', async () => {
    const { server, baseUrl, settlementRepo, quoteSpy } = await startApp(readyGithub());
    try {
      const jobId = await openJob(baseUrl);
      await proposeTwoLineCriteria(baseUrl, jobId, door.rail);
      await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, buyer);
      await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agent);
      await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, buyer);
      await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agent);
      await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, buyer);
      const res = await door.start(baseUrl, jobId);
      await assertRefusalStartsNothing(
        res,
        settlementRepo,
        quoteSpy,
        jobId,
        `the deposit can start only once both parties have signed the price; still to sign: the agent: ${publicBaseUrlFromEnv()}/agreement?job=${jobId}`,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe.each(doors)('$name: refuses a price accepted by the agent only, 409, nothing started', (door) => {
  it('answers 409 naming the buyer still to sign, whole, and starts nothing', async () => {
    const { server, baseUrl, settlementRepo, quoteSpy } = await startApp(readyGithub());
    try {
      const jobId = await openJob(baseUrl);
      await proposeTwoLineCriteria(baseUrl, jobId, door.rail);
      await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, buyer);
      await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agent);
      await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, buyer);
      await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agent);
      await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, agent);
      const res = await door.start(baseUrl, jobId);
      await assertRefusalStartsNothing(
        res,
        settlementRepo,
        quoteSpy,
        jobId,
        `the deposit can start only once both parties have signed the price; still to sign: the buyer: ${publicBaseUrlFromEnv()}/agreement?job=${jobId}`,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe.each(doors)('$name: refuses an agent with no verified GitHub login, 409, nothing started', (door) => {
  it('no login on record at all answers 409 with the login sentence, whole, and starts nothing', async () => {
    const { server, baseUrl, settlementRepo, quoteSpy } = await startApp(readyGithub(), { githubLogin: null, verified: false });
    try {
      const jobId = await walkToFullySigned(baseUrl, 'buyer/target-repo', door.rail);
      const res = await door.start(baseUrl, jobId);
      await assertRefusalStartsNothing(
        res,
        settlementRepo,
        quoteSpy,
        jobId,
        "the agent has not verified its GitHub account yet; the deposit can start once it has, because the work is delivered through that account",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('a login on record but never verified answers the identical 409, whole, and starts nothing', async () => {
    const { server, baseUrl, settlementRepo, quoteSpy } = await startApp(readyGithub(), {
      githubLogin: 'scout-claimed-not-verified',
      verified: false,
    });
    try {
      const jobId = await walkToFullySigned(baseUrl, 'buyer/target-repo', door.rail);
      const res = await door.start(baseUrl, jobId);
      await assertRefusalStartsNothing(
        res,
        settlementRepo,
        quoteSpy,
        jobId,
        "the agent has not verified its GitHub account yet; the deposit can start once it has, because the work is delivered through that account",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe.each(doors)('$name: refuses a sibling already confirmed, 409, nothing started', (door) => {
  it('a sibling job from the same brief with confirmedAt set answers 409, whole, and starts nothing', async () => {
    const { server, baseUrl, settlementRepo, quoteSpy, jobRepo } = await startApp(readyGithub());
    try {
      const jobId = await walkToFullySigned(baseUrl, 'buyer/target-repo', door.rail);
      // Seed the sibling directly through the memory repository -- the
      // state a failed best-effort withdraw (app.ts's confirm route,
      // :5948-5957) leaves behind: still 'proposed', but a sibling next
      // to it already carries confirmedAt.
      const job = await jobRepo.findById(jobId);
      if (job === null) throw new Error('expected the job to exist');
      const requestId = 'req-sibling-readiness-1';
      await jobRepo.update({ ...job, requestId });
      const sibling = await jobRepo.create({
        ...job,
        id: `${jobId}-sibling`,
        requestId,
        confirmedAt: new Date('2026-01-01T00:00:00Z'),
      });
      void sibling;
      const res = await door.start(baseUrl, jobId);
      await assertRefusalStartsNothing(
        res,
        settlementRepo,
        quoteSpy,
        jobId,
        'a sibling job from the same brief has already been confirmed; this job can no longer take a deposit',
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe.each(doors)('$name: a sibling lookup on a driver without findByRequestId is 503, nothing started', (door) => {
  it('answers 503 "storage unavailable" and logs the cause, and starts nothing', async () => {
    const jobRepo = new JobRepoWithoutSiblingLookup();
    const { server, baseUrl, settlementRepo, quoteSpy } = await startApp(readyGithub(), VERIFIED_AGENT, jobRepo);
    try {
      const jobId = await walkToFullySigned(baseUrl, 'buyer/target-repo', door.rail);
      const job = await jobRepo.findById(jobId);
      if (job === null) throw new Error('expected the job to exist');
      await jobRepo.update({ ...job, requestId: 'req-no-lookup-1' });
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await door.start(baseUrl, jobId);
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: 'storage unavailable' });
        expect(errorLog).toHaveBeenCalled();
      } finally {
        errorLog.mockRestore();
      }
      expect(quoteSpy).not.toHaveBeenCalled();
      expect(await settlementRepo.findByJobAndLeg(jobId, 'deposit')).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe.each(doors)('$name: a fully signed, verified, ready job still starts', (door) => {
  it('does not refuse the honest buyer: answers something other than a readiness 409', async () => {
    const { server, baseUrl } = await startApp(readyGithub());
    try {
      const jobId = await walkToFullySigned(baseUrl, 'buyer/target-repo', door.rail);
      const res = await door.start(baseUrl, jobId);
      expect(res.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// onAuth (abt-did-connect.ts): the ABT wallet callback settles the
// deposit, so it must re-check the exact same steps 1 (sibling), 2
// (agreement) and 4 (login) right before it would broadcast -- a
// session minted while the job was ready can still be COMPLETED after
// the agreement, the agent's verification, or a sibling's status
// changed underneath it.
describe('onAuth re-checks deposit readiness before it settles (ABT only)', () => {
  it('a re-proposed price between start and wallet completion refuses: confirmed false, the price sentence, nothing broadcast, no settlement row', async () => {
    const fakeChain = fakeAbtWalletChainClient(true);
    const { server, baseUrl, settlementRepo } = await startApp(readyGithub(), VERIFIED_AGENT, undefined, fakeChain.client);
    try {
      const jobId = await walkToFullySigned(baseUrl, 'buyer/target-repo', 'abt');
      const { sessionToken, authCallbackUrl } = await startAbtSessionLocal(baseUrl, jobId);
      // The agent's side re-proposes the price after /start already read
      // the agreement: this resets BOTH acceptances (job.ts's own rule).
      // It happens after the wallet fetched its claim and before it
      // answers, so it is onAuth's own readiness re-check that refuses.
      const result = await completeAbtWalletProtocol(baseUrl, sessionToken, authCallbackUrl, fakeChain, () =>
        postSigned(baseUrl, `/jobs/${jobId}/criteria`, { criteria: twoLineProposal, priceUsd: '550.00', rail: 'abt' }, agent),
      );
      expect(result.confirmed).toBe(false);
      expect(result.error).toBe(
        `the deposit can start only once both parties have signed the price; still to sign: the buyer and the agent: ${publicBaseUrlFromEnv()}/agreement?job=${jobId}`,
      );
      expect(fakeChain.sentTx()).toBeUndefined();
      expect(await settlementRepo.findByJobAndLeg(jobId, 'deposit')).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('the agent losing its verified login between start and completion refuses: confirmed false, the login sentence, nothing broadcast', async () => {
    const fakeChain = fakeAbtWalletChainClient(true);
    const { server, baseUrl, settlementRepo, agentRepo } = await startApp(readyGithub(), VERIFIED_AGENT, undefined, fakeChain.client);
    try {
      const jobId = await walkToFullySigned(baseUrl, 'buyer/target-repo', 'abt');
      const { sessionToken, authCallbackUrl } = await startAbtSessionLocal(baseUrl, jobId);
      await agentRepo.updateGithubBinding(agent.did, { handle: VERIFIED_AGENT.githubLogin ?? '', status: 'unverified' });
      const result = await completeAbtWalletProtocol(baseUrl, sessionToken, authCallbackUrl, fakeChain);
      expect(result.confirmed).toBe(false);
      expect(result.error).toBe(
        "the agent has not verified its GitHub account yet; the deposit can start once it has, because the work is delivered through that account",
      );
      expect(fakeChain.sentTx()).toBeUndefined();
      expect(await settlementRepo.findByJobAndLeg(jobId, 'deposit')).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('a sibling confirming between start and completion refuses: confirmed false, the sibling sentence, nothing broadcast', async () => {
    const fakeChain = fakeAbtWalletChainClient(true);
    const { server, baseUrl, settlementRepo, jobRepo } = await startApp(readyGithub(), VERIFIED_AGENT, undefined, fakeChain.client);
    try {
      const jobId = await walkToFullySigned(baseUrl, 'buyer/target-repo', 'abt');
      const { sessionToken, authCallbackUrl } = await startAbtSessionLocal(baseUrl, jobId);
      const job = await jobRepo.findById(jobId);
      if (job === null) throw new Error('expected the job to exist');
      const requestId = 'req-sibling-onauth-1';
      await jobRepo.update({ ...job, requestId });
      await jobRepo.create({
        ...job,
        id: `${jobId}-sibling`,
        requestId,
        confirmedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const result = await completeAbtWalletProtocol(baseUrl, sessionToken, authCallbackUrl, fakeChain);
      expect(result.confirmed).toBe(false);
      expect(result.error).toBe(
        'a sibling job from the same brief has already been confirmed; this job can no longer take a deposit',
      );
      expect(fakeChain.sentTx()).toBeUndefined();
      expect(await settlementRepo.findByJobAndLeg(jobId, 'deposit')).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// The remainder leg is not touched by any of these steps (Make item 2's
// own "the remainder leg is unchanged"): confirm already proved the
// agreement, the login and the absence of a confirmed sibling by the
// time a job can reach 'staged'.
describe('the remainder leg is not refused by the new deposit-readiness steps', () => {
  it('remainder/usdc/start on a staged job still succeeds even though a sibling from the same brief confirmed elsewhere', async () => {
    const { server, baseUrl, quoteSpy, jobRepo, settlementRepo } = await startApp(readyGithub());
    try {
      const jobId = await walkToFullySigned(baseUrl, 'buyer/target-repo', 'usdc');
      await settlementRepo.record({
        jobId,
        leg: 'deposit',
        rail: 'usdc',
        hash: `hash-deposit-${jobId}`,
        secondaryHash: null,
        operatorAddress: USDC_OPERATOR_ADDRESS,
        feeAddress: USDC_FEE_ADDRESS,
        amountUsd: '125.00',
        observedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const confirm = await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
      if (confirm.status !== 200) {
        throw new Error(`confirm failed: ${String(confirm.status)}: ${await confirm.text()}`);
      }
      const stage = await postSigned(baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'buyer-target-repo-head-sha' }, agent);
      if (stage.status !== 200) {
        throw new Error(`stage failed: ${String(stage.status)}: ${await stage.text()}`);
      }
      // A sibling confirming AFTER this job already confirmed cannot
      // happen in practice (confirm withdraws siblings), but the
      // remainder door must not even ask the question -- seed one
      // anyway to prove the door never calls checkNoConfirmedSibling.
      const job = await jobRepo.findById(jobId);
      if (job === null) throw new Error('expected the job to exist');
      const requestId = 'req-remainder-unchecked-1';
      await jobRepo.update({ ...job, requestId });
      await jobRepo.create({
        ...job,
        id: `${jobId}-sibling`,
        requestId,
        confirmedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const res = await postSigned(baseUrl, `/jobs/${jobId}/payments/remainder/usdc/start`, {}, buyer);
      expect(res.status).toBe(200);
      expect(quoteSpy).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// Local helpers for the onAuth block: start an ABT session against THIS
// file's own app (startAbtSession from abt-fixtures.ts assumes its own
// StartedAbtApp shape, so this composes the same two calls directly).
async function startAbtSessionLocal(
  baseUrl: string,
  jobId: string,
): Promise<{ readonly sessionToken: string; readonly authCallbackUrl: string }> {
  const res = await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/abt/start`, {}, buyer);
  if (res.status !== 200) {
    throw new Error(`abt /start failed: ${String(res.status)}: ${await res.text()}`);
  }
  const body = (await res.json()) as { readonly token: string; readonly url: string };
  const deepLink = new URL(body.url);
  const encodedCallbackUrl = deepLink.searchParams.get('url');
  if (encodedCallbackUrl === null) {
    throw new Error('expected a wallet callback url inside the abt start response');
  }
  return { sessionToken: body.token, authCallbackUrl: decodeURIComponent(encodedCallbackUrl) };
}

async function completeAbtWalletProtocol(
  baseUrl: string,
  sessionToken: string,
  authCallbackUrl: string,
  fakeChain: { readonly client: AbtChainClient; sentTx(): string | undefined },
  // Runs once the wallet holds the claim and before it answers, for a test
  // that changes the job between the claim and the answer. The claim
  // itself is refused when the job changed BEFORE it is fetched (the
  // locked price no longer matches), so a test of onAuth's own re-check
  // has to change the job after the claim.
  beforeAnswer?: () => Promise<unknown>,
): Promise<{ readonly confirmed: boolean; readonly error?: string }> {
  const { decode: jwtDecode } = await import('@arcblock/jwt');
  const { walletResponseJwt, walletSignsPartialTx } = await import('../helpers/abt-fixtures.js');
  const wallet = buyerWallet;
  void fakeChain;
  const authPath = new URL(authCallbackUrl).pathname;

  const step0Res = await fetch(authCallbackUrl);
  const step0Body = (await step0Res.json()) as { appPk: string; authInfo: string };
  const step0Decoded = jwtDecode(step0Body.authInfo) as unknown as { challenge: string; requestedClaims: Record<string, unknown>[] };

  const step0SubmitRes = await fetch(`${baseUrl}${authPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      _t_: sessionToken,
      userPk: wallet.publicKey,
      userInfo: await walletResponseJwt(wallet, step0Decoded.challenge, [{ type: 'authPrincipal' }]),
    }),
  });
  const step1Body = (await step0SubmitRes.json()) as { appPk: string; authInfo: string };
  const step1Decoded = jwtDecode(step1Body.authInfo) as unknown as { challenge: string; requestedClaims: Record<string, unknown>[] };
  const prepareTxClaim = step1Decoded.requestedClaims.find((c) => c.type === 'prepareTx') as
    | { readonly partialTx: string }
    | undefined;
  if (prepareTxClaim === undefined) {
    throw new Error('expected a prepareTx claim at step 1');
  }
  const finalTx = await walletSignsPartialTx(prepareTxClaim.partialTx, wallet);
  await beforeAnswer?.();

  const step1SubmitRes = await fetch(`${baseUrl}${authPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      _t_: sessionToken,
      userPk: wallet.publicKey,
      userInfo: await walletResponseJwt(wallet, step1Decoded.challenge, [{ type: 'prepareTx', finalTx }]),
    }),
  });
  const finalBody = (await step1SubmitRes.json()) as { appPk: string; authInfo: string };
  const decoded = jwtDecode(finalBody.authInfo) as unknown as Record<string, unknown>;
  const response = decoded.response as { confirmed: boolean };
  const error = decoded.errorMessage as string | undefined;
  return error === undefined || error === '' ? { confirmed: response.confirmed } : { confirmed: response.confirmed, error };
}

void driveAbtPayment;
