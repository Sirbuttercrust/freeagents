// In-memory rate limiting for anonymous verify routes (operator decision,
// issue #30, 2026-08-26): browse and verify stay public with no session and
// no account, but repeated anonymous hits on a verify route are not free
// forever. A session lifts nothing here -- the limit bucket is per caller
// identifier, not per credential, so signing in never raises it.
//
// Fixed window per key, kept honest and minimal per the brief: no new
// infrastructure service, just a Map the process already owns. The window
// resets on the wall clock, not on a sliding count, so the worst case is a
// caller getting `limit` requests at the very start and end of adjacent
// windows -- an acceptable trade against real infrastructure for a v1 that
// exists to stop casual scraping, not a determined attacker.
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
      // available -- exactly the boundary the #30 decision describes.
      const key = req.ip ?? 'unknown';
      const t = now();
      const existing = buckets.get(key);

      if (existing === undefined || t - existing.windowStart >= windowMs) {
        buckets.set(key, { count: 1, windowStart: t });
        next();
        return;
      }

      if (existing.count >= limit) {
        res.status(429).json({ error: 'too many requests' });
        return;
      }

      existing.count += 1;
      next();
    },
  };
}
