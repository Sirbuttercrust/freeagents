// FIX-B41b: PATCH /agents/:agentDid, the owner's edit of an already-listed
// agent (bugs.md B41, the second API part; split out of FIX-B41a, d52961e,
// for the size guard). Lists an agent through the site path first (the
// fixture pattern tests/api/agents-list-site-path.test.ts uses), then edits
// it. Body may carry any of { name, description, skills, floorPriceUsd },
// validated exactly as POST /agents validates them; naming none of the
// four is 400; any other field (did, delegation, githubLogin, proofStatus,
// operatorDid...) changes nothing, by construction: UpdateListingInput has
// no field for them.
import type { Server } from 'node:http';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import * as vc from '@digitalbazaar/vc';
import { securityLoader } from '@digitalbazaar/security-document-loader';

import { createApp } from '../../src/api/app.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import { createKnownKeyStore } from '../../src/adapters/identity/did-abt-resolver.js';
import { MemoryAgentRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import type { AgentRepository } from '../../src/adapters/storage/types.js';
import { testSessionAdapter, mintSessionToken } from '../helpers/session-fixtures.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

const ORIGINAL_SEED = process.env.FREEAGENTS_PLATFORM_SEED;
let seedCounter = 0;

// Invariant 2 (MISSION.md): verify a W3C credential using ONLY
// @digitalbazaar/* and the credential itself, exactly as
// tests/api/agent-invariant2.test.ts's own verifyIndependent does for the
// wallet path and tests/api/agents-list-site-path.test.ts's own copy does
// for the site path. Copied here (not imported across test files) so this
// file's own proof stands alone: an edit must never touch the stored
// delegation, and a stranger given only the (unedited) delegation reaches
// the same verdict this service does.
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
    if (fromPublicKey(keyWithBuffer._publicKeyBuffer) !== issuer.replace(/^did:abt:/, '')) return false;
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

async function postJson(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

async function patchJson(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

async function patchSigned(baseUrl: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, 'PATCH', targetUri, { body: bodyText });
  return fetch(targetUri, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'signature-input': signed['signature-input'], signature: signed.signature, 'content-digest': signed['content-digest'] },
    body: bodyText,
  });
}

interface Booted {
  readonly server: Server;
  readonly baseUrl: string;
  readonly accountRepo: MemoryAccountRepository;
  readonly agentRepo: MemoryAgentRepository;
  readonly sessionToken: string;
}

async function bootApp(): Promise<Booted> {
  seedCounter += 1;
  process.env.FREEAGENTS_PLATFORM_SEED = `b41b${seedCounter}`.padEnd(64, '0');
  const accountRepo = new MemoryAccountRepository();
  const agentRepo = new MemoryAgentRepository();
  const sessionAdapter = testSessionAdapter();
  const identity = createIdentityAdapter(createKnownKeyStore());
  const app = createApp(accountRepo, agentRepo, identity, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const sessionToken = await mintSessionToken(sessionAdapter);
  return { server, baseUrl, accountRepo, agentRepo, sessionToken };
}

async function shutdownApp(booted: Booted): Promise<void> {
  await new Promise<void>((resolve) => booted.server.close(() => resolve()));
}

// Lists one agent through the site path (no did, no delegation), returning
// its DID and the owner's own bearer header, so every test below edits a
// real, already-listed agent rather than a hand-built fixture row.
async function listAgent(booted: Booted, overrides: Record<string, unknown> = {}): Promise<{ did: string; auth: { authorization: string } }> {
  const auth = { authorization: `Bearer ${booted.sessionToken}` };
  const res = await postJson(booted.baseUrl, '/agents', { name: 'scout', skills: ['triage'], ...overrides }, auth);
  const body = (await res.json()) as Record<string, unknown>;
  return { did: body.did as string, auth };
}

afterAll(() => {
  if (ORIGINAL_SEED === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
  else process.env.FREEAGENTS_PLATFORM_SEED = ORIGINAL_SEED;
});

describe('PATCH /agents/:agentDid (FIX-B41b): the owner edits name', () => {
  it('the owner edits the name alone, and GET /agents/:agentDid then serves the new value', async () => {
    const booted = await bootApp();
    try {
      const { did, auth } = await listAgent(booted);
      const res = await patchJson(booted.baseUrl, `/agents/${did}`, { name: 'scout-renamed' }, auth);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.name).toBe('scout-renamed');

      const read = await fetch(`${booted.baseUrl}/agents/${did}`);
      expect(((await read.json()) as Record<string, unknown>).name).toBe('scout-renamed');
    } finally {
      await shutdownApp(booted);
    }
  });
});

describe('PATCH /agents/:agentDid (FIX-B41b): each field edited alone', () => {
  it('description alone is stored and read back, other fields untouched', async () => {
    const booted = await bootApp();
    try {
      const { did, auth } = await listAgent(booted);
      const res = await patchJson(booted.baseUrl, `/agents/${did}`, { description: 'Triages issues.' }, auth);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.description).toBe('Triages issues.');
      expect(body.name).toBe('scout');
      expect(body.skills).toEqual(['triage']);
    } finally {
      await shutdownApp(booted);
    }
  });

  it('skills alone replaces the stored list and reads back', async () => {
    const booted = await bootApp();
    try {
      const { did, auth } = await listAgent(booted);
      const res = await patchJson(booted.baseUrl, `/agents/${did}`, { skills: ['coding', 'review'] }, auth);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.skills).toEqual(['coding', 'review']);
    } finally {
      await shutdownApp(booted);
    }
  });

  it('floorPriceUsd alone is stored and read back', async () => {
    const booted = await bootApp();
    try {
      const { did, auth } = await listAgent(booted);
      const res = await patchJson(booted.baseUrl, `/agents/${did}`, { floorPriceUsd: '25.00' }, auth);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.floorPriceUsd).toBe('25.00');

      const read = await fetch(`${booted.baseUrl}/agents/${did}`);
      expect(((await read.json()) as Record<string, unknown>).floorPriceUsd).toBe('25.00');
    } finally {
      await shutdownApp(booted);
    }
  });

  it('description: null clears an already-set description', async () => {
    const booted = await bootApp();
    try {
      const { did, auth } = await listAgent(booted, { description: 'Triages issues.' });
      const res = await patchJson(booted.baseUrl, `/agents/${did}`, { description: null }, auth);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.description).toBeNull();
    } finally {
      await shutdownApp(booted);
    }
  });

  it('floorPriceUsd: null clears an already-set floor', async () => {
    const booted = await bootApp();
    try {
      const { did, auth } = await listAgent(booted);
      await patchJson(booted.baseUrl, `/agents/${did}`, { floorPriceUsd: '25.00' }, auth);
      const res = await patchJson(booted.baseUrl, `/agents/${did}`, { floorPriceUsd: null }, auth);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.floorPriceUsd).toBeNull();

      const read = await fetch(`${booted.baseUrl}/agents/${did}`);
      expect(((await read.json()) as Record<string, unknown>).floorPriceUsd).toBeNull();
    } finally {
      await shutdownApp(booted);
    }
  });
});

describe('PATCH /agents/:agentDid (FIX-B41b): auth refusals write nothing', () => {
  it('unsigned is 401 and the write is never called', async () => {
    const booted = await bootApp();
    try {
      const { did } = await listAgent(booted);
      const spy = vi.spyOn(booted.agentRepo, 'updateListing');
      const res = await patchJson(booted.baseUrl, `/agents/${did}`, { name: 'stolen-rename' });
      expect(res.status).toBe(401);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      await shutdownApp(booted);
    }
  });

  it('a REGISTERED stranger is 403 and the write is never called', async () => {
    const booted = await bootApp();
    try {
      const { did } = await listAgent(booted);
      const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(231));
      await booted.accountRepo.register({ did: stranger.did, githubLogin: 'edit-listing-stranger' });
      const spy = vi.spyOn(booted.agentRepo, 'updateListing');
      const res = await patchSigned(booted.baseUrl, `/agents/${did}`, { name: 'stolen-rename' }, stranger);
      expect(res.status).toBe(403);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      await shutdownApp(booted);
    }
  });

  it('an UNREGISTERED signer (no account resolves) is 401, never 403', async () => {
    const booted = await bootApp();
    try {
      const { did } = await listAgent(booted);
      const unregistered = await signingIdentityFromSeed(new Uint8Array(32).fill(232));
      const res = await patchSigned(booted.baseUrl, `/agents/${did}`, { name: 'stolen-rename' }, unregistered);
      expect(res.status).toBe(401);
    } finally {
      await shutdownApp(booted);
    }
  });

  it('an unknown agent DID is 404 and the write is never called', async () => {
    const booted = await bootApp();
    try {
      const { auth } = await listAgent(booted);
      const spy = vi.spyOn(booted.agentRepo, 'updateListing');
      const res = await patchJson(booted.baseUrl, '/agents/did:abt:zNoSuchEditAgent', { name: 'ghost' }, auth);
      expect(res.status).toBe(404);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      await shutdownApp(booted);
    }
  });
});

describe('PATCH /agents/:agentDid (FIX-B41b): ignored fields change nothing', () => {
  it('did, delegation, githubLogin, proofStatus beside a valid name change none of them, and the name DOES change', async () => {
    const booted = await bootApp();
    try {
      const { did, auth } = await listAgent(booted);
      const before = await (await fetch(`${booted.baseUrl}/agents/${did}`)).json() as Record<string, unknown>;

      const res = await patchJson(
        booted.baseUrl,
        `/agents/${did}`,
        { name: 'renamed-beside-ignored', did: 'did:abt:zHijacked', delegation: { fake: 'credential' }, githubLogin: 'someone-else', proofStatus: 'verified' },
        auth,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.name).toBe('renamed-beside-ignored');
      expect(body.did).toBe(before.did);
      expect(body.delegation).toEqual(before.delegation);
      expect(body.githubLogin).toBe(before.githubLogin);
      expect(body.proofStatus).toBe(before.proofStatus);
    } finally {
      await shutdownApp(booted);
    }
  });

  it('the write only ever receives the four validated keys, never did/delegation/githubLogin/proofStatus', async () => {
    // Defect from review round 1: a route that forwarded the whole body to
    // storage (`...(body as object)` ahead of the four picks) still passed
    // every prior test in this file, because none of them inspected what
    // reached the write, only what the response and a re-read showed. This
    // spies on the write itself and pins its second argument's keys, so a
    // route-layer leak reddens here even when memory.ts drops the leaked
    // key before it reaches the row.
    const booted = await bootApp();
    try {
      const { did, auth } = await listAgent(booted);
      const spy = vi.spyOn(booted.agentRepo, 'updateListing');
      const res = await patchJson(
        booted.baseUrl,
        `/agents/${did}`,
        { name: 'spied-on-rename', did: 'did:abt:zHijacked', delegation: { fake: 'credential' }, githubLogin: 'someone-else', proofStatus: 'verified', operatorDid: 'did:abt:zHijackedOperator' },
        auth,
      );
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      const forwarded = spy.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(Object.keys(forwarded).sort()).toEqual(['name']);
      expect(forwarded).not.toHaveProperty('did');
      expect(forwarded).not.toHaveProperty('delegation');
      expect(forwarded).not.toHaveProperty('githubLogin');
      expect(forwarded).not.toHaveProperty('proofStatus');
      expect(forwarded).not.toHaveProperty('operatorDid');
    } finally {
      await shutdownApp(booted);
    }
  });

  it('a body naming only did, delegation, githubLogin, proofStatus (no valid field) is 400, and none of them change', async () => {
    const booted = await bootApp();
    try {
      const { did, auth } = await listAgent(booted);
      const before = await (await fetch(`${booted.baseUrl}/agents/${did}`)).json() as Record<string, unknown>;

      const res = await patchJson(
        booted.baseUrl,
        `/agents/${did}`,
        { did: 'did:abt:zHijacked', delegation: { fake: 'credential' }, githubLogin: 'someone-else', proofStatus: 'verified' },
        auth,
      );
      expect(res.status).toBe(400);

      const after = await (await fetch(`${booted.baseUrl}/agents/${did}`)).json() as Record<string, unknown>;
      expect(after).toEqual(before);
    } finally {
      await shutdownApp(booted);
    }
  });
});

describe('PATCH /agents/:agentDid (FIX-B41b): malformed fields are 400 and write nothing', () => {
  async function expectRefusedAndUntouched(booted: Booted, did: string, auth: { authorization: string }, body: unknown): Promise<void> {
    const before = await (await fetch(`${booted.baseUrl}/agents/${did}`)).json() as Record<string, unknown>;
    const res = await patchJson(booted.baseUrl, `/agents/${did}`, body, auth);
    expect(res.status).toBe(400);
    const after = await (await fetch(`${booted.baseUrl}/agents/${did}`)).json() as Record<string, unknown>;
    expect(after).toEqual(before);
  }

  it('empty name is 400', async () => {
    const booted = await bootApp();
    try {
      const { did, auth } = await listAgent(booted);
      await expectRefusedAndUntouched(booted, did, auth, { name: '' });
    } finally {
      await shutdownApp(booted);
    }
  });

  it('a description with a line break is 400', async () => {
    const booted = await bootApp();
    try {
      const { did, auth } = await listAgent(booted);
      await expectRefusedAndUntouched(booted, did, auth, { description: 'line one\nline two' });
    } finally {
      await shutdownApp(booted);
    }
  });

  it('a description over 160 characters is 400', async () => {
    const booted = await bootApp();
    try {
      const { did, auth } = await listAgent(booted);
      await expectRefusedAndUntouched(booted, did, auth, { description: 'a'.repeat(161) });
    } finally {
      await shutdownApp(booted);
    }
  });

  it('a description with a trailing space is 400', async () => {
    const booted = await bootApp();
    try {
      const { did, auth } = await listAgent(booted);
      await expectRefusedAndUntouched(booted, did, auth, { description: 'trailing space ' });
    } finally {
      await shutdownApp(booted);
    }
  });

  it('an empty skills list is 400', async () => {
    const booted = await bootApp();
    try {
      const { did, auth } = await listAgent(booted);
      await expectRefusedAndUntouched(booted, did, auth, { skills: [] });
    } finally {
      await shutdownApp(booted);
    }
  });

  it('floorPriceUsd "5" (not two decimal places) is 400', async () => {
    const booted = await bootApp();
    try {
      const { did, auth } = await listAgent(booted);
      await expectRefusedAndUntouched(booted, did, auth, { floorPriceUsd: '5' });
    } finally {
      await shutdownApp(booted);
    }
  });

  it('name: null is 400 (name may never be cleared)', async () => {
    const booted = await bootApp();
    try {
      const { did, auth } = await listAgent(booted);
      await expectRefusedAndUntouched(booted, did, auth, { name: null });
    } finally {
      await shutdownApp(booted);
    }
  });

  it('an empty body (naming none of the four fields) is 400', async () => {
    const booted = await bootApp();
    try {
      const { did, auth } = await listAgent(booted);
      await expectRefusedAndUntouched(booted, did, auth, {});
    } finally {
      await shutdownApp(booted);
    }
  });
});

describe('PATCH /agents/:agentDid (FIX-B41b): a driver without updateListing', () => {
  it('answers 503 and the log names the cause', async () => {
    const identity = createIdentityAdapter(createKnownKeyStore());
    const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(233));
    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: operator.did, githubLogin: 'no-update-listing-operator' });
    const agentDid = 'did:abt:zNoUpdateListingAgent';
    const delegation = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      id: 'urn:uuid:no-update-listing',
      type: ['VerifiableCredential', 'AgentDelegation'],
      issuer: operator.did,
      issuanceDate: '2026-09-25T00:00:00.000Z',
      credentialSubject: { id: agentDid },
      proof: {
        type: 'Ed25519Signature2020',
        created: '2026-09-25T00:00:00.000Z',
        verificationMethod: `${operator.did}#zOperatorKeyHash`,
        proofPurpose: 'assertionMethod',
        proofValue: 'zMockProofValue',
      },
    };
    // A hand-rolled repository that has every method EXCEPT updateListing
    // (the brief's own "storage seam" pattern): the route must answer 503
    // storage-unavailable, the same as browse does for a driver lacking
    // listAll, never a silent no-op or a crash.
    const realRepo = new MemoryAgentRepository();
    await realRepo.create({ did: agentDid, operatorDid: operator.did, delegation, name: 'scout', skills: ['triage'], githubLogin: null });
    const noUpdateListingRepo: AgentRepository = {
      create: realRepo.create.bind(realRepo),
      findByDid: realRepo.findByDid.bind(realRepo),
      updateGithubBinding: realRepo.updateGithubBinding.bind(realRepo),
      recordKeyRotation: realRepo.recordKeyRotation.bind(realRepo),
      listAll: realRepo.listAll.bind(realRepo),
      setAvatarSpec: realRepo.setAvatarSpec.bind(realRepo),
      setNegotiatesOnOwnersBehalf: realRepo.setNegotiatesOnOwnersBehalf.bind(realRepo),
      setNotifyWebhookUrl: realRepo.setNotifyWebhookUrl.bind(realRepo),
      setListed: realRepo.setListed.bind(realRepo),
      // updateListing deliberately omitted.
    };
    const app = createApp(accountRepo, noUpdateListingRepo, identity);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await patchSigned(baseUrl, `/agents/${agentDid}`, { name: 'renamed' }, operator);
        expect(res.status).toBe(503);
        const loggedNamesTheCause = errorSpy.mock.calls.some((call: unknown[]) => call.some((arg: unknown) => String(arg).includes('updateListing')));
        expect(loggedNamesTheCause).toBe(true);
      } finally {
        errorSpy.mockRestore();
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('PATCH /agents/:agentDid (FIX-B41b): invariant 2 still holds after an edit', () => {
  it('an edit never touches the stored delegation; it still verifies independently after the edit', async () => {
    const booted = await bootApp();
    try {
      const { did, auth } = await listAgent(booted);
      const beforeStored = await booted.agentRepo.findByDid(did);
      expect(beforeStored).not.toBeNull();
      expect(await verifyIndependent(JSON.parse(JSON.stringify(beforeStored?.delegation)) as Record<string, unknown>)).toBe(true);

      const res = await patchJson(booted.baseUrl, `/agents/${did}`, { name: 'renamed-post-edit', description: 'Now with a bio.', skills: ['coding'], floorPriceUsd: '10.00' }, auth);
      expect(res.status).toBe(200);

      const afterStored = await booted.agentRepo.findByDid(did);
      expect(afterStored).not.toBeNull();
      // The delegation object itself is byte-identical: an edit changes
      // only the four listing fields, never the credential that binds
      // the agent DID to the operator DID.
      expect(afterStored?.delegation).toEqual(beforeStored?.delegation);
      expect(await verifyIndependent(JSON.parse(JSON.stringify(afterStored?.delegation)) as Record<string, unknown>)).toBe(true);
    } finally {
      await shutdownApp(booted);
    }
  });
});
