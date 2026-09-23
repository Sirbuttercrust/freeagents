// What an avatar mount looks like after bots.js has handled it, read off the
// element the way a jsdom test can.
//
// jsdom has no canvas implementation, so a jsdom test cannot see pixels. It
// can see everything else FABots.mount does, and that is the stronger claim
// the old "an <svg> exists" assertion never made: WHICH bot the host was
// told to draw. mount() writes the resolved spec onto the host as three
// attributes before it draws, and appends exactly one canvas.bot. The pixels
// themselves are asserted in real Chrome by tests/web/bots-render.test.ts.
import type { AvatarSpec } from '../../src/domain/avatar-spec.js';

export interface BotMount {
  readonly did: string | null;
  readonly spec: { shape: string | null; face: string | null; colour: string | null };
  readonly canvases: number;
  readonly svgs: number;
  readonly pending: boolean;
}

export function botMount(host: Element | null | undefined): BotMount {
  if (!host) throw new Error('no avatar host: the element the page mounts into is missing');
  return {
    did: host.getAttribute('data-avatar'),
    spec: {
      shape: host.getAttribute('data-avatar-shape'),
      face: host.getAttribute('data-avatar-face'),
      colour: host.getAttribute('data-avatar-colour'),
    },
    canvases: host.querySelectorAll(':scope > canvas.bot').length,
    svgs: host.querySelectorAll('svg').length,
    pending: host.hasAttribute('data-pending'),
  };
}

// The mount a page should have made for `did` wearing `spec`: named, one
// canvas, the exact spec, nothing left pending, and no leftover SVG from the
// retired engines.
export function expectedMount(did: string, spec: AvatarSpec): BotMount {
  return {
    did,
    spec: { shape: spec.shape, face: spec.face, colour: spec.colour },
    canvases: 1,
    svgs: 0,
    pending: false,
  };
}

// For a REAL browser (tests/helpers/real-browser.ts evaluate), where the
// canvas exists: a JS function expression that, given a host element,
// returns how many of its canvas's pixels are opaque. A bot drawn into the
// host covers a sizeable share of the square; an empty canvas returns 0.
// Kept as source text because it runs in the page, not in node.
export const PAINTED_PIXELS_FN = `function (host) {
  var c = host && host.querySelector(':scope > canvas.bot');
  if (!c || !c.width || !c.height) return 0;
  var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  var n = 0;
  for (var i = 3; i < d.length; i += 4) if (d[i] > 200) n += 1;
  return n;
}`;
