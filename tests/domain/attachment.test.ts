// MSG1a (Make item 3): contentType is what the bytes route actually
// serves, not the uploaded kind. Every image kind re-encodes to JPEG on
// upload (reencodeImage, src/adapters/attachments/image.ts); a PDF is
// stored verbatim. contentTypeFor is the single source both the upload
// reply and the attachment list read, so the two can never disagree.
import { describe, expect, it } from 'vitest';
import {
  UNSENT_UPLOADS_PER_ACCOUNT,
  UNSENT_UPLOADS_PER_JOB,
  UNSENT_UPLOAD_TTL_MS,
  contentTypeFor,
  unsentUploadCapReached,
  unsentUploadExpired,
  type AllowedAttachmentKind,
  type UnsentUploadRow,
} from '../../src/domain/attachment.js';

describe('contentTypeFor: what the bytes route actually serves (MSG1a make item 3)', () => {
  it.each<[AllowedAttachmentKind, string]>([
    ['image/png', 'image/jpeg'],
    ['image/jpeg', 'image/jpeg'],
    ['image/webp', 'image/jpeg'],
    ['image/heic', 'image/jpeg'],
    ['application/pdf', 'application/pdf'],
  ])('%s serves as %s', (kind, expected) => {
    expect(contentTypeFor(kind)).toBe(expected);
  });
});

// FIX-SW4f (bugs.md SW4-05): the counting rule behind the 429.
describe('unsentUploadCapReached: which unsent-upload cap binds (FIX-SW4f)', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  const row = (jobId: string, ageMs: number, messageId: string | null = null): UnsentUploadRow => ({
    jobId,
    messageId,
    createdAt: new Date(now.getTime() - ageMs),
  });
  const many = (jobId: string, n: number, ageMs = 1000): UnsentUploadRow[] => Array.from({ length: n }, () => row(jobId, ageMs));

  it('the numbers are 10 a job, 20 an account, one hour', () => {
    expect([UNSENT_UPLOADS_PER_JOB, UNSENT_UPLOADS_PER_ACCOUNT, UNSENT_UPLOAD_TTL_MS]).toEqual([10, 20, 3_600_000]);
  });

  it('nine on the job and none elsewhere: no cap binds', () => {
    expect(unsentUploadCapReached(many('j1', 9), 'j1', now)).toBeNull();
  });

  it('ten on the job: the job cap binds', () => {
    expect(unsentUploadCapReached(many('j1', 10), 'j1', now)).toBe('job');
  });

  it('ten on another job do not bind this job', () => {
    expect(unsentUploadCapReached(many('j2', 10), 'j1', now)).toBeNull();
  });

  it('twenty across three jobs, none at ten: the account cap binds', () => {
    const rows = [...many('j1', 7), ...many('j2', 7), ...many('j3', 6)];
    expect(unsentUploadCapReached(rows, 'j4', now)).toBe('account');
  });

  it('nineteen across jobs: no cap binds', () => {
    const rows = [...many('j1', 7), ...many('j2', 6), ...many('j3', 6)];
    expect(unsentUploadCapReached(rows, 'j4', now)).toBeNull();
  });

  it('when both bind, the job cap is the one named', () => {
    expect(unsentUploadCapReached([...many('j1', 10), ...many('j2', 10)], 'j1', now)).toBe('job');
  });

  it('a row a message carries does not count', () => {
    const rows = [...many('j1', 9), row('j1', 1000, 'm-1')];
    expect(unsentUploadCapReached(rows, 'j1', now)).toBeNull();
  });

  it('a row older than an hour does not count, and one exactly an hour old still does', () => {
    expect(unsentUploadCapReached([...many('j1', 9), row('j1', UNSENT_UPLOAD_TTL_MS + 1)], 'j1', now)).toBeNull();
    expect(unsentUploadCapReached([...many('j1', 9), row('j1', UNSENT_UPLOAD_TTL_MS)], 'j1', now)).toBe('job');
  });
});

describe('unsentUploadExpired: a message may carry only a fresh upload (FIX-SW4f)', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  it('an upload an hour old is fresh, one a millisecond older is expired', () => {
    expect(unsentUploadExpired(new Date(now.getTime() - UNSENT_UPLOAD_TTL_MS), now)).toBe(false);
    expect(unsentUploadExpired(new Date(now.getTime() - UNSENT_UPLOAD_TTL_MS - 1), now)).toBe(true);
  });
});
