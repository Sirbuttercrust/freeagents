// R-3 + R-4 completion (B5, launch blocker): the merge route completes
// against the REAL identity adapter (no test wrapper around resolveDid or
// verify) driven by the H1 chain -- register, delegate, criteria exchange,
// confirm, fork, PR, merge -- with a fake github (the only adapter this
// card leaves stubbed, per the brief: "the merge route completes against
// the real adapter with a fake github"). The agent's key becomes resolvable
// for exactly the reason ENT-8 relies on: the agent signs earlier requests
// in this same flow (POST /jobs/:jobId/criteria, /accept, /confirm), and
// that signature's own binding check (createDidAbtSigningKeyResolver) is
// what teaches the shared KnownKeyStore this DID's verification method --
// createApp wires both off the SAME store. No network call anywhere in this
// file: the agent's key was learned from a signature this process itself
// verified, invariant 2 in the small.
import type { Server } from 'node:http';

import * as nodeCrypto from 'node:crypto';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { afterAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import type { GithubAdapter, PullRequestRef } from '../../src/adapters/github/types.js';
import type { IdentityAdapter } from '../../src/adapters/identity/types.js';
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import {
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
  MemoryAccountRepository,
} from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

const FORK_OWNER = 'freeagents-platform';
const FORK_REPO = 'target-repo';
const PR_NUMBER = 11;
const MERGE_SHA = 'h1-real-identity-merge-sha';
const MERGED_AT = new Date('2026-08-30T10:00:00Z');

function fakeGithub(): GithubAdapter {
  return {
    getPullRequest: (ref: PullRequestRef) =>
      Promise.resolve({
        ref,
        state: 'merged',
        mergeCommitSha: MERGE_SHA,
        mergedAt: MERGED_AT,
        headSha: 'h1-head-sha',
        additions: 20,
        deletions: 4,
        filesChanged: 2,
        repositoryPublic: true,
      }),
    getMergeCommitSignature: () => Promise.reject(new NotImplementedError('github', 'getMergeCommitSignature')),
    getPublicGist: () => Promise.reject(new NotImplementedError('github', 'getPublicGist')),
    forkAndOpenPullRequest: () => Promise.resolve({ owner: FORK_OWNER, repo: FORK_REPO, number: PR_NUMBER }),
  };
}

async function postSigned(base: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${base}${path}`;
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

// Independently checks that `signedBy` (a verificationMethod fragment) is
// the fragment of a key that actually verifies a signature the agent's own
// wallet produced -- exactly the check a stranger reading only the
// credential and the agent's public record would run (the card's anchor).
async function fragmentVerifiesAgentSignature(
  signedBy: string,
  agentIdentity: SigningIdentity,
  payload: Buffer,
  signature: Buffer,
): Promise<boolean> {
  try {
    const fragment = signedBy.slice(signedBy.indexOf('#') + 1);
    const key = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint: fragment });
    const raw = (key as unknown as { _publicKeyBuffer: Uint8Array })._publicKeyBuffer;
    const publicKey = nodeCrypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') },
      format: 'jwk',
    });
    return nodeCrypto.verify(null, payload, publicKey, signature);
  } catch {
    return false;
  }
}

async function startApp(): Promise<{
  server: Server;
  baseUrl: string;
  agentIdentity: SigningIdentity;
  buyerIdentity: SigningIdentity;
}> {
  const agentIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(101));
  const buyerIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(102));

  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: agentIdentity.did,
    operatorDid: 'did:abt:op-h1-real-identity',
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: null,
  });
  const operatorRepo = new MemoryAccountRepository();
  await operatorRepo.register({ did: buyerIdentity.did, githubLogin: 'buyer-h1-real-identity' });

  const credentialRepo = new MemoryCredentialRepository();
  const credentials = createCredentialsAdapter(
    { did: 'did:abt:platform-h1-real-identity', seed: new Uint8Array(32).fill(9) },
    credentialRepo,
  );

  // identity is left undefined: createApp wires the REAL adapter (no test
  // wrapper) sharing one KnownKeyStore with the R-34 signing-key resolver.
  const app = createApp(
    operatorRepo,
    agentRepo,
    undefined,
    fakeGithub(),
    new MemoryJobRepository(),
    credentials,
    undefined,
    credentialRepo,
  );
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, agentIdentity, buyerIdentity };
}

describe('POST /jobs/:jobId/merge, the real identity adapter, H1 chain, fake github only', () => {
  let server: Server;

  afterAll(() => {
    server?.close();
  });

  it('completes the job and issues a credential whose signedBy names the key the agent actually holds', async () => {
    const started = await startApp();
    server = started.server;
    const { baseUrl, agentIdentity, buyerIdentity } = started;

    // The H1 walk: brief, criteria, both accept, confirm, fork+PR, merge.
    const draft = await postSigned(baseUrl, '/jobs', {
      agentDid: agentIdentity.did,
      repository: 'buyer/target-repo',
      brief: 'Fix the checkout timeout',
    }, buyerIdentity);
    expect(draft.status).toBe(201);
    const jobId = String(((await draft.json()) as Record<string, unknown>).id);

    // This is the step that teaches the shared KnownKeyStore the agent's
    // verification method: didSignature verifies this request against
    // createDidAbtSigningKeyResolver's binding check.
    const criteria = await postSigned(baseUrl, `/jobs/${jobId}/criteria`, {
      criteria: [
        { text: 'The checkout no longer times out', proposedBy: 'agent' },
        { text: 'Load test passes', proposedBy: 'buyer' },
      ],
    }, agentIdentity);
    expect(criteria.status).toBe(200);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, buyerIdentity)).status).toBe(200);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agentIdentity)).status).toBe(200);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, buyerIdentity)).status).toBe(200);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agentIdentity)).status).toBe(200);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyerIdentity)).status).toBe(200);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/pull-request`, {}, agentIdentity)).status).toBe(200);

    const merge = await postSigned(baseUrl, `/jobs/${jobId}/merge`, {}, buyerIdentity);
    expect(merge.status).toBe(200);
    const mergeBody = (await merge.json()) as Record<string, unknown>;
    expect(mergeBody.status).toBe('completed');
    const credential = mergeBody.credential as Record<string, unknown>;
    const hire = (credential.credentialSubject as Record<string, unknown>).hire as Record<string, unknown>;
    const signedBy = String(hire.signedBy);

    // signedBy must actually be the agent's own key, checked exactly the
    // way a stranger holding only the credential and the agent's DID would:
    // sign a fresh payload with the agent's real private key and confirm
    // the fragment named in signedBy verifies it.
    const payload = Buffer.from('mutation-proof payload for signedBy', 'utf8');
    const signature = nodeCrypto.sign(null, payload, agentIdentity.privateKey);
    expect(signedBy).toBe(agentIdentity.keyid);
    expect(await fragmentVerifiesAgentSignature(signedBy, agentIdentity, payload, signature)).toBe(true);
  });

  // MUTATION PROOF: swap in a resolveDid that names a DIFFERENT key (the
  // buyer's, standing in for "any key the agent does not hold") and confirm
  // the same independent check that just passed now fails -- the test
  // above is actually checking something, not passing by construction.
  it('MUTATION PROOF: resolveDid naming a different key fails the same signedBy check', async () => {
    const agentIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(101));
    const wrongKeyIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(103));

    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agentIdentity.did,
      operatorDid: 'did:abt:op-h1-mutation',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const operatorRepo = new MemoryAccountRepository();
    const buyerIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(102));
    await operatorRepo.register({ did: buyerIdentity.did, githubLogin: 'buyer-h1-mutation' });

    const credentialRepo = new MemoryCredentialRepository();
    const credentials = createCredentialsAdapter(
      { did: 'did:abt:platform-h1-mutation', seed: new Uint8Array(32).fill(8) },
      credentialRepo,
    );

    // The mutated adapter: resolveDid names the WRONG key's verification
    // method for the agent DID, the exact defect this test exists to catch.
    const brokenIdentity: IdentityAdapter = {
      createOperatorDid: () => Promise.reject(new NotImplementedError('identity', 'createOperatorDid')),
      createAgentDid: () => Promise.reject(new NotImplementedError('identity', 'createAgentDid')),
      sign: () => Promise.reject(new NotImplementedError('identity', 'sign')),
      verify: () => Promise.resolve(false),
      verifyDelegation: () => Promise.resolve(true),
      resolveDid: (did: string) =>
        Promise.resolve({ id: did, controller: null, verificationMethod: [wrongKeyIdentity.keyid], alsoKnownAs: null }),
    };

    const app = createApp(
      operatorRepo,
      agentRepo,
      brokenIdentity,
      fakeGithub(),
      new MemoryJobRepository(),
      credentials,
      undefined,
      credentialRepo,
    );
    const s = app.listen(0);
    await new Promise<void>((resolve) => s.once('listening', resolve));
    const address = s.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const draft = await postSigned(baseUrl, '/jobs', {
        agentDid: agentIdentity.did,
        repository: 'buyer/target-repo',
        brief: 'Fix the checkout timeout',
      }, buyerIdentity);
      expect(draft.status).toBe(201);
      const jobId = String(((await draft.json()) as Record<string, unknown>).id);

      expect(
        (
          await postSigned(baseUrl, `/jobs/${jobId}/criteria`, {
            criteria: [
              { text: 'The checkout no longer times out', proposedBy: 'agent' },
              { text: 'Load test passes', proposedBy: 'buyer' },
            ],
          }, agentIdentity)
        ).status,
      ).toBe(200);
      expect((await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, buyerIdentity)).status).toBe(200);
      expect((await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agentIdentity)).status).toBe(200);
      expect((await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, buyerIdentity)).status).toBe(200);
      expect((await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agentIdentity)).status).toBe(200);
      expect((await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyerIdentity)).status).toBe(200);
      expect((await postSigned(baseUrl, `/jobs/${jobId}/pull-request`, {}, agentIdentity)).status).toBe(200);

      const merge = await postSigned(baseUrl, `/jobs/${jobId}/merge`, {}, buyerIdentity);
      expect(merge.status).toBe(200);
      const mergeBody = (await merge.json()) as Record<string, unknown>;
      const credential = mergeBody.credential as Record<string, unknown>;
      const hire = (credential.credentialSubject as Record<string, unknown>).hire as Record<string, unknown>;
      const signedBy = String(hire.signedBy);

      const payload = Buffer.from('mutation-proof payload for signedBy', 'utf8');
      const signature = nodeCrypto.sign(null, payload, agentIdentity.privateKey);
      // The mutated resolveDid names a key the agent never held: the same
      // independent check the happy-path test relies on now goes red.
      expect(await fragmentVerifiesAgentSignature(signedBy, agentIdentity, payload, signature)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });
});
