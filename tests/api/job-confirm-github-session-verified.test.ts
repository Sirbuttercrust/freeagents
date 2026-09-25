// G1: confirm's grantPush guard (B14a) reads Agent.proofStatus, and this
// test proves it passes for an agent verified through path one (the
// operator's own GitHub OAuth session, zero extra steps) exactly as it
// already does for an agent verified through the signed gist. The GitHub
// adapter is stubbed, as every existing confirm test does; the fact under
// test is that POST /agents recorded 'verified' from the session alone,
// with no account-proof call ever made.
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryAccountRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import type { GithubAdapter } from '../../src/adapters/github/types.js';
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import type { DidDocument, IdentityAdapter } from '../../src/adapters/identity/types.js';
import type { Delegation } from '../../src/domain/agent.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { mintSessionToken, testSessionAdapter } from '../helpers/session-fixtures.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

const proposal = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
];

function delegationFor(agentDid: string, operatorDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:confirm-path-one-test',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-09-23T00:00:00.000Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-09-23T00:00:00.000Z',
      verificationMethod: `${operatorDid}#zOperatorKeyHash`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zMockProofValue',
    },
  };
}

function fakeIdentity(): IdentityAdapter {
  return {
    createOperatorDid: () => Promise.reject(new NotImplementedError('identity', 'createOperatorDid')),
    createAgentDid: () => Promise.reject(new NotImplementedError('identity', 'createAgentDid')),
    resolveDid: (): Promise<DidDocument> => Promise.reject(new NotImplementedError('identity', 'resolveDid')),
    sign: () => Promise.reject(new NotImplementedError('identity', 'sign')),
    verify: () => Promise.reject(new NotImplementedError('identity', 'verify')),
    verifyDelegation: () => Promise.resolve(true),
  };
}

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
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

let active: Server | null = null;
afterEach(async () => {
  if (active !== null) {
    await new Promise<void>((resolve) => active!.close(() => resolve()));
    active = null;
  }
});

describe('POST /jobs/:jobId/confirm: a path-one (session-verified) agent clears the grantPush guard (B14a)', () => {
  it('grants push exactly as a path-two (signed gist) agent would, with no account-proof call ever made', async () => {
    const accountRepo = new MemoryAccountRepository();
    const agentRepo = new MemoryAgentRepository();
    const sessionAdapter = testSessionAdapter();
    const jobRepo = new MemoryJobRepository();
    const { github: stagingGithub } = createStagingLifecycleGithubFake();
    const settlementGate = alwaysSettledGate();

    const app = createApp(
      accountRepo,
      agentRepo,
      fakeIdentity(),
      stagingGithub as GithubAdapter,
      jobRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sessionAdapter,
      undefined,
      settlementGate,
    );
    const server = app.listen(0, '127.0.0.1');
    active = server;
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    // The operator's session is the whole proof: no gist, no DID document.
    const sessionToken = await mintSessionToken(sessionAdapter);
    const live = await sessionAdapter.getSession(sessionToken);
    if (live === null) throw new Error('expected the minted token to resolve to a live session');
    const sessionLogin = live.subject;
    const authHeader = { authorization: `Bearer ${sessionToken}` };

    const operatorDid = 'did:abt:zConfirmPathOneOperator';
    await accountRepo.register({ did: operatorDid, githubLogin: sessionLogin });

    // The agent's own signing identity is a real ed25519 keypair, exactly
    // as job-confirm.test.ts uses: the criteria/accept/confirm routes check
    // the caller's signed DID against the job's own agentDid directly.
    const agentIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(212));
    const agentDid = agentIdentity.did;

    const registered = await postJson(
      baseUrl,
      '/agents',
      {
        did: agentDid,
        delegation: delegationFor(agentDid, operatorDid),
        name: 'scout',
        skills: ['triage'],
        githubLogin: sessionLogin,
      },
      authHeader,
    );
    expect(registered.status).toBe(201);
    const registeredBody = (await registered.json()) as Record<string, unknown>;
    // The whole point: verified from registration alone, no account-proof
    // call anywhere in this test.
    expect(registeredBody.proofStatus).toBe('verified');
    expect(registeredBody.githubLogin).toBe(sessionLogin);

    const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(210));
    await accountRepo.register({ did: buyer.did, githubLogin: 'confirm-path-one-buyer' });

    const created = await postSigned(baseUrl, '/jobs', {
      buyerDid: buyer.did,
      agentDid,
      repository: 'buyer/confirm-path-one-repo',
      brief: 'Fix the login bug',
    }, buyer);
    expect(created.status).toBe(201);
    const jobId = String(((await created.json()) as Record<string, unknown>).id);

    expect((await postSigned(baseUrl, `/jobs/${jobId}/criteria`, { criteria: proposal, priceUsd: '500.00', rail: 'abt' }, agentIdentity)).status).toBe(200);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, buyer)).status).toBe(200);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agentIdentity)).status).toBe(200);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, buyer)).status).toBe(200);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agentIdentity)).status).toBe(200);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, buyer)).status).toBe(200);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, agentIdentity)).status).toBe(200);

    // The moment under test: confirm reads the grantPush guard
    // (Agent.githubLogin !== null && proofStatus === 'verified') and must
    // pass it purely from the path-one registration above.
    const confirmed = await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
    expect(confirmed.status).toBe(200);
    const confirmedBody = (await confirmed.json()) as Record<string, unknown>;
    expect(confirmedBody.status).toBe('confirmed');
    // A staging repository was created, which only happens after grantPush
    // itself succeeded (B14a's own call ordering).
    expect(confirmedBody.stagingRepo).not.toBeNull();
  });
});
