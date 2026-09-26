// S7 (security sweep 2026-09-06, "rate limiting covers 2 of 57 routes"):
// classifies every route on the app into a rate-limit bucket by method and
// path pattern, so the class middleware (src/api/app.ts) can apply the
// right limiter without depending on Express having already matched the
// real route (this middleware is mounted BEFORE any route is registered,
// so it does its own pattern match against req.method/req.path).
import { describe, expect, it } from 'vitest';
import { classifyRoute, EXEMPT_WEB_PAGE_PATHS, ROOT_ICON_PATHS } from '../../src/api/rate-limit-classes.js';

describe('classifyRoute: the four verify-class routes (today\'s 60/minute limiter)', () => {
  it('classifies GET /agents/:agentDid as verify', () => {
    expect(classifyRoute('GET', '/agents/did:abt:zSomeAgent')).toBe('verify');
  });

  it('classifies GET /v1/credentials/:credentialId as verify', () => {
    expect(classifyRoute('GET', '/v1/credentials/abc-123')).toBe('verify');
  });

  it('classifies GET /auth/github/callback as verify', () => {
    expect(classifyRoute('GET', '/auth/github/callback')).toBe('verify');
  });

  it('classifies POST /auth/passkey/verify as verify', () => {
    expect(classifyRoute('POST', '/auth/passkey/verify')).toBe('verify');
  });
});

describe('classifyRoute: upstream (GitHub- and chain-calling routes)', () => {
  it('classifies POST /agents/:agentDid/account-proof as upstream (GitHub)', () => {
    expect(classifyRoute('POST', '/agents/did:abt:zAgent/account-proof')).toBe('upstream');
  });

  it('classifies POST /jobs/:jobId/confirm, /decline, /stage, /redo-refuse, /pull-request, /merge as upstream (GitHub)', () => {
    expect(classifyRoute('POST', '/jobs/j-1/confirm')).toBe('upstream');
    expect(classifyRoute('POST', '/jobs/j-1/decline')).toBe('upstream');
    expect(classifyRoute('POST', '/jobs/j-1/stage')).toBe('upstream');
    expect(classifyRoute('POST', '/jobs/j-1/redo-refuse')).toBe('upstream');
    expect(classifyRoute('POST', '/jobs/j-1/pull-request')).toBe('upstream');
    expect(classifyRoute('POST', '/jobs/j-1/merge')).toBe('upstream');
  });

  it('classifies the payment start/wallet-response routes as upstream (the chains)', () => {
    expect(classifyRoute('POST', '/jobs/j-1/payments/deposit/abt/start')).toBe('upstream');
    expect(classifyRoute('POST', '/jobs/j-1/payments/deposit/usdc/start')).toBe('upstream');
    expect(classifyRoute('POST', '/jobs/j-1/payments/deposit/usdc/wallet-response')).toBe('upstream');
  });

  it('classifies any method under /api/did/pay/ as upstream (the did-connect-js chain mount)', () => {
    expect(classifyRoute('GET', '/api/did/pay/token')).toBe('upstream');
    expect(classifyRoute('POST', '/api/did/pay/token')).toBe('upstream');
    expect(classifyRoute('GET', '/api/did/pay/status')).toBe('upstream');
    expect(classifyRoute('GET', '/api/did/pay/timeout')).toBe('upstream');
    expect(classifyRoute('GET', '/api/did/pay/auth')).toBe('upstream');
    expect(classifyRoute('POST', '/api/did/pay/auth')).toBe('upstream');
    expect(classifyRoute('GET', '/api/did/pay/auth/submit')).toBe('upstream');
  });

  it('does NOT classify staged-decline or redo as upstream (they are not in the sweep\'s upstream list)', () => {
    expect(classifyRoute('POST', '/jobs/j-1/staged-decline')).toBe('write');
    expect(classifyRoute('POST', '/jobs/j-1/redo')).toBe('write');
  });
});

describe('classifyRoute: write (every other POST/PUT/PATCH/DELETE)', () => {
  it('classifies POST /accounts as write (the sweep names it explicitly)', () => {
    expect(classifyRoute('POST', '/accounts')).toBe('write');
  });

  it('classifies POST /jobs (creating a hire) as write', () => {
    expect(classifyRoute('POST', '/jobs')).toBe('write');
  });

  it('classifies PATCH /accounts/:did/operator-address as write', () => {
    expect(classifyRoute('PATCH', '/accounts/did:abt:zOperator/operator-address')).toBe('write');
  });

  it('classifies DELETE /agents/:agentDid/avatar as write', () => {
    expect(classifyRoute('DELETE', '/agents/did:abt:zAgent/avatar')).toBe('write');
  });

  it('classifies PUT /agents/:agentDid/negotiation as write', () => {
    expect(classifyRoute('PUT', '/agents/did:abt:zAgent/negotiation')).toBe('write');
  });
});

describe('classifyRoute: read (every other GET)', () => {
  it('classifies GET /agents (the full listing) as read', () => {
    expect(classifyRoute('GET', '/agents')).toBe('read');
  });

  it('classifies GET /jobs/:jobId as read', () => {
    expect(classifyRoute('GET', '/jobs/j-1')).toBe('read');
  });

  it('classifies GET /accounts/:did/agents (the operator roster) as read', () => {
    expect(classifyRoute('GET', '/accounts/did:abt:zOperator/agents')).toBe('read');
  });

  it('classifies GET /accounts/:did (not one of the 4 verify routes) as read', () => {
    expect(classifyRoute('GET', '/accounts/did:abt:zOperator')).toBe('read');
  });
});

describe('classifyRoute: exemptions, named individually', () => {
  it('exempts GET /health', () => {
    expect(classifyRoute('GET', '/health')).toBe('exempt');
  });

  it('exempts the two event streams (a stream is one long request)', () => {
    expect(classifyRoute('GET', '/jobs/j-1/messages/stream')).toBe('exempt');
    expect(classifyRoute('GET', '/accounts/did:abt:zOperator/notifications/stream')).toBe('exempt');
  });

  it('exempts static asset mounts: /css, /js, /assets', () => {
    expect(classifyRoute('GET', '/css/base.css')).toBe('exempt');
    expect(classifyRoute('GET', '/js/pages/browse.js')).toBe('exempt');
    expect(classifyRoute('GET', '/assets/hero.mp4')).toBe('exempt');
  });

  it('exempts the favicon set', () => {
    for (const path of ROOT_ICON_PATHS) {
      expect(classifyRoute('GET', path)).toBe('exempt');
    }
  });

  it('exempts every web page shell', () => {
    for (const path of EXEMPT_WEB_PAGE_PATHS) {
      expect(classifyRoute('GET', path)).toBe('exempt');
    }
  });
});

describe('classifyRoute: an unrecognised route (defence in depth, never silently open)', () => {
  it('falls back to the tightest class (upstream) rather than exempt or unlimited', () => {
    expect(classifyRoute('POST', '/some/route/nobody/registered')).toBe('upstream');
  });
});
