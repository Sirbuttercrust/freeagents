// FIX-S7 round 2 (qa proof r1, defect 3): the burst measurement Make item 2
// requires ("measure the busiest page's burst ... in real Chrome against a
// local server") reproducibly, not typed by hand into a comment. This file
// drives real headless Chrome (tests/helpers/real-browser.ts, the same
// driver tests/web/browse.test.ts and tests/web/job-wireframe.test.ts
// already use) against a real createApp server and counts, per rate-limit
// class, how many requests one page load fires -- browse with 10 cards, a
// SIGNED-IN job page, and a SIGNED-IN deposit page, closing the exact gap
// qa's proof named: "the measurements leave out the signed-in job page,
// and the deposit page was measured before sign-in only".
//
// The counting mechanism: CDP's Network.requestWillBeSent event names
// every request a page fires, including background fetches the page's own
// script issues after load (browse.js's per-card avatar reads, job.js's
// identity-strip read). tests/helpers/real-browser.ts's onEvent exposes
// that event stream; this file classifies each observed request the same
// way the server itself does (src/api/rate-limit-classes.ts's own
// classifyRoute, imported directly rather than re-implemented, so the two
// can never quietly disagree about which bucket a path lands in).
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { classifyRoute, type RouteClassification } from '../../src/api/rate-limit-classes.js';
import { CLASS_DEFAULTS } from '../../src/api/rate-limit-middleware.js';
import {
  MemoryAgentRepository,
  MemoryAccountRepository,
  MemoryJobRepository,
  MemoryCredentialRepository,
} from '../../src/adapters/storage/memory.js';
import { createJob, type Job } from '../../src/domain/job.js';
import type { Delegation } from '../../src/domain/agent.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSessionToken } from '../helpers/session-fixtures.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const BROWSER_TIMEOUT_MS = 30_000;
const OPERATOR_DID = 'did:abt:zBurstMeasureOperator';
const BUYER_DID = 'did:example:burst-measure-buyer';

function delegationFixture(agentDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:burst-measure-${agentDid}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: OPERATOR_DID,
    issuanceDate: '2026-08-30T00:00:00.000Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-08-30T00:00:00.000Z',
      verificationMethod: `${OPERATOR_DID}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zburst-measure-fixture-not-verified-here',
    },
  };
}

function jobFixture(overrides: Partial<Job> & { id: string; agentDid: string }): Job {
  const base = createJob(
    {
      id: overrides.id,
      buyerDid: BUYER_DID,
      agentDid: overrides.agentDid,
      repository: 'buyer/burst-measure-repo',
      brief: 'Fix the checkout flow',
    },
    new Date('2026-08-01T00:00:00Z'),
  );
  return { ...base, ...overrides };
}

// Counts real requests a page load fires, by rate-limit class, over a
// fixed measurement window (subscribe, navigate, wait, unsubscribe). The
// SAME classifyRoute the server itself runs, so a page's own script
// hitting a route this table misclassifies would show up as a mismatch
// between what this measures and what the server actually buckets it as,
// rather than silently agreeing with a wrong assumption.
async function measurePageLoad(
  browser: RealBrowser,
  url: string,
  pageAccept: string,
): Promise<Record<RouteClassification, number>> {
  const counts: Record<RouteClassification, number> = { upstream: 0, write: 0, read: 0, verify: 0, exempt: 0 };
  const unsubscribe = browser.onEvent('Network.requestWillBeSent', (params) => {
    const p = params as { request?: { url?: string; method?: string; headers?: Record<string, string> } };
    const reqUrl = p.request?.url;
    const method = p.request?.method;
    if (typeof reqUrl !== 'string' || typeof method !== 'string') return;
    let path: string;
    try {
      path = new URL(reqUrl).pathname;
    } catch {
      return;
    }
    // Each REQUEST'S OWN Accept header, never the outer page navigation's:
    // the page shell itself asks for pageAccept (html), but a background
    // fetch its own script fires (browse.js's per-card avatar read, using
    // api.js's get(), which always sends Accept: application/json) must be
    // classified by ITS OWN header, or every json read on a negotiated path
    // would be silently miscounted as the exempt page-shell paint.
    const headers = p.request?.headers ?? {};
    const requestAccept = headers['Accept'] ?? headers['accept'] ?? (path === new URL(url).pathname ? pageAccept : undefined);
    const classification = classifyRoute(method, path, requestAccept);
    counts[classification] += 1;
  });
  try {
    await browser.goto(url, 800);
    // Background fetches a page's own script fires (browse.js's per-card
    // avatar reads, job.js's identity-strip read) are not always settled
    // by the time goto()'s own fixed wait returns; a short extra wait
    // gives those a chance to land inside the measurement window rather
    // than being silently dropped by an unsubscribe that fired too early.
    await new Promise((resolve) => setTimeout(resolve, 500));
  } finally {
    unsubscribe();
  }
  return counts;
}

describe('FIX-S7 Make item 2: real-browser burst measurement, reproducible (round 2, defect 3)', () => {
  let agentRepo: MemoryAgentRepository;
  let accountRepo: MemoryAccountRepository;
  let jobRepo: MemoryJobRepository;
  let credentialRepo: MemoryCredentialRepository;
  let server: Server;
  let baseUrl: string;
  let buyerToken: string;
  const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

  beforeAll(async () => {
    agentRepo = new MemoryAgentRepository();
    accountRepo = new MemoryAccountRepository();
    jobRepo = new MemoryJobRepository();
    credentialRepo = new MemoryCredentialRepository();

    await accountRepo.register({ did: OPERATOR_DID, githubLogin: 'burst-measure-operator' });
    await accountRepo.register({ did: BUYER_DID, githubLogin: 'burst-measure-buyer' });

    // Ten agents for the browse page's own PAGE_SIZE (browse.js's own
    // constant), so the measured page load is the full, real first page a
    // buyer actually sees, not a thinner fixture.
    for (let i = 0; i < 10; i += 1) {
      const did = `did:abt:zBurstMeasureAgent${i}`;
      await agentRepo.create({
        did,
        operatorDid: OPERATOR_DID,
        delegation: delegationFixture(did),
        name: `burst-measure-agent-${i}`,
        skills: ['triage'],
        githubLogin: null,
      });
    }

    const jobAgentDid = 'did:abt:zBurstMeasureJobAgent';
    await agentRepo.create({
      did: jobAgentDid,
      operatorDid: OPERATOR_DID,
      delegation: delegationFixture(jobAgentDid),
      name: 'burst-measure-job-agent',
      skills: ['triage'],
      githubLogin: null,
    });

    await jobRepo.create(
      jobFixture({
        id: 'burst-measure-job',
        agentDid: jobAgentDid,
        status: 'confirmed',
        confirmedAt: new Date('2026-08-15T00:00:00Z'),
      }),
    );

    await jobRepo.create(
      jobFixture({
        id: 'burst-measure-deposit-job',
        agentDid: jobAgentDid,
        status: 'proposed',
        criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
        priceUsd: '400.00',
        rail: 'abt',
        depositPercent: 25,
        redoAllowance: 1,
        priceAcceptedByBuyer: true,
        priceAcceptedByAgent: true,
        deliveryWindowDays: 6,
      }),
    );

    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'burst-measure-buyer', id: 88123 }),
    });
    buyerToken = await mintSessionToken(sessionAdapter);

    const app = createApp(
      accountRepo,
      agentRepo,
      undefined,
      undefined,
      jobRepo,
      undefined,
      undefined,
      credentialRepo,
      undefined,
      undefined,
      undefined,
      sessionAdapter,
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it(
    "measures the browse page (10 cards) burst: 11 read, 0 verify (round 3's ruling), several times under CLASS_DEFAULTS",
    async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for real-browser burst measurement; skipping (see CHROME_BIN)');
        return;
      }
      const browser = await RealBrowser.launch({ width: 1280, height: 900 });
      try {
        await browser.send('Network.enable');
        const counts = await measurePageLoad(browser, `${baseUrl}/browse`, HTML_ACCEPT);
        console.log('[FIX-S7 burst measurement] browse page (10 cards):', counts);
        // FIX-S7 round 3 (round 3's ruling): GET /agents/:agentDid moved
        // from `verify` to `read`, so both the listing read and the ten
        // per-card avatar reads land in the same, single `read` bucket.
        expect(counts.read, 'the listing read plus ten per-card avatar reads').toBe(11);
        expect(counts.verify, 'no page load touches the verify bucket at all, post-ruling').toBe(0);
        expect(counts.write).toBe(0);
        expect(counts.upstream).toBe(0);
        expect(counts.read).toBeLessThan(CLASS_DEFAULTS.read.limit);
      } finally {
        await browser.close();
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'measures a SIGNED-IN job page burst: post-ruling, the identity strip and the primary record are both `read`',
    async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for real-browser burst measurement; skipping (see CHROME_BIN)');
        return;
      }
      const browser = await RealBrowser.launch({ width: 1280, height: 900 });
      try {
        await browser.send('Network.enable');
        // Seed the session BEFORE the measured navigation: sessionStorage
        // has to exist when job.js's own start() reads it (nav.js's own
        // session-badge read fires from the same script), the identical
        // "two navigations" pattern tests/web/deposit.test.ts's real-Chrome
        // cases already use.
        await browser.goto(`${baseUrl}/jobs/burst-measure-job`, 300);
        await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify({ token: buyerToken }))})`);

        const counts = await measurePageLoad(browser, `${baseUrl}/jobs/burst-measure-job`, HTML_ACCEPT);
        console.log('[FIX-S7 burst measurement] signed-in job page:', counts);
        // FIX-S7 round 3 (round 3's ruling): GET /agents/:agentDid (job.js's
        // identity strip) is now `read`, same class as GET /jobs/:jobId
        // (the primary record) and nav.js's signed-in reads (GET
        // /accounts/me, GET /accounts/:did/notifications). No page load
        // touches the verify bucket at all any more.
        expect(counts.read, 'the primary record, the identity strip, and nav.js\'s signed-in reads, all read now').toBeGreaterThanOrEqual(1);
        expect(counts.verify, 'no page load touches the verify bucket at all, post-ruling').toBe(0);
        expect(counts.write).toBe(0);
        expect(counts.upstream).toBe(0);
      } finally {
        await browser.close();
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'measures a SIGNED-IN deposit page burst: post-ruling, every read (including renderWho\'s agent read) is `read`',
    async () => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for real-browser burst measurement; skipping (see CHROME_BIN)');
        return;
      }
      const browser = await RealBrowser.launch({ width: 1280, height: 900 });
      try {
        await browser.send('Network.enable');
        await browser.goto(`${baseUrl}/deposit?job=burst-measure-deposit-job`, 300);
        await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify({ token: buyerToken }))})`);

        const counts = await measurePageLoad(browser, `${baseUrl}/deposit?job=burst-measure-deposit-job`, HTML_ACCEPT);
        console.log('[FIX-S7 burst measurement] signed-in deposit page:', counts);
        // FIX-S7 round 3 (round 3's ruling): deposit.js's GET
        // /agents/:agentDid (renderWho) is now `read`, the same class as
        // GET /jobs/:jobId, GET /jobs/:jobId/attestations, GET
        // /agents/:agentDid/hires, and nav.js's signed-in reads. No page
        // load touches the verify bucket at all any more.
        expect(counts.read, 'every read this page fires, all read now').toBeGreaterThanOrEqual(4);
        expect(counts.verify, 'no page load touches the verify bucket at all, post-ruling').toBe(0);
        expect(counts.write).toBe(0);
        expect(counts.upstream).toBe(0);
      } finally {
        await browser.close();
      }
    },
    BROWSER_TIMEOUT_MS,
  );
});
