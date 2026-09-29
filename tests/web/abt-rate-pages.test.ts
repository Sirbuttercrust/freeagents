// FIX-B70b: the ABT pay sheet on /deposit and /staged shows the rate that
// press locked, when the lock ends and when CoinGecko last updated the
// price, driven end to end against the real app. The pages come from the
// app's own static mount into jsdom (tests/helpers/usdc-page-fixtures.ts),
// the ABT rail runs for real on a fake chain, and its rate source answers
// what each test sets with h.setAbtRate. Every expected line is built from
// what the route itself answered to that press, read off the wire, so the
// page is checked against the lock the server wrote rather than against a
// copy of its own formatting.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  buildPageHarness, renderPage, shown, text, waitFor,
  type PageHarness, type RenderedPage,
} from '../helpers/usdc-page-fixtures.js';

const RECENT = new Date(Date.now() - 60 * 60 * 1000);
const PRICE_SENTENCE = 'The ABT price is not available right now. Nothing was charged. Try again in a minute.';
const MINUTE = 60 * 1000;

let h: PageHarness;
let seq = 0;
beforeAll(async () => { h = await buildPageHarness(); });
afterAll(async () => { await h.close(); });
afterEach(() => { h.resetAbtRate(); });

type Leg = 'deposit' | 'staged';
async function job(leg: Leg, rail: 'abt' | null = 'abt'): Promise<string> {
  seq += 1;
  const id = `abt-rate-${leg}-${seq}`;
  if (leg === 'deposit') await h.addJob({ id, rail });
  else await h.addJob({ id, status: 'staged', rail: 'abt', stagedAt: RECENT, stagedCommit: `commit-${id}`, confirmedAt: RECENT, confirmedSpecHash: `sha256:${id}` });
  return id;
}
function open(leg: Leg, id: string): Promise<RenderedPage> {
  return leg === 'deposit'
    ? renderPage(h, `/deposit?job=${id}`, (d) => !d.getElementById('deposit-body')!.hidden && (d.getElementById('pay-btn')!.textContent ?? '') !== '')
    : renderPage(h, `/staged?job=${id}`, (d) => (d.getElementById('pay-btn')!.textContent ?? '').startsWith('Pay the balance'));
}
const startPath = (leg: Leg): string => `/payments/${leg === 'deposit' ? 'deposit' : 'remainder'}/abt/start`;

interface Quote { usdPerAbt: string; rateUpdatedAt: string | null; expiresAt: string }
// The page's own window.fetch, wrapped so every answer the start route
// gives is kept. `stub`, given, answers the start route in place of the app.
function watchStart(page: RenderedPage, leg: Leg, stub?: () => Response): Quote[] {
  const seen: Quote[] = [];
  const inner = page.window.fetch.bind(page.window);
  Object.defineProperty(page.window, 'fetch', {
    writable: true,
    value: async (input: string, init?: RequestInit) => {
      if (!String(input).includes(startPath(leg))) return inner(input, init);
      if (stub) return stub();
      const response = await inner(input, init);
      const body = (await response.clone().json()) as { extra?: { abtQuote?: Quote } };
      if (body.extra?.abtQuote) seen.push(body.extra.abtQuote);
      return response;
    },
  });
  return seen;
}
async function pressPay(page: RenderedPage): Promise<void> {
  (page.document.getElementById('pay-btn') as HTMLButtonElement).click();
  await waitFor(() => (page.document.getElementById('scan') as HTMLDialogElement).open || shown(page.document, 'pay-error'), 'the press never answered');
}
function closeSheet(page: RenderedPage): void {
  (page.document.querySelector('#scan .sfoot [data-closes]') as HTMLButtonElement).click();
}
// A local clock time, the way a person in this timezone reads it.
const clock = (iso: string | Date): string => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const sheetOpen = (page: RenderedPage): boolean => (page.document.getElementById('scan') as HTMLDialogElement).open;
// The block's two lines, read the way a person meets them.
const lines = (page: RenderedPage): [string, string] => {
  const ps = page.document.querySelectorAll('#abt-rate p');
  return [(ps[0]?.textContent ?? '').trim(), (ps[1]?.textContent ?? '').trim()];
};

for (const leg of ['deposit', 'staged'] as const) {
  describe(`${leg}: the ABT sheet shows the lock that press made`, () => {
    it(`(${leg === 'deposit' ? 'a' : 'b'}) a CoinGecko reading: the rate exactly, the time the lock holds until, and the time CoinGecko updated it`, async () => {
      const updatedAt = new Date(Date.now() - 7 * MINUTE);
      h.setAbtRate({ usdPerToken: '0.35702500', updatedAt });
      const page = await open(leg, await job(leg));
      try {
        const seen = watchStart(page, leg);
        const pressedAt = new Date();
        await pressPay(page);
        expect(sheetOpen(page)).toBe(true);
        expect(seen.length).toBe(1);
        const quote = seen[0]!;
        expect(quote.usdPerAbt).toBe('0.35702500');
        expect(quote.rateUpdatedAt).toBe(updatedAt.toISOString());
        // Three different clock times, so no line can pass on the wrong one.
        expect(new Set([clock(quote.expiresAt), clock(updatedAt), clock(pressedAt)]).size).toBe(3);
        expect(shown(page.document, 'abt-rate')).toBe(true);
        expect(lines(page)).toEqual([
          `1 ABT = $0.357025, held until ${clock(quote.expiresAt)}.`,
          `Price data by CoinGecko, updated ${clock(updatedAt)}.`,
        ]);
      } finally { await page.close(); }
    });

    it('(c) a bare rate with no feed time: two decimals, and no "updated"', async () => {
      const page = await open(leg, await job(leg));
      try {
        const seen = watchStart(page, leg);
        await pressPay(page);
        expect(sheetOpen(page)).toBe(true);
        expect(seen[0]!.usdPerAbt).toBe('1');
        expect(seen[0]!.rateUpdatedAt).toBeNull();
        expect(lines(page)).toEqual([`1 ABT = $1.00, held until ${clock(seen[0]!.expiresAt)}.`, 'Price data by CoinGecko.']);
      } finally { await page.close(); }
    });

    it('(d) "CoinGecko" links to coingecko.com in a new tab, inside the ABT part of the sheet', async () => {
      const page = await open(leg, await job(leg));
      try {
        await pressPay(page);
        const links = page.document.querySelectorAll('#abt-rate a');
        expect(links.length).toBe(1);
        const link = links[0] as HTMLAnchorElement;
        expect(link.textContent).toBe('CoinGecko');
        expect(['https://www.coingecko.com', 'https://www.coingecko.com/']).toContain(link.getAttribute('href'));
        expect(link.getAttribute('target')).toBe('_blank');
        expect((link.getAttribute('rel') ?? '').split(/\s+/)).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
        expect(link.closest('#scan-abt')).not.toBeNull();
        expect(shown(page.document, link.parentElement!.parentElement!.id)).toBe(true);
      } finally { await page.close(); }
    });

    it('(e) a second press shows the second lock and nothing from the first', async () => {
      const page = await open(leg, await job(leg));
      try {
        const seen = watchStart(page, leg);
        const first = new Date(Date.now() - 9 * MINUTE), second = new Date(Date.now() - 3 * MINUTE);
        h.setAbtRate({ usdPerToken: '0.35702500', updatedAt: first });
        await pressPay(page);
        expect(lines(page)[0]).toContain('$0.357025');
        closeSheet(page);
        h.setAbtRate({ usdPerToken: '12.50000000', updatedAt: second });
        await pressPay(page);
        expect(seen.length).toBe(2);
        expect(lines(page)).toEqual([
          `1 ABT = $12.50, held until ${clock(seen[1]!.expiresAt)}.`,
          `Price data by CoinGecko, updated ${clock(second)}.`,
        ]);
      } finally { await page.close(); }
    });

    it('(f) a start answer whose quote is null, missing or not a number opens no sheet and says why', async () => {
      const bodies = [{ abtQuote: null }, {}, { abtQuote: { usdPerAbt: 'abc', rateUpdatedAt: null, expiresAt: new Date().toISOString() } }];
      for (const extra of bodies) {
        const page = await open(leg, await job(leg));
        try {
          watchStart(page, leg, () => new Response(JSON.stringify({ url: 'https://wallet.example/one-time', extra }), { status: 200, headers: { 'content-type': 'application/json' } }));
          await pressPay(page);
          expect(sheetOpen(page), JSON.stringify(extra)).toBe(false);
          expect(shown(page.document, 'pay-error')).toBe(true);
          expect(text(page.document, 'pay-error-detail')).toBe(PRICE_SENTENCE);
        } finally { await page.close(); }
      }
    });

    it('(g) the route\u2019s own price 503, with no price to read, reads as a price outage', async () => {
      h.setAbtRate(null);
      const page = await open(leg, await job(leg));
      try {
        await pressPay(page);
        expect(sheetOpen(page)).toBe(false);
        expect(text(page.document, 'pay-error-detail')).toBe(PRICE_SENTENCE);
      } finally { await page.close(); }
    });

    it('(h) the paid mode never shows the rate, even after an ABT press filled it', async () => {
      const id = await job(leg);
      const page = await open(leg, id);
      try {
        await pressPay(page);
        expect(shown(page.document, 'abt-rate')).toBe(true);
        closeSheet(page);
        await h.settle(id, leg === 'deposit' ? 'deposit' : 'remainder', 'abt');
        await pressPay(page);
        await waitFor(() => text(page.document, 'usdc-status') !== '', 'the paid sentence never showed');
        expect(sheetOpen(page)).toBe(true);
        expect(text(page.document, 'usdc-status').toLowerCase()).toContain('already been paid');
        expect(shown(page.document, 'scan-abt')).toBe(false);
        expect(shown(page.document, 'abt-rate')).toBe(false);
      } finally { await page.close(); }
    });
  });
}

describe('deposit: a USDC press on a hire that offers both', () => {
  it('(h) the USDC sheet never shows the rate, even after an ABT press filled it', async () => {
    const page = await open('deposit', await job('deposit', null));
    try {
      expect(shown(page.document, 'railopt-usdc')).toBe(true);
      await pressPay(page);
      expect(shown(page.document, 'abt-rate')).toBe(true);
      closeSheet(page);
      const radio = page.document.getElementById('rail-usdc') as HTMLInputElement;
      radio.checked = true;
      radio.dispatchEvent(new page.window.Event('change', { bubbles: true }));
      await pressPay(page);
      expect(sheetOpen(page)).toBe(true);
      expect(text(page.document, 'scanh')).toBe('Approve in your wallet');
      expect(shown(page.document, 'scan-abt')).toBe(false);
      expect(shown(page.document, 'abt-rate')).toBe(false);
    } finally { await page.close(); }
  });
});
