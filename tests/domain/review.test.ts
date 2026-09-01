// R-22 (ENT-10, issue 29): a review is text welded to a completed hire.
// This file holds the domain rules only: eligibility (reads the job record,
// never trusts a caller-supplied field) and the shape of the review itself.
// The old isValidRating star-rating check is deleted, not weakened: ENT-10.2
// forbids a numeric review value anywhere, and a rating field was never
// wired to any route, so nothing regresses by removing it.
import { describe, expect, it } from 'vitest';
import type { Job, JobStatus } from '../../src/domain/job.js';
import { createJob } from '../../src/domain/job.js';
import {
  assertReviewEligible,
  buildReview,
  JobNotReviewableError,
  ReviewAgentMismatchError,
  ReviewerNotBuyerError,
  reviewTextWellFormed,
  type Review,
} from '../../src/domain/review.js';

const BUYER_DID = 'did:example:buyer';
const AGENT_DID = 'did:example:agent';
const OTHER_AGENT_DID = 'did:example:other-agent';

function job(overrides: Partial<Job> = {}): Job {
  return {
    ...createJob(
      { id: 'job-1', buyerDid: BUYER_DID, agentDid: AGENT_DID, repository: 'buyer/target-repo', brief: 'Fix the login bug' },
      new Date('2026-01-01T00:00:00Z'),
    ),
    status: 'completed',
    mergeCommit: 'deadbeef',
    mergedAt: new Date('2026-01-03T00:00:00Z'),
    ...overrides,
  };
}

describe('assertReviewEligible', () => {
  it('does not throw for a completed job reviewed by its actual buyer, naming its actual agent', () => {
    expect(() => assertReviewEligible(job(), { buyerDid: BUYER_DID, agentDid: AGENT_DID })).not.toThrow();
  });

  const NON_COMPLETED_STATUSES: readonly JobStatus[] = [
    'draft',
    'proposed',
    'confirmed',
    'submitted',
    'declined',
    'closed_unmerged',
    'stale',
    'withdrawn',
  ];

  it.each(NON_COMPLETED_STATUSES)('refuses a job in status "%s": no completed hire', (status) => {
    const err = ((): unknown => {
      try {
        assertReviewEligible(job({ status }), { buyerDid: BUYER_DID, agentDid: AGENT_DID });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(JobNotReviewableError);
    expect((err as Error).message).toContain(status);
  });

  it('refuses a caller whose proven identity is not the job\'s buyer', () => {
    const err = ((): unknown => {
      try {
        assertReviewEligible(job(), { buyerDid: 'did:example:stranger', agentDid: AGENT_DID });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ReviewerNotBuyerError);
  });

  it('refuses a hire against a different agent: the job read from storage decides, never the caller', () => {
    const err = ((): unknown => {
      try {
        assertReviewEligible(job(), { buyerDid: BUYER_DID, agentDid: OTHER_AGENT_DID });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ReviewAgentMismatchError);
  });

  it('checks status before identity: a non-completed job refuses with JobNotReviewableError even for a stranger', () => {
    const err = ((): unknown => {
      try {
        assertReviewEligible(job({ status: 'stale' }), { buyerDid: 'did:example:stranger', agentDid: OTHER_AGENT_DID });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(JobNotReviewableError);
  });
});

describe('reviewTextWellFormed', () => {
  it('accepts non-empty text', () => {
    expect(reviewTextWellFormed('Delivered exactly what was agreed.')).toBe(true);
  });

  it('rejects an empty string, whitespace-only text, and non-strings', () => {
    expect(reviewTextWellFormed('')).toBe(false);
    expect(reviewTextWellFormed('   ')).toBe(false);
    expect(reviewTextWellFormed(5)).toBe(false);
    expect(reviewTextWellFormed(null)).toBe(false);
    expect(reviewTextWellFormed(undefined)).toBe(false);
  });
});

describe('buildReview', () => {
  it('binds the review to the job id and its agent, trims the text, and stamps the given instant', () => {
    const now = new Date('2026-01-04T00:00:00Z');
    const review: Review = buildReview(job(), { authorDid: BUYER_DID, text: '  Great work, shipped fast.  ' }, now);

    expect(review).toEqual({
      jobId: 'job-1',
      authorDid: BUYER_DID,
      agentDid: AGENT_DID,
      text: 'Great work, shipped fast.',
      createdAt: now,
    });
  });

  it('carries no numeric field anywhere on the returned object (ENT-10.2)', () => {
    const review = buildReview(job(), { authorDid: BUYER_DID, text: 'Solid.' }, new Date());
    for (const value of Object.values(review)) {
      expect(typeof value).not.toBe('number');
    }
  });
});
