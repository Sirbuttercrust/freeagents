// P8m: GET /accounts/me. The wireframe (spec/wireframe/myjobs.html) does
// not need this, because a static mock never has to resolve a live
// session to a DID first; the built page does, since the URL vocabulary
// this card is bound to (GET /accounts/:did/jobs, matching
// /accounts/:did/agents) needs a DID to put in the path, and nothing in
// the API today turns a live session into the caller's own account
// record (resolveActingParty is the only place that join happens, and
// every existing call site already had a DID from elsewhere: a job's
// buyerDid/agentDid, or the :did an unrelated route already carries).
// This route is the departure named in the P8m handoff, at this line.
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { MemoryAccountRepository, MemoryAgentRepository } from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

async function getSigned(baseUrl: string, path: string, identity: SigningIdentity): Promise<Response> {
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, 'GET', targetUri, { components: ['@method', '@target-uri', 'content-digest'] });
  return fetch(targetUri, {
    headers: {
      Accept: 'application/json',
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
  });
}

async function listen(app: ReturnType<typeof createApp>): Promise<{ server: Server; baseUrl: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a port');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function delegationFixture(agentDid: string, operatorDid: string): Record<string, unknown> {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-accounts-me',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: agentDid },
    proof: { type: 'Ed25519Signature2020', created: '2026-01-01T00:00:00Z', verificationMethod: `${agentDid}#key-1`, proofPurpose: 'assertionMethod', proofValue: 'zfixture-not-verified-here' },
  };
}

describe('GET /accounts/me', () => {
  it('no proof at all is 401', async () => {
    const app = createApp(new MemoryAccountRepository());
    const { server, baseUrl } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/accounts/me`, { headers: { Accept: 'application/json' } });
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });

  // R-34's signing-key resolver only verifies a signature for a DID it can
  // find registered as an agent OR an account (did-abt-resolver.ts's own
  // isRegistered check): a signature from a wholly unknown DID never
  // verifies at all, so this route's 404 leg needs a DID that IS
  // registered, just not as an Account -- an agent-only identity is
  // exactly that case, and the one a bare signature can actually produce.
  it('a verified signature naming a DID registered only as an agent, never as an Account, is 404, never a synthesised row', async () => {
    const accountRepo = new MemoryAccountRepository();
    const agentRepo = new MemoryAgentRepository();
    const app = createApp(accountRepo, agentRepo);
    const { server, baseUrl } = await listen(app);
    try {
      const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(53));
      const agentOnly = await signingIdentityFromSeed(new Uint8Array(32).fill(54));
      await agentRepo.create({
        did: agentOnly.did,
        operatorDid: operator.did,
        delegation: delegationFixture(agentOnly.did, operator.did) as never,
        name: 'accounts-me-agent-only',
        skills: ['triage'],
        githubLogin: null,
      });
      const res = await getSigned(baseUrl, '/accounts/me', agentOnly);
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('a verified signature naming an already-registered account reads that account back', async () => {
    const accountRepo = new MemoryAccountRepository();
    const app = createApp(accountRepo);
    const { server, baseUrl } = await listen(app);
    try {
      const caller = await signingIdentityFromSeed(new Uint8Array(32).fill(52));
      await accountRepo.register({ did: caller.did, githubLogin: 'accounts-me-caller' });
      const res = await getSigned(baseUrl, '/accounts/me', caller);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.did).toBe(caller.did);
    } finally {
      server.close();
    }
  });
});
