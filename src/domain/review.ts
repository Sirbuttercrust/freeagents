// R-22 (ENT-10, issue 29): a review is text welded to a completed hire. The
// anchor this file exists to hold: only a buyer who paid for and received
// the work may say anything about it, and what they say never becomes a
// number.
//
// Eligibility is proven, not claimed (rule 1 of the card): the caller hands
// in the job record itself and the identity the route already verified
// (session or R-34 signature), never a field the request asserted. The
// route's job is to load that record and that identity honestly; this
// module's job is to refuse anything short of an exact match.
import type { Job } from './job.js';

export interface Review {
  readonly jobId: string;
  readonly authorDid: string; // the buyer, proven, never a caller-supplied field
  readonly agentDid: string; // copied from the job, never taken as separate input
  readonly text: string;
  readonly createdAt: Date;
}

// The job is not completed. Not closed_unmerged, not stale, not any
// non-terminal status: ENT-10.1 names exactly one state a review may cite.
export class JobNotReviewableError extends Error {
  constructor(status: string) {
    super(`cannot review a job in status "${status}"; a review requires a completed hire`);
    this.name = 'JobNotReviewableError';
  }
}

// The caller's proven identity is not this job's buyer. Refused before the
// agent is even compared, because a stranger with no stake in the hire has
// nothing to say about it regardless of which agent they name.
export class ReviewerNotBuyerError extends Error {
  constructor() {
    super('only the buyer on this job may write a review for it');
    this.name = 'ReviewerNotBuyerError';
  }
}

// The caller named an agent that is not the one this job actually hired.
// The job record decides which agent a review may be written against; a
// caller-supplied agentDid that disagrees with it is refused, never
// reconciled or silently corrected.
export class ReviewAgentMismatchError extends Error {
  constructor() {
    super('this job was not hired against the named agent');
    this.name = 'ReviewAgentMismatchError';
  }
}

// Rule 1 of the card, made executable: a review may only be written by the
// buyer DID on a job whose status is completed against that exact agent.
// The check reads the job record (status, buyerDid, agentDid); it never
// trusts a field on the request. Status is checked first, so a job that
// never completed refuses the same way for every caller, proven or not,
// rather than leaking through the identity check first.
export function assertReviewEligible(
  job: Job,
  claimedIdentity: { readonly buyerDid: string; readonly agentDid: string },
): void {
  if (job.status !== 'completed') {
    throw new JobNotReviewableError(job.status);
  }
  if (claimedIdentity.buyerDid !== job.buyerDid) {
    throw new ReviewerNotBuyerError();
  }
  if (claimedIdentity.agentDid !== job.agentDid) {
    throw new ReviewAgentMismatchError();
  }
}

// Total: any value in, one boolean out, never throws, the same totality
// reportWellFormed and rotationWellFormed hold to elsewhere in this domain.
export function reviewTextWellFormed(text: unknown): boolean {
  return typeof text === 'string' && text.trim().length > 0;
}

// The only constructor of a Review. jobId and agentDid are copied from the
// job the caller already proved eligible against (assertReviewEligible),
// never taken as separate input, so a built review cannot name a job or an
// agent other than the one it was checked against. No rating parameter
// exists to pass (ENT-10.2): the type has nowhere to put one.
export function buildReview(
  job: Job,
  input: { readonly authorDid: string; readonly text: string },
  now: Date,
): Review {
  return {
    jobId: job.id,
    authorDid: input.authorDid,
    agentDid: job.agentDid,
    text: input.text.trim(),
    createdAt: now,
  };
}
