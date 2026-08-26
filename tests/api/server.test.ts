// src/api/server.ts is the blocklet entry point: it must resolve the listen
// port through resolveListenPort() and hand the result to app.listen(), so
// that BLOCKLET_PORT support (wired in runtime.ts, tested on its own in
// runtime.test.ts) actually reaches the running process. Previously nothing
// asserted the wiring itself: reverting to
// `Number(process.env['PORT'] ?? 3000)` here would drop BLOCKLET_PORT support
// and fail nothing.
import { describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  listen: vi.fn((_port: number, cb?: () => void) => {
    cb?.();
  }),
  createApp: vi.fn(),
  resolveListenPort: vi.fn(() => 4242),
}));

mock.createApp.mockImplementation(() => ({ listen: mock.listen }));

vi.mock('../../src/api/app.js', () => ({ createApp: mock.createApp }));
vi.mock('../../src/adapters/runtime/runtime.js', () => ({ resolveListenPort: mock.resolveListenPort }));

// Side-effecting on import, like the real process boot: resolveListenPort()
// runs and its result is handed straight to app.listen().
await import('../../src/api/server.js');

describe('src/api/server.ts', () => {
  it('resolves the listen port through resolveListenPort and binds the app to it', () => {
    expect(mock.resolveListenPort).toHaveBeenCalledTimes(1);
    expect(mock.createApp).toHaveBeenCalledTimes(1);
    expect(mock.listen).toHaveBeenCalledWith(4242, expect.any(Function));
  });
});
