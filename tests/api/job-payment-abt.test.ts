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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromRandom, type WalletObject } from '@ocap/wallet';
import { decode as jwtDecode } from '@arcblock/jwt';
import { decodeTx as cborDecodeTx } from '@ocap/message/cbor';
import { fromBase58 } from '@ocap/util';
import { createApp } from '../../src/api/app.js';
import { PrismaSettlementGate } from '../../src/adapters/payment/gate.js';
import { createAbtPaymentRail, type AbtChainClient } from '../../src/adapters/payment/abt.js';
import { didSuffix } from '../../src/domain/agent.js';
import { MemorySettlementRepository } from '../../src/adapters/storage/memory.js';
import { MemoryAgentRepository, MemoryJobRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { signingIdentityFromWallet, type SigningIdentity } from '../helpers/sign-request.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import {
  abtEnv,
  decodeClaimBody,
  driveAbtPayment,
  fakeAbtChainClient,
  getSigned,
  postSigned,
  pureTxEncoder,
  reservePort,
  startAbtSession,
  walletResponseJwt,
  walletSignsPartialTx,
  withEnv,
  type DidConnectClaimResponse,
} from '../helpers/abt-fixtures.js';

const proposal = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
];

const platformWallet = fromRandom();
const TOKEN = fromRandom().address;
const FEE_ADDRESS = fromRandom().address;

function testAbtEnv(baseUrl: string): Record<string, string> {
  return abtEnv(baseUrl, platformWallet, TOKEN, FEE_ADDRESS);
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
  return withEnv(testAbtEnv(baseUrl), async () => {
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
    // P8c: the ABT rail now reads operatorAddressAbt, never the DID
    // suffix, so this agent's operator needs a real account row carrying
    // one. Set to the SAME value the old suffix derivation would have
    // produced, so the existing assertions in this file (which predate
    // P8c) keep proving what they always proved.
    await operatorRepo.register({ did: 'did:abt:op-abt-surface', githubLogin: 'operator-abt-surface' });
    await operatorRepo.setOperatorAddressAbt('did:abt:op-abt-surface', didSuffix('did:abt:op-abt-surface'));
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

describe('S3: the second door combined with a malicious wallet redirect is refused, proving onAuth derives independently of prepareTx (review round 1, D1)', () => {
  it('a session minted through /api/did/pay/token naming an attacker address, then a wallet that redirects the signed payout to that same address, still refuses and settles nothing', async () => {
    const fakeChain12 = fakeAbtChainClient(true);
    const started12 = await startAbtApp(fakeChain12.client);
    try {
      const attackerAddress = fromRandom().address;
      // Door 2: mint directly through did-connect-js's own token route,
      // naming the attacker's address in the query. prepareTx already
      // ignores this (pinned above); this test goes further and proves
      // onAuth ALSO never trusts it, by having the wallet itself redirect
      // the signed output to that same address at the final step.
      const res = await getSigned(
        started12.baseUrl,
        `/api/did/pay/token?jobId=${started12.jobId}&leg=deposit&operatorAddress=${attackerAddress}`,
        started12.buyer,
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
      const step0SubmitRes = await fetch(`${started12.baseUrl}${authPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          _t_: body.token,
          userPk: started12.buyerWallet.publicKey,
          userInfo: await walletResponseJwt(started12.buyerWallet, step0.challenge, [{ type: 'authPrincipal' }]),
        }),
      });
      const step1Body = (await step0SubmitRes.json()) as DidConnectClaimResponse;
      const step1 = decodeClaimBody(step1Body);
      const prepareTxClaim = step1.requestedClaims.find((c) => c.type === 'prepareTx') as
        | { readonly partialTx: string }
        | undefined;
      if (prepareTxClaim === undefined) throw new Error('expected a prepareTx claim');

      const decodedPartial = cborDecodeTx(fromBase58(prepareTxClaim.partialTx)) as {
        itx: { outputs: readonly { owner: string; tokens: unknown; assets: unknown }[] };
      };
      // The wallet's final step: redirect the operator output to the
      // SAME attacker address it named in the query at mint time. This
      // is the reproduction onAuth alone must catch: prepareTx already
      // built an honest claim, so only onAuth's own comparison against
      // the finalTx stands between this and a written settlement.
      const tamperedOutputs = [
        { ...decodedPartial.itx.outputs[0], owner: attackerAddress },
        decodedPartial.itx.outputs[1],
      ];
      const finalTx = await walletSignsPartialTx(prepareTxClaim.partialTx, started12.buyerWallet, tamperedOutputs);

      const step1SubmitRes = await fetch(`${started12.baseUrl}${authPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          _t_: body.token,
          userPk: started12.buyerWallet.publicKey,
          userInfo: await walletResponseJwt(started12.buyerWallet, step1.challenge, [{ type: 'prepareTx', finalTx }]),
        }),
      });
      const finalBody = (await step1SubmitRes.json()) as { appPk: string; authInfo: string };
      const decoded = jwtDecode(finalBody.authInfo) as unknown as Record<string, unknown>;
      const response = decoded.response as { confirmed: boolean };

      expect(response.confirmed).toBe(false);
      expect(await started12.settlementRepo.findByJobAndLeg(started12.jobId, 'deposit')).toBeNull();
      expect(await started12.gate.depositSettled(started12.jobId)).toBe(false);
    } finally {
      started12.server.close();
    }
  });
});

describe('S3, Trap 1: self-hire settles normally on ABT, paying the buyer\'s own derived address', () => {
  it('a buyer hiring their own agent still settles the deposit leg, at the address derived from their own operatorDid', async () => {
    const fakeChain11 = fakeAbtChainClient(true);
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const started11 = await withEnv(testAbtEnv(baseUrl), async () => {
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
      // P8c: the self-hirer's own account needs its ABT payout address on
      // record, set to the same value the old suffix derivation would
      // have produced, so this test keeps proving the self-hire case
      // settles at the buyer's own derived address.
      await operatorRepo.setOperatorAddressAbt(selfHirer.did, didSuffix(selfHirer.did));
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

// P8c: the ABT rail reads Account.operatorAddressAbt, never derives the
// recipient from the hired agent's operator DID suffix (Anchor: that
// silent binding is exactly what this card exists to stop). These tests
// drive the real DID Connect wallet protocol, the same helpers every
// other describe block in this file uses, so the guard is proven
// reachable through the route, not only against a unit-tested helper.
describe('P8c: the ABT rail reads Account.operatorAddressAbt, and fails closed when it is unset', () => {
  it('an ABT payment start for a job whose hired agent\'s operator has no operatorAddressAbt refuses, naming the PATCH route', async () => {
    const fakeChain13 = fakeAbtChainClient(true);
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const started13 = await withEnv(testAbtEnv(baseUrl), async () => {
      const buyerWallet = fromRandom();
      const agentWallet = fromRandom();
      const spentTransferStorage = {
        async record(): Promise<void> {},
        async findByHash() {
          return null;
        },
      };
      const abtRail = createAbtPaymentRail({ chainClient: fakeChain13.client, rateSource: async () => '1', spentTransferStorage });

      const buyer = await signingIdentityFromWallet(buyerWallet);
      const agent = await signingIdentityFromWallet(agentWallet);

      const operatorRepo = new MemoryAccountRepository();
      await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-abt-unset' });
      const agentRepo = new MemoryAgentRepository();
      await agentRepo.create({
        did: agent.did,
        // A real, registered operator account, but one that has never set
        // an ABT payout address (P8c's own anchor case: an account the
        // platform provisions rather than a wallet proving possession).
        operatorDid: 'did:abt:op-abt-unset',
        delegation: { fixture: true } as never,
        name: 'scout',
        skills: ['triage'],
        githubLogin: null,
      });
      await operatorRepo.register({ did: 'did:abt:op-abt-unset', githubLogin: 'operator-abt-unset' });

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

      return { server, baseUrl, buyer, buyerWallet, settlementRepo, jobId };
    });

    try {
      const { sessionToken, authCallbackUrl } = await startAbtSession(started13.baseUrl, started13.buyer, {
        jobId: started13.jobId,
        leg: 'deposit',
      });
      const authPath = new URL(authCallbackUrl).pathname;
      const step0Res = await fetch(authCallbackUrl);
      const step0Body = (await step0Res.json()) as DidConnectClaimResponse;
      const step0 = decodeClaimBody(step0Body);
      // Advancing past authPrincipal is the step that signs the NEXT
      // claim (prepareTx), which is where operatorAddressForJob is
      // called; a null operator address throws before signing, so the
      // response here is the raw { error } shape, never a signed JWT.
      const step0SubmitRes = await fetch(`${started13.baseUrl}${authPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          _t_: sessionToken,
          userPk: started13.buyerWallet.publicKey,
          userInfo: await walletResponseJwt(started13.buyerWallet, step0.challenge, [{ type: 'authPrincipal' }]),
        }),
      });
      const finalBody = (await step0SubmitRes.json()) as { appPk: string; authInfo: string };
      const decoded = jwtDecode(finalBody.authInfo) as unknown as Record<string, unknown>;
      const errorMessage = decoded.errorMessage as string | undefined;
      expect(typeof errorMessage).toBe('string');
      expect(errorMessage).toContain('operator-address');
      expect(await started13.settlementRepo.findByJobAndLeg(started13.jobId, 'deposit')).toBeNull();
    } finally {
      started13.server.close();
    }
  });

  it('the same start succeeds once the operator sets an ABT address, and the prepared transaction pays THAT address, not the DID suffix', async () => {
    const fakeChain14 = fakeAbtChainClient(true);
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const DIFFERENT_ADDRESS = 'z6MkDifferentFromSuffix';
    const started14 = await withEnv(testAbtEnv(baseUrl), async () => {
      const buyerWallet = fromRandom();
      const agentWallet = fromRandom();
      const spentTransferStorage = {
        async record(): Promise<void> {},
        async findByHash() {
          return null;
        },
      };
      const abtRail = createAbtPaymentRail({ chainClient: fakeChain14.client, rateSource: async () => '1', spentTransferStorage });

      const buyer = await signingIdentityFromWallet(buyerWallet);
      const agent = await signingIdentityFromWallet(agentWallet);

      const operatorRepo = new MemoryAccountRepository();
      await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-abt-set' });
      const agentRepo = new MemoryAgentRepository();
      await agentRepo.create({
        did: agent.did,
        operatorDid: 'did:abt:op-abt-set',
        delegation: { fixture: true } as never,
        name: 'scout',
        skills: ['triage'],
        githubLogin: null,
      });
      await operatorRepo.register({ did: 'did:abt:op-abt-set', githubLogin: 'operator-abt-set' });
      // The stored address deliberately differs from the DID suffix
      // (didSuffix('did:abt:op-abt-set')), so a passing test proves the
      // rail pays the STORED address, never falling back to the suffix.
      await operatorRepo.setOperatorAddressAbt('did:abt:op-abt-set', DIFFERENT_ADDRESS);

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

      return { server, baseUrl, buyer, buyerWallet, settlementRepo, jobId };
    });

    try {
      const result = await driveAbtPayment(started14.baseUrl, started14.buyer, started14.buyerWallet, {
        jobId: started14.jobId,
        leg: 'deposit',
      });
      expect(result.confirmed).toBe(true);
      const row = await started14.settlementRepo.findByJobAndLeg(started14.jobId, 'deposit');
      expect(row).not.toBeNull();
      expect(row?.operatorAddress).toBe(DIFFERENT_ADDRESS);
      expect(row?.operatorAddress).not.toBe(didSuffix('did:abt:op-abt-set'));
    } finally {
      started14.server.close();
    }
  });
});
