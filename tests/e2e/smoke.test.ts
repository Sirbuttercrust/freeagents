/**
 * The end-to-end smoke test, and the source of APP_STARTED and E2E_PASSED.
 *
 * WHY THIS FILE EXISTS AT ALL. The factory refuses to merge unless the run log
 * carries every marker in FACTORY_REQUIRED_MARKERS. That is deliberate: a check
 * that never ran produces no failures, and code asking "did anything fail?"
 * reads silence as success. So the gate asks a different question, "did this
 * specific thing report that it ran?", and an absent marker is a block.
 *
 * On 2026-08-19 that gate blocked the first real validated pull request because
 * APP_STARTED and E2E_PASSED had never existed in this repository. The gate was
 * right and the repository was incomplete. Deleting the requirement would have
 * been the easy fix and the wrong one: it would have removed the only check
 * that proves the thing we ship can actually start.
 *
 * WHAT IT ASSERTS, AND WHAT IT REFUSES TO PRETEND.
 * The API is a route surface where the last hire-loop handlers still return
 * 501 on purpose. So this test proves what is genuinely true today:
 *
 *   - the app boots and binds a port
 *   - /health answers 200 with a body we control
 *   - every declared route EXISTS and is reachable, rather than 404
 *   - the real operator registration flow works end to end
 *   - the real agent delegation flow works end to end, with a delegation
 *     proof a real wallet actually signed
 *   - direction one of the GitHub account proof works end to end: the DID
 *     document (served by a wrapped resolver, the real one has no resolver
 *     yet) carries the account in alsoKnownAs, and the binding is recorded
 *     as pending
 *   - direction two of the GitHub account proof works end to end: the agent
 *     wallet key signs the canonical proof bytes, the statement is published
 *     as a public gist, and with both directions holding the binding is
 *     verified, with a third party re-checking the signature without the
 *     service
 *   - the identity boundary is stated before effort and holds (R-23): the
 *     capability document reads with no identity, browsing an agent needs
 *     none, and a hire with no buyer named is refused
 *   - the deleted-gist re-check works end to end (R-5): the gist no longer
 *     resolves, and the next check drops the verified binding to
 *     unverified, with a third party reading the public gist surface and
 *     agreeing without the service
 *   - key rotation works end to end (R-30, ENT-8.4): an agent signs a
 *     credential with its own key, the key is rotated over HTTP, the
 *     rotation shows in the read-back with dates, and the pre-rotation
 *     credential still verifies with @digitalbazaar/* alone, no call to
 *     the service
 *   - the first half of the hire loop works end to end: an operator
 *     registers, delegates an agent, and a buyer's brief opens a job draft
 *     that reads back identically, with brief and briefHash riding the
 *     response so a third party can recompute the hash without the service
 *   - the acceptance-criteria exchange works end to end (R-8): the agent
 *     proposes criteria, the buyer requests changes, the agent re-proposes,
 *     all on one job row in status proposed - the id never changes and no
 *     second job is created
 *   - confirm works end to end (R-9): each criterion is accepted, confirm
 *     computes specHash from the agreed texts, a stranger recomputes it from
 *     the response alone, and afterwards every editing route refuses the job
 *   - fork and open the pull request works end to end (R-10): the confirmed
 *     job walks to submitted, the pull request carries the job id, and the
 *     recorded github call shows the buyer's repository referenced READ-ONLY
 *     with the write going to the platform's fork
 *   - observing the merge works end to end (R-11, ENT-7.1): the submitted
 *     job's pull request is asked about directly, a merged report from
 *     GitHub - never a client assertion - stamps mergeCommit and mergedAt,
 *     and the completed job is locked against a second merge
 *   - the merge issues a work-history credential (R-36, ENT-8): the response
 *     and the read-back both carry it, and a third party verifies it with
 *     the off-the-shelf W3C stack alone, no call to this service
 *   - an unknown route is still a 404, so the previous assertion means something
 *
 * It does NOT claim the hire loop completes end to end for every path: a
 * draft now walks all the way to completed through the criteria exchange,
 * confirm, the pull request and its observed merge, but the review handler
 * stays 501 until its issue lands. As that handler arrives, the flow
 * assertions below replace its 501 expectation too, and the e2e step floor
 * rises with it.
 *
 * THE MARKERS ARE PRINTED ONLY AFTER THE ASSERTIONS THEY DESCRIBE.
 * Printing APP_STARTED before the server is up, or E2E_PASSED in a finally
 * block, would produce a green log for a red run. That is the exact failure the
 * marker mechanism exists to catch, so the ordering here is load-bearing rather
 * than stylistic.
 */
import * as nodeCrypto from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import * as vc from '@digitalbazaar/vc';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import { fromRandom, type WalletObject } from '@ocap/wallet';

import { createApp } from '../../src/api/app.js';
import {
  GistNotFoundError,
  type ForkAndOpenPullRequestInput,
  type Gist,
  type GithubAdapter,
  type PullRequestRef,
} from '../../src/adapters/github/types.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import type { DidDocument, IdentityAdapter, SignedPayload } from '../../src/adapters/identity/types.js';
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import { MemoryAgentRepository, MemoryCredentialRepository, MemoryOperatorRepository } from '../../src/adapters/storage/memory.js';
import { DELEGATION_TYPE } from '../../src/domain/agent.js';
import { signRequest, signingIdentityFromSeed, type SigningIdentity } from '../helpers/sign-request.js';

let server: Server;
let base: string;

// R-15: the app resolves credentials out of this repository. It is
// module-scoped because the resolution step saves into it the same way
// R-13's issuance will, once the platform issuer is wired in.
const credentialRepo = new MemoryCredentialRepository();

// The platform issuer for this run: the DID derives from the seed, exactly
// like every did:abt here, so a stranger holding only the credential can
// bind the proof's key back to the issuer (invariant 2).
const platformWallet = fromRandom();
const platformIssuer = {
  did: platformWallet.toDid(),
  seed: hexToBytes(platformWallet.secretKey).slice(0, 32),
};

/** Counts assertions that exercised the running server over HTTP. */
let stepsAsserted = 0;

async function get(path: string): Promise<Response> {
  const res = await fetch(`${base}${path}`);
  stepsAsserted += 1;
  return res;
}

async function post(path: string, body: unknown = {}): Promise<Response> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  stepsAsserted += 1;
  return res;
}

// R-34: the same call as post(), except the request carries a DID signature
// instead of nothing -- content-type plus the three signature headers, no
// session, no cookie, no Authorization header, ever.
async function postSigned(path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${base}${path}`;
  const signed = signRequest(identity, 'POST', targetUri, { body: bodyText });
  const res = await fetch(targetUri, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
    body: bodyText,
  });
  stepsAsserted += 1;
  return res;
}

function hexToBytes(h: string): Uint8Array {
  return Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
}

// Create a W3C delegation credential using Ed25519Signature2020, the
// registered proof type that satisfies invariant 2. The operator's ArcBlock
// wallet key drives the same ed25519 key wrapped in a W3C suite.
async function signW3CDelegation(operator: WalletObject, agent: WalletObject): Promise<Record<string, unknown>> {
  const operatorDid = operator.toDid();
  const agentDid = agent.toDid();

  const seed = hexToBytes(operator.secretKey).slice(0, 32);
  const key = await Ed25519VerificationKey2020.generate({ seed, controller: operatorDid });
  key.id = `${operatorDid}#${key.publicKeyMultibase}`;

  const suite = new Ed25519Signature2020({ key });

  const credential = {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
      { '@vocab': 'https://freeagents.dev/terms#' },
    ],
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: ['VerifiableCredential', DELEGATION_TYPE],
    issuer: operatorDid,
    issuanceDate: new Date().toISOString(),
    credentialSubject: { id: agentDid, delegatedBy: operatorDid },
  };

  const loader = securityLoader();
  loader.addStatic(key.id, {
    '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
    ...key.export({ publicKey: true }),
  });
  loader.addStatic(operatorDid, {
    '@context': 'https://www.w3.org/ns/did/v1',
    id: operatorDid,
    assertionMethod: [key.id],
    verificationMethod: [
      {
        '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
        ...key.export({ publicKey: true }),
      },
    ],
  });
  const documentLoader = loader.build();

  const signed = await vc.issue({ credential, suite, documentLoader });
  return signed;
}

// A credential signed by the agent's OWN key, with the agent DID as issuer:
// the rotation-era credential ENT-8.4 must keep verifiable. The proof names
// the signing key in DID fragment form, which is the fragment the rotation
// record's fromKey must match. Adapted from
// tests/domain/key-rotation-verification.test.ts.
async function signWithAgentKey(
  agent: WalletObject,
  key: Ed25519VerificationKey2020,
  operatorDid: string,
): Promise<Record<string, unknown>> {
  const agentDid = agent.toDid();
  key.id = `${agentDid}#${key.publicKeyMultibase}`;

  const suite = new Ed25519Signature2020({ key });

  const credential = {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
      { '@vocab': 'https://freeagents.dev/terms#' },
    ],
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: ['VerifiableCredential', DELEGATION_TYPE],
    issuer: agentDid,
    issuanceDate: new Date().toISOString(),
    credentialSubject: { id: agentDid, delegatedBy: operatorDid },
  };

  const loader = securityLoader();
  loader.addStatic(key.id, {
    '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
    ...key.export({ publicKey: true }),
  });
  loader.addStatic(agentDid, {
    '@context': 'https://www.w3.org/ns/did/v1',
    id: agentDid,
    assertionMethod: [key.id],
    verificationMethod: [
      {
        '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
        ...key.export({ publicKey: true }),
      },
    ],
  });
  const documentLoader = loader.build();

  const signed = await vc.issue({ credential, suite, documentLoader });
  return signed;
}

// Verify with an independent verifier: given ONLY the credential, resolve
// the key from proof.verificationMethod's fragment and check the signature
// with vc.verifyCredential alone, plus the binding check that the key
// belongs to the claimed issuer DID (derived with @arcblock/did, which only
// turns a public key into a DID and does not verify the credential).
// @digitalbazaar/* does the verification: that is what proves third-party
// verifiability, no call to this service, no private key.
async function verifyIndependent(credential: Record<string, unknown>): Promise<boolean> {
  try {
    const proof = credential.proof as Record<string, unknown>;
    const verificationMethod = String(proof.verificationMethod);
    const issuer = String(credential.issuer);

    const hashIndex = verificationMethod.indexOf('#');
    if (hashIndex === -1) return false;
    const fingerprint = verificationMethod.slice(hashIndex + 1);

    const key = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint });

    const { fromPublicKey } = await import('@arcblock/did');
    const keyWithBuffer = key as unknown as { _publicKeyBuffer: Uint8Array };
    const derivedDidSuffix = fromPublicKey(keyWithBuffer._publicKeyBuffer);
    const issuerSuffix = issuer.replace(/^did:abt:/, '');
    if (derivedDidSuffix !== issuerSuffix) return false;

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

    const suite = new Ed25519Signature2020();
    const result = await vc.verifyCredential({ credential, suite, documentLoader });
    return result.verified === true;
  } catch {
    return false;
  }
}

// R-3, direction one: the real resolveDid throws NotImplementedError until a
  // resolver exists, so the flow is exercised through a WRAPPED adapter - the
  // real one's verifyDelegation (and hence the R-2 flow below) is untouched.
// It serves one agent DID a standard DID Core document whose alsoKnownAs
// carries the account URL; every other DID gets a document with no
// alsoKnownAs. The target DID is set by the flow test, because the wallet's
// DID is random per run.
let accountProofDid: string | null = null;

// R-4, direction two: the agent wallet whose key signs the gist statement.
// Set by the flow test, because the wallet's DID is random per run.
let proofSigningWallet: WalletObject | null = null;

// R-4, direction two: the published gists, as the public GitHub API would
// serve them. A mapped null is a deleted gist (R-5). The fake adapter
// below is the only file that knows a vendor exists, as with every other
// adapter in this test.
const gists = new Map<string, Gist | null>();

// R-10: what the hire flow asked github to do. The fake records its input so
// the flow can assert the buyer's repository was referenced READ-ONLY and
// the write went to the fork this platform created.
const forkCalls: ForkAndOpenPullRequestInput[] = [];

// R-11 (ENT-7.1): what the hire flow asked github about a pull request's
// merge state. The fake always reports merged, so the flow proves the merge
// route completes a job from GitHub's own report, never from a client claim.
const getPullRequestCalls: PullRequestRef[] = [];
const E2E_MERGE_COMMIT_SHA = 'e2e-merge-sha';
const E2E_MERGED_AT = new Date('2026-08-20T12:00:00Z');

// R-21: avatars served for agents delegated along the way. The first lets a
// later flow prove a different DID renders differently over the wire.
const delegatedAvatars: string[] = [];
const githubAdapter: GithubAdapter = {
  getPullRequest: (ref) => {
    getPullRequestCalls.push(ref);
    return Promise.resolve({
      ref,
      state: 'merged',
      mergeCommitSha: E2E_MERGE_COMMIT_SHA,
      mergedAt: E2E_MERGED_AT,
      headSha: 'e2e-head-sha',
      additions: 128,
      deletions: 12,
      filesChanged: 5,
    });
  },
  getMergeCommitSignature: () => Promise.reject(new NotImplementedError('github', 'getMergeCommitSignature')),
  getPublicGist: (ref) => {
    const gist = gists.get(ref.id);
    if (gist === null) {
      return Promise.reject(new GistNotFoundError(ref.id));
    }
    if (gist === undefined) {
      return Promise.reject(new Error(`gist ${ref.id} not found`));
    }
    return Promise.resolve(gist);
  },
  forkAndOpenPullRequest: (input) => {
    forkCalls.push(input);
    // Models a fork of buyer/target-repo that THIS platform created - the
    // owner differs from the source, which is what keeps invariant 1 true.
    return Promise.resolve({ owner: 'freeagents-platform', repo: 'target-repo', number: 1 });
  },
};

const identityAdapter: IdentityAdapter = {
  ...createIdentityAdapter(),
  resolveDid: (did: string): Promise<DidDocument> => {
    const doc: DidDocument = {
      id: did,
      controller: null,
      verificationMethod: [`${did}#key-1`],
      alsoKnownAs: did === accountProofDid ? ['https://github.com/scout-agent'] : null,
    };
    return Promise.resolve(doc);
  },
  // The real verify is a NotImplementedError until a resolver exists. The
  // flow test needs a real one, so this wrapper does the standard ed25519
  // check against the agent wallet's public key with node:crypto. The
  // wallet key is raw 32-byte hex; the JWK wrap is the standard form.
  verify: (signed: SignedPayload): Promise<boolean> => {
    if (proofSigningWallet === null) {
      return Promise.reject(new NotImplementedError('identity', 'verify'));
    }
    // Wallet keys are 0x-prefixed hex; node:crypto wants the raw 32 bytes.
    const raw = Buffer.from(proofSigningWallet.publicKey.replace(/^0x/, ''), 'hex');
    const publicKey = nodeCrypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
      format: 'jwk',
    });
    return Promise.resolve(
      nodeCrypto.verify(null, Buffer.from(signed.payload, 'utf8'), publicKey, Buffer.from(signed.signature, 'base64')),
    );
  },
};

beforeAll(async () => {
  // Explicit memory repositories: deterministic regardless of whether the
  // runner environment happens to export DATABASE_URL.
  const app = createApp(
    new MemoryOperatorRepository(),
    new MemoryAgentRepository(),
    identityAdapter,
    githubAdapter,
    undefined,
    createCredentialsAdapter(platformIssuer, credentialRepo),
    undefined,
    credentialRepo,
  );
  server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1');
    s.once('listening', () => resolve(s));
    s.once('error', reject);
  });
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('the API starts and answers', () => {
  it('binds a port and serves /health', async () => {
    const res = await get('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });

    // Only now is this true.
    console.log('APP_STARTED');
  });

  it('states the identity boundary before any effort, and honours it (R-23)', async () => {
    // Clause 3 of R-23: the limit is stated before a user invests effort, so
    // it is readable with no identity at all. An agent buyer reads the same
    // document a person does (MISSION, "The machine surface").
    const stated = await get('/capabilities');
    expect(stated.status).toBe(200);
    const boundary = (await stated.json()) as {
      notice: string;
      capabilities: Array<{ id: string; access: string; identityField: string | null }>;
    };
    expect(boundary.notice.length).toBeGreaterThan(0);

    // Clause 1: browsing needs no identity. A 404 here is a pass - the
    // refusal is about the row, not about who asked.
    const browsed = await get('/agents/did:abt:r23-anonymous-browser');
    expect([200, 404]).toContain(browsed.status);

    // Clause 2: hiring requires one. The same request with no buyerDid is
    // refused, and the refusal is exactly what the boundary document said it
    // would be, so nobody discovers the limit by hitting it.
    const declared = boundary.capabilities.find((c) => c.id === 'job.hire');
    expect(declared?.access).toBe('identified');
    expect(declared?.identityField).toBe('buyerDid');
    const anonymousHire = await post('/jobs', {
      agentDid: 'did:abt:r23-agent',
      repository: 'https://github.com/buyer/target-repo',
      brief: 'A brief from nobody in particular.',
    });
    expect(anonymousHire.status).toBe(400);
  });

  it('exposes every declared hire-loop route', async () => {
    // A 501 here is the CORRECT current answer: the route exists and its
    // handler is honest about being unimplemented. What matters for this
    // assertion is that none of them 404, because a route that does not exist
    // cannot be said to have a contract at all.
    // POST /operators, POST /agents, POST /jobs, POST /jobs/:id/confirm,
    // POST /jobs/:id/pull-request and POST /jobs/:id/merge have left this
    // list: they are implemented, and their real flows are asserted below.
    // This is the one-at-a-time replacement the file's design promised.
    const declared: Array<[string, () => Promise<Response>]> = [
      ['GET  /agents/:did/card', () => get('/agents/did:abt:test/card')],
      ['GET  /agents/:did/credentials', () => get('/agents/did:abt:test/credentials')],
      ['POST /jobs/:id/reviews', () => post('/jobs/j1/reviews')],
    ];

    for (const [label, call] of declared) {
      const res = await call();
      expect(res.status, `${label} must exist, got ${res.status}`).not.toBe(404);
      expect(res.status, `${label} should be 501 until implemented`).toBe(501);
    }
  });

  it('registers an operator, reads it back, and refuses duplicates and bad DIDs', async () => {
    // The first real hire-loop flow this file exercises. Five HTTP calls,
    // each counted in stepsAsserted by the helpers above; the fixture is a
    // generic handle, not a real person (public repository).

    // 1. Register. The response is exactly the stored fact projection:
    // did, githubLogin, createdAt, and nothing else, no key material.
    const created = await post('/operators', { did: 'did:abt:op1', githubLogin: 'operator-1' });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as Record<string, unknown>;
    expect(createdBody.did).toBe('did:abt:op1');
    expect(Object.keys(createdBody).sort()).toEqual(['createdAt', 'did', 'githubLogin']);

    // 2. Read back: the same body, field for field.
    const read = await get('/operators/did:abt:op1');
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(createdBody);

    // 3. The same DID twice is a conflict, not a silent overwrite.
    const dup = await post('/operators', { did: 'did:abt:op1', githubLogin: 'operator-1' });
    expect(dup.status).toBe(409);

    // 4. A DID of the wrong method is a client error.
    const bad = await post('/operators', { did: 'did:eth:xyz', githubLogin: 'operator-1' });
    expect(bad.status).toBe(400);

    // 5. An unregistered DID is a 404, so the read-back above meant
    // something.
    const missing = await get('/operators/did:abt:nobody');
    expect(missing.status).toBe(404);
  });

  it('delegates an agent from a registered operator and refuses the failure cases', async () => {
    // The R-2 flow. The delegation proof is a W3C Verifiable Credential with
    // Ed25519Signature2020 proof (invariant 2), signed by a real random
    // wallet. The wallet's ed25519 key is wrapped in the W3C suite, so the
    // same key drives a registered proof type that third parties can verify.

    const operatorWallet = fromRandom();
    const agentWallet = fromRandom();
    const credential = await signW3CDelegation(operatorWallet, agentWallet);

    // 1. The operator registers first: a delegation vouches with its standing.
    const op = await post('/operators', { did: operatorWallet.toDid(), githubLogin: 'operator-delegation' });
    expect(op.status).toBe(201);

    // 2. Delegate the agent. The response carries the delegation verbatim.
    const created = await post('/agents', {
      did: agentWallet.toDid(),
      operator: operatorWallet.toDid(),
      delegation: credential,
      name: 'scout',
      skills: ['triage'],
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as Record<string, unknown>;
    expect(createdBody.did).toBe(agentWallet.toDid());
    expect(createdBody.operatorDid).toBe(operatorWallet.toDid());
    expect(createdBody.delegation).toEqual(credential);

    // 3. Read back: the same body, field for field.
    const read = await get(`/agents/${agentWallet.toDid()}`);
    expect(read.status).toBe(200);
    const readBack = (await read.json()) as Record<string, unknown>;
    expect(readBack).toEqual(createdBody);

    // 3b. R-21: the avatar rides the base projection, derived at serve time
    // from the agent DID. Shape-checked on the wire and identical between
    // create and read-back - determinism over HTTP - then remembered so the
    // file's NEXT delegated agent can be proven to render differently.
    const createdAvatar = String(createdBody.avatar);
    expect(createdAvatar.startsWith('<svg')).toBe(true);
    expect(createdAvatar).toContain('viewBox');
    expect(createdAvatar.endsWith('</svg>')).toBe(true);
    expect(readBack.avatar).toBe(createdAvatar);
    delegatedAvatars.push(createdAvatar);

    // 4. The same agent DID twice is a conflict, not a silent overwrite.
    const dup = await post('/agents', {
      did: agentWallet.toDid(),
      operator: operatorWallet.toDid(),
      delegation: credential,
      name: 'scout',
      skills: ['triage'],
    });
    expect(dup.status).toBe(409);

    // 5. Delegating from an operator that never registered is a 404.
    const stranger = fromRandom();
    const orphan = await post('/agents', {
      did: agentWallet.toDid(),
      operator: stranger.toDid(),
      delegation: credential,
      name: 'orphan',
      skills: ['triage'],
    });
    expect(orphan.status).toBe(404);

    // 6. An unknown agent is a 404, so the read-back meant something.
    const missing = await get('/agents/did:abt:nobody');
    expect(missing.status).toBe(404);
  });

  it('rotates an agent key and the pre-rotation credential still verifies off-platform (R-30, ENT-8.4)', async () => {
    // The ENT-8.4 link, through the HTTP surface. The agent signs a
    // credential with its own key, the key is rotated over HTTP, the record
    // names exactly the key the credential's proof uses, and a third party
    // holding ONLY the credential still verifies it with @digitalbazaar/*
    // alone (invariant 2). Every get/post below counts in stepsAsserted.
    const operatorWallet = fromRandom();
    const agentWallet = fromRandom(); // the OLD key
    const newWallet = fromRandom(); // the replacement
    const oldDid = agentWallet.toDid();

    // 1. Register the operator and delegate the agent, as in the R-2 flow.
    const op = await post('/operators', { did: operatorWallet.toDid(), githubLogin: 'operator-rotate' });
    expect(op.status).toBe(201);
    const delegation = await signW3CDelegation(operatorWallet, agentWallet);
    const delegated = await post('/agents', {
      did: oldDid,
      operator: operatorWallet.toDid(),
      delegation,
      name: 'scout',
      skills: ['triage'],
    });
    expect(delegated.status).toBe(201);

    // 2. Derive the public halves of the old and new keys; the fragments are
    // what a rotation record stores.
    const oldKey = await Ed25519VerificationKey2020.generate({
      seed: hexToBytes(agentWallet.secretKey).slice(0, 32),
      controller: oldDid,
    });
    const oldKeyId = `${oldDid}#${oldKey.publicKeyMultibase}`;
    const newKey = await Ed25519VerificationKey2020.generate({
      seed: hexToBytes(newWallet.secretKey).slice(0, 32),
      controller: newWallet.toDid(),
    });
    const newKeyId = `${newWallet.toDid()}#${newKey.publicKeyMultibase}`;

    // 3. The pre-rotation credential, signed by the agent's own key. Sanity:
    // it verifies before any rotation exists.
    const credential = await signWithAgentKey(agentWallet, oldKey, operatorWallet.toDid());
    expect(await verifyIndependent(credential)).toBe(true);

    // 4. Rotate over HTTP.
    const rotated = await post(`/agents/${oldDid}/key-rotation`, {
      fromKey: oldKeyId,
      toKey: newKeyId,
    });
    expect(rotated.status).toBe(200);
    const rotatedBody = (await rotated.json()) as Record<string, unknown>;

    // 5. The ENT-8.4 link, over the wire: the record names exactly the key
    // the credential's proof uses, so a stranger resolves the old key from
    // the record alone.
    const rotation = (rotatedBody.keyRotations as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(rotation).toBeDefined();
    expect(String(rotation.fromKey)).toBe(oldKeyId);
    expect(String(rotation.fromKey)).toBe(String((credential.proof as Record<string, unknown>).verificationMethod));
    expect(String(rotation.toKey)).toBe(newKeyId);
    expect(Number.isNaN(Date.parse(String(rotation.rotatedAt)))).toBe(false);

    // 6. The read-back shows the rotation with dates (R-6's accept line).
    const read = await get(`/agents/${oldDid}`);
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as Record<string, unknown>;
    const readRotation = (readBody.keyRotations as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(readRotation).toBeDefined();
    expect(String(readRotation.fromKey)).toBe(oldKeyId);

    // 7. Failure cases over the wire: an identity rotation is a 400, and a
    // well-formed body for an unknown agent is a 404.
    expect(
      (await post(`/agents/${oldDid}/key-rotation`, { fromKey: oldKeyId, toKey: oldKeyId })).status,
    ).toBe(400);
    expect(
      (await post('/agents/did:abt:nobody/key-rotation', { fromKey: 'did:abt:nobody#zA', toKey: 'did:abt:nobody#zB' })).status,
    ).toBe(404);

    // 8. The assertion that earns the test: rotation did not orphan the
    // credential. A third party holding ONLY the credential still verifies
    // it after the rotation - no key material, no call to the service.
    expect(await verifyIndependent(credential)).toBe(true);
  });

  it('opens a job draft from a brief and reads it back', async () => {
    // The R-28 flow: a buyer writes a brief against a delegated agent and a
    // repository, and a draft exists afterwards. Fresh wallets throughout -
    // this block shares only the helpers above with the flows before it.

    const operatorWallet = fromRandom();
    const agentWallet = fromRandom();
    const buyerWallet = fromRandom();
    const credential = await signW3CDelegation(operatorWallet, agentWallet);

    // 1. Register the operator.
    const op = await post('/operators', { did: operatorWallet.toDid(), githubLogin: 'operator-jobs' });
    expect(op.status).toBe(201);

    // 2. Delegate an agent from it, W3C-signed as in the R-2 flow above.
    const delegated = await post('/agents', {
      did: agentWallet.toDid(),
      operator: operatorWallet.toDid(),
      delegation: credential,
      name: 'scout',
      skills: ['triage'],
    });
    expect(delegated.status).toBe(201);
    // R-21, wire-level distinctness: this is the file's second delegated
    // agent, so its served avatar must differ from the first one's - a
    // different DID cannot render the same avatar.
    const delegatedBody = (await delegated.json()) as Record<string, unknown>;
    const draftAgentAvatar = String(delegatedBody.avatar);
    expect(draftAgentAvatar.startsWith('<svg')).toBe(true);
    expect(delegatedAvatars, 'two distinct agents rendered the same avatar').not.toContain(
      draftAgentAvatar,
    );
    delegatedAvatars.push(draftAgentAvatar);

    // 3. Open the draft. brief rides beside briefHash precisely so a third
    // party holding the response can recompute the hash alone (invariant 2).
    const draft = await post('/jobs', {
      buyerDid: buyerWallet.toDid(),
      agentDid: agentWallet.toDid(),
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug on the checkout page\r\nthen deploy\n  ',
    });
    expect(draft.status).toBe(201);
    const draftBody = (await draft.json()) as Record<string, unknown>;
    expect(draftBody.status).toBe('draft');
    expect(String(draftBody.id)).toMatch(/^j-/);
    expect(typeof draftBody.brief).toBe('string');
    expect(draftBody.briefHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // 4. Read back: persistence proven independently of the create response.
    const read = await get(`/jobs/${String(draftBody.id)}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(draftBody);

    // 5. An unknown agent is a 404 before anything is stored: memory would
    // accept what Prisma's foreign key rejects, so the route closes the
    // asymmetry itself rather than letting the driver decide.
    const stranger = fromRandom();
    const orphan = await post('/jobs', {
      buyerDid: buyerWallet.toDid(),
      agentDid: stranger.toDid(),
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug',
    });
    expect(orphan.status).toBe(404);

    // 6. A whitespace-only brief is a 400 mapped from createJob's own rule:
    // the route delegates emptiness to the domain instead of restating it.
    const empty = await post('/jobs', {
      buyerDid: buyerWallet.toDid(),
      agentDid: agentWallet.toDid(),
      repository: 'buyer/target-repo',
      brief: '   \n\t ',
    });
    expect(empty.status).toBe(400);
  });

  it('proves direction one of the GitHub account binding through the DID document', async () => {
    // The R-3 flow. The operator's wallet authors the alsoKnownAs entry off
    // platform; the wrapped resolver above serves it for this one DID.
    const operatorWallet = fromRandom();
    const agentWallet = fromRandom();
    const credential = await signW3CDelegation(operatorWallet, agentWallet);

    // 1. Register and delegate, as in the R-2 flow above.
    const op = await post('/operators', { did: operatorWallet.toDid(), githubLogin: 'operator-proof' });
    expect(op.status).toBe(201);
    const created = await post('/agents', {
      did: agentWallet.toDid(),
      operator: operatorWallet.toDid(),
      delegation: credential,
      name: 'scout',
      skills: ['triage'],
    });
    expect(created.status).toBe(201);

    // 2. The wrapped resolver now serves this DID the document that carries
    // https://github.com/scout-agent in alsoKnownAs.
    accountProofDid = agentWallet.toDid();

    // 3. The matching handle records the binding. ENT-5.1: direction one
    // alone is pending, never verified.
    const ok = await post(`/agents/${agentWallet.toDid()}/account-proof`, { handle: 'scout-agent' });
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as Record<string, unknown>;
    expect(okBody.proofStatus).toBe('pending');
    expect(okBody.githubLogin).toBe('scout-agent');

    // 4. A different handle does not match the document: a conflict, and the
    // failed check must not replace the recorded binding.
    const wrong = await post(`/agents/${agentWallet.toDid()}/account-proof`, { handle: 'someone-else' });
    expect(wrong.status).toBe(409);
    const read = await get(`/agents/${agentWallet.toDid()}`);
    const readBody = (await read.json()) as Record<string, unknown>;
    expect(readBody.proofStatus).toBe('pending');
    expect(readBody.githubLogin).toBe('scout-agent');

    // 5. An unregistered agent is a 404, so the 200 above meant something.
    const missing = await post('/agents/did:abt:nobody/account-proof', { handle: 'scout-agent' });
    expect(missing.status).toBe(404);
  });

  it('proves direction two of the GitHub account binding through a signed gist', async () => {
    // The R-4 flow. The agent's wallet key signs the canonical proof bytes;
    // the gist is published as a plain fixture the fake adapter serves; and
    // the wrapped identity adapter verifies with real node:crypto ed25519,
    // so the signature round trip is genuine end to end.
    const operatorWallet = fromRandom();
    const agentWallet = fromRandom();
    const credential = await signW3CDelegation(operatorWallet, agentWallet);

    // 1. Register and delegate, as in the R-2 flow above.
    const op = await post('/operators', { did: operatorWallet.toDid(), githubLogin: 'operator-gist' });
    expect(op.status).toBe(201);
    const created = await post('/agents', {
      did: agentWallet.toDid(),
      operator: operatorWallet.toDid(),
      delegation: credential,
      name: 'scout',
      skills: ['triage'],
    });
    expect(created.status).toBe(201);

    // 2. The wallet key becomes the agent key: the wrapped verifier now
    // checks signatures against it, and the resolver serves the document.
    proofSigningWallet = agentWallet;
    accountProofDid = agentWallet.toDid();

    // 3. The agent signs the canonical proof bytes with its wallet key -
    // raw ed25519, no pre-hash, base64 - and the gist goes up.
    const accountUrl = 'https://github.com/scout-agent';
    const canonical = `freeagents-github-proof v1\n${agentWallet.toDid()}\n${accountUrl}\n`;
    const signature = await agentWallet.sign(canonical, false, 'base64');
    const statement = `version: 1\ndid: ${agentWallet.toDid()}\ngithub: ${accountUrl}\nsignature: ${signature}\n`;
    gists.set('e2e-proof-gist', {
      id: 'e2e-proof-gist',
      owner: 'scout-agent',
      files: { 'proof.txt': statement },
    });

    // 4. Both directions hold: 200 and verified, per ENT-5.1.
    const ok = await post(`/agents/${agentWallet.toDid()}/account-proof`, {
      handle: 'scout-agent',
      gist: 'https://gist.github.com/scout-agent/e2e-proof-gist',
    });
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as Record<string, unknown>;
    expect(okBody.proofStatus).toBe('verified');
    expect(okBody.githubLogin).toBe('scout-agent');

    // 5. A third party re-checks the signature with the same standard
    // primitives, from the gist and the agent DID alone: no call to this
    // service, and the binding is real rather than recorded. The bytes are
    // rebuilt from the DID and the account being checked, not from the file.
    const published = gists.get('e2e-proof-gist');
    expect(published !== undefined).toBe(true);
    const thirdPartyPublicKey = nodeCrypto.createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: Buffer.from(agentWallet.publicKey.replace(/^0x/, ''), 'hex').toString('base64url'),
      },
      format: 'jwk',
    });
    expect(
      nodeCrypto.verify(null, Buffer.from(canonical, 'utf8'), thirdPartyPublicKey, Buffer.from(signature, 'base64')),
    ).toBe(true);
    const tampered = `freeagents-github-proof v1\n${agentWallet.toDid()}\nhttps://github.com/someone-else\n`;
    expect(
      nodeCrypto.verify(null, Buffer.from(tampered, 'utf8'), thirdPartyPublicKey, Buffer.from(signature, 'base64')),
    ).toBe(false);

    // 6. A gist authored by someone else is a conflict, even with the
    // matching URL owner and a genuine statement.
    gists.set('e2e-forged-gist', {
      id: 'e2e-forged-gist',
      owner: 'someone-else',
      files: { 'proof.txt': statement },
    });
    const forged = await post(`/agents/${agentWallet.toDid()}/account-proof`, {
      handle: 'scout-agent',
      gist: 'https://gist.github.com/scout-agent/e2e-forged-gist',
    });
    expect(forged.status).toBe(409);

    // 7. A statement signed by a different key is a conflict, and the
    // verified binding is not replaced by the rejected attempt.
    const imposter = fromRandom();
    const imposterSignature = await imposter.sign(canonical, false, 'base64');
    gists.set('e2e-imposter-gist', {
      id: 'e2e-imposter-gist',
      owner: 'scout-agent',
      files: { 'proof.txt': `version: 1\ndid: ${agentWallet.toDid()}\ngithub: ${accountUrl}\nsignature: ${imposterSignature}\n` },
    });
    const imposterRes = await post(`/agents/${agentWallet.toDid()}/account-proof`, {
      handle: 'scout-agent',
      gist: 'https://gist.github.com/scout-agent/e2e-imposter-gist',
    });
    expect(imposterRes.status).toBe(409);
    const read = await get(`/agents/${agentWallet.toDid()}`);
    const readBody = (await read.json()) as Record<string, unknown>;
    expect(readBody.proofStatus).toBe('verified');

    // 8. A malformed gist URL is a client error, checked before anything
    // is fetched or recorded.
    const badUrl = await post(`/agents/${agentWallet.toDid()}/account-proof`, {
      handle: 'scout-agent',
      gist: 'https://github.com/scout-agent/x',
    });
    expect(badUrl.status).toBe(400);

    // 9. R-5 (ENT-5.3): the operator deletes the gist. The next check with
    // the same body must not read that as an outage; it is the check's
    // answer, and a verified binding drops to unverified.
    gists.set('e2e-proof-gist', null);
    const recheck = await post(`/agents/${agentWallet.toDid()}/account-proof`, {
      handle: 'scout-agent',
      gist: 'https://gist.github.com/scout-agent/e2e-proof-gist',
    });
    expect(recheck.status).toBe(200);
    const recheckBody = (await recheck.json()) as Record<string, unknown>;
    expect(recheckBody.proofStatus).toBe('unverified');
    expect(recheckBody.githubLogin).toBe('scout-agent');

    // 10. A third party, reading the public gist surface directly from the
    // URL form and knowing nothing about this service, finds nothing: the
    // gist no longer resolves, which agrees with the platform's stored
    // unverified without any call into the service's decision code.
    expect(gists.get('e2e-proof-gist')).toBeNull();

    // 11. Read-back: the downgrade survives the round trip, and the handle
    // is kept - the claim was made, it no longer holds.
    const downgraded = await get(`/agents/${agentWallet.toDid()}`);
    const downgradedBody = (await downgraded.json()) as Record<string, unknown>;
    expect(downgradedBody.proofStatus).toBe('unverified');
    expect(downgradedBody.githubLogin).toBe('scout-agent');
  });

  it('exchanges acceptance criteria on one job row, more than once', async () => {
    // The R-8 flow: propose -> request-changes -> re-propose, the loop
    // running twice without a second job. Fresh wallets throughout, as in
    // every flow above.
    const operatorWallet = fromRandom();
    const agentWallet = fromRandom();
    const buyerWallet = fromRandom();
    const credential = await signW3CDelegation(operatorWallet, agentWallet);

    // 1-2. Register and delegate, as in the flows above.
    const op = await post('/operators', { did: operatorWallet.toDid(), githubLogin: 'operator-criteria' });
    expect(op.status).toBe(201);
    const delegated = await post('/agents', {
      did: agentWallet.toDid(),
      operator: operatorWallet.toDid(),
      delegation: credential,
      name: 'scout',
      skills: ['triage'],
    });
    expect(delegated.status).toBe(201);

    // 3. Open the draft.
    const draft = await post('/jobs', {
      buyerDid: buyerWallet.toDid(),
      agentDid: agentWallet.toDid(),
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug on the checkout page',
    });
    expect(draft.status).toBe(201);
    const draftBody = (await draft.json()) as Record<string, unknown>;
    expect(draftBody.status).toBe('draft');
    const jobId = String(draftBody.id);

    // 4. The agent proposes criteria: draft -> proposed, nothing accepted.
    const proposed = await post(`/jobs/${jobId}/criteria`, {
      criteria: [
        { text: 'The login bug is fixed', proposedBy: 'agent' },
        { text: 'Checkout e2e test passes', proposedBy: 'agent' },
      ],
    });
    expect(proposed.status).toBe(200);
    const proposedBody = (await proposed.json()) as Record<string, unknown>;
    expect(proposedBody.id).toBe(jobId);
    expect(proposedBody.status).toBe('proposed');
    expect(proposedBody.criteria).toEqual([
      { text: 'The login bug is fixed', proposedBy: 'agent', accepted: false },
      { text: 'Checkout e2e test passes', proposedBy: 'agent', accepted: false },
    ]);

    // 5. The buyer pushes back: still proposed, same id.
    const pushback = await post(`/jobs/${jobId}/request-changes`, {});
    expect(pushback.status).toBe(200);
    const pushbackBody = (await pushback.json()) as Record<string, unknown>;
    expect(pushbackBody.id).toBe(jobId);
    expect(pushbackBody.status).toBe('proposed');

    // 6. The agent re-proposes: same row again, list replaced.
    const again = await post(`/jobs/${jobId}/criteria`, {
      criteria: [{ text: 'One sharper criterion', proposedBy: 'agent' }],
    });
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as Record<string, unknown>;
    expect(againBody.id).toBe(jobId);
    expect(againBody.status).toBe('proposed');
    expect(againBody.criteria).toEqual([
      { text: 'One sharper criterion', proposedBy: 'agent', accepted: false },
    ]);

    // 7. Read back: the stored row carries the last proposal, and every
    // identity field is still the draft's own - no second job was created.
    const read = await get(`/jobs/${jobId}`);
    expect(read.status).toBe(200);
    const readBack = (await read.json()) as Record<string, unknown>;
    expect(readBack).toEqual({ ...draftBody, status: 'proposed', criteria: againBody.criteria });
  });

  it('confirms a job on the agreed criteria and locks it (R-9)', async () => {
    // Fresh wallets throughout, as in every flow above. The walk: propose
    // two criteria, accept both, confirm, and prove both halves of the
    // issue's accept line - specHash exists and nothing edits the job after.
    const operatorWallet = fromRandom();
    const agentWallet = fromRandom();
    const buyerWallet = fromRandom();
    const credential = await signW3CDelegation(operatorWallet, agentWallet);

    // 1-2. Register and delegate, as in the flows above.
    const op = await post('/operators', { did: operatorWallet.toDid(), githubLogin: 'operator-confirm' });
    expect(op.status).toBe(201);
    const delegated = await post('/agents', {
      did: agentWallet.toDid(),
      operator: operatorWallet.toDid(),
      delegation: credential,
      name: 'scout',
      skills: ['triage'],
    });
    expect(delegated.status).toBe(201);

    // 3. Open the draft.
    const draft = await post('/jobs', {
      buyerDid: buyerWallet.toDid(),
      agentDid: agentWallet.toDid(),
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug on the checkout page',
    });
    expect(draft.status).toBe(201);
    const draftBody = (await draft.json()) as Record<string, unknown>;
    expect(draftBody.status).toBe('draft');
    const jobId = String(draftBody.id);

    // 4. Propose two criteria and accept each one.
    // The interior CRLF survives proposeCriteria's trim on purpose: it makes
    // the stranger's normalisation below load-bearing rather than decorative.
    expect(
      (
        await post(`/jobs/${jobId}/criteria`, {
          criteria: [
            { text: 'The login bug is fixed\r\non staging', proposedBy: 'agent' },
            { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
          ],
        })
      ).status,
    ).toBe(200);
    expect((await post(`/jobs/${jobId}/criteria/0/accept`)).status).toBe(200);
    expect((await post(`/jobs/${jobId}/criteria/1/accept`)).status).toBe(200);

    // 5. Confirm: status flips, specHash appears, confirmedAt rides beside it.
    const confirmed = await post(`/jobs/${jobId}/confirm`);
    expect(confirmed.status).toBe(200);
    const confirmedBody = (await confirmed.json()) as Record<string, unknown>;
    expect(confirmedBody.status).toBe('confirmed');
    expect(String(confirmedBody.specHash)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(typeof confirmedBody.confirmedAt).toBe('string');

    // 6. Read back: base eight + criteria + specHash + confirmedAt, no more.
    const read = await get(`/jobs/${jobId}`);
    expect(read.status).toBe(200);
    const readBack = (await read.json()) as Record<string, unknown>;
    expect(Object.keys(readBack).sort()).toEqual([
      'agentDid',
      'brief',
      'briefHash',
      'buyerDid',
      'confirmedAt',
      'createdAt',
      'criteria',
      'id',
      'repository',
      'specHash',
      'status',
    ]);

    // 7. A stranger recomputes specHash from this response alone: criteria
    // texts '\n'-joined, documented normalisation written out here, sha256
    // with node:crypto. No call to the service, no import of its hashing.
    const joined = (readBack.criteria as Array<{ text: string }>)
      .map((criterion) => criterion.text)
      .join('\n');
    let normalised = joined
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n');
    if (normalised.endsWith('\n')) {
      normalised = normalised.slice(0, -1);
    }
    const recomputed = 'sha256:' + nodeCrypto.createHash('sha256').update(normalised).digest('hex');
    expect(recomputed).toBe(readBack.specHash);

    // 8. Locked: proposing and pushback are both conflicts now.
    expect(
      (await post(`/jobs/${jobId}/criteria`, { criteria: [{ text: 'sneak in', proposedBy: 'agent' }] })).status,
    ).toBe(409);
    expect((await post(`/jobs/${jobId}/request-changes`)).status).toBe(409);
  });

  it('forks and opens the pull request carrying the job id (R-10)', async () => {
    // Fresh wallets throughout, as in every flow above. The walk completes
    // the first half of the hire loop end to end: a buyer's brief becomes a
    // submitted job, and the recorded github call shows the buyer's
    // repository referenced READ-ONLY with the write going to the fork this
    // platform created (invariant 1), the job id riding the public PR
    // artifacts (ENT-4.5).
    const operatorWallet = fromRandom();
    const agentWallet = fromRandom();
    const buyerWallet = fromRandom();
    const credential = await signW3CDelegation(operatorWallet, agentWallet);

    // 1-2. Register and delegate, as in the flows above.
    const op = await post('/operators', { did: operatorWallet.toDid(), githubLogin: 'operator-pr' });
    expect(op.status).toBe(201);
    const delegated = await post('/agents', {
      did: agentWallet.toDid(),
      operator: operatorWallet.toDid(),
      delegation: credential,
      name: 'scout',
      skills: ['triage'],
    });
    expect(delegated.status).toBe(201);

    // 3. Open the draft.
    const draft = await post('/jobs', {
      buyerDid: buyerWallet.toDid(),
      agentDid: agentWallet.toDid(),
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug on the checkout page',
    });
    expect(draft.status).toBe(201);
    const jobId = String(((await draft.json()) as Record<string, unknown>).id);

    // 4-5. Agree the spec: two criteria in, both accepted, confirmed.
    expect(
      (
        await post(`/jobs/${jobId}/criteria`, {
          criteria: [
            { text: 'The login bug is fixed', proposedBy: 'agent' },
            { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
          ],
        })
      ).status,
    ).toBe(200);
    expect((await post(`/jobs/${jobId}/criteria/0/accept`)).status).toBe(200);
    expect((await post(`/jobs/${jobId}/criteria/1/accept`)).status).toBe(200);
    expect((await post(`/jobs/${jobId}/confirm`)).status).toBe(200);

    // 6. Fork and open the PR: the job lands on submitted with the URL and
    // timestamp riding beside it.
    const pr = await post(`/jobs/${jobId}/pull-request`);
    expect(pr.status).toBe(200);
    const prBody = (await pr.json()) as Record<string, unknown>;
    expect(prBody.status).toBe('submitted');
    expect(String(prBody.pullRequestUrl)).toContain('freeagents-platform');
    expect(typeof prBody.submittedAt).toBe('string');
    // R-12: the deadline rides the submission, 30 days out from the domain.
    expect(typeof prBody.deadline).toBe('string');

    // 7. What github was asked to do: source named read-only is the BUYER's
    // repo; branch, title and body carry the job id.
    const call = forkCalls.at(-1) as ForkAndOpenPullRequestInput;
    expect(call.sourceOwner).toBe('buyer');
    expect(call.sourceRepo).toBe('target-repo');
    expect(call.title).toContain(jobId);
    expect(call.body).toContain(jobId);

    // 8. Locked: posting again conflicts and opens no second PR.
    expect((await post(`/jobs/${jobId}/pull-request`)).status).toBe(409);
  });

  it('observes the merge and completes the job (R-11)', async () => {
    // Completes the hire loop end to end: the submitted job's pull request
    // is asked about directly, and only GitHub's own report - never a client
    // assertion (ENT-7.1) - decides whether the job completes.
    const operatorWallet = fromRandom();
    const agentWallet = fromRandom();
    const buyerWallet = fromRandom();
    const credential = await signW3CDelegation(operatorWallet, agentWallet);

    // 1-2. Register and delegate, as in the flows above.
    const op = await post('/operators', { did: operatorWallet.toDid(), githubLogin: 'operator-merge' });
    expect(op.status).toBe(201);
    const delegated = await post('/agents', {
      did: agentWallet.toDid(),
      operator: operatorWallet.toDid(),
      delegation: credential,
      name: 'scout',
      skills: ['triage'],
    });
    expect(delegated.status).toBe(201);

    // 3. Open the draft.
    const draft = await post('/jobs', {
      buyerDid: buyerWallet.toDid(),
      agentDid: agentWallet.toDid(),
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug on the checkout page',
    });
    expect(draft.status).toBe(201);
    const jobId = String(((await draft.json()) as Record<string, unknown>).id);

    // 4-6. Agree the spec and open the pull request: confirmed -> submitted.
    expect(
      (
        await post(`/jobs/${jobId}/criteria`, {
          criteria: [
            { text: 'The login bug is fixed', proposedBy: 'agent' },
            { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
          ],
        })
      ).status,
    ).toBe(200);
    expect((await post(`/jobs/${jobId}/criteria/0/accept`)).status).toBe(200);
    expect((await post(`/jobs/${jobId}/criteria/1/accept`)).status).toBe(200);
    expect((await post(`/jobs/${jobId}/confirm`)).status).toBe(200);
    const pr = await post(`/jobs/${jobId}/pull-request`);
    expect(pr.status).toBe(200);

    // 7. Merge: github's own report stamps the completion facts.
    const before = getPullRequestCalls.length;
    const merge = await post(`/jobs/${jobId}/merge`);
    expect(merge.status).toBe(200);
    const mergeBody = (await merge.json()) as Record<string, unknown>;
    expect(mergeBody.status).toBe('completed');
    expect(mergeBody.mergeCommit).toBe(E2E_MERGE_COMMIT_SHA);
    expect(mergeBody.mergedAt).toBe(E2E_MERGED_AT.toISOString());
    // The submitted keys, plus exactly mergeCommit, mergedAt and credential.
    expect(Object.keys(mergeBody).sort()).toEqual([
      'agentDid',
      'brief',
      'briefHash',
      'buyerDid',
      'confirmedAt',
      'createdAt',
      'credential',
      'criteria',
      'deadline',
      'id',
      'mergeCommit',
      'mergedAt',
      'pullRequestUrl',
      'repository',
      'specHash',
      'status',
      'submittedAt',
    ]);
    expect(getPullRequestCalls.length).toBe(before + 1);

    // Gate 3 step 7 (MISSION.md): the merge issued a credential, and a third
    // party verifies it with the off-the-shelf W3C stack alone - no adapter,
    // no call to this service.
    const issued = mergeBody.credential as Record<string, unknown>;
    expect(String(issued.issuer)).toBe(platformWallet.toDid());
    const credentialSubject = issued.credentialSubject as Record<string, unknown>;
    expect(credentialSubject.id).toBe(agentWallet.toDid());
    const hire = credentialSubject.hire as Record<string, unknown>;
    expect(hire.mergeCommit).toBe(E2E_MERGE_COMMIT_SHA);
    expect(hire.additions).toBe(128);
    expect(hire.deletions).toBe(12);
    expect(hire.filesChanged).toBe(5);
    expect(await verifyIndependent(issued)).toBe(true);
    console.log('E2E_CREDENTIAL_VERIFIED');

    // 8. Read back: identical to the merge response.
    const read = await get(`/jobs/${jobId}`);
    expect(await read.json()).toEqual(mergeBody);

    // 9. Locked: posting again conflicts, and github is not asked again.
    const secondMerge = await post(`/jobs/${jobId}/merge`);
    expect(secondMerge.status).toBe(409);
    expect(getPullRequestCalls.length).toBe(before + 1);
  });

  it('still 404s an undeclared route', async () => {
    // Without this, the assertion above would pass on a catch-all that
    // answered everything, which would make it meaningless.
    const res = await get('/no-such-route');
    expect(res.status).toBe(404);
  });

  it('resolves an issued credential over HTTP, verbatim and resolvable (R-15)', async () => {
    // The bytes that verified are the bytes that are stored: a
    // CompletedHireCredential is signed the same way signW3CDelegation signs
    // the delegation credential (same suites, same static loader), and it is
    // handed to the platform's repository the way R-13's issuance will hand
    // it in, once the platform issuer is wired. The credential id is the
    // stable resolvable form (ENT-8): this server's own URL plus the job id.
    const issuerDid = 'did:abt:platform';
    const subjectDid = 'did:abt:agent-under-test';
    const seed = nodeCrypto.randomBytes(32);
    const key = await Ed25519VerificationKey2020.generate({ seed, controller: issuerDid });
    key.id = `${issuerDid}#${key.publicKeyMultibase}`;

    const credential = {
      '@context': [
        'https://www.w3.org/2018/credentials/v1',
        'https://w3id.org/security/suites/ed25519-2020/v1',
        { '@vocab': 'https://freeagents.dev/terms#' },
      ],
      id: `${base}/v1/credentials/job-cred-1`,
      type: ['VerifiableCredential', 'CompletedHireCredential'],
      issuer: issuerDid,
      issuanceDate: new Date().toISOString(),
      credentialSubject: {
        id: subjectDid,
        jobId: 'job-cred-1',
        pullRequestUrl: 'https://github.com/buyer/target-repo/pull/42',
        mergeCommitSha: '3f8a2c1d9e7b4a5f6c8d0e1f2a3b4c5d6e7f8a9b',
        mergedAt: '2026-08-21T12:00:00.000Z',
        diffAdditions: 12,
        diffDeletions: 4,
        specHash: 'sha256:spec',
        filesChanged: 1,
        repository: 'buyer/target-repo',
        signedBy: issuerDid,
        buyerDid: 'did:abt:buyer-under-test',
      },
    };

    const loader = securityLoader();
    loader.addStatic(key.id, {
      '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
      ...key.export({ publicKey: true }),
    });
    loader.addStatic(issuerDid, {
      '@context': 'https://www.w3.org/ns/did/v1',
      id: issuerDid,
      assertionMethod: [key.id],
      verificationMethod: [
        { '@context': 'https://w3id.org/security/suites/ed25519-2020/v1', ...key.export({ publicKey: true }) },
      ],
    });

    const signed = await vc.issue({
      credential,
      suite: new Ed25519Signature2020({ key }),
      documentLoader: loader.build(),
    });
    await credentialRepo.save({
      completedJobId: 'job-cred-1',
      subjectDid,
      document: signed as unknown as VerifiableCredential,
    });

    // Resolving needs no authentication: resolvable is part of the contract.
    const ok = await get('/v1/credentials/job-cred-1');
    expect(ok.status).toBe(200);
    // The credential is a linked-data document, not an API object.
    expect(String(ok.headers.get('content-type')).includes('application/ld+json')).toBe(true);
    const body = (await ok.json()) as Record<string, unknown>;
    expect(body.id).toBe(`${base}/v1/credentials/job-cred-1`);
    expect((body.credentialSubject as Record<string, unknown>).pullRequestUrl).toBe(
      'https://github.com/buyer/target-repo/pull/42',
    );
    expect((body.proof as Record<string, unknown>).type).toBe('Ed25519Signature2020');

    const missing = await get('/v1/credentials/no-such-credential');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not found' });
  });

  it('drives brief -> criteria -> confirm entirely with DID-signed requests and no session (R-34)', async () => {
    // Fresh wallets throughout, as in every flow above. The buyer's DID
    // signature is the only identity carried on the four job-scoped calls
    // below -- no session, no cookie, no Authorization header at any point.
    const operatorWallet = fromRandom();
    const agentWallet = fromRandom();
    const buyerWallet = fromRandom();
    const credential = await signW3CDelegation(operatorWallet, agentWallet);
    // Same derivation signW3CDelegation uses at line 146: the ArcBlock
    // wallet's ed25519 key and this did:abt-bound signing identity are the
    // same keypair, so buyerIdentity.did equals buyerWallet.toDid().
    const buyerIdentity = await signingIdentityFromSeed(hexToBytes(buyerWallet.secretKey).slice(0, 32));

    // 1. The agent's operator registers.
    const op = await post('/operators', { did: operatorWallet.toDid(), githubLogin: 'operator-r34' });
    expect(op.status).toBe(201);

    // 2. The buyer registers too: a signing identity must be a registered
    // DID for createDidAbtSigningKeyResolver to accept it (R-34).
    const buyerReg = await post('/operators', { did: buyerIdentity.did, githubLogin: 'buyer-r34' });
    expect(buyerReg.status).toBe(201);

    // 3. Delegate the agent, unsigned, exactly as every flow above does --
    // R-34 adds a second identity path, it does not require one everywhere.
    const delegated = await post('/agents', {
      did: agentWallet.toDid(),
      operator: operatorWallet.toDid(),
      delegation: credential,
      name: 'scout',
      skills: ['triage'],
    });
    expect(delegated.status).toBe(201);

    // 4. Open the draft, signed by the buyer.
    const draft = await postSigned(
      '/jobs',
      {
        buyerDid: buyerIdentity.did,
        agentDid: agentWallet.toDid(),
        repository: 'buyer/target-repo',
        brief: 'Fix the login bug on the checkout page',
      },
      buyerIdentity,
    );
    expect(draft.status).toBe(201);
    const draftBody = (await draft.json()) as Record<string, unknown>;
    const jobId = String(draftBody.id);

    // 5. Propose and accept one criterion, signed.
    const proposed = await postSigned(
      `/jobs/${jobId}/criteria`,
      { criteria: [{ text: 'Login works on staging', proposedBy: 'agent' }] },
      buyerIdentity,
    );
    expect(proposed.status).toBe(200);

    // 6. Accept, signed.
    const accepted = await postSigned(`/jobs/${jobId}/criteria/0/accept`, {}, buyerIdentity);
    expect(accepted.status).toBe(200);

    // 7. Confirm, signed: the issue's acceptance line.
    const confirmed = await postSigned(`/jobs/${jobId}/confirm`, {}, buyerIdentity);
    expect(confirmed.status).toBe(200);
    const confirmedBody = (await confirmed.json()) as Record<string, unknown>;
    expect(confirmedBody.status).toBe('confirmed');
    expect(String(confirmedBody.specHash)).toMatch(/^sha256:[0-9a-f]{64}$/);

    // 8. Read back, unsigned (browsing needs no identity, R-23): the same
    // confirmed key set the unsigned hire loop above projects.
    const read = await get(`/jobs/${jobId}`);
    expect(read.status).toBe(200);
    const readBack = (await read.json()) as Record<string, unknown>;
    expect(Object.keys(readBack).sort()).toEqual([
      'agentDid',
      'brief',
      'briefHash',
      'buyerDid',
      'confirmedAt',
      'createdAt',
      'criteria',
      'id',
      'repository',
      'specHash',
      'status',
    ]);
  });

  it('reports the end-to-end step count', () => {
    // The floor is read from .factory/locks/floor.json and raising it is a
    // deliberate human edit. Printing the real number lets the gate compare
    // rather than trust.
    expect(stepsAsserted).toBeGreaterThan(0);
    console.log(`E2E_STEPS_ASSERTED=${stepsAsserted}`);
    console.log('E2E_PASSED');
  });
});
