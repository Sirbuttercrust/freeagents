// FIX-B59: the identity strip's "Back to profile" keeps its whole label.
//
// The strip (.who) on /agreement, /hire and /jobs/<id> is a flex row: the
// avatar, a middle block holding the agent's name and the operator line, a
// spacer, then the button. `.btn` is `white-space: nowrap` (base.css) and
// `overflow: hidden` (polish.css, for the press ripple), and a flex item
// whose overflow is not visible has an automatic minimum width of 0. So the
// row took its whole shortfall out of the button and cut the label on both
// sides ("ack to profil" at 320). A name with no break opportunity was the
// second cause: it could not wrap, so it pushed the page sideways or ran
// under the button.
//
// Only real layout shows either, so this drives real headless Chrome
// through tests/helpers/real-browser.ts and skips (never passes) when no
// Chrome is installed. The fixture world is built the way
// tests/web/mobile-layout.test.ts builds its own: memory repositories,
// createApp, a buyer session planted in sessionStorage before any page
// script runs.
//
// Every width is compared against document.documentElement.clientWidth or
// the strip's own box, never a hard-coded viewport number: CI's Linux
// Chrome draws a classic scrollbar at desktop widths and macOS an overlay
// one.
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
import { createJob } from '../../src/domain/job.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { Session } from '../../src/adapters/identity/session.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession } from '../helpers/session-fixtures.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const PLATFORM_SEED = 'e'.repeat(64);
const OPERATOR_DID = 'did:abt:zWhoStripOperator';
const BUYER_DID = 'did:example:who-strip-buyer';
const BUYER_LOGIN = 'who-strip-buyer';

// The five names the row was measured with: two short ones, a long one with
// spaces, a long one with hyphens, and a long one with no break
// opportunity at all. An agent's name is any non-empty string, so the last
// one is a name the site has to carry.
const NAMES = [
  'Ada',
  'Rehearsal Agent H1',
  'Northwind Accessibility and Localisation Agent',
  'northwind-accessibility-localisation-agent',
  'NorthwindAccessibilityLocalisationAgent',
] as const;

const agentDid = (i: number): string => `did:abt:zWhoStripAgent${i}`;
const jobId = (i: number): string => `who-strip-job-${i}`;

interface StripPage {
  readonly label: string;
  readonly path: (i: number) => string;
  readonly buttonId: string;
  // What 6614211 drew the button at on a desktop pointer: base.css's
  // .btn-sm is 32px, and hire.html raises its own #back-to-profile to 44.
  readonly desktopHeight: number;
}

const STRIP_PAGES: ReadonlyArray<StripPage> = [
  { label: 'agreement', path: (i) => `/agreement?job=${jobId(i)}`, buttonId: 'agent-profile-link', desktopHeight: 32 },
  { label: 'hire', path: (i) => `/hire?agent=${encodeURIComponent(agentDid(i))}`, buttonId: 'back-to-profile', desktopHeight: 44 },
  { label: 'job', path: (i) => `/jobs/${jobId(i)}`, buttonId: 'who-back', desktopHeight: 32 },
];

interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly mobile: boolean;
  readonly touch: boolean;
  // Whether `(max-width: 420px)` is meant to hold at this width. Asserted
  // against the page's own matchMedia, so the branch (b) takes cannot
  // silently be the wrong one.
  readonly stacked: boolean;
}

const PHONES: ReadonlyArray<Viewport> = [
  { width: 320, height: 780, mobile: true, touch: true, stacked: true },
  { width: 390, height: 844, mobile: true, touch: true, stacked: true },
  { width: 430, height: 932, mobile: true, touch: true, stacked: false },
  { width: 520, height: 900, mobile: true, touch: true, stacked: false },
];

const DESKTOP: Viewport = { width: 1280, height: 900, mobile: false, touch: false, stacked: false };

const BROWSER_TIMEOUT_MS = 180_000;

let server: Server;
let baseUrl: string;
let buyerSession: Session;
let originalSeed: string | undefined;

function delegation(did: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:who-strip-${did}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: OPERATOR_DID,
    issuanceDate: '2026-09-01T00:00:00.000Z',
    credentialSubject: { id: did },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-09-01T00:00:00.000Z',
      verificationMethod: `${OPERATOR_DID}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zWhoStripFixtureNotVerifiedHere',
    },
  };
}

beforeAll(async () => {
  originalSeed = process.env.FREEAGENTS_PLATFORM_SEED;
  process.env.FREEAGENTS_PLATFORM_SEED = PLATFORM_SEED;

  const agentRepo = new MemoryAgentRepository();
  const accountRepo = new MemoryAccountRepository();
  const jobRepo = new MemoryJobRepository();
  const credentialRepo = new MemoryCredentialRepository();

  await accountRepo.register({ did: OPERATOR_DID, githubLogin: 'northwind-labs' });
  await accountRepo.register({ did: BUYER_DID, githubLogin: BUYER_LOGIN });

  const criteria = [
    { text: 'The cart survives a refresh', proposedBy: 'agent' as const, acceptedByBuyer: false, acceptedByAgent: true },
  ];

  for (let i = 0; i < NAMES.length; i += 1) {
    const did = agentDid(i);
    await agentRepo.create({
      did,
      operatorDid: OPERATOR_DID,
      delegation: delegation(did),
      name: NAMES[i] ?? '',
      skills: ['typescript'],
      githubLogin: null,
    });
    const base = createJob(
      {
        id: jobId(i),
        buyerDid: BUYER_DID,
        agentDid: did,
        repository: 'buyer/who-strip-repo',
        brief: 'Rebuild the checkout flow so it stops dropping the cart on a refresh.',
      },
      new Date('2026-09-01T00:00:00Z'),
    );
    await jobRepo.create({
      ...base,
      status: 'proposed',
      criteria,
      priceUsd: '400.00',
      rail: 'abt',
      deliveryWindowDays: 14,
    });
  }

  const sessionAdapter = createSessionAdapter({
    github: fakeGitHubConfig(),
    fetchImpl: fakeGitHubFetch({ login: BUYER_LOGIN, id: 5959 }),
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
    // Sixty-odd real page loads against one app, each making two or three
    // reads: a generous override for this file, never a raised default.
    { verify: 10_000, read: 10_000, write: 10_000, upstream: 10_000 },
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

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

interface StripMeasurement {
  readonly ready: boolean;
  readonly name: string;
  readonly label: string;
  readonly narrow: boolean;
  readonly coarse: boolean;
  readonly docScrollWidth: number;
  readonly docClientWidth: number;
  readonly strip: Box;
  readonly mid: Box;
  readonly button: Box;
  readonly buttonScrollWidth: number;
  readonly buttonClientWidth: number;
  readonly labelBox: Box;
  // Every element inside the strip whose box ends past the strip's right
  // edge, named, so a failure says what to fix.
  readonly pastEdge: ReadonlyArray<{ readonly name: string; readonly right: number }>;
  // .n and .r: text that spills out of its own block.
  readonly spills: ReadonlyArray<{ readonly name: string; readonly scrollWidth: number; readonly clientWidth: number }>;
}

async function signIn(browser: RealBrowser): Promise<void> {
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(buyerSession))});`,
  });
}

async function setViewport(browser: RealBrowser, viewport: Viewport): Promise<void> {
  await browser.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 2,
    mobile: viewport.mobile,
  });
  await browser.send('Emulation.setTouchEmulationEnabled', { enabled: viewport.touch });
}

// Loads one page and waits until the strip is what a person sees: the
// agent's real name in it, the operator line showing, the avatar mounted.
// Measuring the "Loading" placeholder would pass or fail on a string the
// row never shows for long.
async function measureStrip(browser: RealBrowser, page: StripPage, index: number): Promise<StripMeasurement> {
  await browser.goto(`${baseUrl}${page.path(index)}`, 200);
  const expectedName = NAMES[index] ?? '';
  const script = `
    (function () {
      function box(el) {
        var r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      }
      function shown(el) {
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none';
      }
      function name(el) {
        return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
          (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
      }
      var strip = document.getElementById('who');
      var btn = document.getElementById(${JSON.stringify(page.buttonId)});
      if (!strip || !btn) return { ready: false };
      var mid = strip.querySelector(':scope > div');
      var n = strip.querySelector('.n');
      var r = strip.querySelector('.r');
      var av = strip.querySelector('.av');
      var ready = shown(strip) && !!mid && !!n && n.textContent === ${JSON.stringify(expectedName)} &&
        !!r && shown(r) && /operated by/.test(r.textContent || '') &&
        !!av && av.childElementCount > 0;
      if (!ready) return { ready: false, name: n ? n.textContent : '' };
      var range = document.createRange();
      range.selectNodeContents(btn);
      var sb = box(strip);
      var pastEdge = Array.prototype.slice.call(strip.querySelectorAll('*'))
        .filter(function (el) { return shown(el) && el.getBoundingClientRect().right > sb.right + 0.5; })
        .map(function (el) { return { name: name(el), right: el.getBoundingClientRect().right }; });
      var spills = [n, r].filter(shown)
        .filter(function (el) { return el.scrollWidth > el.clientWidth; })
        .map(function (el) { return { name: name(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }; });
      return {
        ready: true,
        name: n.textContent,
        label: (btn.textContent || '').trim(),
        narrow: window.matchMedia('(max-width: 420px)').matches,
        coarse: window.matchMedia('(pointer: coarse)').matches,
        docScrollWidth: document.documentElement.scrollWidth,
        docClientWidth: document.documentElement.clientWidth,
        strip: sb,
        mid: box(mid),
        button: box(btn),
        buttonScrollWidth: btn.scrollWidth,
        buttonClientWidth: btn.clientWidth,
        labelBox: box(range),
        pastEdge: pastEdge,
        spills: spills
      };
    })()
  `;
  const deadline = Date.now() + 8000;
  let last: StripMeasurement = await browser.evaluate<StripMeasurement>(script);
  while (!last.ready && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    last = await browser.evaluate<StripMeasurement>(script);
  }
  return last;
}

const EPS = 0.5;

// Set WHO_STRIP_REPORT=1 to print one line per page, name and width: the
// button's width and height, whether the label is whole, whether the button
// sits on its own line, and the page width against the screen. This is how
// the table in the pull request was measured, so anyone can re-run it.
function report(where: string, m: StripMeasurement): void {
  if (!process.env.WHO_STRIP_REPORT) return;
  const whole = m.buttonScrollWidth <= m.buttonClientWidth &&
    m.labelBox.left >= m.button.left - EPS && m.labelBox.right <= m.button.right + EPS;
  const ownLine = m.button.top >= m.mid.bottom - EPS;
  console.log(
    `WHO ${where} | ${whole ? 'whole' : 'cut'} | button ${m.button.width.toFixed(0)}x${m.button.height.toFixed(0)} | ` +
      `${ownLine ? 'own line' : 'shares row'} | page ${m.docScrollWidth} in ${m.docClientWidth} | ` +
      `past edge ${m.pastEdge.length} | spills ${m.spills.length}`,
  );
}

// Pin (a): the whole label, the 44px floor, nothing past the strip's edge,
// no text out of its block, the name never under the button, and nothing
// sideways. Returns every broken clause as a sentence, so one run names
// every page, name and width that fails rather than stopping at the first.
function checkWhole(where: string, m: StripMeasurement): string[] {
  const bad: string[] = [];
  if (m.label !== 'Back to profile') bad.push(`${where}: the button reads "${m.label}"`);
  if (m.buttonScrollWidth > m.buttonClientWidth) {
    bad.push(`${where}: label cut, button scrollWidth ${m.buttonScrollWidth} > clientWidth ${m.buttonClientWidth}`);
  }
  if (m.labelBox.left < m.button.left - EPS || m.labelBox.right > m.button.right + EPS) {
    bad.push(
      `${where}: label text ${m.labelBox.left.toFixed(1)}..${m.labelBox.right.toFixed(1)} runs past the button ${m.button.left.toFixed(1)}..${m.button.right.toFixed(1)} (button ${m.button.width.toFixed(1)} wide)`,
    );
  }
  if (m.button.height < 44 || m.button.width < 44) {
    bad.push(`${where}: button ${m.button.width.toFixed(1)}x${m.button.height.toFixed(1)} is under the 44px floor`);
  }
  if (m.pastEdge.length > 0) bad.push(`${where}: past the strip's right edge ${m.strip.right.toFixed(1)}: ${JSON.stringify(m.pastEdge)}`);
  if (m.spills.length > 0) bad.push(`${where}: text spills out of its block: ${JSON.stringify(m.spills)}`);
  const sharesRow = m.button.top < m.mid.bottom - EPS;
  if (sharesRow && m.mid.right > m.button.left + EPS) {
    bad.push(`${where}: the middle block ends at ${m.mid.right.toFixed(1)}, under the button from ${m.button.left.toFixed(1)}`);
  }
  if (m.docScrollWidth !== m.docClientWidth) {
    bad.push(`${where}: the page is ${m.docScrollWidth} wide in ${m.docClientWidth}`);
  }
  return bad;
}

// Pin (b): at 420 and below the button sits on its own line under the
// name; above that it shares the row and meets the strip's right edge.
function checkPlacement(where: string, m: StripMeasurement, viewport: Viewport): string[] {
  const bad: string[] = [];
  if (m.narrow !== viewport.stacked) bad.push(`${where}: (max-width: 420px) is ${m.narrow}, expected ${viewport.stacked}`);
  if (viewport.stacked) {
    if (m.button.top < m.mid.bottom - EPS) {
      bad.push(`${where}: button top ${m.button.top.toFixed(1)} is above the middle block's bottom ${m.mid.bottom.toFixed(1)}`);
    }
    // Under the name, where hire has always put it: at the strip's left
    // edge, not pushed across the second line.
    if (Math.abs(m.button.left - m.strip.left) > 1) {
      bad.push(`${where}: button left ${m.button.left.toFixed(1)} is not at the strip's left edge ${m.strip.left.toFixed(1)}`);
    }
  } else {
    if (m.button.top >= m.mid.bottom) {
      bad.push(`${where}: button top ${m.button.top.toFixed(1)} is not above the middle block's bottom ${m.mid.bottom.toFixed(1)}`);
    }
    if (Math.abs(m.button.right - m.strip.right) > 1) {
      bad.push(`${where}: button right ${m.button.right.toFixed(1)} is not at the strip's right edge ${m.strip.right.toFixed(1)}`);
    }
  }
  return bad;
}

describe('"Back to profile" keeps its whole label in the identity strip (FIX-B59)', () => {
  it.each(PHONES)(
    'at $width px with a coarse pointer, on agreement, hire and job, for all five names',
    async (viewport) => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for the identity strip measurement; skipping (see CHROME_BIN)');
        return;
      }
      const browser = await RealBrowser.launch({ width: viewport.width, height: viewport.height });
      const bad: string[] = [];
      let measured = 0;
      try {
        await signIn(browser);
        await setViewport(browser, viewport);
        for (const page of STRIP_PAGES) {
          for (let i = 0; i < NAMES.length; i += 1) {
            const where = `${viewport.width} ${page.label} "${NAMES[i]}"`;
            const m = await measureStrip(browser, page, i);
            if (!m.ready) {
              bad.push(`${where}: the strip never rendered the agent (name read "${m.name ?? ''}")`);
              continue;
            }
            measured += 1;
            report(where, m);
            if (!m.coarse) bad.push(`${where}: the pointer is not coarse, so the phone floor is not under test`);
            bad.push(...checkWhole(where, m), ...checkPlacement(where, m, viewport));
          }
        }
      } finally {
        await browser.close();
      }
      expect(bad, bad.join('\n')).toEqual([]);
      expect(measured).toBe(STRIP_PAGES.length * NAMES.length);
    },
    BROWSER_TIMEOUT_MS,
  );

  it('at 1280 with a fine pointer nothing moves: whole, on the name\'s row, at the right edge, as tall as before', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for the identity strip measurement; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: DESKTOP.width, height: DESKTOP.height });
    const bad: string[] = [];
    let measured = 0;
    try {
      await signIn(browser);
      await setViewport(browser, DESKTOP);
      for (const page of STRIP_PAGES) {
        for (let i = 0; i < NAMES.length; i += 1) {
          const where = `1280 ${page.label} "${NAMES[i]}"`;
          const m = await measureStrip(browser, page, i);
          if (!m.ready) {
            bad.push(`${where}: the strip never rendered the agent (name read "${m.name ?? ''}")`);
            continue;
          }
          measured += 1;
          report(where, m);
          if (m.coarse) bad.push(`${where}: the pointer is coarse, so this is not the desktop control`);
          if (m.buttonScrollWidth > m.buttonClientWidth) bad.push(`${where}: label cut`);
          if (m.labelBox.left < m.button.left - EPS || m.labelBox.right > m.button.right + EPS) {
            bad.push(`${where}: label text runs past the button`);
          }
          if (Math.abs(m.button.height - page.desktopHeight) > EPS) {
            bad.push(`${where}: button is ${m.button.height.toFixed(1)} tall, not ${page.desktopHeight}`);
          }
          bad.push(...checkPlacement(where, m, DESKTOP));
          if (m.docScrollWidth !== m.docClientWidth) bad.push(`${where}: the page is ${m.docScrollWidth} wide in ${m.docClientWidth}`);
        }
      }
    } finally {
      await browser.close();
    }
    expect(bad, bad.join('\n')).toEqual([]);
    expect(measured).toBe(STRIP_PAGES.length * NAMES.length);
  }, BROWSER_TIMEOUT_MS);
});
