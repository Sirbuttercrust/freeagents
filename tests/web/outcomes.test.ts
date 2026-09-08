// P8o: how a hire ends, before anyone starts one (SITEMAP P-31, built as
// outcomes.html). Public, reads nothing, states no fact about any
// particular hire -- every assertion here is about the five fixed
// endings, never a fetched or fixtured job.
//
// The five money lines and the two clocks are pinned against MISSION.md
// 124-160 word for word, because a paraphrase here is a change to the
// product's public promise (brief, "Binding design source").
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

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

function getHtml(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } });
}

interface Rendered {
  document: Document;
  fetchPaths: string[];
  close: () => void;
}

async function renderOutcomes(): Promise<Rendered> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  const response = await fetch(`${baseUrl}/outcomes`, { headers: { Accept: HTML } });
  const markup = await response.text();
  const fetchPaths: string[] = [];

  const dom = new JSDOM(markup, {
    url: `${baseUrl}/outcomes`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      Object.defineProperty(window, 'fetch', {
        writable: true,
        value: (input: string, init?: RequestInit) => {
          fetchPaths.push(String(input));
          return fetch(new URL(input, baseUrl), init);
        },
      });
    },
  });

  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);
  return { document: dom.window.document, fetchPaths, close: () => dom.window.close() };
}

describe('GET /outcomes (done-means 1)', () => {
  it('serves the page as HTML', async () => {
    const res = await getHtml('/outcomes');
    expect(res.status).toBe(200);
    expect(String(res.headers.get('content-type'))).toContain('text/html');
    expect(await res.text()).toContain('<!doctype html>');
  });

  it('an unknown path still answers JSON 404 to a non-browser caller', async () => {
    const res = await fetch(`${baseUrl}/no-such-page`, { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });
});

describe('the five endings (done-means 2, 3, 5)', () => {
  it('reads all five, no session, and the page attempts no read of its own', async () => {
    const page = await renderOutcomes();
    try {
      const cards = Array.from(page.document.querySelectorAll('.oc'));
      const headings = cards.map((c) => c.querySelector('h3')?.textContent);
      expect(headings).toEqual([
        'Completed',
        'Completed without a decision',
        'Closed with a reason',
        'Declined',
        'Lapsed',
      ]);
      // No read of any kind: nothing in this page ever calls fetch.
      expect(page.fetchPaths).toEqual([]);
    } finally {
      page.close();
    }
  });

  it('each card carries its four labelled facts in the wireframe order: what happened, the money, the record, you get', async () => {
    const page = await renderOutcomes();
    try {
      const cards = Array.from(page.document.querySelectorAll('.oc'));
      expect(cards.length).toBe(5);
      for (const card of cards) {
        const labels = Array.from(card.querySelectorAll('dl > dt')).map((dt) => dt.textContent);
        expect(labels).toEqual(['What happened', 'The money', 'The record', 'You get']);
      }
    } finally {
      page.close();
    }
  });

  it('each card\'s record names the agent and the buyer as two separate lines, never one summed figure (done-means 4)', async () => {
    const page = await renderOutcomes();
    try {
      const cards = Array.from(page.document.querySelectorAll('.oc'));
      for (const card of cards) {
        const dts = Array.from(card.querySelectorAll('dl > dt'));
        const recordDt = dts.find((dt) => dt.textContent === 'The record');
        const recordDd = recordDt?.nextElementSibling as HTMLElement | null;
        expect(recordDd, 'record dd must exist').toBeTruthy();
        const bolded = Array.from(recordDd?.querySelectorAll('b') ?? []).map((b) => b.textContent);
        expect(bolded.length, 'exactly two labelled record lines, never a third combined one').toBe(2);
        expect(bolded[0]).toBe('The agent');
        expect(bolded[1]).toBe('You');
      }
      // No element anywhere on the page carries a summed or blended figure.
      expect(page.document.querySelector('[class*="total" i]')).toBeNull();
      expect(page.document.querySelector('[class*="summary" i]')).toBeNull();
      expect(page.document.querySelector('table')).toBeNull();
    } finally {
      page.close();
    }
  });

  it('the five money lines, pinned against MISSION.md 124-160', async () => {
    const page = await renderOutcomes();
    try {
      const moneyByCard = new Map<string, string>();
      for (const card of Array.from(page.document.querySelectorAll('.oc'))) {
        const heading = card.querySelector('h3')?.textContent ?? '';
        const dts = Array.from(card.querySelectorAll('dl > dt'));
        const moneyDt = dts.find((dt) => dt.textContent === 'The money');
        moneyByCard.set(heading, (moneyDt?.nextElementSibling as HTMLElement | null)?.textContent ?? '');
      }
      // MISSION.md 140-147: two legs, 25% at agreement / 75% at staging,
      // completion deemed if the buyer neither merges nor closes. Both
      // "Completed" and "Completed without a decision" carry full price
      // with the operator once the balance settles, matching that text.
      expect(moneyByCard.get('Completed')).toBe(
        'The full price is with the operator. Nothing is owed either way.',
      );
      expect(moneyByCard.get('Completed without a decision')).toBe(
        'The full price is with the operator. Nothing is owed either way.',
      );
      // MISSION.md 145-146: "no merged work goes unpaid" -- closing after
      // the balance settles refunds nothing, there being no escrow to
      // refund from (MISSION.md 134: "never holds, custodies, escrows").
      expect(moneyByCard.get('Closed with a reason')).toBe(
        'The full price is with the operator. Closing refunds nothing.',
      );
      // MISSION.md 142-144: the 25% deposit "covers the operator's
      // up-front cost", and the buyer "may... decline free of charge"
      // before the 75% balance is ever charged.
      expect(moneyByCard.get('Declined')).toBe(
        'You paid the deposit and nothing else. The deposit stays with the operator; the balance was never charged.',
      );
      expect(moneyByCard.get('Lapsed')).toBe(
        'Same as declining: the deposit stays with the operator and the balance was never charged.',
      );
    } finally {
      page.close();
    }
  });
});

describe('no colour scale, no ordering from good to bad (done-means 5, mutation proof 4)', () => {
  it('every card carries identical class markup and no inline style', async () => {
    const page = await renderOutcomes();
    try {
      const cards = Array.from(page.document.querySelectorAll('.oc'));
      expect(cards.length).toBe(5);
      const classLists = cards.map((c) => c.className);
      expect(new Set(classLists).size, 'all five cards must share one class list').toBe(1);
      for (const card of cards) {
        expect(card.getAttribute('style'), `${card.querySelector('h3')?.textContent} carries no inline style`).toBeNull();
      }
      // No total, count, or percentage anywhere on the page.
      const bodyText = page.document.body.textContent ?? '';
      expect(bodyText).not.toMatch(/\d+%/);
    } finally {
      page.close();
    }
  });
});

describe('the two seven-day clocks (done-means 6, mutation proof 6)', () => {
  it('both windows are pinned to seven days, with the reason each points the way it does', async () => {
    const page = await renderOutcomes();
    try {
      const items = Array.from(page.document.querySelectorAll('.fixed'))[0]?.querySelectorAll('li') ?? [];
      expect(items.length).toBe(2);
      const first = items[0];
      const second = items[1];
      expect(first?.querySelector('.k')?.textContent).toBe('Seven days after the work is ready');
      expect(first?.querySelector('.v')?.textContent).toBe('silence ends it');
      expect(second?.querySelector('.k')?.textContent).toBe('Seven days after the pull request opens');
      expect(second?.querySelector('.v')?.textContent).toBe('silence completes it');
      const bodyText = page.document.body.textContent ?? '';
      expect(bodyText).toContain('Both are seven days.');
    } finally {
      page.close();
    }
  });
});

describe('what never happens, in any of the five (done-means 7)', () => {
  it('ships all four refusal rows as written', async () => {
    const page = await renderOutcomes();
    try {
      const lists = Array.from(page.document.querySelectorAll('.fixed'));
      const neverList = lists[1];
      expect(neverList, 'a second .fixed list for what never happens').toBeTruthy();
      const rows = Array.from(neverList?.querySelectorAll('li') ?? []);
      expect(rows.length).toBe(4);
      const keys = rows.map((r) => r.querySelector('.k')?.textContent);
      expect(keys).toEqual([
        'FreeAgents never decides who was right',
        'FreeAgents never holds the money',
        'No outcome is scored',
        'Nothing is hidden',
      ]);
      const values = rows.map((r) => r.querySelector('.v')?.textContent);
      expect(values).toEqual(['no arbitration', 'no escrow', 'no rating', 'no deletion']);
    } finally {
      page.close();
    }
  });
});

describe('the way in, from the page a person actually lands on (done-means 8, mutation proof 2)', () => {
  it('the landing footer links to /outcomes', async () => {
    const res = await getHtml('/');
    const html = await res.text();
    expect(html).toContain('href="/outcomes"');
  });

  it('the how footer links to /outcomes', async () => {
    const res = await getHtml('/how');
    const html = await res.text();
    expect(html).toContain('href="/outcomes"');
  });

  it('every link this page renders reaches a path the app actually mounts (inert-declared-control)', async () => {
    const page = await renderOutcomes();
    try {
      const hrefs = Array.from(page.document.querySelectorAll('a'))
        .map((a) => a.getAttribute('href'))
        .filter((h): h is string => h !== null && h.startsWith('/'));
      const uniquePaths = Array.from(new Set(hrefs));
      expect(uniquePaths.length).toBeGreaterThan(0);
      for (const path of uniquePaths) {
        const res = await getHtml(path);
        expect(res.status, `${path} must be served`).toBe(200);
      }
    } finally {
      page.close();
    }
  });
});

describe('no JavaScript of its own (done-means 10)', () => {
  it('loads only api.js and nav.js', async () => {
    const res = await getHtml('/outcomes');
    const html = await res.text();
    const scriptSrcs = Array.from(html.matchAll(/<script src="([^"]+)"/g)).map((m) => m[1]);
    expect(scriptSrcs).toEqual(['/js/pages/api.js', '/js/pages/nav.js']);
  });
});

describe('layout: 320px, both grids collapse per the wireframe media queries, every control measures 44px or more (layout-broken-at-desktop)', () => {
  it('at 320px there is no horizontal overflow and the closing buttons reach the tap floor', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 320, height: 1400 });
    try {
      await browser.goto(`${baseUrl}/outcomes`);

      const overflow = await browser.evaluate<{ scrollWidth: number; clientWidth: number }>(`
        ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })
      `);
      expect(overflow.scrollWidth, 'the 320px page must not scroll sideways').toBe(overflow.clientWidth);

      const grids = await browser.evaluate<{ outcomesCols: number; fixedCols: number }>(`
        (function () {
          var outcomes = document.querySelector('.outcomes');
          var fixed = document.querySelector('.fixed');
          var outcomesCols = getComputedStyle(outcomes).gridTemplateColumns.split(' ').length;
          var fixedFirstLi = fixed.querySelector('li');
          var fixedCols = getComputedStyle(fixedFirstLi).gridTemplateColumns.split(' ').length;
          return { outcomesCols: outcomesCols, fixedCols: fixedCols };
        })()
      `);
      expect(grids.outcomesCols, '.outcomes collapses to one column under 760px').toBe(1);
      expect(grids.fixedCols, '.fixed li collapses to one column under 420px').toBe(1);

      const buttons = await browser.evaluate<Array<{ href: string; width: number; height: number }>>(`
        Array.from(document.querySelectorAll('.btn')).filter(function (a) {
          return a.offsetParent !== null;
        }).map(function (a) {
          var r = a.getBoundingClientRect();
          return { href: a.getAttribute('href') || a.id || '', width: r.width, height: r.height };
        })
      `);
      expect(buttons.length).toBeGreaterThan(0);
      for (const b of buttons) {
        expect(b.height, `${b.href} must reach the 44px tap floor at 320px`).toBeGreaterThanOrEqual(44);
      }
    } finally {
      await browser.close();
    }
  });
});
