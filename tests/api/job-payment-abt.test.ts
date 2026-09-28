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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fromRandom, type WalletObject } from '@ocap/wallet';
import { decode as jwtDecode } from '@arcblock/jwt';
import { decodeTx as cborDecodeTx } from '@ocap/message/cbor';
import { fromBase58, fromTokenToUnit } from '@ocap/util';
import { createApp } from '../../src/api/app.js';
import { PrismaSettlementGate } from '../../src/adapters/payment/gate.js';
import { createAbtPaymentRail, type AbtChainClient, type AbtRateSource } from '../../src/adapters/payment/abt.js';
import type { DidConnectSessionStorage } from '../../src/adapters/payment/session-storage-types.js';
import { didSuffix } from '../../src/domain/agent.js';
import { MemorySettlementRepository } from '../../src/adapters/storage/memory.js';
import { MemoryAgentRepository, MemoryJobRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import type { AccountRepository } from '../../src/adapters/storage/types.js';
import { signingIdentityFromWallet, type SigningIdentity } from '../helpers/sign-request.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';
import {
  abtEnv,
  answerPrepareTxClaim,
  continueAbtWalletProtocol,
  decodeClaimBody,
  driveAbtPayment,
  fakeAbtChainClient,
  fetchPrepareTxClaim,
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

// FIX-B70a: the DID Connect session storage the app builds for itself is
// the only place a payment lock lives, so the tests read it through a
// wrapper that also counts the sessions minted. The wrapper delegates
// every call to the real in-memory storage.
const sessionCapture = vi.hoisted(() => ({
  captured: [] as { creates: number; storage: unknown }[],
}));
vi.mock('../../src/adapters/payment/session-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/adapters/payment/session-storage.js')>();
  return {
    ...actual,
    createDidConnectSessionStorage: () => {
      const storage = actual.createDidConnectSessionStorage();
      const capture = { creates: 0, storage };
      sessionCapture.captured.push(capture);
      return {
        ...storage,
        create: async (token: string, status?: string) => {
          capture.creates += 1;
          return storage.create(token, status);
        },
      };
    },
  };
});

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
  readonly sessions: { readonly storage: DidConnectSessionStorage; readonly created: () => number };
  readonly jobRepo: MemoryJobRepository;
}

async function startAbtApp(
  chainClient: AbtChainClient,
  wrapOperatorRepo?: (repo: MemoryAccountRepository, operatorDid: string) => AccountRepository,
  rateSource: AbtRateSource = async () => '1',
): Promise<StartedAbtApp> {
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
    const abtRail = createAbtPaymentRail({ chainClient, rateSource, spentTransferStorage });

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
      // FIX-B37 (bugs.md B37 + B42): confirm has always refused an agent
      // with no verified GitHub login, and the deposit doors this file
      // exercises now check the identical fact before a session ever
      // mints (route-support.ts's checkAgentGithubVerified). This
      // fixture's own tests are about the ABT payment surface, not
      // about B42, so the fixture agent now carries a verified login
      // the same way tests/api/job-payment-usdc.test.ts's own fixture
      // agents already do (FACTORY_RULES 2.1: setup superseded, not the
      // assertion).
      githubLogin: 'scout-abt-surface',
      negotiatesOnOwnersBehalf: true,
    });
    await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-abt-surface', status: 'verified' });
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
    // FIX-B36: the /start route now reads the job's repository before a
    // deposit leg starts (Make item 2); this fixture answers a ready
    // repository by default, so every existing assertion in this file
    // keeps proving what it always proved.
    const { github } = createStagingLifecycleGithubFake();

    const capturedBefore = sessionCapture.captured.length;
    const app = createApp(
      wrapOperatorRepo !== undefined ? wrapOperatorRepo(operatorRepo, 'did:abt:op-abt-surface') : operatorRepo,
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

    const capture = sessionCapture.captured[capturedBefore];
    if (capture === undefined) throw new Error('expected the app to build its DID Connect session storage');
    const sessions = { storage: capture.storage as DidConnectSessionStorage, created: () => capture.creates };
    return { server, baseUrl, buyer, buyerWallet, settlementRepo, gate, jobId, agent, operatorRepo, sessions, jobRepo };
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
      // FIX-B37 (bugs.md B37 + B42): see the identical comment on the
      // first startAbtApp fixture above.
      githubLogin: 'scout-abt-unconfigured',
      negotiatesOnOwnersBehalf: true,
    });
    await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-abt-unconfigured', status: 'verified' });
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
        // FIX-B37 (bugs.md B37 + B42): see the identical comment on the
        // first startAbtApp fixture above.
        githubLogin: 'self-hired-scout-login',
        negotiatesOnOwnersBehalf: true,
      });
      await agentRepo.updateGithubBinding(agentIdentity.did, { handle: 'self-hired-scout-login', status: 'verified' });
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
        // FIX-B37 (bugs.md B37 + B42): see the identical comment on the
        // first startAbtApp fixture above.
        githubLogin: 'scout-abt-unset',
        negotiatesOnOwnersBehalf: true,
      });
      await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-abt-unset', status: 'verified' });
      await operatorRepo.register({ did: 'did:abt:op-abt-unset', githubLogin: 'operator-abt-unset' });

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
      // FIX-B39 (Ruling, run 792): rule 5 moves this refusal to the
      // /start door itself, so the buyer learns before a session is
      // even minted, rather than after advancing through the wallet
      // protocol as far as prepareTx. checkRailDoorEligible answers
      // this before startAbtSession's own /start call ever succeeds, so
      // the assertion is now on the raw route response.
      const startRes = await postSigned(
        started13.baseUrl,
        `/jobs/${started13.jobId}/payments/deposit/abt/start`,
        {},
        started13.buyer,
      );
      expect(startRes.status).toBe(409);
      const body = (await startRes.json()) as { error: string };
      expect(body.error).toContain('operator-address');
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
        // FIX-B37 (bugs.md B37 + B42): see the identical comment on the
        // first startAbtApp fixture above.
        githubLogin: 'scout-abt-set',
        negotiatesOnOwnersBehalf: true,
      });
      await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-abt-set', status: 'verified' });
      await operatorRepo.register({ did: 'did:abt:op-abt-set', githubLogin: 'operator-abt-set' });
      // The stored address deliberately differs from the DID suffix
      // (didSuffix('did:abt:op-abt-set')), so a passing test proves the
      // rail pays the STORED address, never falling back to the suffix.
      await operatorRepo.setOperatorAddressAbt('did:abt:op-abt-set', DIFFERENT_ADDRESS);

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

  it('the address vanishing between a successful /start and the wallet advancing past authPrincipal still refuses, naming the PATCH route, and settles nothing (defence in depth)', async () => {
    // Ruling (run 792): checkRailDoorEligible's /start-time read is the
    // FRONT gate a buyer sees first, but abt-did-connect.ts's own
    // operatorAddressForJob (inside prepareTx) is kept as a second,
    // independent read at the moment the recipient is actually signed
    // into the transaction. This test proves that second read still
    // fires on its own: the address is present for the /start door's
    // check, then gone by the time the wallet completes authPrincipal
    // and the server resolves the recipient for prepareTx. Removing
    // abt-did-connect.ts's own guard (not app.ts's) is what turns this
    // test red. Reuses startAbtApp (its operator DID and address are
    // fixed at 'did:abt:op-abt-surface' / didSuffix(...)), wrapping only
    // findByDid so the SAME row answers once, then answers with the
    // address gone on every call after -- the /start door's own read
    // succeeds, the wallet's later prepareTx read does not.
    const started14b = await startAbtApp(fakeAbtChainClient(true).client, (repo, operatorDid) => {
      let operatorReads = 0;
      return {
        register: repo.register.bind(repo),
        findByGithubLogin: repo.findByGithubLogin.bind(repo),
        findByPasskeySubject: repo.findByPasskeySubject.bind(repo),
        setOperatorAddressEvm: repo.setOperatorAddressEvm.bind(repo),
        setOperatorAddressAbt: repo.setOperatorAddressAbt.bind(repo),
        findByDid: async (did: string) => {
          const row = await repo.findByDid(did);
          if (did !== operatorDid) return row;
          operatorReads += 1;
          return operatorReads === 1 ? row : row === null ? null : { ...row, operatorAddressAbt: null };
        },
      };
    });

    try {
      const { sessionToken, authCallbackUrl } = await startAbtSession(started14b.baseUrl, started14b.buyer, {
        jobId: started14b.jobId,
        leg: 'deposit',
      });
      const authPath = new URL(authCallbackUrl).pathname;
      const step0Res = await fetch(authCallbackUrl);
      const step0Body = (await step0Res.json()) as DidConnectClaimResponse;
      const step0 = decodeClaimBody(step0Body);
      // Advancing past authPrincipal is the step that signs the NEXT
      // claim (prepareTx), which is where operatorAddressForJob is
      // called; a null operator address throws before signing, so the
      // response here is the raw { error } shape, never a second claim
      // (continueAbtWalletProtocol assumes a full two-step round trip
      // and does not fit this single-step failure).
      const step0SubmitRes = await fetch(`${started14b.baseUrl}${authPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          _t_: sessionToken,
          userPk: started14b.buyerWallet.publicKey,
          userInfo: await walletResponseJwt(started14b.buyerWallet, step0.challenge, [{ type: 'authPrincipal' }]),
        }),
      });
      const finalBody = (await step0SubmitRes.json()) as { appPk: string; authInfo: string };
      const decoded = jwtDecode(finalBody.authInfo) as unknown as Record<string, unknown>;
      const errorMessage = decoded.errorMessage as string | undefined;
      expect(typeof errorMessage).toBe('string');
      expect(errorMessage).toContain('operator-address');
      expect(await started14b.settlementRepo.findByJobAndLeg(started14b.jobId, 'deposit')).toBeNull();
    } finally {
      started14b.server.close();
    }
  });
});

// Proof round 1, D2 (comment 561 on this card): B23's own status gate
// (legStatusEligible) was wired onto the /start route and the token-mint
// door, but never onto onAuth (abt-did-connect.ts), the wallet-response
// leg of the ABT rail. A session minted while the job was 'proposed' could
// still complete the DID Connect protocol and write a settlement row
// AFTER the buyer withdrew the job mid-session -- B23's exact s7 fact,
// on the door the brief calls "every wallet-response route".
describe('B23 on the abt wallet-response path: onAuth refuses a session completed after the job left its eligible status', () => {
  it('a session started at proposed, then completed after the job is withdrawn, confirms nothing and writes no settlement', async () => {
    const fakeChain15 = fakeAbtChainClient(true);
    const started15 = await startAbtApp(fakeChain15.client);
    try {
      const { sessionToken, authCallbackUrl } = await startAbtSession(started15.baseUrl, started15.buyer, {
        jobId: started15.jobId,
        leg: 'deposit',
      });
      const authPath = new URL(authCallbackUrl).pathname;

      // The job leaves 'proposed' for 'withdrawn' in the middle of the
      // session, after the session was minted but before the wallet
      // protocol completes.
      const withdraw = await postSigned(started15.baseUrl, `/jobs/${started15.jobId}/withdraw`, {}, started15.buyer);
      expect(withdraw.status).toBe(200);

      const step0Res = await fetch(authCallbackUrl);
      const step0Body = (await step0Res.json()) as DidConnectClaimResponse;
      const step0 = decodeClaimBody(step0Body);
      const step0SubmitRes = await fetch(`${started15.baseUrl}${authPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          _t_: sessionToken,
          userPk: started15.buyerWallet.publicKey,
          userInfo: await walletResponseJwt(started15.buyerWallet, step0.challenge, [{ type: 'authPrincipal' }]),
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
      const finalTx = await walletSignsPartialTx(prepareTxClaim.partialTx, started15.buyerWallet);
      const step1SubmitRes = await fetch(`${started15.baseUrl}${authPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          _t_: sessionToken,
          userPk: started15.buyerWallet.publicKey,
          userInfo: await walletResponseJwt(started15.buyerWallet, step1.challenge, [{ type: 'prepareTx', finalTx }]),
        }),
      });
      const finalBody = (await step1SubmitRes.json()) as { appPk: string; authInfo: string };
      const decoded = jwtDecode(finalBody.authInfo) as unknown as Record<string, unknown>;
      const response = decoded.response as { confirmed: boolean };
      expect(response.confirmed).toBe(false);
      expect(await started15.settlementRepo.findByJobAndLeg(started15.jobId, 'deposit')).toBeNull();
    } finally {
      started15.server.close();
    }
  });
});

// FIX-B70a: the ABT price is read once, when the payment session starts,
// and locked on the session row. The claim is built from the lock and the
// wallet's answer is checked against the same amounts, on both doors.
const LOCK_LIFETIME_MS = 15 * 60 * 1000;
const NO_LOCK_SENTENCE = 'This payment has no locked ABT price. Start the payment again.';
const EXPIRED_SENTENCE = 'The ABT price for this payment expired. Start the payment again for a fresh price.';
const PRICE_CHANGED_SENTENCE = 'The agreed price changed after this payment started. Start the payment again.';
const NO_PRICE_SENTENCE = 'The ABT price is not available right now. Try again in a minute.';
// The $100.00 deposit leg of the $400.00 fixture job, at $0.34 per ABT.
const AMOUNT_AT_034 = '294.11764705';
const FEE_AT_034 = '8.82352941';

// A rate source the test controls: every call is counted, and it answers
// the given readings in order, repeating the last one. `set` replaces the
// answer for every later call.
function controlledRate(...answers: (string | null)[]): { source: AbtRateSource; set: (rate: string | null) => void; calls: () => number } {
  let queue = [...answers];
  let calls = 0;
  return {
    source: async () => {
      calls += 1;
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return next ?? null;
    },
    set: (next) => {
      queue = [next];
    },
    calls: () => calls,
  };
}

// Mints a session straight through did-connect-js's own token door, the
// way the file's other token-door tests do, and decodes the callback URL.
async function mintThroughTokenDoor(
  started: StartedAbtApp,
  query = '',
): Promise<{ readonly sessionToken: string; readonly authCallbackUrl: string; readonly extra: Record<string, unknown> }> {
  const res = await getSigned(started.baseUrl, `/api/did/pay/token?jobId=${started.jobId}&leg=deposit${query}`, started.buyer);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { readonly token: string; readonly url: string; readonly extra: Record<string, unknown> };
  const encoded = new URL(body.url).searchParams.get('url');
  if (encoded === null) throw new Error('expected a wallet callback url');
  return { sessionToken: body.token, authCallbackUrl: decodeURIComponent(encoded), extra: body.extra };
}

function operatorOutputUnits(partialTx: string): { readonly operator: string; readonly fee: string } {
  const decoded = cborDecodeTx(fromBase58(partialTx)) as { itx: { outputs: readonly { tokens: readonly { value: string }[] }[] } };
  return { operator: decoded.itx.outputs[0]?.tokens[0]?.value ?? '', fee: decoded.itx.outputs[1]?.tokens[0]?.value ?? '' };
}

async function reproposePriceAndSignAgain(started: StartedAbtApp, priceUsd: string): Promise<void> {
  await postSigned(started.baseUrl, `/jobs/${started.jobId}/criteria`, { criteria: proposal, priceUsd, rail: 'abt' }, started.agent);
  await postSigned(started.baseUrl, `/jobs/${started.jobId}/criteria/0/accept`, {}, started.buyer);
  await postSigned(started.baseUrl, `/jobs/${started.jobId}/criteria/0/accept`, {}, started.agent);
  await postSigned(started.baseUrl, `/jobs/${started.jobId}/criteria/1/accept`, {}, started.buyer);
  await postSigned(started.baseUrl, `/jobs/${started.jobId}/criteria/1/accept`, {}, started.agent);
  await postSigned(started.baseUrl, `/jobs/${started.jobId}/price/accept`, {}, started.buyer);
  await postSigned(started.baseUrl, `/jobs/${started.jobId}/price/accept`, {}, started.agent);
}

describe('FIX-B70a: the ABT rate is locked when the payment starts', () => {
  const servers: Server[] = [];
  async function startWith(rate: AbtRateSource): Promise<{ started: StartedAbtApp; fake: ReturnType<typeof fakeAbtChainClient> }> {
    const fake = fakeAbtChainClient(true);
    const started = await startAbtApp(fake.client, undefined, rate);
    servers.push(started.server);
    return { started, fake };
  }
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(() => {
    for (const server of servers) server.close();
  });

  it('(a) a price that moves after the start still confirms at the locked amount, and the rate source is not read again', async () => {
    const rate = controlledRate('0.34');
    const { started, fake } = await startWith(rate.source);
    const { sessionToken, authCallbackUrl } = await startAbtSession(started.baseUrl, started.buyer, { jobId: started.jobId, leg: 'deposit' });
    rate.set('0.35');
    const callsAtStart = rate.calls();
    const step = await fetchPrepareTxClaim(started.baseUrl, sessionToken, authCallbackUrl, started.buyerWallet);
    if (step.kind !== 'claim') throw new Error('expected a claim');
    expect(operatorOutputUnits(step.partialTx)).toEqual({
      operator: fromTokenToUnit(AMOUNT_AT_034).toString(),
      fee: fromTokenToUnit(FEE_AT_034).toString(),
    });
    const result = await answerPrepareTxClaim(started.baseUrl, sessionToken, step, started.buyerWallet);
    expect(result).toEqual({ confirmed: true });
    expect(fake.sentTx()).toBeDefined();
    const row = await started.settlementRepo.findByJobAndLeg(started.jobId, 'deposit');
    expect(row?.amountUsd).toBe('100.00');
    expect(rate.calls()).toBe(callsAtStart);
  });

  it('(b) a feed that dies after the start still confirms at the locked amount', async () => {
    const rate = controlledRate('0.34');
    const { started, fake } = await startWith(rate.source);
    const { sessionToken, authCallbackUrl } = await startAbtSession(started.baseUrl, started.buyer, { jobId: started.jobId, leg: 'deposit' });
    rate.set(null);
    const callsAtStart = rate.calls();
    const result = await continueAbtWalletProtocol(started.baseUrl, sessionToken, authCallbackUrl, started.buyerWallet);
    expect(result).toEqual({ confirmed: true });
    expect(fake.sentTx()).toBeDefined();
    expect((await started.settlementRepo.findByJobAndLeg(started.jobId, 'deposit'))?.rail).toBe('abt');
    expect(rate.calls()).toBe(callsAtStart);
  });

  it('(c) a session minted straight through /api/did/pay/token is locked the same way and pays at its lock when the rate moves', async () => {
    const rate = controlledRate('0.34');
    const { started, fake } = await startWith(rate.source);
    const { sessionToken, authCallbackUrl } = await mintThroughTokenDoor(started);
    rate.set('0.35');
    const callsAtStart = rate.calls();
    const row = await started.sessions.storage.read(sessionToken);
    expect(row?.abtQuote).toMatchObject({ jobId: started.jobId, leg: 'deposit', amountUsd: '100.00', usdPerAbt: '0.34', amountToken: AMOUNT_AT_034, feeToken: FEE_AT_034 });
    const result = await continueAbtWalletProtocol(started.baseUrl, sessionToken, authCallbackUrl, started.buyerWallet);
    expect(result).toEqual({ confirmed: true });
    expect(fake.sentTx()).toBeDefined();
    expect((await started.settlementRepo.findByJobAndLeg(started.jobId, 'deposit'))?.amountUsd).toBe('100.00');
    expect(rate.calls()).toBe(callsAtStart);
  });

  it('(c) a lock planted whole in the token door query is never read: the claim and the settlement carry the amounts the platform locked', async () => {
    const rate = controlledRate('0.34');
    const { started, fake } = await startWith(rate.source);
    const planted = {
      jobId: started.jobId,
      leg: 'deposit',
      amountUsd: '100.00',
      usdPerAbt: '1',
      rateUpdatedAt: null,
      amountToken: '0.00000001',
      feeToken: '0.00000001',
      lockedAt: '2026-09-28T18:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
    };
    const query = Object.entries(planted)
      .filter(([, value]) => value !== null)
      .map(([key, value]) => `&abtQuote[${key}]=${encodeURIComponent(String(value))}`)
      .join('');
    const { sessionToken, authCallbackUrl } = await mintThroughTokenDoor(started, query);
    const step = await fetchPrepareTxClaim(started.baseUrl, sessionToken, authCallbackUrl, started.buyerWallet);
    if (step.kind !== 'claim') throw new Error('expected a claim');
    expect(operatorOutputUnits(step.partialTx)).toEqual({
      operator: fromTokenToUnit(AMOUNT_AT_034).toString(),
      fee: fromTokenToUnit(FEE_AT_034).toString(),
    });
    const result = await answerPrepareTxClaim(started.baseUrl, sessionToken, step, started.buyerWallet);
    expect(result).toEqual({ confirmed: true });
    expect(fake.sentTx()).toBeDefined();
  });

  it('(d) an agreed price that changes after the start is refused before anything is broadcast, with the price-changed sentence', async () => {
    const rate = controlledRate('0.34');
    const { started, fake } = await startWith(rate.source);
    const { sessionToken, authCallbackUrl } = await startAbtSession(started.baseUrl, started.buyer, { jobId: started.jobId, leg: 'deposit' });
    const step = await fetchPrepareTxClaim(started.baseUrl, sessionToken, authCallbackUrl, started.buyerWallet);
    if (step.kind !== 'claim') throw new Error('expected a claim');
    await reproposePriceAndSignAgain(started, '500.00');
    const result = await answerPrepareTxClaim(started.baseUrl, sessionToken, step, started.buyerWallet);
    expect(result).toEqual({ confirmed: false, error: PRICE_CHANGED_SENTENCE });
    expect(fake.sentTx()).toBeUndefined();
    expect(await started.settlementRepo.findByJobAndLeg(started.jobId, 'deposit')).toBeNull();
  });

  it('(e) a wallet that answers after the lock lifetime is refused before anything is broadcast, with the expired sentence', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-28T18:00:00Z'));
    const rate = controlledRate('0.34');
    const { started, fake } = await startWith(rate.source);
    const { sessionToken, authCallbackUrl } = await startAbtSession(started.baseUrl, started.buyer, { jobId: started.jobId, leg: 'deposit' });
    const step = await fetchPrepareTxClaim(started.baseUrl, sessionToken, authCallbackUrl, started.buyerWallet);
    if (step.kind !== 'claim') throw new Error('expected a claim');
    vi.setSystemTime(new Date('2026-09-28T18:00:00Z').getTime() + LOCK_LIFETIME_MS + 1000);
    const result = await answerPrepareTxClaim(started.baseUrl, sessionToken, step, started.buyerWallet);
    expect(result).toEqual({ confirmed: false, error: EXPIRED_SENTENCE });
    expect(fake.sentTx()).toBeUndefined();
    expect(await started.settlementRepo.findByJobAndLeg(started.jobId, 'deposit')).toBeNull();
  });

  it('(e) a claim fetched after the lock lifetime is refused before the wallet can sign it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-28T18:00:00Z'));
    const rate = controlledRate('0.34');
    const { started, fake } = await startWith(rate.source);
    const { sessionToken, authCallbackUrl } = await startAbtSession(started.baseUrl, started.buyer, { jobId: started.jobId, leg: 'deposit' });
    vi.setSystemTime(new Date('2026-09-28T18:00:00Z').getTime() + LOCK_LIFETIME_MS + 1000);
    const step = await fetchPrepareTxClaim(started.baseUrl, sessionToken, authCallbackUrl, started.buyerWallet);
    expect(step).toEqual({ kind: 'refused', error: EXPIRED_SENTENCE });
    expect(fake.sentTx()).toBeUndefined();
  });

  it('a session with no lock at all (the feed was down when it was minted on the token door) mints, then refuses the claim with the no-lock sentence', async () => {
    const rate = controlledRate(null);
    const { started, fake } = await startWith(rate.source);
    const minted = await mintThroughTokenDoor(started);
    expect(minted.extra).toEqual({ abtQuote: null });
    expect((await started.sessions.storage.read(minted.sessionToken))?.abtQuote).toBeUndefined();
    const step = await fetchPrepareTxClaim(started.baseUrl, minted.sessionToken, minted.authCallbackUrl, started.buyerWallet);
    expect(step).toEqual({ kind: 'refused', error: NO_LOCK_SENTENCE });
    expect(fake.sentTx()).toBeUndefined();
  });

  it.each([
    ['job', { jobId: 'some-other-job' }],
    ['leg', { leg: 'remainder' }],
  ])('a lock that names another %s than the session is refused with the no-lock sentence, before broadcast', async (_name, tamper) => {
    const rate = controlledRate('0.34');
    const { started, fake } = await startWith(rate.source);
    const { sessionToken, authCallbackUrl } = await startAbtSession(started.baseUrl, started.buyer, { jobId: started.jobId, leg: 'deposit' });
    const row = await started.sessions.storage.read(sessionToken);
    const lock = row?.abtQuote as Record<string, unknown>;
    await started.sessions.storage.update(sessionToken, { abtQuote: { ...lock, ...tamper } });
    expect(await fetchPrepareTxClaim(started.baseUrl, sessionToken, authCallbackUrl, started.buyerWallet)).toEqual({ kind: 'refused', error: NO_LOCK_SENTENCE });
    expect(fake.sentTx()).toBeUndefined();
  });

  it('(f) /start answers 503 with the price sentence and mints no session when no rate is available', async () => {
    const rate = controlledRate(null);
    const { started } = await startWith(rate.source);
    const before = started.sessions.created();
    const res = await postSigned(started.baseUrl, `/jobs/${started.jobId}/payments/deposit/abt/start`, {}, started.buyer);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: NO_PRICE_SENTENCE });
    expect(started.sessions.created()).toBe(before);
  });

  it('(g) the start response carries the locked quote as a whole object; a bare-string source gives a null rateUpdatedAt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-28T18:00:00Z'));
    const rate = controlledRate('0.34');
    const { started } = await startWith(rate.source);
    const { extra } = await startAbtSession(started.baseUrl, started.buyer, { jobId: started.jobId, leg: 'deposit' });
    expect(extra).toEqual({
      abtQuote: {
        amountToken: AMOUNT_AT_034,
        feeToken: FEE_AT_034,
        usdPerAbt: '0.34',
        rateUpdatedAt: null,
        expiresAt: '2026-09-28T18:15:00.000Z',
      },
    });
  });

  it('(g) a timestamped reading carries its feed time into the start response and the lock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-28T18:00:00Z'));
    const { started } = await startWith(async () => ({ usdPerToken: '0.34000000', updatedAt: new Date('2026-09-28T17:58:30Z') }));
    const { sessionToken, extra } = await startAbtSession(started.baseUrl, started.buyer, { jobId: started.jobId, leg: 'deposit' });
    expect(extra).toEqual({
      abtQuote: {
        amountToken: AMOUNT_AT_034,
        feeToken: FEE_AT_034,
        usdPerAbt: '0.34000000',
        rateUpdatedAt: '2026-09-28T17:58:30.000Z',
        expiresAt: '2026-09-28T18:15:00.000Z',
      },
    });
    expect((await started.sessions.storage.read(sessionToken))?.abtQuote).toEqual({
      jobId: started.jobId,
      leg: 'deposit',
      amountUsd: '100.00',
      usdPerAbt: '0.34000000',
      rateUpdatedAt: '2026-09-28T17:58:30.000Z',
      amountToken: AMOUNT_AT_034,
      feeToken: FEE_AT_034,
      lockedAt: '2026-09-28T18:00:00.000Z',
      expiresAt: '2026-09-28T18:15:00.000Z',
    });
  });
});
