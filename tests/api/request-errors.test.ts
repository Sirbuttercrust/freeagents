// B69 and B80: a request the platform cannot read is answered as the
// caller's mistake (its own 4xx and a sentence naming what to change), not as
// a crash, and every request spends its rate-limit bucket before its body is
// read. Everything here runs against a real listening server on createApp().
import { gzipSync } from 'node:zlib';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express, NextFunction, Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { brokenAddressErrorHandler, bodyParserErrorHandler } from '../../src/api/request-errors.js';
import type { ClassLimits } from '../../src/api/rate-limit-middleware.js';
import { createWebSurface, type WebSurface } from '../../src/web/static.js';

const GENEROUS: ClassLimits = { upstream: 1_000_000, write: 1_000_000, read: 1_000_000, verify: 1_000_000 };

const PARSE_SENTENCE = 'The request body must be valid JSON, an object or an array.';
const SIZE_SENTENCE = 'The request body is larger than 15 MB.';
const ENCODING_SENTENCE =
  'The request body uses a Content-Encoding this service does not read. Send it uncompressed, or as gzip or deflate.';
const CHARSET_SENTENCE = 'The request body must be sent as UTF-8.';
const GENERAL_SENTENCE = 'The request body could not be read.';
const ADDRESS_SENTENCE =
  'The address has a broken percent-escape: a % that is not followed by two hex digits that decode.';

// 15 MB as body-parser reads it: 15 * 1024 * 1024 bytes.
const LIMIT_BYTES = 15 * 1024 * 1024;

interface Running {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

function listen(app: Express): Promise<Running> {
  return new Promise((resolve) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function appWith(rateLimits: ClassLimits = GENEROUS, web?: WebSurface): Express {
  return createApp(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    rateLimits,
    web,
  );
}

// Same walk as tests/architecture/rate-limit-enforcement.test.ts: the app's
// own router stack, never a typed list.
interface ExpressLayer {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: ExpressLayer[] };
}
function writeRoutes(app: Express): Array<{ method: string; path: string }> {
  const stack = (app as unknown as { _router: { stack: ExpressLayer[] } })._router.stack;
  const out: Array<{ method: string; path: string }> = [];
  const walk = (layers: ExpressLayer[]): void => {
    for (const layer of layers) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods).filter((k) => layer.route?.methods[k])) {
          const method = m.toUpperCase();
          if (method !== 'GET' && method !== 'HEAD') out.push({ method, path: layer.route.path });
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack);
      }
    }
  };
  walk(stack);
  return out;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// What POST /jobs answers a caller with no signature: the route's own answer,
// which a body that was read reaches.
const UNSIGNED_JOBS_BODY = {
  error:
    'this route requires a session (sign in with GitHub OAuth or a passkey) or a verified request signature (R-34)',
};

describe('a request the platform cannot read is answered as the caller\'s mistake (B69)', () => {
  let running: Running;
  let errorSpy: MockInstance;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    errorSpy.mockRestore();
    await running?.close();
  });

  it('(a) answers a body that is not JSON with 400 and the parse sentence on every route that takes a body, logging nothing', async () => {
    const app = appWith();
    const routes = writeRoutes(app);
    expect(routes.length).toBeGreaterThanOrEqual(47);
    running = await listen(app);

    const wrong: Array<{ route: string; status: number; body: unknown }> = [];
    for (const { method, path } of routes) {
      const url = `${running.baseUrl}${path.replace(/:[A-Za-z]+/g, 'x')}`;
      const res = await fetch(url, { method, headers: JSON_HEADERS, body: '{bad' });
      const body = await res.json().catch(() => null);
      if (res.status !== 400 || JSON.stringify(body) !== JSON.stringify({ error: PARSE_SENTENCE })) {
        wrong.push({ route: `${method} ${path}`, status: res.status, body });
      }
    }
    expect(wrong).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('(a) answers a JSON string, which strict mode refuses, with 400 and the parse sentence', async () => {
    running = await listen(appWith());
    const res = await fetch(`${running.baseUrl}/jobs`, { method: 'POST', headers: JSON_HEADERS, body: '"x"' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: PARSE_SENTENCE });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('(b) answers a body one byte over the limit with 413 and the size sentence', async () => {
    running = await listen(appWith());
    const prefix = '{"pad":"';
    const suffix = '"}';
    const body = prefix + 'a'.repeat(LIMIT_BYTES + 1 - prefix.length - suffix.length) + suffix;
    expect(Buffer.byteLength(body)).toBe(LIMIT_BYTES + 1);
    const res = await fetch(`${running.baseUrl}/jobs`, { method: 'POST', headers: JSON_HEADERS, body });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: SIZE_SENTENCE });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('(b) lets a valid JSON body one kilobyte under the limit reach the route, which answers its own 401', async () => {
    running = await listen(appWith());
    const prefix = '{"pad":"';
    const suffix = '"}';
    const body = prefix + 'a'.repeat(LIMIT_BYTES - 1024 - prefix.length - suffix.length) + suffix;
    expect(Buffer.byteLength(body)).toBe(LIMIT_BYTES - 1024);
    const res = await fetch(`${running.baseUrl}/jobs`, { method: 'POST', headers: JSON_HEADERS, body });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(UNSIGNED_JOBS_BODY);
  });

  it('(c) answers Content-Encoding br with 415 and the encoding sentence', async () => {
    running = await listen(appWith());
    const res = await fetch(`${running.baseUrl}/jobs`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'Content-Encoding': 'br' },
      body: Buffer.from('{}'),
    });
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: ENCODING_SENTENCE });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('(c) answers charset=latin1 with 415 and the charset sentence', async () => {
    running = await listen(appWith());
    const res = await fetch(`${running.baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=latin1' },
      body: '{}',
    });
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: CHARSET_SENTENCE });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('(c) still reads a gzip body and a utf-16le body, which reach the route and answer its own 401', async () => {
    running = await listen(appWith());
    const gz = await fetch(`${running.baseUrl}/jobs`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'Content-Encoding': 'gzip' },
      body: gzipSync(Buffer.from('{"brief":"x"}')),
    });
    expect(gz.status).toBe(401);
    expect(await gz.json()).toEqual(UNSIGNED_JOBS_BODY);

    const u16 = await fetch(`${running.baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-16le' },
      body: Buffer.from('{"brief":"x"}', 'utf16le'),
    });
    expect(u16.status).toBe(401);
    expect(await u16.json()).toEqual(UNSIGNED_JOBS_BODY);
  });

  it('(d) answers a corrupt gzip body with 400 and the general sentence', async () => {
    running = await listen(appWith());
    const res = await fetch(`${running.baseUrl}/jobs`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'Content-Encoding': 'gzip' },
      body: Buffer.from('this is not gzip data at all'),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: GENERAL_SENTENCE });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('a broken percent-escape in the address is answered as the caller\'s mistake (B69)', () => {
  let running: Running;
  let errorSpy: MockInstance;

  beforeEach(async () => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    running = await listen(appWith());
  });
  afterEach(async () => {
    errorSpy.mockRestore();
    await running.close();
  });

  it('(e) answers GET with Accept application/json 400 and the address sentence', async () => {
    const res = await fetch(`${running.baseUrl}/agents/%E0%A4%A`, { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: ADDRESS_SENTENCE });
    const second = await fetch(`${running.baseUrl}/jobs/%E0%A4%A`, { headers: { Accept: 'application/json' } });
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: ADDRESS_SENTENCE });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('(e) answers a browser the same not-found page, byte for byte, as an unknown address', async () => {
    const broken = await fetch(`${running.baseUrl}/agents/%E0%A4%A`, { headers: { Accept: 'text/html' } });
    const unknown = await fetch(`${running.baseUrl}/no-such-page`, { headers: { Accept: 'text/html' } });
    expect(unknown.status).toBe(404);
    expect(broken.status).toBe(404);
    expect(broken.headers.get('content-type')).toBe(unknown.headers.get('content-type'));
    const brokenText = await broken.text();
    expect(brokenText.length).toBeGreaterThan(0);
    expect(brokenText).toBe(await unknown.text());
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('(e) answers HEAD with Accept text/html 404', async () => {
    const res = await fetch(`${running.baseUrl}/agents/%E0%A4%A`, { method: 'HEAD', headers: { Accept: 'text/html' } });
    expect(res.status).toBe(404);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('(e) answers HEAD with no HTML preference 400', async () => {
    const res = await fetch(`${running.baseUrl}/agents/%E0%A4%A`, { method: 'HEAD', headers: { Accept: 'application/json' } });
    expect(res.status).toBe(400);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('(e) answers a POST with a valid body 400 JSON even when the caller prefers HTML', async () => {
    const res = await fetch(`${running.baseUrl}/jobs/%E0%A4%A/criteria`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, Accept: 'text/html' },
      body: '{"criteria":[]}',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: ADDRESS_SENTENCE });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('what still answers 500 and 404 (B69)', () => {
  let running: Running;
  let errorSpy: MockInstance;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    errorSpy.mockRestore();
    await running?.close();
  });

  it('(f) answers an unknown path 404 not found', async () => {
    running = await listen(appWith());
    const res = await fetch(`${running.baseUrl}/no-such-page`, { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('(f) answers a route\'s own fault that only looks like a caller\'s mistake 500 internal error and logs it once', async () => {
    const real = createWebSurface();
    const web: WebSurface = {
      ...real,
      mountPages(app: Express): void {
        real.mountPages(app);
        app.get('/zz-looks-like-a-callers-mistake', (_req: Request, _res: Response, next: NextFunction) => {
          const err = Object.assign(new Error('a fault in our own code'), {
            status: 400,
            type: 'entity.parse.failed',
          });
          next(err);
        });
      },
    };
    running = await listen(appWith(GENEROUS, web));
    const res = await fetch(`${running.baseUrl}/zz-looks-like-a-callers-mistake`, {
      headers: { Accept: 'application/json' },
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe('every request spends its rate-limit bucket before its body is read (B80)', () => {
  let running: Running;

  afterEach(async () => {
    await running?.close();
  });

  const write3: ClassLimits = { ...GENEROUS, write: 3 };

  async function spendThree(): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(`${running.baseUrl}/jobs`, { method: 'POST', headers: JSON_HEADERS, body: '{bad' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: PARSE_SENTENCE });
    }
  }

  it('(g) answers the fourth request 429 when its body is malformed too', async () => {
    running = await listen(appWith(write3));
    await spendThree();
    const res = await fetch(`${running.baseUrl}/jobs`, { method: 'POST', headers: JSON_HEADERS, body: '{bad' });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'too many requests' });
  });

  it('(g) answers the fourth request 429 when its body is well formed', async () => {
    running = await listen(appWith(write3));
    await spendThree();
    const res = await fetch(`${running.baseUrl}/jobs`, { method: 'POST', headers: JSON_HEADERS, body: '{"brief":"x"}' });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'too many requests' });
  });
});

// The two handlers decide by status and type alone, so their pass-on
// branches are pinned here with a stand-in response: the parser cannot be
// made to raise a 5xx over the wire.
interface Recorded {
  status?: number;
  body?: unknown;
  nextArg?: unknown;
  nextCalled: boolean;
}
function run(
  handler: (err: unknown, req: Request, res: Response, next: NextFunction) => void,
  err: unknown,
  req: Partial<Request> = { method: 'POST', headers: {} },
): Recorded {
  const rec: Recorded = { nextCalled: false };
  const res = {
    status(code: number) {
      rec.status = code;
      return res;
    },
    json(body: unknown) {
      rec.body = body;
      return res;
    },
  } as unknown as Response;
  handler(err, req as Request, res, (e?: unknown) => {
    rec.nextCalled = true;
    rec.nextArg = e;
  });
  return rec;
}

describe('the handlers pass on what is not theirs (B69)', () => {
  it('the parser handler passes a 5xx on to the terminal layer, answering nothing', () => {
    const err = Object.assign(new Error('parser fault'), { status: 500, type: 'entity.too.large' });
    expect(run(bodyParserErrorHandler, err)).toEqual({ nextCalled: true, nextArg: err });
  });

  it('the parser handler passes an error with no status on, answering nothing', () => {
    const err = new Error('no status');
    expect(run(bodyParserErrorHandler, err)).toEqual({ nextCalled: true, nextArg: err });
  });

  it('the parser handler answers an error carrying its own other 4xx with that status and the general sentence', () => {
    const err = Object.assign(new Error('gone'), { status: 410 });
    expect(run(bodyParserErrorHandler, err)).toEqual({
      status: 410,
      body: { error: GENERAL_SENTENCE },
      nextCalled: false,
    });
  });

  it('the address handler passes a URIError that is not a 400 on, answering nothing', () => {
    const err = Object.assign(new URIError('odd'), { status: 500 });
    expect(run(brokenAddressErrorHandler, err)).toEqual({ nextCalled: true, nextArg: err });
  });

  it('the address handler passes an Error that is not a URIError on, whatever its status', () => {
    const err = Object.assign(new Error('not a URIError'), { status: 400 });
    expect(run(brokenAddressErrorHandler, err)).toEqual({ nextCalled: true, nextArg: err });
  });
});
