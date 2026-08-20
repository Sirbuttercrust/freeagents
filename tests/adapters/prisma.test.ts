// The Prisma driver is the only file that knows Postgres exists, and every
// branch in it was previously untested: no test could kill the create call,
// the P2002 mapping, the rethrow, or either findByDid projection.
//
// There is no database in the test environment, and the driver is built so a
// misconfigured deployment fails on the first query, not at boot. So the
// tests drive the driver's DECISIONS, not Postgres: the generated client
// module is stubbed, and the real PrismaClientKnownRequestError from the
// generated package is the error thrown back - the driver's instanceof and
// code checks run against the real class, only the network does not.
//
// If a real Postgres ever becomes available in CI, these tests still pin the
// branch behaviour; the stub is the seam, and it stays.
import { Prisma } from '../../src/generated/prisma/index.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  create: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock('../../src/generated/prisma/index.js', async () => {
  // The driver catches `err instanceof Prisma.PrismaClientKnownRequestError`.
  // Point it at the REAL class from the generated runtime, so the driver's
  // check is tested against the error type it will actually see in production.
  const actual = await vi.importActual<typeof import('../../src/generated/prisma/index.js')>(
    '../../src/generated/prisma/index.js',
  );
  return {
    PrismaClient: class {
      operator = mock;
    },
    Prisma: actual.Prisma,
  };
});

// Import after the mock is registered: the driver's module-level singleton
// then captures the stubbed client, and `db()` never opens a database.
const { PrismaOperatorRepository } = await import(
  '../../src/adapters/storage/prisma.js'
);
const { OperatorAlreadyExistsError } = await import(
  '../../src/adapters/storage/types.js'
);

function p2002(did: string): Error {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (${did})`,
    { code: 'P2002', clientVersion: '5.22.0' },
  );
}

function p1001(): Error {
  return new Prisma.PrismaClientKnownRequestError('cannot reach database', {
    code: 'P1001',
    clientVersion: '5.22.0',
  });
}

describe('PrismaOperatorRepository', () => {
  beforeAll(() => {
    vi.mocked(mock.create).mockReset();
    vi.mocked(mock.findUnique).mockReset();
  });

  afterEach(() => {
    vi.mocked(mock.create).mockReset();
    vi.mocked(mock.findUnique).mockReset();
  });

  it('register: a created row comes back as the operator projection, nothing more', async () => {
    const createdAt = new Date('2026-08-20T05:00:00.000Z');
    vi.mocked(mock.create).mockResolvedValue({
      did: 'did:abt:prisma-1',
      githubLogin: 'operator-prisma-1',
      createdAt,
    });

    const repo = new PrismaOperatorRepository();
    const row = await repo.register({
      did: 'did:abt:prisma-1',
      githubLogin: 'operator-prisma-1',
    });

    // The data sent to the database is exactly the supplied facts.
    expect(mock.create).toHaveBeenCalledWith({
      data: { did: 'did:abt:prisma-1', githubLogin: 'operator-prisma-1' },
    });
    // And the projection is exactly the three stored fields.
    expect(row).toEqual({
      did: 'did:abt:prisma-1',
      githubLogin: 'operator-prisma-1',
      createdAt,
    });
    expect(Object.keys(row).sort()).toEqual(['createdAt', 'did', 'githubLogin']);
  });

  it('register: a P2002 unique-constraint failure is the domain duplicate error', async () => {
    vi.mocked(mock.create).mockRejectedValue(p2002('did:abt:prisma-dup'));

    const repo = new PrismaOperatorRepository();
    const err = await repo
      .register({ did: 'did:abt:prisma-dup', githubLogin: 'operator-prisma-dup' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OperatorAlreadyExistsError);
    expect((err as Error).message).toContain('did:abt:prisma-dup');
    // The API maps this type to 409; a different error type would be a 503,
    // which is exactly what the missing branch would have produced.
    expect((err as Error).name).toBe('OperatorAlreadyExistsError');
  });

  it('register: a non-P2002 Prisma error is rethrown untouched', async () => {
    const original = p1001();
    vi.mocked(mock.create).mockRejectedValue(original);

    const repo = new PrismaOperatorRepository();
    const err = await repo
      .register({ did: 'did:abt:prisma-2', githubLogin: 'operator-prisma-2' })
      .catch((e: unknown) => e);

    // Same object: a dead database must not be rewritten into a duplicate,
    // and it must not be swallowed.
    expect(err).toBe(original);
    expect(err).not.toBeInstanceOf(OperatorAlreadyExistsError);
  });

  it('register: a non-Prisma error is rethrown untouched', async () => {
    const original = new Error('disk full');
    vi.mocked(mock.create).mockRejectedValue(original);

    const repo = new PrismaOperatorRepository();
    const err = await repo
      .register({ did: 'did:abt:prisma-3', githubLogin: 'operator-prisma-3' })
      .catch((e: unknown) => e);

    expect(err).toBe(original);
  });

  it('findByDid: a stored row comes back as the operator projection', async () => {
    const createdAt = new Date('2026-08-20T05:00:00.000Z');
    vi.mocked(mock.findUnique).mockResolvedValue({
      did: 'did:abt:prisma-1',
      githubLogin: 'operator-prisma-1',
      createdAt,
    });

    const repo = new PrismaOperatorRepository();
    const row = await repo.findByDid('did:abt:prisma-1');

    expect(mock.findUnique).toHaveBeenCalledWith({ where: { did: 'did:abt:prisma-1' } });
    expect(row).toEqual({
      did: 'did:abt:prisma-1',
      githubLogin: 'operator-prisma-1',
      createdAt,
    });
  });

  it('findByDid: no stored row comes back as null, not an empty operator', async () => {
    vi.mocked(mock.findUnique).mockResolvedValue(null);

    const repo = new PrismaOperatorRepository();
    const row = await repo.findByDid('did:abt:prisma-none');

    expect(mock.findUnique).toHaveBeenCalledWith({ where: { did: 'did:abt:prisma-none' } });
    expect(row).toBeNull();
  });
});
