// S5+S6 route-level acceptance, driven end to end over HTTP against a real
// createApp instance -- the same way the sweep found both findings.
//
// S5 (replay): the sweep's exact case is closed here. One captured header
// set replayed three times must yield one success and two refusals, both
// on a read route and on a mutating route, so the guard is reachable from
// an HTTP request and not merely proven at the adapter's own unit level
// (the standing inert-declared-control rule this card carries).
//
// S6 (future-dated freshness): a signature created 280 seconds ahead is
// refused at the route level too, closing the ten-minute window the
// anchor names (content-digest binds the body; nothing used to bind the
// occurrence).
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryJobRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';
import { SIGNATURE_MAX_AGE_SECONDS } from '../../src/adapters/identity/http-signature.js';

function delegationFixture(agentDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-signature-replay',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: 'did:abt:op-signature-replay',
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
let agent: SigningIdentity;

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

// Replays the EXACT header set a caller already captured -- no new
// signature is minted, matching how the sweep observed the defect (a
// request intercepted in flight and re-sent byte for byte).
async function replay(path: string, body: unknown, headers: Record<string, string>): Promise<Response> {
  const bodyText = JSON.stringify(body);
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: bodyText,
  });
}

async function replayGet(path: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers });
}

function captureHeaders(identity: SigningIdentity, method: string, path: string, body: unknown): Record<string, string> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, method, targetUri, { body: bodyText });
  return {
    'signature-input': signed['signature-input'],
    signature: signed.signature,
    'content-digest': signed['content-digest'],
  };
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

describe('S5+S6: signature replay is refused and future-dated signatures are refused (route level)', () => {
  beforeAll(async () => {
    buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(211));
    agent = await signingIdentityFromSeed(new Uint8Array(32).fill(244));

    const operatorRepo = new MemoryAccountRepository();
    await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-signature-replay' });

    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: 'did:abt:op-signature-replay',
      delegation: delegationFixture(agent.did),
      name: 'scout',
      skills: ['triage'],
      githubLogin: 'scout-signature-replay',
    });
    await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-signature-replay', status: 'verified' });

    const jobRepo = new MemoryJobRepository();
    const { github } = createStagingLifecycleGithubFake();
    server = createApp(operatorRepo, agentRepo, undefined, github, jobRepo, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, alwaysSettledGate()).listen(0, '127.0.0.1');
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

  // The sweep's exact case (S5): one captured header set replayed three
  // times on a READ route yields one success, two refusals.
  it('a read route (GET /jobs/:jobId/attestation) refuses the same header set replayed: one 200/404 (verified), then refusals', async () => {
    const jobId = await createDraftJob();
    const headers = captureHeaders(buyer, 'GET', `/jobs/${jobId}/attestation`, undefined);

    const first = await replayGet(`/jobs/${jobId}/attestation`, headers);
    const second = await replayGet(`/jobs/${jobId}/attestation`, headers);
    const third = await replayGet(`/jobs/${jobId}/attestation`, headers);

    // The party check runs before the attestation lookup, so a verified
    // signature on a draft job (no attestation yet) is 404, not 401 --
    // that is what proves the signature itself was accepted the first
    // time. The second and third presentations of the IDENTICAL signature
    // must be refused as unverifiable (401), never reach the party check.
    expect(first.status).toBe(404);
    expect(second.status).toBe(401);
    expect(third.status).toBe(401);
  });

  // The sweep's exact case (S5): one captured header set replayed on a
  // MUTATING route yields one success, one refusal (the sweep's own
  // wording: "twice on a mutating route returned 200 both sends").
  it('a mutating route (POST /jobs/:jobId/criteria) refuses the same header set replayed: 200 once, then refused', async () => {
    const jobId = await createDraftJob();
    const criteriaBody = { criteria: [{ text: 'Login works', proposedBy: 'agent' }] };
    const headers = captureHeaders(buyer, 'POST', `/jobs/${jobId}/criteria`, criteriaBody);

    const first = await replay(`/jobs/${jobId}/criteria`, criteriaBody, headers);
    const second = await replay(`/jobs/${jobId}/criteria`, criteriaBody, headers);
    const third = await replay(`/jobs/${jobId}/criteria`, criteriaBody, headers);

    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
    expect(third.status).toBe(401);
  });

  // S6 at the route level: a signature created 280 seconds ahead is
  // refused, closing the ten-minute replay window the anchor names.
  it('S6: a signature created 280 seconds in the future is refused at the route level', async () => {
    const jobId = await createDraftJob();
    const bodyText = JSON.stringify({ criteria: [{ text: 'Login works', proposedBy: 'agent' }] });
    const targetUri = `${baseUrl}/jobs/${jobId}/criteria`;
    const future = Math.floor(Date.now() / 1000) + 280;
    const signed = signRequest(buyer, 'POST', targetUri, { body: bodyText, created: future });

    const response = await fetch(targetUri, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'signature-input': signed['signature-input'],
        signature: signed.signature,
        'content-digest': signed['content-digest'],
      },
      body: bodyText,
    });

    expect(response.status).toBe(401);
  });

  // S6 done-means at the route level: the backward-looking boundary is
  // unchanged -- 24 hours ahead already 401s, and must keep doing so.
  it('a signature 24 hours in the future still refuses at the route level (unchanged)', async () => {
    const jobId = await createDraftJob();
    const bodyText = JSON.stringify({ criteria: [{ text: 'Login works', proposedBy: 'agent' }] });
    const targetUri = `${baseUrl}/jobs/${jobId}/criteria`;
    const farFuture = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    const signed = signRequest(buyer, 'POST', targetUri, { body: bodyText, created: farFuture });

    const response = await fetch(targetUri, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'signature-input': signed['signature-input'],
        signature: signed.signature,
        'content-digest': signed['content-digest'],
      },
      body: bodyText,
    });

    expect(response.status).toBe(401);
  });

  // Positive control (done-means): a correctly signed request verifies. A
  // fix that verifies nothing is not a fix. Two DIFFERENT job creations
  // (two different signatures, same buyer) both succeed -- the replay
  // guard scopes on the signature bytes, never on the keyid alone.
  it('a correctly signed request still verifies (positive control), and a fresh signature is unaffected by an earlier one', async () => {
    const firstJobId = await createDraftJob();
    const secondJobId = await createDraftJob();

    expect(firstJobId).not.toBe(secondJobId);

    const firstAccept = await postSigned(`/jobs/${firstJobId}/criteria`, { criteria: [{ text: 'A', proposedBy: 'agent' }] }, buyer);
    const secondAccept = await postSigned(`/jobs/${secondJobId}/criteria`, { criteria: [{ text: 'B', proposedBy: 'agent' }] }, buyer);

    expect(firstAccept.status).toBe(200);
    expect(secondAccept.status).toBe(200);
  });

  // SIGNATURE_MAX_AGE_SECONDS is imported so this file breaks loudly (a
  // compile error) if a future edit ever removes the export nothing else
  // in this file references -- it also documents the backward window's
  // named size for the reader without repeating the literal 300 here.
  it('the backward-looking freshness window keeps its documented size', () => {
    expect(SIGNATURE_MAX_AGE_SECONDS).toBe(300);
  });

  // D1 (QA review round 1, task t_05b14bcc): decided, documented trade-off.
  // Section 3 of this card's brief forbids adding a nonce parameter to the
  // protocol, and ed25519 signing is deterministic -- the same signer,
  // method, target-uri, body and `created` second always produce the same
  // signature bytes. There is therefore no way, short of a nonce, to tell
  // "one request replayed" from "two genuinely independent requests whose
  // signer happened to sign identical content in the same wall-clock
  // second" apart. The shop's decision, recorded here as a pinned test
  // rather than a silent side effect: the spend store treats both cases
  // the same and refuses the second one. This means a caller must not
  // rely on being able to send two byte-for-byte identical requests (same
  // method, URI, body) within the same second and have both succeed --
  // a real retry should be a freshly signed request, which naturally gets
  // a new `created` value from the caller's own clock.
  it('D1: two independently-signed, byte-identical requests in the same second are indistinguishable from a replay by design; the second is refused', async () => {
    const jobId = await createDraftJob();
    const targetUri = `${baseUrl}/jobs/${jobId}/attestation`;
    const wall = Math.floor(Date.now() / 1000);

    const a = signRequest(buyer, 'GET', targetUri, { created: wall });
    const b = signRequest(buyer, 'GET', targetUri, { created: wall });

    // The determinism this test pins: two calls to signRequest for the
    // exact same inputs produce identical bytes. This is not a bug in
    // signRequest, it is what makes the refusal below inevitable without
    // a nonce.
    expect(a.signature).toBe(b.signature);

    const first = await replayGet(`/jobs/${jobId}/attestation`, a);
    const second = await replayGet(`/jobs/${jobId}/attestation`, b);

    expect(first.status).toBe(404);
    expect(second.status).toBe(401);
  });
});
