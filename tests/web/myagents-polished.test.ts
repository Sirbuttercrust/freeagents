// W-myagents: the My agents page rebuilt on spec/wireframe/myagents.html's
// polished visual system.
//
// The conformance gate (tests/web/wireframe-conformance.test.ts) measures two
// things about this page's clothes: that the wireframe's stylesheets are
// linked, and that the string "data-avatar" appears in the page or its
// script. Both are satisfied by a link tag and a substring, so both are
// satisfied by a page that loads sheets it never uses, mounts an avatar that
// never paints, writes data-avatar inside a comment, renders the wireframe's
// builder notes as copy, or keeps the pre-polish dot where the wireframe
// draws a glyph. This file is the distance between passing that gate and
// shipping the right page.
//
// tests/web/myagents.test.ts owns the live wiring (the three reads, the
// failure handling, the four rulings, the counts, the 320px floor). Nothing
// here restates it.
//
// Where a fact is derived from the wireframe or from a shipped file rather
// than typed here (the note prose, the sheet list, the icon vocabulary), the
// derivation FAILS LOUDLY on an empty population: a selector that stops
// matching would otherwise turn a real sweep into a green loop over nothing.
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
import { createJob, type Job } from '../../src/domain/job.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';
import { PAINTED_PIXELS_FN } from '../helpers/bot-mount.js';
import { defaultAvatar, type AvatarSpec } from '../../src/domain/avatar-spec.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const PLATFORM_SEED = 'e'.repeat(64);

const here = dirname(fileURLToPath(import.meta.url));
const wireframePath = join(here, '../../spec/wireframe/myagents.html');
const pagePath = join(here, '../../src/web/pages/myagents.html');
const scriptPath = join(here, '../../src/web/public/js/pages/myagents.js');
const iconsPath = join(here, '../../src/web/public/js/icons.js');

// The wireframe's own four sample agents, so a reader can hold this page and
// spec/wireframe/myagents.html side by side. One per tier, plus one that is
// verified and therefore carries no attention line at all.
const HIRE_DID = 'did:abt:driftcheck';
const PRIOR_DID = 'did:abt:hatchmark';
const COLD_DID = 'did:abt:pixelforge';
const PLAIN_DID = 'did:abt:seamline';
const PLAIN_OVERRIDE: AvatarSpec = (() => {
  const d = defaultAvatar(PLAIN_DID);
  return { shape: d.shape === 'ghost' ? 'pill' : 'ghost', face: d.face === 'eyes' ? 'mouth' : 'eyes', colour: d.colour === 'c10' ? 'c2' : 'c10' };
})();
function servedSpec(did: string): AvatarSpec {
  return did === PLAIN_DID ? PLAIN_OVERRIDE : defaultAvatar(did);
}

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

function offerFixture(id: string, agentDid: string): Job {
  const base = createJob(
    { id, buyerDid: 'did:abt:myagents-polished-buyer', agentDid, repository: 'buyer/target-repo', brief: 'Fix the login bug' },
    new Date('2026-08-17T00:00:00Z'),
  );
  return { ...base, status: 'draft', criteria: [] };
}

let server: Server;
let baseUrl: string;
let session: Session;
let originalSeed: string | undefined;

beforeAll(async () => {
  originalSeed = process.env.FREEAGENTS_PLATFORM_SEED;
  process.env.FREEAGENTS_PLATFORM_SEED = PLATFORM_SEED;

  const agentRepo = new MemoryAgentRepository();
  const credentialRepo = new MemoryCredentialRepository();
  const jobRepo = new MemoryJobRepository();
  const sessionAdapter = createSessionAdapter({
    github: fakeGitHubConfig(),
    fetchImpl: fakeGitHubFetch({ login: 'myagents-polished-operator', id: 9907 }),
  });

  const app = createApp(
    new MemoryAccountRepository(), agentRepo, undefined, undefined, jobRepo, undefined,
    undefined, credentialRepo, undefined, undefined, undefined, sessionAdapter,
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a port');
  baseUrl = `http://127.0.0.1:${address.port}`;

  session = await mintSession(sessionAdapter);
  const me = (await (await fetch(`${baseUrl}/accounts/me`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}` },
  })).json()) as { did: string };

  // Verified hires, and a GitHub binding that IS verified, so this row's only
  // attention item is the work offer.
  await agentRepo.create({
    did: HIRE_DID, operatorDid: me.did, delegation: delegationFixture(HIRE_DID, me.did),
    name: 'driftcheck', skills: ['contract tests'], githubLogin: 'driftcheck-gh',
  });
  await agentRepo.updateGithubBinding(HIRE_DID, { handle: 'driftcheck-gh', status: 'verified' });
  for (let i = 1; i <= 2; i++) {
    await credentialRepo.save({
      completedJobId: `myagents-polished-hire-${i}`,
      subjectDid: HIRE_DID,
      document: credentialDoc(`https://platform.example/v1/credentials/myagents-polished-hire-${i}`, HIRE_DID, `myagents-polished-commit-${i}`, `did:example:buyer-${i}`),
      repositoryPublic: true,
    });
  }
  await jobRepo.create(offerFixture('myagents-polished-offer', HIRE_DID));

  for (const [did, name] of [[PRIOR_DID, 'hatchmark'], [COLD_DID, 'pixelforge'], [PLAIN_DID, 'seamline']] as const) {
    await agentRepo.create({
      did, operatorDid: me.did, delegation: delegationFixture(did, me.did),
      name, skills: ['work'], githubLogin: null,
    });
  }
  // AV2: one row carries an operator override, so the mount assertions can
  // tell "drew the served spec" from "re-derived the DID default".
  await agentRepo.setAvatarSpec(PLAIN_DID, PLAIN_OVERRIDE);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (originalSeed === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
  else process.env.FREEAGENTS_PLATFORM_SEED = originalSeed;
});

async function servedMarkup(): Promise<string> {
  const res = await fetch(`${baseUrl}/myagents`, { headers: { Accept: HTML } });
  return res.text();
}

function loadedSheets(markup: string): string[] {
  return [...markup.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map(
    (m) => ((m[1] ?? '').split('/').pop() ?? '').trim(),
  );
}

function loadedScripts(markup: string): string[] {
  return [...markup.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => (m[1] ?? '').trim());
}

// One signed-in render of the real page in a real browser, rows resolved.
async function withPage<T>(
  width: number,
  fn: (browser: RealBrowser) => Promise<T>,
  opts: { motion?: 'reduce' | 'no-preference' } = {},
): Promise<T> {
  const browser = await RealBrowser.launch({ width, height: 1200 });
  try {
    if (opts.motion) {
      await browser.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: opts.motion }],
      });
    }
    await browser.goto(`${baseUrl}/myagents`);
    await browser.evaluate(
      `sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(session))})`,
    );
    await browser.goto(`${baseUrl}/myagents`);
    // The roster read, the incoming read and one detail read per row all have
    // to land before anything here is worth measuring.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const painted = await browser.evaluate<number>(
        `Array.prototype.filter.call(document.querySelectorAll('.rav'), function (h) { return (${PAINTED_PIXELS_FN})(h) > 0; }).length`,
      );
      if (painted >= 4) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

// --------------------------------------------------------------- 1. the stack

describe('1. the page wears the wireframe\u2019s visual system', () => {
  it('loads every sheet the wireframe loads, in the wireframe\u2019s own order', async () => {
    const wireframe = readFileSync(wireframePath, 'utf8');
    const wanted = loadedSheets(wireframe);
    expect(wanted, 'no stylesheet parsed out of the wireframe: the derivation is broken')
      .toEqual(['base.css', 'polish.css', 'market.css']);

    const served = loadedSheets(await servedMarkup());
    // tokens.css is this repo's split of the wireframe's token block and is
    // first on every rebuilt page; the rest is the wireframe's list in the
    // wireframe's order, which is also the order market.css:3 depends on.
    // office.css and league.css close every page (the league look,
    // DESIGN.md 2): the office footer, then the shared layer that has to
    // win over every sheet before it.
    expect(served).toEqual(['tokens.css', 'base.css', 'polish.css', 'market.css', 'office.css', 'league.css']);
  });

  it('loads the polished script set in the order the avatar-carrying pages settled', async () => {
    const scripts = loadedScripts(await servedMarkup());
    expect(scripts).toEqual([
      '/js/pages/api.js',
      '/js/pages/nav.js',
      '/js/vendor/bot-avatars/bot-avatars.js',
      '/js/bots.js',
      '/js/office.js',
      '/js/icons.js',
      '/js/polish.js',
      '/js/pages/myagents.js',
      '/js/pages/ui.js',
    ]);
  });
});

// -------------------------------------------------------------- 2. the avatars

describe('2. the avatar mount is real, not a string that satisfies a regex', { timeout: 60000 }, () => {
  it('the static shell ships NO data-avatar, and the script sets it from the DID', () => {
    const shell = readFileSync(pagePath, 'utf8');
    // A data-avatar in static markup is one of two defects: a fabricated DID,
    // or an empty mount that paints a creature for the empty string.
    const staticMounts = [...shell.matchAll(/data-avatar="([^"]*)"/g)].map((m) => m[1]);
    expect(staticMounts, 'the static shell declares a data-avatar before any DID is known').toEqual([]);

    // The conformance gate's regex cannot tell code from a comment, so this
    // asserts the attribute is SET, by a call, on a value taken from the read.
    const script = readFileSync(scriptPath, 'utf8');
    expect(
      /setAttribute\(\s*"data-avatar"\s*,\s*agent\.did\s*\)/.test(script),
      'the script never sets data-avatar to the agent DID with a real call',
    ).toBe(true);
  });

  it('every row mounts its own DID and draws the bot its agent read served', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found; skipping (see CHROME_BIN)');
      return;
    }
    type Row = {
      did: string;
      shape: string | null; face: string | null; colour: string | null;
      painted: number; pending: boolean; kids: number;
    };
    const rows = await withPage(1280, (b) => b.evaluate<Row[]>(`
      Array.prototype.map.call(document.querySelectorAll('.arow'), function (row) {
        var rav = row.querySelector('.rav');
        return {
          did: rav ? rav.getAttribute('data-avatar') : null,
          shape: rav ? rav.getAttribute('data-avatar-shape') : null,
          face: rav ? rav.getAttribute('data-avatar-face') : null,
          colour: rav ? rav.getAttribute('data-avatar-colour') : null,
          painted: (${PAINTED_PIXELS_FN})(rav),
          pending: rav ? rav.hasAttribute('data-pending') : null,
          kids: rav ? rav.childElementCount : 0
        };
      })
    `));

    expect(rows.length, 'no row rendered: the fixture or the read is broken, not the page').toBe(4);
    expect(rows.map((r) => r.did).sort()).toEqual([HIRE_DID, PRIOR_DID, COLD_DID, PLAIN_DID].sort());
    for (const row of rows) {
      const want = servedSpec(row.did);
      // PLAIN_DID carries an override; the other three wear their default.
      // A page that re-derived the spec from the DID would fail PLAIN_DID.
      expect({ shape: row.shape, face: row.face, colour: row.colour }, `${row.did}: wrong bot`).toEqual({ ...want });
      // A 40px bot at 0.74 fill covers well over a hundred device pixels.
      expect(row.painted, `${row.did}: mounted but nothing was drawn`).toBeGreaterThan(100);
      expect(row.pending, `${row.did}: still marked pending after drawing`).toBe(false);
      expect(row.kids, `${row.did}: more than one root in the mount`).toBe(1);
    }
  });

  it('the bot has the same colour here as the palette says, read off the drawn pixels', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found; skipping (see CHROME_BIN)');
      return;
    }
    // The spec attributes say which bot was asked for. This reads what was
    // DRAWN: the most common opaque hue on each canvas has to sit near the
    // palette colour the served spec names, so a renderer that ignored the
    // colour key (or drew every bot one colour) fails here.
    const drawn = await withPage(1280, (b) => b.evaluate<Array<{ did: string; hue: number | null; want: number }>>(`
      (function () {
        function hueOf(r, g, b) {
          var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
          if (d < 24) return null;
          var h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
          return Math.round(((h * 60) + 360) % 360);
        }
        return Array.prototype.map.call(document.querySelectorAll('.arow .rav'), function (rav) {
          var c = rav.querySelector('canvas.bot');
          var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          var bins = {};
          for (var i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 250) continue;
            var h = hueOf(d[i], d[i + 1], d[i + 2]);
            if (h === null) continue;
            var k = Math.round(h / 10);
            bins[k] = (bins[k] || 0) + 1;
          }
          var best = null, n = 0;
          Object.keys(bins).forEach(function (k) { if (bins[k] > n) { n = bins[k]; best = +k * 10; } });
          var hex = window.FABots.COLOURS[rav.getAttribute('data-avatar-colour')];
          var want = hueOf(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16));
          return { did: rav.getAttribute('data-avatar'), hue: best, want: want };
        });
      })()
    `));
    expect(drawn.length).toBe(4);
    for (const row of drawn) {
      expect(row.hue, `${row.did}: no saturated pixel on the canvas`).not.toBeNull();
      const gap = Math.min(Math.abs(row.hue! - row.want), 360 - Math.abs(row.hue! - row.want));
      expect(gap, `${row.did}: drew hue ${row.hue}, palette says ${row.want}`).toBeLessThanOrEqual(25);
    }
  });

  it('no bot paints outside its 40px mount, so nothing lands on the row beneath', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found; skipping (see CHROME_BIN)');
      return;
    }
    // A canvas cannot paint outside its own border box, so the whole claim
    // is that the canvas box IS the 40px host box and the host clips. The
    // swarm needed a hit-test lattice because an svg's ink could escape its
    // viewBox; a canvas's cannot. Measured, with a control: widen the canvas
    // past the host and the clip must be what keeps it in.
    type Box = { host: number[]; canvas: number[]; overflow: string; hostClipsWide: boolean };
    const boxes = await withPage(1280, (b) => b.evaluate<Box[]>(`
      Array.prototype.map.call(document.querySelectorAll('.arow .rav'), function (rav) {
        var c = rav.querySelector('canvas.bot');
        function box(el) { var r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }
        var host = box(rav), canvas = box(c);
        // Control: a canvas forced 20px wider than the host. With the clip in
        // force the point just right of the host is not the canvas.
        c.style.width = '60px';
        var r = rav.getBoundingClientRect();
        var hit = document.elementFromPoint(r.right + 4, r.top + r.height / 2);
        var clips = hit !== c;
        rav.style.overflow = 'visible';
        var hitOpen = document.elementFromPoint(r.right + 4, r.top + r.height / 2);
        rav.style.overflow = '';
        c.style.width = '100%';
        return { host: host, canvas: canvas, overflow: getComputedStyle(rav).overflow,
                 hostClipsWide: clips && hitOpen === c };
      })
    `));
    expect(boxes.length).toBe(4);
    for (const box of boxes) {
      expect(box.host.slice(2), 'the mount is not 40x40').toEqual([40, 40]);
      expect(box.canvas, 'the canvas box differs from the host box').toEqual(box.host);
      expect(box.overflow, 'the avatar box does not clip').toBe('hidden');
      expect(box.hostClipsWide, 'the control could not show the clip doing the work').toBe(true);
    }
  });
});

// ----------------------------------------------------------------- 3. the tier

describe('3. the tier pill carries the wireframe\u2019s glyph, not the pre-polish dot', { timeout: 60000 }, () => {
  it('every tier the wireframe draws maps to the glyph the wireframe gives it', () => {
    const wireframe = readFileSync(wireframePath, 'utf8');
    // Derived from the wireframe rather than typed here: tier class to icon
    // name, as the wireframe's own four rows draw them.
    const pairs = [...wireframe.matchAll(/<span class="tier (tier-[a-z]+)"><span class="ico" data-ico="([a-z0-9-]+)"/g)]
      .map((m) => `${m[1]}:${m[2]}`);
    expect(pairs.length, 'no tier pill parsed out of the wireframe: the derivation is broken').toBeGreaterThanOrEqual(3);
    expect([...new Set(pairs)].sort()).toEqual([
      'tier-claim:file-dash',
      'tier-hire:shield-check',
      'tier-prior:link-2',
    ]);

    // Those three names must exist in the icon vocabulary, or the span is
    // painted with nothing and the pill silently loses its glyph.
    const icons = readFileSync(iconsPath, 'utf8');
    for (const name of ['shield-check', 'link-2', 'file-dash']) {
      expect(new RegExp(`"${name}":`).test(icons), `icons.js defines no glyph named ${name}`).toBe(true);
    }
  });

  it('no row renders base.css\u2019s pre-polish dot, and every glyph is actually painted', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found; skipping (see CHROME_BIN)');
      return;
    }
    const state = await withPage(1280, (b) => b.evaluate<{ dots: number; pills: Array<{ cls: string; ico: string; painted: boolean; w: number; h: number }> }>(`
      (function () {
        return {
          dots: document.querySelectorAll('.tier .dot').length,
          pills: Array.prototype.map.call(document.querySelectorAll('.arow .tier'), function (t) {
            var ico = t.querySelector('.ico');
            var r = ico ? ico.getBoundingClientRect() : { width: 0, height: 0 };
            return {
              cls: t.className,
              ico: ico ? ico.getAttribute('data-ico') : null,
              painted: !!(ico && ico.querySelector('svg')),
              w: +r.width.toFixed(1), h: +r.height.toFixed(1)
            };
          })
        };
      })()
    `));

    expect(state.dots, 'a row still renders the pre-polish .dot').toBe(0);
    expect(state.pills.length, 'no tier pill rendered: the fixture is broken, not the page').toBe(4);
    for (const pill of state.pills) {
      expect(pill.painted, `${pill.cls}: the glyph host is empty, so the pill lost its icon`).toBe(true);
      // polish.css:74 sizes .tier .ico at 13px. If polish.css were missing the
      // box would fall back to the 16px .ico default or to nothing at all.
      expect(pill.w, `${pill.cls}: glyph is ${pill.w}px wide, not the 13px polish.css sets`).toBeCloseTo(13, 0);
      expect(pill.h, `${pill.cls}: glyph is ${pill.h}px tall, not the 13px polish.css sets`).toBeCloseTo(13, 0);
    }
    // The tier the agent is in must match the glyph it wears.
    const hire = state.pills.find((p) => p.cls.includes('tier-hire'));
    expect(hire?.ico, 'the verified-hire pill wears the wrong glyph').toBe('shield-check');
  });
});

// --------------------------------------------------------- 4. the builder notes

describe('4. not one of the wireframe\u2019s three builder notes is rendered', () => {
  it('no element carries class "note", and no note prose appears in the served page', async () => {
    const wireframe = readFileSync(wireframePath, 'utf8');
    const noteSentences = [...wireframe.matchAll(/<div class="note">([\s\S]*?)<\/div>/g)]
      .map((m) => (m[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
      .flatMap((text) => text.split(/(?<=\.)\s+/))
      .map((s) => s.trim())
      .filter((s) => s.length >= 40);
    expect(
      noteSentences.length,
      'no note prose parsed out of the wireframe: the derivation is broken, not the page',
    ).toBeGreaterThan(3);

    const markup = await servedMarkup();
    expect(/class="note"/.test(markup), 'the built page renders an element with class "note"').toBe(false);

    // The reasoning may live in an HTML comment; it must not be visible copy.
    const visible = markup.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const leaked = noteSentences.filter((s) => visible.includes(s));
    expect(leaked, 'builder-note prose rendered as product copy').toEqual([]);
  });

  it('ships no control pointing at a page this app does not mount', async () => {
    const markup = await servedMarkup();
    // The wireframe's List-an-agent button and per-row Settings link. Neither
    // route exists, so shipping either is an inert declared control.
    for (const dead of ['listagent', 'agentsettings']) {
      expect(markup.includes(`href="/${dead}`), `the page links /${dead}, a route this app does not mount`).toBe(false);
    }
  });
});

// ------------------------------------------------------------ 5. states, 320px

describe('5. the polished page holds up at 320px, in both motion modes', { timeout: 60000 }, () => {
  const SWEEP = `
    (function () {
      var all = [].filter.call(document.querySelectorAll('button, a[href]'), function (el) {
        if (el.closest('nav') || el.closest('footer')) return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      return {
        measured: all.length,
        under: all.filter(function (el) {
          var r = el.getBoundingClientRect();
          return r.width < 44 || r.height < 44;
        }).map(function (el) {
          var r = el.getBoundingClientRect();
          return (el.textContent || el.tagName).trim().slice(0, 30) + ' ' +
                 Math.round(r.width * 10) / 10 + 'x' + Math.round(r.height * 10) / 10;
        }),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
      };
    })()
  `;

  it('with the counts disclosure OPEN, nothing overflows and every control clears 44px', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found; skipping (see CHROME_BIN)');
      return;
    }
    const result = await withPage(320, async (b) => {
      // The open state is the one a closed-state screenshot cannot see.
      await b.evaluate(`document.querySelector('[data-disclose="counts"]').click()`);
      await new Promise((r) => setTimeout(r, 600));
      const open = await b.evaluate<boolean>(`!document.getElementById('counts').hidden`);
      const sweep = await b.evaluate<{ measured: number; under: string[]; overflow: number }>(SWEEP);
      return { open, sweep };
    });

    expect(result.open, 'the disclosure did not open, so its contents were never measured').toBe(true);
    expect(result.sweep.measured, 'no control measured: the sweep is broken, not the page').toBeGreaterThan(3);
    expect(result.sweep.under, 'controls under the 44px floor at 320px with the disclosure open').toEqual([]);
    expect(result.sweep.overflow, 'the 320px page scrolls sideways with the disclosure open').toBe(0);
  });

  it('under prefers-reduced-motion the roster still lands on visible content', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found; skipping (see CHROME_BIN)');
      return;
    }
    // .stagger and .reveal animate the roster in. If the finished state were
    // not the CSS default, a reader who asked for no motion would get an
    // invisible roster.
    const state = await withPage(320, (b) => b.evaluate<{ opacity: string; transform: string; avatars: number; icons: number }>(`
      (function () {
        var first = document.querySelector('.arow');
        var cs = getComputedStyle(first);
        return {
          opacity: cs.opacity,
          transform: cs.transform,
          avatars: Array.prototype.filter.call(document.querySelectorAll('.rav'), function (h) { return (${PAINTED_PIXELS_FN})(h) > 100; }).length,
          icons: document.querySelectorAll('.tier .ico svg').length
        };
      })()
    `), { motion: 'reduce' });

    expect(state.opacity, 'the roster is transparent under reduced motion').toBe('1');
    expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(state.transform);
    expect(state.avatars, 'no avatar painted under reduced motion').toBe(4);
    expect(state.icons, 'no tier glyph painted under reduced motion').toBe(4);
  });
});

// ------------------------------------------------------ 6. the avatar editor

describe('6. the avatar editor under each row (AV2)', { timeout: 60000 }, () => {
  // Shared by both tests: open HIRE_DID's editor and wait for its tiles.
  const OPEN_EDITOR = `
    (function () {
      var host = document.querySelector('.rav[data-avatar="${HIRE_DID}"]');
      var row = host && host.closest('.arow');
      var toggle = row && row.querySelector('.avedit-toggle');
      if (!toggle) return false;
      toggle.click();
      return toggle.getAttribute('aria-expanded') === 'true';
    })()
  `;

  it('OPEN at 320px: 18 shapes, 2 faces, 12 colours, every tile 44px, nothing overflows', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found; skipping (see CHROME_BIN)');
      return;
    }
    type Report = {
      opened: boolean;
      counts: { shape: number; face: number; colour: number };
      checked: { shape: string | null; face: string | null; colour: string | null };
      small: string[];
      unnamed: number;
      overflow: number;
      panelRight: number;
      viewport: number;
      tilesDrawn: number;
    };
    const report = await withPage(320, async (b) => {
      const opened = await b.evaluate<boolean>(OPEN_EDITOR);
      await new Promise((r) => setTimeout(r, 400));
      const rest = await b.evaluate<Omit<Report, 'opened'>>(`
        (function () {
          var panel = document.querySelector('.avedit:not([hidden])');
          function n(k) { return panel.querySelectorAll('.avedit-' + k + ' input[type=radio]').length; }
          function c(k) { var i = panel.querySelector('.avedit-' + k + ' input:checked'); return i ? i.value : null; }
          var controls = [].slice.call(panel.querySelectorAll('.avedit-opt, button'));
          var small = controls.filter(function (el) {
            var r = el.getBoundingClientRect();
            return r.width < 44 || r.height < 44;
          }).map(function (el) {
            var r = el.getBoundingClientRect();
            return (el.textContent || el.className).trim().slice(0, 24) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height);
          });
          // Every radio has an accessible name through its label text.
          var unnamed = [].filter.call(panel.querySelectorAll('input[type=radio]'), function (i) {
            var l = i.closest('label');
            return !l || !(l.textContent || '').trim();
          }).length;
          var drawn = [].filter.call(panel.querySelectorAll('.avedit-shape canvas'), function (cv) {
            if (!cv.width) return false;
            var d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
            for (var i = 3; i < d.length; i += 4) if (d[i] > 200) return true;
            return false;
          }).length;
          return {
            counts: { shape: n('shape'), face: n('face'), colour: n('colour') },
            checked: { shape: c('shape'), face: c('face'), colour: c('colour') },
            small: small,
            unnamed: unnamed,
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            panelRight: Math.round(panel.getBoundingClientRect().right),
            viewport: document.documentElement.clientWidth,
            tilesDrawn: drawn
          };
        })()
      `);
      return { opened, ...rest };
    });

    expect(report.opened, 'the editor did not open, so nothing below was measured').toBe(true);
    expect(report.counts).toEqual({ shape: 18, face: 2, colour: 12 });
    // Opens on what is stored: HIRE_DID has no override, so its default.
    expect(report.checked).toEqual({ ...defaultAvatar(HIRE_DID) });
    expect(report.tilesDrawn, 'shape tiles were left blank').toBe(18);
    expect(report.small, 'editor controls under 44px at 320').toEqual([]);
    expect(report.unnamed, 'a radio with no visible name').toBe(0);
    expect(report.overflow, 'the 320px page scrolls sideways with the editor open').toBe(0);
    expect(report.panelRight).toBeLessThanOrEqual(report.viewport);
  });

  it('Save writes the draft through PUT, the row takes it at once, and Reset puts the default back', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found; skipping (see CHROME_BIN)');
      return;
    }
    const d = defaultAvatar(HIRE_DID);
    // A spec that differs from the default in every key, so a save that
    // dropped any one of them shows.
    const pick: AvatarSpec = {
      shape: d.shape === 'star' ? 'drop' : 'star',
      face: d.face === 'eyes' ? 'mouth' : 'eyes',
      colour: d.colour === 'c6' ? 'c11' : 'c6',
    };
    type Seen = { shape: string | null; face: string | null; colour: string | null; status: string };
    const readRow = `
      (function () {
        var host = document.querySelector('.rav[data-avatar="${HIRE_DID}"]');
        var st = host.closest('.arow').querySelector('.avedit-status');
        return { shape: host.getAttribute('data-avatar-shape'), face: host.getAttribute('data-avatar-face'),
                 colour: host.getAttribute('data-avatar-colour'), status: st ? st.textContent : '' };
      })()
    `;
    const seen = await withPage(1280, async (b) => {
      await b.evaluate(OPEN_EDITOR);
      await b.evaluate(`
        (function () {
          var panel = document.querySelector('.avedit:not([hidden])');
          Object.entries(${JSON.stringify(pick)}).forEach(function (kv) {
            var input = panel.querySelector('.avedit-' + kv[0] + ' input[value="' + kv[1] + '"]');
            input.click();
          });
          [].filter.call(panel.querySelectorAll('button'), function (x) { return x.textContent === 'Save'; })[0].click();
        })()
      `);
      await new Promise((r) => setTimeout(r, 800));
      const afterSave = await b.evaluate<Seen>(readRow);
      await b.evaluate(`
        [].filter.call(document.querySelectorAll('.avedit:not([hidden]) button'), function (x) { return x.textContent === 'Reset to default'; })[0].click()
      `);
      await new Promise((r) => setTimeout(r, 800));
      const afterReset = await b.evaluate<Seen>(readRow);
      return { afterSave, afterReset };
    });

    // The row changed without a reload, and the server holds the same spec.
    expect({ shape: seen.afterSave.shape, face: seen.afterSave.face, colour: seen.afterSave.colour }).toEqual({ ...pick });
    expect(seen.afterSave.status).toContain('Saved');
    // After reset: the row and the server are both back on the default.
    expect({ shape: seen.afterReset.shape, face: seen.afterReset.face, colour: seen.afterReset.colour }).toEqual({ ...d });
    expect(seen.afterReset.status).toContain('default');
    const served = (await (await fetch(`${baseUrl}/agents/${encodeURIComponent(HIRE_DID)}`)).json()) as { avatarSpec: AvatarSpec };
    expect(served.avatarSpec, 'the reset did not reach the server').toEqual(d);
  });
});
