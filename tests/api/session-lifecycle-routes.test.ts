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
//
// A session resolves to whichever Account DID its own subject is bound
// to, and an Agent's own DID can never be that DID: POST /accounts and
// POST /agents both refuse the collision, in either order (D1, D2 below).
// So a buyer session reaches every buyer-only and shared route here, and
// an agent still proves its own seat with its delegation key (RFC 9421)
// exactly as it did before this card -- no new session-to-agent binding
// is in this card's scope. The full lifecycle walk below drives the
// buyer side through a session and the agent side through a signature,
// on the same job, to show both proofs are read at the same route.
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import * as vc from '@digitalbazaar/vc';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import { fromRandom, type WalletObject } from '@ocap/wallet';

import { createApp } from '../../src/api/app.js';
import {
  MemoryAgentRepository,
  MemoryAccountRepository,
  MemoryJobRepository,
  MemoryAttestationRepository,
} from '../../src/adapters/storage/memory.js';
import type { GithubAdapter } from '../../src/adapters/github/types.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';
import { signingIdentityFromSeed, signingIdentityFromWallet, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { fakeGitHubConfig } from '../helpers/session-fixtures.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import type { SessionAdapter } from '../../src/adapters/identity/session.js';
import { createPasskeyFixture } from '../helpers/webauthn-fixtures.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import { DELEGATION_TYPE } from '../../src/domain/agent.js';

// The ArcBlock wallet's secretKey is seed(32)||public(32) in hex. Same house
// construction as tests/api/agent-invariant2.test.ts and
// tests/api/job-invariant2.test.ts: POST /agents runs real cryptographic
// verification, so a hand-typed proofValue is refused with 400 before the
// D2 describe block below can even reach the check it exists to prove.
function hexToBytes(h: string): Uint8Array {
  return Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
}

async function signW3CDelegation(operator: WalletObject, agent: WalletObject): Promise<Record<string, unknown>> {
  const operatorDid = operator.toDid();
  const agentDid = agent.toDid();

  const seed = hexToBytes(operator.secretKey).slice(0, 32);
  const key = await Ed25519VerificationKey2020.generate({ seed, controller: operatorDid });
  key.id = `${operatorDid}#${key.publicKeyMultibase}`;

  const suite = new Ed25519Signature2020({ key });

  const credential = {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
      { '@vocab': 'https://freeagents.dev/terms#' },
    ],
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: ['VerifiableCredential', DELEGATION_TYPE],
    issuer: operatorDid,
    issuanceDate: new Date().toISOString(),
    credentialSubject: { id: agentDid, delegatedBy: operatorDid },
  };

  const loader = securityLoader();
  loader.addStatic(key.id, {
    '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
    ...key.export({ publicKey: true }),
  });
  loader.addStatic(operatorDid, {
    '@context': 'https://www.w3.org/ns/did/v1',
    id: operatorDid,
    assertionMethod: [key.id],
    verificationMethod: [
      {
        '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
        ...key.export({ publicKey: true }),
      },
    ],
  });
  const documentLoader = loader.build();

  return vc.issue({ credential, suite, documentLoader });
}

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

// B14a (merged after this card's branch point) replaced fork-and-PR with
// the platform-owned staging repository lifecycle, so the adapter this
// file hands createApp has to speak that lifecycle. The shared fixture is
// the house fake for exactly this case: a suite that walks a job through
// confirm to pull-request without itself being about staging mechanics.
function fakeGithub(): GithubAdapter {
  return createStagingLifecycleGithubFake().github;
}

// Boots createApp on an ephemeral port and resolves once it is listening.
// Takes createApp's own parameter tuple directly (positional, undefined for
// every capability a test does not need), so every describe block below
// keeps calling createApp exactly the way it always did; only the
// listen/wait/address boilerplate around that call is shared, once.
async function bootServer(...args: Parameters<typeof createApp>): Promise<{ server: Server; baseUrl: string }> {
  const server = createApp(...args).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

// Every fixture agent in this file is the same shape (delegationFixture is
// not cryptographically verified by a direct repo.create call, only by
// POST /agents itself, which the D2 block below exercises separately), so
// one helper replaces the repeated seven-field literal at each call site.
async function createAgent(
  agentRepo: MemoryAgentRepository,
  did: string,
  operatorDid: string,
  verifiedGithubLogin: string | null = null,
): Promise<void> {
  await agentRepo.create({
    did,
    operatorDid,
    delegation: delegationFixture(did) as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: verifiedGithubLogin,
  });
  // B14a: confirm refuses to create a staging repository for an agent with
  // no VERIFIED GitHub binding, so any test that walks a job past confirm
  // has to seed one. Tests that never reach confirm pass null and keep the
  // unbound shape they had before B14a landed.
  if (verifiedGithubLogin !== null) {
    await agentRepo.updateGithubBinding(did, { handle: verifiedGithubLogin, status: 'verified' });
  }
}

// The card's own "Done means" acceptance sentence: a session-authenticated
// buyer reaches price/accept, confirm, withdraw, redo and pull-request
// across one job -- no RFC 9421 signature header on any buyer call in this
// describe block. The agent's own seat is proven the way it was proven
// before this card, and the way D1/D2 require it to stay proven: a
// verified signature naming the agent's own DID (signingIdentityFromSeed
// mints a self-certifying did:abt DID, the same construction
// tests/api/job-merge-restart.test.ts uses), since an agent's DID can
// never also be an Account's DID (D1, D2). Same route, same gate
// (resolveJobActingParty), two different proofs for two different
// parties -- the anchor this card exists to prove.
describe('P8a: the full lifecycle walk, buyer by session, agent by its own signature', () => {
  let server: Server;
  let baseUrl: string;
  const BUYER_DID = 'did:abt:p8a-walk-buyer';

  let agentIdentity: SigningIdentity;
  let buyerAuthHeader: Record<string, string>;

  beforeAll(async () => {
    const repo = new MemoryAccountRepository();
    const agentRepo = new MemoryAgentRepository();
    const jobRepo = new MemoryJobRepository();
    const attestationRepo = new MemoryAttestationRepository();
    agentIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(213));
    await createAgent(agentRepo, agentIdentity.did, 'did:abt:p8a-walk-operator', 'p8a-walk-agent-login');
    const buyerSubject = 'p8a-walk-buyer-passkey-subject';
    await repo.register({ did: BUYER_DID, githubLogin: 'p8a-walk-buyer-login', passkeySubject: buyerSubject });

    const sessionAdapter = passkeyAdapter();

    ({ server, baseUrl } = await bootServer(
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
    ));

    buyerAuthHeader = await passkeySessionHeader(sessionAdapter, buyerSubject);
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

  function postAsAgent(path: string, body: unknown): Promise<Response> {
    return postSigned(baseUrl, path, body, agentIdentity);
  }

  it('a session-authenticated buyer accepts a price, confirms, requests a redo, and reads back the pull request the agent submitted, no signature on any buyer call', async () => {
    const created = await postSession(
      '/jobs',
      { agentDid: agentIdentity.did, repository: 'buyer/target-repo', brief: 'Fix the login bug' },
      buyerAuthHeader,
    );
    expect(created.status).toBe(201);
    const jobId = String(((await created.json()) as Record<string, unknown>).id);

    const proposed = await postAsAgent(`/jobs/${jobId}/criteria`, {
      criteria: [
        { text: 'The login bug is fixed', proposedBy: 'agent' },
        { text: 'Checkout e2e test passes', proposedBy: 'agent' },
      ],
      priceUsd: '500.00',
      rail: 'abt',
    });
    expect(proposed.status).toBe(200);

    expect((await postSession(`/jobs/${jobId}/criteria/0/accept`, {}, buyerAuthHeader)).status).toBe(200);
    expect((await postAsAgent(`/jobs/${jobId}/criteria/0/accept`, {})).status).toBe(200);
    expect((await postSession(`/jobs/${jobId}/criteria/1/accept`, {}, buyerAuthHeader)).status).toBe(200);
    expect((await postAsAgent(`/jobs/${jobId}/criteria/1/accept`, {})).status).toBe(200);

    expect((await postSession(`/jobs/${jobId}/price/accept`, {}, buyerAuthHeader)).status).toBe(200);
    expect((await postAsAgent(`/jobs/${jobId}/price/accept`, {})).status).toBe(200);

    const confirmed = await postSession(`/jobs/${jobId}/confirm`, {}, buyerAuthHeader);
    expect(confirmed.status).toBe(200);
    expect(((await confirmed.json()) as Record<string, unknown>).status).toBe('confirmed');

    const staged = await postAsAgent(`/jobs/${jobId}/stage`, { stagedCommit: 'p8a-commit-1' });
    expect(staged.status).toBe(200);
    expect(((await staged.json()) as Record<string, unknown>).status).toBe('staged');

    const redo = await postSession(`/jobs/${jobId}/redo`, { criterionIndex: 0 }, buyerAuthHeader);
    expect(redo.status).toBe(200);
    expect(((await redo.json()) as Record<string, unknown>).status).toBe('redo_requested');

    const restaged = await postAsAgent(`/jobs/${jobId}/stage`, { stagedCommit: 'p8a-commit-2' });
    expect(restaged.status).toBe(200);
    expect(((await restaged.json()) as Record<string, unknown>).status).toBe('staged');

    const pullRequest = await postAsAgent(`/jobs/${jobId}/pull-request`, {});
    expect(pullRequest.status).toBe(200);
    const pullRequestBody = (await pullRequest.json()) as Record<string, unknown>;
    expect(pullRequestBody.status).toBe('submitted');
    // B14a: the PR is opened cross-repo, from the platform's staging
    // repository into the buyer's own repository, so the URL names the
    // source repo. Same shape job-pull-request.test.ts pins.
    expect(pullRequestBody.pullRequestUrl).toBe('https://github.com/buyer/target-repo/pull/1');

    // The buyer's session reads the job the agent's key moved forward,
    // still with no signature anywhere on the buyer's own calls.
    const read = await fetch(`${baseUrl}/jobs/${jobId}`, { headers: { ...buyerAuthHeader } });
    expect(read.status).toBe(200);
    expect(((await read.json()) as Record<string, unknown>).status).toBe('submitted');
  });

  it('a session-authenticated buyer opens a job, and the agent declines it with its own signature, no session ever binds the agent seat', async () => {
    const created = await postSession(
      '/jobs',
      { agentDid: agentIdentity.did, repository: 'buyer/target-repo', brief: 'A job the agent will decline' },
      buyerAuthHeader,
    );
    expect(created.status).toBe(201);
    const jobId = String(((await created.json()) as Record<string, unknown>).id);

    const declined = await postAsAgent(`/jobs/${jobId}/decline`, {});
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
    await createAgent(agentRepo, AGENT_DID, 'did:abt:p8a-refusal-operator');
    await repo.register({ did: BUYER_DID, githubLogin: 'p8a-refusal-buyer-login', passkeySubject: BUYER_SUBJECT });
    sessionAdapter = passkeyAdapter();
    ({ server, baseUrl } = await bootServer(
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
    ));
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

  it('opens a job and withdraws it, both over a session, no RFC 9421 signature anywhere', async () => {
    const jobId = await createJobWithSession();

    const withdrawn = await fetch(`${baseUrl}/jobs/${jobId}/withdraw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...buyerAuthHeader },
    });
    expect(withdrawn.status).toBe(200);
    const body = (await withdrawn.json()) as Record<string, unknown>;
    expect(body.status).toBe('withdrawn');
  });

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

  it('503: a session for an account that does not exist yet, with no platform seed configured to provision one', async () => {
    const jobId = await createJobWithSession();

    // A live, real session token -- verifyPasskey genuinely succeeds --
    // for a passkey subject that was NEVER registered as an Account. The
    // proof is real; nothing has claimed that identity yet. P8d: this
    // describe block's app has no FREEAGENTS_PLATFORM_SEED configured, so
    // resolveActingParty's own auto-provisioning attempt fails closed
    // (503) rather than silently resolving to no party (the old 401).
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
    expect(res.status).toBe(503);
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
    await createAgent(agentRepo, AGENT_DID, 'did:abt:p8a-invalid-sig-operator');
    const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(231));
    await repo.register({ did: buyer.did, githubLogin: 'p8a-invalid-sig-buyer-login' });

    const buyerSubject = 'p8a-invalid-sig-buyer-passkey-subject';
    await repo.register({
      did: 'did:abt:p8a-invalid-sig-session-buyer',
      githubLogin: 'p8a-invalid-sig-session-buyer-login',
      passkeySubject: buyerSubject,
    });
    const sessionAdapter = passkeyAdapter();

    const { server, baseUrl } = await bootServer(
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
    );
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
    await createAgent(agentRepo, AGENT_DID, 'did:abt:p8a-order-operator');

    const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(241));
    await repo.register({ did: buyer.did, githubLogin: 'p8a-order-buyer-login' });

    // A SEPARATE, real, registered account -- the session's own party --
    // which is NOT a party to the job the signature will name.
    const sessionSubject = 'p8a-order-session-subject';
    await repo.register({ did: 'did:abt:p8a-order-session-party', githubLogin: 'p8a-order-session-login', passkeySubject: sessionSubject });
    const sessionAdapter = passkeyAdapter();

    const { server, baseUrl } = await bootServer(
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
    );
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

// D1 (review round 1, qa): the session path resolves an acting party through
// Account.did, but POST /accounts is unauthenticated and, before this fix,
// never checked whether the did being registered already belongs to a
// delegated Agent. Agent DIDs are public (GET /agents lists them), so
// anyone could register an Account naming a live agent's own DID, mint a
// real session for it, and act as that agent on every lifecycle route this
// card just opened to sessions -- reaching decline, withdraw and every
// other agent-only route with no delegation key ever involved. Registering
// the buyer side of a job is unaffected: a buyer DID is ordinarily
// self-chosen and was never defended by a key even before this card.
describe('P8a (D1): an agent DID already claimed by a delegation cannot be registered as an Account', () => {
  it('POST /accounts refuses a did an Agent already holds, and the session it would have minted never resolves to the agent as a party', async () => {
    const original = process.env.FREEAGENTS_PLATFORM_SEED;
    process.env.FREEAGENTS_PLATFORM_SEED = 'a'.repeat(64);
    try {
      const repo = new MemoryAccountRepository();
      const agentRepo = new MemoryAgentRepository();
      const jobRepo = new MemoryJobRepository();
      const AGENT_DID = 'did:abt:p8a-d1-victim-agent';
      await createAgent(agentRepo, AGENT_DID, 'did:abt:p8a-d1-victim-operator');

      const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(251));
      await repo.register({ did: buyer.did, githubLogin: 'p8a-d1-buyer-login' });

      const sessionAdapter = passkeyAdapter();
      const attackerSubject = 'p8a-d1-attacker-subject';

      const { server, baseUrl } = await bootServer(
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
      );

      try {
        // The attacker registers an Account claiming the victim agent's own
        // public DID, binding it to a passkey subject the attacker controls.
        const claim = await fetch(`${baseUrl}/accounts`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            did: AGENT_DID,
            githubLogin: 'p8a-d1-attacker-login',
            passkeySubject: attackerSubject,
          }),
        });
        expect(claim.status).not.toBe(201);
        expect(claim.status).toBe(409);

        // No Account row exists for the agent's DID: the registration was
        // refused, not silently downgraded.
        const read = await fetch(`${baseUrl}/accounts/${AGENT_DID}`);
        expect(read.status).toBe(404);

        // A real, live session for the attacker's own passkey subject: the
        // ceremony succeeds (nothing wrong with the attacker's own
        // identity). P8d: this session now PROVISIONS a real account for
        // the attacker (auto-provisioning at first sign-in), but that
        // provisioned account is a NEW, distinct DID, never the victim
        // agent's own DID (the agent's DID is already claimed by a
        // delegation, and POST /accounts refused to let this session claim
        // it above). The provisioned account is simply not a party to
        // this job.
        const attackerAuthHeader = await passkeySessionHeader(sessionAdapter, attackerSubject);

        const created = await postSigned(baseUrl, '/jobs', { agentDid: AGENT_DID, repository: 'buyer/target-repo', brief: 'Fix the login bug' }, buyer);
        expect(created.status).toBe(201);
        const jobId = String(((await created.json()) as Record<string, unknown>).id);

        const declined = await fetch(`${baseUrl}/jobs/${jobId}/decline`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...attackerAuthHeader },
        });
        expect(declined.status).toBe(403);
      } finally {
        server.close();
      }
    } finally {
      if (original === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
      else process.env.FREEAGENTS_PLATFORM_SEED = original;
    }
  });
});

// D2 (review round 2, qa): D1's guard only sees Agents that already exist,
// so it closes the Account-second ordering (claim the agent's did, THEN try
// to register it) but leaves the Account-first ordering wide open: register
// the did as an Account BEFORE it is ever delegated, and POST /agents (which
// checks delegation validity, never whether the did is already an Account)
// happily delegates on top of it. The attacker's Account row then sits
// underneath a real agent, reachable by session, with no delegation key ever
// involved. Uses real HTTP, a real W3C-signed delegation (the same
// construction tests/api/agent-invariant2.test.ts and
// tests/api/job-invariant2.test.ts use), and a real passkey ceremony, so a
// pass here means the actual route stack refuses this, not a mock of it.
describe('P8a (D2): an Account registered before its did is ever delegated cannot be inherited by that delegation', () => {
  it('POST /agents refuses to delegate a did an Account already holds', async () => {
    const repo = new MemoryAccountRepository();
    const agentRepo = new MemoryAgentRepository();
    const jobRepo = new MemoryJobRepository();
    const operatorWallet = fromRandom();
    const agentWallet = fromRandom();

    const sessionAdapter = passkeyAdapter();
    const attackerSubject = 'p8a-d2-attacker-subject';

    const { server, baseUrl } = await bootServer(
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
    );

    try {
      // The operator registers itself normally, unrelated to the attack.
      const operatorReg = await fetch(`${baseUrl}/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ did: operatorWallet.toDid(), githubLogin: 'p8a-d2-operator-login' }),
      });
      expect(operatorReg.status).toBe(201);

      // The attacker claims the agent's did as an Account BEFORE any
      // delegation exists for it. D1's guard (agentRepo.findByDid) sees
      // nothing here: there is no Agent yet, so nothing to refuse.
      const claim = await fetch(`${baseUrl}/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          did: agentWallet.toDid(),
          githubLogin: 'p8a-d2-attacker-login',
          passkeySubject: attackerSubject,
        }),
      });
      expect(claim.status).toBe(201);

      // The operator now delegates the SAME did as an agent, with a real,
      // independently verifiable W3C delegation credential. This must be
      // refused: the did is already claimed by an Account, and honouring
      // the delegation on top of it is exactly the state D1 closed from
      // the other direction.
      const operatorIdentity = await signingIdentityFromWallet(operatorWallet);
      const delegated = await postSigned(
        baseUrl,
        '/agents',
        {
          did: agentWallet.toDid(),
          delegation: await signW3CDelegation(operatorWallet, agentWallet),
          name: 'scout',
          skills: ['triage'],
        },
        operatorIdentity,
      );
      expect(delegated.status).not.toBe(201);
      expect(delegated.status).toBe(409);

      // No Agent row exists: the delegation was refused, not silently
      // downgraded to a different agent identity.
      const read = await fetch(`${baseUrl}/agents/${agentWallet.toDid()}`);
      expect(read.status).toBe(404);

      // The attacker's live session for that did still resolves to no
      // party on any job: with no Agent ever created, a job naming this
      // did as its agent cannot even be opened, so there is nothing left
      // to decline. The invariant this proves is upstream of that job:
      // the did never became a live agent seat in the first place.
      const attackerAuthHeader = await passkeySessionHeader(sessionAdapter, attackerSubject);
      const created = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...attackerAuthHeader },
        body: JSON.stringify({ agentDid: agentWallet.toDid(), repository: 'buyer/target-repo', brief: 'Fix the login bug' }),
      });
      expect(created.status).not.toBe(201);
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
      const AGENT_OPERATOR_DID = 'did:abt:p8a-usdc-operator';
      await createAgent(agentRepo, AGENT_DID, AGENT_OPERATOR_DID);
      // S3: the USDC recipient is resolved from the hired agent's operator
      // account, so that account has to be registered and carry an
      // operatorAddressEvm or start refuses 409 before this test's own
      // assertion about session auth is ever reached.
      await repo.register({ did: AGENT_OPERATOR_DID, githubLogin: 'p8a-usdc-operator-login' });
      await repo.setOperatorAddressEvm(AGENT_OPERATOR_DID, USDC_OPERATOR_ADDRESS);
      const buyerSubject = 'p8a-usdc-buyer-subject';
      await repo.register({ did: 'did:abt:p8a-usdc-buyer', githubLogin: 'p8a-usdc-buyer-login', passkeySubject: buyerSubject });
      const sessionAdapter = passkeyAdapter();
      const jobRepo = new MemoryJobRepository();
      const settlementRepo = new MemorySettlementRepository();

      const { server, baseUrl } = await bootServer(
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
      );
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
          // S3 ruling 6: the body may not name a recipient. It is resolved
          // from the hired agent's operator, and supplying one is a 400.
          body: JSON.stringify({}),
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
