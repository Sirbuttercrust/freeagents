// SCOPE1: the site says any work delivered as files, not software only.
//
// MISSION.md (PR #224): "work is any work delivered as files that land in a
// git repository (code, websites, documents, writing, designs, data)". The
// site spoke only to developers: five developer-discipline chips on browse, a
// "Language" group in its drawer, a search placeholder of code tasks, and
// "your code" in the promises about what the platform never touches.
//
// (a) re-implements the SCOPE1 card's reading rule in TypeScript, so the
// check lives in this repo rather than in an ops script: every visible line
// of every built page (text, and the placeholder, aria-label, title, alt and
// meta content attributes; comments, <script> and <style> removed,
// <template> content kept) and every string literal with a space in it in
// the page scripts (src/web/public/js, vendor/ excluded). A line naming the
// work as software fails unless it is one of the three allowed phrases,
// none of which is about the kind of work being hired.
//
// (b) to (d) pin the browse chips, the drawer and the landing "never" list.
// Each case fails on main at a261f35; the red run is in the PR body.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const pagesDir = join(root, 'src/web/pages');
const jsDir = join(root, 'src/web/public/js');

const WORDS =
  /\b(software|code|coding|codebase|coder|programm\w*|developers?|Frontend|Backend|Infrastructure|React components)\b/i;
const ALLOWED = ['source code', 'write custom code or trust ours', 'no code can justify'];
const ATTRS = /(?:placeholder|aria-label|title|alt|content)="([^"]*)"/g;
// One left-to-right pass that consumes comments and whole string literals,
// so the closing quote of one string never pairs with the opening quote of
// the next.
const JS_TOKENS =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;

function squash(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(' ');
}

// One textarea for every line: a JSDOM per line exhausts the worker's heap.
const decoder = new JSDOM('').window.document.createElement('textarea');
function unescapeHtml(s: string): string {
  if (!s.includes('&')) return s;
  decoder.innerHTML = s;
  return decoder.value;
}

function pageLines(path: string): string[] {
  let s = readFileSync(path, 'utf8');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  const out: string[] = [];
  for (const m of s.matchAll(ATTRS)) out.push(m[1] ?? '');
  const text = s.replace(/<[^>]+>/g, '\n');
  for (const t of text.split('\n')) out.push(unescapeHtml(t).trim());
  return out.filter((t) => t.trim()).map(squash);
}

function jsLines(path: string): string[] {
  const s = readFileSync(path, 'utf8');
  const out: string[] = [];
  for (const m of s.matchAll(JS_TOKENS)) {
    const lit = m[1] ?? m[2] ?? m[3];
    // Comments match with no group; single words are class names or keys.
    if (lit !== undefined && lit.includes(' ')) out.push(squash(lit));
  }
  return out;
}

function walkJs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'vendor') out.push(...walkJs(p));
    } else if (name.endsWith('.js')) {
      out.push(p);
    }
  }
  return out.sort();
}

function softwareOnlyHits(): { hits: string[]; pages: number; scripts: number } {
  const pages = readdirSync(pagesDir).filter((n) => n.endsWith('.html')).sort().map((n) => join(pagesDir, n));
  const scripts = walkJs(jsDir);
  const hits: string[] = [];
  const read: [string, (p: string) => string[]][] = [
    ...pages.map((p): [string, (p: string) => string[]] => [p, pageLines]),
    ...scripts.map((p): [string, (p: string) => string[]] => [p, jsLines]),
  ];
  for (const [path, reader] of read) {
    for (const line of reader(path)) {
      if (!WORDS.test(line)) continue;
      const low = line.toLowerCase();
      if (ALLOWED.some((a) => low.includes(a))) continue;
      hits.push(`${relative(root, path)}: ${line.slice(0, 160)}`);
    }
  }
  return { hits, pages: pages.length, scripts: scripts.length };
}

function page(name: string): Document {
  return new JSDOM(readFileSync(join(pagesDir, name), 'utf8')).window.document;
}

// The work kinds, taken from MISSION.md's own list. "code" is not a chip: the
// card's reading rule counts the word as software-only copy, and code work is
// still found by the search box, whose placeholder leads with a code task.
const KINDS = ['websites', 'documents', 'writing', 'designs', 'data'];

function catClassTable(): Record<string, string> {
  const src = readFileSync(join(jsDir, 'pcard.js'), 'utf8');
  const body = /var CAT_CLASS = \{([\s\S]*?)\};/.exec(src)?.[1] ?? '';
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(\w+):\s*"([\w-]+)"/g)) out[m[1] ?? ''] = m[2] ?? '';
  return out;
}

describe('SCOPE1: the site says any work delivered as files', () => {
  it('(a) no built page or page script says the work is software only', () => {
    const { hits, pages, scripts } = softwareOnlyHits();
    // An empty population is a broken reader, not a clean tree.
    expect(pages).toBeGreaterThan(20);
    expect(scripts).toBeGreaterThan(20);
    expect(hits).toEqual([]);
  });

  it('(a) the reader still catches the copy it exists to catch', () => {
    // Guards against the rule going vacuous: the old lines must still read as
    // hits when fed through the same test the tree is held to.
    for (const line of ['Change your code', 'Frontend', 'React components, Postgres migration, flaky tests']) {
      expect(WORDS.test(line)).toBe(true);
    }
    expect(jsLines(join(jsDir, 'pages/staged.js')).length).toBeGreaterThan(10);
  });

  it('(b) the browse chip row carries exactly the work kinds, each tinted by a class pcard.js knows', () => {
    const doc = page('browse.html');
    const chips = Array.from(doc.querySelectorAll('#chips .chip[data-skill]'));
    expect(chips.map((c) => c.getAttribute('data-skill'))).toEqual(KINDS);
    const table = catClassTable();
    const market = readFileSync(join(root, 'src/web/public/css/market.css'), 'utf8');
    for (const chip of chips) {
      const slug = chip.getAttribute('data-skill') ?? '';
      expect(chip.classList.contains('cat-chip'), `${slug} keeps .cat-chip`).toBe(true);
      expect(chip.getAttribute('aria-pressed')).toBe('false');
      const tint = table[slug];
      expect(tint, `pcard.js CAT_CLASS maps ${slug}`).toBeTruthy();
      expect(chip.classList.contains(tint ?? ''), `${slug} chip carries ${tint}`).toBe(true);
      expect(market).toMatch(new RegExp(`\\.${tint}\\s*\\{\\s*--cat:\\s*var\\(--cat-`));
      expect(chip.textContent?.trim().toLowerCase()).toBe(slug);
    }
    // The two controls that are not skills are untouched.
    expect(doc.getElementById('chip-has-hires')?.textContent?.trim()).toBe('Has verified hires');
    expect(doc.getElementById('more-filters-btn')?.textContent).toContain('More filters');
  });

  it('(c) the drawer has no "Language" group and no skill checkboxes; Evidence stays', () => {
    const doc = page('browse.html');
    const drawer = doc.getElementById('drawer');
    expect(drawer).toBeTruthy();
    const groups = Array.from(drawer?.querySelectorAll('h4') ?? []).map((h) => h.textContent?.trim());
    expect(groups).not.toContain('Language');
    expect(groups).toContain('Evidence');
    expect(drawer?.querySelectorAll('input[data-skill]').length).toBe(0);
    expect(doc.getElementById('ev-prior')).toBeTruthy();
    const script = readFileSync(join(jsDir, 'pages/browse.js'), 'utf8');
    expect(script).not.toMatch(/\.drawer input\[type=checkbox\]\[data-skill\]/);
  });

  it('(d) the landing "never" list keeps four items, the first about the buyer\u2019s repository', () => {
    const doc = page('landing.html');
    const items = Array.from(doc.querySelectorAll('#refuse li.never')).map((li) => squash(li.textContent ?? ''));
    expect(items).toHaveLength(4);
    // "repository" is a machine word the landing page keeps off (DESIGN.md
    // 1.3, landing-simple.test.ts), so the buyer's repository reads as
    // "your files" there.
    expect(items[0]).toBe('Change your files');
    expect(items[0]).not.toMatch(WORDS);
  });
});
