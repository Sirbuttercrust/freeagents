// S11 (security sweep 2026-09-06, "the rate limiter keys on req.ip with no
// proxy trust configured"): FREEAGENTS_TRUST_PROXY controls Express's own
// `trust proxy` setting, which decides where req.ip and req.protocol read
// the caller's real address and scheme from. "Whoever fixes S7 must fix
// S11 first" (the sweep's own rule): mounting a limiter more broadly
// without proxy trust would turn a per-caller bucket into a shared,
// forgeable one behind any real reverse proxy.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { TRUST_PROXY_ENV_VAR } from '../../src/adapters/config/trust-proxy.js';
import type { Delegation } from '../../src/domain/agent.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

function delegationFixture(agentDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-trust-proxy',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: 'did:abt:op-trust-proxy',
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

let server: Server | null = null;
let originalEnv: string | undefined;

function setTrustProxyEnv(value: string | undefined): void {
  if (value === undefined) delete process.env[TRUST_PROXY_ENV_VAR];
  else process.env[TRUST_PROXY_ENV_VAR] = value;
}

afterEach(async () => {
  setTrustProxyEnv(originalEnv);
  originalEnv = undefined;
  if (server !== null) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

async function listen(app: ReturnType<typeof createApp>): Promise<string> {
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function registeredBuyer(seed: number): Promise<{ identity: SigningIdentity; operatorRepo: MemoryAccountRepository }> {
  const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(seed));
  const operatorRepo = new MemoryAccountRepository();
  await operatorRepo.register({ did: identity.did, githubLogin: `trust-proxy-buyer-${seed}` });
  return { identity, operatorRepo };
}

describe('FREEAGENTS_TRUST_PROXY: startup validation', () => {
  it('refuses an unrecognised value at startup, naming the variable', () => {
    originalEnv = process.env[TRUST_PROXY_ENV_VAR];
    setTrustProxyEnv('not-a-valid-setting/999');

    expect(() => createApp()).toThrow(/FREEAGENTS_TRUST_PROXY/);
  });

  it('accepts the default (unset) with no error', () => {
    originalEnv = process.env[TRUST_PROXY_ENV_VAR];
    setTrustProxyEnv(undefined);

    expect(() => createApp()).not.toThrow();
  });

  it('accepts a hop count with no error', () => {
    originalEnv = process.env[TRUST_PROXY_ENV_VAR];
    setTrustProxyEnv('1');

    expect(() => createApp()).not.toThrow();
  });
});

describe('FREEAGENTS_TRUST_PROXY: per-caller buckets behind a proxy (S11)', () => {
  it('with the setting ON, two callers with different X-Forwarded-For get separate rate-limit buckets', async () => {
    originalEnv = process.env[TRUST_PROXY_ENV_VAR];
    setTrustProxyEnv('1');

    // FIX-S7 round 3 (round 3's ruling): GET /agents/:agentDid moved from
    // `verify` to `read`, so the override here targets the `read` class
    // rather than passing a bare RateLimiter (which would only override
    // `verify`, a bucket this route no longer uses).
    const agentRepo = new MemoryAgentRepository();
    const agentDid = 'did:abt:trust-proxy-on-agent';
    await agentRepo.create({
      did: agentDid,
      operatorDid: 'did:abt:op-trust-proxy',
      delegation: delegationFixture(agentDid),
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const app = createApp(undefined, agentRepo, undefined, undefined, undefined, undefined, undefined, undefined, {
      read: 1,
    });
    const baseUrl = await listen(app);

    const callerA1 = await fetch(`${baseUrl}/agents/${agentDid}`, { headers: { 'X-Forwarded-For': '203.0.113.10' } });
    const callerB1 = await fetch(`${baseUrl}/agents/${agentDid}`, { headers: { 'X-Forwarded-For': '203.0.113.20' } });
    // Each caller's FIRST request succeeds even though the shared limit is
    // 1: they are on separate buckets, not sharing one.
    expect(callerA1.status).toBe(200);
    expect(callerB1.status).toBe(200);

    // A caller's OWN second request exhausts its own bucket.
    const callerA2 = await fetch(`${baseUrl}/agents/${agentDid}`, { headers: { 'X-Forwarded-For': '203.0.113.10' } });
    expect(callerA2.status).toBe(429);
  });

  it('with the setting OFF (the default), a forged X-Forwarded-For changes nothing: both requests share one bucket', async () => {
    originalEnv = process.env[TRUST_PROXY_ENV_VAR];
    setTrustProxyEnv(undefined);

    // FIX-S7 round 3 (round 3's ruling): same repointing to a `read`
    // override as the ON case above.
    const agentRepo = new MemoryAgentRepository();
    const agentDid = 'did:abt:trust-proxy-off-agent';
    await agentRepo.create({
      did: agentDid,
      operatorDid: 'did:abt:op-trust-proxy',
      delegation: delegationFixture(agentDid),
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const app = createApp(undefined, agentRepo, undefined, undefined, undefined, undefined, undefined, undefined, {
      read: 1,
    });
    const baseUrl = await listen(app);

    const first = await fetch(`${baseUrl}/agents/${agentDid}`, { headers: { 'X-Forwarded-For': '203.0.113.10' } });
    expect(first.status).toBe(200);

    // A DIFFERENT claimed X-Forwarded-For, same real test-client socket:
    // with trust proxy off, req.ip ignores the header entirely, so this
    // still lands on the SAME bucket the first request used and trips it.
    const second = await fetch(`${baseUrl}/agents/${agentDid}`, { headers: { 'X-Forwarded-For': '203.0.113.20' } });
    expect(second.status).toBe(429);
  });
});

describe('FREEAGENTS_TRUST_PROXY: RFC 9421 signature verification through a proxy (S11)', () => {
  it('verifies a request whose signed target-uri is https, arriving through a proxy that sets X-Forwarded-Proto: https, with the setting ON', async () => {
    originalEnv = process.env[TRUST_PROXY_ENV_VAR];
    setTrustProxyEnv('1');

    const { identity: buyer, operatorRepo } = await registeredBuyer(41);
    const app = createApp(operatorRepo);
    const baseUrl = await listen(app);
    const address = server!.address() as AddressInfo;

    // The signer believed (correctly, given the proxy's own forwarded
    // header) that the app-visible scheme is https: the target-uri it
    // signs over says so, even though this test's raw socket connection is
    // plain http. With trust proxy ON, req.protocol at app.ts:1060 honours
    // X-Forwarded-Proto, so the server derives the identical https
    // target-uri the signer used, and the signature verifies.
    const httpsTargetUri = `https://127.0.0.1:${address.port}/accounts/me`;
    const signed = signRequest(buyer, 'GET', httpsTargetUri, { components: ['@method', '@target-uri', 'content-digest'] });

    const res = await fetch(`${baseUrl}/accounts/me`, {
      headers: {
        'X-Forwarded-Proto': 'https',
        'signature-input': signed['signature-input'],
        signature: signed.signature,
        'content-digest': signed['content-digest'],
      },
    });

    expect(res.status).toBe(200);
  });

  it('verifies a request whose signed target-uri is http, with the setting OFF (the default)', async () => {
    originalEnv = process.env[TRUST_PROXY_ENV_VAR];
    setTrustProxyEnv(undefined);

    const { identity: buyer, operatorRepo } = await registeredBuyer(42);
    const app = createApp(operatorRepo);
    const baseUrl = await listen(app);
    const address = server!.address() as AddressInfo;

    // With trust proxy OFF, req.protocol ignores X-Forwarded-Proto and
    // reports the real connection scheme (http, this test's raw socket).
    // Signing over http (even while claiming X-Forwarded-Proto: https)
    // matches what the server actually derives, so the signature verifies.
    const httpTargetUri = `http://127.0.0.1:${address.port}/accounts/me`;
    const signed = signRequest(buyer, 'GET', httpTargetUri, { components: ['@method', '@target-uri', 'content-digest'] });

    const res = await fetch(`${baseUrl}/accounts/me`, {
      headers: {
        'X-Forwarded-Proto': 'https',
        'signature-input': signed['signature-input'],
        signature: signed.signature,
        'content-digest': signed['content-digest'],
      },
    });

    expect(res.status).toBe(200);
  });

  it('a signature computed for https FAILS when the setting is OFF (proving the setting has a real effect, not a no-op)', async () => {
    originalEnv = process.env[TRUST_PROXY_ENV_VAR];
    setTrustProxyEnv(undefined);

    const { identity: buyer, operatorRepo } = await registeredBuyer(43);
    const app = createApp(operatorRepo);
    const baseUrl = await listen(app);
    const address = server!.address() as AddressInfo;

    // Signed for https, but the setting is off so the server derives http:
    // the signature base the server recomputes differs from what was
    // signed, and verification must fail (401, invalid signature), even
    // though the signing key itself is perfectly well known.
    const httpsTargetUri = `https://127.0.0.1:${address.port}/accounts/me`;
    const signed = signRequest(buyer, 'GET', httpsTargetUri, { components: ['@method', '@target-uri', 'content-digest'] });

    const res = await fetch(`${baseUrl}/accounts/me`, {
      headers: {
        'X-Forwarded-Proto': 'https',
        'signature-input': signed['signature-input'],
        signature: signed.signature,
        'content-digest': signed['content-digest'],
      },
    });
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(401);
    expect(body.error).toBe('invalid signature');
  });
});
