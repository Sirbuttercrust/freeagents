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

// MSG1a (Make item 3, defect line: "the full-size image is served under
// the wrong type"): every image kind is re-encoded to JPEG on upload
// (reencodeImage, src/adapters/attachments/image.ts), but the bytes
// route used to answer with the UPLOADED kind, so a PNG or HEIC upload
// was served as image/png or image/heic over JPEG bytes. This is the
// single source of what the bytes route actually serves for a full-size
// file: the upload reply and the attachment list route both read it, so
// the two responses can never disagree with each other or with the
// bytes. `kind` itself keeps its existing meaning (the type detected
// from the uploaded bytes) everywhere it already appears; this function
// only answers a second, distinct question.
export function contentTypeFor(kind: AllowedAttachmentKind): 'image/jpeg' | 'application/pdf' {
  return isImageKind(kind) ? 'image/jpeg' : 'application/pdf';
}

// FIX-SW4f (SW4-05): how many uploads a caller may hold that no
// message carries. The conversation page sends each upload within seconds
// of storing it, so these numbers are far above real use and only stop a
// caller that stores files it never sends.
//
// 10 on one job: room for a person picking several files on a slow link.
export const UNSENT_UPLOADS_PER_JOB = 10;
// 20 across every job: room for several open conversations at once.
export const UNSENT_UPLOADS_PER_ACCOUNT = 20;
// One hour: far past any real send. An upload older than this stops
// counting, may not be put in a message, and is removed by the sweep.
export const UNSENT_UPLOAD_TTL_MS = 60 * 60 * 1000;

// The fields the counting rule reads from a stored upload.
export interface UnsentUploadRow {
  readonly jobId: string;
  readonly messageId: string | null;
  readonly createdAt: Date;
}

// True when an upload is too old for a message to carry it.
export function unsentUploadExpired(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() > UNSENT_UPLOAD_TTL_MS;
}

// Which cap a caller's next upload to `jobId` would pass: 'job' when it
// already holds UNSENT_UPLOADS_PER_JOB unsent uploads on that job, 'account'
// when it holds UNSENT_UPLOADS_PER_ACCOUNT across every job, else null. A row
// a message carries, or one past the TTL, does not count. The job cap is
// named first when both bind, because sending a file here clears it. Pure.
export function unsentUploadCapReached(
  rows: readonly UnsentUploadRow[],
  jobId: string,
  now: Date,
): 'job' | 'account' | null {
  const counting = rows.filter((row) => row.messageId === null && !unsentUploadExpired(row.createdAt, now));
  if (counting.filter((row) => row.jobId === jobId).length >= UNSENT_UPLOADS_PER_JOB) return 'job';
  if (counting.length >= UNSENT_UPLOADS_PER_ACCOUNT) return 'account';
  return null;
}

// One stored attachment record. `path` and `thumbnailPath` are random
// file ids under the configurable storage directory (never the
// original filename, never a caller-guessable path) -- see
// src/adapters/attachments/storage.ts for the directory resolution and
// the id generation. Never the original bytes: an image row's `path`
// names the RE-ENCODED file (EXIF stripped), and a PDF row's `path`
// names the uploaded bytes verbatim (a PDF has no EXIF/GPS payload to
// strip, and the brief's re-encode instruction is scoped to images).
//
// `messageId` (FIX-SW4f) is the id of the message recorded as carrying
// this upload. The unsent-upload quota and the sweep read it: null means
// no message has been recorded as carrying it, which is true of a fresh
// upload, of a row stored before the column existed, and of a row whose
// markSent failed.
export interface Attachment {
  readonly id: string;
  readonly jobId: string;
  readonly uploaderDid: string;
  readonly kind: AllowedAttachmentKind;
  readonly originalFilename: string;
  readonly sizeBytes: number;
  readonly path: string;
  readonly thumbnailPath: string | null;
  readonly messageId: string | null;
  readonly createdAt: Date;
}
