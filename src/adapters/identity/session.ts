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

// FIX-B47b: what a stored OAuth state is FOR. A sign-in state carries no
// extra fields at all (decision 1: neither an account nor an agent DID is
// bound at that point). A proof state names the account DID that started
// it and the one agent DID it may verify -- both fixed at start, never
// supplied again at completion, so a completed proof can only ever act on
// the agent it was begun for.
export type OAuthStatePurpose =
  | { readonly kind: 'sign-in' }
  | { readonly kind: 'proof'; readonly accountDid: string; readonly agentDid: string };

// FIX-B47b: the outcome of completing a proof-purpose OAuth state.
//   - 'ok': the exchange and the /user read both succeeded; the route still
//     has to publish and verify the gist before recording anything.
//   - 'invalid-state': the state was never issued, was already used, has
//     expired, or names the WRONG purpose (a sign-in state presented here,
//     decision 1's own guard). The same refusal for every one of those
//     causes, exactly as completeGitHubOAuth answers null for all of its
//     own failure shapes, so a caller cannot distinguish them by response.
//   - 'exchange-failed': the state was valid and proof-purposed, but the
//     provider's own token exchange or the /user read failed (a bad code,
//     or GitHub down). The owner declining at GitHub's consent screen never
//     reaches this method at all: GitHub sends that case back as
//     `error=access_denied` with no code, so nothing here ever sees it.
//     On this head no route calls completeGitHubProofOAuth yet; the
//     callback's proof branch (FIX-B47b part two) reads `error` off the
//     query string ahead of any code exchange and answers its own
//     'refused' outcome for access_denied without ever calling this method.
export type GitHubProofCompletion =
  | { readonly kind: 'ok'; readonly accountDid: string; readonly agentDid: string; readonly login: string; readonly token: string }
  | { readonly kind: 'invalid-state' }
  | { readonly kind: 'exchange-failed' };

export interface SessionAdapter {
  beginGitHubOAuth(): Promise<OAuthStart>;
  completeGitHubOAuth(params: {
    readonly code: string;
    readonly state: string;
  }): Promise<Session | null>;

  // FIX-B47b, decision 1 and 2: starts a proof-purpose OAuth state, bound
  // to the account DID that may complete it and the one agent DID it may
  // verify, asking for the `gist` scope and prompt=select_account so the
  // owner picks which GitHub account the agent works from. Never a
  // session: completing this state can only ever answer a
  // GitHubProofCompletion, through completeGitHubProofOAuth below.
  beginGitHubProofOAuth(accountDid: string, agentDid: string): Promise<OAuthStart>;

  // FIX-B47b, decision 1: tells a caller what a state is FOR, without
  // consuming it (the callback needs this to decide which completion
  // method to call, before either one runs its own single-use check).
  // null for a state never issued or already expired by TTL; a state
  // already consumed by its own completion method still answers its
  // original purpose here (peeking is read-only and carries no
  // side effect), so the callback can tell "wrong purpose" apart from
  // "this state is simply used up" if it ever needs to.
  peekOAuthStatePurpose(state: string): OAuthStatePurpose | null;

  // FIX-B47b: exchanges a proof-purpose state for the fields the route
  // needs to compose, sign and publish the gist statement, and never
  // mints a Session (decision 1, direction two). Single-use like
  // completeGitHubOAuth: consumed on this attempt whether or not the
  // exchange succeeds, so a reused state can never complete twice.
  // Refuses (invalid-state) a sign-in-purpose state presented here,
  // the mirror of completeGitHubOAuth refusing a proof-purpose state.
  completeGitHubProofOAuth(params: {
    readonly code: string;
    readonly state: string;
  }): Promise<GitHubProofCompletion>;

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
  beginGitHubProofOAuth(): Promise<OAuthStart> {
    throw new NotImplementedError('SessionAdapter', 'beginGitHubProofOAuth');
  }
  peekOAuthStatePurpose(): OAuthStatePurpose | null {
    throw new NotImplementedError('SessionAdapter', 'peekOAuthStatePurpose');
  }
  completeGitHubProofOAuth(): Promise<GitHubProofCompletion> {
    throw new NotImplementedError('SessionAdapter', 'completeGitHubProofOAuth');
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
