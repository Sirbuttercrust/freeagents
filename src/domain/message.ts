// HT1 Part B (ruling, 2026-09-25): the hire thread's message data, pure
// domain. One thread per job, opened at the brief (draft) and read-only
// once the job reaches a terminal status (isTerminal, src/domain/job.ts).
//
// Reused, not reinvented: the gate that decides whether the agent's OWN
// signature may act on a job (agentMayNegotiate, src/domain/agent.ts) is
// exactly the gate this file's thread-access rule needs too, per the
// original brief's own line: "the negotiation routes are: propose
// criteria/price, request-changes, criteria accept, price accept,
// confirm, decline before confirm, and posting a message." Posting is
// already in that list; this file does not repeat the gate, the route
// layer calls the same requireNegotiationAllowed function it already
// calls for every other negotiation route.
//
// INVARIANT 3 (MISSION.md): a message never enters a credential, an
// attestation or a spec hash. This file is never imported by
// src/domain/job.ts's confirmSpec, by src/domain/attestation.ts, or by
// src/adapters/credentials/credentials.ts -- the digest and the
// credential are computed from job/attestation fields alone, and no
// function here can reach either of those call sites even by accident,
// because nothing in this file is ever passed to them. The invariant is
// therefore structural (nothing here is on the path), not merely
// asserted; tests/domain/message-invariant3.test.ts's own digest test
// proves it by computation, not by review.
import { isTerminal, type JobStatus, type Party } from './job.js';
import { agentMayNegotiate } from './agent.js';

// authorKind distinguishes who actually wrote a row, distinct from
// authorParty (the job seat: 'buyer' | 'agent' | 'system'). A party of
// 'agent' splits into two authorKinds depending on which key wrote it:
// the agent's own signing key ('agent-autonomous') or its operator's
// session/signature ('owner'). 'system' rows carry authorKind 'system'
// and authorParty 'system' together, always.
export type AuthorKind = 'owner' | 'agent-autonomous' | 'buyer' | 'system';
export type AuthorParty = Party | 'system';

export class MessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageError';
  }
}

// State-conflict errors (409s at the route layer), mirroring
// JobTransitionError / JobPriceError's own split from the plain
// MessageError above: the caller sent nothing malformed, the THREAD's
// own state is what refuses the action.
export class ThreadReadOnlyError extends Error {
  constructor(jobId: string) {
    super(`the hire thread for job ${jobId} is read-only: the job has reached a terminal status`);
    this.name = 'ThreadReadOnlyError';
  }
}

export class MessageEditWindowExpiredError extends Error {
  constructor(messageId: string) {
    super(`message ${messageId} can no longer be edited: the 15 minute edit window has passed`);
    this.name = 'MessageEditWindowExpiredError';
  }
}

// Plain text only (the original HT1 brief, item 3: "no attachments or
// links rendering as HTML" -- attachments now exist as a SEPARATE typed
// list, never inline HTML in the body itself). A length cap: chosen as a
// product value (FACTORY_RULES 7.1: a cap is a product value, not a
// judgement value), generous enough for a real negotiation message,
// short enough that a client renders it without its own pagination.
export const MESSAGE_BODY_MAX_LENGTH = 4000;

// The 15 minute edit window (HT1 STEER, 2026-09-25): "edit within 15
// minutes of send, with full edit history kept... NO delete or unsend,
// ever."
export const EDIT_WINDOW_MINUTES = 15;

export interface EditRecord {
  // The body as it stood BEFORE this edit replaced it -- so the edit
  // history reads as a list of past versions, oldest first, ending with
  // (but not including) the current body. Readable by both parties
  // (STEER: "the full edit history kept and readable by both parties").
  readonly body: string;
  readonly editedAt: Date;
}

// One reaction slot per party, mirroring Criterion's own
// acceptedByBuyer/acceptedByAgent pattern (src/domain/job.ts): two
// independent slots, never a shared one, so one party's reaction can
// never overwrite the other's. Any single emoji; null means no reaction
// from that party. Re-reacting replaces; there is no separate "remove"
// value distinct from null -- removeReaction sets the slot back to null.
export interface Reactions {
  readonly buyer: string | null;
  readonly agent: string | null;
}

export const NO_REACTIONS: Reactions = { buyer: null, agent: null };

// A quote card (STEER: "a quote event carries the price, window and
// criteria count so a client can render a summary card without a second
// call"). Written when the exchange proposes a price alongside criteria
// (POST /jobs/:jobId/criteria with a price named).
//
// FIX-B39, rule 1: a quote may leave the currency open (null) until a
// deposit settles one; a card naming a rail keeps naming it exactly as
// before.
export interface QuoteSentEvent {
  readonly type: 'quote_sent';
  readonly priceUsd: string;
  readonly rail: 'abt' | 'usdc' | null;
  readonly deliveryWindowDays: number | null;
  readonly criteriaCount: number;
}

// STEER (bugs.md B19): a settlement leg observed on chain
// becomes a row in the thread the instant it is recorded, so a buyer who
// has paid can see it. leg names which of the two legs settled; the
// amount is always in USD (never a token amount) and the rail names
// which chain it settled on. Deliberately never a wallet address or a
// transaction hash -- the settlement's own on-chain proof lives at
// ObservedSettlementRecord (src/adapters/storage/types.ts), a separate
// store this event never reaches into.
export interface DepositPaidEvent {
  readonly type: 'deposit_paid';
  readonly leg: 'deposit';
  readonly amountUsd: string;
  readonly rail: 'abt' | 'usdc';
}

// STEER (bugs.md B19): the remainder leg's sibling event, named
// 'remainder_paid' rather than 'balance_paid' -- 'remainder' is this
// codebase's own established name for the second payment leg (RouteLeg,
// src/adapters/payment/route-support.ts; remainderUsd,
// src/domain/payment.ts), chosen there for the identical reason this
// event needs it too: tests/architecture/no-custody.test.ts bans the
// literal word "balance" on any line outside src/adapters/payment.
export interface RemainderPaidEvent {
  readonly type: 'remainder_paid';
  readonly leg: 'remainder';
  readonly amountUsd: string;
  readonly rail: 'abt' | 'usdc';
}

export interface StagedEvent {
  readonly type: 'staged';
}

export interface PullRequestOpenedEvent {
  readonly type: 'pr_opened';
  readonly pullRequestUrl: string;
}

export interface CompletedEvent {
  readonly type: 'completed';
  readonly mergeCommit: string;
}

export type SystemEvent =
  | QuoteSentEvent
  | DepositPaidEvent
  | RemainderPaidEvent
  | StagedEvent
  | PullRequestOpenedEvent
  | CompletedEvent;

// One attachment reference on a message: the id an attachment was stored
// under (src/domain/attachment.ts), never the bytes and never a path.
export interface MessageAttachmentRef {
  readonly attachmentId: string;
}

export interface Message {
  readonly id: string;
  readonly jobId: string;
  // null only for a system row; every party-authored row carries the
  // DID that actually signed or session-authenticated the write (never
  // the operator's DID when the agent's own key wrote it, and vice
  // versa -- authorDid is the real actor, authorKind is which SEAT that
  // actor holds).
  readonly authorDid: string | null;
  readonly authorParty: AuthorParty;
  readonly authorKind: AuthorKind;
  readonly body: string;
  readonly replyToId: string | null;
  readonly createdAt: Date;
  readonly editedAt: Date | null;
  readonly editHistory: readonly EditRecord[];
  readonly reactions: Reactions;
  readonly attachments: readonly MessageAttachmentRef[];
  // Present only on a platform-written row (authorParty === 'system');
  // null on every party-authored row. The discriminant IS authorParty,
  // never a second boolean this field could disagree with.
  readonly systemEvent: SystemEvent | null;
}

// The thread's own open/closed rule (HT1 brief, item 3): opens at the
// brief (from 'draft') and stays open through every non-terminal status;
// becomes read-only once the job reaches ANY terminal status
// (isTerminal, src/domain/job.ts -- the same list every other terminal
// check in this codebase already shares, not a second enumeration here).
export function threadIsWritable(jobStatus: JobStatus): boolean {
  return !isTerminal(jobStatus);
}

// The read/write gate for the thread (HT1 brief, item 3): "readable and
// writable only by the job's two parties, and by the agent's own DID
// only when [the] negotiatesOnOwnersBehalf flag is on." The buyer and
// the agent's OPERATOR are always allowed; the agent's own signing key
// is allowed only once its owner has turned the flag on -- exactly
// agentMayNegotiate's own question, asked here for message access
// instead of for a negotiation route, so the two callers can never
// silently diverge on what "the agent's own key" means.
export function partyMayAccessThread(input: {
  readonly party: Party;
  readonly callerIsAgentOwnKey: boolean;
  readonly negotiatesOnOwnersBehalf: boolean;
}): boolean {
  if (input.party === 'buyer') return true;
  return agentMayNegotiate({
    callerIsAgentOwnKey: input.callerIsAgentOwnKey,
    negotiatesOnOwnersBehalf: input.negotiatesOnOwnersBehalf,
  });
}

// Derives authorKind from the same two facts requireNegotiationAllowed
// already resolves for free (party, and whether the acting DID equals
// the job's own agentDid): there is no third lookup, just a naming of
// the case already known at the call site.
export function authorKindFor(party: Party, callerIsAgentOwnKey: boolean): AuthorKind {
  if (party === 'buyer') return 'buyer';
  return callerIsAgentOwnKey ? 'agent-autonomous' : 'owner';
}

// A single Unicode grapheme cluster that is plainly an emoji: exactly
// one user-perceived character (so a caller cannot smuggle a sentence
// into a reaction slot), and one whose codepoints carry the
// Extended_Pictographic or Emoji_Presentation Unicode property (so a
// plain letter, digit or punctuation mark is refused). Intl.Segmenter is
// a Node 22+ global (this repo's own engines.node floor, package.json),
// so no new dependency is needed for grapheme-aware splitting.
export function isSingleEmoji(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)];
  if (graphemes.length !== 1) return false;
  return /\p{Extended_Pictographic}/u.test(value) || /\p{Emoji_Presentation}/u.test(value);
}

export function messageBodyWellFormed(body: unknown): body is string {
  return typeof body === 'string' && body.length > 0 && body.length <= MESSAGE_BODY_MAX_LENGTH;
}

// MSG1a (Make item 5): an empty body is allowed only when attachmentIds
// names at least one qualifying attachment (iMessage sends a bare
// photo). This is the single source of that content rule -- createMessage
// below is its only caller. The route's own shape check (POST
// /jobs/:jobId/messages, app.ts) does not call this function: it checks
// only that the body is a string within the length cap, a narrower,
// attachment-independent check, and leaves the empty-body-needs-an-
// attachment decision to createMessage so the two can never diverge on
// what counts as a well-formed message.
export function messageWellFormedFor(body: unknown, hasAttachments: boolean): body is string {
  if (typeof body !== 'string' || body.length > MESSAGE_BODY_MAX_LENGTH) return false;
  if (body.length === 0) return hasAttachments;
  return true;
}

// Builds a new party-authored row. Pure: the caller supplies id and now
// (the same pattern createJob takes), and replyToId is validated against
// the set of ids ALREADY in the thread -- a reply to a message that does
// not exist, or to a message from a different job, is refused here
// rather than silently accepted as a dangling reference.
export function createMessage(input: {
  readonly id: string;
  readonly jobId: string;
  readonly authorDid: string;
  readonly authorParty: Party;
  readonly authorKind: AuthorKind;
  readonly body: string;
  readonly replyToId?: string | null;
  readonly existingMessageIds: ReadonlySet<string>;
  readonly attachments?: readonly MessageAttachmentRef[];
}, now: Date): Message {
  const hasAttachments = (input.attachments ?? []).length > 0;
  if (!messageWellFormedFor(input.body, hasAttachments)) {
    throw new MessageError(
      hasAttachments
        ? `a message body must be up to ${MESSAGE_BODY_MAX_LENGTH} characters`
        : `a message body must be 1 to ${MESSAGE_BODY_MAX_LENGTH} characters (or carry at least one attachment)`,
    );
  }
  const replyToId = input.replyToId ?? null;
  if (replyToId !== null && !input.existingMessageIds.has(replyToId)) {
    throw new MessageError(`replyToId ${replyToId} does not name a message in this thread`);
  }
  return {
    id: input.id,
    jobId: input.jobId,
    authorDid: input.authorDid,
    authorParty: input.authorParty,
    authorKind: input.authorKind,
    body: input.body,
    replyToId,
    createdAt: now,
    editedAt: null,
    editHistory: [],
    reactions: NO_REACTIONS,
    attachments: input.attachments ?? [],
    systemEvent: null,
  };
}

// Builds a platform-written system row. Never callable with a party
// authorKind: the discriminant (authorParty: 'system') is fixed here,
// not taken as a parameter a caller could get wrong.
export function createSystemMessage(input: {
  readonly id: string;
  readonly jobId: string;
  readonly body: string;
  readonly systemEvent: SystemEvent;
}, now: Date): Message {
  return {
    id: input.id,
    jobId: input.jobId,
    authorDid: null,
    authorParty: 'system',
    authorKind: 'system',
    body: input.body,
    replyToId: null,
    createdAt: now,
    editedAt: null,
    editHistory: [],
    reactions: NO_REACTIONS,
    attachments: [],
    systemEvent: input.systemEvent,
  };
}

// NO delete or unsend function exists anywhere in this file, deliberately
// (HT1 brief, item 3: "NO delete or unsend, ever"). editMessage is the
// only mutation a party's own row ever receives after creation, and it
// keeps rather than discards the prior text.
export function editMessage(message: Message, newBody: string, now: Date): Message {
  if (message.authorParty === 'system') {
    throw new MessageError(`message ${message.id} is a system row and cannot be edited`);
  }
  if (!messageBodyWellFormed(newBody)) {
    throw new MessageError(`a message body must be 1 to ${MESSAGE_BODY_MAX_LENGTH} characters`);
  }
  const ageMs = now.getTime() - message.createdAt.getTime();
  if (ageMs > EDIT_WINDOW_MINUTES * 60_000) {
    throw new MessageEditWindowExpiredError(message.id);
  }
  return {
    ...message,
    body: newBody,
    editedAt: now,
    editHistory: [...message.editHistory, { body: message.body, editedAt: message.editedAt ?? message.createdAt }],
  };
}

// One reaction per party per message, any single emoji, replace on
// re-react (HT1 STEER). Refuses a non-emoji or multi-grapheme value
// rather than silently truncating it.
export function reactToMessage(message: Message, party: Party, emoji: string): Message {
  if (!isSingleEmoji(emoji)) {
    throw new MessageError('a reaction must be exactly one emoji');
  }
  return { ...message, reactions: { ...message.reactions, [party]: emoji } };
}

export function removeReaction(message: Message, party: Party): Message {
  return { ...message, reactions: { ...message.reactions, [party]: null } };
}

// Read receipts (HT1 STEER): per-party lastReadAt. Stored as a sibling
// record, not a field on Message (a read receipt is a fact about the
// READER's position in the thread, not about any one message -- the same
// separation KeyRotation and CompromiseReport already keep from the
// entity they describe, src/adapters/storage/types.ts's own header
// comments). Monotonic: marking read at an earlier instant than already
// recorded is a no-op, never a regression a stale client request could
// cause.
export interface ThreadReadState {
  readonly jobId: string;
  readonly party: Party;
  readonly lastReadAt: Date;
}

export function advanceReadState(current: ThreadReadState | null, jobId: string, party: Party, at: Date): ThreadReadState {
  if (current !== null && current.lastReadAt.getTime() >= at.getTime()) return current;
  return { jobId, party, lastReadAt: at };
}
