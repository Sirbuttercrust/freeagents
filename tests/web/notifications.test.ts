// FIX-SW12k (SW3-09): the notification list marks what a person opens as
// read, and offers Mark all as read. Driven end to end against the real app
// with a real session (the discipline tests/web/dashboard.test.ts holds
// to): every read POST lands on the real route, and every "read" this file
// asserts is what the server answers afterwards, never the page's own word.
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Session } from '../../src/adapters/identity/session.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';
import { startNotificationWorld, type NotificationAccount, type NotificationWorld } from '../helpers/notification-world.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const PLATFORM_SEED = 'c'.repeat(64);
const BROWSER_TIMEOUT_MS = 60_000;

const MARK_ALL = 'Mark all as read';
const CAUGHT_UP = 'You are all caught up.';
const MARK_ALL_FAILED = 'Some notifications could not be marked read. Reloading may work.';

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly keepalive: boolean | undefined;
}

// Answers a request in place of the real app, or returns null to let it
// through. Only the read POSTs are ever intercepted below.
type Intercept = (sent: Sent, index: number) => Promise<Response> | null;

interface Page {
  readonly window: JSDOM['window'];
  readonly document: Document;
  readonly sent: Sent[];
  // Whether the page itself cancelled each click's navigation, recorded
  // before this harness cancels it (jsdom cannot navigate).
  readonly navigationBlocked: boolean[];
  close(): void;
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function renderNotifications(baseUrl: string, session: Session, intercept?: Intercept): Promise<Page> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));
  const sent: Sent[] = [];
  const navigationBlocked: boolean[] = [];
  let posts = 0;
  const markup = await (await fetch(`${baseUrl}/notifications`, { headers: { Accept: HTML } })).text();
  const dom = new JSDOM(markup, {
    url: `${baseUrl}/notifications`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.sessionStorage.setItem('fa_session', JSON.stringify(session));
      Object.defineProperty(window, 'fetch', {
        writable: true,
        value: (input: string, init?: RequestInit) => {
          const url = new URL(String(input), baseUrl);
          const headers = (init?.headers ?? {}) as Record<string, string>;
          const entry: Sent = {
            method: (init?.method ?? 'GET').toUpperCase(),
            path: url.pathname,
            authorization: headers.Authorization ?? null,
            keepalive: init?.keepalive,
          };
          sent.push(entry);
          if (entry.method === 'POST' && intercept !== undefined) {
            const answer = intercept(entry, posts++);
            if (answer !== null) return answer;
          }
          return fetch(url, init);
        },
      });
      // Bubble phase on window runs after every listener the page put on a
      // row, so defaultPrevented here is the page's own decision.
      window.addEventListener('click', (e) => {
        navigationBlocked.push(e.defaultPrevented);
        e.preventDefault();
      });
    },
  });
  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', () => resolve());
  });
  await until(() => dom.window.document.getElementById('notifications-body')?.hidden === false, 'the list to render');
  if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);
  return { window: dom.window, document: dom.window.document, sent, navigationBlocked, close: () => dom.window.close() };
}

function readRoute(a: NotificationAccount, id: string): string {
  return `/accounts/${encodeURIComponent(a.did)}/notifications/${encodeURIComponent(id)}/read`;
}

function readPosts(page: Page): Sent[] {
  return page.sent.filter((s) => s.method === 'POST' && /\/notifications\/[^/]+\/read$/.test(s.path));
}

function listReads(page: Page, a: NotificationAccount): number {
  return page.sent.filter((s) => s.method === 'GET' && s.path === `/accounts/${encodeURIComponent(a.did)}/notifications`).length;
}

function rowFor(page: Page, jobId: string): HTMLAnchorElement {
  const row = page.document.querySelector<HTMLAnchorElement>(`#notification-rows a[href="/jobs/${jobId}"]`);
  if (row === null) throw new Error(`no row for ${jobId}`);
  return row;
}

function press(page: Page, el: Element): void {
  el.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}

function bodyButtons(page: Page): HTMLButtonElement[] {
  return Array.from(page.document.querySelectorAll<HTMLButtonElement>('#notifications-body button'));
}

function summary(page: Page): string {
  return (page.document.getElementById('unread-summary')?.textContent ?? '').trim();
}

function alertNode(page: Page): HTMLElement {
  const node = page.document.getElementById('mark-all-error');
  if (node === null) throw new Error('no #mark-all-error node');
  return node;
}

let world: NotificationWorld;
let originalSeed: string | undefined;

beforeAll(async () => {
  originalSeed = process.env.FREEAGENTS_PLATFORM_SEED;
  process.env.FREEAGENTS_PLATFORM_SEED = PLATFORM_SEED;
  world = await startNotificationWorld('notif-page');
});

afterAll(async () => {
  await world.close();
  if (originalSeed === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
  else process.env.FREEAGENTS_PLATFORM_SEED = originalSeed;
});

describe('(a) opening a notification marks it read', () => {
  it('a press on an unread row sends exactly one read POST for that notification, with the bearer token and keepalive, and never holds the navigation to /jobs/<jobId>', async () => {
    const a = await world.account('open-unread', { unread: 2, read: 1 });
    const page = await renderNotifications(world.baseUrl, a.session);
    try {
      const target = a.unread[0]!;
      const row = rowFor(page, target.jobId);
      expect(row.getAttribute('href')).toBe(`/jobs/${target.jobId}`);
      press(page, row);
      expect(readPosts(page)).toEqual([
        { method: 'POST', path: readRoute(a, target.id), authorization: `Bearer ${a.session.token}`, keepalive: true },
      ]);
      expect(page.navigationBlocked).toEqual([false]);
      await until(async () => (await world.unreadCountOf(a)) === 1, 'the server to count one fewer unread');
      // A second press on the same row sends nothing more.
      press(page, row);
      expect(readPosts(page).length).toBe(1);
    } finally {
      page.close();
    }
  });

  it('a press on a row already read sends nothing, and still navigates', async () => {
    const a = await world.account('open-read', { unread: 1, read: 2 });
    const page = await renderNotifications(world.baseUrl, a.session);
    try {
      const row = rowFor(page, a.read[1]!.jobId);
      expect(row.getAttribute('href')).toBe(`/jobs/${a.read[1]!.jobId}`);
      press(page, row);
      await new Promise((r) => setTimeout(r, 200));
      expect(readPosts(page)).toEqual([]);
      expect(page.navigationBlocked).toEqual([false]);
      expect(await world.unreadCountOf(a)).toBe(1);
    } finally {
      page.close();
    }
  });

  it('a refused read POST changes nothing on screen: the row keeps its unread dot', async () => {
    const a = await world.account('open-refused', { unread: 1, read: 0 });
    const page = await renderNotifications(world.baseUrl, a.session, () => Promise.resolve(new Response('{}', { status: 503 })));
    try {
      const row = rowFor(page, a.unread[0]!.jobId);
      press(page, row);
      await new Promise((r) => setTimeout(r, 200));
      expect(readPosts(page).length).toBe(1);
      expect(row.querySelector('.notif-dot')).not.toBeNull();
      expect(summary(page)).toBe('1 unread notification');
      expect(await world.unreadCountOf(a)).toBe(1);
    } finally {
      page.close();
    }
  });
});

describe('(b) the Mark all as read button exists only while something is unread', () => {
  it('with unread rows the page carries exactly one button, a plain .btn reading Mark all as read', async () => {
    const a = await world.account('button-shown', { unread: 2, read: 1 });
    const page = await renderNotifications(world.baseUrl, a.session);
    try {
      const buttons = bodyButtons(page);
      expect(buttons.map((b) => b.textContent?.trim())).toEqual([MARK_ALL]);
      expect(buttons[0]!.classList.contains('btn')).toBe(true);
      expect(buttons[0]!.classList.contains('btn-primary')).toBe(false);
      expect(buttons[0]!.getAttribute('type')).toBe('button');
    } finally {
      page.close();
    }
  });

  it('with nothing unread the page carries no button at all in #notifications-body', async () => {
    const a = await world.account('button-absent', { unread: 0, read: 2 });
    const page = await renderNotifications(world.baseUrl, a.session);
    try {
      expect(summary(page)).toBe(CAUGHT_UP);
      expect(bodyButtons(page)).toEqual([]);
    } finally {
      page.close();
    }
  });
});

describe('(c) Mark all as read', () => {
  it('sends one POST per unread row and none for a read row, is disabled while they run, and then draws what the server holds', async () => {
    const a = await world.account('mark-all', { unread: 3, read: 2 });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // Hold the first POST until the button has been seen disabled.
    const page = await renderNotifications(world.baseUrl, a.session, (sent, index) => {
      if (index !== 0) return null;
      return gate.then(() => fetch(new URL(sent.path, world.baseUrl), { method: 'POST', headers: { Authorization: sent.authorization ?? '', Accept: 'application/json', 'content-type': 'application/json' }, body: '{}' }));
    });
    try {
      const button = bodyButtons(page)[0]!;
      expect(alertNode(page).getAttribute('role')).toBe('alert');
      const readsBefore = listReads(page, a);
      press(page, button);
      await until(() => readPosts(page).length === 1, 'the first POST');
      expect(button.disabled).toBe(true);
      release();
      await until(() => summary(page) === CAUGHT_UP, 'the list to be read again');

      const byPath = readPosts(page).map((s) => s.path).sort();
      expect(byPath).toEqual(a.unread.map((n) => readRoute(a, n.id)).sort());
      for (const r of a.read) expect(byPath).not.toContain(readRoute(a, r.id));
      expect(readPosts(page).every((s) => s.authorization === `Bearer ${a.session.token}`)).toBe(true);
      expect(listReads(page, a)).toBe(readsBefore + 1);

      expect(page.document.querySelectorAll('#notification-rows a').length).toBe(5);
      expect(page.document.querySelectorAll('#notification-rows .notif-dot').length).toBe(0);
      expect(page.document.querySelectorAll('#notification-rows .is-unread').length).toBe(0);
      expect(bodyButtons(page)).toEqual([]);
      expect(alertNode(page).hidden).toBe(true);
      expect(await world.unreadCountOf(a)).toBe(0);
    } finally {
      page.close();
    }
  });
});

describe('(d) a failed Mark all as read stops, says so in one sentence, and reads the list again', () => {
  const refuse = (status: number) => () => Promise.resolve(new Response(JSON.stringify({ error: 'refused' }), { status, headers: { 'content-type': 'application/json' } }));
  const cases: [string, () => Promise<Response>][] = [
    ['a 403', refuse(403)],
    ['a 429', refuse(429)],
    ['a 503', refuse(503)],
    ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
  ];

  it.each(cases)('%s on the second POST', async (label, fail) => {
    const a = await world.account(`fail-${label.replace(/\W+/g, '-')}`, { unread: 3, read: 1 });
    // The first POST reaches the real app; the second is refused.
    const page = await renderNotifications(world.baseUrl, a.session, (_sent, index) => (index === 1 ? fail() : null));
    try {
      const node = alertNode(page);
      expect(node.getAttribute('role')).toBe('alert');
      expect(node.hidden).toBe(true);
      const readsBefore = listReads(page, a);
      press(page, bodyButtons(page)[0]!);
      await until(() => node.hidden === false, 'the alert');
      await until(() => listReads(page, a) === readsBefore + 1, 'the list to be read again');
      await until(() => summary(page) === '2 unread notifications', 'the re-read list to draw');

      expect(node.textContent).toBe(MARK_ALL_FAILED);
      // Stopped at the refusal: the third unread row was never sent.
      expect(readPosts(page).length).toBe(2);
      expect(await world.unreadCountOf(a)).toBe(2);
      expect(page.document.querySelectorAll('#notification-rows .notif-dot').length).toBe(2);
      const buttons = bodyButtons(page);
      expect(buttons.map((b) => b.textContent?.trim())).toEqual([MARK_ALL]);
      expect(buttons[0]!.disabled).toBe(false);
    } finally {
      page.close();
    }
  });
});

describe('(layout) /notifications with unread rows, real Chrome', () => {
  it('holds at 320, 390 and 1280 with no sideways scroll, and Mark all as read is 44px tall on a phone', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const a = await world.account('layout', { unread: 3, read: 2 });
    const browser = await RealBrowser.launch({ width: 320, height: 900 });
    try {
      await browser.goto(`${world.baseUrl}/notifications`);
      await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(a.session))})`);
      for (const width of [320, 390, 1280]) {
        await browser.setViewport(width, 900);
        await browser.goto(`${world.baseUrl}/notifications`, 800);
        const g = await browser.evaluate<{ scrollWidth: number; clientWidth: number; button: { height: number; right: number } | null }>(`
          (function () {
            var b = document.querySelector('#notifications-body button');
            var box = b ? b.getBoundingClientRect() : null;
            return {
              scrollWidth: document.documentElement.scrollWidth,
              clientWidth: document.documentElement.clientWidth,
              button: box && box.height > 0 ? { height: box.height, right: box.right } : null,
            };
          })()
        `);
        expect(g.button, `the button rendered at ${width}`).not.toBeNull();
        expect(g.scrollWidth, `no sideways scroll at ${width}`).toBe(g.clientWidth);
        expect(g.button!.right, `the button sits inside the viewport at ${width}`).toBeLessThanOrEqual(g.clientWidth);
        if (width < 760) expect(g.button!.height, `the button reaches the 44px floor at ${width}`).toBeGreaterThanOrEqual(44);
      }
    } finally {
      await browser.close();
    }
  }, BROWSER_TIMEOUT_MS);
});
