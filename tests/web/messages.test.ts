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
//   (k) real Chrome, real input: each control a person reaches by hand
//       (the react button, a long press, Download, Copy, a click on the
//       backdrop, the browser's Back, Tab and Enter on a bubble, a double
//       click, Escape, coming back to a hidden tab), the page filling the
//       window without scrolling, and the contrast of every piece of text
//       inside my own bubbles
//   (l) GitHub's staging invitation: one line for each seat, the owner's
//       with an https only link to accept it that opens a new tab, an
//       address that is not https drawn with no link, the list and the
//       live region in words, and the owner's line fitting in real Chrome
//       at 320 and 390 with its link 44px on touch
//
// The pinned strip (Make 8) and the step table's equality with job.js are
// pinned too. Set MSG1B_CAPTURE_DIR to a directory to have (i) save a
// screenshot of each state it measures at 390 and 1280.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM, VirtualConsole } from 'jsdom';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../src/adapters/identity/session.js';
import { createSystemMessage } from '../../src/domain/message.js';
import { createJob, isTerminal, type JobStatus } from '../../src/domain/job.js';
import {
  AGENT_DID, AGENT_GITHUB_LOGIN, AGENT_NAME, AGREED, BUYER_DID, BUYER_LOGIN, DONE, IDENTITIES, INVITED, INVITE_LIVE, INVITE_REFUSED, INVITE_URL,
  LONG_BRIEF, OPEN, OWNER_DID, OWNER_LOGIN, REFUSED_URLS, STAGED, SUBMITTED,
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
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
async function untilAsync(check: () => Promise<boolean>, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await wait(100);
  }
  return check();
}

// A row as the API sends it; a test reads the fields it asserts on.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
async function messagesOf(jobId: string): Promise<Row[]> {
  const res = await asParty(world, world.buyer, 'GET', `/jobs/${jobId}/messages`);
  return ((await res.json()) as { messages: Row[] }).messages;
}
async function threadsOf(who: Session, did: string): Promise<{ threads: Row[]; unreadTotal: number }> {
  const res = await asParty(world, who, 'GET', `/accounts/${encodeURIComponent(did)}/threads`);
  return (await res.json()) as { threads: Row[]; unreadTotal: number };
}
// When each seat last read the thread, in ms (0 for never), from the route.
async function lastReadOf(jobId: string, party: 'buyer' | 'agent'): Promise<number> {
  const res = await asParty(world, world.buyer, 'GET', `/jobs/${jobId}/messages/read-state`);
  const at = ((await res.json()) as Record<string, { lastReadAt: string | null }>)[party]?.lastReadAt;
  return at ? Date.parse(at) : 0;
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
// FIX-B53: GitHub's staging invitation, as the thread says it and as the
// list and the live region name it.
const INVITE_SENTENCE = `GitHub invited @${AGENT_GITHUB_LOGIN} to the private staging repository`;
const INVITE_LINK = 'Accept on GitHub';
const INVITE_WORDS = 'GitHub invitation sent';

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
      // the five hires of MSG1b, and FIX-B53's three: INVITED, INVITE_REFUSED
      // and INVITE_LIVE
      expect(rows).toHaveLength(8);
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

  // SW2-09: every message carries a react button, so each one's accessible
  // name says which message it acts on: the author as the thread names
  // them and the message's first words, clipped on a whole word.
  describe('SW2-09: each react button names its message', () => {
    const label = (id: string): string | null => {
      const btn = page.$(`#msg-${id} .reactbtn`);
      expect(btn, `a react button on #msg-${id}`).not.toBeNull();
      return btn!.getAttribute('aria-label');
    };

    it('(b) three messages from two people give three different whole-string names', () => {
      const got = [label(world.ids.thanks), label(world.ids.push), label(world.ids.counter)];
      expect(got).toEqual([
        `React or reply to @${OWNER_LOGIN}: Thanks, this is a clear brief.`,
        'React or reply to You: Could you do $1,100? I can make the',
        `React or reply to @${OWNER_LOGIN}: If you make the snapshot, $1,200 works.`,
      ]);
      expect(new Set(got).size).toBe(3);
      const every = page.$$('.reactbtn').map((b) => b.getAttribute('aria-label'));
      expect(every.length).toBeGreaterThan(3);
      expect(every).not.toContain('React or reply to this message');
    });

    it('(c) a message that is only an image names the attachment kind', () => {
      expect(label(world.ids.image)).toBe(`React or reply to @${OWNER_LOGIN}: Image`);
    });

    it('(d) a long message is clipped on a whole word, never half of one', () => {
      // The body runs on past "My checklist is at https://..."; 40
      // characters end inside "checklist", so the name stops before it.
      expect(label(world.ids.question)).toBe(`React or reply to @${OWNER_LOGIN}: Any extensions besides the defaults? My`);
    });
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
        INVITE_SENTENCE,
        'Work ready for your review',
        `${AGENT_NAME} opened a pull request View`,
        'Final payment sent, $900',
        'Pull request merged',
        'Hire complete. You both get a receipt for this job.',
      ]);
      expect(done.$('.event a')!.getAttribute('href')).toBe(`/pullrequest?job=${DONE}`);
    } finally { done.close(); }
  });

  // M12: the bar's name, its Hire link and a long brief's "Read the whole
  // brief" all go to the hire's own page, which differs by seat.
  it.each([
    ['the hirer', 'buyer', `/jobs/${SUBMITTED}`],
    ['the owner', 'owner', `/operatorjob?job=${SUBMITTED}`],
  ] as const)('%s: the bar\u2019s name, its Hire link and Read the whole brief go to that seat\u2019s page for the hire', async (_label, who, href) => {
    expect(LONG_BRIEF.length, 'the fixture brief must be long enough to be cut').toBeGreaterThan(280);
    const page = await render(thread(SUBMITTED), who === 'buyer' ? world.buyer : world.owner);
    try {
      expect(page.$('.a-bar .who-c')!.getAttribute('href')).toBe(href);
      const info = page.$('.a-bar .end a')!;
      expect(info.getAttribute('aria-label')).toBe('See the hire');
      expect(info.getAttribute('href')).toBe(href);
      const more = page.$('#msg-brief a.more')!;
      expect(more.textContent).toBe('Read the whole brief');
      expect(more.getAttribute('href')).toBe(href);
    } finally { page.close(); }
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

  it('the other party\u2019s message offers no Edit, and the quote card offers no Edit and no Copy', async () => {
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

  // Make 4's "within 15 minutes": the fixture's oldMine is the hirer's own,
  // with words, sent 40 minutes before the world was built.
  it('my own message from more than 15 minutes ago offers Reply and Copy, but no Edit', async () => {
    const old = (await messagesOf(OPEN)).find((m) => m.id === world.ids.oldMine)!;
    expect(old.authorDid).toBe(BUYER_DID);
    expect(old.body).not.toBe('');
    expect(Date.now() - Date.parse(old.createdAt)).toBeGreaterThan(15 * 60 * 1000);
    const page = await render(thread(OPEN), world.buyer);
    try {
      expect(bubbleOf(page, world.ids.oldMine).closest('.run')!.classList.contains('me')).toBe(true);
      const menu = openMenu(page, world.ids.oldMine);
      expect(Array.from(menu.querySelectorAll('.tb-acts button')).map((b) => b.textContent)).toEqual(['Reply', 'Copy']);
      expect(menu.querySelector('.tb-foot')!.textContent).toContain("Messages can't be unsent.");
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
      expect(await until(() => page.$('.run.them.typing .bubble') !== null)).toBe(true);
      expect(page.$$('.typing .bubble i')).toHaveLength(3);
      expect(page.$('.typing .bubble')!.getAttribute('aria-label')).toBe(`@${OWNER_LOGIN} is typing`);
      expect(page.text('#thread-live')).toContain(`@${OWNER_LOGIN} is typing`);

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

  // The poll brings rows in by its own path, so it announces them by its
  // own path too. A reaction changes the row, so the next poll redraws it,
  // and that must not read it out a second time.
  it('when the stream is refused, a row the poll brings in is announced once, and a reaction the next poll brings is not announced', async () => {
    const page = await render(thread(OPEN), world.buyer, { refuseStream: true });
    try {
      const note = `Heard by the poll ${Date.now()}`;
      const sent = (await (await asParty(world, world.owner, 'POST', `/jobs/${OPEN}/messages`, { body: note })).json()) as Row;
      expect(await until(() => page.$$('.run.them .bubble').some((b) => b.textContent === note), 11_000)).toBe(true);
      const lines = (): string[] => page.$$('#thread-live p').map((p) => p.textContent ?? '');
      expect(await until(() => lines().includes(`@${OWNER_LOGIN}: ${note}`))).toBe(true);
      expect((await asParty(world, world.owner, 'POST', `/jobs/${OPEN}/messages/${sent.id}/reactions`, { emoji: '\uD83D\uDC4D' })).status).toBe(200);
      expect(await until(() => page.$(`#msg-${sent.id} .react`) !== null, 11_000), 'the next poll drew the reaction').toBe(true);
      await wait(300);
      expect(lines().filter((l) => l.endsWith(note))).toHaveLength(1);
    } finally { page.close(); }
  }, 30_000);

  // M10: while the thread is open and the page is visible, a row that
  // lands over the stream is marked read at once, not on the next open.
  it('a message that arrives over the stream while I am looking is marked read', async () => {
    const page = await render(thread(OPEN), world.owner);
    const reads = (): number => page.calls.filter((c) => c === `POST /jobs/${OPEN}/messages/read`).length;
    try {
      expect(await until(() => reads() === 1), 'opening the thread marks it read once').toBe(true);
      const note = `Seen as it lands ${Date.now()}`;
      const sent = (await (await asParty(world, world.buyer, 'POST', `/jobs/${OPEN}/messages`, { body: note })).json()) as Row;
      expect(await until(() => page.$$('.run.them .bubble').some((b) => b.textContent === note))).toBe(true);
      expect(await until(() => reads() === 2)).toBe(true);
      expect(await untilAsync(async () => (await lastReadOf(OPEN, 'agent')) >= Date.parse(sent.createdAt))).toBe(true);
    } finally { page.close(); }
  });

  // A live region is read out whenever something is added inside it. The
  // thread is redrawn whole on every change, so if it were one, every
  // typing ping, reaction and receipt would read the conversation out
  // again. This watches every node added inside a live region (aria-live
  // or a live role), and every live region a redraw adds with something
  // already in it, and holds what a screen reader would be handed.
  it('a screen reader hears the other person start typing and each new row, and nothing when a ping, a reaction or a receipt redraws the thread', async () => {
    const page = await render(thread(OPEN), world.buyer);
    const heard: string[] = [];
    let redraws = 0;
    const LIVE = '[aria-live]:not([aria-live="off"]), [role="status"], [role="log"], [role="alert"], [role="marquee"], [role="timer"]';
    const inLive = (node: Node | null): boolean => {
      for (let n = node; n !== null; n = n.parentNode) {
        if (n.nodeType === 1 && (n as Element).matches(LIVE)) return true;
      }
      return false;
    };
    const threadEl = page.$('[data-thread]')!;
    const words = (n: Node): string => (n.textContent ?? '').replace(/\s+/g, ' ').trim();
    const said = (e: Element): string => words(e) || (e.getAttribute('aria-label') ?? '').trim();
    const observer = new page.window.MutationObserver((records) => {
      for (const r of records) {
        if (threadEl.contains(r.target)) redraws += 1;
        if (inLive(r.target)) {
          if (r.type === 'characterData') heard.push(words(r.target));
          r.addedNodes.forEach((n) => { if (words(n)) heard.push(words(n)); });
          continue;
        }
        r.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          const e = n as Element;
          [...(e.matches(LIVE) ? [e] : []), ...Array.from(e.querySelectorAll(LIVE))].forEach((region) => {
            if (said(region)) heard.push(said(region));
          });
        });
      }
    });
    observer.observe(page.document.body, { childList: true, subtree: true, characterData: true });
    const redrawn = async (act: () => Promise<unknown>): Promise<void> => {
      const before = redraws;
      await act();
      expect(await until(() => redraws > before), 'the action redraws the thread, so the check below means something').toBe(true);
      await wait(250);
    };
    const typing = `@${OWNER_LOGIN} is typing`;
    try {
      expect(inLive(threadEl), 'the thread is not itself a live region').toBe(false);
      await redrawn(() => asParty(world, world.owner, 'POST', `/jobs/${OPEN}/typing`, {}));
      expect(heard).toEqual([typing]);
      await redrawn(() => asParty(world, world.owner, 'POST', `/jobs/${OPEN}/typing`, {}));
      await redrawn(() => asParty(world, world.owner, 'POST', `/jobs/${OPEN}/messages/${world.ids.thanks}/reactions`, { emoji: '\uD83D\uDC40' }));
      await redrawn(() => asParty(world, world.owner, 'POST', `/jobs/${OPEN}/messages/read`, {}));
      expect(heard, 'a second ping, a reaction and a receipt are heard as nothing').toEqual([typing]);
      const note = `One more thing ${Date.now()}`;
      await redrawn(() => asParty(world, world.owner, 'POST', `/jobs/${OPEN}/messages`, { body: note }));
      expect(heard).toEqual([typing, `@${OWNER_LOGIN}: ${note}`]);
    } finally {
      observer.disconnect();
      await asParty(world, world.owner, 'DELETE', `/jobs/${OPEN}/messages/${world.ids.thanks}/reactions`);
      page.close();
    }
  });
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

describe('(f2) a hire paid in full that ended with no pull request', () => {
  const PAID_UNDELIVERED = 'msg-job-paid-undelivered';
  beforeAll(async () => {
    const recent = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const base = createJob({ id: PAID_UNDELIVERED, buyerDid: BUYER_DID, agentDid: AGENT_DID, repository: 'buyer/msg-repo', brief: 'Move the backups to the new host.' }, recent);
    await world.jobs.create({
      ...base, status: 'paid_undelivered', priceUsd: '500.00', rail: 'abt',
      priceAcceptedByBuyer: true, priceAcceptedByAgent: true, confirmedAt: recent, confirmedSpecHash: 'sha256:msg-paid-undelivered-spec',
      stagedAt: recent, stagedCommit: 'msgpaidundeliveredcommit',
    });
  });

  it.each([['the hirer', 'buyer'], ['the owner', 'owner']] as const)('%s reads it as ended: the strip in words, no next step, and the read-only line', async (_label, who) => {
    const page = await render(thread(PAID_UNDELIVERED), who === 'buyer' ? world.buyer : world.owner);
    try {
      expect(page.text('.closedline')).toBe('This hire has ended, so the conversation is read only. It stays here for both of you.');
      expect(page.$('#cmp')).toBeNull();
      expect(page.text('.a-pin .pin-now')).toBe('Paid in full, never delivered');
      expect(page.$('#pin-next')).toBeNull();
      expect(page.$$('.a-pin .pip-row')).toHaveLength(0);
    } finally { page.close(); }
  });

  // The page's own list of endings, read from its source the way
  // tests/web/operatorjob-polished.test.ts reads that page's list, held
  // equal to src/domain/job.ts's isTerminal over every JobStatus.
  it('the page\u2019s TERMINAL names exactly the statuses the domain calls terminal', () => {
    const source = readFileSync(join(repoRoot, 'src/web/public/js/pages/messages.js'), 'utf8');
    const block = /var TERMINAL = \{([\s\S]*?)\};/.exec(source)?.[1] ?? '';
    const pageKeys = [...block.matchAll(/([a-z_]+):\s*1/g)].map((m) => m[1] as JobStatus);
    expect(pageKeys.length, 'no keys parsed out of messages.js TERMINAL').toBeGreaterThan(5);
    const every: JobStatus[] = [
      'draft', 'proposed', 'confirmed', 'staged', 'redo_requested', 'submitted',
      'completed', 'declined', 'closed_unmerged', 'stale', 'withdrawn',
      'staged_declined', 'closed_unpaid', 'expired_unstaged', 'deemed_completed', 'cited_closed',
      'paid_undelivered',
    ];
    expect(every, 'the hand list must name all seventeen JobStatus values').toHaveLength(17);
    expect(every.filter((s) => isTerminal(s) !== pageKeys.includes(s)), 'statuses where messages.js and src/domain/job.ts disagree about "finished"').toEqual([]);
  });
});

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
    ['a thread with GitHub\u2019s invitation, the owner', thread(INVITED), 'owner'],
  ] as const)('%s', async (_label, path, who) => {
    const page = await render(path, who === 'buyer' ? world.buyer : world.owner);
    try {
      const labels = page.$$('main [aria-label]').map((n) => n.getAttribute('aria-label') ?? '').join(' ');
      const text = `${page.$('main')!.textContent ?? ''} ${labels} ${page.document.title}`;
      expect(text.trim().length).toBeGreaterThan(40);
      if (path === thread(INVITED)) {
        expect(page.$$('.event').map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()), 'the invitation line is on the page, so the check below reads it')
          .toEqual([`${INVITE_SENTENCE} ${INVITE_LINK}`]);
      }
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
// Re-reads an expression in the page until `ok` holds or the time runs
// out, and returns the last value read.
async function pollIn<T>(b: RealBrowser, expr: string, ok: (v: T) => boolean, ms: number): Promise<T> {
  const end = Date.now() + ms;
  let v = await b.evaluate<T>(expr);
  while (!ok(v) && Date.now() < end) {
    await wait(100);
    v = await b.evaluate<T>(expr);
  }
  return v;
}

// ------------------------------------------------------------------ real input
// Everything below goes through Chrome's own input pipeline (Input.*), so
// the page gets the same events, in the same order, as it would from a
// person: hover before a click, mousedown focusing what it lands on, a
// right click raising contextmenu, a finger held down.
interface Point { x: number; y: number }
// Scrolls the element to the middle of its own scroller and returns its
// centre, after checking that a person pointing there would hit it.
async function aim(b: RealBrowser, selector: string): Promise<Point> {
  const p = await b.evaluate<{ x: number; y: number; hit: boolean } | null>(`(function () {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    var r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    var at = document.elementFromPoint(x, y);
    return { x: x, y: y, hit: !!at && (at === el || el.contains(at)) };
  })()`);
  if (!p) throw new Error(`nothing on the page matches ${selector}`);
  expect(p.hit, `${selector} is covered at its own centre`).toBe(true);
  return { x: p.x, y: p.y };
}
async function mouse(b: RealBrowser, at: Point, opts: { button?: 'left' | 'right'; clicks?: number } = {}): Promise<void> {
  const button = opts.button ?? 'left';
  await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
  for (let n = 1; n <= (opts.clicks ?? 1); n += 1) {
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button, clickCount: n });
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button, clickCount: n });
  }
}
const KEYS: Record<string, { code: string; keyCode: number }> = {
  Tab: { code: 'Tab', keyCode: 9 }, Enter: { code: 'Enter', keyCode: 13 }, Escape: { code: 'Escape', keyCode: 27 },
};
async function press(b: RealBrowser, key: keyof typeof KEYS): Promise<void> {
  const k = KEYS[key]!;
  await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: k.code, windowsVirtualKeyCode: k.keyCode });
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: k.code, windowsVirtualKeyCode: k.keyCode });
}
// What the tapback menu is showing, and for which message.
const MENU = `(function () { var m = document.querySelector('.tbmenu'); return m ? m.getAttribute('data-for') : null; })()`;
const OVERLAY_OPEN = `!!document.querySelector('.ovl .scrim, .ovl .tbmenu, .ovl .sheet')`;

// The contrast of every piece of text inside my own bubbles, from computed
// styles, the way the pixels are actually composited: the text's colour
// with its own alpha, every background under it with theirs, and every
// opacity between them applied to its whole group. A dimmed label, a
// translucent quote, or a faded ancestor all land in the number. Anything
// the arithmetic cannot account for (a background image, a filter, a
// blend mode, a colour it cannot read) is reported instead of guessed at.
interface Contrast { rows: Array<{ text: string; px: number; weight: number; ratio: number; floor: number }>; unmeasurable: string[] }
const CONTRAST = `(function () {
  function parse(s) {
    var m = /^rgba?\\(([^)]*)\\)$/.exec(s);
    if (m) { var p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(parseFloat); return [p[0] / 255, p[1] / 255, p[2] / 255, p.length > 3 ? p[3] : 1]; }
    m = /^color\\(srgb ([^)]*)\\)$/.exec(s);
    if (m) { var q = m[1].split(/[\\s\\/]+/).filter(Boolean).map(parseFloat); return [q[0], q[1], q[2], q.length > 3 ? q[3] : 1]; }
    return null;
  }
  var bad = [];
  function col(s, where) { var c = parse(s); if (!c) { bad.push(where + ': ' + s); return [0, 0, 0, 0]; } return [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]]; }
  function over(t, u) { return [t[0] + u[0] * (1 - t[3]), t[1] + u[1] * (1 - t[3]), t[2] + u[2] * (1 - t[3]), t[3] + u[3] * (1 - t[3])]; }
  function name(e) { return e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).join('.') : ''); }
  // one element's group: its background, then the rest of the chain (or the
  // text) on top, all at the element's own opacity
  function group(chain, i, text) {
    var cs = getComputedStyle(chain[i]);
    if (chain[i].closest('.a-app') && (cs.backgroundImage !== 'none' || cs.filter !== 'none' || cs.mixBlendMode !== 'normal')) bad.push(name(chain[i]) + ': a background image, filter or blend');
    var inner = i + 1 < chain.length ? group(chain, i + 1, text) : (text || [0, 0, 0, 0]);
    var c = over(inner, col(cs.backgroundColor, name(chain[i])));
    var o = parseFloat(cs.opacity);
    return [c[0] * o, c[1] * o, c[2] * o, c[3] * o];
  }
  function lum(c) {
    function ch(v) { return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
  }
  var rows = [];
  [].forEach.call(document.querySelectorAll('.thread .run.me .bubble'), function (bubble) {
    var walk = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
    for (var n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!/\\S/.test(n.nodeValue)) continue;
      var host = n.parentElement, range = document.createRange();
      range.selectNodeContents(n);
      var r = range.getBoundingClientRect(), cs = getComputedStyle(host);
      if (!r.width || !r.height || cs.visibility === 'hidden') continue;
      var chain = [];
      for (var e = host; e; e = e.parentElement) chain.unshift(e);
      var canvas = [1, 1, 1, 1];
      var ink = over(group(chain, 0, col(cs.color, name(host) + ' color')), canvas);
      var paper = over(group(chain, 0, null), canvas);
      var a = lum(ink), b = lum(paper);
      var px = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight, 10);
      var large = px >= 24 || (px >= 18.66 && weight >= 700);
      rows.push({ text: n.nodeValue.trim().slice(0, 40), px: px, weight: weight, ratio: Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100, floor: large ? 3 : 4.5 });
    }
  });
  return { rows: rows, unmeasurable: bad };
})()`;

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

  // M11: the percentage and the ring follow the upload's own progress
  // events. A label stuck at 0% (or jumping straight to 100% on load) fails.
  it('an upload in progress shows the ring, a percentage that climbs past 0, and cancel, and fits', async () => {
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
        const pct = await pollIn(b, `(function () { var l = document.querySelector('[data-up-label]'); var m = l && /^Uploading, (\\d+)%$/.exec(l.textContent); return m ? +m[1] : -1; })()`, (n: number) => n > 0, 6000);
        expect(pct, `${view.width}: the percentage never moved off 0`).toBeGreaterThan(0);
        expect(pct, `${view.width}: the upload finished before it could be seen in flight`).toBeLessThan(100);
        const up = await b.evaluate<{ label: string; offset: number; full: number; cancel: number }>(`({
          label: (document.querySelector('[data-up-label]') || {}).textContent || '',
          offset: parseFloat(document.querySelector('[data-upload] .ring').getAttribute('stroke-dashoffset')),
          full: parseFloat(document.querySelector('[data-upload] .ring').getAttribute('stroke-dasharray')),
          cancel: (document.querySelector('[data-upload] .cancel') || { getBoundingClientRect: function () { return { width: 0 }; } }).getBoundingClientRect().width
        })`);
        expect(up.label).toMatch(/^Uploading, [1-9]\d?%$/);
        expect(up.offset, 'the ring has drawn part of its circle').toBeLessThan(up.full);
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

// ------------------------------------------------------------------ (k)

describe('(k) in real Chrome, by hand', () => {
  const open = async (view: View, who: Session, path: string): Promise<RealBrowser> => {
    const b = await chrome(view, who, true);
    await b.goto(`${world.baseUrl}${path}`, 1800);
    return b;
  };
  const focused = (b: RealBrowser): Promise<unknown> => js(b, "document.activeElement && document.activeElement.getAttribute('data-msg')");

  // M1
  it('with a mouse, the react button beside a bubble shows on hover and opens that message\u2019s menu', async () => {
    if (!hasRealBrowser()) return;
    const id = world.ids.thanks;
    const b = await open(DESKTOP, world.buyer, thread(OPEN));
    try {
      const bubble = await aim(b, `#msg-${id} [data-msg]`);
      await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bubble.x, y: bubble.y });
      expect(await js(b, `getComputedStyle(document.querySelector('#msg-${id} .reactbtn')).opacity`)).toBe('1');
      await mouse(b, await aim(b, `#msg-${id} .reactbtn`));
      expect(await js(b, MENU)).toBe(id);
    } finally { await b.close(); }
  }, BROWSER_TIMEOUT_MS);

  // M2. A quick tap is the control: it must not open anything.
  it('on a phone, a long press opens the bubble\u2019s menu and it stays open when the finger lifts; a quick tap opens nothing', async () => {
    if (!hasRealBrowser()) return;
    const id = world.ids.thanks;
    const b = await open(PHONE_390, world.buyer, thread(OPEN));
    try {
      expect(await js(b, "matchMedia('(pointer: coarse)').matches")).toBe(true);
      const p = await aim(b, `#msg-${id} [data-msg]`);
      await b.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
      await b.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await wait(700);
      expect(await js(b, MENU), 'a quick tap opened the menu').toBeNull();
      await b.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
      await wait(700);
      expect(await js(b, MENU), 'held for 700ms').toBe(id);
      await b.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await wait(400);
      expect(await js(b, MENU), 'after the finger lifts').toBe(id);
    } finally { await b.close(); }
  }, BROWSER_TIMEOUT_MS);

  // M3. B72: Chrome writes <name>.crdownload and, for a moment at the end,
  // both it and the final name sit in the folder together. Stopping at the
  // first sight of the final name could read that moment (main's CI run
  // 36582046456). So this waits on the download's real end: Chrome's own
  // Browser.downloadProgress "completed", then a folder with no partial
  // left in it. The exact listing and the byte check below are unchanged.
  it('with a mouse, a PDF card downloads the file, byte for byte', async () => {
    if (!hasRealBrowser()) return;
    const dir = mkdtempSync(join(tmpdir(), 'msg1b-download-'));
    const b = await chrome(DESKTOP, world.buyer, true);
    try {
      let state = 'none';
      const stop = b.onEvent('Browser.downloadProgress', (p) => { state = (p as { state: string }).state; });
      await b.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true });
      await b.goto(`${world.baseUrl}${thread(OPEN)}`, 1800);
      await mouse(b, await aim(b, `[data-dl="${world.ids.pdfFile}"]`));
      const end = Date.now() + 5000;
      while (Date.now() < end && state !== 'completed' && state !== 'canceled') await wait(50);
      stop();
      expect(state, 'Chrome never reported the download completed').toBe('completed');
      while (Date.now() < end && readdirSync(dir).some((f) => f.endsWith('.crdownload'))) await wait(50);
      expect(readdirSync(dir)).toEqual(['db-access-policy.pdf']);
      expect(readFileSync(join(dir, 'db-access-policy.pdf')).equals(world.pdf)).toBe(true);
    } finally {
      await b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, BROWSER_TIMEOUT_MS);

  // M4. The browser's own clipboard, read back through the page.
  it('with a mouse, Copy in a right click\u2019s menu puts the message\u2019s words on the clipboard and closes the menu', async () => {
    if (!hasRealBrowser()) return;
    const id = world.ids.thanks;
    const b = await chrome(DESKTOP, world.buyer, true);
    try {
      await b.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: world.baseUrl });
      await b.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await b.goto(`${world.baseUrl}${thread(OPEN)}`, 1800);
      await js(b, "navigator.clipboard.writeText('nothing copied yet')");
      await mouse(b, await aim(b, `#msg-${id} [data-msg]`), { button: 'right' });
      expect(await js(b, MENU)).toBe(id);
      await mouse(b, await aim(b, '.tbmenu [data-act="copy"]'));
      const copied = await pollIn(b, 'navigator.clipboard.readText()', (t: string) => t !== 'nothing copied yet', 3000);
      expect(copied).toBe('Thanks, this is a clear brief.');
      expect(await js(b, OVERLAY_OPEN)).toBe(false);
    } finally { await b.close(); }
  }, BROWSER_TIMEOUT_MS);

  // M5
  it('with a mouse, a click on the dimmed backdrop closes the open menu', async () => {
    if (!hasRealBrowser()) return;
    const id = world.ids.thanks;
    const b = await open(DESKTOP, world.buyer, thread(OPEN));
    try {
      await mouse(b, await aim(b, `#msg-${id} [data-msg]`), { button: 'right' });
      expect(await js(b, MENU)).toBe(id);
      const spot = { x: 20, y: DESKTOP.height / 2 };
      expect(await js(b, `document.elementFromPoint(${spot.x}, ${spot.y}).hasAttribute('data-scrim')`), 'the backdrop is what a click there lands on').toBe(true);
      await mouse(b, spot);
      expect(await js(b, OVERLAY_OPEN)).toBe(false);
    } finally { await b.close(); }
  }, BROWSER_TIMEOUT_MS);

  // M6. The marker proves Back stayed in the page (popstate) rather than
  // loading it again, which would pass without the handler.
  it('the browser\u2019s Back button goes back to the conversation before, then to the list, without reloading the page', async () => {
    if (!hasRealBrowser()) return;
    const b = await open(DESKTOP, world.buyer, '/messages');
    const back = async (): Promise<void> => {
      const h = (await b.send('Page.getNavigationHistory')).result as { currentIndex: number; entries: Array<{ id: number }> };
      await b.send('Page.navigateToHistoryEntry', { entryId: h.entries[h.currentIndex - 1]!.id });
      await wait(900);
    };
    const where = `({ search: location.search, same: window.__samePage === true,
      current: (document.querySelector('.convlist a[aria-current]') || { getAttribute: function () { return null; } }).getAttribute('data-job'),
      now: (document.querySelector('.pin-now') || {}).textContent || null,
      none: document.getElementById('conv').classList.contains('is-none') })`;
    try {
      await js(b, 'window.__samePage = true');
      await mouse(b, await aim(b, `.convlist a[data-job="${STAGED}"]`));
      await wait(900);
      await mouse(b, await aim(b, `.convlist a[data-job="${SUBMITTED}"]`));
      await wait(900);
      expect(await js(b, where)).toEqual({ search: `?job=${SUBMITTED}`, same: true, current: SUBMITTED, now: 'Pull request open', none: false });
      await back();
      expect(await js(b, where)).toEqual({ search: `?job=${STAGED}`, same: true, current: STAGED, now: 'Work ready for your review', none: false });
      await back();
      expect(await js(b, where)).toEqual({ search: '', same: true, current: null, now: null, none: true });
    } finally { await b.close(); }
  }, BROWSER_TIMEOUT_MS);

  // M7
  it('with the keyboard, Tab reaches the first bubble and Enter opens its menu', async () => {
    if (!hasRealBrowser()) return;
    const b = await open(DESKTOP, world.buyer, thread(OPEN));
    try {
      const id = await js(b, "document.querySelector('.thread [data-msg][tabindex=\"0\"]').getAttribute('data-msg')");
      expect(id).toBe(world.ids.oldMine);
      await js(b, "document.getElementById('pin-next').focus()");
      await press(b, 'Tab');
      expect(await focused(b)).toBe(id);
      await press(b, 'Enter');
      expect(await js(b, MENU)).toBe(id);
    } finally { await b.close(); }
  }, BROWSER_TIMEOUT_MS);

  // M8
  it('with a mouse, a double click on a bubble opens its menu', async () => {
    if (!hasRealBrowser()) return;
    const id = world.ids.thanks;
    const b = await open(DESKTOP, world.buyer, thread(OPEN));
    try {
      const p = await aim(b, `#msg-${id} [data-msg]`);
      await mouse(b, p);
      expect(await js(b, MENU), 'a single click opens nothing').toBeNull();
      await mouse(b, p, { clicks: 2 });
      expect(await js(b, MENU)).toBe(id);
    } finally { await b.close(); }
  }, BROWSER_TIMEOUT_MS);

  // M9
  it('Escape closes the open menu and puts focus back on the bubble it was opened from', async () => {
    if (!hasRealBrowser()) return;
    const id = world.ids.thanks;
    const b = await open(DESKTOP, world.buyer, thread(OPEN));
    try {
      await mouse(b, await aim(b, `#msg-${id} [data-msg]`), { button: 'right' });
      expect(await js(b, MENU)).toBe(id);
      expect(await js(b, "!!document.activeElement.closest('.tbmenu')"), 'focus moved into the menu').toBe(true);
      await press(b, 'Escape');
      expect(await js(b, OVERLAY_OPEN)).toBe(false);
      expect(await focused(b)).toBe(id);
    } finally { await b.close(); }
  }, BROWSER_TIMEOUT_MS);

  // M13. Another tab in front hides this one; closing it brings this one
  // back, the way switching tabs does.
  it('a message that lands while the tab is hidden stays unread until the tab is shown again, then is marked read', async () => {
    if (!hasRealBrowser()) return;
    const b = await open(DESKTOP, world.owner, thread(OPEN));
    try {
      const other = (await b.send('Target.createTarget', { url: 'about:blank' })).result as { targetId: string };
      expect(await pollIn(b, 'document.visibilityState', (s: string) => s === 'hidden', 3000)).toBe('hidden');
      const note = `While you were away ${Date.now()}`;
      const sent = (await (await asParty(world, world.buyer, 'POST', `/jobs/${OPEN}/messages`, { body: note })).json()) as Row;
      await wait(1200);
      expect(await lastReadOf(OPEN, 'agent'), 'marked read while hidden').toBeLessThan(Date.parse(sent.createdAt));
      await b.send('Target.closeTarget', { targetId: other.targetId });
      expect(await pollIn(b, 'document.visibilityState', (s: string) => s === 'visible', 3000)).toBe('visible');
      expect(await untilAsync(async () => (await lastReadOf(OPEN, 'agent')) >= Date.parse(sent.createdAt))).toBe(true);
    } finally { await b.close(); }
  }, BROWSER_TIMEOUT_MS);

  // The page is the app, as the board locks it: nothing under it, and no
  // page scroll to slide the pinned strip under the site's sticky bar.
  it.each([[PHONE_320], [PHONE_390], [DESKTOP]] as const)('%o: with a thread open the page does not scroll, and a mouse wheel over the pinned strip leaves its next step in view', async (view) => {
    if (!hasRealBrowser()) return;
    const b = await open(view, world.buyer, thread(OPEN));
    const geo = `(function () {
      var nav = document.querySelector('nav.nav'), pin = document.querySelector('.a-pin'), next = document.getElementById('pin-next');
      var navShown = getComputedStyle(nav).display !== 'none', r = next.getBoundingClientRect();
      var at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        scrollHeight: document.documentElement.scrollHeight, innerHeight: innerHeight, scrollY: scrollY,
        appBottom: Math.round(document.getElementById('msg-app').getBoundingClientRect().bottom),
        navBottom: navShown ? nav.getBoundingClientRect().bottom : 0,
        pinTop: pin.getBoundingClientRect().top, nextTop: r.top, nextSeen: !!at && (at === next || next.contains(at)),
        pinX: pin.getBoundingClientRect().left + 40, pinY: pin.getBoundingClientRect().top + pin.getBoundingClientRect().height / 2
      };
    })()`;
    type Geo = { scrollHeight: number; innerHeight: number; scrollY: number; appBottom: number; navBottom: number; pinTop: number; nextTop: number; nextSeen: boolean; pinX: number; pinY: number };
    try {
      const before = await b.evaluate<Geo>(geo);
      expect(before.scrollHeight, 'the document is taller than the window').toBeLessThanOrEqual(before.innerHeight);
      expect(before.appBottom, 'the app fills the window').toBe(before.innerHeight);
      expect(before.nextSeen).toBe(true);
      if (!view.touch) {
        expect(await js(b, `!!document.elementFromPoint(${before.pinX}, ${before.pinY}).closest('.a-pin')`), 'the wheel goes over the strip').toBe(true);
        await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.pinX, y: before.pinY });
        for (let i = 0; i < 4; i += 1) await b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: before.pinX, y: before.pinY, deltaX: 0, deltaY: 120 });
        await wait(500);
      }
      const after = await b.evaluate<Geo>(geo);
      expect(after.scrollY).toBe(0);
      expect(after.pinTop, 'the strip slid under the site bar').toBeGreaterThanOrEqual(after.navBottom);
      expect(after.nextTop).toBeGreaterThanOrEqual(after.navBottom);
      expect(after.nextSeen, 'the next step is covered').toBe(true);
    } finally { await b.close(); }
  }, BROWSER_TIMEOUT_MS);

  // Below the app's 420px floor the page has to scroll. The site bar is
  // not sticky here, so it scrolls away with the page instead of settling
  // over the strip.
  it('in a window shorter than the app, a mouse wheel over the pinned strip scrolls the site bar away, not over the strip', async () => {
    if (!hasRealBrowser()) return;
    const view: View = { width: 1280, height: 400, touch: false };
    const b = await open(view, world.buyer, thread(OPEN));
    try {
      const at = await b.evaluate<{ x: number; y: number; scrolls: boolean }>(`(function () {
        var r = document.querySelector('.a-pin').getBoundingClientRect();
        return { x: r.left + 40, y: r.top + r.height / 2, scrolls: document.documentElement.scrollHeight > innerHeight };
      })()`);
      expect(at.scrolls, 'the window is shorter than the app, so the page scrolls').toBe(true);
      await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
      for (let i = 0; i < 4; i += 1) await b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: 120 });
      await wait(500);
      const after = await b.evaluate<{ scrollY: number; navBottom: number; pinTop: number }>(`({
        scrollY: scrollY,
        navBottom: document.querySelector('nav.nav').getBoundingClientRect().bottom,
        pinTop: document.querySelector('.a-pin').getBoundingClientRect().top
      })`);
      expect(after.scrollY, 'the wheel scrolled the page').toBeGreaterThan(0);
      expect(after.pinTop, 'the strip slid under the site bar').toBeGreaterThanOrEqual(after.navBottom);
    } finally { await b.close(); }
  }, BROWSER_TIMEOUT_MS);

  // Defect 3's measure, over every text node in my own bubbles: the
  // hirer's brief (cut, with its link), label and messages; the owner's PDF
  // card, a reply with its quote, and their messages.
  it('every piece of text inside my own bubbles measures 4.5:1 or more against the bubble it sits on', async () => {
    if (!hasRealBrowser()) return;
    const rows: Contrast['rows'] = [];
    for (const [who, jobId] of [[world.buyer, SUBMITTED], [world.buyer, OPEN], [world.owner, OPEN]] as const) {
      const b = await open(DESKTOP, who, thread(jobId));
      try {
        const m = await b.evaluate<Contrast>(CONTRAST);
        expect(m.unmeasurable, 'text the measure cannot account for').toEqual([]);
        rows.push(...m.rows);
      } finally { await b.close(); }
    }
    const texts = rows.map((r) => r.text);
    for (const must of ['Brief', 'Read the whole brief', 'PDF, 1 KB', 'db-access-policy.pdf', '@msg-buyer', 'Could you do $1,100?']) {
      expect(texts.some((t) => t.startsWith(must)), `the fixture shows "${must}" in my bubble`).toBe(true);
    }
    if (captureDir) {
      mkdirSync(captureDir, { recursive: true });
      writeFileSync(join(captureDir, 'contrast-my-bubbles.json'), JSON.stringify(rows, null, 1));
    }
    expect(rows.filter((r) => r.ratio < r.floor)).toEqual([]);
  }, BROWSER_TIMEOUT_MS);
});

// ------------------------------------------------------------------ (l)

// FIX-B53. Each pin reads its own hire: INVITED for the line and the list,
// INVITE_REFUSED for the addresses the page must not link, and INVITE_LIVE,
// which only the live pin writes into.
describe('(l) GitHub\u2019s staging invitation', () => {
  // Each .event line: its words, whitespace collapsed, and its anchors.
  const lines = (page: Page): Array<{ text: string; anchors: HTMLAnchorElement[] }> =>
    page.$$('.event').map((e) => ({
      text: (e.textContent ?? '').replace(/\s+/g, ' ').trim(),
      anchors: Array.from(e.querySelectorAll('a')),
    }));
  // The glyph's paths, compared by their d attributes (a serialiser may
  // write the same markup another way).
  const glyph = (e: Element): string[] => Array.from(e.querySelectorAll('svg path')).map((p) => p.getAttribute('d') ?? '');
  const linkGlyph = (): string[] => {
    const src = readFileSync(join(repoRoot, 'src/web/public/js/pages/messages.js'), 'utf8');
    const markup = /\n {4}link: '([^']*)'/.exec(src)?.[1] ?? '';
    return [...markup.matchAll(/d="([^"]*)"/g)].map((m) => m[1]!);
  };

  it('the hirer sees one line, the whole sentence with the agent\u2019s GitHub account, and no link', async () => {
    const page = await render(thread(INVITED), world.buyer);
    try {
      expect(lines(page)).toEqual([{ text: INVITE_SENTENCE, anchors: [] }]);
      expect(linkGlyph()).toHaveLength(2);
      expect(glyph(page.$('.event')!)).toEqual(linkGlyph());
    } finally { page.close(); }
  });

  it('the owner sees the same sentence and one Accept on GitHub link to GitHub\u2019s page, in a new tab, with noopener', async () => {
    const page = await render(thread(INVITED), world.owner);
    try {
      const got = lines(page);
      expect(got.map((l) => l.text)).toEqual([`${INVITE_SENTENCE} ${INVITE_LINK}`]);
      expect(got[0]!.anchors).toHaveLength(1);
      const a = got[0]!.anchors[0]!;
      expect(a.textContent).toBe(INVITE_LINK);
      expect(a.getAttribute('href')).toBe(INVITE_URL);
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener nofollow');
      expect(glyph(page.$('.event')!)).toEqual(linkGlyph());
    } finally { page.close(); }
  });

  it('an address that is not https (javascript:, http:) draws the owner\u2019s sentence with no link', async () => {
    const rows = (await messagesOf(INVITE_REFUSED)).filter((m) => m.systemEvent?.type === 'staging_invited');
    expect(rows.map((m) => m.systemEvent.acceptUrl).sort()).toEqual([...REFUSED_URLS].sort());
    const page = await render(thread(INVITE_REFUSED), world.owner);
    try {
      expect(lines(page)).toEqual([{ text: INVITE_SENTENCE, anchors: [] }, { text: INVITE_SENTENCE, anchors: [] }]);
      expect(page.document.querySelector('main a[href^="javascript"], main a[href^="http:"]')).toBeNull();
    } finally { page.close(); }
  });

  it.each([
    ['the hirer', 'buyer'],
    ['the owner', 'owner'],
  ] as const)('the list names the invitation in words for %s, never Update', async (_label, who) => {
    const session = who === 'buyer' ? world.buyer : world.owner;
    const api = await threadsOf(session, who === 'buyer' ? BUYER_DID : OWNER_DID);
    expect(api.threads.find((t) => t.jobId === INVITED)!.lastMessage.systemEventType).toBe('staging_invited');
    const page = await render('/messages', session);
    try {
      expect(page.text(`.convlist a[data-job="${INVITED}"] .cl-lt`)).toBe(INVITE_WORDS);
    } finally { page.close(); }
  });

  // The stream refused, so the row comes in by the 10 second poll; the
  // poll after it brings nothing new, and nothing is read out again.
  it('when the stream is refused, an invitation written while the owner has the thread open is announced once, in words', async () => {
    const page = await render(thread(INVITE_LIVE), world.owner, { refuseStream: true });
    const heard = (): string[] => page.$$('#thread-live p').map((p) => p.textContent ?? '');
    const polls = (): number => page.calls.filter((c) => c === `GET /jobs/${INVITE_LIVE}/messages`).length;
    try {
      expect(heard()).toEqual([]);
      await world.messages.create(createSystemMessage({
        id: `sys-live-invite-${Date.now()}`, jobId: INVITE_LIVE, body: '',
        systemEvent: { type: 'staging_invited', acceptUrl: INVITE_URL, githubLogin: AGENT_GITHUB_LOGIN },
      }, new Date()));
      expect(await until(() => lines(page).length === 1, 11_000), 'the poll drew the line').toBe(true);
      const after = polls();
      expect(await until(() => polls() > after, 11_000), 'another poll ran').toBe(true);
      await wait(300);
      expect(heard()).toEqual([INVITE_WORDS]);
    } finally { page.close(); }
  }, 30_000);

  it.each([
    [PHONE_320, 'owner'], [PHONE_390, 'owner'], [PHONE_390, 'buyer'], [DESKTOP, 'owner'], [DESKTOP, 'buyer'],
  ] as const)('real Chrome %o, %s: the thread with the invitation fits, and on touch every control is 44px', async (view, who) => {
    if (!hasRealBrowser()) { console.warn('no Chrome found; skipping (see CHROME_BIN)'); return; }
    const b = await chrome(view, who === 'buyer' ? world.buyer : world.owner, false);
    try {
      await b.goto(`${world.baseUrl}${thread(INVITED)}`, 1800);
      const line = await b.evaluate<{ text: string; links: Array<{ w: number; h: number; href: string; hit: boolean }> } | null>(`(function () {
        var e = document.querySelector('.thread .event');
        if (!e) return null;
        return { text: e.textContent.replace(/\\s+/g, ' ').trim(), links: [].map.call(e.querySelectorAll('a'), function (a) {
          a.scrollIntoView({ block: 'center' });
          var r = a.getBoundingClientRect(), at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return { w: r.width, h: r.height, href: a.getAttribute('href'), hit: !!at && (at === a || a.contains(at)) };
        }) };
      })()`);
      expect(line).not.toBeNull();
      if (who === 'buyer') {
        expect(line!.text).toBe(INVITE_SENTENCE);
        expect(line!.links).toEqual([]);
      } else {
        expect(line!.text).toBe(`${INVITE_SENTENCE} ${INVITE_LINK}`);
        expect(line!.links).toHaveLength(1);
        expect(line!.links[0]!.href).toBe(INVITE_URL);
        expect(line!.links[0]!.hit, 'the link is covered at its own centre').toBe(true);
        if (view.touch) {
          expect(line!.links[0]!.w).toBeGreaterThanOrEqual(44);
          expect(line!.links[0]!.h).toBeGreaterThanOrEqual(44);
        }
      }
      await gate(b, view, `invited-${who}`);
    } finally { await b.close(); }
  }, BROWSER_TIMEOUT_MS);
});
