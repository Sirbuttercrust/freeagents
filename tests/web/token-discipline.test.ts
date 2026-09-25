// DESIGN.md 2.1: "No screen may introduce a hex value." Every colour lives
// in the token table (src/web/public/css/tokens.css) or in a stylesheet's own
// documented token block (a custom property declared with a literal, such as
// market.css's --cat-* tints), and everything else paints with var(--token).
//
// Nothing enforced that on the site before the league look: a hex planted in
// league.css passed every gate, because verify_designmd.py reads only the
// wireframe tree's stylesheets. This reads the site's own sheets and every
// page's inline <style> and style="" attributes, with comments removed, and
// fails on any colour literal that is not a token's definition.
//
// It also holds the retirement: #7C7CFF, the old single accent, appears
// nowhere a browser would paint it.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const cssDir = join(here, '../../src/web/public/css');
const pagesDir = join(here, '../../src/web/pages');

const HEX = /#[0-9A-Fa-f]{3,8}\b/g;
const RGB = /\brgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/g;

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

// A literal is allowed in exactly two places: as the value of a custom
// property (that IS the token table, wherever a sheet keeps its block), and
// inside a mask, where #000 means "opaque" rather than a colour anyone sees.
//
// rgb()/rgba() is how a sheet writes a token at partial strength, which CSS
// custom properties cannot do on their own. So an rgb literal passes when it
// is a neutral (white or black at some alpha: a highlight or a shadow, not a
// hue) or exactly a declared token's colour. A hue that is no token is an
// invented colour and fails. Jade, the --check colour, fails even as its own
// token's rgb: DESIGN.md 2.2 allows it only beside a tick, so a sheet that
// wants it at partial strength uses --check-dim, and a raw jade literal is
// decoration by construction.
const JADE_RGB = '70,195,154';

function tokenRgbs(): Set<string> {
  const out = new Set<string>();
  for (const f of readdirSync(cssDir).filter((n) => n.endsWith('.css'))) {
    const src = stripComments(readFileSync(join(cssDir, f), 'utf8'));
    for (const m of src.matchAll(/--[\w-]+\s*:\s*#([0-9A-Fa-f]{6})\b/g)) {
      const h = m[1] ?? '000000';
      out.add([0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(','));
    }
  }
  return out;
}
const TOKENS = tokenRgbs();

function rgbAllowed(lit: string): boolean {
  const [r, g, b] = lit.replace(/^rgba?\(/, '').split(',').map((s) => parseInt(s, 10));
  const key = `${r},${g},${b}`;
  if (key === JADE_RGB) return false;
  if (r === g && g === b) return true;
  return TOKENS.has(key);
}

function offences(css: string, where: string): string[] {
  const out: string[] = [];
  const clean = stripComments(css);
  for (const decl of clean.split(/[;{}]/)) {
    const d = decl.trim().replace(/\s+/g, ' ');
    if (d === '') continue;
    if (/^--[\w-]+\s*:/.test(d)) continue;
    if (/^(-webkit-)?mask(-image)?\s*:/.test(d)) continue;
    for (const f of d.match(HEX) ?? []) out.push(`${where}: ${f} in "${d.slice(0, 80)}"`);
    for (const f of d.match(RGB) ?? []) {
      if (!rgbAllowed(f.replace(/\s+/g, ''))) out.push(`${where}: ${f} in "${d.slice(0, 80)}"`);
    }
  }
  return out;
}

function pageCss(html: string): string {
  const blocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  const attrs = [...html.matchAll(/\sstyle="([^"]*)"/g)].map((m) => `x{${m[1]}}`);
  return [...blocks, ...attrs].join('\n');
}

describe('no screen introduces a colour literal (DESIGN.md 2.1)', () => {
  const sheets = readdirSync(cssDir).filter((f) => f.endsWith('.css') && f !== 'tokens.css');
  const pages = readdirSync(pagesDir).filter((f) => f.endsWith('.html'));

  it('reads every stylesheet and every page', () => {
    expect(sheets).toContain('league.css');
    expect(sheets).toContain('office.css');
    expect(pages.length).toBeGreaterThan(20);
  });

  it('the shared stylesheets paint only with tokens', () => {
    const bad = sheets.flatMap((f) => offences(readFileSync(join(cssDir, f), 'utf8'), f));
    expect(bad).toEqual([]);
  });

  it('no page paints with a literal in its own <style> or style=""', () => {
    const bad = pages.flatMap((f) => offences(pageCss(readFileSync(join(pagesDir, f), 'utf8')), f));
    expect(bad).toEqual([]);
  });

  it('the retired accent #7C7CFF is painted nowhere, token blocks included', () => {
    const files = [
      ...readdirSync(cssDir).filter((f) => f.endsWith('.css')).map((f) => join(cssDir, f)),
      ...pages.map((f) => join(pagesDir, f)),
    ];
    const hits = files.filter((p) => /#7C7CFF|#9A9AFF|124,\s*124,\s*255/i.test(stripComments(readFileSync(p, 'utf8'))));
    expect(hits).toEqual([]);
  });
});
