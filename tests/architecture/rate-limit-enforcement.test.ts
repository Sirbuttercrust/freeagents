// S7 (security sweep 2026-09-06), missing-enforcement (standing defect #9):
// walks the app's OWN router stack (app._router.stack, the same mechanism
// the sweep used) and fails if any registered route is neither classified
// by rate-limit-classes.ts's ROUTE_TABLE nor on its exemption lists. A
// route that falls into no class is the defect this test exists to catch,
// not a passing case.
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { classifyRoute, ROUTE_TABLE, ROOT_ICON_PATHS, EXEMPT_WEB_PAGE_PATHS, prefersHtmlAccept } from '../../src/api/rate-limit-classes.js';
import { ROOT_ICONS, prefersHtml } from '../../src/web/static.js';

interface ExpressLayer {
  route?: { path: string; methods: Record<string, boolean> };
  name?: string;
  handle?: { stack?: ExpressLayer[] };
  regexp?: { fast_slash?: boolean };
  path?: string;
}

// Collects every registered [method, path] pair by walking the app's own
// router stack, recursing into any nested router (express.static and
// app.use both register as a 'router'-shaped layer with no per-route
// methods of its own -- those are asset MOUNTS, not individual routes, and
// are covered by the prefix exemptions rather than by naming every file).
function registeredRoutes(app: ReturnType<typeof createApp>): Array<{ method: string; path: string }> {
  const stack = (app as unknown as { _router: { stack: ExpressLayer[] } })._router.stack;
  const routes: Array<{ method: string; path: string }> = [];
  function walk(layers: ExpressLayer[]): void {
    for (const layer of layers) {
      if (layer.route) {
        const route = layer.route;
        const methods = Object.keys(route.methods).filter((m) => route.methods[m]);
        for (const method of methods) {
          routes.push({ method: method.toUpperCase(), path: route.path });
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack);
      }
    }
  }
  walk(stack);
  return routes;
}

describe('rate-limit-classes.ts ROUTE_TABLE covers every registered route (missing-enforcement, #9)', () => {
  it('classifies every route the app actually registers as something other than falling through the unrecognised default', () => {
    const app = createApp();
    const routes = registeredRoutes(app);
    expect(routes.length).toBeGreaterThan(0);

    const unclassified = routes.filter(({ method, path }) => {
      const classification = classifyRoute(method, path);
      // 'upstream' is classifyRoute's own fallback for a route NEITHER in
      // ROUTE_TABLE nor on an exemption list (the missing-enforcement
      // defect this test exists to catch). A route legitimately classified
      // upstream is always found EXACTLY in ROUTE_TABLE (or the
      // /api/did/pay/ prefix, which no route in this app's own
      // registrations uses), so any route reaching the fallback with no
      // exact table entry is the drift this test must fail on.
      const inTable = ROUTE_TABLE.some((entry) => entry.method === method && entry.pattern === path);
      const isKnownExempt = classification === 'exempt';
      return !inTable && !isKnownExempt;
    });

    expect(unclassified, `unclassified routes: ${JSON.stringify(unclassified)}`).toEqual([]);
  });

  it('never classifies a registered route as exempt unless it is a stream, /health, a static mount, a favicon, or a web page shell', () => {
    const app = createApp();
    const routes = registeredRoutes(app);
    const wronglyExempt = routes.filter(({ method, path }) => {
      const classification = classifyRoute(method, path);
      if (classification !== 'exempt') return false;
      const isStream = path.endsWith('/stream');
      const isHealth = path === '/health';
      const isWebPage = EXEMPT_WEB_PAGE_PATHS.includes(path) || ROOT_ICON_PATHS.includes(path);
      return !isStream && !isHealth && !isWebPage;
    });
    expect(wronglyExempt).toEqual([]);
  });
});

describe('rate-limit-classes.ts exemption lists stay in agreement with the real web surface', () => {
  it('ROOT_ICON_PATHS names exactly the files src/web/static.ts serves at the site root', () => {
    const staticIconPaths = ROOT_ICONS.map(([file]) => `/${file}`).sort();
    expect([...ROOT_ICON_PATHS].sort()).toEqual(staticIconPaths);
  });

  // The limiter's own copy of the page-shell Accept test must answer
  // exactly as the web surface's prefersHtml does, or a page paint the
  // web surface serves as html would be charged to an API bucket (or a
  // JSON read let through free). Same inputs, same answer, for every
  // header shape a browser, a fetch() call or a script sends.
  it("prefersHtmlAccept answers exactly as src/web/static.ts's prefersHtml for the same Accept headers", () => {
    const headers: ReadonlyArray<string | undefined> = [
      undefined,
      '',
      'text/html',
      'TEXT/HTML',
      'text/html;q=0.9',
      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'application/json',
      'application/json, text/plain, */*',
      '*/*',
      'application/xhtml+xml',
      ' text/html ',
      'application/json;q=1, text/html;q=0.1',
    ];
    for (const header of headers) {
      expect(prefersHtmlAccept(header), JSON.stringify(header)).toBe(prefersHtml(header));
    }
  });
});

describe('classifyRoute: each named exemption is pinned by its own test (guard-without-a-test, #28)', () => {
  it('exempts /health', () => {
    expect(classifyRoute('GET', '/health')).toBe('exempt');
  });

  it('exempts GET /jobs/:jobId/messages/stream', () => {
    expect(classifyRoute('GET', '/jobs/j-1/messages/stream')).toBe('exempt');
  });

  it('exempts GET /accounts/:did/notifications/stream', () => {
    expect(classifyRoute('GET', '/accounts/did:abt:zOp/notifications/stream')).toBe('exempt');
  });

  it('exempts every static asset prefix', () => {
    expect(classifyRoute('GET', '/css/x.css')).toBe('exempt');
    expect(classifyRoute('GET', '/js/x.js')).toBe('exempt');
    expect(classifyRoute('GET', '/assets/x.mp4')).toBe('exempt');
  });

  it('exempts every favicon path', () => {
    for (const path of ROOT_ICON_PATHS) {
      expect(classifyRoute('GET', path)).toBe('exempt');
    }
  });
});
