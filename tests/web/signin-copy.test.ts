// Proof follow-up (t_d1b82a77, F2): the served /signin page must say which
// half of sign-in exists and which does not, not read as "the flow exists,
// this page just lacks the button." Two things pinned together on purpose:
// the copy itself, and the fact that backs it (no HTTP route mints a
// session). If a future PR wires up /auth/github or /auth/passkey/verify,
// this file's second describe block goes red on its own and says so.

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('/signin states which half of sign-in exists, honestly', () => {
  it('says no route mints a session yet, and does not claim the flow exists', async () => {
    const res = await fetch(`${baseUrl}/signin`, { headers: { Accept: HTML } });
    expect(res.status).toBe(200);
    const body = await res.text();

    // The corrected claim: enforcement is live, issuance is not.
    expect(body).toContain('There is no way to sign in yet.');

    // The two phrasings round 2 shipped that read as "the flow exists,
    // this page just lacks a button" -- both must be gone.
    expect(body).not.toContain('Sign-in is not wired up on this page yet.');
    expect(body).not.toContain('does not yet carry a button that starts the flow');
  });
});

// This is the fact the copy above rests on. If it goes red, the copy is
// stale again and needs a human decision, not a wording pass -- see the
// card body for why (issue 84 territory, R-24 unblock plan).
describe('no HTTP route mints a session (the fact the corrected copy states)', () => {
  it.each([
    ['/auth/github', 'GET'],
    ['/auth/github/callback', 'GET'],
    ['/auth/passkey/register', 'POST'],
    ['/auth/passkey/verify', 'POST'],
    ['/session', 'GET'],
    ['/sessions', 'POST'],
    ['/login', 'GET'],
  ] as const)('%s (%s) is not a route', async (path, method) => {
    const res = await fetch(`${baseUrl}${path}`, { method });
    expect(res.status).toBe(404);
  });
});
