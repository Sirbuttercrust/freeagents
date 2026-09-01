// The public web surface's wiring (src/web/static.ts, mounted by
// src/api/app.ts). What this file proves is that the pages are REACHABLE and
// that mounting them changed no API behaviour. Content is not asserted: the
// brief asks for wiring tests, and pinning copy here would make every
// wording change a test change.
//
// The one thing worth stating up front, because it is the whole design: three
// page paths are also API paths, and the split is by the Accept header alone.
// A browser asking for text/html gets a page; a verifier asking for
// application/ld+json gets the signed document, byte for byte, exactly as
// before this surface existed. Both halves are asserted below, because a test
// that only checked the page would let the API break silently.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import {
  createWebSurface,
  prefersHtml,
  resolveWebDir,
  sourceUrlFromEnv,
  WebAssetsNotFoundError,
} from '../../src/web/static.js';
import {
  MemoryAgentRepository,
  MemoryOperatorRepository,
} from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';

const AGENT_DID = 'did:abt:agent-web-surface';
const OPERATOR_DID = 'did:abt:op-web-surface';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

function delegationFixture(): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-web',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: OPERATOR_DID,
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: AGENT_DID },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-01-01T00:00:00Z',
      verificationMethod: `${AGENT_DID}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zfixture-not-verified-here',
    },
  };
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const repo = new MemoryOperatorRepository();
  await repo.register({ did: OPERATOR_DID, githubLogin: 'operator-web-surface' });

  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: AGENT_DID,
    operatorDid: OPERATOR_DID,
    delegation: delegationFixture(),
    name: 'scout',
    skills: ['triage'],
    githubLogin: null,
  });

  server = createApp(repo, agentRepo).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function getHtml(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } });
}

describe('the web surface serves its pages', () => {
  it('serves the landing page at /', async () => {
    const res = await getHtml('/');
    expect(res.status).toBe(200);
    expect(String(res.headers.get('content-type'))).toContain('text/html');
    // The one content assertion in this file, and it is structural rather
    // than editorial: an HTML document, not a JSON body that happened to be
    // labelled text/html.
    expect(await res.text()).toContain('<!doctype html>');
  });

  it.each([
    ['/how', 'how it works'],
    ['/browse', 'browse placeholder'],
    ['/signin', 'sign in'],
    ['/verify', 'verify'],
  ])('serves %s (%s)', async (path) => {
    const res = await getHtml(path);
    expect(res.status).toBe(200);
    expect(String(res.headers.get('content-type'))).toContain('text/html');
  });

  it('serves the agent profile shell at /agents/:agentDid for a browser', async () => {
    const res = await getHtml(`/agents/${encodeURIComponent(AGENT_DID)}`);
    expect(res.status).toBe(200);
    expect(String(res.headers.get('content-type'))).toContain('text/html');
  });

  // The page shell is served for ANY agent DID, because the shell is what
  // then reads the record and renders "no agent is listed under that
  // identity" from the API's own 404. Asserting this pins that the page is
  // not gated on the record existing, which is what keeps the missing-agent
  // message a designed state rather than a bare 404.
  it('serves the agent profile shell for an unregistered DID too', async () => {
    const res = await getHtml('/agents/did:abt:nobody-at-all');
    expect(res.status).toBe(200);
    expect(String(res.headers.get('content-type'))).toContain('text/html');
  });

  it('serves the operator profile shell at /operators/:did for a browser', async () => {
    const res = await getHtml(`/operators/${encodeURIComponent(OPERATOR_DID)}`);
    expect(res.status).toBe(200);
    expect(String(res.headers.get('content-type'))).toContain('text/html');
  });

  it('serves the credential page at /v1/credentials/:id for a browser', async () => {
    const res = await getHtml('/v1/credentials/job-that-does-not-exist');
    expect(res.status).toBe(200);
    expect(String(res.headers.get('content-type'))).toContain('text/html');
  });

  it('serves the stylesheets and the page scripts', async () => {
    const css = await fetch(`${baseUrl}/css/base.css`);
    expect(css.status).toBe(200);
    expect(String(css.headers.get('content-type'))).toContain('text/css');

    const js = await fetch(`${baseUrl}/js/pages/api.js`);
    expect(js.status).toBe(200);
    expect(String(js.headers.get('content-type'))).toContain('javascript');
  });
});

describe('mounting the pages changed no API behaviour', () => {
  // Each of these is a route the page mount sits in FRONT of. If the Accept
  // negotiation ever regressed to "serve the page unless the path starts
  // with /v1", or to matching `*/*`, one of these would come back as HTML.

  it('GET /agents/:agentDid still answers JSON to a non-browser caller', async () => {
    const res = await fetch(`${baseUrl}/agents/${encodeURIComponent(AGENT_DID)}`, {
      headers: { Accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(String(res.headers.get('content-type'))).toContain('application/json');
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ did: AGENT_DID });
  });

  it('GET /agents/:agentDid answers JSON with no Accept header at all', async () => {
    // The bare-fetch case. Node's fetch sends `Accept: */*`, which is not a
    // request for HTML and must never be read as one: a verifier using a
    // default HTTP client is the exact caller invariant 2 exists for.
    const res = await fetch(`${baseUrl}/agents/${encodeURIComponent(AGENT_DID)}`);
    expect(res.status).toBe(200);
    expect(String(res.headers.get('content-type'))).toContain('application/json');
  });

  it('GET /operators/:did still answers JSON, and still 404s an unknown DID', async () => {
    const found = await fetch(`${baseUrl}/operators/${encodeURIComponent(OPERATOR_DID)}`, {
      headers: { Accept: 'application/json' },
    });
    expect(found.status).toBe(200);
    expect((await found.json()) as Record<string, unknown>).toMatchObject({ did: OPERATOR_DID });

    const missing = await fetch(`${baseUrl}/operators/did:abt:nobody`, {
      headers: { Accept: 'application/json' },
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not found' });
  });

  it('GET /v1/credentials/:id still 404s as JSON for a verifier', async () => {
    const res = await fetch(`${baseUrl}/v1/credentials/job-that-does-not-exist`, {
      headers: { Accept: 'application/ld+json' },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('GET /health and GET /capabilities are untouched', async () => {
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });

    const capabilities = await fetch(`${baseUrl}/capabilities`);
    expect(capabilities.status).toBe(200);
    const body = (await capabilities.json()) as { capabilities: unknown[] };
    expect(Array.isArray(body.capabilities)).toBe(true);
  });

  // A browser is not exempt from the API's rules: the page mount is GET
  // only, so a POST from anywhere reaches the handler it always did. POST
  // /operators takes no session/signature gate (D1/bootstrap-deadlock,
  // t_8b63ee9e -- registering an operator is how an account is created,
  // so it cannot itself demand one), so the handler's own body validation
  // is what answers here: a wrong-method DID is still a 400, proving the
  // routing point just as well as before -- the response is JSON from the
  // API handler, never the HTML page mount.
  it('a POST from a browser still reaches the API handler, not a page', async () => {
    const res = await fetch(`${baseUrl}/operators`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Accept: HTML },
      body: JSON.stringify({ did: 'did:eth:wrong-method', githubLogin: 'x' }),
    });
    expect(res.status).toBe(400);
    expect(String(res.headers.get('content-type'))).toContain('application/json');
  });
});

describe('an unknown path answers in the caller language', () => {
  it('serves the 404 page to a browser', async () => {
    const res = await getHtml('/no-such-page');
    expect(res.status).toBe(404);
    expect(String(res.headers.get('content-type'))).toContain('text/html');
    expect(await res.text()).toContain('<!doctype html>');
  });

  it('serves JSON to every other caller', async () => {
    const res = await fetch(`${baseUrl}/no-such-page`, { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(404);
    expect(String(res.headers.get('content-type'))).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('404s an unknown POST as JSON even from a browser', async () => {
    // The fallback is method-aware: only GET and HEAD can want a page. A
    // POST that matched nothing is a client error in the API's language,
    // whatever the Accept header says.
    const res = await fetch(`${baseUrl}/no-such-page`, { method: 'POST', headers: { Accept: HTML } });
    expect(res.status).toBe(404);
    expect(String(res.headers.get('content-type'))).toContain('application/json');
  });

  it('404s a missing static asset rather than hanging or listing a directory', async () => {
    const res = await fetch(`${baseUrl}/css/not-a-stylesheet.css`, { headers: { Accept: 'text/css' } });
    expect(res.status).toBe(404);
  });
});

// The Accept parser, directly. Each case below is a real client's header,
// and each one changed behaviour when the parser was written the obvious
// (wrong) way with a substring match.
describe('prefersHtml', () => {
  it('is true for a browser navigation', () => {
    expect(prefersHtml(HTML)).toBe(true);
  });

  it('is true for a bare text/html and for one with a quality value', () => {
    expect(prefersHtml('text/html')).toBe(true);
    expect(prefersHtml('text/html;q=0.9')).toBe(true);
    expect(prefersHtml('application/json, text/html;q=0.8')).toBe(true);
  });

  it('is false for every non-browser caller', () => {
    // `*/*` is fetch and curl's default and is NOT a request for HTML: read
    // as one, every verifier in the world would be handed a web page.
    expect(prefersHtml('*/*')).toBe(false);
    expect(prefersHtml('application/json')).toBe(false);
    expect(prefersHtml('application/ld+json')).toBe(false);
    expect(prefersHtml(undefined)).toBe(false);
    expect(prefersHtml('')).toBe(false);
  });

  it('is false for a type that merely contains the word html', () => {
    // A substring match on 'text/html' would be true for both of these, and
    // neither is a browser asking for a page.
    expect(prefersHtml('application/vnd.example+html')).toBe(false);
    expect(prefersHtml('text/html-fragment')).toBe(false);
  });
});

describe('resolveWebDir', () => {
  it('finds the web directory from the module it lives beside', () => {
    // No argument: the real production path, resolved the way createApp
    // resolves it.
    expect(resolveWebDir()).toContain('web');
  });

  it('throws rather than falling back when the assets are missing', () => {
    // A server that starts and serves nothing at / is the failure this
    // check exists to prevent, so the error is loud and names what it
    // looked for. A silent fallback would turn a deployment mistake into a
    // mystery.
    expect(() => resolveWebDir('/')).toThrow(WebAssetsNotFoundError);
  });

  // THE SHIPPED LAYOUT, NOT THE DEVELOPMENT ONE.
  //
  // `tsc` compiles .ts and copies nothing else. Without a build step that
  // carries pages/ and public/ into dist, dist/src/web holds static.js
  // alone, resolveWebDir walks up, finds the SOURCE tree, and development
  // never notices. A package that ships only dist has no source tree to
  // find, and blocklet.yml points main straight into dist.
  //
  // This it pins the layout the deploy actually has, so the copy step
  // cannot be dropped from the build script without a red test.
  it('resolves inside a dist-only tree once the assets are copied', () => {
    const root = mkdtempSync(join(tmpdir(), 'fa-dist-'));
    const distWeb = join(root, 'dist', 'src', 'web');
    mkdirSync(join(distWeb, 'pages'), { recursive: true });
    writeFileSync(join(distWeb, 'static.js'), '// compiled\n');

    // Before the assets are there: the walk runs out of tree and says so.
    expect(() => resolveWebDir(distWeb)).toThrow(WebAssetsNotFoundError);

    // With the marker page copied in, the module's own directory IS the web
    // directory, which is what the build step produces.
    writeFileSync(join(distWeb, 'pages', 'landing.html'), '<!doctype html>');
    expect(resolveWebDir(distWeb)).toBe(distWeb);
  });

  it('the build script carries the assets that make that true', () => {
    // The mechanism is one line in package.json, and a refactor that
    // rewrites the build command is exactly when it gets lost.
    const pkg = JSON.parse(
      readFileSync(join(resolveWebDir(), '..', '..', 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts['build']).toContain('copy-web-assets');
  });
});

// The footer's source and licence links are CONFIGURATION, not tree
// content: a public repository must not carry a specific account's address
// baked into every page. These its pin the three states that behaviour has.
describe('the source links are configured, never hardcoded', () => {
  function footerOf(surface: ReturnType<typeof createWebSurface>): Promise<string> {
    const app = createApp(
      new MemoryOperatorRepository(),
      new MemoryAgentRepository(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      // Position 9 is the verify-route rate limiter main added; the web
      // surface rides behind it at position 10. Passing undefined keeps the
      // limiter at its default, which these tests never trip.
      undefined,
      surface,
    );
    return new Promise((resolve, reject) => {
      const srv = app.listen(0, () => {
        const port = (srv.address() as AddressInfo).port;
        fetch(`http://127.0.0.1:${port}/`, { headers: { Accept: HTML } })
          .then((res) => res.text())
          .then((text) => {
            srv.close(() => resolve(text));
          })
          .catch((err: unknown) => {
            srv.close(() => reject(err instanceof Error ? err : new Error(String(err))));
          });
      });
    });
  }

  it('renders both links when a source URL is configured', async () => {
    const html = await footerOf(createWebSurface(resolveWebDir(), 'https://example.com/org/repo'));
    expect(html).toContain('<a href="https://example.com/org/repo" rel="noreferrer">Source code</a>');
    expect(html).toContain('https://example.com/org/repo/blob/main/LICENSE');
  });

  it('renders NEITHER link when nothing is configured', async () => {
    // Not a dead link, not a guess at somebody's fork: the links are gone.
    // A footer with two entries is honest about a deployment that was never
    // told where its source lives.
    const html = await footerOf(createWebSurface(resolveWebDir(), ''));
    expect(html).not.toContain('Source code');
    expect(html).not.toContain('blob/main/LICENSE');
    // And the placeholder itself never reaches the browser.
    expect(html).not.toContain('SOURCE_LINKS');
  });

  it('escapes a URL before it lands inside an href', async () => {
    // The value comes from a deployment's own environment rather than from
    // a request, so this is defence in depth. It still must not be able to
    // close the attribute it sits in.
    const html = await footerOf(createWebSurface(resolveWebDir(), 'https://x.test/"><script>alert(1)</script>'));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('leaves no placeholder in any page, in either state', async () => {
    for (const url of ['', 'https://example.com/org/repo']) {
      const html = await footerOf(createWebSurface(resolveWebDir(), url));
      expect(html, `placeholder survived with source url ${url || '(unset)'}`).not.toContain('SOURCE_LINKS');
    }
  });

  it('reads the environment, with an unset variable meaning no links', () => {
    const before = process.env['FREEAGENTS_SOURCE_URL'];
    try {
      delete process.env['FREEAGENTS_SOURCE_URL'];
      expect(sourceUrlFromEnv()).toBe('');

      // Blocklet Server materialises every declared env var, so an
      // unconfigured deployment delivers '' rather than undefined. Both
      // must mean the same thing.
      process.env['FREEAGENTS_SOURCE_URL'] = '';
      expect(sourceUrlFromEnv()).toBe('');

      // A trailing slash is stripped, so the licence path never doubles it.
      process.env['FREEAGENTS_SOURCE_URL'] = 'https://example.com/org/repo/';
      expect(sourceUrlFromEnv()).toBe('https://example.com/org/repo');
    } finally {
      if (before === undefined) delete process.env['FREEAGENTS_SOURCE_URL'];
      else process.env['FREEAGENTS_SOURCE_URL'] = before;
    }
  });
});
