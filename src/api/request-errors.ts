// B69: a request the platform cannot read is the caller's mistake, so it is
// answered with its own 4xx and a sentence saying what to change, and writes
// nothing to the operator's log. A fault of ours still reaches the terminal
// error layer in app.ts as a 500.
import type { NextFunction, Request, Response } from 'express';
import { prefersHtml } from '../web/static.js';

// The one number express.json reads as its `limit` and the size sentence
// quotes, so the two cannot drift. body-parser reads '15mb' as 15 * 1024 *
// 1024 bytes.
export const JSON_BODY_LIMIT_MB = 15;
export const JSON_BODY_LIMIT = `${JSON_BODY_LIMIT_MB}mb`;

const PARSE_FAILED = 'The request body must be valid JSON, an object or an array.';
const TOO_LARGE = `The request body is larger than ${JSON_BODY_LIMIT_MB} MB.`;
const ENCODING_UNSUPPORTED =
  'The request body uses a Content-Encoding this service does not read. Send it uncompressed, or as gzip or deflate.';
const CHARSET_UNSUPPORTED = 'The request body must be sent as UTF-8.';
const NOT_READABLE = 'The request body could not be read.';
const BROKEN_ESCAPE =
  'The address has a broken percent-escape: a % that is not followed by two hex digits that decode.';

const SENTENCE_BY_TYPE: Readonly<Record<string, string>> = {
  'entity.parse.failed': PARSE_FAILED,
  'entity.too.large': TOO_LARGE,
  'encoding.unsupported': ENCODING_UNSUPPORTED,
  'charset.unsupported': CHARSET_UNSUPPORTED,
};

interface StatusError {
  readonly status?: unknown;
  readonly type?: unknown;
}

function clientStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const status = (err as StatusError).status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 499
    ? status
    : undefined;
}

// Mounted directly after express.json. Its position is its scope: no route
// has run yet, so the only errors that can reach it come from the parser (and
// from the rate limiter mounted above the parser). An error carrying its own
// 4xx is answered with that status; anything else, a parser 5xx included,
// goes on to the terminal layer.
export function bodyParserErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  const status = clientStatus(err);
  if (status === undefined) {
    next(err);
    return;
  }
  const type = (err as StatusError).type;
  const sentence = (typeof type === 'string' ? SENTENCE_BY_TYPE[type] : undefined) ?? NOT_READABLE;
  res.status(status).json({ error: sentence });
}

// Mounted just before the unmatched-path fallback. Express raises a URIError
// with status 400 when a route parameter has a broken percent-escape. A
// browser asking for a page gets the same not-found page an unknown address
// gets; every other caller is told what is wrong with the address.
export function brokenAddressErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (!(err instanceof URIError) || clientStatus(err) !== 400) {
    next(err);
    return;
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && prefersHtml(req.headers.accept)) {
    next();
    return;
  }
  res.status(400).json({ error: BROKEN_ESCAPE });
}
