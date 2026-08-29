// The storage factory picks the driver from DATABASE_URL. Neither branch was
// previously tested: no test ever set or unset the variable, so a change that
// swapped the two drivers, or deleted the startup warning, would fail nothing.
import type { Job } from '../../src/domain/job.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The factory reads process.env at call time, so each test sets the variable
// and restores it afterwards. No database is touched: constructing either
// repository opens nothing (the Prisma client is created on first query).
const {
  createCompromiseRepository,
  createCredentialRepository,
  createJobRepository,
  createOperatorRepository,
} = await import('../../src/adapters/storage/storage.js');
const { MemoryCompromiseRepository, MemoryCredentialRepository, MemoryJobRepository, MemoryOperatorRepository } =
  await import('../../src/adapters/storage/memory.js');
const { PrismaCompromiseRepository, PrismaCredentialRepository, PrismaJobRepository, PrismaOperatorRepository } =
  await import('../../src/adapters/storage/prisma.js');
const { CredentialAlreadyIssuedError, JobAlreadyExistsError, credentialLookupKey } = await import(
  '../../src/adapters/storage/types.js'
);

// Shared with tests/adapters/prisma.test.ts: both drivers are pinned to the
// same input/output pair, so a projection that drops a field fails at least
// one of the two. Keep the two fixtures in lockstep if this changes.
const jobFixture: Job = {
  id: 'job_1',
  buyerDid: 'did:example:buyer',
  agentDid: 'did:example:agent',
  repository: 'buyer/target-repo',
  brief: 'Fix the login bug on the checkout page',
  briefHash: 'sha256:brief',
  confirmedSpecHash: null,
  status: 'draft',
  criteria: [],
  pullRequestUrl: null,
  mergeCommit: null,
  mergedAt: null,
  confirmedAt: null,
  submittedAt: null,
  deadline: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

// The credential the driver stores is the full W3C credential (R-15); the
// storage tests drive the driver's decisions, not the cryptography, so a
// shaped fixture stands in for the bytes a real issuer signed.
const credentialFixture: VerifiableCredential = {
  '@context': ['https://www.w3.org/ns/credentials/v2'],
  id: 'urn:uuid:00000000-0000-4000-8000-000000000001',
  type: ['VerifiableCredential', 'CompletedHireCredential'],
  issuer: 'did:abt:platform',
  validFrom: '2026-01-03T00:00:00.000Z',
  credentialSubject: {
    id: 'did:abt:agent',
    hire: {
      brief: 'sha256:brief',
      repository: 'buyer/target-repo',
      pullRequest: 'https://github.com/buyer/target-repo/pull/1',
      mergedAt: '2026-01-03T00:00:00.000Z',
      mergeCommit: '3f8a2c1d9e7b4a5f6c8d0e1f2a3b4c5d6e7f8a9b',
      signedBy: 'did:abt:agent#job_1',
      buyer: 'did:example:buyer',
      additions: 1,
      deletions: 1,
      filesChanged: 1,
      specHash: 'sha256:spec',
    },
  },
  proof: { type: 'Ed25519Signature2020', proofValue: 'zProof' },
};

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

describe('createJobRepository', () => {
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
    const repo = createJobRepository();
    expect(repo).toBeInstanceOf(PrismaJobRepository);
    // The two drivers are different classes; an instanceof on the wrong one
    // would pass on a common ancestor, so also assert the exact name.
    expect(repo.constructor.name).toBe('PrismaJobRepository');
  });

  it('DATABASE_URL empty selects the in-memory driver, with the loud warning', () => {
    vi.stubEnv('DATABASE_URL', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const repo = createJobRepository();
    expect(repo).toBeInstanceOf(MemoryJobRepository);
    expect(repo.constructor.name).toBe('MemoryJobRepository');
    // The warning is the fail-loud half of the branch: a dev/test mode must
    // announce itself, so its absence is a regression this test catches.
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('in-memory');
  });

  it('DATABASE_URL unset selects the in-memory driver, with the loud warning', () => {
    vi.unstubAllEnvs();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.DATABASE_URL;
    const repo = createJobRepository();
    expect(repo).toBeInstanceOf(MemoryJobRepository);
  });
});

describe('createCredentialRepository', () => {
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
    const repo = createCredentialRepository();
    expect(repo).toBeInstanceOf(PrismaCredentialRepository);
    expect(repo.constructor.name).toBe('PrismaCredentialRepository');
  });

  it('DATABASE_URL empty selects the in-memory driver, with the loud warning', () => {
    vi.stubEnv('DATABASE_URL', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const repo = createCredentialRepository();
    expect(repo).toBeInstanceOf(MemoryCredentialRepository);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('in-memory');
  });

  it('DATABASE_URL unset selects the in-memory driver, with the loud warning', () => {
    vi.unstubAllEnvs();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.DATABASE_URL;
    const repo = createCredentialRepository();
    expect(repo).toBeInstanceOf(MemoryCredentialRepository);
  });
});

describe('createCompromiseRepository', () => {
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
    const repo = createCompromiseRepository();
    expect(repo).toBeInstanceOf(PrismaCompromiseRepository);
    expect(repo.constructor.name).toBe('PrismaCompromiseRepository');
  });

  it('DATABASE_URL empty selects the in-memory driver, with the loud warning', () => {
    vi.stubEnv('DATABASE_URL', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const repo = createCompromiseRepository();
    expect(repo).toBeInstanceOf(MemoryCompromiseRepository);
    expect(repo.constructor.name).toBe('MemoryCompromiseRepository');
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('in-memory');
  });

  it('DATABASE_URL unset selects the in-memory driver, with the loud warning', () => {
    vi.unstubAllEnvs();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.DATABASE_URL;
    const repo = createCompromiseRepository();
    expect(repo).toBeInstanceOf(MemoryCompromiseRepository);
  });
});

describe('credentialLookupKey', () => {
  it('is the last non-empty path segment of a full credential id', () => {
    // ENT-8: a credential id is '<base>/v1/credentials/<completedJobId>',
    // and the completed job id is the storage key.
    expect(credentialLookupKey('https://platform.example/v1/credentials/job_1')).toBe('job_1');
    expect(credentialLookupKey('urn:uuid:whatever/v1/credentials/job_2')).toBe('job_2');
  });

  it('an id with no slash is its own key', () => {
    expect(credentialLookupKey('job_1')).toBe('job_1');
  });

  it('trailing slashes do not hide the key', () => {
    expect(credentialLookupKey('https://platform.example/v1/credentials/job_1/')).toBe('job_1');
  });

  it('an empty id is its own key', () => {
    expect(credentialLookupKey('')).toBe('');
  });
});

describe('MemoryCredentialRepository', () => {
  it('save and findByDocumentId round-trip the credential verbatim', async () => {
    const repo = new MemoryCredentialRepository();
    await repo.save({
      completedJobId: 'job_1',
      subjectDid: 'did:abt:agent',
      document: credentialFixture,
    });
    expect(await repo.findByDocumentId('job_1')).toEqual(credentialFixture);
    // The full resolvable id (ENT-8) resolves to the same stored document:
    // the caller does not need to know which form the driver keys on.
    const fullId = 'https://platform.example/v1/credentials/job_1';
    expect(await repo.findByDocumentId(fullId)).toEqual(credentialFixture);
  });

  it('findByDocumentId of an unknown id is null', async () => {
    const repo = new MemoryCredentialRepository();
    expect(await repo.findByDocumentId('job_missing')).toBeNull();
    expect(await repo.findByDocumentId('https://platform.example/v1/credentials/job_missing')).toBeNull();
  });

  it('a second save for the same completed job is CredentialAlreadyIssuedError', async () => {
    const repo = new MemoryCredentialRepository();
    await repo.save({
      completedJobId: 'job_1',
      subjectDid: 'did:abt:agent',
      document: credentialFixture,
    });
    // Saving under the full id of the same job is still the same job: the
    // key is the completed job id, not the string the caller happened to
    // pass.
    const err = await repo
      .save({
        completedJobId: 'https://platform.example/v1/credentials/job_1',
        subjectDid: 'did:abt:agent',
        document: credentialFixture,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialAlreadyIssuedError);
    expect((err as Error).name).toBe('CredentialAlreadyIssuedError');
    // The first document is untouched by the rejected second save.
    expect(await repo.findByDocumentId('job_1')).toEqual(credentialFixture);
  });

  it('two different completed jobs store independently', async () => {
    const repo = new MemoryCredentialRepository();
    const other: VerifiableCredential = {
      ...credentialFixture,
      credentialSubject: {
        ...credentialFixture.credentialSubject,
        hire: { ...credentialFixture.credentialSubject.hire, mergeCommit: '0'.repeat(40) },
      },
    };
    await repo.save({ completedJobId: 'job_1', subjectDid: 'did:abt:agent', document: credentialFixture });
    await repo.save({ completedJobId: 'job_2', subjectDid: 'did:abt:agent', document: other });
    expect(await repo.findByDocumentId('job_1')).toEqual(credentialFixture);
    expect(await repo.findByDocumentId('job_2')).toEqual(other);
  });
});

describe('MemoryJobRepository', () => {
  it('creates and loads back the job unchanged', async () => {
    const repo = new MemoryJobRepository();
    const input: Job = { ...jobFixture };
    const created = await repo.create(input);
    expect(created).toEqual(jobFixture);
    expect(await repo.findById('job_1')).toEqual(jobFixture);
    // The stored row is a copy of the input: mutating the input afterwards
    // must not leak into what the next read returns.
    (input as { status: string }).status = 'proposed';
    expect(await repo.findById('job_1')).toEqual(jobFixture);
  });

  it('loads back an updated status as the update sent it', async () => {
    const repo = new MemoryJobRepository();
    await repo.create(jobFixture);
    const updated = { ...jobFixture, status: 'proposed' as const };
    expect(await repo.update(updated)).toEqual(updated);
    expect(await repo.findById('job_1')).toEqual(updated);
  });

  // R-12: outcome rows (closed_unmerged, stale) are stored and projected like
  // any other status; the deadline the submission wrote is untouched by the
  // outcome update.
  it('round-trips outcome rows through update with the deadline untouched', async () => {
    const repo = new MemoryJobRepository();
    const submitted: Job = {
      ...jobFixture,
      status: 'submitted',
      pullRequestUrl: 'https://github.com/buyer/target-repo/pull/1',
      submittedAt: new Date('2026-01-02T00:00:00Z'),
      deadline: new Date('2026-02-01T00:00:00Z'),
    };
    await repo.create(jobFixture);

    const closed: Job = { ...submitted, status: 'closed_unmerged' };
    expect(await repo.update(closed)).toEqual(closed);
    expect(await repo.findById('job_1')).toEqual(closed);
    expect((await repo.findById('job_1'))?.deadline).toEqual(submitted.deadline);

    // Re-open the row at submitted for the stale leg, like the state machine
    // would have done from its own row.
    await repo.update(submitted);
    const stale: Job = { ...submitted, status: 'stale' };
    expect(await repo.update(stale)).toEqual(stale);
    expect(await repo.findById('job_1')).toEqual(stale);
    expect((await repo.findById('job_1'))?.deadline).toEqual(submitted.deadline);
  });

  it('findById of a missing id is null', async () => {
    const repo = new MemoryJobRepository();
    expect(await repo.findById('job_missing')).toBeNull();
  });

  it('a duplicate create is JobAlreadyExistsError', async () => {
    const repo = new MemoryJobRepository();
    await repo.create(jobFixture);
    const err = await repo.create(jobFixture).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobAlreadyExistsError);
    expect((err as Error).name).toBe('JobAlreadyExistsError');
  });

  it('an update of a missing id is null', async () => {
    const repo = new MemoryJobRepository();
    expect(await repo.update(jobFixture)).toBeNull();
  });

  // The criteria round-trip (R-8): a job whose exchange has run must read
  // back exactly what was stored, through update (the path the exchange
  // routes use) and without the array being shared with the caller's input.
  it('round-trips criteria through create and reads them back identical', async () => {
    const repo = new MemoryJobRepository();
    const withCriteria: Job = {
      ...jobFixture,
      status: 'proposed',
      criteria: [
        { text: 'The login bug is fixed', proposedBy: 'agent', accepted: false },
        { text: 'Checkout e2e test passes', proposedBy: 'buyer', accepted: true },
      ],
    };
    await repo.create(jobFixture);

    const updated = await repo.update(withCriteria);
    expect(updated).toEqual(withCriteria);
    expect(await repo.findById('job_1')).toEqual(withCriteria);
  });

  it('a job with no proposal yet reads back with criteria as an empty array', async () => {
    const repo = new MemoryJobRepository();
    await repo.create(jobFixture);
    const read = await repo.findById('job_1');
    expect(read?.criteria).toEqual([]);
    expect(Array.isArray(read?.criteria)).toBe(true);
  });

  // R-11: complete is the only writer of the observed merge facts, and the
  // row it stores is the whole completed job.
  const completedFixture: Job = {
    ...jobFixture,
    status: 'completed',
    mergeCommit: 'merge-abc',
    mergedAt: new Date('2026-01-03T00:00:00Z'),
  };
  const completedAnchor = {
    jobId: 'job_1',
    buyerDid: 'did:example:buyer',
    agentDid: 'did:example:agent',
    mergeCommit: 'merge-abc',
    completedAt: new Date('2026-01-03T00:00:00Z'),
  };

  it('complete stores the completed job and reads back the merge facts exactly', async () => {
    const repo = new MemoryJobRepository();
    await repo.create(jobFixture);
    const input: Job = { ...completedFixture };
    const stored = await repo.complete(input, completedAnchor);
    expect(stored).toEqual(completedFixture);
    expect(stored?.mergeCommit).toBe('merge-abc');
    expect(stored?.mergedAt).toEqual(completedFixture.mergedAt);
    expect(await repo.findById('job_1')).toEqual(completedFixture);
  });

  it('complete of an unknown id is null, like update', async () => {
    const repo = new MemoryJobRepository();
    expect(await repo.complete(completedFixture, completedAnchor)).toBeNull();
  });

  it('findCompletedByJobId reads back the completed row, and null until it completes', async () => {
    const repo = new MemoryJobRepository();
    await repo.create(jobFixture);
    // Not completed yet: the row exists, but there is no completed record.
    expect(await repo.findCompletedByJobId('job_1')).toBeNull();
    expect(await repo.findCompletedByJobId('job_missing')).toBeNull();
    await repo.complete(completedFixture, completedAnchor);
    // The stored record is the anchor plus the driver-stamped id.
    expect(await repo.findCompletedByJobId('job_1')).toEqual({
      id: 'job_1',
      ...completedAnchor,
    });
  });

  it('complete stores a copy: mutating the input afterwards does not leak', async () => {
    const repo = new MemoryJobRepository();
    await repo.create(jobFixture);
    const criteria = [{ text: 'The login bug is fixed', proposedBy: 'agent' as const, accepted: true }];
    const expected = { ...completedFixture, criteria: [{ ...criteria[0] }] };
    const input: Job = { ...completedFixture, criteria };
    await repo.complete(input, completedAnchor);
    (input as { status: string }).status = 'proposed';
    (input as { mergeCommit: string | null }).mergeCommit = 'mutated';
    (criteria[0] as { text: string }).text = 'mutated';
    // The stored row is a deep copy: the top-level fields and the criteria
    // entries are all independent of the caller's input.
    expect(await repo.findById('job_1')).toEqual(expected);
  });

  // R-33: the hire-record read. An agent with no jobs at all gets [], not
  // null, the same "zero renders as zero" decision findCompletedByJobId's
  // null-until-complete case makes for one job.
  it('findCompletedByAgent is empty for an agent with no jobs', async () => {
    const repo = new MemoryJobRepository();
    expect(await repo.findCompletedByAgent('did:example:agent')).toEqual([]);
  });

  it('findCompletedByAgent excludes a created-but-unmerged job', async () => {
    const repo = new MemoryJobRepository();
    await repo.create(jobFixture);
    expect(await repo.findCompletedByAgent('did:example:agent')).toEqual([]);
  });

  it('findCompletedByAgent excludes a job with a mergeCommit but no mergedAt', async () => {
    const repo = new MemoryJobRepository();
    await repo.create(jobFixture);
    await repo.update({ ...jobFixture, mergeCommit: 'merge-abc', mergedAt: null });
    expect(await repo.findCompletedByAgent('did:example:agent')).toEqual([]);
  });

  it('findCompletedByAgent excludes a job with a mergedAt but no mergeCommit', async () => {
    const repo = new MemoryJobRepository();
    await repo.create(jobFixture);
    await repo.update({ ...jobFixture, mergeCommit: null, mergedAt: new Date('2026-01-01T00:00:00Z') });
    expect(await repo.findCompletedByAgent('did:example:agent')).toEqual([]);
  });

  it('findCompletedByAgent includes a completed job with every CompletedJob field populated', async () => {
    const repo = new MemoryJobRepository();
    await repo.create(jobFixture);
    await repo.complete(completedFixture, completedAnchor);
    expect(await repo.findCompletedByAgent('did:example:agent')).toEqual([{ id: 'job_1', ...completedAnchor }]);
  });

  it('findCompletedByAgent returns two completed jobs for the same agent in ascending completedAt order', async () => {
    const repo = new MemoryJobRepository();
    const earlier = {
      jobId: 'job_2',
      buyerDid: 'did:example:buyer',
      agentDid: 'did:example:agent',
      mergeCommit: 'merge-earlier',
      completedAt: new Date('2026-01-02T00:00:00Z'),
    };
    await repo.create({ ...jobFixture, id: 'job_2' });
    await repo.complete({ ...completedFixture, id: 'job_2', mergeCommit: 'merge-earlier', mergedAt: earlier.completedAt }, earlier);

    await repo.create(jobFixture);
    await repo.complete(completedFixture, completedAnchor);

    const hires = await repo.findCompletedByAgent('did:example:agent');
    expect(hires).toEqual([
      { id: 'job_2', ...earlier },
      { id: 'job_1', ...completedAnchor },
    ]);
  });

  it('findCompletedByAgent sorts by completedAt, not by insertion order', async () => {
    const repo = new MemoryJobRepository();
    const earlier = {
      jobId: 'job_2',
      buyerDid: 'did:example:buyer',
      agentDid: 'did:example:agent',
      mergeCommit: 'merge-earlier',
      completedAt: new Date('2026-01-02T00:00:00Z'),
    };
    // The later-completed job (job_1, 2026-01-03) is inserted first, and the
    // earlier-completed job (job_2, 2026-01-02) is inserted second: Map
    // insertion order is the reverse of ascending completedAt order, so a
    // deleted sort would return the rows in insertion order and fail this.
    await repo.create(jobFixture);
    await repo.complete(completedFixture, completedAnchor);

    await repo.create({ ...jobFixture, id: 'job_2' });
    await repo.complete({ ...completedFixture, id: 'job_2', mergeCommit: 'merge-earlier', mergedAt: earlier.completedAt }, earlier);

    const hires = await repo.findCompletedByAgent('did:example:agent');
    expect(hires).toEqual([
      { id: 'job_2', ...earlier },
      { id: 'job_1', ...completedAnchor },
    ]);
  });

  it('findCompletedByAgent excludes a completed job belonging to a different agent', async () => {
    const repo = new MemoryJobRepository();
    const otherAgentAnchor = { ...completedAnchor, jobId: 'job_3', agentDid: 'did:example:other-agent' };
    await repo.create({ ...jobFixture, id: 'job_3', agentDid: 'did:example:other-agent' });
    await repo.complete({ ...completedFixture, id: 'job_3', agentDid: 'did:example:other-agent' }, otherAgentAnchor);

    expect(await repo.findCompletedByAgent('did:example:agent')).toEqual([]);
  });
});
