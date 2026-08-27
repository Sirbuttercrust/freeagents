// R-39 acceptance, human-seeded 2026-08-27. These are the RED contract for
// src/adapters/identity/session.ts: each case is declared with `it.fails`,
// so the suite stays green while the adapter is a stub, and the moment a
// real implementation makes a case pass, `it.fails` itself fails. The
// implementer's first move is therefore forced and mechanical: replace
// `it.fails` with `it` and make the assertions real. The assertions below
// are placeholders for the acceptance lines in the comments, not the final
// tests.
//
// The boundary under test is the operator decision on issue #30
// (2026-08-26): browse and verify public, hire and list behind a session,
// anonymous verify rate limited. Invariants 7 and 8 bind: a wallet is never
// required, and OAuth or a passkey reaches every capability.
import { describe, it, expect } from 'vitest';
import {
  NotImplementedSessionAdapter,
  type SessionAdapter,
} from '../../src/adapters/identity/session.js';

describe('base session: GitHub OAuth and passkey (R-39)', () => {
  const adapter: SessionAdapter = new NotImplementedSessionAdapter();

  it.fails('GitHub OAuth round trip yields a session with the one Session shape', async () => {
    // begin -> provider redirect + single-use state; complete with the
    // callback code and the SAME state -> Session { subject, method:
    // 'github-oauth', token, issuedAt, expiresAt }.
    expect(true).toBe(false); // RED until implemented
    void adapter;
  });

  it.fails('OAuth completion with a reused or unknown state yields null, not a throw', async () => {
    expect(true).toBe(false); // RED until implemented
  });

  it.fails('passkey round trip yields a session with the SAME shape as OAuth', async () => {
    // register -> WebAuthn options with a single-use expiring challenge;
    // verify -> Session { method: 'passkey' }. Every other field identical
    // in shape to the OAuth session: one session model, no second account.
    expect(true).toBe(false); // RED until implemented
  });

  it.fails('a hire-loop route returns 401 without a session and works with one', async () => {
    // POST /jobs with no bearer token -> 401. Same request with a live
    // session token -> not 401. The route list that requires a session is
    // exactly the hire-and-list set from src/domain/access.ts.
    expect(true).toBe(false); // RED until implemented
  });

  it.fails('browse and verify routes succeed with no session and no account', async () => {
    // GET /agents/:agentDid and GET /v1/credentials/:credentialId answer a
    // stranger. This is the product's trust story; a session requirement
    // here is a regression, not a hardening.
    expect(true).toBe(false); // RED until implemented
  });

  it.fails('anonymous verify routes are rate limited', async () => {
    // Public does not mean scrapeable-to-death (#30 addendum). Repeated
    // anonymous hits on a verify route eventually answer 429; a session
    // does not lift the product boundary, only the limit bucket.
    expect(true).toBe(false); // RED until implemented
  });

  it.fails('getSession resolves expired and ended tokens to null, indistinguishably', async () => {
    expect(true).toBe(false); // RED until implemented
  });
});
