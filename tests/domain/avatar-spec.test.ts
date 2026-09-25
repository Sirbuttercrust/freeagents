// AV1 (ENT-2.3 ruling, 2026-09-22): the agent avatar spec. Default derives
// from the DID; the operator may override shape, face and colour from fixed
// sets; no uploads, ever. This file pins the pure domain rule only -- no
// route, no storage, no vendor import (domain-purity.test.ts enforces that
// structurally).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AVATAR_COLOURS,
  AVATAR_COLOUR_NAMES,
  AVATAR_FACES,
  AVATAR_SHAPES,
  AVATAR_TEST_VECTORS,
  defaultAvatar,
  isValidAvatarColourKey,
  isValidAvatarFace,
  isValidAvatarShape,
  resolveAvatar,
  type AvatarSpec,
} from '../../src/domain/avatar-spec.js';

describe('AVATAR_SHAPES', () => {
  it('is exactly the library type list, 18 entries, in this order', () => {
    expect(AVATAR_SHAPES).toEqual([
      'clover', 'flower', 'triangle', 'square', 'blob', 'ghost', 'circle', 'drop',
      'star', 'droid', 'mech', 'alien', 'hexagon', 'cat', 'cloud', 'pill', 'pebble', 'puddle',
    ]);
  });
});

describe('AVATAR_FACES', () => {
  it('is exactly eyes and mouth', () => {
    expect(AVATAR_FACES).toEqual(['eyes', 'mouth']);
  });
});

describe('AVATAR_COLOURS', () => {
  it('has exactly the keys c1 through c12', () => {
    expect(Object.keys(AVATAR_COLOURS)).toEqual([
      'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11', 'c12',
    ]);
  });

  // AV2 filled the values. Each is a six digit hex, the twelve are distinct,
  // and each clears 3:1 against every surface an avatar sits on (WCAG
  // 1.4.11), computed here from the token values rather than trusted from
  // the comment beside the table.
  it('every value is a distinct six digit hex that clears 3:1 on every surface', () => {
    const values = Object.values(AVATAR_COLOURS);
    expect(new Set(values).size).toBe(12);
    const lum = (hex: string): number => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
      return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
    };
    const ratio = (a: string, b: string): number => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    // --bg, --bg-1, --bg-2 (src/web/public/css/tokens.css, direction B), and
    // --pane-fill-2 (white at 0.055) composited over --bg-2, the lightest
    // card surface.
    const surfaces = ['#0B0A12', '#13111D', '#1B1829', '#282535'];
    for (const value of values) {
      expect(value).toMatch(/^#[0-9A-F]{6}$/);
      for (const surface of surfaces) {
        expect(ratio(value, surface), `${value} on ${surface}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('names every colour for the picker, one name per key', () => {
    expect(Object.keys(AVATAR_COLOUR_NAMES)).toEqual(Object.keys(AVATAR_COLOURS));
    expect(new Set(Object.values(AVATAR_COLOUR_NAMES)).size).toBe(12);
  });

  // DESIGN.md 2.2 and 2.4: jade (#46C39A, --check) means a job somebody
  // checked, so no avatar may wear it or anything a person would read as
  // it. c2 held it until direction B; the key stays and the value moved.
  it('no colour is jade, or within delta-E 30 of it, and c2 keeps its key', () => {
    const lab = (hex: string): [number, number, number] => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)) as [number, number, number];
      const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
      const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
      const f = (v: number): number => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
      return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
    };
    const jade = lab('#46C39A');
    for (const [key, value] of Object.entries(AVATAR_COLOURS)) {
      const [l, a, b] = lab(value);
      const d = Math.hypot(l - jade[0], a - jade[1], b - jade[2]);
      expect(d, `${key} ${value} sits ${d.toFixed(1)} from jade`).toBeGreaterThanOrEqual(30);
    }
    expect(AVATAR_COLOURS.c2).toBe('#FF2E88');
    expect(AVATAR_COLOUR_NAMES.c2).toBe('Pink');
  });

  // Twelve colours only help if a person can tell them apart on a 24px
  // swatch. CIELAB delta-E (CIE76) between every pair, with D65 white; 25 is
  // well past "clearly different" for flat fills at that size.
  it('no two colours sit closer than delta-E 25', () => {
    const lab = (hex: string): [number, number, number] => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)) as [number, number, number];
      const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
      const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
      const f = (v: number): number => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
      return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
    };
    const entries = Object.entries(AVATAR_COLOURS);
    let nearest = { d: Infinity, pair: '' };
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const [ka, va] = entries[i]!;
        const [kb, vb] = entries[j]!;
        const [la, aa, ba] = lab(va);
        const [lb, ab, bb] = lab(vb);
        const d = Math.hypot(la - lb, aa - ab, ba - bb);
        if (d < nearest.d) nearest = { d, pair: `${ka}/${kb}` };
      }
    }
    expect(nearest.d, `nearest pair ${nearest.pair}`).toBeGreaterThanOrEqual(25);
  });
});

describe('defaultAvatar', () => {
  it('is deterministic: the same DID renders the same spec, always', () => {
    for (const { did } of AVATAR_TEST_VECTORS) {
      expect(defaultAvatar(did)).toEqual(defaultAvatar(did));
    }
  });

  it('matches every pinned test vector', () => {
    for (const { did, expected } of AVATAR_TEST_VECTORS) {
      expect(defaultAvatar(did), `mismatch for ${JSON.stringify(did)}`).toEqual(expected);
    }
  });

  it('has at least 8 pinned vectors (AV2 tests its client fallback against the same list)', () => {
    expect(AVATAR_TEST_VECTORS.length).toBeGreaterThanOrEqual(8);
  });

  it('always returns a shape, face and colour from the fixed sets', () => {
    for (const { did } of AVATAR_TEST_VECTORS) {
      const spec = defaultAvatar(did);
      expect(AVATAR_SHAPES).toContain(spec.shape);
      expect(AVATAR_FACES).toContain(spec.face);
      expect(Object.keys(AVATAR_COLOURS)).toContain(spec.colour);
    }
  });

  it('is total: the empty string renders a spec, not a throw', () => {
    expect(() => defaultAvatar('')).not.toThrow();
  });

  it('reads its input and nothing else -- no clock, randomness or environment surface', () => {
    // Mirrors avatar.test.ts's own structural check on the sibling
    // determinism-hazard file.
    const banned = ['Math.random', 'Date.now', 'performance.now', 'process.env'];
    const hits = banned.filter((token) => SOURCE.includes(token));
    expect(hits, `determinism hazards found in avatar-spec.ts: ${hits.join(', ')}`).toEqual([]);
  });

  it('derives from sha256(did) bytes 0, 1 and 2 exactly as documented', () => {
    // Independently recomputed here, not merely re-asserting the exported
    // vectors, so a change to the derivation is caught even if a vector
    // were accidentally left stale.
    for (const { did } of AVATAR_TEST_VECTORS) {
      const digest = createHash('sha256').update(did, 'utf8').digest();
      const shape = AVATAR_SHAPES[(digest[0] ?? 0) % AVATAR_SHAPES.length];
      const face = AVATAR_FACES[(digest[1] ?? 0) % AVATAR_FACES.length];
      const colourKeys = Object.keys(AVATAR_COLOURS);
      const colour = colourKeys[(digest[2] ?? 0) % colourKeys.length];
      expect(defaultAvatar(did)).toEqual({ shape, face, colour });
    }
  });
});

// Read once, at module scope, for the determinism-hazard check above.
const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, '../../src/domain/avatar-spec.ts'), 'utf8');

describe('resolveAvatar', () => {
  const did = 'did:abt:zResolveFixture';

  it('returns the stored override when present', () => {
    const stored: AvatarSpec = { shape: 'triangle', face: 'mouth', colour: 'c7' };
    expect(resolveAvatar(stored, did)).toEqual(stored);
  });

  it('falls back to the default when stored is null', () => {
    expect(resolveAvatar(null, did)).toEqual(defaultAvatar(did));
  });

  it('falls back to the default when stored is undefined', () => {
    expect(resolveAvatar(undefined, did)).toEqual(defaultAvatar(did));
  });

  it('falls back to the default when a stored value is structurally invalid', () => {
    // Defensive: resolveAvatar sits at the wire boundary, so a corrupted or
    // pre-migration row must never surface a bad shape/face/colour key.
    const corrupted = { shape: 'not-a-shape', face: 'eyes', colour: 'c1' } as unknown as AvatarSpec;
    expect(resolveAvatar(corrupted, did)).toEqual(defaultAvatar(did));
  });
});

describe('isValidAvatarShape', () => {
  it('accepts every shape in the fixed set', () => {
    for (const shape of AVATAR_SHAPES) {
      expect(isValidAvatarShape(shape)).toBe(true);
    }
  });

  it('rejects a value outside the fixed set', () => {
    expect(isValidAvatarShape('robot')).toBe(false);
  });

  it('rejects a raw hex colour masquerading as a shape', () => {
    expect(isValidAvatarShape('#418')).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(isValidAvatarShape('')).toBe(false);
  });

  it('rejects a non-string', () => {
    expect(isValidAvatarShape(42)).toBe(false);
    expect(isValidAvatarShape(null)).toBe(false);
    expect(isValidAvatarShape(undefined)).toBe(false);
  });
});

describe('isValidAvatarFace', () => {
  it('accepts eyes and mouth', () => {
    expect(isValidAvatarFace('eyes')).toBe(true);
    expect(isValidAvatarFace('mouth')).toBe(true);
  });

  it('rejects a value outside the fixed set', () => {
    expect(isValidAvatarFace('nose')).toBe(false);
  });

  it('rejects a non-string', () => {
    expect(isValidAvatarFace(1)).toBe(false);
  });
});

describe('isValidAvatarColourKey', () => {
  it('accepts every key from c1 to c12', () => {
    for (const key of Object.keys(AVATAR_COLOURS)) {
      expect(isValidAvatarColourKey(key)).toBe(true);
    }
  });

  it('rejects a raw hex value -- validation accepts a key, never a raw hex', () => {
    expect(isValidAvatarColourKey('#E0A24E')).toBe(false);
  });

  it('rejects a key outside the fixed set', () => {
    expect(isValidAvatarColourKey('c13')).toBe(false);
    expect(isValidAvatarColourKey('c0')).toBe(false);
  });

  it('rejects a non-string', () => {
    expect(isValidAvatarColourKey(1)).toBe(false);
  });
});
