// The league look (t_c662b9f5, DESIGN.md 2.1, 2.6, 2.8, 6.1): what the
// rebuilt pages promise, pinned as rules a browser measures rather than as
// screenshots someone has to eyeball.
//
//   the office footer   every page with chrome carries it, it builds its room
//                       even on pages that load no bot engine up front, it
//                       runs its loop when motion is allowed, and under
//                       prefers-reduced-motion it stands still on a composed
//                       frame. No part of it is jade: --check means "we
//                       watched this happen" and nothing in a drawing was.
//   the player card     browse draws one card per agent, the card field is
//                       the agent's own colour, the jade stamp shows only on
//                       an agent with a checked job, and a card with nothing
//                       checked carries no badge of any kind.
//   the phone menu      closed by default below 761px, a 44px button, and
//                       the open state neither widens the page nor hides a
//                       link under the 44px floor.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';
import { createApp } from '../../src/api/app.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
} from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';

const BROWSER_TIMEOUT_MS = 45_000;
const here = dirname(fileURLToPath(import.meta.url));
const pagesDir = join(here, '../../src/web/pages');

const OPERATOR_DID = 'did:abt:zLeagueOperator';
const HIRED_DID = 'did:abt:zLeagueHired';
const COLD_DID = 'did:abt:zLeagueCold';
const JADE = 'rgb(70, 195, 154)'; // --check, #46C39A

function delegation(agentDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:league-${agentDid}`,
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
        repository: 'buyer/league-repo',
        pullRequest: 'https://github.com/buyer/league-repo/pull/1',
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
  } as unknown as VerifiableCredential;
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const agentRepo = new MemoryAgentRepository();
  const jobRepo = new MemoryJobRepository();
  const credentialRepo = new MemoryCredentialRepository();
  await agentRepo.create({
    did: HIRED_DID, operatorDid: OPERATOR_DID, delegation: delegation(HIRED_DID),
    name: 'League Hired Agent', skills: ['frontend'], githubLogin: null,
  });
  await agentRepo.create({
    did: COLD_DID, operatorDid: OPERATOR_DID, delegation: delegation(COLD_DID),
    name: 'League Cold Agent', skills: ['welding'], githubLogin: null,
  });
  const buyer = 'did:example:league-buyer';
  const draft = {
    id: 'league-job-1', buyerDid: buyer, repository: 'buyer/league-repo', brief: 'Fix it', briefHash: 'sha256:brief',
    confirmedSpecHash: null, status: 'draft' as const, criteria: [], priceUsd: null, rail: null,
    priceAcceptedByBuyer: false, priceAcceptedByAgent: false, depositPercent: 25, redoAllowance: 1, redoUsedCount: 0,
    redoRequestedCriterionIndex: null, redoRequestedAt: null, redoRefusedAt: null, stagedLapseExtensionDays: 0,
    deliveryWindowDays: null, pullRequestUrl: null, mergeCommit: null, mergedAt: null, confirmedAt: null, submittedAt: null,
    deadline: null, createdAt: new Date('2026-08-01T00:00:00Z'), stagedAt: null, stagedCommit: null, stagingRepo: null,
    baseCommit: null, stagingRepoDeleteAfter: null, citedCloseCriterionIndex: null, citedCloseReasonText: null,
    citedCloseAuthorDid: null, citedCloseAt: null, deemedCompletedAt: null, agentDid: HIRED_DID,
  };
  await jobRepo.create(draft);
  await jobRepo.complete(
    { ...draft, status: 'completed', mergeCommit: 'leaguec0ffee1', mergedAt: new Date('2026-08-30T00:00:00Z') },
    { jobId: draft.id, buyerDid: buyer, agentDid: HIRED_DID, mergeCommit: 'leaguec0ffee1', completedAt: new Date('2026-08-30T00:00:00Z') },
  );
  await credentialRepo.save({
    completedJobId: draft.id,
    subjectDid: HIRED_DID,
    document: credentialDoc('https://platform.example/v1/credentials/league-job-1', HIRED_DID, 'leaguec0ffee1', buyer),
    repositoryPublic: true,
  });
  const app = createApp(new MemoryAccountRepository(), agentRepo, undefined, undefined, jobRepo, undefined, undefined, credentialRepo);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function open(path: string, width: number, motion: 'reduce' | 'no-preference'): Promise<RealBrowser> {
  const b = await RealBrowser.launch({ width, height: 900 });
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion }] });
  await b.goto(`${baseUrl}${path}`, 900);
  return b;
}

// Scrolls the footer into view, waits for the lazy engine and the loop, and
// reads the scene clock twice, 700ms apart.
const OFFICE_PROBE = `
  new Promise(function (resolve) {
    window.scrollTo(0, document.body.scrollHeight);
    var tries = 0;
    (function wait() {
      var root = document.querySelector('[data-office]');
      var s = root && root.__faOffice;
      if (!s && tries++ < 40) { setTimeout(wait, 100); return; }
      if (!s) { resolve({ built: false }); return; }
      var t1 = s.t;
      setTimeout(function () {
        var jade = [];
        root.querySelectorAll('*').forEach(function (e) {
          var cs = getComputedStyle(e);
          ['color', 'backgroundColor', 'borderTopColor', 'fill', 'stroke'].forEach(function (k) {
            if (cs[k] === '${JADE}') jade.push(e.className + ' ' + k);
          });
        });
        resolve({
          built: true,
          t1: t1,
          t2: s.t,
          running: s.running,
          live: root.classList.contains('is-live'),
          canvases: root.querySelectorAll('canvas').length,
          jade: jade,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        });
      }, 700);
    })();
  })
`;

type OfficeProbe = {
  built: boolean; t1: number; t2: number; running: boolean; live: boolean;
  canvases: number; jade: string[]; overflow: number;
};

describe('the office footer is on every page with chrome', () => {
  it('every built page but the OAuth bounce declares [data-office] and loads office.js and office.css', () => {
    const pages = readdirSync(pagesDir).filter((f) => f.endsWith('.html'));
    expect(pages.length).toBeGreaterThan(20);
    const missing: string[] = [];
    for (const page of pages) {
      if (page === 'auth-callback-success.html') continue; // redirects in under a second, no chrome
      const html = readFileSync(join(pagesDir, page), 'utf8');
      if (!/data-office/.test(html) || !html.includes('/js/office.js') || !html.includes('/css/office.css')
        || !html.includes('/css/league.css')) {
        missing.push(page);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('the office footer, in a real browser', () => {
  // /verify loads no bot engine of its own, so it proves the lazy load;
  // /browse loads the engine up front.
  it.each([['/browse'], ['/verify']])('%s: builds the room, runs its loop, and draws no jade', async (path) => {
    if (!hasRealBrowser()) return;
    const b = await open(path, 1280, 'no-preference');
    try {
      const o = await b.evaluate<OfficeProbe>(OFFICE_PROBE);
      expect(o.built, 'the office room never built').toBe(true);
      expect(o.canvases, 'no bots in the room').toBeGreaterThan(0);
      expect(o.live).toBe(true);
      expect(o.running, 'the loop is not running with motion allowed').toBe(true);
      expect(o.t2, 'the scene clock did not advance').not.toBe(o.t1);
      expect(o.jade, 'jade is reserved for what was witnessed; the office is a drawing').toEqual([]);
    } finally {
      await b.close();
    }
  }, BROWSER_TIMEOUT_MS);

  it('under prefers-reduced-motion the room stands still on a composed frame', async () => {
    if (!hasRealBrowser()) return;
    const b = await open('/browse', 1280, 'reduce');
    try {
      const o = await b.evaluate<OfficeProbe>(OFFICE_PROBE);
      expect(o.built).toBe(true);
      expect(o.canvases, 'the still frame still shows the bots').toBeGreaterThan(0);
      expect(o.live).toBe(false);
      expect(o.running).toBe(false);
      expect(o.t2, 'the scene clock moved under reduced motion').toBe(o.t1);
    } finally {
      await b.close();
    }
  }, BROWSER_TIMEOUT_MS);

  it('at 320px the footer does not widen the page', async () => {
    if (!hasRealBrowser()) return;
    const b = await open('/browse', 320, 'no-preference');
    try {
      const o = await b.evaluate<OfficeProbe>(OFFICE_PROBE);
      expect(o.built).toBe(true);
      expect(o.overflow).toBe(0);
    } finally {
      await b.close();
    }
  }, BROWSER_TIMEOUT_MS);
});

describe('the player card on browse', () => {
  it('one card per agent in its own colour; the jade stamp only where a job was checked', async () => {
    if (!hasRealBrowser()) return;
    const b = await open('/browse', 1280, 'reduce');
    try {
      const cards = await b.evaluate<Array<{
        did: string; colour: string; stamp: boolean; stampColour: string; badges: number; head: string; skillClass: string;
      }>>(`
        new Promise(function (resolve) {
          setTimeout(function () {
            resolve([].map.call(document.querySelectorAll('[data-agent-card]'), function (c) {
              var tick = c.querySelector('.pc-head svg');
              var skill = c.querySelector('.pc-skill');
              return {
                did: c.getAttribute('data-agent-card'),
                colour: c.style.getPropertyValue('--c'),
                stamp: !!tick,
                stampColour: tick ? getComputedStyle(tick).color : '',
                badges: c.querySelectorAll('[class*="badge"]').length,
                head: c.querySelector('.pc-head').textContent.replace(/\\s+/g, ' ').trim(),
                skillClass: skill ? skill.className : ''
              };
            }));
          }, 600);
        })
      `);
      expect(cards.map((c) => c.did).sort()).toEqual([COLD_DID, HIRED_DID].sort());
      const hired = cards.find((c) => c.did === HIRED_DID)!;
      const cold = cards.find((c) => c.did === COLD_DID)!;

      expect(hired.colour, 'the card field is the agent\u2019s own colour').toMatch(/^#[0-9A-F]{6}$/i);
      expect(cold.colour).toMatch(/^#[0-9A-F]{6}$/i);
      expect(hired.stamp, 'a checked job earns the stamp').toBe(true);
      expect(hired.stampColour, 'the stamp is the --check jade').toBe(JADE);
      expect(hired.head).toBe('1 checked job');
      expect(cold.stamp, 'no checked job, no stamp').toBe(false);
      expect(cold.head).toBe('0 checked jobs');
      expect(cold.badges, 'a card with nothing checked carries no badge of any kind (ENT-2.4)').toBe(0);

      // A skill that names a discipline keeps its tint; free text does not.
      expect(hired.skillClass).toContain('cat-frontend');
      expect(cold.skillClass).toBe('pc-skill');
    } finally {
      await b.close();
    }
  }, BROWSER_TIMEOUT_MS);
});

// JADE ONLY BESIDE A TICK (DESIGN.md 2.2). --check means "we watched this
// happen", so every visible element that paints jade must carry a tick or a
// shield tick itself or have one as a sibling, and a zero count must never be
// jade. The token gate reads literals only; this reads computed colour, so it
// also catches var(--check) and var(--t-hire) used in the wrong place. The
// cold agent's page is the zero case: nothing on it may be jade at all.
const JADE_SWEEP = `
  new Promise(function (resolve) {
    var tries = 0;
    (function wait() {
      var s = document.getElementById('summary');
      if (s && s.hasAttribute('data-pending') && tries++ < 40) { setTimeout(wait, 100); return; }
      setTimeout(function () {
        // A tick is a drawn tick, not just any icon: the git-merge glyph on
        // a node is an svg too. These are the tick strokes the site draws
        // (icons.js shield-check, check and check-circle; pcard.js pc-tick).
        var TICKS = ['m9 12 2 2 4-4', 'm5 12 5 5L20 7', 'm8.5 12 2.5 2.5L16 9.5', 'M4.6 8.2l2.2 2.2 4.6-4.9'];
        function isTick(svg) {
          return [].some.call(svg.querySelectorAll('path'), function (p) { return TICKS.indexOf(p.getAttribute('d')) !== -1; });
        }
        function holdsTick(el) {
          if (el.tagName.toLowerCase() === 'svg') return isTick(el);
          return [].some.call(el.querySelectorAll('svg'), isTick);
        }
        function hasTick(el) {
          if (holdsTick(el)) return true;
          var p = el.parentElement;
          if (!p) return false;
          return [].some.call(p.children, function (c) { return c !== el && holdsTick(c); });
        }
        var bad = [];
        var jadeCount = 0;
        document.querySelectorAll('body *').forEach(function (e) {
          if (e.closest('svg') || e.closest('[aria-hidden="true"]')) return;
          var r = e.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return;
          var cs = getComputedStyle(e);
          if (cs.visibility === 'hidden' || cs.display === 'none') return;
          var props = ['color', 'backgroundColor', 'borderTopColor'].filter(function (k) { return cs[k] === '${JADE}'; });
          if (props.length === 0) return;
          // color only matters where the element draws text or an icon itself
          if (props.length === 1 && props[0] === 'color' && !e.textContent.trim() && !e.querySelector('svg')) return;
          jadeCount++;
          var text = e.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40);
          if (!hasTick(e)) bad.push((e.id || e.className || e.tagName) + ' [' + props.join(',') + '] "' + text + '"');
          if (/^0(\\D|$)/.test(text)) bad.push('zero in jade: ' + (e.id || e.className) + ' "' + text + '"');
        });
        resolve({ bad: bad, jadeCount: jadeCount });
      }, 500);
    })();
  })
`;

describe('jade sits only beside a tick, and never on a zero', () => {
  // 'some': the page shows checked work, so the sweep must find jade (else
  // it proves nothing). 'none': the zero case, no jade at all. 'any': the
  // page may or may not show jade (the sign-in fan is aria-hidden).
  it.each([
    ['/', 'some'],
    ['/browse', 'some'],
    ['/how', 'some'],
    ['/signin', 'any'],
    [`/agents/${HIRED_DID}`, 'some'],
    [`/agents/${COLD_DID}`, 'none'],
    // No account behind this DID in the fixture, so this is the not-found
    // state, whose stat row still renders a 0. Nothing on it was watched.
    [`/accounts/${OPERATOR_DID}`, 'none'],
  ])('%s', async (path, jade) => {
    if (!hasRealBrowser()) return;
    const b = await open(path, 1280, 'reduce');
    try {
      const s = await b.evaluate<{ bad: string[]; jadeCount: number }>(JADE_SWEEP);
      expect(s.bad, 'jade without a tick, or a zero painted jade').toEqual([]);
      if (jade === 'none') expect(s.jadeCount, 'an agent with no checked hire shows no jade at all').toBe(0);
      if (jade === 'some') expect(s.jadeCount, 'the sweep found no jade on a page with checked work').toBeGreaterThan(0);
    } finally {
      await b.close();
    }
  }, BROWSER_TIMEOUT_MS);
});

describe('the phone menu', () => {
  it('at 320px: closed by default, a 44px button, and the open menu fits with 44px links', async () => {
    if (!hasRealBrowser()) return;
    const b = await open('/browse', 320, 'reduce');
    try {
      const m = await b.evaluate<{
        closedHidden: boolean; btn: number; expanded: string | null; openShown: boolean; overflow: number; smallest: number;
        escClosed: boolean;
      }>(`
        (function () {
          var nav = document.querySelector('nav.nav');
          var btn = nav.querySelector('.menu');
          var links = nav.querySelector('.links');
          var closedHidden = getComputedStyle(links).display === 'none';
          var r = btn.getBoundingClientRect();
          btn.click();
          var openShown = getComputedStyle(links).display !== 'none';
          var hs = [].map.call(links.querySelectorAll('a'), function (a) { return a.getBoundingClientRect().height; });
          var out = {
            closedHidden: closedHidden,
            btn: Math.min(r.width, r.height),
            expanded: btn.getAttribute('aria-expanded'),
            openShown: openShown,
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            smallest: Math.min.apply(null, hs)
          };
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          out.escClosed = btn.getAttribute('aria-expanded') === 'false' && document.activeElement === btn;
          return out;
        })()
      `);
      expect(m.closedHidden).toBe(true);
      expect(m.btn).toBeGreaterThanOrEqual(44);
      expect(m.expanded).toBe('true');
      expect(m.openShown).toBe(true);
      expect(m.overflow).toBe(0);
      expect(m.smallest).toBeGreaterThanOrEqual(44);
      expect(m.escClosed, 'Escape closes the menu and returns focus to the button').toBe(true);
    } finally {
      await b.close();
    }
  }, BROWSER_TIMEOUT_MS);
});
