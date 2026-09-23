// W-operatorjob: the operator's view of one hire, rebuilt on
// spec/wireframe/operatorjob.html's polished visual system.
//
// The conformance gate (tests/web/wireframe-conformance.test.ts) measures one
// thing about this page's clothes: that every stylesheet the wireframe loads
// is linked, and that an avatar mount exists somewhere. Two link tags and one
// string satisfy it, and the string test is a regex over raw file text, so a
// comment mentioning the attribute passes it with no mount behind it. So that
// gate is equally satisfied by a page that links flow.css and keeps a
// page-local copy of every rule in it, mounts an avatar attribute the engine
// never paints, ships a timeline whose three drawn states are one state drawn
// three times, or orders its history by the order the renderer happened to
// push rows. This file is the distance between passing that gate and wearing
// the design.
//
// tests/web/operatorjob.test.ts owns the live wiring: the party gate, the
// stage and redo routes driven for real, the state sentences, and the 320px
// floor on the redo panel and the accept sheet. Nothing here restates it.
//
// Two kinds of assertion live here, and the split is deliberate. jsdom
// performs no layout and resolves linked sheets after the page's own <style>
// block, so it can see markup and script order but can never see that a rule
// is in force. Every claim about what the sheets DO to this page is measured
// in a real browser instead.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import {
  MemoryAgentRepository,
  MemoryAccountRepository,
  MemoryJobRepository,
  MemoryAttestationRepository,
} from '../../src/adapters/storage/memory.js';
import { createJob, isTerminal, REDO_LAPSE_EXTENSION_DAYS, type Job, type JobStatus } from '../../src/domain/job.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession } from '../helpers/session-fixtures.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import { createStagingLifecycleGithubFake, PLATFORM_LOGIN } from '../helpers/github-staging-fixtures.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { Session } from '../../src/adapters/identity/session.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';
import { botMount, expectedMount } from '../helpers/bot-mount.js';
import { defaultAvatar } from '../../src/domain/avatar-spec.js';

// Real-browser layout tests launch Chrome, navigate at least once and
// evaluate in the page; vitest's 5000ms default times out under full-suite
// load exactly the way CI1 found in dashboard.test.ts and
// hire-polished.test.ts (run 35390871202, layout tests red on
// "Test timed out in 5000ms" with no layout defect). 30s is past every
// launch observed here and a genuinely broken layout still fails inside it.
const BROWSER_TIMEOUT_MS = 30_000;

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const AGENT_DID = 'did:abt:operatorjob-polish-agent';
const OPERATOR_LOGIN = 'operatorjob-polish-operator';

const here = dirname(fileURLToPath(import.meta.url));
const pagePath = join(here, '../../src/web/pages/operatorjob.html');
const scriptPath = join(here, '../../src/web/public/js/pages/operatorjob.js');

// Every timestamp is computed from the wall clock, never a fixed date: GET
// /jobs/:jobId runs the live lapse clocks on every read, so a hardcoded
// fixture would expire out from under this suite (the RECENT pattern
// tests/web/operatorjob.test.ts already uses, and its reasoning).
//
// ONE BASE INSTANT for the whole suite, and this is a repair rather than a
// flourish. The first version called Date.now() afresh at each use, so a
// fixture's createdAt and its confirmedAt, both written as "six hours ago",
// were computed from two different milliseconds: whichever statement ran
// second was newer. Section 4 sorts the timeline by its own timestamps, so
// that inversion reordered two rows and failed the suite roughly one run in
// three. Reading every offset off one captured instant makes the fixture's
// event order the order the fixture says it is.
const BASE = Date.now();
const HOURS_AGO = (n: number): Date => new Date(BASE - n * 60 * 60 * 1000);

let server: Server;
let baseUrl: string;
let operatorSession: Session;

function delegationFixture(did: string, operatorDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:delegation-for-${did}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: did },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-01-01T00:00:00Z',
      verificationMethod: `${did}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zfixture-not-verified-here',
    },
  };
}

function jobFixture(overrides: Partial<Job> & { id: string }): Job {
  const base = createJob(
    {
      id: overrides.id,
      buyerDid: 'did:abt:operatorjob-polish-buyer',
      agentDid: AGENT_DID,
      repository: 'buyer/operatorjob-polish-repo',
      brief: 'Consolidate the design tokens into one source of truth',
    },
    HOURS_AGO(6),
  );
  return { ...base, ...overrides };
}

beforeAll(async () => {
  const operatorAdapter = createSessionAdapter({
    github: fakeGitHubConfig(),
    fetchImpl: fakeGitHubFetch({ login: OPERATOR_LOGIN, id: 88401 }),
  });
  const operatorDid = 'did:abt:operatorjob-polish-operator-account';

  const accountRepo = new MemoryAccountRepository();
  await accountRepo.register({ did: operatorDid, githubLogin: OPERATOR_LOGIN });
  await accountRepo.register({ did: 'did:abt:operatorjob-polish-buyer', githubLogin: 'operatorjob-polish-buyer-login' });

  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: AGENT_DID,
    operatorDid,
    delegation: delegationFixture(AGENT_DID, operatorDid),
    name: 'operatorjob-polish-scout',
    skills: ['triage'],
    githubLogin: 'operatorjob-polish-scout-login',
  });

  const jobRepo = new MemoryJobRepository();
  const { github } = createStagingLifecycleGithubFake();
  for (const id of ['polish-redo', 'polish-restaged', 'polish-completed']) {
    await github.createStagingRepository({
      jobId: id, baseCommit: `base-${id}`, sourceOwner: 'buyer', sourceRepo: 'operatorjob-polish-repo',
    });
  }

  const app = createApp(
    accountRepo, agentRepo, undefined, github, jobRepo, undefined, undefined, undefined,
    undefined, undefined, undefined, operatorAdapter, undefined, alwaysSettledGate(),
    anyCommitStagingObserver(), new MemoryAttestationRepository(),
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  operatorSession = await mintSession(operatorAdapter);

  const agreed = {
    criteria: [
      { text: 'The README migration guide lists every changed import path', proposedBy: 'agent' as const, acceptedByBuyer: true, acceptedByAgent: true },
      { text: 'Checkout e2e test passes', proposedBy: 'buyer' as const, acceptedByBuyer: true, acceptedByAgent: true },
    ],
    priceUsd: '1200.00',
    rail: 'abt' as const,
    depositPercent: 25,
    redoAllowance: 1,
    priceAcceptedByBuyer: true,
    priceAcceptedByAgent: true,
    confirmedAt: HOURS_AGO(5),
  };

  // The state the wireframe draws: a redo waiting on an answer.
  await jobRepo.create({
    ...jobFixture({
      id: 'polish-redo', status: 'staged', ...agreed,
      confirmedSpecHash: 'sha256:polish-redo',
      stagingRepo: { owner: PLATFORM_LOGIN, repo: 'staging-polish-redo' },
      baseCommit: 'base-polish-redo',
      stagedAt: HOURS_AGO(3),
      stagedCommit: 'commit-polish-original',
    }),
    status: 'redo_requested',
    redoUsedCount: 1,
    redoRequestedCriterionIndex: 0,
    redoRequestedAt: HOURS_AGO(1),
    stagedLapseExtensionDays: REDO_LAPSE_EXTENSION_DAYS,
  });

  // THE ORDERING FIXTURE. An accepted redo means the agent stages AGAIN, so
  // stagedAt is newer than redo.requestedAt. The two facts arrive in the
  // renderer in the opposite order from the order they happened, which is
  // what section 4 below is about.
  await jobRepo.create({
    ...jobFixture({
      id: 'polish-restaged', status: 'staged', ...agreed,
      confirmedSpecHash: 'sha256:polish-restaged',
      stagingRepo: { owner: PLATFORM_LOGIN, repo: 'staging-polish-restaged' },
      baseCommit: 'base-polish-restaged',
      stagedAt: HOURS_AGO(0.2),
      stagedCommit: 'commit-polish-restaged',
    }),
    status: 'staged',
    redoUsedCount: 1,
    redoRequestedCriterionIndex: 0,
    redoRequestedAt: HOURS_AGO(2),
    stagedLapseExtensionDays: REDO_LAPSE_EXTENSION_DAYS,
  });

  // A finished hire: nothing is waiting, so no row may be marked current.
  await jobRepo.create({
    ...jobFixture({
      id: 'polish-completed', status: 'staged', ...agreed,
      confirmedSpecHash: 'sha256:polish-completed',
      stagingRepo: { owner: PLATFORM_LOGIN, repo: 'staging-polish-completed' },
      baseCommit: 'base-polish-completed',
      stagedAt: HOURS_AGO(4),
      stagedCommit: 'commit-polish-completed',
    }),
    status: 'completed',
    submittedAt: HOURS_AGO(3),
    pullRequestUrl: 'https://github.com/buyer/operatorjob-polish-repo/pull/9',
    mergedAt: HOURS_AGO(2),
    mergeCommit: 'merge-polish-completed',
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function servedMarkup(): Promise<string> {
  const res = await fetch(`${baseUrl}/operatorjob?job=polish-redo`, { headers: { Accept: HTML } });
  expect(res.status).toBe(200);
  return res.text();
}

interface Rendered {
  document: Document;
  window: JSDOM['window'];
  close: () => void;
}

// The page with its own scripts run for real against the real app. Nothing
// this file asserts on exists until GET /jobs/:jobId resolves, so the wait is
// not optional garnish.
async function render(job = 'polish-redo'): Promise<Rendered> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  const path = `/operatorjob?job=${encodeURIComponent(job)}`;
  const res = await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } });
  const markup = await res.text();

  const dom = new JSDOM(markup, {
    url: `${baseUrl}${path}`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.sessionStorage.setItem('fa_session', JSON.stringify(operatorSession));
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
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);

  return { document: dom.window.document, window: dom.window, close: () => dom.window.close() };
}

interface BrowserOpts { width?: number; job?: string; reduce?: boolean }

// A real browser on the signed-in page. Returns null (and the caller returns)
// when no Chrome is installed, because a missing browser is a different fact
// than a broken layout, the exit-3 convention tests/helpers/real-browser.ts
// already documents.
async function measure<T>(opts: BrowserOpts, fn: (browser: RealBrowser) => Promise<T>): Promise<T | null> {
  if (!hasRealBrowser()) {
    console.warn('no Chrome found for real-browser measurement; skipping (see CHROME_BIN)');
    return null;
  }
  const width = opts.width ?? 1280;
  const path = `/operatorjob?job=${encodeURIComponent(opts.job ?? 'polish-redo')}`;
  const browser = await RealBrowser.launch({ width, height: 900 });
  try {
    if (opts.reduce === true) {
      await browser.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
    }
    await browser.goto(`${baseUrl}${path}`);
    await browser.evaluate(
      `sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(operatorSession))})`,
    );
    await browser.goto(`${baseUrl}${path}`, 800);
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

function linkedSheets(markup: string): string[] {
  return [...markup.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map(
    (m) => ((m[1] ?? '').split('/').pop() ?? '').trim(),
  );
}

function loadedScripts(markup: string): string[] {
  return [...markup.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => (m[1] ?? '').trim());
}

// ------------------------------------------------------------- 1. the stack

describe('1. the page wears the polished system, and only the sheets it uses', () => {
  it('loads tokens, base, polish and flow, and none of the page-specific sheets', async () => {
    const sheets = linkedSheets(await servedMarkup());

    expect(sheets, 'the polished layer must be linked').toContain('polish.css');
    expect(sheets, 'the flow components must be linked').toContain('flow.css');
    expect(sheets).toContain('tokens.css');
    expect(sheets).toContain('base.css');

    // The absence half, which the conformance gate does not make: it checks
    // only that the wireframe's sheets are present, so an over-load passes it
    // in silence. None of these four has a component on this screen.
    const overLoaded = ['market.css', 'gallery.css', 'agreement.css', 'landing.css'].filter((s) =>
      sheets.includes(s),
    );
    expect(overLoaded, 'stylesheets loaded by a page that uses none of their components').toEqual([]);
  });

  it('loads the bot core and bots.js before polish, all before the page script, and no icon sprite', async () => {
    const scripts = loadedScripts(await servedMarkup());

    expect(scripts).toEqual([
      '/js/pages/api.js',
      '/js/pages/nav.js',
      '/js/vendor/bot-avatars/bot-avatars.js',
      '/js/bots.js',
      '/js/polish.js',
      '/js/pages/operatorjob.js',
      '/js/pages/ui.js',
    ]);

    // Stated as an ordering as well as a list, because the list is the thing
    // a later edit reshuffles. operatorjob.js's renderWho calls FABots at
    // render time, so bots.js must have defined it (and bots.js reads the
    // core once when it loads); ui.js's reveal sweep runs last so the page's
    // own classes are already on the tree.
    const core = scripts.indexOf('/js/vendor/bot-avatars/bot-avatars.js');
    const bots = scripts.indexOf('/js/bots.js');
    const polish = scripts.indexOf('/js/polish.js');
    const page = scripts.indexOf('/js/pages/operatorjob.js');
    const ui = scripts.indexOf('/js/pages/ui.js');
    expect(bots - core, 'bots.js runs after the core it reads').toBeGreaterThan(0);
    expect(page - bots, 'the page script runs after the avatar renderer it calls').toBeGreaterThan(0);
    expect(page - polish, 'the page script runs after the sweeps it repaints over').toBeGreaterThan(0);
    expect(ui - page, 'the reveal sweep runs after the page script declares its targets').toBeGreaterThan(0);

    // icons.js paints [data-ico] hosts. Neither this page nor its script
    // declares one, so loading the sprite would ship a module with nothing to
    // do. Parsed, not grepped: a grep cannot tell an attribute on an element
    // from the word in a comment, and this page's head comment names the
    // sprite to explain why it is absent.
    expect(scripts.some((s) => s.includes('icons.js'))).toBe(false);
    const shell = new JSDOM(readFileSync(pagePath, 'utf8'));
    try {
      expect(
        Array.from(shell.window.document.querySelectorAll('[data-ico]')).length,
        'a [data-ico] host ships with no sprite to paint it',
      ).toBe(0);
    } finally {
      shell.window.close();
    }
    const scriptText = readFileSync(scriptPath, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    expect(scriptText.includes('data-ico'), 'the script builds a glyph host with no sprite loaded').toBe(false);
  });

  it('carries no second copy of a rule flow.css already ships', async () => {
    // The drift this card exists to stop. The page-local block used to hold
    // 22 rules byte-identical to flow.css's own, which is two definitions of
    // one component waiting to disagree. Derived from the files rather than
    // from a list, so a rule copied back in fails here.
    const pageStyle = /<style>([\s\S]*?)<\/style>/.exec(readFileSync(pagePath, 'utf8'))?.[1] ?? '';
    expect(pageStyle.length, 'no page-local <style> block found: this check would be vacuous').toBeGreaterThan(200);

    const selectorsIn = (css: string): Set<string> => {
      const out = new Set<string>();
      const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of stripped.matchAll(/(^|[};])\s*([^{};@]+)\{/g)) {
        for (const sel of (m[2] ?? '').split(',')) {
          const trimmed = sel.trim().replace(/\s+/g, ' ');
          if (trimmed !== '') out.add(trimmed);
        }
      }
      return out;
    };

    const local = selectorsIn(pageStyle);
    expect(local.size, 'no selectors parsed out of the page block').toBeGreaterThan(5);

    const flow = selectorsIn(readFileSync(join(here, '../../src/web/public/css/flow.css'), 'utf8'));
    expect(flow.has('.who'), 'flow.css does not carry .who: the comparison corpus is wrong').toBe(true);

    // .who and the whole .fixed/.facts/.acts/.sheet vocabulary come from
    // flow.css now. The page keeps only what no shared sheet carries: the
    // wireframe's own .obrief and .track internals, #agreement-link, .warn.
    const duplicated = [...local].filter((sel) => flow.has(sel));
    expect(duplicated, 'the page redeclares a selector flow.css already owns').toEqual([]);
  });
});

// ------------------------------------------------------ 2. the .who creature

describe('2. the .who avatar is the agent\u2019s bot, at the size the sheets set', () => {
  it('the mount carries the job\u2019s own agentDid and the bot the agent read served', async () => {
    const page = await render();
    try {
      const mount = page.document.getElementById('agent-avatar');
      expect(mount, '#agent-avatar is missing').not.toBeNull();

      // POSITIVE CONTROL. Everything below is satisfied by an empty page, so
      // the read has to have produced the row first.
      expect(page.document.getElementById('agent-name')?.textContent).toBe('operatorjob-polish-scout');

      // No override stored, so the served spec is the DID default.
      expect(botMount(mount), 'the mount does not wear the spec the agent read served').toEqual(
        expectedMount(AGENT_DID, defaultAvatar(AGENT_DID)),
      );

      // The engine this page no longer uses. agent.avatar was the older
      // server-rendered blobatar stand-in, removed in AV2; a page on the
      // polished system draws the bot on a canvas (DESIGN.md 2.4, ENT-2.3),
      // so no <img> may come back.
      expect(
        page.document.querySelector('.who img'),
        'the server-rendered avatar engine is back in the .who row',
      ).toBeNull();
    } finally {
      page.close();
    }
  });

  it('the bot works while the job is in progress and rests once it is not', async () => {
    // What "working" has to mean to be worth anything: the same page and the
    // same agent, and the state follows the job's status alone. polish-redo
    // is redo_requested (inProgress in src/domain/job-list.ts); the other
    // two are staged and completed, neither of which the agent is working on.
    const cases: Array<[string, string]> = [
      ['polish-redo', 'working'],
      ['polish-restaged', 'default'],
      ['polish-completed', 'default'],
    ];
    for (const [job, state] of cases) {
      const page = await render(job);
      try {
        const mount = page.document.getElementById('agent-avatar');
        expect(mount?.getAttribute('data-avatar'), `${job}: nothing was mounted`).toBe(AGENT_DID);
        expect(mount?.getAttribute('data-avatar-state'), `${job}: wrong motion state`).toBe(state);
      } finally {
        page.close();
      }
    }
  });

  // MEASURED, not read. This is the half jsdom cannot see, and it is the
  // defect this card found: before the rebuild the .who avatar was an <img>
  // with no class, and the page-local rule meant to size it keyed off
  // `.who .avatar`, which matched nothing. The img took the whole column.
  it('the creature is a 32px square, not a column-width circle', async () => {
    const measured = await measure({ width: 1280 }, async (browser) =>
      browser.evaluate<{ av: [number, number]; who: number; matchesOldRule: number }>(`
        (function () {
          var av = document.getElementById('agent-avatar');
          var r = av.getBoundingClientRect();
          return {
            av: [Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100],
            who: Math.round(document.querySelector('.who').getBoundingClientRect().width),
            matchesOldRule: document.querySelectorAll('.who .avatar').length
          };
        })()
      `),
    );
    if (measured === null) return;

    expect(measured.who, 'the .who row has no width, so the ratio below means nothing').toBeGreaterThan(200);
    expect(measured.av, 'the creature is not the 32px square flow.css and polish.css set').toEqual([32, 32]);
    // The specific failure shape, pinned: the broken version was as wide as
    // its container. Anything near that is the same defect returning.
    expect(
      measured.av[0] < measured.who / 4,
      `the avatar is ${measured.av[0]}px inside a ${measured.who}px row, which is the full-column avatar defect`,
    ).toBe(true);
    expect(
      measured.matchesOldRule,
      'a .who .avatar element is back; that selector matched nothing and is why the old img was unsized',
    ).toBe(0);
  }, BROWSER_TIMEOUT_MS);

  // MUTATION CONTROL for the assertion above. polish.css is what clips the
  // creature and flow.css is what sizes it; disable both in place and the
  // same mount must change. A control that reports no change would mean the
  // size above comes from somewhere else and the sheets are decoration.
  it('control: with flow.css and polish.css disabled, the same mount changes size', async () => {
    const measured = await measure({ width: 1280 }, async (browser) => {
      const probe = `
        (function () {
          var r = document.getElementById('agent-avatar').getBoundingClientRect();
          return [Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100];
        })()
      `;
      const on = await browser.evaluate<[number, number]>(probe);
      const disabled = await browser.evaluate<number>(`
        (function () {
          var n = 0;
          Array.from(document.styleSheets).forEach(function (sheet) {
            var href = String(sheet.href);
            if (href.indexOf('flow.css') !== -1 || href.indexOf('polish.css') !== -1) { sheet.disabled = true; n += 1; }
          });
          return n;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const off = await browser.evaluate<[number, number]>(probe);
      return { on, off, disabled };
    });
    if (measured === null) return;

    expect(measured.disabled, 'the control disabled no sheet, so its result means nothing').toBe(2);
    expect(measured.on, 'the shipped size changed').toEqual([32, 32]);
    expect(
      measured.off[0] !== measured.on[0] || measured.off[1] !== measured.on[1],
      `the mount kept its 32px box with both sheets disabled (${JSON.stringify(measured)}), so the sheets are not what size it`,
    ).toBe(true);
  }, BROWSER_TIMEOUT_MS);
});

// ------------------------------------------------- 3. the timeline dot states

describe('3. the timeline distinguishes what happened from what is happening', () => {
  it('every row is done, and the newest row on an open job is current', async () => {
    const page = await render('polish-redo');
    try {
      const rows = Array.from(page.document.querySelectorAll('#history > li'));
      expect(rows.length, 'no history rows rendered: the classes below would be vacuous').toBeGreaterThan(2);

      const classes = rows.map((li) => li.className);
      expect(classes.slice(0, -1).every((c) => c === 'done'), `every past row must be done, got ${classes.join(', ')}`).toBe(true);
      expect(classes[classes.length - 1], 'the newest row on an open job is the current one').toBe('now');

      // The state the page deliberately does not ship. renderHistory appends
      // a row only for a timestamp the projection carries, so a row about
      // something that has not happened has no source; a `todo` class here
      // would be markup no code can justify.
      expect(rows.filter((li) => li.className.includes('todo')).length).toBe(0);
    } finally {
      page.close();
    }
  });

  it('a finished hire marks no row current, because nothing is waiting', async () => {
    const page = await render('polish-completed');
    try {
      const rows = Array.from(page.document.querySelectorAll('#history > li'));
      expect(rows.length, 'no rows rendered on the completed job').toBeGreaterThan(3);
      expect(rows.map((li) => li.className).every((c) => c === 'done'), 'a terminal job marked a row current').toBe(true);
    } finally {
      page.close();
    }
  });

  // The page's own terminal list, checked against the domain's. A status the
  // domain calls terminal that this page thinks is open would put a "current"
  // marker on a finished hire; the reverse would lose the marker on a live
  // one. Derived from src/domain/job.ts's exported isTerminal rather than
  // from a copied list, so the two cannot drift silently.
  it('the page\u2019s terminal statuses agree with the domain\u2019s, status by status', async () => {
    const script = readFileSync(scriptPath, 'utf8');
    const block = /var TERMINAL_STATUSES = \[([\s\S]*?)\];/.exec(script)?.[1] ?? '';
    const pageList = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as JobStatus);
    expect(pageList.length, 'no terminal statuses parsed out of operatorjob.js').toBeGreaterThan(5);

    const every: JobStatus[] = [
      'draft', 'proposed', 'confirmed', 'staged', 'redo_requested', 'submitted',
      'completed', 'declined', 'closed_unmerged', 'stale', 'withdrawn',
      'staged_declined', 'closed_unpaid', 'expired_unstaged', 'deemed_completed', 'cited_closed',
    ];
    const disagreements = every.filter((s) => isTerminal(s) !== pageList.includes(s));
    expect(disagreements, 'statuses where the page and src/domain/job.ts disagree about "finished"').toEqual([]);
  });

  // MEASURED. The classes above are only worth having if the sheet draws them
  // differently; three drawn states that render one way is the flattening
  // this card was told not to ship.
  it('the two states are visibly different dots, and the difference is the sheet\u2019s', async () => {
    const measured = await measure({ job: 'polish-redo' }, async (browser) =>
      browser.evaluate<{ rows: Array<{ cls: string; bg: string; border: string }>; restColour: string }>(`
        (function () {
          function dotOf(li) {
            var d = li.querySelector('.dot');
            var c = getComputedStyle(d);
            return { cls: li.className, bg: c.backgroundColor, border: c.borderTopColor };
          }
          var rows = Array.prototype.map.call(document.querySelectorAll('#history > li'), dotOf);
          // The rest state, read by taking the state class off a real row.
          var li = document.querySelector('#history > li');
          var saved = li.className;
          li.className = '';
          var rest = getComputedStyle(li.querySelector('.dot')).backgroundColor;
          li.className = saved;
          return { rows: rows, restColour: rest };
        })()
      `),
    );
    if (measured === null) return;

    const done = measured.rows.find((r) => r.cls === 'done');
    const now = measured.rows.find((r) => r.cls === 'now');
    expect(done, 'no done row measured').toBeTruthy();
    expect(now, 'no current row measured').toBeTruthy();
    expect(
      done!.bg !== now!.bg,
      `done and current draw the same dot (${JSON.stringify(measured.rows)}), which is the flattened timeline`,
    ).toBe(true);
    // And the rest state is a third value, so `done` is an override rather
    // than the same fill written twice. This is the wireframe's own rule.
    expect(
      measured.restColour !== done!.bg,
      `the unclassed dot already draws as done (${measured.restColour}), so the done rule does nothing`,
    ).toBe(true);
  }, BROWSER_TIMEOUT_MS);
});

// --------------------------------------------------- 4. the history is ordered

describe('4. the timeline is ordered by when things happened', () => {
  it('a restaged job puts the restage after the redo it answered', async () => {
    // polish-restaged: stagedAt 12 minutes ago, redo.requestedAt 2 hours ago.
    // The renderer pushes staging before the redo, so push order and real
    // order disagree, which is the whole point of the fixture.
    const page = await render('polish-restaged');
    try {
      const labels = Array.from(page.document.querySelectorAll('#history > li .lbl')).map((n) => n.textContent ?? '');
      const staged = labels.indexOf('Work staged');
      const redo = labels.indexOf('The buyer sent it back, citing a line');
      expect(staged, '"Work staged" row missing').toBeGreaterThan(-1);
      expect(redo, 'the redo row is missing').toBeGreaterThan(-1);
      expect(
        staged > redo,
        `the restage is drawn above the redo it answered (${labels.join(' | ')})`,
      ).toBe(true);

      // And the marker follows the sort: the newest fact is the current one.
      const rows = Array.from(page.document.querySelectorAll('#history > li'));
      expect(rows[rows.length - 1]?.querySelector('.lbl')?.textContent).toBe('Work staged');
    } finally {
      page.close();
    }
  });

  it('every row is in ascending time order, read off the rendered dates', async () => {
    const page = await render('polish-completed');
    try {
      const rows = Array.from(page.document.querySelectorAll('#history > li'));
      expect(rows.length, 'no rows to order').toBeGreaterThan(3);
      const labels = rows.map((li) => li.querySelector('.lbl')?.textContent ?? '');
      // The projection's own order for this fixture, which is also the true
      // order of events: brief 6 hours ago, confirmed 5, staged 4, submitted
      // 3, merged 2, each read off the one BASE instant at the head of this
      // file so the fixture's own order cannot invert between statements.
      // Stated as the expected sequence rather than as a monotonicity check
      // on the dates, because every fixture date formats to the same day and
      // a same-day check would pass on any permutation.
      expect(labels).toEqual([
        'Brief arrived',
        'Agreement confirmed, both sides signed',
        'Work staged',
        'Pull request opened',
        'Merged',
      ]);
    } finally {
      page.close();
    }
  });
});

// -------------------------------------------------------------- 5. the reveal

describe('5. the reveal engages, finishes, and stands down for reduced motion', () => {
  it('the declared targets are the panes the wireframe declares', async () => {
    const shell = new JSDOM(readFileSync(pagePath, 'utf8'));
    try {
      const ids = Array.from(shell.window.document.querySelectorAll('.reveal, .stagger')).map((el) => el.id);
      expect(ids, 'the reveal targets are not the wireframe\u2019s four panes plus the timeline').toEqual([
        'redo-panel', 'stage-panel', 'money-facts', 'history', 'drafting-facts',
      ]);
      const timeline = shell.window.document.getElementById('history');
      expect(timeline?.classList.contains('stagger'), 'the timeline does not opt into the stagger').toBe(true);
    } finally {
      shell.window.close();
    }
  });

  // The rows are appended long after ui.js's sweep. This is the assertion
  // that they still end up visible: the container is what the observer
  // watches, and base.css styles stagger children off the parent's class.
  it('rows appended after the sweep still finish visible, in motion and at rest', async () => {
    for (const reduce of [false, true]) {
      const measured = await measure({ reduce }, async (browser) => {
        await browser.evaluate('window.scrollTo(0, document.body.scrollHeight); true;');
        // Past ui.js's own three second unconditional fallback, so this reads
        // the settled state and not a frame in the middle of a transition.
        await new Promise((resolve) => setTimeout(resolve, 3600));
        return browser.evaluate<{ jsReveal: boolean; reduce: boolean; rows: number; faded: string[] }>(`
          (function () {
            var faded = [];
            Array.prototype.forEach.call(document.querySelectorAll('.reveal, .stagger'), function (el) {
              if (el.hidden) return;
              if (parseFloat(getComputedStyle(el).opacity) < 0.99) faded.push(el.id);
            });
            Array.prototype.forEach.call(document.querySelectorAll('#history > li'), function (li) {
              if (parseFloat(getComputedStyle(li).opacity) < 0.99) faded.push('row');
            });
            return {
              jsReveal: document.documentElement.classList.contains('js-reveal'),
              reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
              rows: document.querySelectorAll('#history > li').length,
              faded: faded
            };
          })()
        `);
      });
      if (measured === null) return;

      expect(measured.reduce, `the emulation did not take for reduce=${reduce}`).toBe(reduce);
      expect(measured.rows, 'no timeline rows rendered, so nothing was measured').toBeGreaterThan(2);
      expect(measured.faded, `content left invisible with reduce=${reduce}`).toEqual([]);
      // Reduced motion never engages the hidden layer at all: ui.js returns
      // before adding the class, so the CSS default (the finished state) is
      // what a visitor gets, with no transition to sit through.
      expect(measured.jsReveal, `the reveal layer engaged with reduce=${reduce}`).toBe(!reduce);
    }
  }, 120000);

  // MUTATION CONTROL for the assertion above. With .js-reveal forced onto
  // <html> and the container's .is-in taken away, the rows must go invisible.
  // A control that stays visible would mean the check above cannot fail.
  it('control: with the reveal layer forced on and .is-in removed, the rows do go invisible', async () => {
    const measured = await measure({}, async (browser) => {
      await browser.evaluate('window.scrollTo(0, document.body.scrollHeight); true;');
      await new Promise((resolve) => setTimeout(resolve, 3600));
      return browser.evaluate<{ before: number; after: number; rows: number }>(`
        (function () {
          var track = document.getElementById('history');
          var first = track.querySelector('li');
          var before = parseFloat(getComputedStyle(first).opacity);
          document.documentElement.classList.add('js-reveal');
          track.classList.remove('is-in');
          var after = parseFloat(getComputedStyle(first).opacity);
          return { before: before, after: after, rows: track.children.length };
        })()
      `);
    });
    if (measured === null) return;

    expect(measured.rows, 'no rows to hide, so the control proves nothing').toBeGreaterThan(2);
    expect(measured.before, 'the row was not visible to begin with').toBeGreaterThan(0.99);
    expect(
      measured.after < 0.5,
      `the row stayed visible with the hidden layer forced on (${JSON.stringify(measured)}), so the reveal assertion cannot fail`,
    ).toBe(true);
  }, 120000);

  it('with JavaScript off the page is not a blank screen', async () => {
    if (!hasRealBrowser()) return;
    const browser = await RealBrowser.launch({ width: 1280, height: 900 });
    try {
      await browser.send('Emulation.setScriptExecutionDisabled', { value: true });
      await browser.goto(`${baseUrl}/operatorjob?job=polish-redo`, 600);
      const out = await browser.evaluate<{ htmlClass: string; text: string; faded: number; brand: string; logo: boolean }>(`
        (function () {
          var faded = 0;
          Array.prototype.forEach.call(document.querySelectorAll('.reveal, .stagger'), function (el) {
            if (parseFloat(getComputedStyle(el).opacity) < 0.99) faded += 1;
          });
          var a = document.querySelector('a.brand');
          var logo = Array.prototype.some.call(document.querySelectorAll('a.brand img'), function (i) {
            return i.complete && i.naturalWidth > 0 && i.getBoundingClientRect().width > 0;
          });
          return { htmlClass: document.documentElement.className,
                   text: (document.body.innerText || '').trim(), faded: faded,
                   brand: a ? (a.getAttribute('aria-label') || '') : '', logo: logo };
        })()
      `);
      // The hidden state only exists under .js-reveal, which only JavaScript
      // adds, so with scripts off every declared target keeps the CSS default
      // (its finished state) and nothing is invisible.
      expect(out.htmlClass, 'the hidden reveal layer engaged with no JavaScript running').not.toContain('js-reveal');
      expect(out.faded, 'a reveal target is invisible with JavaScript off').toBe(0);
      // This page's body is data-driven and stays hidden with no script, the
      // same shape staged.html, deposit.html and agreement.html already ship.
      // What must never happen is a blank document: the nav, the footer and
      // their real destinations are server-rendered and readable. The product
      // name is the logo (DESIGN.md section 8), an image inside a labelled
      // link, so it is checked as painted and named rather than as text.
      expect(out.brand, 'the page is genuinely blank with JavaScript off').toBe('FreeAgents home');
      expect(out.logo, 'the logo did not paint with JavaScript off').toBe(true);
      expect(out.text).toContain('How it works');
      expect(out.text).toContain('Verify a credential');
    } finally {
      await browser.close();
    }
  }, 60000);
});

// ---------------------------------------------- 6. 320px, with the sheet open

describe('6. the polished page holds at 320px, including its open states', () => {
  it('the .who row wraps rather than overflowing, and every control clears 44px', async () => {
    const measured = await measure({ width: 320 }, async (browser) =>
      browser.evaluate<{
        wrap: string; whoScroll: [number, number]; doc: [number, number];
        short: Array<{ t: string; h: number }>;
      }>(`
        (function () {
          var who = document.querySelector('.who');
          var short = [];
          Array.prototype.forEach.call(document.querySelectorAll('button, a.btn'), function (b) {
            var r = b.getBoundingClientRect();
            if (r.height === 0 && r.width === 0) return;
            if (r.height < 44) short.push({ t: (b.textContent || '').trim().slice(0, 30), h: Math.round(r.height * 100) / 100 });
          });
          return {
            wrap: getComputedStyle(who).flexWrap,
            whoScroll: [who.scrollWidth, who.clientWidth],
            doc: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
            short: short
          };
        })()
      `),
    );
    if (measured === null) return;

    // flow.css wraps .who below 420px, which is why the page-local
    // `flex-wrap: wrap` this card deleted is not needed at 320: the shared
    // sheet already does it, in a media query, where the wireframe put it.
    expect(measured.wrap, 'the .who row does not wrap at 320px, so its four children must fit one line').toBe('wrap');
    expect(measured.whoScroll[0], 'the .who row scrolls sideways inside itself').toBe(measured.whoScroll[1]);
    expect(measured.doc[0], 'the 320px page scrolls sideways').toBe(measured.doc[1]);
    expect(measured.short, 'controls under the 44px tap floor at 320px').toEqual([]);
  }, BROWSER_TIMEOUT_MS);

  it('the refuse sheet, opened at 320px, fits and wears flow.css\u2019s own chrome', async () => {
    // tests/web/operatorjob.test.ts already opens the ACCEPT sheet at 320.
    // This one opens the other sheet, and additionally reads the three
    // declarations flow.css carries that the deleted page-local copy did not,
    // which is the visible difference the sheet swap is supposed to deliver.
    const measured = await measure({ width: 320 }, async (browser) => {
      await browser.evaluate("document.getElementById('redo-refuse-btn').click(); true;");
      await new Promise((resolve) => setTimeout(resolve, 400));
      return browser.evaluate<{
        open: boolean; rows: number; doc: [number, number]; right: number;
        shadow: string; headAlign: string; closeLineHeight: string; closeBox: [number, number];
      }>(`
        (function () {
          var d = document.getElementById('refuse');
          var r = d.getBoundingClientRect();
          var close = d.querySelector('.sclose');
          var cr = close.getBoundingClientRect();
          return {
            open: d.open,
            rows: d.querySelectorAll('#refuse-consequences > li').length,
            doc: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
            right: Math.round(r.right),
            shadow: getComputedStyle(d).boxShadow,
            headAlign: getComputedStyle(d.querySelector('.shead')).alignItems,
            closeLineHeight: getComputedStyle(close).lineHeight,
            closeBox: [Math.round(cr.width), Math.round(cr.height)]
          };
        })()
      `);
    });
    if (measured === null) return;

    expect(measured.open, 'the refuse sheet did not open').toBe(true);
    expect(measured.rows, 'the refuse sheet rendered no consequence rows').toBeGreaterThan(2);
    expect(measured.doc[0], 'the 320px page scrolls sideways with the refuse sheet open').toBe(measured.doc[1]);
    expect(measured.right, 'the sheet runs off the right edge').toBeLessThanOrEqual(measured.doc[1]);
    expect(measured.closeBox, 'the close control is under the 44px tap floor').toEqual([44, 44]);

    // The three declarations flow.css adds over the copy this card deleted.
    // Each is a real visual change that arrives with the sheet, so each is
    // asserted rather than assumed.
    expect(measured.shadow, 'flow.css\u2019s sheet shadow is not in force').toContain('inset');
    expect(measured.shadow, 'the sheet\u2019s drop shadow is missing').toMatch(/rgba?\(0, 0, 0/);
    expect(measured.headAlign, 'flow.css\u2019s shead alignment is not in force').toBe('flex-start');
    expect(measured.closeLineHeight, 'flow.css\u2019s sclose line-height is not in force').toBe('22px');
  }, 60000);
});
