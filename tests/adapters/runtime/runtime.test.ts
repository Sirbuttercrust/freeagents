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

  it('throws naming BLOCKLET_PORT when it is not a valid port', () => {
    expect(() => resolveListenPort({ BLOCKLET_PORT: 'not-a-port' })).toThrow(/BLOCKLET_PORT/);
  });

  it('throws naming PORT when it is out of range', () => {
    expect(() => resolveListenPort({ PORT: '70000' })).toThrow(/PORT/);
  });
});
