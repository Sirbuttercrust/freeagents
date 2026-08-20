// The storage factory picks the driver from DATABASE_URL. Neither branch was
// previously tested: no test ever set or unset the variable, so a change that
// swapped the two drivers, or deleted the startup warning, would fail nothing.
import { afterEach, describe, expect, it, vi } from 'vitest';

// The factory reads process.env at call time, so each test sets the variable
// and restores it afterwards. No database is touched: constructing either
// repository opens nothing (the Prisma client is created on first query).
const { createOperatorRepository } = await import(
  '../../src/adapters/storage/storage.js'
);
const { MemoryOperatorRepository } = await import(
  '../../src/adapters/storage/memory.js'
);
const { PrismaOperatorRepository } = await import(
  '../../src/adapters/storage/prisma.js'
);

describe('createOperatorRepository', () => {
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

  it('DATABASE_URL set selects the Prisma driver', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@127.0.0.1:5432/freeagents');
    const repo = createOperatorRepository();
    expect(repo).toBeInstanceOf(PrismaOperatorRepository);
    // The two drivers are different classes; an instanceof on the wrong one
    // would pass on a common ancestor, so also assert the exact name.
    expect(repo.constructor.name).toBe('PrismaOperatorRepository');
  });

  it('DATABASE_URL empty selects the in-memory driver, with the loud warning', () => {
    // An empty string is what a misconfigured deployment most often has: the
    // variable exists but means nothing. The falsy check must treat it as unset.
    vi.stubEnv('DATABASE_URL', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const repo = createOperatorRepository();
    expect(repo).toBeInstanceOf(MemoryOperatorRepository);
    expect(repo.constructor.name).toBe('MemoryOperatorRepository');
    // The warning is the fail-loud half of the branch: a dev/test mode must
    // announce itself, so its absence is a regression this test catches.
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('in-memory');
  });

  it('DATABASE_URL unset selects the in-memory driver, with the loud warning', () => {
    // The genuinely-unset case (not an empty string): the factory must not
    // read a value that is not there.
    vi.unstubAllEnvs();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.DATABASE_URL;
    const repo = createOperatorRepository();
    expect(repo).toBeInstanceOf(MemoryOperatorRepository);
  });
});
