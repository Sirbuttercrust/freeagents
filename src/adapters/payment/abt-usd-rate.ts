// The ABT/USD price feed: CoinGecko's free public API, no key
// (MAP.md "ABT price source and fee"; MISSION.md: "ABT is converted at
// CoinGecko's public ABT/USD price"). CoinGecko lists ABT under the id
// `arcblock`. Reads go through an injectable fetch and clock, the pattern
// the webhook sender uses, so no test touches the network.
import type { RateReading } from './types.js';

const COINGECKO_ABT_USD_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=arcblock&vs_currencies=usd&include_last_updated_at=true';

// CoinGecko's own cache lifetime for the keyless tier. Asking more often
// than this only spends the per-IP rate limit and returns the same number.
export const ABT_RATE_CACHE_MS = 60_000;

// A reading whose feed time is older than this is not quoted. CoinGecko's
// data was measured 72 to 125 seconds old on a normal read; adding our own
// 60 second cache keeps a healthy reading well under 5 minutes, so only a
// feed that has genuinely stopped updating crosses it.
export const ABT_RATE_STALE_AFTER_MS = 300_000;

// How long one request may take. A quote waits on this call, so a hung
// connection must turn into "no price" quickly instead of holding the buyer.
export const ABT_RATE_TIMEOUT_MS = 5_000;

// Token amounts are computed from the rate at this many fractional digits
// (usdToTokenAmount's RATE_PRECISION in domain/payment.ts).
const PRICE_DECIMALS = 8;

export interface AbtUsdRateSourceOptions {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  readonly url?: string;
}

export type AbtUsdRateSource = () => Promise<RateReading | null>;

// A plain decimal string with 8 fractional digits, or null when the value
// is not a usable price: not a finite positive number, one that rounds to
// zero at 8 places, or one too large to print without an exponent.
function formatPrice(usd: unknown): string | null {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return null;
  const fixed = usd.toFixed(PRICE_DECIMALS);
  if (fixed.includes('e')) return null;
  return Number(fixed) === 0 ? null : fixed;
}

function parseReading(text: string): RateReading | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const entry = (parsed as { arcblock?: { usd?: unknown; last_updated_at?: unknown } } | null)?.arcblock;
  if (entry === undefined || entry === null) return null;
  const usdPerToken = formatPrice(entry.usd);
  const seconds = entry.last_updated_at;
  if (usdPerToken === null || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return { usdPerToken, updatedAt: new Date(seconds * 1000) };
}

export function createAbtUsdRateSource(options: AbtUsdRateSourceOptions = {}): AbtUsdRateSource {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? ABT_RATE_TIMEOUT_MS;
  const url = options.url ?? COINGECKO_ABT_USD_URL;

  let cached: { readonly reading: RateReading; readonly fetchedAtMs: number } | null = null;
  let inflight: Promise<RateReading | null> | null = null;

  // A reading is answered only while its feed time is inside the cutoff.
  function usable(reading: RateReading | undefined): RateReading | null {
    if (reading === undefined) return null;
    return now().getTime() - reading.updatedAt.getTime() > ABT_RATE_STALE_AFTER_MS ? null : reading;
  }

  async function requestReading(): Promise<RateReading | null> {
    const signal = AbortSignal.timeout(timeoutMs);
    // A fetch that ignores its signal must still not hold the caller, so
    // the abort also rejects a race of our own.
    const aborted = new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('the ABT price request timed out')));
    });
    const work = (async () => {
      const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal });
      if (!response.ok) return null;
      return parseReading(await response.text());
    })();
    // The loser of the race must not surface as an unhandled rejection.
    work.catch(() => undefined);
    aborted.catch(() => undefined);
    return Promise.race([work, aborted]);
  }

  async function refresh(): Promise<RateReading | null> {
    try {
      const reading = await requestReading();
      if (reading !== null) {
        cached = { reading, fetchedAtMs: now().getTime() };
        return usable(reading);
      }
    } catch {
      // Falls through to the cached reading below.
    }
    // A failed refresh leaves the cache's own timestamp alone, so the next
    // read tries the feed again; the old reading is served only while it is
    // inside the staleness cutoff.
    return usable(cached?.reading);
  }

  return async () => {
    if (cached !== null && now().getTime() - cached.fetchedAtMs < ABT_RATE_CACHE_MS) {
      return usable(cached.reading);
    }
    if (inflight === null) {
      inflight = refresh().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  };
}
