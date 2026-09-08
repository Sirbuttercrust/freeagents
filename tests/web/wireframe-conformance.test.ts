// Wireframe conformance (Keaton, 2026-09-08: "I notice a lot of the work for
// agent profiles and other pages werent brough over. I worked with burnish a
// while ago on these.")
//
// The wireframes in spec/wireframe/ passed the design gate and are the
// binding source for every page under src/web/pages/. The pages built on
// 2026-08-31 were briefed on the data contract instead, and rendered fields
// where the wireframe had a designed page: no tab bar, no timeline, no
// discipline filters, no "What it works on". Nothing measured the gap, so it
// went out. This file is the measurement, and it is deliberately blunt: for
// every built page with a wireframe, every heading and every control label
// the wireframe carries must be present in the built page, unless the
// departure is listed below with a reason a reader can weigh.
//
// Text is compared after stripping tags, scripts, styles, comments, and the
// wireframe's own design notes (div.note), which explain the design and are
// not part of the page. A control is a <button> or an <a> with visible text.
// Sample data in the wireframe (an agent name, a repo#PR) is filtered by the
// SAMPLE list: those are values, not design.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const builtDir = join(here, '../../src/web/pages');
const wireDir = join(here, '../../spec/wireframe');

// Built page -> wireframe file, where the names differ. The landing page was
// built from the design seat's landing-swarm.html (kept outside the repo,
// see PLAN.md); spec/wireframe/index.html is the sitemap page, so landing is
// not compared here.
const WIREFRAME_FOR: Record<string, string | null> = {
  landing: null,
  'auth-callback-error': null,
  'auth-callback-success': null,
};

// Justified departures, per page, each with the reason. A heading or control
// listed here may be absent from the built page. Adding a line here is a
// design decision and belongs in the PR body.
const ALLOWED_ABSENT: Record<string, Record<string, string>> = {
  agent: {
    'The same profile, brand new': 'the cold-start variant is the same page with zero data, not a second section (R-18)',
  },
  browse: {},
  operator: {},
  job: {},
  dashboard: {},
  credential: {},
  incoming: {},
  myagents: {},
  signin: {},
  settings: {},
  verify: {},
};

// Sample values the wireframe uses to look real. Not design; never required.
// Anything carrying a dollar figure or a wireframe-only "Simulate" control is
// a value or a demo affordance, not a control the product ships.
const SAMPLE = /^(axiom-ui|gridwright|stylewright|a11y-sweep|northsound(\.dev)?|northline(\.dev)?|@northsound|pixelforge|driftcheck|tessellate|brightloop\/api|vercel\/commerce#\d+|acme\/[\w-]+#?\d*|northline\/design-tokens ?#?\d*|tailwindlabs\/headlessui|did:abt:[\w…]+|fa-[\w]+|job [0-9a-f]{6}|\d+ (Aug|Jul|Jan)|[A-Z][a-z]{2} \d{4}|Jan to Jul|Simulate:|.*\$\d)/;

// The signed-in navigation (My jobs, My agents, Dashboard, Settings, Sign
// out) is rendered by src/web/public/js/pages/nav.js into #nav-signed-in on
// every page, so the wireframe's static nav links are satisfied by the shared
// script rather than by each page's HTML. Asserted once, below, against nav.js.
const SHARED_NAV = new Set(['My jobs', 'My agents', 'Dashboard', 'Settings', 'Sign out', 'Sign in', 'Browse', 'List an agent', 'FreeAgents']);

function strip(htmlText: string): string {
  return htmlText
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<div class="note"[\s\S]*?<\/div>\s*<\/div>/g, '')
    .replace(/<div class="note"[\s\S]*?<\/div>/g, '');
}

function clean(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&rarr;|→/g, '').replace(/\s+/g, ' ').trim();
}

function headings(htmlText: string): string[] {
  return [...strip(htmlText).matchAll(/<(h1|h2|h3)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => clean(m[2] ?? '')).filter((h) => h.length > 0);
}

function controls(htmlText: string): string[] {
  return [...strip(htmlText).matchAll(/<(?:button|a)\b[^>]*>([\s\S]*?)<\/(?:button|a)>/g)]
    .map((m) => clean(m[1] ?? ''))
    .filter((c) => c.length > 1 && c.length < 60 && !SAMPLE.test(c) && !SHARED_NAV.has(c));
}

function visibleText(htmlText: string): string {
  return clean(strip(htmlText));
}

const builtPages = readdirSync(builtDir)
  .filter((f) => f.endsWith('.html'))
  .map((f) => f.slice(0, -5))
  .filter((name) => WIREFRAME_FOR[name] !== null);

describe('the shared navigation carries the wireframe nav', () => {
  it('nav.js renders every signed-in link the wireframes draw', () => {
    const nav = readFileSync(join(here, '../../src/web/public/js/pages/nav.js'), 'utf8');
    const missing = ['My jobs', 'My agents', 'Dashboard', 'Settings', 'Sign out'].filter((l) => !nav.includes(l));
    expect(missing, 'signed-in nav links absent from nav.js').toEqual([]);
  });
});

describe('every built page carries its wireframe', () => {
  it('found pages to compare', () => {
    expect(builtPages.length).toBeGreaterThan(10);
  });

  it.each(builtPages)('%s has a wireframe', (name) => {
    const wire = join(wireDir, `${WIREFRAME_FOR[name] ?? name}.html`);
    expect(existsSync(wire), `no wireframe for ${name}; add it to spec/wireframe or list it in WIREFRAME_FOR as null with a reason`).toBe(true);
  });

  it.each(builtPages)('%s carries every wireframe heading', (name) => {
    const wire = readFileSync(join(wireDir, `${WIREFRAME_FOR[name] ?? name}.html`), 'utf8');
    const built = visibleText(readFileSync(join(builtDir, `${name}.html`), 'utf8'));
    const allowed = ALLOWED_ABSENT[name] ?? {};
    const missing = headings(wire).filter((h) => !SAMPLE.test(h) && !built.includes(h) && !(h in allowed));
    expect(missing, `${name}: wireframe headings absent from the built page`).toEqual([]);
  });

  it.each(builtPages)('%s carries every wireframe control', (name) => {
    const wire = readFileSync(join(wireDir, `${WIREFRAME_FOR[name] ?? name}.html`), 'utf8');
    const built = visibleText(readFileSync(join(builtDir, `${name}.html`), 'utf8'));
    const allowed = ALLOWED_ABSENT[name] ?? {};
    const missing = [...new Set(controls(wire))].filter((c) => !built.includes(c) && !(c in allowed));
    expect(missing, `${name}: wireframe controls absent from the built page`).toEqual([]);
  });
});
