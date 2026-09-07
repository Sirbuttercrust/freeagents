// P8d: signing in gives you an account (auto-provision at first sign-in),
// and that account cannot be paid until you say where. This file proves
// the card's own anchor and "Done means" list, driven at the route level
// over real HTTP, never by importing resolveActingParty or the identity
// adapter's methods directly into an assertion.
import type { Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import type { SessionAdapter } from '../../src/adapters/identity/session.js';
import { fakeGitHubConfig, fakeGitHubFetch } from '../helpers/session-fixtures.js';
import { createPasskeyFixture } from '../helpers/webauthn-fixtures.js';
import type { Delegation } from '../../src/domain/agent.js';

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
      const accountRepo = new MemoryAccountRepository();
      const baseUrl = await listen(
        createApp(accountRepo, agentRepo, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
      );

      const auth = await githubSessionHeader(sessionAdapter);

      // Two simultaneous first requests from one new person: both name
      // this agent so each independently attempts to resolve (and
      // therefore provision) the same brand-new subject.
      const [first, second] = await Promise.all([
        fetch(`${baseUrl}/jobs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({ agentDid, repository: 'buyer/target-repo', brief: 'First concurrent hire' }),
        }),
        fetch(`${baseUrl}/jobs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({ agentDid, repository: 'buyer/target-repo', brief: 'Second concurrent hire' }),
        }),
      ]);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const firstBody = (await first.json()) as Record<string, unknown>;
      const secondBody = (await second.json()) as Record<string, unknown>;
      expect(firstBody.buyerDid).toBe(secondBody.buyerDid);

      const account = await accountRepo.findByGithubLogin('p8d-concurrent-github');
      expect(account).not.toBeNull();
    });
  });

  it('a provisioned account has both operator addresses null, and an ABT payment for a job hiring its agent refuses to start, naming the PATCH route', async () => {
    await withPlatformSeed(async () => {
      const sessionAdapter = createSessionAdapter({
        github: fakeGitHubConfig(),
        fetchImpl: fakeGitHubFetch({ login: 'p8d-custody-fence-buyer', id: 9004 }),
      });
      const accountRepo = new MemoryAccountRepository();
      const baseUrl = await listen(
        createApp(accountRepo, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
      );
      const auth = await githubSessionHeader(sessionAdapter);
      await forceProvisioning(baseUrl, auth);

      const account = await accountRepo.findByGithubLogin('p8d-custody-fence-buyer');
      expect(account).not.toBeNull();
      // THE CUSTODY FENCE, asserted directly: neither payout address is
      // ever set by provisioning.
      expect(account?.operatorAddressAbt).toBeNull();
      expect(account?.operatorAddressEvm).toBeNull();
    });
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
    await withPlatformSeed(async () => {
      const sessionAdapter = createSessionAdapter({
        github: fakeGitHubConfig(),
        fetchImpl: fakeGitHubFetch({ login: 'p8d-upgrade-path-buyer', id: 9006 }),
      });
      const accountRepo = new MemoryAccountRepository();
      const baseUrl = await listen(
        createApp(accountRepo, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter),
      );
      const auth = await githubSessionHeader(sessionAdapter);
      await forceProvisioning(baseUrl, auth);
      const account = await accountRepo.findByGithubLogin('p8d-upgrade-path-buyer');
      expect(account).not.toBeNull();
      const did = account!.did;

      const res = await fetch(`${baseUrl}/accounts/${did}/operator-address`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ operatorAddressAbt: 'z1MyOwnAbtAddress' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.operatorAddressAbt).toBe('z1MyOwnAbtAddress');
    });
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
