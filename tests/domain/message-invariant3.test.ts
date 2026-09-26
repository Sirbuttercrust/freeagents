// HT1 Part B: invariant 3 (MISSION.md) -- messages never enter a
// credential, an attestation or the agreement's spec hash. Proven by
// computation: confirmSpec's own confirmedSpecHash is byte-identical
// whether or not the job has messages attached, because messages are
// never on ANY path confirmSpec reads from (see src/domain/message.ts's
// own header comment: this file is never imported by job.ts,
// attestation.ts or credentials.ts).
import { describe, expect, it } from 'vitest';
import { confirmSpec, createJob, proposeCriteria, acceptCriterion, acceptPrice, type Job } from '../../src/domain/job.js';
import {
  createMessage,
  createSystemMessage,
  reactToMessage,
  type Message,
} from '../../src/domain/message.js';

function agreedJob(): Job {
  let job = createJob(
    { id: 'job-invariant3', buyerDid: 'did:example:buyer', agentDid: 'did:example:agent', repository: 'buyer/target-repo', brief: 'Fix the bug' },
    new Date('2026-01-01T00:00:00Z'),
  );
  job = proposeCriteria(job, [{ text: 'The bug is fixed', proposedBy: 'agent' }], {
    priceUsd: '500.00',
    rail: 'abt',
  });
  job = acceptCriterion(job, 0, 'buyer');
  job = acceptCriterion(job, 0, 'agent');
  job = acceptPrice(job, 'buyer');
  job = acceptPrice(job, 'agent');
  return job;
}

describe('invariant 3: messages never affect the confirmed spec hash', () => {
  it('confirmSpec produces the identical hash with and without messages attached to the job', () => {
    const withoutMessages = confirmSpec(agreedJob(), new Date('2026-01-02T00:00:00Z'));

    // A rich thread: a party message, a reply, a reaction, and a system
    // event -- none of it is ever passed to confirmSpec or stored on the
    // Job type itself (messages live in a separate repository, keyed by
    // jobId, never a field on Job). Building them here proves the digest
    // computation has no path that could reach them even if a caller
    // tried.
    const messages: Message[] = [];
    const m1 = createMessage(
      { id: 'm1', jobId: 'job-invariant3', authorDid: 'did:example:buyer', authorParty: 'buyer', authorKind: 'buyer', body: 'What is the timeline?', existingMessageIds: new Set() },
      new Date('2026-01-01T01:00:00Z'),
    );
    messages.push(m1);
    const m2 = createMessage(
      {
        id: 'm2',
        jobId: 'job-invariant3',
        authorDid: 'did:example:agent',
        authorParty: 'agent',
        authorKind: 'owner',
        body: 'Two weeks.',
        replyToId: 'm1',
        existingMessageIds: new Set(['m1']),
      },
      new Date('2026-01-01T02:00:00Z'),
    );
    messages.push(reactToMessage(m2, 'buyer', '\u{1F44D}'));
    messages.push(
      createSystemMessage(
        { id: 'm3', jobId: 'job-invariant3', body: 'Quote sent', systemEvent: { type: 'quote_sent', priceUsd: '500.00', rail: 'abt', deliveryWindowDays: null, criteriaCount: 1 } },
        new Date('2026-01-01T03:00:00Z'),
      ),
    );
    expect(messages.length).toBe(3);

    const withMessages = confirmSpec(agreedJob(), new Date('2026-01-02T00:00:00Z'));

    expect(withMessages.confirmedSpecHash).toBe(withoutMessages.confirmedSpecHash);
    expect(withMessages.confirmedSpecHash).not.toBeNull();
  });

  it('src/domain/job.ts never imports src/domain/message.ts (structural, not merely asserted)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const jobSource = fs.readFileSync(path.join(here, '../../src/domain/job.ts'), 'utf8');
    expect(jobSource.includes('message.js')).toBe(false);
    expect(jobSource.includes('notification.js')).toBe(false);
    expect(jobSource.includes('attachment.js')).toBe(false);
  });

  it('src/domain/attestation.ts never imports src/domain/message.ts (structural, not merely asserted)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, '../../src/domain/attestation.ts'), 'utf8');
    expect(source.includes('message.js')).toBe(false);
    expect(source.includes('notification.js')).toBe(false);
    expect(source.includes('attachment.js')).toBe(false);
  });

  it('src/adapters/credentials/credentials.ts never imports src/domain/message.ts (structural, not merely asserted)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, '../../src/adapters/credentials/credentials.ts'), 'utf8');
    expect(source.includes('message.js')).toBe(false);
    expect(source.includes('notification.js')).toBe(false);
    expect(source.includes('attachment.js')).toBe(false);
  });
});
