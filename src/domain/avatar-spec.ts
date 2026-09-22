// AV1 (ENT-2.3 ruling, 2026-09-22, MAP.md "Agent avatars ruling"): the
// agent avatar spec. Pure domain, no vendor import (domain-purity.test.ts
// enforces this structurally -- import only node: builtins or other
// src/domain modules from this file).
//
// The acceptance sentence behind this card: a random shape and colour by
// default, with the owner able to customize their agent's avatar. The
// ruling narrows "random" to "deterministic from the DID" (same DID, same
// default, forever) and "customize" to "choose shape, face and colour from
// fixed sets" -- never an upload, never a raw hex, never a field that
// could carry arbitrary content. Identity stays the name and the DID; the
// avatar never carries identity on its own (ENT-2.3, restated below).
import { createHash } from 'node:crypto';

// The library's own type list, this exact order, 18 entries. AV2's vendored
// renderer indexes into this array by position, so the order here IS the
// contract; reordering it silently reassigns every agent's default shape.
export const AVATAR_SHAPES = [
  'clover', 'flower', 'triangle', 'square', 'blob', 'ghost', 'circle', 'drop',
  'star', 'droid', 'mech', 'alien', 'hexagon', 'cat', 'cloud', 'pill', 'pebble', 'puddle',
] as const;

export type AvatarShape = (typeof AVATAR_SHAPES)[number];

export const AVATAR_FACES = ['eyes', 'mouth'] as const;

export type AvatarFace = (typeof AVATAR_FACES)[number];

// AV2 filled the values (spec/wireframe/DESIGN.md 2.4). Validation still
// accepts a KEY (below), never a raw hex, so a caller can never smuggle an
// arbitrary colour value through this field; the hex lives here and in the
// browser renderer's copy (src/web/public/js/bots.js), and
// tests/web/bots-client.test.ts fails if the two tables drift.
//
// Every value clears 3:1 (WCAG 1.4.11, graphics) against --bg, --bg-1,
// --bg-2 and the lightest pane surface; the lowest is c11 cobalt at 4.8:1.
// c1 to c4 are --agent-2 to --agent-5. --agent-1 is not here because it is
// the accent, and an avatar must never wear the colour that means verified
// (DESIGN.md 2.2). No colour falls in the hue band 228 to 258 degrees that
// swarm.js kept clear around the accent: the two nearest are c11 cobalt at
// 216 and c9 violet at 268.
export const AVATAR_COLOURS: Readonly<Record<string, string>> = {
  c1: '#58B0E8', c2: '#46C39A', c3: '#E0A24E', c4: '#E4757F', c5: '#FF6A3D', c6: '#FFD32B',
  c7: '#9BE85A', c8: '#1ED3C6', c9: '#B06BFF', c10: '#F25CD4', c11: '#3D8BFF', c12: '#FF62B0',
};

// The name a person hears for each colour, used by the picker's swatches.
export const AVATAR_COLOUR_NAMES: Readonly<Record<string, string>> = {
  c1: 'Sky', c2: 'Jade', c3: 'Amber', c4: 'Rose', c5: 'Vermilion', c6: 'Yellow',
  c7: 'Lime', c8: 'Teal', c9: 'Violet', c10: 'Orchid', c11: 'Cobalt', c12: 'Pink',
};

export type AvatarColourKey = keyof typeof AVATAR_COLOURS;

// One agent's avatar, whether it is the DID-derived default or a stored
// operator override. Both defaultAvatar and a validated PUT body produce
// exactly this shape.
export interface AvatarSpec {
  readonly shape: AvatarShape;
  readonly face: AvatarFace;
  readonly colour: string;
}

const AVATAR_COLOUR_KEYS = Object.keys(AVATAR_COLOURS) as readonly string[];

export function isValidAvatarShape(value: unknown): value is AvatarShape {
  return typeof value === 'string' && (AVATAR_SHAPES as readonly string[]).includes(value);
}

export function isValidAvatarFace(value: unknown): value is AvatarFace {
  return typeof value === 'string' && (AVATAR_FACES as readonly string[]).includes(value);
}

// Accepts a KEY (c1..c12), never a raw hex: the design card fills the
// values later, and a route that accepted a hex string here would reopen
// exactly the "look like somebody else" surface the no-upload rule closes.
export function isValidAvatarColourKey(value: unknown): value is AvatarColourKey {
  return typeof value === 'string' && AVATAR_COLOUR_KEYS.includes(value);
}

export function isValidAvatarSpec(value: unknown): value is AvatarSpec {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return isValidAvatarShape(v.shape) && isValidAvatarFace(v.face) && isValidAvatarColourKey(v.colour);
}

// Deterministic from the DID alone: hash of the input only, no clock, no
// random source, no environment. src/web/public/js/bots.js carries the same
// derivation for a response with no spec, pinned to the vectors below.
// Total: any string in, including the empty string, renders a spec.
//
// Byte 0 selects the shape, byte 1 the face, byte 2 the colour key, each
// its own byte so the three traits never share entropy.
export function defaultAvatar(did: string): AvatarSpec {
  const digest = createHash('sha256').update(did, 'utf8').digest();
  const at = (i: number): number => digest[i] ?? 0;
  const shape = AVATAR_SHAPES[at(0) % AVATAR_SHAPES.length] as AvatarShape;
  const face = AVATAR_FACES[at(1) % AVATAR_FACES.length] as AvatarFace;
  const colour = AVATAR_COLOUR_KEYS[at(2) % AVATAR_COLOUR_KEYS.length] as AvatarColourKey;
  return { shape, face, colour };
}

// The stored override if present and well-formed, else the DID-derived
// default. A structurally invalid stored value (a pre-migration row, a
// corrupted read) falls back to the default rather than surfacing a bad
// shape/face/colour key to a caller -- resolveAvatar sits at the wire
// boundary and must never hand out a spec outside the fixed sets.
export function resolveAvatar(stored: AvatarSpec | null | undefined, did: string): AvatarSpec {
  if (stored !== null && stored !== undefined && isValidAvatarSpec(stored)) {
    return { shape: stored.shape, face: stored.face, colour: stored.colour };
  }
  return defaultAvatar(did);
}

// Fixed test vectors, at least 8 DIDs with their expected default specs.
// AV2's client-side fallback renderer is tested against this exact list,
// so a divergence between the server derivation and the client's own copy
// of it is caught in either suite. Recomputed independently in
// tests/domain/avatar-spec.test.ts against sha256(did) bytes 0/1/2, so this
// list cannot silently drift from the documented derivation above.
export const AVATAR_TEST_VECTORS: readonly { readonly did: string; readonly expected: AvatarSpec }[] = [
  { did: 'did:abt:zNKtD5hwiSDiwLrD6tAQRNTN1ZiDBBpaKrb', expected: { shape: 'flower', face: 'eyes', colour: 'c2' } },
  { did: 'did:abt:z8HeJQVh7ELTQhXhpC9ksH2ciE13ib6Ymr', expected: { shape: 'flower', face: 'eyes', colour: 'c12' } },
  { did: 'did:abt:zShort', expected: { shape: 'mech', face: 'eyes', colour: 'c8' } },
  { did: 'did:abt:a', expected: { shape: 'puddle', face: 'eyes', colour: 'c9' } },
  { did: 'did:abt:b', expected: { shape: 'droid', face: 'mouth', colour: 'c10' } },
  { did: 'did:abt:agent', expected: { shape: 'star', face: 'mouth', colour: 'c12' } },
  { did: 'did:abt:agemt', expected: { shape: 'cloud', face: 'mouth', colour: 'c4' } },
  { did: '', expected: { shape: 'alien', face: 'eyes', colour: 'c5' } },
] as const;
