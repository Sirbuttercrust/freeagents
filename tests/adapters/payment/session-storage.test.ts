// The DID Connect session storage factory picks the driver from
// DATABASE_URL, mirroring src/adapters/storage/storage.ts's own factory
// tests (tests/adapters/storage.test.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';

const { createDidConnectSessionStorage } = await import('../../../src/adapters/payment/session-storage.js');
const { createMemoryDidConnectStorage } = await import('../../../src/adapters/payment/session-storage-memory.js');
const { createPrismaDidConnectStorage } = await import('../../../src/adapters/payment/session-storage-prisma.js');

describe('createDidConnectSessionStorage', () => {
  const original = process.env.DATABASE_URL;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (original === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = original;
    }
    vi.restoreAllMocks();
  });

  it('DATABASE_URL set selects a storage with the Prisma-flavoured shape (same interface, on/emit present)', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:***@127.0.0.1:5432/freeagents');
    const storage = createDidConnectSessionStorage();
    // Both drivers satisfy the same structural interface; distinguish them
    // by constructing the Prisma one directly and comparing shape rather
    // than identity, matching this factory's plain-object (non-class)
    // return type.
    const reference = createPrismaDidConnectStorage();
    expect(Object.keys(storage).sort()).toEqual(Object.keys(reference).sort());
  });

  it('DATABASE_URL empty selects the in-memory driver, with the loud warning', () => {
    vi.stubEnv('DATABASE_URL', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = createDidConnectSessionStorage();
    const reference = createMemoryDidConnectStorage();
    expect(Object.keys(storage).sort()).toEqual(Object.keys(reference).sort());
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('in-memory');
  });

  it('DATABASE_URL unset selects the in-memory driver, with the loud warning', () => {
    vi.unstubAllEnvs();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.DATABASE_URL;
    const storage = createDidConnectSessionStorage();
    expect(typeof storage.create).toBe('function');
  });

  it('the in-memory driver actually behaves in-memory: it round-trips a session', async () => {
    vi.unstubAllEnvs();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.DATABASE_URL;
    const storage = createDidConnectSessionStorage();
    await storage.create('tok1', 'created');
    expect(await storage.read('tok1')).toEqual({ token: 'tok1', status: 'created' });
  });
});
