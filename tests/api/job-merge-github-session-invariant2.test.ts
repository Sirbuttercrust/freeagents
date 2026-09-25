// G1, invariant 2 for path one (CLAUDE.md: "Anything touching identity,
// credentials, or the hire loop ships with a test proving a third party
// can still verify the result without calling this service"): for a path
// one (session-verified) agent, what a third party checks is unchanged
// from today -- the W3C credential itself, verified with the off-the-shelf
// @digitalbazaar stack, and the merge commit the agent's account made,
// observable directly on GitHub. This mirrors job-merge-invariant2.test.ts
// exactly, with the one difference that matters: the agent's GitHub
// binding here was recorded by POST /agents from the operator's session
// alone, with no account-proof call anywhere in this file.
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
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import type { DidDocument, IdentityAdapter } from '../../src/adapters/identity/types.js';
import type { Delegation } from '../../src/domain/agent.js';
import {
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
  MemoryAccountRepository,
} from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { mintSessionToken, testSessionAdapter } from '../helpers/session-fixtures.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';

function didFromKey(key: Ed25519VerificationKey2020): string {
  const keyWithBuffer = key as unknown as { _publicKeyBuffer: Uint8Array };
  return `did:abt:${fromPublicKey(keyWithBuffer._publicKeyBuffer)}`;
}

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

const MERGE_SHA = 'g1-path-one-merge-commit-sha';
const MERGED_AT = new Date('2026-09-23T09:00:00Z');

function delegationFor(agentDid: string, operatorDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:g1-path-one-invariant2',
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

describe('POST /jobs/:jobId/merge, G1 path one, invariant 2: a third party still verifies without this service', () => {
  let server: Server;
  let baseUrl: string;
  let credential: Record<string, unknown>;
  let readBackCredential: Record<string, unknown>;
  let issuerDid: string;
  let agentDid: string;
  let sessionLogin: string;

  beforeAll(async () => {
    const issuerSeed = crypto.getRandomValues(new Uint8Array(32));
    const issuerKey = await generateKey(issuerSeed);
    issuerDid = issuerKey.controller;

    const agentSeed = crypto.getRandomValues(new Uint8Array(32));
    const agentIdentity = await signingIdentityFromSeed(agentSeed);
    agentDid = agentIdentity.did;
    const buyerIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(213));
    const buyerDid = buyerIdentity.did;

    const identity: IdentityAdapter = {
      createOperatorDid: () => Promise.reject(new NotImplementedError('identity', 'createOperatorDid')),
      createAgentDid: () => Promise.reject(new NotImplementedError('identity', 'createAgentDid')),
      resolveDid: (did: string): Promise<DidDocument> =>
        Promise.resolve({ id: did, controller: null, verificationMethod: [`${did}#key-1`], alsoKnownAs: null }),
      sign: () => Promise.reject(new NotImplementedError('identity', 'sign')),
      verify: () => Promise.reject(new NotImplementedError('identity', 'verify')),
      verifyDelegation: () => Promise.resolve(true),
    };

    const { github: staging } = createStagingLifecycleGithubFake();
    let jobIdForBody = '';
    let prState: 'open' | 'merged' = 'open';
    let prAuthorLogin = '';
    const github: GithubAdapter = {
      ...staging,
      getPullRequest: (ref: PullRequestRef) =>
        Promise.resolve({
          ref,
          state: prState,
          mergeCommitSha: prState === 'merged' ? MERGE_SHA : null,
          mergedAt: prState === 'merged' ? MERGED_AT : null,
          headSha: 'commit-sha-1',
          additions: 40,
          deletions: 3,
          filesChanged: 2,
          repositoryPublic: true,
          headRepoOwner: prAuthorLogin,
          headRepoFullName: `${prAuthorLogin}/target-repo`,
          headRepoIsFork: true,
          baseRepoFullName: 'buyer/target-repo',
          authorLogin: prAuthorLogin,
          body: `Job: ${jobIdForBody}\n`,
        }),
    };

    const credentialRepo = new MemoryCredentialRepository();
    const credentials = createCredentialsAdapter({ did: issuerDid, seed: issuerSeed }, credentialRepo);
    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: buyerDid, githubLogin: 'buyer-g1-path-one-invariant2' });
    const sessionAdapter = testSessionAdapter();
    const agentRepo = new MemoryAgentRepository();

    const s = createApp(
      accountRepo,
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
      undefined,
      alwaysSettledGate(),
      anyCommitStagingObserver(),
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => s.once('listening', resolve));
    const address = s.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    server = s;
    baseUrl = `http://127.0.0.1:${address.port}`;

    // Register the agent path one: the operator's GitHub OAuth session is
    // the whole proof, no gist and no account-proof call anywhere here.
    const sessionToken = await mintSessionToken(sessionAdapter);
    const live = await sessionAdapter.getSession(sessionToken);
    if (live === null) throw new Error('expected the minted token to resolve to a live session');
    sessionLogin = live.subject;
    prAuthorLogin = sessionLogin;
    const authHeader = { authorization: 'Bearer ' + sessionToken };

    const operatorDid = 'did:abt:zG1PathOneInvariant2Operator';
    await accountRepo.register({ did: operatorDid, githubLogin: sessionLogin });

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
    expect(registeredBody.proofStatus).toBe('verified');

    // Walk one job over HTTP, all the way to merge.
    const draft = await postSigned(baseUrl, '/jobs', {
      agentDid,
      repository: 'buyer/target-repo',
      brief: 'Fix the checkout timeout',
    }, buyerIdentity);
    expect(draft.status).toBe(201);
    const jobId = String(((await draft.json()) as Record<string, unknown>).id);
    jobIdForBody = jobId;

    expect(
      (
        await postSigned(baseUrl, `/jobs/${jobId}/criteria`, {
          criteria: [
            { text: 'The checkout no longer times out', proposedBy: 'agent' },
            { text: 'Load test passes', proposedBy: 'buyer' },
          ],
          priceUsd: '500.00',
          rail: 'abt',
        }, agentIdentity)
      ).status,
    ).toBe(200);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, buyerIdentity)).status).toBe(200);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agentIdentity)).status).toBe(200);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, buyerIdentity)).status).toBe(200);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agentIdentity)).status).toBe(200);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, buyerIdentity)).status).toBe(200);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, agentIdentity)).status).toBe(200);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyerIdentity)).status).toBe(200);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-sha-1' }, agentIdentity)).status).toBe(200);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/pull-request`, { pullRequestUrl: 'https://github.com/buyer/target-repo/pull/1' }, agentIdentity)).status).toBe(200);

    prState = 'merged';
    const merge = await postSigned(baseUrl, `/jobs/${jobId}/merge`, {}, buyerIdentity);
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

  it('the merge succeeded through confirm\'s grantPush guard, cleared purely by path one', async () => {
    // If path one had not recorded verified, confirm would have 503'd
    // before a staging repository ever existed, and none of the above
    // would have reached merge at all.
    expect(credential).not.toBeUndefined();
  });

  it('verifies with the off-the-shelf W3C stack alone, no call to this service', async () => {
    expect(await verifyIndependent(credential)).toBe(true);
  });

  it('the read-back credential is the same bytes, and it verifies too', async () => {
    expect(readBackCredential).toEqual(credential);
    expect(await verifyIndependent(readBackCredential)).toBe(true);
  });

  it('binds to the agent as the credential subject and the platform as issuer, with no mention of the account-proof mechanism', async () => {
    expect(credential.issuer).toBe(issuerDid);
    expect((credential.credentialSubject as Record<string, unknown>).id).toBe(agentDid);
    // The credential is a pure work-history fact: it carries nothing about
    // HOW the GitHub binding was proved, matching invariant 3 (credentials
    // carry facts, never opinions) and keeping path one and path two
    // indistinguishable on the wire.
    expect(JSON.stringify(credential)).not.toContain(sessionLogin);
  });

  it('the agent\'s verified GitHub login is a separate, independently-checkable fact on the agent record', async () => {
    // Invariant 2 for path one: a third party checks the credential
    // (above) and, separately, the merge commit the agent's account made
    // on GitHub (MERGE_SHA, observable directly on the platform whose fake
    // this fixture stands in for). The agent record names which login that
    // was, itself a fact anyone can read without trusting this service's
    // verdict about it, since the login it names is the GitHub login
    // GitHub's own OAuth response reported for that operator's session.
    const agentRead = await get(baseUrl, `/agents/${agentDid}`);
    const agentBody = (await agentRead.json()) as Record<string, unknown>;
    expect(agentBody.githubLogin).toBe(sessionLogin);
    expect(agentBody.proofStatus).toBe('verified');
  });

  it('TAMPER: a changed diff stat fails the independent verifier', async () => {
    const tampered = JSON.parse(JSON.stringify(credential)) as Record<string, unknown>;
    const subject = tampered.credentialSubject as Record<string, unknown>;
    const hire = subject.hire as Record<string, unknown>;
    hire.additions = 999999;
    expect(await verifyIndependent(tampered)).toBe(false);
  });
});
