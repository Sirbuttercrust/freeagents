// HT1 Part B (attachments STEER, 2026-09-25): re-encodes an uploaded
// image server-side so EXIF/GPS and any trailing payload never survive
// into storage (the brief's own words: "the original bytes are never
// kept"). sharp (Apache-2.0) is the dependency choice; see this
// repository's PR body for the justification CLAUDE.md's dependency rule
// requires. This is the only file in the repository that imports sharp,
// mirroring how src/adapters/github/github.ts is the only file that
// knows GitHub's REST shape exists.
//
// KNOWN CAVEAT (sharp's own documented limitation, not a bug in this
// adapter): sharp's prebuilt binaries ship libvips without HEVC/HEIC
// decode support, because HEVC remains patent-encumbered
// (github.com/lovell/sharp/issues/4132). A deployment that needs to
// accept real HEIC uploads must install a libvips build compiled against
// libheif itself (sharp.pixelplumbing.com/install#building-from-source);
// this adapter does not attempt to work around that, and a HEIC input
// sharp cannot decode on this deployment surfaces as the same
// ImageReencodeError every other decode failure does, never a silent
// pass-through of the original bytes.
import sharp from 'sharp';

export class ImageReencodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageReencodeError';
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

// Decodes the uploaded bytes and re-encodes them from scratch. sharp's
// own toBuffer()/toFile() strip all metadata by default (the library's
// own documented behaviour: "By default all metadata will be removed,
// which includes EXIF-based orientation") -- this adapter does not ask
// for withMetadata/keepExif anywhere, which is exactly what makes the
// strip happen. autoOrient normalizes any EXIF orientation flag into the
// pixel data itself BEFORE that flag is discarded, so a photo taken
// sideways does not silently rotate once its orientation tag is gone.
export async function reencodeImage(buffer: Buffer): Promise<ReencodedImage> {
  try {
    const pipeline = sharp(buffer, { failOn: 'error' }).autoOrient();
    const bytes = await pipeline.clone().jpeg({ quality: 90 }).toBuffer();
    const thumbnailBytes = await pipeline
      .clone()
      .resize({ width: THUMBNAIL_MAX_EDGE, height: THUMBNAIL_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return { bytes, thumbnailBytes };
  } catch (err) {
    throw new ImageReencodeError(
      `could not decode and re-encode the uploaded image: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
