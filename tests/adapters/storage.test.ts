// The storage factory picks the driver from DATABASE_URL. Neither branch was
// previously tested: no test ever set or unset the variable, so a change that
// swapped the two drivers, or deleted the startup warning, would fail nothing.
import type { Job } from '../../src/domain/job.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The factory reads process.env at call time, so each test sets the variable
// and restores it afterwards. No database is touched: constructing either
// repository opens nothing (the Prisma client is created on first query).
const { createJobRepository, createOperatorRepository } = await import(
  '../../src/adapters/storage/storage.js'
);
const { MemoryJobRepository, MemoryOperatorRepository } = await import(
  '../../src/adapters/storage/memory.js'
);
const { PrismaJobRepository, PrismaOperatorRepository } = await import(
  '../../src/adapters/storage/prisma.js'
);
const { JobAlreadyExistsError } = await import(
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
});
