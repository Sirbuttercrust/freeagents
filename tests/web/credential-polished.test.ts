// W-credential: the receipt page rebuilt on spec/wireframe/credential.html's
// polished visual system.
//
// The conformance gate (tests/web/wireframe-conformance.test.ts) measures one
// thing about this page's clothes: that every stylesheet the wireframe loads
// is linked. It cannot see the script ORDER that decides whether the glyphs
// paint, an over-load of sheets this page has no components for, a copy
// control that carries the class without the subtree the class styles, or a
// glyph name that exists in the markup and not in the sprite. Every one of
// those passes that gate while shipping the wrong page. This file pins what
// this card changed, so a later card cannot quietly undo it.
//
// Populations are derived from the shipped files rather than typed here where
// that is possible, and every derivation FAILS LOUDLY on an empty result: a
// selector that stops matching would otherwise turn a real sweep into a green
// loop over nothing.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryCredentialRepository } from '../../src/adapters/storage/memory.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

const here = dirname(fileURLToPath(import.meta.url));
const builtPath = join(here, '../../src/web/pages/credential.html');
const iconsPath = join(here, '../../src/web/public/js/icons.js');

const AGENT_DID = 'did:abt:zWCredentialPolishedAgent';
const JOB_ID = 'w-credential-polished-job';

// Every optional field the page draws a row for is present, so the sweeps
// below meet the full control population. A document missing specHash hides
// one row (credential.js render, the specHash branch), which would make a six-control assertion
// pass with five shipped.
function credentialDoc(): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id: `https://freeagents.dev/v1/credentials/${JOB_ID}`,
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: 'did:abt:platform',
    validFrom: '2026-08-30T00:00:00.000Z',
    credentialSubject: {
      id: AGENT_DID,
      hire: {
        brief: 'sha256:w-credential-brief',
        repository: 'buyer/w-credential-polished-repo',
        pullRequest: 'https://github.com/buyer/w-credential-polished-repo/pull/9',
        mergedAt: '2026-08-20T00:00:00.000Z',
        mergeCommit: 'wcredentialpolishedcommit',
        signedBy: `${AGENT_DID}#key-1`,
        buyer: 'did:example:w-credential-polished-buyer',
        additions: 6,
        deletions: 2,
        filesChanged: 2,
        specHash: 'sha256:w-credential-spec',
      },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zw-credential-polished-proof' },
  };
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const credentialRepo = new MemoryCredentialRepository();
  await credentialRepo.save({
    completedJobId: JOB_ID,
    subjectDid: AGENT_DID,
    document: credentialDoc(),
    repositoryPublic: true,
  });
  server = createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, credentialRepo).listen(
    0,
    '127.0.0.1',
  );
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function servedMarkup(path: string): Promise<string> {
  const res = await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } });
  expect(res.status, `unexpected status for ${path}`).toBe(200);
  return res.text();
}

interface Rendered {
  document: Document;
  openDisclosures: () => number;
  close: () => void;
}

// The page with its own scripts run for real, the instrument
// tests/web/credential-wireframe.test.ts already uses. jsdom performs no
// layout, so nothing here reads a size; the sizes in this file's comments
// were measured in headless Chrome and are quoted, never asserted.
async function renderCredential(path: string, markupOverride?: string): Promise<Rendered> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  const markup = markupOverride ?? (await servedMarkup(path));
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
  await new Promise((resolve) => setTimeout(resolve, 300));

  if (failures.length > 0) throw new Error(`page script failed on ${path}: ${failures.join('; ')}`);

  const document = dom.window.document;
  return {
    document,
    // Every copy control on this page lives behind a disclosure. A sweep that
    // never opens one reports a clean page in both the broken and the fixed
    // state, so the count is returned and asserted by each caller.
    openDisclosures: () => {
      const triggers = Array.from(document.querySelectorAll('[data-disclose]'));
      triggers.forEach((btn) => (btn as HTMLElement).click());
      return triggers.length;
    },
    close: () => dom.window.close(),
  };
}

function linkedSheets(markup: string): string[] {
  return [...markup.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map(
    (m) => ((m[1] ?? '').split('/').pop() ?? '').trim(),
  );
}

function loadedScripts(markup: string): string[] {
  return [...markup.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => (m[1] ?? '').trim());
}

const CREDENTIAL_PATH = `/v1/credentials/${JOB_ID}`;

// ---------------------------------------------------------------- 1. the stack

describe('1. the page wears the polished system, and only the sheets it uses', () => {
  it('links tokens.css, base.css and polish.css, and none of the page sheets it has no components for', async () => {
    const sheets = linkedSheets(await servedMarkup(CREDENTIAL_PATH));

    // The presence half, which is the assertion the conformance gate makes,
    // restated here so this file fails on its own if the sheet is dropped.
    expect(sheets, 'the polished layer must be linked').toContain('polish.css');
    expect(sheets).toContain('tokens.css');
    expect(sheets).toContain('base.css');

    // The absence half, which the conformance gate does NOT make: it checks
    // only that the wireframe's sheets are present, so an over-load passes it
    // silently. The wireframe names base.css and polish.css and nothing else.
    // market.css is the marketplace card, gallery.css the portfolio grid,
    // agreement.css the signature matrix, pipeline.css the flow rail. This
    // page draws none of them.
    const overLoaded = ['market.css', 'gallery.css', 'agreement.css', 'landing.css', 'pipeline.css'].filter((s) =>
      sheets.includes(s),
    );
    expect(overLoaded, 'stylesheets loaded by a page that uses none of their components').toEqual([]);
  });

  it('loads icons.js before polish.js, and does not load the avatar engine', async () => {
    const scripts = loadedScripts(await servedMarkup(CREDENTIAL_PATH));

    // THE DEPENDENCY FIRST, and the whole list second. Asserted in this order
    // deliberately: a list compared by equality catches an ordering swap but
    // reports it as a six-line array diff, leaving the reader to work out
    // which of the two orders is correct and why. This assertion fails first
    // and says it. polish.js's init calls FAIcon.paint() (polish.js:554-555)
    // and icons.js is what defines FAIcon, so the declared order is the one
    // that states that dependency.
    //
    // It pins the dependency, not a failure anyone can see today. icons.js
    // registers its own DOMContentLoaded paint at load (icons.js:127-131), so
    // the hosts are already painted when init runs: served with the two tags
    // reversed, 12 of 12 [data-ico] hosts painted, and with both paint entry
    // points removed, 0 of 12, which is the control that says the count can
    // read zero. The self-paint that makes a reversal harmless lives in
    // icons.js and nothing here owns it.
    const icons = scripts.indexOf('/js/icons.js');
    const polish = scripts.indexOf('/js/polish.js');
    expect(icons, '/js/icons.js is not loaded').toBeGreaterThanOrEqual(0);
    expect(polish, '/js/polish.js is not loaded').toBeGreaterThanOrEqual(0);
    expect(icons, 'polish.js calls FAIcon.paint() and would run before icons.js defines it').toBeLessThan(polish);

    expect(scripts).toEqual([
      '/js/pages/api.js',
      '/js/pages/nav.js',
      '/js/office.js',
      '/js/icons.js',
      '/js/polish.js',
      '/js/pages/credential.js',
      '/js/pages/ui.js',
    ]);

    // swarm.js paints [data-avatar] hosts. This wireframe declares none, not
    // even a nav account menu, because the page is public and has no signed
    // in chrome, so loading the engine would ship a module with nothing to
    // do. Parsed, not grepped: a grep cannot tell an attribute on an element
    // from the word in a comment.
    expect(scripts.some((s) => s.includes('swarm.js'))).toBe(false);
    const shell = new JSDOM(readFileSync(builtPath, 'utf8'));
    try {
      expect(Array.from(shell.window.document.querySelectorAll('[data-avatar]')).length).toBe(0);
    } finally {
      shell.window.close();
    }
  });
});

// ----------------------------------------------------------- 2. the copy buttons

describe('2. every copy control carries the wireframe\u2019s glyph structure', () => {
  // The structure is what polish.css styles. Without .copybtn the .icoslot is
  // not positioned, so both glyphs fall into the flow side by side with the
  // tick at full opacity beside the copy glyph instead of stacked under it.
  // Without the .icoslot the absolute rules still resolve, against the button
  // itself (.copybtn is position:relative, polish.css:301), but nothing is
  // left in the flow holding the glyphs' 13x13 cell and the label slides into
  // it: measured at 320 under touch emulation with the slot removed from one
  // control, that label sits 15px from the button's left edge instead of
  // 34px and the button narrows from 83.23px to 64.23px, while the five
  // untouched controls beside it hold 83.23x44. Without .ico-copy and
  // .ico-done there is nothing to cross-fade; without the .lbl the label is
  // the button's own text node, which is exactly what ui.js:73's guard
  // protects. Any one of the five missing is a control that looks right in a
  // static screenshot and reports nothing when pressed.
  const wrongStructure = (controls: Element[]): string[] =>
    controls
      .filter((el) => {
        const slot = el.querySelector('.icoslot');
        return (
          !el.classList.contains('copybtn') ||
          slot === null ||
          slot.querySelector('.ico.ico-copy') === null ||
          slot.querySelector('.ico.ico-done') === null ||
          el.querySelector('.lbl') === null
        );
      })
      .map((el) => el.id || el.className);

  it('every [data-copy] is a .copybtn with an .icoslot holding both ico-copy and ico-done, six of them', async () => {
    const page = await renderCredential(CREDENTIAL_PATH);
    try {
      expect(page.openDisclosures(), 'the sweep opened no disclosure: every copy control lives behind one').toBe(3);

      // Six, not the wireframe's four. The wireframe draws three identities
      // plus one agreement fingerprint; this page draws four identities (it
      // adds the key that signed the merge commit) and two fingerprints
      // (brief and criteria), which is its existing data wiring.
      const controls = Array.from(page.document.querySelectorAll('[data-copy]'));
      expect(controls.length, 'no [data-copy] control on the page: this sweep would pass vacuously').toBe(6);

      expect(wrongStructure(controls), 'copy controls without the copybtn/icoslot/ico/lbl structure').toEqual([]);
    } finally {
      page.close();
    }
  });

  // MUTATION CONTROL. A test that cannot fail is not evidence. The class is
  // stripped from one shipped button and the same assertion is required to
  // name that button, which proves the sweep discriminates rather than
  // reporting green over a population it never really inspected.
  it('fails, naming the button, when the copybtn class is stripped from one control', async () => {
    const markup = await servedMarkup(CREDENTIAL_PATH);
    const broken = markup.replace(
      '<button class="btn btn-sm copybtn" type="button" id="id-issuer-copy"',
      '<button class="btn btn-sm" type="button" id="id-issuer-copy"',
    );
    expect(broken, 'the mutation did not apply: the markup shape it edits has changed').not.toBe(markup);

    const page = await renderCredential(CREDENTIAL_PATH, broken);
    try {
      page.openDisclosures();
      const controls = Array.from(page.document.querySelectorAll('[data-copy]'));
      expect(controls.length, 'the mutation changed the control population, not just one class').toBe(6);
      expect(wrongStructure(controls)).toEqual(['id-issuer-copy']);
    } finally {
      page.close();
    }
  });

  // A correct structure still paints nothing if the glyph name does not exist
  // in the sprite, and nothing throws when it does not: the unknown name
  // returns null out of svg() (icons.js:102) and paint() then appends nothing
  // (icons.js:121), so the neighbouring word carries on. Nothing moves
  // either, which is what makes the failure invisible in a screenshot. The
  // host keeps its box from .ico-sm (polish.css:56): repainted at 320 with
  // one host's data-ico set to a name the sprite does not carry, that host
  // measured 13x13 empty and its button held 83.23x44, unchanged from before
  // the swap and identical to the five controls beside it. So the vocabulary
  // is read out of the shipped file, and a name removed from icons.js fails
  // this rather than silently painting nothing.
  it('every data-ico on the page names a glyph that exists, and every host is painted', async () => {
    const glyphs = new Set(
      [...readFileSync(iconsPath, 'utf8').matchAll(/^\s+"([a-z0-9-]+)":/gm)].map((m) => m[1] ?? ''),
    );
    expect(glyphs.size, 'no glyph names parsed out of icons.js: the derivation is broken').toBeGreaterThan(10);

    const page = await renderCredential(CREDENTIAL_PATH);
    try {
      page.openDisclosures();
      const hosts = Array.from(page.document.querySelectorAll('[data-ico]'));
      expect(hosts.length, 'no [data-ico] host on the page: this sweep would pass vacuously').toBe(12);

      const unknown = hosts.map((el) => el.getAttribute('data-ico') ?? '').filter((name) => !glyphs.has(name));
      expect(unknown, 'data-ico names with no glyph in icons.js (these paint nothing, silently)').toEqual([]);

      const unpainted = hosts
        .filter((el) => el.querySelector('svg') === null)
        .map((el) => el.getAttribute('data-ico') ?? '');
      expect(unpainted, 'data-ico hosts with no painted svg child').toEqual([]);
    } finally {
      page.close();
    }
  });

  // ui.js swapped btn.textContent to "Copied" and back on every [data-copy].
  // On a .copybtn that replaces the whole subtree: the .icoslot, both glyphs
  // and the .lbl are destroyed on the first press and the restore puts back a
  // bare word, permanently. ui.js:73 carries the guard that stops it, and the
  // guard was dormant on this page until this card put the class on a button
  // here. Invisible in a screenshot of a page nobody has clicked.
  it('a pressed copy button keeps its glyphs and its label, and reports the press', async () => {
    const page = await renderCredential(CREDENTIAL_PATH);
    try {
      page.openDisclosures();
      const btn = page.document.getElementById('id-agent-copy')!;
      const shape = () => ({
        glyphs: btn.querySelectorAll('[data-ico]').length,
        painted: btn.querySelectorAll('.icoslot svg').length,
        label: (btn.querySelector('.lbl')?.textContent ?? '').trim(),
      });

      expect(shape()).toEqual({ glyphs: 2, painted: 2, label: 'Copy' });
      (btn as HTMLElement).click();
      expect(shape(), 'the press destroyed the button\u2019s own icon and label').toEqual({
        glyphs: 2,
        painted: 2,
        label: 'Copy',
      });
      // polish.js's copyMorph is what reports the result on a .copybtn, and
      // it can only do that if the glyphs it cross-fades are still there.
      expect(btn.classList.contains('is-done'), 'the copy button reported nothing back').toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(shape(), 'the restore timer left a bare word where the icon was').toEqual({
        glyphs: 2,
        painted: 2,
        label: 'Copy',
      });
      expect(btn.classList.contains('is-done')).toBe(false);
    } finally {
      page.close();
    }
  });
});

// --------------------------------------------------- 3. the ids the script needs

describe('3. the polished markup did not move what credential.js reaches for', () => {
  // credential.js's setPair finds each control as id + "-copy" and
  // either sets data-copy on it or hides it. Both operations are on the
  // button element, so the polished subtree survives them, and the polish card
  // edited no line of that file. Asserted rather than assumed: renaming an id
  // to match a new class vocabulary is the obvious next tidy-up and it would
  // silently unwire every value on the page.
  it('fills every copy control from the signed document, none left empty', async () => {
    const page = await renderCredential(CREDENTIAL_PATH);
    try {
      page.openDisclosures();

      const reachable = (node: Element): boolean => {
        for (let el: Element | null = node; el; el = el.parentElement) {
          if ((el as HTMLElement).hidden) return false;
        }
        return true;
      };
      const live = Array.from(page.document.querySelectorAll('[data-copy]')).filter(reachable);
      expect(live.length, 'no reachable copy control: this sweep would pass vacuously').toBe(6);

      const dead = live.filter((el) => (el.getAttribute('data-copy') ?? '') === '').map((el) => el.id);
      expect(dead, 'reachable copy controls with nothing to copy (inert-declared-control)').toEqual([]);

      // And the value is the one beside it, not some other row's: a control
      // wired to the wrong sibling copies the wrong identifier, which is
      // worse on a page of identifiers than copying nothing.
      const mismatched = Array.from(page.document.querySelectorAll('.kv'))
        .map((row) => {
          const shown = (row.querySelector('dd')?.textContent ?? '').trim();
          const btn = row.querySelector('[data-copy]');
          if (btn === null) return null;
          const value = btn.getAttribute('data-copy') ?? '';
          return shown === value ? null : `${btn.id}: shown=${JSON.stringify(shown)} copies=${JSON.stringify(value)}`;
        })
        .filter((row): row is string => row !== null);
      expect(mismatched, 'a copy control carrying something other than the value beside it').toEqual([]);
    } finally {
      page.close();
    }
  });

  // The absent-value path. specHash is absent on a job completed without a
  // confirmed spec (R-35), and credential.js hides that whole row rather than
  // printing an empty hash. The polished button must disappear with it: a
  // control that paints, clears the tap floor, says "Copy" and copies nothing
  // is the inert-declared-control defect, and adding a subtree to the button
  // is exactly the change that could leave it visible.
  it('hides the criteria control, subtree and all, when the document carries no specHash', async () => {
    const withoutSpec = credentialDoc();
    delete (withoutSpec.credentialSubject.hire as { specHash?: string }).specHash;

    const repo = new MemoryCredentialRepository();
    await repo.save({
      completedJobId: 'no-spec-hash-job',
      subjectDid: AGENT_DID,
      document: { ...withoutSpec, id: 'https://freeagents.dev/v1/credentials/no-spec-hash-job' },
      repositoryPublic: true,
    });
    const altServer = createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, repo).listen(
      0,
      '127.0.0.1',
    );
    await new Promise<void>((resolve) => altServer.once('listening', resolve));
    const altPort = (altServer.address() as AddressInfo).port;

    try {
      const res = await fetch(`http://127.0.0.1:${altPort}/v1/credentials/no-spec-hash-job`, {
        headers: { Accept: HTML },
      });
      expect(res.status).toBe(200);
      const dom = new JSDOM(await res.text(), {
        url: `http://127.0.0.1:${altPort}/v1/credentials/no-spec-hash-job`,
        runScripts: 'dangerously',
        resources: 'usable',
        pretendToBeVisual: true,
        beforeParse(window) {
          Object.defineProperty(window, 'fetch', {
            writable: true,
            value: (input: string, init?: RequestInit) =>
              fetch(new URL(input, `http://127.0.0.1:${altPort}`), init),
          });
        },
      });
      await new Promise<void>((resolve) => {
        if (dom.window.document.readyState === 'complete') resolve();
        else dom.window.addEventListener('load', () => resolve());
      });
      await new Promise((resolve) => setTimeout(resolve, 300));

      try {
        const doc = dom.window.document;
        // POSITIVE CONTROL. The receipt has to have loaded, or "the row is
        // hidden" is true of a page that rendered nothing.
        expect(doc.getElementById('facts')!.hidden, 'no receipt loaded: this assertion would be vacuous').toBe(false);
        expect(doc.getElementById('agreed-spec-wrap')!.hidden, 'the criteria row survived a document with no specHash').toBe(
          true,
        );
        expect(
          (doc.getElementById('agreed-brief-copy') as HTMLElement).hidden,
          'the brief fingerprint went away with the criteria row',
        ).toBe(false);
      } finally {
        dom.window.close();
      }
    } finally {
      await new Promise<void>((resolve) => altServer.close(() => resolve()));
    }
  });
});
