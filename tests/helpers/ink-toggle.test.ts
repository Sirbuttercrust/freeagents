// Pins for tests/helpers/ink-toggle.ts, measured in a real browser against
// createApp() the way the three diagram contrast walks start theirs.
//
//   (a) each half of the toggle changes the ink at once: right after
//       INKLESS_ON every diagram word is at alpha 0, right after INKLESS_OFF
//       every word reads the colour it had before, and after neither is a
//       colour transition running. Each half is read with no wait, because
//       the walk's reads come a fixed pause after the toggle and a busy
//       machine stretches that pause.
//   (b) no test file but the helper holds the transparent-ink declaration,
//       so a walk cannot grow a second, easing copy of the toggle.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { INKLESS_OFF, INKLESS_ON } from './ink-toggle.js';
import { RealBrowser, hasRealBrowser } from './real-browser.js';

const here = dirname(fileURLToPath(import.meta.url));
const testsDir = join(here, '..');
const T_MS = 60_000;

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function skipWithoutChrome(): boolean {
  if (hasRealBrowser()) return false;
  console.warn('no Chrome found for the ink toggle tests; skipping (see CHROME_BIN)');
  return true;
}

// One entry per element under [data-diagram] that holds a word of its own:
// where it is, what it says and the colour the browser computes for it now.
// The transitions list names every colour transition running anywhere on
// the page at the moment of the read.
interface Word { at: string; text: string; color: string }
interface Read { words: Word[]; running: string[] }
const READ = `
  (function () {
    var words = [];
    Array.prototype.forEach.call(document.querySelectorAll('[data-diagram] *'), function (e) {
      var own = Array.prototype.filter.call(e.childNodes, function (c) { return c.nodeType === 3 && /\\S/.test(c.nodeValue); })
        .map(function (c) { return c.nodeValue.trim().replace(/\\s+/g, ' '); }).join(' ');
      if (!own) return;
      words.push({ at: e.tagName.toLowerCase() + '.' + (e.getAttribute('class') || '').split(' ').join('.'), text: own.slice(0, 40), color: getComputedStyle(e).color });
    });
    var running = document.getAnimations().filter(function (a) { return a.transitionProperty === 'color'; })
      .map(function (a) { var t = a.effect.target; return t.tagName.toLowerCase() + '.' + (t.getAttribute('class') || '').split(' ').join('.'); });
    return { words: words, running: running };
  })()
`;
const read = (b: RealBrowser) => b.evaluate<Read>(READ);

// getComputedStyle().color is rgb(r, g, b) or rgba(r, g, b, a).
function alphaOf(color: string): number {
  const m = /^rgba?\(([^)]*)\)$/.exec(color);
  const parts = (m?.[1] ?? '').split(',').map((p) => p.trim());
  return parts.length === 4 ? Number(parts[3]) : 1;
}

// /how at the frozen moment where the proof rows have all arrived, scrolled
// to the first diagram, and left to settle so nothing is mid-ease before
// the toggle under test is the first thing that moves.
async function settledPage(width: number, height: number): Promise<RealBrowser> {
  const b = await RealBrowser.launch({ width, height });
  try {
    await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await b.goto(`${baseUrl}/how?t=8.2`, 600);
    expect(await b.evaluate<number>("document.querySelectorAll('[data-diagram]').length"), 'three diagrams to measure').toBe(3);
    await b.evaluate("window.scrollTo(0, document.querySelector('[data-diagram]').getBoundingClientRect().top + scrollY - 120)");
    await sleep(600);
    return b;
  } catch (e) {
    await b.close();
    throw e;
  }
}

const SIZES: Array<[number, number]> = [[1280, 800], [390, 844]];

describe('(a) the ink toggle changes the ink at once, with no colour transition running', () => {
  for (const [w, h] of SIZES) {
    it(`INKLESS_ON at ${w} x ${h}: right after it every diagram word is at alpha 0 and no colour transition runs`, async () => {
      if (skipWithoutChrome()) return;
      const b = await settledPage(w, h);
      try {
        const before = await read(b);
        expect(before.running, 'nothing is easing before the toggle').toEqual([]);
        expect(before.words.map((x) => alphaOf(x.color)), 'some words are inked before the toggle').not.toEqual(before.words.map(() => 0));

        await b.evaluate(INKLESS_ON);
        const after = await read(b);
        expect.soft(after.running, 'no colour transition is running right after INKLESS_ON').toEqual([]);
        expect.soft(after.words.map((x) => alphaOf(x.color)), 'every word is at alpha 0 right after INKLESS_ON')
          .toEqual(before.words.map(() => 0));
      } finally {
        await b.close();
      }
    }, T_MS);

    it(`INKLESS_OFF at ${w} x ${h}: right after it every diagram word reads its own colour again and no colour transition runs`, async () => {
      if (skipWithoutChrome()) return;
      const b = await settledPage(w, h);
      try {
        const before = await read(b);
        expect(before.running, 'nothing is easing before the toggle').toEqual([]);

        await b.evaluate(INKLESS_ON);
        await sleep(600);
        expect((await read(b)).running, 'the hidden state has settled before it is lifted').toEqual([]);

        await b.evaluate(INKLESS_OFF);
        const after = await read(b);
        expect.soft(after.running, 'no colour transition is running right after INKLESS_OFF').toEqual([]);
        expect.soft(after.words.map((x) => x.color), 'every word reads the colour it had before the toggle')
          .toEqual(before.words.map((x) => x.color));
        expect(await b.evaluate<number>("document.querySelectorAll('#dg-inkless').length"), 'the ink style is gone').toBe(0);
      } finally {
        await b.close();
      }
    }, T_MS);
  }
});

// ------------------------------------------------------------------ (b)
// The ease on a diagram word's colour is why the toggle lives in one place.
// A walk that carries its own copy of the transparent-ink declaration is a
// walk that can go back to the easing toggle without any pin noticing.
const TRANSPARENT_INK = /color\s*:\s*transparent\s*!\s*important/;
const HELPER = 'helpers/ink-toggle.ts';

function filesHoldingTheDeclaration(dir: string, except: string[]): string[] {
  const hits: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    const rel = relative(dir, full);
    if (except.includes(rel)) continue;
    if (TRANSPARENT_INK.test(readFileSync(full, 'utf8'))) hits.push(rel);
  }
  return hits.sort();
}

describe('(b) the transparent-ink declaration lives only in the shared toggle', () => {
  it('no file under tests/ but the shared toggle holds it', () => {
    expect(filesHoldingTheDeclaration(testsDir, [HELPER])).toEqual([]);
  });

  it('the shared toggle does hold it, so the check above is looking at the right thing', () => {
    expect(filesHoldingTheDeclaration(testsDir, [])).toEqual([HELPER]);
  });

  it('a copy planted in a scratch file is found', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'ink-toggle-scratch-'));
    try {
      const planted = ['*{color:', 'transparent!', 'important}'].join('');
      writeFileSync(join(scratch, 'walk.test.ts'), `const OWN_TOGGLE = '${planted}';\n`);
      writeFileSync(join(scratch, 'clean.test.ts'), "const fine = 'colour stays';\n");
      expect(filesHoldingTheDeclaration(scratch, [])).toEqual(['walk.test.ts']);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
