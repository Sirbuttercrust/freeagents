// P8a (invariant 8): a signed-in buyer can run a hire without a wallet.
//
// THE anchor this card exists to prove: every job lifecycle route accepts a
// live session exactly where it accepts a request signature. Before this
// card, the two chokepoints (requireSignedParty, runPartyExchange) and the
// manually-gated routes (criteria, attestation, attestations, reviews) read
// only signerDidOf(req); a signed-in buyer with no signing key was refused
// at the very next step after POST /jobs. This file proves the fix at the
// route surface, never by importing the resolver directly: a reviewer reads
// real HTTP responses, the same as every other acceptance suite in this
// repo.
//
// Every session in this file is minted through a passkey ceremony
// (createPasskeyFixture / registerPasskey / verifyPasskey): one adapter
// instance can mint as many distinct passkey subjects as a test needs,
// unlike the fixed-login GitHub fake, which is why the multi-identity
// tests below (stranger, session-vs-signature ordering) all use passkey.
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import {
  MemoryAgentRepository,
  MemoryAccountRepository,
  MemoryJobRepository,
  MemoryAttestationRepository,
} from '../../src/adapters/storage/memory.js';
import type { GithubAdapter, PullRequestRef } from '../../src/adapters/github/types.js';
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { fakeGitHubConfig } from '../helpers/session-fixtures.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import type { SessionAdapter } from '../../src/adapters/identity/session.js';
import { createPasskeyFixture } from '../helpers/webauthn-fixtures.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';

function delegationFixture(agentDid: string): Record<string, unknown> {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-p8a',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: 'did:abt:op-p8a',
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

function passkeyAdapter(): SessionAdapter {
  return createSessionAdapter({
    github: fakeGitHubConfig(),
    passkey: { rpName: 'FreeAgents test', rpID: 'localhost', origin: 'http://localhost:3000' },
  });
}

// Registers a fresh passkey subject on the given adapter and returns a
// bearer-ready Authorization header for it -- a real WebAuthn "none"
// registration ceremony each time, the same fixture
// party-derivation-acceptance.test.ts uses for its own passkey case.
async function passkeySessionHeader(adapter: SessionAdapter, subject: string): Promise<Record<string, string>> {
  const { optionsJson } = await adapter.registerPasskey(subject);
  const registrationOptions = JSON.parse(optionsJson) as { challenge: string };
  const fixture = createPasskeyFixture();
  const response = fixture.registrationResponse(registrationOptions.challenge, 'localhost');
  const session = await adapter.verifyPasskey(JSON.stringify({ subject, response }));
  if (session === null) {
    throw new Error('passkeySessionHeader: verifyPasskey unexpectedly returned null');
  }
  return { authorization: `Bearer ${session.token}` };
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

function fakeGithub(): GithubAdapter {
  return {
    getPullRequest: () => Promise.reject(new NotImplementedError('github', 'getPullRequest')),
    getMergeCommitSignature: () => Promise.reject(new NotImplementedError('github', 'getMergeCommitSignature')),
    getPublicGist: () => Promise.reject(new NotImplementedError('github', 'getPublicGist')),
    forkAndOpenPullRequest: (): Promise<PullRequestRef> =>
      Promise.resolve({ owner: 'freeagents-platform', repo: 'target-repo', number: 1 }),
  };
}

describe('P8a: a session-authenticated buyer withdraws a job with no signature anywhere', () => {
  let server: Server;
  let baseUrl: string;
  let authHeader: Record<string, string>;
  const AGENT_DID = 'did:abt:p8a-agent-withdraw';

  beforeAll(async () => {
    const repo = new MemoryAccountRepository();
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:op-p8a-withdraw',
      delegation: delegationFixture(AGENT_DID) as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const sessionAdapter = passkeyAdapter();
    const subject = 'p8a-withdraw-buyer-subject';
    await repo.register({ did: 'did:abt:p8a-session-buyer', githubLogin: 'p8a-withdraw-buyer-login', passkeySubject: subject });
    server = createApp(
      repo,
      agentRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sessionAdapter,
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    authHeader = await passkeySessionHeader(sessionAdapter, subject);
  });

  afterAll(() => {
    server.close();
  });

  it('opens a job and withdraws it, both over a session, no RFC 9421 signature anywhere', async () => {
    const created = await fetch(`${baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader },
      body: JSON.stringify({
        agentDid: AGENT_DID,
        repository: 'buyer/target-repo',
        brief: 'Fix the login bug',
      }),
    });
    expect(created.status).toBe(201);
    const jobId = String(((await created.json()) as Record<string, unknown>).id);

    const withdrawn = await fetch(`${baseUrl}/jobs/${jobId}/withdraw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader },
    });
    expect(withdrawn.status).toBe(200);
    const body = (await withdrawn.json()) as Record<string, unknown>;
    expect(body.status).toBe('withdrawn');
  });
});

// The card's own "Done means" acceptance sentence: a session-authenticated
// buyer reaches price/accept, confirm, stage, redo and pull-request across
// one job. No RFC 9421 signature header is ever sent in this describe
// block: every identity proof here is a session bearer token.
describe('P8a: the full lifecycle walk, reached entirely through sessions', () => {
  let server: Server;
  let baseUrl: string;
  const AGENT_DID = 'did:abt:p8a-walk-agent';
  const BUYER_DID = 'did:abt:p8a-walk-buyer';

  let buyerAuthHeader: Record<string, string>;
  let agentAuthHeader: Record<string, string>;

  beforeAll(async () => {
    const repo = new MemoryAccountRepository();
    const agentRepo = new MemoryAgentRepository();
    const jobRepo = new MemoryJobRepository();
    const attestationRepo = new MemoryAttestationRepository();
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:p8a-walk-operator',
      delegation: delegationFixture(AGENT_DID) as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const buyerSubject = 'p8a-walk-buyer-passkey-subject';
    const agentSubject = 'p8a-walk-agent-passkey-subject';
    await repo.register({ did: BUYER_DID, githubLogin: 'p8a-walk-buyer-login', passkeySubject: buyerSubject });
    // The agent's OWN did:abt DID is registered as an Account too, bound
    // to its own passkey subject: the same mechanism a real agent
    // operator would use to reach the agent-only routes from a session
    // instead of a signing key.
    await repo.register({ did: AGENT_DID, githubLogin: 'p8a-walk-agent-login', passkeySubject: agentSubject });

    const sessionAdapter = passkeyAdapter();

    server = createApp(
      repo,
      agentRepo,
      undefined,
      fakeGithub(),
      jobRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sessionAdapter,
      undefined,
      alwaysSettledGate(),
      anyCommitStagingObserver(),
      attestationRepo,
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    buyerAuthHeader = await passkeySessionHeader(sessionAdapter, buyerSubject);
    agentAuthHeader = await passkeySessionHeader(sessionAdapter, agentSubject);
  });

  afterAll(() => {
    server.close();
  });

  async function postSession(path: string, body: unknown, auth: Record<string, string>): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify(body),
    });
  }

  it('a session-authenticated buyer accepts a price, confirms, stages, requests a redo, and opens a pull request, no signature anywhere', async () => {
    const created = await postSession(
      '/jobs',
      { agentDid: AGENT_DID, repository: 'buyer/target-repo', brief: 'Fix the login bug' },
      buyerAuthHeader,
    );
    expect(created.status).toBe(201);
    const jobId = String(((await created.json()) as Record<string, unknown>).id);

    const proposed = await postSession(
      `/jobs/${jobId}/criteria`,
      {
        criteria: [
          { text: 'The login bug is fixed', proposedBy: 'agent' },
          { text: 'Checkout e2e test passes', proposedBy: 'agent' },
        ],
        priceUsd: '500.00',
        rail: 'abt',
      },
      agentAuthHeader,
    );
    expect(proposed.status).toBe(200);

    expect((await postSession(`/jobs/${jobId}/criteria/0/accept`, {}, buyerAuthHeader)).status).toBe(200);
    expect((await postSession(`/jobs/${jobId}/criteria/0/accept`, {}, agentAuthHeader)).status).toBe(200);
    expect((await postSession(`/jobs/${jobId}/criteria/1/accept`, {}, buyerAuthHeader)).status).toBe(200);
    expect((await postSession(`/jobs/${jobId}/criteria/1/accept`, {}, agentAuthHeader)).status).toBe(200);

    expect((await postSession(`/jobs/${jobId}/price/accept`, {}, buyerAuthHeader)).status).toBe(200);
    expect((await postSession(`/jobs/${jobId}/price/accept`, {}, agentAuthHeader)).status).toBe(200);

    const confirmed = await postSession(`/jobs/${jobId}/confirm`, {}, buyerAuthHeader);
    expect(confirmed.status).toBe(200);
    expect(((await confirmed.json()) as Record<string, unknown>).status).toBe('confirmed');

    const staged = await postSession(`/jobs/${jobId}/stage`, { stagedCommit: 'p8a-commit-1' }, agentAuthHeader);
    expect(staged.status).toBe(200);
    expect(((await staged.json()) as Record<string, unknown>).status).toBe('staged');

    const redo = await postSession(`/jobs/${jobId}/redo`, { criterionIndex: 0 }, buyerAuthHeader);
    expect(redo.status).toBe(200);
    expect(((await redo.json()) as Record<string, unknown>).status).toBe('redo_requested');

    const restaged = await postSession(`/jobs/${jobId}/stage`, { stagedCommit: 'p8a-commit-2' }, agentAuthHeader);
    expect(restaged.status).toBe(200);
    expect(((await restaged.json()) as Record<string, unknown>).status).toBe('staged');

    const pullRequest = await postSession(`/jobs/${jobId}/pull-request`, {}, agentAuthHeader);
    expect(pullRequest.status).toBe(200);
    const pullRequestBody = (await pullRequest.json()) as Record<string, unknown>;
    expect(pullRequestBody.status).toBe('submitted');
    expect(pullRequestBody.pullRequestUrl).toContain('freeagents-platform/target-repo/pull/1');
  });

  it('a session-authenticated agent declines a fresh job, no signature anywhere', async () => {
    const created = await postSession(
      '/jobs',
      { agentDid: AGENT_DID, repository: 'buyer/target-repo', brief: 'A job the agent will decline' },
      buyerAuthHeader,
    );
    expect(created.status).toBe(201);
    const jobId = String(((await created.json()) as Record<string, unknown>).id);

    const declined = await postSession(`/jobs/${jobId}/decline`, {}, agentAuthHeader);
    expect(declined.status).toBe(200);
    expect(((await declined.json()) as Record<string, unknown>).status).toBe('declined');
  });
});

describe('P8a: refusal shapes on the session path', () => {
  let server: Server;
  let baseUrl: string;
  let repo: MemoryAccountRepository;
  let sessionAdapter: SessionAdapter;
  const AGENT_DID = 'did:abt:p8a-refusal-agent';
  const BUYER_DID = 'did:abt:p8a-refusal-buyer';
  const BUYER_SUBJECT = 'p8a-refusal-buyer-subject';

  let buyerAuthHeader: Record<string, string>;

  beforeAll(async () => {
    repo = new MemoryAccountRepository();
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:p8a-refusal-operator',
      delegation: delegationFixture(AGENT_DID) as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    await repo.register({ did: BUYER_DID, githubLogin: 'p8a-refusal-buyer-login', passkeySubject: BUYER_SUBJECT });
    sessionAdapter = passkeyAdapter();
    server = createApp(
      repo,
      agentRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sessionAdapter,
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    buyerAuthHeader = await passkeySessionHeader(sessionAdapter, BUYER_SUBJECT);
  });

  afterAll(() => {
    server.close();
  });

  async function createJobWithSession(): Promise<string> {
    const created = await fetch(`${baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...buyerAuthHeader },
      body: JSON.stringify({ agentDid: AGENT_DID, repository: 'buyer/target-repo', brief: 'Fix the login bug' }),
    });
    expect(created.status).toBe(201);
    return String(((await created.json()) as Record<string, unknown>).id);
  }

  it('403: a session that resolves to a DID which is not a party to the job', async () => {
    const jobId = await createJobWithSession();

    // A second, real, registered account, whose session resolves to a
    // DID that is neither this job's buyer nor its agent.
    const strangerSubject = 'p8a-refusal-stranger-subject';
    await repo.register({ did: 'did:abt:p8a-refusal-stranger', githubLogin: 'p8a-refusal-stranger-login', passkeySubject: strangerSubject });
    const strangerAuthHeader = await passkeySessionHeader(sessionAdapter, strangerSubject);

    const res = await fetch(`${baseUrl}/jobs/${jobId}/withdraw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...strangerAuthHeader },
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as Record<string, unknown>).toEqual({
      error: 'the authenticated party is not a party to this job',
    });
  });

  it('401: a session for an account that does not exist', async () => {
    const jobId = await createJobWithSession();

    // A live, real session token -- verifyPasskey genuinely succeeds --
    // for a passkey subject that was NEVER registered as an Account. The
    // proof is real; nothing has claimed that identity yet.
    const unregisteredSubject = 'p8a-refusal-unregistered-subject';
    const { optionsJson } = await sessionAdapter.registerPasskey(unregisteredSubject);
    const registrationOptions = JSON.parse(optionsJson) as { challenge: string };
    const fixture = createPasskeyFixture();
    const response = fixture.registrationResponse(registrationOptions.challenge, 'localhost');
    const session = await sessionAdapter.verifyPasskey(JSON.stringify({ subject: unregisteredSubject, response }));
    if (session === null) throw new Error('expected verifyPasskey to succeed');
    const unregisteredAuthHeader = { authorization: `Bearer ${session.token}` };

    const res = await fetch(`${baseUrl}/jobs/${jobId}/withdraw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...unregisteredAuthHeader },
    });
    expect(res.status).toBe(401);
  });

  it('401: no proof at all (no session, no signature)', async () => {
    const jobId = await createJobWithSession();

    const res = await fetch(`${baseUrl}/jobs/${jobId}/withdraw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('R-34');
    expect(body.error.toLowerCase()).toContain('session');
  });
});

describe('P8a: an invalid signature is refused outright, never falling through to a session', () => {
  it('a request carrying BOTH a valid bearer token and a tampered signature is still 401', async () => {
    const repo = new MemoryAccountRepository();
    const agentRepo = new MemoryAgentRepository();
    const AGENT_DID = 'did:abt:p8a-invalid-sig-agent';
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:p8a-invalid-sig-operator',
      delegation: delegationFixture(AGENT_DID) as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(231));
    await repo.register({ did: buyer.did, githubLogin: 'p8a-invalid-sig-buyer-login' });

    const buyerSubject = 'p8a-invalid-sig-buyer-passkey-subject';
    await repo.register({
      did: 'did:abt:p8a-invalid-sig-session-buyer',
      githubLogin: 'p8a-invalid-sig-session-buyer-login',
      passkeySubject: buyerSubject,
    });
    const sessionAdapter = passkeyAdapter();

    const server = createApp(
      repo,
      agentRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sessionAdapter,
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const authHeader = await passkeySessionHeader(sessionAdapter, buyerSubject);

    try {
      const created = await postSigned(baseUrl, '/jobs', { agentDid: AGENT_DID, repository: 'buyer/target-repo', brief: 'Fix the login bug' }, buyer);
      expect(created.status).toBe(201);
      const jobId = String(((await created.json()) as Record<string, unknown>).id);

      // Sign for one body, send a different one: didSignature's own
      // "invalid" leg (content-digest mismatch), a live bearer token
      // riding alongside it.
      const signedBody = JSON.stringify({});
      const tamperedBody = JSON.stringify({ tampered: true });
      const targetUri = `${baseUrl}/jobs/${jobId}/withdraw`;
      const signed = signRequest(buyer, 'POST', targetUri, { body: signedBody });

      const res = await fetch(targetUri, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'signature-input': signed['signature-input'],
          signature: signed.signature,
          'content-digest': signed['content-digest'],
          ...authHeader,
        },
        body: tamperedBody,
      });
      expect(res.status).toBe(401);
      expect((await res.json())).toEqual({ error: 'invalid signature' });

      // The job never moved: a stranger reading it back over the SAME
      // valid session sees it still in its pre-withdraw state.
      const read = await fetch(`${baseUrl}/jobs/${jobId}`);
      expect(read.status).toBe(200);
      expect(((await read.json()) as Record<string, unknown>).status).not.toBe('withdrawn');
    } finally {
      server.close();
    }
  });
});

describe('P8a: a signature and a session naming different DIDs resolves to the signature', () => {
  it('the signature wins the party check, and a test pins that order', async () => {
    const repo = new MemoryAccountRepository();
    const agentRepo = new MemoryAgentRepository();
    const AGENT_DID = 'did:abt:p8a-order-agent';
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:p8a-order-operator',
      delegation: delegationFixture(AGENT_DID) as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });

    const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(241));
    await repo.register({ did: buyer.did, githubLogin: 'p8a-order-buyer-login' });

    // A SEPARATE, real, registered account -- the session's own party --
    // which is NOT a party to the job the signature will name.
    const sessionSubject = 'p8a-order-session-subject';
    await repo.register({ did: 'did:abt:p8a-order-session-party', githubLogin: 'p8a-order-session-login', passkeySubject: sessionSubject });
    const sessionAdapter = passkeyAdapter();

    const server = createApp(
      repo,
      agentRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sessionAdapter,
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const sessionAuthHeader = await passkeySessionHeader(sessionAdapter, sessionSubject);

    try {
      const created = await postSigned(baseUrl, '/jobs', { agentDid: AGENT_DID, repository: 'buyer/target-repo', brief: 'Fix the login bug' }, buyer);
      expect(created.status).toBe(201);
      const jobId = String(((await created.json()) as Record<string, unknown>).id);

      // The request is BOTH validly signed by the buyer (a party) AND
      // carries a valid session for a DIFFERENT account (not a party).
      // resolveActingParty resolves the signature first: the withdraw
      // must succeed as the BUYER, not be refused as the session's
      // non-party account.
      const bodyText = JSON.stringify({});
      const targetUri = `${baseUrl}/jobs/${jobId}/withdraw`;
      const signed = signRequest(buyer, 'POST', targetUri, { body: bodyText });
      const res = await fetch(targetUri, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'signature-input': signed['signature-input'],
          signature: signed.signature,
          'content-digest': signed['content-digest'],
          ...sessionAuthHeader,
        },
        body: bodyText,
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as Record<string, unknown>).status).toBe('withdrawn');
    } finally {
      server.close();
    }
  });
});

describe('P8a: the payment start routes accept a session for the buyer, still returning a wallet-signable transaction', () => {
  it('POST /jobs/:jobId/payments/deposit/usdc/start reaches the rail on a session, no signature, no platform key involved', async () => {
    const { createUsdcPaymentRail } = await import('../../src/adapters/payment/usdc.js');
    const { MemorySettlementRepository } = await import('../../src/adapters/storage/memory.js');

    const USDC_TOKEN = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
    const USDC_FEE_ADDRESS = '0xFeeAddress000000000000000000000000000';
    const USDC_OPERATOR_ADDRESS = '0xOperator000000000000000000000000000000';
    const USDC_CHAIN_ID = 421614;
    const usdcEnvVars: Record<string, string> = {
      FREEAGENTS_USDC_RPC_URL: 'https://sepolia-rollup.arbitrum.io/rpc',
      FREEAGENTS_USDC_TOKEN_CONTRACT: USDC_TOKEN,
      FREEAGENTS_USDC_CHAIN_ID: String(USDC_CHAIN_ID),
      FREEAGENTS_USDC_FEE_ADDRESS: USDC_FEE_ADDRESS,
    };
    const original: Record<string, string | undefined> = {};
    for (const key of Object.keys(usdcEnvVars)) {
      original[key] = process.env[key];
      process.env[key] = usdcEnvVars[key];
    }

    try {
      const usdcRail = createUsdcPaymentRail({
        chainClient: { decimals: async () => 6, getTransactionReceipt: async () => null },
        rateSource: async () => '1',
        halfPaidStorage: { record: async () => {}, read: async () => null, clear: async () => {} },
        spentTransferStorage: { record: async () => {}, findByHash: async () => null },
      });

      const repo = new MemoryAccountRepository();
      const agentRepo = new MemoryAgentRepository();
      const AGENT_DID = 'did:abt:p8a-usdc-agent';
      await agentRepo.create({
        did: AGENT_DID,
        operatorDid: 'did:abt:p8a-usdc-operator',
        delegation: delegationFixture(AGENT_DID) as never,
        name: 'scout',
        skills: ['triage'],
        githubLogin: null,
      });
      const buyerSubject = 'p8a-usdc-buyer-subject';
      await repo.register({ did: 'did:abt:p8a-usdc-buyer', githubLogin: 'p8a-usdc-buyer-login', passkeySubject: buyerSubject });
      const sessionAdapter = passkeyAdapter();
      const jobRepo = new MemoryJobRepository();
      const settlementRepo = new MemorySettlementRepository();

      const server = createApp(
        repo,
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
        sessionAdapter,
        undefined,
        alwaysSettledGate(),
        anyCommitStagingObserver(),
        undefined,
        null,
        usdcRail,
        settlementRepo,
      ).listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected server to listen on a port');
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const authHeader = await passkeySessionHeader(sessionAdapter, buyerSubject);

      try {
        const created = await fetch(`${baseUrl}/jobs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeader },
          body: JSON.stringify({ agentDid: AGENT_DID, repository: 'buyer/target-repo', brief: 'Fix the login bug' }),
        });
        expect(created.status).toBe(201);
        const jobId = String(((await created.json()) as Record<string, unknown>).id);

        const proposed = await fetch(`${baseUrl}/jobs/${jobId}/criteria`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeader },
          body: JSON.stringify({
            criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent' }],
            priceUsd: '500.00',
            rail: 'usdc',
          }),
        });
        expect(proposed.status).toBe(200);

        const start = await fetch(`${baseUrl}/jobs/${jobId}/payments/deposit/usdc/start`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeader },
          body: JSON.stringify({ operatorAddress: USDC_OPERATOR_ADDRESS }),
        });
        expect(start.status).toBe(200);
        const body = (await start.json()) as Record<string, unknown>;
        // A PaymentRequest for the BUYER's own wallet to sign: no platform
        // key, no signature, appears anywhere in the answer.
        expect(body.rail).toBe('usdc');
        expect(JSON.stringify(body).toLowerCase()).not.toContain('platformsk');
        expect(JSON.stringify(body).toLowerCase()).not.toContain('privatekey');
      } finally {
        server.close();
      }
    } finally {
      for (const key of Object.keys(original)) {
        if (original[key] === undefined) delete process.env[key];
        else process.env[key] = original[key];
      }
    }
  });
});
