// S7 (security sweep 2026-09-06): one class-limiter middleware, mounted
// once in src/api/app.ts, picking a bucket per route class
// (rate-limit-classes.ts's classifyRoute) so exhausting one class never
// throttles another.
import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { createRateLimiter } from '../../src/adapters/identity/verify-rate-limit.js';
import {
  CLASS_DEFAULTS,
  createClassRateLimiters,
  createClassRateLimitMiddleware,
} from '../../src/api/rate-limit-middleware.js';

function fakeReq(method: string, path: string): Request {
  return { method, path, ip: '203.0.113.7' } as unknown as Request;
}

function fakeRes(): Response {
  const res = {
    status(_code: number) {
      return res;
    },
    json(_body: unknown) {
      return res;
    },
    set(_name: string, _value: string) {
      return res;
    },
  } as unknown as Response;
  return res;
}

describe('createClassRateLimiters: default limits, one bucket per class', () => {
  it('creates a distinct RateLimiter for each of the four classes', () => {
    const limiters = createClassRateLimiters();
    expect(limiters.upstream).toBeDefined();
    expect(limiters.write).toBeDefined();
    expect(limiters.read).toBeDefined();
    expect(limiters.verify).toBeDefined();
    // Distinct instances: exhausting one must never trip another's guard.
    expect(limiters.upstream).not.toBe(limiters.write);
    expect(limiters.write).not.toBe(limiters.read);
    expect(limiters.read).not.toBe(limiters.verify);
  });
});

describe('createClassRateLimiters: the injection seam (Make item 3)', () => {
  it('a bare RateLimiter passed as the override is treated as the verify class override, unchanged behaviour for the 4 existing test files', () => {
    const injected = createRateLimiter({ limit: 2, windowMs: 60_000 });
    const limiters = createClassRateLimiters(injected);
    expect(limiters.verify).toBe(injected);
    // Every other class still gets its own default-derived limiter, not
    // silently replaced by the same injected instance.
    expect(limiters.upstream).not.toBe(injected);
    expect(limiters.write).not.toBe(injected);
    expect(limiters.read).not.toBe(injected);
  });

  it('a ClassLimits object overrides only the named classes, by NUMBER (a generous override), and defaults the rest', () => {
    const limiters = createClassRateLimiters({ write: 1 });
    let nextCalls = 0;
    const next: NextFunction = () => {
      nextCalls += 1;
    };
    limiters.write.middleware(fakeReq('POST', '/accounts'), fakeRes(), next);
    limiters.write.middleware(fakeReq('POST', '/accounts'), fakeRes(), next);
    // limit: 1 trips on the second call.
    expect(nextCalls).toBe(1);
  });
});

describe('createClassRateLimitMiddleware: routes to the right bucket by class', () => {
  it('a write-class route only ever consumes the write bucket, never the read bucket', () => {
    const limiters = createClassRateLimiters({ write: 1, read: 100 });
    const middleware = createClassRateLimitMiddleware(limiters);
    const next = vi.fn();

    middleware(fakeReq('POST', '/accounts'), fakeRes(), next);
    middleware(fakeReq('POST', '/accounts'), fakeRes(), next);
    // write's limit of 1 trips on the second write call...
    expect(next).toHaveBeenCalledTimes(1);

    // ...but a read-class route from the SAME caller is entirely unaffected.
    middleware(fakeReq('GET', '/agents'), fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('exhausting the upstream bucket never throttles the write bucket for the same caller', () => {
    const limiters = createClassRateLimiters({ upstream: 1, write: 100 });
    const middleware = createClassRateLimitMiddleware(limiters);
    const next = vi.fn();

    middleware(fakeReq('POST', '/agents/did:abt:zA/account-proof'), fakeRes(), next);
    middleware(fakeReq('POST', '/agents/did:abt:zA/account-proof'), fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);

    middleware(fakeReq('POST', '/accounts'), fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('an exempt route (e.g. /health) calls next() immediately, consuming no bucket at all', () => {
    const limiters = createClassRateLimiters({ read: 0 });
    const middleware = createClassRateLimitMiddleware(limiters);
    const next = vi.fn();

    // read's own limit of 0 would reject any read-class request outright;
    // /health still passes because it is exempt, never routed to a bucket.
    middleware(fakeReq('GET', '/health'), fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('CLASS_DEFAULTS: one table, each default several times the measured browser burst', () => {
  it('names an env variable and a default for every class', () => {
    expect(CLASS_DEFAULTS.upstream.envVar).toBe('FREEAGENTS_RATE_LIMIT_UPSTREAM');
    expect(CLASS_DEFAULTS.write.envVar).toBe('FREEAGENTS_RATE_LIMIT_WRITE');
    expect(CLASS_DEFAULTS.read.envVar).toBe('FREEAGENTS_RATE_LIMIT_READ');
    expect(CLASS_DEFAULTS.verify.envVar).toBe('FREEAGENTS_RATE_LIMIT_VERIFY');
    for (const routeClass of ['upstream', 'write', 'read', 'verify'] as const) {
      expect(CLASS_DEFAULTS[routeClass].limit).toBeGreaterThan(0);
      expect(CLASS_DEFAULTS[routeClass].reason.length).toBeGreaterThan(0);
    }
  });

  it('the verify default stays at 60, unchanged from the pre-existing limiter', () => {
    expect(CLASS_DEFAULTS.verify.limit).toBe(60);
  });

  it('every default clears the browse page\'s measured burst of 10 (the busiest measured page-load class burst) several times over', () => {
    for (const routeClass of ['upstream', 'write', 'read', 'verify'] as const) {
      expect(CLASS_DEFAULTS[routeClass].limit).toBeGreaterThanOrEqual(10 * 2);
    }
  });
});

describe('createClassRateLimiters: each class limit is settable from its own env variable', () => {
  it('reads a positive numeric override from the env variable', () => {
    const original = process.env[CLASS_DEFAULTS.write.envVar];
    try {
      process.env[CLASS_DEFAULTS.write.envVar] = '3';
      const limiters = createClassRateLimiters();
      let nextCalls = 0;
      const next: NextFunction = () => {
        nextCalls += 1;
      };
      for (let i = 0; i < 4; i += 1) {
        limiters.write.middleware(fakeReq('POST', '/accounts'), fakeRes(), next);
      }
      // 3 allowed, the 4th trips.
      expect(nextCalls).toBe(3);
    } finally {
      if (original === undefined) delete process.env[CLASS_DEFAULTS.write.envVar];
      else process.env[CLASS_DEFAULTS.write.envVar] = original;
    }
  });

  it('falls back to the default when the env variable is unset or empty', () => {
    const original = process.env[CLASS_DEFAULTS.read.envVar];
    try {
      process.env[CLASS_DEFAULTS.read.envVar] = '';
      const limiters = createClassRateLimiters();
      let nextCalls = 0;
      const next: NextFunction = () => {
        nextCalls += 1;
      };
      // Default (300) comfortably allows this many requests without tripping.
      for (let i = 0; i < 50; i += 1) {
        limiters.read.middleware(fakeReq('GET', '/agents'), fakeRes(), next);
      }
      expect(nextCalls).toBe(50);
    } finally {
      if (original === undefined) delete process.env[CLASS_DEFAULTS.read.envVar];
      else process.env[CLASS_DEFAULTS.read.envVar] = original;
    }
  });
});
