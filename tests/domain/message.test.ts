// MSG1a (Make item 5, brief: "a photo cannot be sent without words...
// iMessage sends a bare photo"): createMessage's empty-body rule, pinned
// at the domain layer directly (the route-level acceptance test lives in
// tests/api/hire-thread-messages.test.ts).
import { describe, expect, it } from 'vitest';
import { createMessage, MessageError, MESSAGE_BODY_MAX_LENGTH } from '../../src/domain/message.js';

describe('createMessage: the empty-body rule (MSG1a, make item 5)', () => {
  it('refuses an empty body when no attachments are named', () => {
    expect(() =>
      createMessage(
        {
          id: 'm1',
          jobId: 'job-1',
          authorDid: 'did:example:buyer',
          authorParty: 'buyer',
          authorKind: 'buyer',
          body: '',
          existingMessageIds: new Set(),
        },
        new Date('2026-01-01T00:00:00Z'),
      ),
    ).toThrow(MessageError);
  });

  it('accepts an empty body when at least one attachment is named', () => {
    const message = createMessage(
      {
        id: 'm2',
        jobId: 'job-1',
        authorDid: 'did:example:buyer',
        authorParty: 'buyer',
        authorKind: 'buyer',
        body: '',
        existingMessageIds: new Set(),
        attachments: [{ attachmentId: 'a1' }],
      },
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(message.body).toBe('');
    expect(message.attachments).toEqual([{ attachmentId: 'a1' }]);
  });

  it('still refuses a body over the length cap even with attachments present', () => {
    expect(() =>
      createMessage(
        {
          id: 'm3',
          jobId: 'job-1',
          authorDid: 'did:example:buyer',
          authorParty: 'buyer',
          authorKind: 'buyer',
          body: 'x'.repeat(MESSAGE_BODY_MAX_LENGTH + 1),
          existingMessageIds: new Set(),
          attachments: [{ attachmentId: 'a1' }],
        },
        new Date('2026-01-01T00:00:00Z'),
      ),
    ).toThrow(MessageError);
  });

  it('a message with no attachments still needs a body between 1 and the cap, unchanged', () => {
    const message = createMessage(
      {
        id: 'm4',
        jobId: 'job-1',
        authorDid: 'did:example:buyer',
        authorParty: 'buyer',
        authorKind: 'buyer',
        body: 'hello',
        existingMessageIds: new Set(),
      },
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(message.body).toBe('hello');
  });
});
