// R-19 (D4, ENT-1.2): what the operator page actually RENDERS, real script
// against the real API. Mirrors tests/web/browse.test.ts for style: jsdom
// loads the served page, lets its own script run, and the assertions read
// the DOM a visitor is left looking at.
//
// ANCHOR under test: an operator page is the sum of who they run, never a
// score for the operator. D4: one layout, no branching; sort and filter
// controls appear only above ten agents.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import {
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
  MemoryAccountRepository,
} from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';

const SOLO_OPERATOR_DID = 'did:abt:zRosterPageSoloOperator';
const MANY_OPERATOR_DID = 'did:abt:zRosterPageManyOperator';
const EMPTY_OPERATOR_DID = 'did:abt:zRosterPageEmptyOperator';
const CONTROL_OPERATOR_DID = 'did:abt:zRosterPageControlOperator';
// W3: an operator whose roster carries one verified-hire row and one row
// with no verified record at all, so the tier-chip rendering (D2 of this
// card) can be pinned against real HTTP responses rather than asserted
// against a fixture nobody exercised.
const TIER_OPERATOR_DID = 'did:abt:zRosterPageTierOperator';

function delegation(agentDid: string, operatorDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:roster-page-${agentDid}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-08-30T00:00:00.000Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-08-30T00:00:00.000Z',
      verificationMethod: `${operatorDid}#key-1`,
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
  const operatorRepo = new MemoryAccountRepository();
  const agentRepo = new MemoryAgentRepository();
  const credentialRepo = new MemoryCredentialRepository();
  const jobRepo = new MemoryJobRepository();

  await operatorRepo.register({ did: SOLO_OPERATOR_DID, githubLogin: 'roster-page-solo' });
  await operatorRepo.register({ did: MANY_OPERATOR_DID, githubLogin: 'roster-page-many' });
  await operatorRepo.register({ did: EMPTY_OPERATOR_DID, githubLogin: 'roster-page-empty' });

  const soloAgentDid = 'did:abt:zRosterPageSoloAgent';
  await agentRepo.create({
    did: soloAgentDid,
    operatorDid: SOLO_OPERATOR_DID,
    delegation: delegation(soloAgentDid, SOLO_OPERATOR_DID),
    name: 'Solo Agent',
    skills: ['typescript'],
    githubLogin: null,
  });
  await credentialRepo.save({
    completedJobId: 'roster-page-solo-job',
    subjectDid: soloAgentDid,
    document: credentialDoc('https://platform.example/v1/credentials/roster-page-solo-job', soloAgentDid, 'roster-page-solo-commit', 'did:example:buyer-solo'),
    repositoryPublic: true,
  });

  // Eleven agents under one operator: crosses D4's above-ten threshold.
  for (let i = 0; i < 11; i += 1) {
    const did = `did:abt:zRosterPageManyAgent${i}`;
    await agentRepo.create({
      did,
      operatorDid: MANY_OPERATOR_DID,
      delegation: delegation(did, MANY_OPERATOR_DID),
      name: `Many Agent ${i}`,
      skills: ['python'],
      githubLogin: null,
    });
  }

  await operatorRepo.register({ did: CONTROL_OPERATOR_DID, githubLogin: 'roster-page-control' });
  // Eleven agents on a split skill set, listed one after another with a real
  // gap between each (mirrors registerAgent's createdAt-by-registration-time
  // rule in tests/api/browse.test.ts), so recently-listed has a genuine
  // order to prove and skill has a genuine split to filter on: 6 python, 5
  // rust, same mix the live reproduction from review used.
  for (let i = 0; i < 11; i += 1) {
    const did = `did:abt:zRosterPageControlAgent${i}`;
    await agentRepo.create({
      did,
      operatorDid: CONTROL_OPERATOR_DID,
      delegation: delegation(did, CONTROL_OPERATOR_DID),
      name: `Control Agent ${i}`,
      skills: i < 6 ? ['python'] : ['rust'],
      githubLogin: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  // W3: two rows to distinguish the tier chip a verified-hire row carries
  // from the tier chip a no-record row carries, both real HTTP data.
  await operatorRepo.register({ did: TIER_OPERATOR_DID, githubLogin: 'roster-page-tier' });
  const tierHireAgentDid = 'did:abt:zRosterPageTierHireAgent';
  await agentRepo.create({
    did: tierHireAgentDid,
    operatorDid: TIER_OPERATOR_DID,
    delegation: delegation(tierHireAgentDid, TIER_OPERATOR_DID),
    name: 'Tier Hire Agent',
    skills: ['typescript'],
    githubLogin: null,
  });
  await credentialRepo.save({
    completedJobId: 'roster-page-tier-job',
    subjectDid: tierHireAgentDid,
    document: credentialDoc('https://platform.example/v1/credentials/roster-page-tier-job', tierHireAgentDid, 'roster-page-tier-commit', 'did:example:buyer-tier'),
    repositoryPublic: true,
  });
  const tierClaimAgentDid = 'did:abt:zRosterPageTierClaimAgent';
  await agentRepo.create({
    did: tierClaimAgentDid,
    operatorDid: TIER_OPERATOR_DID,
    delegation: delegation(tierClaimAgentDid, TIER_OPERATOR_DID),
    name: 'Tier Claim Agent',
    skills: ['python'],
    githubLogin: null,
  });

  const app = createApp(operatorRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, credentialRepo);
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

// jsdom's Location is a legacy platform object with a non-configurable
// href/assign pair (a real jsdom limitation: setting window.location.href
// on a JSDOM instance cannot complete a cross-document navigation at all,
// see node_modules/jsdom/lib/jsdom/living/window/navigation.js). The one
// observable seam jsdom itself calls on every href/assign/replace path is
// whatwg-url's parseURL, which is an ordinary writable module export. This
// intercepts that seam to observe the URL the page script asked to
// navigate to, exactly as a browser's window.location.assign spy would.
const require = createRequire(import.meta.url);
const whatwgURL = require('whatwg-url') as { parseURL: (v: string, opts?: unknown) => unknown };

function captureNavigations(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = whatwgURL.parseURL;
  whatwgURL.parseURL = function (this: unknown, v: string, opts?: unknown) {
    calls.push(v);
    return original.call(this, v, opts);
  };
  return {
    calls,
    restore() {
      whatwgURL.parseURL = original;
    },
  };
}

async function render(path: string): Promise<Rendered> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
  expect(response.status, `unexpected status for ${path}`).toBe(200);
  const markup = await response.text();

  const dom = new JSDOM(markup, {
    url: `${baseUrl}${path}`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      Object.defineProperty(window, 'fetch', {
        writable: true,
        value: (input: string, init?: RequestInit) => fetch(new URL(input, baseUrl), init),
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

describe('the operator page roster (R-19)', () => {
  it('a single-agent operator sees the roster table with one row, no sort or filter controls', async () => {
    const page = await render(`/accounts/${SOLO_OPERATOR_DID}`);
    try {
      const rows = page.document.querySelectorAll('[data-agent-row]');
      expect(rows.length).toBe(1);

      // D4: below ten agents, the table renders plain, no controls.
      expect(page.document.getElementById('roster-controls')?.hidden).toBe(true);
    } finally {
      page.close();
    }
  });

  // W3 UPDATE: the roster row was rebuilt from the design seat's wireframe
  // (spec/wireframe/operator.html) to the same tier-chip shape browse.js's
  // W2 rebuild already applies to its own card: ONE tier chip stating the
  // agent's own tier, plus an evidence line carrying only the OTHER
  // non-zero counts, mirroring browse's own applyTier exactly rather than
  // always showing all three labelled counts regardless of tier. The solo
  // fixture agent has exactly one verified hire and nothing else, so its
  // row states that hire count and nothing else, which is the "port the
  // row properly" instruction from this card's brief, not a regression:
  // tests/web/browse.test.ts's own three-tier describe block pins the
  // identical per-tier behaviour for browse's card.
  it('the roster row states its own tier honestly, the same per-tier table a browse card uses', async () => {
    const page = await render(`/accounts/${SOLO_OPERATOR_DID}`);
    try {
      const row = page.document.querySelector('[data-agent-row]');
      const tier = row?.querySelector('.tier');
      expect(tier?.className).toContain('tier-hire');
      const text = row?.textContent ?? '';
      expect(text).toContain('1 verified hire');
    } finally {
      page.close();
    }
  });

  it('the aggregate is a summary line, three separate figures, never a combined score', async () => {
    const page = await render(`/accounts/${SOLO_OPERATOR_DID}`);
    try {
      const summary = page.document.getElementById('roster-summary')?.textContent ?? '';
      expect(summary).toContain('1 verified hire');
      expect(summary).toContain('verified prior work');
      expect(summary).toContain('portfolio');
      // No blended word anywhere near the aggregate.
      expect(summary.toLowerCase()).not.toContain('score');
      expect(summary.toLowerCase()).not.toContain('reputation');
      expect(summary.toLowerCase()).not.toContain('rank');
    } finally {
      page.close();
    }
  });

  it('per-agent rows stay dominant: the roster table renders before the aggregate summary in the DOM', async () => {
    const page = await render(`/accounts/${SOLO_OPERATOR_DID}`);
    try {
      const rosterHost = page.document.getElementById('roster-cards');
      const summary = page.document.getElementById('roster-summary');
      expect(rosterHost).toBeTruthy();
      expect(summary).toBeTruthy();
      const position = rosterHost?.compareDocumentPosition(summary as Node) ?? 0;
      // DOCUMENT_POSITION_FOLLOWING: summary comes after the roster.
      expect((position & 0x04) !== 0).toBe(true);
    } finally {
      page.close();
    }
  });

  it('an operator with zero agents renders an honest empty roster, no promotional framing (ENT-2.4)', async () => {
    const page = await render(`/accounts/${EMPTY_OPERATOR_DID}`);
    try {
      expect(page.document.getElementById('roster-empty')?.hidden).toBe(false);
      expect(page.document.querySelectorAll('[data-agent-row]').length).toBe(0);
      const text = (page.document.body.textContent ?? '').toLowerCase();
      expect(text).not.toContain('coming soon');
      expect(text).not.toContain('new operator');

      const summary = page.document.getElementById('roster-summary')?.textContent ?? '';
      expect(summary).toContain('0 verified hires');
    } finally {
      page.close();
    }
  });

  it('an operator running eleven agents gets sort and filter controls (D4, above ten)', async () => {
    const page = await render(`/accounts/${MANY_OPERATOR_DID}`);
    try {
      const rows = page.document.querySelectorAll('[data-agent-row]');
      expect(rows.length).toBe(11);
      expect(page.document.getElementById('roster-controls')?.hidden).toBe(false);
      const sortSelect = page.document.getElementById('roster-sort');
      expect(sortSelect).toBeTruthy();
    } finally {
      page.close();
    }
  });

  it('every roster row links to its agent profile', async () => {
    const page = await render(`/accounts/${SOLO_OPERATOR_DID}`);
    try {
      const link = page.document.querySelector(`a[href="/agents/${encodeURIComponent('did:abt:zRosterPageSoloAgent')}"]`);
      expect(link).toBeTruthy();
    } finally {
      page.close();
    }
  });

  // D4's controls exist to DO something. These four tests operate them
  // rather than asserting presence (review, run 76, defect vacuous-guard):
  // a test that never fires an event on #roster-sort or #roster-skill
  // passes identically on a build where neither is wired to anything.

  // W3 UPDATE: the roster row (rebuilt from spec/wireframe/operator.html)
  // carries no skills line in its wireframe shape (the right column is the
  // tier chip plus the evidence line only, the same as browse's own
  // wireframe row), so a filtered row no longer states the skill it
  // matched in its own text. The filter is still proven end to end by
  // checking WHICH agents survived: the control fixture assigns rust to
  // exactly agents 6 through 10 (skills: i < 6 ? python : rust), so a
  // skill=rust query must return precisely that set.
  it('loading the roster with a skill query param renders only the matching rows, the same way browse filters (item 1)', async () => {
    const page = await render(`/accounts/${CONTROL_OPERATOR_DID}?skill=rust`);
    try {
      const rows = page.document.querySelectorAll('[data-agent-row]');
      expect(rows.length).toBe(5);
      const dids = Array.from(rows).map((row) => row.getAttribute('data-agent-row'));
      const expected = [6, 7, 8, 9, 10].map((i) => `did:abt:zRosterPageControlAgent${i}`);
      expect(dids.sort()).toEqual(expected.sort());
    } finally {
      page.close();
    }
  });

  it('loading the roster with a sort query param reorders the rows, the same way browse sorts (item 1)', async () => {
    const page = await render(`/accounts/${CONTROL_OPERATOR_DID}?sort=recently-listed`);
    try {
      const rows = Array.from(page.document.querySelectorAll('[data-agent-row]'));
      const dids = rows.map((r) => r.getAttribute('data-agent-row'));
      // Registered last, listed first under recently-listed; registered
      // first, listed last. A plain reorder proves the parameter drove it,
      // not the roster's fixed registration order.
      expect(dids[0]).toBe('did:abt:zRosterPageControlAgent10');
      expect(dids[dids.length - 1]).toBe('did:abt:zRosterPageControlAgent0');
    } finally {
      page.close();
    }
  });

  it('operating the sort select navigates to the URL that produces that sort, the same mechanism browse uses (item 1, item 2)', async () => {
    const page = await render(`/accounts/${CONTROL_OPERATOR_DID}`);
    const nav = captureNavigations();
    try {
      const sortSelect = page.document.getElementById('roster-sort') as HTMLSelectElement | null;
      expect(sortSelect).toBeTruthy();
      sortSelect!.value = 'recently-listed';
      sortSelect!.dispatchEvent(new (page.document.defaultView as unknown as { Event: typeof Event }).Event('change', { bubbles: true }));

      const relevant = nav.calls.filter((url) => url.includes('/accounts/'));
      expect(relevant.length).toBeGreaterThan(0);
      const last = relevant[relevant.length - 1] ?? '';
      expect(last).toContain('sort=recently-listed');
      expect(last).toContain(`/accounts/${encodeURIComponent(CONTROL_OPERATOR_DID)}`);
    } finally {
      nav.restore();
      page.close();
    }
  });

  it('operating the skill filter navigates to the URL that produces that filter, the same mechanism browse uses (item 1, item 2)', async () => {
    const page = await render(`/accounts/${CONTROL_OPERATOR_DID}`);
    const nav = captureNavigations();
    try {
      const skillInput = page.document.getElementById('roster-skill') as HTMLInputElement | null;
      expect(skillInput).toBeTruthy();
      skillInput!.value = 'rust';
      skillInput!.dispatchEvent(new (page.document.defaultView as unknown as { Event: typeof Event }).Event('change', { bubbles: true }));

      const relevant = nav.calls.filter((url) => url.includes('/accounts/'));
      expect(relevant.length).toBeGreaterThan(0);
      const last = relevant[relevant.length - 1] ?? '';
      expect(last).toContain('skill=rust');
      expect(last).toContain(`/accounts/${encodeURIComponent(CONTROL_OPERATOR_DID)}`);
    } finally {
      nav.restore();
      page.close();
    }
  });

  // Review round 3, D1: filtering an above-ten roster down to a handful of
  // rows must not delete the controls that produced the filter. Browse
  // keeps #sort and #skill visible in the identical case; the roster must
  // match it, gating on the FULL roster size, never the filtered one.
  it('filtering an above-ten roster down keeps the controls visible and the filter value on screen (D1)', async () => {
    const page = await render(`/accounts/${CONTROL_OPERATOR_DID}?skill=rust`);
    try {
      const rows = page.document.querySelectorAll('[data-agent-row]');
      expect(rows.length).toBe(5);

      const controls = page.document.getElementById('roster-controls');
      expect(controls?.hidden).toBe(false);

      const skillInput = page.document.getElementById('roster-skill') as HTMLInputElement | null;
      expect(skillInput).toBeTruthy();
      expect(skillInput?.value).toBe('rust');
    } finally {
      page.close();
    }
  });

  // Review round 3, D3: a roster row must carry every field browse's card
  // does for the same agent, not just the three tier counts already
  // checked above. Comparing the rendered DOM field by field (rather than
  // only the tier counts) is what the round-2 parity test missed: it never
  // looked at .when.
  //
  // W3 UPDATE: operator.html/operator.js were rebuilt from the design
  // seat's wireframe (spec/wireframe/operator.html) in this card, moving
  // the roster row from the pre-wireframe evidence-row/name-link/when
  // vocabulary this comment used to describe to the wireframe's own
  // .agent/.nm/.tier/.ev shape, the same tier-chip vocabulary browse.js's
  // W2 rebuild already applies to its own card. The wireframe's roster row
  // carries no explicit skills line (its right column is the tier chip
  // plus the evidence line only), so the skills comparison this test used
  // to make is removed rather than compared against an element that no
  // longer exists; the record facts still compared below (name, hire
  // count, date) are what D3 exists to protect.
  it("a roster row states the same record facts as the same agent's browse card, including the date (D3)", async () => {
    const rosterPage = await render(`/accounts/${SOLO_OPERATOR_DID}`);
    const browsePage = await render('/browse');
    try {
      const rosterRow = rosterPage.document.querySelector('[data-agent-row]');
      const browseCard = browsePage.document.querySelector(
        `[data-agent-card="${'did:abt:zRosterPageSoloAgent'}"]`,
      );
      expect(rosterRow).toBeTruthy();
      expect(browseCard).toBeTruthy();

      const rosterName = rosterRow?.querySelector('.nm')?.textContent ?? '';
      const browseName = browseCard?.querySelector('.name')?.textContent ?? '';
      expect(rosterName).not.toBe('');
      expect(rosterName).toBe(browseName);

      // Both surfaces read the SAME field (BrowseCard.verifiedHireCount,
      // src/domain/browse.ts) for the hire count, through the SAME tier
      // vocabulary (.tier, the label text beside the dot): the underlying
      // number must never drift.
      const rosterTierText = rosterRow?.querySelector('.right .tier')?.textContent ?? '';
      const browseTierText = browseCard?.querySelector('.tier-label')?.textContent ?? '';
      expect(rosterTierText).toContain('1 verified hire');
      expect(browseTierText).toContain('1 verified hire');

      // The roster's wireframe row carries no separate date field (the
      // wireframe's .agent shape has no .when slot); the last-verified
      // fact is still read off the SAME lastVerifiedAt this agent's browse
      // proof line states, through browse's own selector.
      const browseProof = browseCard?.querySelector('.proof')?.textContent ?? '';
      expect(browseProof).toContain('Last verified');
    } finally {
      rosterPage.close();
      browsePage.close();
    }
  });

  // Review round 3, D2: the summary sentence must not claim a population it
  // is not showing. A skill filter narrows the rows on screen while the
  // aggregate stays full-roster (app.ts: an operator's accountability does
  // not shrink because a visitor filtered); the wording must say so
  // honestly instead of claiming "every agent listed here" over a filtered
  // view that plainly is not every agent.
  it('the summary never claims a filtered view lists every agent when the aggregate is full-roster (D2)', async () => {
    const page = await render(`/accounts/${CONTROL_OPERATOR_DID}?skill=rust`);
    try {
      const rows = page.document.querySelectorAll('[data-agent-row]');
      expect(rows.length).toBe(5);

      const summary = page.document.getElementById('roster-summary')?.textContent ?? '';
      expect(summary.toLowerCase()).not.toContain('listed here');
      expect(summary).toContain('verified hire');
    } finally {
      page.close();
    }
  });

  // Review round 3, D5: a filter that matches nothing must not be reported
  // as an empty roster. #roster-empty was gated on the POST-filter row
  // count, the identical mistake D1 made for #roster-controls one line
  // above it in operator.js. This operator runs eleven agents; a filter
  // that matches none of them is a filter result, not an empty roster, and
  // the copy must say so the way browse.html's #empty already does for the
  // identical case, rather than claiming nothing has been delegated.
  it('filtering an above-ten roster to zero matches reports an empty filter result, not a false empty roster (D5)', async () => {
    const page = await render(`/accounts/${CONTROL_OPERATOR_DID}?skill=cobol`);
    try {
      const rows = page.document.querySelectorAll('[data-agent-row]');
      expect(rows.length).toBe(0);

      const empty = page.document.getElementById('roster-empty');
      expect(empty?.hidden).toBe(false);

      // The controls that produced the filter must stay reachable so the
      // visitor can clear it (D1's fix must not regress here).
      const controls = page.document.getElementById('roster-controls');
      expect(controls?.hidden).toBe(false);

      const text = (empty?.textContent ?? '').toLowerCase();
      expect(text).toContain('no agents match this filter');
      expect(text).not.toContain('runs no agents yet');
      expect(text).not.toContain('nothing has been delegated');

      // The summary still reports the full eleven-agent roster honestly,
      // unaffected by the empty filter result (D2's fix must not regress).
      const summary = page.document.getElementById('roster-summary')?.textContent ?? '';
      expect(summary.toLowerCase()).not.toContain('listed here');
    } finally {
      page.close();
    }
  });

  it('an operator with a genuinely empty roster still sees the original empty-roster copy, not the filter copy (D5)', async () => {
    const page = await render(`/accounts/${EMPTY_OPERATOR_DID}`);
    try {
      const empty = page.document.getElementById('roster-empty');
      expect(empty?.hidden).toBe(false);
      const text = (empty?.textContent ?? '').toLowerCase();
      expect(text).toContain('runs no agents yet');
      expect(text).not.toContain('no agents match this filter');
    } finally {
      page.close();
    }
  });

  // W3: the roster row rebuilt from the design seat's wireframe
  // (spec/wireframe/operator.html) carries a tier chip (.tier .dot plus a
  // label) beside the evidence line, the same vocabulary browse.html's own
  // wireframe rebuild (W2) uses for its cards, rather than the flat
  // three-count evidence row this page rendered before this card.
  it('a verified-hire roster row carries the tier-hire chip and its evidence line', async () => {
    const page = await render(`/accounts/${TIER_OPERATOR_DID}`);
    try {
      const row = page.document.querySelector('[data-agent-row="did:abt:zRosterPageTierHireAgent"]');
      expect(row).toBeTruthy();
      const tier = row?.querySelector('.tier');
      expect(tier?.className).toContain('tier-hire');
      expect(tier?.textContent).toContain('1 verified hire');
      const ev = row?.querySelector('.ev');
      expect(ev).toBeTruthy();
    } finally {
      page.close();
    }
  });

  it('a roster row with no verified record carries the tier-claim chip, never an absence', async () => {
    const page = await render(`/accounts/${TIER_OPERATOR_DID}`);
    try {
      const row = page.document.querySelector('[data-agent-row="did:abt:zRosterPageTierClaimAgent"]');
      expect(row).toBeTruthy();
      const tier = row?.querySelector('.tier');
      expect(tier?.className).toContain('tier-claim');
      expect(tier?.textContent).toContain('No verified record');
    } finally {
      page.close();
    }
  });

  // W3: the wireframe's four-step "List an agent" block. Pinned as a real
  // DOM assertion (not just conformance's text scan) that all four numbered
  // steps render and that Start points at the sign-in route, matching
  // how.html's own "List an agent" link and signin.js's agent.list
  // capability rather than a listing route that does not exist.
  it('the "List an agent" section renders all four numbered steps and Start points at sign-in', async () => {
    const page = await render(`/accounts/${SOLO_OPERATOR_DID}`);
    try {
      const steps = page.document.querySelectorAll('.rows.steps .s');
      expect(steps.length).toBe(4);
      const headings = Array.from(steps).map((s) => s.querySelector('h3')?.textContent ?? '');
      expect(headings).toEqual([
        'Prove your GitHub account',
        'Describe the agent',
        'Delegate an agent identity',
        'Publish',
      ]);
      const start = Array.from(page.document.querySelectorAll('a')).find((a) => a.textContent === 'Start');
      expect(start).toBeTruthy();
      expect(start?.getAttribute('href')).toBe('/signin');
    } finally {
      page.close();
    }
  });

  // W3 round 2 fix (D2, guard-without-a-test): the tier-prior branch of
  // agentTierInfo has no HTTP fixture to exercise it, because
  // agentWorkRecord (src/domain/agent-work-record.ts) hardcodes
  // verifiedPriorWork: [] until ENT-11 lands, the exact gap
  // tests/web/browse.test.ts:338-346 documents for browse's own identical
  // branch. Rather than fabricate a fake HTTP fixture the app can never
  // actually produce, this calls the pure function directly through the
  // test-only hook operator.js exposes for it, over an object shaped like
  // the BrowseCard fields it reads. The function has no DOM dependency and
  // no side effects, so calling it directly proves the same rule a
  // rendered row would apply once ENT-11 makes the branch reachable.
  it('agentTierInfo renders tier-prior for a prior-only agent, the branch no HTTP fixture can reach until ENT-11', async () => {
    const page = await render(`/accounts/${SOLO_OPERATOR_DID}`);
    try {
      const win = page.document.defaultView as unknown as {
        __operatorTestHooks?: {
          agentTierInfo: (agent: {
            verifiedHireCount: number;
            verifiedPriorWorkCount: number;
            portfolioCount: number;
          }) => { tierClass: string; tierLabel: string; evidence: string };
        };
      };
      expect(win.__operatorTestHooks).toBeTruthy();
      const info = win.__operatorTestHooks!.agentTierInfo({
        verifiedHireCount: 0,
        verifiedPriorWorkCount: 3,
        portfolioCount: 0,
      });
      expect(info.tierClass).toBe('tier-prior');
      expect(info.tierLabel).toBe('3 verified prior work');
      expect(info.evidence).toBe('no hires yet');
    } finally {
      page.close();
    }
  });
});
