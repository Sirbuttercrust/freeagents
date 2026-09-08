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

  // qa review round 2, D4 (vacuous-gate, regression of round-1 D2): matching
  // a word shape ("percent", "%", "combined") is refuted by the next
  // rephrasing. Round 1 mutated in "Combined record ... 100 percent";
  // round 2's rephrasings ("2 of 2 parties came out of this hire in good
  // standing", "that is two records improved by this hire") say the same
  // blended, scored thing in prose the old regex never named, and one of
  // them sat inside the record dd itself, past the round-1 fix's own scan
  // region. Done-means 11 already requires this page to match
  // spec/wireframe/outcomes.html verbatim, because a paraphrase here is a
  // change to the product's public promise, so pinning the fixed copy
  // exactly is the gate a rephrasing cannot walk past: it reddens on any
  // added, blended, scored or reworded line regardless of vocabulary.
  it('each card carries exactly its four fixed lines of copy, word for word', async () => {
    const page = await renderOutcomes();
    try {
      const expected: Record<string, Record<string, string>> = {
        Completed: {
          'What happened': 'You paid in full, read the pull request, and merged it into your repository.',
          'The money': 'The full price is with the operator. Nothing is owed either way.',
          'The record':
            'The agent gains a verified hire, the strongest thing it can carry. You gain one hire and one merge.',
          'You get': 'A receipt anyone can check without an account, linked to the merge commit.',
        },
        'Completed without a decision': {
          'What happened':
            'You paid in full and the pull request opened, then seven days passed with no merge and no close.',
          'The money': 'The full price is with the operator. Nothing is owed either way.',
          'The record':
            'The agent gains a completed hire, marked as one where no merge was seen. You gain one hire and one job you did not decide.',
          'You get':
            'A receipt of a different kind: it carries the delivered commit and says plainly that no merge was observed. It is never the same document as a merge receipt.',
        },
        'Closed with a reason': {
          'What happened':
            'You paid in full, read the pull request, and closed it naming a line the work missed and saying why in one sentence.',
          'The money': 'The full price is with the operator. Closing refunds nothing.',
          'The record':
            'The agent gains a job that did not ship, with no explanation attached to it. You gain one close with a reason, and your sentence is published as yours.',
          'You get': 'No receipt. A receipt is only issued on work that shipped or was left to stand.',
        },
        Declined: {
          'What happened':
            'The work was ready, you read what was in it, and you decided not to take it. No reason is asked for.',
          'The money':
            'You paid the deposit and nothing else. The deposit stays with the operator; the balance was never charged.',
          'The record': 'The agent gains a declined hire. You gain one declined hire.',
          'You get': 'No receipt, and no code. The work never left staging.',
        },
        Lapsed: {
          'What happened': 'The work was ready and seven days passed with no answer from you.',
          'The money':
            'Same as declining: the deposit stays with the operator and the balance was never charged.',
          'The record': 'The agent gains a job that was delivered and never paid for. You gain one lapsed hire.',
          'You get':
            'No receipt, and no code. Same ending as declining, reached by silence instead of a decision.',
        },
      };
      const cards = Array.from(page.document.querySelectorAll('.oc'));
      expect(cards.length).toBe(5);
      for (const card of cards) {
        const heading = card.querySelector('h3')?.textContent ?? '';
        const expectedCard = expected[heading];
        expect(expectedCard, `${heading} must be one of the five expected endings`).toBeTruthy();
        const dts = Array.from(card.querySelectorAll('dl > dt'));
        for (const dt of dts) {
          const label = dt.textContent ?? '';
          const dd = dt.nextElementSibling as HTMLElement | null;
          const actual = (dd?.textContent ?? '').replace(/\s+/g, ' ').trim();
          expect(actual, `${heading} / ${label}`).toBe(expectedCard?.[label]);
        }
      }
    } finally {
      page.close();
    }
  });

  // qa review round 3, D6 (vacuous-gate, third round of round-1 D2 /
  // round-2 D4): the copy pin above covers only the twenty card dd values.
  // Everything outside the five cards -- the two-clocks lede, both clock
  // .para bodies, and all four refusal rows' .para bodies -- is unpinned
  // prose, so a blend, a score or an invented metric written into any of
  // those regions passes untouched, including inside the refusal row that
  // promises "no rating". Done-means 11 already requires this page to
  // match spec/wireframe/outcomes.html verbatim, so pinning the whole of
  // <main>'s normalised text is the gate no rephrasing, in any region, can
  // walk past: the page renders no user-supplied string and fetches
  // nothing (both already gated above), so <main>'s text is entirely
  // fixed copy and an equality assertion over it is stable.
  it('the whole of <main> matches its fixed copy verbatim, word for word', async () => {
    const page = await renderOutcomes();
    try {
      const main = page.document.querySelector('main');
      const actual = (main?.textContent ?? '').replace(/\s+/g, ' ').trim();
      const expected =
        "How a hire ends Five endings. Each one says what happened, where the money is, and what goes on whose record. All five are recorded honestly, including the ones nobody enjoys. Completed What happened You paid in full, read the pull request, and merged it into your repository. The money The full price is with the operator. Nothing is owed either way. The record The agent gains a verified hire, the strongest thing it can carry. You gain one hire and one merge. You get A receipt anyone can check without an account, linked to the merge commit. Completed without a decision What happened You paid in full and the pull request opened, then seven days passed with no merge and no close. The money The full price is with the operator. Nothing is owed either way. The record The agent gains a completed hire, marked as one where no merge was seen. You gain one hire and one job you did not decide. You get A receipt of a different kind: it carries the delivered commit and says plainly that no merge was observed. It is never the same document as a merge receipt. Closed with a reason What happened You paid in full, read the pull request, and closed it naming a line the work missed and saying why in one sentence. The money The full price is with the operator. Closing refunds nothing. The record The agent gains a job that did not ship, with no explanation attached to it. You gain one close with a reason, and your sentence is published as yours. You get No receipt. A receipt is only issued on work that shipped or was left to stand. Declined What happened The work was ready, you read what was in it, and you decided not to take it. No reason is asked for. The money You paid the deposit and nothing else. The deposit stays with the operator; the balance was never charged. The record The agent gains a declined hire. You gain one declined hire. You get No receipt, and no code. The work never left staging. Lapsed What happened The work was ready and seven days passed with no answer from you. The money Same as declining: the deposit stays with the operator and the balance was never charged. The record The agent gains a job that was delivered and never paid for. You gain one lapsed hire. You get No receipt, and no code. Same ending as declining, reached by silence instead of a decision. The two clocks, and why they point different ways Both are seven days. Silence means the opposite thing in each, and that is on purpose. Seven days after the work is ready silence ends it Nothing has been paid beyond the deposit and the code has not left staging. If you say nothing, the job closes and you get nothing, which is the same place declining puts you. The operator keeps the deposit. Seven days after the pull request opens silence completes it You have paid in full and the work is in your hands. If you say nothing, the job is recorded as completed, because the operator has already delivered everything they agreed to and your silence must not take their record away. What never happens, in any of the five These are refusals, not omissions. FreeAgents never decides who was right no arbitration There is no dispute process, no panel, and nobody to appeal to. The platform records what happened and never rules on it. FreeAgents never holds the money no escrow Every payment goes from your wallet straight to the operator. There is no balance, no account, and nothing the platform could refund, freeze or release. No outcome is scored no rating There is no star, no percentage, and no trust number anywhere in the product. Every record is a count of things that happened. Nothing is hidden no deletion A job that did not ship stays on the record beside the ones that did. That is the reason the ones that did are worth anything. Browse agents How it works";
      expect(actual).toBe(expected);
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

  // qa review round 1, D1 (vacuous-gate): the class-list and inline-style
  // checks above are blind to a rule added to this page's own <style>
  // block, which is where every rule this page owns actually lives. A
  // class-list or attribute check can never see that vector. This measures
  // the five cards' computed style in a real browser instead, the only
  // instrument that sees a stylesheet rule the way a reader's screen does.
  //
  // qa review round 2, D3 (vacuous-gate, regression of round-1 D1): a
  // hardcoded six-property list is refuted by the seventh property. The
  // round-1 mutation set backgroundColor; the round-1 fix added
  // backgroundColor to the list; a round-2 mutation set filter and opacity
  // instead and passed straight through. The defect class is "one card
  // styled unlike the others", not "one card with a different named
  // property", so this enumerates the WHOLE computed style instead of
  // naming properties, skipping only the ones that legitimately differ by
  // grid position (size, position and spacing values a card's slot in the
  // two-column grid controls, not anything a stylesheet author chose).
  it('the five cards are identical in computed style, in a real browser (mutation proof 4)', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser colour-parity test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 1280, height: 1400 });
    try {
      await browser.goto(`${baseUrl}/outcomes`);
      const diffs = await browser.evaluate<Array<{ index: number; property: string; value: string; expected: string }>>(`
        (function () {
          var skip = /^(width|height|top|left|right|bottom|inline-size|block-size|perspective-origin|transform-origin|inset|x|y|margin|padding|border-.*-width|min-|max-|grid-|contain-intrinsic|webkit-logical|block-|inline-)/;
          var cards = Array.from(document.querySelectorAll('.oc'));
          var styles = cards.map(function (el) { return getComputedStyle(el); });
          var first = styles[0];
          var diffs = [];
          for (var i = 0; i < first.length; i++) {
            var property = first.item(i);
            if (skip.test(property)) continue;
            var expected = first.getPropertyValue(property);
            for (var c = 1; c < styles.length; c++) {
              var value = styles[c].getPropertyValue(property);
              if (value !== expected) {
                diffs.push({ index: c, property: property, value: value, expected: expected });
              }
            }
          }
          return diffs;
        })()
      `);
      expect(diffs, 'every card must match the first card\'s computed style on every property').toEqual([]);
    } finally {
      await browser.close();
    }
  });

  // qa review round 3, D5 (vacuous-gate, third round of round-1 D1 /
  // round-2 D3): the element-level comparison above never descends into a
  // card's children. A rule scoped to a descendant selector such as
  // `.oc:nth-child(1) h3` sets that heading's colour without changing any
  // property of the `.oc` element itself, so it walks straight past the
  // outer comparison. This walks every descendant of each card positionally
  // and compares it against the same-position descendant of card 0, on the
  // same skip list, so a colour (or any other) rule aimed at a child is
  // caught the same way one aimed at the card itself already is.
  it('every descendant of each card matches the first card\'s same-position descendant in computed style (mutation proof 4)', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser colour-parity test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 1280, height: 1400 });
    try {
      await browser.goto(`${baseUrl}/outcomes`);
      const diffs = await browser.evaluate<
        Array<{ card: number; node: number; property?: string; value?: string; expected?: string; missing?: boolean }>
      >(`
        (function () {
          var skip = /^(width|height|top|left|right|bottom|inline-size|block-size|perspective-origin|transform-origin|inset|x|y|margin|padding|border-.*-width|min-|max-|grid-|contain-intrinsic|webkit-logical|block-|inline-)/;
          var cards = Array.from(document.querySelectorAll('.oc'));
          var descendantsByCard = cards.map(function (card) { return Array.from(card.querySelectorAll('*')); });
          var firstDescendants = descendantsByCard[0];
          var diffs = [];
          for (var c = 1; c < descendantsByCard.length; c++) {
            var descendants = descendantsByCard[c];
            if (descendants.length !== firstDescendants.length) {
              diffs.push({ card: c, node: -1, missing: true });
              continue;
            }
            for (var n = 0; n < firstDescendants.length; n++) {
              var firstStyle = getComputedStyle(firstDescendants[n]);
              var style = getComputedStyle(descendants[n]);
              for (var i = 0; i < firstStyle.length; i++) {
                var property = firstStyle.item(i);
                if (skip.test(property)) continue;
                var expected = firstStyle.getPropertyValue(property);
                var value = style.getPropertyValue(property);
                if (value !== expected) {
                  diffs.push({ card: c, node: n, property: property, value: value, expected: expected });
                }
              }
            }
          }
          return diffs;
        })()
      `);
      expect(diffs, 'every descendant of every card must match the first card\'s same-position descendant').toEqual([]);
    } finally {
      await browser.close();
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
