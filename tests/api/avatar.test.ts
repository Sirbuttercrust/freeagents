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
});
