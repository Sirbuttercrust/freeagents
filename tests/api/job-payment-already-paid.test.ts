// B49 (this card): a leg already paid could be paid again. Measured
// on 2e27cf2: with the USDC deposit settled and the job still 'proposed',
// POST .../deposit/usdc/start answered 200 with fresh transfer intents, so a
// buyer who reloaded checkout before confirm was offered a second full
// payment. The ABT doors have the same shape: legStatusEligible checks the
// job's status, never whether the leg already settled. Five places refuse a
// settled leg here: the token-mint door (/api/did/pay/token), abt/start,
// usdc/start, usdc/wallet-response's non-replay path, and onAuth
// (abt-did-connect.ts) before it broadcasts. Each place's own test goes red
// when that place's checkLegNotAlreadySettled call is removed, and an exact
// replay of a recorded USDC pair still answers what the first call answered.
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { fromRandom } from '@ocap/wallet';
import { createApp } from '../../src/api/app.js';
import { PrismaSettlementGate } from '../../src/adapters/payment/gate.js';
import { createUsdcPaymentRail, type UsdcChainClient } from '../../src/adapters/payment/usdc.js';
import { createAbtPaymentRail } from '../../src/adapters/payment/abt.js';
import { createAbtEthPaymentRail } from '../../src/adapters/payment/abt-eth.js';
import { createMemoryAbtEthShortPaymentStorage } from '../../src/adapters/payment/abt-eth-short-payment-memory.js';
import type { AbtEthShortPaymentStorage } from '../../src/adapters/payment/abt-eth-short-payment.js';
import type { UsdcHalfPaidStorage } from '../../src/adapters/payment/usdc-half-paid-storage-types.js';
import { didSuffix } from '../../src/domain/agent.js';
import type { UsdcSpentTransferRow, UsdcSpentTransferStorage } from '../../src/adapters/payment/usdc-spent-transfer-storage-types.js';
import { MemorySettlementRepository, MemoryAgentRepository, MemoryJobRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';
import { signingIdentityFromSeed } from '../helpers/sign-request.js';
import { fakeHalfPaidStorage } from '../helpers/usdc-half-paid-fixtures.js';
import {
  abtEnv,
  continueAbtWalletProtocol,
  fakeAbtChainClient as recordingAbtChainClient,
  getSigned,
  postSigned,
  pureTxEncoder,
  reservePort,
  startAbtSession,
  withEnv,
} from '../helpers/abt-fixtures.js';
const USDC_TOKEN = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const USDC_FEE_ADDRESS = '0xFeeAddress000000000000000000000000000';
const USDC_OPERATOR_ADDRESS = '0xOperator000000000000000000000000000000';
const USDC_CHAIN_ID = 421614;
const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(251));
const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(252));
const platformWallet = fromRandom();
const ABT_TOKEN = fromRandom().address;
const ABT_FEE_ADDRESS = fromRandom().address;
const proposal = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'agent' },
];
function abtEthEnvVars(): Record<string, string> {
  return {
    FREEAGENTS_ABT_ETH_RPC_URL: 'https://rpc.example.test',
    FREEAGENTS_ABT_ETH_TOKEN_CONTRACT: '0xb98d4c97425d9908e66e53a6fdf673acca0be986',
    FREEAGENTS_ABT_ETH_CHAIN_ID: '1',
    FREEAGENTS_ABT_ETH_FEE_ADDRESS: '0x2222222222222222222222222222222222222222',
  };
}
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
interface Started {
  readonly server: Server;
  readonly baseUrl: string;
  readonly settlementRepo: MemorySettlementRepository;
  // The USDC rail's half-paid record, readable by the test, and a switch
  // that makes its next reads throw.
  readonly usdcHalfPaid: UsdcHalfPaidStorage;
  readonly usdcReadsFail: { on: boolean };
  // The signed transaction the ABT rail broadcast, undefined while none was.
  readonly abtBroadcast: () => string | undefined;
  // The short payments of the ABT-on-Ethereum rail, which this app wires
  // beside the other two so a test can plant a row.
  readonly abtEthShorts: AbtEthShortPaymentStorage;
}
// Runs fn against a started app, guaranteeing server.close() even on
// failure -- the try/finally every describe block below would otherwise
// repeat individually.
async function withStarted(fn: (s: Started) => Promise<void>): Promise<void> {
  const started = await startApp();
  try {
    await fn(started);
  } finally {
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
  }
}
async function startApp(): Promise<Started> {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  return withEnv({ ...usdcEnvVars(), ...abtEthEnvVars(), ...abtEnv(baseUrl, platformWallet, ABT_TOKEN, ABT_FEE_ADDRESS) }, async () => {
    const usdcHalfPaid = fakeHalfPaidStorage();
    const usdcReadsFail = { on: false };
    const usdcRail = createUsdcPaymentRail({
      chainClient: fakeUsdcChainClient(),
      rateSource: async () => '1',
      halfPaidStorage: {
        ...usdcHalfPaid,
        read: async (jobId, leg) => {
          if (usdcReadsFail.on) throw new Error('storage down');
          return usdcHalfPaid.read(jobId, leg);
        },
      },
      spentTransferStorage: fakeSpentTransferStorage(),
    });
    const abtSpentRows = new Map<string, { hash: string; jobId: string; leg: 'deposit' | 'balance' }>();
    const abtChain = recordingAbtChainClient();
    const abtRail = createAbtPaymentRail({
      chainClient: abtChain.client,
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
    await operatorRepo.register({ did: buyer.did, githubLogin: `buyer-already-paid-${Math.random()}` });
    await operatorRepo.setOperatorAddressEvm(buyer.did, USDC_OPERATOR_ADDRESS);
    await operatorRepo.setOperatorAddressAbt(buyer.did, didSuffix(buyer.did));
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: buyer.did,
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: 'scout-already-paid',
      negotiatesOnOwnersBehalf: true,
    });
    await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-already-paid', status: 'verified' });
    const jobRepo = new MemoryJobRepository();
    const settlementRepo = new MemorySettlementRepository();
    const gate = new PrismaSettlementGate(settlementRepo);
    const { github } = createStagingLifecycleGithubFake();
    const abtEthShorts = createMemoryAbtEthShortPaymentStorage();
    const abtEthRail = createAbtEthPaymentRail({
      chainClient: { decimals: async () => 18, getTransactionReceipt: async () => null, recordedAt: async () => null },
      rateSource: async () => null,
      spentTransferStorage: fakeSpentTransferStorage(),
      halfPaidStorage: { ...fakeHalfPaidStorage(), read: async () => null },
    });
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
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      abtEthRail, undefined, abtEthShorts,
    );
    const server = app.listen(port, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    return { server, baseUrl, settlementRepo, usdcHalfPaid, usdcReadsFail, abtBroadcast: abtChain.sentTx, abtEthShorts };
  });
}
// rail null is an open quote: the buyer picks the currency at checkout.
async function walkToProposed(baseUrl: string, rail: 'usdc' | 'abt' | null = 'usdc'): Promise<string> {
  const created = await postSigned(baseUrl, '/jobs', {
    buyerDid: buyer.did,
    agentDid: agent.did,
    repository: 'buyer/target-repo',
    brief: 'Fix the login bug',
  }, buyer);
  const jobId = String(((await created.json()) as Record<string, unknown>).id);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria`, { criteria: proposal, priceUsd: '500.00', ...(rail === null ? {} : { rail }) }, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, agent);
  return jobId;
}
async function recordSettledDeposit(settlementRepo: MemorySettlementRepository, jobId: string, rail: 'abt' | 'usdc'): Promise<void> {
  await settlementRepo.record({
    jobId,
    leg: 'deposit',
    rail,
    hash: `already-paid-hash-${jobId}`,
    secondaryHash: rail === 'usdc' ? `already-paid-fee-hash-${jobId}` : null,
    operatorAddress: rail === 'usdc' ? USDC_OPERATOR_ADDRESS : didSuffix(buyer.did),
    feeAddress: rail === 'usdc' ? USDC_FEE_ADDRESS : ABT_FEE_ADDRESS,
    amountUsd: '125.00',
    observedAt: new Date('2026-01-01T00:00:00Z'),
  });
}
describe('B49: usdc/start refuses a leg that already has a settlement row', () => {
  it('answers 409 naming the already-paid sentence, and starts nothing fresh', () => withStarted(async ({ baseUrl, settlementRepo }) => {
    const jobId = await walkToProposed(baseUrl, 'usdc');
    await recordSettledDeposit(settlementRepo, jobId, 'usdc');
    const res = await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, {}, buyer);
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain('already been paid');
  }));
  it('a leg that is NOT settled still starts normally', () => withStarted(async ({ baseUrl }) => {
    const jobId = await walkToProposed(baseUrl, 'usdc');
    const res = await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, {}, buyer);
    expect(res.status).toBe(200);
  }));
});
describe('B49: abt/start refuses a leg that already has a settlement row', () => {
  it('answers 409 naming the already-paid sentence, and mints no session', () => withStarted(async ({ baseUrl, settlementRepo }) => {
    const jobId = await walkToProposed(baseUrl, 'abt');
    await recordSettledDeposit(settlementRepo, jobId, 'abt');
    const res = await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/abt/start`, {}, buyer);
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain('already been paid');
  }));
});
describe('B49: the token-mint door (/api/did/pay/token) refuses a leg that already has a settlement row', () => {
  it('answers 409 naming the already-paid sentence, and mints no session', () => withStarted(async ({ baseUrl, settlementRepo }) => {
    const jobId = await walkToProposed(baseUrl, 'abt');
    await recordSettledDeposit(settlementRepo, jobId, 'abt');
    const res = await getSigned(baseUrl, `/api/did/pay/token?jobId=${jobId}&leg=deposit`, buyer);
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain('already been paid');
  }));
});
describe('B49: usdc/wallet-response refuses a fresh (non-replay) attempt on an already-settled leg', () => {
  it('a different hash pair than the recorded settlement answers 409, and the row is unchanged', () => withStarted(async ({ baseUrl, settlementRepo }) => {
    const jobId = await walkToProposed(baseUrl, 'usdc');
    await recordSettledDeposit(settlementRepo, jobId, 'usdc');
    const res = await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/usdc/wallet-response`, { priceTxHash: '0xdep-price', feeTx: { signed: true, hash: '0xdep-fee' } }, buyer);
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain('already been paid');
    const row = await settlementRepo.findByJobAndLeg(jobId, 'deposit');
    expect(row?.hash).toBe(`already-paid-hash-${jobId}`);
  }));
  it('an exact replay of the recorded pair still answers what the first call answered (idempotency untouched)', () => withStarted(async ({ baseUrl, settlementRepo }) => {
    const jobId = await walkToProposed(baseUrl, 'usdc');
    await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, {}, buyer);
    const walletResponsePath = `/jobs/${jobId}/payments/deposit/usdc/wallet-response`;
    const walletResponseBody = { priceTxHash: '0xdep-price', feeTx: { signed: true, hash: '0xdep-fee' } };
    const first = await postSigned(baseUrl, walletResponsePath, walletResponseBody, buyer);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody.confirmed).toBe(true);
    // Same recorded pair replayed: must still answer confirmed, not 409.
    const replay = await postSigned(baseUrl, walletResponsePath, walletResponseBody, buyer);
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as Record<string, unknown>;
    expect(replayBody.confirmed).toBe(true);
    const row = await settlementRepo.findByJobAndLeg(jobId, 'deposit');
    expect(row?.hash).toBe('0xdep-price');
  }));
});
describe('B49: onAuth (the ABT wallet callback) refuses to broadcast or settle a leg that settled in the meantime', () => {
  it('a session minted while the leg was still open refuses once the leg settles before the wallet finishes', () => withStarted(async ({ baseUrl, settlementRepo }) => {
    const jobId = await walkToProposed(baseUrl, 'abt');
    // The session is minted while the deposit leg is still open (the
    // ordinary /start call), so eligibility passes at MINT time -- the
    // exact race B49 exists for: a second device, or a later settlement
    // through a different session, lands before this wallet finishes.
    const { sessionToken, authCallbackUrl } = await startAbtSession(baseUrl, buyer, { jobId, leg: 'deposit' });
    await recordSettledDeposit(settlementRepo, jobId, 'abt');
    const result = await continueAbtWalletProtocol(baseUrl, sessionToken, authCallbackUrl, fromRandom());
    expect(result.confirmed).toBe(false);
    expect(result.error).toContain('already been paid');
    // Nothing was overwritten: the pre-existing settlement row still
    // carries the hash this test itself wrote, never a broadcast hash.
    const row = await settlementRepo.findByJobAndLeg(jobId, 'deposit');
    expect(row?.hash).toBe(`already-paid-hash-${jobId}`);
  }));
});

// B88: a deposit whose price transfer already reached the owner in USDC (the
// fee still to come) is held on USDC the way a settled one is. Every door
// that offers the leg in ABT refuses it, and refuses it with the sentence
// that says where to finish it.
describe('B88: a deposit half-paid in USDC is refused by every ABT door', () => {
  const HELD_IN_USDC = 'part of the deposit for this job was paid in "usdc"; finish it there, the "abt" payment routes refuse it';
  const STORAGE_DOWN = 'storage unavailable';

  async function halfPayInUsdc(baseUrl: string, jobId: string): Promise<void> {
    expect((await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, {}, buyer)).status).toBe(200);
    const res = await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/usdc/wallet-response`, { priceTxHash: '0xdep-price', feeTx: { signed: false } }, buyer);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      rail: 'usdc',
      hash: '0xdep-price',
      confirmed: false,
      legs: { price: { status: 'confirmed', hash: '0xdep-price' }, fee: { status: 'not_signed' } },
      halfPaid: true,
    });
  }

  it.each([
    ['abt/start', (baseUrl: string, jobId: string) => postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/abt/start`, {}, buyer)],
    ['the token-mint door', (baseUrl: string, jobId: string) => getSigned(baseUrl, `/api/did/pay/token?jobId=${jobId}&leg=deposit`, buyer)],
  ])('%s answers 409 with the held sentence and mints no session', (_door, call) => withStarted(async ({ baseUrl, settlementRepo }) => {
    const jobId = await walkToProposed(baseUrl, null);
    await halfPayInUsdc(baseUrl, jobId);
    const res = await call(baseUrl, jobId);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: HELD_IN_USDC });
    expect(await settlementRepo.findByJobAndLeg(jobId, 'deposit')).toBeNull();
  }));

  it('onAuth refuses a session minted before the USDC price landed: nothing is broadcast and no row is written', () => withStarted(async ({ baseUrl, settlementRepo, abtBroadcast }) => {
    const jobId = await walkToProposed(baseUrl, null);
    // The session is minted while nothing is paid (B49's race shape), then the
    // USDC price lands before this wallet answers.
    const { sessionToken, authCallbackUrl } = await startAbtSession(baseUrl, buyer, { jobId, leg: 'deposit' });
    await halfPayInUsdc(baseUrl, jobId);
    const result = await continueAbtWalletProtocol(baseUrl, sessionToken, authCallbackUrl, fromRandom());
    expect(result).toEqual({ confirmed: false, error: HELD_IN_USDC });
    expect(abtBroadcast()).toBeUndefined();
    expect(await settlementRepo.findByJobAndLeg(jobId, 'deposit')).toBeNull();
  }));

  it('onAuth answers the storage sentence when the half-paid read fails, and broadcasts and records nothing', () => withStarted(async ({ baseUrl, settlementRepo, abtBroadcast, usdcReadsFail }) => {
    const jobId = await walkToProposed(baseUrl, null);
    const { sessionToken, authCallbackUrl } = await startAbtSession(baseUrl, buyer, { jobId, leg: 'deposit' });
    usdcReadsFail.on = true;
    const result = await continueAbtWalletProtocol(baseUrl, sessionToken, authCallbackUrl, fromRandom());
    expect(result).toEqual({ confirmed: false, error: STORAGE_DOWN });
    expect(abtBroadcast()).toBeUndefined();
    expect(await settlementRepo.findByJobAndLeg(jobId, 'deposit')).toBeNull();
  }));
});

// A deposit whose ABT-on-Ethereum payment reached the owner worth less than
// the agreed price is stored short and waits on the owner. The ABT wallet's
// callback refuses it the way every other door does, and nothing is
// broadcast or recorded.
describe('a deposit stored short on ABT on Ethereum is refused by the ABT wallet callback', () => {
  const SHORT_ON_ABT = 'the deposit for this job reached the owner in "abt_eth" worth less than the agreed price and waits on their answer; the "abt" payment routes refuse it. Message the owner.';

  it.each([
    ['abt/start', (baseUrl: string, jobId: string) => postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/abt/start`, {}, buyer)],
    ['the token-mint door', (baseUrl: string, jobId: string) => getSigned(baseUrl, `/api/did/pay/token?jobId=${jobId}&leg=deposit`, buyer)],
  ])('%s answers 409 with the waits-on-the-owner sentence and mints no session', (_door, call) => withStarted(async ({ baseUrl, settlementRepo, abtEthShorts }) => {
    const jobId = await walkToProposed(baseUrl, null);
    await abtEthShorts.record({
      priceTxHash: '0xaaaa000000000000000000000000000000000000000000000000000000000001',
      jobId,
      leg: 'deposit',
      lockId: 'lock-1',
      feeTxHash: null,
      amountToken: '500',
      amountUsd: '125.00',
      usdPerTokenAtRead: '0.2',
      worthUsd: '100',
      recordedAt: new Date('2026-10-06T12:20:00.000Z'),
      readAt: new Date('2026-10-06T12:40:00.000Z'),
    });

    const res = await call(baseUrl, jobId);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: SHORT_ON_ABT });
    expect(await settlementRepo.findByJobAndLeg(jobId, 'deposit')).toBeNull();
  }));

  it('refuses a session minted before the short payment was stored: nothing is broadcast and no row is written', () => withStarted(async ({ baseUrl, settlementRepo, abtBroadcast, abtEthShorts }) => {
    const jobId = await walkToProposed(baseUrl, null);
    const { sessionToken, authCallbackUrl } = await startAbtSession(baseUrl, buyer, { jobId, leg: 'deposit' });
    await abtEthShorts.record({
      priceTxHash: '0xaaaa000000000000000000000000000000000000000000000000000000000001',
      jobId,
      leg: 'deposit',
      lockId: 'lock-1',
      feeTxHash: null,
      amountToken: '500',
      amountUsd: '125.00',
      usdPerTokenAtRead: '0.2',
      worthUsd: '100',
      recordedAt: new Date('2026-10-06T12:20:00.000Z'),
      readAt: new Date('2026-10-06T12:40:00.000Z'),
    });

    const result = await continueAbtWalletProtocol(baseUrl, sessionToken, authCallbackUrl, fromRandom());

    expect(result).toEqual({ confirmed: false, error: SHORT_ON_ABT });
    expect(abtBroadcast()).toBeUndefined();
    expect(await settlementRepo.findByJobAndLeg(jobId, 'deposit')).toBeNull();
  }));
});
