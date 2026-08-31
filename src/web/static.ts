// The public web surface: static files plus the page shells the browser
// asks for, mounted on the same express app and therefore the same port, so
// the blocklet's single web interface covers the API and the site together.
//
// TWO RULES SHAPE EVERYTHING HERE.
//
// 1. THE API KEEPS PRIORITY. Three page paths collide with real API routes
//    (`/agents/:did`, `/operators/:did`, `/v1/credentials/:id`), and the
//    collision is deliberate rather than accidental: a credential's id IS
//    its address (ENT-8), so a person handed one pastes it into a browser
//    and must land on something readable, while a verifier fetching the
//    same URL must still get the signed document byte for byte
//    (invariant 2). Both are served by asking what the caller wants:
//    a request is answered with HTML only when it EXPLICITLY asks for
//    text/html. Anything else - `*/*` from fetch and curl,
//    `application/ld+json` from a verifier, no Accept header at all - falls
//    through untouched to the API handler it always reached.
//
// 2. AN UNKNOWN PATH ANSWERS IN THE CALLER'S LANGUAGE. A browser gets the
//    404 page; every other client gets the same `{ error: 'not found' }`
//    JSON the API answers with everywhere else. Serving an HTML page to a
//    JSON client would be a worse lie than the 404 itself.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';

// The marker that identifies the web directory. Checked rather than assumed:
// this module is compiled to dist/src/web/static.js in production and run
// from src/web/static.ts in development, so the number of levels between it
// and the repository root differs by run mode. Walking up for a file that
// must exist answers the question in both, and refuses to guess in neither.
const WEB_MARKER = join('pages', 'landing.html');

// How far up to walk. dist/src/web -> dist/src -> dist -> repo root is three,
// so six is generous headroom without ever escaping to the filesystem root
// on a machine where the marker is missing.
const MAX_WALK = 6;

// Thrown at app construction when the web assets cannot be located. Loud on
// purpose: a server that starts and then serves nothing at / is the failure
// mode this whole function exists to prevent, and a silent fallback would
// turn a deployment mistake into a mystery.
export class WebAssetsNotFoundError extends Error {
  constructor(searched: readonly string[]) {
    super(
      `web assets not found: no directory containing ${WEB_MARKER} in ${searched.join(', ')}`,
    );
    this.name = 'WebAssetsNotFoundError';
  }
}

export function resolveWebDir(from: string = dirname(fileURLToPath(import.meta.url))): string {
  const searched: string[] = [];
  let here = resolve(from);
  for (let i = 0; i <= MAX_WALK; i += 1) {
    // Two shapes are checked at every level: this directory IS the web
    // directory (development, where the module sits in src/web), or it
    // CONTAINS one at src/web (production, walking up out of dist).
    for (const candidate of [here, join(here, 'src', 'web')]) {
      searched.push(candidate);
      if (existsSync(join(candidate, WEB_MARKER))) return candidate;
    }
    const up = dirname(here);
    if (up === here) break;
    here = up;
  }
  throw new WebAssetsNotFoundError(searched);
}

// A caller wants HTML only when it says so. Browsers send
// `text/html,application/xhtml+xml,...`; fetch and curl send `*/*`, which is
// not a request for HTML and must never be treated as one, because that is
// the difference between a verifier reading a credential and a verifier
// reading a web page about one.
export function prefersHtml(accept: string | undefined): boolean {
  if (typeof accept !== 'string') return false;
  return accept.split(',').some((part) => (part.split(';')[0] ?? '').trim().toLowerCase() === 'text/html');
}

// The page files, read once at construction. They are a few kilobytes each
// and never change while the process runs, so re-reading per request would
// buy nothing and add a filesystem fault to every page view.
type PageName =
  | 'landing'
  | 'how'
  | 'browse'
  | 'signin'
  | 'verify'
  | 'agent'
  | 'operator'
  | 'credential'
  | 'notfound';

const PAGE_FILES: Readonly<Record<PageName, string>> = {
  landing: 'landing.html',
  how: 'how.html',
  browse: 'browse.html',
  signin: 'signin.html',
  verify: 'verify.html',
  agent: 'agent.html',
  operator: 'operator.html',
  credential: 'credential.html',
  notfound: 'notfound.html',
};

// WHERE THIS DEPLOYMENT'S SOURCE LIVES, AND WHY IT IS NOT IN THE TREE.
//
// SITEMAP.md section 2 gives the footer four links, two of which point at
// the source repository and its licence. A repository URL hardcoded into
// the pages would be a specific account's address baked into a public tree
// that names its own location nowhere else, so it is configuration, read the
// same way FREEAGENTS_PUBLIC_BASE_URL is.
//
// Unset, both links are REMOVED rather than pointed at a guess. A footer
// with two links is honest about a deployment that was never told where its
// source lives; a dead link is not, and a link to somebody else's fork is
// worse than either.
//
// `||` and not `??`: Blocklet Server materialises every declared env var, so
// an unconfigured deployment delivers '' rather than undefined, and the
// nullish fallback would leave the template placeholder in the HTML.
export function sourceUrlFromEnv(): string {
  return (process.env.FREEAGENTS_SOURCE_URL || '').replace(/\/+$/, '');
}

// The placeholders the page files carry, and what each resolves to. A page
// is a static file, so this is a substitution at load, not a template
// engine: there is one variable in the whole product and adding a framework
// to inject it would be the tail wagging the dog.
const SOURCE_LINK_PATTERN = /<!--SOURCE_LINKS-->[\s\S]*?<!--\/SOURCE_LINKS-->/g;

function sourceLinks(sourceUrl: string): string {
  if (sourceUrl === '') return '';
  // The URL is attribute-escaped before it reaches the markup. It comes from
  // a deployment's own environment rather than from a request, so this is
  // defence in depth rather than a live hole, but a value that lands inside
  // an href should never be able to close the attribute it sits in.
  const safe = sourceUrl
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return (
    `<a href="${safe}" rel="noreferrer">Source code</a>` +
    `<a href="${safe}/blob/main/LICENSE" rel="noreferrer">Licence</a>`
  );
}

function loadPages(webDir: string, sourceUrl: string): Readonly<Record<PageName, string>> {
  const links = sourceLinks(sourceUrl);
  const entries = Object.entries(PAGE_FILES).map(([name, file]) => {
    // readFileSync throws on a missing page, which is the right answer: a
    // half-present site is worse than a server that refuses to start and
    // names the file it could not read.
    const html = readFileSync(join(webDir, 'pages', file), 'utf8');
    return [name, html.replace(SOURCE_LINK_PATTERN, links)] as const;
  });
  return Object.fromEntries(entries) as Record<PageName, string>;
}

// Mounts the site. Called twice by createApp, because order is the whole
// mechanism: `mountWebPages` runs BEFORE the API routes so a browser can be
// answered on a shared path, and `mountWebFallback` runs after them so an
// unmatched path reaches the 404 page.
export interface WebSurface {
  readonly mountPages: (app: Express) => void;
  readonly mountFallback: (app: Express) => void;
}

export function createWebSurface(
  webDir: string = resolveWebDir(),
  sourceUrl: string = sourceUrlFromEnv(),
): WebSurface {
  const pages = loadPages(webDir, sourceUrl);

  const send = (res: Response, name: PageName, status = 200): void => {
    res.status(status).set('Content-Type', 'text/html; charset=utf-8').send(pages[name]);
  };

  // A page on a path an API route also owns. The guard is the Accept header
  // and nothing else, so no API client's behaviour changes by one byte.
  const negotiated =
    (name: PageName) =>
    (req: Request, res: Response, next: NextFunction): void => {
      if (!prefersHtml(req.headers.accept)) {
        next();
        return;
      }
      send(res, name);
    };

  return {
    mountPages(app: Express): void {
      // Static assets first: stylesheets, browser scripts, the hero video.
      // `express.static` answers only for files that exist and calls next()
      // otherwise, so a missing asset falls through to the 404 handler
      // rather than hanging or serving an index listing.
      app.use(
        '/css',
        express.static(join(webDir, 'public', 'css'), { fallthrough: true, index: false }),
      );
      app.use(
        '/js',
        express.static(join(webDir, 'public', 'js'), { fallthrough: true, index: false }),
      );
      app.use(
        '/assets',
        express.static(join(webDir, 'public', 'assets'), { fallthrough: true, index: false }),
      );

      // Pages on paths of their own. No API route reaches these, so there is
      // nothing to negotiate.
      app.get('/', (_req: Request, res: Response) => send(res, 'landing'));
      app.get('/how', (_req: Request, res: Response) => send(res, 'how'));
      app.get('/browse', (_req: Request, res: Response) => send(res, 'browse'));
      app.get('/signin', (_req: Request, res: Response) => send(res, 'signin'));
      app.get('/verify', (_req: Request, res: Response) => send(res, 'verify'));

      // Pages that share a path with an API route (see rule 1 above).
      app.get('/agents/:agentDid', negotiated('agent'));
      app.get('/operators/:did', negotiated('operator'));
      app.get('/v1/credentials/:credentialId', negotiated('credential'));
    },

    mountFallback(app: Express): void {
      app.use((req: Request, res: Response) => {
        if ((req.method === 'GET' || req.method === 'HEAD') && prefersHtml(req.headers.accept)) {
          send(res, 'notfound', 404);
          return;
        }
        res.status(404).json({ error: 'not found' });
      });
    },
  };
}
