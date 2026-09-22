// W-hire: the hire page rebuilt on spec/wireframe/hire.html's polished
// visual system.
//
// The conformance gate (tests/web/wireframe-conformance.test.ts) measures two
// things about this page's clothes: that polish.css is linked, and that a
// data-avatar mount exists in the page or its script. Both are satisfied by a
// link tag and a string, so both are satisfied by a page that loads four
// sheets it does not use, mounts an avatar that never paints, renders the
// wireframe's builder notes as copy, links a rail stage at a route that can
// only refuse, or collapses its own textarea on every phone. This file is the
// distance between passing that gate and shipping the right page.
//
// tests/web/hire-flow.test.ts owns the live wiring (the DID from the query
// string, the signed-out branch, the agent read, both guards, the 201
// redirect, the six refusal sentences). Nothing here restates it.
//
// Where a fact is derived from the wireframe or from a shipped file rather
// than typed here (the note prose, the stylesheet set, the control
// population), the derivation FAILS LOUDLY on an empty population: a selector
// that stops matching would otherwise turn a real sweep into a green loop
// over nothing.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { MemoryAgentRepository, MemoryAccountRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSessionToken } from '../helpers/session-fixtures.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';
import { botMount, expectedMount } from '../helpers/bot-mount.js';
import { defaultAvatar, type AvatarSpec } from '../../src/domain/avatar-spec.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

const here = dirname(fileURLToPath(import.meta.url));
const wireframePath = join(here, '../../spec/wireframe/hire.html');
const scriptPath = join(here, '../../src/web/public/js/pages/hire.js');

const AGENT_DID = 'did:abt:zWHirePolishedAgent';
const OVERRIDE: AvatarSpec = (() => {
  const d = defaultAvatar(AGENT_DID);
  return { shape: d.shape === 'mech' ? 'cat' : 'mech', face: d.face === 'eyes' ? 'mouth' : 'eyes', colour: d.colour === 'c9' ? 'c3' : 'c9' };
})();
const OPERATOR_DID = 'did:abt:zWHirePolishedOperator';

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

let server: Server;
let baseUrl: string;
let token: string;

beforeAll(async () => {
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: AGENT_DID,
    operatorDid: OPERATOR_DID,
    delegation: delegationFixture(AGENT_DID, OPERATOR_DID),
    name: 'hire-polished-scout',
    skills: ['triage'],
    githubLogin: null,
  });
  // AV2: an operator override, deliberately different from this DID's
  // default, so the mount assertion below can only pass if hire.js drew the
  // spec the agent read served rather than re-deriving one from the DID.
  await agentRepo.setAvatarSpec(AGENT_DID, OVERRIDE);
  const sessionAdapter = createSessionAdapter({
    github: fakeGitHubConfig(),
    fetchImpl: fakeGitHubFetch({ login: 'hire-polished-buyer', id: 9201 }),
  });
  const accountRepo = new MemoryAccountRepository();
  await accountRepo.register({ did: 'did:abt:hire-polished-buyer-account', githubLogin: 'hire-polished-buyer' });

  server = createApp(
    accountRepo,
    agentRepo,
    undefined,
    undefined,
    new MemoryJobRepository(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    sessionAdapter,
  ).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  token = await mintSessionToken(sessionAdapter);
  // 30s, not vitest's 10s default: minting a real session runs the sign-in
  // path's key work, and this hook timed out under load on the first run of
  // this file while the code it wraps was fine.
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function hirePath(agentDid = AGENT_DID): string {
  return `/hire?agent=${encodeURIComponent(agentDid)}`;
}

async function servedMarkup(path = hirePath()): Promise<string> {
  const res = await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } });
  expect(res.status).toBe(200);
  return res.text();
}

interface Rendered {
  document: Document;
  close: () => void;
}

// The page with its own scripts run for real, the same instrument
// tests/web/hire-flow.test.ts uses. jsdom performs no layout, so nothing here
// reads a size; every size assertion drives a real browser instead.
async function renderHire(path: string, session: { token: string } | null): Promise<Rendered> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  const markup = await servedMarkup(path);
  const dom = new JSDOM(markup, {
    url: `${baseUrl}${path}`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      if (session !== null) {
        window.sessionStorage.setItem('fa_session', JSON.stringify(session));
      }
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
  await new Promise((resolve) => setTimeout(resolve, 300));

  const real = failures.filter((message) => !message.includes('Not implemented: navigation'));
  if (real.length > 0) throw new Error(`page script failed on ${path}: ${real.join('; ')}`);

  return { document: dom.window.document, close: () => dom.window.close() };
}

function linkedSheets(markup: string): string[] {
  return [...markup.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map(
    (m) => ((m[1] ?? '').split('/').pop() ?? '').trim(),
  );
}

function loadedScripts(markup: string): string[] {
  return [...markup.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => (m[1] ?? '').trim());
}

// ---------------------------------------------------------------- 1. the stack

describe('1. the page wears the polished system, and only the sheets it uses', () => {
  it('loads polish.css, and loads none of market, gallery, agreement or pipeline', async () => {
    const sheets = linkedSheets(await servedMarkup());

    // The presence half, which is the conformance gate's assertion, restated
    // so this file fails on its own if the sheet is ever dropped.
    expect(sheets, 'the polished layer must be linked').toContain('polish.css');
    expect(sheets).toContain('tokens.css');
    expect(sheets).toContain('base.css');

    // The absence half, which the conformance gate does NOT make: it checks
    // only that the wireframe's sheets are present, so an over-load passes it
    // in silence. This page has no market card, no portfolio gallery, no
    // signature matrix and no pipeline rail, and the wireframe links none of
    // the four.
    const overLoaded = ['market.css', 'gallery.css', 'agreement.css', 'pipeline.css', 'landing.css'].filter((s) =>
      sheets.includes(s),
    );
    expect(overLoaded, 'stylesheets loaded by a page that uses none of their components').toEqual([]);
  });

  it('loads the bot core, then bots.js, before the page script, and does not load the icon sprite', async () => {
    const markup = await servedMarkup();
    const scripts = loadedScripts(markup);

    expect(scripts).toEqual([
      '/js/pages/api.js',
      '/js/pages/nav.js',
      '/js/vendor/bot-avatars/bot-avatars.js',
      '/js/bots.js',
      '/js/polish.js',
      '/js/pages/hire.js',
      '/js/pages/ui.js',
    ]);

    // Order is the assertion, not mere presence: window.FABots has to exist
    // by the time hire.js runs its agent read, and bots.js reads
    // window.BotAvatars once when it loads, so the core must come first.
    expect(scripts.indexOf('/js/vendor/bot-avatars/bot-avatars.js')).toBeLessThan(scripts.indexOf('/js/bots.js'));
    expect(scripts.indexOf('/js/bots.js')).toBeLessThan(scripts.indexOf('/js/pages/hire.js'));

    // icons.js paints [data-ico] hosts. This page declares none, the same as
    // its wireframe, so loading the sprite would ship a module with nothing
    // to do. Parsed, not grepped: a grep cannot tell an attribute on an
    // element from the word in a comment, and this page's comment explains
    // why the attribute is absent.
    expect(scripts.some((s) => s.includes('icons.js'))).toBe(false);
    const shell = new JSDOM(markup);
    try {
      expect(
        Array.from(shell.window.document.querySelectorAll('[data-ico]')).length,
        'a [data-ico] host with no sprite loaded paints nothing, silently',
      ).toBe(0);
    } finally {
      shell.window.close();
    }
  });
});

// --------------------------------------------------------------- 2. the avatar

describe('2. the avatar is the agent\u2019s bot, mounted only once the DID is known', () => {
  it('hire.js mounts through bots.js and no longer calls the older server-rendered engine', () => {
    const script = readFileSync(scriptPath, 'utf8');
    expect(script.includes('setAvatar'), 'A.setAvatar is the blobatar stand-in this page must not use').toBe(false);
    expect(script.includes('FASwarm'), 'the retired insect engine is gone from this page').toBe(false);
    expect(script, 'bots.js is what paints this page now').toContain('FABots.mount');
  });

  it('the shell ships an EMPTY mount, never a data-avatar attribute', async () => {
    const shell = new JSDOM(await servedMarkup());
    try {
      const doc = shell.window.document;
      // A data-avatar in static markup is one of two defects: a fabricated
      // agent identity, or an empty attribute that polish.js's load-time
      // sweep paints nothing into. The mount exists; the attribute does not.
      const mounts = Array.from(doc.querySelectorAll('[data-avatar]'));
      expect(
        mounts.map((el) => el.getAttribute('data-avatar')),
        'the static shell declares a data-avatar before any DID is known',
      ).toEqual([]);
      expect(doc.getElementById('agent-avatar'), 'the .who strip carries no avatar host at all').not.toBeNull();
      expect(doc.getElementById('agent-avatar')!.classList.contains('av')).toBe(true);
    } finally {
      shell.window.close();
    }
  });

  it('after the agent read the mount carries the real DID and the bot the read served', async () => {
    const page = await renderHire(hirePath(), { token });
    try {
      const host = page.document.getElementById('agent-avatar')!;
      // The stored override, not the DID default: hire.js drew the spec it
      // was served.
      expect(botMount(host), 'the mount does not wear the spec the agent read served').toEqual(
        expectedMount(AGENT_DID, OVERRIDE),
      );

      // The identity strip states who, from the record, not from the markup.
      expect(page.document.getElementById('agent-name')!.textContent).toContain('hire-polished-scout');
      const operatorRow = page.document.getElementById('operated-by')!;
      expect(operatorRow.hidden, 'the operator line stayed hidden on a record that has one').toBe(false);
      expect(page.document.getElementById('operator-link')!.getAttribute('href')).toBe(
        `/accounts/${encodeURIComponent(OPERATOR_DID)}`,
      );
    } finally {
      page.close();
    }
  });

  // The opposite direction, which every no-empty-mount assertion above is
  // also satisfied by simply deleting the host: on a page state where no
  // agent was confirmed, the mount must still be unpainted AND unnamed.
  it.each([
    ['signed out', null as { token: string } | null, hirePath()],
    ['the agent read failed', { token: '' } as { token: string } | null, hirePath('did:abt:zNotRegisteredAtAll')],
  ])('%s: nothing is mounted and nothing is painted', async (_label, session, path) => {
    const page = await renderHire(path, session === null ? null : { token });
    try {
      const host = page.document.getElementById('agent-avatar')!;
      expect(host.getAttribute('data-avatar'), 'a DID was mounted for an agent this page never confirmed').toBeNull();
      expect(host.querySelector('canvas'), 'a bot was drawn for an agent this page never confirmed').toBeNull();
      expect(page.document.getElementById('hire-body')!.hidden, 'the form rendered without a confirmed agent').toBe(
        true,
      );
    } finally {
      page.close();
    }
  });
});

// ----------------------------------------------------------------- 3. the rail

describe('3. the five-step rail is a map, and none of its stages is a dead link', () => {
  it('step 1 is current, stages 2 to 5 carry no href, and .railnow carries the step in real text', async () => {
    const page = await renderHire(hirePath(), { token });
    try {
      const steps = Array.from(page.document.querySelectorAll('.steps li'));
      expect(steps.length, 'the rail is not the wireframe\u2019s five stages').toBe(5);
      expect(steps.map((li) => (li.textContent ?? '').replace(/\s+/g, ' ').trim())).toEqual([
        '1 Brief',
        '2 Agreement',
        '3 Deposit',
        '4 The work',
        '5 Pull request',
      ]);
      expect(steps[0]!.classList.contains('on'), 'step 1 is not marked current').toBe(true);
      expect(
        steps.slice(1).filter((li) => li.classList.contains('on')).length,
        'more than one stage claims to be current',
      ).toBe(0);

      // THE INERT-DECLARED-CONTROL ASSERTION. agreement, deposit, staged and
      // pullrequest are all built and mounted, and every one of them reads
      // ?job= and refuses without it. This page runs before any job exists,
      // so a stage rendered as an anchor would send a person to a page that
      // can only say "This address does not name a hire."
      const anchors = steps.flatMap((li) => Array.from(li.querySelectorAll('a')));
      expect(anchors.map((a) => a.getAttribute('href') ?? ''), 'a rail stage is a link to a page that can only refuse').toEqual(
        [],
      );

      // The rail collapses to rules under 640px and this line is what carries
      // the step then, including for a screen reader. Empty text there is the
      // collapse losing the information rather than restating it.
      const railnow = page.document.querySelector('.railnow');
      expect(railnow, 'no .railnow line beneath the rail').not.toBeNull();
      expect((railnow!.textContent ?? '').trim()).toBe('Step 1 of 5: the brief.');
    } finally {
      page.close();
    }
  });
});

// ---------------------------------------------------------- 4. no builder notes

describe('4. the wireframe\u2019s builder notes are not rendered as copy', () => {
  it('no element carries class "note", and no note prose appears in the built page', async () => {
    const wireframe = readFileSync(wireframePath, 'utf8');

    // Derived from the wireframe's own div.note block (lines 217 to 273):
    // the five-stages-five-URLs note, the draft note, the hash note, the fork
    // note, the outcomes note and the two "deliberately absent" notes. They
    // explain the design to a builder; rendering them would turn the page's
    // reasoning into its copy. Sentences under 40 characters are dropped as
    // too short to be distinctive.
    const noteSentences = [...wireframe.matchAll(/<div class="note">([\s\S]*?)<\/div>\s*$/gm), ...wireframe.matchAll(/<div class="note">([\s\S]*?)<script/g)]
      .map((m) => (m[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
      .flatMap((text) => text.split(/(?<=\.)\s+/))
      .map((s) => s.trim())
      .filter((s) => s.length >= 40);
    expect(
      noteSentences.length,
      'no note prose parsed out of the wireframe: the derivation is broken, not the page',
    ).toBeGreaterThan(5);

    const page = await renderHire(hirePath(), { token });
    try {
      expect(
        Array.from(page.document.querySelectorAll('.note')).length,
        'the built page renders an element with class "note"',
      ).toBe(0);

      const rendered = (page.document.body.textContent ?? '').replace(/\s+/g, ' ');
      const leaked = noteSentences.filter((s) => rendered.includes(s));
      expect(leaked, 'builder-note prose rendered as product copy').toEqual([]);
    } finally {
      page.close();
    }
  });

  it('invents no repository name, price, delivery date or criteria list', async () => {
    const page = await renderHire(hirePath(), { token });
    try {
      // The RENDERED MARKUP, not body.textContent. A placeholder is text a
      // person reads and textContent never contains it, so a sweep of the
      // text alone passes with a wireframe sample repository sitting in the
      // field as a suggestion. Found by planting exactly that: the mutation
      // ran green through this assertion until it read the markup instead.
      const markup = page.document.body.innerHTML;
      const rendered = (page.document.body.textContent ?? '').replace(/\s+/g, ' ');

      // The wireframe's four sample repositories and its sample brief. Every
      // one is a fact about a buyer this platform has never met.
      ['northline/design-tokens', 'northline/billing-api', 'northline/marketing-site', 'northline/internal-tools'].forEach(
        (sample) => {
          expect(rendered, `the wireframe\u2019s sample repository "${sample}" shipped as copy`).not.toContain(sample);
          expect(markup, `the wireframe\u2019s sample repository "${sample}" shipped in an attribute`).not.toContain(sample);
        },
      );
      expect(markup, 'the wireframe\u2019s sample brief shipped as a prefilled value').not.toContain(
        'Our design tokens are duplicated across three packages',
      );

      // Two controls, no others: the agent quotes price and delivery from the
      // brief, so a field for either here would be the buyer negotiating
      // against themselves before the agent has read anything.
      const fields = Array.from(page.document.querySelectorAll('#hire-form input, #hire-form textarea, #hire-form select'));
      expect(fields.map((el) => el.id).sort(), 'this page carries exactly two controls').toEqual(['brief', 'repo']);
      expect(
        Array.from(page.document.querySelectorAll('#hire-form select')).length,
        'a <select> here can only be populated with repositories nothing serves',
      ).toBe(0);

      // And neither control ships prefilled: a value in the box is a claim
      // about what this buyer wants, typed by us.
      expect((page.document.getElementById('repo') as HTMLInputElement).value, 'the repository field ships prefilled').toBe(
        '',
      );
      expect((page.document.getElementById('brief') as HTMLTextAreaElement).value, 'the brief ships prefilled').toBe('');
    } finally {
      page.close();
    }
  });
});

// ------------------------------------------------- 5. the guidance is not a fault

describe('5. a fired guard reddens the error, never the standing guidance', () => {
  // The brief's field carries a guidance hint ("Length is a guide, not a
  // gate") beside the character count. polish.css's .field.is-bad reddens
  // EVERY .hint in a field at once, so wiring this field to that pair would
  // paint the guidance as an error the moment someone blurred an empty box.
  // Measured on the shipped page: guidance --fg-3, error --bad.
  it('the empty-brief guard leaves the guidance line at its resting colour', async () => {
    const page = await renderHire(hirePath(), { token });
    try {
      const briefInput = page.document.getElementById('brief') as HTMLTextAreaElement;
      const repoInput = page.document.getElementById('repo') as HTMLInputElement;
      repoInput.value = 'buyer/target-repo';
      briefInput.value = '   ';
      (page.document.getElementById('btn-send') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const error = page.document.getElementById('brief-error')!;
      expect(error.hidden, 'the empty-brief guard did not speak').toBe(false);
      expect((error.textContent ?? '').trim()).toBe('Write what needs doing before sending.');

      // The mechanism, asserted rather than the colour (jsdom resolves no
      // cascade): the field never enters the state whose rule would repaint
      // the guidance, and the textarea does not opt into the blur validator
      // that sets it.
      expect(
        Array.from(page.document.querySelectorAll('.field.is-bad')).length,
        'the field entered .is-bad, which reddens the guidance hint too',
      ).toBe(0);
      expect(
        briefInput.hasAttribute('data-required'),
        'data-required hands this field to polish.js\u2019s blur validator, which sets .is-bad',
      ).toBe(false);
      expect(page.document.querySelector('.hint'), 'the guidance line is gone entirely').not.toBeNull();
    } finally {
      page.close();
    }
  });

  it('the character count is a guide: it states the budget and refuses nothing', async () => {
    const page = await renderHire(hirePath(), { token });
    try {
      const counter = page.document.getElementById('c-brief')!;
      expect((counter.textContent ?? '').trim(), 'polish.js\u2019s counter never ran').toBe('0 / 2000');

      // No maxlength: the page may not refuse a length that nothing behind it
      // refuses (createJob rejects an empty brief and nothing else).
      const briefInput = page.document.getElementById('brief') as HTMLTextAreaElement;
      expect(briefInput.hasAttribute('maxlength'), 'a cap the server does not apply').toBe(false);
    } finally {
      page.close();
    }
  });
});

// ------------------------------------------------------------- 6. the layout

// EVERY BROWSER-BACKED TEST BELOW CARRIES AN EXPLICIT TIMEOUT.
// vitest's default is 5000ms and RealBrowser.launch alone takes 1 to 4s on an
// idle machine. Run inside the full suite, or beside another seat's build,
// launch plus two navigations regularly passes 5s and the test fails with a
// timeout that says nothing about the page. Measured: the first mutation run
// of this file reported all six of these red on thirteen consecutive
// mutations, including mutations that cannot touch layout at all, which is
// what a timing dependency looks like from the outside. 30s is past every
// launch observed here and a genuinely broken layout still fails inside it.
const BROWSER_TIMEOUT_MS = 30_000;

describe('6. the page measures right at 1280 and at 320', () => {
  // Signed in, because the form is the page and it does not render otherwise.
  // A sweep of the signed-out state measures three controls and calls it
  // covered.
  async function signedIn(browser: RealBrowser, path = hirePath()): Promise<void> {
    await browser.goto(`${baseUrl}${path}`, 300);
    await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify({ token }))})`);
    await browser.goto(`${baseUrl}${path}`, 900);
  }

  const sweep = `
    (function () {
      // A link inside a sentence has a line-box hit area and WCAG 2.5.8
      // exempts it; padding it to 44px wrecks the paragraph. An inline
      // formatting context is bounded by block boxes, so the test is whether
      // the link's own parent holds real text beside it.
      function inSentence(a) {
        return [].some.call(a.parentElement.childNodes, function (n) {
          return n.nodeType === 3 && n.textContent.trim().length > 0;
        });
      }
      var all = [].filter.call(
        document.querySelectorAll('main button, main a[href], main input, main textarea, footer a'),
        function (el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      return {
        measured: all.map(function (el) { return el.id || el.className || el.tagName; }),
        under: all.filter(function (el) {
          var r = el.getBoundingClientRect();
          return (r.width < 44 || r.height < 44) && !(el.tagName === 'A' && inSentence(el));
        }).map(function (el) {
          var r = el.getBoundingClientRect();
          return (el.id || el.className || el.tagName) + ' ' +
                 Math.round(r.width * 10) / 10 + 'x' + Math.round(r.height * 10) / 10;
        })
      };
    })()
  `;

  it.each([
    [1280, 'desktop'],
    [320, 'mobile'],
  ])('every standalone control clears 44x44 at %ipx (%s)', async (width) => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: width as number, height: 1000 });
    try {
      await signedIn(browser);
      const form = await browser.evaluate<{ measured: string[]; under: string[] }>(sweep);
      expect(
        form.measured.length,
        'the signed-in state offered no control to measure: this sweep would pass vacuously',
      ).toBeGreaterThan(6);
      ['btn-send', 'repo', 'brief', 'back-to-profile', 'back-to-profile-bottom'].forEach((id) => {
        expect(form.measured, `${id} was not reached by the sweep`).toContain(id);
      });
      expect(form.under, `under the floor at ${width}px: ${JSON.stringify(form.under)}`).toEqual([]);

      // The signed-out state hides every one of those and shows its own
      // control. Measuring one state leaves the other unmeasured, which is
      // how a 32px button ships.
      await browser.goto(`${baseUrl}${hirePath()}`, 300);
      await browser.evaluate('sessionStorage.clear()');
      await browser.goto(`${baseUrl}${hirePath()}`, 900);
      const out = await browser.evaluate<{ measured: string[]; under: string[] }>(sweep);
      expect(out.measured, 'the signed-out state did not offer its sign-in control').toContain('signin-link');
      expect(out.under, `under the floor at ${width}px (signed out): ${JSON.stringify(out.under)}`).toEqual([]);
    } finally {
      await browser.close();
    }
  }, BROWSER_TIMEOUT_MS);

  it('320px: no horizontal overflow, and the rail hands the step to .railnow', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 320, height: 900 });
    try {
      await signedIn(browser);
      const metrics = await browser.evaluate<{
        scrollWidth: number;
        clientWidth: number;
        offenders: string[];
        stepFont: string;
        railnow: string;
        railnowText: string;
        textarea: number;
      }>(`
        (function () {
          var doc = document.documentElement;
          var offenders = [].filter.call(document.querySelectorAll('body *'), function (el) {
            return el.getBoundingClientRect().right > doc.clientWidth + 0.5;
          }).map(function (el) {
            return (el.id || el.className || el.tagName) + ' @' +
                   Math.round(el.getBoundingClientRect().right);
          });
          return {
            scrollWidth: doc.scrollWidth,
            clientWidth: doc.clientWidth,
            offenders: offenders.slice(0, 8),
            stepFont: getComputedStyle(document.querySelector('.steps li')).fontSize,
            railnow: getComputedStyle(document.querySelector('.railnow')).display,
            railnowText: document.querySelector('.railnow').textContent.trim(),
            textarea: Math.round(document.getElementById('brief').getBoundingClientRect().height)
          };
        })()
      `);
      expect(
        metrics.scrollWidth,
        `320px page scrolls sideways. offenders: ${JSON.stringify(metrics.offenders)}`,
      ).toBe(metrics.clientWidth);
      expect(metrics.offenders).toEqual([]);

      // The collapse and its replacement, as a pair. The rail going to
      // font-size 0 while .railnow stays hidden would drop the step silently.
      expect(metrics.stepFont, 'the rail did not collapse at 320px').toBe('0px');
      expect(metrics.railnow, 'the rail collapsed and nothing restated the step').toBe('block');
      expect(metrics.railnowText).toBe('Step 1 of 5: the brief.');

      // base.css's 44px floor sets `textarea.input { min-height: 44px }` at
      // this width. A page-local rule that loses to it collapses the brief
      // box to one line on every phone, which no assertion above can see.
      expect(metrics.textarea, 'the brief box collapsed to the tap-target floor').toBeGreaterThanOrEqual(150);
    } finally {
      await browser.close();
    }
  }, BROWSER_TIMEOUT_MS);

  // The gutter. `class="wrap section"` on one element is a tie base.css
  // resolves in .section's favour, zeroing .wrap's 32px horizontal padding,
  // and the 320px case hides it because base.css's own 420px rule comes
  // later and restores the padding. Measured before the fix: the pane came
  // back 1080 wide against the wireframe's 1016, flush to the viewport edge.
  it('1280px: the content column keeps the wireframe\u2019s gutter', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 1280, height: 1000 });
    try {
      await signedIn(browser);
      const geometry = await browser.evaluate<{ pane: number[]; who: number[]; h1Wins: string }>(`
        (function () {
          function box(sel) {
            var r = document.querySelector(sel).getBoundingClientRect();
            return [Math.round(r.width), Math.round(r.left)];
          }
          var h = document.querySelector('h1').getBoundingClientRect();
          return {
            pane: box('.pane'),
            who: box('.who'),
            h1Wins: document.elementsFromPoint(h.left + 6, h.top + 6)[0].tagName
          };
        })()
      `);
      expect(geometry.pane[0], 'the content column is not the wireframe\u2019s 1016px measure').toBe(1016);
      expect(geometry.pane[1], 'the column is not centred in the 1280px viewport').toBe(132);
      expect(geometry.who[0], 'the identity strip and the rail disagree about the measure').toBe(1016);

      // The visibility law, asked of the browser rather than read off a
      // z-index: nothing decorative may paint over the heading.
      expect(geometry.h1Wins, 'something is painted over the heading').toBe('H1');
    } finally {
      await browser.close();
    }
  }, BROWSER_TIMEOUT_MS);
});

// ------------------------------------------------------- 7. the reveal's end state

describe('7. the rail pane lands on visible content in both motion modes', () => {
  // The pane is a .reveal. Reduced motion does not mean "no animation ran",
  // it means the person sees a dignified static result, and the failure mode
  // is the pane sitting at its hidden start frame forever: the step rail
  // missing from the screen that tells a buyer where they are. So the
  // assertion under reduce is a pair that pulls against itself, nothing moved
  // AND the pane is still painted, because checking only the first passes a
  // rail that vanished.
  it.each([
    ['no-preference', true],
    ['reduce', false],
  ])('prefers-reduced-motion: %s', async (motion, expectJsReveal) => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 1280, height: 900 });
    try {
      await browser.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: motion }],
      });
      await browser.goto(`${baseUrl}${hirePath()}`, 300);
      await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify({ token }))})`);
      await browser.goto(`${baseUrl}${hirePath()}`, 500);

      // Polled to a deadline past the page's own 3s unconditional backstop
      // rather than settled once: a gate that only passes on an idle machine
      // is flaky, not green, and a genuinely stalled reveal is still stalled
      // when the deadline passes.
      const measured = await browser.evaluate<{
        matches: boolean;
        jsReveal: boolean;
        opacity: string;
        transform: string;
        box: [number, number];
        steps: number;
      }>(`
        (function () {
          var pane = document.querySelector('.pane.reveal');
          var deadline = Date.now() + 6000;
          return new Promise(function (resolve) {
            (function poll() {
              var cs = getComputedStyle(pane);
              var settled = parseFloat(cs.opacity) >= 0.99 &&
                (cs.transform === 'none' || cs.transform === 'matrix(1, 0, 0, 1, 0, 0)');
              if (settled || Date.now() > deadline) {
                var r = pane.getBoundingClientRect();
                resolve({
                  matches: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
                  jsReveal: document.documentElement.classList.contains('js-reveal'),
                  opacity: cs.opacity,
                  transform: cs.transform,
                  box: [Math.round(r.width), Math.round(r.height)],
                  steps: pane.querySelectorAll('.steps li').length
                });
              } else { setTimeout(poll, 100); }
            })();
          });
        })()
      `);

      // The emulation actually applied. Without this the reduce row silently
      // measures the no-preference branch and confirms it.
      expect(measured.matches, 'the reduced-motion emulation did not apply').toBe(motion === 'reduce');
      expect(measured.jsReveal, 'the hidden state is applied in the wrong motion mode').toBe(expectJsReveal);

      // Visible, in both modes, and still carrying its five stages.
      expect(parseFloat(measured.opacity), 'the rail pane settled invisible').toBeGreaterThanOrEqual(0.99);
      expect(['none', 'matrix(1, 0, 0, 1, 0, 0)'], 'the rail pane settled off its resting position').toContain(
        measured.transform,
      );
      expect(measured.box[0], 'the rail pane has no width').toBeGreaterThan(0);
      expect(measured.box[1], 'the rail pane has no height').toBeGreaterThan(0);
      expect(measured.steps, 'the pane settled visible and empty').toBe(5);
    } finally {
      await browser.close();
    }
  }, BROWSER_TIMEOUT_MS);
});
