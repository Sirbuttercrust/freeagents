// SW2-03: ui.js's scroll reveal fired only once 5% of an element was on
// screen. A roster of 101 agents is one .stagger container about 27,500 px
// tall on a 390 x 844 phone, so 5% of it is taller than the screen: the
// observer could never fire, and the roster sat at opacity 0 until the
// 3 second fallback. These run the real pages in real Chrome, because
// jsdom has no layout and no IntersectionObserver to measure.
//
// ui.js arms that 3 second fallback at DOMContentLoaded, and it would show
// the roster even with the fix reverted. So every test installs an
// instrument before the first navigation that drops any 3000 ms timer the
// page sets and counts it. With the fallback unable to fire, an is-in class
// can only be the observer's, and no test needs a bound on how long the page
// took to load (the roster's own load counts toward any such bound). The
// count is asserted too (1 where ui.js arms the fallback, 0 under reduced
// motion), so the instrument fails loudly if ui.js changes its timer.
//
//   (a) /myagents, 101 agents, 390 x 844: the roster is in at once, with the
//       fallback dropped.
//   (b) /how, 390 x 844: a short .stagger below the fold keeps its
//       entrance (one inside "Show the full wording", opened first). A
//       sliver on screen is not enough; scrolled into view, it comes in.
//   (c) /myagents under reduced motion: no hidden state at all, and no
//       fallback armed.
//   (d) the roster of (a) with its read held, so the rows land more than
//       2.5 s after DOMContentLoaded: a slow load does not fail a working
//       reveal.
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
} from '../../src/adapters/storage/memory.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession } from '../helpers/session-fixtures.js';
import type { Session } from '../../src/adapters/identity/session.js';
import type { Delegation } from '../../src/domain/agent.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const ROSTER = 101;
const WIDTH = 390;
const HEIGHT = 844;
// ui.js's own fallback delay: anything still hidden this long after it runs
// is shown. The tests drop the timer that carries this delay.
const FALLBACK_MS = 3000;
// Installed before the first navigation: a timer set for FALLBACK_MS is
// counted and never scheduled; every other timer is the page's own.
const DROP_FALLBACK = `(function () {
  var real = window.setTimeout;
  window.__droppedFallbacks = 0;
  window.setTimeout = function (fn, ms) {
    if (ms === ${FALLBACK_MS}) { window.__droppedFallbacks += 1; return 0; }
    return real.apply(this, arguments);
  };
})()`;
// (d) holds the roster read (GET /accounts/:did/agents) this long on the wire.
const HELD_READ_MS = 2700;
// (d) requires the rows to land at least this long after DOMContentLoaded.
const SLOW_LOAD_MS = 2500;

function delegationFixture(agentDid: string, operatorDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:delegation-for-${agentDid}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
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

let server: Server;
let baseUrl: string;
let session: Session;
let originalSeed: string | undefined;

beforeAll(async () => {
  // Account provisioning off a session derives the DID from this seed.
  originalSeed = process.env.FREEAGENTS_PLATFORM_SEED;
  process.env.FREEAGENTS_PLATFORM_SEED = 'f'.repeat(64);
  const agentRepo = new MemoryAgentRepository();
  const sessionAdapter = createSessionAdapter({
    github: fakeGitHubConfig(),
    fetchImpl: fakeGitHubFetch({ login: 'reveal-tall-operator', id: 9931 }),
  });
  const app = createApp(
    new MemoryAccountRepository(), agentRepo, undefined, undefined, new MemoryJobRepository(), undefined,
    undefined, new MemoryCredentialRepository(), undefined, undefined, undefined, sessionAdapter,
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a port');
  baseUrl = `http://127.0.0.1:${address.port}`;

  session = await mintSession(sessionAdapter);
  const me = (await (await fetch(`${baseUrl}/accounts/me`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}` },
  })).json()) as { did?: string };
  if (typeof me.did !== 'string') throw new Error(`GET /accounts/me gave no DID: ${JSON.stringify(me)}`);
  for (let i = 0; i < ROSTER; i++) {
    const did = `did:abt:reveal-tall-${String(i).padStart(3, '0')}`;
    await agentRepo.create({
      did, operatorDid: me.did, delegation: delegationFixture(did, me.did),
      name: `agent-${i}`, skills: ['work'], githubLogin: null,
    });
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (originalSeed === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
  else process.env.FREEAGENTS_PLATFORM_SEED = originalSeed;
});

interface BrowserOptions {
  readonly motion?: 'reduce';
  // Holds the roster read this many ms on the wire (CDP Fetch domain).
  readonly holdRosterMs?: number;
}

async function withBrowser<T>(fn: (b: RealBrowser) => Promise<T>, opts: BrowserOptions = {}): Promise<T> {
  const browser = await RealBrowser.launch({ width: WIDTH, height: HEIGHT });
  const pending = new Set<ReturnType<typeof setTimeout>>();
  try {
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: DROP_FALLBACK });
    if (opts.motion) {
      await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: opts.motion }] });
    }
    if (opts.holdRosterMs !== undefined) {
      const holdMs = opts.holdRosterMs;
      await browser.send('Fetch.enable', { patterns: [{ urlPattern: '*/accounts/*/agents', requestStage: 'Request' }] });
      browser.onEvent('Fetch.requestPaused', (params) => {
        const { requestId } = params as { requestId: string };
        const timer = setTimeout(() => {
          pending.delete(timer);
          void browser.send('Fetch.continueRequest', { requestId }).catch(() => undefined);
        }, holdMs);
        pending.add(timer);
      });
    }
    return await fn(browser);
  } finally {
    // The hold belongs to this one browser: release it, then close.
    for (const timer of pending) clearTimeout(timer);
    if (opts.holdRosterMs !== undefined) await browser.send('Fetch.disable').catch(() => undefined);
    await browser.close();
  }
}

// How many 3000 ms timers the current document tried to set.
function droppedFallbacks(b: RealBrowser): Promise<number | undefined> {
  return b.evaluate<number | undefined>('window.__droppedFallbacks');
}

// Signs in, opens /myagents, and polls until every row is in the DOM.
// Returns the page's own clock at that moment and at DOMContentLoaded,
// when ui.js started its fallback timer.
async function openRoster(b: RealBrowser): Promise<{ rowsAt: number; dcl: number }> {
  await b.goto(`${baseUrl}/myagents`, 0);
  await b.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(session))})`);
  await b.goto(`${baseUrl}/myagents`, 0);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const rows = await b.evaluate<number>(`document.querySelectorAll('#rows > .arow').length`);
    if (rows === ROSTER) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  return b.evaluate<{ rowsAt: number; dcl: number }>(`({
    rowsAt: document.querySelectorAll('#rows > .arow').length === ${ROSTER} ? performance.now() : -1,
    dcl: performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd
  })`);
}

interface RosterRead {
  readonly dcl: number;
  readonly rowsAt: number;
  readonly dropped: number | undefined;
  readonly at400: { now: number; isIn: boolean; height: number; opacity: number; fading: boolean };
  readonly settled: { now: number; opacity: string; jsReveal: boolean };
}

// Opens the roster with the fallback dropped, reads it 400 ms after the rows
// land, then once more after the first row's own animations finish.
function readRoster(opts: BrowserOptions = {}): Promise<RosterRead> {
  return withBrowser(async (b) => {
    const { rowsAt, dcl } = await openRoster(b);
    expect(rowsAt, `the roster never rendered ${ROSTER} rows`).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 400));
    const at400 = await b.evaluate<RosterRead['at400']>(`(function () {
      var rows = document.getElementById('rows');
      var first = rows.querySelector('.arow');
      return {
        now: performance.now(),
        isIn: rows.classList.contains('is-in'),
        height: rows.getBoundingClientRect().height,
        opacity: parseFloat(getComputedStyle(first).opacity),
        fading: first.getAnimations().some(function (a) { return a.playState === 'running'; })
      };
    })()`);
    // The entrance runs 450 ms (base.css); wait out whatever is left of
    // the first row's own transition, then read it once more.
    const settled = await b.evaluate<RosterRead['settled']>(`(async function () {
      var first = document.querySelector('#rows > .arow');
      await Promise.all(first.getAnimations().map(function (a) { return a.finished; }));
      return {
        now: performance.now(),
        opacity: getComputedStyle(first).opacity,
        jsReveal: document.documentElement.classList.contains('js-reveal')
      };
    })()`);
    return { dcl, rowsAt, dropped: await droppedFallbacks(b), at400, settled };
  }, opts);
}

// What SW2-03 needs: the observer, not the fallback, revealed the roster.
function expectRosterRevealedByObserver(got: RosterRead): void {
  // The case is the finding's own: a container more than 20 screens tall.
  expect(got.at400.height, 'the roster is not taller than 20 screens: the fixture no longer reproduces SW2-03').toBeGreaterThan(HEIGHT * 20);
  expect(got.settled.jsReveal, 'the reveal layer never armed, so this proves nothing').toBe(true);
  // The fallback timer was set and dropped, so nothing else could add is-in.
  expect(got.dropped, 'ui.js did not arm exactly one 3000 ms timer: the instrument no longer sees the fallback').toBe(1);
  expect(got.at400.isIn, 'the roster has no is-in 400 ms after its rows landed').toBe(true);
  expect(
    got.at400.opacity > 0 || got.at400.fading,
    `the first row is neither fading in nor shown 400 ms after the rows landed (opacity ${got.at400.opacity}, no running transition)`,
  ).toBe(true);
  expect(got.settled.opacity, 'the first row did not settle at full opacity').toBe('1');
}

describe('SW2-03: a reveal block taller than the screen shows at once', { timeout: 60000 }, () => {
  // This used to read the first row's opacity at a fixed 400 ms
  // against > 0.9. The entrance runs 450 ms, so a slow runner caught it
  // mid-fade (0.83) with is-in already set. What SW2-03 needs is that the
  // observer revealed the roster, not a wall-clock frame of its fade: so at
  // 400 ms the roster must be is-in and its first row visibly on its way
  // (opacity above 0, or its transition running), and once that row's own
  // animations finish it must sit at opacity 1. The old test also bounded
  // its last read to under 3 s after DOMContentLoaded to rule out the
  // fallback, but that clock counts the roster's own load, so a slow load
  // failed a working reveal. Now the fallback timer is dropped, and there is
  // no clock to read.
  it('(a) /myagents with 101 agents at 390 x 844, ui.js\'s fallback timer dropped: 400 ms after the rows land the roster is in and its first row is fading in or shown, and it settles at opacity 1', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found; skipping (see CHROME_BIN)');
      return;
    }
    expectRosterRevealedByObserver(await readRoster());
  });

  it(`(d) the roster read held so the rows land over ${SLOW_LOAD_MS} ms after DOMContentLoaded: still in 400 ms after the rows land, fallback dropped`, async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found; skipping (see CHROME_BIN)');
      return;
    }
    const got = await readRoster({ holdRosterMs: HELD_READ_MS });
    // The load was slow enough that the old bound would have failed it.
    expect(got.rowsAt - got.dcl, `the rows landed under ${SLOW_LOAD_MS} ms after DOMContentLoaded: the hold did not slow the load`).toBeGreaterThanOrEqual(SLOW_LOAD_MS);
    expectRosterRevealedByObserver(got);
  });

  it('(b) /how at 390 x 844: a short .stagger below the fold stays hidden with a sliver on screen, and comes in once scrolled to', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found; skipping (see CHROME_BIN)');
      return;
    }
    const got = await withBrowser(async (b) => {
      await b.goto(`${baseUrl}/how`, 0);
      // DIAG1b: /how leads with diagrams, and its short .stagger blocks (the
      // old five steps, evidence table and refusal cards) sit behind "Show
      // the full wording" at the foot of the page. Opening it from script,
      // without scrolling, puts them on the page below the fold.
      await b.evaluate(`document.querySelector('[data-disclose="full-wording"]').click()`);
      const pick = await b.evaluate<{ index: number; top: number; height: number; isIn: boolean; opacity: string } | null>(`(function () {
        var list = Array.prototype.slice.call(document.querySelectorAll('.stagger'));
        for (var i = 0; i < list.length; i++) {
          var r = list[i].getBoundingClientRect();
          if (r.top > innerHeight && r.height > 100 && r.height < innerHeight / 2) {
            return {
              index: i, top: r.top + scrollY, height: r.height, isIn: list[i].classList.contains('is-in'),
              opacity: getComputedStyle(list[i].firstElementChild).opacity
            };
          }
        }
        return null;
      })()`);
      if (pick === null) return { pick };
      // The observer's root ends 8% above the screen's bottom edge. Put
      // the block's top 6 px inside that root: some of it is on screen,
      // under the 5% a short block still needs.
      const rootBottom = HEIGHT * 0.92;
      await b.evaluate(`window.scrollTo(0, ${Math.round(pick.top - rootBottom + 6)})`);
      await new Promise((r) => setTimeout(r, 400));
      const sliver = await b.evaluate<{ now: number; isIn: boolean; onScreen: number }>(`(function () {
        var n = document.querySelectorAll('.stagger')[${pick.index}];
        var r = n.getBoundingClientRect();
        return { now: performance.now(), isIn: n.classList.contains('is-in'), onScreen: ${rootBottom} - r.top };
      })()`);
      await b.evaluate(`document.querySelectorAll('.stagger')[${pick.index}].scrollIntoView({ block: 'center' })`);
      // Polled, with a deadline that only fails the run: how long the
      // observer takes is not what is under test.
      const deadline = Date.now() + 10000;
      let scrolledIsIn = false;
      while (!scrolledIsIn && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
        scrolledIsIn = await b.evaluate<boolean>(`document.querySelectorAll('.stagger')[${pick.index}].classList.contains('is-in')`);
      }
      return { pick, sliver, scrolledIsIn, dropped: await droppedFallbacks(b) };
    });
    expect(got.pick, 'no short .stagger below the fold on /how: the fixture no longer exercises the entrance').not.toBeNull();
    const { pick, sliver, scrolledIsIn, dropped } = got as Required<typeof got> & { pick: NonNullable<typeof got.pick> };
    expect({ isIn: pick.isIn, opacity: pick.opacity }, 'the block was already in before any scroll').toEqual({ isIn: false, opacity: '0' });
    expect(sliver!.onScreen, 'the sliver scroll missed the observer root').toBeGreaterThan(0);
    expect(sliver!.onScreen).toBeLessThan(pick.height * 0.05);
    expect(sliver!.isIn, 'a short block came in on a sliver: its entrance is gone').toBe(false);
    // The fallback timer was set and dropped, so only the observer could add is-in.
    expect(dropped, 'ui.js did not arm exactly one 3000 ms timer: the instrument no longer sees the fallback').toBe(1);
    expect(scrolledIsIn, 'the short block never came in once scrolled to').toBe(true);
  });

  it('(c) /myagents under reduced motion: no js-reveal, no fallback timer armed, and every row at opacity 1 as soon as it lands', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found; skipping (see CHROME_BIN)');
      return;
    }
    const got = await withBrowser(async (b) => {
      const { rowsAt } = await openRoster(b);
      const read = await b.evaluate<{ jsReveal: boolean; opacities: string[] }>(`({
        jsReveal: document.documentElement.classList.contains('js-reveal'),
        opacities: Array.prototype.map.call(document.querySelectorAll('#rows > .arow'), function (r) { return getComputedStyle(r).opacity; })
      })`);
      return { rowsAt, read, dropped: await droppedFallbacks(b) };
    }, { motion: 'reduce' });
    expect(got.rowsAt, `the roster never rendered ${ROSTER} rows`).toBeGreaterThan(0);
    expect(got.read.jsReveal).toBe(false);
    // ui.js returns before it arms anything under reduced motion.
    expect(got.dropped, 'a 3000 ms timer was armed under reduced motion').toBe(0);
    expect(got.read.opacities).toHaveLength(ROSTER);
    expect(got.read.opacities.filter((o) => o !== '1')).toEqual([]);
  });
});
