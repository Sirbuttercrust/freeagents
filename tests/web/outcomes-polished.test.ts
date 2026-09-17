// W-outcomes: the polished visual system on /outcomes, gated.
//
// tests/web/outcomes.test.ts already pins this page's copy, structure, money
// lines and the five cards' parity. This file gates only what arrived when
// the page moved onto the polished stack: the stylesheets, the reveal, and
// the way both degrade.
//
// Everything here is measured in a real browser, because every claim in it
// is a claim about rendered behaviour. A jsdom assertion that a class is
// present is not evidence that motion happens, that reduced motion suppresses
// it, or that content survives with scripts off; jsdom performs no layout and
// runs no transition. That is the vacuous-gate defect this repo has already
// caught four times on other pages.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';

import { createApp } from '../../src/api/app.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const here = dirname(fileURLToPath(import.meta.url));
const builtPage = join(here, '../../src/web/pages/outcomes.html');
const wireframe = join(here, '../../spec/wireframe/outcomes.html');
const flowCss = join(here, '../../src/web/public/css/flow.css');

// Every structural assertion below runs against a PARSE, never against the
// markup string. Learned the hard way while writing this file: three
// assertions here were first written as string searches and all three went
// red against a correct page, because the page's own head comment explains
// the departure and therefore contains the literal text the searches looked
// for (`<style>`, `class="... reveal"`, `style="--i:0"`). A gate that
// reddens when a comment explains the rule it enforces is measuring comment
// formatting, not the page. Parsing puts comments where they belong, outside
// the element tree. The one exception is the last assertion in this file,
// which is deliberately about the comment text itself.
function parse(src: string): Document {
  const dom = new JSDOM(src);
  return dom.window.document;
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Reads every .oc card's opacity and transform. One string per card so a
// difference in either property shows up as a distinct entry.
const CARD_STATE = `
  Array.from(document.querySelectorAll('.oc')).map(function (el) {
    var cs = getComputedStyle(el);
    return cs.opacity + '|' + cs.transform;
  })
`;

// Counts cards the reader cannot actually see.
//
// This is deliberately NOT each card's own computed opacity, and the
// difference is a real defect this file caught in its own first draft. A
// mutation that put opacity:0 on the .outcomes CONTAINER hid all five cards
// from a reader and passed every gate here, because opacity composites down
// the tree rather than inheriting as a computed value: the cards still read
// "1" while being painted into a fully transparent layer.
//
// Measured in Chrome against this page, settled, one card sampled under three
// hiding mutations applied to its container:
//
//   mutation                 own opacity   checkVisibility
//   as served                1             true
//   ancestor opacity: 0      1             false
//   ancestor visibility:hidden 1           false
//   ancestor display: none   1             false
//
// checkVisibility is the only one of the three that sees all of them, so it
// is the instrument. The options are named explicitly because the defaults
// skip the opacity check, which is the exact vector that got through.
const INVISIBLE_CARDS = `
  Array.from(document.querySelectorAll('.oc')).filter(function (el) {
    return !el.checkVisibility({
      opacityProperty: true,
      visibilityProperty: true,
      contentVisibilityAuto: true
    });
  }).length
`;

describe('the polished stylesheets are linked, and this page owns no CSS of its own', () => {
  // The page's <style> block held 22 declaration lines duplicating rules
  // flow.css already ships. Linking the sheet and keeping the copy would mean
  // two sources for one look, which is the drift the sheet exists to prevent.
  // This gate is what stops the copy coming back: it fails if any rule this
  // page needs is re-declared locally.
  it('links tokens, base, polish and flow, in that order, and declares no local rules', () => {
    const doc = parse(readFileSync(builtPage, 'utf8'));
    const sheets = Array.from(doc.querySelectorAll('link[rel="stylesheet"]')).map((l) =>
      l.getAttribute('href'),
    );
    expect(sheets).toEqual(['/css/tokens.css', '/css/base.css', '/css/polish.css', '/css/flow.css']);
    expect(
      doc.querySelectorAll('style').length,
      'this page declares no <style> element; flow.css owns .outcomes, .oc and .fixed',
    ).toBe(0);
  });

  // The rules the deleted block held have to exist SOMEWHERE, or the deletion
  // was a regression wearing a tidy-up's clothes. Named individually, because
  // "flow.css is linked" does not prove flow.css still carries them.
  it('flow.css carries every selector the deleted local block declared', () => {
    const css = readFileSync(flowCss, 'utf8');
    for (const selector of [
      '.outcomes {',
      '.oc {',
      '.oc h3 {',
      '.oc dl {',
      '.oc dt {',
      '.oc dd {',
      '.oc dd b {',
      '.fixed {',
      '.fixed li {',
      '.fixed li:last-child {',
      '.fixed .k {',
      '.fixed .v {',
      '.fixed .para {',
    ]) {
      expect(css, `flow.css must still declare ${selector}`).toContain(selector);
    }
  });
});

describe('the reveal: it runs, and every way it can fail lands on visible content', () => {
  // The claim is "the cards start hidden and become visible", and the only
  // way to know is to watch. A sampler installed via
  // Page.addScriptToEvaluateOnNewDocument runs before any of the page's own
  // script, so frame 0 is captured before ui.js can add .js-reveal.
  it('the cards actually animate in, and all five move together at every frame', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for the reveal trace; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 1280, height: 1400 });
    try {
      await browser.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          window.__trace = [];
          var t0 = performance.now();
          (function frame() {
            var cards = Array.from(document.querySelectorAll('.oc'));
            if (cards.length) {
              window.__trace.push({
                lowest: Math.min.apply(null, cards.map(function (el) {
                  return Number(getComputedStyle(el).opacity);
                })),
                distinct: new Set(cards.map(function (el) {
                  var cs = getComputedStyle(el);
                  return cs.opacity + '|' + cs.transform;
                })).size
              });
            }
            if (performance.now() - t0 < 2500) requestAnimationFrame(frame);
          })();
        `,
      });
      await browser.goto(`${baseUrl}/outcomes`, 2600);
      const trace = await browser.evaluate<Array<{ lowest: number; distinct: number }>>(
        'window.__trace',
      );

      // A floor, not a measurement. 2.5 seconds of requestAnimationFrame is
      // ~150 frames on a healthy machine and this only needs enough samples
      // to span the 450ms transition; 20 is far below any plausible real
      // rate and exists to catch a sampler that never installed at all,
      // which would otherwise make every assertion below vacuously true.
      expect(trace.length, 'the sampler must have captured frames').toBeGreaterThan(20);

      // It is a reveal, not a decoration: some frame had a card at zero.
      // Without this, deleting the reveal class entirely would still pass
      // every other assertion in this file.
      expect(
        Math.min(...trace.map((f) => f.lowest)),
        'some frame must show a card fully hidden, or no reveal is happening at all',
      ).toBe(0);

      // And it ends visible. Asserted with checkVisibility rather than the
      // cards' own opacity, so a hiding rule on any ancestor is caught too.
      expect(trace[trace.length - 1]?.lowest, 'every card must finish fully visible').toBe(1);
      expect(
        await browser.evaluate<number>(INVISIBLE_CARDS),
        'no card may be left invisible to the reader once the reveal has run',
      ).toBe(0);

      // The five cards move as one. This is the motion-time counterpart to
      // outcomes.test.ts's "the five cards are identical in computed style,
      // in a real browser", which measures them at rest: a per-card
      // transition-delay would put them at different opacities mid-flight,
      // and a card that arrives on its own reads as a card being emphasised.
      // Zero is the assertion rather than a tolerance, because the number of
      // frames a machine samples varies and the number that may diverge does
      // not. Checked against the wireframe's --i:0..4: with those present a
      // large fraction of the entrance frames diverge and this goes red.
      const divergent = trace.filter((f) => f.distinct > 1);
      expect(
        divergent.length,
        'all five cards must share one opacity and transform at every frame of the reveal',
      ).toBe(0);
    } finally {
      await browser.close();
    }
  }, 60000);

  it('reduced motion: content is complete, js-reveal is never applied, nothing transitions', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for the reduced-motion check; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 1280, height: 1400 });
    try {
      await browser.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      await browser.goto(`${baseUrl}/outcomes`);
      const out = await browser.evaluate<{
        jsReveal: boolean;
        states: string[];
        durations: string[];
        visibleCards: number;
        invisibleCards: number;
      }>(`
        (function () {
          var cards = Array.from(document.querySelectorAll('.oc'));
          return {
            jsReveal: document.documentElement.classList.contains('js-reveal'),
            states: Array.from(new Set(${CARD_STATE})),
            durations: Array.from(new Set(cards.map(function (el) {
              return getComputedStyle(el).transitionDuration;
            }))),
            visibleCards: cards.filter(function (el) {
              return el.getBoundingClientRect().height > 0 &&
                     getComputedStyle(el).opacity === '1';
            }).length,
            invisibleCards: ${INVISIBLE_CARDS}
          };
        })()
      `);
      // ui.js returns before adding the class when reduce matches, so the
      // hidden state can never apply. This asserts the outcome, not the code
      // path: a future refactor that adds the class anyway fails here.
      expect(out.jsReveal, 'js-reveal must not be applied under reduced motion').toBe(false);
      expect(out.visibleCards, 'all five cards fully visible').toBe(5);
      expect(out.invisibleCards, 'nothing may hide a card from the reader').toBe(0);
      expect(out.states.length, 'all five cards in one identical state').toBe(1);
      expect(out.durations, 'no card transitions under reduced motion').toEqual(['0s']);
    } finally {
      await browser.close();
    }
  }, 60000);

  it('javascript disabled: the whole page is readable and every card is fully visible', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for the scripts-off check; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 1280, height: 1400 });
    try {
      // Disables script execution for the PAGE. Runtime.evaluate over the
      // protocol still runs, which is the only reason the measurement is
      // possible from inside a scripts-off page.
      await browser.send('Emulation.setScriptExecutionDisabled', { value: true });
      await browser.goto(`${baseUrl}/outcomes`);
      const out = await browser.evaluate<{
        jsReveal: boolean;
        states: string[];
        cards: number;
        headings: number;
        mainChars: number;
        noOverflow: boolean;
        invisibleCards: number;
      }>(`
        (function () {
          return {
            jsReveal: document.documentElement.classList.contains('js-reveal'),
            states: Array.from(new Set(${CARD_STATE})),
            cards: document.querySelectorAll('.oc').length,
            headings: document.querySelectorAll('main h1, main h2, main h3').length,
            mainChars: (document.querySelector('main').textContent || '')
              .replace(/\\s+/g, ' ').trim().length,
            noOverflow: document.documentElement.scrollWidth === document.documentElement.clientWidth,
            invisibleCards: ${INVISIBLE_CARDS}
          };
        })()
      `);
      expect(out.jsReveal, 'without script nothing can add js-reveal').toBe(false);
      expect(out.cards, 'all five endings render with no script at all').toBe(5);
      expect(out.headings, 'h1 plus the five card headings plus the two section headings').toBe(8);
      expect(out.states, 'every card at full opacity and no transform').toEqual(['1|none']);
      expect(out.invisibleCards, 'nothing may hide a card when scripts never run').toBe(0);
      // The disclosure is the point of this page, so "it renders" has to mean
      // the words are there, not that the boxes are.
      expect(out.mainChars, 'the full disclosure is present as text').toBeGreaterThan(3000);
      expect(out.noOverflow).toBe(true);
    } finally {
      await browser.close();
    }
  }, 60000);
});

describe('320px on a touch pointer, in both motion modes', () => {
  // outcomes.test.ts's own 320px test already checks this width, but with
  // mobile:false, so (pointer: coarse) does not match and the 44px floor in
  // base.css:541 and polish.css:567 never fires. That is the exact trap
  // polish.css:552-566 documents. This drives a real touch profile, so the
  // floor is under test rather than merely present, and does it in both
  // motion modes because reduced motion changes which rules apply.
  it.each(['no-preference', 'reduce'])(
    'motion=%s: no sideways scroll, both grids collapse, every control clears 44px',
    async (motion) => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for the 320px touch check; skipping (see CHROME_BIN)');
        return;
      }
      const browser = await RealBrowser.launch({ width: 320, height: 640 });
      try {
        await browser.send('Emulation.setDeviceMetricsOverride', {
          width: 320,
          height: 640,
          deviceScaleFactor: 2,
          mobile: true,
          screenOrientation: { angle: 0, type: 'portraitPrimary' },
        });
        await browser.send('Emulation.setTouchEmulationEnabled', {
          enabled: true,
          maxTouchPoints: 5,
        });
        await browser.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: motion }],
        });
        await browser.goto(`${baseUrl}/outcomes`, 1500);

        const out = await browser.evaluate<{
          coarse: boolean;
          scrollWidth: number;
          clientWidth: number;
          outcomesCols: number;
          fixedCols: number;
          under44: Array<{ what: string; w: number; h: number }>;
          hiddenCards: number;
          widest: { what: string; right: number } | null;
        }>(`
          (function () {
            var small = [];
            Array.from(document.querySelectorAll('a, button')).forEach(function (el) {
              var r = el.getBoundingClientRect();
              if (el.offsetParent === null && r.height === 0) return;
              if (r.height < 44 || r.width < 44) {
                small.push({
                  what: (el.id || el.className || el.tagName) + ':' +
                        (el.textContent || '').trim().slice(0, 24),
                  w: Math.round(r.width * 100) / 100,
                  h: Math.round(r.height * 100) / 100
                });
              }
            });
            // The widest element's right edge, so an overflow failure names
            // what overflowed instead of only reporting a number.
            var widest = null;
            Array.from(document.querySelectorAll('main *')).forEach(function (el) {
              var right = el.getBoundingClientRect().right;
              if (!widest || right > widest.right) {
                widest = { what: el.tagName + '.' + (el.className || ''), right: Math.round(right) };
              }
            });
            return {
              coarse: matchMedia('(pointer: coarse)').matches,
              scrollWidth: document.documentElement.scrollWidth,
              clientWidth: document.documentElement.clientWidth,
              outcomesCols: getComputedStyle(document.querySelector('.outcomes'))
                .gridTemplateColumns.split(' ').length,
              fixedCols: getComputedStyle(document.querySelector('.fixed li'))
                .gridTemplateColumns.split(' ').length,
              under44: small,
              hiddenCards: ${INVISIBLE_CARDS},
              widest: widest
            };
          })()
        `);

        // Without this the whole tap-target sweep below is vacuous.
        expect(out.coarse, 'the emulation must report a coarse pointer, or the 44px rules never fire').toBe(
          true,
        );
        expect(
          out.scrollWidth,
          `the 320px page must not scroll sideways; widest element ${JSON.stringify(out.widest)}`,
        ).toBe(out.clientWidth);
        expect(out.outcomesCols, '.outcomes collapses to one column under 760px').toBe(1);
        expect(out.fixedCols, '.fixed li collapses to one column under 420px').toBe(1);
        expect(out.under44, 'every link and button clears 44x44 on a touch pointer').toEqual([]);
        // Content, not motion, is the requirement: a card still mid-fade when
        // the reader arrives is fine, a card stuck hidden is not. goto's wait
        // is well past the 450ms transition and both motion modes settle.
        expect(out.hiddenCards, 'no card is left hidden at 320px in either motion mode').toBe(0);
      } finally {
        await browser.close();
      }
    },
    60000,
  );
});

describe('the wireframe still binds after the rebuild', () => {
  it('the built page ships every class the wireframe declares for the reveal', () => {
    const wire = parse(readFileSync(wireframe, 'utf8'));
    const built = parse(readFileSync(builtPage, 'utf8'));
    for (const doc of [wire, built]) {
      const box = doc.querySelector('.outcomes');
      expect(box, 'the card grid exists').toBeTruthy();
      expect(box?.classList.contains('stagger')).toBe(true);
      expect(box?.classList.contains('reveal')).toBe(true);
    }
    // The wireframe declares three reveal targets: the card grid and the two
    // .fixed lists. Counting them stops a later edit from dropping one
    // quietly, which no rendered check would notice since a non-revealing
    // element simply looks finished.
    expect(wire.querySelectorAll('.reveal').length).toBe(3);
    expect(built.querySelectorAll('.reveal').length).toBe(3);
    expect(built.querySelectorAll('.fixed.reveal').length, 'both clock and refusal lists').toBe(2);
  });

  it('the brand link keeps the wireframe accessible name', () => {
    const built = parse(readFileSync(builtPage, 'utf8'));
    expect(built.querySelector('.brand')?.getAttribute('aria-label')).toBe('FreeAgents home');
  });

  // The departure is deliberate and documented at the point of departure in
  // src/web/pages/outcomes.html. This pins BOTH halves so neither can drift
  // silently: the cards carry no --i, and the reason is still written down.
  it('no per-card --i ships, and the reason is recorded in the page', () => {
    const wire = parse(readFileSync(wireframe, 'utf8'));
    const built = parse(readFileSync(builtPage, 'utf8'));
    const staggerIndexed = (doc: Document) =>
      Array.from(doc.querySelectorAll('.oc')).filter((el) =>
        (el.getAttribute('style') ?? '').includes('--i'),
      ).length;
    expect(staggerIndexed(wire), 'the wireframe declares five').toBe(5);
    expect(
      staggerIndexed(built),
      'the built page ships none; see the departure comment above .outcomes',
    ).toBe(0);
    // Deliberately a string search, and the only one in this file: the
    // subject of this assertion IS the comment. A page that drops the --i
    // values without saying why is a silent departure, which is the thing
    // being prevented.
    expect(
      readFileSync(builtPage, 'utf8'),
      'the departure must stay explained where a reader of the markup will find it',
    ).toContain('THE ONE DEPARTURE FROM THE WIREFRAME');
  });
});
