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
// Chrome, driven by tests/helpers/real-browser.ts's own CDP driver,
// against a real createApp server; the measurement script is
// tests/web/rate-limit-burst-measurement.test.ts and is run, not typed by
// hand -- run it yourself with `npx vitest run
// tests/web/rate-limit-burst-measurement.test.ts` and its console.log
// lines print these same counts). FIX-S7 round 2 (qa proof r1, defect 3):
// round 1's numbers left out the signed-in job page and measured deposit
// signed-out only; both are measured signed in below, closing that gap.
//   - browse page, 10 cards (PAGE_SIZE, browse.js): 1 GET /agents (a
//     `read`) + 10 GET /agents/:agentDid (a `verify`, browse.js:376's
//     per-card avatar read) = 1 read + 10 verify in one page load. The
//     page shell itself (/browse, Accept: html) is exempt and consumes
//     neither bucket (rate-limit-classes.ts's EXEMPT_WEB_PAGE_PATHS).
//   - job page, SIGNED IN: 1 GET /jobs/:jobId (`read`, the primary
//     record) + 1 GET /agents/:agentDid (`verify`, job.js's identity
//     strip) + nav.js's own signed-in reads (GET /accounts/me and GET
//     /accounts/:did/notifications, both `read`) = up to 3 read + 1
//     verify measured; the page shell for /jobs/:jobId itself is also
//     exempt (Accept: html, rate-limit-classes.ts's negotiated-page-shell
//     rule), so it consumes neither bucket either.
//   - deposit page, SIGNED IN: GET /jobs/:jobId (`read`) + GET
//     /jobs/:jobId/attestations (`read`, authed party probe) + GET
//     /agents/:agentDid (`verify`, renderWho) + GET
//     /agents/:agentDid/hires (`read`) + nav.js's signed-in reads (GET
//     /accounts/me, GET /accounts/:did/notifications, both `read`) = up
//     to 6 read + 1 verify measured.
// The busiest measured burst for any one class in one page load is 10
// (`verify`, the browse page's 10 avatar reads) and 6 (`read`, the
// signed-in deposit page). Defaults below sit at several times both:
// `verify` keeps its pre-existing 60/60s (6x the browse burst); `read`
// and `write` get generous per-minute budgets scaled the same way (50x
// and more the signed-in deposit page's read burst); `upstream`
// (GitHub/chain calls, never seen in a page load a browser itself
// drives) is deliberately the tightest, since each request there costs a
// real external call.
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
  // browse/job/deposit page loads (real Chrome, signed in, see the
  // DEFAULTS TABLE header comment above) was 6, the signed-in deposit
  // page; 300/minute is 50 times that, many times any real read burst,
  // including a buyer with several tabs open.
  read: {
    envVar: 'FREEAGENTS_RATE_LIMIT_READ',
    limit: 300,
    reason: 'fifty times the busiest measured signed-in page-load read burst (deposit page, 6 reads)',
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
    const classification = classifyRoute(req.method, req.path, req.headers?.accept);
    if (classification === 'exempt') {
      next();
      return;
    }
    limiters[classification].middleware(req, res, next);
  };
}
