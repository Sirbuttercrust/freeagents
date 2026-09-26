// HT1 Part B (attachments STEER, 2026-09-25): the pure rules an
// attachment must satisfy, checked from the file's OWN BYTES, never from
// its name or the client's declared content type (the brief's own
// wording, restated as this module's whole reason to exist). No vendor
// import here: re-encoding needs sharp, which is an adapter concern
// (src/adapters/attachments/image.ts); this file only decides what is
// ALLOWED, never how to transform it.
export type AllowedAttachmentKind = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/heic' | 'application/pdf';

// 10 MB cap per file (the brief's own number).
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentError';
  }
}

// Reads the magic bytes at the front of a buffer and names the one kind
// they match, or null when none of the five allowed kinds' signature is
// present. Total: any buffer in (including an empty one), never throws.
//
// PNG: the fixed 8-byte PNG signature (RFC 2083).
// JPEG: the SOI marker FF D8 FF (every real JPEG, baseline or
//   progressive, starts here; JFIF/EXIF/Adobe markers all follow it).
// WebP: the RIFF container with a WEBP form type at byte 8 (RIFF's own
//   12-byte header: 'RIFF', 4-byte size, 'WEBP').
// HEIC/HEIF: an ISO base media file format box whose FIRST box is
//   'ftyp' (bytes 4-7) naming one of the HEIF/HEIC major brands at
//   bytes 8-11. AVIF shares the exact same container and is
//   DELIBERATELY not in this brand list: the brief names PNG, JPEG,
//   WebP and HEIC, not AVIF.
// PDF: the '%PDF-' signature every PDF file begins with (ISO 32000).
export function detectMagicBytes(buffer: Buffer): AllowedAttachmentKind | null {
  if (buffer.length < 12) return null;

  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii');
    const heifBrands = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
    if (heifBrands.has(brand)) return 'image/heic';
  }

  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') {
    return 'application/pdf';
  }

  return null;
}

// The one gate every upload passes: size, then magic bytes. Refuses a
// `.png`-named file whose bytes are not actually a PNG (or anything else
// on the allow list), and refuses anything over the cap regardless of
// its declared name or content type. Total: throws AttachmentError on a
// refusal, never a silent pass.
export function assertAttachmentAllowed(buffer: Buffer): AllowedAttachmentKind {
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(`attachment exceeds the ${MAX_ATTACHMENT_BYTES} byte cap`);
  }
  const kind = detectMagicBytes(buffer);
  if (kind === null) {
    throw new AttachmentError(
      'attachment is not a recognised PNG, JPEG, WebP, HEIC or PDF file (checked from its bytes, never its name)',
    );
  }
  return kind;
}

export function isImageKind(kind: AllowedAttachmentKind): boolean {
  return kind !== 'application/pdf';
}

// One stored attachment record. `path` and `thumbnailPath` are random
// file ids under the configurable storage directory (never the
// original filename, never a caller-guessable path) -- see
// src/adapters/attachments/storage.ts for the directory resolution and
// the id generation. Never the original bytes: an image row's `path`
// names the RE-ENCODED file (EXIF stripped), and a PDF row's `path`
// names the uploaded bytes verbatim (a PDF has no EXIF/GPS payload to
// strip, and the brief's re-encode instruction is scoped to images).
export interface Attachment {
  readonly id: string;
  readonly jobId: string;
  readonly uploaderDid: string;
  readonly kind: AllowedAttachmentKind;
  readonly originalFilename: string;
  readonly sizeBytes: number;
  readonly path: string;
  readonly thumbnailPath: string | null;
  readonly createdAt: Date;
}
