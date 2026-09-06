// P5/P6: the attestation repository (design record, 2026-09-01, brief
// scope item 4; widened by P6's redo). Keyed by job id, many rows per job:
// a written record is IMMUTABLE (never edited or overwritten), but a job
// may accumulate more than one across redos, each a fresh sequence number.
// findByJobId serves the latest (the document the buyer currently decides
// against); listByJobId serves every one, oldest first, for the buyer to
// read the attestation shown before and after a redo (P6 brief).
//
// The Prisma half follows tests/adapters/prisma.test.ts's own pattern: the
// generated client module is stubbed so no test opens a real database, and
// the real PrismaClientKnownRequestError class is used for the P2002 leg.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAttestation } from '../../src/domain/attestation.js';
import { createJob, stageWork, type Job } from '../../src/domain/job.js';

const mock = vi.hoisted(() => ({
  attestationCreate: vi.fn(),
  attestationFindFirst: vi.fn(),
  attestationFindMany: vi.fn(),
  attestationCount: vi.fn(),
}));

vi.mock('../../src/generated/prisma/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/generated/prisma/index.js')>(
    '../../src/generated/prisma/index.js',
  );
  return {
    PrismaClient: class {
      attestation = {
        create: mock.attestationCreate,
        findFirst: mock.attestationFindFirst,
        findMany: mock.attestationFindMany,
        count: mock.attestationCount,
      };
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
  it('save and findByJobId round-trip the attestation and the signed document verbatim, at sequence 1', async () => {
    const repo = new MemoryAttestationRepository();
    await repo.save({ jobId: 'job_att_1', attestation, signed: signedFixture });
    const stored = await repo.findByJobId('job_att_1');
    expect(stored?.jobId).toBe('job_att_1');
    expect(stored?.sequence).toBe(1);
    expect(stored?.attestation).toEqual(attestation);
    expect(stored?.signed).toEqual(signedFixture);
  });

  it('findByJobId of an unknown job is null', async () => {
    const repo = new MemoryAttestationRepository();
    expect(await repo.findByJobId('never-staged')).toBeNull();
  });

  // P6 (design record, 2026-09-01): a redo that restages the same job
  // must produce a NEW attestation record beside the old one, never an
  // edit or overwrite of it -- the brief's own wording ("the buyer must
  // be able to read the attestation they were shown before the redo,
  // after the redo, or the redo becomes a way to make an unflattering
  // measurement disappear"). This supersedes P5's original "one
  // attestation per job, ever" pin: the immutability guarantee now
  // applies PER SEQUENCE (a written record is never mutated or replaced),
  // not to the job as a whole.
  it('a second save for the same job id succeeds, as sequence 2, alongside the first', async () => {
    const repo = new MemoryAttestationRepository();
    await repo.save({ jobId: 'job_att_1', attestation, signed: signedFixture });
    const second = await repo.save({ jobId: 'job_att_1', attestation, signed: signedFixture });
    expect(second.sequence).toBe(2);
    // findByJobId serves the LATEST record: the document the buyer
    // currently decides against.
    const latest = await repo.findByJobId('job_att_1');
    expect(latest?.sequence).toBe(2);
  });

  it('listByJobId returns every attestation for a job, oldest first, none edited or removed by a later save', async () => {
    const repo = new MemoryAttestationRepository();
    const firstAttestation = { ...attestation, diffHash: 'sha256:first' };
    const secondAttestation = { ...attestation, diffHash: 'sha256:second' };
    await repo.save({ jobId: 'job_att_1', attestation: firstAttestation, signed: signedFixture });
    await repo.save({ jobId: 'job_att_1', attestation: secondAttestation, signed: signedFixture });
    const all = await repo.listByJobId('job_att_1');
    expect(all).toHaveLength(2);
    expect(all[0]?.sequence).toBe(1);
    expect(all[0]?.attestation.diffHash).toBe('sha256:first');
    expect(all[1]?.sequence).toBe(2);
    expect(all[1]?.attestation.diffHash).toBe('sha256:second');
  });

  it('listByJobId is empty for a job with none, never null', async () => {
    const repo = new MemoryAttestationRepository();
    expect(await repo.listByJobId('never-staged')).toEqual([]);
  });

  it('two different jobs store independently', async () => {
    const repo = new MemoryAttestationRepository();
    await repo.save({ jobId: 'job_att_1', attestation, signed: signedFixture });
    await repo.save({ jobId: 'job_att_2', attestation, signed: signedFixture });
    expect((await repo.findByJobId('job_att_1'))?.jobId).toBe('job_att_1');
    expect((await repo.findByJobId('job_att_2'))?.jobId).toBe('job_att_2');
    expect((await repo.listByJobId('job_att_1'))).toHaveLength(1);
    expect((await repo.listByJobId('job_att_2'))).toHaveLength(1);
  });
});

describe('PrismaAttestationRepository', () => {
  beforeEach(() => {
    mock.attestationCreate.mockReset();
    mock.attestationFindFirst.mockReset();
    mock.attestationFindMany.mockReset();
    mock.attestationCount.mockReset();
  });

  it('save: sends the job id, the sequence, the attestation and the signed document verbatim to the database', async () => {
    mock.attestationCount.mockResolvedValue(0);
    mock.attestationCreate.mockResolvedValue({ id: 'cuid-1', jobId: 'job_att_1', sequence: 1 });

    const repo = new PrismaAttestationRepository();
    await repo.save({ jobId: 'job_att_1', attestation, signed: signedFixture });

    expect(mock.attestationCreate).toHaveBeenCalledWith({
      data: {
        jobId: 'job_att_1',
        sequence: 1,
        document: attestation,
        signed: signedFixture,
      },
    });
  });

  it('save: a second call for the same job counts the existing rows and writes sequence 2', async () => {
    mock.attestationCount.mockResolvedValue(1);
    mock.attestationCreate.mockResolvedValue({ id: 'cuid-2', jobId: 'job_att_1', sequence: 2 });

    const repo = new PrismaAttestationRepository();
    const result = await repo.save({ jobId: 'job_att_1', attestation, signed: signedFixture });

    expect(mock.attestationCount).toHaveBeenCalledWith({ where: { jobId: 'job_att_1' } });
    expect(result.sequence).toBe(2);
  });

  it('save: a race that produces a P2002 on the (jobId, sequence) pair is the domain duplicate error', async () => {
    mock.attestationCount.mockResolvedValue(0);
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (jobId,sequence)', {
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
    mock.attestationCount.mockResolvedValue(0);
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
    mock.attestationCount.mockResolvedValue(0);
    const original = new Error('disk full');
    mock.attestationCreate.mockRejectedValue(original);

    const repo = new PrismaAttestationRepository();
    const err = await repo.save({ jobId: 'job_att_1', attestation, signed: signedFixture }).catch((e: unknown) => e);

    expect(err).toBe(original);
  });

  it('findByJobId: serves the row with the highest sequence, the current document', async () => {
    mock.attestationFindFirst.mockResolvedValue({
      jobId: 'job_att_1',
      sequence: 2,
      document: attestation,
      signed: signedFixture,
    });

    const repo = new PrismaAttestationRepository();
    const stored = await repo.findByJobId('job_att_1');

    expect(mock.attestationFindFirst).toHaveBeenCalledWith({
      where: { jobId: 'job_att_1' },
      orderBy: { sequence: 'desc' },
    });
    expect(stored?.sequence).toBe(2);
    expect(stored?.attestation).toEqual(attestation);
    expect(stored?.signed).toEqual(signedFixture);
  });

  it('findByJobId: no stored row is null', async () => {
    mock.attestationFindFirst.mockResolvedValue(null);

    const repo = new PrismaAttestationRepository();
    expect(await repo.findByJobId('missing')).toBeNull();
  });

  it('listByJobId: every attestation for a job, oldest first', async () => {
    mock.attestationFindMany.mockResolvedValue([
      { jobId: 'job_att_1', sequence: 1, document: attestation, signed: signedFixture },
      { jobId: 'job_att_1', sequence: 2, document: attestation, signed: signedFixture },
    ]);

    const repo = new PrismaAttestationRepository();
    const all = await repo.listByJobId('job_att_1');

    expect(mock.attestationFindMany).toHaveBeenCalledWith({
      where: { jobId: 'job_att_1' },
      orderBy: { sequence: 'asc' },
    });
    expect(all.map((row) => row.sequence)).toEqual([1, 2]);
  });

  it('listByJobId: no stored rows is an empty array, never null', async () => {
    mock.attestationFindMany.mockResolvedValue([]);

    const repo = new PrismaAttestationRepository();
    expect(await repo.listByJobId('missing')).toEqual([]);
  });
});
