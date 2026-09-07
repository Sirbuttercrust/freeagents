// S5+S6: the signature-spend storage factory picks the driver from
// DATABASE_URL, mirroring src/adapters/payment/session-storage.ts's own
// factory tests (tests/adapters/payment/session-storage.test.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';

const { createSignatureSpendStorage } = await import('../../../src/adapters/identity/signature-spend-storage.js');
const { createMemorySignatureSpendStorage } = await import(
  '../../../src/adapters/identity/signature-spend-storage-memory.js'
);
const { createPrismaSignatureSpendStorage } = await import(
  '../../../src/adapters/identity/signature-spend-storage-prisma.js'
);

describe('createSignatureSpendStorage', () => {
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

  it('DATABASE_URL set selects a storage with the Prisma-flavoured shape (same interface)', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:***@127.0.0.1:5432/freeagents');
    const storage = createSignatureSpendStorage();
    const reference = createPrismaSignatureSpendStorage();
    expect(Object.keys(storage).sort()).toEqual(Object.keys(reference).sort());
  });

  it('DATABASE_URL empty selects the in-memory driver, with the loud warning', () => {
    vi.stubEnv('DATABASE_URL', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = createSignatureSpendStorage();
    const reference = createMemorySignatureSpendStorage();
    expect(Object.keys(storage).sort()).toEqual(Object.keys(reference).sort());
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('in-memory');
  });

  it('DATABASE_URL unset selects the in-memory driver, and it actually behaves in-memory', async () => {
    vi.unstubAllEnvs();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.DATABASE_URL;
    const storage = createSignatureSpendStorage();
    await storage.record({ keyid: 'keyid-1', signatureHash: 'hash-1', created: 1700000000 });
    expect(await storage.findByKeyidAndHash('keyid-1', 'hash-1')).toEqual({
      keyid: 'keyid-1',
      signatureHash: 'hash-1',
      created: 1700000000,
    });
  });
});
