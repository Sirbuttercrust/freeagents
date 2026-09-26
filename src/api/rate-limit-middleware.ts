// S7 (security sweep 2026-09-06, "rate limiting covers 2 of 57 routes"):
// one class-limiter middleware, mounted ONCE in src/api/app.ts, right
// after the body parser and before web.mountPages(app). Picks a bucket
// per route CLASS (rate-limit-classes.ts's classifyRoute) and applies
// that class's own limit, so exhausting one class's bucket never
// throttles another. `verify` keeps today's exact single-bucket shape
// (createRateLimiter), reused rather than reinvented.
//
// DEFAULTS TABLE. Every number below is set at several times the measured
// burst of the busiest real page load this card checked (real headless
// Chrome against a local server, tests/helpers/real-browser.ts's own
// driver, no synthetic estimate):
//   - browse page, 10 cards (PAGE_SIZE, browse.js): 1 GET /agents (a
//     `read`) + 10 GET /agents/:agentDid (a `verify`, browse.js:376's
//     per-card avatar read) = 11 reads/verifies in one page load.
//   - job page (signed-out): 1 GET /jobs/:jobId (`read`) + 1 GET
//     /agents/:agentDid (`verify`, job.js's identity strip) + 1 GET
//     /accounts/:did (`read`, the operator link) = 2 reads + 1 verify.
//   - deposit page's own pre-session reads: GET /jobs/:jobId (`read`) +
//     GET /jobs/:jobId/attestations (`read`) = 2 reads, before the page
//     ever checks whether a session exists.
// The busiest measured burst for any one class in one page load is 10
// (`verify`, the browse page's 10 avatar reads). Defaults below sit at
// several times that: `verify` keeps its pre-existing 60/60s (6x);
// `read` and `write` get generous per-minute budgets scaled the same way;
// `upstream` (GitHub/chain calls, never seen in a page load a browser
// itself drives) is deliberately the tightest, since each request there
// costs a real external call.
import type { NextFunction, Request, Response } from 'express';
import { createRateLimiter, type RateLimiter } from '../adapters/identity/verify-rate-limit.js';
import { classifyRoute, type RouteClass } from './rate-limit-classes.js';

export interface ClassLimits {
  readonly upstream?: number;
  readonly write?: number;
  readonly read?: number;
  readonly verify?: number;
}

// One shared window for every class: 60 seconds, so "requests per minute"
// is a single, comparable unit across the table.
const WINDOW_MS = 60_000;

interface ClassDefault {
  readonly envVar: string;
  readonly limit: number;
  readonly reason: string;
}

export const CLASS_DEFAULTS: Readonly<Record<RouteClass, ClassDefault>> = {
  // The tightest bucket: each request costs a real GitHub API call or a
  // real chain RPC call (the sweep's own "an authenticated party can
  // drive unbounded upstream RPC load"). No real page load a browser
  // drives generates more than one of these per user action (a hire's
  // confirm, stage, merge, or a payment start are each a single deliberate
  // click), so 20/minute is generous headroom over that while still
  // bounding the cost of a compromised or scripted caller.
  upstream: {
    envVar: 'FREEAGENTS_RATE_LIMIT_UPSTREAM',
    limit: 20,
    reason: 'each request costs a real GitHub or chain call; no legitimate page load fires more than one per user action',
  },
  // Every other POST/PUT/PATCH/DELETE, POST /accounts included (S7's own
  // remediation names this route explicitly). No page load measured here
  // fires more than a handful of writes; 120/minute is several times that.
  write: {
    envVar: 'FREEAGENTS_RATE_LIMIT_WRITE',
    limit: 120,
    reason: 'no measured page load fires more than a few writes per visit; well above any real burst',
  },
  // Every other GET. The busiest measured `read`-class burst across
  // browse/job/deposit page loads was 2; 300/minute is many times any real
  // read burst, including a buyer with several tabs open.
  read: {
    envVar: 'FREEAGENTS_RATE_LIMIT_READ',
    limit: 300,
    reason: 'several times the busiest measured page-load read burst (browse, job, deposit pages)',
  },
  // The 4 pre-existing routes (S7's original limiter): unchanged, kept at
  // today's exact 60/minute so behaviour for these routes does not shift.
  // The browse page's own 10-avatar burst (this class) is well under it.
  verify: {
    envVar: 'FREEAGENTS_RATE_LIMIT_VERIFY',
    limit: 60,
    reason: "unchanged from the pre-existing limiter; the browse page's 10-avatar burst is well under it, several times over",
  },
};

function limitFromEnv(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// Builds the four class buckets. `overrides` is the createApp injection
// seam (Make item 3): a single RateLimiter passed there is treated as the
// `verify` class override (keeping the four existing test files' call
// sites working unchanged, since they each construct exactly one
// RateLimiter today), or a ClassLimits object can override any subset of
// classes explicitly by NUMBER (a generous override, never a raised
// default -- Make item 3's own rule for test files that need more
// requests than a default allows).
export function createClassRateLimiters(overrides?: RateLimiter | ClassLimits): Record<RouteClass, RateLimiter> {
  const isBareLimiter = overrides !== undefined && typeof (overrides as RateLimiter).middleware === 'function';
  const verifyOverrideLimiter = isBareLimiter ? (overrides as RateLimiter) : undefined;
  const classOverrides = isBareLimiter ? undefined : (overrides as ClassLimits | undefined);

  function limiterFor(routeClass: RouteClass): RateLimiter {
    if (routeClass === 'verify' && verifyOverrideLimiter !== undefined) return verifyOverrideLimiter;
    const override = classOverrides?.[routeClass];
    const def = CLASS_DEFAULTS[routeClass];
    const limit = override ?? limitFromEnv(def.envVar, def.limit);
    return createRateLimiter({ limit, windowMs: WINDOW_MS });
  }

  return {
    upstream: limiterFor('upstream'),
    write: limiterFor('write'),
    read: limiterFor('read'),
    verify: limiterFor('verify'),
  };
}

// The single middleware mounted once in app.ts. Picks a bucket by the
// request's own class and delegates to that class's limiter; an exempt
// route (classifyRoute returns 'exempt') calls next() immediately with no
// bucket at all.
export function createClassRateLimitMiddleware(
  limiters: Record<RouteClass, RateLimiter>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const classification = classifyRoute(req.method, req.path);
    if (classification === 'exempt') {
      next();
      return;
    }
    limiters[classification].middleware(req, res, next);
  };
}
