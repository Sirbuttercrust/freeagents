// src/api/server.ts is the blocklet entry point: it must resolve the listen
// port through resolveListenPort() and hand the result to app.listen(), so
// that BLOCKLET_PORT support (wired in runtime.ts, tested on its own in
// runtime.test.ts) actually reaches the running process. Previously nothing
// asserted the wiring itself: reverting to
// `Number(process.env['PORT'] ?? 3000)` here would drop BLOCKLET_PORT support
// and fail nothing.
//
// P9: it must also print the configuration report exactly once at startup
// (scope item 1), additive to the listen wiring above, never replacing it.
//
// B14a: and the github token scope line, from the one live network probe
// this process makes at boot (a GET /user, read only for its
// x-oauth-scopes header -- report.ts's own header comment). A probe
// failure (network down, DNS) must never block startup the way every
// other capability here already refuses to: caught and logged as its own
// line, not thrown.
//
// ISS1 (bugs.md B30, review round 1): the configuration report now
// carries the derived issuer DID on its credentials line, read from
// ONE credentials adapter this file builds itself and hands into
// createApp -- never a second, independent call to platformIssuerFromEnv.
// That is what this file's own mocks below now prove: createCredentialsAdapter
// and createCredentialRepository are each called exactly once, the SAME
// adapter instance's describeIssuer() feeds the report line, and that
// same instance (plus the same repository) is the sixth and eighth
// argument createApp receives -- so a test double standing in for
// "the app" cannot hide two separate derivations the way mocking
// platformIssuerFromEnv directly used to.
import { describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  listen: vi.fn((_port: number, cb?: () => void) => {
    cb?.();
  }),
  createApp: vi.fn(),
  resolveListenPort: vi.fn(() => 4242),
  buildConfigReport: vi.fn(() => ({ capabilities: [] })),
  formatConfigReport: vi.fn(() => 'configuration report:\n  database: configured'),
  probeGithubTokenScope: vi.fn(async () => ({ requiredScope: 'repo', scopesHeader: 'repo', hasRequiredScope: true })),
  formatGithubScopeLine: vi.fn(() => '  githubTokenScope: has repo'),
  describeIssuer: vi.fn(async () => ({
    issuer: 'did:abt:zServerTestDerivedDid',
    verificationMethod: 'did:abt:zServerTestDerivedDid#zKey',
    publicKeyMultibase: 'zKey',
  })),
  credentialRepoSentinel: { __brand: 'credentialRepoSentinel' },
}));

const credentialsAdapterSentinel = { describeIssuer: mock.describeIssuer, __brand: 'credentialsAdapterSentinel' };
const createCredentialsAdapter = vi.fn(() => credentialsAdapterSentinel);
const createCredentialRepository = vi.fn(() => mock.credentialRepoSentinel);

mock.createApp.mockImplementation(() => ({ listen: mock.listen }));

vi.mock('../../src/api/app.js', () => ({ createApp: mock.createApp }));
vi.mock('../../src/adapters/runtime/runtime.js', () => ({ resolveListenPort: mock.resolveListenPort }));
vi.mock('../../src/adapters/config/report.js', () => ({
  buildConfigReport: mock.buildConfigReport,
  formatConfigReport: mock.formatConfigReport,
  probeGithubTokenScope: mock.probeGithubTokenScope,
  formatGithubScopeLine: mock.formatGithubScopeLine,
}));
vi.mock('../../src/adapters/credentials/credentials.js', () => ({
  createCredentialsAdapter,
}));
vi.mock('../../src/adapters/storage/storage.js', () => ({
  createCredentialRepository,
}));

const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

// Side-effecting on import, like the real process boot: resolveListenPort()
// runs and its result is handed straight to app.listen().
await import('../../src/api/server.js');
// The scope probe and the issuer derivation are both async (a real network
// call and a real key derivation in production); give their microtasks a
// turn to resolve before asserting on their log lines.
await new Promise((resolve) => setTimeout(resolve, 0));

describe('src/api/server.ts', () => {
  it('resolves the listen port through resolveListenPort and binds the app to it', () => {
    expect(mock.resolveListenPort).toHaveBeenCalledTimes(1);
    expect(mock.createApp).toHaveBeenCalledTimes(1);
    expect(mock.listen).toHaveBeenCalledWith(4242, expect.any(Function));
  });

  it('builds exactly one credentials adapter over exactly one credential repository', () => {
    expect(createCredentialRepository).toHaveBeenCalledTimes(1);
    expect(createCredentialsAdapter).toHaveBeenCalledTimes(1);
    expect(createCredentialsAdapter).toHaveBeenCalledWith(undefined, mock.credentialRepoSentinel);
  });

  it('hands that SAME credentials adapter and repository into createApp, never a second construction', () => {
    expect(mock.createApp).toHaveBeenCalledWith(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      credentialsAdapterSentinel,
      undefined,
      mock.credentialRepoSentinel,
    );
  });

  it('builds and logs the configuration report exactly once at startup, carrying the SAME adapter\'s derived issuer DID', () => {
    expect(mock.describeIssuer).toHaveBeenCalledTimes(1);
    expect(mock.buildConfigReport).toHaveBeenCalledTimes(1);
    expect(mock.formatConfigReport).toHaveBeenCalledTimes(1);
    expect(mock.formatConfigReport).toHaveBeenCalledWith(expect.anything(), 'did:abt:zServerTestDerivedDid');
    expect(logSpy).toHaveBeenCalledWith('configuration report:\n  database: configured');
  });

  it('probes the github token scope and logs the result line, additive to the report', () => {
    expect(mock.probeGithubTokenScope).toHaveBeenCalledTimes(1);
    expect(mock.formatGithubScopeLine).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('  githubTokenScope: has repo');
  });
});
