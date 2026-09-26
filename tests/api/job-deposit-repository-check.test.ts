// FIX-B36, Make item 2: the deposit cannot start on a repository that is
// not ready. Before a DEPOSIT leg starts, on all three doors (POST
// /jobs/:jobId/payments/deposit/abt/start, POST
// /jobs/:jobId/payments/deposit/usdc/start, and the token-mint door
// mounted on /api/did/pay/token), the platform reads the job's
// repository and answers 409 with nothing started when it is not ready:
// not visible to the platform, private and owned by a personal account,
// private with organization forking off, or empty. A 5xx or network
// failure from the read is 503 "github unavailable". The remainder leg
// is not checked here -- the repository was proven at confirm.
//
// Every new case here is red on origin/main first (there was no check at
// all): this file did not exist before this card.
import type { Server } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { fromRandom } from '@ocap/wallet';

import { createApp } from '../../src/api/app.js';
import { PrismaSettlementGate } from '../../src/adapters/payment/gate.js';
import { createUsdcPaymentRail, type UsdcChainClient, type UsdcPaymentRailShim } from '../../src/adapters/payment/usdc.js';
import { createAbtPaymentRail, type AbtChainClient } from '../../src/adapters/payment/abt.js';
import { didSuffix } from '../../src/domain/agent.js';
import type { UsdcSpentTransferRow, UsdcSpentTransferStorage } from '../../src/adapters/payment/usdc-spent-transfer-storage-types.js';
import type { GithubAdapter, RepositoryFacts } from '../../src/adapters/github/types.js';
import { RepositoryEmptyError, RepositoryNotAccessibleError } from '../../src/adapters/github/types.js';
import { MemorySettlementRepository, MemoryAgentRepository, MemoryJobRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { abtEnv, reservePort, withEnv, pureTxEncoder, getSigned } from '../helpers/abt-fixtures.js';

const USDC_TOKEN = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const USDC_FEE_ADDRESS = '0xFeeAddress000000000000000000000000000';
const USDC_OPERATOR_ADDRESS = '0xOperator000000000000000000000000000000';
const USDC_CHAIN_ID = 421614;

const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(161));
const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(162));
const platformWallet = fromRandom();
const ABT_TOKEN = fromRandom().address;
const ABT_FEE_ADDRESS = fromRandom().address;

const proposal = [
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
function fakeAbtChainClient(): AbtChainClient {
  return { getTransaction: async () => null } as unknown as AbtChainClient;
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
  readonly quoteSpy: ReturnType<typeof vi.fn>;
}

async function startApp(github: GithubAdapter): Promise<Started> {
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
    // started, the rail's quote or session mint spy at zero"). Wraps the
    // real rail so a passing repository still exercises the real quote
    // math; only the CALL COUNT is observed here.
    const quoteSpy = vi.fn(realUsdcRail.quote.bind(realUsdcRail));
    const usdcRail: UsdcPaymentRailShim = { ...realUsdcRail, quote: quoteSpy };

    const abtSpentRows = new Map<string, { hash: string; jobId: string; leg: 'deposit' | 'balance' }>();
    const abtRail = createAbtPaymentRail({
      chainClient: fakeAbtChainClient(),
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
    await operatorRepo.register({ did: buyer.did, githubLogin: `buyer-deposit-repo-check-${Math.random()}` });
    await operatorRepo.setOperatorAddressEvm(buyer.did, USDC_OPERATOR_ADDRESS);
    await operatorRepo.setOperatorAddressAbt(buyer.did, didSuffix(buyer.did));
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: buyer.did,
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: 'scout-deposit-repo-check',
      negotiatesOnOwnersBehalf: true,
    });
    // Verified so a test can walk a job all the way through confirm and
    // stage (the remainder-leg test below needs a staged job, and
    // confirm's own gate refuses an agent without a verified GitHub
    // login).
    await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-deposit-repo-check', status: 'verified' });
    const jobRepo = new MemoryJobRepository();
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
    return { server, baseUrl, settlementRepo, quoteSpy };
  });
}

async function walkToProposed(baseUrl: string, repository: string, rail: 'usdc' | 'abt' = 'usdc'): Promise<string> {
  const created = await postSigned(baseUrl, '/jobs', {
    buyerDid: buyer.did,
    agentDid: agent.did,
    repository,
    brief: 'Fix the login bug',
  }, buyer);
  const jobId = String(((await created.json()) as Record<string, unknown>).id);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria`, { criteria: proposal, priceUsd: '500.00', rail }, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, agent);
  return jobId;
}

// The remainder leg is only eligible once a job is 'staged' (or
// 'redo_requested'); this walks all the way there through confirm and
// stage, so the remainder-leg exemption test below drives a job that
// is ACTUALLY eligible, not one the status gate would refuse first for
// an unrelated reason. Records the deposit as settled directly on the
// settlement repo (the same shortcut job-confirm-staging.test.ts takes)
// rather than round-tripping the usdc rail's own wallet-response flow,
// since that mechanics is not what this test is about.
async function walkToStaged(
  baseUrl: string,
  repository: string,
  settlementRepo: MemorySettlementRepository,
  rail: 'usdc' | 'abt' = 'usdc',
): Promise<string> {
  const jobId = await walkToProposed(baseUrl, repository, rail);
  await settlementRepo.record({
    jobId,
    leg: 'deposit',
    rail,
    hash: `hash-deposit-${jobId}`,
    secondaryHash: null,
    operatorAddress: rail === 'usdc' ? USDC_OPERATOR_ADDRESS : didSuffix(buyer.did),
    feeAddress: rail === 'usdc' ? USDC_FEE_ADDRESS : 'z1Fee',
    amountUsd: '125.00',
    observedAt: new Date('2026-01-01T00:00:00Z'),
  });
  const confirm = await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
  if (confirm.status !== 200) {
    throw new Error(`walkToStaged: confirm failed with ${String(confirm.status)}: ${await confirm.text()}`);
  }
  const stage = await postSigned(baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: `${repository}-head-sha` }, agent);
  if (stage.status !== 200) {
    throw new Error(`walkToStaged: stage failed with ${String(stage.status)}: ${await stage.text()}`);
  }
  return jobId;
}

function readyFacts(overrides: Partial<RepositoryFacts> = {}): RepositoryFacts {
  return {
    fullName: 'buyer/repo-check',
    private: false,
    allowForking: true,
    ownerIsOrganization: true,
    defaultBranch: 'main',
    sha: 'ready-sha',
    ...overrides,
  };
}

function githubAnswering(facts: RepositoryFacts): GithubAdapter {
  const { github } = createStagingLifecycleGithubFake();
  return { ...github, readRepository: async () => facts };
}

function githubRejecting(err: Error): GithubAdapter {
  const { github } = createStagingLifecycleGithubFake();
  return { ...github, readRepository: async () => Promise.reject(err) };
}

// The remainder-leg test below needs a repository that reads fine at
// confirm (so the job can reach 'staged') and then stops answering
// afterward, to prove the remainder door never re-reads it. A plain
// githubRejecting fixture cannot do that: it would 503 confirm itself
// before the job ever got staged.
function githubBreakableAfterConfirm(): { readonly github: GithubAdapter; breakNow(err: Error): void } {
  const fixture = createStagingLifecycleGithubFake();
  let broken: Error | null = null;
  const github: GithubAdapter = {
    ...fixture.github,
    readRepository: async (ref) => {
      if (broken !== null) return Promise.reject(broken);
      return fixture.github.readRepository(ref);
    },
  };
  return { github, breakNow: (err: Error) => { broken = err; } };
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

describe.each(doors)('$name: refuses a repository the platform cannot see, 409, nothing started', (door) => {
  it('answers 409 with the confirm-identical message, and starts nothing', async () => {
    const github = githubRejecting(new RepositoryNotAccessibleError('buyer', 'repo-check', 404));
    const { server, baseUrl, settlementRepo, quoteSpy } = await startApp(github);
    try {
      const jobId = await walkToProposed(baseUrl, 'buyer/repo-check', door.rail);
      const res = await door.start(baseUrl, jobId);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error.toLowerCase()).toContain('cannot see this repository');
      expect(body.error).toContain('scout-deposit-repo-check');
      expect(body.error).toContain('private-repos?job=' + jobId);
      expect(quoteSpy).not.toHaveBeenCalled();
      expect(await settlementRepo.findByJobAndLeg(jobId, 'deposit')).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe.each(doors)('$name: refuses a private repository owned by a personal account, 409, nothing started', (door) => {
  it('answers 409 naming the organization fix, and starts nothing', async () => {
    const github = githubAnswering(readyFacts({ private: true, ownerIsOrganization: false }));
    const { server, baseUrl, settlementRepo, quoteSpy } = await startApp(github);
    try {
      const jobId = await walkToProposed(baseUrl, 'buyer/repo-check', door.rail);
      const res = await door.start(baseUrl, jobId);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error.toLowerCase()).toContain('personal account');
      expect(body.error.toLowerCase()).toContain('organization');
      expect(body.error).toContain('private-repos?job=' + jobId);
      expect(quoteSpy).not.toHaveBeenCalled();
      expect(await settlementRepo.findByJobAndLeg(jobId, 'deposit')).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe.each(doors)('$name: refuses a private repository whose organization has forking off, 409, nothing started', (door) => {
  it('answers 409 naming the forking fix, and starts nothing', async () => {
    const github = githubAnswering(readyFacts({ private: true, allowForking: false }));
    const { server, baseUrl, settlementRepo, quoteSpy } = await startApp(github);
    try {
      const jobId = await walkToProposed(baseUrl, 'buyer/repo-check', door.rail);
      const res = await door.start(baseUrl, jobId);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error.toLowerCase()).toContain('forking');
      expect(body.error).toContain('private-repos?job=' + jobId);
      expect(quoteSpy).not.toHaveBeenCalled();
      expect(await settlementRepo.findByJobAndLeg(jobId, 'deposit')).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe.each(doors)('$name: refuses an empty repository, 409, nothing started', (door) => {
  it('answers 409 naming the one-commit fix, and starts nothing', async () => {
    const github = githubRejecting(new RepositoryEmptyError('buyer', 'repo-check'));
    const { server, baseUrl, settlementRepo, quoteSpy } = await startApp(github);
    try {
      const jobId = await walkToProposed(baseUrl, 'buyer/repo-check', door.rail);
      const res = await door.start(baseUrl, jobId);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error.toLowerCase()).toContain('no commits');
      expect(quoteSpy).not.toHaveBeenCalled();
      expect(await settlementRepo.findByJobAndLeg(jobId, 'deposit')).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe.each(doors)('$name: a 5xx or network failure reading the repository is 503, nothing started', (door) => {
  it('answers 503 "github unavailable", not 409, and starts nothing', async () => {
    const github = githubRejecting(new Error('connection refused by github'));
    const { server, baseUrl, settlementRepo, quoteSpy } = await startApp(github);
    try {
      const jobId = await walkToProposed(baseUrl, 'buyer/repo-check', door.rail);
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await door.start(baseUrl, jobId);
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: 'github unavailable' });
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

describe.each(doors)('$name: a ready repository passes the check', (door) => {
  it('does not refuse for repository readiness (a ready repository answers something other than the repository 409s)', async () => {
    const github = githubAnswering(readyFacts());
    const { server, baseUrl } = await startApp(github);
    try {
      const jobId = await walkToProposed(baseUrl, 'buyer/repo-check', door.rail);
      const res = await door.start(baseUrl, jobId);
      // A ready repository never answers the repository-readiness 409:
      // usdc/start succeeds (200), abt/start and the token-mint door
      // succeed too (200, minting a session) -- all three reach past the
      // repository check into their own normal path.
      expect(res.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// The remainder leg is not checked here (brief, "Not this card" /
// "the remainder leg is not checked here"): the repository was already
// proven at confirm. This drives a job all the way to 'staged' (so the
// remainder leg is ACTUALLY eligible, not refused first by the status
// gate for an unrelated reason), then breaks the repository read after
// confirm has already happened. Proof r1: the previous version of this
// test called remainder/usdc/start on a job still 'proposed', so the
// status gate (legStatusEligible) answered 409 before checkRepositoryReady
// was ever reached, and the assertion passed whether or not the guard
// existed -- turning it into `if (true)` (checking every leg) still kept
// the whole file green. This version fails under that mutation: with
// every leg checked, remainder/usdc/start would 409 on the repository
// message instead of succeeding.
describe('the remainder leg is not checked by the repository-readiness guard', () => {
  it('usdc remainder/start succeeds on a STAGED job even though the repository has gone unreadable since confirm', async () => {
    const { github, breakNow } = githubBreakableAfterConfirm();
    const { server, baseUrl, quoteSpy, settlementRepo } = await startApp(github);
    try {
      const jobId = await walkToStaged(baseUrl, 'buyer/repo-check', settlementRepo, 'usdc');
      // Break the repository read only AFTER confirm/stage succeeded --
      // the fact under test is that remainder/start does not re-read it.
      breakNow(new RepositoryNotAccessibleError('buyer', 'repo-check', 404));
      const res = await postSigned(baseUrl, `/jobs/${jobId}/payments/remainder/usdc/start`, {}, buyer);
      expect(res.status).toBe(200);
      expect(quoteSpy).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('usdc remainder/start on a job still proposed answers the ordinary status 409, not the repository message', async () => {
    const github = githubRejecting(new RepositoryNotAccessibleError('buyer', 'repo-check', 404));
    const { server, baseUrl } = await startApp(github);
    try {
      const jobId = await walkToProposed(baseUrl, 'buyer/repo-check', 'usdc');
      // Still 'proposed' -- the remainder leg is only eligible at staged.
      const res = await postSigned(baseUrl, `/jobs/${jobId}/payments/remainder/usdc/start`, {}, buyer);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error.toLowerCase()).not.toContain('cannot see this repository');
      expect(body.error.toLowerCase()).toContain('not payable');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // Proof r2, gap 2: the exemption above pinned usdc/start only. Changing
  // abt/start's `leg === 'deposit'` guard (app.ts:6239) or the token-mint
  // door's (app.ts:6130) to check every leg left 102/102 green, because
  // nothing drove a staged, abt-rail job through either of those two
  // doors on the remainder leg. These two mirror the usdc case above, one
  // per door, both on the abt rail (the only rail those two doors accept).
  it('abt remainder/start succeeds on a STAGED job even though the repository has gone unreadable since confirm', async () => {
    const { github, breakNow } = githubBreakableAfterConfirm();
    const { server, baseUrl, settlementRepo } = await startApp(github);
    try {
      const jobId = await walkToStaged(baseUrl, 'buyer/repo-check', settlementRepo, 'abt');
      breakNow(new RepositoryNotAccessibleError('buyer', 'repo-check', 404));
      const res = await postSigned(baseUrl, `/jobs/${jobId}/payments/remainder/abt/start`, {}, buyer);
      expect(res.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('the token-mint door remainder leg succeeds on a STAGED job even though the repository has gone unreadable since confirm', async () => {
    const { github, breakNow } = githubBreakableAfterConfirm();
    const { server, baseUrl, settlementRepo } = await startApp(github);
    try {
      const jobId = await walkToStaged(baseUrl, 'buyer/repo-check', settlementRepo, 'abt');
      breakNow(new RepositoryNotAccessibleError('buyer', 'repo-check', 404));
      const res = await getSigned(baseUrl, `/api/did/pay/token?jobId=${jobId}&leg=remainder`, buyer);
      expect(res.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
