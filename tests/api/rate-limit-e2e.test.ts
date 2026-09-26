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

  it('exhausting the verify class (GET /v1/credentials/:credentialId) never throttles the read class (GET /agents/:agentDid) for the same caller', async () => {
    // FIX-S7 round 3 (Temper's ruling): GET /agents/:agentDid moved from
    // `verify` to `read`, so this test now exercises the verify class
    // through GET /v1/credentials/:credentialId instead (still verify,
    // answers 404 for an unknown id rather than needing a real credential
    // fixture) and proves the READ class survives it untouched.
    const agentRepo = new MemoryAgentRepository();
    const agentDid = 'did:abt:zClassLimitsReadAgent';
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

    const firstVerify = await fetch(`${baseUrl}/v1/credentials/never-issued`);
    expect(firstVerify.status).toBe(404);
    const secondVerify = await fetch(`${baseUrl}/v1/credentials/never-issued`);
    expect(secondVerify.status).toBe(429);

    const read = await fetch(`${baseUrl}/agents/${agentDid}`);
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

// FIX-S7 round 2 (qa proof r1, defect 1) + round 3 (Temper's ruling): a
// page shell paint on one of the four negotiated paths (/agents/:agentDid,
// /accounts/:did, /v1/credentials/:credentialId, /jobs/:jobId) never
// touches the class bucket that path's OWN json reads consume. Reproduces
// the exact repro qa's proof gave: exhaust the bucket GET /agents/:agentDid
// now belongs to (`read`, since Temper's ruling) with real JSON reads,
// then confirm the page shell for the SAME did still answers 200 html
// rather than a JSON 429 body.
describe('class rate limits: negotiated page shells never share a bucket with their own JSON reads (FIX-S7 round 2)', () => {
  const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

  it('GET /agents/:agentDid as an html page shell is never 429, even after the read bucket is exhausted by json reads to the same path', async () => {
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
      verify: 100,
      read: 1,
      write: 100,
      upstream: 100,
    });
    const baseUrl = await listen(app);

    // Exhaust the read bucket (GET /agents/:agentDid's own class, since
    // Temper's ruling): first json read succeeds, second trips 429.
    const firstJson = await fetch(`${baseUrl}/agents/${agentDid}`, { headers: { Accept: 'application/json' } });
    expect(firstJson.status).toBe(200);
    const secondJson = await fetch(`${baseUrl}/agents/${agentDid}`, { headers: { Accept: 'application/json' } });
    expect(secondJson.status).toBe(429);

    // The page shell for the SAME did, asked for as html, is unaffected:
    // it never touched the read bucket in the first place.
    const pageShell = await fetch(`${baseUrl}/agents/${agentDid}`, { headers: { Accept: HTML_ACCEPT } });
    expect(pageShell.status).toBe(200);
    expect(pageShell.headers.get('content-type')).toContain('text/html');
  });

  it('page shells alone (no json) never trip the verify bucket at the default limit', async () => {
    // The page-shell half of qa's repro (proof r1): paging browse
    // 1,2,3,1,2,3 then opening an agent profile is 7 page-shell paints on
    // /browse (exempt by EXEMPT_WEB_PAGE_PATHS already) plus one page-shell
    // paint on /agents/:agentDid -- none of which may consume any bucket
    // now that page shells are classified by Accept. This test drives NO
    // page script (Node fetch runs none), so it does not by itself prove
    // an honest session survives; see the next describe block for the
    // test that replays the JSON reads a real page load fires.
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

// FIX-S7 round 3 (Temper's ruling; qa proof r2's HIGH defect, "the verify
// budget must also hold up across an honest multi-page session"). qa's own
// repro: the page-shell-only e2e test above passes whether or not a real
// session works, because Node fetch runs no page script and so never fires
// the per-card avatar reads browse.js's own script makes. This test
// replays those JSON reads directly (the same counts
// tests/web/rate-limit-burst-measurement.test.ts measures in real Chrome:
// 1 GET /agents + 10 GET /agents/:agentDid per browse page), at DEFAULT
// limits, and asserts every one succeeds. Before Temper's ruling moved GET
// /agents/:agentDid to `read`, six browse pages (60 avatar reads) plus the
// agent page's own read (61st) tripped the pre-existing 60/minute verify
// bucket exactly as qa's real-Chrome repro found; this test fails the same
// way if the route is ever moved back.
describe('class rate limits: an honest multi-page browse session, JSON reads replayed, never meets a 429 at default limits (FIX-S7 round 3)', () => {
  it('six browse page loads (10 cards each) followed by one agent page: every JSON read succeeds at DEFAULT limits', async () => {
    const agentRepo = new MemoryAgentRepository();
    const agents: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const did = `did:abt:zHonestSessionAgent${i}`;
      agents.push(did);
      await agentRepo.create({
        did,
        operatorDid: 'did:abt:op-honest-session',
        delegation: delegationFixture(did),
        name: `scout-${i}`,
        skills: ['triage'],
        githubLogin: null,
      });
    }
    // Defaults: no override at all, proving the REAL production limits
    // (not a generous test override) survive this session.
    const app = createApp(undefined, agentRepo);
    const baseUrl = await listen(app);
    const JSON_ACCEPT = 'application/json';

    // 6 browse page loads, each firing browse.js's own reads: 1 GET
    // /agents (the listing) + 10 GET /agents/:agentDid (one per card,
    // browse.js:376). 6 x 11 = 66 JSON reads before the agent page itself.
    for (let page = 0; page < 6; page += 1) {
      const listing = await fetch(`${baseUrl}/agents`, { headers: { Accept: JSON_ACCEPT } });
      expect(listing.status).toBe(200);
      for (const did of agents) {
        const avatar = await fetch(`${baseUrl}/agents/${did}`, { headers: { Accept: JSON_ACCEPT } });
        expect(avatar.status, `page ${page + 1}, avatar read for ${did}`).toBe(200);
      }
    }

    // The agent page's own JSON read (the one qa's real-Chrome repro found
    // rendered "AGENT NOT FOUND" instead of the record).
    const agentPageRead = await fetch(`${baseUrl}/agents/${agents[0]}`, { headers: { Accept: JSON_ACCEPT } });
    expect(agentPageRead.status).toBe(200);
  });
});

// FIX-S7 round 2 (qa proof r1, defect 5a) + round 2 review (qa proof r2,
// item 2b): this e2e test proves classifyRoute puts /api/did/pay/* in the
// upstream class, but it CANNOT pin the explicit UPSTREAM_PREFIX check by
// itself: deleting that check still lands the same request on `upstream`
// via the generic unrecognised-route fallback (rate-limit-classes.ts's own
// classifyRouteWithReason), so the HTTP status this level observes is
// identical either way. Only the unit-level classificationReason assertion
// (tests/api/rate-limit-classes.test.ts's "classificationReason" describe
// block, asserting 'upstream-prefix' rather than 'fallback-unclassified')
// actually distinguishes the two, and the PR body says so plainly per
// FACTORY_RULES rule 1 rather than repeating qa's r2 finding that this
// level pins it.
describe('class rate limits: the /api/did/pay/ mount is upstream (FIX-S7 round 2, defect 5a)', () => {
  it('an unconfigured deployment (no ABT rail mounted) still classifies /api/did/pay/token as upstream', async () => {
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
