// S7 (security sweep 2026-09-06): end-to-end proof, over real HTTP through
// createApp, that each route class has its own independent bucket -- not
// just a unit-level proof against the middleware function in isolation
// (tests/api/rate-limit-middleware.test.ts already covers that; this file
// proves the SAME thing through the real app, with real route handlers,
// so a wiring mistake in app.ts itself would be caught here even if the
// middleware unit tests all still passed).
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';

function delegationFixture(agentDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-class-limits-e2e',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: 'did:abt:op-class-limits-e2e',
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

afterEach(async () => {
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

describe('class rate limits, end to end over real HTTP (S7)', () => {
  it('GET /browse (a web page shell) is never rate limited, even with every class exhausted', async () => {
    const app = createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      read: 0,
      write: 0,
      upstream: 0,
      verify: 0,
    });
    const baseUrl = await listen(app);

    const first = await fetch(`${baseUrl}/browse`);
    const second = await fetch(`${baseUrl}/browse`);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it('a static asset (/css/*) is never rate limited, even with every class exhausted', async () => {
    const app = createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      read: 0,
      write: 0,
      upstream: 0,
      verify: 0,
    });
    const baseUrl = await listen(app);

    const first = await fetch(`${baseUrl}/css/base.css`);
    const second = await fetch(`${baseUrl}/css/base.css`);
    // Neither response is a 429; whether the file exists (200) or not
    // (404-ish fallthrough), rate limiting is not what stops it.
    expect(first.status).not.toBe(429);
    expect(second.status).not.toBe(429);
  });

  it('exhausting the read class (GET /agents) never throttles the write class (POST /accounts) for the same caller', async () => {
    const app = createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      read: 1,
      write: 100,
      upstream: 100,
      verify: 100,
    });
    const baseUrl = await listen(app);

    const firstRead = await fetch(`${baseUrl}/agents`);
    expect(firstRead.status).toBe(200);
    const secondRead = await fetch(`${baseUrl}/agents`);
    expect(secondRead.status).toBe(429);
    expect(secondRead.headers.get('Retry-After')).not.toBeNull();

    // A write, from the SAME caller, is entirely unaffected by the
    // exhausted read bucket.
    const write = await fetch(`${baseUrl}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: 'did:abt:zClassLimitsBuyer' }),
    });
    expect(write.status).not.toBe(429);
  });

  it('exhausting the verify class (GET /agents/:agentDid) never throttles the read class (GET /agents) for the same caller', async () => {
    const agentRepo = new MemoryAgentRepository();
    const agentDid = 'did:abt:zClassLimitsVerifyAgent';
    await agentRepo.create({
      did: agentDid,
      operatorDid: 'did:abt:op-class-limits-e2e',
      delegation: delegationFixture(agentDid),
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const app = createApp(undefined, agentRepo, undefined, undefined, undefined, undefined, undefined, undefined, {
      verify: 1,
      read: 100,
      write: 100,
      upstream: 100,
    });
    const baseUrl = await listen(app);

    const firstVerify = await fetch(`${baseUrl}/agents/${agentDid}`);
    expect(firstVerify.status).toBe(200);
    const secondVerify = await fetch(`${baseUrl}/agents/${agentDid}`);
    expect(secondVerify.status).toBe(429);

    const read = await fetch(`${baseUrl}/agents`);
    expect(read.status).toBe(200);
  });

  it('GET /health is never rate limited, even with every class exhausted', async () => {
    const app = createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      read: 0,
      write: 0,
      upstream: 0,
      verify: 0,
    });
    const baseUrl = await listen(app);

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
  });

  it('POST /accounts (the sweep\'s own named write route) is in the write class, not unlimited', async () => {
    const operatorRepo = new MemoryAccountRepository();
    const app = createApp(operatorRepo, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { write: 1 });
    const baseUrl = await listen(app);

    const first = await fetch(`${baseUrl}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: 'did:abt:zWriteClassBuyerOne' }),
    });
    expect(first.status).not.toBe(429);

    const second = await fetch(`${baseUrl}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: 'did:abt:zWriteClassBuyerTwo' }),
    });
    expect(second.status).toBe(429);
  });
});
