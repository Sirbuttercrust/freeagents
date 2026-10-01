// FIX-B58 (B58): GET /agents/:agentDid/card serves the agent's
// work-history extension block, the object an owner pastes into the agent's
// own A2A card under `capabilities.extensions`. The route answered 501 since
// it was declared. FreeAgents serves the
// extension block only, because a whole card would need an A2A address no
// agent has given us.
//
// Every test that reads the block asserts the whole body with toEqual, so a
// key added, dropped or renamed fails here.
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import * as vc from '@digitalbazaar/vc';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import { fromRandom, type WalletObject } from '@ocap/wallet';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import { MemoryAgentRepository, MemoryAccountRepository, MemoryCredentialRepository } from '../../src/adapters/storage/memory.js';
import type { AgentRepository, CredentialRepository } from '../../src/adapters/storage/types.js';
import type { CredentialsAdapter, VerifiableCredential, DeemedCompletionCredential } from '../../src/adapters/credentials/types.js';
import { DELEGATION_TYPE, type Agent, type Delegation } from '../../src/domain/agent.js';

const EXTENSION_URI = 'https://freeagents.dev/ext/work-history/v1';
const EXTENSION_DESCRIPTION = 'Verifiable identity and completed-work history';

function listen(app: Express): Promise<Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
}

function portOf(server: Server): number {
  return (server.address() as AddressInfo).port;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// The digest, computed here from the spec's sentence and nothing else: the
// credential ids sorted, joined with a line feed, hashed, lowercase hex.
function digestOf(ids: readonly string[]): string {
  return `sha256-${sha256Hex([...ids].sort().join('\n'))}`;
}

function hexToBytes(h: string): Uint8Array {
  return Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
}

// A delegation signed with a real wallet key, the way
// tests/api/agent-invariant2.test.ts signs one.
async function signW3CDelegation(operator: WalletObject, agent: WalletObject): Promise<Delegation> {
  const operatorDid = operator.toDid();
  const seed = hexToBytes(operator.secretKey).slice(0, 32);
  const key = await Ed25519VerificationKey2020.generate({ seed, controller: operatorDid });
  key.id = `${operatorDid}#${key.publicKeyMultibase}`;
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
    credentialSubject: { id: agent.toDid(), delegatedBy: operatorDid },
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
    verificationMethod: [{ '@context': 'https://w3id.org/security/suites/ed25519-2020/v1', ...key.export({ publicKey: true }) }],
  });
  const signed = await vc.issue({ credential, suite: new Ed25519Signature2020({ key }), documentLoader: loader.build() });
  return signed as unknown as Delegation;
}

// What a stranger holding only the delegation does: rebuild the key from the
// proof's fingerprint, bind it to the claimed issuer DID, verify with the
// off-the-shelf W3C stack. No call to this service, no @arcblock/vc.
async function verifyIndependent(credential: Record<string, unknown>): Promise<boolean> {
  try {
    const proof = credential.proof as Record<string, unknown>;
    const verificationMethod = String(proof.verificationMethod);
    const issuer = String(credential.issuer);
    const hashIndex = verificationMethod.indexOf('#');
    if (hashIndex === -1) return false;
    const key = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint: verificationMethod.slice(hashIndex + 1) });
    const { fromPublicKey } = await import('@arcblock/did');
    const raw = (key as unknown as { _publicKeyBuffer: Uint8Array })._publicKeyBuffer;
    if (fromPublicKey(raw) !== issuer.replace(/^did:abt:/, '')) return false;
    key.controller = issuer;
    key.id = verificationMethod;
    const loader = securityLoader();
    loader.addStatic(key.id, { '@context': 'https://w3id.org/security/suites/ed25519-2020/v1', ...key.export({ publicKey: true }) });
    loader.addStatic(issuer, {
      '@context': 'https://www.w3.org/ns/did/v1',
      id: issuer,
      assertionMethod: [key.id],
      verificationMethod: [{ '@context': 'https://w3id.org/security/suites/ed25519-2020/v1', ...key.export({ publicKey: true }) }],
    });
    const result = await vc.verifyCredential({ credential, suite: new Ed25519Signature2020(), documentLoader: loader.build() });
    return result.verified === true;
  } catch {
    return false;
  }
}

function hireCredential(subjectDid: string, jobId: string, mergedAt: string): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id: `urn:uuid:hire-${jobId}`,
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: 'did:abt:platform',
    validFrom: mergedAt,
    credentialSubject: {
      id: subjectDid,
      hire: {
        brief: 'sha256:brief',
        repository: 'buyer/target-repo',
        pullRequest: `https://github.com/buyer/target-repo/pull/${jobId}`,
        mergedAt,
        mergeCommit: '3f8a2c1d9e7b4a5f6c8d0e1f2a3b4c5d6e7f8a9b',
        signedBy: `${subjectDid}#zJobKey`,
        buyer: 'did:example:buyer',
        additions: 1,
        deletions: 1,
        filesChanged: 1,
      },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zProof' },
  };
}

function deemedCredential(subjectDid: string, jobId: string): DeemedCompletionCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id: `urn:uuid:deemed-${jobId}`,
    type: ['VerifiableCredential', 'DeemedCompletionCredential'],
    issuer: 'did:abt:platform',
    validFrom: '2026-08-01T00:00:00.000Z',
    credentialSubject: {
      id: subjectDid,
      deemedCompletion: { stagedCommit: 'staged-sha', noMerge: true, buyer: 'did:example:buyer' },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zProof' },
  };
}

// The block the route must answer, written out key by key from the brief so
// the assertion never leans on the route's own builder.
function expectedBlock(input: {
  readonly subject: string;
  readonly operator: string;
  readonly delegation: unknown;
  readonly accounts: readonly { platform: string; handle: string; proofStatus: string }[];
  readonly baseUrl: string;
  readonly count: number;
  readonly since: string | null;
  readonly digest: string;
  readonly attestedBy: string;
}): Record<string, unknown> {
  return {
    uri: EXTENSION_URI,
    description: EXTENSION_DESCRIPTION,
    required: false,
    params: {
      subject: input.subject,
      operator: input.operator,
      delegation: input.delegation,
      accounts: input.accounts,
      credentials: {
        endpoint: `${input.baseUrl}/agents/${encodeURIComponent(input.subject)}/credentials`,
        count: input.count,
        since: input.since,
        digest: input.digest,
      },
      attestedBy: input.attestedBy,
    },
  };
}

const ORIGINAL_BASE_URL = process.env.FREEAGENTS_PUBLIC_BASE_URL;

describe('GET /agents/:agentDid/card (FIX-B58)', () => {
  let server: Server;
  let baseUrl: string;
  let issuerDid: string;
  const agentRepo = new MemoryAgentRepository();
  const credentialRepo = new MemoryCredentialRepository();
  const operator = fromRandom();
  const agentWallet = fromRandom();
  let delegation: Delegation;

  async function registerAgent(did: string, githubLogin: string | null, del: Delegation = delegation): Promise<Agent> {
    return agentRepo.create({
      did,
      operatorDid: operator.toDid(),
      delegation: del,
      name: `agent-${did.slice(-6)}`,
      skills: ['triage'],
      githubLogin,
    });
  }

  async function saveHire(did: string, jobId: string, mergedAt: string): Promise<string> {
    const document = hireCredential(did, jobId, mergedAt);
    await credentialRepo.save({ completedJobId: jobId, subjectDid: did, document, repositoryPublic: true });
    return document.id;
  }

  async function readCard(did: string): Promise<{ status: number; body: unknown; res: Response }> {
    const res = await fetch(`${baseUrl}/agents/${encodeURIComponent(did)}/card`);
    return { status: res.status, body: await res.json(), res };
  }

  beforeAll(async () => {
    delegation = await signW3CDelegation(operator, agentWallet);
    const credentials = createCredentialsAdapter(undefined, credentialRepo);
    const app = createApp(
      new MemoryAccountRepository(),
      agentRepo,
      undefined,
      undefined,
      undefined,
      credentials,
      undefined,
      credentialRepo,
    );
    server = await listen(app);
    baseUrl = `http://127.0.0.1:${portOf(server)}`;
    // The endpoint the block names is rooted at the configured public base;
    // pointing it at this server lets a test fetch the endpoint as a URL.
    process.env.FREEAGENTS_PUBLIC_BASE_URL = baseUrl;
    const wellKnown = (await (await fetch(`${baseUrl}/.well-known/freeagents-issuer.json`)).json()) as { issuer: string };
    issuerDid = wellKnown.issuer;
  });

  afterAll(async () => {
    if (ORIGINAL_BASE_URL === undefined) delete process.env.FREEAGENTS_PUBLIC_BASE_URL;
    else process.env.FREEAGENTS_PUBLIC_BASE_URL = ORIGINAL_BASE_URL;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('(a) a verified-login agent with two completed hires gets the whole block, required false', async () => {
    const did = agentWallet.toDid();
    await registerAgent(did, 'octo-agent');
    await agentRepo.updateGithubBinding(did, { handle: 'octo-agent', status: 'verified' });
    // Saved out of id order on purpose, so the digest's sort is observable.
    const idB = await saveHire(did, 'job-b', '2026-08-12T00:00:00.000Z');
    const idA = await saveHire(did, 'job-a', '2026-08-10T00:00:00.000Z');

    const { status, body, res } = await readCard(did);
    expect(status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(body).toEqual(
      expectedBlock({
        subject: did,
        operator: operator.toDid(),
        delegation,
        accounts: [{ platform: 'github', handle: 'octo-agent', proofStatus: 'verified' }],
        baseUrl,
        count: 2,
        since: '2026-08-10T00:00:00.000Z',
        digest: digestOf([idA, idB]),
        attestedBy: issuerDid,
      }),
    );
    expect((body as { required: unknown }).required).toBe(false);
  });

  it('(b) params.delegation is the delegation GET /agents/:agentDid serves, and a stranger verifies it alone', async () => {
    const did = agentWallet.toDid();
    const { body } = await readCard(did);
    const block = body as { params: { delegation: Record<string, unknown> } };

    const profile = (await (await fetch(`${baseUrl}/agents/${encodeURIComponent(did)}`)).json()) as { delegation: unknown };
    expect(block.params.delegation).toEqual(profile.delegation);

    // The stranger holds only the block's JSON: no request to this service.
    const strangerCopy = JSON.parse(JSON.stringify(block.params.delegation)) as Record<string, unknown>;
    expect(await verifyIndependent(strangerCopy)).toBe(true);

    // Negative control: one changed claim breaks the signature.
    const tampered = JSON.parse(JSON.stringify(strangerCopy)) as { credentialSubject: Record<string, unknown> };
    tampered.credentialSubject.delegatedBy = 'did:abt:zSomeoneElse';
    expect(await verifyIndependent(tampered as unknown as Record<string, unknown>)).toBe(false);
  });

  it('(c) a deemed-completion credential moves nothing; a third hire moves count and digest, not since', async () => {
    const did = 'did:abt:zCardCounting';
    await registerAgent(did, null);
    const idB = await saveHire(did, 'count-b', '2026-08-12T00:00:00.000Z');
    const idA = await saveHire(did, 'count-a', '2026-08-10T00:00:00.000Z');
    const base = {
      subject: did,
      operator: operator.toDid(),
      delegation,
      accounts: [],
      baseUrl,
      attestedBy: issuerDid,
    };

    const before = await readCard(did);
    expect(before.body).toEqual(
      expectedBlock({ ...base, count: 2, since: '2026-08-10T00:00:00.000Z', digest: digestOf([idA, idB]) }),
    );

    await credentialRepo.save({
      completedJobId: 'count-deemed',
      subjectDid: did,
      document: deemedCredential(did, 'count-deemed'),
      repositoryPublic: true,
    });
    const afterDeemed = await readCard(did);
    expect(afterDeemed.body).toEqual(before.body);

    const idC = await saveHire(did, 'count-c', '2026-08-20T00:00:00.000Z');
    const afterThird = await readCard(did);
    expect(afterThird.body).toEqual(
      expectedBlock({ ...base, count: 3, since: '2026-08-10T00:00:00.000Z', digest: digestOf([idA, idB, idC]) }),
    );
    expect(digestOf([idA, idB, idC])).not.toBe(digestOf([idA, idB]));
  });

  it('(d) credentials.endpoint is a URL that lists the agent\'s own credentials, and attestedBy is the published issuer', async () => {
    const did = agentWallet.toDid();
    const { body } = await readCard(did);
    const block = body as { params: { credentials: { endpoint: string }; attestedBy: string } };

    const listing = await fetch(block.params.credentials.endpoint);
    expect(listing.status).toBe(200);
    const listed = (await listing.json()) as { agentDid: string; credentials: { credentialId: string }[] };
    expect(listed.agentDid).toBe(did);
    expect(digestOf(listed.credentials.map((c) => c.credentialId))).toBe(
      (body as { params: { credentials: { digest: string } } }).params.credentials.digest,
    );

    const wellKnown = (await (await fetch(`${baseUrl}/.well-known/freeagents-issuer.json`)).json()) as { issuer: string };
    expect(block.params.attestedBy).toBe(wellKnown.issuer);
  });

  it('(e) an agent with no GitHub login answers accounts [] and an empty credential summary', async () => {
    const did = 'did:abt:zCardNoLogin';
    await registerAgent(did, null);
    const { status, body } = await readCard(did);
    expect(status).toBe(200);
    expect(body).toEqual(
      expectedBlock({
        subject: did,
        operator: operator.toDid(),
        delegation,
        accounts: [],
        baseUrl,
        count: 0,
        since: null,
        digest: `sha256-${sha256Hex('')}`,
        attestedBy: issuerDid,
      }),
    );
  });

  it('(e) an agent whose GitHub login the platform has not verified answers proofStatus "unverified"', async () => {
    const did = 'did:abt:zCardUnverified';
    await registerAgent(did, 'claimed-only');
    const { status, body } = await readCard(did);
    expect(status).toBe(200);
    expect(body).toEqual(
      expectedBlock({
        subject: did,
        operator: operator.toDid(),
        delegation,
        accounts: [{ platform: 'github', handle: 'claimed-only', proofStatus: 'unverified' }],
        baseUrl,
        count: 0,
        since: null,
        digest: `sha256-${sha256Hex('')}`,
        attestedBy: issuerDid,
      }),
    );
  });

  it('(f) an unlisted agent still answers 200 with its block', async () => {
    const did = 'did:abt:zCardUnlisted';
    await registerAgent(did, null);
    const id = await saveHire(did, 'unlisted-1', '2026-08-15T00:00:00.000Z');
    await agentRepo.setListed(did, false);
    const { status, body } = await readCard(did);
    expect(status).toBe(200);
    expect(body).toEqual(
      expectedBlock({
        subject: did,
        operator: operator.toDid(),
        delegation,
        accounts: [],
        baseUrl,
        count: 1,
        since: '2026-08-15T00:00:00.000Z',
        digest: digestOf([id]),
        attestedBy: issuerDid,
      }),
    );
  });

  it('(f) an unregistered agent answers 404 with its DID in the sentence', async () => {
    const { status, body } = await readCard('did:abt:znobody');
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'agent did:abt:znobody is not registered' });
  });
});

describe('GET /agents/:agentDid/card, refusals (FIX-B58 f)', () => {
  const DID = 'did:abt:zCardRefusals';
  const servers: Server[] = [];
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

  afterEach(async () => {
    errorLog.mockClear();
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  });

  afterAll(() => {
    errorLog.mockRestore();
  });

  const baseDelegation = { id: 'urn:uuid:refusal-fixture' } as unknown as Delegation;

  function agentRow(): Agent {
    return {
      did: DID,
      operatorDid: 'did:abt:zRefusalOperator',
      delegation: baseDelegation,
      name: 'refusal-agent',
      description: null,
      skills: ['triage'],
      githubLogin: null,
      proofStatus: 'unverified',
      createdAt: new Date(),
      keyRotations: [],
      floorPriceUsd: null,
      minBuyerMerges: null,
      maxWalkedAfterConfirm: null,
      avatarSpec: null,
      negotiatesOnOwnersBehalf: false,
      notifyWebhookUrl: null,
      listed: true,
    } as Agent;
  }

  async function read(opts: {
    findByDid?: AgentRepository['findByDid'];
    listBySubjectDid?: CredentialRepository['listBySubjectDid'];
    describeIssuer?: CredentialsAdapter['describeIssuer'];
  }): Promise<Response> {
    const baseAgents = new MemoryAgentRepository();
    const agents: AgentRepository = {
      create: (input) => baseAgents.create(input),
      findByDid: opts.findByDid ?? (() => Promise.resolve(agentRow())),
      updateGithubBinding: (did, input) => baseAgents.updateGithubBinding(did, input),
      recordKeyRotation: (did, input) => baseAgents.recordKeyRotation(did, input),
      setAvatarSpec: (did, spec) => baseAgents.setAvatarSpec(did, spec),
      setNegotiatesOnOwnersBehalf: (did, flag) => baseAgents.setNegotiatesOnOwnersBehalf(did, flag),
      setNotifyWebhookUrl: (did, url) => baseAgents.setNotifyWebhookUrl(did, url),
      setListed: (did, listed) => baseAgents.setListed(did, listed),
    };
    const memoryCredentials = new MemoryCredentialRepository();
    const credentialRepo: CredentialRepository = {
      save: (input) => memoryCredentials.save(input),
      findByDocumentId: (id) => memoryCredentials.findByDocumentId(id),
      listBySubjectDid: opts.listBySubjectDid ?? ((did) => memoryCredentials.listBySubjectDid(did)),
    };
    const real = createCredentialsAdapter(undefined, credentialRepo);
    const credentials: CredentialsAdapter = { ...real, describeIssuer: opts.describeIssuer ?? (() => real.describeIssuer()) };
    const app = createApp(new MemoryAccountRepository(), agents, undefined, undefined, undefined, credentials, undefined, credentialRepo);
    const server = await listen(app);
    servers.push(server);
    return fetch(`http://127.0.0.1:${portOf(server)}/agents/${DID}/card`);
  }

  it('answers 200 when every dependency works, so the refusals below are not a route that always fails', async () => {
    const res = await read({});
    expect(res.status).toBe(200);
  });

  it('503 storage unavailable when the agent lookup throws, and logs the cause', async () => {
    const cause = new Error('db down');
    const res = await read({ findByDid: () => Promise.reject(cause) });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'storage unavailable' });
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('/card'), cause);
  });

  it('503 storage unavailable when the credential read throws, never a block with count 0', async () => {
    const cause = new Error('credential table down');
    const res = await read({ listBySubjectDid: () => Promise.reject(cause) });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'storage unavailable' });
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('/card'), cause);
  });

  it('503 issuer identity unavailable when describeIssuer rejects, and logs the cause', async () => {
    const cause = new Error('signing key unavailable');
    const res = await read({ describeIssuer: () => Promise.reject(cause) });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'issuer identity unavailable' });
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('/card'), cause);
  });
});
