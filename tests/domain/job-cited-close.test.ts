// P6: the cited close (design record, 2026-09-01, row 4). After paying,
// the buyer may close the pull request once, naming a confirmed criterion
// index plus one sentence, attributed to the buyer never the platform.
// Stops the credential, refunds nothing (the route's job to say so before
// the buyer clicks; this file only builds the domain fact). Settlement
// itself is a route-layer fact (SettlementGate), asked in
// tests/api/job-cited-close.test.ts; this file drives on jobs already at
// `submitted`, exactly as the transition table gates it.
import { describe, expect, it } from 'vitest';
import {
  createJob,
  JobError,
  JobTransitionError,
  recordCitedClose,
  applyLapses,
  type Job,
} from '../../src/domain/job.js';

function submittedJob(overrides: Partial<Job> = {}): Job {
  const draft = createJob(
    { id: 'job_1', buyerDid: 'did:example:buyer', agentDid: 'did:example:agent', repository: 'buyer/target-repo', brief: 'Fix the login bug' },
    new Date('2026-01-01T00:00:00Z'),
  );
  return {
    ...draft,
    status: 'submitted',
    confirmedSpecHash: 'sha256:spec',
    confirmedAt: new Date('2026-01-02T00:00:00Z'),
    priceUsd: '500.00',
    rail: 'abt',
    priceAcceptedByBuyer: true,
    priceAcceptedByAgent: true,
    criteria: [
      { text: 'Login works', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
      { text: 'Checkout works', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
    ],
    pullRequestUrl: 'https://github.com/buyer/target-repo/pull/1',
    submittedAt: new Date('2026-01-08T00:00:00Z'),
    deadline: new Date('2026-02-07T00:00:00Z'),
    stagedAt: new Date('2026-01-05T00:00:00Z'),
    stagedCommit: 'commit-1',
    ...overrides,
  };
}

describe('recordCitedClose: submitted -> cited_closed, cited, attributed to the buyer', () => {
  it('refuses at any status other than submitted', () => {
    const draft = createJob(
      { id: 'job_2', buyerDid: 'did:example:buyer', agentDid: 'did:example:agent', repository: 'buyer/target-repo', brief: 'Fix it' },
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(() =>
      recordCitedClose(draft, { criterionIndex: 0, reasonText: 'not fixed' }, new Date()),
    ).toThrow(JobTransitionError);
    const staged = submittedJob({ status: 'staged' });
    expect(() =>
      recordCitedClose(staged, { criterionIndex: 0, reasonText: 'not fixed' }, new Date()),
    ).toThrow(JobTransitionError);
  });

  it('refuses an index outside the confirmed criteria', () => {
    const job = submittedJob();
    expect(() => recordCitedClose(job, { criterionIndex: -1, reasonText: 'no' }, new Date())).toThrow(JobError);
    expect(() => recordCitedClose(job, { criterionIndex: 2, reasonText: 'no' }, new Date())).toThrow(JobError);
  });

  it('refuses an empty or whitespace-only reason: an empty string is not a sentence', () => {
    const job = submittedJob();
    expect(() => recordCitedClose(job, { criterionIndex: 0, reasonText: '' }, new Date())).toThrow(JobError);
    expect(() => recordCitedClose(job, { criterionIndex: 0, reasonText: '   ' }, new Date())).toThrow(JobError);
  });

  it('records the criterion, the reason, the buyer as author, and the instant', () => {
    const job = submittedJob();
    const now = new Date('2026-01-10T00:00:00Z');
    const closed = recordCitedClose(job, { criterionIndex: 1, reasonText: '  The checkout flow still fails.  ' }, now);
    expect(closed.status).toBe('cited_closed');
    expect(closed.citedCloseCriterionIndex).toBe(1);
    expect(closed.citedCloseReasonText).toBe('The checkout flow still fails.');
    expect(closed.citedCloseAuthorDid).toBe(job.buyerDid);
    expect(closed.citedCloseAt).toBe(now);
  });

  it('is not the platform\'s voice: the author is always the job\'s own buyerDid, never a caller-supplied field', () => {
    const job = submittedJob();
    const closed = recordCitedClose(job, { criterionIndex: 0, reasonText: 'bad work' }, new Date());
    expect(closed.citedCloseAuthorDid).toBe('did:example:buyer');
  });

  it('cannot be repeated: a cited_closed job has no edge back to cited_closed', () => {
    const job = submittedJob();
    const closed = recordCitedClose(job, { criterionIndex: 0, reasonText: 'bad work' }, new Date());
    expect(() => recordCitedClose(closed, { criterionIndex: 1, reasonText: 'again' }, new Date())).toThrow(
      JobTransitionError,
    );
  });
});

// Design record row 4's absorbed counter-demand: "no index means the clock
// keeps running and deemed completion fires." A buyer who closes the pull
// request on GitHub without calling this function (the merge route's own
// OBSERVATION path, recordClosedUnmerged) never reaches cited_closed, so
// this pins the fact for a job that took neither path: applyLapses (the
// same clock runner the API's applyLiveLapses drives) still deems it
// complete on schedule, exactly as if recordCitedClose had never existed.
describe('no cited close filed: applyLapses still deems the job complete on schedule', () => {
  it('a submitted job with no cited close and no merge deems complete 7+ days after submittedAt', () => {
    const job = submittedJob();
    const pastDeadline = new Date(job.submittedAt!.getTime() + 7 * 86_400_000 + 1000);
    const result = applyLapses(job, pastDeadline);
    expect(result.status).toBe('deemed_completed');
  });
});
