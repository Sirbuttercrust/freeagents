// P8m: the pure bucketing rule behind My jobs (P-16). MISSION.md's own
// anchor for this screen ("A signed-in buyer opens one page and sees
// every hire they have made, what state each one is in") needs one place
// where a JobStatus becomes one of the four labels the wireframe's chips
// use, so the route and the page never carry two competing ideas of what
// "waiting on you" means.
//
// No vendor import, no Express type (brief scope item 4): this file is
// importable from a test with nothing but src/domain/job.ts's own
// JobStatus type, the same "adapters may import domain, never the
// reverse" rule every other domain file in this directory keeps.
//
// TOTAL OVER THE ENUM. A switch with no default, plus the exhaustiveness
// check at the bottom, is what turns a seventeenth JobStatus into a
// compile error here rather than a status that silently never appears in
// anyone's list (the brief's own words: "a switch with no default plus
// an exhaustiveness check is what makes a sixteenth status a typecheck
// failure rather than a silently missing row" -- job.ts:31-47 already
// declares sixteen values today, not the fifteen the brief's prose
// counts; the code is ground truth, named here as a handoff departure).
import type { JobStatus } from './job.js';

export type JobListBucket = 'waitingOnYou' | 'inProgress' | 'shipped' | 'notShipped' | 'notReal';

// Every JobStatus the domain declares (src/domain/job.ts:31-47), listed
// once here so a test can assert this bucketing function is actually
// total over the real enum rather than over a hand-copied guess of it.
// Kept as a value (not derived from the type, which TypeScript erases at
// runtime) and pinned to job.ts's own count by the domain test that
// exercises this list.
export const ALL_JOB_STATUSES: readonly JobStatus[] = [
  'draft',
  'proposed',
  'confirmed',
  'staged',
  'redo_requested',
  'submitted',
  'completed',
  'declined',
  'closed_unmerged',
  'stale',
  'withdrawn',
  'staged_declined',
  'closed_unpaid',
  'expired_unstaged',
  'deemed_completed',
  'cited_closed',
];

function assertNever(status: never): never {
  throw new Error(`jobListBucketOf: unhandled JobStatus ${String(status)}`);
}

// The bucketing table the brief's own scope item 4 states verbatim.
// draft and proposed map to notReal, a fifth value distinct from the
// four the wireframe's chips render: ENT-4.1 (no job exists before the
// buyer confirms), so the route filters notReal rows out before this
// function's other four values ever reach the page, and the exclusion
// is expressed once, here, instead of once in the route and once again
// in the page.
export function jobListBucketOf(status: JobStatus): JobListBucket {
  switch (status) {
    case 'draft':
    case 'proposed':
      return 'notReal';
    // At staged the buyer pays the balance, asks for the redo, or
    // declines (P8j, P8k); at submitted the cited close is theirs alone
    // (P8l). Both are the buyer's own move to make.
    case 'staged':
    case 'submitted':
      return 'waitingOnYou';
    // At confirmed and redo_requested the next move belongs to the
    // operator (staging the work, or answering the redo), so these are
    // in progress, not waiting on the buyer.
    case 'confirmed':
    case 'redo_requested':
      return 'inProgress';
    case 'completed':
    case 'deemed_completed':
      return 'shipped';
    case 'declined':
    case 'closed_unmerged':
    case 'stale':
    case 'withdrawn':
    case 'staged_declined':
    case 'closed_unpaid':
    case 'expired_unstaged':
    case 'cited_closed':
      return 'notShipped';
    default:
      return assertNever(status);
  }
}

// The one date each status is about (done-means item 1): the instant the
// domain's own one-writer field for that status was written, never a
// borrowed field from an unrelated transition. null when a status
// carries no dedicated timestamp of its own (declined, closed_unmerged,
// stale, withdrawn, staged_declined, closed_unpaid, expired_unstaged all
// have no field job.ts writes specifically for reaching them): the page
// renders nothing rather than a guessed or reused date
// (unverified-state-claim, the defect line this brief names).
export interface JobListDateFacts {
  readonly status: JobStatus;
  readonly stagedAt: Date | null;
  readonly submittedAt: Date | null;
  readonly confirmedAt: Date | null;
  readonly redoRequestedAt: Date | null;
  readonly mergedAt: Date | null;
  readonly deemedCompletedAt: Date | null;
  readonly citedCloseAt: Date | null;
}

export function jobListDateOf(job: JobListDateFacts): Date | null {
  switch (job.status) {
    case 'staged':
      return job.stagedAt;
    case 'submitted':
      return job.submittedAt;
    case 'confirmed':
      return job.confirmedAt;
    case 'redo_requested':
      return job.redoRequestedAt;
    case 'completed':
      return job.mergedAt;
    case 'deemed_completed':
      return job.deemedCompletedAt;
    case 'cited_closed':
      return job.citedCloseAt;
    case 'draft':
    case 'proposed':
    case 'declined':
    case 'closed_unmerged':
    case 'stale':
    case 'withdrawn':
    case 'staged_declined':
    case 'closed_unpaid':
    case 'expired_unstaged':
      return null;
    default:
      return assertNever(job.status);
  }
}
