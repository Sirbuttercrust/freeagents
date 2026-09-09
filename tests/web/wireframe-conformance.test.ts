// Wireframe conformance.
//
// Written 2026-09-08 after review found that much of the designed work for the
// agent profile and other pages had never reached the built site.
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
    // The wireframe's tab-bar chip labels bake in one sample agent's own
    // counts (axiom-ui: 45/12/31/2). The built page's chips carry the SAME
    // labels with LIVE counts computed from GET /agents/:did at render time
    // (DESIGN.md invariant 5, "no invented numbers"), so the literal sample
    // digits can never appear in this page's static markup -- baking them in
    // would ship a fabricated number under a real agent's name. The chip
    // controls themselves (the "All", "Hires", "Prior", "Claims" buttons and
    // their live-count behaviour) are asserted in
    // tests/web/agent-cold-start.test.ts and tests/web/agent-work-history-tabs.test.ts.
    'All 45': 'sample count from the wireframe\u2019s one example agent; the built chip carries a live count instead (see reason on "All 45" above)',
    'Hires 12': 'same reason as "All 45": a live count, never the wireframe\u2019s sample digit',
    'Prior 31': 'same reason as "All 45": a live count, never the wireframe\u2019s sample digit',
    'Claims 2': 'same reason as "All 45": a live count, never the wireframe\u2019s sample digit',
    // Proof round 2, D1 (conformance-satisfied-by-dead-markup): these two
    // prior-work controls used to sit inside <template> elements that
    // nothing cloned, so removed conformance-agent-carries-every-control's
    // pass by neither a page change nor an honest absence. R-17's three
    // tiers share ONE item shape (VerifiedHireItem, agent-work-record.ts)
    // that carries no commit count or gist URL, because no prior-work item
    // has ever reached this route (ENT-11 not wired). Both controls are
    // removed until that type gains gistUrl/commitCount/lastCheckedAt
    // (handoff gap, this card).
    'gist proof': 'ENT-11 not wired: no prior-work item reaches this route yet, so there is no row for this control to sit on (see the removed tmpl-verify-prior in agent.html)',
    'Check the ownership proof': 'same reason as "gist proof": ENT-11 not wired, no prior-work row exists for this affordance yet',
  },
  browse: {
    // The brief's one authorised departure: nothing in the data carries a
    // line-count. CredentialEvidence (src/domain/agent-work-record.ts)
    // holds repository, pullRequest, mergedAt, mergeCommit, buyerDid,
    // repositoryPublic, additions, deletions, filesChanged -- no bucketed
    // "typical change size" a checkbox could filter on. These three are
    // checkbox <label> text, never matched by controls() (button/a only),
    // so this entry documents the omission rather than being load-bearing
    // for the test itself.
    'Under 200 lines': 'no diff-size bucket exists on CredentialEvidence (agent-work-record.ts); rendering the control would ship a filter that cannot filter (brief: "Typical change size" is the one authorised departure)',
    '200 to 1000': 'same reason as "Under 200 lines": no diff-size bucket in the data',
    'Over 1000': 'same reason as "Under 200 lines": no diff-size bucket in the data',
    // Wireframe sample values (SAMPLE's regex does not happen to cover
    // these two), never baked into the shipped page as fabricated agent
    // facts: pellucid and gridwright/tessellate/axiom-ui are the
    // wireframe's example agent names, rendered live from GET /agents
    // instead. A real agent named exactly "pellucid" would still render
    // fine; this entry is about the wireframe's SAMPLE row, not a ban.
    'pellucid': "wireframe sample data (an example agent's name); this page renders agent names live from GET /agents, never a hardcoded sample",
    'github.com/quietloop': 'wireframe sample data (an example GitHub proof link); the built proof line renders real data per card (DATA-CONTRACT section 4), never this sample URL',
    // The two zero-state relaxation buttons ship as real controls with
    // real re-queried counts (browse.js: relaxationButton); only the
    // wireframe's SAMPLE digits ("3 results", "12 results") can never
    // appear verbatim, because they are not this platform's real data.
    'Drop "verified hires" \u00b7 3 results': 'the control ships (browse.js renderZeroState); the sample count "3 results" is wireframe sample data, replaced with a real re-queried count',
    'Drop "Rust" \u00b7 12 results': 'the control ships (browse.js renderZeroState); the sample count "12 results" is wireframe sample data, replaced with a real re-queried count',
  },
  operator: {},
  job: {
    // The wireframe draws the closed-without-shipping state as a second
    // job on the same page. The built page shows ONE hire, and it already
    // has that state: close-section and the stopped track row (the same
    // call the agent page already made for "The same profile, brand new").
    'If the job does not ship': 'the wireframe draws this as a second example job on the same page; the built page shows one hire and already has this state (close-section, the stopped track row)',
    // The wireframe's two sample job identifiers. The heading renders the
    // real job id from the projection, pinned by a dedicated test, never
    // one of these baked-in sample ids.
    'Job fa-7k29': "wireframe sample data (the shipped example's job id); the built heading renders the job's real id from the projection",
    'Job ac-3m81': "wireframe sample data (the second example's job id); this page shows one hire, so this id never ships",
    // Both sample labels belong to the wireframe's second example job,
    // which does not ship as its own section (see the entry above). The
    // real page's identity strip renders the operator's own shortened DID,
    // and its one back control is "Back to profile", which does ship.
    'a different operator': 'wireframe sample data from the second example job, which does not ship as its own section; the real identity strip renders the operator\u2019s own shortened DID',
    "See tessellate's profile": 'wireframe sample data from the second example job, which does not ship as its own section',
  },
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
