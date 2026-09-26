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
// lines print these same counts). FIX-S7 round 3 (Temper's ruling on the
// verify-vs-honest-user conflict qa's proof r2 raised): GET
// /agents/:agentDid moved from `verify` to `read` (rate-limit-classes.ts),
// so every count below that used to name a `verify` reading from that
// route now counts it as `read` instead; the browse page's own per-card
// avatar reads now consume zero `verify` at all.
//   - browse page, 10 cards (PAGE_SIZE, browse.js): 1 GET /agents + 10 GET
//     /agents/:agentDid (browse.js:376's per-card avatar read, both
//     `read` now) = 11 read + 0 verify in one page load. The page shell
//     itself (/browse, Accept: html) is exempt and consumes neither
//     bucket (rate-limit-classes.ts's EXEMPT_WEB_PAGE_PATHS).
//   - job page, SIGNED IN: GET /jobs/:jobId (the primary record) + GET
//     /agents/:agentDid (job.js's identity strip) + nav.js's own
//     signed-in reads (GET /accounts/me and GET
//     /accounts/:did/notifications) = up to 5 read + 0 verify measured;
//     the page shell for /jobs/:jobId itself is also exempt (Accept:
//     html, rate-limit-classes.ts's negotiated-page-shell rule), so it
//     consumes neither bucket either.
//   - deposit page, SIGNED IN: GET /jobs/:jobId + GET
//     /jobs/:jobId/attestations (authed party probe) + GET
//     /agents/:agentDid (renderWho) + GET /agents/:agentDid/hires +
//     nav.js's signed-in reads (GET /accounts/me, GET
//     /accounts/:did/notifications) = up to 7 read + 0 verify measured.
// The busiest measured burst for the `read` class in one page load is 11
// (the browse page's 1 listing + 10 avatar reads). `verify` now sees no
// page-load traffic at all: it serves only the 3 stranger/script routes
// (a sign-in callback, a passkey assertion, a credential lookup), each a
// single deliberate action. Defaults below sit at several times the
// measured bursts: `read` and `write` get generous per-minute budgets
// well above the 11-request browse burst; `verify` keeps its
// pre-existing 60/60s, several times any real use of those 3 routes;
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
  // browse/job/deposit page loads (real Chrome, signed in, see the
  // DEFAULTS TABLE header comment above) was 11, the browse page's own
  // listing plus its ten per-card avatar reads (GET /agents/:agentDid is
  // `read`, Temper's ruling, round 3); 300/minute is well above that,
  // many times any real read burst, including a buyer with several tabs
  // open.
  read: {
    envVar: 'FREEAGENTS_RATE_LIMIT_READ',
    limit: 300,
    reason: 'well above the busiest measured page-load read burst (browse page, 11 reads)',
  },
  // The 3 pre-existing routes a stranger or a script uses to prove
  // something (a sign-in callback, a passkey assertion, an issued
  // credential lookup): unchanged, kept at today's exact 60/minute so
  // behaviour for these routes does not shift. No page load a browser
  // itself drives touches this bucket at all (Temper's ruling, round 3,
  // moved GET /agents/:agentDid to `read`).
  verify: {
    envVar: 'FREEAGENTS_RATE_LIMIT_VERIFY',
    limit: 60,
    reason: 'unchanged from the pre-existing limiter; no ordinary page load touches this bucket at all',
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
