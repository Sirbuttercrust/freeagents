// SessionAdapter implementation for GitHub OAuth and passkey (R-39). This
// is the only file that imports a GitHub package or the WebAuthn library:
// src/adapters/identity/session.ts (the contract) and everything in
// src/domain/ stay vendor-free, per the brief's "vendors live in the
// adapter implementation only".
//
// GitHub OAuth: the documented web application flow.
// https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
// Sign-in's own scope is deliberately empty (no `scope` parameter at all):
// GitHub's own docs say an omitted scope defaults to no access beyond
// identifying the user, and sign-in needs to know who the user is, not
// their repositories. FIX-B47b: the ONE-CLICK GITHUB PROOF's own start
// (beginGitHubProofOAuth) is the sole caller in this file that ever asks
// for a scope, and it asks for exactly `gist` (never `repo`, never a
// write to any repository) plus prompt=select_account, so the owner picks
// which GitHub account the agent works from. Sign-in's own authorize call
// (beginGitHubOAuth) is unchanged by this: it still asks for nothing.
//
// Passkey: @simplewebauthn/server v13 (MasterKale/SimpleWebAuthn), the
// standard, actively maintained WebAuthn library. See the PR body for the
// new-dependency justification this brief requires.
//
// FIX-B61a: a passkey signs in only the account it was registered to. The
// server makes the passkey name at register and binds it to the ceremony;
// verifyPasskey finds the ceremony by the challenge inside the response,
// stores the credential under that name, and only then mints the session;
// beginPasskeySignIn / completePasskeySignIn check a later assertion
// against the stored key and counter, with the user handle equal to the
// stored name. The browser names nobody. No stored passkey, no passkey
// sign-in.
import { randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from '@simplewebauthn/server';
import { MemoryPasskeyCredentialRepository } from '../storage/memory.js';
import { createPasskeyCredentialRepository } from '../storage/storage.js';
import { PasskeyCredentialAlreadyExistsError, type PasskeyCredentialRepository } from '../storage/types.js';
import type { OAuthStart, GitHubProofCompletion, OAuthStatePurpose, Session, SessionAdapter, SignInMethod } from './session.js';

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

// FIX-B47b: what an OAuth state is FOR, stored beside it (decision 1). A
// sign-in state carries no extra fields; a proof state carries the account
// DID that started it and the one agent DID it may verify, fixed at start
// and never re-supplied at completion.
type StoredStatePurpose =
  | { readonly kind: 'sign-in' }
  | { readonly kind: 'proof'; readonly accountDid: string; readonly agentDid: string };

interface StoredOAuthState {
  readonly createdAtMs: number;
  readonly purpose: StoredStatePurpose;
  used: boolean;
}

// A passkey ceremony in flight. `subject` is the passkey name the server
// made at register; it is bound to the challenge here and never re-read from
// anything a browser sends back.
interface StoredPasskeyChallenge {
  readonly subject: string | null;
  readonly createdAtMs: number;
  used: boolean;
}

// The browser's passkey picker label: it says nothing about the account.
const PASSKEY_LABEL = 'FreeAgents account';

// The challenge a browser signed lives inside the response's clientDataJSON,
// so it is what finds the ceremony a response completes. Null for anything
// that is not a well-formed response.
function challengeInClientData(response: unknown): string | null {
  const encoded = (response as { response?: { clientDataJSON?: unknown } } | null)?.response?.clientDataJSON;
  if (typeof encoded !== 'string') return null;
  try {
    const clientData = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { challenge?: unknown } | null;
    const challenge = clientData?.challenge;
    return typeof challenge === 'string' && challenge.length > 0 ? challenge : null;
  } catch {
    return null;
  }
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
  /**
   * Where the passkey made at sign-up is kept, so every later sign-in is
   * checked against it. Defaults to a new in-memory store per adapter (a
   * passkey then lasts only as long as the adapter); a deployment passes
   * createPasskeyCredentialRepository() so it survives a restart.
   */
  readonly passkeyCredentials?: PasskeyCredentialRepository;
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
// How long the browser gives a person to finish a passkey ceremony. The
// library's default is 60 seconds, too short when the passkey lives on a
// phone reached by a QR code from a computer. Five minutes, the same as the
// server keeps the challenge, so the browser never waits on a challenge the
// server has already dropped.
const PASSKEY_CEREMONY_TIMEOUT_MS = DEFAULT_PASSKEY_CHALLENGE_TTL_MS;
// COSE algorithm ids: ES256 (-7), then RS256 (-257).
const PASSKEY_ALGORITHMS = [-7, -257];

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
    passkeyCredentials: createPasskeyCredentialRepository(),
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
  const passkeys = options.passkeyCredentials ?? new MemoryPasskeyCredentialRepository();
  // Registration and sign-in challenges, each keyed by the challenge string
  // the browser signs. A registration challenge carries the name the server
  // made; a sign-in challenge names nobody. They are separate maps so a
  // challenge issued for one ceremony can never complete the other.
  const registrationChallenges = new Map<string, StoredPasskeyChallenge>();
  const signInChallenges = new Map<string, StoredPasskeyChallenge>();

  // Finds the pending ceremony a response completes, by the challenge inside
  // its clientDataJSON. Single-use: consumed here, on this attempt, whatever
  // the rest of the attempt does. Null for unknown, used or expired.
  function takeChallenge(
    pending: Map<string, StoredPasskeyChallenge>,
    response: unknown,
  ): { readonly challenge: string; readonly row: StoredPasskeyChallenge } | null {
    const challenge = challengeInClientData(response);
    if (challenge === null) return null;
    const row = pending.get(challenge);
    if (row === undefined || row.used) return null;
    if (now() - row.createdAtMs > passkeyChallengeTtlMs) return null;
    row.used = true;
    return { challenge, row };
  }

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

  // FIX-B47b: the token exchange and /user read completeGitHubOAuth and
  // completeGitHubProofOAuth both need -- extracted so the proof path
  // reuses the IDENTICAL GitHub calls sign-in already makes, never a
  // second, only-superficially-similar implementation. Total: any failure
  // (a bad code, a provider outage, a malformed response) is null, never a
  // throw, so each caller maps it to its own failure shape without
  // inspecting which one it was.
  async function exchangeCodeForLogin(code: string): Promise<{ readonly login: string; readonly token: string } | null> {
    try {
      const tokenRes = await fetchImpl('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: options.github.clientId,
          client_secret: options.github.clientSecret,
          code,
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

      return { login: userBody.login, token: tokenBody.access_token };
    } catch {
      return null;
    }
  }

  return {
    async beginGitHubOAuth(): Promise<OAuthStart> {
      const state = randomBytes(32).toString('base64url');
      oauthStates.set(state, { createdAtMs: now(), purpose: { kind: 'sign-in' }, used: false });
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
      const stored = oauthStates.get(params.state);
      if (stored === undefined || stored.used) return null;
      // Decision 1, direction two: a proof-purpose state can never mint a
      // session. Checked BEFORE consuming the state, so a crossed-over
      // attempt leaves the proof state exactly as it was, still completable
      // through completeGitHubProofOAuth.
      if (stored.purpose.kind !== 'sign-in') return null;
      if (now() - stored.createdAtMs > oauthStateTtlMs) return null;
      // Single-use: consumed on this attempt whether or not the rest of
      // the exchange succeeds, so a reused state can never complete twice.
      stored.used = true;

      const exchanged = await exchangeCodeForLogin(params.code);
      if (exchanged === null) return null;
      return newSession(exchanged.login, 'github-oauth');
    },

    // FIX-B47b, decision 1 and 2: mints a proof-purpose state bound to the
    // caller-resolved account DID and the one agent DID this proof may
    // verify, asking for `gist` and prompt=select_account. Rejects before
    // minting any state when OAuth is not configured (empty client id or
    // secret) -- the same fail-closed-before-any-side-effect stance
    // requireOAuthAppCredentials takes in the github adapter.
    async beginGitHubProofOAuth(accountDid: string, agentDid: string): Promise<OAuthStart> {
      if (options.github.clientId === '' || options.github.clientSecret === '') {
        throw new Error('session adapter: FREEAGENTS_GITHUB_CLIENT_ID/FREEAGENTS_GITHUB_CLIENT_SECRET are not configured');
      }
      const state = randomBytes(32).toString('base64url');
      oauthStates.set(state, {
        createdAtMs: now(),
        purpose: { kind: 'proof', accountDid, agentDid },
        used: false,
      });
      const url = new URL('https://github.com/login/oauth/authorize');
      url.searchParams.set('client_id', options.github.clientId);
      url.searchParams.set('redirect_uri', options.github.redirectUri);
      url.searchParams.set('scope', 'gist');
      url.searchParams.set('prompt', 'select_account');
      url.searchParams.set('state', state);
      return { redirectUrl: url.toString(), state };
    },

    // FIX-B47b, decision 1: read-only, never consumes the state. A state
    // already used still answers its original purpose (used-ness is a
    // separate fact each completion method checks for itself).
    peekOAuthStatePurpose(state: string): OAuthStatePurpose | null {
      const stored = oauthStates.get(state);
      if (stored === undefined) return null;
      if (now() - stored.createdAtMs > oauthStateTtlMs) return null;
      return stored.purpose;
    },

    // FIX-B47b: the proof-purpose counterpart of completeGitHubOAuth.
    // Refuses (invalid-state) a sign-in-purpose state, an expired state, an
    // already-used state, or a state never issued -- the same one shape for
    // every one of those causes, so a caller cannot learn which happened.
    // Single-use: consumed before the exchange runs, whether or not the
    // exchange itself succeeds.
    async completeGitHubProofOAuth(params: { readonly code: string; readonly state: string }): Promise<GitHubProofCompletion> {
      const stored = oauthStates.get(params.state);
      if (stored === undefined || stored.used) return { kind: 'invalid-state' };
      // Decision 1, direction one: a sign-in-purpose state can never
      // complete a proof. Checked before consuming the state, so a
      // crossed-over attempt leaves the sign-in state exactly as it was.
      if (stored.purpose.kind !== 'proof') return { kind: 'invalid-state' };
      if (now() - stored.createdAtMs > oauthStateTtlMs) return { kind: 'invalid-state' };
      stored.used = true;

      const exchanged = await exchangeCodeForLogin(params.code);
      if (exchanged === null) return { kind: 'exchange-failed' };
      return {
        kind: 'ok',
        accountDid: stored.purpose.accountDid,
        agentDid: stored.purpose.agentDid,
        login: exchanged.login,
        token: exchanged.token,
      };
    },

    // The server calls this with a name it made, never one a browser sent.
    // The challenge is bound to that name, and the name is the user handle,
    // so a later sign-in finds the account from the passkey itself.
    async registerPasskey(subject: string): Promise<{ optionsJson: string }> {
      if (options.passkey === undefined) {
        throw new Error('session adapter: passkey is not configured (FREEAGENTS_PASSKEY_RP_ID unset)');
      }
      const regOptions = await generateRegistrationOptions({
        rpName: options.passkey.rpName,
        rpID: options.passkey.rpID,
        // A plain label for the browser's passkey picker. The name rides
        // only in the user handle (userID), never in a visible label.
        userName: PASSKEY_LABEL,
        // The library's default is an empty display name. Some phone
        // passkey managers refuse to save a passkey with no display name,
        // so the picker gets the same plain label.
        userDisplayName: PASSKEY_LABEL,
        userID: new TextEncoder().encode(subject),
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        // ES256 first, then RS256. The library's default puts Ed25519 first,
        // which a phone's platform authenticator does not reliably support.
        supportedAlgorithmIDs: PASSKEY_ALGORITHMS,
        timeout: PASSKEY_CEREMONY_TIMEOUT_MS,
      });
      registrationChallenges.set(regOptions.challenge, { subject, createdAtMs: now(), used: false });
      return { optionsJson: JSON.stringify(regOptions) };
    },

    // responseJson carries { response }. The ceremony is found by the
    // challenge inside it; any `subject` in the envelope is not read. A
    // failed attempt is null; a storage failure throws, so no session is
    // minted for a passkey that was never stored.
    async verifyPasskey(responseJson: string): Promise<Session | null> {
      if (options.passkey === undefined) return null;
      let subject: string;
      let credential: WebAuthnCredential;
      try {
        const parsed: unknown = JSON.parse(responseJson);
        if (typeof parsed !== 'object' || parsed === null) return null;
        const response = (parsed as { response?: unknown }).response;
        if (response === undefined) return null;

        const taken = takeChallenge(registrationChallenges, response);
        if (taken === null || taken.row.subject === null) return null;

        const verification = await verifyRegistrationResponse({
          response: response as RegistrationResponseJSON,
          expectedChallenge: taken.challenge,
          expectedOrigin: options.passkey.origin,
          expectedRPID: options.passkey.rpID,
          requireUserVerification: true,
        });
        if (!verification.verified) return null;
        subject = taken.row.subject;
        credential = verification.registrationInfo.credential;
      } catch {
        return null;
      }

      try {
        await passkeys.save({
          id: credential.id,
          subject,
          publicKey: credential.publicKey,
          counter: credential.counter,
          transports: credential.transports ?? [],
          createdAt: new Date(now()),
          lastUsedAt: null,
        });
      } catch (err) {
        // A credential id already bound is a refused attempt, not a fault:
        // nothing was stored and nothing is minted.
        if (err instanceof PasskeyCredentialAlreadyExistsError) return null;
        throw err;
      }
      return newSession(subject, 'passkey');
    },

    // No allowCredentials: the browser offers the passkeys it holds for
    // this site, and the one it picks names the account by its user handle.
    async beginPasskeySignIn(): Promise<{ optionsJson: string }> {
      if (options.passkey === undefined) {
        throw new Error('session adapter: passkey is not configured (FREEAGENTS_PASSKEY_RP_ID unset)');
      }
      const authOptions = await generateAuthenticationOptions({
        rpID: options.passkey.rpID,
        userVerification: 'required',
        timeout: PASSKEY_CEREMONY_TIMEOUT_MS,
      });
      signInChallenges.set(authOptions.challenge, { subject: null, createdAtMs: now(), used: false });
      return { optionsJson: JSON.stringify(authOptions) };
    },

    // Every refusal is null; a storage failure throws.
    async completePasskeySignIn(responseJson: string): Promise<Session | null> {
      if (options.passkey === undefined) return null;
      const passkey = options.passkey;
      let response: AuthenticationResponseJSON;
      try {
        const parsed: unknown = JSON.parse(responseJson);
        if (typeof parsed !== 'object' || parsed === null) return null;
        response = parsed as AuthenticationResponseJSON;
      } catch {
        return null;
      }
      // Consumed here, on this attempt, whatever the rest does.
      const taken = takeChallenge(signInChallenges, response);
      if (taken === null) return null;
      if (typeof response.id !== 'string' || response.id.length === 0) return null;

      const stored = await passkeys.findById(response.id);
      if (stored === null) return null;

      const userHandle = response.response?.userHandle;
      if (typeof userHandle !== 'string') return null;
      if (Buffer.from(userHandle, 'base64url').toString('utf8') !== stored.subject) return null;

      let newCounter: number;
      try {
        const verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge: taken.challenge,
          expectedOrigin: passkey.origin,
          expectedRPID: passkey.rpID,
          credential: {
            id: stored.id,
            publicKey: stored.publicKey,
            counter: stored.counter,
            transports: stored.transports as AuthenticatorTransportFuture[],
          },
          requireUserVerification: true,
        });
        if (!verification.verified) return null;
        newCounter = verification.authenticationInfo.newCounter;
      } catch {
        return null;
      }
      await passkeys.recordUse(stored.id, newCounter);
      return newSession(stored.subject, 'passkey');
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
