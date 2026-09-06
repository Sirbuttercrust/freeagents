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
}));

mock.createApp.mockImplementation(() => ({ listen: mock.listen }));

vi.mock('../../src/api/app.js', () => ({ createApp: mock.createApp }));
vi.mock('../../src/adapters/runtime/runtime.js', () => ({ resolveListenPort: mock.resolveListenPort }));
vi.mock('../../src/adapters/config/report.js', () => ({
  buildConfigReport: mock.buildConfigReport,
  formatConfigReport: mock.formatConfigReport,
  probeGithubTokenScope: mock.probeGithubTokenScope,
  formatGithubScopeLine: mock.formatGithubScopeLine,
}));

const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

// Side-effecting on import, like the real process boot: resolveListenPort()
// runs and its result is handed straight to app.listen().
await import('../../src/api/server.js');
// The scope probe is async (a real network call in production); give its
// microtask a turn to resolve before asserting on the second log line.
await new Promise((resolve) => setTimeout(resolve, 0));

describe('src/api/server.ts', () => {
  it('resolves the listen port through resolveListenPort and binds the app to it', () => {
    expect(mock.resolveListenPort).toHaveBeenCalledTimes(1);
    expect(mock.createApp).toHaveBeenCalledTimes(1);
    expect(mock.listen).toHaveBeenCalledWith(4242, expect.any(Function));
  });

  it('builds and logs the configuration report exactly once at startup', () => {
    expect(mock.buildConfigReport).toHaveBeenCalledTimes(1);
    expect(mock.formatConfigReport).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('configuration report:\n  database: configured');
  });

  it('probes the github token scope and logs the result line, additive to the report', () => {
    expect(mock.probeGithubTokenScope).toHaveBeenCalledTimes(1);
    expect(mock.formatGithubScopeLine).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('  githubTokenScope: has repo');
  });
});
