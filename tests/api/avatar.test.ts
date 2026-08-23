import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { renderAvatar } from '../../src/api/avatar.js';

/**
 * WHY THESE TESTS ASSERT PROPERTIES, NOT PIXELS.
 *
 * An avatar's pixels cannot be hand-computed or recalled, so a literal
 * expected-SVG here would be a fabricated constant: worse than no test,
 * because it fails correct code and invites bending the renderer toward a
 * meaningless string (the hashSpec failure of 2026-08-19, issue #2). What
 * CAN be asserted is exactly what the wire contract needs:
 *
 *   - determinism: the same DID renders the same string, always;
 *   - a closed determinism surface: the source reads its input and nothing
 *     else - no clock, no randomness, no environment;
 *   - shape: an SVG document with the fixed viewBox, inline, self-contained;
 *   - distinctness on samples: different DIDs render differently. This is
 *     sampling, not a proof - global injectivity is unprovable for ANY
 *     finite-trait renderer, the upstream package included. If a real
 *     collision ever surfaces, widen the trait space; never weaken the
 *     claim silently.
 *
 * The empty string is a legal input: renderAvatar is total, and the empty
 * DID renders the zero-digest avatar deterministically like any other.
 */

const here = dirname(fileURLToPath(import.meta.url));

// Fixtures: realistic did:abt:<base58> forms plus degenerate shapes. None of
// these values is special; they are inputs, not expectations.
const FIXTURE_DIDS = [
  'did:abt:zNKtD5hwiSDiwLrD6tAQRNTN1ZiDBBpaKrb',
  'did:abt:z8HeJQVh7ELTQhXhpC9ksH2ciE13ib6Ymr',
  'did:abt:zShort',
  'did:abt:a',
  'not a did at all',
  '',
];

// Digest byte accessor mirroring the renderer's documented derivation; used
// to locate fixture inputs that exercise each outcome of a selection.
const byteOf = (did: string, index: number): number =>
  createHash('sha256').update(did, 'utf8').digest()[index] ?? 0;

// Deterministically searches a small DID space for an input whose byte at
// `index` hits `residue` mod `mod`, so every arm of a discrete selection gets
// a pinned input regardless of what the digest values happen to be.
const findDidWithByteResidue = (label: string, index: number, residue: number, mod: number): string => {
  for (let n = 0; n < 10000; n++) {
    const did = `did:abt:${label}${n.toString(36)}`;
    if (byteOf(did, index) % mod === residue) return did;
  }
  throw new Error(`no ${label} fixture found with byte ${index} ≡ ${residue} mod ${mod}`);
};

describe('renderAvatar', () => {
  it('is deterministic: every fixture renders identically twice', () => {
    for (const did of FIXTURE_DIDS) {
      expect(renderAvatar(did), `unstable output for ${JSON.stringify(did)}`).toBe(renderAvatar(did));
    }
  });

  it('reads its input and nothing else - no clock, randomness, environment or network surface', () => {
    // Cross-process stability rests on the source being pure, so this is
    // checked structurally against the file itself (domain-purity style),
    // not just behaviourally against one call.
    const src = readFileSync(join(here, '../../src/api/avatar.ts'), 'utf8');
    const banned = ['Math.random', 'Date.now', 'performance.now', 'process.env'];
    const hits = banned.filter((token) => src.includes(token));
    expect(hits, `determinism hazards found in avatar.ts: ${hits.join(', ')}`).toEqual([]);
  });

  it('returns a self-contained SVG document with the pinned viewBox', () => {
    for (const did of FIXTURE_DIDS) {
      const svg = renderAvatar(did);
      expect(svg.startsWith('<svg'), `bad opening for ${JSON.stringify(did)}`).toBe(true);
      expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(svg).toContain('viewBox="0 0 64 64"');
      expect(svg.endsWith('</svg>'), `bad closing for ${JSON.stringify(did)}`).toBe(true);
    }
  });

  it('stays under the projection weight limit', () => {
    // The avatar rides every agent response unconditionally, so its size is
    // part of the wire budget, not an implementation detail.
    for (const did of FIXTURE_DIDS) {
      expect(renderAvatar(did).length, `oversized for ${JSON.stringify(did)}`).toBeLessThan(2048);
    }
  });

  it('renders 200 sampled DIDs with no two alike (sampled, not proven)', () => {
    // Keyed by the rendered SVG: a duplicate value IS a colliding pair, so
    // this is the all-pairs claim stated in linear time.
    const seen = new Map<string, string>();
    for (let i = 0; i < 200; i++) {
      const did = `did:abt:${crypto.randomUUID()}`;
      const svg = renderAvatar(did);
      const clash = seen.get(svg);
      expect(clash, `${did} and ${clash} rendered the same avatar`).toBeUndefined();
      seen.set(svg, did);
    }
  });

  it('renders adjacent DIDs differently', () => {
    // Neighbouring inputs are where lazy derivations (prefixing, truncation)
    // collapse; byte-level divergence must show immediately.
    expect(renderAvatar('did:abt:a')).not.toBe(renderAvatar('did:abt:b'));
    expect(renderAvatar('did:abt:z1')).not.toBe(renderAvatar('did:abt:z2'));
    expect(renderAvatar('did:abt:agent')).not.toBe(renderAvatar('did:abt:agemt'));
  });

  // The two tests below are killing tests for the renderer's discrete
  // digest-derived selections - the branch points where a deletion or a sign
  // flip still satisfies every property above (determinism, shape, size,
  // distinctness all hold for either arm). The expected value is NOT a
  // fabricated constant: it is recomputed here from the documented mapping
  // (sha256(did), named byte range, modulo) exactly as the source header
  // specifies it, so the test encodes the spec independently of the code
  // under test.

  it('pins the mouth bend to byte 23 parity - both ternary arms are load-bearing', () => {
    for (const residue of [0, 1] as const) {
      const did = findDidWithByteResidue(`bend${residue}`, 23, residue, 2);
      const match = /<path d="M \d+ 38 Q 32 (-?\d+) \d+ 38" stroke=/.exec(renderAvatar(did));
      expect(match, `no mouth path rendered for ${JSON.stringify(did)}`).not.toBeNull();
      const controlY = match === null ? NaN : Number(match[1]);
      // Even byte 23 bends +3 (control point below the line), odd bends -3;
      // deleting the ternary or flipping either arm fails one residue.
      expect(controlY - 38, `wrong bend arm for ${did}`).toBe(residue === 0 ? 3 : -3);
    }
  });

  it('pins the silhouette anchor count to byte 6 across all three residues', () => {
    for (const residue of [0, 1, 2] as const) {
      const did = findDidWithByteResidue(`anchors${residue}`, 6, residue, 3);
      const outline = /<path d="([^"]+)" fill=/.exec(renderAvatar(did));
      expect(outline, `no outline path rendered for ${JSON.stringify(did)}`).not.toBeNull();
      const d = outline === null ? '' : (outline[1] ?? '');
      // The outline is M followed by one Q segment per anchor point.
      const segments = (d.match(/ Q /g) ?? []).length;
      expect(segments, `wrong anchor count for ${did}`).toBe(7 + residue);
    }
  });
});
