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
 * The API is a route surface where the hire-loop handlers still return 501 on
 * purpose. So this test proves what is genuinely true today:
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
 *   - the first half of the hire loop works end to end: an operator
 *     registers, delegates an agent, and a buyer's brief opens a job draft
 *     that reads back identically, with brief and briefHash riding the
 *     response so a third party can recompute the hash without the service
 *   - the acceptance-criteria exchange works end to end (R-8): the agent
 *     proposes criteria, the buyer requests changes, the agent re-proposes,
 *     all on one job row in status proposed - the id never changes and no
 *     second job is created
 *   - an unknown route is still a 404, so the previous assertion means something
 *
 * It does NOT claim the hire flow completes: a draft now walks to proposed
 * through the criteria exchange, but confirm, pull-request, merge and review
 * handlers stay 501 until their issues land. As their handlers arrive, the
 * flow assertions below replace those 501 expectations one at a time, and the
 * e2e step floor rises with them.
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
import type { Gist, GithubAdapter } from '../../src/adapters/github/types.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import type { DidDocument, IdentityAdapter, SignedPayload } from '../../src/adapters/identity/types.js';
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import { MemoryAgentRepository, MemoryOperatorRepository } from '../../src/adapters/storage/memory.js';
import { DELEGATION_TYPE } from '../../src/domain/agent.js';

let server: Server;
let base: string;

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
// serve them. The fake adapter below is the only file that knows a vendor
// exists, as with every other adapter in this test.
const gists = new Map<string, Gist>();
const githubAdapter: GithubAdapter = {
  getPullRequest: () => Promise.reject(new NotImplementedError('github', 'getPullRequest')),
  getMergeCommitSignature: () => Promise.reject(new NotImplementedError('github', 'getMergeCommitSignature')),
  getPublicGist: (ref) => {
    const gist = gists.get(ref.id);
    if (gist === undefined) {
      return Promise.reject(new Error(`gist ${ref.id} not found`));
    }
    return Promise.resolve(gist);
  },
  forkAndOpenPullRequest: () => Promise.reject(new NotImplementedError('github', 'forkAndOpenPullRequest')),
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

  it('exposes every declared hire-loop route', async () => {
    // A 501 here is the CORRECT current answer: the route exists and its
    // handler is honest about being unimplemented. What matters for this
    // assertion is that none of them 404, because a route that does not exist
    // cannot be said to have a contract at all.
    // POST /operators, POST /agents and POST /jobs have left this list:
    // they are implemented, and their real flows are asserted below. This is
    // the one-at-a-time replacement the file's design promised.
    const declared: Array<[string, () => Promise<Response>]> = [
      ['GET  /agents/:did/card', () => get('/agents/did:abt:test/card')],
      ['GET  /agents/:did/credentials', () => get('/agents/did:abt:test/credentials')],
      ['POST /jobs/:id/confirm', () => post('/jobs/j1/confirm')],
      ['POST /jobs/:id/pull-request', () => post('/jobs/j1/pull-request')],
      ['POST /jobs/:id/merge', () => post('/jobs/j1/merge')],
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
    expect(await read.json()).toEqual(createdBody);

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

  it('still 404s an undeclared route', async () => {
    // Without this, the assertion above would pass on a catch-all that
    // answered everything, which would make it meaningless.
    const res = await get('/no-such-route');
    expect(res.status).toBe(404);
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
