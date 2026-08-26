import { describe, expect, it } from 'vitest';
import { resolveListenPort } from '../../../src/adapters/runtime/runtime.js';

describe('resolveListenPort', () => {
  it('prefers BLOCKLET_PORT over PORT', () => {
    expect(resolveListenPort({ BLOCKLET_PORT: '8080', PORT: '3001' })).toBe(8080);
  });

  it('falls back to PORT when BLOCKLET_PORT is absent', () => {
    expect(resolveListenPort({ PORT: '3001' })).toBe(3001);
  });

  it('defaults to 3000 when neither is set', () => {
    expect(resolveListenPort({})).toBe(3000);
  });

  it('treats an empty BLOCKLET_PORT as absent, not zero', () => {
    expect(resolveListenPort({ BLOCKLET_PORT: '', PORT: '3001' })).toBe(3001);
  });

  it('treats an empty PORT as absent, not zero, and falls back to the default', () => {
    expect(resolveListenPort({ PORT: '' })).toBe(3000);
  });

  it('throws naming BLOCKLET_PORT when it is not a valid port', () => {
    expect(() => resolveListenPort({ BLOCKLET_PORT: 'not-a-port' })).toThrow(/BLOCKLET_PORT/);
  });

  it('throws naming PORT when it is out of range', () => {
    expect(() => resolveListenPort({ PORT: '70000' })).toThrow(/PORT/);
  });

  it('throws naming PORT when it is negative', () => {
    expect(() => resolveListenPort({ PORT: '-1' })).toThrow(/PORT/);
  });

  it('reads process.env when no env is passed', () => {
    // The default parameter is the production path: server.ts calls
    // resolveListenPort() bare. Exercise it so the default cannot silently
    // stop being process.env.
    const saved = { BLOCKLET_PORT: process.env['BLOCKLET_PORT'], PORT: process.env['PORT'] };
    try {
      process.env['BLOCKLET_PORT'] = '8123';
      delete process.env['PORT'];
      expect(resolveListenPort()).toBe(8123);
      delete process.env['BLOCKLET_PORT'];
      process.env['PORT'] = '3456';
      expect(resolveListenPort()).toBe(3456);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
