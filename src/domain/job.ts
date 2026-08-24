import { hashSpec } from './hashing.js';

// The hire loop as a state machine (MISSION.md, "The hire loop"). A job is
// opened as a draft from the buyer's brief, proposed once the criteria
// exchange starts, confirmed once the buyer accepts the agent's acceptance
// criteria, submitted when the agent opens a pull request, and completed when
// that pull request merges. Declined is reachable from any non-terminal
// state: a buyer can walk away, or the agent can pass.

export type JobStatus = 'draft' | 'proposed' | 'confirmed' | 'submitted' | 'completed' | 'declined';

const TERMINAL_STATUSES: readonly JobStatus[] = ['completed', 'declined'];

// One acceptance criterion of the exchange R-8 owns (ENT-6). A structured
// list, not free text (D2): each entry a single checkable sentence, either
// party may propose, and both must accept before confirm (that gate lives
// at confirm, R-9).
export interface Criterion {
  readonly text: string;
  readonly proposedBy: 'agent' | 'buyer';
  readonly accepted: boolean;
}

export interface Job {
  readonly id: string;
  readonly buyerDid: string;
  readonly agentDid: string;
  readonly repository: string;
  // The buyer's own prose for the work (ENT-4). Stored verbatim so a third
  // party holding it can recompute briefHash without calling this service.
  readonly brief: string;
  readonly briefHash: string;
  // The acceptance criteria as last proposed (ENT-6). Empty until the
  // exchange starts; replaced wholesale on every re-propose while proposed;
  // immutable once confirmed (D2). Raw text only: hashing is confirm's job.
  readonly criteria: Criterion[];
  readonly confirmedSpecHash: string | null;
  readonly status: JobStatus;
  readonly pullRequestUrl: string | null;
  // The observed outcome facts (ENT-7.1): written ONLY by completeJob, from
  // what github reported - never by a party's claim. Null until completion.
  readonly mergeCommit: string | null;
  readonly mergedAt: Date | null;
  readonly confirmedAt: Date | null;
  readonly submittedAt: Date | null;
  readonly createdAt: Date;
}

// Mirrors the CompletedJob row: the only thing a Credential or a Review may
// be issued against (see prisma/schema.prisma).
export interface CompletedJob {
  readonly id: string;
  readonly jobId: string;
  readonly buyerDid: string;
  readonly agentDid: string;
  readonly mergeCommit: string;
  readonly completedAt: Date;
}

// User-facing: the input was the buyer's to fix, not a system failure.
// The API layer (R-28) maps this to 400.
export class JobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobError';
  }
}

// Opens a job in draft from the buyer's brief. The brief is the verifiable
// fact of this record: briefHash is hashSpec of the brief as supplied, so
// anyone holding the prose can recompute it with off-the-shelf tools.
export function createJob(
  input: {
    readonly id: string;
    readonly buyerDid: string;
    readonly agentDid: string;
    readonly repository: string;
    readonly brief: string;
  },
  now: Date,
): Job {
  if (input.brief.trim() === '') {
    throw new JobError('a job needs a brief: what should the agent do?');
  }
  return {
    id: input.id,
    buyerDid: input.buyerDid,
    agentDid: input.agentDid,
    repository: input.repository,
    brief: input.brief,
    briefHash: hashSpec(input.brief),
    confirmedSpecHash: null,
    status: 'draft',
    criteria: [],
    pullRequestUrl: null,
    mergeCommit: null,
    mergedAt: null,
    confirmedAt: null,
    submittedAt: null,
    createdAt: now,
  };
}

export class JobTransitionError extends Error {
  constructor(from: JobStatus, action: string) {
    super(`cannot ${action} a job in status "${from}"`);
    this.name = 'JobTransitionError';
  }
}

/**
 * Validates that a job transition from one status to another is legal according to the hire loop
 * @param fromStatus - The current status of the job
 * @param toStatus - The intended next status of the job
 * @returns The toStatus if the transition is legal
 * @throws JobTransitionError if the transition is not allowed
 */
export function validateJobTransition(fromStatus: JobStatus, toStatus: JobStatus): JobStatus {
  // Terminal states cannot be transitioned from
  if (isTerminal(fromStatus)) {
    throw new JobTransitionError(fromStatus, `transition from "${fromStatus}"`);
  }
  
  // Valid transitions according to the hire loop
  // draft -> proposed is walked by the criteria exchange R-8 owns; this
  // table only records the edge.
  const validTransitions: Record<JobStatus, JobStatus[]> = {
    draft: ['proposed', 'declined'],
    proposed: ['confirmed', 'declined'],
    confirmed: ['submitted', 'declined'],
    submitted: ['completed', 'declined'],
    completed: [],
    declined: [],
  };
  
  const allowedTransitions = validTransitions[fromStatus];
  
  if (!allowedTransitions.includes(toStatus)) {
    throw new JobTransitionError(fromStatus, `transition to "${toStatus}"`);
  }
  
  return toStatus;
}

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

// Confirm computes specHash itself (ENT-4.2): a caller-supplied digest would
// let the wire disagree with what was agreed. The gates run after the
// transition check so wrong-status stays a state conflict, not content
// feedback (ASSUMPTIONS CONFIRM_GATE_STATUS).
export function confirmSpec(job: Job, now: Date): Job {
  validateJobTransition(job.status, 'confirmed');
  if (job.criteria.length === 0) {
    throw new JobError('confirm needs at least one acceptance criterion: nothing was agreed');
  }
  const outstanding = job.criteria.filter((criterion) => !criterion.accepted).length;
  if (outstanding > 0) {
    throw new JobError(
      `confirm needs every criterion accepted: ${outstanding} of ${job.criteria.length} outstanding`,
    );
  }
  // specHash pins WHAT WAS AGREED: the criteria texts in order, '\n'-joined,
  // through hashSpec's documented normalisation (\n endings, trailing
  // whitespace stripped per line, no trailing newline). Anyone holding the
  // criteria can recompute it with node:crypto alone - invariant 2. The
  // accepted flags are uniformly true here and proposedBy stays visible in
  // plaintext, so neither belongs in the digest.
  const specText = job.criteria.map((criterion) => criterion.text).join('\n');
  return { ...job, status: 'confirmed', confirmedSpecHash: hashSpec(specText), confirmedAt: now };
}

export function submitPullRequest(job: Job, pullRequestUrl: string, now: Date): Job {
  validateJobTransition(job.status, 'submitted');
  return { ...job, status: 'submitted', pullRequestUrl, submittedAt: now };
}

// The only path to a CompletedJob. Its buyerDid and agentDid are copied from
// the job, never taken as separate input, so this function cannot produce a
// CompletedJob whose parties disagree with the job it completes.
export function completeJob(
  job: Job,
  input: { readonly mergeCommit: string; readonly completedAt: Date },
): { readonly job: Job; readonly completedJob: Omit<CompletedJob, 'id'> } {
  validateJobTransition(job.status, 'completed');
  return {
    // The merge facts are stamped here and nowhere else, mirroring how
    // confirmSpec owns confirmedSpecHash/confirmedAt: one writer writes the
    // pair, so a job's projection can never disagree with its anchor row.
    job: { ...job, status: 'completed', mergeCommit: input.mergeCommit, mergedAt: input.completedAt },
    completedJob: {
      jobId: job.id,
      buyerDid: job.buyerDid,
      agentDid: job.agentDid,
      mergeCommit: input.mergeCommit,
      completedAt: input.completedAt,
    },
  };
}

export function decline(job: Job): Job {
  validateJobTransition(job.status, 'declined');
  return { ...job, status: 'declined' };
}

// The acceptance-criteria exchange R-8 owns (ENT-6, D2). The first propose
// walks draft -> proposed, the edge the transition table already records;
// every later one replaces the whole list while staying in proposed.
export function proposeCriteria(
  job: Job,
  input: ReadonlyArray<{ readonly text: string; readonly proposedBy: string }>,
): Job {
  if (input.length === 0) {
    throw new JobError('a proposal needs at least one acceptance criterion');
  }
  const criteria: Criterion[] = input.map((criterion) => {
    if (typeof criterion.text !== 'string' || criterion.text.trim() === '') {
      throw new JobError('every criterion needs non-empty text: what can be checked against it?');
    }
    if (criterion.proposedBy !== 'agent' && criterion.proposedBy !== 'buyer') {
      throw new JobError('proposedBy must be "agent" or "buyer"');
    }
    return { text: criterion.text.trim(), proposedBy: criterion.proposedBy, accepted: false };
  });
  if (job.status === 'draft') {
    validateJobTransition(job.status, 'proposed');
    return { ...job, status: 'proposed', criteria };
  }
  if (job.status === 'proposed') {
    // proposed -> proposed is not a legal transition, and looping must not
    // invent one: a re-propose replaces the list in place, same status,
    // same job. Only the first propose crosses the validator.
    return { ...job, criteria };
  }
  throw new JobTransitionError(job.status, 'propose criteria for');
}

// The buyer's pushback: every acceptance flag resets, so nothing counts as
// agreed across a change request. Same id, same status, same texts - the
// next proposeCriteria replaces the list wholesale.
export function requestChanges(job: Job): Job {
  if (job.status !== 'proposed') {
    throw new JobTransitionError(job.status, 'request changes on');
  }
  return {
    ...job,
    criteria: job.criteria.map((criterion) => ({ ...criterion, accepted: false })),
  };
}

// One party accepts one criterion. Domain-only until confirm (R-9) enforces
// the both-parties gate; idempotent on an already-accepted entry.
export function acceptCriterion(job: Job, index: number): Job {
  if (job.status !== 'proposed') {
    throw new JobTransitionError(job.status, 'accept a criterion on');
  }
  if (!Number.isInteger(index) || index < 0 || index >= job.criteria.length) {
    throw new JobError(`no criterion at index ${index}`);
  }
  return {
    ...job,
    criteria: job.criteria.map((criterion, i) => (i === index ? { ...criterion, accepted: true } : criterion)),
  };
}
