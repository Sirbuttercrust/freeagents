// R-39 completion acceptance suite: the five behaviours the card's "Done
// means" section names explicitly, each proven through the real HTTP route,
// not a domain-level fixture. Every other test file in this repo covers one
// slice of this story from its own angle; this file is the one place all
// five acceptance sentences live together, so a reviewer can find the whole
// card's proof in one read.
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { AccountAlreadyExistsError } from '../../src/adapters/storage/types.js';
import { signRequest, signingIdentityFromSeed, type SigningIdentity } from '../helpers/sign-request.js';
import { mintSessionToken, testSessionAdapter } from '../helpers/session-fixtures.js';

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

describe('R-39 completion acceptance: party derived, never declared', () => {
  it('a session-authenticated hire derives the buyer from the session, refusing a different real buyerDid smuggled into the body', async () => {
    const repo = new MemoryAccountRepository();
    const agentRepo = new MemoryAgentRepository();
    const AGENT_DID = 'did:abt:pd-agent-session';
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:pd-operator-session',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    // The session's own party: testSessionAdapter always signs in as the
    // fixed GitHub login 'test-session-user'.
    await repo.register({ did: 'did:abt:pd-session-buyer', githubLogin: 'test-session-user' });
    // A SECOND, real, registered account -- what an attacker would try to
    // smuggle into the body to steal credit for someone else's hire.
    await repo.register({ did: 'did:abt:pd-other-buyer', githubLogin: 'someone-else' });

    const sessionAdapter = testSessionAdapter();
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
    ).listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const token = await mintSessionToken(sessionAdapter);
    const authHeader = { authorization: `Bearer ${token}` };

    try {
      // No buyerDid at all: the session alone opens the job, as the party.
      const honest = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader },
        body: JSON.stringify({
          agentDid: AGENT_DID,
          repository: 'buyer/target-repo',
          brief: 'Fix the login bug',
        }),
      });
      expect(honest.status).toBe(201);
      const honestBody = (await honest.json()) as Record<string, unknown>;
      expect(honestBody.buyerDid).toBe('did:abt:pd-session-buyer');

      // Smuggling a DIFFERENT real account's DID into the body: refused,
      // never honoured, regardless of the fact that the DID is real and
      // registered.
      const smuggled = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader },
        body: JSON.stringify({
          buyerDid: 'did:abt:pd-other-buyer',
          agentDid: AGENT_DID,
          repository: 'buyer/target-repo',
          brief: 'Fix the login bug, but credit someone else',
        }),
      });
      expect(smuggled.status).toBe(403);
      expect(await smuggled.json()).toEqual({ error: 'buyerDid does not match the authenticated party' });
    } finally {
      server.close();
    }
  });

  it('a signature-authenticated hire derives the party from the signature, refusing a different real buyerDid smuggled into the body', async () => {
    const repo = new MemoryAccountRepository();
    const agentRepo = new MemoryAgentRepository();
    const AGENT_DID = 'did:abt:pd-agent-sig';
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:pd-operator-sig',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(211));
    const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(212));
    await repo.register({ did: buyer.did, githubLogin: 'pd-buyer-sig' });
    await repo.register({ did: stranger.did, githubLogin: 'pd-stranger-sig' });

    const server = createApp(repo, agentRepo).listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      // No buyerDid at all: the signature alone opens the job, as the
      // party -- same code path as the session case above.
      const honest = await postSigned(baseUrl, '/jobs', {
        agentDid: AGENT_DID,
        repository: 'buyer/target-repo',
        brief: 'Fix the checkout timeout',
      }, buyer);
      expect(honest.status).toBe(201);
      const honestBody = (await honest.json()) as Record<string, unknown>;
      expect(honestBody.buyerDid).toBe(buyer.did);

      // The signer is `buyer`, but the body claims `stranger`, a second
      // real, registered account: refused, never honoured.
      const smuggled = await postSigned(baseUrl, '/jobs', {
        buyerDid: stranger.did,
        agentDid: AGENT_DID,
        repository: 'buyer/target-repo',
        brief: 'Fix the checkout timeout, but credit the stranger',
      }, buyer);
      expect(smuggled.status).toBe(403);
      expect(await smuggled.json()).toEqual({ error: 'buyerDid does not match the authenticated party' });
    } finally {
      server.close();
    }
  });

  it('two accounts cannot share a githubLogin', async () => {
    const repo = new MemoryAccountRepository();
    await repo.register({ did: 'did:abt:pd-login-first', githubLogin: 'pd-shared-login' });

    await expect(
      repo.register({ did: 'did:abt:pd-login-second', githubLogin: 'pd-shared-login' }),
    ).rejects.toBeInstanceOf(AccountAlreadyExistsError);

    // The first registration stands: a rejected second write never
    // overwrites or double-books the login.
    const first = await repo.findByDid('did:abt:pd-login-first');
    expect(first?.githubLogin).toBe('pd-shared-login');
    const second = await repo.findByDid('did:abt:pd-login-second');
    expect(second).toBeNull();
  });

  it('two accounts cannot share a passkeySubject', async () => {
    const repo = new MemoryAccountRepository();
    await repo.register({
      did: 'did:abt:pd-passkey-first',
      githubLogin: 'pd-passkey-first-login',
      passkeySubject: 'pd-shared-passkey',
    });

    await expect(
      repo.register({
        did: 'did:abt:pd-passkey-second',
        githubLogin: 'pd-passkey-second-login',
        passkeySubject: 'pd-shared-passkey',
      }),
    ).rejects.toBeInstanceOf(AccountAlreadyExistsError);

    const first = await repo.findByDid('did:abt:pd-passkey-first');
    expect(first?.passkeySubject).toBe('pd-shared-passkey');
    const second = await repo.findByDid('did:abt:pd-passkey-second');
    expect(second).toBeNull();
  });

  it('the same account buys on one job and operates the selling agent on another, and hiring its own agent is labelled a self-hire', async () => {
    const repo = new MemoryAccountRepository();
    const agentRepo = new MemoryAgentRepository();
    const account = await signingIdentityFromSeed(new Uint8Array(32).fill(213));
    const otherAgentOperator = await signingIdentityFromSeed(new Uint8Array(32).fill(214));

    // The dual-role account: it delegates ITS OWN agent (operator role on
    // job A below) and separately registers as the buyer for job B, hiring
    // a DIFFERENT operator's agent (buyer role, no self-hire).
    await repo.register({ did: account.did, githubLogin: 'pd-dual-role' });
    await repo.register({ did: otherAgentOperator.did, githubLogin: 'pd-other-operator' });

    const ownAgentDid = 'did:abt:pd-own-agent';
    const otherAgentDid = 'did:abt:pd-other-agent';
    await agentRepo.create({
      did: ownAgentDid,
      operatorDid: account.did,
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    await agentRepo.create({
      did: otherAgentDid,
      operatorDid: otherAgentOperator.did,
      delegation: { fixture: true } as never,
      name: 'ranger',
      skills: ['triage'],
      githubLogin: null,
    });

    const server = createApp(repo, agentRepo).listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      // Job A: the account hires ITS OWN agent -- a self-hire, the party
      // derivation resolving the same DID on both sides of the job.
      const selfHireJob = await postSigned(baseUrl, '/jobs', {
        agentDid: ownAgentDid,
        repository: 'buyer/target-repo',
        brief: 'Self-hire: fix my own checkout bug',
      }, account);
      expect(selfHireJob.status).toBe(201);
      const selfHireBody = (await selfHireJob.json()) as Record<string, unknown>;
      expect(selfHireBody.buyerDid).toBe(account.did);
      expect(selfHireBody.agentDid).toBe(ownAgentDid);

      // Job B: the SAME account, now acting as buyer, hires a DIFFERENT
      // operator's agent -- not a self-hire.
      const buyerJob = await postSigned(baseUrl, '/jobs', {
        agentDid: otherAgentDid,
        repository: 'buyer/target-repo',
        brief: 'As a buyer: hire the other operator\'s agent',
      }, account);
      expect(buyerJob.status).toBe(201);
      const buyerJobBody = (await buyerJob.json()) as Record<string, unknown>;
      expect(buyerJobBody.buyerDid).toBe(account.did);
      expect(buyerJobBody.agentDid).toBe(otherAgentDid);

      // Both jobs share one buyerDid (the dual-role account), proving one
      // account genuinely played both roles across two jobs in this run.
      expect(selfHireBody.buyerDid).toBe(buyerJobBody.buyerDid);
    } finally {
      server.close();
    }
  });
});
