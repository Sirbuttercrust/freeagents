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
import type { Job } from '../../src/domain/job.js';
import { Prisma } from '../../src/generated/prisma/index.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  create: vi.fn(),
  findUnique: vi.fn(),
  agentCreate: vi.fn(),
  agentFindUnique: vi.fn(),
  agentUpdate: vi.fn(),
  jobCreate: vi.fn(),
  jobFindUnique: vi.fn(),
  jobUpdate: vi.fn(),
  keyRotationCreate: vi.fn(),
  keyRotationFindMany: vi.fn(),
  credentialCreate: vi.fn(),
  credentialFindUnique: vi.fn(),
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
      agent = { create: mock.agentCreate, findUnique: mock.agentFindUnique, update: mock.agentUpdate };
      job = { create: mock.jobCreate, findUnique: mock.jobFindUnique, update: mock.jobUpdate };
      keyRotation = { create: mock.keyRotationCreate, findMany: mock.keyRotationFindMany };
      credential = { create: mock.credentialCreate, findUnique: mock.credentialFindUnique };
    },
    Prisma: actual.Prisma,
  };
});

// Import after the mock is registered: the driver's module-level singleton
// then captures the stubbed client, and `db()` never opens a database.
const {
  PrismaAgentRepository,
  PrismaCredentialRepository,
  PrismaJobRepository,
  PrismaOperatorRepository,
} = await import('../../src/adapters/storage/prisma.js');
const {
  AgentAlreadyExistsError,
  CredentialAlreadyIssuedError,
  JobAlreadyExistsError,
  OperatorAlreadyExistsError,
} = await import('../../src/adapters/storage/types.js');

// The same input/output pair tests/adapters/storage.test.ts pins the memory
// driver to: if the two fixtures drift, both tests must be changed together.
const jobFixture = {
  id: 'job_1',
  buyerDid: 'did:example:buyer',
  agentDid: 'did:example:agent',
  repository: 'buyer/target-repo',
  brief: 'Fix the login bug on the checkout page',
  briefHash: 'sha256:brief',
  confirmedSpecHash: null,
  status: 'draft',
  criteria: [] as Array<{ text: string; proposedBy: 'agent' | 'buyer'; accepted: boolean }>,
  pullRequestUrl: null,
  mergeCommit: null,
  mergedAt: null,
  confirmedAt: null,
  submittedAt: null,
  deadline: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
} satisfies Job;

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

function p2025(did: string): Error {
  return new Prisma.PrismaClientKnownRequestError(
    `An error occurred while updating the row with id: ${did}`,
    { code: 'P2025', clientVersion: '5.22.0' },
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
    vi.mocked(mock.agentUpdate).mockReset();
    vi.mocked(mock.keyRotationCreate).mockReset();
    vi.mocked(mock.keyRotationFindMany).mockReset();
    // Every read path now goes through agentWithRotations, which always
    // fetches the rotation rows; an agent with no rotations gets none.
    vi.mocked(mock.keyRotationFindMany).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.mocked(mock.agentCreate).mockReset();
    vi.mocked(mock.agentFindUnique).mockReset();
    vi.mocked(mock.agentUpdate).mockReset();
    vi.mocked(mock.keyRotationCreate).mockReset();
    vi.mocked(mock.keyRotationFindMany).mockReset();
    vi.mocked(mock.keyRotationFindMany).mockResolvedValue([]);
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
      keyRotations: [],
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
      keyRotations: [],
    });
  });

  it('findByDid: no stored row comes back as null, not an empty agent', async () => {
    vi.mocked(mock.agentFindUnique).mockResolvedValue(null);

    const repo = new PrismaAgentRepository();
    const row = await repo.findByDid('did:abt:agent-none');

    expect(mock.agentFindUnique).toHaveBeenCalledWith({ where: { did: 'did:abt:agent-none' } });
    expect(row).toBeNull();
  });

  it('updateGithubBinding: an updated row comes back as the agent projection', async () => {
    const createdAt = new Date('2026-08-20T05:00:00.000Z');
    const updatedRow = {
      did: 'did:abt:agent-1',
      operatorDid: 'did:abt:op-1',
      delegation: delegationFixture,
      name: 'scout',
      skills: ['triage'],
      githubLogin: 'scout-agent',
      proofStatus: 'pending',
      createdAt,
    };
    vi.mocked(mock.agentUpdate).mockResolvedValue(updatedRow);
    // The update row does not carry rotations, so the driver re-fetches the
    // agent through the same read path as every other lookup.
    vi.mocked(mock.agentFindUnique).mockResolvedValue(updatedRow);

    const repo = new PrismaAgentRepository();
    const row = await repo.updateGithubBinding('did:abt:agent-1', {
      handle: 'scout-agent',
      status: 'pending',
    });

    expect(mock.agentUpdate).toHaveBeenCalledWith({
      where: { did: 'did:abt:agent-1' },
      data: { githubLogin: 'scout-agent', proofStatus: 'pending' },
    });
    expect(row).toEqual({ ...updatedRow, keyRotations: [] });
  });

  it('updateGithubBinding: a P2025 not-found comes back as null, not an error', async () => {
    vi.mocked(mock.agentUpdate).mockRejectedValue(p2025('did:abt:agent-none'));

    const repo = new PrismaAgentRepository();
    const row = await repo.updateGithubBinding('did:abt:agent-none', {
      handle: 'scout-agent',
      status: 'pending',
    });

    expect(row).toBeNull();
  });

  it('updateGithubBinding: a non-P2025 Prisma error is rethrown untouched', async () => {
    const original = p1001();
    vi.mocked(mock.agentUpdate).mockRejectedValue(original);

    const repo = new PrismaAgentRepository();
    const err = await repo
      .updateGithubBinding('did:abt:agent-2', { handle: 'scout-agent', status: 'pending' })
      .catch((e: unknown) => e);

    expect(err).toBe(original);
  });

  it('updateGithubBinding: a non-Prisma error is rethrown untouched', async () => {
    const original = new Error('disk full');
    vi.mocked(mock.agentUpdate).mockRejectedValue(original);

    const repo = new PrismaAgentRepository();
    const err = await repo
      .updateGithubBinding('did:abt:agent-3', { handle: 'scout-agent', status: 'pending' })
      .catch((e: unknown) => e);

    expect(err).toBe(original);
  });

  it('findByDid: rotation rows are projected in the order the database returns them', async () => {
    const createdAt = new Date('2026-08-20T05:00:00.000Z');
    const first = new Date('2026-08-21T01:00:00.000Z');
    const second = new Date('2026-08-21T02:00:00.000Z');
    vi.mocked(mock.agentFindUnique).mockResolvedValue({
      did: 'did:abt:agent-rot',
      operatorDid: 'did:abt:op-1',
      delegation: delegationFixture,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
      proofStatus: 'unverified',
      createdAt,
    });
    vi.mocked(mock.keyRotationFindMany).mockResolvedValue([
      {
        id: 'kr-1',
        agentDid: 'did:abt:agent-rot',
        fromKey: 'did:abt:zOldKey#zOldFingerprint',
        toKey: 'did:abt:zNewKey#zNewFingerprint',
        rotatedAt: first,
      },
      {
        id: 'kr-2',
        agentDid: 'did:abt:agent-rot',
        fromKey: 'did:abt:zNewKey#zNewFingerprint',
        toKey: 'did:abt:zNewerKey#zNewerFingerprint',
        rotatedAt: second,
      },
    ]);

    const repo = new PrismaAgentRepository();
    const row = await repo.findByDid('did:abt:agent-rot');

    expect(mock.keyRotationFindMany).toHaveBeenCalledWith({
      where: { agentDid: 'did:abt:agent-rot' },
      orderBy: { rotatedAt: 'asc' },
    });
    expect(row?.keyRotations).toEqual([
      { fromKey: 'did:abt:zOldKey#zOldFingerprint', toKey: 'did:abt:zNewKey#zNewFingerprint', rotatedAt: first },
      { fromKey: 'did:abt:zNewKey#zNewFingerprint', toKey: 'did:abt:zNewerKey#zNewerFingerprint', rotatedAt: second },
    ]);
  });

  it('recordKeyRotation: an agent that was never stored comes back as null, and no rotation row is written', async () => {
    vi.mocked(mock.agentFindUnique).mockResolvedValue(null);

    const repo = new PrismaAgentRepository();
    const row = await repo.recordKeyRotation('did:abt:agent-none', {
      fromKey: 'did:abt:zOldKey#zOldFingerprint',
      toKey: 'did:abt:zNewKey#zNewFingerprint',
    });

    expect(row).toBeNull();
    expect(mock.keyRotationCreate).not.toHaveBeenCalled();
  });

  it('recordKeyRotation: appends a row with a driver-stamped date, and the row comes back on the returned agent', async () => {
    const createdAt = new Date('2026-08-20T05:00:00.000Z');
    const rotatedAt = new Date('2026-08-21T01:00:00.000Z');
    const newRow = {
      id: 'kr-1',
      agentDid: 'did:abt:agent-1',
      fromKey: 'did:abt:zOldKey#zOldFingerprint',
      toKey: 'did:abt:zNewKey#zNewFingerprint',
      rotatedAt,
    };
    vi.mocked(mock.agentFindUnique).mockResolvedValue({
      did: 'did:abt:agent-1',
      operatorDid: 'did:abt:op-1',
      delegation: delegationFixture,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
      proofStatus: 'unverified',
      createdAt,
    });
    vi.mocked(mock.keyRotationCreate).mockResolvedValue(newRow);
    vi.mocked(mock.keyRotationFindMany).mockResolvedValue([newRow]);

    const repo = new PrismaAgentRepository();
    const row = await repo.recordKeyRotation('did:abt:agent-1', {
      fromKey: 'did:abt:zOldKey#zOldFingerprint',
      toKey: 'did:abt:zNewKey#zNewFingerprint',
    });

    // The row sent to the database carries the public identifiers and a
    // driver-stamped date. A driver that silently drops the history (the
    // rejected R-6 branch) would return keyRotations: [] here, which the
    // projection assertion below catches.
    expect(mock.keyRotationCreate).toHaveBeenCalledWith({
      data: {
        agentDid: 'did:abt:agent-1',
        fromKey: 'did:abt:zOldKey#zOldFingerprint',
        toKey: 'did:abt:zNewKey#zNewFingerprint',
        rotatedAt: expect.any(Date),
      },
    });
    expect(row?.keyRotations).toEqual([
      { fromKey: 'did:abt:zOldKey#zOldFingerprint', toKey: 'did:abt:zNewKey#zNewFingerprint', rotatedAt },
    ]);
  });
});

describe('PrismaJobRepository', () => {
  beforeAll(() => {
    vi.mocked(mock.jobCreate).mockReset();
    vi.mocked(mock.jobFindUnique).mockReset();
    vi.mocked(mock.jobUpdate).mockReset();
  });

  afterEach(() => {
    vi.mocked(mock.jobCreate).mockReset();
    vi.mocked(mock.jobFindUnique).mockReset();
    vi.mocked(mock.jobUpdate).mockReset();
  });

  it('create: sends every stored field, including the brief, and projects it back', async () => {
    vi.mocked(mock.jobCreate).mockResolvedValue({ ...jobFixture });

    const repo = new PrismaJobRepository();
    const row = await repo.create(jobFixture);

    // Every domain field crosses the wire: the brief in particular is the
    // field this issue exists to keep (R-27), and a projection that dropped
    // it would make the round-trip below fail.
    expect(mock.jobCreate).toHaveBeenCalledWith({ data: { ...jobFixture } });
    expect(row).toEqual(jobFixture);
    expect(Object.keys(row).sort()).toEqual(
      [
        'agentDid',
        'brief',
        'briefHash',
        'buyerDid',
        'confirmedAt',
        'confirmedSpecHash',
        'createdAt',
        'criteria',
        'id',
        'mergeCommit',
        'mergedAt',
        'pullRequestUrl',
        'repository',
        'status',
        'submittedAt',
        'deadline',
      ].sort(),
    );
  });

  it('create: a P2002 unique-constraint failure is the domain duplicate error', async () => {
    vi.mocked(mock.jobCreate).mockRejectedValue(p2002('job_dup'));

    const repo = new PrismaJobRepository();
    const err = await repo.create(jobFixture).catch((e: unknown) => e);

    // The domain error names the id of the job the caller tried to store,
    // not the Prisma message: the API maps the type, humans read the id.
    expect(err).toBeInstanceOf(JobAlreadyExistsError);
    expect((err as Error).message).toContain(jobFixture.id);
    expect((err as Error).name).toBe('JobAlreadyExistsError');
  });

  it('create: a non-P2002 Prisma error is rethrown untouched', async () => {
    const original = p1001();
    vi.mocked(mock.jobCreate).mockRejectedValue(original);

    const repo = new PrismaJobRepository();
    const err = await repo.create(jobFixture).catch((e: unknown) => e);

    // Same object: a dead database must not be rewritten into a duplicate,
    // and it must not be swallowed.
    expect(err).toBe(original);
    expect(err).not.toBeInstanceOf(JobAlreadyExistsError);
  });

  it('create: a non-Prisma error is rethrown untouched', async () => {
    const original = new Error('disk full');
    vi.mocked(mock.jobCreate).mockRejectedValue(original);

    const repo = new PrismaJobRepository();
    const err = await repo.create(jobFixture).catch((e: unknown) => e);

    expect(err).toBe(original);
  });

  it('update: sends every field except the id and projects the row back', async () => {
    const updated = { ...jobFixture, status: 'proposed' as const };
    vi.mocked(mock.jobUpdate).mockResolvedValue({ ...updated });

    const repo = new PrismaJobRepository();
    const row = await repo.update(updated);

    expect(mock.jobUpdate).toHaveBeenCalledWith({
      where: { id: 'job_1' },
      data: {
        buyerDid: updated.buyerDid,
        agentDid: updated.agentDid,
        repository: updated.repository,
        brief: updated.brief,
        briefHash: updated.briefHash,
        confirmedSpecHash: updated.confirmedSpecHash,
        criteria: updated.criteria,
        status: updated.status,
        pullRequestUrl: updated.pullRequestUrl,
        confirmedAt: updated.confirmedAt,
        submittedAt: updated.submittedAt,
        deadline: updated.deadline,
        createdAt: updated.createdAt,
      },
    });
    expect(row).toEqual(updated);
  });

  it('update: a P2025 not-found comes back as null, not an error', async () => {
    vi.mocked(mock.jobUpdate).mockRejectedValue(p2025('job_missing'));

    const repo = new PrismaJobRepository();
    const row = await repo.update(jobFixture);

    expect(row).toBeNull();
  });

  it('update: a non-P2025 Prisma error is rethrown untouched', async () => {
    const original = p1001();
    vi.mocked(mock.jobUpdate).mockRejectedValue(original);

    const repo = new PrismaJobRepository();
    const err = await repo.update(jobFixture).catch((e: unknown) => e);

    expect(err).toBe(original);
  });

  it('update: a non-Prisma error is rethrown untouched', async () => {
    const original = new Error('disk full');
    vi.mocked(mock.jobUpdate).mockRejectedValue(original);

    const repo = new PrismaJobRepository();
    const err = await repo.update(jobFixture).catch((e: unknown) => e);

    expect(err).toBe(original);
  });

  it('findById: a stored row comes back as the full projection, brief included', async () => {
    vi.mocked(mock.jobFindUnique).mockResolvedValue({ ...jobFixture });

    const repo = new PrismaJobRepository();
    const row = await repo.findById('job_1');

    expect(mock.jobFindUnique).toHaveBeenCalledWith({ where: { id: 'job_1' } });
    expect(row).toEqual(jobFixture);
  });

  it("findById: a row with no criteria on it reads back with criteria as an empty array, never undefined or null", async () => {
    // A row written before the column existed, or a null Json cell: the
    // projection must normalise both to [] so callers can iterate criteria
    // without a guard.
    vi.mocked(mock.jobFindUnique).mockResolvedValue({
      ...jobFixture,
      criteria: null,
    } as unknown as typeof jobFixture);

    const repo = new PrismaJobRepository();
    const row = await repo.findById('job_1');

    expect(row).toEqual(jobFixture);
    expect(Array.isArray(row?.criteria)).toBe(true);
  });

  it('findById: a row whose criteria hold real entries reads them back verbatim, not flattened to []', async () => {
    // The Array.isArray TRUE arm of the toJob criteria mapping. Deleting that
    // arm (returning [] unconditionally) passes the null-normalisation test
    // above while silently discarding every stored criterion; this test is
    // the one that fails if it does.
    const stored = [
      { text: 'parses a well-formed brief', proposedBy: 'agent' as const, accepted: true },
      { text: 'rejects an empty repository', proposedBy: 'buyer' as const, accepted: false },
    ];
    vi.mocked(mock.jobFindUnique).mockResolvedValue({
      ...jobFixture,
      criteria: stored,
    } as unknown as typeof jobFixture);

    const repo = new PrismaJobRepository();
    const row = await repo.findById('job_1');

    expect(row?.criteria).toEqual(stored);
  });

  // R-12: the driver filters no enum values - an outcome row projects back
  // unchanged, deadline included.
  it('findById: a closed_unmerged outcome row reads back unchanged', async () => {
    const stored = {
      ...jobFixture,
      status: 'closed_unmerged' as const,
      pullRequestUrl: 'https://github.com/buyer/target-repo/pull/1',
      submittedAt: new Date('2026-01-02T00:00:00Z'),
      deadline: new Date('2026-02-01T00:00:00Z'),
    } satisfies Job;
    vi.mocked(mock.jobFindUnique).mockResolvedValue({ ...stored });

    const repo = new PrismaJobRepository();
    const row = await repo.findById('job_1');

    expect(row).toEqual(stored);
    expect(row?.status).toBe('closed_unmerged');
    expect(row?.deadline).toEqual(new Date('2026-02-01T00:00:00Z'));
  });

  it('findById: a stale outcome row reads back unchanged', async () => {
    const stored = {
      ...jobFixture,
      status: 'stale' as const,
      pullRequestUrl: 'https://github.com/buyer/target-repo/pull/1',
      submittedAt: new Date('2026-01-02T00:00:00Z'),
      deadline: new Date('2026-02-01T00:00:00Z'),
    } satisfies Job;
    vi.mocked(mock.jobFindUnique).mockResolvedValue({ ...stored });

    const repo = new PrismaJobRepository();
    const row = await repo.findById('job_1');

    expect(row).toEqual(stored);
    expect(row?.status).toBe('stale');
  });

  it('findById: no stored row comes back as null, not an empty job', async () => {
    vi.mocked(mock.jobFindUnique).mockResolvedValue(null);

    const repo = new PrismaJobRepository();
    const row = await repo.findById('job_missing');

    expect(mock.jobFindUnique).toHaveBeenCalledWith({ where: { id: 'job_missing' } });
    expect(row).toBeNull();
  });

  // R-11: complete is the only writer of the observed merge facts. update
  // deliberately omits the two columns, and complete must not.
  const mergedAt = new Date('2026-01-03T00:00:00Z');
  const completedFixture = {
    ...jobFixture,
    status: 'completed' as const,
    pullRequestUrl: 'https://github.com/buyer/target-repo/pull/1',
    mergeCommit: 'merge-abc',
    mergedAt,
  } satisfies Job;

  it('complete: sends the full completed payload, including the merge columns, and projects it back', async () => {
    vi.mocked(mock.jobUpdate).mockResolvedValue({ ...completedFixture });

    const repo = new PrismaJobRepository();
    const row = await repo.complete(completedFixture, {
      jobId: 'job_1',
      buyerDid: 'did:example:buyer',
      agentDid: 'did:example:agent',
      mergeCommit: 'merge-abc',
      completedAt: mergedAt,
    });

    // The payload is the whole completed row: the update test above pins
    // the same shape WITHOUT mergeCommit/mergedAt, so the two payloads are
    // pinned differently by design - only complete writes those columns.
    expect(mock.jobUpdate).toHaveBeenCalledWith({
      where: { id: 'job_1' },
      data: {
        buyerDid: completedFixture.buyerDid,
        agentDid: completedFixture.agentDid,
        repository: completedFixture.repository,
        brief: completedFixture.brief,
        briefHash: completedFixture.briefHash,
        confirmedSpecHash: completedFixture.confirmedSpecHash,
        criteria: completedFixture.criteria,
        status: completedFixture.status,
        pullRequestUrl: completedFixture.pullRequestUrl,
        mergeCommit: 'merge-abc',
        mergedAt,
        confirmedAt: completedFixture.confirmedAt,
        submittedAt: completedFixture.submittedAt,
        deadline: completedFixture.deadline,
        createdAt: completedFixture.createdAt,
      },
    });
    expect(row).toEqual(completedFixture);
  });

  it('complete: a P2025 not-found comes back as null, not an error', async () => {
    vi.mocked(mock.jobUpdate).mockRejectedValue(p2025('job_missing'));

    const repo = new PrismaJobRepository();
    const row = await repo.complete(completedFixture, {
      jobId: 'job_1',
      buyerDid: 'did:example:buyer',
      agentDid: 'did:example:agent',
      mergeCommit: 'merge-abc',
      completedAt: mergedAt,
    });

    expect(row).toBeNull();
  });

  it('complete: a non-P2025 Prisma error is rethrown untouched', async () => {
    const original = p1001();
    vi.mocked(mock.jobUpdate).mockRejectedValue(original);

    const repo = new PrismaJobRepository();
    const err = await repo
      .complete(completedFixture, {
        jobId: 'job_1',
        buyerDid: 'did:example:buyer',
        agentDid: 'did:example:agent',
        mergeCommit: 'merge-abc',
        completedAt: mergedAt,
      })
      .catch((e: unknown) => e);

    expect(err).toBe(original);
  });

  it('complete: a non-Prisma error is rethrown untouched', async () => {
    const original = new Error('disk full');
    vi.mocked(mock.jobUpdate).mockRejectedValue(original);

    const repo = new PrismaJobRepository();
    const err = await repo
      .complete(completedFixture, {
        jobId: 'job_1',
        buyerDid: 'did:example:buyer',
        agentDid: 'did:example:agent',
        mergeCommit: 'merge-abc',
        completedAt: mergedAt,
      })
      .catch((e: unknown) => e);

    expect(err).toBe(original);
  });

  it('findCompletedByJobId: a completed row comes back as the completed record', async () => {
    vi.mocked(mock.jobFindUnique).mockResolvedValue({ ...completedFixture });

    const repo = new PrismaJobRepository();
    const row = await repo.findCompletedByJobId('job_1');

    expect(mock.jobFindUnique).toHaveBeenCalledWith({ where: { id: 'job_1' } });
    // The completed record is the anchor shape (no id of its own beyond the
    // job's), projected from the same row findById reads.
    expect(row).toEqual({
      id: 'job_1',
      jobId: 'job_1',
      buyerDid: 'did:example:buyer',
      agentDid: 'did:example:agent',
      mergeCommit: 'merge-abc',
      completedAt: mergedAt,
    });
  });

  it('findCompletedByJobId: a row that never completed comes back as null', async () => {
    vi.mocked(mock.jobFindUnique).mockResolvedValue({ ...jobFixture });

    const repo = new PrismaJobRepository();
    const row = await repo.findCompletedByJobId('job_1');

    expect(row).toBeNull();
  });

  it('findCompletedByJobId: no stored row comes back as null', async () => {
    vi.mocked(mock.jobFindUnique).mockResolvedValue(null);

    const repo = new PrismaJobRepository();
    const row = await repo.findCompletedByJobId('job_missing');

    expect(mock.jobFindUnique).toHaveBeenCalledWith({ where: { id: 'job_missing' } });
    expect(row).toBeNull();
  });
});

describe('PrismaCredentialRepository', () => {
  beforeAll(() => {
    vi.mocked(mock.credentialCreate).mockReset();
    vi.mocked(mock.credentialFindUnique).mockReset();
  });

  afterEach(() => {
    vi.mocked(mock.credentialCreate).mockReset();
    vi.mocked(mock.credentialFindUnique).mockReset();
  });

  // The credential the driver stores is the full W3C credential (R-15); the
  // shaped fixture stands in for the bytes a real issuer signed, the way
  // delegationFixture does for the agent repository.
  const credentialFixture = {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: 'did:abt:platform',
    credentialSubject: {
      id: 'did:abt:agent',
      jobId: 'job_1',
      pullRequestUrl: 'https://github.com/buyer/target-repo/pull/1',
      mergeCommitSha: '3f8a2c1d9e7b4a5f6c8d0e1f2a3b4c5d6e7f8a9b',
      mergedAt: '2026-01-03T00:00:00.000Z',
      diffAdditions: 1,
      diffDeletions: 1,
      specHash: 'sha256:spec',
      filesChanged: 1,
      repository: 'buyer/target-repo',
      signedBy: 'did:abt:agent#job_1',
      buyerDid: 'did:example:buyer',
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zProof' },
  };

  it('save: sends the completed job id, the subject, and the verbatim document', async () => {
    vi.mocked(mock.credentialCreate).mockResolvedValue({ id: 'cuid-1' });

    const repo = new PrismaCredentialRepository();
    await repo.save({
      completedJobId: 'job_1',
      subjectDid: 'did:abt:agent',
      document: credentialFixture,
    });

    // The document crosses the wire verbatim: a projection that reshaped it
    // here would break the proof on the way out, which is exactly what the
    // invariant-2 tests elsewhere in this suite refuse to allow.
    expect(mock.credentialCreate).toHaveBeenCalledWith({
      data: {
        completedJobId: 'job_1',
        subjectDid: 'did:abt:agent',
        document: credentialFixture,
        issuedAt: expect.any(Date),
      },
    });
  });

  it('save: the storage key is the last path segment of a full credential id', async () => {
    vi.mocked(mock.credentialCreate).mockResolvedValue({ id: 'cuid-1' });

    const repo = new PrismaCredentialRepository();
    await repo.save({
      completedJobId: 'https://platform.example/v1/credentials/job_1',
      subjectDid: 'did:abt:agent',
      document: credentialFixture,
    });

    expect(mock.credentialCreate).toHaveBeenCalledWith({
      data: {
        completedJobId: 'job_1',
        subjectDid: 'did:abt:agent',
        document: credentialFixture,
        issuedAt: expect.any(Date),
      },
    });
  });

  it('save: a P2002 unique-constraint failure is the domain duplicate error', async () => {
    vi.mocked(mock.credentialCreate).mockRejectedValue(p2002('job_1'));

    const repo = new PrismaCredentialRepository();
    const err = await repo
      .save({ completedJobId: 'job_1', subjectDid: 'did:abt:agent', document: credentialFixture })
      .catch((e: unknown) => e);

    // One credential per completed job (invariant 6): the domain error
    // names the job, the way the operator and agent drivers name their
    // duplicates.
    expect(err).toBeInstanceOf(CredentialAlreadyIssuedError);
    expect((err as Error).message).toContain('job_1');
    expect((err as Error).name).toBe('CredentialAlreadyIssuedError');
  });

  it('save: a non-P2002 Prisma error is rethrown untouched', async () => {
    const original = p1001();
    vi.mocked(mock.credentialCreate).mockRejectedValue(original);

    const repo = new PrismaCredentialRepository();
    const err = await repo
      .save({ completedJobId: 'job_1', subjectDid: 'did:abt:agent', document: credentialFixture })
      .catch((e: unknown) => e);

    // Same object: a dead database must not be rewritten into a duplicate,
    // and it must not be swallowed.
    expect(err).toBe(original);
    expect(err).not.toBeInstanceOf(CredentialAlreadyIssuedError);
  });

  it('save: a non-Prisma error is rethrown untouched', async () => {
    const original = new Error('disk full');
    vi.mocked(mock.credentialCreate).mockRejectedValue(original);

    const repo = new PrismaCredentialRepository();
    const err = await repo
      .save({ completedJobId: 'job_1', subjectDid: 'did:abt:agent', document: credentialFixture })
      .catch((e: unknown) => e);

    expect(err).toBe(original);
  });

  it('findByDocumentId: a stored row comes back as the verbatim document', async () => {
    vi.mocked(mock.credentialFindUnique).mockResolvedValue({
      id: 'cuid-1',
      completedJobId: 'job_1',
      subjectDid: 'did:abt:agent',
      document: credentialFixture,
      issuedAt: new Date('2026-01-03T00:00:00Z'),
    });

    const repo = new PrismaCredentialRepository();
    const row = await repo.findByDocumentId('job_1');

    expect(mock.credentialFindUnique).toHaveBeenCalledWith({ where: { completedJobId: 'job_1' } });
    expect(row).toEqual(credentialFixture);
  });

  it('findByDocumentId: a full credential id resolves through the same key', async () => {
    vi.mocked(mock.credentialFindUnique).mockResolvedValue({
      id: 'cuid-1',
      completedJobId: 'job_1',
      subjectDid: 'did:abt:agent',
      document: credentialFixture,
      issuedAt: new Date('2026-01-03T00:00:00Z'),
    });

    const repo = new PrismaCredentialRepository();
    const row = await repo.findByDocumentId('https://platform.example/v1/credentials/job_1');

    expect(mock.credentialFindUnique).toHaveBeenCalledWith({ where: { completedJobId: 'job_1' } });
    expect(row).toEqual(credentialFixture);
  });

  it('findByDocumentId: no stored row comes back as null, not an empty document', async () => {
    vi.mocked(mock.credentialFindUnique).mockResolvedValue(null);

    const repo = new PrismaCredentialRepository();
    const row = await repo.findByDocumentId('job_missing');

    expect(mock.credentialFindUnique).toHaveBeenCalledWith({ where: { completedJobId: 'job_missing' } });
    expect(row).toBeNull();
  });
});
