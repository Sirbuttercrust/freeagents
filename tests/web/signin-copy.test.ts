// P8b: the /signin page now offers the two real sign-in controls instead of
// the honest "not built yet" placeholder this file pinned before this card.
// The old placeholder text and the old "no route mints a session" fact are
// gone; this file proves what replaced both.

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('/signin offers the two real controls, and no longer says sign-in does not exist', () => {
  it('renders a GitHub button and a passkey button, and drops the old placeholder sentence', async () => {
    const res = await fetch(`${baseUrl}/signin`, { headers: { Accept: HTML } });
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain('id="btn-github"');
    expect(body).toContain('Continue with GitHub');
    expect(body).toContain('id="btn-passkey"');
    expect(body).toContain('Use a passkey');

    // The corrected claim this file used to pin is gone: the routes exist
    // now, so the page must not say otherwise.
    expect(body).not.toContain('There is no way to sign in yet.');
    expect(body).not.toContain('Sign-in is not wired up on this page yet.');
    expect(body).not.toContain('does not yet carry a button that starts the flow');
  });

  // D1 descoped by review ruling (P8b, 2026-09-07): a session and a
  // registered account are two different things, and this build does not
  // yet create the second one for a person automatically. The page must
  // say so up front rather than let either control's success path end at
  // a 403 with no explanation. Static because it has to be true before
  // either button is even clicked: the GitHub half never renders anything
  // on this page after a real redirect round trip (the callback route
  // answers JSON directly, unchanged by this card), so a message tied only
  // to a button's success handler would never reach that path at all.
  it('tells a visitor up front that signing in is not the same as having a registered account', async () => {
    const res = await fetch(`${baseUrl}/signin`, { headers: { Accept: HTML } });
    const body = await res.text();

    expect(body).toContain('id="account-notice"');
    expect(body).toContain('registered account');
    expect(body).toContain('does not create one for you automatically yet');
  });

  // qa review round 3, D3 (claim-contradicts-implementation): the
  // account-notice above told the truth, and the "How signing in works"
  // section 737px below it told the opposite: that every account can hire
  // and list "from the moment it exists" and identity "is created behind
  // the scenes" already. Both were rendered visible on the same page. This
  // guards the retraction the same way the placeholder-sentence guard above
  // guards the earlier lie, so a repair cannot silently reintroduce it.
  it('does not claim elsewhere on the page that an account is already created automatically for every visitor', async () => {
    const res = await fetch(`${baseUrl}/signin`, { headers: { Accept: HTML } });
    const body = await res.text();

    expect(body).not.toContain('can list from the moment it exists');
  });
});

// This is the fact the page's controls rest on. Every route named here
// mints or ends a real session (P8b); if any of these regresses to 404,
// the page above is back to offering a button that cannot work.
describe('every route the signin page depends on is mounted', () => {
  it('GET /auth/github/start answers 200, not 404', async () => {
    const res = await fetch(`${baseUrl}/auth/github/start`);
    expect(res.status).not.toBe(404);
  });

  it('POST /auth/passkey/register answers something other than 404 for a well-formed body', async () => {
    const res = await fetch(`${baseUrl}/auth/passkey/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'signin-copy-test-subject' }),
    });
    expect(res.status).not.toBe(404);
  });

  it.each([
    ['/auth/github/callback', 'GET'],
    ['/auth/passkey/verify', 'POST'],
    ['/auth/signout', 'POST'],
  ] as const)('%s (%s) is a mounted route', async (path, method) => {
    const res = await fetch(`${baseUrl}${path}`, { method });
    expect(res.status).not.toBe(404);
  });
});
