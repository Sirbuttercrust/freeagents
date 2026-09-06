// P5: the attestation repository (design record, 2026-09-01, brief scope
// item 4). Keyed by job id; immutable once written -- a redo that later
// restages the same job needs a NEW record scheme, which is the next
// card's job (this repository intentionally offers no update method, and
// the Prisma model's own comment names the same seam).
//
// The Prisma half follows tests/adapters/prisma.test.ts's own pattern: the
// generated client module is stubbed so no test opens a real database, and
// the real PrismaClientKnownRequestError class is used for the P2002 leg.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAttestation } from '../../src/domain/attestation.js';
import { createJob, stageWork, type Job } from '../../src/domain/job.js';

const mock = vi.hoisted(() => ({
  attestationCreate: vi.fn(),
  attestationFindUnique: vi.fn(),
}));

vi.mock('../../src/generated/prisma/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/generated/prisma/index.js')>(
    '../../src/generated/prisma/index.js',
  );
  return {
    PrismaClient: class {
      attestation = { create: mock.attestationCreate, findUnique: mock.attestationFindUnique };
    },
    Prisma: actual.Prisma,
  };
});

const { MemoryAttestationRepository } = await import('../../src/adapters/storage/memory.js');
const { PrismaAttestationRepository } = await import('../../src/adapters/storage/prisma.js');
const { AttestationAlreadyStoredError } = await import('../../src/adapters/storage/types.js');
const { Prisma } = await import('../../src/generated/prisma/index.js');

function stagedJob(): Job {
  const draft = createJob(
    { id: 'job_att_1', buyerDid: 'did:example:buyer', agentDid: 'did:example:agent', repository: 'buyer/target-repo', brief: 'Fix it' },
    new Date('2026-01-01T00:00:00Z'),
  );
  const confirmed: Job = {
    ...draft,
    status: 'confirmed',
    confirmedSpecHash: 'sha256:spec',
    confirmedAt: new Date('2026-01-02T00:00:00Z'),
    priceUsd: '500.00',
    rail: 'abt',
    priceAcceptedByBuyer: true,
    priceAcceptedByAgent: true,
    criteria: [{ text: 'Login works', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
  };
  return stageWork(confirmed, 'commit-sha-1', new Date('2026-01-05T00:00:00Z'));
}

const attestation = buildAttestation(
  stagedJob(),
  {
    diffHash: 'sha256:diffhash',
    filesChanged: 1,
    linesAdded: 2,
    linesRemoved: 1,
    changedPaths: ['src/a.ts'],
    lineShareByCategory: { source: 1, test: 0, lockfile: 0, generated: 0, vendored: 0 },
    testsDeleted: [],
    testsSkipAdded: [],
    buyerTestRun: { command: 'npm test', exitCode: 0, passCount: 1, failCount: 0, skipCount: 0, failingTestNames: [] },
    outOfCriteriaPathCount: 0,
    commitSigners: [{ matchesAgentDid: true }],
  },
  new Date('2026-01-06T00:00:00Z'),
);

const signedFixture = {
  '@context': ['https://www.w3.org/ns/credentials/v2'],
  id: 'https://platform.example/v1/attestations/commit-sha-1',
  type: ['VerifiableCredential', 'JobAttestation'],
  issuer: 'did:abt:platform',
  validFrom: '2026-01-06T00:00:00.000Z',
  credentialSubject: { id: 'urn:freeagents:staged-commit:commit-sha-1', attestation },
  proof: { type: 'Ed25519Signature2020', proofValue: 'zProof' },
};

describe('MemoryAttestationRepository', () => {
  it('save and findByJobId round-trip the attestation and the signed document verbatim', async () => {
    const repo = new MemoryAttestationRepository();
    await repo.save({ jobId: 'job_att_1', attestation, signed: signedFixture });
    const stored = await repo.findByJobId('job_att_1');
    expect(stored?.jobId).toBe('job_att_1');
    expect(stored?.attestation).toEqual(attestation);
    expect(stored?.signed).toEqual(signedFixture);
  });

  it('findByJobId of an unknown job is null', async () => {
    const repo = new MemoryAttestationRepository();
    expect(await repo.findByJobId('never-staged')).toBeNull();
  });

  it('a second save for the same job id is AttestationAlreadyStoredError: immutable once written', async () => {
    const repo = new MemoryAttestationRepository();
    await repo.save({ jobId: 'job_att_1', attestation, signed: signedFixture });
    const err = await repo.save({ jobId: 'job_att_1', attestation, signed: signedFixture }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttestationAlreadyStoredError);
    expect((err as Error).name).toBe('AttestationAlreadyStoredError');
    // The first record survives the rejected second save.
    expect((await repo.findByJobId('job_att_1'))?.attestation).toEqual(attestation);
  });

  it('two different jobs store independently', async () => {
    const repo = new MemoryAttestationRepository();
    await repo.save({ jobId: 'job_att_1', attestation, signed: signedFixture });
    await repo.save({ jobId: 'job_att_2', attestation, signed: signedFixture });
    expect((await repo.findByJobId('job_att_1'))?.jobId).toBe('job_att_1');
    expect((await repo.findByJobId('job_att_2'))?.jobId).toBe('job_att_2');
  });
});

describe('PrismaAttestationRepository', () => {
  beforeEach(() => {
    mock.attestationCreate.mockReset();
    mock.attestationFindUnique.mockReset();
  });

  it('save: sends the job id, the attestation and the signed document verbatim to the database', async () => {
    mock.attestationCreate.mockResolvedValue({ id: 'cuid-1' });

    const repo = new PrismaAttestationRepository();
    await repo.save({ jobId: 'job_att_1', attestation, signed: signedFixture });

    expect(mock.attestationCreate).toHaveBeenCalledWith({
      data: {
        jobId: 'job_att_1',
        document: attestation,
        signed: signedFixture,
      },
    });
  });

  it('save: a P2002 unique-constraint failure is the domain duplicate error', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (jobId)', {
      code: 'P2002',
      clientVersion: '5.22.0',
    });
    mock.attestationCreate.mockRejectedValue(p2002);

    const repo = new PrismaAttestationRepository();
    const err = await repo.save({ jobId: 'job_att_1', attestation, signed: signedFixture }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AttestationAlreadyStoredError);
    expect((err as Error).message).toContain('job_att_1');
  });

  it('save: a non-P2002 Prisma error is rethrown untouched', async () => {
    const original = new Prisma.PrismaClientKnownRequestError('cannot reach database', {
      code: 'P1001',
      clientVersion: '5.22.0',
    });
    mock.attestationCreate.mockRejectedValue(original);

    const repo = new PrismaAttestationRepository();
    const err = await repo.save({ jobId: 'job_att_1', attestation, signed: signedFixture }).catch((e: unknown) => e);

    expect(err).toBe(original);
    expect(err).not.toBeInstanceOf(AttestationAlreadyStoredError);
  });

  it('save: a non-Prisma error is rethrown untouched', async () => {
    const original = new Error('disk full');
    mock.attestationCreate.mockRejectedValue(original);

    const repo = new PrismaAttestationRepository();
    const err = await repo.save({ jobId: 'job_att_1', attestation, signed: signedFixture }).catch((e: unknown) => e);

    expect(err).toBe(original);
  });

  it('findByJobId: a stored row comes back as the verbatim attestation and signed document', async () => {
    mock.attestationFindUnique.mockResolvedValue({
      jobId: 'job_att_1',
      document: attestation,
      signed: signedFixture,
    });

    const repo = new PrismaAttestationRepository();
    const stored = await repo.findByJobId('job_att_1');

    expect(mock.attestationFindUnique).toHaveBeenCalledWith({ where: { jobId: 'job_att_1' } });
    expect(stored?.attestation).toEqual(attestation);
    expect(stored?.signed).toEqual(signedFixture);
  });

  it('findByJobId: no stored row is null', async () => {
    mock.attestationFindUnique.mockResolvedValue(null);

    const repo = new PrismaAttestationRepository();
    expect(await repo.findByJobId('missing')).toBeNull();
  });
});
