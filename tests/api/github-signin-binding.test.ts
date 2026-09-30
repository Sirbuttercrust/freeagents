// SW4-06: a GitHub sign-in completes only in the browser that began it.
// GET /auth/github/start binds the state to the caller with an HttpOnly
// cookie and GET /auth/github/callback refuses a sign-in that does not
// bring it back. Every test drives the real routes over HTTP and reads the
// real Set-Cookie header, the way a browser would.
import type { Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { fakeGitHubConfig, fakeGitHubFetch } from '../helpers/session-fixtures.js';

const HTML = 'text/html';
const REFUSAL = { error: 'invalid or expired sign-in attempt' };

let server: Server | null = null;

afterEach(async () => {
  if (server !== null) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

async function boot(redirectUri?: string): Promise<string> {
  const sessionAdapter = createSessionAdapter({
    github: { ...fakeGitHubConfig(), ...(redirectUri !== undefined ? { redirectUri } : {}) },
    fetchImpl: fakeGitHubFetch({ login: 'octo-binding', id: 9101 }),
  });
  const app = createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sessionAdapter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return `http://127.0.0.1:${address.port}`;
}

interface ParsedCookie {
  readonly name: string;
  readonly value: string;
  // Attribute names lower-cased; a flag attribute (HttpOnly, Secure) maps to ''.
  readonly attributes: ReadonlyMap<string, string>;
}

// Every Set-Cookie line the response carries for `name`, parsed attribute by
// attribute, so a test asserts each attribute and never a substring.
function cookiesNamed(res: Response, name: string): ParsedCookie[] {
  const parsed: ParsedCookie[] = [];
  for (const line of res.headers.getSetCookie()) {
    const [pair, ...rest] = line.split(';').map((part) => part.trim());
    const eq = pair!.indexOf('=');
    if (pair!.slice(0, eq) !== name) continue;
    const attributes = new Map<string, string>();
    for (const attr of rest) {
      const at = attr.indexOf('=');
      if (at === -1) attributes.set(attr.toLowerCase(), '');
      else attributes.set(attr.slice(0, at).toLowerCase(), attr.slice(at + 1));
    }
    parsed.push({ name, value: pair!.slice(eq + 1), attributes });
  }
  return parsed;
}

async function start(baseUrl: string): Promise<{ state: string; res: Response }> {
  const res = await fetch(`${baseUrl}/auth/github/start`);
  const body = (await res.json()) as { state: string };
  return { state: body.state, res };
}

function callback(baseUrl: string, state: string, init: { cookie?: string; accept?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.cookie !== undefined) headers['Cookie'] = init.cookie;
  if (init.accept !== undefined) headers['Accept'] = init.accept;
  return fetch(`${baseUrl}/auth/github/callback?code=good-code&state=${encodeURIComponent(state)}`, { headers });
}

function expectCleared(res: Response): void {
  const cleared = cookiesNamed(res, 'fa_oauth_state');
  expect(cleared).toHaveLength(1);
  expect(cleared[0]!.value).toBe('');
  expect(cleared[0]!.attributes.get('path')).toBe('/auth/github/callback');
  expect(new Date(cleared[0]!.attributes.get('expires')!).getTime()).toBeLessThan(Date.now());
}

describe('(a) GET /auth/github/start sets the binding cookie', () => {
  it('sets one fa_oauth_state cookie holding the returned state, HttpOnly, SameSite=Lax, on the callback path, for 600 seconds, without Secure on an http redirect', async () => {
    const baseUrl = await boot();
    const { state, res } = await start(baseUrl);

    const cookies = cookiesNamed(res, 'fa_oauth_state');
    expect(cookies).toHaveLength(1);
    const cookie = cookies[0]!;
    expect(cookie.value).toBe(state);
    expect(cookie.attributes.has('httponly')).toBe(true);
    expect(cookie.attributes.get('samesite')).toBe('Lax');
    expect(cookie.attributes.get('path')).toBe('/auth/github/callback');
    expect(cookie.attributes.get('max-age')).toBe('600');
    expect(cookie.attributes.has('secure')).toBe(false);
    expect(res.headers.getSetCookie()).toHaveLength(1);
  });

  it('adds Secure when the redirect_uri in the start answer is https', async () => {
    const baseUrl = await boot('https://freeagents.example/auth/github/callback');
    const { state, res } = await start(baseUrl);

    const cookies = cookiesNamed(res, 'fa_oauth_state');
    expect(cookies).toHaveLength(1);
    const cookie = cookies[0]!;
    expect(cookie.value).toBe(state);
    expect(cookie.attributes.has('secure')).toBe(true);
    expect(cookie.attributes.has('httponly')).toBe(true);
    expect(cookie.attributes.get('samesite')).toBe('Lax');
    expect(cookie.attributes.get('path')).toBe('/auth/github/callback');
    expect(cookie.attributes.get('max-age')).toBe('600');
  });
});

describe("(b) the callback with the starting browser's cookie", () => {
  it('answers 200 with the session as JSON and clears the cookie on the callback path', async () => {
    const baseUrl = await boot();
    const { state } = await start(baseUrl);

    const res = await callback(baseUrl, state, { cookie: `fa_oauth_state=${state}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      subject: 'octo-binding',
      method: 'github-oauth',
      token: expect.any(String),
      issuedAt: expect.any(String),
      expiresAt: expect.any(String),
    });
    expectCleared(res);
  });

  it('answers 200 with the session page for a browser and clears the cookie on the callback path', async () => {
    const baseUrl = await boot();
    const { state } = await start(baseUrl);

    const res = await callback(baseUrl, state, { cookie: `fa_oauth_state=${state}`, accept: HTML });
    expect(res.status).toBe(200);
    expect(String(res.headers.get('content-type'))).toContain('text/html');
    expect(await res.text()).toContain('id="fa-session-data"');
    expectCleared(res);
  });
});

describe('(c) the callback with no cookie', () => {
  it('answers 401 with the whole refusal body, clears the cookie path, and leaves the state unused', async () => {
    const baseUrl = await boot();
    const { state } = await start(baseUrl);

    const refused = await callback(baseUrl, state);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual(REFUSAL);
    expectCleared(refused);

    const completed = await callback(baseUrl, state, { cookie: `fa_oauth_state=${state}` });
    expect(completed.status).toBe(200);
  });

  it('answers a browser 401 with the error page, and the state still completes with its cookie', async () => {
    const baseUrl = await boot();
    const { state } = await start(baseUrl);

    const refused = await callback(baseUrl, state, { accept: HTML });
    expect(refused.status).toBe(401);
    expect(String(refused.headers.get('content-type'))).toContain('text/html');
    const page = await refused.text();
    expect(page).toContain('Sign-in did not go through');
    expect(page).not.toContain('fa-session-data');

    const completed = await callback(baseUrl, state, { cookie: `fa_oauth_state=${state}` });
    expect(completed.status).toBe(200);
  });
});

describe('(d) the callback with a cookie holding a different state', () => {
  it('answers 401 and consumes neither state', async () => {
    const baseUrl = await boot();
    const first = await start(baseUrl);
    const second = await start(baseUrl);

    const refused = await callback(baseUrl, first.state, { cookie: `fa_oauth_state=${second.state}` });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual(REFUSAL);

    const firstDone = await callback(baseUrl, first.state, { cookie: `fa_oauth_state=${first.state}` });
    expect(firstDone.status).toBe(200);
    const secondDone = await callback(baseUrl, second.state, { cookie: `fa_oauth_state=${second.state}` });
    expect(secondDone.status).toBe(200);
  });

  it('compares the whole string exactly, with no case folding', async () => {
    const baseUrl = await boot();
    const { state } = await start(baseUrl);
    const swapped = state.toUpperCase() === state ? state.toLowerCase() : state.toUpperCase();
    expect(swapped).not.toBe(state);

    const refused = await callback(baseUrl, state, { cookie: `fa_oauth_state=${swapped}` });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual(REFUSAL);
  });
});

describe('(e) a state is single use', () => {
  it('answers 401 for a reused state even with its cookie', async () => {
    const baseUrl = await boot();
    const { state } = await start(baseUrl);
    const cookie = `fa_oauth_state=${state}`;

    expect((await callback(baseUrl, state, { cookie })).status).toBe(200);
    const replay = await callback(baseUrl, state, { cookie });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual(REFUSAL);
  });
});
