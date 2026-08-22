import { hashSpec } from './hashing.js';

// The hire loop as a state machine (MISSION.md, "The hire loop"). A job is
// opened as a draft from the buyer's brief, proposed once the criteria
// exchange starts, confirmed once the buyer accepts the agent's acceptance
// criteria, submitted when the agent opens a pull request, and completed when
// that pull request merges. Declined is reachable from any non-terminal
// state: a buyer can walk away, or the agent can pass.

export type JobStatus = 'draft' | 'proposed' | 'confirmed' | 'submitted' | 'completed' | 'declined';

const TERMINAL_STATUSES: readonly JobStatus[] = ['completed', 'declined'];

export interface Job {
  readonly id: string;
  readonly buyerDid: string;
  readonly agentDid: string;
  readonly repository: string;
  // The buyer's own prose for the work (ENT-4). Stored verbatim so a third
  // party holding it can recompute briefHash without calling this service.
  readonly brief: string;
  readonly briefHash: string;
  readonly confirmedSpecHash: string | null;
  readonly status: JobStatus;
  readonly pullRequestUrl: string | null;
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
    pullRequestUrl: null,
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

export function confirmSpec(job: Job, confirmedSpecHash: string, now: Date): Job {
  validateJobTransition(job.status, 'confirmed');
  return { ...job, status: 'confirmed', confirmedSpecHash, confirmedAt: now };
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
    job: { ...job, status: 'completed' },
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
