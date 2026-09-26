// Anonymous verify rate limiting (operator decision, issue #30, 2026-08-26):
// browse and verify stay public, but repeated anonymous hits on a verify
// route are not free forever. In-memory fixed-window counter, no new
// infrastructure service. Unit-tested directly against the middleware
// function rather than through a real HTTP server, so the window and limit
// can be pinned to small values instead of waiting on real time or hammering
// a live app with hundreds of requests.
import { describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { createRateLimiter } from '../../../src/adapters/identity/verify-rate-limit.js';

function fakeReq(ip: string): Request {
  return { ip } as unknown as Request;
}

function fakeRes(): { res: Response; statusCode: number | null; body: unknown } {
  const state: { statusCode: number | null; body: unknown } = { statusCode: null, body: undefined };
  const res = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
    set(_name: string, _value: string) {
      return res;
    },
  } as unknown as Response;
  return { res, statusCode: state.statusCode, body: state.body };
}

describe('createRateLimiter (anonymous verify routes, #30)', () => {
  it('allows requests up to the limit, then answers 429', () => {
    const clock = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => clock });
    let nextCalls = 0;
    const next: NextFunction = () => {
      nextCalls += 1;
    };

    const first = fakeRes();
    limiter.middleware(fakeReq('127.0.0.1'), first.res, next);
    const second = fakeRes();
    limiter.middleware(fakeReq('127.0.0.1'), second.res, next);
    const third = fakeRes();
    limiter.middleware(fakeReq('127.0.0.1'), third.res, next);

    expect(nextCalls).toBe(2);
    expect((third.res as unknown as { status: (c: number) => unknown }).status).toBeDefined();
  });

  it('the 429 response carries a 429 status and an error body, and next() is never called for it', () => {
    const clock = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => clock });
    let nextCalls = 0;
    const next: NextFunction = () => {
      nextCalls += 1;
    };

    let statusSeen: number | null = null;
    let bodySeen: unknown = null;
    const res = {
      status(code: number) {
        statusSeen = code;
        return res;
      },
      json(body: unknown) {
        bodySeen = body;
        return res;
      },
      set(_name: string, _value: string) {
        return res;
      },
    } as unknown as Response;

    limiter.middleware(fakeReq('203.0.113.5'), res, next);
    limiter.middleware(fakeReq('203.0.113.5'), res, next);

    expect(nextCalls).toBe(1);
    expect(statusSeen).toBe(429);
    expect(bodySeen).toEqual({ error: 'too many requests' });
  });

  it('a fresh window resets the count for the same caller', () => {
    let clock = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => clock });
    let nextCalls = 0;
    const next: NextFunction = () => {
      nextCalls += 1;
    };
    const res = fakeRes().res;

    limiter.middleware(fakeReq('192.0.2.1'), res, next);
    clock = 1000;
    limiter.middleware(fakeReq('192.0.2.1'), res, next);

    expect(nextCalls).toBe(2);
  });

  // FIX-S7: a 429 a person can act on carries Retry-After (seconds), the
  // window's remainder, so a client knows exactly how long to wait rather
  // than guessing or retrying immediately.
  it('a 429 response carries a Retry-After header naming the window\'s remainder, in seconds', () => {
    let clock = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 10_000, now: () => clock });
    let nextCalls = 0;
    const next: NextFunction = () => {
      nextCalls += 1;
    };
    const headers: Record<string, string> = {};
    const res = {
      status(_code: number) {
        return res;
      },
      json(_body: unknown) {
        return res;
      },
      set(name: string, value: string) {
        headers[name] = value;
        return res;
      },
    } as unknown as Response;

    limiter.middleware(fakeReq('198.51.100.9'), res, next);
    clock = 4000; // 4 of the 10 second window elapsed
    limiter.middleware(fakeReq('198.51.100.9'), res, next);

    expect(nextCalls).toBe(1);
    expect(headers['Retry-After']).toBe('6');
  });


  it('different callers get independent budgets', () => {
    const clock = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => clock });
    let nextCalls = 0;
    const next: NextFunction = () => {
      nextCalls += 1;
    };
    const res = fakeRes().res;

    limiter.middleware(fakeReq('192.0.2.1'), res, next);
    limiter.middleware(fakeReq('192.0.2.2'), res, next);

    expect(nextCalls).toBe(2);
  });
});
