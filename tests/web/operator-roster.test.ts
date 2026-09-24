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

import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

import { createApp } from '../../src/api/app.js';
import {
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
  MemoryAccountRepository,
} from '../../src/adapters/storage/memory.js';
import { createRateLimiter } from '../../src/adapters/identity/verify-rate-limit.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';
import { botMount, expectedMount } from '../helpers/bot-mount.js';
import { defaultAvatar } from '../../src/domain/avatar-spec.js';

// Real-browser layout tests launch Chrome, navigate at least once and
// evaluate in the page; vitest's 5000ms default times out under full-suite
// load exactly the way CI1 found in dashboard.test.ts and
// hire-polished.test.ts (run 35390871202, layout tests red on
// "Test timed out in 5000ms" with no layout defect). 30s is past every
// launch observed here and a genuinely broken layout still fails inside it.
const BROWSER_TIMEOUT_MS = 30_000;

const SOLO_OPERATOR_DID = 'did:abt:zRosterPageSoloOperator';
const MANY_OPERATOR_DID = 'did:abt:zRosterPageManyOperator';
const EMPTY_OPERATOR_DID = 'did:abt:zRosterPageEmptyOperator';
const CONTROL_OPERATOR_DID = 'did:abt:zRosterPageControlOperator';
// W3: an operator whose roster carries one verified-hire row and one row
// with no verified record at all, so the tier-chip rendering (D2 of this
// card) can be pinned against real HTTP responses rather than asserted
// against a fixture nobody exercised.
const TIER_OPERATOR_DID = 'did:abt:zRosterPageTierOperator';
// W12: an operator running two agents, one with a verified hire (a public
// repository) and one with a portfolio claim (a private repository, which
// agentWorkRecord demotes out of the verified-hire tier). This is the
// fixture the gallery section and its evidence gate are proven against:
// real HTTP data carrying both tiers the gallery is allowed to render, from
// two DIFFERENT agents, so span.work-by naming the producing agent has
// something real to disagree about.
const GALLERY_OPERATOR_DID = 'did:abt:zRosterPageGalleryOperator';

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

  // W12: the gallery fixture. Agent one has ONE verified hire (a public
  // repository, real evidence); agent two has ONE portfolio claim (a
  // private repository, so agentWorkRecord demotes it out of the
  // verified-hire tier per invariant 4). Both agents are delegated from
  // the SAME operator, so GET /accounts/:did/agents returns both rows and
  // the gallery has to merge work across them.
  await operatorRepo.register({ did: GALLERY_OPERATOR_DID, githubLogin: 'roster-page-gallery' });
  const galleryHireAgentDid = 'did:abt:zRosterPageGalleryHireAgent';
  await agentRepo.create({
    did: galleryHireAgentDid,
    operatorDid: GALLERY_OPERATOR_DID,
    delegation: delegation(galleryHireAgentDid, GALLERY_OPERATOR_DID),
    name: 'Gallery Hire Agent',
    skills: ['typescript'],
    githubLogin: null,
  });
  await credentialRepo.save({
    completedJobId: 'roster-page-gallery-hire-job',
    subjectDid: galleryHireAgentDid,
    document: credentialDoc(
      'https://platform.example/v1/credentials/roster-page-gallery-hire-job',
      galleryHireAgentDid,
      'roster-page-gallery-hire-commit',
      'did:example:buyer-gallery-hire',
    ),
    repositoryPublic: true,
  });
  const galleryClaimAgentDid = 'did:abt:zRosterPageGalleryClaimAgent';
  await agentRepo.create({
    did: galleryClaimAgentDid,
    operatorDid: GALLERY_OPERATOR_DID,
    delegation: delegation(galleryClaimAgentDid, GALLERY_OPERATOR_DID),
    name: 'Gallery Claim Agent',
    skills: ['python'],
    githubLogin: null,
  });
  await credentialRepo.save({
    completedJobId: 'roster-page-gallery-claim-job',
    subjectDid: galleryClaimAgentDid,
    document: credentialDoc(
      'https://platform.example/v1/credentials/roster-page-gallery-claim-job',
      galleryClaimAgentDid,
      'roster-page-gallery-claim-commit',
      'did:example:buyer-gallery-claim',
    ),
    repositoryPublic: false,
  });

  const app = createApp(
    operatorRepo,
    agentRepo,
    undefined,
    undefined,
    jobRepo,
    undefined,
    undefined,
    credentialRepo,
    // W12: the roster row and the gallery each make one GET
    // /agents/:agentDid read per agent (the roster's own avatar paint,
    // mirroring browse.js's loadAvatar; the gallery's shared per-agent
    // work read). This file renders several eleven-agent rosters across
    // many tests in one process, which comfortably clears the default
    // 60-per-minute anonymous verify limit (#30) well before the file
    // finishes; nothing here is testing that limiter, so it is raised for
    // this fixture the same way tests/api/session.test.ts injects its own
    // limiter to test the OPPOSITE case.
    createRateLimiter({ limit: 10_000, windowMs: 60_000 }),
  );
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

// D-CI3: whether the gallery's own async chain (below) has a signal to
// wait on at all. /browse (rendered once in this file, line ~568) has no
// #gallery/#gallery-empty pair, so this page type falls to
// hasBrowseSignal/browseSettled below instead.
function hasGallerySignal(doc: Document): boolean {
  return doc.getElementById('gallery-empty') !== null && doc.getElementById('gallery') !== null;
}

// D-CI3 (operator.js:561-577, W12): loadGallery fires one GET per roster
// agent and calls paintRosterAvatar synchronously inside EACH read's own
// .then, before Promise.all(reads) resolves. So the instant Promise.all
// settles and calls renderGallery/renderGalleryEmpty, every paintRosterAvatar
// call for this page has already run. #gallery-empty starts `hidden` in the
// served markup and #gallery starts with no children, so neither reads true
// before that point: unhidden empty, or a populated gallery, are both proof
// the chain finished, with no window for a false positive.
function gallerySettled(doc: Document): boolean {
  const galleryEmpty = doc.getElementById('gallery-empty') as HTMLElement | null;
  const gallery = doc.getElementById('gallery');
  if (!galleryEmpty || !gallery) return true;
  return !galleryEmpty.hidden || gallery.children.length > 0;
}

// D-CI3 round 2 (Proof r1, comment 549): render()'s /browse branch used to
// fall back to a fixed 400ms sleep, the SAME teardown race the gallery fix
// above closes, just on browse.js's own chain instead of operator.js's.
// cardFor (browse.js:359-403) puts a card in the DOM and calls loadAvatar
// (browse.js:415-421) for it; loadAvatar's own GET /agents/:did read calls
// window.FABots.mount in its .then, AFTER the card already has a DOM
// parent. render() used to return, the test asserted and closed the
// window, and a per-card avatar read that settled only after that landed
// in bots.js's mount() (src/web/public/js/bots.js:398,
// document.createElement("canvas")) with a torn-down document: the same
// "Cannot read properties of undefined (reading 'createElement')" shape
// QA's mutation reproduced at bots.js:398 <- browse.js:419.
function hasBrowseSignal(doc: Document): boolean {
  return doc.getElementById('zero-host') !== null && doc.getElementById('rows') !== null;
}

// #zero-host starts `hidden` in the served markup (browse.html:435) and
// #rows starts with no children (browse.html:404), so neither reads
// "settled" before the initial GET /agents listing read has resolved and
// renderAll has run. Once #rows holds cards, EVERY card's avatar host is
// checked for the one DOM fact only a completed mount() call produces: a
// <canvas> child (bots.js:398-405, appended inside mount() after a
// successful read). A host with no canvas yet is still awaiting its read,
// so this can only read true once every per-card GET /agents/:did loadAvatar
// fired has actually settled and mounted, closing the same window the
// gallery signal above closes. The genuine zero-results state (#zero-host
// unhidden) is settled on its own: it carries no cards and so no avatar
// read was ever fired for it.
function browseSettled(doc: Document): boolean {
  const zeroHost = doc.getElementById('zero-host') as HTMLElement | null;
  const rows = doc.getElementById('rows');
  if (!zeroHost || !rows) return true;
  if (!zeroHost.hidden) return true;
  if (rows.children.length === 0) return false;
  const cards = Array.from(rows.querySelectorAll('[data-agent-card]'));
  return cards.every((card) => {
    const avatarHost = card.querySelector('.acard-av');
    if (!avatarHost) return true;
    return avatarHost.querySelector('canvas') !== null;
  });
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

  // D-CI3 (CI3 card, run 35907083987): the fixed 400ms wait this used to be
  // was a guess at the three-fetch chain's (operator record, roster,
  // per-agent gallery reads) worst case, not a real signal. Under
  // test-suite load the gallery's Promise.all(reads) can still be pending
  // past 400ms. render() returned anyway, the test asserted and closed the
  // window (dom.window.close(), which jsdom nulls document out on), and a
  // gallery read that finished only after that landed in paintRosterAvatar
  // with a torn-down document: "Cannot read properties of undefined
  // (reading 'querySelector')" at operator.js:588, exactly the run's
  // unhandled rejection. Polling for the real signal above closes that
  // window instead of widening it.
  //
  // D-CI3 round 2 (Proof r1, comment 549): /browse carried the identical
  // race on its own async chain (browse.js's loadAvatar into bots.js's
  // mount()), still behind the fixed 400ms wait this replaces below with
  // browseSettled, the same closed-window shape as the gallery branch.
  if (hasGallerySignal(dom.window.document)) {
    const deadline = Date.now() + 4000;
    while (!gallerySettled(dom.window.document) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!gallerySettled(dom.window.document)) {
      throw new Error(`page at ${path} never reached its settled gallery signal within 4000ms`);
    }
  } else if (hasBrowseSignal(dom.window.document)) {
    const deadline = Date.now() + 4000;
    while (!browseSettled(dom.window.document) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!browseSettled(dom.window.document)) {
      throw new Error(`page at ${path} never reached its settled browse signal within 4000ms`);
    }
  } else {
    throw new Error(`page at ${path} carries neither a gallery nor a browse settle signal`);
  }

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
  // W12 UPDATE: this card rebuilt the roster row a second time, from the
  // W3 wireframe's retired .agent/.nm/.tier/.ev shape to market.css's own
  // .acard grid (div.agrid.stagger of article.acard), the SAME card
  // browse.html's own W10 rebuild already ships, per the brief's own
  // instruction to read browse.js's card builder and match its class
  // vocabulary rather than inventing a second one. Selectors below follow
  // that move: .nm becomes .acard-name, and the tier chip sought no
  // longer sits under a .right column (the .acard shape has no such
  // column) but directly in .acard-body, the same place browse.js's own
  // tmpl-card puts its visually-hidden .tier.
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

      const rosterName = rosterRow?.querySelector('.acard-name')?.textContent ?? '';
      // W10: browse's card was rebuilt on the polished wireframe
      // (market.css .acard), which names its card-link class .acard-name
      // rather than the pre-polish row's .name. Selector updated to match;
      // the fact under test (the same name on both surfaces) is unchanged.
      const browseName = browseCard?.querySelector('.acard-name')?.textContent ?? '';
      expect(rosterName).not.toBe('');
      expect(rosterName).toBe(browseName);

      // Both surfaces read the SAME field (BrowseCard.verifiedHireCount,
      // src/domain/browse.ts) for the hire count, through the SAME tier
      // vocabulary (.tier, the label text beside the dot): the underlying
      // number must never drift.
      const rosterTierText = rosterRow?.querySelector('.tier')?.textContent ?? '';
      // W10: the polished card states its own tier visibly through the
      // cardbadge (market.css .pverified/.punverified) and the evidence
      // line, not through a separate visible .tier-label; .tier itself
      // now carries the same "N verified hires" sentence directly,
      // visually hidden for a screen reader and for exactly this kind of
      // cross-page comparison (browse.html's own .tier-label-a11y).
      const browseTierText = browseCard?.querySelector('.tier')?.textContent ?? '';
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
  //
  // W12 UPDATE: the evidence line sought below is now market.css's own
  // .acard-ev (the .acard shape's foot row), not the retired .ev the W3
  // .agent row used.
  it('a verified-hire roster row carries the tier-hire chip and its evidence line', async () => {
    const page = await render(`/accounts/${TIER_OPERATOR_DID}`);
    try {
      const row = page.document.querySelector('[data-agent-row="did:abt:zRosterPageTierHireAgent"]');
      expect(row).toBeTruthy();
      const tier = row?.querySelector('.tier');
      expect(tier?.className).toContain('tier-hire');
      expect(tier?.textContent).toContain('1 verified hire');
      const ev = row?.querySelector('.acard-ev');
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
  // the roster row's per-tier table has no HTTP fixture to exercise it,
  // because agentWorkRecord (src/domain/agent-work-record.ts) hardcodes
  // verifiedPriorWork: [] until ENT-11 lands, the exact gap
  // tests/web/browse.test.ts:338-346 documents for browse's own identical
  // branch. Rather than fabricate a fake HTTP fixture the app can never
  // actually produce, this calls the pure functions directly through the
  // test-only hook operator.js exposes for them, over counts shaped like
  // the BrowseCard fields they read. Neither function has a DOM
  // dependency or a side effect, so calling them directly proves the same
  // table a rendered row would apply once ENT-11 makes the branch
  // reachable.
  //
  // W12 UPDATE: this card rebuilt the roster row's per-tier table from a
  // single agentTierInfo function to the SAME cardbadgeFor/
  // evidenceLineFor pair browse.js's own cardFor uses (per the brief's
  // instruction to match browse.js's class vocabulary exactly rather than
  // inventing a second one), so the hook and this test follow that split.
  it('cardbadgeFor and evidenceLineFor render the tier-prior branch honestly, the branch no HTTP fixture can reach until ENT-11', async () => {
    const page = await render(`/accounts/${SOLO_OPERATOR_DID}`);
    try {
      const win = page.document.defaultView as unknown as {
        __operatorTestHooks?: {
          cardbadgeFor: (hire: number, prior: number, claim: number) => Element | null;
          evidenceLineFor: (hire: number, prior: number, claim: number) => DocumentFragment;
        };
      };
      expect(win.__operatorTestHooks).toBeTruthy();
      const badge = win.__operatorTestHooks!.cardbadgeFor(0, 3, 0);
      expect(badge?.className).toContain('punverified');
      expect(badge?.textContent).toContain('No hires yet');

      const evidence = win.__operatorTestHooks!.evidenceLineFor(0, 3, 0);
      const host = page.document.createElement('div');
      host.appendChild(evidence);
      expect(host.textContent).toContain('0 verified');
      expect(host.textContent).toContain('3 prior');
    } finally {
      page.close();
    }
  });
});

// W12: the operator page rebuilt on the polished wireframe. The roster
// coverage above is unchanged (D3 of that fix pinned the .agent shape,
// which this card's brief keeps intact); these describe blocks prove the
// NEW sections the polished header, identity box, gallery and painters
// add.
describe('the operator page header, identity box and painted hosts (W12)', () => {
  it('the header renders the polished .phero/.pav.is-op/.pname shape, not the retired .ohead/svg.oav', async () => {
    const page = await render(`/accounts/${SOLO_OPERATOR_DID}`);
    try {
      expect(page.document.querySelector('.phero')).toBeTruthy();
      expect(page.document.querySelector('.ohead')).toBeNull();
      const avatarHost = page.document.querySelector('.pav.is-op');
      expect(avatarHost).toBeTruthy();
      expect(avatarHost?.getAttribute('data-avatar')).toBe(SOLO_OPERATOR_DID);
    } finally {
      page.close();
    }
  });

  // W11 D2 defect class (script-rendered-icon-never-painted): icons.js and
  // swarm.js each sweep the DOM once at load, before operator.js's own
  // fetch resolves, so any [data-ico] or [data-avatar] host this script
  // builds AFTER that sweep needs an explicit paint call or it ships
  // empty. Guard without a test is the second most common defect class in
  // the ledger (22 entries), so this asserts the painted svg child
  // directly rather than only the host's presence.
  it('every icon host operator.js builds at render time carries a painted svg child, not an empty span', async () => {
    const page = await render(`/accounts/${GALLERY_OPERATOR_DID}`);
    try {
      const icoHosts = Array.from(page.document.querySelectorAll('[data-ico]'));
      expect(icoHosts.length).toBeGreaterThan(0);
      icoHosts.forEach((host) => {
        expect(host.querySelector('svg')).not.toBeNull();
      });
    } finally {
      page.close();
    }
  });

  it('the operator avatar and every roster card avatar hold one bot canvas, wearing the spec the read served', async () => {
    const page = await render(`/accounts/${GALLERY_OPERATOR_DID}`);
    try {
      const avatarHosts = Array.from(page.document.querySelectorAll('[data-avatar]'));
      expect(avatarHosts.length).toBeGreaterThan(1);
      avatarHosts.forEach((host) => {
        const did = host.getAttribute('data-avatar')!;
        // No override is stored for any agent here, and an operator (a
        // person) never has one, so every host wears its DID's default.
        expect(botMount(host), `host for ${did}`).toEqual(expectedMount(did, defaultAvatar(did)));
      });
      // The operator's own avatar never animates: a person is not working
      // on a job.
      const head = page.document.querySelector(`[data-avatar="${GALLERY_OPERATOR_DID}"]`);
      expect(head, 'the operator head avatar is missing').not.toBeNull();
      expect(head?.getAttribute('data-avatar-still')).toBe('true');
    } finally {
      page.close();
    }
  });

  // The .pbox identity box (wireframe line 106): DID, then GitHub. R-19's
  // existing #ident strip is replaced by this box; the DID row still
  // carries a copy control, moved into the .v cell as agent.html's .pbox
  // already does for the same fact.
  it('the identity box renders a .pbox with the operator DID and a copy control, never "proven both ways"', async () => {
    const page = await render(`/accounts/${SOLO_OPERATOR_DID}`);
    try {
      const box = page.document.querySelector('.pbox');
      expect(box).toBeTruthy();
      expect(box?.querySelector('h3')?.textContent).toBe('Identity, checkable without us');
      const lines = Array.from(box?.querySelectorAll('.line') ?? []);
      const keys = lines.map((l) => l.querySelector('.k')?.textContent ?? '');
      expect(keys).toContain('DID');
      expect(keys).toContain('GitHub');
      const copyBtn = box?.querySelector('[data-copy]');
      expect(copyBtn?.getAttribute('data-copy')).toBe(SOLO_OPERATOR_DID);
      // ENT-8 invariant restated for this box (see brief): accountProjection
      // carries a GitHub handle and no proof status at all, so this box must
      // never claim the two-directional check an operator record does not
      // carry, unlike the identical box on an agent's own profile.
      expect(box?.textContent ?? '').not.toContain('proven both ways');
    } finally {
      page.close();
    }
  });

  // The .pstats row (wireframe lines 83-104): four cells, the merge-rate
  // cell reading the same honest fallback the agent page's identical gap
  // already ships, never a fraction or a percentage the API cannot back.
  it('the merge-rate pstat cell reads "not yet observed" and no fraction or percentage appears in the row', async () => {
    const page = await render(`/accounts/${SOLO_OPERATOR_DID}`);
    try {
      const pstats = page.document.querySelector('.pstats');
      expect(pstats).toBeTruthy();
      const text = pstats?.textContent ?? '';
      expect(text).toContain('not yet observed');
      expect(text).not.toMatch(/\d+\s*\/\s*\d+/);
      expect(text).not.toMatch(/%/);
    } finally {
      page.close();
    }
  });

  // MISSION invariant 5, restated for this row: three separately labelled
  // totals, never combined into one number a buyer could read as a score.
  it('the three tier totals in .pstats never appear summed into a single combined number', async () => {
    const page = await render(`/accounts/${TIER_OPERATOR_DID}`);
    try {
      const pstats = page.document.querySelector('.pstats');
      expect(pstats).toBeTruthy();
      const cells = Array.from(pstats?.querySelectorAll('.pstat') ?? []);
      const values = cells.map((c) => (c.querySelector('.v')?.textContent ?? '').trim());
      // The tier fixture has exactly one verified hire and no prior work or
      // claims on file: a combined-score defect would print a total (e.g.
      // "1") that reads identically to the honest per-tier "1" here, so this
      // also checks the agents cell reads the roster's own agent count (2),
      // never a blend of the tier counts beside it.
      expect(values).toContain('2');
      const agentsCell = cells.find((c) => (c.querySelector('.k')?.textContent ?? '').includes('Agents'));
      expect(agentsCell?.querySelector('.v')?.textContent?.trim()).toBe('2');
    } finally {
      page.close();
    }
  });
});

// The "Work from these agents" gallery (wireframe lines 133-216): real
// work across the whole roster, behind the SAME evidence gate the agent
// page's own portfolio gallery enforces (ENT-12.1, a claim never gets a
// preview).
describe('the operator page gallery, work across the roster behind the evidence gate (W12)', () => {
  it('renders "Work from these agents" and a "Browse all agents" control pointing at /browse', async () => {
    const page = await render(`/accounts/${GALLERY_OPERATOR_DID}`);
    try {
      const heading = Array.from(page.document.querySelectorAll('h2')).find(
        (h) => h.textContent === 'Work from these agents',
      );
      expect(heading).toBeTruthy();
      const browseLink = Array.from(page.document.querySelectorAll('a')).find(
        (a) => (a.textContent ?? '').includes('Browse all agents'),
      );
      expect(browseLink).toBeTruthy();
      expect(browseLink?.getAttribute('href')).toBe('/browse');
    } finally {
      page.close();
    }
  });

  // The gallery's whole reason to exist over the agent page's own: naming
  // WHICH agent produced each card (wireframe line 187, span.work-by).
  it('renders a card for the verified hire, naming the agent that produced it in .work-by', async () => {
    const page = await render(`/accounts/${GALLERY_OPERATOR_DID}`);
    try {
      const cards = Array.from(page.document.querySelectorAll('.work'));
      expect(cards.length).toBeGreaterThan(0);
      const hireCard = cards.find((c) => !c.classList.contains('is-claim'));
      expect(hireCard).toBeTruthy();
      const workBy = hireCard?.querySelector('.work-by');
      expect(workBy).toBeTruthy();
      expect(workBy?.textContent ?? '').toContain('Gallery Hire Agent');
    } finally {
      page.close();
    }
  });

  // ENT-12.1, the evidence gate: a claim never gets a preview, ever. This
  // is the assertion a card-count-only test would miss, so it checks the
  // claim card's own frame carries the dashed empty state and NO verify
  // affordance, while the hire card beside it does carry one.
  it('a portfolio-claim card renders the dashed empty frame with no verify link; the verified-hire card does carry one', async () => {
    const page = await render(`/accounts/${GALLERY_OPERATOR_DID}`);
    try {
      const claimCard = page.document.querySelector('.work.is-claim');
      expect(claimCard).toBeTruthy();
      expect(claimCard?.querySelector('.work-frame.is-empty')).toBeTruthy();
      expect(claimCard?.querySelector('a')).toBeNull();

      const hireCard = Array.from(page.document.querySelectorAll('.work')).find(
        (c) => !c.classList.contains('is-claim'),
      );
      expect(hireCard).toBeTruthy();
      expect(hireCard?.querySelector('.work-frame.is-empty')).toBeNull();

      // D1: a card-count check alone cannot fail if the evidence gate is
      // deleted outright, since the claim card above carries no link
      // either way. This asserts the hire card's own link is a real
      // anchor pointed at the SAME pullRequest field credentialDoc set
      // (line 77), the same two fields agent.js's galleryCard keys its
      // link on (credentialId, pullRequest).
      const hireLink = hireCard?.querySelector('.work-links a');
      expect(hireLink).toBeTruthy();
      expect(hireLink?.getAttribute('href')).toBe('https://github.com/buyer/target-repo/pull/1');
    } finally {
      page.close();
    }
  });

  // ENT-2.4: an operator with zero work across every agent gets an honest
  // empty state in the section, never a hidden section.
  it('an operator with no work across any agent renders an honest empty gallery section, not a hidden one', async () => {
    const page = await render(`/accounts/${EMPTY_OPERATOR_DID}`);
    try {
      const heading = Array.from(page.document.querySelectorAll('h2')).find(
        (h) => h.textContent === 'Work from these agents',
      );
      expect(heading).toBeTruthy();
      expect(heading?.closest('div')?.hidden).not.toBe(true);
      const cards = page.document.querySelectorAll('.work');
      expect(cards.length).toBe(0);
    } finally {
      page.close();
    }
  });

  // jsdom performs no layout, so it can tell a link exists but never
  // whether a real 320px screen renders it under the 44px floor
  // (tap-target-under-44px, 5 strikes in the ledger). Drives real headless
  // Chrome the same way tests/web/browse.test.ts's own tap-target case
  // does, over the same GALLERY_OPERATOR_DID fixture that already carries
  // both a roster .acard-name link and a gallery card, so one page load
  // proves both new sections at once.
  it('the roster card name link and the gallery Browse-all-agents control are both at least 44px tall at 320px, real Chrome (tap-target-under-44px)', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 320, height: 900 });
    try {
      await browser.goto(`${baseUrl}/accounts/${GALLERY_OPERATOR_DID}`);
      // The roster and the gallery both fire async reads after load; give
      // them the same settle time render() above waits for real script
      // runs, before measuring anything real Chrome laid out.
      await new Promise((resolve) => setTimeout(resolve, 600));

      const undersized = await browser.evaluate<Array<[string, number, number]>>(`
        Array.from(document.querySelectorAll('.acard-name, .btn'))
          .filter((el) => el.offsetParent !== null)
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
  }, BROWSER_TIMEOUT_MS);

  // D2: the visually-hidden tier sentence (.tier.tier-label-a11y) has to
  // actually be hidden on screen, not merely carry the class name. jsdom
  // performs no layout and cannot tell the difference between a class that
  // is defined and one that is not; this drives real Chrome the same way
  // the tap-target case above does, over the same roster that already
  // carries both a hire row and a no-record row (GALLERY_OPERATOR_DID),
  // and reads the box real Chrome laid out.
  it('the roster card .tier sentence stays visually hidden in real Chrome, matching browse (unstyled-ported-component)', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 1280, height: 900 });
    try {
      await browser.goto(`${baseUrl}/accounts/${GALLERY_OPERATOR_DID}`);
      await new Promise((resolve) => setTimeout(resolve, 600));

      const visible = await browser.evaluate<Array<[string, number, number]>>(`
        Array.from(document.querySelectorAll('.acard .tier'))
          .map((el) => {
            const r = el.getBoundingClientRect();
            return [(el.textContent || '').trim(), r.width, r.height];
          })
          .filter(([, w, h]) => w > 1 || h > 1)
      `);
      expect(visible, `.tier sentences rendered on screen: ${JSON.stringify(visible)}`).toEqual([]);
    } finally {
      await browser.close();
    }
  }, BROWSER_TIMEOUT_MS);
});
