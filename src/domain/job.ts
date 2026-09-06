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

// P4 (design record, 2026-09-01): five new statuses for the payment state
// machine. `staged` sits between an agreed price and an opened pull
// request -- the work lives in a staging repository with a published
// attestation, unpaid and unseen, so unpaid work never becomes visible.
// The other four are terminal outcomes the two clocks and the buyer's
// staged-time choices can reach: see the transition table on
// validateJobTransition below for exactly which edges reach each one.
// P6 (design record, 2026-09-01, rows 2 and 4): two more statuses.
// `redo_requested` sits between `staged` and `staged` again -- the buyer
// has asked for a redo and the operator has not yet answered; it is
// non-terminal because both its edges (accept via stageWork, refuse via
// refuseRedo) lead back into the loop. `cited_closed` is terminal: the
// buyer's deliberate, reasoned close after paying, distinct from
// closed_unmerged (the merge route's OBSERVATION of a closed PR with no
// reason attached) because a reader must be able to tell "the buyer chose
// to stop, on the record, citing a reason" from "GitHub reports this PR
// closed" without inspecting a second field. See recordCitedClose's own
// header comment for why the two never share one status.
export type JobStatus =
  | 'draft'
  | 'proposed'
  | 'confirmed'
  | 'staged'
  | 'redo_requested'
  | 'submitted'
  | 'completed'
  | 'declined'
  | 'closed_unmerged'
  | 'stale'
  | 'withdrawn'
  | 'staged_declined'
  | 'closed_unpaid'
  | 'expired_unstaged'
  | 'deemed_completed'
  | 'cited_closed';

const TERMINAL_STATUSES: readonly JobStatus[] = [
  'completed',
  'declined',
  'closed_unmerged',
  'withdrawn',
  // P4 terminal outcomes (design record, 2026-09-01): a buyer who declines
  // staged work, a job the buyer went silent on at staged, a confirmed job
  // nobody ever staged, and a paid job nobody merged or closed in time,
  // are each a distinct closed fact, not a variant of an existing one.
  'staged_declined',
  'closed_unpaid',
  'expired_unstaged',
  'deemed_completed',
  // P6: the buyer's deliberate, reasoned close after paying. Terminal like
  // every other closed outcome above -- once made, it cannot be walked back.
  'cited_closed',
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

// The rail that settles the price: which token the agreed dollar figure
// gets paid in. Fixed to two values for v1 (P1 brief); the price itself is
// always one number in dollars, whatever token settles it.
export type Rail = 'abt' | 'usdc';

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
  // P1: the agreed price, one number in dollars, whatever token settles it.
  // A decimal string with exactly two places, never a float (a JS number
  // cannot hold a decimal amount exactly). Null until the agent proposes
  // one alongside the criteria.
  readonly priceUsd: string | null;
  readonly rail: Rail | null;
  // Accepting the price is a line in the agreement like any criterion: both
  // parties accept it, tracked as an independent pair exactly like
  // Criterion.acceptedByBuyer / acceptedByAgent (ENT-6.2's own pattern).
  readonly priceAcceptedByBuyer: boolean;
  readonly priceAcceptedByAgent: boolean;
  // Fixed for v1, not caller-settable: the field exists so the digest
  // carries it and a later card can open it (P1 brief, scope item 1).
  readonly depositPercent: number;
  readonly redoAllowance: number;
  // P6: how many redos this job has consumed. Compared against
  // redoAllowance by requestRedo; never decremented back down by a
  // refusal or by anything else (design record row 2: "the allowance is
  // not refunded by a refusal").
  readonly redoUsedCount: number;
  // P6: the redo currently awaiting the operator's answer, at
  // redo_requested. All three null outside that window; written together
  // by requestRedo, the same one-writer pairing confirmSpec keeps.
  readonly redoRequestedCriterionIndex: number | null;
  readonly redoRequestedAt: Date | null;
  // P6: the instant the operator refused the redo, null until a refusal
  // happens. Distinct from redoRequestedAt (which survives a refusal, so
  // the buyer's record shows what was asked) and never cleared once set,
  // because it is exactly the fact the design record's surviving attack
  // (prepayment farming, refusing every redo) makes visible.
  readonly redoRefusedAt: Date | null;
  // P6: the accumulated extension to the staged lapse deadline from every
  // accepted redo, in days, added to LAPSE_AT_STAGED_AFTER_DAYS by
  // lapseAtStaged. A stored fact rather than a recomputation from
  // redoUsedCount, so a future redo shape (e.g. a variable extension)
  // does not have to touch this field's meaning.
  readonly stagedLapseExtensionDays: number;
  // Agent-proposed, default 14 days, set alongside the price.
  readonly deliveryWindowDays: number | null;
  readonly confirmedSpecHash: string | null;
  readonly status: JobStatus;
  readonly pullRequestUrl: string | null;
  // The observed outcome facts (ENT-7.1): written ONLY by completeJob, from
  // what github reported - never by a party's claim. Null until completion.
  readonly mergeCommit: string | null;
  readonly mergedAt: Date | null;
  readonly confirmedAt: Date | null;
  readonly submittedAt: Date | null;
  // P4: the instant the agent staged the work (confirmed -> staged) and
  // the commit SHA it staged, in the staging repository the attestation
  // (a later card) will publish against. Both null until staged; written
  // together by stageWork, the same one-writer pairing confirmSpec keeps
  // for confirmedSpecHash/confirmedAt.
  readonly stagedAt: Date | null;
  readonly stagedCommit: string | null;
  // B14a: the platform-created repository the staged commit lives in
  // (owner/repo under the platform account), and the base commit the
  // platform pinned when it created that repository. Both null until the
  // repository exists (confirm creates it -- see the API route's own
  // header comment). baseCommit is distinct from stagedCommit: baseCommit
  // is the seed the repository was created from, stagedCommit (above) is
  // whatever the agent has staged since, and the stage route walks from
  // one to the other (bounded ancestry check) to prove a staged commit
  // actually descends from what the platform pinned.
  readonly stagingRepo: { readonly owner: string; readonly repo: string } | null;
  readonly baseCommit: string | null;
  // B14a scope item 5: the cleanup policy, RECORDED not built -- this
  // field is set by a later sweep card, never by anything in this card.
  // Null outside a terminal status; computeStagingRepoDeleteAfter below
  // is the domain function that computes the value a terminal-transition
  // caller would write, but no transition function in this file calls it
  // (the card's own instruction: "never delete in this card", extended
  // here to "never even schedule deletion automatically" until the sweep
  // card exists to honour the field).
  readonly stagingRepoDeleteAfter: Date | null;
  // P6: the buyer's deliberate, reasoned close after paying (cited_closed).
  // All four null outside that status; written together by
  // recordCitedClose, the same one-writer pairing every other terminal
  // fact in this file keeps. citedCloseAuthorDid is always the job's own
  // buyerDid (recordCitedClose copies it, never takes it as a separate
  // input) so this field can never disagree with who actually has
  // standing to close.
  readonly citedCloseCriterionIndex: number | null;
  readonly citedCloseReasonText: string | null;
  readonly citedCloseAuthorDid: string | null;
  readonly citedCloseAt: Date | null;

  // P6: the instant deemCompleted actually fired (design record row 3):
  // the fact a deemed-completion credential needs and completeJob's own
  // mergedAt has no equivalent for, since GitHub never reports a fact
  // here. Null until deemed_completed, written by deemCompleted alone.
  readonly deemedCompletedAt: Date | null;


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

// P1: fixed for v1, not caller-settable. The digest carries them so a
// later card can open either to negotiation without a hash-shape change.
export const DEPOSIT_PERCENT = 25;
export const REDO_ALLOWANCE = 1;
// P1: the agent's proposal may omit deliveryWindowDays; this is what it
// defaults to.
export const DEFAULT_DELIVERY_WINDOW_DAYS = 14;

// User-facing: the input was the buyer's to fix, not a system failure.
// The API layer (R-28) maps this to 400.
export class JobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobError';
  }
}

// P1: confirm refuses because the price is not yet a fully agreed fact --
// no price proposed, only one party accepted it, or no rail set. Distinct
// from the plain JobError the criteria-outstanding gate throws (both are
// "the agreement is not ready", but the route maps this one to 409 the
// same state-conflict way a criteria gap is mapped, not to 400: nothing
// the caller sent is malformed, the AGREEMENT itself is incomplete).
export class JobPriceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobPriceError';
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
    priceUsd: null,
    rail: null,
    priceAcceptedByBuyer: false,
    priceAcceptedByAgent: false,
    depositPercent: DEPOSIT_PERCENT,
    redoAllowance: REDO_ALLOWANCE,
    redoUsedCount: 0,
    redoRequestedCriterionIndex: null,
    redoRequestedAt: null,
    redoRefusedAt: null,
    stagedLapseExtensionDays: 0,
    deliveryWindowDays: null,
    pullRequestUrl: null,
    mergeCommit: null,
    mergedAt: null,
    confirmedAt: null,
    submittedAt: null,
    stagedAt: null,
    stagedCommit: null,
    stagingRepo: null,
    baseCommit: null,
    stagingRepoDeleteAfter: null,
    citedCloseCriterionIndex: null,
    citedCloseReasonText: null,
    citedCloseAuthorDid: null,
    citedCloseAt: null,
    deemedCompletedAt: null,
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
  //
  // P4 (design record, 2026-09-01): confirmed no longer walks straight to
  // submitted. Staged work sits unpaid and unseen in a staging repository
  // until the balance settles (the route layer's gate, not this table);
  // only then does submitted (an opened pull request) become reachable.
  // Two edges are deliberately absent from `staged`, each recording a
  // fact this table must not blur into an existing status:
  //   staged -> withdrawn is absent. Once work is staged the buyer's exit
  //   is staged_declined, a distinct fact from withdrawn: the buyer saw a
  //   published attestation and passed, rather than walking away before
  //   anything was delivered. Two different facts never share one status.
  //   staged -> declined is absent. The agent has already delivered the
  //   work at staged; there is nothing left for it to refuse.
  const validTransitions: Record<JobStatus, JobStatus[]> = {
    draft: ['proposed', 'declined', 'withdrawn'],
    proposed: ['confirmed', 'declined', 'withdrawn'],
    confirmed: ['staged', 'expired_unstaged', 'declined', 'withdrawn'],
    // P6: staged gains one edge, to redo_requested (requestRedo, design
    // record row 2). staged -> withdrawn and staged -> declined stay
    // absent for the same reasons the P4 comment above already names.
    staged: ['submitted', 'staged_declined', 'closed_unpaid', 'redo_requested'],
    // P6: redo_requested has three edges out. Accepting the redo is NOT a
    // transition of its own -- stageWork repeats the confirmed -> staged
    // edge (its own header comment), which this table therefore also has
    // to permit starting FROM redo_requested, not only from confirmed.
    // Refusing is refuseRedo's own edge, back to staged. closed_unpaid is
    // lapseAtStaged's own edge (review round 1, D2): a redo the operator
    // never answers is still an unpaid staged job on the clock, the same
    // clock and the same extended deadline that already protects an
    // unanswered staged job, so this table records the same fact staged's
    // own entry already does. Named here for documentation only --
    // lapseAtStaged writes the status directly, the same way it already
    // does from `staged`, rather than calling this validator.
    redo_requested: ['staged', 'closed_unpaid'],
    // R-12 (ENT-7.2): non-merge outcomes are recorded, not hidden. The
    // stale -> closed_unmerged edge is legal (R-31): an outcome update
    // after stale, not a new state. P4: deemed_completed joins the same
    // list (the buyer paid, then neither merged nor closed within the
    // review window) -- see deemCompleted below. `stale` itself is
    // untouched by this card: deemed completion now fires at 7 days,
    // long before stale's 30-day mark, so stale is effectively
    // unreachable on a paid job going forward. That retirement is its
    // own card (a status removal ripples through both storage drivers
    // and the lifecycle routes); this table keeps `stale` exactly as it
    // was and adds no new edge to it.
    // P6: submitted gains cited_closed (recordCitedClose, design record
    // row 4): the buyer's deliberate, reasoned close after paying,
    // distinct from closed_unmerged (see recordCitedClose's own header
    // comment for why the two never share one status).
    submitted: ['completed', 'closed_unmerged', 'deemed_completed', 'stale', 'declined', 'withdrawn', 'cited_closed'],
    stale: ['completed', 'closed_unmerged', 'declined', 'withdrawn'],
    closed_unmerged: [],
    completed: [],
    declined: [],
    withdrawn: [],
    // P4 terminal outcomes: each is a closed fact with no further
    // transition (see TERMINAL_STATUSES above).
    staged_declined: [],
    closed_unpaid: [],
    expired_unstaged: [],
    deemed_completed: [],
    // P6 terminal outcome: no edge back out, once made.
    cited_closed: [],
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
  // P1 anchor: a hire cannot confirm without a price both parties signed.
  // Checked after the criteria gate (mirroring CONFIRM_GATE_STATUS's own
  // ordering: transition first, content gates after), so a caller sees the
  // criteria problem before the price problem when both are outstanding --
  // one failure at a time, the earlier one in the agreement first.
  if (job.priceUsd === null || job.rail === null) {
    throw new JobPriceError(
      'confirm needs an agreed price: no price has been proposed for this job yet',
    );
  }
  if (!job.priceAcceptedByBuyer || !job.priceAcceptedByAgent) {
    throw new JobPriceError(
      'confirm needs the price accepted by both parties before the agreement is final',
    );
  }
  // specHash pins WHAT WAS AGREED: the criteria texts in order, '\n'-joined,
  // through hashSpec's documented normalisation (\n endings, trailing
  // whitespace stripped per line, no trailing newline). Anyone holding the
  // criteria can recompute it with node:crypto alone - invariant 2. The
  // acceptance flags are uniformly true here and proposedBy stays visible in
  // plaintext, so neither belongs in the digest.
  //
  // P1 extends the digest with the price line (ENT-4.2): after the criteria
  // texts, newline-joined, in this fixed order -- price, rail, deposit,
  // redo, window -- so a stranger recomputing the hash from the confirmed
  // response's own fields needs no call to this service.
  const specText = [
    ...job.criteria.map((criterion) => criterion.text),
    `price:${job.priceUsd}`,
    `rail:${job.rail}`,
    `deposit:${job.depositPercent}`,
    `redo:${job.redoAllowance}`,
    `window:${job.deliveryWindowDays}`,
  ].join('\n');
  return { ...job, status: 'confirmed', confirmedSpecHash: hashSpec(specText), confirmedAt: now };
}

// The instant an unmerged pull request goes stale, in days (D3
// 2026-08-22: 30 days from submission).
export const STALE_AFTER_DAYS = 30;

// P4: the agent stages its work (confirmed -> staged), the same party
// rule submitPullRequest already keeps (only the agent submits its own
// work): only the agent may call this, enforced by the route layer the
// same way it enforces submitPullRequest's party rule, not by this pure
// function taking a party argument it would then have to validate twice.
// The attestation document itself is a later card; this function stores
// only the staged commit SHA and the instant, the two facts this card
// owns. The redo mechanic a buyer can request at staged is a later card
// too -- this is the seam it attaches to: a redo would read this same
// stagedCommit/stagedAt pair and, on approval, call stageWork again with
// a revised commit, still gated on the same confirmed -> staged edge
// (a redo does not invent a new transition, it repeats this one).
export function stageWork(job: Job, stagedCommit: string, now: Date): Job {
  validateJobTransition(job.status, 'staged');
  return {
    // stagedAt and stagedCommit are one pair with one writer, mirroring
    // confirmSpec's own confirmedSpecHash/confirmedAt pairing.
    ...job,
    status: 'staged',
    stagedCommit,
    stagedAt: now,
  };
}

// B14a: attaches the staging repository facts onto an already-confirmed
// job. A pure function, not a transition: confirm's own status edge
// (draft/proposed -> confirmed) is confirmSpec's job alone, and this
// function does not touch status. The route calls this AFTER confirmSpec
// has already validated the transition and AFTER the github adapter has
// already created the repository and granted push -- so a repository
// creation failure never reaches this function at all, and the caller
// simply does not persist the confirmed job (leaving the prior persisted
// row, still 'proposed', untouched -- see the API route's own header
// comment on the fail-closed order).
export function attachStagingRepository(
  job: Job,
  stagingRepo: { readonly owner: string; readonly repo: string },
  baseCommit: string,
): Job {
  return { ...job, stagingRepo, baseCommit };
}

// P6 (design record, 2026-09-01, row 2): the redo mechanic requestRedo /
// refuseRedo fills the seam stageWork's own header comment names. Named
// beside LAPSE_AT_STAGED_AFTER_DAYS, per the brief: a redo extends
// delivery 7 days, the same length as the base staged lapse window.
export const REDO_LAPSE_EXTENSION_DAYS = 7;

// A redo requested on a job with no allowance left. Distinct from the
// plain JobError an out-of-range criterion index throws: this is a state
// conflict (the agreement's redo budget is exhausted), not malformed
// input, mirroring JobPriceError's own split from JobError for the same
// reason (a caller-mapped 409, not a 400).
export class RedoAllowanceExhaustedError extends Error {
  constructor(jobId: string) {
    super(`job ${jobId} has no redo allowance left`);
    this.name = 'RedoAllowanceExhaustedError';
  }
}

// The buyer's one redo at staged (design record row 2): cites a confirmed
// criterion index, no price change, extends the staged lapse deadline by
// REDO_LAPSE_EXTENSION_DAYS. Party enforcement (buyer only) is the route
// layer's job, the same split stageWork keeps from its own agent-only
// rule. Consumption is unconditional here: requestRedo either succeeds
// and increments redoUsedCount, or throws and changes nothing, so a
// caught throw can never leave a half-consumed allowance.
export function requestRedo(job: Job, criterionIndex: number, now: Date): Job {
  validateJobTransition(job.status, 'redo_requested');
  if (!Number.isInteger(criterionIndex) || criterionIndex < 0 || criterionIndex >= job.criteria.length) {
    throw new JobError(`no confirmed criterion at index ${criterionIndex}`);
  }
  if (job.redoUsedCount >= job.redoAllowance) {
    throw new RedoAllowanceExhaustedError(job.id);
  }
  return {
    ...job,
    status: 'redo_requested',
    redoUsedCount: job.redoUsedCount + 1,
    redoRequestedCriterionIndex: criterionIndex,
    redoRequestedAt: now,
    // The extension is a stored fact from the moment the redo is
    // requested, not deferred to acceptance: lapseAtStaged reads it off
    // whatever status the job is actually in, and a refused redo (which
    // returns to staged, never to redo_requested) still needs the
    // extension it already earned by being asked -- see refuseRedo's own
    // header comment.
    stagedLapseExtensionDays: job.stagedLapseExtensionDays + REDO_LAPSE_EXTENSION_DAYS,
  };
}

// The operator's refusal (design record row 2): returns the job to
// staged, where the buyer pays or declines, exactly as if no redo had
// been asked -- except the refusal itself is a permanent, recorded fact
// (redoRefusedAt), and redoUsedCount is NOT decremented: the allowance
// was already spent the instant it was asked for, per the brief ("the
// allowance is not refunded by a refusal"). The extension earned at
// request time survives the refusal too (the buyer already lost a
// redo's worth of leverage; losing the extension as well would double
// the operator's advantage from one refusal).
export function refuseRedo(job: Job, now: Date): Job {
  validateJobTransition(job.status, 'staged');
  return { ...job, status: 'staged', redoRefusedAt: now };
}

// P4: the buyer declines the staged work, free of charge, before paying
// the balance (design record, 2026-09-01: "the buyer has exactly three
// moves there and nowhere else: pay the balance, request the one redo, or
// decline for free"). Terminal: staged_declined records that the buyer
// saw a published attestation and passed, a distinct fact from withdrawn
// (see the transition table's comment on the absent staged -> withdrawn
// edge). No money moves and none is owed -- this function touches no
// payment field because there is nothing here to touch: the deposit
// already settled at confirm and is never reversed (MISSION.md invariant
// 12; no refund vocabulary exists anywhere in this domain).
export function recordStagedDeclined(job: Job): Job {
  validateJobTransition(job.status, 'staged_declined');
  return { ...job, status: 'staged_declined' };
}

// P4: the two clocks and applyLapses (brief section 4). Each is a pure
// function of stored timestamps and an injected `now` -- no timers, no
// cron, no background process, nothing that wakes up on its own. Each
// refuses on any other starting status by returning the job UNCHANGED
// (never throwing): a clock is consulted wherever a job is read, so a
// status irrelevant to a given clock is the overwhelmingly common case,
// not an error condition. Each is idempotent: once a job has lapsed,
// re-running the same clock (or applyLapses) against it is a no-op,
// because the job's status no longer matches the clock's own starting
// status.
//
// The boundary is STRICTLY after the deadline, matching STALE_AFTER_DAYS'
// own day-count convention: exactly N days out is not yet lapsed, one
// instant past it is.
export const EXPIRE_UNSTAGED_AFTER_DAYS = 30;
export const LAPSE_AT_STAGED_AFTER_DAYS = 7;
export const DEEM_COMPLETED_AFTER_DAYS = 7;

// B14a scope item 5: staging repos are deleted 30 days after a terminal
// state -- RECORDED here, not built. This function computes the value a
// later sweep card writes onto stagingRepoDeleteAfter; nothing in this
// file calls it (no transition function here sets stagingRepoDeleteAfter,
// deliberately -- see the field's own header comment on Job). Named
// distinctly from the other *_AFTER_DAYS constants above rather than
// merged into their pattern, since this one governs a resource
// (a repository) rather than a job status.
export const STAGING_REPO_CLEANUP_AFTER_DAYS = 30;

export function computeStagingRepoDeleteAfter(terminalAt: Date): Date {
  return new Date(terminalAt.getTime() + STAGING_REPO_CLEANUP_AFTER_DAYS * 86_400_000);
}

// confirmed with no staging, EXPIRE_UNSTAGED_AFTER_DAYS after confirmedAt,
// becomes expired_unstaged (terminal). confirmedAt is always set on a
// confirmed job (confirmSpec's own writer pairing), so the null check
// below is a type guard, not a real branch a confirmed row can hit.
export function expireUnstaged(job: Job, now: Date): Job {
  if (job.status !== 'confirmed' || job.confirmedAt === null) return job;
  const deadline = job.confirmedAt.getTime() + EXPIRE_UNSTAGED_AFTER_DAYS * 86_400_000;
  if (now.getTime() <= deadline) return job;
  return { ...job, status: 'expired_unstaged' };
}

// staged (or redo_requested) with no balance settled,
// LAPSE_AT_STAGED_AFTER_DAYS after stagedAt, becomes closed_unpaid
// (terminal). "The code never leaves staging": nothing here touches
// stagedCommit or stagedAt, so a lapsed row still carries exactly what was
// staged, for whatever the attestation card eventually shows against a
// closed_unpaid job.
//
// P6 review round 1 (D2): redo_requested joins staged as a starting status
// this clock covers, not only staged. Before this fix, the moment a buyer
// requested a redo the job left `staged` and this clock returned it
// unchanged forever after -- an operator who simply never answered the
// redo left the job immortal, with no deadline of any kind. redo_requested
// sits between staged and staged again (job.ts's own header comment): the
// buyer has still not paid in either status, so the same clock protects
// both the same way, off the same stagedAt and the same
// stagedLapseExtensionDays (requestRedo has already added the extension
// by the time a job reaches redo_requested, so the deadline a pending
// redo is held to is already the extended one, not the base one).
//
// remainderIsSettled is the caller's answer to the ONE fact this clock is
// defined against (brief section 4: "staged with NO BALANCE SETTLED" --
// named remainderIsSettled, not balanceIsSettled, for the same
// tests/architecture/no-custody.test.ts reason src/domain/payment.ts's
// remainderUsd is not named balanceUsd: invariant 12 bans the substring
// "balance" in any src file outside src/adapters/payment, and this file
// is outside that directory). Review round 1 (D4, t_cb5d35cd) found the
// first cut checked only status and elapsed time, so a buyer who had
// already paid could still have their job closed unpaid by an unrelated
// read -- destroying delivered, paid-for work. Defaults to false (fail
// closed): an unwired caller that forgets to pass the settlement fact
// gets the safe answer, a lapse, not a silent skip that could mask a real
// non-payment. src/api/app.ts is the only call site with an actual
// SettlementGate to ask; it passes the real answer explicitly rather
// than relying on this default.
// The statuses lapseAtStaged treats as "still staged, clock running":
// staged itself, and redo_requested (a pending redo sits between staged
// and staged again, per job.ts's own header comment on the status). A
// named, exported set rather than an inline check in two places, so the
// API layer's applyLiveLapses (the one caller with a live settlement
// gate to ask) can derive which statuses need that live fact instead of
// repeating a second literal that can fall out of sync with this
// function's own starting statuses (P6 review round 2, D3, t_604e3f2a).
export const LAPSE_AT_STAGED_STATUSES: ReadonlySet<JobStatus> = new Set(['staged', 'redo_requested']);

export function lapseAtStaged(job: Job, now: Date, remainderIsSettled = false): Job {
  if (
    !LAPSE_AT_STAGED_STATUSES.has(job.status) ||
    job.stagedAt === null ||
    remainderIsSettled
  ) {
    return job;
  }
  // P6: a redo requested and accepted earlier on this job extends the
  // window by stagedLapseExtensionDays (a stored fact, never
  // recomputed from redoUsedCount -- see requestRedo's own header
  // comment). Zero for a job that was never redone, so this is a pure
  // widening, never a narrowing, of the base deadline.
  const deadline =
    job.stagedAt.getTime() + (LAPSE_AT_STAGED_AFTER_DAYS + job.stagedLapseExtensionDays) * 86_400_000;
  if (now.getTime() <= deadline) return job;
  return { ...job, status: 'closed_unpaid' };
}

// submitted, neither merged nor closed, DEEM_COMPLETED_AFTER_DAYS after
// submittedAt, becomes deemed_completed (terminal). Fires long before
// STALE_AFTER_DAYS' 30-day mark (see the transition table's comment on
// `submitted`), which is why stale is now effectively unreachable on a
// paid job -- a retirement left to its own card, not resolved here.
//
// deemed_completed issues a credential of a DISTINCT type (a later
// card's job, per the brief). This function must not and does not issue
// one: it writes only the status, leaving mergeCommit and mergedAt null
// exactly as completeJob's own null-until-observed contract already
// promises for every non-merged job. If a future completion path were
// ever tempted to fire a credential off this status, that must be gated
// off explicitly there, not assumed safe because this function is quiet
// about it.
export function deemCompleted(job: Job, now: Date): Job {
  if (job.status !== 'submitted' || job.submittedAt === null) return job;
  const deadline = job.submittedAt.getTime() + DEEM_COMPLETED_AFTER_DAYS * 86_400_000;
  if (now.getTime() <= deadline) return job;
  return { ...job, status: 'deemed_completed', deemedCompletedAt: now };
}

// Runs the three clocks in order and returns the job unchanged when none
// applies. remainderIsSettled answers the ONE live fact lapseAtStaged
// needs (see its own header comment); the two other clocks ignore it.
// Defaults to false (fail closed), matching lapseAtStaged's own default
// -- a caller that has not looked up settlement gets the safe answer.
//
// Call site (P4, review round 1 fix, t_cb5d35cd -- D1/D2/D3): this domain
// function has exactly one caller, src/api/app.ts's applyLiveLapses,
// which is itself called from two places -- GET /jobs/:jobId, and
// loadForExchange, the one load EVERY mutation and exchange route in
// this file shares (confirm, stage, pull-request, staged-decline,
// withdraw, decline, the criteria and price exchange). Routing every
// mutation through the same load as GET, rather than leaving the clocks
// bound to GET alone, is what closes D2 (a lapsed job could still be
// acted on) and D3 (the outcome depended on whether someone had GET'd
// the job first). Nothing here schedules a re-check: a status that only
// changes when someone looks is honest, and a scheduler (cron, a worker)
// is a separate decision this card does not make.
export function applyLapses(job: Job, now: Date, remainderIsSettled = false): Job {
  return deemCompleted(lapseAtStaged(expireUnstaged(job, now), now, remainderIsSettled), now);
}

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

// P6 (design record, 2026-09-01, row 4): the buyer's deliberate, reasoned
// close after paying. Kept as a DIFFERENT status from closed_unmerged on
// purpose: closed_unmerged is the merge route's OBSERVATION of a closed
// pull request (recordClosedUnmerged's own header comment), with no
// reason attached and no buyer intent behind it as far as this domain
// knows -- a buyer could go silent and let GitHub's PR close for any
// reason, or none. cited_closed is the opposite: a specific act, with a
// specific reason, attributed to a specific party, that stops the
// credential outright. Sharing one status would force a reader to open
// the reason field just to learn whether a close was deliberate at all;
// two statuses make that fact visible from the status alone. "No index
// means the clock keeps running" (the absorbed counter-demand) follows
// from this split by construction: a buyer who closes the PR on GitHub
// without calling this function never reaches cited_closed, so
// deemCompleted's own clock is untouched and keeps counting toward
// deemed_completed on its own schedule.
export interface CitedCloseInput {
  readonly criterionIndex: number;
  readonly reasonText: string;
}

export function recordCitedClose(job: Job, input: CitedCloseInput, now: Date): Job {
  validateJobTransition(job.status, 'cited_closed');
  if (!Number.isInteger(input.criterionIndex) || input.criterionIndex < 0 || input.criterionIndex >= job.criteria.length) {
    throw new JobError(`no confirmed criterion at index ${input.criterionIndex}`);
  }
  const reasonText = input.reasonText.trim();
  if (reasonText === '') {
    throw new JobError('a cited close needs at least one sentence of the buyer\'s own prose: an empty string is not a sentence');
  }
  return {
    ...job,
    status: 'cited_closed',
    citedCloseCriterionIndex: input.criterionIndex,
    citedCloseReasonText: reasonText,
    // Copied from the job, never taken as a separate input (mirrors
    // completeJob's own stance on buyerDid/agentDid): the platform never
    // authors this field, and the author can never disagree with who
    // actually has standing to close.
    citedCloseAuthorDid: job.buyerDid,
    citedCloseAt: now,
  };
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

// OPEN FAIRNESS QUESTION (do not resolve here, brief section "An open
// question you must not resolve"): an agent may still decline a job at
// confirmed, after the buyer's deposit has already reached the operator
// (confirmSpec's own deposit gate runs before this edge is ever reached).
// The platform holds nothing and reverses nothing (MISSION.md invariant
// 12), so that deposit is gone from the buyer's side with no refund path
// and no penalty on the agent. This function adds neither: the edge stays
// exactly as it already was, and the fairness question awaits the owner's
// ruling on a later card.

// The acceptance-criteria exchange R-8 owns (ENT-6, D2). The first propose
// walks draft -> proposed, the edge the transition table already records;
// every later one revises the list while staying in proposed.
//
// Re-propose is a DIFF against the stored list, not a wholesale replace
// (design review, 2026-08-29: "editing one line resets only that line"). A new
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
// Validates a decimal-USD string: exactly two places after the point, no
// sign, no thousands separator. Total: any string in, one boolean out.
// Never a float in the domain (a JS number cannot hold a decimal amount
// exactly), so this is the one place the shape is checked.
function isDecimalUsd(value: string): boolean {
  return /^\d+\.\d{2}$/.test(value);
}

export interface PriceProposal {
  readonly priceUsd: string;
  readonly rail: Rail;
  readonly deliveryWindowDays?: number;
}

// The acceptance-criteria exchange R-8 owns (ENT-6, D2). The first propose
// walks draft -> proposed, the edge the transition table already records;
// every later one revises the list while staying in proposed.
//
// Re-propose is a DIFF against the stored list, not a wholesale replace
// (design review, 2026-08-29: "editing one line resets only that line"). A new
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
//
// P1: the agent's proposal (POST /jobs/:jobId/criteria) may carry a price
// beside the criteria (scope item 2). Accepting the price is a line in the
// agreement like any criterion: proposing the SAME price+rail+window as is
// already stored leaves both acceptances untouched (mirroring an unchanged
// criterion's text keeping its acceptance history); proposing a DIFFERENT
// one resets both to unaccepted (mirroring an edited criterion's text
// resetting to unaccepted). Omitting the price argument entirely leaves
// whatever price is already stored untouched, so a re-propose that only
// touches criteria text does not disturb an already-agreed price.
export function proposeCriteria(
  job: Job,
  input: ReadonlyArray<{ readonly text: string; readonly proposedBy: string }>,
  price?: PriceProposal,
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

  let priceFields: Pick<
    Job,
    'priceUsd' | 'rail' | 'deliveryWindowDays' | 'priceAcceptedByBuyer' | 'priceAcceptedByAgent'
  > = {
    priceUsd: job.priceUsd,
    rail: job.rail,
    deliveryWindowDays: job.deliveryWindowDays,
    priceAcceptedByBuyer: job.priceAcceptedByBuyer,
    priceAcceptedByAgent: job.priceAcceptedByAgent,
  };
  if (price !== undefined) {
    if (typeof price.priceUsd !== 'string' || !isDecimalUsd(price.priceUsd)) {
      throw new JobError('priceUsd must be a decimal string with exactly two places, e.g. "500.00"');
    }
    if (price.rail !== 'abt' && price.rail !== 'usdc') {
      throw new JobError('rail must be "abt" or "usdc"');
    }
    const deliveryWindowDays = price.deliveryWindowDays ?? DEFAULT_DELIVERY_WINDOW_DAYS;
    const unchanged =
      job.priceUsd === price.priceUsd &&
      job.rail === price.rail &&
      job.deliveryWindowDays === deliveryWindowDays;
    priceFields = {
      priceUsd: price.priceUsd,
      rail: price.rail,
      deliveryWindowDays,
      priceAcceptedByBuyer: unchanged ? job.priceAcceptedByBuyer : false,
      priceAcceptedByAgent: unchanged ? job.priceAcceptedByAgent : false,
    };
  }

  if (job.status === 'draft') {
    validateJobTransition(job.status, 'proposed');
    return { ...job, ...priceFields, status: 'proposed', criteria };
  }
  if (job.status === 'proposed') {
    // proposed -> proposed is not a legal transition, and looping must not
    // invent one: a re-propose revises the list in place, same status,
    // same job. Only the first propose crosses the validator.
    return { ...job, ...priceFields, criteria };
  }
  throw new JobTransitionError(job.status, 'propose criteria for');
}

// The buyer's pushback: a bodyless signal that carries no criterion text of
// its own, so it cannot target one line the way a re-propose can. Once
// editing moved to per-criterion diffing (see proposeCriteria below), a
// blanket reset here would undo the very thing that change fixes: the
// 2026-08-29 design review named exactly this - "requestChanges resets every
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

// P1: one party accepts the price line, the same shape as acceptCriterion
// (ENT-6.2's pattern applied to price): idempotent per party, independent
// of the other party's flag. Refuses when no price has been proposed yet --
// there is nothing to accept -- the same way acceptCriterion refuses an
// out-of-range index.
export function acceptPrice(job: Job, party: Party): Job {
  if (job.status !== 'proposed') {
    throw new JobTransitionError(job.status, 'accept the price on');
  }
  if (job.priceUsd === null || job.rail === null) {
    throw new JobError('no price has been proposed for this job yet');
  }
  return party === 'buyer'
    ? { ...job, priceAcceptedByBuyer: true }
    : { ...job, priceAcceptedByAgent: true };
}

// P1, scope item 5: the optional agent floor (MAP.md). A proposal below it
// is refused at propose time, naming the floor. Total in the sense that
// invokes need not catch anything unexpected: a null floor never throws (no
// floor set), and a price at or above the floor never throws. Compares as
// decimal strings converted once, never as floats retained beyond the
// comparison, so the domain still never stores a price as a number.
export function assertPriceAboveFloor(priceUsd: string, floorPriceUsd: string | null): void {
  if (floorPriceUsd === null) return;
  if (Number(priceUsd) < Number(floorPriceUsd)) {
    throw new JobError(`proposed price ${priceUsd} is below the agent's floor of ${floorPriceUsd}`);
  }
}
