import { createHash } from 'node:crypto';

/**
 * Hashes a spec string using SHA-256 and returns the lowercase hex representation
 * with proper normalisation:
 * - trailing whitespace stripped per line
 * - line endings normalised to \n
 * - no trailing newline
 */
export function hashSpec(spec: string): string {
  // Normalise line endings to \n
  let normalised = spec.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  
  // Strip trailing whitespace per line and remove empty lines at the end
  const lines = normalised.split('\n');
  const trimmedLines = lines.map(line => line.trimEnd());
  normalised = trimmedLines.join('\n');
  
  // Remove trailing newline if present
  if (normalised.endsWith('\n')) {
    normalised = normalised.slice(0, -1);
  }
  
  // Hash the normalised spec
  const hash = createHash('sha256');
  hash.update(normalised);
  const hashHex = hash.digest('hex');
  return `sha256:${hashHex}`;
}