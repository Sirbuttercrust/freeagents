// R-18 (ENT-2.4): the profile page's presentation of the empty case, on top
// of R-17's three-tier API response. Same anchor as the domain layer's own
// test (tests/domain/agent-work-record.test.ts): an agent with no record
// renders as an agent with no record, and nothing about the rendering
// apologises for it.
//
// Two fixtures, one page. A cold-start agent (no credentials at all) and a
// full-record agent (one verified hire, one demoted portfolio item) are
// rendered through the SAME markup and script, and the assertions below
// compare their structure directly: same three section headings, same
// order, no reordering, no badge that exists on one and not the other.
// Proving the empty case is not a special layout means proving it against
// a real full profile, not describing what a full profile ought to do.
import type { Server } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import {
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
} from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';
import type { Job } from '../../src/domain/job.js';

const OPERATOR_DID = 'did:abt:zR18Operator';
const COLD_DID = 'did:abt:zR18ColdAgent';
const FULL_DID = 'did:abt:zR18FullAgent';
const PRIVATE_ONLY_DID = 'did:abt:zR18PrivateOnlyAgent';
const TWO_FORM_DID = 'did:abt:zR18TwoFormAgent';
const TWO_FORM_BUYER_SHORT = 'zR18TwoFormBuyer';
const TWO_FORM_BUYER_LONG = `did:abt:${TWO_FORM_BUYER_SHORT}`;

function delegation(agentDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:r18-${agentDid}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: OPERATOR_DID,
    issuanceDate: '2026-08-30T00:00:00.000Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-08-30T00:00:00.000Z',
      verificationMethod: `${OPERATOR_DID}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zProof',
    },
  };
}

function credentialDoc(
  id: string,
  subjectDid: string,
  repository: string,
  mergeCommit = 'r18cafe',
  buyerDid = 'did:example:r18-buyer',
): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id,
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: 'did:abt:platform',
    validFrom: '2026-08-30T00:00:00.000Z',
    credentialSubject: {
      id: subjectDid,
      hire: {
        brief: 'sha256:brief',
        repository,
        pullRequest: `https://github.com/${repository}/pull/1`,
        mergedAt: '2026-08-30T00:00:00.000Z',
        mergeCommit,
        signedBy: `${subjectDid}#key-1`,
        buyer: buyerDid,
        additions: 10,
        deletions: 2,
        filesChanged: 1,
      },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zProof' },
  };
}

function jobFixture(overrides: Partial<Job> & { id: string; agentDid: string }): Job {
  return {
    buyerDid: 'did:example:r18-buyer',
    repository: 'buyer/r18-repo',
    brief: 'Fix the checkout flow',
    briefHash: 'sha256:brief',
    confirmedSpecHash: null,
    status: 'draft',
    criteria: [],
    pullRequestUrl: null,
    mergeCommit: null,
    mergedAt: null,
    confirmedAt: null,
    submittedAt: null,
    deadline: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  };
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const agentRepo = new MemoryAgentRepository();
  const jobRepo = new MemoryJobRepository();
  const credentialRepo = new MemoryCredentialRepository();

  await agentRepo.create({
    did: COLD_DID,
    operatorDid: OPERATOR_DID,
    delegation: delegation(COLD_DID),
    name: 'cold-start-agent',
    skills: ['triage'],
    githubLogin: null,
  });

  await agentRepo.create({
    did: FULL_DID,
    operatorDid: OPERATOR_DID,
    delegation: delegation(FULL_DID),
    name: 'full-record-agent',
    skills: ['react'],
    githubLogin: null,
  });

  // One completed, publicly-visible hire: a real verified-hire row.
  const publicDraft = jobFixture({ id: 'r18-job-public', agentDid: FULL_DID });
  await jobRepo.create(publicDraft);
  await jobRepo.complete(
    { ...publicDraft, status: 'completed', mergeCommit: 'r18cafe', mergedAt: new Date('2026-08-30T00:00:00Z') },
    {
      jobId: publicDraft.id,
      buyerDid: publicDraft.buyerDid,
      agentDid: FULL_DID,
      mergeCommit: 'r18cafe',
      completedAt: new Date('2026-08-30T00:00:00Z'),
    },
  );
  await credentialRepo.save({
    completedJobId: 'r18-job-public',
    subjectDid: FULL_DID,
    document: credentialDoc('https://platform.example/v1/credentials/r18-job-public', FULL_DID, 'buyer/r18-repo'),
    repositoryPublic: true,
  });

  // One completed hire into a PRIVATE repository: demotes to portfolio
  // (evidenceTier, invariant 4), so the full-record fixture exercises all
  // three tiers, not only the verified one.
  const privateDraft = jobFixture({ id: 'r18-job-private', agentDid: FULL_DID });
  await jobRepo.create(privateDraft);
  await jobRepo.complete(
    { ...privateDraft, status: 'completed', mergeCommit: 'r18beef', mergedAt: new Date('2026-08-30T00:00:00Z') },
    {
      jobId: privateDraft.id,
      buyerDid: privateDraft.buyerDid,
      agentDid: FULL_DID,
      mergeCommit: 'r18beef',
      completedAt: new Date('2026-08-30T00:00:00Z'),
    },
  );
  await credentialRepo.save({
    completedJobId: 'r18-job-private',
    subjectDid: FULL_DID,
    document: credentialDoc('https://platform.example/v1/credentials/r18-job-private', FULL_DID, 'buyer/r18-private'),
    repositoryPublic: false,
  });

  await agentRepo.create({
    did: PRIVATE_ONLY_DID,
    operatorDid: OPERATOR_DID,
    delegation: delegation(PRIVATE_ONLY_DID),
    name: 'private-only-agent',
    skills: [],
    githubLogin: null,
  });

  // One completed hire, merged, but into a PRIVATE repository: the only
  // credential this agent has demotes to portfolio (evidenceTier,
  // invariant 4), so this agent has zero verified hires by the R-17
  // contract even though it has one completed job.
  const privateOnlyDraft = jobFixture({ id: 'r18-job-private-only', agentDid: PRIVATE_ONLY_DID });
  await jobRepo.create(privateOnlyDraft);
  await jobRepo.complete(
    { ...privateOnlyDraft, status: 'completed', mergeCommit: 'r18private', mergedAt: new Date('2026-08-30T00:00:00Z') },
    {
      jobId: privateOnlyDraft.id,
      buyerDid: privateOnlyDraft.buyerDid,
      agentDid: PRIVATE_ONLY_DID,
      mergeCommit: 'r18private',
      completedAt: new Date('2026-08-30T00:00:00Z'),
    },
  );
  await credentialRepo.save({
    completedJobId: 'r18-job-private-only',
    subjectDid: PRIVATE_ONLY_DID,
    document: credentialDoc('https://platform.example/v1/credentials/r18-job-private-only', PRIVATE_ONLY_DID, 'buyer/r18-private-only'),
    repositoryPublic: false,
  });

  await agentRepo.create({
    did: TWO_FORM_DID,
    operatorDid: OPERATOR_DID,
    delegation: delegation(TWO_FORM_DID),
    name: 'two-form-buyer-agent',
    skills: [],
    githubLogin: null,
  });

  // Two completed, publicly-visible hires, both verified: the SAME buyer
  // recorded under both DID forms across the two jobs (src/domain/agent.ts:
  // didSuffix, "z..." and "did:abt:z..." name the same key). The API's own
  // buyer-diversity read (buyer-diversity.ts:93-95, didSuffix reconciliation)
  // resolves this to one distinct buyer. The page must agree.
  const twoFormDraftA = jobFixture({ id: 'r18-job-twoform-a', agentDid: TWO_FORM_DID, buyerDid: TWO_FORM_BUYER_LONG });
  await jobRepo.create(twoFormDraftA);
  await jobRepo.complete(
    { ...twoFormDraftA, status: 'completed', mergeCommit: 'r18twoforma', mergedAt: new Date('2026-08-30T00:00:00Z') },
    {
      jobId: twoFormDraftA.id,
      buyerDid: TWO_FORM_BUYER_LONG,
      agentDid: TWO_FORM_DID,
      mergeCommit: 'r18twoforma',
      completedAt: new Date('2026-08-30T00:00:00Z'),
    },
  );
  await credentialRepo.save({
    completedJobId: 'r18-job-twoform-a',
    subjectDid: TWO_FORM_DID,
    document: credentialDoc(
      'https://platform.example/v1/credentials/r18-job-twoform-a',
      TWO_FORM_DID,
      'buyer/r18-twoform-a',
      'r18twoforma',
      TWO_FORM_BUYER_LONG,
    ),
    repositoryPublic: true,
  });

  const twoFormDraftB = jobFixture({ id: 'r18-job-twoform-b', agentDid: TWO_FORM_DID, buyerDid: TWO_FORM_BUYER_SHORT });
  await jobRepo.create(twoFormDraftB);
  await jobRepo.complete(
    { ...twoFormDraftB, status: 'completed', mergeCommit: 'r18twoformb', mergedAt: new Date('2026-08-30T00:00:00Z') },
    {
      jobId: twoFormDraftB.id,
      buyerDid: TWO_FORM_BUYER_SHORT,
      agentDid: TWO_FORM_DID,
      mergeCommit: 'r18twoformb',
      completedAt: new Date('2026-08-30T00:00:00Z'),
    },
  );
  await credentialRepo.save({
    completedJobId: 'r18-job-twoform-b',
    subjectDid: TWO_FORM_DID,
    document: credentialDoc(
      'https://platform.example/v1/credentials/r18-job-twoform-b',
      TWO_FORM_DID,
      'buyer/r18-twoform-b',
      'r18twoformb',
      TWO_FORM_BUYER_SHORT,
    ),
    repositoryPublic: true,
  });

  const app = createApp(undefined, agentRepo, undefined, undefined, jobRepo, undefined, undefined, credentialRepo);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function render(path: string): Promise<Document> {
  return renderFrom(baseUrl, path);
}

async function renderFrom(fromBaseUrl: string, path: string): Promise<Document> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  const response = await fetch(`${fromBaseUrl}${path}`, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
  expect(response.status, `unexpected status for ${path}`).toBe(200);
  const markup = await response.text();

  const dom = new JSDOM(markup, {
    url: `${fromBaseUrl}${path}`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      Object.defineProperty(window, 'fetch', {
        writable: true,
        value: (input: string, init?: RequestInit) => fetch(new URL(input, fromBaseUrl), init),
      });
    },
  });

  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 250));

  if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);

  return dom.window.document;
}

// A second server that proxies every request to the real one EXCEPT
// GET /agents/:did/hires, which it answers with the API's own storage
// error shape (503 {"error":"storage unavailable"}, src/api/app.ts:973).
// This is the only way to exercise "the /hires read failed" from outside
// the page script: the real server always answers it because the memory
// repositories never fail.
async function startFailingHiresServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const realPort = (server.address() as AddressInfo).port;

  const proxy = http.createServer((req, res) => {
    if (req.url !== undefined && /\/agents\/[^/]+\/hires$/.test(req.url)) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'storage unavailable' }));
      return;
    }

    const upstream = http.request(
      { hostname: '127.0.0.1', port: realPort, path: req.url, method: req.method, headers: req.headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    req.pipe(upstream);
  });

  await new Promise<void>((resolve) => proxy.listen(0, resolve));
  const proxyBaseUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

  return {
    baseUrl: proxyBaseUrl,
    close: () => new Promise<void>((resolve) => proxy.close(() => resolve())),
  };
}

// The three section heading ids, in the order a full profile has always
// used (DATA-CONTRACT section 4, spec/wireframe/agent.html): verified hires
// first, then verified prior work, then portfolio claims. Both fixtures are
// checked against this same list.
const TIER_HEADING_IDS = ['tier-hire-heading', 'tier-prior-heading', 'tier-claim-heading'];

// Node.DOCUMENT_POSITION_FOLLOWING per the DOM spec (a constant value, not
// tied to any particular window), used because jsdom's global scope here
// carries no ambient `Node`.
const DOCUMENT_POSITION_FOLLOWING = 0x04;

function headingOrder(document: Document): string[] {
  const nodes = TIER_HEADING_IDS.map((id) => {
    const node = document.getElementById(id);
    if (node === null) throw new Error(`missing heading #${id}`);
    return { id, node };
  });
  return [...nodes]
    .sort((a, b) => {
      const position = a.node.compareDocumentPosition(b.node);
      if (position & DOCUMENT_POSITION_FOLLOWING) return -1;
      return 1;
    })
    .map((entry) => entry.id);
}

const FORBIDDEN_PHRASES = [
  'new agent',
  "we're new",
  'just joined',
  'brand new',
  'rising',
  'getting started',
  'welcome to freeagents',
];

describe('an agent with no record (R-18, ENT-2.4)', () => {
  it('renders all three tier sections, each present, each showing its true zero state', async () => {
    const document = await render(`/agents/${COLD_DID}`);

    expect(document.getElementById('history-empty')?.hidden).toBe(false);
    expect(document.getElementById('prior-work-empty')?.hidden).toBe(false);
    expect(document.getElementById('portfolio-empty')?.hidden).toBe(false);

    expect(document.getElementById('history')?.children.length).toBe(0);
    expect(document.getElementById('prior-work')?.children.length).toBe(0);
    expect(document.getElementById('portfolio')?.children.length).toBe(0);
  });

  it('orders the three sections exactly as a full profile does: hires, then prior work, then portfolio', async () => {
    const document = await render(`/agents/${COLD_DID}`);
    expect(headingOrder(document)).toEqual(TIER_HEADING_IDS);
  });

  it('carries no "new" badge, no promotional framing, and no invented activity anywhere on the page', async () => {
    const document = await render(`/agents/${COLD_DID}`);
    const text = (document.body.textContent ?? '').toLowerCase();
    for (const phrase of FORBIDDEN_PHRASES) {
      expect(text, `page text should not contain "${phrase}"`).not.toContain(phrase);
    }
    // No element anywhere carries a badge-style class or attribute. A
    // "new"/"rising" treatment would need to hang a marker on something,
    // and this is that marker's total absence.
    expect(document.querySelectorAll('[class*="badge" i], [data-badge]').length).toBe(0);
  });

  it('does not collapse or hide the empty sections behind a getting-started hero', async () => {
    const document = await render(`/agents/${COLD_DID}`);
    // Every tier's empty-state block is a sibling in the normal flow, not
    // swapped out for a single combined placeholder.
    for (const id of ['history-empty', 'prior-work-empty', 'portfolio-empty']) {
      const node = document.getElementById(id);
      expect(node, `#${id} should exist on the page`).not.toBeNull();
    }
  });
});

describe('an agent WITH a record renders the same shape (contrast case)', () => {
  it('shows the same three section headings, in the same order, as the cold-start profile', async () => {
    const coldDocument = await render(`/agents/${COLD_DID}`);
    const fullDocument = await render(`/agents/${FULL_DID}`);

    expect(headingOrder(fullDocument)).toEqual(headingOrder(coldDocument));
    expect(headingOrder(fullDocument)).toEqual(TIER_HEADING_IDS);
  });

  it('populates the verified-hire and portfolio tiers with real rows, while prior work stays honestly empty (ENT-11 not yet wired)', async () => {
    const document = await render(`/agents/${FULL_DID}`);

    expect(document.getElementById('history')?.children.length).toBe(1);
    expect(document.getElementById('portfolio')?.children.length).toBe(1);
    // verifiedPriorWork is always [] until ENT-11 lands (agent-work-record.ts).
    // Its section still renders, honestly empty, exactly like the cold-start
    // page's does -- this is the proof that the empty state is not special
    // to a record-less agent.
    expect(document.getElementById('prior-work-empty')?.hidden).toBe(false);
    expect(document.getElementById('prior-work')?.children.length).toBe(0);
  });

  it('gives the verified-hire row a verify affordance and the portfolio row none (DATA-CONTRACT section 1)', async () => {
    const document = await render(`/agents/${FULL_DID}`);

    const hireRow = document.getElementById('history')?.firstElementChild;
    expect(hireRow?.querySelector('.verify')).not.toBeNull();

    const portfolioRow = document.getElementById('portfolio')?.firstElementChild;
    expect(portfolioRow?.querySelector('.verify')).toBeNull();
  });

  // The headline sentence (DESIGN 1.2, "the single most important sentence
  // on the page") must count the same thing the rows below it show, or the
  // page tells a buyer two different stories about the same agent. The one
  // real verified hire here is the fixture's ground truth for that count.
  it('counts the headline against the tier the rows come from, not the untiered completed-job total', async () => {
    const document = await render(`/agents/${FULL_DID}`);
    const summary = document.getElementById('summary')?.textContent ?? '';
    const verifiedHireRows = document.getElementById('history')?.children.length ?? -1;

    expect(verifiedHireRows).toBe(1);
    expect(summary).toContain('1 verified hire,');
    expect(summary).not.toContain('2 verified hires');
  });
});

// A hire that completed but merged into a private repository carries no
// verified-hire tier fact (evidenceTier, invariant 4): the agent has one
// completed job and zero verified hires. The rows already know this
// (R-18's own row fix). The headline sentence has to agree with them, or a
// buyer reading only the summary is told this agent has a verified hire it
// does not have, which is the anchor's failure mode by another name.
describe('an agent whose only credential demoted to portfolio (private-repo merge)', () => {
  it('does not claim a verified hire in the headline sentence', async () => {
    const document = await render(`/agents/${PRIVATE_ONLY_DID}`);

    expect(document.getElementById('history')?.children.length).toBe(0);
    expect(document.getElementById('history-empty')?.hidden).toBe(false);
    expect(document.getElementById('portfolio')?.children.length).toBe(1);

    const summary = document.getElementById('summary')?.textContent ?? '';
    expect(summary).toContain('0 verified hires');
    expect(summary).not.toMatch(/^1 verified hire\b/);
  });
});

// A hire's buyerDid can arrive in wallet form (z...) or registry form
// (did:abt:z...); both name the same key (src/domain/agent.ts:33-37). The
// API's own buyer-diversity read reconciles them with didSuffix before
// counting distinct buyers (buyer-diversity.ts:93-95) specifically so one
// buyer in two forms is not read as two (MISSION invariant 5). The page's
// headline sentence has to apply the same reconciliation, or it tells a
// buyer this agent has served more independent clients than it has.
describe('an agent whose one buyer is recorded under two DID forms', () => {
  it('counts one buyer in the headline sentence, not two', async () => {
    const document = await render(`/agents/${TWO_FORM_DID}`);

    expect(document.getElementById('history')?.children.length).toBe(2);

    const summary = document.getElementById('summary')?.textContent ?? '';
    expect(summary).toContain('2 verified hires,');
    expect(summary).toContain('from 1 buyer.');
    expect(summary).not.toContain('2 separate buyers');
  });
});

// api.js states this as rule 1 for every page: a failed read is said out
// loud, never rendered as an empty record, because an agent with nothing
// and an agent whose record could not be loaded must never look the same.
// The verified-hire count in the headline can still come from the R-17
// tier array (that fact does not depend on /hires), but the self-hire
// label depends on /hires, and when that read fails, the page must not
// present the absence of a self-hire label as the fact that there is none.
describe('an agent whose self-hire read fails', () => {
  it('does not present a self-hire-free summary as fact when /hires cannot be read', async () => {
    const proxy = await startFailingHiresServer();
    try {
      const document = await renderFrom(proxy.baseUrl, `/agents/${FULL_DID}`);

      const summary = document.getElementById('summary')?.textContent ?? '';
      const notice = document.getElementById('selfhires-error')?.textContent ?? '';

      // The verified-hire count still stands on its own tier fact.
      expect(summary).toContain('1 verified hire,');
      // But nothing on the page may claim, one way or the other, how many
      // of those were self-hires: that fact is unresolved, not zero.
      expect(document.getElementById('selfhires')?.hidden).toBe(true);
      expect(notice.toLowerCase()).toContain('could not be read');
    } finally {
      await proxy.close();
    }
  });
});
