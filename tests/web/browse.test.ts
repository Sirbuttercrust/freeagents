// R-20 (ENT-2.2, D1): what the browse page actually RENDERS, with the real
// script running against the real API. Mirrors tests/web/agent-cold-start.
// test.ts and tests/web/render.test.ts for style: jsdom loads the served
// page, lets its own script run, and the assertions read the DOM a visitor
// is left looking at rather than the JSON the API returned.
import type { Server } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';
import { createApp } from '../../src/api/app.js';
import {
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
  MemoryAccountRepository,
} from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';

const OPERATOR_DID = 'did:abt:zBrowsePageOperator';
const COLD_DID = 'did:abt:zBrowsePageColdAgent';
const HIRED_DID = 'did:abt:zBrowsePageHiredAgent';

function delegation(agentDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:browse-page-${agentDid}`,
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

function credentialDoc(id: string, subjectDid: string, mergeCommit: string, buyerDid: string): VerifiableCredential {
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
        repository: 'buyer/target-repo',
        pullRequest: 'https://github.com/buyer/target-repo/pull/1',
        mergedAt: '2026-08-30T00:00:00.000Z',
        mergeCommit,
        signedBy: `${subjectDid}#key-1`,
        buyer: buyerDid,
        additions: 4,
        deletions: 1,
        filesChanged: 1,
      },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zProof' },
  };
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const agentRepo = new MemoryAgentRepository();
  const credentialRepo = new MemoryCredentialRepository();
  const jobRepo = new MemoryJobRepository();

  await agentRepo.create({
    did: COLD_DID,
    operatorDid: OPERATOR_DID,
    delegation: delegation(COLD_DID),
    name: 'Cold Start Agent',
    skills: ['typescript'],
    githubLogin: null,
  });

  await agentRepo.create({
    did: HIRED_DID,
    operatorDid: OPERATOR_DID,
    delegation: delegation(HIRED_DID),
    name: 'Hired Agent',
    skills: ['python', 'triage'],
    githubLogin: null,
  });
  await credentialRepo.save({
    completedJobId: 'browse-page-job-1',
    subjectDid: HIRED_DID,
    document: credentialDoc('https://platform.example/v1/credentials/browse-page-job-1', HIRED_DID, 'browse-page-commit-1', 'did:example:buyer-a'),
    repositoryPublic: true,
  });
  // The buyer count (PR 89) comes from completed jobs, not from the
  // credential store: a real completed job is what buyerDiversity()
  // actually resolves.
  await jobRepo.create({
    id: 'browse-page-job-1',
    buyerDid: 'did:example:buyer-a',
    agentDid: HIRED_DID,
    repository: 'buyer/target-repo',
    brief: 'Fix the checkout flow',
    briefHash: 'sha256:brief',
    confirmedSpecHash: null,
    status: 'draft',
    criteria: [],
    priceUsd: null,
    rail: null,
    priceAcceptedByBuyer: false,
    priceAcceptedByAgent: false,
    depositPercent: 25,
    redoAllowance: 1,
    redoUsedCount: 0,
    redoRequestedCriterionIndex: null,
    redoRequestedAt: null,
    redoRefusedAt: null,
    stagedLapseExtensionDays: 0,
    deliveryWindowDays: null,
    pullRequestUrl: null,
    mergeCommit: null,
    mergedAt: null,
    confirmedAt: null,
    submittedAt: null,
    deadline: null,
    createdAt: new Date('2026-08-29T00:00:00Z'),
    stagedAt: null,
    stagedCommit: null,
    stagingRepo: null,
    baseCommit: null,
    stagingRepoDeleteAfter: null,
    citedCloseCriterionIndex: null,
    citedCloseReasonText: null,
    citedCloseAuthorDid: null,
    citedCloseAt: null,
    deemedCompletedAt: null,
  });
  await jobRepo.complete(
    {
      id: 'browse-page-job-1',
      buyerDid: 'did:example:buyer-a',
      agentDid: HIRED_DID,
      repository: 'buyer/target-repo',
      brief: 'Fix the checkout flow',
      briefHash: 'sha256:brief',
      confirmedSpecHash: null,
      status: 'completed',
      criteria: [],
      priceUsd: null,
      rail: null,
      priceAcceptedByBuyer: false,
      priceAcceptedByAgent: false,
      depositPercent: 25,
      redoAllowance: 1,
      redoUsedCount: 0,
      redoRequestedCriterionIndex: null,
      redoRequestedAt: null,
      redoRefusedAt: null,
      stagedLapseExtensionDays: 0,
      deliveryWindowDays: null,
      pullRequestUrl: null,
      mergeCommit: 'browse-page-commit-1',
      mergedAt: new Date('2026-08-30T00:00:00Z'),
      confirmedAt: null,
      submittedAt: null,
      deadline: null,
      createdAt: new Date('2026-08-29T00:00:00Z'),
      stagedAt: null,
      stagedCommit: null,
      stagingRepo: null,
      baseCommit: null,
      stagingRepoDeleteAfter: null,
      citedCloseCriterionIndex: null,
      citedCloseReasonText: null,
      citedCloseAuthorDid: null,
      citedCloseAt: null,
      deemedCompletedAt: null,
    },
    {
      jobId: 'browse-page-job-1',
      buyerDid: 'did:example:buyer-a',
      agentDid: HIRED_DID,
      mergeCommit: 'browse-page-commit-1',
      completedAt: new Date('2026-08-30T00:00:00Z'),
    },
  );

  const app = createApp(new MemoryAccountRepository(), agentRepo, undefined, undefined, jobRepo, undefined, undefined, credentialRepo);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Rendered {
  document: Document;
  close: () => void;
}

async function render(path: string, base: string = baseUrl): Promise<Rendered> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  const response = await fetch(`${base}${path}`, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
  expect(response.status, `unexpected status for ${path}`).toBe(200);
  const markup = await response.text();

  const dom = new JSDOM(markup, {
    url: `${base}${path}`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      Object.defineProperty(window, 'fetch', {
        writable: true,
        value: (input: string, init?: RequestInit) => fetch(new URL(input, base), init),
      });
    },
  });

  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 250));

  if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);

  return { document: dom.window.document, close: () => dom.window.close() };
}

describe('the browse page (W2, built from spec/wireframe/browse.html)', () => {
  it('renders one card per agent, each carrying the evidence row on the card itself', async () => {
    const page = await render('/browse');
    try {
      const cards = page.document.querySelectorAll('[data-agent-card]');
      expect(cards.length).toBe(2);

      const hiredCard = Array.from(cards).find((c) => c.getAttribute('data-agent-card') === HIRED_DID);
      expect(hiredCard).toBeTruthy();
      const text = hiredCard?.textContent ?? '';
      // The evidence-tier count is on the card itself, not behind a click
      // (tier-hire: "N verified hires", the brief's own per-tier table).
      expect(text).toContain('1 verified hire');
      expect(hiredCard?.querySelector('.tier')?.className).toContain('tier-hire');
    } finally {
      page.close();
    }
  });

  it('the filter bar labels skills as self-asserted', async () => {
    const page = await render('/browse');
    try {
      const label = page.document.body.textContent ?? '';
      expect(label.toLowerCase()).toContain('self-asserted');
    } finally {
      page.close();
    }
  });

  it('the sort control offers exactly the three named keys, and no popularity or upvote sort', async () => {
    const page = await render('/browse');
    try {
      const buttons = page.document.querySelectorAll('#sort-buttons button[data-sort]');
      const values = Array.from(buttons).map((b) => b.getAttribute('data-sort'));
      expect(values.sort()).toEqual(['recently-listed', 'recently-verified', 'verified-hires'].sort());
      const wholeText = (page.document.body.textContent ?? '').toLowerCase();
      expect(wholeText).not.toContain('popular');
      expect(wholeText).not.toContain('upvote');
      expect(wholeText).not.toContain('trending');
    } finally {
      page.close();
    }
  });

  it('filtering by skill via the query string narrows the list', async () => {
    const page = await render('/browse?skill=python');
    try {
      const cards = page.document.querySelectorAll('[data-agent-card]');
      expect(cards.length).toBe(1);
      expect(cards[0]?.getAttribute('data-agent-card')).toBe(HIRED_DID);
    } finally {
      page.close();
    }
  });

  it('each card links to the agent profile', async () => {
    const page = await render('/browse');
    try {
      const link = page.document.querySelector(`a[href="/agents/${encodeURIComponent(HIRED_DID)}"]`);
      expect(link).toBeTruthy();
    } finally {
      page.close();
    }
  });

  // The wireframe's own design notes (div.note) are commentary addressed
  // to the builder, never product copy: "read them, do not render them"
  // (this card's own binding-source instruction). conduct.html and
  // settings.html already state the correct stance in their own comments.
  // No rule in the shipped base.css hides .note (that rule lives only in
  // the wireframe's own base.css, deliberately not ported), so any
  // surviving .note element renders as plain visible body text.
  it('carries none of the wireframe\'s builder-facing div.note blocks in the shipped markup', async () => {
    const page = await render('/browse');
    try {
      expect(page.document.querySelectorAll('.note').length).toBe(0);
    } finally {
      page.close();
    }
  });
});

// The brief's per-tier table (W2 card), read off the three counts already
// on the payload:
//   verified hires > 0          tier-hire,  "N verified hires"
//   no hires, prior work > 0    tier-prior, "N verified prior work", "no hires yet"
//   neither                     tier-claim, "No verified record", "Nothing verified."
// ENT-2.4 governs the third case, which is also the cold-start row: an
// agent with no verified record renders as an agent with no verified
// record, never an absence and never a badge.
//
// The middle row (tier-prior) is not exercised through this real HTTP
// route today: agentWorkRecord (src/domain/agent-work-record.ts) always
// returns verifiedPriorWork: [] because ENT-11 (the prior-work item type)
// is not wired to any route yet, the exact gap tests/web/agent-cold-
// start.test.ts documents for the agent profile page ("verifiedPriorWork
// is always [] until ENT-11 lands"). A card with verifiedPriorWorkCount > 0
// and verifiedHireCount === 0 is therefore unreachable via GET /agents
// until that gap closes; the tier-prior CSS class and copy are still
// wired in browse.js's applyTier and exist ready for that day.
describe('the browse page: three-tier row rendering (ENT-2.4)', () => {
  it('a verified-hire row carries tier-hire and "N verified hires"', async () => {
    const page = await render('/browse');
    try {
      const cards = page.document.querySelectorAll('[data-agent-card]');
      const hiredCard = Array.from(cards).find((c) => c.getAttribute('data-agent-card') === HIRED_DID);
      const tier = hiredCard?.querySelector('.tier');
      expect(tier?.className).toContain('tier-hire');
      expect(tier?.textContent).toContain('1 verified hire');
    } finally {
      page.close();
    }
  });

  it('the cold-start row (no verified hires, no prior work, no claims) carries tier-claim and "No verified record", never an absence', async () => {
    const page = await render('/browse');
    try {
      const cards = page.document.querySelectorAll('[data-agent-card]');
      const coldCard = Array.from(cards).find((c) => c.getAttribute('data-agent-card') === COLD_DID);
      expect(coldCard).toBeTruthy();
      const tier = coldCard?.querySelector('.tier');
      expect(tier?.className).toContain('tier-claim');
      expect(tier?.textContent).toContain('No verified record');
      // ENT-2.4: no "new" badge, no promotional framing.
      const text = (coldCard?.textContent ?? '').toLowerCase();
      expect(text).not.toContain('new agent');
      expect(text).not.toContain('just joined');
      expect(text).not.toContain('brand new');
      expect(coldCard?.querySelectorAll('[class*="badge" i], [data-badge]').length).toBe(0);
      // The claim proof line states what is absent, plainly, in the dim style.
      const proof = coldCard?.querySelector('.proof');
      expect(proof?.className).toContain('dim');
      expect(proof?.textContent).toContain('Nothing verified.');
    } finally {
      page.close();
    }
  });
});

// The zero state (DESIGN.md "empty"): names the filter responsible and
// offers the widest single relaxation with a REAL count, never a guess
// (brief: "the zero state's relaxation counts are real, never invented").
// Two independent filters are active here by construction: the server-side
// skill filter (?skill=typescript, matching only COLD_DID) and the
// client-side "has verified hires" filter (matching only HIRED_DID), so
// combined they produce zero rows and two distinct relaxation buttons.
describe('the browse page: zero-state relaxation (DATA-CONTRACT section 3)', () => {
  it('shows the Zero results heading, one Drop button per active filter with a real re-queried count, and Clear all', async () => {
    const page = await render('/browse?skill=typescript&hires=1');
    try {
      const zeroHost = page.document.getElementById('zero-host');
      expect(zeroHost?.hidden).toBe(false);
      expect(zeroHost?.querySelector('h2')?.textContent).toBe('Zero results');

      const rows = page.document.querySelectorAll('[data-agent-card]');
      expect(rows.length).toBe(0);

      const actions = page.document.getElementById('empty-actions');
      const buttonTexts = Array.from(actions?.querySelectorAll('button') ?? []).map((b) => b.textContent ?? '');

      // COLD_DID (typescript, 0 hires) is the only agent the skill filter
      // matches; dropping the hires filter alone leaves that ONE agent.
      expect(buttonTexts.some((t) => t.includes('Drop "typescript"') && t.includes('1 result'))).toBe(true);
      // HIRED_DID (1 verified hire) is the only agent that clears the
      // hires filter; dropping the skill filter alone leaves that ONE agent.
      expect(buttonTexts.some((t) => t.includes('Drop "verified hires"') && t.includes('1 result'))).toBe(true);
      expect(buttonTexts).toContain('Clear all');
    } finally {
      page.close();
    }
  });

  it('a filtered zero state names which filter is responsible, and Clear all removes every filter', async () => {
    const page = await render('/browse?skill=typescript&hires=1');
    try {
      const title = page.document.getElementById('empty-title')?.textContent ?? '';
      expect(title).toContain('No agents match all your filters.');

      const clearAll = page.document.getElementById('clear-all-btn');
      expect(clearAll?.textContent).toBe('Clear all');
    } finally {
      page.close();
    }
  });

  // The brief: "If a count cannot be read, render the button without a
  // count rather than with a guess." A proxy in front of the real server
  // fails only the relaxed re-query the skill-drop button depends on
  // (GET /agents with no skill param), the same fault-injection shape
  // deposit.test.ts:499 and staged.test.ts use for their own D1 guards.
  // The hires-drop button stays client side and is unaffected, so its
  // real count is the control proving the failure is isolated to the
  // one read that broke.
  it('a relaxation button with no readable count renders the label alone, never a guessed number', async () => {
    const realPort = (server.address() as AddressInfo).port;
    const proxy = http.createServer((req, res) => {
      if (req.url !== undefined && /^\/agents(\?(?!.*\bskill=).*)?$/.test(req.url)) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'storage unavailable' }));
        return;
      }
      const upstream = http.request({ hostname: '127.0.0.1', port: realPort, path: req.url, method: req.method, headers: req.headers }, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      });
      req.pipe(upstream);
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyBaseUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    try {
      const page = await render('/browse?skill=typescript&hires=1', proxyBaseUrl);
      try {
        const actions = page.document.getElementById('empty-actions');
        const buttonTexts = Array.from(actions?.querySelectorAll('button') ?? []).map((b) => b.textContent ?? '');

        // The skill relaxation's read failed: label only, no count, no dot.
        expect(buttonTexts.some((t) => t === 'Drop "typescript"')).toBe(true);
        expect(buttonTexts.some((t) => t.startsWith('Drop "typescript" \u00b7'))).toBe(false);

        // The hires relaxation is client side and untouched by the proxy,
        // so it still carries its real count.
        expect(buttonTexts.some((t) => t.includes('Drop "verified hires"') && t.includes('1 result'))).toBe(true);
      } finally {
        page.close();
      }
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});

// jsdom performs no layout, so it can tell a control exists but never
// whether a real 320px screen renders it under the 44px floor. This drives
// real headless Chrome the same way tests/web/dashboard.test.ts's own
// tap-target case does. Fourteen agents (more than PAGE_SIZE=10) so the
// pager actually renders a page-2 button and a live Next control, matching
// the review's own reproduction harness.
describe('the browse page: tap targets at 320px, real Chrome (tap-target-under-44px)', () => {
  let tapServer: Server;
  let tapBaseUrl: string;

  beforeAll(async () => {
    const agentRepo = new MemoryAgentRepository();
    const operatorDid = 'did:abt:zBrowseTapOperator';
    for (let i = 0; i < 14; i += 1) {
      const did = `did:abt:zBrowseTapAgent${i}`;
      await agentRepo.create({
        did,
        operatorDid,
        delegation: delegation(did),
        name: `Tap Target Agent ${i}`,
        skills: ['python'],
        githubLogin: null,
      });
    }
    const app = createApp(new MemoryAccountRepository(), agentRepo);
    tapServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => tapServer.once('listening', resolve));
    tapBaseUrl = `http://127.0.0.1:${(tapServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => tapServer.close(() => resolve()));
  });

  it('More filters, the three sort buttons and the pager buttons are all at least 44px tall', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 320, height: 900 });
    try {
      await browser.goto(`${tapBaseUrl}/browse`);

      const undersized = await browser.evaluate<Array<[string, number, number]>>(`
        Array.from(document.querySelectorAll('.more, .sort button, .pager button'))
          .map((el) => {
            const r = el.getBoundingClientRect();
            return [el.textContent || '', r.width, r.height];
          })
          .filter(([, w, h]) => w < 44 || h < 44)
      `);
      expect(undersized, `undersized targets: ${JSON.stringify(undersized)}`).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  // Round 2 review, D3: a guard that only re-selects the classes a human
  // already reported can only ever re-find what that human already found.
  // This sweeps every interactive control the page actually renders,
  // filtered to elements that are laid out (an offsetParent, so a control
  // still hidden behind [hidden] is not falsely counted), and opens the
  // drawer first so its labels and checkboxes are part of the sweep. A
  // checkbox itself is allowed to stay visually small: its LABEL is the
  // real tap target, because clicking the label already toggles the box
  // (the same relationship pullrequest.html's .picker label documents).
  it('every rendered interactive control is at least 44px, drawer open, real Chrome (tap-target-under-44px)', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 320, height: 900 });
    try {
      await browser.goto(`${tapBaseUrl}/browse`);
      await browser.evaluate(`document.querySelector('[data-disclose="drawer"]').click()`);

      const undersized = await browser.evaluate<Array<[string, number, number]>>(`
        Array.from(document.querySelectorAll('button, a, input, label'))
          .filter((el) => el.offsetParent !== null && el.closest('[hidden]') === null)
          .filter((el) => el.tagName !== 'INPUT' || el.type !== 'checkbox' || !el.closest('label'))
          .map((el) => {
            const r = el.getBoundingClientRect();
            return [el.tagName + ' ' + (el.textContent || '').trim(), r.width, r.height];
          })
          .filter(([, w, h]) => w < 44 || h < 44)
      `);
      expect(undersized, `undersized targets: ${JSON.stringify(undersized)}`).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
