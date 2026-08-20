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
  agentCreate: vi.fn(),
  agentFindUnique: vi.fn(),
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
      agent = { create: mock.agentCreate, findUnique: mock.agentFindUnique };
    },
    Prisma: actual.Prisma,
  };
});

// Import after the mock is registered: the driver's module-level singleton
// then captures the stubbed client, and `db()` never opens a database.
const { PrismaAgentRepository, PrismaOperatorRepository } = await import(
  '../../src/adapters/storage/prisma.js'
);
const { AgentAlreadyExistsError, OperatorAlreadyExistsError } = await import(
  '../../src/adapters/storage/types.js'
);

// The delegation the driver stores is the full W3C credential (R-2); these
// tests drive the driver's decisions, not the cryptography, so a shaped
// fixture stands in for the bytes a real wallet signed.
const delegationFixture = {
  '@context': [
    'https://www.w3.org/2018/credentials/v1',
    'https://w3id.org/security/suites/ed25519-2020/v1',
    { '@vocab': 'https://freeagents.dev/terms#' },
  ],
  id: 'urn:uuid:test-credential-id',
  type: ['VerifiableCredential', 'AgentDelegation'],
  issuer: 'did:abt:zOperatorKeyHash',
  credentialSubject: { id: 'did:abt:zAgentKeyHash', delegatedBy: 'did:abt:zOperatorKeyHash' },
  proof: {
    type: 'Ed25519Signature2020',
    created: '2026-08-20T05:00:00.000Z',
    verificationMethod: 'did:abt:zOperatorKeyHash#zOperatorKeyHash',
    proofPurpose: 'assertionMethod',
    proofValue: 'zMockProofValue',
  },
  issuanceDate: '2026-08-20T05:00:00.000Z',
};

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

describe('PrismaAgentRepository', () => {
  beforeAll(() => {
    vi.mocked(mock.agentCreate).mockReset();
    vi.mocked(mock.agentFindUnique).mockReset();
  });

  afterEach(() => {
    vi.mocked(mock.agentCreate).mockReset();
    vi.mocked(mock.agentFindUnique).mockReset();
  });

  it('create: the stored row comes back as the agent projection, delegation verbatim', async () => {
    const createdAt = new Date('2026-08-20T05:00:00.000Z');
    vi.mocked(mock.agentCreate).mockResolvedValue({
      did: 'did:abt:agent-1',
      operatorDid: 'did:abt:op-1',
      delegation: delegationFixture,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
      proofStatus: 'unverified',
      createdAt,
    });

    const repo = new PrismaAgentRepository();
    const row = await repo.create({
      did: 'did:abt:agent-1',
      operatorDid: 'did:abt:op-1',
      delegation: delegationFixture,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });

    // The data sent to the database carries the full credential, not a
    // projection of it: projecting would drop the fields the signature
    // covers and the stored copy would stop verifying off-platform.
    expect(mock.agentCreate).toHaveBeenCalledWith({
      data: {
        did: 'did:abt:agent-1',
        operatorDid: 'did:abt:op-1',
        delegation: delegationFixture,
        name: 'scout',
        skills: ['triage'],
        githubLogin: null,
      },
    });
    expect(row).toEqual({
      did: 'did:abt:agent-1',
      operatorDid: 'did:abt:op-1',
      delegation: delegationFixture,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
      proofStatus: 'unverified',
      createdAt,
    });
  });

  it('create: a P2002 unique-constraint failure is the domain duplicate error', async () => {
    vi.mocked(mock.agentCreate).mockRejectedValue(p2002('did:abt:agent-dup'));

    const repo = new PrismaAgentRepository();
    const err = await repo
      .create({
        did: 'did:abt:agent-dup',
        operatorDid: 'did:abt:op-1',
        delegation: delegationFixture,
        name: 'scout',
        skills: ['triage'],
        githubLogin: null,
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AgentAlreadyExistsError);
    expect((err as Error).message).toContain('did:abt:agent-dup');
    expect((err as Error).name).toBe('AgentAlreadyExistsError');
  });

  it('create: a non-P2002 Prisma error is rethrown untouched', async () => {
    const original = p1001();
    vi.mocked(mock.agentCreate).mockRejectedValue(original);

    const repo = new PrismaAgentRepository();
    const err = await repo
      .create({
        did: 'did:abt:agent-2',
        operatorDid: 'did:abt:op-1',
        delegation: delegationFixture,
        name: 'scout',
        skills: ['triage'],
        githubLogin: null,
      })
      .catch((e: unknown) => e);

    expect(err).toBe(original);
    expect(err).not.toBeInstanceOf(AgentAlreadyExistsError);
  });

  it('create: a non-Prisma error is rethrown untouched', async () => {
    const original = new Error('disk full');
    vi.mocked(mock.agentCreate).mockRejectedValue(original);

    const repo = new PrismaAgentRepository();
    const err = await repo
      .create({
        did: 'did:abt:agent-3',
        operatorDid: 'did:abt:op-1',
        delegation: delegationFixture,
        name: 'scout',
        skills: ['triage'],
        githubLogin: null,
      })
      .catch((e: unknown) => e);

    expect(err).toBe(original);
  });

  it('findByDid: a stored row comes back as the agent projection', async () => {
    const createdAt = new Date('2026-08-20T05:00:00.000Z');
    vi.mocked(mock.agentFindUnique).mockResolvedValue({
      did: 'did:abt:agent-1',
      operatorDid: 'did:abt:op-1',
      delegation: delegationFixture,
      name: 'scout',
      skills: ['triage'],
      githubLogin: 'agent-login-1',
      proofStatus: 'verified',
      createdAt,
    });

    const repo = new PrismaAgentRepository();
    const row = await repo.findByDid('did:abt:agent-1');

    expect(mock.agentFindUnique).toHaveBeenCalledWith({ where: { did: 'did:abt:agent-1' } });
    expect(row).toEqual({
      did: 'did:abt:agent-1',
      operatorDid: 'did:abt:op-1',
      delegation: delegationFixture,
      name: 'scout',
      skills: ['triage'],
      githubLogin: 'agent-login-1',
      proofStatus: 'verified',
      createdAt,
    });
  });

  it('findByDid: no stored row comes back as null, not an empty agent', async () => {
    vi.mocked(mock.agentFindUnique).mockResolvedValue(null);

    const repo = new PrismaAgentRepository();
    const row = await repo.findByDid('did:abt:agent-none');

    expect(mock.agentFindUnique).toHaveBeenCalledWith({ where: { did: 'did:abt:agent-none' } });
    expect(row).toBeNull();
  });
});
