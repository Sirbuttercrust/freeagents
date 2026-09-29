// FIX-SW12c: two of the SW2 UI sweep's findings, pinned where they live.
//
// SW2-01: browse's disabled pager button (Previous on page 1) faded its
// --fg-2 ink with opacity .4 and painted about 2.2:1, under the 4.5 AA floor
// DESIGN.md 2.5 sets for anything that renders characters. The disabled
// state now steps the ink down to --fg-3 at full opacity.
//
// SW2-02: WebKit drew the owner roster's Sort select (#roster-sort) with its
// own native metrics, 214x26 on a coarse pointer, ignoring .input's
// min-height and padding. base.css now resets appearance on select.input
// and draws the chevron itself, so .input's box holds in every engine.
//
// The static reads (a) and (b) say the rule is written; the real-Chrome
// reads say it is in force after the whole cascade. The WebKit side of
// SW2-02 is proven by the sweep's own WebKit probe, which this suite does
// not carry (no WebKit driver is a dependency here).
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';
import { createApp } from '../../src/api/app.js';
import {
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
  MemoryAccountRepository,
} from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';

// A cold Chrome launch plus a navigation and a settle is well past vitest's
// 5000ms default under full-suite load; the same margin the other
// real-browser files use.
const BROWSER_TIMEOUT_MS = 30_000;

const here = dirname(fileURLToPath(import.meta.url));
const baseCss = readFileSync(join(here, '../../src/web/public/css/base.css'), 'utf8');

const OPERATOR_DID = 'did:abt:zSw12cOperator';
// Eleven agents: one more than browse's ten-per-page, so the pager draws
// with Previous disabled on page 1, and one more than the roster's
// above-ten threshold, so the owner's page draws its Sort control.
const AGENT_COUNT = 11;

function delegation(agentDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:sw12c-${agentDid}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: OPERATOR_DID,
    issuanceDate: '2026-09-29T00:00:00.000Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-09-29T00:00:00.000Z',
      verificationMethod: `${OPERATOR_DID}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zSw12cFixtureNotVerifiedHere',
    },
  };
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Every rule body whose selector list is exactly `selector`, in source
// order, with comments removed. A rule written twice is read twice.
function ruleBodies(css: string, selector: string): string[] {
  const clean = stripComments(css);
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    if ((m[1] ?? '').trim().replace(/\s+/g, ' ') === selector) out.push((m[2] ?? '').trim());
  }
  return out;
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const accountRepo = new MemoryAccountRepository();
  const agentRepo = new MemoryAgentRepository();
  await accountRepo.register({ did: OPERATOR_DID, githubLogin: 'sw12c-operator' });
  for (let i = 0; i < AGENT_COUNT; i += 1) {
    const did = `did:abt:zSw12cAgent${String(i).padStart(2, '0')}`;
    await agentRepo.create({
      did,
      operatorDid: OPERATOR_DID,
      delegation: delegation(did),
      name: `sw12c-agent-${i}`,
      skills: ['typescript'],
      githubLogin: null,
    });
  }
  server = createApp(
    accountRepo,
    agentRepo,
    undefined,
    undefined,
    new MemoryJobRepository(),
    undefined,
    undefined,
    new MemoryCredentialRepository(),
    // Two pages that each read every agent's detail for its avatar; the
    // default read budget is not what this file tests.
    { verify: 10_000, read: 10_000, write: 10_000, upstream: 10_000 },
  ).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ------------------------------------------------------------------ SW2-01

describe('SW2-01: the disabled pager button on /browse paints readable ink', () => {
  it('(a) the served page styles .pager button:disabled with --fg-3 and no fade', async () => {
    const html = await (await fetch(`${baseUrl}/browse`, { headers: { Accept: 'text/html' } })).text();
    const styles = Array.from(html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)).map((m) => m[1] ?? '').join('\n');
    const bodies = ruleBodies(styles, '.pager button:disabled');
    expect(bodies.length, 'no .pager button:disabled rule on the served page: the read would pass vacuously').toBeGreaterThan(0);
    const decls = bodies.flatMap((b) => b.split(';').map((d) => d.trim().replace(/\s+/g, ' ')).filter(Boolean));
    expect(decls).toContain('color: var(--fg-3)');
    const fades = decls.filter((d) => /^opacity\s*:/.test(d) && parseFloat(d.split(':')[1] ?? '1') < 1);
    expect(fades, 'the disabled pager button is faded with opacity').toEqual([]);
  });

  it.each([
    ['390', 390, 844],
    ['1280', 1280, 900],
  ] as const)('in real Chrome at %s the disabled Previous paints --fg-3 at full opacity, 4.5:1 or better on --bg-2', async (_label, width, height) => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width, height });
    try {
      await browser.goto(`${baseUrl}/browse`, 1200);
      const got = await browser.evaluate<{
        found: boolean;
        label: string;
        disabled: boolean;
        color: string;
        fg3: string;
        opacityChain: number;
        ratioOnBg2: number;
      }>(`
        (function () {
          var btn = Array.prototype.find.call(document.querySelectorAll('#pager button'), function (b) {
            return (b.textContent || '').trim() === 'Previous';
          });
          if (!btn) return { found: false, label: '', disabled: false, color: '', fg3: '', opacityChain: 0, ratioOnBg2: 0 };
          function rgbOf(value) {
            var probe = document.createElement('span');
            probe.style.color = value;
            document.body.appendChild(probe);
            var c = getComputedStyle(probe).color;
            probe.remove();
            return c;
          }
          function channels(c) { return c.match(/[\\d.]+/g).slice(0, 3).map(Number); }
          function lum(c) {
            var v = channels(c).map(function (x) { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
            return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
          }
          var chain = 1;
          for (var n = btn; n; n = n.parentElement) chain *= parseFloat(getComputedStyle(n).opacity);
          var color = getComputedStyle(btn).color;
          var bg2 = rgbOf('var(--bg-2)');
          var a = lum(color), b = lum(bg2);
          return {
            found: true,
            label: btn.textContent.trim(),
            disabled: btn.disabled,
            color: color,
            fg3: rgbOf('var(--fg-3)'),
            opacityChain: chain,
            ratioOnBg2: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100,
          };
        })()
      `);
      expect(got.found, 'no Previous button in #pager: the pager did not draw').toBe(true);
      expect(got.disabled).toBe(true);
      expect(got.color).toBe(got.fg3);
      expect(got.opacityChain).toBe(1);
      // --bg-2 is the lightest surface in the token table, so a pass here
      // is a pass on --bg and --bg-1 too.
      expect(got.ratioOnBg2).toBeGreaterThanOrEqual(4.5);
    } finally {
      await browser.close();
    }
  }, BROWSER_TIMEOUT_MS);
});

// ------------------------------------------------------------------ SW2-02

describe('SW2-02: a select.input keeps the .input box in every engine', () => {
  it('(b) base.css resets appearance on select.input, both spellings, with room on the right for its own chevron', () => {
    const bodies = ruleBodies(baseCss, 'select.input');
    expect(bodies.length, 'no select.input rule in base.css').toBe(1);
    const decls = (bodies[0] ?? '').split(';').map((d) => d.trim().replace(/\s+/g, ' ')).filter(Boolean);
    expect(decls).toContain('-webkit-appearance: none');
    expect(decls).toContain('appearance: none');
    const pad = decls.find((d) => d.startsWith('padding-right:'));
    expect(pad, 'no padding-right: the option text would run under the chevron').toBeDefined();
    expect(parseFloat((pad ?? '').split(':')[1] ?? '0')).toBeGreaterThanOrEqual(30);
    const image = decls.find((d) => d.startsWith('background-image:')) ?? '';
    expect(image, 'no drawn chevron: appearance none removes the native arrow').toMatch(/gradient/);
    // The chevron's ink is a token, never a literal (DESIGN.md 2.1).
    expect(image).toMatch(/var\(--fg-2\)/);
    expect(image).not.toMatch(/#[0-9A-Fa-f]{3,8}\b|rgba?\(/);
  });

  it('(c) in real Chrome at 390 with a coarse pointer, the owner page\'s Sort select is 44px tall and draws its chevron', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 390, height: 844 });
    try {
      // mobile + touch emulation is what makes (pointer: coarse) true; a
      // bare narrow window reports a fine pointer.
      await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      await browser.goto(`${baseUrl}/accounts/${encodeURIComponent(OPERATOR_DID)}`, 1200);
      const got = await browser.evaluate<{
        coarse: boolean;
        controlsShown: boolean;
        width: number;
        height: number;
        appearance: string;
        backgroundImage: string;
        paddingRight: number;
        docScrollWidth: number;
        docClientWidth: number;
      }>(`
        (function () {
          var sel = document.getElementById('roster-sort');
          var controls = document.getElementById('roster-controls');
          var r = sel.getBoundingClientRect();
          var cs = getComputedStyle(sel);
          return {
            coarse: window.matchMedia('(pointer: coarse)').matches,
            controlsShown: !!controls && !controls.hidden,
            width: r.width,
            height: r.height,
            appearance: cs.appearance || cs.webkitAppearance,
            backgroundImage: cs.backgroundImage,
            paddingRight: parseFloat(cs.paddingRight),
            docScrollWidth: document.documentElement.scrollWidth,
            docClientWidth: document.documentElement.clientWidth,
          };
        })()
      `);
      expect(got.coarse, 'the emulation did not produce a coarse pointer, so the measurement proves nothing').toBe(true);
      expect(got.controlsShown, 'the roster controls never showed: eleven agents should cross the threshold').toBe(true);
      expect(got.height).toBeGreaterThanOrEqual(44);
      expect(got.width).toBeGreaterThanOrEqual(44);
      expect(got.appearance).toBe('none');
      expect(got.backgroundImage).not.toBe('none');
      expect(got.backgroundImage).toMatch(/linear-gradient/);
      expect(got.paddingRight).toBeGreaterThanOrEqual(30);
      expect(got.docScrollWidth).toBe(got.docClientWidth);
    } finally {
      await browser.close();
    }
  }, BROWSER_TIMEOUT_MS);
});
