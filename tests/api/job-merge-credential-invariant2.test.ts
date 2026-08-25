// R-36 (#65), invariant 2 (MISSION.md): the work-history credential the
// MERGE ROUTE issues - not a direct adapter call - verifies with an
// off-the-shelf W3C verifier, with no adapter, no HTTP client, and no code
// of ours in the verification path. tests/adapters/credentials/
// work-history-invariant2.test.ts (R-14) proves this for the adapter in
// isolation; this file proves it for the credential that actually comes out
// of POST /jobs/:jobId/merge, walked over HTTP end to end.
import { fromPublicKey } from '@arcblock/did';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import * as vc from '@digitalbazaar/vc';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import type { GithubAdapter, PullRequestRef, PullRequestSummary } from '../../src/adapters/github/types.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import type { IdentityAdapter } from '../../src/adapters/identity/types.js';
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import { MemoryAgentRepository, MemoryCredentialRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';

// Copied verbatim from tests/adapters/credentials/work-history-invariant2.test.ts
// (R-14). Do not import anything from src/adapters/credentials/credentials.ts
// into this verification path - the point of invariant 2 is that a stranger
// verifies without any of this service's own code.
function didFromKey(key: Ed25519VerificationKey2020): string {
  const keyWithBuffer = key as unknown as { _publicKeyBuffer: Uint8Array };
  return `did:abt:${fromPublicKey(keyWithBuffer._publicKeyBuffer)}`;
}

async function generateKey(seed: Uint8Array): Promise<Ed25519VerificationKey2020> {
  const key = await Ed25519VerificationKey2020.generate({ seed, controller: 'did:abt:pending' });
  key.controller = didFromKey(key);
  return key;
}

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

const AGENT_DID = 'did:abt:agent-merge-inv2';
const BUYER_DID = 'did:abt:buyer-merge-inv2';
const FORK_OWNER = 'freeagents-platform';
const FORK_REPO = 'target-repo-inv2';
const PR_NUMBER = 11;
const MERGE_SHA = 'merge-commit-sha-inv2-def456';
const MERGED_AT = new Date('2026-08-21T09:00:00Z');

function mergedGithub(): GithubAdapter {
  return {
    getPullRequest: (ref: PullRequestRef): Promise<PullRequestSummary> =>
      Promise.resolve({
        ref,
        state: 'merged',
        mergeCommitSha: MERGE_SHA,
        mergedAt: MERGED_AT,
        headSha: 'head-sha-inv2',
        additions: 31,
        deletions: 4,
        filesChanged: 2,
      }),
    getMergeCommitSignature: () => Promise.reject(new NotImplementedError('github', 'getMergeCommitSignature')),
    getPublicGist: () => Promise.reject(new NotImplementedError('github', 'getPublicGist')),
    forkAndOpenPullRequest: () => Promise.resolve({ owner: FORK_OWNER, repo: FORK_REPO, number: PR_NUMBER }),
  };
}

let server: Server;
let baseUrl: string;

async function post(path: string, body: unknown = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

describe('job merge credential, invariant 2 (R-36, MISSION Gate 2)', () => {
  let mergeBody: Record<string, unknown>;
  let jobId: string;

  beforeAll(async () => {
    // The platform issuer: DID derived from the seed, exactly like the
    // adapter-level R-14 test, so verifyIndependent's binding check accepts
    // it.
    const issuerSeed = crypto.getRandomValues(new Uint8Array(32));
    const issuerKey = await generateKey(issuerSeed);
    const issuerDid = issuerKey.controller;

    const identity: IdentityAdapter = {
      ...createIdentityAdapter(),
      resolveDid: (did: string) =>
        Promise.resolve({ id: did, controller: null, verificationMethod: [`${did}#key-1`], alsoKnownAs: null }),
    };
    const credentialRepo = new MemoryCredentialRepository();
    const credentials = createCredentialsAdapter({ did: issuerDid, seed: issuerSeed }, credentialRepo);

    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:op-merge-inv2',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });

    const app = createApp(
      undefined,
      agentRepo,
      identity,
      mergedGithub(),
      new MemoryJobRepository(),
      credentials,
      credentialRepo,
    );
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    // Walk draft -> proposed -> confirmed -> submitted -> merged over HTTP
    // only, the same five posts job-merge.test.ts's walkToSubmitted makes.
    const created = await post('/jobs', {
      buyerDid: BUYER_DID,
      agentDid: AGENT_DID,
      repository: 'buyer/target-repo-inv2',
      brief: 'Fix the checkout timeout',
    });
    expect(created.status).toBe(201);
    jobId = String(((await created.json()) as Record<string, unknown>).id);

    expect(
      (
        await post(`/jobs/${jobId}/criteria`, {
          criteria: [
            { text: 'The checkout timeout is fixed', proposedBy: 'agent' },
            { text: 'Load test passes', proposedBy: 'buyer' },
          ],
        })
      ).status,
    ).toBe(200);
    expect((await post(`/jobs/${jobId}/criteria/0/accept`)).status).toBe(200);
    expect((await post(`/jobs/${jobId}/criteria/1/accept`)).status).toBe(200);
    expect((await post(`/jobs/${jobId}/confirm`)).status).toBe(200);
    expect((await post(`/jobs/${jobId}/pull-request`)).status).toBe(200);

    const merge = await post(`/jobs/${jobId}/merge`);
    expect(merge.status).toBe(200);
    mergeBody = (await merge.json()) as Record<string, unknown>;
  });

  afterAll(() => {
    server.close();
  });

  it('the invariant-2 test: a stranger holding only the JSON verifies the merge-issued credential off-platform', async () => {
    const credential = JSON.parse(JSON.stringify(mergeBody.credential)) as Record<string, unknown>;
    expect(await verifyIndependent(credential)).toBe(true);
  });

  it('uses the registered Ed25519Signature2020 proof with a proofValue, not the jws regression', async () => {
    const credential = JSON.parse(JSON.stringify(mergeBody.credential)) as Record<string, unknown>;
    const proof = credential.proof as Record<string, unknown>;
    expect(proof.type).toBe('Ed25519Signature2020');
    expect(typeof proof.proofValue).toBe('string');
    expect(proof.jws).toBeUndefined();
  });

  it('a tampered merge commit sha FAILS the independent verifier', async () => {
    const tampered = JSON.parse(JSON.stringify(mergeBody.credential)) as Record<string, unknown>;
    const subject = tampered.credentialSubject as Record<string, unknown>;
    subject.mergeCommitSha = '0'.repeat(40);
    expect(await verifyIndependent(tampered)).toBe(false);
  });

  it('a tampered subject id FAILS the independent verifier', async () => {
    const tampered = JSON.parse(JSON.stringify(mergeBody.credential)) as Record<string, unknown>;
    const subject = tampered.credentialSubject as Record<string, unknown>;
    subject.id = 'did:abt:zSomeoneElse';
    expect(await verifyIndependent(tampered)).toBe(false);
  });

  it('the same document served by GET /v1/credentials/<jobId> verifies too', async () => {
    const resolved = await get(`/v1/credentials/${jobId}`);
    expect(resolved.status).toBe(200);
    const body = (await resolved.json()) as Record<string, unknown>;
    expect(await verifyIndependent(body)).toBe(true);
  });

  it('no key material rides the merge response', async () => {
    const wire = JSON.stringify(mergeBody).toLowerCase();
    for (const stem of ['privatekey', 'secretkey', 'secret', 'keypair', 'mnemonic']) {
      expect(wire).not.toContain(stem);
    }
  });
});
