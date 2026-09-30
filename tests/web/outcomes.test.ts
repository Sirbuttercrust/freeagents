// P8o: how a hire ends, before anyone starts one (SITEMAP P-31, built as
// outcomes.html). Public, reads nothing, states no fact about any
// particular hire: every assertion here is about the five fixed endings,
// never a fetched or fixtured job.
//
// DIAG1a moved the page onto two animated diagrams (tests/web/diagrams.test.ts
// measures their behaviour) and put the five cards, the two clocks and the
// four refusals behind one disclosure, unchanged. Every guarantee this file
// held on the old page still holds here, and the cards are read where they
// now sit.
//
// The money lines and the two clocks are pinned against MISSION.md's
// Settlement section ("Two legs, fair to both sides") word for word, because
// a paraphrase here is a change to the product's public promise.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

// Real-browser layout tests launch Chrome, navigate at least once and
// evaluate in the page; vitest's 5000ms default times out under full-suite
// load exactly the way CI1 found in dashboard.test.ts and
// hire-polished.test.ts (run 35390871202, layout tests red on
// "Test timed out in 5000ms" with no layout defect). 30s is past every
// launch observed here and a genuinely broken layout still fails inside it.
const BROWSER_TIMEOUT_MS = 30_000;

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

const publicJsPages = join(dirname(fileURLToPath(import.meta.url)), '../../src/web/public/js/pages');
const missionMd = join(dirname(fileURLToPath(import.meta.url)), '../../MISSION.md');

// Opens the page's one disclosure with a real press, so the cards are
// measured as a reader sees them once they open it.
async function openFullWording(browser: RealBrowser): Promise<void> {
  const at = await browser.evaluate<{ x: number; y: number }>(`
    (function () {
      var b = document.querySelector('main button[data-disclose="full-wording"]');
      b.scrollIntoView({ block: 'center' });
      var r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()
  `);
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
  await new Promise((r) => setTimeout(r, 300));
  const open = await browser.evaluate<boolean>("!document.getElementById('full-wording').hidden");
  expect(open, 'the full wording opened').toBe(true);
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

  // The cards moved behind the page's one disclosure (DIAG1a) and nowhere
  // else. The second diagram and the closing buttons sit outside it, so
  // this also pins that the disclosure holds exactly the old page's
  // wording and nothing the first screen needs.
  it('all five cards, both clock rows and all four refusal rows sit inside the one "Show the full wording" disclosure, and nothing else does', async () => {
    const page = await renderOutcomes();
    try {
      const doc = page.document;
      const buttons = Array.from(doc.querySelectorAll('main [data-disclose]'));
      expect(buttons.map((b) => [b.textContent, b.getAttribute('data-disclose'), b.getAttribute('data-disclose-alt')])).toEqual([
        ['Show the full wording', 'full-wording', 'Hide the full wording'],
      ]);
      const panel = doc.getElementById('full-wording');
      expect(panel?.hidden, 'ui.js closes it at load').toBe(true);
      expect(Array.from(panel?.children ?? []).map((e) => e.tagName.toLowerCase() + '.' + e.className)).toEqual([
        'p.sub',
        'div.outcomes stagger reveal',
        'h2.',
        'p.sub',
        'ul.fixed pane pane-pad reveal',
        'h2.',
        'p.sub',
        'ul.fixed pane pane-pad reveal',
      ]);
      expect(doc.querySelectorAll('.oc').length).toBe(panel?.querySelectorAll('.oc').length);
      expect(doc.querySelectorAll('.fixed').length).toBe(panel?.querySelectorAll('.fixed').length);
      expect(panel?.querySelectorAll('[data-diagram], a, button').length, 'no diagram and no control inside the panel').toBe(0);
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

  // The same two-populations rule on the diagram's five ending cards, which
  // are what a reader sees first: the agent's line and the buyer's line are
  // two separate rows under "Record", never one.
  it('each ending in the diagram names the agent and the buyer as two separate record lines, never one summed figure', async () => {
    const page = await renderOutcomes();
    try {
      const ends = Array.from(page.document.querySelectorAll('.dg-end'));
      expect(ends.length).toBe(5);
      const records = ends.map((end) => {
        const rows = Array.from(end.querySelectorAll('.dg-facts > div'));
        expect(rows.map((r) => r.querySelector('.dg-k')?.textContent)).toEqual(['Money', 'Record', 'Receipt']);
        const lines = Array.from(rows[1]?.querySelectorAll('.dg-v.is-stack > span') ?? []);
        return lines.map((l) => (l.textContent ?? '').replace(/\s+/g, ' ').trim());
      });
      expect(records).toEqual([
        ['Agent a declined hire', 'You a declined hire'],
        ['Agent delivered, never paid for', 'You a lapsed hire'],
        ['Agent a verified hire', 'You a hire and a merge'],
        ['Agent a completed hire, no merge seen', 'You a hire you did not decide'],
        ['Agent a job that did not ship', 'You a close, your reason published'],
      ]);
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
          'You get': 'No receipt, and no files. The work never left staging.',
        },
        Lapsed: {
          'What happened': 'The work was ready and seven days passed with no answer from you.',
          'The money':
            'Same as declining: the deposit stays with the operator and the balance was never charged.',
          'The record': 'The agent gains a job that was delivered and never paid for. You gain one lapsed hire.',
          'You get':
            'No receipt, and no files. Same ending as declining, reached by silence instead of a decision.',
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
  // round-2 D4): a copy pin over the card values alone left the rest of the
  // page as unpinned prose, so a blend, a score or an invented metric
  // written anywhere else passed untouched. Pinning all of <main>'s text is
  // the gate no rephrasing, in any region, can walk past: the page renders
  // no user-supplied string and fetches nothing (both gated above), so
  // every word in <main> is fixed copy.
  //
  // DIAG1a: the pin is now the new page's text, read one text node at a
  // time, so the diagram's short labels ("Money", "Agent") are each exact
  // and a word moved from one node to its neighbour still fails. The old
  // page's copy is all still here, in order, inside the disclosure.
  it('the whole of <main> matches its fixed copy word for word, text node by text node', async () => {
    const page = await renderOutcomes();
    try {
      const doc = page.document;
      const main = doc.querySelector('main');
      expect(main).not.toBeNull();
      const walk = doc.createTreeWalker(main as Node, 4);
      const actual: string[] = [];
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const t = (n.nodeValue ?? '').replace(/\s+/g, ' ').trim();
        if (t) actual.push(t);
      }
      // Every text node in <main>, in order, joined with " | " so a word that
      // moves from one node to its neighbour still fails.
      const expected =
        "How a hire ends | Five ways a hire can end, and what each one leaves behind. | Where each hire can end | Replay | You agree, and pay 25% | Before any work starts. | The agent's work is ready | Read it first. You can send it back once. | If you decline it | Declined | Money | Deposit only, kept by the operator. | Record | Agent | a declined hire | You | a declined hire | Receipt | None, and no files | If you say nothing for 7 days | Lapsed | Money | Deposit only, kept by the operator. | Record | Agent | delivered, never paid for | You | a lapsed hire | Receipt | None, and no files | The pull request opens | Into your repository, from the agent's own copy. | If you merge it | Completed | Money | Paid in full. | Record | Agent | a verified hire | You | a hire and a merge | Receipt | Yes. Anyone can check it. | If you say nothing for 7 days | Completed without a decision | Money | Paid in full. | Record | Agent | a completed hire, no merge seen | You | a hire you did not decide | Receipt | Yes, marked: no merge seen. | If you close it and say why | Closed with a reason | Money | Paid in full. Closing does not undo it. | Record | Agent | a job that did not ship | You | a close, your reason published | Receipt | None | Seven days of silence ends a hire before you pay, and completes it once you have. | Show the full wording | Five endings. Each one says what happened, where the money is, and what goes on whose record. All five are recorded honestly, including the ones nobody enjoys. | Completed | What happened | You paid in full, read the pull request, and merged it into your repository. | The money | The full price is with the operator. Nothing is owed either way. | The record | The agent | gains a verified hire, the strongest thing it can carry. | You | gain one hire and one merge. | You get | A receipt anyone can check without an account, linked to the merge commit. | Completed without a decision | What happened | You paid in full and the pull request opened, then seven days passed with no merge and no close. | The money | The full price is with the operator. Nothing is owed either way. | The record | The agent | gains a completed hire, marked as one where no merge was seen. | You | gain one hire and one job you did not decide. | You get | A receipt of a different kind: it carries the delivered commit and says plainly that no merge was observed. It is never the same document as a merge receipt. | Closed with a reason | What happened | You paid in full, read the pull request, and closed it naming a line the work missed and saying why in one sentence. | The money | The full price is with the operator. Closing refunds nothing. | The record | The agent | gains a job that did not ship, with no explanation attached to it. | You | gain one close with a reason, and your sentence is published as yours. | You get | No receipt. A receipt is only issued on work that shipped or was left to stand. | Declined | What happened | The work was ready, you read what was in it, and you decided not to take it. No reason is asked for. | The money | You paid the deposit and nothing else. The deposit stays with the operator; the balance was never charged. | The record | The agent | gains a declined hire. | You | gain one declined hire. | You get | No receipt, and no files. The work never left staging. | Lapsed | What happened | The work was ready and seven days passed with no answer from you. | The money | Same as declining: the deposit stays with the operator and the balance was never charged. | The record | The agent | gains a job that was delivered and never paid for. | You | gain one lapsed hire. | You get | No receipt, and no files. Same ending as declining, reached by silence instead of a decision. | The two clocks, and why they point different ways | Both are seven days. Silence means the opposite thing in each, and that is on purpose. | Seven days after the work is ready | silence ends it | Nothing has been paid beyond the deposit and the work has not left staging. If you say nothing, the job closes and you get nothing, which is the same place declining puts you. The operator keeps the deposit. | Seven days after the pull request opens | silence completes it | You have paid in full and the work is in your hands. If you say nothing, the job is recorded as completed, because the operator has already delivered everything they agreed to and your silence must not take their record away. | What never happens, in any of the five | These are refusals, not omissions. | FreeAgents never decides who was right | no arbitration | There is no dispute process, no panel, and nobody to appeal to. The platform records what happened and never rules on it. | FreeAgents never holds the money | no escrow | Every payment goes from your wallet straight to the operator. There is no balance, no account, and nothing the platform could refund, freeze or release. | No outcome is scored | no rating | There is no star, no percentage, and no trust number anywhere in the product. Every record is a count of things that happened. | Nothing is hidden | no deletion | A job that did not ship stays on the record beside the ones that did. That is the reason the ones that did are worth anything. | What never happens | Replay | Nobody rules on who was right | It records what happened. | Money never stops at FreeAgents | From your wallet to the agent's owner. | No ending is scored | No stars, no percentage. | Nothing is deleted | Unshipped jobs stay on the record. | Browse agents | How it works";
      expect(actual.join(' | ')).toBe(expected);
    } finally {
      page.close();
    }
  });

  it('the five money lines, pinned against MISSION.md\'s two legs', async () => {
    const page = await renderOutcomes();
    try {
      const moneyByCard = new Map<string, string>();
      for (const card of Array.from(page.document.querySelectorAll('.oc'))) {
        const heading = card.querySelector('h3')?.textContent ?? '';
        const dts = Array.from(card.querySelectorAll('dl > dt'));
        const moneyDt = dts.find((dt) => dt.textContent === 'The money');
        moneyByCard.set(heading, (moneyDt?.nextElementSibling as HTMLElement | null)?.textContent ?? '');
      }
      // MISSION.md, "Two legs, fair to both sides": 25 percent at
      // agreement, 75 percent when the work is staged, completion deemed if
      // the buyer neither merges nor closes. Both "Completed" and
      // "Completed without a decision" carry full price with the operator
      // once the balance settles, matching that text.
      expect(moneyByCard.get('Completed')).toBe(
        'The full price is with the operator. Nothing is owed either way.',
      );
      expect(moneyByCard.get('Completed without a decision')).toBe(
        'The full price is with the operator. Nothing is owed either way.',
      );
      // The same paragraph: "no merged work goes unpaid", so closing after
      // the balance settles refunds nothing, there being no escrow to refund
      // from (the paragraph before it: "never holds, custodies, escrows").
      expect(moneyByCard.get('Closed with a reason')).toBe(
        'The full price is with the operator. Closing refunds nothing.',
      );
      // The deposit "covers the operator's up-front cost", and the buyer
      // "may... decline free of charge" before the balance is ever charged.
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

  // The diagram says the same thing in coins: an ending before the balance
  // shows the deposit's share of four, an ending after it shows all four.
  // The share is read from MISSION.md, so the picture cannot drift from the
  // rule it draws. tests/web/diagrams.test.ts counts the painted coins.
  it('the money row of each ending in the diagram matches MISSION.md\'s two legs, in words and in coins', async () => {
    const share = Number(/(\d+) percent of the price at agreement/.exec(readFileSync(missionMd, 'utf8'))?.[1]);
    expect(share, 'MISSION.md states the deposit share').toBeGreaterThan(0);
    const deposit = `${(4 * share) / 100} of 4 parts paid`;
    const page = await renderOutcomes();
    try {
      const rows = Array.from(page.document.querySelectorAll('.dg-end')).map((end) => {
        const money = end.querySelector('.dg-v.is-money');
        return [
          end.querySelector('h3')?.textContent,
          money?.querySelector('.dg-coins')?.getAttribute('aria-label'),
          money?.querySelectorAll('.dg-coin:not(.dg-empty)').length,
          money?.querySelector(':scope > span:not(.dg-coins)')?.textContent,
        ];
      });
      expect(rows).toEqual([
        ['Declined', deposit, 1, 'Deposit only, kept by the operator.'],
        ['Lapsed', deposit, 1, 'Deposit only, kept by the operator.'],
        ['Completed', '4 of 4 parts paid', 4, 'Paid in full.'],
        ['Completed without a decision', '4 of 4 parts paid', 4, 'Paid in full.'],
        ['Closed with a reason', '4 of 4 parts paid', 4, 'Paid in full. Closing does not undo it.'],
      ]);
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
      // The same for the five endings in the diagram: one class list, and
      // no inline style (the script sets its play state only while it plays,
      // and here, with no SVG geometry, it never starts).
      const ends = Array.from(page.document.querySelectorAll('.dg-end'));
      expect(ends.length).toBe(5);
      expect(new Set(ends.map((e) => e.className)).size, 'all five endings share one class list').toBe(1);
      expect(ends.map((e) => e.getAttribute('style')), 'no ending carries an inline style').toEqual([null, null, null, null, null]);
      // No score anywhere on the page. The one percentage is the deposit
      // share, a fraction of the price that MISSION.md fixes, on the step
      // where it is paid; any other figure with a % is a rating.
      const share = /(\d+) percent of the price at agreement/.exec(readFileSync(missionMd, 'utf8'))?.[1];
      const percents = Array.from((page.document.body.textContent ?? '').matchAll(/\d+%/g)).map((m) => m[0]);
      expect(percents).toEqual([`${share}%`]);
      expect(page.document.querySelector('[data-id="n1"] h3')?.textContent).toBe(`You agree, and pay ${share}%`);
    } finally {
      page.close();
    }
  });

  // qa review round 1, D1 (vacuous-gate): the class-list and inline-style
  // checks above are blind to a rule in a stylesheet, which is where every
  // rule this page's cards take actually lives. A
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
  //
  // DIAG1a: the cards sit behind the page's disclosure, so it is opened
  // first, with a real press; measured closed, five hidden cards would
  // match each other whatever their rules said. The diagram's five
  // endings, measured on the finished picture, get the same comparison.
  it('the five cards are identical in computed style once the disclosure is open, and so are the diagram\'s five endings, in a real browser (mutation proof 4)', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser colour-parity test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 1280, height: 1400 });
    try {
      await browser.goto(`${baseUrl}/outcomes?still`);
      await openFullWording(browser);
      const diffs = await browser.evaluate<Array<{ sel: string; index: number; property: string; value: string; expected: string }>>(`
        (function () {
          var skip = /^(width|height|top|left|right|bottom|inline-size|block-size|perspective-origin|transform-origin|inset|x|y|margin|padding|border-.*-width|min-|max-|grid-|contain-intrinsic|webkit-logical|block-|inline-)/;
          var diffs = [];
          ['.oc', '.dg-end'].forEach(function (sel) {
            var cards = Array.from(document.querySelectorAll(sel));
            if (cards.length !== 5) diffs.push({ sel: sel, index: -1, property: 'count', value: String(cards.length), expected: '5' });
            var styles = cards.map(function (el) { return getComputedStyle(el); });
            var first = styles[0];
            for (var i = 0; i < first.length; i++) {
              var property = first.item(i);
              if (skip.test(property)) continue;
              var expected = first.getPropertyValue(property);
              for (var c = 1; c < styles.length; c++) {
                var value = styles[c].getPropertyValue(property);
                if (value !== expected) {
                  diffs.push({ sel: sel, index: c, property: property, value: value, expected: expected });
                }
              }
            }
          });
          return diffs;
        })()
      `);
      expect(diffs, 'every card must match the first card\'s computed style on every property').toEqual([]);
    } finally {
      await browser.close();
    }
  }, BROWSER_TIMEOUT_MS);

  // qa review round 3, D5 (vacuous-gate, third round of round-1 D1 /
  // round-2 D3): the element-level comparison above never descends into a
  // card's children. A rule scoped to a descendant selector such as
  // `.oc:nth-child(1) h3` sets that heading's colour without changing any
  // property of the `.oc` element itself, so it walks straight past the
  // outer comparison. This walks every descendant of each card positionally
  // and compares it against the same-position descendant of card 0, on the
  // same skip list, so a colour (or any other) rule aimed at a child is
  // caught the same way one aimed at the card itself already is. The cards
  // are measured with the disclosure open (DIAG1a), as above.
  it('every descendant of each card matches the first card\'s same-position descendant in computed style, with the disclosure open (mutation proof 4)', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser colour-parity test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 1280, height: 1400 });
    try {
      await browser.goto(`${baseUrl}/outcomes`);
      await openFullWording(browser);
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
  }, BROWSER_TIMEOUT_MS);
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
      // The diagram draws both clocks: the same seven days of silence leads
      // to Lapsed before the balance and to Completed without a decision
      // after it, and the note under the diagram says which way each points.
      const silent = Array.from(page.document.querySelectorAll('.dg-end'))
        .filter((e) => e.getAttribute('data-via') === 'Say nothing for 7 days')
        .map((e) => [e.getAttribute('data-from'), e.querySelector('h3')?.textContent]);
      expect(silent).toEqual([
        ['n2', 'Lapsed'],
        ['n3', 'Completed without a decision'],
      ]);
      expect(page.document.querySelector('.dg-note')?.textContent).toBe(
        'Seven days of silence ends a hire before you pay, and completes it once you have.',
      );
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

  it('the second diagram draws the same four refusals, each struck through, in the same order', async () => {
    const page = await renderOutcomes();
    try {
      const diagrams = Array.from(page.document.querySelectorAll('[data-diagram]'));
      expect(diagrams.map((d) => d.querySelector('.dg-title')?.textContent)).toEqual(['Where each hire can end', 'What never happens']);
      const nopes = Array.from(diagrams[1]?.querySelectorAll('.dg-nope') ?? []).map((n) => [
        n.querySelector('h3')?.textContent,
        n.querySelector('p')?.textContent,
        n.querySelectorAll('.dg-strike').length,
      ]);
      expect(nopes).toEqual([
        ['Nobody rules on who was right', 'It records what happened.', 1],
        ['Money never stops at FreeAgents', "From your wallet to the agent's owner.", 1],
        ['No ending is scored', 'No stars, no percentage.', 1],
        ['Nothing is deleted', 'Unshipped jobs stay on the record.', 1],
      ]);
    } finally {
      page.close();
    }
  });
});

// DIAG1a changed <main> and nothing around it. The nav and the footer are
// the shared chrome every page carries, byte for byte, and neither marks a
// link as the current page (the prototype marked "How it works", which is
// not this page). The footer keeps the placeholder the server fills with
// the source links.
describe('what the page keeps from before the diagrams', () => {
  const NAV = `<nav class="nav">
  <div class="wrap inner">
    <a class="brand" href="/" aria-label="FreeAgents home"><img class="logo-lockup" src="/assets/brand/freeagents-logo-dark.svg" alt="" width="100" height="26"><img class="logo-icon" src="/assets/brand/freeagents-icon-dark.svg" alt="" width="28" height="28"></a>
    <div class="links">
      <a href="/browse">Browse</a>
      <a href="/how">How it works</a>
    </div>
    <div class="spacer"></div>
    <a class="btn btn-sm" id="nav-signin" href="/signin">Sign in</a>
    <div class="row" id="nav-signed-in" hidden>
      <button class="btn btn-sm" type="button" id="nav-signout">Sign out</button>
    </div>
  </div>
</nav>`;
  const FOOTER = `<footer class="foot">
  <div class="site-office" data-office aria-hidden="true"></div>
  <div class="wrap inner">
    <a href="/how">How it works</a>
    <a href="/verify">Verify a credential</a>
    <!--SOURCE_LINKS--><!--/SOURCE_LINKS-->
  </div>
</footer>`;
  const builtPage = join(dirname(fileURLToPath(import.meta.url)), '../../src/web/pages/outcomes.html');

  it('the nav and the footer are the shared chrome, byte for byte, with no link marked current and the source-links placeholder kept', () => {
    const src = readFileSync(builtPage, 'utf8');
    expect(src.split(NAV).length - 1, 'the nav, exactly once').toBe(1);
    expect(src.split(FOOTER).length - 1, 'the footer, exactly once').toBe(1);
    expect(src.match(/<nav\b/g)?.length).toBe(1);
    expect(src.match(/<footer\b/g)?.length).toBe(1);
    expect(src.match(/class="on"|aria-current/g), 'no element on the page is marked current').toBeNull();
  });

  it('<main> ends with the two closing buttons, Browse agents as the one primary and How it works beside it', async () => {
    const page = await renderOutcomes();
    try {
      const last = page.document.querySelector('main')?.lastElementChild;
      const links = Array.from(last?.querySelectorAll('a') ?? []).map((a) => [a.className, a.getAttribute('href'), a.textContent]);
      expect(links).toEqual([
        ['btn btn-primary', '/browse', 'Browse agents'],
        ['btn', '/how', 'How it works'],
      ]);
      expect(page.document.querySelectorAll('.btn-primary').length, 'one primary on the page').toBe(1);
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
  // W-outcomes: the list grew from two to five when this page moved onto the
  // polished visual system, and DIAG1a added the shared diagram component as
  // the sixth. The describe's title is still exactly right: this page has
  // no script OF ITS OWN. There is no src/web/public/js/pages/outcomes.js.
  // Every file here is shared (diagrams.js is the component /how and
  // /conduct will load too), and every one of them is asserted below rather
  // than merely allowed, so the list stays a pin and not a wildcard.
  //
  // The ORDER is load-bearing and is asserted, not just the membership:
  // polish.js's init() calls FAIcon.paint() as its first statement, and so
  // does diagrams.js once it has built the wire labels, so icons.js has to
  // be parsed before both. diagrams.js comes last because it measures the
  // settled layout.
  //
  // What is NOT here matters as much. bots.js and the vendored avatar core
  // draw agents; this page draws none, so neither is in the list. office.js
  // fetches them for the footer on its own once the footer is near, as on
  // every page without agents.
  it('loads the shared polish layer and the diagram component, in that order, and no page script of its own', async () => {
    const res = await getHtml('/outcomes');
    const html = await res.text();
    const scriptSrcs = Array.from(html.matchAll(/<script src="([^"]+)"/g)).map((m) => m[1]);
    expect(scriptSrcs).toEqual([
      '/js/pages/api.js',
      '/js/pages/nav.js',
      '/js/office.js',
      '/js/icons.js',
      '/js/polish.js',
      '/js/pages/ui.js',
      '/js/diagrams.js',
    ]);
    // The page's own script would be /js/pages/outcomes.js. It does not
    // exist and nothing references it.
    expect(scriptSrcs).not.toContain('/js/pages/outcomes.js');
    expect(existsSync(join(publicJsPages, 'outcomes.js'))).toBe(false);
  });

  // The absence of an avatar is asserted against the PARSED DOM, not against
  // the markup string, because a comment explaining the absence could name
  // the attribute and a string search would then redden on the
  // explanation. What matters is that no ELEMENT mounts one, and only a
  // parse can see that.
  it('mounts no avatar: the wireframe declares none and neither does this page', async () => {
    const page = await renderOutcomes();
    try {
      expect(page.document.querySelectorAll('[data-avatar]').length).toBe(0);
    } finally {
      page.close();
    }
  });
});

describe('layout: 320px, both grids collapse per the wireframe media queries, every control measures 44px or more (layout-broken-at-desktop)', () => {
  // Measured with the disclosure open, so the two grids it holds are laid
  // out and the 320px no-overflow law covers the page's open state too.
  it('at 320px, closed and with the full wording open, there is no horizontal overflow, both grids collapse, and every visible button reaches the tap floor', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 320, height: 1400 });
    try {
      await browser.goto(`${baseUrl}/outcomes`);

      const closed = await browser.evaluate<{ scrollWidth: number; clientWidth: number }>(`
        ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })
      `);
      expect(closed.scrollWidth, 'the 320px page must not scroll sideways').toBe(closed.clientWidth);

      await openFullWording(browser);
      const overflow = await browser.evaluate<{ scrollWidth: number; clientWidth: number }>(`
        ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })
      `);
      expect(overflow.scrollWidth, 'the 320px page must not scroll sideways with the full wording open').toBe(overflow.clientWidth);

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
  }, BROWSER_TIMEOUT_MS);
});
