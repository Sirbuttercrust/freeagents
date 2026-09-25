// B23 and B25 (bug ledger, C1 rehearsal s7 and s8): the payment surface's
// two status-independent guards.
//
// B23: every payment start route (both rails) and the USDC wallet-response
// route accepted a job in ANY status, including a terminal one. On a
// withdrawn job, USDC deposit start answered 200 with transfer intents,
// the USDC wallet response recorded an ObservedSettlement row, and ABT
// deposit start minted a wallet session -- a buyer could pay for a job
// that no longer exists. Each leg is only ever eligible while the job is
// in the status that leg belongs to: deposit while 'proposed' (the same
// status the existing tests already drive it from, tests/api/job-payment-
// usdc.test.ts's walkToConfirmed stops at 'proposed' before calling
// deposit start), remainder while 'staged' or 'redo_requested' (the same
// two statuses LAPSE_AT_STAGED_STATUSES already names for the identical
// reason: work is staged and unpaid). Every other status refuses 409.
//
// B25: USDC deposit start accepted a job priced on the ABT rail (and vice
// versa). Each rail's routes now refuse 409 when the job's agreed rail is
// a different one, checked in both directions.
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { fromRandom } from '@ocap/wallet';

import { createApp } from '../../src/api/app.js';
import { PrismaSettlementGate } from '../../src/adapters/payment/gate.js';
import { createUsdcPaymentRail, type UsdcChainClient } from '../../src/adapters/payment/usdc.js';
import { createAbtPaymentRail, type AbtChainClient } from '../../src/adapters/payment/abt.js';
import { didSuffix } from '../../src/domain/agent.js';
import type { UsdcSpentTransferRow, UsdcSpentTransferStorage } from '../../src/adapters/payment/usdc-spent-transfer-storage-types.js';
import { MemorySettlementRepository, MemoryAgentRepository, MemoryJobRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { abtEnv, reservePort, withEnv, pureTxEncoder, getSigned } from '../helpers/abt-fixtures.js';

const USDC_TOKEN = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const USDC_FEE_ADDRESS = '0xFeeAddress000000000000000000000000000';
const USDC_OPERATOR_ADDRESS = '0xOperator000000000000000000000000000000';
const USDC_CHAIN_ID = 421614;

const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(241));
const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(242));
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
    getTransactionReceipt: async (hash: string) => {
      const normalized = hash.toLowerCase();
      if (normalized === '0xdep-price') {
        return { status: 1, transfer: { to: USDC_OPERATOR_ADDRESS, value: '125000000', tokenContract: USDC_TOKEN, chainId: USDC_CHAIN_ID } };
      }
      if (normalized === '0xdep-fee') {
        return { status: 1, transfer: { to: USDC_FEE_ADDRESS, value: '7500000', tokenContract: USDC_TOKEN, chainId: USDC_CHAIN_ID } };
      }
      return null;
    },
  };
}
function fakeAbtChainClient(): AbtChainClient {
  return {
    getTransaction: async () => null,
  } as unknown as AbtChainClient;
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
}

async function startApp(): Promise<Started> {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  return withEnv({ ...usdcEnvVars(), ...abtEnv(baseUrl, platformWallet, ABT_TOKEN, ABT_FEE_ADDRESS) }, async () => {
    const usdcRail = createUsdcPaymentRail({
      chainClient: fakeUsdcChainClient(),
      rateSource: async () => '1',
      halfPaidStorage: { record: async () => {}, read: async () => null, clear: async () => {} },
      spentTransferStorage: fakeSpentTransferStorage(),
    });
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
    await operatorRepo.register({ did: buyer.did, githubLogin: `buyer-payment-status-${Math.random()}` });
    await operatorRepo.setOperatorAddressEvm(buyer.did, USDC_OPERATOR_ADDRESS);
    await operatorRepo.setOperatorAddressAbt(buyer.did, didSuffix(buyer.did));
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: buyer.did,
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: 'scout-payment-status',
      negotiatesOnOwnersBehalf: true,
    });
    await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-payment-status', status: 'verified' });
    const jobRepo = new MemoryJobRepository();
    const settlementRepo = new MemorySettlementRepository();
    const gate = new PrismaSettlementGate(settlementRepo);
    const { github } = createStagingLifecycleGithubFake();
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
      undefined,
      undefined,
      abtRail,
      usdcRail,
      settlementRepo,
      pureTxEncoder,
    );
    const server = app.listen(port, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    return { server, baseUrl, settlementRepo };
  });
}

async function walkToProposed(baseUrl: string, rail: 'usdc' | 'abt' = 'usdc'): Promise<string> {
  const created = await postSigned(baseUrl, '/jobs', {
    buyerDid: buyer.did,
    agentDid: agent.did,
    repository: 'buyer/target-repo',
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

describe('B23: payment routes refuse a job whose status does not belong to the leg', () => {
  it('usdc deposit/start refuses 409 on a withdrawn job', async () => {
    const { server, baseUrl } = await startApp();
    try {
      const jobId = await walkToProposed(baseUrl);
      const withdraw = await postSigned(baseUrl, `/jobs/${jobId}/withdraw`, {}, buyer);
      expect(withdraw.status).toBe(200);

      const start = await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, {}, buyer);
      expect(start.status).toBe(409);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('usdc deposit/wallet-response refuses 409 on a withdrawn job and records no settlement', async () => {
    const { server, baseUrl, settlementRepo } = await startApp();
    try {
      const jobId = await walkToProposed(baseUrl);
      await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, {}, buyer);
      const withdraw = await postSigned(baseUrl, `/jobs/${jobId}/withdraw`, {}, buyer);
      expect(withdraw.status).toBe(200);

      const walletResponse = await postSigned(
        baseUrl,
        `/jobs/${jobId}/payments/deposit/usdc/wallet-response`,
        { priceTxHash: '0xafter-withdraw-price', feeTx: { signed: true, hash: '0xafter-withdraw-fee' } },
        buyer,
      );
      expect(walletResponse.status).toBe(409);
      expect(await settlementRepo.findByJobAndLeg(jobId, 'deposit')).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('abt deposit/start refuses 409 on a withdrawn job, minting no wallet session', async () => {
    const { server, baseUrl } = await startApp();
    try {
      const jobId = await walkToProposed(baseUrl, 'abt');
      const withdraw = await postSigned(baseUrl, `/jobs/${jobId}/withdraw`, {}, buyer);
      expect(withdraw.status).toBe(200);

      const start = await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/abt/start`, {}, buyer);
      expect(start.status).toBe(409);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('usdc remainder/start refuses 409 before the job is staged (still proposed)', async () => {
    const { server, baseUrl } = await startApp();
    try {
      const jobId = await walkToProposed(baseUrl);
      const start = await postSigned(baseUrl, `/jobs/${jobId}/payments/remainder/usdc/start`, {}, buyer);
      expect(start.status).toBe(409);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('usdc deposit/start refuses 409 once the job is confirmed: the deposit leg belongs to proposed only', async () => {
    const { server, baseUrl } = await startApp();
    try {
      const jobId = await walkToProposed(baseUrl);
      await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, {}, buyer);
      await postSigned(
        baseUrl,
        `/jobs/${jobId}/payments/deposit/usdc/wallet-response`,
        { priceTxHash: '0xdep-price', feeTx: { signed: true, hash: '0xdep-fee' } },
        buyer,
      );
      const confirm = await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
      expect(confirm.status).toBe(200);

      // The deposit already settled once above; starting it again on a
      // confirmed job is refused by status, independent of whether the
      // leg was already paid.
      const secondStart = await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, {}, buyer);
      expect(secondStart.status).toBe(409);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('B25: payment routes refuse a job priced on the other rail', () => {
  it('usdc deposit/start refuses 409 on an ABT-priced job', async () => {
    const { server, baseUrl } = await startApp();
    try {
      const jobId = await walkToProposed(baseUrl, 'abt');
      const start = await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, {}, buyer);
      expect(start.status).toBe(409);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('abt deposit/start refuses 409 on a USDC-priced job (the other direction)', async () => {
    const { server, baseUrl } = await startApp();
    try {
      const jobId = await walkToProposed(baseUrl, 'usdc');
      const start = await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/abt/start`, {}, buyer);
      expect(start.status).toBe(409);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('usdc deposit/wallet-response refuses 409 on an ABT-priced job', async () => {
    const { server, baseUrl } = await startApp();
    try {
      const jobId = await walkToProposed(baseUrl, 'abt');
      const walletResponse = await postSigned(
        baseUrl,
        `/jobs/${jobId}/payments/deposit/usdc/wallet-response`,
        { priceTxHash: '0xwrong-rail-price', feeTx: { signed: true, hash: '0xwrong-rail-fee' } },
        buyer,
      );
      expect(walletResponse.status).toBe(409);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// Proof round 1, D1 (comment 561 on this card): B23 and B25 were wired
// only onto /jobs/:jobId/payments/:leg/abt/start. did-connect-js's own
// /api/did/pay/token mount is the SECOND door to the exact same session
// mint (app.ts's own comment at requireBuyerToMintAbtSession names this
// door as the thing that must match /start), and it had neither check:
// a withdrawn or wrong-rail job still minted a session token through it.
describe('B23 and B25 on the second door: /api/did/pay/token refuses the same status and rail conflicts /start refuses', () => {
  it('refuses 409 on a withdrawn job, minting no session', async () => {
    const { server, baseUrl } = await startApp();
    try {
      const jobId = await walkToProposed(baseUrl, 'abt');
      const withdraw = await postSigned(baseUrl, `/jobs/${jobId}/withdraw`, {}, buyer);
      expect(withdraw.status).toBe(200);

      const res = await getSigned(baseUrl, `/api/did/pay/token?jobId=${jobId}&leg=deposit`, buyer);
      expect(res.status).toBe(409);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('refuses 409 on a job priced on the other rail', async () => {
    const { server, baseUrl } = await startApp();
    try {
      const jobId = await walkToProposed(baseUrl, 'usdc');
      const res = await getSigned(baseUrl, `/api/did/pay/token?jobId=${jobId}&leg=deposit`, buyer);
      expect(res.status).toBe(409);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
