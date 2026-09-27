// FIX-B47b: the session adapter's one-click GitHub proof primitives.
// beginGitHubProofOAuth mints a state bound to one account DID and one
// agent DID, asking for the `gist` scope. peekOAuthStatePurpose tells a
// caller what a state is FOR without consuming it. completeGitHubProofOAuth
// exchanges a proof state into { accountDid, agentDid, login, token } and
// never mints a session. Decision 1: a sign-in state can never complete a
// proof, and a proof state can never mint a session -- both directions are
// pinned here, not only from the route layer.
import { describe, it, expect } from 'vitest';
import { createSessionAdapter } from '../../../src/adapters/identity/session-github-passkey.js';
import { fakeGitHubConfig, fakeGitHubFetch, failingGitHubFetch } from '../../helpers/session-fixtures.js';

describe('beginGitHubProofOAuth (FIX-B47b)', () => {
  it('answers a redirect URL carrying exactly client_id, redirect_uri, scope=gist, prompt=select_account, and a fresh state', async () => {
    const adapter = createSessionAdapter({ github: fakeGitHubConfig() });
    const start = await adapter.beginGitHubProofOAuth('did:abt:zOwner', 'did:abt:zAgent');
    const url = new URL(start.redirectUrl);
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect([...url.searchParams.keys()].sort()).toEqual(
      ['client_id', 'prompt', 'redirect_uri', 'scope', 'state'].sort(),
    );
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/auth/github/callback');
    expect(url.searchParams.get('scope')).toBe('gist');
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('state')).toBe(start.state);
    expect(start.state.length).toBeGreaterThan(0);
  });

  it('rejects when GitHub OAuth is not configured (empty client id or secret), before minting any state', async () => {
    const adapter = createSessionAdapter({ github: { clientId: '', clientSecret: '', redirectUri: 'http://localhost:3000/auth/github/callback' } });
    await expect(adapter.beginGitHubProofOAuth('did:abt:zOwner', 'did:abt:zAgent')).rejects.toThrow();
  });
});

describe('peekOAuthStatePurpose (FIX-B47b)', () => {
  it('reports sign-in for a state beginGitHubOAuth minted, without consuming it', async () => {
    const adapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'octo', id: 1 }) });
    const start = await adapter.beginGitHubOAuth();
    expect(adapter.peekOAuthStatePurpose(start.state)).toEqual({ kind: 'sign-in' });
    // Not consumed: the real completion still succeeds afterward.
    const session = await adapter.completeGitHubOAuth({ code: 'good-code', state: start.state });
    expect(session).not.toBeNull();
  });

  it('reports proof, with the bound account and agent DIDs, for a state beginGitHubProofOAuth minted, without consuming it', async () => {
    const adapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'octo', id: 1 }) });
    const start = await adapter.beginGitHubProofOAuth('did:abt:zOwner', 'did:abt:zAgent');
    expect(adapter.peekOAuthStatePurpose(start.state)).toEqual({
      kind: 'proof',
      accountDid: 'did:abt:zOwner',
      agentDid: 'did:abt:zAgent',
    });
    // Not consumed: the real proof completion still succeeds afterward.
    const completion = await adapter.completeGitHubProofOAuth({ code: 'good-code', state: start.state });
    expect(completion.kind).toBe('ok');
  });

  it('answers null for a state never issued', async () => {
    const adapter = createSessionAdapter({ github: fakeGitHubConfig() });
    expect(adapter.peekOAuthStatePurpose('never-issued')).toBeNull();
  });
});

describe('completeGitHubProofOAuth (FIX-B47b)', () => {
  it('exchanges a good proof state into { ok, accountDid, agentDid, login, token }', async () => {
    const adapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'octo-proof', id: 55 }),
    });
    const start = await adapter.beginGitHubProofOAuth('did:abt:zOwner', 'did:abt:zAgent');
    const completion = await adapter.completeGitHubProofOAuth({ code: 'good-code', state: start.state });
    expect(completion).toEqual({
      kind: 'ok',
      accountDid: 'did:abt:zOwner',
      agentDid: 'did:abt:zAgent',
      login: 'octo-proof',
      token: 'fake-access-token',
    });
  });

  it('is single-use: a second completion of the same state is invalid-state', async () => {
    const adapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'octo-proof', id: 56 }),
    });
    const start = await adapter.beginGitHubProofOAuth('did:abt:zOwner', 'did:abt:zAgent');
    const first = await adapter.completeGitHubProofOAuth({ code: 'good-code', state: start.state });
    expect(first.kind).toBe('ok');
    const replay = await adapter.completeGitHubProofOAuth({ code: 'good-code', state: start.state });
    expect(replay).toEqual({ kind: 'invalid-state' });
  });

  it('answers invalid-state for a state never issued, without throwing', async () => {
    const adapter = createSessionAdapter({ github: fakeGitHubConfig() });
    await expect(adapter.completeGitHubProofOAuth({ code: 'x', state: 'never-issued' })).resolves.toEqual({
      kind: 'invalid-state',
    });
  });

  it('answers invalid-state for an expired state', async () => {
    let now = new Date('2026-09-27T00:00:00Z').getTime();
    const adapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'octo-proof', id: 57 }),
      oauthStateTtlMs: 1000,
      now: () => now,
    });
    const start = await adapter.beginGitHubProofOAuth('did:abt:zOwner', 'did:abt:zAgent');
    now += 1001;
    await expect(adapter.completeGitHubProofOAuth({ code: 'good-code', state: start.state })).resolves.toEqual({
      kind: 'invalid-state',
    });
  });

  it('answers exchange-failed (never invalid-state) for a valid state whose provider exchange fails', async () => {
    const adapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: failingGitHubFetch() });
    const start = await adapter.beginGitHubProofOAuth('did:abt:zOwner', 'did:abt:zAgent');
    await expect(adapter.completeGitHubProofOAuth({ code: 'bad-code', state: start.state })).resolves.toEqual({
      kind: 'exchange-failed',
    });
  });

  // Decision 1, direction one: a SIGN-IN state can never complete a proof.
  it('refuses (invalid-state) when a sign-in state is presented to completeGitHubProofOAuth, and mints no result', async () => {
    const adapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'octo', id: 60 }) });
    const start = await adapter.beginGitHubOAuth();
    const completion = await adapter.completeGitHubProofOAuth({ code: 'good-code', state: start.state });
    expect(completion).toEqual({ kind: 'invalid-state' });
  });

  // Decision 1, direction two: a PROOF state can never mint a session.
  it('refuses (null) when a proof state is presented to completeGitHubOAuth, and mints no session', async () => {
    const adapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'octo', id: 61 }) });
    const start = await adapter.beginGitHubProofOAuth('did:abt:zOwner', 'did:abt:zAgent');
    const session = await adapter.completeGitHubOAuth({ code: 'good-code', state: start.state });
    expect(session).toBeNull();
    // The proof state survives the crossed-over attempt and still completes
    // through its own, correct method afterward.
    const completion = await adapter.completeGitHubProofOAuth({ code: 'good-code', state: start.state });
    expect(completion.kind).toBe('ok');
  });
});
