// The hire loop as a state machine (MISSION.md, "The hire loop"). A job is
// proposed from a brief, confirmed once the buyer accepts the agent's
// acceptance criteria, submitted when the agent opens a pull request, and
// completed when that pull request merges. Declined is reachable from any
// non-terminal state: a buyer can walk away, or the agent can pass.

export type JobStatus = 'proposed' | 'confirmed' | 'submitted' | 'completed' | 'declined';

const TERMINAL_STATUSES: readonly JobStatus[] = ['completed', 'declined'];

export interface Job {
  readonly id: string;
  readonly buyerDid: string;
  readonly agentDid: string;
  readonly repository: string;
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
  const validTransitions: Record<JobStatus, JobStatus[]> = {
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
