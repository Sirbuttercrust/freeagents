// Invariant 2 (MISSION.md) and Gate 3 step 7, at the API level (R-36): a
// third party must confirm the credential the merge route issued without
// calling this service. tests/adapters/credentials/work-history-invariant2.test.ts
// proves this for the adapter directly; this file proves it for the credential
// as it actually arrives - over HTTP, from POST /jobs/:jobId/merge, after a
// real job walked the whole hire loop through the domain state machine, not
// hand-assembled. verifyIndependent uses ONLY the @digitalbazaar W3C stack;
// createCredentialsAdapter is imported solely to construct the app.
import type { Server } from 'node:http';

import { fromPublicKey } from '@arcblock/did';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import * as vc from '@digitalbazaar/vc';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import type { GithubAdapter, PullRequestRef } from '../../src/adapters/github/types.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import type { DidDocument, IdentityAdapter } from '../../src/adapters/identity/types.js';
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import {
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
  MemoryAccountRepository,
} from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { mintSessionToken, testSessionAdapter } from '../helpers/session-fixtures.js';

// The did:abt suffix derives from the public key, exactly like agent DIDs, so
// the proof's verification method binds back to the DID without any lookup in
// this service.
function didFromKey(key: Ed25519VerificationKey2020): string {
  const keyWithBuffer = key as unknown as { _publicKeyBuffer: Uint8Array };
  return `did:abt:${fromPublicKey(keyWithBuffer._publicKeyBuffer)}`;
}

// The suite requires a controller at generate time, but the DID is itself
// derived from this key, so a placeholder stands in; it is overwritten
// before the key is used to sign.
async function generateKey(seed: Uint8Array): Promise<Ed25519VerificationKey2020> {
  const key = await Ed25519VerificationKey2020.generate({ seed, controller: 'did:abt:pending' });
  key.controller = didFromKey(key);
  return key;
}

// A stranger holding only the credential JSON: resolve the key from the
// proof's verificationMethod fingerprint, check the key actually belongs to
// the claimed issuer, and verify with the off-the-shelf W3C stack. No access
// to the issuer's seed, no call to this service.
async function verifyIndependent(credential: Record<string, unknown>): Promise<boolean> {
  try {
    const proof = credential.proof as Record<string, unknown>;
    const verificationMethod = String(proof.verificationMethod);
    const issuer = String(credential.issuer);

    const fingerprint = verificationMethod.slice(verificationMethod.indexOf('#') + 1);
    const key = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint });

    const keyWithBuffer = key as unknown as { _publicKeyBuffer: Uint8Array };
    if (fromPublicKey(keyWithBuffer._publicKeyBuffer) !== issuer.replace(/^did:abt:/, '')) {
      return false;
    }

    key.controller = issuer;
    key.id = verificationMethod;

    const loader = securityLoader();
    loader.addStatic(key.id, {
      '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
      ...key.export({ publicKey: true }),
    });
    loader.addStatic(issuer, {
      '@context': 'https://www.w3.org/ns/did/v1',
      id: issuer,
      assertionMethod: [key.id],
      verificationMethod: [
        {
          '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
          ...key.export({ publicKey: true }),
        },
      ],
    });
    const documentLoader = loader.build();

    const result = await vc.verifyCredential({
      credential,
      suite: new Ed25519Signature2020(),
      documentLoader,
    });
    return result.verified === true;
  } catch {
    return false;
  }
}

const FORK_OWNER = 'freeagents-platform';
const FORK_REPO = 'target-repo';
const PR_NUMBER = 3;
const MERGE_SHA = 'inv2-merge-commit-sha';
const MERGED_AT = new Date('2026-08-25T09:00:00Z');

async function post(base: string, path: string, body: unknown = {}, authHeader: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeader },
    body: JSON.stringify(body),
  });
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

async function get(base: string, path: string): Promise<Response> {
  return fetch(`${base}${path}`);
}

describe('POST /jobs/:jobId/merge, invariant 2 (R-36): a third party verifies the issued credential', () => {
  let server: Server;
  let baseUrl: string;
  let credential: Record<string, unknown>;
  let readBackCredential: Record<string, unknown>;
  let issuerDid: string;
  let agentDid: string;

  beforeAll(async () => {
    const issuerSeed = crypto.getRandomValues(new Uint8Array(32));
    const issuerKey = await generateKey(issuerSeed);
    issuerDid = issuerKey.controller;

    // The agent's signing identity and its registered delegation DID must be
    // the same key: the merge route resolves the agent by agentDid, and the
    // exchange routes' party binding accepts only a signature naming that
    // same DID, so one seed drives both.
    const agentSeed = crypto.getRandomValues(new Uint8Array(32));
    const agentIdentity = await signingIdentityFromSeed(agentSeed);
    agentDid = agentIdentity.did;
    const buyerIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(94));
    const buyerDid = buyerIdentity.did;

    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agentDid,
      operatorDid: 'did:abt:op-merge-invariant2',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });

    const identity: IdentityAdapter = {
      ...createIdentityAdapter(),
      resolveDid: (did: string): Promise<DidDocument> =>
        Promise.resolve({ id: did, controller: null, verificationMethod: [`${did}#key-1`], alsoKnownAs: null }),
    };

    const github: GithubAdapter = {
      getPullRequest: (ref: PullRequestRef) =>
        Promise.resolve({
          ref,
          state: 'merged',
          mergeCommitSha: MERGE_SHA,
          mergedAt: MERGED_AT,
          headSha: 'inv2-head-sha',
          additions: 55,
          deletions: 6,
          filesChanged: 3,
          repositoryPublic: true,
        }),
      getMergeCommitSignature: () => Promise.reject(new NotImplementedError('github', 'getMergeCommitSignature')),
      getPublicGist: () => Promise.reject(new NotImplementedError('github', 'getPublicGist')),
      forkAndOpenPullRequest: () => Promise.resolve({ owner: FORK_OWNER, repo: FORK_REPO, number: PR_NUMBER }),
    };

    const credentialRepo = new MemoryCredentialRepository();
    const credentials = createCredentialsAdapter({ did: issuerDid, seed: issuerSeed }, credentialRepo);
    const operatorRepo = new MemoryAccountRepository();
    await operatorRepo.register({ did: buyerDid, githubLogin: 'buyer-merge-invariant2' });
    const sessionAdapter = testSessionAdapter();
    const authHeader = { authorization: `Bearer ${await mintSessionToken(sessionAdapter)}` };

    const s = createApp(
      operatorRepo,
      agentRepo,
      identity,
      github,
      new MemoryJobRepository(),
      credentials,
      undefined,
      credentialRepo,
      undefined,
      undefined,
      undefined,
      sessionAdapter,
    ).listen(0);
    await new Promise<void>((resolve) => s.once('listening', resolve));
    const address = s.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    server = s;
    baseUrl = `http://127.0.0.1:${address.port}`;

    // Walk one job over HTTP, all the way to merge.
    const draft = await post(baseUrl, '/jobs', {
      buyerDid,
      agentDid,
      repository: 'buyer/target-repo',
      brief: 'Fix the checkout timeout',
    }, authHeader);
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
    expect((await post(baseUrl, `/jobs/${jobId}/pull-request`)).status).toBe(200);

    const merge = await post(baseUrl, `/jobs/${jobId}/merge`);
    expect(merge.status).toBe(200);
    const mergeBody = (await merge.json()) as Record<string, unknown>;
    credential = mergeBody.credential as Record<string, unknown>;

    const read = await get(baseUrl, `/jobs/${jobId}`);
    const readBody = (await read.json()) as Record<string, unknown>;
    readBackCredential = readBody.credential as Record<string, unknown>;
  });

  afterAll(() => {
    server.close();
  });

  it('verifies with the off-the-shelf W3C stack alone, no call to this service', async () => {
    expect(await verifyIndependent(credential)).toBe(true);
  });

  it('the read-back credential is the same bytes, and it verifies too', async () => {
    expect(readBackCredential).toEqual(credential);
    expect(await verifyIndependent(readBackCredential)).toBe(true);
  });

  it('binds to the agent as the credential subject and the platform as issuer', async () => {
    expect(credential.issuer).toBe(issuerDid);
    expect((credential.credentialSubject as Record<string, unknown>).id).toBe(agentDid);
  });

  it('uses the registered Ed25519Signature2020 proof, never a vendor jws', async () => {
    const proof = credential.proof as Record<string, unknown>;
    expect(proof.type).toBe('Ed25519Signature2020');
    expect(proof.jws).toBeUndefined();
  });

  it('TAMPER: a changed diff stat fails the independent verifier', async () => {
    const tampered = JSON.parse(JSON.stringify(credential)) as Record<string, unknown>;
    const subject = tampered.credentialSubject as Record<string, unknown>;
    const hire = subject.hire as Record<string, unknown>;
    hire.additions = 999999;
    expect(await verifyIndependent(tampered)).toBe(false);
  });

  it('FORGERY: a spliced issuer cannot borrow this proof', async () => {
    const forged = JSON.parse(JSON.stringify(credential)) as Record<string, unknown>;
    forged.issuer = 'did:abt:zSomeoneElseEntirely';
    expect(await verifyIndependent(forged)).toBe(false);
  });
});
