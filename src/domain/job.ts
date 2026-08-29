import { hashSpec } from './hashing.js';

// The hire loop as a state machine (MISSION.md, "The hire loop"). A job is
// opened as a draft from the buyer's brief, proposed once the criteria
// exchange starts, confirmed once the buyer accepts the agent's acceptance
// criteria, submitted when the agent opens a pull request, and completed when
// that pull request merges. Declined is reachable from any non-terminal
// state: a buyer can walk away, or the agent can pass. Withdrawn is
// likewise reachable from any non-terminal state (R-31, D3 2026-08-22): a
// buyer walk-away recorded as a timing fact, and terminal - a withdrawn job
// has no further outcomes to observe.

export type JobStatus =
  | 'draft'
  | 'proposed'
  | 'confirmed'
  | 'submitted'
  | 'completed'
  | 'declined'
  | 'closed_unmerged'
  | 'stale'
  | 'withdrawn';

const TERMINAL_STATUSES: readonly JobStatus[] = [
  'completed',
  'declined',
  'closed_unmerged',
  'withdrawn',
];

// A party to the hire loop: whoever is doing the accepting. Named apart
// from Criterion.proposedBy on purpose, even though it takes the same two
// values - proposedBy records who WROTE a line, acceptedByBuyer /
// acceptedByAgent record who has AGREED to it, and those are independent
// facts (the proposer of a line has not thereby accepted it; see
// proposeCriteria below, which leaves a fresh line unaccepted by both).
export type Party = 'buyer' | 'agent';

// One acceptance criterion of the exchange R-8 owns (ENT-6). A structured
// list, not free text (D2): each entry a single checkable sentence, either
// party may propose it, and both must accept before confirm (ENT-6.2). A
// single accepted flag cannot record two independent parties agreeing, so
// acceptance is tracked per party; acceptCriterion sets exactly one of
// these two, never both, and confirmSpec requires both true on every line.
// Identity here comes from the caller the route layer resolves
// (src/api/app.ts's runExchange), not from a cryptographic signature over
// the text: R-34 (DID-signed requests) is where a per-party signature over
// the criterion text would eventually replace this boolean pair, and that
// upgrade seam is exactly these two fields.
export interface Criterion {
  readonly text: string;
  readonly proposedBy: 'agent' | 'buyer';
  readonly acceptedByBuyer: boolean;
  readonly acceptedByAgent: boolean;
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
  // The instant the pull request goes stale (R-12, D3 2026-08-22): written
  // by submitPullRequest as submittedAt + STALE_AFTER_DAYS, null until
  // submitted and for rows written before R-12.
  readonly deadline: Date | null;
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
    deadline: null,
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
    draft: ['proposed', 'declined', 'withdrawn'],
    proposed: ['confirmed', 'declined', 'withdrawn'],
    confirmed: ['submitted', 'declined', 'withdrawn'],
    // R-12 (ENT-7.2): non-merge outcomes are recorded, not hidden. The
    // stale -> closed_unmerged edge is legal (R-31): an outcome update
    // after stale, not a new state.
    submitted: ['completed', 'closed_unmerged', 'stale', 'declined', 'withdrawn'],
    stale: ['completed', 'closed_unmerged', 'declined', 'withdrawn'],
    closed_unmerged: [],
    completed: [],
    declined: [],
    withdrawn: [],
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
// feedback (ASSUMPTIONS CONFIRM_GATE_STATUS). ENT-6.2's rule, enforced: a
// criterion counts as agreed only once BOTH acceptedByBuyer and
// acceptedByAgent are true, so one party accepting every line is refused
// here exactly like an unaccepted line would be.
export function confirmSpec(job: Job, now: Date): Job {
  validateJobTransition(job.status, 'confirmed');
  if (job.criteria.length === 0) {
    throw new JobError('confirm needs at least one acceptance criterion: nothing was agreed');
  }
  const outstanding = job.criteria.filter(
    (criterion) => !criterion.acceptedByBuyer || !criterion.acceptedByAgent,
  ).length;
  if (outstanding > 0) {
    throw new JobError(
      `confirm needs every criterion accepted by both parties: ${outstanding} of ${job.criteria.length} outstanding`,
    );
  }
  // specHash pins WHAT WAS AGREED: the criteria texts in order, '\n'-joined,
  // through hashSpec's documented normalisation (\n endings, trailing
  // whitespace stripped per line, no trailing newline). Anyone holding the
  // criteria can recompute it with node:crypto alone - invariant 2. The
  // acceptance flags are uniformly true here and proposedBy stays visible in
  // plaintext, so neither belongs in the digest.
  const specText = job.criteria.map((criterion) => criterion.text).join('\n');
  return { ...job, status: 'confirmed', confirmedSpecHash: hashSpec(specText), confirmedAt: now };
}

// The instant an unmerged pull request goes stale, in days (D3
// 2026-08-22: 30 days from submission).
export const STALE_AFTER_DAYS = 30;

export function submitPullRequest(job: Job, pullRequestUrl: string, now: Date): Job {
  validateJobTransition(job.status, 'submitted');
  return {
    // submittedAt and deadline are one pair with one writer (R-12): the
    // submission instant and the instant the pull request goes stale.
    ...job,
    status: 'submitted',
    pullRequestUrl,
    submittedAt: now,
    deadline: new Date(now.getTime() + STALE_AFTER_DAYS * 86_400_000),
  };
}

// Records that the pull request closed without merging (R-12, ENT-7.2):
// the outcome is recorded, not hidden. No new timestamp: the status IS the
// outcome; the observation instant is not a third-party-verifiable fact the
// way mergedAt (GitHub's) is.
export function recordClosedUnmerged(job: Job): Job {
  validateJobTransition(job.status, 'closed_unmerged');
  return { ...job, status: 'closed_unmerged' };
}

// Records that the pull request went stale past its deadline (R-12, ENT-7.2).
// Deliberately non-terminal: a merge after the stale marker still completes
// the job (D3 2026-08-22).
export function recordStale(job: Job): Job {
  validateJobTransition(job.status, 'stale');
  return { ...job, status: 'stale' };
}

// Records that the buyer withdrew the job (R-31, D3 2026-08-22): a
// timing fact, never a judgement of the work. Terminal: a withdrawn
// job has no further outcomes to observe.
export function recordWithdrawn(job: Job): Job {
  validateJobTransition(job.status, 'withdrawn');
  return { ...job, status: 'withdrawn' };
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
// every later one revises the list while staying in proposed.
//
// Re-propose is a DIFF against the stored list, not a wholesale replace
// (Keaton, 2026-08-29: "editing one line resets only that line"). A new
// entry is matched against the CURRENT criteria by exact trimmed text: an
// unchanged line keeps whatever acceptedByBuyer/acceptedByAgent it already
// carried, because nothing about it changed. A line whose text differs from
// every current entry - whether it is a genuinely new criterion or an edit
// of an existing one - has no honest way to tell those two cases apart from
// the text alone, and BOTH cases mean the parties have not agreed on this
// exact wording yet, so both start unaccepted by both parties. Removing a
// criterion (striking it) is simply not carrying its text into the new
// list; it disappears, and every other line's match (and therefore its
// acceptance) is untouched, which is the "neighbouring acceptances" this
// issue asked to be decided. Each stored entry is consumed by at most one
// match, so two lines with identical text cannot both inherit the same
// acceptance history.
export function proposeCriteria(
  job: Job,
  input: ReadonlyArray<{ readonly text: string; readonly proposedBy: string }>,
): Job {
  if (input.length === 0) {
    throw new JobError('a proposal needs at least one acceptance criterion');
  }
  const pool = [...job.criteria];
  const consumed = new Set<number>();
  const criteria: Criterion[] = input.map((criterion) => {
    if (typeof criterion.text !== 'string' || criterion.text.trim() === '') {
      throw new JobError('every criterion needs non-empty text: what can be checked against it?');
    }
    if (criterion.proposedBy !== 'agent' && criterion.proposedBy !== 'buyer') {
      throw new JobError('proposedBy must be "agent" or "buyer"');
    }
    const text = criterion.text.trim();
    const matchIndex = pool.findIndex((existing, i) => !consumed.has(i) && existing.text === text);
    if (matchIndex === -1) {
      return { text, proposedBy: criterion.proposedBy, acceptedByBuyer: false, acceptedByAgent: false };
    }
    consumed.add(matchIndex);
    const existing = pool[matchIndex];
    return {
      text,
      proposedBy: criterion.proposedBy,
      acceptedByBuyer: existing?.acceptedByBuyer ?? false,
      acceptedByAgent: existing?.acceptedByAgent ?? false,
    };
  });
  if (job.status === 'draft') {
    validateJobTransition(job.status, 'proposed');
    return { ...job, status: 'proposed', criteria };
  }
  if (job.status === 'proposed') {
    // proposed -> proposed is not a legal transition, and looping must not
    // invent one: a re-propose revises the list in place, same status,
    // same job. Only the first propose crosses the validator.
    return { ...job, criteria };
  }
  throw new JobTransitionError(job.status, 'propose criteria for');
}

// The buyer's pushback: a bodyless signal that carries no criterion text of
// its own, so it cannot target one line the way a re-propose can. Once
// editing moved to per-criterion diffing (see proposeCriteria below), a
// blanket reset here would undo the very thing that change fixes: Keaton's
// 2026-08-29 review named exactly this - "requestChanges resets every
// acceptance on the job, which punishes a long spec for a one-word fix".
// requestChanges therefore does the only honest thing left for a route with
// no target: it validates the job is still open for negotiation and returns
// it UNCHANGED. The actual edit, and the actual per-criterion reset, happens
// when the agent or buyer calls POST /jobs/:jobId/criteria with revised
// text.
export function requestChanges(job: Job): Job {
  if (job.status !== 'proposed') {
    throw new JobTransitionError(job.status, 'request changes on');
  }
  return job;
}

// One party accepts one criterion. Domain-only until confirm (R-9) enforces
// the both-parties gate (ENT-6.2); idempotent per party on an
// already-accepted entry, and independent of the OTHER party's flag: the
// buyer accepting a line the agent already accepted does not touch the
// agent's flag, and vice versa.
export function acceptCriterion(job: Job, index: number, party: Party): Job {
  if (job.status !== 'proposed') {
    throw new JobTransitionError(job.status, 'accept a criterion on');
  }
  if (!Number.isInteger(index) || index < 0 || index >= job.criteria.length) {
    throw new JobError(`no criterion at index ${index}`);
  }
  return {
    ...job,
    criteria: job.criteria.map((criterion, i) => {
      if (i !== index) return criterion;
      return party === 'buyer'
        ? { ...criterion, acceptedByBuyer: true }
        : { ...criterion, acceptedByAgent: true };
    }),
  };
}
