// Fixed-window rate limiting, shared by every rate-limit class this app
// mounts (verify, upstream, write, read -- src/api/rate-limit-classes.ts
// names the classes, src/api/app.ts wires one bucket per class). One
// caller identifier (req.ip -- Express's own best-effort address, honest
// about a proxy only once FREEAGENTS_TRUST_PROXY says so, see
// src/adapters/config/trust-proxy.ts), one Map the process already owns,
// no new infrastructure service.
//
// Fixed window per key: the window resets on the wall clock, not on a
// sliding count, so the worst case is a caller getting `limit` requests at
// the very start and end of adjacent windows -- an acceptable trade
// against real infrastructure for a v1 that exists to stop casual scraping
// and to bound each route CLASS's own upstream/storage load, not to
// resist a determined, distributed attacker.
import type { NextFunction, Request, Response } from 'express';

export interface RateLimiterOptions {
  readonly limit: number;
  readonly windowMs: number;
  /** Injected clock, for testing the window boundary. */
  readonly now?: () => number;
}

export interface RateLimiter {
  middleware(req: Request, res: Response, next: NextFunction): void;
}

interface Bucket {
  count: number;
  windowStart: number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { limit, windowMs } = options;
  const now = options.now ?? (() => Date.now());
  const buckets = new Map<string, Bucket>();

  return {
    middleware(req: Request, res: Response, next: NextFunction): void {
      // req.ip is Express's own best-effort caller identifier. No account
      // or session backs an anonymous request, so this is the only handle
      // available for the verify class, and the same handle every other
      // class uses too, so a class boundary is never crossed by identity
      // alone -- only by which bucket the request's own route class picked.
      const key = req.ip ?? 'unknown';
      const t = now();
      const existing = buckets.get(key);

      if (existing === undefined || t - existing.windowStart >= windowMs) {
        buckets.set(key, { count: 1, windowStart: t });
        next();
        return;
      }

      if (existing.count >= limit) {
        // FIX-S7 Make item 4: "The 429 a person can act on." Retry-After
        // is the window's remainder in whole seconds, rounded UP so a
        // client that waits exactly this long never retries a moment too
        // early (a caller arriving mid-second still needs the rest of
        // that second, not the truncated part of it).
        const elapsedMs = t - existing.windowStart;
        const remainderMs = Math.max(0, windowMs - elapsedMs);
        const retryAfterSeconds = Math.ceil(remainderMs / 1000);
        res.set('Retry-After', String(retryAfterSeconds));
        res.status(429).json({ error: 'too many requests' });
        return;
      }

      existing.count += 1;
      next();
    },
  };
}
