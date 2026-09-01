// Fixtures for src/adapters/identity/session.test.ts (R-39): a fake GitHub
// OAuth token/user endpoint pair, driven entirely through an injected
// fetchImpl so the test suite makes no real network call (CLAUDE.md, and
// this brief's "no network calls in the test suite").
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import type { SessionAdapter } from '../../src/adapters/identity/session.js';

export interface FakeGitHubUser {
  readonly login: string;
  readonly id: number;
}

// The two GitHub endpoints the OAuth web flow needs, faked in one function
// so a test can assert the whole round trip without touching the network.
// https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
export function fakeGitHubFetch(user: FakeGitHubUser): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.startsWith('https://github.com/login/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'fake-access-token', token_type: 'bearer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.startsWith('https://api.github.com/user')) {
      const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'] ?? '';
      if (!auth.includes('fake-access-token')) {
        return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
      }
      return new Response(JSON.stringify({ login: user.login, id: user.id }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

// A fetch stand-in whose token exchange fails outright: exercises the
// "reused or unknown state" and general-failure null paths without a
// throw ever crossing the adapter boundary.
export function failingGitHubFetch(): typeof fetch {
  return (async () => new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 400 })) as typeof fetch;
}

export function fakeGitHubConfig(): { readonly clientId: string; readonly clientSecret: string; readonly redirectUri: string } {
  return {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'http://localhost:3000/auth/github/callback',
  };
}

// R-39 follow-up (issue 83, route enforcement): a ready-to-use session
// adapter plus a helper that mints a real, live bearer token through the
// same GitHub OAuth round trip session.test.ts exercises. Shared by every
// route test that needs a live session header rather than a fake one, so
// the token a test presents is one the adapter's own getSession() actually
// resolves, not a hand-typed string.
export function testSessionAdapter(): SessionAdapter {
  return createSessionAdapter({
    github: fakeGitHubConfig(),
    fetchImpl: fakeGitHubFetch({ login: 'test-session-user', id: Math.floor(Math.random() * 1_000_000) }),
  });
}

export async function mintSessionToken(adapter: SessionAdapter): Promise<string> {
  const start = await adapter.beginGitHubOAuth();
  const session = await adapter.completeGitHubOAuth({ code: 'test-code', state: start.state });
  if (session === null) {
    throw new Error('mintSessionToken: completeGitHubOAuth unexpectedly returned null');
  }
  return session.token;
}

// The header shape every gated-route test needs: Authorization: Bearer
// <token>, from a session the SAME adapter instance passed into createApp
// will resolve.
export async function sessionHeader(adapter: SessionAdapter): Promise<{ readonly authorization: string }> {
  const token = await mintSessionToken(adapter);
  return { authorization: `Bearer ${token}` };
}
