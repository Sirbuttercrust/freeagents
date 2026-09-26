// HT1 Part B (attachments STEER, 2026-09-25): local disk storage under a
// configurable directory (an env var with a generic default, never a
// hardcoded path in code), random file ids. Nothing public-facing: this
// directory is never mounted by src/web/static.ts's express.static
// calls, and this file exposes no directory-listing capability of its
// own.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// A generic default, no real deployment path baked in (CLAUDE.md "This
// repository is public": no absolute paths in committed code). Resolved
// relative to the process cwd at call time, matching how PORT's own
// default is read at call time rather than baked into a constant.
const DEFAULT_ATTACHMENTS_DIR = './var/attachments';

export function attachmentsDirFromEnv(): string {
  const configured = process.env.FREEAGENTS_ATTACHMENTS_DIR || DEFAULT_ATTACHMENTS_DIR;
  return resolve(configured);
}

// A random, unguessable file id -- never the original filename (STEER:
// "random file ids"), never derived from anything a caller supplied.
export function randomFileId(): string {
  return randomBytes(16).toString('hex');
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

// Writes bytes under the attachments directory at a random-id-derived
// path, creating the directory if needed. Returns the path a later
// readAttachmentFile call can use to read it back -- an opaque handle
// this module owns the meaning of, never exposed to a client.
export async function writeAttachmentFile(dir: string, id: string, bytes: Buffer): Promise<string> {
  await ensureDir(dir);
  const path = join(dir, id);
  await writeFile(path, bytes);
  return path;
}

export async function readAttachmentFile(path: string): Promise<Buffer> {
  return readFile(path);
}
