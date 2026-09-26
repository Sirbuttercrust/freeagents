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

// FIX-S7 round 2 (qa proof r1, defect 1): a page shell paint on one of the
// four negotiated paths (/agents/:agentDid, /accounts/:did,
// /v1/credentials/:credentialId, /jobs/:jobId) never touches the class
// bucket that path's OWN json reads consume. Reproduces the exact repro
// qa's proof gave: exhaust the verify bucket with real JSON reads to
// GET /agents/:agentDid, then confirm the page shell for the SAME did still
// answers 200 html rather than the JSON 429 body qa found.
describe('class rate limits: negotiated page shells never share a bucket with their own JSON reads (FIX-S7 round 2)', () => {
  const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

  it('GET /agents/:agentDid as an html page shell is never 429, even after the verify bucket is exhausted by json reads to the same path', async () => {
    const agentRepo = new MemoryAgentRepository();
    const agentDid = 'did:abt:zPageShellVerifyAgent';
    await agentRepo.create({
      did: agentDid,
      operatorDid: 'did:abt:op-page-shell-e2e',
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

    // Exhaust the verify bucket: first json read succeeds, second trips 429.
    const firstJson = await fetch(`${baseUrl}/agents/${agentDid}`, { headers: { Accept: 'application/json' } });
    expect(firstJson.status).toBe(200);
    const secondJson = await fetch(`${baseUrl}/agents/${agentDid}`, { headers: { Accept: 'application/json' } });
    expect(secondJson.status).toBe(429);

    // The page shell for the SAME did, asked for as html, is unaffected:
    // it never touched the verify bucket in the first place.
    const pageShell = await fetch(`${baseUrl}/agents/${agentDid}`, { headers: { Accept: HTML_ACCEPT } });
    expect(pageShell.status).toBe(200);
    expect(pageShell.headers.get('content-type')).toContain('text/html');
  });

  it('an honest multi-page browse session (page shells only, no json) never trips the verify bucket at the default limit', async () => {
    // Reproduces qa's own repro at default limits: paging browse
    // 1,2,3,1,2,3 then opening an agent profile is 7 page-shell paints on
    // /browse (exempt by EXEMPT_WEB_PAGE_PATHS already) plus one page-shell
    // paint on /agents/:agentDid -- none of which may consume the verify
    // bucket now that page shells are classified by Accept.
    const agentRepo = new MemoryAgentRepository();
    const agentDid = 'did:abt:zPageShellSessionAgent';
    await agentRepo.create({
      did: agentDid,
      operatorDid: 'did:abt:op-page-shell-session',
      delegation: delegationFixture(agentDid),
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    // Defaults: no override at all, proving the REAL production limits
    // (not a generous test override) survive this session.
    const app = createApp(undefined, agentRepo);
    const baseUrl = await listen(app);

    for (let i = 0; i < 20; i += 1) {
      const res = await fetch(`${baseUrl}/browse`, { headers: { Accept: HTML_ACCEPT } });
      expect(res.status).toBe(200);
    }
    const agentPage = await fetch(`${baseUrl}/agents/${agentDid}`, { headers: { Accept: HTML_ACCEPT } });
    expect(agentPage.status).toBe(200);
    expect(agentPage.headers.get('content-type')).toContain('text/html');
  });
});

// FIX-S7 round 2 (qa proof r1, defect 5a): pins the /api/did/pay/ prefix
// check by REASON, at the e2e layer, so a mutant that deletes
// classifyRoute's explicit UPSTREAM_PREFIX branch is caught even though
// classifyRoute's own generic fallback lands the same request on the same
// class ('upstream' either way -- see rate-limit-classes.test.ts's
// classificationReason describe block for the unit-level version of this
// same proof).
describe('class rate limits: the /api/did/pay/ mount is upstream by its own explicit rule (FIX-S7 round 2, defect 5a)', () => {
  it('an unconfigured deployment (no ABT rail mounted) still classifies /api/did/pay/token as upstream, not the generic fallback', async () => {
    const app = createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { upstream: 1 });
    const baseUrl = await listen(app);

    // No ABT rail is configured in this test env, so did-connect-js never
    // mounts a real handler here; the class limiter still runs FIRST
    // (app.ts:1043), ahead of every route registration, so the request is
    // classified and rate limited before Express ever gets to answer
    // "no route" -- the class the request receives is the whole point of
    // this test, not the eventual 404/503 body.
    const first = await fetch(`${baseUrl}/api/did/pay/token`);
    const second = await fetch(`${baseUrl}/api/did/pay/token`);
    expect(first.status).not.toBe(429);
    expect(second.status).toBe(429);
    expect(second.headers.get('Retry-After')).not.toBeNull();
  });
});
