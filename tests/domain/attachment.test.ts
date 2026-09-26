// MSG1a (Make item 3): contentType is what the bytes route actually
// serves, not the uploaded kind. Every image kind re-encodes to JPEG on
// upload (reencodeImage, src/adapters/attachments/image.ts); a PDF is
// stored verbatim. contentTypeFor is the single source both the upload
// reply and the attachment list read, so the two can never disagree.
import { describe, expect, it } from 'vitest';
import { contentTypeFor, type AllowedAttachmentKind } from '../../src/domain/attachment.js';

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
