// MSG1a (Make item 1): the pure rules behind GET /accounts/:did/threads.
// No vendor import, no Express type -- testable with nothing but
// src/domain/job.ts's Party and src/domain/message.ts's Message shape,
// the same convention tests/domain/job-list.test.ts already exercises.
import { describe, expect, it } from 'vitest';
import { createMessage, createSystemMessage, type Message, type AuthorKind, type MessageAttachmentRef } from '../../src/domain/message.js';
import type { Party } from '../../src/domain/job.js';
import { bodyPreviewOf, lastMessageOf, lastActivityAtOf, threadUnreadCount } from '../../src/domain/thread-list.js';

function partyMessage(overrides: {
  readonly id: string;
  readonly body: string;
  readonly createdAt: Date;
  readonly jobId?: string;
  readonly authorDid?: string;
  readonly authorParty?: Party;
  readonly authorKind?: AuthorKind;
  readonly attachments?: readonly MessageAttachmentRef[];
}): Message {
  return createMessage(
    {
      id: overrides.id,
      jobId: overrides.jobId ?? 'job-1',
      authorDid: overrides.authorDid ?? 'did:example:buyer',
      authorParty: overrides.authorParty ?? 'buyer',
      authorKind: overrides.authorKind ?? 'buyer',
      body: overrides.body,
      existingMessageIds: new Set(),
      ...(overrides.attachments !== undefined ? { attachments: overrides.attachments } : {}),
    },
    overrides.createdAt,
  );
}

describe('bodyPreviewOf: first 200 CODE POINTS, never a broken surrogate pair', () => {
  it('previews at 200 code points, not 200 UTF-16 units, for a string over the limit', () => {
    // An emoji outside the BMP is TWO UTF-16 code units but ONE code
    // point. 250 of them is 250 code points (500 UTF-16 units); the
    // preview must be exactly 200 code points, and every one of them a
    // complete, unbroken emoji.
    const body = '\u{1F600}'.repeat(250);
    const preview = bodyPreviewOf(body);
    expect(Array.from(preview).length).toBe(200);
    expect(preview).toBe('\u{1F600}'.repeat(200));
  });

  it('a short body previews unchanged', () => {
    expect(bodyPreviewOf('hello')).toBe('hello');
  });

  it('an empty body previews as empty (an attachment-only message)', () => {
    expect(bodyPreviewOf('')).toBe('');
  });
});

describe('lastMessageOf: the newest row, or null for an empty thread', () => {
  it('null when the thread has no message rows', () => {
    expect(lastMessageOf([])).toBeNull();
  });

  it('the newest row by createdAt, not the last one pushed', () => {
    const older = partyMessage({ id: 'm1', body: 'first', createdAt: new Date('2026-01-01T00:00:00Z') });
    const newer = partyMessage({ id: 'm2', body: 'second', createdAt: new Date('2026-01-02T00:00:00Z'), authorParty: 'agent', authorKind: 'owner' });
    const result = lastMessageOf([newer, older]);
    expect(result?.bodyPreview).toBe('second');
    expect(result?.authorParty).toBe('agent');
    expect(result?.authorKind).toBe('owner');
  });

  it('carries attachmentCount and an empty bodyPreview for an attachment-only row', () => {
    const row = partyMessage({ id: 'm3', body: '', createdAt: new Date('2026-01-01T00:00:00Z'), attachments: [{ attachmentId: 'a1' }] });
    const result = lastMessageOf([row]);
    expect(result?.bodyPreview).toBe('');
    expect(result?.attachmentCount).toBe(1);
  });

  it('carries systemEventType for a system row, null for a party row', () => {
    const systemRow = createSystemMessage(
      { id: 'sys1', jobId: 'job-1', body: 'Quote sent', systemEvent: { type: 'quote_sent', priceUsd: '500.00', rail: 'abt', deliveryWindowDays: null, criteriaCount: 1 } },
      new Date('2026-01-03T00:00:00Z'),
    );
    const partyRow = partyMessage({ id: 'm4', body: 'hi', createdAt: new Date('2026-01-01T00:00:00Z') });
    expect(lastMessageOf([systemRow])?.systemEventType).toBe('quote_sent');
    expect(lastMessageOf([partyRow])?.systemEventType).toBeNull();
  });
});

describe('lastActivityAtOf: the later of the job\'s createdAt and its newest message', () => {
  it('the job createdAt when there are no messages yet', () => {
    const jobCreatedAt = new Date('2026-01-01T00:00:00Z');
    expect(lastActivityAtOf(jobCreatedAt, [])).toEqual(jobCreatedAt);
  });

  it('the newest message time when it is later than the job createdAt', () => {
    const jobCreatedAt = new Date('2026-01-01T00:00:00Z');
    const msg = partyMessage({ id: 'm1', body: 'hi', createdAt: new Date('2026-01-05T00:00:00Z') });
    expect(lastActivityAtOf(jobCreatedAt, [msg])).toEqual(new Date('2026-01-05T00:00:00Z'));
  });

  it('the job createdAt when it is later than every message (should not happen, but never regresses)', () => {
    const jobCreatedAt = new Date('2026-01-10T00:00:00Z');
    const msg = partyMessage({ id: 'm1', body: 'hi', createdAt: new Date('2026-01-05T00:00:00Z') });
    expect(lastActivityAtOf(jobCreatedAt, [msg])).toEqual(jobCreatedAt);
  });
});

describe('threadUnreadCount: rows from the OTHER seat after lastReadAt, plus the agent brief bonus', () => {
  it('all messages from the other party count when lastReadAt is null (never read)', () => {
    const messages = [
      { authorParty: 'buyer' as const, createdAt: new Date('2026-01-01T00:00:00Z') },
      { authorParty: 'buyer' as const, createdAt: new Date('2026-01-02T00:00:00Z') },
    ];
    expect(threadUnreadCount('agent', messages, null)).toBe(2 + 1); // + the brief bonus for 'agent'
    expect(threadUnreadCount('buyer', messages, null)).toBe(0); // own messages never count
  });

  it('only messages created after lastReadAt count', () => {
    const lastReadAt = new Date('2026-01-02T00:00:00Z');
    const messages = [
      { authorParty: 'agent' as const, createdAt: new Date('2026-01-01T00:00:00Z') },
      { authorParty: 'agent' as const, createdAt: new Date('2026-01-03T00:00:00Z') },
    ];
    expect(threadUnreadCount('buyer', messages, lastReadAt)).toBe(1);
  });

  it('a system row counts as unread for both seats', () => {
    const messages = [{ authorParty: 'system' as const, createdAt: new Date('2026-01-01T00:00:00Z') }];
    expect(threadUnreadCount('buyer', messages, null)).toBe(1);
    expect(threadUnreadCount('agent', messages, null)).toBe(1 + 1); // + the brief bonus
  });

  it('the agent brief bonus disappears once the agent seat has any read state at all, even a stale one', () => {
    const oldRead = new Date('2020-01-01T00:00:00Z');
    expect(threadUnreadCount('agent', [], oldRead)).toBe(0);
  });

  it('a buyer never gets the brief bonus, even when unread', () => {
    expect(threadUnreadCount('buyer', [], null)).toBe(0);
  });
});
