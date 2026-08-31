// What the not-found pages actually RENDER, with the real scripts running
// against the real API.
//
// WHY THIS FILE EXISTS. static.test.ts asserts that /agents/<unknown-did>
// is SERVED, and every one of its assertions is server-side. That is why it
// passed while both failure pages painted controls pointing nowhere: a page
// can return 200 with correct headers and still tell a visitor something
// untrue. So this file loads pages, runs their scripts, and asserts what a
// visitor is left looking at.
//
// WHAT jsdom CAN AND CANNOT SETTLE, measured rather than assumed.
//
// The defect being pinned is that `hidden` is only a UA-stylesheet
// `display: none` and loses to any author rule that sets `display`. The fix
// is one rule, `[hidden] { display: none !important; }`. Checking that fix
// through getComputedStyle needs an engine that implements !important
// precedence, and jsdom does not:
//
//   .row{display:flex} [hidden]{display:none!important}  -> none  (agrees)
//   [hidden]{display:none!important} .row{display:flex}  -> flex  (wrong)
//
// A browser answers `none` to both: !important wins regardless of order.
// So jsdom's computed display here is right only by accident of rule
// order, and an assertion resting on it would pass for the wrong reason
// and break on an unrelated reshuffle of the stylesheet.
//
// Visibility is therefore pinned through the two things that jointly
// produce it, each checked with an instrument that can genuinely fail:
//
//   1. the ELEMENT is marked hidden on the failure path  (`el.hidden`,
//      which jsdom reflects correctly), and
//   2. the GUARD RULE is present and important in the stylesheet the page
//      actually loaded (read back through the CSSOM, so it has to have
//      parsed, not merely be present as text).
//
// Real-browser confirmation belongs with the measurement sweep, which is
// where this repository already keeps anything about rendered pixels.
//
// Every assertion below was run against the pre-fix tree and observed to
// fail. A test for a defect that has never been red is a test nobody has
// checked.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import {
  MemoryAgentRepository,
  MemoryOperatorRepository,
} from '../../src/adapters/storage/memory.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  // Deliberately EMPTY repositories. Every record below is one that does
  // not exist, which is the state under test.
  server = createApp(new MemoryOperatorRepository(), new MemoryAgentRepository()).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Rendered {
  window: JSDOM['window'];
  document: Document;
  /** Marked hidden by the markup or by a script. */
  isHidden(id: string): boolean;
  /** True when some stylesheet this page loaded carries the guard rule. */
  hasHiddenGuard(): boolean;
  close(): void;
}

/** Load a page the way a browser does and let its scripts finish. */
async function render(path: string, expectStatus = 200): Promise<Rendered> {
  const virtualConsole = new VirtualConsole();
  // A script that throws would otherwise fail silently and leave every
  // assertion below measuring a page that never ran.
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  // JSDOM.fromURL refuses any non-2xx, and the 404 page is a real page
  // served with the status it should have, so the markup is fetched by
  // hand. The url option is still set, so relative asset paths resolve
  // exactly as they would in a browser.
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
  expect(response.status, `unexpected status for ${path}`).toBe(expectStatus);
  const markup = await response.text();

  const dom = new JSDOM(markup, {
    url: `${baseUrl}${path}`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      // jsdom ships no fetch. The pages need the one a browser gives them,
      // pointed at this server so relative paths resolve.
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
  // The page scripts fetch after load; this is one turn past that.
  await new Promise((resolve) => setTimeout(resolve, 250));

  if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);

  const document = dom.window.document;

  return {
    window: dom.window,
    document,
    isHidden(id) {
      const node = document.getElementById(id);
      if (!node) throw new Error(`no element #${id} on ${path}`);
      return node.hidden;
    },
    hasHiddenGuard() {
      // Read back through the CSSOM rather than searching the file's text:
      // a rule that failed to parse would still match a string search, and
      // a rule the page never loaded would too.
      for (const sheet of Array.from(document.styleSheets)) {
        for (const rule of Array.from(sheet.cssRules)) {
          const styleRule = rule as CSSStyleRule;
          if (styleRule.selectorText !== '[hidden]') continue;
          if (styleRule.style.getPropertyValue('display') !== 'none') continue;
          // Without !important the rule loses to an inline style, and
          // several of these pages set display inline.
          if (styleRule.style.getPropertyPriority('display') === 'important') return true;
        }
      }
      return false;
    },
    close: () => dom.window.close(),
  };
}

// The guard is one line that a tidy-up could delete without obvious
// consequence, and every visibility claim below rests on it.
describe('the hidden guard is present in the stylesheets that ship', () => {
  it.each([
    ['/v1/credentials/no-such-receipt', 'receipt'],
    ['/agents/did:abt:nobody-at-all', 'agent'],
    ['/operators/did:abt:nobody-at-all', 'operator'],
    ['/verify', 'verify'],
    ['/how', 'how it works'],
    ['/signin', 'sign in'],
    ['/browse', 'browse'],
    // The landing page loads landing.css instead of base.css, so it needs
    // its own copy of the rule and is the page most likely to lose it.
    ['/', 'landing'],
  ])('%s (%s) loads a parsed, important [hidden] rule', async (path) => {
    const page = await render(path);
    try {
      expect(page.hasHiddenGuard()).toBe(true);
    } finally {
      page.close();
    }
  });
});

describe('a receipt that does not exist offers no controls', () => {
  it('says so, and marks the actions hidden rather than painting three dead buttons', async () => {
    const page = await render('/v1/credentials/no-such-receipt');
    try {
      expect(page.document.getElementById('load-error')?.hidden).toBe(false);
      expect(page.document.getElementById('load-error-detail')?.textContent).toContain(
        'no receipt at that address',
      );

      // The heart of it. "Download the record" beside "there is no receipt"
      // is a control that states no fact.
      expect(page.isHidden('actions')).toBe(true);
      expect(page.isHidden('facts')).toBe(true);
    } finally {
      page.close();
    }
  });

  it('leaves no anchor pointing at a stand-in destination', async () => {
    const page = await render('/v1/credentials/no-such-receipt');
    try {
      // These get a real href from credential.js on the success path only.
      // A markup default of "/" made both lead to the landing page, which
      // is worse than leading nowhere: it looks like it worked.
      for (const id of ['agent-link', 'download-link']) {
        expect(page.document.getElementById(id)?.getAttribute('href'), id).toBe(null);
      }
    } finally {
      page.close();
    }
  });
});

describe('an agent that was never registered says only that', () => {
  it('hides the identity row instead of leaving it loading for good', async () => {
    const page = await render('/agents/did:abt:nobody-at-all');
    try {
      expect(page.document.getElementById('name')?.textContent).toBe('Agent not found');

      // A permanent "operator loading" claims we are still working when we
      // have finished and failed.
      expect(page.isHidden('ident')).toBe(true);
      expect(page.document.getElementById('operator-link')?.getAttribute('href')).toBe(null);
      expect(page.document.getElementById('credentials-link')?.getAttribute('href')).toBe(null);
    } finally {
      page.close();
    }
  });

  it('does not show an empty-history message it has no grounds for', async () => {
    // "No verified hires yet" is a fact about an agent. We do not have one.
    const page = await render('/agents/did:abt:nobody-at-all');
    try {
      expect(page.isHidden('history-empty')).toBe(true);
    } finally {
      page.close();
    }
  });
});

describe('an operator that was never registered says only that', () => {
  it('hides the identity row on the failure path', async () => {
    const page = await render('/operators/did:abt:nobody-at-all');
    try {
      expect(page.document.getElementById('name')?.textContent).toBe('Operator not found');
      expect(page.isHidden('ident')).toBe(true);
    } finally {
      page.close();
    }
  });
});

// The landing page's entrances take elements APART before they wait for the
// observer: rise() empties the heading and rebuilds it as hidden word spans,
// settle() replaces its line with a single space. A throw at the observer
// leaves the page permanently mid-teardown, with the headline blank and
// every element after it in init()'s loop never processed at all.
//
// Not hypothetical. jsdom has no IntersectionObserver, and the first run of
// this file hit exactly that: "Uncaught ReferenceError: IntersectionObserver
// is not defined", with the hero heading empty behind it. A browser without
// it, or with it disabled by policy, loses the copy rather than the motion.
describe('the landing page keeps its words when the observer is missing', () => {
  it('renders headline text with no IntersectionObserver in the environment', async () => {
    expect(
      'IntersectionObserver' in globalThis,
      'this it is meaningless if the environment provides one',
    ).toBe(false);

    const page = await render('/');
    try {
      const risen = page.document.querySelectorAll('[data-rise]');
      expect(risen.length, 'no [data-rise] elements: the selector has drifted').toBeGreaterThan(0);

      for (const node of Array.from(risen)) {
        const text = (node.textContent ?? '').replace(/\u00A0/g, ' ').trim();
        expect(text, 'a rise element rendered empty').not.toBe('');
      }

      // Same for the scrambled lines, which are replaced by a single
      // non-breaking space while they wait.
      for (const node of Array.from(page.document.querySelectorAll('[data-settle]'))) {
        const text = (node.textContent ?? '').replace(/\u00A0/g, ' ').trim();
        expect(text, 'a settle element rendered empty').not.toBe('');
      }
    } finally {
      page.close();
    }
  });
});

// The class, swept rather than spot-checked. Two elements leaked and two
// more were latent, saved only by happening to compute to zero height, so
// the check that belongs here covers every page with a hidden element.
describe('every page that hides something also carries the guard for it', () => {
  it.each([
    ['/', 'landing', 200],
    ['/how', 'how it works', 200],
    ['/browse', 'browse placeholder', 200],
    ['/signin', 'sign in', 200],
    ['/verify', 'verify', 200],
    ['/agents/did:abt:nobody-at-all', 'agent, not found', 200],
    ['/operators/did:abt:nobody-at-all', 'operator, not found', 200],
    ['/v1/credentials/no-such-receipt', 'receipt, not found', 200],
    // A real page, served with the status it should have.
    ['/no-such-page', '404', 404],
  ])('%s (%s)', async (path, _label, status) => {
    const page = await render(path as string, status as number);
    try {
      const hidden = Array.from(page.document.querySelectorAll('[hidden]'));
      if (hidden.length === 0) return;

      expect(
        page.hasHiddenGuard(),
        `${path} marks ${hidden.length} element(s) hidden but loads no [hidden] guard, ` +
          `so any of them carrying a display rule would paint anyway`,
      ).toBe(true);

      // No element may set display inline, which would need the guard's
      // !important to beat it. Catches a future edit that reaches for a
      // style attribute on something it also wants hidden.
      const inlineDisplay = hidden
        .filter((node) => (node.getAttribute('style') ?? '').includes('display'))
        .map((node) => `${node.tagName.toLowerCase()}#${node.id || '(no id)'}`);
      expect(inlineDisplay, `inline display on a hidden element on ${path}`).toEqual([]);
    } finally {
      page.close();
    }
  });
});
