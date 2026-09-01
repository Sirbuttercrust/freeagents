// R-34: the five hire-loop routes wired to didSignature (src/api/app.ts),
// driven end to end over HTTP with no session, cookie or Authorization
// header anywhere -- a DID-signed request is a second, optional identity
// path, never a replacement for what already works. Case 1 is the issue's
// acceptance line at unit scale; the rest prove the refusal paths a
// present-but-invalid signature must take (401) and the party-binding rule
// a valid-but-wrong signature must take (403).
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryJobRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

function delegationFixture(agentDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-signed-routes',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: 'did:abt:op-signed-routes',
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

let server: Server;
let baseUrl: string;
let buyer: SigningIdentity;
// A real signing identity, not a fixed placeholder string: R-34's party
// binding must accept a signature from either party to the job, and that
// needs an agent that can actually produce one (see "allows the agent to
// sign" below).
let agent: SigningIdentity;
let stranger: SigningIdentity;
let unregistered: SigningIdentity;
let jobRepo: MemoryJobRepository;

async function post(path: string, body: unknown, callerDid?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (callerDid !== undefined) headers['x-freeagents-caller-did'] = callerDid;
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

// The three signature headers, nothing else -- no session, no cookie, no
// Authorization header, so the loop this file drives is provably identity
// by signature alone.
async function postSigned(path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
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

async function createDraftJob(): Promise<string> {
  const draft = await postSigned(
    '/jobs',
    { buyerDid: buyer.did, agentDid: agent.did, repository: 'buyer/target-repo', brief: 'Fix the login bug' },
    buyer,
  );
  const body = (await draft.json()) as Record<string, unknown>;
  return String(body.id);
}

describe('DID-signed hire-loop routes (R-34)', () => {
  beforeAll(async () => {
    buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(11));
    agent = await signingIdentityFromSeed(new Uint8Array(32).fill(44));
    stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(22));
    unregistered = await signingIdentityFromSeed(new Uint8Array(32).fill(33));

    const operatorRepo = new MemoryAccountRepository();
    await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-signed-routes' });

    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: 'did:abt:op-signed-routes',
      delegation: delegationFixture(agent.did),
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    // stranger is a registered agent DID -- registered, but not a party to
    // any job this file creates, so it is the fixture for "signature
    // verifies but names the wrong party" (cases 6 and 7).
    await agentRepo.create({
      did: stranger.did,
      operatorDid: 'did:abt:op-signed-routes',
      delegation: delegationFixture(stranger.did),
      name: 'stranger',
      skills: ['triage'],
      githubLogin: null,
    });

    jobRepo = new MemoryJobRepository();
    server = createApp(operatorRepo, agentRepo, undefined, undefined, jobRepo).listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('drives brief -> criteria -> accept -> confirm entirely with signed requests and no session', async () => {
    const draft = await postSigned(
      '/jobs',
      { buyerDid: buyer.did, agentDid: agent.did, repository: 'buyer/target-repo', brief: 'Fix the login bug' },
      buyer,
    );
    expect(draft.status).toBe(201);
    const draftBody = (await draft.json()) as Record<string, unknown>;
    const jobId = String(draftBody.id);

    const proposed = await postSigned(`/jobs/${jobId}/criteria`, { criteria: [{ text: 'Login works', proposedBy: 'agent' }] }, buyer);
    expect(proposed.status).toBe(200);

    // Two-party consent (ENT-6.2): confirm needs both parties' acceptance,
    // so both sign their own accept.
    const acceptedByBuyer = await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, buyer);
    expect(acceptedByBuyer.status).toBe(200);
    const acceptedByAgent = await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, agent);
    expect(acceptedByAgent.status).toBe(200);

    const confirmed = await postSigned(`/jobs/${jobId}/confirm`, {}, buyer);
    expect(confirmed.status).toBe(200);
    const confirmedBody = (await confirmed.json()) as Record<string, unknown>;
    expect(confirmedBody.status).toBe('confirmed');
    expect(typeof confirmedBody.specHash).toBe('string');
  });

  // ENT-6.2's caller-identity gate now requires a verified signature on
  // every one of the four exchange routes: possession of the party's key,
  // not a claim naming it. An unsigned request never reaches the domain.
  it('refuses an unsigned request on each of the four exchange routes with 401', async () => {
    const jobId = await createDraftJob();

    const propose = await post(`/jobs/${jobId}/criteria`, {
      criteria: [{ text: 'Checkout works', proposedBy: 'agent' }],
    });
    expect(propose.status).toBe(401);
    expect(((await propose.json()) as { error: string }).error).toContain('R-34');

    // Sign the proposal so the remaining three routes have something to act on.
    await postSigned(
      `/jobs/${jobId}/criteria`,
      { criteria: [{ text: 'Checkout works', proposedBy: 'agent' }] },
      buyer,
    );

    const requestChanges = await post(`/jobs/${jobId}/request-changes`, {});
    expect(requestChanges.status).toBe(401);

    const accept = await post(`/jobs/${jobId}/criteria/0/accept`, {});
    expect(accept.status).toBe(401);

    const confirm = await post(`/jobs/${jobId}/confirm`, {});
    expect(confirm.status).toBe(401);
  });

  // The retired header names a party but proves nothing -- it is inert, not
  // a fallback identity path. A request that carries it without a verified
  // signature is refused exactly like one that carries no header at all.
  it('leaves the retired x-freeagents-caller-did header inert: present but unsigned is still 401', async () => {
    const jobId = await createDraftJob();

    const response = await post(
      `/jobs/${jobId}/criteria`,
      { criteria: [{ text: 'Checkout works', proposedBy: 'agent' }] },
      buyer.did,
    );

    expect(response.status).toBe(401);
  });

  it('refuses a tampered body: signed for one body, sent with another', async () => {
    const signedBody = JSON.stringify({
      buyerDid: buyer.did,
      agentDid: agent.did,
      repository: 'buyer/target-repo',
      brief: 'Original brief',
    });
    const tamperedBody = JSON.stringify({
      buyerDid: buyer.did,
      agentDid: agent.did,
      repository: 'buyer/target-repo',
      brief: 'Tampered brief',
    });
    const targetUri = `${baseUrl}/jobs`;
    const signed = signRequest(buyer, 'POST', targetUri, { body: signedBody });
    const createSpy = vi.spyOn(jobRepo, 'create');

    const response = await fetch(targetUri, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'signature-input': signed['signature-input'],
        signature: signed.signature,
        'content-digest': signed['content-digest'],
      },
      body: tamperedBody,
    });

    expect(response.status).toBe(401);
    // The middleware rejected the request before the handler ran: no draft
    // was ever written for it.
    expect(createSpy).not.toHaveBeenCalled();
    createSpy.mockRestore();
  });

  it('refuses a signature made for a different route', async () => {
    const jobId = await createDraftJob();
    await postSigned(`/jobs/${jobId}/criteria`, { criteria: [{ text: 'Works', proposedBy: 'agent' }] }, buyer);

    const confirmUri = `${baseUrl}/jobs/${jobId}/confirm`;
    const signedForConfirm = signRequest(buyer, 'POST', confirmUri, { body: '{}' });

    const replayed = await fetch(`${baseUrl}/jobs/${jobId}/request-changes`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'signature-input': signedForConfirm['signature-input'],
        signature: signedForConfirm.signature,
        'content-digest': signedForConfirm['content-digest'],
      },
      body: '{}',
    });

    expect(replayed.status).toBe(401);
  });

  it('refuses a well-formed signature from an unregistered DID', async () => {
    const response = await postSigned(
      '/jobs',
      { buyerDid: buyer.did, agentDid: agent.did, repository: 'buyer/target-repo', brief: 'Fix the login bug' },
      unregistered,
    );

    expect(response.status).toBe(401);
  });

  it('refuses a signature naming the wrong buyerDid with 403, not 401', async () => {
    const response = await postSigned(
      '/jobs',
      { buyerDid: buyer.did, agentDid: agent.did, repository: 'buyer/target-repo', brief: 'Fix the login bug' },
      stranger,
    );

    expect(response.status).toBe(403);
  });

  it('allows the agent, not just the buyer, to sign a job it is a party to', async () => {
    const jobId = await createDraftJob();

    const response = await postSigned(
      `/jobs/${jobId}/criteria`,
      { criteria: [{ text: 'Login works', proposedBy: 'agent' }] },
      agent,
    );

    expect(response.status).toBe(200);
  });

  // The retired header is fully inert now, even when a verified signature
  // is present: a caller who signs as one party gains nothing by also
  // sending the header naming a different party, because nothing reads it.
  // The signed party's identity governs, exactly as if the header were
  // absent -- this is the header's dead-code status made observable.
  it('ignores the retired header entirely, even naming a different party than the verified signature', async () => {
    const jobId = await createDraftJob();
    const bodyText = JSON.stringify({ criteria: [{ text: 'Login works', proposedBy: 'agent' }] });
    const targetUri = `${baseUrl}/jobs/${jobId}/criteria`;
    // Signed by the buyer; the header claims the agent. If the header were
    // read at all, this would 403 (mismatch) or apply as the agent's
    // proposal. Neither happens: it is dead weight on the wire.
    const signed = signRequest(buyer, 'POST', targetUri, { body: bodyText });

    const response = await fetch(targetUri, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'signature-input': signed['signature-input'],
        signature: signed.signature,
        'content-digest': signed['content-digest'],
        'x-freeagents-caller-did': agent.did,
      },
      body: bodyText,
    });

    expect(response.status).toBe(200);
  });

  it('refuses a registered stranger driving a job it is not a party to', async () => {
    const jobId = await createDraftJob();

    const response = await postSigned(`/jobs/${jobId}/request-changes`, {}, stranger);

    expect(response.status).toBe(403);
  });

  it('refuses a signature that does not cover content-digest, even when the digest header matches the body sent', async () => {
    const targetUri = `${baseUrl}/jobs`;
    const body = JSON.stringify({
      buyerDid: buyer.did,
      agentDid: agent.did,
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug',
    });
    // content-digest is still computed correctly for the body actually sent
    // (so the raw-body match in didSignature would pass), but it is left out
    // of the covered components -- the signature itself never bound it.
    const signed = signRequest(buyer, 'POST', targetUri, { body, components: ['@method', '@target-uri'] });
    const createSpy = vi.spyOn(jobRepo, 'create');

    const response = await fetch(targetUri, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'signature-input': signed['signature-input'],
        signature: signed.signature,
        'content-digest': signed['content-digest'],
      },
      body,
    });

    expect(response.status).toBe(401);
    expect(createSpy).not.toHaveBeenCalled();
    createSpy.mockRestore();
  });

  it('falls back to an empty raw body when the request carries none at all, and still matches the digest', async () => {
    const jobId = await createDraftJob();
    const targetUri = `${baseUrl}/jobs/${jobId}/request-changes`;
    // No body and no content-type header: express.json's verify hook never
    // fires, so rawBody is left unset on the request. stranger is a
    // registered agent but not a party to this job, so a 403 (rather than a
    // 401 or a crash) proves the middleware reached the party check --
    // meaning the digest match against the empty-buffer fallback succeeded.
    const signed = signRequest(stranger, 'POST', targetUri, {});

    const response = await fetch(targetUri, {
      method: 'POST',
      headers: {
        'signature-input': signed['signature-input'],
        signature: signed.signature,
        'content-digest': signed['content-digest'],
      },
    });

    expect(response.status).toBe(403);
  });

  it('refuses a half-signed request: Signature-Input present, Signature absent', async () => {
    const targetUri = `${baseUrl}/jobs`;
    const body = JSON.stringify({
      buyerDid: buyer.did,
      agentDid: agent.did,
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug',
    });
    const signed = signRequest(buyer, 'POST', targetUri, { body });

    const response = await fetch(targetUri, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'signature-input': signed['signature-input'],
        'content-digest': signed['content-digest'],
      },
      body,
    });

    expect(response.status).toBe(401);
  });

  it('refuses the reverse half-signed request: Signature present, Signature-Input absent', async () => {
    // The middleware's bypass condition requires BOTH headers absent before it
    // lets a request through unsigned. Only the Input-without-Signature order
    // was tested; deleting the second conjunct would let this order skip
    // verification with no test failing (validator finding, PR #80 lap 3).
    const targetUri = `${baseUrl}/jobs`;
    const body = JSON.stringify({
      buyerDid: buyer.did,
      agentDid: agent.did,
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug',
    });
    const signed = signRequest(buyer, 'POST', targetUri, { body });

    const response = await fetch(targetUri, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        signature: signed.signature,
        'content-digest': signed['content-digest'],
      },
      body,
    });

    expect(response.status).toBe(401);
  });
});
