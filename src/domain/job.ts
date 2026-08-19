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

function assertStatus(job: Job, expected: JobStatus, action: string): void {
  if (job.status !== expected) {
    throw new JobTransitionError(job.status, action);
  }
}

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function confirmSpec(job: Job, confirmedSpecHash: string, now: Date): Job {
  assertStatus(job, 'proposed', 'confirm the spec of');
  return { ...job, status: 'confirmed', confirmedSpecHash, confirmedAt: now };
}

export function submitPullRequest(job: Job, pullRequestUrl: string, now: Date): Job {
  assertStatus(job, 'confirmed', 'submit a pull request for');
  return { ...job, status: 'submitted', pullRequestUrl, submittedAt: now };
}

// The only path to a CompletedJob. Its buyerDid and agentDid are copied from
// the job, never taken as separate input, so this function cannot produce a
// CompletedJob whose parties disagree with the job it completes.
export function completeJob(
  job: Job,
  input: { readonly mergeCommit: string; readonly completedAt: Date },
): { readonly job: Job; readonly completedJob: Omit<CompletedJob, 'id'> } {
  assertStatus(job, 'submitted', 'complete');
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
  if (isTerminal(job.status)) {
    throw new JobTransitionError(job.status, 'decline');
  }
  return { ...job, status: 'declined' };
}
