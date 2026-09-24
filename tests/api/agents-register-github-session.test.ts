// G1 path one (ENT-5.1): an operator signed in with GitHub OAuth has
// already proved they control that login (session-github-passkey.ts
// returns the login GitHub itself reported). When that operator registers
// an agent naming their OWN session login as the agent's githubLogin, the
// binding records verified with no further step: no gist, no DID document
// check, nothing beyond the registration call itself. The server takes the
// login from the session, never from the request body alone: a body naming
// a login that is not the session's own stays unverified here, leaving
// path two (the signed gist) as the only way to verify that claim.
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import type { DidDocument, IdentityAdapter } from '../../src/adapters/identity/types.js';
import type { Delegation } from '../../src/domain/agent.js';
import { mintSessionToken, testSessionAdapter } from '../helpers/session-fixtures.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

function delegationFor(agentDid: string, operatorDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:agents-register-session-test',
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

// Only verifyDelegation is under test here (always true, mirroring
// account-proof.test.ts's own fakeIdentity): every other capability throws
// NotImplementedError, the same honest shape the real adapter takes for
// anything this suite never calls.
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

describe('POST /agents, path one (G1): session-verified GitHub login registers verified with zero extra steps', () => {
  let server: Server;
  let baseUrl: string;
  const accountRepo = new MemoryAccountRepository();
  const agentRepo = new MemoryAgentRepository();
  const sessionAdapter = testSessionAdapter();
  let sessionToken: string;
  let sessionLogin: string;
  let operatorDid: string;

  beforeAll(async () => {
    const app = createApp(accountRepo, agentRepo, fakeIdentity(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    sessionToken = await mintSessionToken(sessionAdapter);
    const live = await sessionAdapter.getSession(sessionToken);
    if (live === null) throw new Error('expected the minted token to resolve to a live session');
    sessionLogin = live.subject;

    operatorDid = 'did:abt:zPathOneOperator';
    await accountRepo.register({ did: operatorDid, githubLogin: sessionLogin });
  });

  afterAll(() => {
    server.close();
  });

  it('registers verified with no gist and no DID document check when githubLogin names the session\'s own login', async () => {
    const agentDid = 'did:abt:zPathOneAgent1';
    const res = await postJson(
      baseUrl,
      '/agents',
      {
        did: agentDid,
        delegation: delegationFor(agentDid, operatorDid),
        name: 'scout',
        skills: ['triage'],
        githubLogin: sessionLogin,
      },
      { authorization: `Bearer ${sessionToken}` },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.githubLogin).toBe(sessionLogin);
    expect(body.proofStatus).toBe('verified');

    // Read-back agrees: the binding survives the round trip.
    const read = await fetch(`${baseUrl}/agents/${agentDid}`);
    const readBody = (await read.json()) as Record<string, unknown>;
    expect(readBody.proofStatus).toBe('verified');
  });

  it('is case-insensitive, matching GitHub\'s own tolerance for login case', async () => {
    const agentDid = 'did:abt:zPathOneAgentCase';
    const res = await postJson(
      baseUrl,
      '/agents',
      {
        did: agentDid,
        delegation: delegationFor(agentDid, operatorDid),
        name: 'scout',
        skills: ['triage'],
        githubLogin: sessionLogin.toUpperCase(),
      },
      { authorization: `Bearer ${sessionToken}` },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.proofStatus).toBe('verified');
  });

  it('a githubLogin that is not the session\'s own registers unverified, never trusted from the body alone', async () => {
    const agentDid = 'did:abt:zPathOneAgent2';
    const res = await postJson(
      baseUrl,
      '/agents',
      {
        did: agentDid,
        delegation: delegationFor(agentDid, operatorDid),
        name: 'scout',
        skills: ['triage'],
        githubLogin: 'someone-elses-login',
      },
      { authorization: `Bearer ${sessionToken}` },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.githubLogin).toBe('someone-elses-login');
    expect(body.proofStatus).toBe('unverified');
  });

  it('an agent registered with no githubLogin at all stays unverified, as today', async () => {
    const agentDid = 'did:abt:zPathOneAgentNoLogin';
    const res = await postJson(
      baseUrl,
      '/agents',
      { did: agentDid, delegation: delegationFor(agentDid, operatorDid), name: 'scout', skills: ['triage'] },
      { authorization: `Bearer ${sessionToken}` },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.githubLogin).toBeNull();
    expect(body.proofStatus).toBe('unverified');
  });

  it('a request authenticated by an R-34 signature (no session) never verifies at registration, even naming a real login', async () => {
    const signerIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(201));
    await accountRepo.register({ did: signerIdentity.did, githubLogin: 'signature-only-operator' });
    const agentDid = 'did:abt:zPathOneAgentSigned';
    const res = await postSigned(
      baseUrl,
      '/agents',
      {
        did: agentDid,
        delegation: delegationFor(agentDid, signerIdentity.did),
        name: 'scout',
        skills: ['triage'],
        githubLogin: 'signature-only-operator',
      },
      signerIdentity,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    // No session at all: sessionSubject is never set, so path one cannot
    // fire regardless of what the body claims.
    expect(body.proofStatus).toBe('unverified');
  });
});
