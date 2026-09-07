// P10: the ABT payment surface, driven end to end over real HTTP through
// the actual DID Connect protocol (brief, "the ABT flow is reachable end
// to end over HTTP against a fake chain client"). This test plays the
// WALLET side of the protocol itself, exactly the sequence
// qr-server.mjs's real mobile wallet drives: call the buyer's own /start
// route to mint a session, decode the wallet callback URL it returns
// (review round 1, D1: no test may hard-code that path, since a real
// wallet only ever learns it from the /start response), fetch the first
// signed claim (authPrincipal), answer it, receive the second signed
// claim (prepareTx), sign the partial transaction the way a wallet
// would, and post the finished response back. No unit test substitutes
// for this: every guard in the payment surface is a route guard, and
// this is the only test that reaches the route through the wallet's own
// wire protocol.
import type { Server } from 'node:http';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromRandom, type WalletObject } from '@ocap/wallet';
import { decode as jwtDecode, sign as jwtSign } from '@arcblock/jwt';
import { encodeTx as clientEncodeTx } from '@ocap/client/encode';
import { decodeTx as cborDecodeTx, encodeTx as cborEncodeTx } from '@ocap/message/cbor';
import { fromBase58, fromBase64, toBase58 } from '@ocap/util';
import { createApp } from '../../src/api/app.js';
import { PrismaSettlementGate } from '../../src/adapters/payment/gate.js';
import { createAbtPaymentRail, type AbtChainClient } from '../../src/adapters/payment/abt.js';
import type { AbtTxEncoder } from '../../src/adapters/payment/abt-did-connect.js';
import { didSuffix } from '../../src/domain/agent.js';
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

function abtEnv(baseUrl: string): Record<string, string> {
  return {
    FREEAGENTS_ABT_CHAIN_HOST: 'https://beta.abtnetwork.io/api',
    FREEAGENTS_ABT_PLATFORM_SK: platformWallet.secretKey,
    FREEAGENTS_ABT_TOKEN: TOKEN,
    FREEAGENTS_ABT_FEE_ADDRESS: FEE_ADDRESS,
    // The DID Connect wallet callback URL is built from this (WalletAuthenticator's
    // own baseUrl), which is why it must resolve to the SAME server this
    // test's own fetch calls land on (review round 1, D1): a mismatch here
    // is exactly the defect that round found.
    FREEAGENTS_PUBLIC_BASE_URL: baseUrl,
  };
}

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

// Reserves a real ephemeral port on 127.0.0.1 and releases it immediately,
// so the app's own FREEAGENTS_PUBLIC_BASE_URL (baked in before createApp
// is called, since WalletAuthenticator reads it at construction) can name
// the exact address the app will bind to a moment later. There is a small
// window between this close() and the real listen() below where another
// process could claim the same port; acceptable for a test.
async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        reject(new Error('expected a port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
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
    // S2: getTx must answer THE CHAIN's own record of what this
    // transaction actually paid, read from the exact bytes that were
    // broadcast (sent), never invented -- confirm() binds against
    // outputs, so a fake that echoed back an empty list would make every
    // route-level test here fail confirm() for the wrong reason (no
    // outputs to bind against) rather than proving the real path.
    getTx: async () => {
      if (!confirmed || sent === undefined) {
        return { code: 'FAILED', outputs: [] };
      }
      const decoded = cborDecodeTx(fromBase64(sent)) as { itx: { outputs: readonly { owner: string; tokens: readonly { address: string; value: string }[] }[] } };
      return { code: 'OK', outputs: decoded.itx.outputs };
    },
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
// `outputsOverride`, when supplied, replaces the outputs the partial tx
// itself named before signing -- simulating a MALICIOUS wallet that
// redirects a payment (review round 2, D1's own reproduction shape).
async function walletSignsPartialTx(partialTxBase58: string, buyer: WalletObject, outputsOverride?: unknown): Promise<string> {
  const decoded = cborDecodeTx(fromBase58(partialTxBase58)) as Record<string, unknown>;
  const itx = decoded.itx as { readonly typeUrl: string; readonly outputs: unknown };
  const signed = {
    ...decoded,
    itx: {
      typeUrl: itx.typeUrl,
      inputs: [{ owner: buyer.address }],
      outputs: outputsOverride ?? itx.outputs,
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

async function getSigned(baseUrl: string, path: string, identity: SigningIdentity): Promise<Response> {
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, 'GET', targetUri);
  return fetch(targetUri, {
    headers: {
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
  });
}

// Calls the buyer's own /start route (review round 1, D1: never a
// hard-coded /api/did/pay/token call) and decodes the wallet callback URL
// it hands back, exactly as a real DID Wallet would: the response's `url`
// field is the abtwallet.io deep link, and the callback address the
// wallet actually fetches is the `url` query parameter nested inside it
// (WalletAuthenticator.uri()'s own shape).
async function startAbtSession(
  baseUrl: string,
  starter: SigningIdentity,
  params: { readonly jobId: string; readonly leg: 'deposit' | 'remainder' },
): Promise<{ readonly sessionToken: string; readonly authCallbackUrl: string }> {
  const res = await postSigned(
    baseUrl,
    `/jobs/${params.jobId}/payments/${params.leg}/abt/start`,
    {},
    starter,
  );
  if (res.status !== 200) {
    throw new Error(`abt /start failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { readonly token: string; readonly url: string };
  const deepLink = new URL(body.url);
  // WalletAuthenticator.uri() (node_modules/@arcblock/did-connect-js/dist/
  // authenticator/wallet.js) builds this deep link by calling
  // encodeURIComponent on the callback URL itself, then passing the
  // whole payload object (including that already-encoded string) through
  // querystring.stringify, which encodes it a second time. URLSearchParams
  // decodes one layer (the qs.stringify layer); the encodeURIComponent
  // layer WalletAuthenticator itself added is still there afterward, so
  // this needs one more decode to get the real callback URL a wallet
  // would actually fetch.
  const encodedCallbackUrl = deepLink.searchParams.get('url');
  if (encodedCallbackUrl === null) {
    throw new Error('expected a wallet callback url inside the abt start response');
  }
  const authCallbackUrl = decodeURIComponent(encodedCallbackUrl);
  return { sessionToken: body.token, authCallbackUrl };
}

// Drives the full DID Connect wallet protocol for one payment leg,
// against the real HTTP routes, exactly the sequence a mobile wallet
// follows: start a session through the buyer's own route (never a
// hard-coded path), fetch the first claim (authPrincipal), answer it,
// receive the second claim (prepareTx), sign it, submit, read the final
// confirmed/error result. `starter` is whoever signs the HTTP request
// that mints the session (must be the job's buyer, or /start itself
// refuses); `wallet` is whoever completes the DID Connect steps, which
// may be a different DID, to prove onAuth's own buyerDid check.
async function driveAbtPayment(
  baseUrl: string,
  starter: SigningIdentity,
  wallet: WalletObject,
  params: { readonly jobId: string; readonly leg: 'deposit' | 'remainder' },
  outputsOverride?: unknown,
): Promise<{ readonly confirmed: boolean; readonly error?: string }> {
  const { sessionToken, authCallbackUrl } = await startAbtSession(baseUrl, starter, params);
  const authPath = new URL(authCallbackUrl).pathname;

  const step0Res = await fetch(authCallbackUrl);
  const step0Body = (await step0Res.json()) as DidConnectClaimResponse;
  const step0 = decodeClaimBody(step0Body);

  const step0SubmitRes = await fetch(`${baseUrl}${authPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      _t_: sessionToken,
      userPk: wallet.publicKey,
      userInfo: await walletResponseJwt(wallet, step0.challenge, [{ type: 'authPrincipal' }]),
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

  const finalTx = await walletSignsPartialTx(prepareTxClaim.partialTx, wallet, outputsOverride);

  const step1SubmitRes = await fetch(`${baseUrl}${authPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      _t_: sessionToken,
      userPk: wallet.publicKey,
      userInfo: await walletResponseJwt(wallet, step1.challenge, [{ type: 'prepareTx', finalTx }]),
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

interface StartedAbtApp {
  readonly server: Server;
  readonly baseUrl: string;
  readonly buyer: SigningIdentity;
  readonly buyerWallet: WalletObject;
  readonly settlementRepo: MemorySettlementRepository;
  readonly gate: PrismaSettlementGate;
  readonly jobId: string;
  readonly agent: SigningIdentity;
  readonly operatorRepo: MemoryAccountRepository;
}

async function startAbtApp(chainClient: AbtChainClient): Promise<StartedAbtApp> {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  return withEnv(abtEnv(baseUrl), async () => {
    const buyerWallet = fromRandom();
    const agentWallet = fromRandom();
    // S2: an in-memory spent-transfer store so this route test never
    // touches Prisma (DATABASE_URL is unset here), mirroring
    // tests/api/job-payment-usdc.test.ts's own fakeSpentTransferStorage.
    const spentTransferRows = new Map<string, { hash: string; jobId: string; leg: 'deposit' | 'balance' }>();
    const spentTransferStorage = {
      async record(row: { hash: string; jobId: string; leg: 'deposit' | 'balance' }): Promise<void> {
        spentTransferRows.set(row.hash, { ...row });
      },
      async findByHash(hash: string) {
        return spentTransferRows.get(hash) ?? null;
      },
    };
    const abtRail = createAbtPaymentRail({ chainClient, rateSource: async () => '1', spentTransferStorage });

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
    const server = app.listen(port, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));

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

    return { server, baseUrl, buyer, buyerWallet, settlementRepo, gate, jobId, agent, operatorRepo };
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

  it('start, claim, wallet response, confirm: settlement is written and the gate opens confirm, paying the hired agent\'s operator, never a caller-named address', async () => {
    const result = await driveAbtPayment(started.baseUrl, started.buyer, started.buyerWallet, {
      jobId: started.jobId,
      leg: 'deposit',
    });
    expect(result.confirmed).toBe(true);

    const row = await started.settlementRepo.findByJobAndLeg(started.jobId, 'deposit');
    expect(row).not.toBeNull();
    expect(row?.rail).toBe('abt');
    expect(row?.amountUsd).toBe('100.00');
    // S3, Ruling 1: the recipient is derived from the hired agent's
    // operatorDid (didSuffix), fixed at 'did:abt:op-abt-surface' by
    // startAbtApp -- never anything a caller named.
    expect(row?.operatorAddress).toBe(didSuffix('did:abt:op-abt-surface'));

    expect(await started.gate.depositSettled(started.jobId)).toBe(true);
  });
});

describe('the ABT payment flow refuses a wallet that redirects the operator output to an attacker (review round 2, D1)', () => {
  it('a wallet that signs and broadcasts cleanly but names a different owner for the operator output does not confirm', async () => {
    const fakeChain8 = fakeAbtChainClient(true);
    const started8 = await startAbtApp(fakeChain8.client);
    try {
      // Drive the full DID Connect wallet protocol, but the WALLET step
      // swaps the operator output's owner to an attacker before signing
      // (amounts and the fee output untouched): the honest sequence a
      // real mobile wallet would follow right up until the moment it
      // decides who actually gets paid. fakeAbtChainClient's own getTx
      // replays the exact bytes sendTx received, so this is the chain's
      // real record of what was broadcast, never an invented list.
      const attacker = 'z1Attacker0000000000000000000000000000';
      const { sessionToken, authCallbackUrl } = await startAbtSession(started8.baseUrl, started8.buyer, {
        jobId: started8.jobId,
        leg: 'deposit',
      });
      const authPath = new URL(authCallbackUrl).pathname;
      const step0Res = await fetch(authCallbackUrl);
      const step0Body = (await step0Res.json()) as DidConnectClaimResponse;
      const step0 = decodeClaimBody(step0Body);
      const step0SubmitRes = await fetch(`${started8.baseUrl}${authPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          _t_: sessionToken,
          userPk: started8.buyerWallet.publicKey,
          userInfo: await walletResponseJwt(started8.buyerWallet, step0.challenge, [{ type: 'authPrincipal' }]),
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
      const decodedPartial = cborDecodeTx(fromBase58(prepareTxClaim.partialTx)) as {
        itx: { outputs: readonly { owner: string; tokens: unknown; assets: unknown }[] };
      };
      const tamperedOutputs = [
        { ...decodedPartial.itx.outputs[0], owner: attacker },
        decodedPartial.itx.outputs[1],
      ];
      const finalTx = await walletSignsPartialTx(prepareTxClaim.partialTx, started8.buyerWallet, tamperedOutputs);
      const step1SubmitRes = await fetch(`${started8.baseUrl}${authPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          _t_: sessionToken,
          userPk: started8.buyerWallet.publicKey,
          userInfo: await walletResponseJwt(started8.buyerWallet, step1.challenge, [{ type: 'prepareTx', finalTx }]),
        }),
      });
      const finalBody = (await step1SubmitRes.json()) as { appPk: string; authInfo: string };
      const decoded = jwtDecode(finalBody.authInfo) as unknown as Record<string, unknown>;
      const response = decoded.response as { confirmed: boolean };

      expect(response.confirmed).toBe(false);
      expect(await started8.settlementRepo.findByJobAndLeg(started8.jobId, 'deposit')).toBeNull();
      expect(await started8.gate.depositSettled(started8.jobId)).toBe(false);
    } finally {
      started8.server.close();
    }
  });
});

describe('the ABT payment flow refuses a wallet whose DID is not the job\'s buyer', () => {
  it('a stranger wallet completes the protocol but the payment is refused, and no settlement is written', async () => {
    const fakeChain2 = fakeAbtChainClient(true);
    const started2 = await startAbtApp(fakeChain2.client);
    try {
      const stranger = fromRandom();
      // The session is minted properly (starter is the real buyer, so
      // /start itself lets it through); the stranger only ever gets as
      // far as completing the wallet protocol with their own DID, which
      // onAuth's own buyerDid check must still refuse.
      const result = await driveAbtPayment(started2.baseUrl, started2.buyer, stranger, {
        jobId: started2.jobId,
        leg: 'deposit',
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
      const result = await driveAbtPayment(started3.baseUrl, started3.buyer, started3.buyerWallet, {
        jobId: started3.jobId,
        leg: 'deposit',
      });
      expect(result.confirmed).toBe(false);
      expect(await started3.settlementRepo.findByJobAndLeg(started3.jobId, 'deposit')).toBeNull();
      expect(await started3.gate.depositSettled(started3.jobId)).toBe(false);
    } finally {
      started3.server.close();
    }
  });
});

describe('POST /jobs/:jobId/payments/deposit/abt/start: the wallet callback URL it returns is reachable on the same server', () => {
  it('review round 1, D1: fetching body.url\'s decoded callback path answers the real DID Connect claim, not a 404', async () => {
    const fakeChain4 = fakeAbtChainClient(true);
    const started4 = await startAbtApp(fakeChain4.client);
    try {
      const { authCallbackUrl } = await startAbtSession(started4.baseUrl, started4.buyer, {
        jobId: started4.jobId,
        leg: 'deposit',
      });
      // A real mobile wallet's very next step is fetching exactly this
      // URL. Before the D1 fix this answered 404, because did-connect-js
      // builds it from the /start route's own path rather than the
      // /api/did/pay/token path it is actually mounted at.
      const res = await fetch(authCallbackUrl);
      expect(res.status).toBe(200);
      const body = (await res.json()) as DidConnectClaimResponse;
      expect(typeof body.authInfo).toBe('string');
      expect(body.authInfo.length).toBeGreaterThan(0);
    } finally {
      started4.server.close();
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
      const startRes = await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/abt/start`, {}, buyer);
      expect(startRes.status).toBe(503);
      const body = (await startRes.json()) as Record<string, unknown>;
      expect(String(body.error)).toContain('abt');
    } finally {
      server.close();
    }
  });
});

describe('review round 1, D2: the abt session-minting route refuses a request that does not name the buyer', () => {
  let started5: StartedAbtApp;
  let fakeChain5: ReturnType<typeof fakeAbtChainClient>;

  beforeAll(async () => {
    fakeChain5 = fakeAbtChainClient(true);
    started5 = await startAbtApp(fakeChain5.client);
  });

  afterAll(() => started5.server.close());

  it('an unsigned request to /api/did/pay/token is refused before a session is minted', async () => {
    const res = await fetch(
      `${started5.baseUrl}/api/did/pay/token?jobId=${started5.jobId}&leg=deposit`,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain('signature');
  });

  it('a signed request naming a stranger, not the buyer, is refused and mints no session', async () => {
    const stranger = fromRandom();
    const strangerIdentity = await signingIdentityFromWallet(stranger);
    // Registered as a real account so its signature resolves at all (an
    // unregistered DID cannot be verified and 401s at didSignature
    // itself, which is the OTHER leg this describe block already covers,
    // not the one this test pins).
    await started5.operatorRepo.register({ did: strangerIdentity.did, githubLogin: 'stranger-abt-token' });
    const res = await getSigned(
      started5.baseUrl,
      `/api/did/pay/token?jobId=${started5.jobId}&leg=deposit`,
      strangerIdentity,
    );
    expect(res.status).toBe(403);
  });

  it('the buyer\'s own signed request still mints a session (the gate does not also block the legitimate caller)', async () => {
    const res = await getSigned(
      started5.baseUrl,
      `/api/did/pay/token?jobId=${started5.jobId}&leg=deposit`,
      started5.buyer,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.token).toBe('string');
  });
});

describe('review round 2, D3: the token-route buyer gate must check the jobId the session actually binds to', () => {
  let started6: StartedAbtApp;
  let fakeChain6: ReturnType<typeof fakeAbtChainClient>;
  let attacker: SigningIdentity;
  let attackerJobId: string;

  beforeAll(async () => {
    fakeChain6 = fakeAbtChainClient(true);
    started6 = await startAbtApp(fakeChain6.client);

    // The attacker is a real, registered buyer, but of their OWN job, not
    // started6's job. did-connect-js's generateSession folds req.body,
    // req.query and req.params into one extraParams object with query
    // winning over body (util.js: {...req.body, ...req.query, ...req.params}),
    // so a POST that carries the attacker's own jobId in the body and the
    // victim's jobId in the query must still be refused: the guard has to
    // check the same jobId the session will actually be bound to.
    const attackerWallet = fromRandom();
    attacker = await signingIdentityFromWallet(attackerWallet);
    await started6.operatorRepo.register({ did: attacker.did, githubLogin: 'attacker-abt-token' });
    const created = await postSigned(started6.baseUrl, '/jobs', {
      buyerDid: attacker.did,
      agentDid: started6.agent.did,
      repository: 'attacker/target-repo',
      brief: 'Fix the attacker\'s own bug',
    }, attacker);
    const job = (await created.json()) as Record<string, unknown>;
    attackerJobId = String(job.id);
    await postSigned(started6.baseUrl, `/jobs/${attackerJobId}/criteria`, { criteria: proposal, priceUsd: '400.00', rail: 'abt' }, started6.agent);
  });

  afterAll(() => started6.server.close());

  it('a POST carrying the attacker\'s own jobId in the body and the victim\'s jobId in the query is refused', async () => {
    const res = await postSigned(
      started6.baseUrl,
      `/api/did/pay/token?jobId=${started6.jobId}&leg=deposit`,
      { jobId: attackerJobId, leg: 'deposit' },
      attacker,
    );
    expect(res.status).toBe(403);
  });
});

describe('review round 3, D4: the job\'s own agent is a real party to the job but not its buyer, and starting an abt payment is refused', () => {
  it('the agent cannot start a payment for the job it was hired on, and no settlement is written', async () => {
    const fakeChain7 = fakeAbtChainClient(true);
    const started7 = await startAbtApp(fakeChain7.client);
    try {
      const res = await postSigned(
        started7.baseUrl,
        `/jobs/${started7.jobId}/payments/deposit/abt/start`,
        {},
        started7.agent,
      );
      expect(res.status).toBe(403);
      expect(await started7.settlementRepo.findByJobAndLeg(started7.jobId, 'deposit')).toBeNull();
    } finally {
      started7.server.close();
    }
  });
});

describe('S3: a buyer naming their own address is refused on both doors, and never settles', () => {
  it('the /start route refuses a body that still carries operatorAddress, with 400', async () => {
    const fakeChain9 = fakeAbtChainClient(true);
    const started9 = await startAbtApp(fakeChain9.client);
    try {
      const attackerAddress = fromRandom().address;
      const res = await postSigned(
        started9.baseUrl,
        `/jobs/${started9.jobId}/payments/deposit/abt/start`,
        { operatorAddress: attackerAddress },
        started9.buyer,
      );
      expect(res.status).toBe(400);
      expect(String((await res.json() as Record<string, unknown>).error)).toContain('resolved from the hired agent');
      expect(await started9.settlementRepo.findByJobAndLeg(started9.jobId, 'deposit')).toBeNull();
    } finally {
      started9.server.close();
    }
  });

  it('minting a session directly through /api/did/pay/token with operatorAddress in the query still pays the hired agent\'s operator, never the query value', async () => {
    const fakeChain10 = fakeAbtChainClient(true);
    const started10 = await startAbtApp(fakeChain10.client);
    try {
      const attackerAddress = fromRandom().address;
      // A buyer posting directly to /api/did/pay/token, bypassing /start
      // entirely, naming their own address in the query -- the second
      // door the ruling calls out by name.
      const res = await getSigned(
        started10.baseUrl,
        `/api/did/pay/token?jobId=${started10.jobId}&leg=deposit&operatorAddress=${attackerAddress}`,
        started10.buyer,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { readonly token: string; readonly url: string };
      const deepLink = new URL(body.url);
      const encodedCallbackUrl = deepLink.searchParams.get('url');
      if (encodedCallbackUrl === null) throw new Error('expected a wallet callback url');
      const authCallbackUrl = decodeURIComponent(encodedCallbackUrl);
      const authPath = new URL(authCallbackUrl).pathname;

      const step0Res = await fetch(authCallbackUrl);
      const step0Body = (await step0Res.json()) as DidConnectClaimResponse;
      const step0 = decodeClaimBody(step0Body);
      const step0SubmitRes = await fetch(`${started10.baseUrl}${authPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          _t_: body.token,
          userPk: started10.buyerWallet.publicKey,
          userInfo: await walletResponseJwt(started10.buyerWallet, step0.challenge, [{ type: 'authPrincipal' }]),
        }),
      });
      const step1Body = (await step0SubmitRes.json()) as DidConnectClaimResponse;
      const step1 = decodeClaimBody(step1Body);
      const prepareTxClaim = step1.requestedClaims.find((c) => c.type === 'prepareTx') as
        | { readonly partialTx: string }
        | undefined;
      if (prepareTxClaim === undefined) throw new Error('expected a prepareTx claim');
      // The claim itself already proves the fix: decode the partial tx
      // the server built and assert its own output owner is the hired
      // agent's operator, never the attacker's address named in the
      // query. If the vulnerability were still present, this would
      // decode to attackerAddress instead.
      const decodedPartial = cborDecodeTx(fromBase58(prepareTxClaim.partialTx)) as {
        itx: { outputs: readonly { owner: string }[] };
      };
      expect(decodedPartial.itx.outputs[0]?.owner).toBe(didSuffix('did:abt:op-abt-surface'));
      expect(decodedPartial.itx.outputs[0]?.owner).not.toBe(attackerAddress);
    } finally {
      started10.server.close();
    }
  });
});

describe('S3, Trap 1: self-hire settles normally on ABT, paying the buyer\'s own derived address', () => {
  it('a buyer hiring their own agent still settles the deposit leg, at the address derived from their own operatorDid', async () => {
    const fakeChain11 = fakeAbtChainClient(true);
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const started11 = await withEnv(abtEnv(baseUrl), async () => {
      const selfHirerWallet = fromRandom();
      const agentWallet = fromRandom();
      const spentTransferRows = new Map<string, { hash: string; jobId: string; leg: 'deposit' | 'balance' }>();
      const spentTransferStorage = {
        async record(row: { hash: string; jobId: string; leg: 'deposit' | 'balance' }): Promise<void> {
          spentTransferRows.set(row.hash, { ...row });
        },
        async findByHash(hash: string) {
          return spentTransferRows.get(hash) ?? null;
        },
      };
      const abtRail = createAbtPaymentRail({ chainClient: fakeChain11.client, rateSource: async () => '1', spentTransferStorage });

      const selfHirer = await signingIdentityFromWallet(selfHirerWallet);
      const agentIdentity = await signingIdentityFromWallet(agentWallet);

      const operatorRepo = new MemoryAccountRepository();
      await operatorRepo.register({ did: selfHirer.did, githubLogin: 'self-hirer-abt' });
      const agentRepo = new MemoryAgentRepository();
      await agentRepo.create({
        did: agentIdentity.did,
        // Self-hire: the agent's operator IS the buyer's own DID.
        operatorDid: selfHirer.did,
        delegation: { fixture: true } as never,
        name: 'self-hired-scout',
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
      const server = app.listen(port, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));

      const created = await postSigned(baseUrl, '/jobs', {
        buyerDid: selfHirer.did,
        agentDid: agentIdentity.did,
        repository: 'buyer/target-repo',
        brief: 'Fix the login bug',
      }, selfHirer);
      const job = (await created.json()) as Record<string, unknown>;
      const jobId = String(job.id);
      await postSigned(baseUrl, `/jobs/${jobId}/criteria`, { criteria: proposal, priceUsd: '400.00', rail: 'abt' }, agentIdentity);
      await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, selfHirer);
      await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agentIdentity);
      await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, selfHirer);
      await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agentIdentity);
      await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, selfHirer);
      await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, agentIdentity);

      return { server, baseUrl, selfHirer, selfHirerWallet, settlementRepo, jobId };
    });

    try {
      const result = await driveAbtPayment(started11.baseUrl, started11.selfHirer, started11.selfHirerWallet, {
        jobId: started11.jobId,
        leg: 'deposit',
      });
      expect(result.confirmed).toBe(true);
      const row = await started11.settlementRepo.findByJobAndLeg(started11.jobId, 'deposit');
      expect(row?.operatorAddress).toBe(didSuffix(started11.selfHirer.did));
    } finally {
      started11.server.close();
    }
  });
});
