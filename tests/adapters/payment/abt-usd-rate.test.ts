// The ABT/USD feed (FIX-B70a): CoinGecko's free public price, read through
// an injected fetch and an injected clock. No test here touches the
// network; the fetch is always a fake.
import { describe, expect, it } from 'vitest';
import {
  ABT_RATE_CACHE_MS,
  ABT_RATE_STALE_AFTER_MS,
  ABT_RATE_TIMEOUT_MS,
  createAbtUsdRateSource,
} from '../../../src/adapters/payment/abt-usd-rate.js';

const T0 = Date.parse('2026-09-28T18:00:00Z');
const T0_SECONDS = Math.floor(T0 / 1000);

function body(usd: unknown, lastUpdatedAt: unknown = T0_SECONDS): string {
  return JSON.stringify({ arcblock: { usd, last_updated_at: lastUpdatedAt } });
}

function okResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
}

// A fetch that answers a scripted list of results, one per call, and
// records every URL it was asked for. A result is a Response, an Error to
// throw, or 'hang' (never settles until the request's signal aborts).
type Scripted = Response | Error | 'hang';

function scriptedFetch(script: readonly Scripted[]): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  let index = 0;
  const fetchImpl = (async (input: unknown, init?: { signal?: AbortSignal }) => {
    urls.push(String(input));
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    if (step === undefined) throw new Error('empty script');
    if (step === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    if (step instanceof Error) throw step;
    return step.clone();
  }) as typeof fetch;
  return { fetchImpl, urls };
}

function clock(start = T0): { now: () => Date; advance: (ms: number) => void } {
  let current = start;
  return { now: () => new Date(current), advance: (ms) => { current += ms; } };
}

describe('the named constants', () => {
  it('are 60 seconds of cache, 5 minutes of staleness, and a 5 second timeout', () => {
    expect(ABT_RATE_CACHE_MS).toBe(60_000);
    expect(ABT_RATE_STALE_AFTER_MS).toBe(300_000);
    expect(ABT_RATE_TIMEOUT_MS).toBe(5_000);
  });
});

describe('the CoinGecko ABT/USD feed: parsing', () => {
  it("parses CoinGecko's own body into a plain decimal price and the feed's update time, from the keyless simple/price URL", async () => {
    const { fetchImpl, urls } = scriptedFetch([okResponse(body(0.34452, T0_SECONDS - 90))]);
    const source = createAbtUsdRateSource({ fetchImpl, now: clock().now });
    expect(await source()).toEqual({ usdPerToken: '0.34452000', updatedAt: new Date((T0_SECONDS - 90) * 1000) });
    expect(urls).toEqual([
      'https://api.coingecko.com/api/v3/simple/price?ids=arcblock&vs_currencies=usd&include_last_updated_at=true',
    ]);
  });

  it('never writes a price in exponent notation, however small or large the number is', async () => {
    const small = createAbtUsdRateSource({ fetchImpl: scriptedFetch([okResponse(body(1e-7))]).fetchImpl, now: clock().now });
    expect(await small()).toEqual({ usdPerToken: '0.00000010', updatedAt: new Date(T0_SECONDS * 1000) });
    const large = createAbtUsdRateSource({ fetchImpl: scriptedFetch([okResponse(body(123456789.5))]).fetchImpl, now: clock().now });
    expect(await large()).toEqual({ usdPerToken: '123456789.50000000', updatedAt: new Date(T0_SECONDS * 1000) });
  });
});

describe('the CoinGecko ABT/USD feed: the 60 second cache', () => {
  it('a second read inside 60 seconds makes no request and answers the same reading', async () => {
    const { fetchImpl, urls } = scriptedFetch([okResponse(body(0.34452))]);
    const time = clock();
    const source = createAbtUsdRateSource({ fetchImpl, now: time.now });
    const first = await source();
    time.advance(ABT_RATE_CACHE_MS - 1);
    const second = await source();
    expect(second).toEqual(first);
    expect(urls).toHaveLength(1);
  });

  it('a read after 60 seconds makes one new request and answers the new price', async () => {
    const { fetchImpl, urls } = scriptedFetch([
      okResponse(body(0.34452, T0_SECONDS)),
      okResponse(body(0.35, T0_SECONDS + 61)),
    ]);
    const time = clock();
    const source = createAbtUsdRateSource({ fetchImpl, now: time.now });
    await source();
    time.advance(ABT_RATE_CACHE_MS);
    expect(await source()).toEqual({ usdPerToken: '0.35000000', updatedAt: new Date((T0_SECONDS + 61) * 1000) });
    expect(urls).toHaveLength(2);
  });

  it('concurrent callers on a cold cache share one request', async () => {
    const { fetchImpl, urls } = scriptedFetch([okResponse(body(0.34452))]);
    const source = createAbtUsdRateSource({ fetchImpl, now: clock().now });
    const [a, b, c] = await Promise.all([source(), source(), source()]);
    expect(urls).toHaveLength(1);
    expect(a).toEqual({ usdPerToken: '0.34452000', updatedAt: new Date(T0_SECONDS * 1000) });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});

describe('the CoinGecko ABT/USD feed: the 5 minute staleness cutoff', () => {
  it('a reading whose last_updated_at is more than 5 minutes old answers null', async () => {
    const { fetchImpl } = scriptedFetch([okResponse(body(0.34452, T0_SECONDS - 301))]);
    const source = createAbtUsdRateSource({ fetchImpl, now: clock().now });
    expect(await source()).toBeNull();
  });

  it('a reading exactly 5 minutes old is still answered', async () => {
    const { fetchImpl } = scriptedFetch([okResponse(body(0.34452, T0_SECONDS - 300))]);
    const source = createAbtUsdRateSource({ fetchImpl, now: clock().now });
    expect(await source()).toEqual({ usdPerToken: '0.34452000', updatedAt: new Date((T0_SECONDS - 300) * 1000) });
  });

  it('a cached reading that ages past the cutoff is not served from the cache either', async () => {
    const { fetchImpl, urls } = scriptedFetch([okResponse(body(0.34452, T0_SECONDS - 250))]);
    const time = clock();
    const source = createAbtUsdRateSource({ fetchImpl, now: time.now });
    expect(await source()).not.toBeNull();
    // 51 seconds later the reading is 301 seconds old, still inside the
    // 60 second cache window, and past the cutoff.
    time.advance(51_000);
    expect(await source()).toBeNull();
    expect(urls).toHaveLength(1);
  });
});

describe('the CoinGecko ABT/USD feed: a failed refresh', () => {
  const failures: readonly { readonly name: string; readonly result: () => Scripted }[] = [
    { name: 'a network error', result: () => new Error('connect ECONNREFUSED') },
    { name: 'a 429', result: () => new Response('{"status":{"error_code":429}}', { status: 429 }) },
    { name: 'a 500', result: () => new Response('boom', { status: 500 }) },
    { name: 'a body with no arcblock.usd', result: () => okResponse('{"arcblock":{}}') },
    { name: 'a body that is not JSON', result: () => okResponse('<html>') },
    { name: 'a body with no last_updated_at', result: () => okResponse('{"arcblock":{"usd":0.34}}') },
    { name: 'a price of zero', result: () => okResponse(body(0)) },
    { name: 'a negative price', result: () => okResponse(body(-0.34)) },
    { name: 'a price that is a string', result: () => okResponse(body('0.34'))},
    { name: 'a price that is null', result: () => okResponse(body(null)) },
    { name: 'a price that rounds to zero at 8 places', result: () => okResponse(body(1e-9)) },
  ];

  it.each(failures)('$name answers the cached reading while it is inside the 5 minute cutoff', async ({ result }) => {
    const { fetchImpl, urls } = scriptedFetch([okResponse(body(0.34452, T0_SECONDS)), result()]);
    const time = clock();
    const source = createAbtUsdRateSource({ fetchImpl, now: time.now });
    const first = await source();
    time.advance(ABT_RATE_CACHE_MS + 1);
    expect(await source()).toEqual(first);
    expect(urls).toHaveLength(2);
  });

  it.each(failures)('$name answers null once the cached reading is past the 5 minute cutoff', async ({ result }) => {
    const { fetchImpl, urls } = scriptedFetch([okResponse(body(0.34452, T0_SECONDS)), result()]);
    const time = clock();
    const source = createAbtUsdRateSource({ fetchImpl, now: time.now });
    expect(await source()).not.toBeNull();
    time.advance(ABT_RATE_STALE_AFTER_MS + 1_000);
    expect(await source()).toBeNull();
    expect(urls).toHaveLength(2);
  });

  it('a failure on a cold cache answers null', async () => {
    const { fetchImpl } = scriptedFetch([new Error('down')]);
    const source = createAbtUsdRateSource({ fetchImpl, now: clock().now });
    expect(await source()).toBeNull();
  });

  it('a failed refresh does not restart the cache window: the next read tries the feed again', async () => {
    const { fetchImpl, urls } = scriptedFetch([
      okResponse(body(0.34452, T0_SECONDS)),
      new Error('down'),
      okResponse(body(0.36, T0_SECONDS + 100)),
    ]);
    const time = clock();
    const source = createAbtUsdRateSource({ fetchImpl, now: time.now });
    await source();
    time.advance(ABT_RATE_CACHE_MS + 1);
    await source();
    time.advance(1_000);
    expect(await source()).toEqual({ usdPerToken: '0.36000000', updatedAt: new Date((T0_SECONDS + 100) * 1000) });
    expect(urls).toHaveLength(3);
  });
});

describe('the CoinGecko ABT/USD feed: the timeout', () => {
  it('a request that hangs past the timeout answers null, and the request carried an abort signal', async () => {
    let seenSignal: AbortSignal | undefined;
    const hanging = (async (_input: unknown, init?: { signal?: AbortSignal }) => {
      seenSignal = init?.signal;
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    const source = createAbtUsdRateSource({ fetchImpl: hanging, now: clock().now, timeoutMs: 30 });
    expect(await source()).toBeNull();
    expect(seenSignal?.aborted).toBe(true);
  });

  it('a request that hangs and honours its abort signal answers null', async () => {
    const { fetchImpl } = scriptedFetch(['hang']);
    const source = createAbtUsdRateSource({ fetchImpl, now: clock().now, timeoutMs: 30 });
    expect(await source()).toBeNull();
  });
});
