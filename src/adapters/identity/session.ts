// Base session: GitHub OAuth and passkey. R-39, seeded by hand 2026-08-27
// (Phase-0 rule: auth is on the irreversible list, so a human writes this
// contract and its failing tests; the factory implements against them).
//
// Why this exists: invariant 8 names GitHub OAuth and passkey as THE two
// sign-in methods, and until this file neither existed anywhere in src/.
// R-23 declared the identity boundary (src/domain/access.ts) without
// enforcing it. This adapter is the enforcement point, and it is also the
// shape R-24's DID Wallet path must reuse: one Session type, no second
// account model, ever.
//
// The boundary it enforces is the operator decision on issue #30
// (2026-08-26): browse and verify are public with no session and no account;
// hire and list require a session; anonymous verify routes are rate limited.
//
// Contract:
//   - beginGitHubOAuth() hands back the provider redirect and an opaque,
//     single-use state token. completeGitHubOAuth() exchanges callback
//     params for a Session or null. Never a throw for a bad callback:
//     null maps to 401 without inspecting error messages.
//   - registerPasskey() / verifyPasskey() carry WebAuthn options and
//     responses as opaque JSON strings. The adapter owns challenge
//     storage; a challenge is single-use and expiring, exactly the
//     property R-24's wallet challenge will need, which is why the shape
//     lives here and not in a passkey-specific type.
//   - getSession() resolves a bearer token to a live Session or null.
//     Expired and revoked both resolve to null, indistinguishably.
//   - endSession() is idempotent: ending a dead session is a no-op.
//   - No method imports an ArcBlock or GitHub package here; this is the
//     capability interface. Vendors appear only in the implementation.
//
// NOT IMPLEMENTED YET on purpose: the failing tests in
// tests/api/session.test.ts name exactly what must exist before this
// file may pass.
import { NotImplementedError } from '../not-implemented.js';

export type SignInMethod = 'github-oauth' | 'passkey';

export interface Session {
  // The proof-specific identity the sign-in method produced: the GitHub
  // login for github-oauth, the caller-supplied subject for passkey. One
  // field, one shape, both proof-specific: R-39 completion resolves this
  // to an Account server-side (session.ts's own resolveSessionAccount, or
  // the adapter's resolveSessionAccount option), via the schema's unique
  // githubLogin / passkeySubject constraint. This field is NEVER an
  // Account DID itself and is never trusted as a caller-declared party;
  // it is the key the resolution join looks up.
  readonly subject: string;
  readonly method: SignInMethod;
  readonly token: string;
  readonly issuedAt: string;   // ISO 8601
  readonly expiresAt: string;  // ISO 8601
}

export interface OAuthStart {
  readonly redirectUrl: string;
  // Single-use, expiring, bound to this start. The completion call that
  // does not present it fails closed.
  readonly state: string;
}

export interface SessionAdapter {
  beginGitHubOAuth(): Promise<OAuthStart>;
  completeGitHubOAuth(params: {
    readonly code: string;
    readonly state: string;
  }): Promise<Session | null>;

  // WebAuthn ceremonies. Options and responses are the JSON the browser
  // API produces, passed through opaque; the adapter validates.
  registerPasskey(subject: string): Promise<{ optionsJson: string }>;
  verifyPasskey(responseJson: string): Promise<Session | null>;

  getSession(token: string): Promise<Session | null>;
  endSession(token: string): Promise<void>;
}

export class NotImplementedSessionAdapter implements SessionAdapter {
  beginGitHubOAuth(): Promise<OAuthStart> {
    throw new NotImplementedError('SessionAdapter', 'beginGitHubOAuth');
  }
  completeGitHubOAuth(): Promise<Session | null> {
    throw new NotImplementedError('SessionAdapter', 'completeGitHubOAuth');
  }
  registerPasskey(): Promise<{ optionsJson: string }> {
    throw new NotImplementedError('SessionAdapter', 'registerPasskey');
  }
  verifyPasskey(): Promise<Session | null> {
    throw new NotImplementedError('SessionAdapter', 'verifyPasskey');
  }
  getSession(): Promise<Session | null> {
    throw new NotImplementedError('SessionAdapter', 'getSession');
  }
  endSession(): Promise<void> {
    throw new NotImplementedError('SessionAdapter', 'endSession');
  }
}
