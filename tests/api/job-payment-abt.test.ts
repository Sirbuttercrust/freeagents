// P10: the ABT payment surface, driven end to end over real HTTP through
// the actual DID Connect protocol (brief, "the ABT flow is reachable end
// to end over HTTP against a fake chain client"). This test plays the
// WALLET side of the protocol itself, exactly the sequence
// qr-server.mjs's real mobile wallet drives: fetch a session token, fetch
// the first signed claim (authPrincipal), answer it, receive the second
// signed claim (prepareTx), sign the partial transaction the way a wallet
// would, and post the finished response back. No unit test substitutes
// for this: every guard in the payment surface is a route guard, and this
// is the only test that reaches the route through the wallet's own wire
// protocol.
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromRandom, type WalletObject } from '@ocap/wallet';
import { decode as jwtDecode, sign as jwtSign } from '@arcblock/jwt';
import { encodeTx as clientEncodeTx } from '@ocap/client/encode';
import { decodeTx as cborDecodeTx, encodeTx as cborEncodeTx } from '@ocap/message/cbor';
import { fromBase58, toBase58 } from '@ocap/util';
import { createApp } from '../../src/api/app.js';
import { PrismaSettlementGate } from '../../src/adapters/payment/gate.js';
import { createAbtPaymentRail, type AbtChainClient } from '../../src/adapters/payment/abt.js';
import type { AbtTxEncoder } from '../../src/adapters/payment/abt-did-connect.js';
import { MemorySettlementRepository } from '../../src/adapters/storage/memory.js';
import { MemoryAgentRepository, MemoryJobRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { signingIdentityFromWallet, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';

const proposal = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
];

const platformWallet = fromRandom();
const TOKEN = fromRandom().address;
const FEE_ADDRESS = fromRandom().address;

function abtEnv(): Record<string, string> {
  return {
    FREEAGENTS_ABT_CHAIN_HOST: 'https://beta.abtnetwork.io/api',
    FREEAGENTS_ABT_PLATFORM_SK: platformWallet.secretKey,
    FREEAGENTS_ABT_TOKEN: TOKEN,
    FREEAGENTS_ABT_FEE_ADDRESS: FEE_ADDRESS,
  };
}

const OPERATOR_ADDRESS = fromRandom().address;

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    original[key] = process.env[key];
    process.env[key] = vars[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

// A pure, no-network encoder (FACTORY_RULES.md: no network in the test
// suite): @ocap/client/encode's own encodeTx is already a pure function,
// this only pins a fixed chainId/feeConfig so no fetchContext call is
// ever reachable from this test.
const pureTxEncoder: AbtTxEncoder = async ({ type, data, wallet, chainHost }) => {
  void chainHost;
  const { buffer } = clientEncodeTx({ type, tx: data as never, wallet: wallet as never, chainId: 'test-chain', feeConfig: [] });
  return buffer;
};

function fakeAbtChainClient(confirmed = true): { client: AbtChainClient; sentTx: () => string | undefined; hash: string } {
  let sent: string | undefined;
  const hash = 'broadcast-hash-1';
  const client: AbtChainClient = {
    decodeTx: async (bytes) => cborDecodeTx(bytes),
    sendTx: async (input) => {
      sent = input.tx;
      return { hash };
    },
    getTx: async () => ({ code: confirmed ? 'OK' : 'FAILED' }),
    getAccountState: async () => ({ state: null }),
  };
  return { client, sentTx: () => sent, hash };
}

// Signs the JWT a real DID Wallet would produce for one DID Connect
// response step: iss/iat/nbf/exp/version come from JWT.sign itself; this
// only supplies the protocol fields (challenge, requestedClaims) the
// server's authenticator.verify() actually reads.
async function walletResponseJwt(
  wallet: WalletObject,
  challenge: string,
  requestedClaims: readonly Record<string, unknown>[],
): Promise<string> {
  return jwtSign(
    wallet.address,
    wallet.secretKey,
    { action: 'responseAuth', challenge, requestedClaims },
    true,
    '1.1.0',
  );
}

// The wallet's own step: decode the partial tx it was asked to sign,
// add its own input and signature, re-encode. cborDecodeTx flattens the
// itx envelope (type/inputs/outputs at the top level, matching what
// abt.ts's own onWalletResponse decodes); cborEncodeTx's own input shape
// is the nested type/value envelope, exactly mirroring
// tests/adapters/payment/never-input-owner.test.ts's identical helper.
async function walletSignsPartialTx(partialTxBase58: string, buyer: WalletObject): Promise<string> {
  const decoded = cborDecodeTx(fromBase58(partialTxBase58)) as Record<string, unknown>;
  const itx = decoded.itx as { readonly typeUrl: string; readonly outputs: unknown };
  const signed = {
    ...decoded,
    itx: {
      typeUrl: itx.typeUrl,
      inputs: [{ owner: buyer.address }],
      outputs: itx.outputs,
    },
    signatures: [{ signer: buyer.address }],
  };
  const bytes = cborEncodeTx(signed as never);
  return toBase58(bytes);
}

interface DidConnectClaimResponse {
  readonly appPk: string;
  readonly authInfo: string;
}

function decodeClaimBody(response: DidConnectClaimResponse): {
  readonly challenge: string;
  readonly requestedClaims: readonly Record<string, unknown>[];
} {
  const body = jwtDecode(response.authInfo) as unknown as { challenge: string; requestedClaims: Record<string, unknown>[] };
  return { challenge: body.challenge, requestedClaims: body.requestedClaims };
}

// Drives the full DID Connect wallet protocol for one payment leg,
// against the real HTTP routes, exactly the sequence a mobile wallet
// follows: token, first claim (authPrincipal), second claim (prepareTx),
// sign it, submit, read the final confirmed/error result.
async function driveAbtPayment(
  baseUrl: string,
  buyerWallet: WalletObject,
  params: { readonly jobId: string; readonly leg: 'deposit' | 'remainder'; readonly operatorAddress: string },
): Promise<{ readonly confirmed: boolean; readonly error?: string }> {
  const tokenRes = await fetch(
    `${baseUrl}/api/did/pay/token?jobId=${encodeURIComponent(params.jobId)}&leg=${params.leg}&operatorAddress=${encodeURIComponent(params.operatorAddress)}`,
  );
  const tokenBody = (await tokenRes.json()) as { token: string };
  const sessionToken = tokenBody.token;

  const step0Res = await fetch(`${baseUrl}/api/did/pay/auth?_t_=${sessionToken}`);
  const step0Body = (await step0Res.json()) as DidConnectClaimResponse;
  const step0 = decodeClaimBody(step0Body);

  const step0SubmitRes = await fetch(`${baseUrl}/api/did/pay/auth`, {
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

  const step1SubmitRes = await fetch(`${baseUrl}/api/did/pay/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      _t_: sessionToken,
      userPk: buyerWallet.publicKey,
      userInfo: await walletResponseJwt(buyerWallet, step1.challenge, [{ type: 'prepareTx', finalTx }]),
    }),
  });
  const finalBody = (await step1SubmitRes.json()) as { appPk: string; authInfo: string };
  // ensureSignedJson (did-connect-js's own wrapper) lifts 'error' to the
  // TOP level of the signed payload and strips it from response, so the
  // error string is a sibling of response, not nested inside it.
  const decoded = jwtDecode(finalBody.authInfo) as unknown as Record<string, unknown>;
  const response = decoded.response as { confirmed: boolean };
  const error = decoded.errorMessage as string | undefined;
  return error === undefined || error === '' ? { confirmed: response.confirmed } : { confirmed: response.confirmed, error };
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

interface StartedAbtApp {
  readonly server: Server;
  readonly baseUrl: string;
  readonly buyerWallet: WalletObject;
  readonly settlementRepo: MemorySettlementRepository;
  readonly gate: PrismaSettlementGate;
  readonly jobId: string;
}

async function startAbtApp(chainClient: AbtChainClient): Promise<StartedAbtApp> {
  return withEnv(abtEnv(), async () => {
    const buyerWallet = fromRandom();
    const agentWallet = fromRandom();
    const abtRail = createAbtPaymentRail({ chainClient, rateSource: async () => '1' });

    const buyer = await signingIdentityFromWallet(buyerWallet);
    const agent = await signingIdentityFromWallet(agentWallet);

    const operatorRepo = new MemoryAccountRepository();
    await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-abt-surface' });
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: 'did:abt:op-abt-surface',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const jobRepo = new MemoryJobRepository();
    const settlementRepo = new MemorySettlementRepository();
    const gate = new PrismaSettlementGate(settlementRepo);

    const app = createApp(
      operatorRepo,
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
      gate,
      anyCommitStagingObserver(),
      undefined,
      abtRail,
      null,
      settlementRepo,
      pureTxEncoder,
    );
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const created = await postSigned(baseUrl, '/jobs', {
      buyerDid: buyer.did,
      agentDid: agent.did,
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug',
    }, buyer);
    const job = (await created.json()) as Record<string, unknown>;
    const jobId = String(job.id);
    await postSigned(baseUrl, `/jobs/${jobId}/criteria`, { criteria: proposal, priceUsd: '400.00', rail: 'abt' }, agent);
    await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, buyer);
    await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agent);
    await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, buyer);
    await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agent);
    await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, buyer);
    await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, agent);

    return { server, baseUrl, buyerWallet, settlementRepo, gate, jobId };
  });
}

describe('the ABT DID Connect payment flow, driven end to end over HTTP', () => {
  let started: StartedAbtApp;
  let fakeChain: ReturnType<typeof fakeAbtChainClient>;

  beforeAll(async () => {
    fakeChain = fakeAbtChainClient(true);
    started = await startAbtApp(fakeChain.client);
  });

  afterAll(() => started.server.close());

  it('start, claim, wallet response, confirm: settlement is written and the gate opens confirm', async () => {
    const result = await driveAbtPayment(started.baseUrl, started.buyerWallet, {
      jobId: started.jobId,
      leg: 'deposit',
      operatorAddress: OPERATOR_ADDRESS,
    });
    expect(result.confirmed).toBe(true);

    const row = await started.settlementRepo.findByJobAndLeg(started.jobId, 'deposit');
    expect(row).not.toBeNull();
    expect(row?.rail).toBe('abt');
    expect(row?.amountUsd).toBe('100.00');

    expect(await started.gate.depositSettled(started.jobId)).toBe(true);
  });
});

describe('the ABT payment flow refuses a wallet whose DID is not the job\'s buyer', () => {
  it('a stranger wallet completes the protocol but the payment is refused, and no settlement is written', async () => {
    const fakeChain2 = fakeAbtChainClient(true);
    const started2 = await startAbtApp(fakeChain2.client);
    try {
      const stranger = fromRandom();
      const result = await driveAbtPayment(started2.baseUrl, stranger, {
        jobId: started2.jobId,
        leg: 'deposit',
        operatorAddress: OPERATOR_ADDRESS,
      });
      expect(result.confirmed).toBe(false);
      expect(result.error).toBeDefined();
      expect(await started2.settlementRepo.findByJobAndLeg(started2.jobId, 'deposit')).toBeNull();
      expect(await started2.gate.depositSettled(started2.jobId)).toBe(false);
    } finally {
      started2.server.close();
    }
  });
});

describe('confirm() answering confirmed: false writes no settlement row on ABT', () => {
  it('a chain that never confirms the tx leaves no row and the gate refuses', async () => {
    const fakeChainUnconfirmed = fakeAbtChainClient(false);
    const started3 = await startAbtApp(fakeChainUnconfirmed.client);
    try {
      const result = await driveAbtPayment(started3.baseUrl, started3.buyerWallet, {
        jobId: started3.jobId,
        leg: 'deposit',
        operatorAddress: OPERATOR_ADDRESS,
      });
      expect(result.confirmed).toBe(false);
      expect(await started3.settlementRepo.findByJobAndLeg(started3.jobId, 'deposit')).toBeNull();
      expect(await started3.gate.depositSettled(started3.jobId)).toBe(false);
    } finally {
      started3.server.close();
    }
  });
});

describe('POST /jobs/:jobId/payments/deposit/abt/start: an unconfigured rail refuses cleanly', () => {
  it('answers a clear 503 naming the rail, and the process does not crash', async () => {
    const buyerWallet = fromRandom();
    const agentWallet = fromRandom();
    const buyer = await signingIdentityFromWallet(buyerWallet);
    const agent = await signingIdentityFromWallet(agentWallet);
    const operatorRepo = new MemoryAccountRepository();
    await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-abt-unconfigured' });
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: 'did:abt:op-abt-unconfigured',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const jobRepo = new MemoryJobRepository();
    const settlementRepo = new MemorySettlementRepository();
    const gate = new PrismaSettlementGate(settlementRepo);
    const app = createApp(
      operatorRepo,
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
      gate,
      anyCommitStagingObserver(),
      undefined,
      null,
      null,
      settlementRepo,
    );
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const created = await postSigned(baseUrl, '/jobs', {
        buyerDid: buyer.did,
        agentDid: agent.did,
        repository: 'buyer/target-repo',
        brief: 'Fix the login bug',
      }, buyer);
      const job = (await created.json()) as Record<string, unknown>;
      const jobId = String(job.id);
      const startRes = await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/abt/start`, { operatorAddress: 'z1Operator' }, buyer);
      expect(startRes.status).toBe(503);
      const body = (await startRes.json()) as Record<string, unknown>;
      expect(String(body.error)).toContain('abt');
    } finally {
      server.close();
    }
  });
});
