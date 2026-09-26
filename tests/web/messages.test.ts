// MSG1b: the hire conversation screen at /messages (SITEMAP P-33),
// direction A of the MSG0 design board, driven end to end against the real
// app on memory repositories (tests/helpers/messages-world.ts). jsdom for
// the behaviour, the tests/web/deposit.test.ts pattern; real Chrome
// (tests/helpers/real-browser.ts) for the geometry.
//
//   (a) signed out shows the sign-in prompt; a stranger's ?job= shows one
//       plain sentence, and so does a job that does not exist
//   (b) the list for a hirer and for an owner: names in words, the hire in
//       one line, the last line, the time, the unread dot and count, the
//       API's order (newest first); an empty list says so
//   (c) the thread: a party row, an edited row with its history for either
//       party, a reply with its quote, both seats' reactions, the quote
//       cards with their link, every system event, the automatic label,
//       an image and a PDF, the intro and the brief, links as safe anchors
//   (d) sending (Enter, not Shift+Enter), replying, editing, reacting,
//       replacing, removing (by tapping again and from "who reacted"), any
//       emoji, the draft kept per job, typing sent at most once in 3s,
//       and no unsend anywhere
//   (e) live: the other party's message, their typing and their read
//       receipt arrive without a reload, over the stream and, when the
//       stream is refused, over the 10 second poll
//   (f) a finished hire is read only and offers no write
//   (g) a file with no words sends; a 12 MB file and a .sql file each get
//       the notice and upload nothing; a cancelled upload sends nothing
//   (h) the nav's Messages link counts unreadTotal on another page; the
//       quiet links on job.html and operatorjob.html
//   (i) real Chrome at 320 and 390 (touch) and 1280: no sideways scroll
//       with the list, a thread and every open state; every control 44px
//       on touch; reduced motion runs nothing and hides nothing; 17px text
//       and 2px grouped gaps at 390
//   (j) no machine words and no DID on the surface, and no dashes
//
// The pinned strip (Make 8) and the step table's equality with job.js are
// pinned too. Set MSG1B_CAPTURE_DIR to a directory to have (i) save a
// screenshot of each state it measures at 390 and 1280.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM, VirtualConsole } from 'jsdom';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../src/adapters/identity/session.js';
import {
  AGENT_NAME, AGREED, BUYER_DID, BUYER_LOGIN, DONE, IDENTITIES, OPEN, OWNER_DID, OWNER_LOGIN, STAGED, SUBMITTED,
  asParty, buildMessagesWorld, type World,
} from '../helpers/messages-world.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../..');
const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const BROWSER_TIMEOUT_MS = 120_000;
// Each jsdom case renders the real page against the real app and waits on
// real round trips; 5 seconds is too tight under a loaded suite.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 30_000 });

let world: World;
beforeAll(async () => { world = await buildMessagesWorld(); });
afterAll(async () => { await world.close(); });

// ------------------------------------------------------------------ jsdom

interface Page {
  readonly window: JSDOM['window'];
  readonly document: Document;
  readonly calls: string[];
  readonly failures: string[];
  $(sel: string): HTMLElement | null;
  $$(sel: string): HTMLElement[];
  text(sel: string): string;
  close(): void;
}

// The page as a person's browser runs it: the served markup, every script,
// the session in sessionStorage, fetch wired to the real app. The stream
// needs TextDecoder, which jsdom lacks, so Node's is handed in unless a
// test asks for the fallback.
async function render(path: string, session: Session | null, opts: { stream?: boolean; refuseStream?: boolean } = {}): Promise<Page> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));
  const res = await fetch(`${world.baseUrl}${path}`, { headers: { Accept: HTML } });
  const markup = await res.text();
  const calls: string[] = [];
  const controllers: AbortController[] = [];
  const dom = new JSDOM(markup, {
    url: `${world.baseUrl}${path}`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      if (session !== null) window.sessionStorage.setItem('fa_session', JSON.stringify(session));
      if (opts.stream !== false) Object.defineProperty(window, 'TextDecoder', { writable: true, value: TextDecoder });
      Object.defineProperty(window, 'fetch', {
        writable: true,
        value: (input: string, init: RequestInit = {}) => {
          const url = new URL(input, world.baseUrl);
          calls.push(`${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`);
          if (opts.refuseStream && url.pathname.endsWith('/stream')) return Promise.resolve(new Response('{}', { status: 503 }));
          // jsdom's AbortSignal is not Node's, so the page's abort is
          // relayed onto a Node controller this harness also holds.
          const ctrl = new AbortController();
          controllers.push(ctrl);
          const theirs = init.signal as { aborted: boolean; addEventListener(t: string, f: () => void): void } | null | undefined;
          if (theirs) {
            if (theirs.aborted) ctrl.abort();
            else theirs.addEventListener('abort', () => ctrl.abort());
          }
          const { signal: _dropped, ...rest } = init;
          return fetch(url, { ...rest, signal: ctrl.signal });
        },
      });
    },
  });
  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', () => resolve());
  });
  await wait(700);
  if (failures.length > 0) throw new Error(`page script failed on ${path}: ${failures.join('; ')}`);
  const doc = dom.window.document;
  return {
    window: dom.window, document: doc, calls, failures,
    $: (sel) => doc.querySelector(sel) as HTMLElement | null,
    $$: (sel) => Array.from(doc.querySelectorAll(sel)) as HTMLElement[],
    text: (sel) => ((doc.querySelector(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim()),
    close() {
      dom.window.dispatchEvent(new dom.window.Event('pagehide'));
      controllers.forEach((c) => c.abort());
      dom.window.close();
    },
  };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await wait(50);
  }
  return check();
}

async function messagesOf(jobId: string): Promise<Array<Record<string, any>>> {
  const res = await asParty(world, world.buyer, 'GET', `/jobs/${jobId}/messages`);
  return ((await res.json()) as { messages: Array<Record<string, any>> }).messages;
}
async function threadsOf(who: Session, did: string): Promise<{ threads: Array<Record<string, any>>; unreadTotal: number }> {
  const res = await asParty(world, who, 'GET', `/accounts/${encodeURIComponent(did)}/threads`);
  return (await res.json()) as { threads: Array<Record<string, any>>; unreadTotal: number };
}
function bubbleOf(page: Page, id: string): HTMLElement {
  const b = page.$(`#msg-${id} [data-msg]`);
  if (!b) throw new Error(`no bubble for ${id}`);
  return b;
}
function openMenu(page: Page, id: string): HTMLElement {
  bubbleOf(page, id).dispatchEvent(new page.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const menu = page.$('.tbmenu');
  if (!menu) throw new Error(`no tapback menu opened for ${id}`);
  return menu;
}
function type(page: Page, text: string): HTMLTextAreaElement {
  const ta = page.$('#cmp') as HTMLTextAreaElement;
  ta.value = text;
  ta.dispatchEvent(new page.window.Event('input', { bubbles: true }));
  return ta;
}
function enter(page: Page, shift = false): void {
  const ta = page.$('#cmp') as HTMLTextAreaElement;
  ta.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: shift, bubbles: true, cancelable: true }));
}
function pick(page: Page, inputId: string, name: string, bytes: Uint8Array, mime: string): void {
  const input = page.$(`#${inputId}`) as HTMLInputElement;
  // jsdom's Blob wants its own realm's bytes
  const own = new page.window.Uint8Array(bytes.length);
  own.set(bytes);
  const file = new page.window.File([own as unknown as BlobPart], name, { type: mime });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new page.window.Event('change', { bubbles: true }));
}
const thread = (id: string): string => `/messages?job=${encodeURIComponent(id)}`;

// ------------------------------------------------------------------ (a)

describe('(a) who can see what', () => {
  it('signed out, the page shows the sign-in prompt and nothing else', async () => {
    const page = await render('/messages', null);
    try {
      expect(page.$('#signin-required')!.hidden).toBe(false);
      expect(page.text('#signin-required')).toContain('Sign in to see your messages.');
      expect(page.$('#signin-link')!.getAttribute('href')).toBe('/signin');
      expect(page.$('#msg-app')!.hidden).toBe(true);
    } finally { page.close(); }
  });

  it('a stranger opening someone else\u2019s hire gets one plain sentence, never a blank screen', async () => {
    const page = await render(thread(OPEN), world.stranger);
    try {
      expect(page.$('#msg-app')!.hidden).toBe(false);
      expect(page.$('#conv')!.classList.contains('is-none')).toBe(true);
      expect(page.text('#conv-none-text')).toBe("Only the hirer and the agent's owner can read this conversation.");
      expect(page.$('#conv-none-back')!.hidden).toBe(false);
      expect(page.$('.thread')).toBeNull();
      // and the stranger's own list is honestly empty
      expect(page.$('#list-empty')!.hidden).toBe(false);
      expect(page.text('#list-empty')).toBe('No conversations yet.');
    } finally { page.close(); }
  });

  it('a hire that does not exist says so in words', async () => {
    const page = await render(thread('no-such-hire'), world.buyer);
    try {
      expect(page.text('#conv-none-text')).toBe('There is no hire at that address.');
    } finally { page.close(); }
  });
});

// ------------------------------------------------------------------ (b)

describe('(b) the list, for both seats', () => {
  it.each([
    ['the hirer', 'buyer', `with @${OWNER_LOGIN}`],
    ['the owner', 'owner', `with @${BUYER_LOGIN}`],
  ] as const)('%s sees every hire, newest first, with the unread dot and count', async (_label, who, withWords) => {
    const session = who === 'buyer' ? world.buyer : world.owner;
    const did = who === 'buyer' ? BUYER_DID : OWNER_DID;
    const api = await threadsOf(session, did);
    const page = await render('/messages', session);
    try {
      const rows = page.$$('.convlist li');
      expect(rows.map((li) => li.querySelector('a')!.getAttribute('data-job'))).toEqual(api.threads.map((t) => t.jobId));
      expect(rows).toHaveLength(5);
      let anyUnread = false;
      rows.forEach((li, i) => {
        const t = api.threads[i]!;
        const a = li.querySelector('a')!;
        expect(a.getAttribute('href')).toBe(`/messages?job=${t.jobId}`);
        expect(li.querySelector('.cl-top b')!.textContent).toBe(`${AGENT_NAME} ${withWords}`);
        expect(li.classList.contains('unread')).toBe(t.unreadCount > 0);
        const sr = li.querySelector('.cl-last .sr');
        if (t.unreadCount > 0) {
          anyUnread = true;
          expect(sr!.textContent).toBe(`${t.unreadCount} unread. `);
        } else {
          expect(sr).toBeNull();
        }
        expect(li.querySelector('time')!.textContent!.length).toBeGreaterThan(0);
      });
      expect(anyUnread, 'the fixture must leave something unread for this to mean anything').toBe(true);

      const open = page.$(`.convlist a[data-job="${OPEN}"]`)!;
      expect(open.querySelector('.cl-hire')!.textContent).toBe('Move Postgres 12 to 16 on a new host.');
      expect(open.querySelector('.cl-lt')!.textContent).toBe(who === 'buyer' ? 'You: Thursday after 10 PM Eastern.' : 'Thursday after 10 PM Eastern.');
      expect(page.text(`.convlist a[data-job="${STAGED}"] .cl-lt`)).toBe('Brief sent');
      expect(page.text(`.convlist a[data-job="${DONE}"] .cl-lt`)).toBe(who === 'buyer' ? 'You: Thanks. Good working with you.' : 'Thanks. Good working with you.');
    } finally { page.close(); }
  });

  it('a row opens its thread in place, with the row marked current', async () => {
    const page = await render('/messages', world.owner);
    try {
      (page.$(`.convlist a[data-job="${STAGED}"]`) as HTMLAnchorElement).click();
      expect(await until(() => page.$('.thread') !== null)).toBe(true);
      expect(page.window.location.search).toBe(`?job=${STAGED}`);
      expect(page.$(`.convlist a[data-job="${STAGED}"]`)!.getAttribute('aria-current')).toBe('true');
      // and the back control returns to the list
      (page.$('#conv-back') as HTMLAnchorElement).click();
      expect(await until(() => page.$('.thread') === null)).toBe(true);
      expect(page.window.location.search).toBe('');
    } finally { page.close(); }
  });
});

// ------------------------------------------------------------------ (c)

describe('(c) the thread renders every kind of row', () => {
  let page: Page;
  beforeAll(async () => { page = await render(thread(OPEN), world.buyer); });
  afterAll(() => page.close());

  it('the intro, then the brief as the first bubble, on my side', () => {
    expect(page.text('.intro b')).toBe(AGENT_NAME);
    expect(page.text('.intro p')).toBe(`You are talking with @${OWNER_LOGIN}, who runs ${AGENT_NAME}. Anything ${AGENT_NAME} sends by itself is marked. This conversation stays with the hire.`);
    const brief = page.$('#msg-brief')!;
    expect(brief.closest('.run')!.classList.contains('me')).toBe(true);
    expect(brief.querySelector('.lbl')!.textContent).toBe('Brief');
    expect(brief.querySelector('.txt')!.textContent).toContain('Move Postgres 12 to 16 on a new host.');
    expect(page.$$('.stamp').length).toBeGreaterThan(0);
  });

  it('the other party\u2019s rows group into one run, with the tail on the last bubble only', () => {
    const first = page.$(`#msg-${world.ids.thanks}`)!;
    const run = first.closest('.run')!;
    expect(run.classList.contains('them')).toBe(true);
    expect(run.querySelector('.who')!.textContent).toBe(`@${OWNER_LOGIN}`);
    expect(first.textContent).toContain('Thanks, this is a clear brief.');
    expect(run.contains(page.$(`#msg-${world.ids.question}`))).toBe(true);
    for (const r of page.$$('.run')) {
      const msgs = Array.from(r.querySelectorAll(':scope > .msg'));
      const tails = msgs.filter((m) => m.classList.contains('tail'));
      expect(tails.length).toBeLessThanOrEqual(1);
      if (tails.length === 1) expect(msgs[msgs.length - 1]).toBe(tails[0]);
    }
  });

  it('a link in a body is a real anchor, http and https only, and nothing else is', () => {
    const anchors = Array.from(bubbleOf(page, world.ids.question).querySelectorAll('a'));
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.getAttribute('href')).toBe('https://example.com/checklist');
    expect(anchors[0]!.textContent).toBe('https://example.com/checklist');
    expect(anchors[0]!.getAttribute('rel')).toBe('noopener nofollow ugc');
    expect(anchors[0]!.getAttribute('target')).toBe('_blank');
    expect(bubbleOf(page, world.ids.question).textContent).toContain('javascript:alert(1) is only words.');
    expect(page.document.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it('a reply carries the quote of the message it answers, and the quote jumps to it', () => {
    const quote = page.$(`#msg-${world.ids.counter} .quote`)!;
    expect(quote.querySelector('b')!.textContent).toBe('You');
    expect(quote.querySelector('span')!.textContent).toBe('Could you do $1,100? I can make the staging snapshot myself.');
    expect(quote.getAttribute('data-jump')).toBe(world.ids.push);
    (quote as HTMLButtonElement).click();
    expect(page.$(`#msg-${world.ids.push}`)!.classList.contains('flash')).toBe(true);
  });

  it('both seats\u2019 reactions show, mine in my colour, each opening who reacted', () => {
    const reacts = page.$$(`#msg-${world.ids.counter} .reacts .react`);
    expect(reacts.map((r) => r.textContent)).toEqual(['\uD83D\uDC4D', '\uD83E\uDD1D']);
    expect(reacts.map((r) => r.classList.contains('mine'))).toEqual([false, true]);
    expect(reacts[1]!.getAttribute('aria-label')).toBe('You reacted \uD83E\uDD1D. Show who reacted');
    reacts[1]!.click();
    const sheet = page.$('.sheet.who')!;
    expect(sheet.querySelector('h2')!.textContent).toBe('Reactions');
    expect(Array.from(sheet.querySelectorAll('li .nm')).map((n) => n.textContent)).toEqual([`@${OWNER_LOGIN}`, 'You']);
    expect(sheet.querySelectorAll('[data-act="unreact"]')).toHaveLength(1);
    (sheet.querySelector('.x') as HTMLButtonElement).click();
    expect(page.$('.sheet')).toBeNull();
  });

  it('the quote cards: the first replaced, the latest with its price, window, points and the link to the agreement', () => {
    const cards = page.$$('.quotecard');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.classList.contains('replaced')).toBe(true);
    expect(cards[0]!.querySelector('.qc-price')!.textContent).toBe('$1,400');
    expect(cards[0]!.querySelector('.qc-note')!.textContent).toBe('Replaced by the updated quote below.');
    expect(cards[0]!.querySelector('a')).toBeNull();
    const latest = cards[1]!;
    expect(latest.querySelector('.qc-lbl')!.textContent).toBe('Updated quote');
    expect(latest.querySelector('.qc-price')!.textContent).toBe('$1,200');
    expect(latest.querySelector('.qc-was')!.textContent).toBe('was $1,400');
    expect(Array.from(latest.querySelectorAll('dt, dd')).map((n) => n.textContent)).toEqual(['Delivery', '5 days', 'Points to sign', '2']);
    const link = latest.querySelector('a.qc-open')!;
    expect(link.textContent).toBe('Review the quote');
    expect(link.getAttribute('href')).toBe(`/agreement?job=${OPEN}`);
    const events = page.$$('.event').map((e) => (e.textContent ?? '').trim());
    expect(events).toContain(`@${OWNER_LOGIN} sent a quote`);
    expect(events).toContain(`@${OWNER_LOGIN} updated the quote to $1,200`);
  });

  it('a message the agent sent by itself says so', () => {
    const auto = page.$(`#msg-${world.ids.auto}`)!;
    const run = auto.closest('.run')!;
    expect(run.querySelector('.who')!.textContent).toBe(`${AGENT_NAME} agent`);
    expect(run.querySelector('.meta .auto')!.textContent).toBe(`Sent by ${AGENT_NAME} automatically`);
  });

  it('an image shows as its own bubble, and a PDF as a file card with its name and size', () => {
    const open = page.$(`#msg-${world.ids.image} .bubble.img .imgopen`)!;
    expect(open.getAttribute('aria-label')).toBe('Open staging-check.png full size');
    expect(open.getAttribute('data-view')).toBe(world.ids.imageFile);
    const card = page.$(`#msg-${world.ids.pdf} .filecard`)!;
    expect(card.querySelector('b')!.textContent).toBe('db-access-policy.pdf');
    expect(card.querySelector('small')!.textContent).toBe('PDF, 1 KB');
    expect(card.getAttribute('data-dl')).toBe(world.ids.pdfFile);
    expect(bubbleOf(page, world.ids.pdf).closest('.msg')!.textContent).toContain('Our access policy, for the cutover night.');
    (open as HTMLButtonElement).click();
    const viewer = page.$('.viewer')!;
    expect(viewer.getAttribute('aria-label')).toBe('staging-check.png');
    expect(viewer.querySelector(`[data-dl="${world.ids.imageFile}"]`)!.getAttribute('aria-label')).toBe('Download staging-check.png');
    (viewer.querySelector('[data-act="close"]') as HTMLButtonElement).click();
    expect(page.$('.viewer')).toBeNull();
  });

  it('an edited message says Edited, and that opens every version', () => {
    const msg = page.$(`#msg-${world.ids.night}`)!;
    expect(msg.textContent).toContain('Thursday after 10 PM Eastern.');
    const edited = msg.parentElement!.querySelector(`[data-hist="${world.ids.night}"]`) as HTMLButtonElement;
    expect(edited.textContent).toBe('Edited');
    edited.click();
    const sheet = page.$('.sheet.hist')!;
    expect(Array.from(sheet.querySelectorAll('.history .bubble')).map((b) => b.textContent)).toEqual(['Thursday after 10 PM Eastern.', 'Wednesday after 10 PM Eastern.']);
    expect(Array.from(sheet.querySelectorAll('.h-when b')).map((b) => b.textContent)).toEqual(['Now, edited', 'First sent']);
    (sheet.querySelector('.x') as HTMLButtonElement).click();
  });

  it('the other party sees the same history', async () => {
    const other = await render(thread(OPEN), world.owner);
    try {
      (other.$(`[data-hist="${world.ids.night}"]`) as HTMLButtonElement).click();
      expect(other.$$('.sheet.hist .history .bubble').map((b) => b.textContent)).toEqual(['Thursday after 10 PM Eastern.', 'Wednesday after 10 PM Eastern.']);
    } finally { other.close(); }
  });

  it('every system event the platform writes reads as a centred line, the pull request linking its page', async () => {
    const done = await render(thread(DONE), world.buyer);
    try {
      const events = done.$$('.event').map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim());
      expect(events).toEqual([
        'Deposit paid, $300',
        'Work ready for your review',
        `${AGENT_NAME} opened a pull request View`,
        'Final payment sent, $900',
        'Pull request merged',
        'Hire complete. You both get a receipt for this job.',
      ]);
      expect(done.$('.event a')!.getAttribute('href')).toBe(`/pullrequest?job=${DONE}`);
    } finally { done.close(); }
  });
});

// ------------------------------------------------------------------ Make 8

describe('the pinned strip: where the hire is, five steps, one next step for this seat', () => {
  const cases = [
    ['proposed, the hirer', OPEN, 'buyer', 'Agreeing the quote', 2, 'Review the quote', `/agreement?job=${OPEN}`, false],
    ['proposed, the owner', OPEN, 'owner', 'Agreeing the quote', 2, 'Review the quote', `/agreement?job=${OPEN}`, false],
    ['agreed, the hirer owes the deposit', AGREED, 'buyer', 'Agreed. The deposit starts the work', 2, 'Pay the deposit', `/deposit?job=${AGREED}`, true],
    ['agreed, the owner waits', AGREED, 'owner', 'Agreed. Waiting for the deposit', 2, 'Review the quote', `/agreement?job=${AGREED}`, false],
    ['staged, the hirer reviews', STAGED, 'buyer', 'Work ready for your review', 4, 'Review the work', `/staged?job=${STAGED}`, true],
    ['staged, the owner waits', STAGED, 'owner', "Waiting for the hirer's review", 4, null, null, false],
    ['submitted', SUBMITTED, 'buyer', 'Pull request open', 6, 'Pull request', `/pullrequest?job=${SUBMITTED}`, false],
    ['completed', DONE, 'buyer', 'Complete', 6, 'Receipt', `/v1/credentials/${DONE}`, false],
  ] as const;
  it.each(cases)('%s', async (_label, jobId, who, now, step, text, href, primary) => {
    const page = await render(thread(jobId), who === 'buyer' ? world.buyer : world.owner);
    try {
      expect(page.text('.a-pin .pin-now')).toBe(now);
      const pips = page.$$('.a-pin .pip-row i');
      expect(pips).toHaveLength(5);
      expect(pips.map((p) => p.className)).toEqual([1, 2, 3, 4, 5].map((k) => (k < step ? 'done' : k === step ? 'now' : '')));
      expect(page.$('.a-pin .pip-row')!.getAttribute('aria-label')).toBe(step > 5 ? 'All five steps done' : `Step ${step} of 5`);
      const next = page.$('#pin-next') as HTMLAnchorElement | null;
      if (text === null) {
        expect(next).toBeNull();
      } else {
        expect(next!.textContent).toBe(text);
        expect(next!.getAttribute('href')).toBe(href);
        expect(next!.classList.contains('btn-primary')).toBe(primary);
      }
      expect(page.$$('main .btn-primary').filter((b) => !b.closest('[hidden]')).length).toBeLessThanOrEqual(1);
    } finally { page.close(); }
  });

  it('the step table is job.js\u2019s, status for status', () => {
    const read = (file: string): string => readFileSync(join(repoRoot, 'src/web/public/js/pages', file), 'utf8').match(/var STEP_FOR_STATUS = \{([\s\S]*?)\n {2}\};/)?.[1] ?? '';
    const table = (body: string): Record<string, string> =>
      Object.fromEntries([...body.matchAll(/([a-z_]+):\s*("done"|null|\d)/g)].map((m) => [m[1]!, m[2]!]));
    const mine = table(read('messages.js'));
    expect(Object.keys(mine).length).toBeGreaterThan(10);
    expect(mine).toEqual(table(read('job.js')));
  });
});

// ------------------------------------------------------------------ (d)

describe('(d) writing: every control reaches its route and shows on the page', () => {
  it('Enter sends; Shift+Enter does not', async () => {
    const page = await render(thread(OPEN), world.buyer);
    try {
      type(page, 'First line');
      enter(page, true);
      await wait(300);
      expect((await messagesOf(OPEN)).some((m) => m.body === 'First line')).toBe(false);
      type(page, 'Sent with Enter');
      enter(page);
      expect(await until(() => page.$$('.run.me .bubble').some((b) => b.textContent === 'Sent with Enter'))).toBe(true);
      const row = (await messagesOf(OPEN)).find((m) => m.body === 'Sent with Enter');
      expect(row?.authorParty).toBe('buyer');
      expect((page.$('#cmp') as HTMLTextAreaElement).value).toBe('');
    } finally { page.close(); }
  });

  it('Reply puts up the bar, cancel takes it down, and the sent reply carries replyToId and its quote', async () => {
    const page = await render(thread(OPEN), world.buyer);
    try {
      const menu = openMenu(page, world.ids.thanks);
      (menu.querySelector('[data-act="reply"]') as HTMLButtonElement).click();
      expect(page.text('.replybar b')).toBe(`Replying to @${OWNER_LOGIN}`);
      expect(page.text('.replybar .rb-txt span')).toBe('Thanks, this is a clear brief.');
      (page.$('.replybar [data-act="cancel-reply"]') as HTMLButtonElement).click();
      expect(page.$('.replybar')).toBeNull();

      (openMenu(page, world.ids.thanks).querySelector('[data-act="reply"]') as HTMLButtonElement).click();
      type(page, 'You are welcome.');
      (page.$('#composer') as HTMLFormElement).dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
      expect(await until(() => page.$$('.run.me .quote').some((q) => q.getAttribute('data-jump') === world.ids.thanks))).toBe(true);
      const row = (await messagesOf(OPEN)).find((m) => m.body === 'You are welcome.');
      expect(row?.replyToId).toBe(world.ids.thanks);
      expect(page.$('.replybar')).toBeNull();
    } finally { page.close(); }
  });

  it('my own recent message can be edited, the edit reaches PATCH, and Edited appears', async () => {
    const page = await render(thread(OPEN), world.buyer);
    try {
      type(page, 'Around 9 PM works');
      enter(page);
      await until(() => page.$$('.run.me .bubble').some((b) => b.textContent === 'Around 9 PM works'));
      const sent = (await messagesOf(OPEN)).find((m) => m.body === 'Around 9 PM works')!;
      const menu = openMenu(page, sent.id);
      expect(menu.querySelector('.tb-foot')!.textContent).toBe("Messages can't be unsent. They are the record of this hire. You can edit one for 15 minutes.");
      expect(Array.from(menu.querySelectorAll('.tb-acts button')).map((b) => b.textContent)).toEqual(['Reply', 'Edit', 'Copy']);
      (menu.querySelector('[data-act="edit"]') as HTMLButtonElement).click();
      expect(page.text('.replybar b')).toBe('Editing your message');
      expect((page.$('#cmp') as HTMLTextAreaElement).value).toBe('Around 9 PM works');
      type(page, 'Around 10 PM works');
      enter(page);
      expect(await until(() => page.$(`[data-hist="${sent.id}"]`) !== null)).toBe(true);
      expect(bubbleOf(page, sent.id).textContent).toBe('Around 10 PM works');
      const after = (await messagesOf(OPEN)).find((m) => m.id === sent.id)!;
      expect(after.body).toBe('Around 10 PM works');
      expect(after.editHistory.map((e: { body: string }) => e.body)).toEqual(['Around 9 PM works']);
    } finally { page.close(); }
  });

  it('the other party\u2019s message and an old one of mine offer no Edit', async () => {
    const page = await render(thread(OPEN), world.buyer);
    try {
      const theirs = openMenu(page, world.ids.thanks);
      expect(theirs.querySelector('[data-act="edit"]')).toBeNull();
      expect(theirs.querySelector('.tb-foot')).toBeNull();
      page.document.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      // the quote card is the platform's row: nothing to edit or copy
      const card = openMenu(page, world.ids.quote2);
      expect(card.querySelector('[data-act="edit"]')).toBeNull();
      expect(card.querySelector('[data-act="copy"]')).toBeNull();
    } finally { page.close(); }
  });

  it('a tapback sets my reaction, another replaces it, the same one again removes it', async () => {
    const page = await render(thread(OPEN), world.buyer);
    const reaction = async (): Promise<string | null> => (await messagesOf(OPEN)).find((m) => m.id === world.ids.question)!.reactions.buyer;
    try {
      (openMenu(page, world.ids.question).querySelector('[aria-label="Thumbs up"]') as HTMLButtonElement).click();
      expect(await until(() => page.$(`#msg-${world.ids.question} .react.mine`) !== null)).toBe(true);
      expect(await reaction()).toBe('\uD83D\uDC4D');
      const menu = openMenu(page, world.ids.question);
      expect(menu.querySelector('[aria-label="Thumbs up"]')!.getAttribute('aria-pressed')).toBe('true');
      (menu.querySelector('[aria-label="Heart"]') as HTMLButtonElement).click();
      expect(await until(() => page.text(`#msg-${world.ids.question} .react.mine`) === '\u2764\uFE0F')).toBe(true);
      expect(await reaction()).toBe('\u2764\uFE0F');
      (openMenu(page, world.ids.question).querySelector('[aria-label="Heart"]') as HTMLButtonElement).click();
      expect(await until(() => page.$(`#msg-${world.ids.question} .react.mine`) === null)).toBe(true);
      expect(await reaction()).toBeNull();
    } finally { page.close(); }
  });

  it('any emoji from the sheet, and Remove from who reacted', async () => {
    const page = await render(thread(OPEN), world.buyer);
    const reaction = async (): Promise<string | null> => (await messagesOf(OPEN)).find((m) => m.id === world.ids.thanks)!.reactions.buyer;
    try {
      (openMenu(page, world.ids.thanks).querySelector('[data-act="emoji"]') as HTMLButtonElement).click();
      const sheet = page.$('.sheet.emoji')!;
      expect(sheet.querySelector('h2')!.textContent).toBe('React with any emoji');
      const search = sheet.querySelector('#emq') as HTMLInputElement;
      search.value = 'rocket';
      search.dispatchEvent(new page.window.Event('input', { bubbles: true }));
      const shown = Array.from(sheet.querySelectorAll('.emoji-group [data-tap]')).filter((b) => !(b as HTMLElement).hidden);
      expect(shown.map((b) => b.getAttribute('data-tap'))).toEqual(['\uD83D\uDE80']);
      (shown[0] as HTMLButtonElement).click();
      expect(await until(() => page.text(`#msg-${world.ids.thanks} .react.mine`) === '\uD83D\uDE80')).toBe(true);
      expect(await reaction()).toBe('\uD83D\uDE80');
      (page.$(`#msg-${world.ids.thanks} .react.mine`) as HTMLButtonElement).click();
      (page.$('.sheet.who [data-act="unreact"]') as HTMLButtonElement).click();
      expect(await until(() => page.$(`#msg-${world.ids.thanks} .react.mine`) === null)).toBe(true);
      expect(await reaction()).toBeNull();
    } finally { page.close(); }
  });

  it('the composer\u2019s emoji button inserts into the message instead of reacting', async () => {
    const page = await render(thread(OPEN), world.buyer);
    try {
      type(page, 'Sounds good ');
      (page.$('[data-act="emoji-compose"]') as HTMLButtonElement).click();
      expect(page.text('.sheet.emoji h2')).toBe('Insert an emoji');
      (page.$('.sheet.emoji [data-tap="\uD83D\uDC4D"]') as HTMLButtonElement).click();
      expect((page.$('#cmp') as HTMLTextAreaElement).value).toBe('Sounds good \uD83D\uDC4D');
      expect(page.$('.sheet')).toBeNull();
    } finally { page.close(); }
  });

  it('a half-written message survives leaving the thread and coming back, per hire', async () => {
    const page = await render(thread(OPEN), world.buyer);
    try {
      type(page, 'Half a thought');
      (page.$('#conv-back') as HTMLAnchorElement).click();
      await until(() => page.$('#cmp') === null);
      (page.$(`.convlist a[data-job="${STAGED}"]`) as HTMLAnchorElement).click();
      await until(() => page.$('#cmp') !== null);
      expect((page.$('#cmp') as HTMLTextAreaElement).value).toBe('');
      (page.$(`.convlist a[data-job="${OPEN}"]`) as HTMLAnchorElement).click();
      expect(await until(() => (page.$('#cmp') as HTMLTextAreaElement | null)?.value === 'Half a thought')).toBe(true);
      type(page, '');
    } finally { page.close(); }
  });

  it('typing is sent at most once every 3 seconds', async () => {
    const page = await render(thread(OPEN), world.buyer);
    try {
      type(page, 'a');
      type(page, 'ab');
      type(page, 'abc');
      await wait(200);
      expect(page.calls.filter((c) => c === `POST /jobs/${OPEN}/typing`)).toHaveLength(1);
      type(page, '');
    } finally { page.close(); }
  });

  it('nothing anywhere offers to delete or unsend', async () => {
    const page = await render(thread(OPEN), world.buyer);
    try {
      const words = page.document.body.textContent ?? '';
      openMenu(page, world.ids.night);
      const menuWords = page.$('.tbmenu')!.textContent ?? '';
      expect(`${words} ${menuWords}`).not.toMatch(/\b(delete|unsend|recall)\b/i);
      expect(page.$$('[data-act]').map((b) => b.getAttribute('data-act'))).not.toContain('delete');
    } finally { page.close(); }
  });
});

// ------------------------------------------------------------------ (e)

describe('(e) live, without a reload', () => {
  it('over the stream: the other party\u2019s message, their typing, and Read once they read', async () => {
    const page = await render(thread(OPEN), world.buyer);
    try {
      const note = `Live note ${Date.now()}`;
      expect((await asParty(world, world.owner, 'POST', `/jobs/${OPEN}/messages`, { body: note })).status).toBe(201);
      expect(await until(() => page.$$('.run.them .bubble').some((b) => b.textContent === note))).toBe(true);

      expect((await asParty(world, world.owner, 'POST', `/jobs/${OPEN}/typing`, {})).status).toBe(204);
      expect(await until(() => page.$('.run.them.typing [role="status"]') !== null)).toBe(true);
      expect(page.$('.typing [role="status"]')!.getAttribute('aria-label')).toBe(`@${OWNER_LOGIN} is typing`);

      type(page, 'Did you get that?');
      enter(page);
      expect(await until(() => page.text('[data-rcpt]') === 'Delivered')).toBe(true);
      expect((await asParty(world, world.owner, 'POST', `/jobs/${OPEN}/messages/read`, {})).status).toBe(200);
      expect(await until(() => page.$('[data-rcpt] .rd b')?.textContent === 'Read')).toBe(true);
      // one receipt, under my latest message only
      expect(page.$$('[data-rcpt]')).toHaveLength(1);
    } finally { page.close(); }
  });

  it('opening a thread marks it read for my seat, and the nav badge follows', async () => {
    await asParty(world, world.buyer, 'POST', `/jobs/${SUBMITTED}/messages`, { body: 'Checking in on the review.' });
    const before = await threadsOf(world.owner, OWNER_DID);
    expect(before.threads.find((t) => t.jobId === SUBMITTED)!.unreadCount).toBeGreaterThan(0);
    const page = await render(thread(SUBMITTED), world.owner);
    try {
      await wait(600);
      const after = await threadsOf(world.owner, OWNER_DID);
      expect(after.threads.find((t) => t.jobId === SUBMITTED)!.unreadCount).toBe(0);
      expect(page.$(`.convlist a[data-job="${SUBMITTED}"]`)!.closest('li')!.classList.contains('unread')).toBe(false);
      const badge = page.$('#nav-messages .badge');
      if (after.unreadTotal > 0) expect(badge!.textContent).toBe(String(after.unreadTotal));
      else expect(badge).toBeNull();
    } finally { page.close(); }
  });

  it('when the stream is refused, the 10 second poll brings the message in', async () => {
    const page = await render(thread(OPEN), world.buyer, { refuseStream: true });
    try {
      const note = `Polled note ${Date.now()}`;
      await asParty(world, world.owner, 'POST', `/jobs/${OPEN}/messages`, { body: note });
      await wait(1500);
      expect(page.$$('.run.them .bubble').some((b) => b.textContent === note), 'arrived before any poll: the stream was not refused').toBe(false);
      expect(await until(() => page.$$('.run.them .bubble').some((b) => b.textContent === note), 11_000)).toBe(true);
      expect(page.calls.filter((c) => c === `GET /jobs/${OPEN}/messages`).length).toBeGreaterThanOrEqual(2);
    } finally { page.close(); }
  }, 20_000);
});

// ------------------------------------------------------------------ (f)

describe('(f) a finished hire is read only', () => {
  it('the composer is replaced by the quiet line, and nothing offers a write', async () => {
    const page = await render(thread(DONE), world.buyer);
    try {
      expect(page.text('.closedline')).toBe('This hire is complete, so the conversation is read only. It stays here for both of you.');
      expect(page.$('#cmp')).toBeNull();
      expect(page.$('[data-act="attach"]')).toBeNull();
      expect(page.$$('.reactbtn')).toHaveLength(0);
      bubbleOf(page, world.ids.doneThanks).dispatchEvent(new page.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      expect(page.$('.tbmenu')).toBeNull();
      (page.$(`#msg-${world.ids.doneThanks} .react`) as HTMLButtonElement).click();
      expect(page.$('.sheet.who')).not.toBeNull();
      expect(page.$('.sheet.who [data-act="unreact"]')).toBeNull();
      const writes = page.calls.filter((c) => /^(POST|PATCH|DELETE) /.test(c) && !c.endsWith('/messages/read'));
      expect(writes).toEqual([]);
    } finally { page.close(); }
  });
});

// ------------------------------------------------------------------ (g)

describe('(g) files', () => {
  it('an image with no words sends as a message of its own', async () => {
    const page = await render(thread(OPEN), world.buyer);
    try {
      const before = (await messagesOf(OPEN)).length;
      pick(page, 'pick-image', 'cutover-plan.png', new Uint8Array(world.png), 'image/png');
      expect(page.text('[data-up-label]')).toMatch(/^Uploading, \d+%$/);
      const ok = await until(() => page.$$('.run.me .bubble.img .imgopen').some((b) => b.getAttribute('aria-label') === 'Open cutover-plan.png full size'), 5000);
      expect(ok).toBe(true);
      const rows = await messagesOf(OPEN);
      expect(rows.length).toBe(before + 1);
      const sent = rows[rows.length - 1]!;
      expect(sent.body).toBe('');
      expect(sent.attachments).toHaveLength(1);
      expect(page.$('[data-upload]')).toBeNull();
    } finally { page.close(); }
  });

  it.each([
    ['a 12 MB image', 'huge-screenshot.png', 12 * 1024 * 1024, 'image/png', 'pick-image'],
    ['a .sql file', 'staging-dump.sql', 2048, 'application/sql', 'pick-pdf'],
  ] as const)('%s gets the notice and uploads nothing', async (_label, name, size, mime, input) => {
    const page = await render(thread(OPEN), world.buyer);
    try {
      const before = (await world.attachments.listByJobId(OPEN)).length;
      pick(page, input, name, new Uint8Array(size), mime);
      await wait(400);
      expect(page.text('.notice[role="alert"] .nt')).toBe(`${name} can't be sent here. You can send images and PDFs up to 10 MB. For anything else, paste a link, like Google Drive or Figma.`);
      expect(page.$('[data-upload]')).toBeNull();
      expect((await world.attachments.listByJobId(OPEN)).length).toBe(before);
      (page.$('.notice [data-act="dismiss"]') as HTMLButtonElement).click();
      expect(page.$('.notice')).toBeNull();
    } finally { page.close(); }
  });

  it('cancel stops an upload and sends nothing', async () => {
    const page = await render(thread(OPEN), world.buyer);
    try {
      const before = (await world.attachments.listByJobId(OPEN)).length;
      const msgsBefore = (await messagesOf(OPEN)).length;
      pick(page, 'pick-pdf', 'plan.pdf', new Uint8Array(world.pdf), 'application/pdf');
      const cancel = page.$('[data-upload] .cancel') as HTMLButtonElement;
      expect(cancel.getAttribute('aria-label')).toBe('Cancel the upload');
      cancel.click();
      expect(page.$('[data-upload]')).toBeNull();
      await wait(600);
      expect((await world.attachments.listByJobId(OPEN)).length).toBe(before);
      expect((await messagesOf(OPEN)).length).toBe(msgsBefore);
    } finally { page.close(); }
  });

  it('the attach menu names what can be sent, and each choice opens its picker', async () => {
    const page = await render(thread(OPEN), world.buyer);
    try {
      const attach = page.$('[data-act="attach"]') as HTMLButtonElement;
      attach.click();
      expect(attach.getAttribute('aria-expanded')).toBe('true');
      expect(page.$$('.attachmenu button').map((b) => (b.textContent ?? '').trim())).toEqual(['Photo or imageJPG, PNG, WebP or HEIC, up to 10 MB', 'PDFUp to 10 MB']);
      expect(page.text('.attachmenu .am-foot')).toBe('Anything else, paste a link.');
      let opened = '';
      (page.$('#pick-pdf') as HTMLInputElement).click = () => { opened = 'pdf'; };
      (page.$('.attachmenu [data-act="pick-pdf"]') as HTMLButtonElement).click();
      expect(opened).toBe('pdf');
      expect(attach.getAttribute('aria-expanded')).toBe('false');
    } finally { page.close(); }
  });
});

// ------------------------------------------------------------------ (h)

describe('(h) the ways in', () => {
  it('the nav on another page reads Messages with the live unread total', async () => {
    await asParty(world, world.owner, 'POST', `/jobs/${STAGED}/messages`, { body: 'Ready when you are.' });
    const api = await threadsOf(world.buyer, BUYER_DID);
    expect(api.unreadTotal).toBeGreaterThan(0);
    const page = await render('/browse', world.buyer);
    try {
      expect(await until(() => page.$('#nav-messages .badge') !== null)).toBe(true);
      const link = page.$('#nav-messages')!;
      expect(link.getAttribute('href')).toBe('/messages');
      expect(link.firstChild!.textContent).toBe('Messages');
      expect(link.querySelector('.badge')!.textContent).toBe(String(api.unreadTotal));
      expect(link.getAttribute('aria-label')).toBe(`Messages, ${api.unreadTotal} unread`);
    } finally { page.close(); }
  });

  it('job.html shows one quiet Messages link to a party, and none to anyone else', async () => {
    for (const [session, shown] of [[world.buyer, true], [world.owner, true], [world.stranger, false], [null, false]] as const) {
      const page = await render(`/jobs/${OPEN}`, session);
      try {
        await until(() => page.$('#messages-cta')!.hidden === !shown, 1500);
        expect(page.$('#messages-cta')!.hidden).toBe(!shown);
        if (shown) {
          const link = page.$('#messages-link')!;
          expect(link.textContent).toBe('Messages');
          expect(link.getAttribute('href')).toBe(`/messages?job=${OPEN}`);
          expect(link.classList.contains('btn-primary')).toBe(false);
        }
      } finally { page.close(); }
    }
  });

  it('operatorjob.html links the owner to this hire\u2019s conversation', async () => {
    const page = await render(`/operatorjob?job=${STAGED}`, world.owner);
    try {
      await until(() => page.$('#operatorjob-body')!.hidden === false, 2000);
      const link = page.$('#messages-link')!;
      expect(link.textContent).toBe('Message the hirer');
      expect(link.getAttribute('href')).toBe(`/messages?job=${STAGED}`);
    } finally { page.close(); }
  });

  it('each link lands on a page that opens that thread', async () => {
    const res = await fetch(`${world.baseUrl}/messages?job=${STAGED}`, { headers: { Accept: HTML } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('/js/pages/messages.js');
  });
});

// ------------------------------------------------------------------ (j)

// S1's machine-word lists, pinned against S1's own file below.
const JARGON = ['credential', 'credentials', 'attestation', 'attested', 'hash', 'hashes', 'Ed25519', 'settlement', 'settle', 'settles', 'settled', 'rail', 'rails', 'specHash', 'diffHash'];
const JARGON_EXACT = ['DID', 'DIDs'];
const DID_STRING = /\bdid:[a-z0-9]+:/i;
function machineWords(text: string): string[] {
  const found = [
    ...JARGON.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(text)),
    ...JARGON_EXACT.filter((w) => new RegExp(`\\b${w}\\b`).test(text)),
  ];
  if (DID_STRING.test(text)) found.push('a DID string');
  for (const id of IDENTITIES) {
    const suffix = id.replace(/^did:[a-z0-9]+:/i, '');
    if (text.includes(id) || text.includes(suffix)) found.push(`the identity ${id}`);
  }
  if (/[\u2013\u2014]/.test(text)) found.push('a dash');
  return found;
}

describe('(j) plain words only', () => {
  it('the lists here are S1\u2019s lists, word for word', () => {
    const s1 = readFileSync(join(here, 'hire-journey-simple.test.ts'), 'utf8');
    const list = (name: string): string[] =>
      [...(s1.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
    expect(list('JARGON')).toEqual(JARGON);
    expect(list('JARGON_EXACT')).toEqual(JARGON_EXACT);
  });

  it('the gate says no to a planted DID and a planted word', () => {
    expect(machineWords(`You are talking with ${OWNER_DID}`)).not.toEqual([]);
    expect(machineWords('Deposit settled on the rail')).not.toEqual([]);
    expect(machineWords('The agent did the work.')).toEqual([]);
  });

  it.each([
    ['the list, the hirer', '/messages', 'buyer'],
    ['a thread mid-negotiation, the hirer', thread(OPEN), 'buyer'],
    ['a thread mid-negotiation, the owner', thread(OPEN), 'owner'],
    ['a finished thread', thread(DONE), 'buyer'],
  ] as const)('%s', async (_label, path, who) => {
    const page = await render(path, who === 'buyer' ? world.buyer : world.owner);
    try {
      const labels = page.$$('main [aria-label]').map((n) => n.getAttribute('aria-label') ?? '').join(' ');
      const text = `${page.$('main')!.textContent ?? ''} ${labels} ${page.document.title}`;
      expect(text.trim().length).toBeGreaterThan(40);
      expect(machineWords(text)).toEqual([]);
      if (path.includes('job=')) {
        const hist = page.$('[data-hist]') as HTMLButtonElement | null;
        if (hist) { hist.click(); expect(machineWords(page.$('.ovl')!.textContent ?? '')).toEqual([]); }
      }
    } finally { page.close(); }
  });
});

// ------------------------------------------------------------------ (i)

interface Measure {
  sw: number; cw: number;
  overflow: string[]; sideways: string[]; tap: string[];
}
const MEASURE = `
(function () {
  var vw = document.documentElement.clientWidth;
  function name(el) { var c = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).join('.') : ''; return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (c ? '.' + c : ''); }
  function hidden(el) { for (var p = el; p && p !== document; p = p.parentElement) { var s = getComputedStyle(p); if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return true; } return false; }
  var out = { sw: document.documentElement.scrollWidth, cw: vw, overflow: [], sideways: [], tap: [] };
  var all = document.querySelectorAll('main *, .ovl *');
  for (var i = 0; i < all.length; i++) {
    var el = all[i], r = el.getBoundingClientRect();
    if (!r.width || !r.height || hidden(el)) continue;
    var clipped = false;
    for (var c = el.parentElement; c && c !== document.body; c = c.parentElement) {
      if (getComputedStyle(c).overflowX !== 'visible') { var cr = c.getBoundingClientRect(); clipped = cr.left >= -0.5 && cr.right <= vw + 0.5; break; }
    }
    if (!clipped && (r.right > vw + 0.5 || r.left < -0.5)) out.overflow.push(name(el) + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
    var ox = getComputedStyle(el).overflowX;
    if ((ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth + 1) out.sideways.push(name(el) + ' ' + el.scrollWidth + '>' + el.clientWidth);
  }
  var inter = document.querySelectorAll('main a[href], main button, main textarea, main input, .ovl a[href], .ovl button, .ovl input');
  for (var j = 0; j < inter.length; j++) {
    var e = inter[j];
    if (e.disabled || hidden(e) || e.closest('.liftclone')) continue;
    var s = getComputedStyle(e), b = e.getBoundingClientRect();
    if (!b.width || !b.height) continue;
    var inline = e.tagName === 'A' && s.display === 'inline' && e.parentElement && /\\S/.test((e.parentElement.textContent || '').replace(e.textContent, ''));
    if (inline) continue;
    if (b.width < 43.5 || b.height < 43.5) out.tap.push((e.getAttribute('aria-label') || (e.textContent || '').trim().slice(0, 30) || name(e)) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height));
  }
  return out;
})()`;

interface View { width: number; height: number; touch: boolean }
const PHONE_320: View = { width: 320, height: 700, touch: true };
const PHONE_390: View = { width: 390, height: 844, touch: true };
const DESKTOP: View = { width: 1280, height: 860, touch: false };
const captureDir = process.env.MSG1B_CAPTURE_DIR;

async function chrome(view: View, session: Session, reduce: boolean): Promise<RealBrowser> {
  const b = await RealBrowser.launch({ width: view.width, height: view.height });
  await b.send('Emulation.setDeviceMetricsOverride', { width: view.width, height: view.height, deviceScaleFactor: 2, mobile: view.touch });
  await b.send('Emulation.setTouchEmulationEnabled', { enabled: view.touch });
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }] });
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(session))});` });
  return b;
}
async function shot(b: RealBrowser, view: View, state: string): Promise<void> {
  if (!captureDir || view.width === 320) return;
  mkdirSync(captureDir, { recursive: true });
  const res = await b.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(captureDir, `${view.width}-${state}.png`), Buffer.from(String((res.result as { data: string }).data), 'base64'));
}
async function gate(b: RealBrowser, view: View, state: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 450));
  const m = await b.evaluate<Measure>(MEASURE);
  expect(m.sw, `${view.width} ${state}: the page scrolls sideways`).toBe(m.cw);
  expect(m.overflow, `${view.width} ${state}: past the edge`).toEqual([]);
  expect(m.sideways, `${view.width} ${state}: a box scrolls sideways`).toEqual([]);
  if (view.touch) expect(m.tap, `${view.width} ${state}: under 44px`).toEqual([]);
  await shot(b, view, state);
}
const js = (b: RealBrowser, expr: string): Promise<unknown> => b.evaluate(expr);
const close = (b: RealBrowser): Promise<unknown> => js(b, "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");

describe('(i) in real Chrome', () => {
  it.each([[PHONE_320], [PHONE_390], [DESKTOP]] as const)('%o: the list, a thread and every open state fit, and every control is 44px on touch', async (view) => {
    if (!hasRealBrowser()) { console.warn('no Chrome found; skipping (see CHROME_BIN)'); return; }
    const b = await chrome(view, world.buyer, false);
    try {
      await b.goto(`${world.baseUrl}/messages`, 1500);
      await gate(b, view, 'list');

      await b.goto(`${world.baseUrl}${thread(OPEN)}`, 1800);
      const shape = await b.evaluate<{ inThread: boolean; navShown: boolean; bar: boolean }>(`({
        inThread: document.body.classList.contains('in-thread'),
        navShown: getComputedStyle(document.querySelector('nav.nav')).display !== 'none',
        bar: !!document.querySelector('.a-bar') && getComputedStyle(document.querySelector('.a-bar')).display !== 'none'
      })`);
      expect(shape.inThread && shape.bar).toBe(true);
      expect(shape.navShown, 'the thread\u2019s own bar replaces the site header on a phone only').toBe(!view.touch);
      await gate(b, view, 'thread');

      await js(b, `document.querySelector('#msg-${world.ids.counter} [data-msg]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`);
      expect(await js(b, "!!document.querySelector('.tbmenu')")).toBe(true);
      await gate(b, view, 'tapback-menu');
      await js(b, "document.querySelector('.tbmenu [data-act=emoji]').click()");
      await gate(b, view, 'emoji-sheet');
      await close(b);
      await js(b, `document.querySelector('#msg-${world.ids.counter} .react').click()`);
      await gate(b, view, 'who-reacted');
      await close(b);
      await js(b, `document.querySelector('[data-hist="${world.ids.night}"]').click()`);
      await gate(b, view, 'history-sheet');
      await close(b);
      await js(b, `document.querySelector('[data-view="${world.ids.imageFile}"]').click()`);
      await new Promise((r) => setTimeout(r, 600));
      expect(await js(b, "(document.querySelector('.viewer img') || {}).naturalWidth > 0")).toBe(true);
      await gate(b, view, 'viewer');
      await close(b);
      await js(b, "document.querySelector('[data-act=attach]').click()");
      await gate(b, view, 'attach-menu');
      await close(b);
      await js(b, `(function () { var m = document.querySelector('#msg-${world.ids.thanks} [data-msg]'); m.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); document.querySelector('.tbmenu [data-act=reply]').click(); })()`);
      await gate(b, view, 'replying');
      await js(b, "document.querySelector('[data-act=cancel-reply]').click()");

      // the thumbnail loaded through the Bearer header, as an object URL
      expect(await js(b, `(document.querySelector('img[data-thumb="${world.ids.imageFile}"]') || {}).src || ''`)).toMatch(/^blob:/);

      // the composer grows with its text and stops at its cap
      const grown = await b.evaluate<number[]>(`(function () {
        var ta = document.getElementById('cmp'); var h0 = ta.getBoundingClientRect().height;
        ta.value = 'one\\ntwo\\nthree'; ta.dispatchEvent(new Event('input', { bubbles: true }));
        var h1 = ta.getBoundingClientRect().height;
        ta.value = new Array(30).join('line\\n'); ta.dispatchEvent(new Event('input', { bubbles: true }));
        var h2 = ta.getBoundingClientRect().height;
        ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true }));
        return [h0, h1, h2];
      })()`);
      expect(grown[0]).toBe(44);
      expect(grown[1]!).toBeGreaterThan(44);
      expect(grown[2]).toBe(132);

      await b.goto(`${world.baseUrl}${thread(DONE)}`, 1500);
      await gate(b, view, 'read-only');

      if (view.touch) {
        // on a phone the back control returns to the list, with the site header
        await js(b, "document.getElementById('conv-back').click()");
        await new Promise((r) => setTimeout(r, 400));
        expect(await js(b, "document.body.classList.contains('show-list') && getComputedStyle(document.querySelector('.a-list')).display !== 'none'")).toBe(true);
      }
    } finally { await b.close(); }
  }, BROWSER_TIMEOUT_MS);

  it('an upload in progress shows the ring, the percentage and cancel, and fits', async () => {
    if (!hasRealBrowser()) return;
    const big = join(tmpdir(), `msg1b-upload-${Date.now()}.png`);
    await sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 128, g: 128, b: 128 }, noise: { type: 'gaussian', mean: 128, sigma: 60 } } }).png().toFile(big);
    for (const view of [PHONE_390, DESKTOP]) {
      const b = await chrome(view, world.buyer, false);
      try {
        await b.goto(`${world.baseUrl}${thread(AGREED)}`, 1500);
        await b.send('Network.enable');
        await b.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: 4_000_000, uploadThroughput: 400_000 });
        await b.send('DOM.enable');
        const doc = await b.send('DOM.getDocument');
        const found = await b.send('DOM.querySelector', { nodeId: (doc.result as { root: { nodeId: number } }).root.nodeId, selector: '#pick-image' });
        await b.send('DOM.setFileInputFiles', { files: [big], nodeId: (found.result as { nodeId: number }).nodeId });
        await new Promise((r) => setTimeout(r, 2500));
        const up = await b.evaluate<{ label: string; ring: boolean; cancel: number }>(`({
          label: (document.querySelector('[data-up-label]') || {}).textContent || '',
          ring: !!document.querySelector('[data-upload] .ring'),
          cancel: (document.querySelector('[data-upload] .cancel') || { getBoundingClientRect: function () { return { width: 0 }; } }).getBoundingClientRect().width
        })`);
        expect(up.label).toMatch(/^Uploading, \d+%$/);
        expect(up.ring).toBe(true);
        expect(up.cancel).toBeGreaterThanOrEqual(44);
        await gate(b, view, 'uploading');
        await js(b, "document.querySelector('[data-upload] .cancel').click()");
        expect(await js(b, "document.querySelector('[data-upload]') === null")).toBe(true);
      } finally { await b.close(); }
    }
  }, BROWSER_TIMEOUT_MS);

  it('at 390: 17px bubble text and 2px between grouped bubbles', async () => {
    if (!hasRealBrowser()) return;
    const b = await chrome(PHONE_390, world.buyer, true);
    try {
      await b.goto(`${world.baseUrl}${thread(OPEN)}`, 1800);
      const m = await b.evaluate<{ sizes: string[]; gaps: number[] }>(`(function () {
        var sizes = [].map.call(document.querySelectorAll('.thread .bubble:not(.img):not(.file)'), function (b) { return getComputedStyle(b).fontSize; });
        var gaps = [];
        [].forEach.call(document.querySelectorAll('.thread .run'), function (run) {
          var kids = [].slice.call(run.children);
          for (var i = 1; i < kids.length; i++) {
            var a = kids[i - 1], c = kids[i];
            if (!a.classList.contains('msg') || !c.classList.contains('msg') || c.classList.contains('has-react')) continue;
            gaps.push(Math.round((c.getBoundingClientRect().top - a.getBoundingClientRect().bottom) * 10) / 10);
          }
        });
        return { sizes: sizes, gaps: gaps };
      })()`);
      expect(m.sizes.length).toBeGreaterThan(5);
      expect([...new Set(m.sizes)]).toEqual(['17px']);
      expect(m.gaps.length, 'the fixture has at least two grouped pairs to measure').toBeGreaterThanOrEqual(2);
      expect([...new Set(m.gaps)]).toEqual([2]);
    } finally { await b.close(); }
  }, BROWSER_TIMEOUT_MS);

  it.each([['reduce'], ['no-preference']] as const)('motion %s: the typing dots and the bubbles are visible, and only no-preference animates', async (pref) => {
    if (!hasRealBrowser()) return;
    const b = await chrome(PHONE_390, world.buyer, pref === 'reduce');
    try {
      await b.goto(`${world.baseUrl}${thread(OPEN)}`, 1800);
      await asParty(world, world.owner, 'POST', `/jobs/${OPEN}/typing`, {});
      await new Promise((r) => setTimeout(r, 500));
      const m = await b.evaluate<{ running: number; dots: number; dotsShown: boolean; bubblesShown: boolean }>(`(function () {
        var dots = [].slice.call(document.querySelectorAll('.typing i'));
        function shown(el) { var r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && parseFloat(s.opacity) > 0.2 && s.visibility !== 'hidden'; }
        return {
          running: document.getAnimations().filter(function (a) { return a.playState === 'running'; }).length,
          dots: dots.length,
          dotsShown: dots.length === 3 && dots.every(shown),
          bubblesShown: [].every.call(document.querySelectorAll('.thread .bubble'), shown)
        };
      })()`);
      expect(m.dots).toBe(3);
      expect(m.dotsShown).toBe(true);
      expect(m.bubblesShown).toBe(true);
      if (pref === 'reduce') expect(m.running, 'an animation runs under reduced motion').toBe(0);
      else expect(m.running, 'the control: with motion allowed the dots animate, so the reduce case can fail').toBeGreaterThan(0);
      await shot(b, PHONE_390, `typing-${pref}`);
    } finally { await b.close(); }
  }, BROWSER_TIMEOUT_MS);
});
