import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  acceptCriterion,
  completeJob,
  confirmSpec,
  createJob,
  decline,
  isTerminal,
  JobError,
  JobTransitionError,
  proposeCriteria,
  recordClosedUnmerged,
  recordStale,
  recordWithdrawn,
  requestChanges,
  submitPullRequest,
  STALE_AFTER_DAYS,
  validateJobTransition,
} from '../../src/domain/job.js';
import type { Criterion, Job } from '../../src/domain/job.js';

function proposedJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job_1',
    buyerDid: 'did:example:buyer',
    agentDid: 'did:example:agent',
    repository: 'buyer/target-repo',
    brief: 'Fix the login bug on the checkout page',
    briefHash: 'sha256:brief',
    confirmedSpecHash: null,
    status: 'proposed',
    criteria: [],
    pullRequestUrl: null,
    mergeCommit: null,
    mergedAt: null,
    confirmedAt: null,
    submittedAt: null,
    deadline: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

const proposal = (): Array<{ text: string; proposedBy: string }> => [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'agent' },
];

// A proposal every party has accepted - what confirmSpec requires (ENT-6.2).
function acceptedProposalJob(overrides: Partial<Job> = {}): Job {
  return proposedJob({
    status: 'proposed',
    criteria: [
      { text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
      { text: 'Checkout e2e test passes', proposedBy: 'buyer', acceptedByBuyer: true, acceptedByAgent: true },
    ],
    ...overrides,
  });
}

describe('job state machine', () => {
  it('walks proposed -> confirmed -> submitted -> completed', () => {
    const now = new Date('2026-01-02T00:00:00Z');

    const confirmed = confirmSpec(acceptedProposalJob(), now);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.confirmedSpecHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(confirmed.confirmedAt).toBe(now);

    const submitted = submitPullRequest(confirmed, 'https://github.com/buyer/target-repo/pull/1', now);
    expect(submitted.status).toBe('submitted');
    expect(submitted.pullRequestUrl).toBe('https://github.com/buyer/target-repo/pull/1');

    const { job: completed, completedJob } = completeJob(submitted, {
      mergeCommit: 'abc123',
      completedAt: now,
    });
    expect(completed.status).toBe('completed');
    // The observed facts are stamped on the job by the same writer that
    // produced the anchor row - the job and the row cannot disagree.
    expect(completed.mergeCommit).toBe('abc123');
    expect(completed.mergedAt).toBe(now);
    expect(completedJob).toEqual({
      jobId: 'job_1',
      buyerDid: 'did:example:buyer',
      agentDid: 'did:example:agent',
      mergeCommit: 'abc123',
      completedAt: now,
    });
  });

  it('declines from any non-terminal status', () => {
    expect(decline(proposedJob()).status).toBe('declined');
    expect(decline(proposedJob({ status: 'confirmed' })).status).toBe('declined');
    expect(decline(proposedJob({ status: 'submitted' })).status).toBe('declined');
  });

  it('rejects confirming a job that is not proposed', () => {
    // The transition check fires before the content gates, so a confirmed
    // job rejects with JobTransitionError whatever its criteria hold.
    const job = proposedJob({ status: 'confirmed' });
    expect(() => confirmSpec(job, new Date())).toThrow(JobTransitionError);
  });

  it('rejects submitting a pull request before the spec is confirmed', () => {
    expect(() => submitPullRequest(proposedJob(), 'https://example.com/pr/1', new Date())).toThrow(
      JobTransitionError,
    );
  });

  it('rejects completing a job that has no open pull request', () => {
    const job = proposedJob({ status: 'confirmed' });
    expect(() => completeJob(job, { mergeCommit: 'abc123', completedAt: new Date() })).toThrow(
      JobTransitionError,
    );
  });

  it('rejects declining a job that already reached a terminal status', () => {
    const completed = proposedJob({ status: 'completed' });
    expect(() => decline(completed)).toThrow(JobTransitionError);
  });

  it('treats completed, declined, closed_unmerged and withdrawn as terminal; stale is not', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('declined')).toBe(true);
    expect(isTerminal('closed_unmerged')).toBe(true);
    expect(isTerminal('withdrawn')).toBe(true);
    expect(isTerminal('stale')).toBe(false);
    expect(isTerminal('draft')).toBe(false);
    expect(isTerminal('proposed')).toBe(false);
    expect(isTerminal('confirmed')).toBe(false);
    expect(isTerminal('submitted')).toBe(false);
  });
});

// R-12 (ENT-7.2): non-merge outcomes are recorded, not hidden. The table is
// the single source of truth, so each new edge gets a direct pin.
describe('job outcomes (R-12)', () => {
  const submitted = (): Job =>
    proposedJob({
      status: 'submitted',
      pullRequestUrl: 'https://github.com/buyer/target-repo/pull/1',
      submittedAt: new Date('2026-02-01T00:00:00Z'),
      deadline: new Date('2026-03-03T00:00:00Z'),
      criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
    });

  it('walks submitted -> closed_unmerged and submitted -> stale', () => {
    expect(validateJobTransition('submitted', 'closed_unmerged')).toBe('closed_unmerged');
    expect(validateJobTransition('submitted', 'stale')).toBe('stale');
  });

  it('stale is not terminal: a merge after the stale marker still completes (D3)', () => {
    expect(validateJobTransition('stale', 'completed')).toBe('completed');
    expect(validateJobTransition('stale', 'declined')).toBe('declined');
  });

  it('closed_unmerged is terminal: nothing transitions out of it', () => {
    expect(() => validateJobTransition('closed_unmerged', 'completed')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('closed_unmerged', 'stale')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('closed_unmerged', 'declined')).toThrow(JobTransitionError);
  });

  it('an outcome update after stale is legal (R-31 closed the deferred edge)', () => {
    expect(validateJobTransition('stale', 'closed_unmerged')).toBe('closed_unmerged');
  });

  it('submitPullRequest writes deadline as submittedAt + 30 days, exactly', () => {
    const now = new Date('2026-02-01T12:30:00Z');
    const submitted = submitPullRequest(proposedJob({ status: 'confirmed' }), 'https://github.com/buyer/target-repo/pull/1', now);
    // STALE_AFTER_DAYS is the D3 value; deriving the expectation from it keeps
    // the test honest if the constant ever moves, and the ISO pin proves the
    // offset is applied, not skipped.
    const expected = new Date(now.getTime() + STALE_AFTER_DAYS * 86_400_000);
    expect(STALE_AFTER_DAYS).toBe(30);
    expect(submitted.deadline).not.toBeNull();
    expect(submitted.deadline!.toISOString()).toBe(expected.toISOString());
    expect(submitted.submittedAt).toBe(now);
  });

  it('createJob leaves deadline null until submitted', () => {
    const job = createJob(
      { id: 'job_1', buyerDid: 'did:example:buyer', agentDid: 'did:example:agent', repository: 'buyer/target-repo', brief: 'Fix the login bug' },
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(job.deadline).toBeNull();
  });

  it('recordClosedUnmerged returns a new job, preserves the submission pair and the deadline', () => {
    const job = submitted();
    const recorded = recordClosedUnmerged(job);
    expect(recorded).not.toBe(job);
    expect(recorded.status).toBe('closed_unmerged');
    expect(recorded.pullRequestUrl).toBe(job.pullRequestUrl);
    expect(recorded.submittedAt).toBe(job.submittedAt);
    expect(recorded.deadline).toBe(job.deadline);
    expect(recorded.criteria).toEqual(job.criteria);
    expect(job.status).toBe('submitted');
  });

  it('recordStale returns a new job, preserves the submission pair and the deadline', () => {
    const job = submitted();
    const recorded = recordStale(job);
    expect(recorded).not.toBe(job);
    expect(recorded.status).toBe('stale');
    expect(recorded.pullRequestUrl).toBe(job.pullRequestUrl);
    expect(recorded.submittedAt).toBe(job.submittedAt);
    expect(recorded.deadline).toBe(job.deadline);
    expect(recorded.criteria).toEqual(job.criteria);
    expect(job.status).toBe('submitted');
  });

  it('records a closed-unmerged outcome from submitted and stale, and nothing earlier or later', () => {
    expect(recordClosedUnmerged(submitted()).status).toBe('closed_unmerged');
    expect(recordClosedUnmerged(proposedJob({ status: 'stale' })).status).toBe('closed_unmerged');
    expect(() => recordClosedUnmerged(proposedJob({ status: 'draft' }))).toThrow(JobTransitionError);
    expect(() => recordClosedUnmerged(proposedJob({ status: 'confirmed' }))).toThrow(JobTransitionError);
    expect(() => recordClosedUnmerged(proposedJob({ status: 'completed' }))).toThrow(JobTransitionError);
    // Re-recording the outcome on an already-observed row is a terminal-state
    // conflict, not a no-op.
    expect(() => recordClosedUnmerged(recordClosedUnmerged(submitted()))).toThrow(JobTransitionError);
  });

  it('records a stale outcome from submitted, and nothing earlier or later', () => {
    expect(recordStale(submitted()).status).toBe('stale');
    expect(() => recordStale(proposedJob({ status: 'draft' }))).toThrow(JobTransitionError);
    expect(() => recordStale(proposedJob({ status: 'confirmed' }))).toThrow(JobTransitionError);
    expect(() => recordStale(proposedJob({ status: 'completed' }))).toThrow(JobTransitionError);
    expect(() => recordStale(proposedJob({ status: 'closed_unmerged' }))).toThrow(JobTransitionError);
    expect(() => recordStale(proposedJob({ status: 'stale' }))).toThrow(JobTransitionError);
    expect(() => recordStale(recordStale(submitted()))).toThrow(JobTransitionError);
  });
});

// R-31 (#50, D3 2026-08-22): the buyer withdraws an open job. Withdrawn is
// a timing fact reachable from every non-terminal state - like declined -
// and terminal: a withdrawn job has no further outcomes to observe.
describe('job withdrawn (R-31)', () => {
  const submitted = (): Job =>
    proposedJob({
      status: 'submitted',
      pullRequestUrl: 'https://github.com/buyer/target-repo/pull/1',
      submittedAt: new Date('2026-02-01T00:00:00Z'),
      deadline: new Date('2026-03-03T00:00:00Z'),
    });

  it('is reachable from every non-terminal state, and nowhere else', () => {
    expect(validateJobTransition('draft', 'withdrawn')).toBe('withdrawn');
    expect(validateJobTransition('proposed', 'withdrawn')).toBe('withdrawn');
    expect(validateJobTransition('confirmed', 'withdrawn')).toBe('withdrawn');
    expect(validateJobTransition('submitted', 'withdrawn')).toBe('withdrawn');
    expect(validateJobTransition('stale', 'withdrawn')).toBe('withdrawn');
    // Terminal states stay closed: no status reaches a withdrawn job.
    expect(() => validateJobTransition('withdrawn', 'draft')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('withdrawn', 'proposed')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('withdrawn', 'confirmed')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('withdrawn', 'submitted')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('withdrawn', 'completed')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('withdrawn', 'declined')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('withdrawn', 'closed_unmerged')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('withdrawn', 'stale')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('withdrawn', 'withdrawn')).toThrow(JobTransitionError);
  });

  it('recordWithdrawn returns a new job, preserves the submission pair and the deadline', () => {
    const job = submitted();
    const recorded = recordWithdrawn(job);
    expect(recorded).not.toBe(job);
    expect(recorded.status).toBe('withdrawn');
    expect(recorded.pullRequestUrl).toBe(job.pullRequestUrl);
    expect(recorded.submittedAt).toBe(job.submittedAt);
    expect(recorded.deadline).toBe(job.deadline);
    expect(recorded.criteria).toEqual(job.criteria);
    expect(job.status).toBe('submitted');
  });

  it('records a withdrawn outcome from every non-terminal state, and nothing terminal', () => {
    expect(recordWithdrawn(submitted()).status).toBe('withdrawn');
    expect(recordWithdrawn(proposedJob({ status: 'draft' })).status).toBe('withdrawn');
    expect(recordWithdrawn(proposedJob({ status: 'confirmed' })).status).toBe('withdrawn');
    expect(recordWithdrawn(proposedJob({ status: 'stale' })).status).toBe('withdrawn');
    expect(() => recordWithdrawn(proposedJob({ status: 'completed' }))).toThrow(JobTransitionError);
    expect(() => recordWithdrawn(proposedJob({ status: 'declined' }))).toThrow(JobTransitionError);
    expect(() => recordWithdrawn(proposedJob({ status: 'closed_unmerged' }))).toThrow(JobTransitionError);
    // A second withdraw is a terminal-state conflict, not a no-op.
    expect(() => recordWithdrawn(recordWithdrawn(submitted()))).toThrow(JobTransitionError);
  });
});

describe('createJob', () => {
  const now = new Date('2026-01-01T00:00:00Z');

  it('opens a draft carrying the brief, with the brief hash of that brief', () => {
    const brief = 'Fix the login bug on the checkout page';
    const job = createJob(
      {
        id: 'job_1',
        buyerDid: 'did:example:buyer',
        agentDid: 'did:example:agent',
        repository: 'buyer/target-repo',
        brief,
      },
      now,
    );

    expect(job.status).toBe('draft');
    expect(job.brief).toBe(brief);
    // Property, not a memorised constant: the hash is recomputed here by the
    // same primitive the implementation calls (see invariant 2 test below
    // for the full normalisation check).
    expect(job.briefHash).toBe('sha256:' + createHash('sha256').update(brief).digest('hex'));
    expect(job.briefHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(job.confirmedSpecHash).toBeNull();
    expect(job.pullRequestUrl).toBeNull();
    expect(job.mergeCommit).toBeNull();
    expect(job.mergedAt).toBeNull();
    expect(job.confirmedAt).toBeNull();
    expect(job.submittedAt).toBeNull();
    expect(job.createdAt).toBe(now);
  });

  it('rejects an empty or whitespace-only brief', () => {
    expect(() =>
      createJob({ id: 'job_1', buyerDid: 'did:example:buyer', agentDid: 'did:example:agent', repository: 'buyer/target-repo', brief: '' }, now),
    ).toThrow(JobError);
    expect(() =>
      createJob({ id: 'job_1', buyerDid: 'did:example:buyer', agentDid: 'did:example:agent', repository: 'buyer/target-repo', brief: '   \n\t ' }, now),
    ).toThrow(JobError);
  });

  it('walks draft -> proposed -> confirmed -> submitted -> completed', () => {
    expect(validateJobTransition('draft', 'proposed')).toBe('proposed');
    expect(validateJobTransition('proposed', 'confirmed')).toBe('confirmed');
    expect(validateJobTransition('confirmed', 'submitted')).toBe('submitted');
    expect(validateJobTransition('submitted', 'completed')).toBe('completed');
  });

  it('rejects skipping ahead from a draft', () => {
    expect(() => validateJobTransition('draft', 'confirmed')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('draft', 'submitted')).toThrow(JobTransitionError);
    expect(() => validateJobTransition('draft', 'completed')).toThrow(JobTransitionError);
  });

  it('declines a draft, and a draft brief is not mutated by any transition function', () => {
    const job = createJob(
      { id: 'job_1', buyerDid: 'did:example:buyer', agentDid: 'did:example:agent', repository: 'buyer/target-repo', brief: 'Fix the login bug on the checkout page' },
      now,
    );

    expect(decline(job).status).toBe('declined');

    // proposeCriteria (R-8) and confirmSpec each return a new job object;
    // none of them touches the brief, which is the buyer's verbatim record.
    // Both parties must accept before confirm (ENT-6.2), so both accept
    // calls run against every index.
    let proposed = proposeCriteria({ ...job, status: 'draft' }, proposal());
    proposed = acceptCriterion(acceptCriterion(proposed, 0, 'buyer'), 0, 'agent');
    proposed = acceptCriterion(acceptCriterion(proposed, 1, 'buyer'), 1, 'agent');
    expect(proposed.brief).toBe(job.brief);
    const confirmed = confirmSpec(proposed, now);
    expect(confirmed.brief).toBe(job.brief);
    expect(submitPullRequest(confirmed, 'https://github.com/buyer/target-repo/pull/1', now).brief).toBe(job.brief);
    expect(completeJob(submitPullRequest(confirmed, 'https://github.com/buyer/target-repo/pull/1', now), { mergeCommit: 'abc123', completedAt: now }).job.brief).toBe(job.brief);
    expect(decline(confirmed).brief).toBe(job.brief);
  });
});

// The acceptance-criteria exchange R-8 owns (ENT-6, D2): propose walks
// draft -> proposed once, then loops in place, diffing against the stored
// list rather than replacing it wholesale; nothing here mutates the job it
// was handed.
describe('criteria exchange', () => {
  const draft = (): Job => proposedJob({ status: 'draft' });

  it('proposes on a draft: proposed status, trimmed texts, all unaccepted by both parties', () => {
    const job = draft();
    const input = [
      { text: '  The login bug is fixed  ', proposedBy: 'agent' },
      { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
    ];

    const proposed = proposeCriteria(job, input);

    expect(proposed.status).toBe('proposed');
    expect(proposed.id).toBe(job.id);
    expect(proposed.criteria).toEqual([
      { text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: false },
      { text: 'Checkout e2e test passes', proposedBy: 'buyer', acceptedByBuyer: false, acceptedByAgent: false },
    ] satisfies Criterion[]);
  });

  it('propose does not mutate the job it was handed', () => {
    const job = draft();
    proposeCriteria(job, proposal());
    expect(job.status).toBe('draft');
    expect(job.criteria).toEqual([]);
  });

  it('re-proposing with entirely new text is a fresh, unaccepted list, same status and id', () => {
    const proposed = proposeCriteria(draft(), proposal());
    const revised = [{ text: 'One sharper criterion', proposedBy: 'agent' }];

    const again = proposeCriteria(proposed, revised);

    expect(again.status).toBe('proposed');
    expect(again.id).toBe(proposed.id);
    expect(again.criteria).toEqual([
      { text: 'One sharper criterion', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: false },
    ]);
  });

  // The brief's explicit call: "editing one line resets only that line".
  it('revising one criterion resets only that line and leaves the others intact', () => {
    let job = proposeCriteria(draft(), proposal());
    job = acceptCriterion(acceptCriterion(job, 0, 'buyer'), 0, 'agent');
    job = acceptCriterion(job, 1, 'buyer');
    expect(job.criteria[0]).toEqual({
      text: 'The login bug is fixed',
      proposedBy: 'agent',
      acceptedByBuyer: true,
      acceptedByAgent: true,
    });
    expect(job.criteria[1]).toEqual({
      text: 'Checkout e2e test passes',
      proposedBy: 'agent',
      acceptedByBuyer: true,
      acceptedByAgent: false,
    });

    // Edit line 1's text only; line 0's text is carried through unchanged.
    const revised = proposeCriteria(job, [
      { text: 'The login bug is fixed', proposedBy: 'agent' },
      { text: 'Checkout e2e test passes on every browser', proposedBy: 'agent' },
    ]);

    // Untouched: the unchanged line keeps its acceptance history exactly.
    expect(revised.criteria[0]).toEqual({
      text: 'The login bug is fixed',
      proposedBy: 'agent',
      acceptedByBuyer: true,
      acceptedByAgent: true,
    });
    // Reset: the edited line starts fresh for both parties, even though the
    // buyer had accepted the old wording.
    expect(revised.criteria[1]).toEqual({
      text: 'Checkout e2e test passes on every browser',
      proposedBy: 'agent',
      acceptedByBuyer: false,
      acceptedByAgent: false,
    });
  });

  it('striking a criterion removes it without touching the acceptance of the ones that remain', () => {
    let job = proposeCriteria(draft(), proposal());
    job = acceptCriterion(acceptCriterion(job, 0, 'buyer'), 0, 'agent');
    job = acceptCriterion(acceptCriterion(job, 1, 'buyer'), 1, 'agent');

    // Only the first line survives the revision; the second is struck.
    const revised = proposeCriteria(job, [{ text: 'The login bug is fixed', proposedBy: 'agent' }]);

    expect(revised.criteria).toEqual([
      { text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
    ]);
  });

  it('adding a criterion leaves the existing ones untouched and starts the new one unaccepted', () => {
    let job = proposeCriteria(draft(), [{ text: 'The login bug is fixed', proposedBy: 'agent' }]);
    job = acceptCriterion(acceptCriterion(job, 0, 'buyer'), 0, 'agent');

    const revised = proposeCriteria(job, [
      { text: 'The login bug is fixed', proposedBy: 'agent' },
      { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
    ]);

    expect(revised.criteria).toEqual([
      { text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
      { text: 'Checkout e2e test passes', proposedBy: 'buyer', acceptedByBuyer: false, acceptedByAgent: false },
    ]);
  });

  it('requestChanges leaves the criteria and their acceptances untouched, and only validates status', () => {
    let job = proposeCriteria(draft(), proposal());
    job = acceptCriterion(job, 0, 'buyer');
    expect(job.criteria[0]?.acceptedByBuyer).toBe(true);
    expect(job.criteria[0]?.acceptedByAgent).toBe(false);

    const pushedBack = requestChanges(job);

    expect(pushedBack.status).toBe('proposed');
    expect(pushedBack.id).toBe(job.id);
    expect(pushedBack.criteria).toEqual(job.criteria);
  });

  it('acceptCriterion flips only the calling party\'s own flag, idempotently', () => {
    let job = proposeCriteria(draft(), proposal());

    job = acceptCriterion(job, 1, 'buyer');
    expect(job.criteria.map((c) => [c.acceptedByBuyer, c.acceptedByAgent])).toEqual([
      [false, false],
      [true, false],
    ]);

    // Idempotent per party: accepting again does not toggle it off, and the
    // other party's flag is untouched.
    const repeat = acceptCriterion(job, 1, 'buyer');
    expect(repeat.criteria).toEqual(job.criteria);

    // The other party accepting the same line sets ONLY its own flag.
    const both = acceptCriterion(job, 1, 'agent');
    expect(both.criteria[1]).toEqual({
      text: 'Checkout e2e test passes',
      proposedBy: 'agent',
      acceptedByBuyer: true,
      acceptedByAgent: true,
    });
  });

  it('rejects proposing on a confirmed job', () => {
    let proposed = proposeCriteria(draft(), proposal());
    proposed = acceptCriterion(acceptCriterion(proposed, 0, 'buyer'), 0, 'agent');
    proposed = acceptCriterion(acceptCriterion(proposed, 1, 'buyer'), 1, 'agent');
    const confirmed = confirmSpec(proposed, new Date());
    expect(() => proposeCriteria(confirmed, proposal())).toThrow(JobTransitionError);
    expect(() => requestChanges(confirmed)).toThrow(JobTransitionError);
    expect(() => acceptCriterion(confirmed, 0, 'buyer')).toThrow(JobTransitionError);
  });

  it('rejects an empty list, whitespace text and a bogus proposer with JobError', () => {
    const job = draft();
    expect(() => proposeCriteria(job, [])).toThrow(JobError);
    expect(() => proposeCriteria(job, [{ text: '   \n\t ', proposedBy: 'agent' }])).toThrow(JobError);
    expect(() => proposeCriteria(job, [{ text: 'fine', proposedBy: 'nobody' }])).toThrow(JobError);
  });

  // The API guard shadows this clause (a numeric text 400s there), so only a
  // direct call proves it: without the typeof check, .trim() on the impostor
  // throws TypeError - a 500 - where the domain owes a JobError.
  it('rejects a non-string criterion text with JobError, not TypeError', () => {
    const job = draft();
    const input = [
      { text: 42 as unknown as string, proposedBy: 'agent' },
      { text: null as unknown as string, proposedBy: 'buyer' },
    ];

    expect(() => proposeCriteria(job, input)).toThrow(JobError);
    expect(() => proposeCriteria(job, input)).not.toThrow(TypeError);
  });

  it('rejects an out-of-range or non-integer accept index', () => {
    const job = proposeCriteria(draft(), proposal());
    expect(() => acceptCriterion(job, -1, 'buyer')).toThrow(JobError);
    expect(() => acceptCriterion(job, 2, 'buyer')).toThrow(JobError);
    expect(() => acceptCriterion(job, 0.5, 'buyer')).toThrow(JobError);
  });
});

// MISSION.md invariant 2, as far as it reaches in R-27: the service issues no
// credential for a job yet, so the verifiable fact it introduces is the brief
// hash. A third party holding the brief must be able to recompute it with
// off-the-shelf tools (node:crypto, openssl, a W3C verifier), without calling
// this service. The digest below is derived inside the test from the same
// documented normalisation the implementation applies; nothing is memorised.
describe('invariant 2: the brief hash is re-computable off-platform', () => {
  it('briefHash is the sha256 of the normalised brief', () => {
    // CRLF endings and trailing line whitespace: what a pasted buyer message
    // most plausibly has.
    const brief = 'Fix the login bug on the checkout page\r\n  ';
    const job = createJob(
      { id: 'job_1', buyerDid: 'did:example:buyer', agentDid: 'did:example:agent', repository: 'buyer/target-repo', brief },
      new Date('2026-01-01T00:00:00Z'),
    );

    // The documented normalisation, applied here independently:
    // \n endings, trailing whitespace stripped per line, no final newline.
    let normalised = brief
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n');
    if (normalised.endsWith('\n')) {
      normalised = normalised.slice(0, -1);
    }
    const expected = 'sha256:' + createHash('sha256').update(normalised).digest('hex');

    expect(job.briefHash).toBe(expected);

    // Confirm computes its own digest now (R-9), and the brief hash rides
    // through unchanged; both digests are plain sha256:<hex> strings: a
    // GitHub API consumer or W3C verifier checks them against the text it
    // holds, no round-trip here.
    const now = new Date('2026-01-02T00:00:00Z');
    const confirmed = confirmSpec(
      {
        ...job,
        status: 'proposed',
        criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
      },
      now,
    );
    expect(confirmed.briefHash).toBe(expected);
    expect(confirmed.briefHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(confirmed.confirmedSpecHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

// R-9 (ENT-4.2, ENT-6.2): confirm computes the spec hash itself from the
// stored criteria and enforces the both-parties acceptance gate. Each gate
// gets its own failing input, so deleting any single guard fails exactly one
// test here rather than passing silently.
describe('confirmSpec (R-9)', () => {
  const now = new Date('2026-01-02T00:00:00Z');

  // ENT-6.2, made real: one flag cannot record two parties agreeing. These
  // pin the gate this issue exists to add - a caller could delete
  // acceptedByAgent from the check and only this block would notice.
  it('refuses confirm when only the buyer accepted every criterion', () => {
    const job = acceptedProposalJob({
      criteria: [
        { text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: false },
        { text: 'Checkout e2e test passes', proposedBy: 'buyer', acceptedByBuyer: true, acceptedByAgent: false },
      ],
    });
    expect(() => confirmSpec(job, now)).toThrow(JobError);
    expect(() => confirmSpec(job, now)).toThrow(/outstanding/);
  });

  it('refuses confirm when only the agent accepted every criterion', () => {
    const job = acceptedProposalJob({
      criteria: [
        { text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: true },
        { text: 'Checkout e2e test passes', proposedBy: 'buyer', acceptedByBuyer: false, acceptedByAgent: true },
      ],
    });
    expect(() => confirmSpec(job, now)).toThrow(JobError);
  });

  it('succeeds once every criterion carries both parties', () => {
    const job = acceptedProposalJob();
    const confirmed = confirmSpec(job, now);
    expect(confirmed.status).toBe('confirmed');
  });

  it('hashes the JOINED criterion texts through the documented normalisation', () => {
    // A CRLF inside one text and trailing spaces on another: normalisation
    // runs over the joined string, so what a stranger reproduces is the
    // per-line trim of the '\n'-joined texts.
    const job = acceptedProposalJob({
      criteria: [
        { text: 'The login bug is fixed\r\non every page  ', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
        { text: 'Checkout e2e test passes\t', proposedBy: 'buyer', acceptedByBuyer: true, acceptedByAgent: true },
      ],
    });

    // The documented serialization (A1), recomputed independently - this test
    // does not call the hashing module:
    const specText = job.criteria.map((criterion) => criterion.text).join('\n');
    let normalised = specText
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n');
    if (normalised.endsWith('\n')) {
      normalised = normalised.slice(0, -1);
    }
    const expected = 'sha256:' + createHash('sha256').update(normalised).digest('hex');

    const confirmed = confirmSpec(job, now);
    expect(confirmed.confirmedSpecHash).toBe(expected);
    expect(confirmed.confirmedSpecHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Property, not a constant: a different agreement hashes differently.
    const other = confirmSpec(
      acceptedProposalJob({
        criteria: [{ text: 'A different criterion entirely', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
      }),
      now,
    );
    expect(other.confirmedSpecHash).not.toBe(confirmed.confirmedSpecHash);
  });

  it('rejects confirming with no criteria at all: JobError, not TypeError', () => {
    expect(() => confirmSpec(proposedJob(), now)).toThrow(JobError);
    expect(() => confirmSpec(proposedJob(), now)).not.toThrow(TypeError);
  });

  it('rejects confirming while one criterion of two is still unaccepted', () => {
    const job = acceptedProposalJob({
      criteria: [
        { text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
        { text: 'Checkout e2e test passes', proposedBy: 'buyer', acceptedByBuyer: true, acceptedByAgent: false },
      ],
    });
    expect(() => confirmSpec(job, now)).toThrow(JobError);
  });

  it('names the outstanding count when nothing was accepted', () => {
    const job = acceptedProposalJob({
      criteria: [
        { text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: false, acceptedByAgent: false },
        { text: 'Checkout e2e test passes', proposedBy: 'buyer', acceptedByBuyer: false, acceptedByAgent: false },
      ],
    });
    expect(() => confirmSpec(job, now)).toThrow(/outstanding/);
    expect(() => confirmSpec(job, now)).toThrow(/2 of 2 outstanding/);
  });

  it('returns a new object and leaves the handed-in job untouched', () => {
    const job = acceptedProposalJob();
    const confirmed = confirmSpec(job, now);
    expect(confirmed).not.toBe(job);
    expect(job.status).toBe('proposed');
    expect(job.confirmedSpecHash).toBeNull();
    expect(job.confirmedAt).toBeNull();
  });

  it('rejects re-confirming an already confirmed job', () => {
    const confirmed = confirmSpec(acceptedProposalJob(), now);
    expect(() => confirmSpec(confirmed, now)).toThrow(JobTransitionError);
  });
});
