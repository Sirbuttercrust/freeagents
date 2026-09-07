// P10 acceptance criterion: "the gate reads durably: two createApp calls
// sharing one repository both see the settlement, the way the
// observed-key test proves a restart" (tests/api/job-merge-restart.test.ts
// is that pattern for identity; this is the same pattern for the
// settlement record). Process 1 walks a job to a settled deposit leg over
// its own USDC route and closes; process 2, sharing only the durable
// settlementRepo, answers PrismaSettlementGate.depositSettled(jobId) true
// and lets confirm succeed, with no in-memory state carried over except
// the repository instance itself.
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { PrismaSettlementGate } from '../../src/adapters/payment/gate.js';
import { createUsdcPaymentRail, type UsdcChainClient } from '../../src/adapters/payment/usdc.js';
import type { UsdcSpentTransferRow, UsdcSpentTransferStorage } from '../../src/adapters/payment/usdc-spent-transfer-storage-types.js';
import { MemorySettlementRepository } from '../../src/adapters/storage/memory.js';
import {
  MemoryAgentRepository,
  MemoryJobRepository,
  MemoryAccountRepository,
} from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';

const USDC_TOKEN = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const USDC_FEE_ADDRESS = '0xFeeAddress000000000000000000000000000';
const USDC_OPERATOR_ADDRESS = '0xOperator000000000000000000000000000000';

function usdcEnvVars(): Record<string, string> {
  return {
    FREEAGENTS_USDC_RPC_URL: 'https://sepolia-rollup.arbitrum.io/rpc',
    FREEAGENTS_USDC_TOKEN_CONTRACT: USDC_TOKEN,
    FREEAGENTS_USDC_CHAIN_ID: '421614',
    FREEAGENTS_USDC_FEE_ADDRESS: USDC_FEE_ADDRESS,
  };
}

function withUsdcEnv<T>(fn: () => T): T {
  const original: Record<string, string | undefined> = {};
  const vars = usdcEnvVars();
  for (const key of Object.keys(vars)) {
    original[key] = process.env[key];
    process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

// S1: the deposit leg on a 500.00 USD job at the default 25% deposit and
// 1:1 rate is 125.00 USDC price / 7.50 USDC fee (6% of 125.00). Both
// hashes this test posts resolve through the same fake, keyed so each
// leg's hash pays the recipient and amount that leg actually expects.
function fakeUsdcChainClient(): UsdcChainClient {
  return {
    decimals: async () => 6,
    getTransactionReceipt: async (hash: string) => {
      if (hash.includes('fee')) {
        return { status: 1, transfer: { to: USDC_FEE_ADDRESS, value: '7500000', tokenContract: USDC_TOKEN, chainId: 421614 } };
      }
      return { status: 1, transfer: { to: USDC_OPERATOR_ADDRESS, value: '125000000', tokenContract: USDC_TOKEN, chainId: 421614 } };
    },
  };
}

// S1: a stateful fake of the spent-transfer storage, so this restart test
// never touches Prisma (DATABASE_URL is unset here).
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

async function postSigned(base: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
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

async function listen(app: ReturnType<typeof createApp>): Promise<{ server: Server; baseUrl: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe('the settlement gate reads durably across a process restart, sharing only the settlement repository', () => {
  let servers: Server[] = [];

  afterEach(() => {
    for (const server of servers) server.close();
    servers = [];
  });

  it('a deposit settled by process 1 unlocks confirm on process 2, which never observed the payment itself', async () => {
    const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(211));
    const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(212));

    const operatorRepo = new MemoryAccountRepository();
    await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-durable-gate' });
    const operatorDid = 'did:abt:op-durable-gate';
    await operatorRepo.register({ did: operatorDid, githubLogin: 'operator-durable-gate' });
    await operatorRepo.setOperatorAddressEvm(operatorDid, USDC_OPERATOR_ADDRESS);
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid,
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: 'scout-durable-gate',
    });
    await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-durable-gate', status: 'verified' });
    const jobRepo = new MemoryJobRepository();
    // The ONLY thing shared between the two processes below: everything
    // else (the gate instance, the rail instance) is constructed fresh
    // per process, the same shape a real restart leaves.
    const settlementRepo = new MemorySettlementRepository();

    const usdcRail = withUsdcEnv(() =>
      createUsdcPaymentRail({
        chainClient: fakeUsdcChainClient(),
        rateSource: async () => '1',
        halfPaidStorage: { record: async () => {}, read: async () => null, clear: async () => {} },
        spentTransferStorage: fakeSpentTransferStorage(),
      }),
    );

    const { github: github1 } = createStagingLifecycleGithubFake();
    const app1 = createApp(
      operatorRepo,
      agentRepo,
      undefined,
      github1,
      jobRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new PrismaSettlementGate(settlementRepo),
      anyCommitStagingObserver(),
      undefined,
      null,
      usdcRail,
      settlementRepo,
    );
    const first = await listen(app1);
    servers.push(first.server);

    const created = await postSigned(first.baseUrl, '/jobs', {
      buyerDid: buyer.did,
      agentDid: agent.did,
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug',
    }, buyer);
    const jobId = String(((await created.json()) as Record<string, unknown>).id);
    await postSigned(first.baseUrl, `/jobs/${jobId}/criteria`, {
      criteria: [
        { text: 'The login bug is fixed', proposedBy: 'agent' },
        { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
      ],
      priceUsd: '500.00',
      rail: 'usdc',
    }, agent);
    await postSigned(first.baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, buyer);
    await postSigned(first.baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agent);
    await postSigned(first.baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, buyer);
    await postSigned(first.baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agent);
    await postSigned(first.baseUrl, `/jobs/${jobId}/price/accept`, {}, buyer);
    await postSigned(first.baseUrl, `/jobs/${jobId}/price/accept`, {}, agent);

    const started = await postSigned(first.baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, {}, buyer);
    expect(started.status).toBe(200);
    const walletResponse = await postSigned(
      first.baseUrl,
      `/jobs/${jobId}/payments/deposit/usdc/wallet-response`,
      { priceTxHash: '0xdurableprice1', feeTx: { signed: true, hash: '0xdurablefee1' } },
      buyer,
    );
    expect(walletResponse.status).toBe(200);
    expect(await settlementRepo.findByJobAndLeg(jobId, 'deposit')).not.toBeNull();

    // Process 1 exits. Process 2 shares only settlementRepo, and its own
    // PrismaSettlementGate is a fresh instance holding no cache of its own.
    first.server.close();

    const usdcRail2 = withUsdcEnv(() =>
      createUsdcPaymentRail({
        chainClient: fakeUsdcChainClient(),
        rateSource: async () => '1',
        halfPaidStorage: { record: async () => {}, read: async () => null, clear: async () => {} },
        spentTransferStorage: fakeSpentTransferStorage(),
      }),
    );
    const { github: github2 } = createStagingLifecycleGithubFake();
    const app2 = createApp(
      operatorRepo,
      agentRepo,
      undefined,
      github2,
      jobRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new PrismaSettlementGate(settlementRepo),
      anyCommitStagingObserver(),
      undefined,
      null,
      usdcRail2,
      settlementRepo,
    );
    const second = await listen(app2);
    servers.push(second.server);

    const confirm = await postSigned(second.baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
    expect(confirm.status).toBe(200);
  });
});
