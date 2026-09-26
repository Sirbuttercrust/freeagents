// HT1 Part B (attachments STEER, 2026-09-25): re-encodes an uploaded
// image server-side so EXIF/GPS and any trailing payload never survive
// into storage (the brief's own words: "the original bytes are never
// kept"). sharp (Apache-2.0) is the dependency choice; see this
// repository's PR body for the justification CLAUDE.md's dependency rule
// requires. sharp remains the only library this adapter re-encodes
// PNG/JPEG/WebP through, mirroring how src/adapters/github/github.ts is
// the only file that knows GitHub's REST shape exists.
//
// HEIC (Proof r1, defect 1): sharp's prebuilt binaries ship libvips
// without HEVC/HEIC decode support, because HEVC remains
// patent-encumbered (github.com/lovell/sharp/issues/4132) -- building
// libvips against libheif from source is not something this deployment
// can require. heic-convert (ISC, catdad-experiments, 321 GitHub stars,
// last published 2026-09-05) decodes HEIC/HEIF through a WASM build of
// libheif (its own dependency libheif-js) with no native compile step,
// so it works on any Node runtime without a special libvips build. It
// is used ONLY to turn the HEIC bytes into a PNG buffer; that PNG buffer
// is then handed to the exact same sharp pipeline every other image
// takes, so EXIF stripping, auto-orient and the thumbnail all go through
// the one re-encode path this file already had. See this repository's
// PR body for the dependency justification CLAUDE.md's rule requires.
import sharp from 'sharp';
import heicConvert from 'heic-convert';

// `detail` carries the underlying decoder's own message (libvips,
// heic-convert, whichever ran) for the SERVER's own log only -- never
// read by the route when building the client-facing response (Proof r1,
// defect 1: raw libvips text must never reach the client). `message`
// stays the one fixed, library-agnostic sentence every caller sees.
export class ImageReencodeError extends Error {
  readonly detail: string;
  constructor(message: string, detail: string) {
    super(message);
    this.name = 'ImageReencodeError';
    this.detail = detail;
  }
}

export interface ReencodedImage {
  readonly bytes: Buffer;
  readonly thumbnailBytes: Buffer;
}

// The thumbnail's longest edge, in pixels. A product value (a cap is a
// product value per FACTORY_RULES 7.1), generous enough to preview a
// document scan, small enough to stay a genuine thumbnail.
const THUMBNAIL_MAX_EDGE = 480;

// Decodes a HEIC buffer to a PNG buffer via heic-convert, so the rest of
// this file's pipeline never needs to know HEIC was ever involved. Any
// decode failure surfaces through the SAME ImageReencodeError every
// other decode failure does, with the underlying library's own message
// contained rather than leaked as an uncaught rejection.
async function heicToPngBuffer(buffer: Buffer): Promise<Buffer> {
  const converted = await heicConvert({ buffer: new Uint8Array(buffer), format: 'PNG' });
  return Buffer.from(converted);
}

// Decodes the uploaded bytes and re-encodes them from scratch. sharp's
// own toBuffer()/toFile() strip all metadata by default (the library's
// own documented behaviour: "By default all metadata will be removed,
// which includes EXIF-based orientation") -- this adapter does not ask
// for withMetadata/keepExif anywhere, which is exactly what makes the
// strip happen. autoOrient normalizes any EXIF orientation flag into the
// pixel data itself BEFORE that flag is discarded, so a photo taken
// sideways does not silently rotate once its orientation tag is gone.
//
// `isHeic` names whether the CALLER already identified the upload as
// HEIC from its magic bytes (src/domain/attachment.ts's own
// detectMagicBytes): this function trusts that classification rather
// than re-sniffing, so the one place format detection happens stays the
// domain layer, never duplicated here.
export async function reencodeImage(buffer: Buffer, isHeic = false): Promise<ReencodedImage> {
  try {
    const decodableBytes = isHeic ? await heicToPngBuffer(buffer) : buffer;
    const pipeline = sharp(decodableBytes, { failOn: 'error' }).autoOrient();
    const bytes = await pipeline.clone().jpeg({ quality: 90 }).toBuffer();
    const thumbnailBytes = await pipeline
      .clone()
      .resize({ width: THUMBNAIL_MAX_EDGE, height: THUMBNAIL_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return { bytes, thumbnailBytes };
  } catch (err) {
    // Never the underlying library's raw text reaching the client
    // (Proof r1, defect 1): the message is logged in full by the route's
    // own console.error (via ImageReencodeError.detail), but the error
    // THROWN here carries a fixed, library-agnostic sentence so a
    // caller never learns which decoder failed or how.
    const detail = err instanceof Error ? err.message : String(err);
    throw new ImageReencodeError('could not decode and re-encode the uploaded image', detail);
  }
}
