import { createHash } from 'node:crypto';

/**
 * A deterministic avatar rendered server-side from an agent DID. This is a
 * LOCAL IMPLEMENTATION STANDING IN FOR THE PUBLISHED PACKAGE `blobatar`
 * (npm v2.4.0, MIT, Alain00/blobatar), because this build environment cannot
 * add installed packages. The wire contract is identical either way - an SVG
 * string derived only from the DID, stable across runs and processes, carried
 * inline on the agent record, with no upload, no storage and no moderation
 * surface anywhere (MISSION.md, "Identity-derived avatars") - so the swap-in
 * is tracked as FOLLOWUP F1 and is invisible to consumers of this string.
 *
 * Every visual trait reads its own byte range of the SHA-256 digest, so no
 * two traits share entropy and adjacent DIDs diverge everywhere at once. The
 * function is total: any string input renders, including the empty string,
 * because the contract needs "same DID, same avatar", not syntax checking -
 * the DID was already validated where it was stored. The determinism surface
 * is closed by construction: hash of the input only, no clock, no random
 * source, no environment, no network.
 */
export function renderAvatar(did: string): string {
  const bytes = createHash('sha256').update(did, 'utf8').digest();
  // noUncheckedIndexedAccess: read past the 32-byte digest falls back to 0
  // instead of asserting the index exists.
  const at = (i: number): number => bytes[i] ?? 0;

  // One decimal place is plenty on a 64x64 canvas and keeps projections light.
  const fix = (n: number): number => Math.round(n * 10) / 10;
  const hsl = (h: number, s: number, l: number): string => `hsl(${h} ${s}% ${l}%)`;

  // Backdrop: bytes 0-2.
  const bg = hsl(Math.round((at(0) / 255) * 360), 45 + (at(1) % 30), 84 + (at(2) % 10));
  // Body colour: bytes 3-5.
  const body = hsl(Math.round((at(3) / 255) * 360), 55 + (at(4) % 30), 42 + (at(5) % 22));

  // Silhouette: bytes 6-7 choose how many anchors ring the centre and where
  // the ring starts; bytes 8-16 nudge each anchor's radius individually, so
  // neighbouring DIDs get visibly different outlines.
  type Pt = { readonly x: number; readonly y: number };
  const anchors = 7 + (at(6) % 3); // 7, 8 or 9 anchor points
  const turn = (at(7) / 255) * Math.PI * 2;
  const pts: Pt[] = [];
  for (let i = 0; i < anchors; i++) {
    const angle = turn + (i / anchors) * Math.PI * 2;
    const radius = 15 + (at(8 + i) / 255) * 9; // 15..24, inside the frame
    pts.push({ x: fix(32 + Math.cos(angle) * radius), y: fix(32 + Math.sin(angle) * radius) });
  }
  // A smooth closed curve through the anchors' segment midpoints: no corners
  // for the eye to read as data, still fully determined by the digest.
  const mids: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    mids.push({
      x: fix(((a?.x ?? 32) + (b?.x ?? 32)) / 2),
      y: fix(((a?.y ?? 32) + (b?.y ?? 32)) / 2),
    });
  }
  const first = mids[0];
  let outline = `M ${first?.x ?? 32},${first?.y ?? 32}`;
  for (let i = 0; i < pts.length; i++) {
    const anchor = pts[i];
    const after = mids[(i + 1) % mids.length];
    outline += ` Q ${anchor?.x ?? 32},${anchor?.y ?? 32} ${after?.x ?? 32},${after?.y ?? 32}`;
  }
  outline += ' Z';

  // Face: bytes 17-23 place the eyes and mouth, each on its own range.
  const ink = hsl(Math.round((at(20) / 255) * 360), 60 + (at(21) % 25), 22);
  const eyeDx = 4 + (at(18) % 4); // 4..7 either side of centre
  const eyeY = 27 + (at(19) % 5); // 27..31
  const eyeR = fix(1.6 + (at(17) / 255) * 1.4); // 1.6..3.0
  const mouthHalf = 3 + (at(22) % 4); // 3..6
  const mouthBend = at(23) % 2 === 0 ? 3 : -3;

  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    `<rect width="64" height="64" fill="${bg}"/>` +
    `<path d="${outline}" fill="${body}"/>` +
    `<circle cx="${32 - eyeDx}" cy="${eyeY}" r="${eyeR}" fill="${ink}"/>` +
    `<circle cx="${32 + eyeDx}" cy="${eyeY}" r="${eyeR}" fill="${ink}"/>` +
    `<path d="M ${32 - mouthHalf} 38 Q 32 ${38 + mouthBend} ${32 + mouthHalf} 38" stroke="${ink}" stroke-width="1.6" fill="none" stroke-linecap="round"/>` +
    '</svg>'
  );
}
