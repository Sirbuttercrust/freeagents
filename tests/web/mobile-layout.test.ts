// M1: the mobile layout laws, measured in a real browser at 320px.
//
// TWO LAWS, ONE FILE, BECAUSE NEITHER CAN BE CHECKED WITHOUT LAYOUT.
//
// 1. No page widens the layout viewport past the screen. A phone that
//    cannot fit a page's widest element does not clip it: it widens the
//    layout viewport and scales the WHOLE page down to fit. Measured on
//    /browse at 320 with ten pages of results before this card: an
//    innerWidth of 608 against a clientWidth of 320, so every word on the
//    page rendered at about half size because of one row of pager buttons.
//    That is invisible to a test that reads computed styles, and invisible
//    to a screenshot taken at the wrong width.
//
// 2. Every field you can type into is at least 16px. Mobile Safari zooms
//    the page in when a text field under 16px takes focus and does not
//    zoom back out. Android Chrome does not, which is why this ships
//    unnoticed.
//
// jsdom performs no layout at all, so it can tell you a media query
// exists and never tell you whether the row overflows. The whole file
// drives real headless Chrome through tests/helpers/real-browser.ts, the
// same driver tests/web/job-wireframe.test.ts and tests/web/browse.test.ts
// already use for exactly this class of defect, and skips (rather than
// passes) when no Chrome is installed.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
} from '../../src/adapters/storage/memory.js';
import { createJob, type Job } from '../../src/domain/job.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession } from '../helpers/session-fixtures.js';
import type { Session } from '../../src/adapters/identity/session.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const NARROW = 320;
const PLATFORM_SEED = 'd'.repeat(64);

const OPERATOR_DID = 'did:abt:zM1Operator';
const AGENT_DID = 'did:abt:zM1Agent';
const BUYER_DID = 'did:example:m1-buyer';
const JOB_ID = 'm1-job-completed';

// Ten pages of results at browse.js's PAGE_SIZE of 10, which is what puts
// twelve controls (Previous, ten numbers, Next) in the pager. Fewer agents
// and the row fits on its own, so the test would pass against the very
// markup that shipped the defect.
const AGENT_COUNT = 100;

function delegation(agentDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:m1-${agentDid}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: OPERATOR_DID,
    issuanceDate: '2026-09-01T00:00:00.000Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-09-01T00:00:00.000Z',
      verificationMethod: `${OPERATOR_DID}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zM1FixtureNotVerifiedHere',
    },
  };
}

function credentialDoc(): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id: `https://freeagents.dev/v1/credentials/${JOB_ID}`,
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: 'did:abt:platform',
    validFrom: '2026-09-01T00:00:00.000Z',
    credentialSubject: {
      id: AGENT_DID,
      hire: {
        brief: 'sha256:m1-brief',
        repository: 'buyer/m1-repo',
        pullRequest: 'https://github.com/buyer/m1-repo/pull/4',
        mergedAt: '2026-09-02T00:00:00.000Z',
        mergeCommit: 'm1mergecommit',
        signedBy: `${AGENT_DID}#key-1`,
        buyer: BUYER_DID,
        additions: 120,
        deletions: 40,
        filesChanged: 7,
      },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zM1Proof' },
  };
}

function jobFixture(overrides: Partial<Job> & { id: string }): Job {
  const base = createJob(
    {
      id: overrides.id,
      buyerDid: BUYER_DID,
      agentDid: AGENT_DID,
      repository: 'buyer/m1-repo',
      brief: 'Rebuild the checkout flow so it stops dropping the cart on a refresh.',
    },
    new Date('2026-09-01T00:00:00Z'),
  );
  return { ...base, ...overrides };
}

let server: Server;
let baseUrl: string;
let buyerSession: Session;
let originalSeed: string | undefined;

// Every page src/web/static.ts routes, each with the query string that
// gives it something real to render. A page driven with no data lays out a
// handful of empty containers and would pass the width assertion while the
// populated page overflows, which is exactly how the pager survived until
// now: the sweep that found it drove /browse with a live database behind
// it, and the suite drove it with fourteen agents.
const PAGES: ReadonlyArray<readonly [label: string, path: string]> = [
  ['landing', '/'],
  ['how', '/how'],
  ['browse', '/browse'],
  ['browse, page 5 of 10', '/browse?page=5'],
  ['browse, last page', '/browse?page=10'],
  ['browse, zero results', '/browse?skill=nothing-matches-this'],
  ['signin', '/signin'],
  ['verify', '/verify'],
  ['verify, receipt loaded', `/verify?credential=${JOB_ID}`],
  ['agent', `/agents/${encodeURIComponent(AGENT_DID)}`],
  ['operator', `/accounts/${encodeURIComponent(OPERATOR_DID)}`],
  ['credential', `/v1/credentials/${JOB_ID}`],
  ['job', `/jobs/${JOB_ID}`],
  ['hire', `/hire?agent=${encodeURIComponent(AGENT_DID)}`],
  ['agreement', '/agreement?job=m1-job-proposed'],
  ['deposit', '/deposit?job=m1-job-confirmed'],
  ['staged', '/staged?job=m1-job-staged'],
  ['pullrequest', '/pullrequest?job=m1-job-submitted'],
  ['myjobs', '/myjobs'],
  ['myagents', '/myagents'],
  ['outcomes', '/outcomes'],
  ['incoming', '/incoming'],
  ['conduct', '/conduct?account=m1-buyer-login'],
  ['dashboard', '/dashboard'],
  ['operatorjob', '/operatorjob?job=m1-job-staged'],
  ['settings', '/settings'],
  ['notfound', '/no-such-page-exists'],
];

beforeAll(async () => {
  originalSeed = process.env.FREEAGENTS_PLATFORM_SEED;
  process.env.FREEAGENTS_PLATFORM_SEED = PLATFORM_SEED;

  const agentRepo = new MemoryAgentRepository();
  const accountRepo = new MemoryAccountRepository();
  const jobRepo = new MemoryJobRepository();
  const credentialRepo = new MemoryCredentialRepository();

  await agentRepo.create({
    did: AGENT_DID,
    operatorDid: OPERATOR_DID,
    delegation: delegation(AGENT_DID),
    name: 'm1-detail-agent',
    skills: ['typescript', 'frontend'],
    githubLogin: 'm1-detail-agent-gh',
  });

  // The rest of the roster: enough for ten pages of results.
  for (let i = 0; i < AGENT_COUNT - 1; i += 1) {
    const did = `did:abt:zM1RosterAgent${String(i).padStart(3, '0')}`;
    await agentRepo.create({
      did,
      operatorDid: OPERATOR_DID,
      delegation: delegation(did),
      name: `m1-roster-agent-${i}`,
      skills: ['typescript'],
      githubLogin: null,
    });
  }

  await accountRepo.register({ did: OPERATOR_DID, githubLogin: 'm1-operator-login' });
  await accountRepo.register({ did: BUYER_DID, githubLogin: 'm1-buyer-login' });

  const criteria = [
    { text: 'The cart survives a refresh', proposedBy: 'agent' as const, acceptedByBuyer: true, acceptedByAgent: true },
    { text: 'No new lint errors', proposedBy: 'agent' as const, acceptedByBuyer: true, acceptedByAgent: true },
  ];
  const recent = new Date('2026-09-02T00:00:00Z');

  await jobRepo.create(
    jobFixture({
      id: 'm1-job-proposed',
      status: 'proposed',
      criteria,
      priceUsd: '400.00',
      rail: 'abt',
      deliveryWindowDays: 14,
    }),
  );
  await jobRepo.create(
    jobFixture({
      id: 'm1-job-confirmed',
      status: 'confirmed',
      criteria,
      priceUsd: '400.00',
      rail: 'abt',
      priceAcceptedByBuyer: true,
      priceAcceptedByAgent: true,
      confirmedAt: recent,
      confirmedSpecHash: 'sha256:m1-confirmed-spec',
    }),
  );
  await jobRepo.create(
    jobFixture({
      id: 'm1-job-staged',
      status: 'staged',
      criteria,
      priceUsd: '400.00',
      rail: 'abt',
      priceAcceptedByBuyer: true,
      priceAcceptedByAgent: true,
      confirmedAt: recent,
      confirmedSpecHash: 'sha256:m1-confirmed-spec',
      stagedAt: recent,
      stagedCommit: 'm1stagedcommit',
    }),
  );
  await jobRepo.create(
    jobFixture({
      id: 'm1-job-submitted',
      status: 'submitted',
      criteria,
      priceUsd: '400.00',
      rail: 'abt',
      priceAcceptedByBuyer: true,
      priceAcceptedByAgent: true,
      confirmedAt: recent,
      confirmedSpecHash: 'sha256:m1-confirmed-spec',
      stagedAt: recent,
      stagedCommit: 'm1stagedcommit',
      pullRequestUrl: 'https://github.com/buyer/m1-repo/pull/4',
      submittedAt: recent,
    }),
  );
  await jobRepo.create(
    jobFixture({
      id: JOB_ID,
      status: 'completed',
      criteria,
      priceUsd: '400.00',
      rail: 'abt',
      priceAcceptedByBuyer: true,
      priceAcceptedByAgent: true,
      confirmedAt: recent,
      confirmedSpecHash: 'sha256:m1-confirmed-spec',
      stagedAt: recent,
      stagedCommit: 'm1stagedcommit',
      pullRequestUrl: 'https://github.com/buyer/m1-repo/pull/4',
      submittedAt: recent,
      mergeCommit: 'm1mergecommit',
      mergedAt: recent,
    }),
  );

  await credentialRepo.save({
    completedJobId: JOB_ID,
    subjectDid: AGENT_DID,
    document: credentialDoc(),
    repositoryPublic: true,
  });

  const sessionAdapter = createSessionAdapter({
    github: fakeGitHubConfig(),
    fetchImpl: fakeGitHubFetch({ login: 'm1-buyer-login', id: 4242 }),
  });

  server = createApp(
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
  ).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  buyerSession = await mintSession(sessionAdapter);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (originalSeed === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
  else process.env.FREEAGENTS_PLATFORM_SEED = originalSeed;
});

interface PageMeasurement {
  readonly innerWidth: number;
  readonly clientWidth: number;
  readonly scrollWidth: number;
  readonly bodyScrollWidth: number;
  readonly viewportMeta: string | null;
  // Every element whose right edge is past the screen, named well enough to
  // fix without re-deriving it. An assertion that only reports a number
  // makes the next person repeat this whole investigation.
  readonly overflowing: ReadonlyArray<{ readonly name: string; readonly right: number; readonly width: number }>;
  // Proof that the exclusion above is safe: after trying to scroll all the
  // way right, the page has not moved. A fixed layer that somehow DID push
  // the page out would show up here as a non-zero scrollX even if
  // `overflowing` was filtered empty.
  readonly scrollXAfterScrollRight: number;
  readonly smallFields: ReadonlyArray<{ readonly name: string; readonly fontSize: string }>;
}

// One browser, one page, at a real phone's device metrics. `mobile: true`
// and touch emulation are what make `(pointer: coarse)` and the layout
// viewport behave the way a phone does; a bare window size does not, which
// is the same trap base.css's own 44px floor comment describes (a 320px
// headless window reports a FINE pointer).
async function measure(browser: RealBrowser, path: string): Promise<PageMeasurement> {
  await browser.send('Emulation.setDeviceMetricsOverride', {
    width: NARROW,
    height: 780,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await browser.goto(`${baseUrl}${path}`, 1200);

  return browser.evaluate<PageMeasurement>(`
    (function () {
      var doc = document.documentElement;
      var vw = window.innerWidth;
      var meta = document.querySelector('meta[name="viewport"]');
      function shown(el) {
        var r = el.getBoundingClientRect();
        var cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
      }
      function name(el) {
        var id = el.id ? '#' + el.id : '';
        var cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/)[0] : '';
        return el.tagName.toLowerCase() + id + cls;
      }
      // True when the element sits inside (or is) a fixed-position layer.
      // Walks up because the marks that bleed are descendants of the layer,
      // not the layer itself.
      function fixedLayer(el) {
        var p = el;
        while (p && p !== document.body) {
          if (getComputedStyle(p).position === 'fixed') return true;
          p = p.parentElement;
        }
        return false;
      }
      var overflowing = Array.prototype.slice.call(document.querySelectorAll('body *'))
        .filter(function (el) { return shown(el) && el.getBoundingClientRect().right > vw + 1; })
        // A fixed-position layer is positioned against the viewport, not
        // the document, so it cannot widen the page and cannot be scrolled
        // to: the landing page's two agent layers (.agent-layer, position
        // fixed, aria-hidden, pointer-events none, below the content) fly
        // 47 decorative marks past the right edge by design while the
        // document still measures exactly 320 and window.scrollX stays 0.
        // Excluded because the law being enforced is "nothing is pushed
        // off the screen", and an out-of-flow decoration pushes nothing.
        // The document-width assertions below are NOT relaxed for it:
        // if such a layer ever did widen the page, scrollWidth catches it.
        .filter(function (el) { return !fixedLayer(el); })
        .slice(0, 8)
        .map(function (el) {
          var r = el.getBoundingClientRect();
          return { name: name(el), right: Math.round(r.right), width: Math.round(r.width) };
        });
      var smallFields = Array.prototype.slice.call(document.querySelectorAll('input, select, textarea'))
        .filter(function (el) { return parseFloat(getComputedStyle(el).fontSize) < 16; })
        .map(function (el) {
          return { name: name(el), fontSize: getComputedStyle(el).fontSize };
        });
      // Last, because it moves the page: try to scroll right, read how far
      // it went, put it back.
      window.scrollTo(9999, 0);
      var scrollXAfterScrollRight = window.scrollX;
      window.scrollTo(0, 0);
      return {
        innerWidth: vw,
        clientWidth: doc.clientWidth,
        scrollWidth: doc.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        viewportMeta: meta ? meta.getAttribute('content') : null,
        overflowing: overflowing,
        scrollXAfterScrollRight: scrollXAfterScrollRight,
        smallFields: smallFields
      };
    })()
  `);
}

// The signed-in pages read their session out of sessionStorage before they
// fetch anything, so it has to be in place before the page's own script
// runs. Page.addScriptToEvaluateOnNewDocument is the only hook that is
// early enough; an evaluate() after goto() has already lost the race.
async function signIn(browser: RealBrowser): Promise<void> {
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(buyerSession))});`,
  });
}

describe('the browse pager fits a 320px screen with ten pages of results (M1 finding 1)', () => {
  it('does not widen the layout viewport, and still renders a working pager and ten results', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for the mobile layout measurement; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: NARROW, height: 780 });
    try {
      const measured = await measure(browser, '/browse');

      // The headline. Before this card: 608 against a clientWidth of 320,
      // because twelve 44px buttons in a nowrap row need 594px and the
      // content box is 292px.
      expect(
        measured.scrollWidth,
        `browse widened the layout viewport to ${measured.innerWidth}; overflowing: ${JSON.stringify(measured.overflowing)}`,
      ).toBe(NARROW);
      expect(measured.innerWidth).toBe(NARROW);
      expect(measured.overflowing).toEqual([]);

      // The pager is VISIBLE and complete, not fixed by hiding it. Ten
      // results on the page, a live Next, and the collapsed numbers still
      // in the document as working controls.
      const pager = await browser.evaluate<{
        hidden: boolean;
        totalButtons: number;
        visibleLabels: string[];
        nextEnabled: boolean;
        currentPage: string | null;
        cards: number;
        position: string;
        positionShown: boolean;
        widest: number;
      }>(`
        (function () {
          var host = document.getElementById('pager');
          var btns = Array.prototype.slice.call(host.querySelectorAll('button'));
          var visible = btns.filter(function (b) { return b.getBoundingClientRect().width > 0; });
          var next = btns[btns.length - 1];
          var current = btns.filter(function (b) { return b.getAttribute('aria-current') === 'page'; })[0];
          var pos = document.getElementById('pager-position');
          return {
            hidden: host.hidden,
            totalButtons: btns.length,
            visibleLabels: visible.map(function (b) { return (b.textContent || '').trim(); }),
            nextEnabled: !next.disabled,
            currentPage: current ? (current.textContent || '').trim() : null,
            cards: document.querySelectorAll('.acard').length,
            position: pos ? (pos.textContent || '').trim() : '',
            positionShown: pos ? pos.getBoundingClientRect().height > 0 : false,
            widest: Math.max.apply(null, visible.map(function (b) { return Math.round(b.getBoundingClientRect().right); }))
          };
        })()
      `);

      expect(pager.hidden).toBe(false);
      expect(pager.cards).toBe(10);
      expect(pager.totalButtons).toBe(12);
      expect(pager.visibleLabels).toEqual(['Previous', '1', '2', '3', 'Next']);
      expect(pager.currentPage).toBe('1');
      expect(pager.nextEnabled).toBe(true);
      expect(pager.widest).toBeLessThanOrEqual(NARROW);

      // The count the collapse takes off screen, stated rather than lost.
      expect(pager.position).toBe('Page 1 of 10');
      expect(pager.positionShown).toBe(true);
    } finally {
      await browser.close();
    }
  }, 60_000);

  // A window that does not move is a window that stops containing the
  // current page, which would leave a phone with no way to reach page 6.
  it('slides the three-number window so the current page is always one of them', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for the mobile layout measurement; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: NARROW, height: 780 });
    try {
      for (const [page, expected] of [
        [5, ['Previous', '4', '5', '6', 'Next']],
        [10, ['Previous', '8', '9', '10', 'Next']],
      ] as ReadonlyArray<readonly [number, string[]]>) {
        const measured = await measure(browser, `/browse?page=${page}`);
        expect(
          measured.scrollWidth,
          `browse page ${page} overflowed: ${JSON.stringify(measured.overflowing)}`,
        ).toBe(NARROW);

        const shown = await browser.evaluate<{ labels: string[]; current: string | null; position: string }>(`
          (function () {
            var btns = Array.prototype.slice.call(document.querySelectorAll('#pager button'));
            var visible = btns.filter(function (b) { return b.getBoundingClientRect().width > 0; });
            var current = btns.filter(function (b) { return b.getAttribute('aria-current') === 'page'; })[0];
            var pos = document.getElementById('pager-position');
            return {
              labels: visible.map(function (b) { return (b.textContent || '').trim(); }),
              current: current ? (current.textContent || '').trim() : null,
              position: pos ? (pos.textContent || '').trim() : ''
            };
          })()
        `);
        expect(shown.labels, `pager window on page ${page}`).toEqual(expected);
        expect(shown.current).toBe(String(page));
        expect(shown.position).toBe(`Page ${page} of 10`);
      }
    } finally {
      await browser.close();
    }
  }, 60_000);

  // The collapse is a width decision, so it must not survive the width
  // changing. A phone rotated to landscape, and every desktop, gets the
  // full numbered row back with no script re-run.
  it('restores all ten numbers, and drops the position line, above the breakpoint', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for the mobile layout measurement; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 1280, height: 900 });
    try {
      await browser.goto(`${baseUrl}/browse?page=5`, 1200);
      const wide = await browser.evaluate<{
        labels: string[];
        scrollWidth: number;
        clientWidth: number;
        positionShown: boolean;
      }>(`
        (function () {
          var btns = Array.prototype.slice.call(document.querySelectorAll('#pager button'));
          var visible = btns.filter(function (b) { return b.getBoundingClientRect().width > 0; });
          var pos = document.getElementById('pager-position');
          return {
            labels: visible.map(function (b) { return (b.textContent || '').trim(); }),
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            positionShown: pos ? pos.getBoundingClientRect().height > 0 : false
          };
        })()
      `);
      expect(wide.labels).toEqual(['Previous', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'Next']);
      expect(wide.positionShown).toBe(false);
      expect(wide.scrollWidth).toBe(wide.clientWidth);
    } finally {
      await browser.close();
    }
  }, 60_000);
});

describe('no page widens the layout viewport at 320px (M1, mobile-horizontal-overflow)', () => {
  it.each(PAGES)('%s lays out inside 320px', async (label, path) => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for the mobile layout measurement; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: NARROW, height: 780 });
    try {
      await signIn(browser);
      const measured = await measure(browser, path);

      // The viewport meta is what makes the other two numbers mean
      // anything: without it a phone lays the page out at 980px and every
      // width assertion below becomes a statement about a desktop.
      expect(measured.viewportMeta, `${label} is missing its viewport meta`).toContain('width=device-width');

      expect(
        measured.scrollWidth,
        `${label} (${path}) widened to ${measured.scrollWidth}; overflowing: ${JSON.stringify(measured.overflowing)}`,
      ).toBe(NARROW);
      expect(measured.innerWidth, `${label} scaled the page down to fit`).toBe(NARROW);
      expect(measured.bodyScrollWidth).toBe(NARROW);
      expect(measured.overflowing, `${label} has elements past the right edge`).toEqual([]);
      // The check that keeps the fixed-layer exclusion above honest: a
      // page that can be scrolled sideways has pushed something off
      // screen, whatever the element filter decided.
      expect(measured.scrollXAfterScrollRight, `${label} scrolls sideways`).toBe(0);
    } finally {
      await browser.close();
    }
  }, 60_000);
});

describe('every field you can type into is at least 16px at 320px (M1 findings 2 and 3)', () => {
  it.each(PAGES)('%s has no field under 16px', async (label, path) => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for the mobile layout measurement; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: NARROW, height: 780 });
    try {
      await signIn(browser);
      const measured = await measure(browser, path);
      expect(
        measured.smallFields,
        `${label} (${path}) would zoom iOS on focus: ${JSON.stringify(measured.smallFields)}`,
      ).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 60_000);

  // The two the sweep named, pinned by id rather than by sweep, so a page
  // that stops rendering one of them cannot quietly turn its case
  // vacuous.
  it('the browse search field and the verify receipt field are both 16px, by name', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for the mobile layout measurement; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: NARROW, height: 780 });
    try {
      for (const [path, id] of [
        ['/browse', 'q'],
        ['/verify', 'credential-id'],
      ] as ReadonlyArray<readonly [string, string]>) {
        await measure(browser, path);
        const field = await browser.evaluate<{ found: boolean; fontSize: string; shown: boolean }>(`
          (function () {
            var el = document.getElementById(${JSON.stringify(id)});
            if (!el) return { found: false, fontSize: '', shown: false };
            var r = el.getBoundingClientRect();
            return { found: true, fontSize: getComputedStyle(el).fontSize, shown: r.width > 0 && r.height > 0 };
          })()
        `);
        expect(field.found, `${path} no longer renders #${id}`).toBe(true);
        expect(field.shown, `#${id} is not visible on ${path}`).toBe(true);
        expect(parseFloat(field.fontSize), `#${id} on ${path} is ${field.fontSize}`).toBeGreaterThanOrEqual(16);
      }
    } finally {
      await browser.close();
    }
  }, 60_000);
});
