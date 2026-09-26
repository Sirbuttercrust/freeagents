// S7 (security sweep 2026-09-06, "rate limiting covers 2 of 57 routes"):
// classifies every route by method and path pattern into one of four rate
// limit buckets, plus the exemption list. Used by the class-limiter
// middleware in src/api/app.ts, mounted once, right after the body parser
// and BEFORE web.mountPages(app) and every API route -- so this module
// does its OWN path matching rather than relying on req.route (Express has
// not matched a route yet at the point this middleware runs).
//
// ROUTE_TABLE is the single source of truth for every route this app
// registers (see the router-walk test, tests/architecture/rate-limit-
// enforcement.test.ts, which fails if app._router.stack ever grows a
// route this table does not name). Adding a route without adding it here
// is the missing-enforcement defect that test exists to catch.
export type RouteClass = 'upstream' | 'write' | 'read' | 'verify';
export type RouteClassification = RouteClass | 'exempt';

interface RouteEntry {
  readonly method: string;
  readonly pattern: string;
  readonly classification: RouteClassification;
}

// Every route src/api/app.ts registers directly (method + exact path
// template, colon segments matching any single path segment). Order does
// not matter for this table: method+pattern pairs are unique, matched by
// exact segment-for-segment comparison, never by which one is listed
// first.
export const ROUTE_TABLE: readonly RouteEntry[] = [
  { method: 'GET', pattern: '/health', classification: 'exempt' },
  { method: 'GET', pattern: '/capabilities', classification: 'read' },
  { method: 'GET', pattern: '/sign-in-methods', classification: 'read' },
  { method: 'GET', pattern: '/.well-known/freeagents-issuer.json', classification: 'read' },
  { method: 'GET', pattern: '/auth/github/start', classification: 'read' },
  // FIX-S7 round 3: the `verify` bucket keeps exactly
  // the 3 routes a stranger or a script uses to PROVE something (a
  // sign-in callback, a passkey assertion, an issued credential lookup),
  // never the site's own ordinary reads. GET /agents/:agentDid moved out
  // of this bucket to `read` (see its own entry below) because it is the
  // agent strip every page renders, not a verification.
  { method: 'GET', pattern: '/auth/github/callback', classification: 'verify' },
  { method: 'POST', pattern: '/auth/passkey/register', classification: 'write' },
  { method: 'POST', pattern: '/auth/passkey/verify', classification: 'verify' },
  { method: 'POST', pattern: '/auth/signout', classification: 'write' },
  // The sweep names this explicitly: "apply a limiter to ... POST /accounts".
  { method: 'POST', pattern: '/accounts', classification: 'write' },
  { method: 'GET', pattern: '/accounts/me', classification: 'read' },
  { method: 'GET', pattern: '/accounts/:did', classification: 'read' },
  { method: 'PATCH', pattern: '/accounts/:did/operator-address', classification: 'write' },
  { method: 'GET', pattern: '/jobs/:jobId/messages', classification: 'read' },
  { method: 'POST', pattern: '/jobs/:jobId/messages', classification: 'write' },
  { method: 'PATCH', pattern: '/jobs/:jobId/messages/:messageId', classification: 'write' },
  { method: 'POST', pattern: '/jobs/:jobId/messages/:messageId/reactions', classification: 'write' },
  { method: 'DELETE', pattern: '/jobs/:jobId/messages/:messageId/reactions', classification: 'write' },
  { method: 'GET', pattern: '/jobs/:jobId/messages/read-state', classification: 'read' },
  { method: 'POST', pattern: '/jobs/:jobId/messages/read', classification: 'write' },
  { method: 'POST', pattern: '/jobs/:jobId/typing', classification: 'write' },
  // A stream is one long request (Make item 2): exempt, never counted
  // against the read bucket the way a normal poll would be.
  { method: 'GET', pattern: '/jobs/:jobId/messages/stream', classification: 'exempt' },
  { method: 'GET', pattern: '/accounts/:did/notifications', classification: 'read' },
  { method: 'POST', pattern: '/accounts/:did/notifications/:notificationId/read', classification: 'write' },
  { method: 'GET', pattern: '/accounts/:did/notifications/stream', classification: 'exempt' },
  { method: 'GET', pattern: '/push/vapid-public-key', classification: 'read' },
  { method: 'POST', pattern: '/accounts/:did/push-subscriptions', classification: 'write' },
  { method: 'DELETE', pattern: '/accounts/:did/push-subscriptions', classification: 'write' },
  { method: 'POST', pattern: '/jobs/:jobId/attachments', classification: 'write' },
  // The list of sent attachments (names, sizes, types) the conversation
  // screen reads so the other party can name a file without downloading it.
  // A party-gated storage read with no upstream call.
  { method: 'GET', pattern: '/jobs/:jobId/attachments', classification: 'read' },
  { method: 'GET', pattern: '/jobs/:jobId/attachments/:attachmentId', classification: 'read' },
  { method: 'GET', pattern: '/accounts/:did/agents', classification: 'read' },
  { method: 'GET', pattern: '/accounts/:did/jobs', classification: 'read' },
  { method: 'GET', pattern: '/accounts/:did/incoming', classification: 'read' },
  { method: 'GET', pattern: '/accounts/:did/pending', classification: 'read' },
  // Every conversation the account is in, both seats, with unread counts:
  // the messages list and the nav badge. A storage read with no upstream call.
  { method: 'GET', pattern: '/accounts/:did/threads', classification: 'read' },
  { method: 'POST', pattern: '/agents', classification: 'write' },
  { method: 'GET', pattern: '/agents', classification: 'read' },
  // FIX-S7 round 3 (the round-3 ruling on the verify-vs-honest-user
  // conflict qa's proof r2 raised): this is the site's own ordinary
  // agent-record read, not a stranger's or a script's verification.
  // Twelve page scripts read it for the agent strip (browse.js once per
  // card, plus job, agreement, operator, operatorjob, deposit,
  // pullrequest, verify, staged, credential, dashboard, myagents), so
  // moving it to `read` (300/minute) keeps an honest multi-page browse
  // session under budget without loosening the `verify` bucket the
  // sign-in callbacks share.
  { method: 'GET', pattern: '/agents/:agentDid', classification: 'read' },
  // GitHub-calling (security sweep's own upstream list).
  { method: 'POST', pattern: '/agents/:agentDid/account-proof', classification: 'upstream' },
  { method: 'POST', pattern: '/agents/:agentDid/key-rotation', classification: 'write' },
  { method: 'PUT', pattern: '/agents/:agentDid/avatar', classification: 'write' },
  { method: 'DELETE', pattern: '/agents/:agentDid/avatar', classification: 'write' },
  { method: 'PUT', pattern: '/agents/:agentDid/negotiation', classification: 'write' },
  { method: 'PUT', pattern: '/agents/:agentDid/webhook', classification: 'write' },
  { method: 'POST', pattern: '/agents/:agentDid/compromise-report', classification: 'write' },
  { method: 'GET', pattern: '/agents/:agentDid/compromise-reports', classification: 'read' },
  { method: 'GET', pattern: '/agents/:agentDid/reviews', classification: 'read' },
  { method: 'GET', pattern: '/agents/:agentDid/hires', classification: 'read' },
  { method: 'GET', pattern: '/agents/:agentDid/card', classification: 'read' },
  { method: 'GET', pattern: '/agents/:agentDid/credentials', classification: 'read' },
  { method: 'GET', pattern: '/buyers/:githubLogin/conduct', classification: 'read' },
  { method: 'GET', pattern: '/v1/credentials/:credentialId', classification: 'verify' },
  { method: 'GET', pattern: '/v1/credentials/:credentialId/status', classification: 'read' },
  { method: 'POST', pattern: '/jobs', classification: 'write' },
  { method: 'GET', pattern: '/jobs/:jobId', classification: 'read' },
  { method: 'POST', pattern: '/jobs/:jobId/criteria', classification: 'write' },
  { method: 'POST', pattern: '/jobs/:jobId/request-changes', classification: 'write' },
  { method: 'POST', pattern: '/jobs/:jobId/criteria/:index/accept', classification: 'write' },
  { method: 'POST', pattern: '/jobs/:jobId/price/accept', classification: 'write' },
  // GitHub- and chain-calling (security sweep's own upstream list).
  { method: 'POST', pattern: '/jobs/:jobId/confirm', classification: 'upstream' },
  { method: 'POST', pattern: '/jobs/:jobId/withdraw', classification: 'write' },
  { method: 'POST', pattern: '/jobs/:jobId/decline', classification: 'upstream' },
  { method: 'POST', pattern: '/jobs/:jobId/stage', classification: 'upstream' },
  { method: 'GET', pattern: '/jobs/:jobId/attestation', classification: 'read' },
  { method: 'GET', pattern: '/jobs/:jobId/attestations', classification: 'read' },
  // Not in the sweep's upstream list (no GitHub or chain call): plain writes.
  { method: 'POST', pattern: '/jobs/:jobId/staged-decline', classification: 'write' },
  { method: 'POST', pattern: '/jobs/:jobId/redo', classification: 'write' },
  { method: 'POST', pattern: '/jobs/:jobId/redo-refuse', classification: 'upstream' },
  { method: 'POST', pattern: '/jobs/:jobId/pull-request', classification: 'upstream' },
  { method: 'POST', pattern: '/jobs/:jobId/payments/:leg/abt/start', classification: 'upstream' },
  { method: 'POST', pattern: '/jobs/:jobId/payments/:leg/usdc/start', classification: 'upstream' },
  { method: 'POST', pattern: '/jobs/:jobId/payments/:leg/usdc/wallet-response', classification: 'upstream' },
  { method: 'POST', pattern: '/jobs/:jobId/merge', classification: 'upstream' },
  { method: 'POST', pattern: '/jobs/:jobId/cited-close', classification: 'write' },
  { method: 'POST', pattern: '/jobs/:jobId/reviews', classification: 'write' },
];

// The did-connect-js mount (src/adapters/payment/abt-did-connect.ts):
// attachExpress registers `{prefix}/{action}/token`, `/status`, `/timeout`,
// `/auth`, and `/auth/submit` under `/api/did/pay` (action: 'pay'), plus
// this file's own guard middleware at `/api/did/pay/token`. Every one of
// them is a door onto the ABT chain session (the sweep's own "the
// /api/did/pay/* mount (the chains)"), so the whole subtree is upstream
// regardless of method or leaf, rather than naming each leaf by hand.
const UPSTREAM_PREFIX = '/api/did/pay/';

// Static asset mounts (src/web/static.ts's mountPages): express.static
// serves arbitrary files under these roots, so a fixed leaf list would
// drift the moment a new stylesheet or script is added. Prefix match, not
// classified at all -- a browser loading a page's own assets must never
// trip a data-read limit.
const EXEMPT_STATIC_PREFIXES = ['/css/', '/js/', '/assets/'];

// The favicon/manifest set src/web/static.ts serves at the site root
// (ROOT_ICONS there). Duplicated here as a name list rather than importing
// static.ts's own export, so this module (loaded by app.ts before web
// surface construction in some call orders) never depends on web/static.ts
// at all; tests/architecture/rate-limit-enforcement.test.ts cross-checks
// this list against ROOT_ICONS directly so the two cannot silently drift.
export const ROOT_ICON_PATHS: readonly string[] = [
  '/favicon.ico',
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-512-maskable.png',
  '/site.webmanifest',
];

// The web page shells (src/web/static.ts's mountPages): static markup with
// no storage read of its own -- the real reads a page needs are separate,
// already-classified API calls. Never a page an API route also negotiates:
// those four (/agents/:agentDid, /accounts/:did, /v1/credentials/:id,
// /jobs/:jobId) are named ONCE in ROUTE_TABLE above for their JSON reads,
// and NEGOTIATED_PAGE_SHELL_PATTERNS below exempts only their html page
// paint, so a JSON reader of the same path still spends its bucket.
export const EXEMPT_WEB_PAGE_PATHS: readonly string[] = [
  '/',
  '/how',
  '/browse',
  '/signin',
  '/verify',
  '/hire',
  '/agreement',
  '/deposit',
  '/staged',
  '/pullrequest',
  '/myjobs',
  '/myagents',
  '/outcomes',
  '/incoming',
  '/conduct',
  '/dashboard',
  '/operatorjob',
  '/settings',
  '/notifications',
  '/private-repos',
];

// FIX-S7 round 2 (qa proof r1, defect 1): the four GET routes src/web/
// static.ts negotiates by Accept (its own `negotiated()`): a page shell
// paint (Accept: text/html) never touches a bucket, but the identical path
// asked for as JSON is a real, already-classified API read (verify/read
// per ROUTE_TABLE above) and stays rate limited exactly as before. Method
// is always GET; a page shell is never a write.
const NEGOTIATED_PAGE_SHELL_PATTERNS: readonly string[] = [
  '/agents/:agentDid',
  '/accounts/:did',
  '/v1/credentials/:credentialId',
  '/jobs/:jobId',
];

// Copy of src/web/static.ts's own prefersHtml, deliberately not imported:
// this module's own header comment states it does its own path matching
// rather than depending on the web surface (src/api/app.ts may construct
// this module before the web surface in some call orders). The two copies
// are held in agreement by tests/architecture/rate-limit-enforcement.test.ts,
// which runs both over the same set of Accept headers and requires the same
// answer from each, so a drift between them turns that test red.
export function prefersHtmlAccept(accept: string | undefined): boolean {
  if (typeof accept !== 'string') return false;
  return accept.split(',').some((part) => (part.split(';')[0] ?? '').trim().toLowerCase() === 'text/html');
}

// Segment-for-segment comparison: a `:name` segment in the pattern matches
// any single path segment, a literal segment must match exactly. No
// pattern in this table uses a wildcard or an optional segment, so this is
// deliberately simpler than a full path-to-regexp compile.
function matchesPattern(pattern: string, path: string): boolean {
  const patternSegments = pattern.split('/');
  const pathSegments = path.split('/');
  if (patternSegments.length !== pathSegments.length) return false;
  return patternSegments.every((segment, i) => segment.startsWith(':') || segment === pathSegments[i]);
}

// Classifies one request by method and path. Checks the fixed exemption
// lists first (prefixes, then exact lists), then walks ROUTE_TABLE for an
// exact method+pattern match. An unrecognised route falls back to
// 'upstream', the tightest bucket -- never silently exempt and never
// silently unlimited (missing-enforcement, defect class #9): a route this
// table forgot degrades a caller's experience on that one route rather
// than opening a hole.
//
// FIX-S7 round 2 (qa proof r1, defect 1): four GET routes are NEGOTIATED
// page shells (src/web/static.ts's own `negotiated()`) -- /agents/:did,
// /accounts/:did, /v1/credentials/:id, /jobs/:jobId. Before round 2 this
// function classified them by path alone, so a browser painting the page
// (Accept: text/html) shared the SAME bucket as that page's own later JSON
// reads to the identical path, which is a regression from main: there, the
// page-shell handler answered before the rate limiter even existed
// (web.mountPages ran, and the limiter did not), so a paint never touched
// any bucket at all. `accept` is optional and defaults to undefined (no
// header, or a caller this function's own callers never pass one for --
// see rate-limit-middleware.ts, which always passes req.headers.accept):
// undefined never matches prefersHtml, so every existing caller's
// behaviour (JSON reads, and every route that is not one of these four)
// is exactly what it was before this parameter existed.
export function classifyRoute(method: string, path: string, accept?: string): RouteClassification {
  return classifyRouteWithReason(method, path, accept).classification;
}

export type ClassificationReason =
  | 'upstream-prefix'
  | 'exempt-static-prefix'
  | 'exempt-root-icon'
  | 'exempt-web-page'
  | 'exempt-page-shell'
  | 'route-table'
  | 'fallback-unclassified';

export interface Classified {
  readonly classification: RouteClassification;
  readonly reason: ClassificationReason;
}

// FIX-S7 round 2 (qa proof r1, defect 5a): named by REASON as well as by
// class, so a mutation that deletes the explicit /api/did/pay/ prefix
// check is observable even where it lands on the same class the generic
// fallback would have picked anyway (both are 'upstream'; only the reason
// differs). classifyRoute above is the class-only view every existing
// caller keeps using unchanged; classificationReason (below) is the new,
// separately-tested surface a mutation-proof test reads.
function classifyRouteWithReason(method: string, path: string, accept?: string): Classified {
  if (path.startsWith(UPSTREAM_PREFIX)) return { classification: 'upstream', reason: 'upstream-prefix' };
  for (const prefix of EXEMPT_STATIC_PREFIXES) {
    if (path.startsWith(prefix)) return { classification: 'exempt', reason: 'exempt-static-prefix' };
  }
  if (ROOT_ICON_PATHS.includes(path)) return { classification: 'exempt', reason: 'exempt-root-icon' };
  if (EXEMPT_WEB_PAGE_PATHS.includes(path)) return { classification: 'exempt', reason: 'exempt-web-page' };

  const upperMethod = method.toUpperCase();
  if (upperMethod === 'GET' && prefersHtmlAccept(accept) && NEGOTIATED_PAGE_SHELL_PATTERNS.some((pattern) => matchesPattern(pattern, path))) {
    return { classification: 'exempt', reason: 'exempt-page-shell' };
  }

  for (const entry of ROUTE_TABLE) {
    if (entry.method === upperMethod && matchesPattern(entry.pattern, path)) {
      return { classification: entry.classification, reason: 'route-table' };
    }
  }
  return { classification: 'upstream', reason: 'fallback-unclassified' };
}

export function classificationReason(method: string, path: string, accept?: string): ClassificationReason {
  return classifyRouteWithReason(method, path, accept).reason;
}
