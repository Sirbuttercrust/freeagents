// FIX-B39 (bugs.md B39), rule 5: ONE shared function every payment door
// calls in place of B25's job-rail-only check. This file drives the real
// HTTP routes (both /start doors, the token door, the USDC
// wallet-response route, and the ABT wallet callback) to prove each door
// actually calls the shared check for the two NEW causes it adds:
// the deposit already settled in the other currency, and the owner has
// no payout address for this currency (on an OPEN quote, checked before
// any rail is pinned).
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
import { signingIdentityFromSeed, signingIdentityFromWallet, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { abtEnv, reservePort, withEnv, pureTxEncoder, getSigned, startAbtSession, decodeClaimBody, walletResponseJwt, walletSignsPartialTx, type DidConnectClaimResponse } from '../helpers/abt-fixtures.js';
import { decode as jwtDecode } from '@arcblock/jwt';

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
  readonly operatorRepo: MemoryAccountRepository;
  readonly operatorDid: string;
}

async function startApp(opts: { readonly abtAddress?: string; readonly usdcAddress?: string } = {}): Promise<Started> {
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
    await operatorRepo.register({ did: buyer.did, githubLogin: `buyer-rail-door-${Math.random()}` });
    const operatorDid = `did:abt:op-rail-door-${Math.random()}`;
    await operatorRepo.register({ did: operatorDid, githubLogin: `operator-rail-door-${Math.random()}` });
    if (opts.abtAddress !== undefined) {
      await operatorRepo.setOperatorAddressAbt(operatorDid, opts.abtAddress);
    }
    if (opts.usdcAddress !== undefined) {
      await operatorRepo.setOperatorAddressEvm(operatorDid, opts.usdcAddress);
    }
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid,
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: 'scout-rail-door',
      negotiatesOnOwnersBehalf: true,
    });
    await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-rail-door', status: 'verified' });
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
    return { server, baseUrl, settlementRepo, operatorRepo, operatorDid };
  });
}

async function walkToOpenProposed(baseUrl: string): Promise<string> {
  const created = await postSigned(baseUrl, '/jobs', {
    buyerDid: buyer.did,
    agentDid: agent.did,
    repository: 'buyer/target-repo',
    brief: 'Fix the login bug',
  }, buyer);
  const jobId = String(((await created.json()) as Record<string, unknown>).id);
  // Open quote: no rail named at all.
  await postSigned(baseUrl, `/jobs/${jobId}/criteria`, { criteria: proposal, priceUsd: '500.00' }, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, agent);
  return jobId;
}

describe('rule 5: the deposit that settled in the other currency refuses every door, before confirm', () => {
  it('usdc deposit/start refuses naming the deposit currency, once an abt deposit has settled', async () => {
    const { server, baseUrl, settlementRepo } = await startApp({ abtAddress: 'z1Operator', usdcAddress: USDC_OPERATOR_ADDRESS });
    try {
      const jobId = await walkToOpenProposed(baseUrl);
      await settlementRepo.record({
        jobId, leg: 'deposit', rail: 'abt', hash: 'h1', secondaryHash: null,
        operatorAddress: 'z1Operator', feeAddress: 'z1Fee', amountUsd: '125.00', observedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const res = await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, {}, buyer);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('abt');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('abt deposit/start refuses naming the deposit currency, once a usdc deposit has settled', async () => {
    const { server, baseUrl, settlementRepo } = await startApp({ abtAddress: 'z1Operator', usdcAddress: USDC_OPERATOR_ADDRESS });
    try {
      const jobId = await walkToOpenProposed(baseUrl);
      await settlementRepo.record({
        jobId, leg: 'deposit', rail: 'usdc', hash: 'h2', secondaryHash: null,
        operatorAddress: USDC_OPERATOR_ADDRESS, feeAddress: USDC_FEE_ADDRESS, amountUsd: '125.00', observedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const res = await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/abt/start`, {}, buyer);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('usdc');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('the token-mint door refuses naming the deposit currency, once a usdc deposit has settled', async () => {
    const { server, baseUrl, settlementRepo } = await startApp({ abtAddress: 'z1Operator', usdcAddress: USDC_OPERATOR_ADDRESS });
    try {
      const jobId = await walkToOpenProposed(baseUrl);
      await settlementRepo.record({
        jobId, leg: 'deposit', rail: 'usdc', hash: 'h3', secondaryHash: null,
        operatorAddress: USDC_OPERATOR_ADDRESS, feeAddress: USDC_FEE_ADDRESS, amountUsd: '125.00', observedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const res = await getSigned(baseUrl, `/api/did/pay/token?jobId=${jobId}&leg=deposit`, buyer);
      expect(res.status).toBe(409);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('usdc wallet-response refuses and records no settlement, once an abt deposit has settled', async () => {
    const { server, baseUrl, settlementRepo } = await startApp({ abtAddress: 'z1Operator', usdcAddress: USDC_OPERATOR_ADDRESS });
    try {
      const jobId = await walkToOpenProposed(baseUrl);
      await settlementRepo.record({
        jobId, leg: 'deposit', rail: 'abt', hash: 'h4', secondaryHash: null,
        operatorAddress: 'z1Operator', feeAddress: 'z1Fee', amountUsd: '125.00', observedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const res = await postSigned(
        baseUrl,
        `/jobs/${jobId}/payments/deposit/usdc/wallet-response`,
        { priceTxHash: '0xafter-abt-price', feeTx: { signed: true, hash: '0xafter-abt-fee' } },
        buyer,
      );
      expect(res.status).toBe(409);
      // Only the earlier abt settlement is on record; this call recorded
      // nothing new for the usdc rail check to have overwritten.
      const row = await settlementRepo.findByJobAndLeg(jobId, 'deposit');
      expect(row?.rail).toBe('abt');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('the ABT wallet callback refuses and records no settlement, once a usdc deposit has settled', async () => {
    const started = await startApp({ abtAddress: 'z1Operator', usdcAddress: USDC_OPERATOR_ADDRESS });
    try {
      // onAuth's own buyer check compares the wallet that completes the
      // DID Connect steps against job.buyerDid, so this job's buyer must
      // be backed by a real wallet (unlike the module-level seed-based
      // `buyer` used elsewhere in this file), matching every other
      // wallet-driven test in tests/api/job-payment-abt.test.ts.
      const buyerWallet = fromRandom();
      const walletBuyer = await signingIdentityFromWallet(buyerWallet);
      await started.operatorRepo.register({ did: walletBuyer.did, githubLogin: `wallet-buyer-rail-door-${Math.random()}` });
      const created = await postSigned(started.baseUrl, '/jobs', {
        buyerDid: walletBuyer.did,
        agentDid: agent.did,
        repository: 'buyer/target-repo',
        brief: 'Fix the login bug',
      }, walletBuyer);
      const jobId = String(((await created.json()) as Record<string, unknown>).id);
      await postSigned(started.baseUrl, `/jobs/${jobId}/criteria`, { criteria: proposal, priceUsd: '500.00' }, agent);
      await postSigned(started.baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, walletBuyer);
      await postSigned(started.baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agent);
      await postSigned(started.baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, walletBuyer);
      await postSigned(started.baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agent);
      await postSigned(started.baseUrl, `/jobs/${jobId}/price/accept`, {}, walletBuyer);
      await postSigned(started.baseUrl, `/jobs/${jobId}/price/accept`, {}, agent);
      // The session mints while the deposit is still open (rail null),
      // exactly the B23 sequencing this suite's own withdrawal test
      // above uses: mint first, then let the fact change mid-session, so
      // onAuth's OWN check is what refuses, not /start or prepareTx.
      const { sessionToken, authCallbackUrl } = await startAbtSession(started.baseUrl, walletBuyer, { jobId, leg: 'deposit' });
      await started.settlementRepo.record({
        jobId, leg: 'deposit', rail: 'usdc', hash: 'h5', secondaryHash: null,
        operatorAddress: USDC_OPERATOR_ADDRESS, feeAddress: USDC_FEE_ADDRESS, amountUsd: '125.00', observedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const authPath = new URL(authCallbackUrl).pathname;
      const step0Res = await fetch(authCallbackUrl);
      const step0Body = (await step0Res.json()) as DidConnectClaimResponse;
      const step0 = decodeClaimBody(step0Body);
      const step0SubmitRes = await fetch(`${started.baseUrl}${authPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          _t_: sessionToken,
          userPk: buyerWallet.publicKey,
          userInfo: await walletResponseJwt(buyerWallet, step0.challenge, [{ type: 'authPrincipal' }]),
        }),
      });
      const step1Body = (await step0SubmitRes.json()) as DidConnectClaimResponse;
      const step1 = decodeClaimBody(step1Body);
      const prepareTxClaim = step1.requestedClaims.find((c) => c.type === 'prepareTx') as
        | { readonly partialTx: string }
        | undefined;
      if (prepareTxClaim === undefined) {
        throw new Error('expected a prepareTx claim at step 1');
      }
      const finalTx = await walletSignsPartialTx(prepareTxClaim.partialTx, buyerWallet);
      const step1SubmitRes = await fetch(`${started.baseUrl}${authPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          _t_: sessionToken,
          userPk: buyerWallet.publicKey,
          userInfo: await walletResponseJwt(buyerWallet, step1.challenge, [{ type: 'prepareTx', finalTx }]),
        }),
      });
      const finalBody = (await step1SubmitRes.json()) as { appPk: string; authInfo: string };
      const decoded = jwtDecode(finalBody.authInfo) as unknown as Record<string, unknown>;
      const response = decoded.response as { confirmed: boolean };
      const errorMessage = decoded.errorMessage as string | undefined;
      // onAuth's own eligibility gate is what refuses here: a settled
      // deposit in the other currency.
      expect(response.confirmed).toBe(false);
      expect(errorMessage).toContain('usdc');
      const row = await started.settlementRepo.findByJobAndLeg(jobId, 'deposit');
      expect(row?.rail).toBe('usdc');
    } finally {
      started.server.close();
    }
  });
});

describe('rule 5: no payout address for THIS currency refuses an open quote, before any rail is pinned', () => {
  it('abt deposit/start refuses naming the missing operator address when only the usdc address is set', async () => {
    const { server, baseUrl } = await startApp({ usdcAddress: USDC_OPERATOR_ADDRESS });
    try {
      const jobId = await walkToOpenProposed(baseUrl);
      const res = await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/abt/start`, {}, buyer);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('operator address');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('the token-mint door refuses naming the missing operator address when only the usdc address is set', async () => {
    const { server, baseUrl } = await startApp({ usdcAddress: USDC_OPERATOR_ADDRESS });
    try {
      const jobId = await walkToOpenProposed(baseUrl);
      const res = await getSigned(baseUrl, `/api/did/pay/token?jobId=${jobId}&leg=deposit`, buyer);
      expect(res.status).toBe(409);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
