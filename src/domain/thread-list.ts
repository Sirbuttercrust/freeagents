// MSG1a (Make item 1): the pure rules behind GET /accounts/:did/threads.
// No vendor import, no Express type -- the same "adapters may import
// domain, never the reverse" convention job-list.ts already keeps.
import type { Party } from './job.js';
import type { AuthorKind, AuthorParty, Message, SystemEvent } from './message.js';

// The first 200 CODE POINTS of a message body, never 200 UTF-16 code
// units: Array.from splits by code point (the iterator protocol a
// string exposes), so a surrogate-pair emoji straddling the 200th
// position is never cut in half the way body.slice(0, 200) could cut
// it. Total: an empty string previews as an empty string (an
// attachment-only message).
export function bodyPreviewOf(body: string): string {
  return Array.from(body).slice(0, 200).join('');
}

export interface ThreadLastMessage {
  readonly authorParty: AuthorParty;
  readonly authorKind: AuthorKind;
  readonly bodyPreview: string;
  readonly attachmentCount: number;
  readonly systemEventType: SystemEvent['type'] | null;
  readonly createdAt: Date;
}

// null when the thread has no message rows at all (the brief itself is
// a Job field, never a Message row, so a job with zero posted messages
// answers null here even though it already has a brief). Otherwise the
// NEWEST row by createdAt.
export function lastMessageOf(messages: readonly Message[]): ThreadLastMessage | null {
  if (messages.length === 0) return null;
  const newest = messages.reduce((a, b) => (b.createdAt.getTime() > a.createdAt.getTime() ? b : a));
  return {
    authorParty: newest.authorParty,
    authorKind: newest.authorKind,
    bodyPreview: bodyPreviewOf(newest.body),
    attachmentCount: newest.attachments.length,
    systemEventType: newest.systemEvent === null ? null : newest.systemEvent.type,
    createdAt: newest.createdAt,
  };
}

// The later of the job's own createdAt (the brief) and its newest
// message's createdAt -- a thread with no messages yet is exactly as
// fresh as its brief.
export function lastActivityAtOf(jobCreatedAt: Date, messages: readonly Message[]): Date {
  const newestMessageAt = messages.reduce<Date | null>(
    (latest, m) => (latest === null || m.createdAt.getTime() > latest.getTime() ? m.createdAt : latest),
    null,
  );
  if (newestMessageAt === null) return jobCreatedAt;
  return newestMessageAt.getTime() > jobCreatedAt.getTime() ? newestMessageAt : jobCreatedAt;
}

// The rows written by anyone but the caller's own seat (the other
// party's messages and every system row), created after the caller
// seat's lastReadAt -- all of them when the seat has never read
// (lastReadAt null). For the 'agent' seat, the brief itself counts as
// one more unread until that seat has ANY read state at all (a new
// brief shows as unread to the owner, the "first line of communication"
// ruling); a buyer's own brief never counts, because the buyer wrote it.
export function threadUnreadCount(
  seat: Party,
  messages: readonly { readonly authorParty: AuthorParty; readonly createdAt: Date }[],
  lastReadAt: Date | null,
): number {
  const unreadMessages = messages.filter(
    (m) => m.authorParty !== seat && (lastReadAt === null || m.createdAt.getTime() > lastReadAt.getTime()),
  ).length;
  const briefBonus = seat === 'agent' && lastReadAt === null ? 1 : 0;
  return unreadMessages + briefBonus;
}
