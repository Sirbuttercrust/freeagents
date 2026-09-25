// ISS1 (bugs.md B30): the one public, unauthenticated, cacheable read that
// tells a third party which DID is FreeAgents' own issuer -- published
// outside any credential, so a credential cannot forge it (invariant 2's
// "checkable by a third party without calling this service" needs a
// starting point: which DID to trust in the first place). The DID and key
// come from the SAME platformIssuerFromEnv the credentials adapter signs
// with, never a second derivation that could name a different key.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import { deriveDidFromSeed } from '../../src/adapters/identity/did-from-seed.js';

function listen(app: Express): Promise<Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
}

function portOf(srv: Server): number {
  return (srv.address() as AddressInfo).port;
}

const ISSUER_SEED = new Uint8Array(32).fill(42);

describe('GET /.well-known/freeagents-issuer.json', () => {
  let server: Server;
  let baseUrl: string;
  let issuerDid: string;

  beforeAll(async () => {
    // ISS1's whole point: the issuer DID must actually derive from the
    // signing key, so this fixture derives it the same way
    // platformIssuerFromEnv does in production -- never an arbitrary
    // literal that happens not to correspond to any key.
    issuerDid = (await deriveDidFromSeed(ISSUER_SEED)).did;
    const credentials = createCredentialsAdapter({ did: issuerDid, seed: ISSUER_SEED });
    const app = createApp(undefined, undefined, undefined, undefined, undefined, credentials);
    server = await listen(app);
    baseUrl = `http://127.0.0.1:${portOf(server)}`;
  });

  afterAll(() => {
    server.close();
  });

  it('answers 200 with no authentication at all', async () => {
    const res = await fetch(`${baseUrl}/.well-known/freeagents-issuer.json`);
    expect(res.status).toBe(200);
  });

  it('is cacheable: sends a Cache-Control header allowing shared/public caching', async () => {
    const res = await fetch(`${baseUrl}/.well-known/freeagents-issuer.json`);
    const cacheControl = res.headers.get('cache-control');
    expect(cacheControl).not.toBeNull();
    expect(cacheControl).toMatch(/public|max-age/);
  });

  it('names the configured issuer DID, verbatim', async () => {
    const res = await fetch(`${baseUrl}/.well-known/freeagents-issuer.json`);
    const body = (await res.json()) as { issuer: string; verificationMethod: string; publicKeyMultibase: string };
    expect(body.issuer).toBe(issuerDid);
  });

  it('carries verificationMethod as "<did>#<publicKeyMultibase>" and publicKeyMultibase matches the seed\'s own key', async () => {
    const res = await fetch(`${baseUrl}/.well-known/freeagents-issuer.json`);
    const body = (await res.json()) as { issuer: string; verificationMethod: string; publicKeyMultibase: string };

    const key = await Ed25519VerificationKey2020.generate({ seed: ISSUER_SEED, controller: issuerDid });
    expect(body.publicKeyMultibase).toBe(key.publicKeyMultibase);
    expect(body.verificationMethod).toBe(`${issuerDid}#${key.publicKeyMultibase}`);
  });

  it('the published key actually re-derives the published issuer DID (the same binding check a verifier performs)', async () => {
    const { fromPublicKey } = await import('@arcblock/did');
    const res = await fetch(`${baseUrl}/.well-known/freeagents-issuer.json`);
    const body = (await res.json()) as { issuer: string; verificationMethod: string; publicKeyMultibase: string };

    const key = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint: body.publicKeyMultibase });
    const raw = (key as unknown as { _publicKeyBuffer: Uint8Array })._publicKeyBuffer;
    expect(body.issuer).toBe(`did:abt:${fromPublicKey(raw)}`);
  });
});
