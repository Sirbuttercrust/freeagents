// SessionAdapter implementation for GitHub OAuth and passkey (R-39). This
// is the only file that imports a GitHub package or the WebAuthn library:
// src/adapters/identity/session.ts (the contract) and everything in
// src/domain/ stay vendor-free, per the brief's "vendors live in the
// adapter implementation only".
//
// GitHub OAuth: the documented web application flow.
// https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
// Scope requested is deliberately empty (no `scope` parameter at all):
// GitHub's own docs say an omitted scope defaults to no access beyond
// identifying the user, and sign-in needs to know who the user is, not
// their repositories.
//
// Passkey: @simplewebauthn/server v13 (MasterKale/SimpleWebAuthn), the
// standard, actively maintained WebAuthn library. See the PR body for the
// new-dependency justification this brief requires.
//
// The contract exposes exactly registerPasskey(subject) and
// verifyPasskey(responseJson): no separate "begin authentication" method.
// So the round trip this adapter implements is registration-as-sign-in --
// completing a registration ceremony proves possession of the authenticator
// and issues a session, the same way GitHub's callback does. A returning
// user re-authenticating with an existing passkey (no fresh registration)
// is a real product need the contract does not expose a method for; it is
// named as an assumption in the PR body rather than invented here as a
// signature change the brief forbids.
import { randomBytes } from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { OAuthStart, Session, SessionAdapter, SignInMethod } from './session.js';

// One store, one row shape, for both sign-in methods (the brief: "one
// session shape... no parallel token store per method"). subject and
// method are the fields Session itself carries; everything past them is
// this adapter's own bookkeeping, never returned to a caller.
interface StoredSession {
  readonly subject: string;
  readonly method: SignInMethod;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  revoked: boolean;
}

interface StoredOAuthState {
  readonly createdAtMs: number;
  used: boolean;
}

interface StoredPasskeyChallenge {
  readonly challenge: string;
  readonly createdAtMs: number;
  used: boolean;
}

// A durable local id for a GitHub account that has not (yet, or ever)
// created a did:abt DID -- the contract's own comment on Session.subject:
// "a user who has not created a DID yet gets a stable local id". Prefixed
// so R-24's did:abt subjects and this adapter's subjects can never collide
// in the same field.
function githubSubject(githubUserId: number): string {
  return `github:${githubUserId}`;
}

export interface GitHubOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

export interface PasskeyConfig {
  readonly rpName: string;
  readonly rpID: string;
  readonly origin: string;
}

export interface SessionAdapterOptions {
  readonly github: GitHubOAuthConfig;
  readonly passkey?: PasskeyConfig;
  /** Injected for tests; defaults to the real fetch (no network in the test suite otherwise). */
  readonly fetchImpl?: typeof fetch;
  readonly sessionTtlMs?: number;
  readonly oauthStateTtlMs?: number;
  readonly passkeyChallengeTtlMs?: number;
  /** Injected clock, for testing expiry. */
  readonly now?: () => number;
}

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10m, single-use regardless
const DEFAULT_PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5m, single-use regardless

interface GitHubUserResponse {
  readonly login: string;
  readonly id: number;
}

function isGitHubUserResponse(value: unknown): value is GitHubUserResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.login === 'string' && typeof v.id === 'number';
}

// R-39 follow-up (issue 83, route enforcement): the env-derived default for
// createApp, mirroring credentials.ts's platformIssuerFromEnv. `||` and not
// `??` throughout: Blocklet Server materialises every declared env var, so
// an unconfigured deployment delivers '' rather than undefined, and the
// nullish fallback would build a GitHub OAuth config that silently fails
// every exchange instead of announcing itself. An unconfigured deployment
// still returns a working adapter (session mechanics, rate limiting and the
// route gate all function); only the GitHub token exchange itself will fail
// closed against the real provider, which is the honest behaviour for a
// deployment nobody has wired up yet.
export function sessionAdapterFromEnv(): SessionAdapter {
  const clientId = process.env.FREEAGENTS_GITHUB_CLIENT_ID || '';
  const clientSecret = process.env.FREEAGENTS_GITHUB_CLIENT_SECRET || '';
  const redirectUri = process.env.FREEAGENTS_GITHUB_REDIRECT_URI || 'http://localhost:3000/auth/github/callback';
  if (clientId === '' || clientSecret === '') {
    console.warn(
      'session: FREEAGENTS_GITHUB_CLIENT_ID/FREEAGENTS_GITHUB_CLIENT_SECRET not set; ' +
        'GitHub OAuth sign-in will fail closed until configured. Passkey and existing ' +
        'sessions are unaffected.',
    );
  }
  const rpID = process.env.FREEAGENTS_PASSKEY_RP_ID;
  // exactOptionalPropertyTypes forbids `passkey: undefined`, so the key is
  // spread in only when a passkey config actually exists, not merely
  // assigned a possibly-undefined value.
  return createSessionAdapter({
    github: { clientId, clientSecret, redirectUri },
    ...(rpID === undefined || rpID === ''
      ? {}
      : {
          passkey: {
            rpName: process.env.FREEAGENTS_PASSKEY_RP_NAME || 'FreeAgents',
            rpID,
            origin: process.env.FREEAGENTS_PASSKEY_ORIGIN || `https://${rpID}`,
          },
        }),
  });
}

export function createSessionAdapter(options: SessionAdapterOptions): SessionAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const oauthStateTtlMs = options.oauthStateTtlMs ?? DEFAULT_OAUTH_STATE_TTL_MS;
  const passkeyChallengeTtlMs = options.passkeyChallengeTtlMs ?? DEFAULT_PASSKEY_CHALLENGE_TTL_MS;

  const sessions = new Map<string, StoredSession>();
  const oauthStates = new Map<string, StoredOAuthState>();
  // Registration challenges keyed by the subject a caller is registering a
  // passkey for.
  const registrationChallenges = new Map<string, StoredPasskeyChallenge>();

  function newSession(subject: string, method: SignInMethod): Session {
    const token = randomBytes(32).toString('base64url');
    const issuedAtMs = now();
    const expiresAtMs = issuedAtMs + sessionTtlMs;
    sessions.set(token, { subject, method, issuedAtMs, expiresAtMs, revoked: false });
    return {
      subject,
      method,
      token,
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  return {
    async beginGitHubOAuth(): Promise<OAuthStart> {
      const state = randomBytes(32).toString('base64url');
      oauthStates.set(state, { createdAtMs: now(), used: false });
      const url = new URL('https://github.com/login/oauth/authorize');
      url.searchParams.set('client_id', options.github.clientId);
      url.searchParams.set('redirect_uri', options.github.redirectUri);
      url.searchParams.set('state', state);
      // No `scope` parameter: GitHub's own docs say an omitted scope
      // defaults to no access beyond identifying the user (the minimum
      // this sign-in needs), never repo access.
      return { redirectUrl: url.toString(), state };
    },

    // Total: every failure path returns null, never a throw, so the route
    // maps null to 401 without inspecting error messages (mirrors
    // verifyDelegation and http-signature's verify() elsewhere in this
    // codebase).
    async completeGitHubOAuth(params: { readonly code: string; readonly state: string }): Promise<Session | null> {
      try {
        const stored = oauthStates.get(params.state);
        if (stored === undefined || stored.used) return null;
        if (now() - stored.createdAtMs > oauthStateTtlMs) return null;
        // Single-use: consumed on this attempt whether or not the rest of
        // the exchange succeeds, so a reused state can never complete twice.
        stored.used = true;

        const tokenRes = await fetchImpl('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({
            client_id: options.github.clientId,
            client_secret: options.github.clientSecret,
            code: params.code,
            redirect_uri: options.github.redirectUri,
          }),
        });
        if (!tokenRes.ok) return null;
        const tokenBody = (await tokenRes.json()) as { access_token?: unknown };
        if (typeof tokenBody.access_token !== 'string' || tokenBody.access_token.length === 0) return null;

        const userRes = await fetchImpl('https://api.github.com/user', {
          headers: { authorization: `Bearer ${tokenBody.access_token}`, accept: 'application/vnd.github+json' },
        });
        if (!userRes.ok) return null;
        const userBody: unknown = await userRes.json();
        if (!isGitHubUserResponse(userBody)) return null;

        return newSession(githubSubject(userBody.id), 'github-oauth');
      } catch {
        return null;
      }
    },

    async registerPasskey(subject: string): Promise<{ optionsJson: string }> {
      if (options.passkey === undefined) {
        throw new Error('session adapter: passkey is not configured (FREEAGENTS_PASSKEY_RP_ID unset)');
      }
      const regOptions = await generateRegistrationOptions({
        rpName: options.passkey.rpName,
        rpID: options.passkey.rpID,
        userName: subject,
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      });
      registrationChallenges.set(subject, { challenge: regOptions.challenge, createdAtMs: now(), used: false });
      return { optionsJson: JSON.stringify(regOptions) };
    },

    // responseJson carries { subject, response }: the subject names which
    // registerPasskey() challenge this completes (the browser's WebAuthn
    // response has no notion of "subject" on its own; binding it to one is
    // this adapter's job, like any relying party's).
    async verifyPasskey(responseJson: string): Promise<Session | null> {
      if (options.passkey === undefined) return null;
      try {
        const parsed: unknown = JSON.parse(responseJson);
        if (typeof parsed !== 'object' || parsed === null) return null;
        const envelope = parsed as { subject?: unknown; response?: unknown };
        if (typeof envelope.subject !== 'string' || envelope.response === undefined) return null;

        const challengeRow = registrationChallenges.get(envelope.subject);
        if (challengeRow === undefined || challengeRow.used) return null;
        if (now() - challengeRow.createdAtMs > passkeyChallengeTtlMs) return null;
        challengeRow.used = true; // single-use regardless of outcome

        const verification = await verifyRegistrationResponse({
          response: envelope.response as RegistrationResponseJSON,
          expectedChallenge: challengeRow.challenge,
          expectedOrigin: options.passkey.origin,
          expectedRPID: options.passkey.rpID,
        });
        if (!verification.verified) return null;
        return newSession(envelope.subject, 'passkey');
      } catch {
        return null;
      }
    },

    async getSession(token: string): Promise<Session | null> {
      const row = sessions.get(token);
      if (row === undefined) return null;
      // Expired and revoked resolve to null indistinguishably: the
      // contract's own requirement. One check, one outcome, no separate
      // branch that could leak which happened.
      if (row.revoked || now() >= row.expiresAtMs) return null;
      return {
        subject: row.subject,
        method: row.method,
        token,
        issuedAt: new Date(row.issuedAtMs).toISOString(),
        expiresAt: new Date(row.expiresAtMs).toISOString(),
      };
    },

    async endSession(token: string): Promise<void> {
      // Idempotent: ending a dead (or never-existent) session is a no-op,
      // never a throw.
      const row = sessions.get(token);
      if (row !== undefined) row.revoked = true;
    },
  };
}
