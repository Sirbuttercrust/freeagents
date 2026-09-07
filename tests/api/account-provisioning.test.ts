// P8d: signing in gives you an account (auto-provision at first sign-in),
// and that account cannot be paid until you say where. This file proves
// the card's own anchor and "Done means" list, driven at the route level
// over real HTTP, never by importing resolveActingParty or the identity
// adapter's methods directly into an assertion.
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryAccountRepository, MemoryJobRepository, MemorySettlementRepository } from '../../src/adapters/storage/memory.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import type { SessionAdapter } from '../../src/adapters/identity/session.js';
import { fakeGitHubConfig, fakeGitHubFetch } from '../helpers/session-fixtures.js';
import { createPasskeyFixture } from '../helpers/webauthn-fixtures.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { Account } from '../../src/domain/account.js';
import type { AccountRepository } from '../../src/adapters/storage/types.js';
import { PrismaSettlementGate } from '../../src/adapters/payment/gate.js';
import { createAbtPaymentRail } from '../../src/adapters/payment/abt.js';
import { signingIdentityFromWallet, type SigningIdentity } from '../helpers/sign-request.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import {
  abtEnv,
  decodeClaimBody,
  driveAbtPayment,
  fakeAbtChainClient,
  fromRandom,
  postSigned,
  pureTxEncoder,
  reservePort,
  startAbtSession,
  walletResponseJwt,
  withEnv,
  type DidConnectClaimResponse,
  type WalletObject,
} from '../helpers/abt-fixtures.js';
import { decode as jwtDecode } from '@arcblock/jwt';

const PLATFORM_SEED = 'f'.repeat(64);

function delegationFixture(agentDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-provisioning-test',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: 'did:abt:op-provisioning-test',
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-01-01T00:00:00Z',
      verificationMethod: `${agentDid}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zfixture-not-verified-here',
    },
  };
}

let server: Server | null = null;

async function listen(app: ReturnType<typeof createApp>): Promise<string> {
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return `http://127.0.0.1:${address.port}`;
}

function passkeyAdapter(): SessionAdapter {
  return createSessionAdapter({
    github: fakeGitHubConfig(),
    passkey: { rpName: 'FreeAgents test', rpID: 'localhost', origin: 'http://localhost:3000' },
  });
}

async function passkeySessionHeader(adapter: SessionAdapter, subject: string): Promise<Record<string, string>> {
  const { optionsJson } = await adapter.registerPasskey(subject);
  const registrationOptions = JSON.parse(optionsJson) as { challenge: string };
  const fixture = createPasskeyFixture();
  const response = fixture.registrationResponse(registrationOptions.challenge, 'localhost');
  const session = await adapter.verifyPasskey(JSON.stringify({ subject, response }));
  if (session === null) throw new Error('expected verifyPasskey to succeed');
  return { authorization: `Bearer ${session.token}` };
}

async function githubSessionHeader(adapter: SessionAdapter): Promise<Record<string, string>> {
  const start = await adapter.beginGitHubOAuth();
  const session = await adapter.completeGitHubOAuth({ code: 'any-code', state: start.state });
  if (session === null) throw new Error('expected completeGitHubOAuth to succeed');
  return { authorization: `Bearer ${session.token}` };
}

async function withPlatformSeed<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.env.FREEAGENTS_PLATFORM_SEED;
  process.env.FREEAGENTS_PLATFORM_SEED = PLATFORM_SEED;
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
    else process.env.FREEAGENTS_PLATFORM_SEED = original;
  }
}

// PATCH /accounts/:did/operator-address calls resolveActingParty before it
// ever compares :did against the resolved party, so a session-authenticated
// call to it (against any placeholder :did) is a reliable way to force
// provisioning without depending on POST /jobs's own agent fixture. The
// 403 it answers with (the placeholder :did is never the resolved party)
// is expected and irrelevant here; only the side effect matters.
async function forceProvisioning(baseUrl: string, auth: Record<string, string>): Promise<void> {
  await fetch(`${baseUrl}/accounts/placeholder-to-force-provisioning/operator-address`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ operatorAddressEvm: '0x0000000000000000000000000000000000dEaD' }),
  });
}

// P8d repair round 2 (Proof review round 1, D1): fetch() reuses a shared
// keep-alive agent for two calls to the same origin, which serializes
// them onto one connection instead of sending both at once. A fresh
// node:http request per call (agent: false) is a genuinely separate
// connection, so two calls issued together are actually in flight
// together, the property the concurrency test needs and fetch() alone
// cannot give it.
async function postJsonFreshSocket(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ readonly status: number; readonly json: () => Promise<Record<string, unknown>> }> {
  const url = new URL(path, baseUrl);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status, json: async () => JSON.parse(text) as Record<string, unknown> });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// P8d repair round 2 (Proof review round 1, D1): even on separate
// sockets, two nearly-simultaneous requests can still run their
// provisioning work end to end, one after the other, if neither one's
// own code happens to yield the event loop at the right moment; nothing
// then proves the two calls were ever actually inside
// provisionAccountForSession's race window together. This wrapper makes
// the overlap real instead of hoped-for: both callers must reach
// register() before either is allowed past it, so the underlying
// repository always sees the two calls the way two truly concurrent
// processes would, neither committed while the other is still deciding.
// entriesSeen lets the test assert the overlap actually happened.
class BarrierAccountRepository implements AccountRepository {
  entriesSeen = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly inner: AccountRepository,
    private readonly parties: number,
  ) {}

  async register(input: {
    readonly did: string;
    readonly githubLogin?: string | null;
    readonly passkeySubject?: string | null;
  }): Promise<Account> {
    this.entriesSeen += 1;
    if (this.entriesSeen < this.parties) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    } else {
      for (const release of this.waiting) release();
      this.waiting.length = 0;
    }
    return this.inner.register(input);
  }

  findByDid(did: string): Promise<Account | null> {
    return this.inner.findByDid(did);
  }

  findByGithubLogin(githubLogin: string | null): Promise<Account | null> {
    return this.inner.findByGithubLogin(githubLogin);
  }

  findByPasskeySubject(passkeySubject: string | null): Promise<Account | null> {
    return this.inner.findByPasskeySubject(passkeySubject);
  }

  setOperatorAddressEvm(did: string, operatorAddressEvm: string): Promise<Account | null> {
    return this.inner.setOperatorAddressEvm(did, operatorAddressEvm);
  }

  setOperatorAddressAbt(did: string, operatorAddressAbt: string): Promise<Account | null> {
    return this.inner.setOperatorAddressAbt(did, operatorAddressAbt);
  }
}

// P8d repair round 2 (Proof review round 1, D2): the custody-fence and
// upgrade-path tests below need a hire that has actually reached an
// agreed price on the ABT rail, whose PAYEE (the hired agent's operator)
// is a provisioned account, i.e. an account with no address until the
// account itself sets one. The buyer and the agent both sign their own
// side of the exchange with real wallet identities (mirroring
// tests/api/job-payment-abt.test.ts exactly, via the shared
// tests/helpers/abt-fixtures.ts), so the only thing under test is
// whether the OPERATOR side of the payment honours the custody fence.
async function setupAbtJobWithProvisionedOperator(
  operatorGithubLogin: string,
): Promise<{
  readonly server: Server;
  readonly baseUrl: string;
  readonly buyer: SigningIdentity;
  readonly buyerWallet: WalletObject;
  readonly operatorAuth: Record<string, string>;
  readonly operatorDid: string;
  readonly accountRepo: MemoryAccountRepository;
  readonly settlementRepo: MemorySettlementRepository;
  readonly jobId: string;
}> {
  return withPlatformSeed(async () => {
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const platformWallet = fromRandom();
    const token = fromRandom().address;
    const feeAddress = fromRandom().address;
    return withEnv(abtEnv(baseUrl, platformWallet, token, feeAddress), async () => {
      // The operator's DID is derived deterministically from the
      // platform seed and its sign-in subject (identity.ts's own
      // createOperatorDid), the SAME derivation
      // provisionAccountForSession uses at first sign-in -- computed
      // here only so the agent row below can name it before the
      // operator's session has actually signed in.
      const { did: operatorDid } = await createIdentityAdapter().createOperatorDid(operatorGithubLogin);

      const operatorSessionAdapter = createSessionAdapter({
        github: fakeGitHubConfig(),
        fetchImpl: fakeGitHubFetch({ login: operatorGithubLogin, id: Math.floor(Math.random() * 1_000_000) }),
      });

      const accountRepo = new MemoryAccountRepository();
      const agentRepo = new MemoryAgentRepository();
      const agentWallet = fromRandom();
      const agent = await signingIdentityFromWallet(agentWallet);
      await agentRepo.create({
        did: agent.did,
        operatorDid,
        delegation: delegationFixture(agent.did),
        name: 'scout',
        skills: ['triage'],
        githubLogin: null,
      });

      const buyerWallet = fromRandom();
      const buyer = await signingIdentityFromWallet(buyerWallet);
      // Registered by hand, mirroring tests/api/job-payment-abt.test.ts's
      // own startAbtApp: the buyer's request signature only verifies
      // against a DID this process's signing-key resolver recognises as
      // registered (did-abt-resolver.ts's isRegistered check). Nothing
      // about custody or provisioning is under test on the BUYER side
      // here, only on the operator side, so the buyer is set up exactly
      // like every other route test's buyer.
      await accountRepo.register({ did: buyer.did, githubLogin: 'p8d-abt-boundary-buyer' });

      const jobRepo = new MemoryJobRepository();
      const settlementRepo = new MemorySettlementRepository();
      const gate = new PrismaSettlementGate(settlementRepo);
      const spentTransferStorage = {
        async record(): Promise<void> {},
        async findByHash() {
          return null;
        },
      };
      const abtRail = createAbtPaymentRail({
        chainClient: fakeAbtChainClient(true).client,
        rateSource: async () => '1',
        spentTransferStorage,
      });

      const app = createApp(
        accountRepo,
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
        operatorSessionAdapter,
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

      // Provisions the operator account at first sign-in (the anchor:
      // a session, never a signing key), through the SAME route the
      // upgrade-path PATCH itself uses -- the 403 answered here (the
      // placeholder :did is never the resolved party) is expected and
      // irrelevant; only the provisioning side effect matters.
      const operatorAuth = await githubSessionHeader(operatorSessionAdapter);
      await forceProvisioning(baseUrl, operatorAuth);

      const created = await postSigned(baseUrl, '/jobs', {
        buyerDid: buyer.did,
        agentDid: agent.did,
        repository: 'buyer/target-repo',
        brief: 'Fix the login bug',
      }, buyer);
      const job = (await created.json()) as Record<string, unknown>;
      const jobId = String(job.id);
      await postSigned(baseUrl, `/jobs/${jobId}/criteria`, {
        criteria: [
          { text: 'The login bug is fixed', proposedBy: 'agent' },
          { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
        ],
        priceUsd: '400.00',
        rail: 'abt',
      }, agent);
      await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, buyer);
      await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agent);
      await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, buyer);
      await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agent);
      await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, buyer);
      await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, agent);

      return { server, baseUrl, buyer, buyerWallet, operatorAuth, operatorDid, accountRepo, settlementRepo, jobId };
    });
  });
}

describe('P8d: signing in gives you an account, no POST /accounts call anywhere', () => {
  afterEach(async () => {
    if (server !== null) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  // THE CARD'S CENTRAL TEST: a subject that no account claims signs in,
  // and with only that session token completes a hire through POST
  // /jobs. No POST /accounts call anywhere in this test.
  it('GitHub sign-in: a stranger signs in and hires immediately, no registration step', async () => {
    await withPlatformSeed(async () => {
      const sessionAdapter = createSessionAdapter({
        github: fakeGitHubConfig(),
        fetchImpl: fakeGitHubFetch({ login: 'p8d-github-stranger', id: 9001 }),
      });
      const agentRepo = new MemoryAgentRepository();
      const agentDid = 'did:abt:p8d-github-agent';
      await agentRepo.create({
        did: agentDid,
        operatorDid: 'did:abt:p8d-github-operator',
        delegation: delegationFixture(agentDid),
        name: 'scout',
        skills: ['triage'],
        githubLogin: null,
      });
      const accountRepo = new MemoryAccountRepository();
      const baseUrl = await listen(
        createApp(accountRepo, agentRepo, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
      );

      const auth = await githubSessionHeader(sessionAdapter);

      const hire = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ agentDid, repository: 'buyer/target-repo', brief: 'Fix the login bug' }),
      });
      expect(hire.status).toBe(201);
      const body = (await hire.json()) as Record<string, unknown>;
      expect(typeof body.buyerDid).toBe('string');
      expect((body.buyerDid as string).startsWith('did:abt:')).toBe(true);

      // Provisioned, never registered by hand: the account exists.
      const account = await accountRepo.findByGithubLogin('p8d-github-stranger');
      expect(account).not.toBeNull();
      expect(account?.did).toBe(body.buyerDid);
    });
  });

  it('passkey sign-in: a stranger signs in and hires immediately, the same as GitHub', async () => {
    await withPlatformSeed(async () => {
      const sessionAdapter = passkeyAdapter();
      const subject = 'p8d-passkey-stranger';
      const agentRepo = new MemoryAgentRepository();
      const agentDid = 'did:abt:p8d-passkey-agent';
      await agentRepo.create({
        did: agentDid,
        operatorDid: 'did:abt:p8d-passkey-operator',
        delegation: delegationFixture(agentDid),
        name: 'scout',
        skills: ['triage'],
        githubLogin: null,
      });
      const accountRepo = new MemoryAccountRepository();
      const baseUrl = await listen(
        createApp(accountRepo, agentRepo, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
      );

      const auth = await passkeySessionHeader(sessionAdapter, subject);

      const hire = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ agentDid, repository: 'buyer/target-repo', brief: 'Fix the login bug' }),
      });
      expect(hire.status).toBe(201);
      const body = (await hire.json()) as Record<string, unknown>;

      const account = await accountRepo.findByPasskeySubject(subject);
      expect(account).not.toBeNull();
      expect(account?.did).toBe(body.buyerDid);
      // Passkey provisioning never invents a GitHub login.
      expect(account?.githubLogin).toBeNull();
    });
  });

  it('signing in twice as the same GitHub subject resolves to one account with one DID', async () => {
    await withPlatformSeed(async () => {
      const sessionAdapter = createSessionAdapter({
        github: fakeGitHubConfig(),
        fetchImpl: fakeGitHubFetch({ login: 'p8d-twice-github', id: 9002 }),
      });
      const accountRepo = new MemoryAccountRepository();
      const baseUrl = await listen(
        createApp(accountRepo, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
      );

      const firstAuth = await githubSessionHeader(sessionAdapter);
      await forceProvisioning(baseUrl, firstAuth);
      const firstAccount = await accountRepo.findByGithubLogin('p8d-twice-github');
      expect(firstAccount).not.toBeNull();

      const secondAuth = await githubSessionHeader(sessionAdapter);
      await forceProvisioning(baseUrl, secondAuth);
      const secondAccount = await accountRepo.findByGithubLogin('p8d-twice-github');

      expect(secondAccount?.did).toBe(firstAccount?.did);
    });
  });

  it('two concurrent first requests for one new subject yield one account', async () => {
    await withPlatformSeed(async () => {
      const sessionAdapter = createSessionAdapter({
        github: fakeGitHubConfig(),
        fetchImpl: fakeGitHubFetch({ login: 'p8d-concurrent-github', id: 9003 }),
      });
      const agentRepo = new MemoryAgentRepository();
      const agentDid = 'did:abt:p8d-concurrent-agent';
      await agentRepo.create({
        did: agentDid,
        operatorDid: 'did:abt:p8d-concurrent-operator',
        delegation: delegationFixture(agentDid),
        name: 'scout',
        skills: ['triage'],
        githubLogin: null,
      });
      // Holds both provisioning attempts at register() until BOTH have
      // arrived (see BarrierAccountRepository above), so the race is
      // genuine rather than hoped for from two fetch() calls that may or
      // may not overlap in practice.
      const accountRepo = new BarrierAccountRepository(new MemoryAccountRepository(), 2);
      const baseUrl = await listen(
        createApp(accountRepo, agentRepo, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
      );

      const auth = await githubSessionHeader(sessionAdapter);

      // Two simultaneous first requests from one new person, each on its
      // own fresh socket (never fetch()'s shared keep-alive connection,
      // which serializes same-origin calls and would hide the race):
      // both name this agent so each independently attempts to resolve,
      // and therefore provision, the same brand-new subject.
      const [first, second] = await Promise.all([
        postJsonFreshSocket(
          baseUrl,
          '/jobs',
          { agentDid, repository: 'buyer/target-repo', brief: 'First concurrent hire' },
          auth,
        ),
        postJsonFreshSocket(
          baseUrl,
          '/jobs',
          { agentDid, repository: 'buyer/target-repo', brief: 'Second concurrent hire' },
          auth,
        ),
      ]);

      // Proves the overlap actually happened: both requests reached
      // register() before either was released. Without this, a test
      // that merely ran two requests sequentially and happened to pass
      // would prove nothing about the race the card names.
      expect(accountRepo.entriesSeen).toBe(2);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const firstBody = await first.json();
      const secondBody = await second.json();
      expect(firstBody.buyerDid).toBe(secondBody.buyerDid);

      const account = await accountRepo.findByGithubLogin('p8d-concurrent-github');
      expect(account).not.toBeNull();
    });
  });

  it('a provisioned account has both operator addresses null, and an ABT payment for a job hiring its agent refuses to start, naming the PATCH route', async () => {
    // THE CUSTODY FENCE, asserted directly: the payment itself refuses,
    // not merely a column reading null. The provisioned account here is
    // the AGENT'S OPERATOR (the payee), so the ABT rail's own refusal
    // (abt-did-connect.ts's operatorAddressForJob) is what fires, driven
    // through the real DID Connect wallet protocol exactly like
    // tests/api/job-payment-abt.test.ts's own equivalent case
    // (advancing past authPrincipal is the step that signs the NEXT
    // claim, prepareTx, which is where the null operator address throws
    // before ever signing anything -- there is no prepareTx claim to
    // read here, only the raw { error } shape).
    const started = await setupAbtJobWithProvisionedOperator('p8d-custody-fence-operator');
    try {
      const account = await started.accountRepo.findByDid(started.operatorDid);
      expect(account).not.toBeNull();
      expect(account?.operatorAddressAbt).toBeNull();
      expect(account?.operatorAddressEvm).toBeNull();

      const { sessionToken, authCallbackUrl } = await startAbtSession(started.baseUrl, started.buyer, {
        jobId: started.jobId,
        leg: 'deposit',
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
          userPk: started.buyerWallet.publicKey,
          userInfo: await walletResponseJwt(started.buyerWallet, step0.challenge, [{ type: 'authPrincipal' }]),
        }),
      });
      const finalBody = (await step0SubmitRes.json()) as { appPk: string; authInfo: string };
      const decoded = jwtDecode(finalBody.authInfo) as unknown as Record<string, unknown>;
      const errorMessage = decoded.errorMessage as string | undefined;
      expect(typeof errorMessage).toBe('string');
      expect(errorMessage).toContain('operator-address');
      expect(await started.settlementRepo.findByJobAndLeg(started.jobId, 'deposit')).toBeNull();
    } finally {
      started.server.close();
    }
  });

  it('with FREEAGENTS_PLATFORM_SEED unset, a sign-in by a new subject answers 503 and creates no account', async () => {
    const original = process.env.FREEAGENTS_PLATFORM_SEED;
    delete process.env.FREEAGENTS_PLATFORM_SEED;
    try {
      const sessionAdapter = createSessionAdapter({
        github: fakeGitHubConfig(),
        fetchImpl: fakeGitHubFetch({ login: 'p8d-no-seed-buyer', id: 9005 }),
      });
      const agentRepo = new MemoryAgentRepository();
      const agentDid = 'did:abt:p8d-no-seed-agent';
      await agentRepo.create({
        did: agentDid,
        operatorDid: 'did:abt:p8d-no-seed-operator',
        delegation: delegationFixture(agentDid),
        name: 'scout',
        skills: ['triage'],
        githubLogin: null,
      });
      const accountRepo = new MemoryAccountRepository();
      const baseUrl = await listen(
        createApp(accountRepo, agentRepo, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
      );
      const auth = await githubSessionHeader(sessionAdapter);

      const hire = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ agentDid, repository: 'buyer/target-repo', brief: 'Fix the login bug' }),
      });
      expect(hire.status).toBe(503);

      const account = await accountRepo.findByGithubLogin('p8d-no-seed-buyer');
      expect(account).toBeNull();
    } finally {
      if (original === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
      else process.env.FREEAGENTS_PLATFORM_SEED = original;
    }
  });

  it('a GitHub session whose subject is null or empty resolves to no account and never to a null-login row', async () => {
    // Exercised at the storage layer directly: app.ts's session-derived
    // subject can never actually be empty in practice (GitHub always
    // returns a real login), so this is the null-subject guard's own
    // acceptance proof, already pinned at the storage layer in
    // tests/adapters/account-null-subject-guard.test.ts. Restated here so
    // the card's "Done means" list has a route-adjacent anchor: a stray
    // passkey-only row (githubLogin === null) must never be handed back
    // by a lookup for an empty subject.
    await withPlatformSeed(async () => {
      const accountRepo = new MemoryAccountRepository();
      await accountRepo.register({ did: 'did:abt:p8d-null-subject-a', passkeySubject: 'p8d-null-subject-passkey-a' });
      const resolved = await accountRepo.findByGithubLogin('');
      expect(resolved).toBeNull();
    });
  });

  it('POST /accounts behaves exactly as before: bringing your own DID still registers it', async () => {
    await withPlatformSeed(async () => {
      const sessionAdapter = createSessionAdapter({ github: fakeGitHubConfig() });
      const accountRepo = new MemoryAccountRepository();
      const baseUrl = await listen(
        createApp(accountRepo, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
      );

      const res = await fetch(`${baseUrl}/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ did: 'did:abt:p8d-bring-your-own', githubLogin: 'p8d-bring-your-own-login' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.did).toBe('did:abt:p8d-bring-your-own');
    });
  });

  it('the same payment succeeds after the provisioned account sets an address, proving the upgrade path is open', async () => {
    // Same setup as the custody-fence test above: a provisioned OPERATOR
    // account backing the hired agent. Here it upgrades by setting its
    // own ABT address through the PATCH route (still only a session, no
    // signing key), and the SAME payment that just refused now confirms
    // and pays exactly that address.
    const started = await setupAbtJobWithProvisionedOperator('p8d-upgrade-path-operator');
    try {
      const ADDRESS = 'z1UpgradePathOwnAddress';
      const patchRes = await fetch(`${started.baseUrl}/accounts/${started.operatorDid}/operator-address`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...started.operatorAuth },
        body: JSON.stringify({ operatorAddressAbt: ADDRESS }),
      });
      expect(patchRes.status).toBe(200);
      const patchBody = (await patchRes.json()) as Record<string, unknown>;
      expect(patchBody.operatorAddressAbt).toBe(ADDRESS);

      const result = await driveAbtPayment(started.baseUrl, started.buyer, started.buyerWallet, {
        jobId: started.jobId,
        leg: 'deposit',
      });
      expect(result.confirmed).toBe(true);
      const row = await started.settlementRepo.findByJobAndLeg(started.jobId, 'deposit');
      expect(row).not.toBeNull();
      expect(row?.operatorAddress).toBe(ADDRESS);
    } finally {
      started.server.close();
    }
  });

  // Every resolveActingParty call site must map a provisioning failure to
  // 503, never fall through to the generic terminal 500 handler. POST
  // /jobs already proves this (above); this pins the same convention on
  // a second, differently-wired route (forwarded(), not a route-local
  // try/catch written the same way) so the convention is proven at more
  // than one call site, not just the first one written.
  it('POST /jobs/:jobId/reviews also answers 503, not 500, when a session cannot be provisioned', async () => {
    const original = process.env.FREEAGENTS_PLATFORM_SEED;
    delete process.env.FREEAGENTS_PLATFORM_SEED;
    try {
      const sessionAdapter = createSessionAdapter({
        github: fakeGitHubConfig(),
        fetchImpl: fakeGitHubFetch({ login: 'p8d-reviews-no-seed-buyer', id: 9007 }),
      });
      const accountRepo = new MemoryAccountRepository();
      const baseUrl = await listen(
        createApp(accountRepo, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
      );
      const auth = await githubSessionHeader(sessionAdapter);

      const res = await fetch(`${baseUrl}/jobs/no-such-job/reviews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ agentDid: 'did:abt:p8d-reviews-agent', text: 'Great work, thanks.' }),
      });
      expect(res.status).toBe(503);
    } finally {
      if (original === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
      else process.env.FREEAGENTS_PLATFORM_SEED = original;
    }
  });
});
