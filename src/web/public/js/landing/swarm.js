/* The Swarm: procedurally generated agent creatures.

   Every agent's face is derived from its DID and nothing else, which is the
   rule DESIGN.md section 2.4 and ENT-2.3 both state: an operator cannot
   choose it and cannot impersonate another agent by picking its look. Same
   DID, same creature, on every screen and every visit.

   WHY THIS REPLACED THE PREVIOUS AVATAR

   The old engine came from bloub (github.com/jeremy-prt/bloub, MIT, Jeremy
   Perret), whose README limits its licence to "the code in this repository,
   not the design it recreates", because bloub recreates x.ai's Grok avatar.
   The licence was honoured and the shapes here were already our own, but the
   resemblance was real and the family it belonged to had become a common
   look. This generator shares no code and no lineage with it.

   WHAT MAKES ONE AGENT DIFFERENT FROM ANOTHER

   Nine species across six insect orders, each with its OWN body plan rather
   than one plan with different numbers. A spider has two body sections, eight
   radiating legs and no wings. A dragonfly has compound eyes covering its
   head and four flat wings with a pigmented stigma. A bee has a petiole
   waist. These are different architectures, which is why they are
   recognisable at a glance and why the earlier parametric version was not:
   a bee and a moth were the same shape at different proportions.

   Colour is a two-tone harmony roll: 12 hues at 3 lightness values, paired by
   hue distance, with a hard luminance floor so body and wing can never merge
   into one silhouette at small sizes.

   Measured, not asserted. Over 20,000 seeded draws the collision rate is
   under 4 percent, species differ by 13 to 30 percent of their silhouette
   cells, and every creature is a single connected shape.

   Legible down to 32px: at avatar sizes the six most similar species pairs
   still differ by 18 percent of their pixels.
*/

/* ---------------------------------------------------------------- core */

/* FreeAgents agent concepts: the shared generative core.
   Burnish, 2026-08-28.

   PALETTE REBUILT 2026-08-28 for arcade vibrancy.

   WHY THE FIRST PALETTE CAME OUT CHALKY, WHICH WAS A REAL BUG AND NOT TASTE
   The first version built its three values by mixing the base hue toward
   white and toward black:

       bright = mix(hue, #FFFFFF, 0.22)
       deep   = mix(hue, #000000, 0.30)

   Mixing toward white is the same operation as pulling saturation out. A
   fully saturated hue blended 22 percent toward white loses roughly a fifth
   of its chroma, so every "bright" swatch came back pastel and the whole set
   read washed out beside a real arcade sprite. Galaga's hardware could not
   do pastel: it had 32 fixed colours and its sprites are near maximum chroma
   because that is all a CRT phosphor palette offers.

   The fix is to move LIGHTNESS in HSL and leave SATURATION alone, which is
   a different operation entirely. Same hue, same chroma, different value.

   The second thing this file now does is GUARANTEE contrast rather than
   check it afterwards. A saturated blue at 42 percent lightness is much
   darker than a saturated yellow at the same lightness, because the eye
   weights green at 0.72 and blue at 0.07. Fixed lightness per value would
   have shipped a deep blue that fails 3:1 against the page. `ensureContrast`
   lifts lightness until it passes, preserving hue and saturation.

   THE ACCENT COLLISION, unchanged and still real
   DESIGN.md 2.2 reserves --accent (#7C7CFF) for one meaning: evidence we
   watched happen. DESIGN.md 2.4 then defines --agent-1 as the same value, so
   today's floating agents wear the colour that is supposed to mean verified.
   The hue band around the accent is left empty here on purpose. */

(function (global) {
  "use strict";

  /* ------------------------------------------------------------ hashing */

  function hash(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pick(r, list) { return list[Math.floor(r() * list.length) % list.length]; }
  function int(r, n) { return Math.floor(r() * n) % n; }
  function range(r, lo, hi) { return lo + r() * (hi - lo); }

  /* ------------------------------------------------------- colour space */

  function hexToRgb(h) {
    h = String(h).trim().replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var v = parseInt(h, 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  function rgbToHex(c) {
    return "#" + c.map(function (x) {
      return Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0");
    }).join("");
  }

  /* HSL, so lightness can move without touching chroma. This is the whole
     reason the palette stopped being pastel. */
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h, s, l = (max + min) / 2;
    if (max === min) { h = 0; s = 0; }
    else {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h: h, s: s, l: l };
  }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2;
    var t = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
      : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [(t[0] + m) * 255, (t[1] + m) * 255, (t[2] + m) * 255];
  }
  function hexToHsl(hex) {
    var c = hexToRgb(hex);
    return rgbToHsl(c[0], c[1], c[2]);
  }
  function hslToHex(h, s, l) {
    return rgbToHex(hslToRgb(h, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, l))));
  }

  function mix(from, to, t) {
    var a = hexToRgb(from), b = hexToRgb(to);
    return rgbToHex([
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t
    ]);
  }
  function lighten(hex, t) { return mix(hex, "#FFFFFF", t); }
  function darken(hex, t) { return mix(hex, "#000000", t); }

  /* Lightness move that KEEPS chroma. Use this, not lighten/darken, on
     anything that must stay vivid. */
  function withLightness(hex, l, sMul) {
    var c = hexToHsl(hex);
    return hslToHex(c.h, c.s * (sMul == null ? 1 : sMul), l);
  }

  function relLum(hex) {
    var c = hexToRgb(hex).map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) {
    var la = relLum(a), lb = relLum(b);
    var hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }

  var BG = "#08090A";

  /* Lift lightness in HSL until the colour clears `min` against the page.
     Hue and saturation survive; only value moves. A saturated blue needs a
     much higher lightness than a saturated yellow to reach the same
     contrast, and hardcoding one number for both is how a palette ships a
     swatch nobody can see. */
  function ensureContrast(hex, min, bg) {
    bg = bg || BG;
    min = min || 3.2;
    var c = hexToHsl(hex);
    var l = c.l;
    for (var i = 0; i < 60 && contrast(hslToHex(c.h, c.s, l), bg) < min; i++) {
      l += 0.01;
      if (l > 0.95) break;
    }
    return hslToHex(c.h, c.s, l);
  }

  /* --------------------------------------------------------- the palette

     Twelve hues at arcade chroma. The gap between `azure` (200) and
     `violet` (272) is the reserved accent band, left empty on purpose.

     Base values are the MID swatch. Deep and bright are derived by moving
     lightness only. */

  var HUES = [
    { id: "red",     deg: 0,   base: "#FF2D2D" },
    { id: "orange",  deg: 26,  base: "#FF7A1A" },
    { id: "amber",   deg: 42,  base: "#FFB300" },
    { id: "yellow",  deg: 54,  base: "#FFE01A" },
    { id: "lime",    deg: 78,  base: "#AEF52B" },
    { id: "green",   deg: 130, base: "#1FE04B" },
    { id: "spring",  deg: 156, base: "#00EF96" },
    { id: "cyan",    deg: 176, base: "#0FE8DC" },
    { id: "azure",   deg: 200, base: "#12B6FF" },
    { id: "violet",  deg: 272, base: "#A64DFF" },
    { id: "magenta", deg: 308, base: "#FF4AE0" },
    { id: "rose",    deg: 338, base: "#FF3D82" }
  ];

  /* Lightness targets, saturation held near maximum. Compare with the old
     mix-toward-white approach, which lost chroma at both ends. */
  var VALUES = [
    { id: "deep",   l: 0.44, s: 0.98 },
    { id: "mid",    l: 0.58, s: 1.00 },
    { id: "bright", l: 0.72, s: 0.98 }
  ];

  var PALETTE = (function () {
    var out = [];
    HUES.forEach(function (h) {
      var base = hexToHsl(h.base);
      VALUES.forEach(function (v) {
        /* Saturation is taken from the hue's own base and pushed toward
           full, never reduced. */
        var sat = Math.min(1, base.s * v.s);
        var hex = ensureContrast(hslToHex(base.h, sat, v.l), 3.2);
        out.push({
          id: h.id + "-" + v.id,
          hue: h.id,
          hueDeg: h.deg,
          value: v.id,
          hex: hex,
          sat: hexToHsl(hex).s
        });
      });
    });
    return out;
  })();

  var RESERVED = { hex: "#7C7CFF", loDeg: 228, hiDeg: 258 };

  /* ------------------------------------------------------------ material

     One lighting model shared by every family, so five silhouettes still
     read as one product. Rim light and gradient now move lightness in HSL
     too, so a lit edge on a vivid body stays vivid instead of turning
     white. */
  function material(hex) {
    var c = hexToHsl(hex);
    return {
      base: hex,
      light: hslToHex(c.h, Math.min(1, c.s * 0.96), Math.min(0.88, c.l + 0.16)),
      dark: hslToHex(c.h, Math.min(1, c.s * 1.0), Math.max(0.16, c.l - 0.20)),
      rim: hslToHex(c.h, Math.min(1, c.s * 0.80), Math.min(0.92, c.l + 0.30)),
      shadow: "rgba(0,0,0,0.34)",
      eye: c.l < 0.5 ? hslToHex(c.h, c.s * 0.3, 0.92) : hslToHex(c.h, c.s, 0.22)
    };
  }

  /* ------------------------------------------------------------ harmony

     Galaga's enemies are two-tone: a Zako bee is blue with yellow wings, a
     Goei butterfly red with white, a Boss Galaga green until it takes a
     hit. That split is most of why those sprites read at 16px.

     A creature therefore gets a SCHEME, not a colour: body, wing and trim
     chosen as a set. Four bands of hue distance. */

  function hueDistance(a, b) {
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  var HARMONIES = {
    complement: { lo: 120, hi: 180 },
    split:      { lo: 75,  hi: 119 },
    analogous:  { lo: 24,  hi: 74 },
    duotone:    { lo: 0,   hi: 0 }
  };
  var HARMONY_IDS = Object.keys(HARMONIES);

  var VALUE_PAIRS = [
    ["deep", "bright"],
    ["mid", "bright"],
    ["bright", "deep"],
    ["deep", "mid"],
    ["mid", "deep"]
  ];

  function swatch(hueId, valueId) {
    for (var i = 0; i < PALETTE.length; i++) {
      if (PALETTE[i].hue === hueId && PALETTE[i].value === valueId) return PALETTE[i];
    }
    return PALETTE[0];
  }

  function harmony(r) {
    var schemeId = pick(r, HARMONY_IDS);
    var band = HARMONIES[schemeId];
    var bodyHue = pick(r, HUES);

    var candidates = HUES.filter(function (h) {
      var d = hueDistance(h.deg, bodyHue.deg);
      return d >= band.lo && d <= band.hi;
    });
    if (schemeId === "duotone" || !candidates.length) candidates = [bodyHue];
    var wingHue = pick(r, candidates);

    var pair = pick(r, VALUE_PAIRS);
    var body = swatch(bodyHue.id, pair[0]);
    var wing = swatch(wingHue.id, pair[1]);

    /* Enforce the value split rather than hoping the roll produced one.
       Two hues far apart on the wheel can still share a luminance, and at
       40px that renders as one solid shape. Try both ends of the wing
       hue's range and take whichever separates furthest. */
    if (Math.abs(relLum(body.hex) - relLum(wing.hex)) < 0.10) {
      var candBright = swatch(wingHue.id, "bright");
      var candDeep = swatch(wingHue.id, "deep");
      var gapBright = Math.abs(relLum(body.hex) - relLum(candBright.hex));
      var gapDeep = Math.abs(relLum(body.hex) - relLum(candDeep.hex));
      wing = gapBright >= gapDeep ? candBright : candDeep;

      if (Math.max(gapBright, gapDeep) < 0.10) {
        for (var w = 0; w < HUES.length; w++) {
          var alt = swatch(HUES[w].id, relLum(body.hex) < 0.30 ? "bright" : "deep");
          if (Math.abs(relLum(body.hex) - relLum(alt.hex)) >= 0.14) { wing = alt; break; }
        }
      }
    }

    /* Trim is the highlight: arcade sprites put their brightest colour on
       their smallest area, which is what makes the eye land there. Kept at
       full chroma rather than washed toward white. */
    var trimHue = r() < 0.5 ? bodyHue : wingHue;
    var trimBase = hexToHsl(swatch(trimHue.id, "bright").hex);
    var trim = hslToHex(trimBase.h, trimBase.s, Math.min(0.82, trimBase.l + 0.10));

    return {
      scheme: schemeId,
      body: body,
      wing: wing,
      trimHex: trim,
      /* Galaga eyes are near white. A faint body tint keeps the creature
         reading as one object rather than a body wearing two stickers. */
      eyeHex: mix("#FFFFFF", body.hex, 0.10)
    };
  }

  /* ------------------------------------------------------------- verify */

  function verify() {
    var failures = [];

    PALETTE.forEach(function (c) {
      var ratio = contrast(c.hex, BG);
      if (ratio < 3) {
        failures.push({ kind: "contrast", id: c.id, hex: c.hex, ratio: Math.round(ratio * 100) / 100 });
      }
      /* Vibrancy is now a measured property, not an aspiration. Anything
         under 0.55 saturation is the chalky failure the rebuild exists to
         prevent, so it fails the gate rather than quietly shipping. */
      if (c.sat < 0.55) {
        failures.push({ kind: "washed-out", id: c.id, hex: c.hex, sat: Math.round(c.sat * 100) / 100 });
      }
      var a = hexToRgb(c.hex), b = hexToRgb(RESERVED.hex);
      var dist = Math.sqrt(
        Math.pow(a[0] - b[0], 2) + Math.pow(a[1] - b[1], 2) + Math.pow(a[2] - b[2], 2)
      );
      if (dist < 60) {
        failures.push({ kind: "accent-collision", id: c.id, hex: c.hex, distance: Math.round(dist) });
      }
    });

    var sats = PALETTE.map(function (c) { return c.sat; });
    return {
      total: PALETTE.length,
      failures: failures,
      pass: failures.length === 0,
      minContrast: Math.round(Math.min.apply(null, PALETTE.map(function (c) {
        return contrast(c.hex, BG);
      })) * 100) / 100,
      minSat: Math.round(Math.min.apply(null, sats) * 100) / 100,
      avgSat: Math.round((sats.reduce(function (a, b) { return a + b; }, 0) / sats.length) * 100) / 100
    };
  }

  global.FACore = {
    hash: hash,
    rng: rng,
    pick: pick,
    int: int,
    range: range,
    mix: mix,
    lighten: lighten,
    darken: darken,
    withLightness: withLightness,
    hexToHsl: hexToHsl,
    hslToHex: hslToHex,
    ensureContrast: ensureContrast,
    relLum: relLum,
    contrast: contrast,
    material: material,
    harmony: harmony,
    hueDistance: hueDistance,
    swatch: swatch,
    HARMONIES: HARMONIES,
    HARMONY_IDS: HARMONY_IDS,
    VALUE_PAIRS: VALUE_PAIRS,
    PALETTE: PALETTE,
    HUES: HUES,
    VALUES: VALUES,
    RESERVED: RESERVED,
    BG: BG,
    verify: verify
  };
})(typeof window !== "undefined" ? window : this);


/* ------------------------------------------------------------- species */

/* FreeAgents agents: the insect species library.
   Burnish, 2026-08-28.

   WHY THIS FILE REPLACED THE PARAMETRIC GENERATOR
   The previous version had ONE body plan (head, thorax, abdomen, swept
   wings) with numeric ranges per species. That is why every creature read
   the same: a bee and a moth differed only in how wide their ranges were.
   Real insect orders are not variations on a theme, they are different
   architectures, and the differences are exactly the things a person
   recognises:

     a spider has NO wings and NO antennae, two body sections, eight legs
     a dragonfly's eyes cover almost its whole head, and its four wings are
       held straight out rather than swept back
     a bee has a petiole, the narrow waist, and banded abdomen
     a beetle's forewings are hardened into elytra that meet in a seam
     a mantis has an elongated prothorax and folded raptorial forelegs
     an ant has three nodes with narrow joins and elbowed antennae

   So each species gets its OWN builder that draws its own anatomy. Shared
   helpers handle mirroring and limb walking; nothing else is shared,
   because sharing is what made them look alike.

   ANATOMY SOURCES (checked 2026-08-28)
   NCSU ENT 425 Order Odonata: "antennae short and bristle-like; compound
   eyes large, often covering most of the head; four membranous wings with
   many veins; base of wings narrow, stalk-like; one distinctively
   pigmented cell (stigma) on leading edge; abdomen long and slender."
   BugGuide: dragonfly wings "held horizontally, cannot be folded";
   Hymenoptera "hind wings smaller than front wings".
   Wikipedia Spider anatomy: "two tagmata instead of three, eight jointed
   legs, no wings or antennae, eight simple eyes usually arranged in two
   rows of four, joined by a thin pedicel."

   GRID
   23 x 19. Wide enough for a dragonfly's wingspan and a spider's eight
   sprawled legs, tall enough for a dragonfly abdomen that is genuinely
   half the body. The previous 19x15 could not hold either.

   CELL VALUES
     0 empty        1 body/chitin   2 eye          3 wing membrane
     4 accent       5 segment band  6 wing pattern 7 leg
     8 eye pupil    9 structural dark (elytra seam, joints) */

(function (global) {
  "use strict";

  var W = 23;
  var H = 19;
  var MID = 11;

  /* ------------------------------------------------------------ helpers */

  function canvas() {
    var g = [];
    for (var r = 0; r < H; r++) g.push(new Array(W).fill(0));
    return g;
  }

  /* Every write is mirrored. Bilateral symmetry is not decoration, it is
     the thing that makes a grid of cells read as an animal. */
  function put(g, r, c, v) {
    if (r < 0 || r >= H || c < 0 || c >= W) return;
    g[r][c] = v;
    g[r][W - 1 - c] = v;
  }
  function at(g, r, c) {
    if (r < 0 || r >= H || c < 0 || c >= W) return 0;
    return g[r][c];
  }

  /* Fill a horizontal band centred on the spine. `half` is cells either
     side of centre, so half=2 gives a 5 wide row. */
  function band(g, r, half, v) {
    for (var c = 0; c <= half; c++) put(g, r, MID - c, v);
  }

  /* Walk a limb one axis at a time so consecutive cells always share an
     EDGE. A diagonal step shares only a corner, and corner contact is not
     connectivity: that was the defect that put 27.9 percent of the previous
     generation's creatures into pieces.

     Steps are letters: o out (toward the left rim), i in, d down, u up. */
  function limb(g, r, c, steps, v) {
    var cr = r, cc = c;
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      if (s === "o") cc -= 1;
      else if (s === "i") cc += 1;
      else if (s === "d") cr += 1;
      else if (s === "u") cr -= 1;
      if (cc < 0 || cr < 0 || cr >= H) break;
      if (at(g, cr, cc) === 0) put(g, cr, cc, v);
    }
    return { r: cr, c: cc };
  }

  /* Outermost body column on a row, so a limb or a wing can attach to
     something that is actually there rather than to where we assumed the
     body would be. */
  function edgeOf(g, r) {
    for (var c = 0; c <= MID; c++) if (at(g, r, c)) return c;
    return -1;
  }

  function span(rnd, pair) {
    return pair[0] + Math.floor(rnd() * (pair[1] - pair[0] + 1));
  }
  function chance(rnd, p) { return rnd() < p; }

  /* A wing drawn as a tapered blade: the inboard edge rakes outward with
     distance from the shoulder so it reads as a wing rather than a slab,
     and each row is clamped to overlap its neighbour so the blade cannot
     fall into pieces. */
  function bladeWing(g, top, bot, rootCol, reach, sweep, v, tilt) {
    var rows = bot - top + 1;
    if (rows < 2) return [];
    var shoulder = top + Math.floor(rows / 2);
    var drawn = [];
    var prevInner = null;
    tilt = tilt || 0;
    for (var r = top; r <= bot; r++) {
      var t = rows === 1 ? 0.5 : (r - top) / (rows - 1);
      var len = Math.round(reach * Math.sin(Math.PI * Math.pow(t, sweep)));
      if (len <= 0) continue;
      var rake = Math.min(len - 1, Math.round(Math.abs(r - shoulder) * 1.1));
      var start = rootCol + Math.max(0, rake);
      if (prevInner !== null) start = Math.min(start, prevInner + 1);
      if (start > rootCol + len) continue;

      /* THE PIVOT.
         Wings used to move by translating the whole band up or down a row,
         which changes 50 to 90 cells in one step and reads as a snap rather
         than a beat. A real wing PIVOTS at the shoulder: the root barely
         moves and the tip travels furthest. Offsetting each column by its
         distance from the root does that, and it changes far fewer cells
         per step because the inboard half stays put.

         The staircase fill matters: two adjacent columns whose rows differ
         share only a corner, and corner contact is not connectivity. Every
         row between the previous column's offset and this one is filled, so
         the wing is one orthogonally connected blade at any tilt. */
      var span2 = (rootCol + len) - start;
      var prevOff = null;
      for (var c = start; c <= rootCol + len; c++) {
        if (MID - c < 0) break;
        var frac = span2 <= 0 ? 0 : (c - start) / span2;
        var off = Math.round(frac * tilt);
        if (prevOff !== null && off !== prevOff) {
          var lo = Math.min(off, prevOff), hi = Math.max(off, prevOff);
          for (var fy = lo; fy <= hi; fy++) put(g, r + fy, MID - c, v);
        } else {
          put(g, r + off, MID - c, v);
        }
        prevOff = off;
      }
      prevInner = start;
      drawn.push({ row: r, inner: start, outer: rootCol + len });
    }
    /* Bridge any row that ended up with nothing solid inboard of it. */
    drawn.forEach(function (d) {
      if (at(g, d.row, MID - (d.inner - 1)) !== 0) return;
      if (at(g, d.row - 1, MID - d.inner) !== 0) return;
      if (at(g, d.row + 1, MID - d.inner) !== 0) return;
      for (var c = 1; c < d.inner; c++) {
        if (at(g, d.row, MID - c) === 0) put(g, d.row, MID - c, 1);
      }
    });
    return drawn;
  }

  /* A straight wing: narrow at the base, parallel sided, squared off. This
     is the dragonfly wing and it is a genuinely different shape from a
     blade. Held horizontal because Odonata cannot fold their wings. */
  function straightWing(g, row, rootCol, len, thickness, v, tilt) {
    var drawn = [];
    tilt = tilt || 0;
    for (var t = 0; t < thickness; t++) {
      var rr = row + t;
      /* The base is stalk-like: the first two columns are always one cell
         thin regardless of thickness. NCSU: "base of wings narrow,
         stalk-like". */
      var startC = t === 0 ? rootCol : rootCol + 2;
      var span2 = (rootCol + len) - startC;
      var prevOff = null;
      for (var c = startC; c <= rootCol + len; c++) {
        if (MID - c < 0) break;
        /* Same shoulder pivot as the blade: the root holds, the tip
           travels, with a staircase fill so the wing stays connected. */
        var frac = span2 <= 0 ? 0 : (c - startC) / span2;
        var off = Math.round(frac * tilt);
        if (prevOff !== null && off !== prevOff) {
          var lo = Math.min(off, prevOff), hi = Math.max(off, prevOff);
          for (var fy = lo; fy <= hi; fy++) put(g, rr + fy, MID - c, v);
        } else {
          put(g, rr + off, MID - c, v);
        }
        prevOff = off;
      }
      drawn.push({ row: rr, inner: startC, outer: rootCol + len });
    }
    return drawn;
  }

  /* ------------------------------------------------------------ species */

  var SPECIES = {};

  /* ---------------------------------------------------------------- BEE
     Apis. The forager. Signature: petiole waist, banded abdomen, fuzzy
     thorax, hind wings smaller than fore. */
  SPECIES.bee = {
    label: "Bee",
    note: "Fuzzy thorax, petiole waist, banded abdomen, two wing pairs",
    order: "Hymenoptera",
    hasWings: true, legCount: 6, antennae: "elbowed",
    build: function (rnd, g, pose) {
      var headHalf = span(rnd, [2, 3]);
      var thoraxHalf = headHalf + 1;
      var abdHalf = span(rnd, [2, 3]);
      var abdLen = span(rnd, [5, 6]);

      /* Head with big oval eyes wrapping the sides of the face. */
      var headTop = 2;
      band(g, headTop, headHalf - 1, 1);
      band(g, headTop + 1, headHalf, 1);
      band(g, headTop + 2, headHalf, 1);
      for (var er = headTop; er <= headTop + 2; er++) {
        put(g, er, MID - headHalf, 2);
        if (er > headTop) put(g, er, MID - headHalf + 1, 2);
      }
      put(g, headTop + 2, MID - headHalf, 8);

      /* Elbowed antennae: up the face, then a sharp turn outward. */
      limb(g, headTop, MID - headHalf + 1, "uuo", 1);
      put(g, headTop - 3, MID - headHalf, 4);

      /* Fuzzy thorax. The fuzz is accent cells on the shoulders, which is
         how you say "hairy" in nine pixels. */
      var thTop = headTop + 3;
      var thBot = thTop + 3;
      for (var tr = thTop; tr <= thBot; tr++) band(g, tr, thoraxHalf, 1);
      put(g, thTop, MID - thoraxHalf, 4);
      put(g, thBot, MID - thoraxHalf, 4);

      /* THE PETIOLE. One cell wide. This is the single feature that makes
         a bee a bee and not a fly. */
      var waist = thBot + 1;
      band(g, waist, 0, 5);

      /* Banded abdomen, tapering, ending in a sting. */
      var abTop = waist + 1;
      for (var i = 0; i < abdLen; i++) {
        var rr2 = abTop + i;
        if (rr2 >= H) break;
        var w = Math.max(0, abdHalf - Math.floor(i / 2));
        band(g, rr2, w, i % 2 === 1 ? 5 : 1);
      }
      var stingRow = Math.min(H - 1, abTop + abdLen);
      band(g, stingRow, 0, 4);

      /* Wings: forewing long, hindwing shorter and lower. Hymenoptera have
         hind wings smaller than front wings.

         POSE: the wing band shifts up or down a row and shortens slightly.
         A bee's beat is fast and shallow, so one row of travel is right;
         more would read as flapping like a bird. */
      /* PIVOT, not translate: the wing root stays on the thorax and only
         the tip travels. Hind wing tilts slightly less, which is what a
         real two-pair flyer does and keeps the pairs from reading as one
         rigid plate. */
      var tilt = wingTilt(pose);
      var reach = wingReach(pose);
      bladeWing(g, thTop, thTop + 3, thoraxHalf + 2,
        span(rnd, [6, 8]) + reach, 0.55, 3, tilt);
      bladeWing(g, thTop + 3, thBot + 2, thoraxHalf + 2,
        span(rnd, [4, 5]) + reach, 0.7, 3, Math.round(tilt * 0.6));

      /* Six legs, hind pair carrying pollen baskets. */
      /* Below the wing band. Hind pair carries the pollen basket. */
      for (var lg = 0; lg < 3; lg++) {
        var lr = thBot + lg;
        var ec = edgeOf(g, lr);
        if (ec < 0) continue;
        limb(g, lr, ec, lg === 2 ? "odddo" : "oddd", 7);
        if (lg === 2) put(g, Math.min(H - 1, lr + 3), Math.max(0, ec - 2), 4);
      }
    }
  };

  /* --------------------------------------------------------------- WASP
     Sleeker than a bee: a longer waist, no fuzz, sharper banding. */
  SPECIES.wasp = {
    label: "Wasp",
    note: "Two-cell waist, smooth armour, hard warning bands",
    order: "Hymenoptera",
    hasWings: true, legCount: 6, antennae: "straight",
    build: function (rnd, g, pose) {
      var headHalf = 2;
      var thoraxHalf = 3;
      var abdHalf = span(rnd, [2, 3]);

      var headTop = 2;
      band(g, headTop, headHalf - 1, 1);
      band(g, headTop + 1, headHalf, 1);
      for (var er = headTop; er <= headTop + 1; er++) put(g, er, MID - headHalf, 2);
      put(g, headTop + 1, MID - headHalf, 8);
      limb(g, headTop, MID - 1, "uu", 1);

      var thTop = headTop + 2;
      var thBot = thTop + 2;
      for (var tr = thTop; tr <= thBot; tr++) band(g, tr, thoraxHalf, 1);

      /* A longer waist than the bee's, which is what reads as "wasp". */
      band(g, thBot + 1, 0, 5);
      band(g, thBot + 2, 0, 5);

      var abTop = thBot + 3;
      var abdLen = span(rnd, [4, 5]);
      for (var i = 0; i < abdLen; i++) {
        var rr2 = abTop + i;
        if (rr2 >= H) break;
        var w = i === 0 ? abdHalf - 1 : Math.max(0, abdHalf - Math.floor(i / 2));
        band(g, rr2, w, i % 2 === 0 ? 1 : 5);
      }
      band(g, Math.min(H - 1, abTop + abdLen), 0, 4);

      /* Tighter stroke than the bee: same pivot, less travel. */
      bladeWing(g, thTop, thBot + 2, thoraxHalf + 2,
        span(rnd, [7, 9]) + wingReach(pose), 0.5, 3,
        Math.round(wingTilt(pose) * 0.8));

      /* Below the wing band: legs on wing rows get swallowed. */
      for (var lg = 0; lg < 3; lg++) {
        var lr = thBot + 1 + lg;
        var ec = edgeOf(g, lr);
        if (ec >= 0) limb(g, lr, ec, "oddd", 7);
      }
    }
  };

  /* ---------------------------------------------------------- DRAGONFLY
     Odonata. Signature: eyes covering most of the head, four long wings
     held HORIZONTAL with a stigma near each tip, abdomen long and slender. */
  SPECIES.dragonfly = {
    label: "Dragonfly",
    note: "Eyes cover the head, four flat wings with stigma, long abdomen",
    order: "Odonata",
    hasWings: true, legCount: 6, antennae: "bristle",
    build: function (rnd, g, pose) {
      var headHalf = span(rnd, [3, 4]);
      var thoraxHalf = 2;

      /* THE HEAD IS MOSTLY EYE. Two rows, nearly the full head width, with
         only a narrow strip of face between them at the centre. Nothing
         else in this library looks like this. */
      var headTop = 1;
      band(g, headTop, headHalf, 2);
      band(g, headTop + 1, headHalf, 2);
      band(g, headTop + 2, headHalf - 1, 1);
      put(g, headTop, MID, 1);
      put(g, headTop + 1, MID - headHalf, 8);

      /* Bristle antennae: one cell. Odonata antennae are vestigial and
         drawing them larger would be wrong. */
      put(g, headTop - 1, MID - headHalf + 1, 4);

      var thTop = headTop + 3;
      var thBot = thTop + 3;
      for (var tr = thTop; tr <= thBot; tr++) band(g, tr, thoraxHalf, 1);

      /* Long slender segmented abdomen, roughly half the body. */
      var abTop = thBot + 1;
      for (var rr = abTop; rr < H; rr++) {
        var w = rr > H - 4 ? 0 : 1;
        band(g, rr, w, (rr - abTop) % 2 === 1 ? 5 : 1);
      }
      band(g, H - 1, 1, 4);

      /* Four wings held straight out. Long, narrow, squared, stalked at
         the base. The stigma is the pigmented cell near the leading tip
         and it is the detail that says Odonata to anyone who has looked at
         one. */
      var reach = span(rnd, [8, 10]);
      /* POSE: the two wing pairs beat OUT OF PHASE, which is what real
         Odonata do and is the single most recognisable thing about how a
         dragonfly flies. Fore goes up while hind goes down, so the frames
         read as counter-rotation rather than as one flapping mass. */
      /* Measured at 94 cells per step when both pairs travelled a full row
         in opposite directions: 4 wings x 2 rows of displacement is the
         whole creature moving. Only the HIND pair travels now and the fore
         pair changes reach instead, which keeps the counter-phase reading
         while halving the visible jump. */
      /* Counter-phase, now expressed as opposite TILT rather than opposite
         row offsets: fore pivots up while hind pivots down. Real Odonata
         behaviour and the most recognisable thing about how a dragonfly
         flies, and as a pivot it costs a fraction of the cells the old
         translation did. */
      var dTilt = wingTilt(pose);
      var fore = straightWing(g, thTop, thoraxHalf + 1, reach + wingReach(pose), 2, 3, dTilt);
      var hind = straightWing(g, thTop + 3, thoraxHalf + 1, reach - 1, 2, 3, -dTilt);

      [fore, hind].forEach(function (set) {
        if (!set.length) return;
        var lead = set[0];
        put(g, lead.row, MID - lead.outer, 6);
        put(g, lead.row, MID - lead.outer + 1, 6);
      });

      /* Venation: a bright line along each wing. */
      if (fore.length > 1) {
        for (var c = fore[1].inner; c <= fore[1].outer; c += 3) {
          put(g, fore[1].row, MID - c, 6);
        }
      }

      /* Six legs clustered forward under the thorax, which is where an
         aerial hunter keeps them.

         Drawn BELOW the wing rows on purpose. The first version put them
         on the same rows as the wings, and since a wing cell is already
         occupied the limb walker skipped every step: the ascii check
         reported 2 leg cells on a six-legged animal. Wings own the upper
         thorax; legs get the rows beneath it. */
      for (var lg = 0; lg < 3; lg++) {
        var lr = thBot - 1 + lg;
        var ec = edgeOf(g, lr);
        if (ec >= 0) limb(g, lr, ec, "odd", 7);
      }
    }
  };

  /* ------------------------------------------------------------- SPIDER
     Araneae. Signature: two body sections joined by a pedicel, eight
     sprawled arching legs, eight simple eyes in two rows, and crucially NO
     WINGS and NO ANTENNAE. */
  SPECIES.spider = {
    label: "Spider",
    note: "Two sections, eight arching legs, eight eyes, no wings",
    order: "Araneae",
    hasWings: false, legCount: 8, antennae: "none",
    build: function (rnd, g, pose) {
      var cephHalf = span(rnd, [2, 3]);
      var abdHalf = span(rnd, [3, 4]);
      var abdLen = span(rnd, [5, 6]);

      /* Cephalothorax: head and thorax fused into one section. Sits high
         so the eight legs have room to radiate around it and the abdomen
         has room below. */
      var cTop = 2;
      var cBot = cTop + 3;
      for (var cr = cTop; cr <= cBot; cr++) {
        band(g, cr, cr === cTop ? cephHalf - 1 : cephHalf, 1);
      }

      /* Eight simple eyes in two rows of four. Spiders have single-lens
         eyes, not compound ones, so these are small and separate rather
         than one big block. Wikipedia: "eight simple eyes usually arranged
         in two rows of four". */
      put(g, cTop, MID - 1, 2);
      put(g, cTop, MID - cephHalf + 1, 2);
      put(g, cTop + 1, MID - 2, 8);
      put(g, cTop + 1, MID, 2);

      /* Chelicerae, the fangs, below the eye rows. */
      put(g, cBot, MID - 1, 4);

      /* Pedicel, the thin waist between the two sections. */
      var ped = cBot + 1;
      band(g, ped, 0, 9);

      /* Bulbous abdomen, widest in the middle. */
      var aTop = ped + 1;
      for (var i = 0; i < abdLen; i++) {
        var rr = aTop + i;
        if (rr >= H) break;
        var t = i / (abdLen - 1);
        var w = Math.round(abdHalf * Math.sin(Math.PI * (0.25 + t * 0.7)));
        band(g, rr, Math.max(1, w), 1);
      }

      /* Spinnerets at the very tip. */
      var spin = Math.min(H - 1, aTop + abdLen);
      put(g, spin, MID, 4);

      /* Abdomen marking. Uses value 10 (body marking), which is a
         different thing from value 6 (wing pattern). The first version
         reused the wing values here and the species gate correctly called
         it: an arachnid was reporting up to 19 wing cells. A spider has no
         wings, so its markings need a value that has nothing to do with
         wings. */
      var markKind = Math.floor(rnd() * 3);
      for (var i2 = 1; i2 < abdLen - 1; i2++) {
        var mr = aTop + i2;
        if (mr >= H) continue;
        if (markKind === 0 && at(g, mr, MID) === 1) put(g, mr, MID, 10);
        if (markKind === 1 && i2 % 2 === 1) {
          for (var mc = 0; mc <= abdHalf - 1; mc++) {
            if (at(g, mr, MID - mc) === 1) put(g, mr, MID - mc, 10);
          }
        }
        if (markKind === 2 && (i2 === 1 || i2 === 3)) {
          if (at(g, mr, MID - 2) === 1) put(g, mr, MID - 2, 10);
        }
      }
      if (markKind === 0) {
        var xr = aTop + 2;
        for (var xc = 0; xc <= 1; xc++) {
          if (at(g, xr, MID - xc) === 1) put(g, xr, MID - xc, 10);
        }
      }

      /* EIGHT LEGS, four pairs, radiating from the CEPHALOTHORAX only.

         Two things make eight legs read as eight rather than as a fringe:
         each pair leaves from its own row, and each pair takes a visibly
         different angle. The first version used similar paths on adjacent
         rows, so the legs touched and the limb count came back as 2
         connected groups instead of 8.

         Legs attach to the cephalothorax because that is where a spider's
         legs actually are. Running them alongside the abdomen made the
         creature read as a crab. */
      /* POSE: a spider has no wings, so its idle is entirely in the legs.
         Real spiders probe with alternating pairs rather than moving all
         eight together, so each pose lifts one diagonal set and lets the
         others hold. That alternation is what stops it looking like a
         wobbling star.

         pose 0  neutral stance
         pose 1  pairs 1 and 3 reach forward and up
         pose 2  pairs 2 and 4 reach, the first set settles */
      /* Five poses walking a continuous cycle rather than three snapping
         between extremes. Adjacent poses differ in ONE pair, so the beat
         order steps through them without any single step moving the whole
         animal: that is what stops eight legs reading as a twitch. */
      var POSE_PATHS = [
        ["ouo",  "oouo", "oodd", "oddd"],
        ["ouuo", "oouo", "oodd", "oddd"],
        ["ouuo", "oouu", "oodd", "oddd"],
        ["ouuo", "oouu", "oodo", "oddd"],
        ["ouuo", "oouu", "oodo", "oddo"]
      ];
      var paths = POSE_PATHS[pose] || POSE_PATHS[2];
      for (var p = 0; p < 4; p++) {
        var lr = cTop + p;
        if (lr > cBot) break;
        var ec = edgeOf(g, lr);
        if (ec < 0) continue;
        limb(g, lr, ec, paths[p], 7);
      }
    }
  };

  /* ------------------------------------------------------------- BEETLE
     Coleoptera. Signature: forewings hardened into elytra that meet in a
     straight seam down the middle, a pronotum shield behind the head, and
     often a horn. */
  SPECIES.beetle = {
    label: "Beetle",
    note: "Elytra with a centre seam, pronotum shield, optional horn",
    order: "Coleoptera",
    hasWings: true, legCount: 6, antennae: "clubbed",
    build: function (rnd, g, pose) {
      var headHalf = 2;
      var pronHalf = span(rnd, [3, 4]);
      var elyHalf = pronHalf + 1;
      var elyLen = span(rnd, [7, 9]);
      var horned = chance(rnd, 0.45);

      var headTop = 2;
      band(g, headTop, headHalf - 1, 1);
      band(g, headTop + 1, headHalf, 1);
      put(g, headTop + 1, MID - headHalf, 2);
      put(g, headTop + 1, MID - headHalf + 1, 8);

      /* A rhinoceros beetle's horn: forward and up off the centre line.
         Drawn on the spine so it stays symmetric. */
      if (horned) {
        put(g, headTop - 1, MID, 4);
        put(g, headTop - 2, MID, 4);
        put(g, headTop - 2, MID - 1, 4);
      } else {
        /* Otherwise mandibles either side of the mouth. */
        put(g, headTop, MID - headHalf, 4);
      }

      /* Clubbed antennae, which twitch on the off frame. */
      var bAnt = ["ou", "ouu", "ouu", "ou", "ou"][pose] || "ou";
      limb(g, headTop, MID - headHalf + 1, bAnt, 1);
      put(g, headTop - (bAnt.length > 2 ? 2 : 1), MID - headHalf - 1, 4);

      /* Pronotum: the shield between head and elytra. */
      var pTop = headTop + 2;
      band(g, pTop, pronHalf - 1, 1);
      band(g, pTop + 1, pronHalf, 1);

      /* ELYTRA. An oval shell with a hard seam down the centre. The seam
         is the single detail that makes a beetle unmistakable, and it is
         why this species uses a dark structural value rather than a
         pattern colour. */
      var eTop = pTop + 2;
      for (var i = 0; i < elyLen; i++) {
        var rr = eTop + i;
        if (rr >= H) break;
        var t = i / (elyLen - 1);
        var w = Math.round(elyHalf * Math.sin(Math.PI * (0.18 + t * 0.78)));
        band(g, rr, Math.max(1, w), 3);
        put(g, rr, MID, 9);
      }

      /* Elytra markings: spots or ribs. */
      if (chance(rnd, 0.5)) {
        for (var s = 1; s < elyLen - 1; s += 2) {
          var sr = eTop + s;
          if (at(g, sr, MID - 2) === 3) put(g, sr, MID - 2, 6);
        }
      } else {
        for (var rib = 0; rib < elyLen; rib++) {
          var rr2 = eTop + rib;
          if (at(g, rr2, MID - elyHalf + 1) === 3) put(g, rr2, MID - elyHalf + 1, 6);
        }
      }

      /* Six sturdy legs.

         POSE: a beetle's elytra are hardened wing cases and they do NOT
         flap at rest, so animating them would be wrong. The idle lives in
         the legs and the antennae instead: a slow trundle, two frames
         only. This is why beetle is the one species with frames: 2. */
      /* Measured at 2 cells changed per step, which is invisible. A beetle
         should still be the calmest thing on the page, so the fix is not
         to flap the elytra (they are hardened cases and do not move at
         rest) but to give the legs a real stride and the antennae a
         twitch. Lands around 8 cells: present, unhurried. */
      /* Elytra stay shut: they are hardened wing cases and do not flap at
         rest. The whole idle is a slow trundle in the legs. */
      var STRIDES = [
        ["odd",  "odd",  "odd"],
        ["oddd", "odd",  "oddd"],
        ["oddd", "oddd", "oddd"],
        ["odd",  "oddd", "odd"],
        ["odd",  "odd",  "odd"]
      ];
      var stride = STRIDES[pose] || STRIDES[0];
      for (var lg = 0; lg < 3; lg++) {
        var lr = pTop + 1 + lg * 3;
        var ec = edgeOf(g, lr);
        if (ec >= 0) limb(g, lr, ec, stride[lg], 7);
      }
    }
  };

  /* ------------------------------------------------------------- MANTIS
     Mantodea. Signature: triangular head, elongated prothorax, and the
     raptorial forelegs held folded in front. */
  SPECIES.mantis = {
    label: "Mantis",
    note: "Triangular head, long prothorax, raptorial forelegs folded",
    order: "Mantodea",
    hasWings: true, legCount: 6, antennae: "straight",
    build: function (rnd, g, pose) {
      /* Triangular head, wider than tall, eyes on the outer points. */
      var headTop = 1;
      band(g, headTop, 2, 1);
      band(g, headTop + 1, 1, 1);
      put(g, headTop, MID - 2, 2);
      put(g, headTop, MID - 3, 2);
      put(g, headTop + 1, MID - 1, 8);

      limb(g, headTop, MID - 2, "uu", 1);

      /* ELONGATED PROTHORAX. The long narrow segment behind the head is
         what makes a mantis look like a mantis before you even see the
         arms. */
      var neckTop = headTop + 2;
      var neckLen = span(rnd, [3, 4]);
      for (var i = 0; i < neckLen; i++) band(g, neckTop + i, 1, 1);

      /* RAPTORIAL FORELEGS, folded in the prayer posture: down and out
         from the neck, then back up and in. The Z is the signature.

         POSE: a mantis idles by slowly re-setting its arms and swaying.
         The arms tighten and extend across the three frames, which is the
         motion people actually associate with the animal. Slowest hz in
         the library on purpose: a fast mantis reads as a bug in the code
         rather than as a predator waiting. */
      var armRow = neckTop + 1;
      /* Five arm positions, tightening then extending. A mantis idles
         slowly, so each step is deliberately small. */
      /* Every pose must differ from its neighbours: duplicated entries here
         produced 480 transitions that changed nothing, which is a creature
         freezing mid-cycle. Five distinct arm positions, one step apart. */
      var ARMS = [
        ["ood",   "ou"],
        ["oodd",  "ouu"],
        ["oodd",  "ouuu"],
        ["oddd",  "ouuu"],
        ["odddd", "ouuuu"]
      ];
      var arm = ARMS[pose] || ARMS[2];
      limb(g, armRow, MID - 1, arm[0], 7);
      limb(g, armRow + 2, MID - 3, arm[1], 4);

      /* Body and folded wings over the abdomen. */
      /* NO body sway. Shifting the whole body a row measured 41 cells per
         step and broke anatomy on 93 frames, because the wings and legs
         were placed relative to a thorax that had moved out from under
         them. The mantis idle lives entirely in the arms, which is also
         what a real one does while waiting. */
      var bTop = neckTop + neckLen;
      var bodyHalf = span(rnd, [2, 3]);
      var bodyLen = span(rnd, [5, 7]);
      for (var b = 0; b < bodyLen; b++) {
        var rr = bTop + b;
        if (rr >= H) break;
        var w = Math.max(1, bodyHalf - Math.floor(b / 3));
        band(g, rr, w, b % 2 === 1 ? 5 : 1);
      }

      /* Wings folded flat along the back, so they read as a long panel
         rather than as spread blades. */
      bladeWing(g, bTop, Math.min(H - 2, bTop + bodyLen - 1), bodyHalf + 1,
        span(rnd, [3, 4]), 0.9, 3, Math.round(wingTilt(pose) * 0.5));

      /* Four walking legs behind the arms. */
      for (var lg = 0; lg < 2; lg++) {
        var lr = bTop + 1 + lg * 2;
        var ec = edgeOf(g, lr);
        if (ec >= 0) limb(g, lr, ec, "oddd", 7);
      }
    }
  };

  /* ---------------------------------------------------------------- ANT
     Formicidae. Signature: three nodes with narrow joins, elbowed
     antennae, big mandibles, and no wings on a worker. */
  SPECIES.ant = {
    label: "Ant",
    note: "Three nodes, elbowed antennae, mandibles, wingless worker",
    order: "Hymenoptera",
    hasWings: false, legCount: 6, antennae: "elbowed",
    build: function (rnd, g, pose) {
      var headHalf = span(rnd, [2, 3]);

      /* Big head, which on an ant is proportionally larger than on a bee. */
      var headTop = 2;
      band(g, headTop, headHalf - 1, 1);
      band(g, headTop + 1, headHalf, 1);
      band(g, headTop + 2, headHalf, 1);
      put(g, headTop + 1, MID - headHalf, 2);
      put(g, headTop + 2, MID - headHalf, 8);

      /* Mandibles: forward and out. Big enough to read. */
      limb(g, headTop, MID - headHalf + 1, "ou", 4);

      /* ELBOWED ANTENNAE: a long scape up, then a sharp bend outward.
         Nothing else in this library bends like this.

         POSE: the antennae are where an ant's attention lives, so they
         carry the idle. The elbow swings out and back while the body
         stays put, which reads as an ant checking the air. */
      /* The antennae sweep through five positions rather than flicking
         between three, so the arc reads as searching rather than twitching. */
      var ANT_ANT = ["uuo", "uuoo", "uuoou", "uuoo", "uuoouu"];
      limb(g, headTop, MID - 1, ANT_ANT[pose] || ANT_ANT[2], 1);

      /* Narrow neck, then the mesosoma. */
      var neck = headTop + 3;
      band(g, neck, 0, 9);

      var mTop = neck + 1;
      var mLen = span(rnd, [3, 4]);
      for (var i = 0; i < mLen; i++) band(g, mTop + i, 2, 1);

      /* PETIOLE: the single narrow node that gives an ant its three-part
         outline. */
      var pet = mTop + mLen;
      band(g, pet, 0, 4);

      /* Gaster: the big rounded rear section. */
      var gTop = pet + 1;
      var gLen = Math.min(span(rnd, [4, 5]), H - gTop);
      for (var j = 0; j < gLen; j++) {
        var rr = gTop + j;
        var t = gLen === 1 ? 0.5 : j / (gLen - 1);
        var w = Math.round(3 * Math.sin(Math.PI * (0.22 + t * 0.72)));
        band(g, rr, Math.max(1, w), j % 2 === 1 ? 5 : 1);
      }

      /* Six long legs, marching: alternate tripods swing on alternate
         poses, which is how a real six-legged gait works. */
      /* Alternating tripod, five samples. Only one tripod is mid-swing at
         a time, which is how a real six-legged gait works and what keeps
         any single step small. */
      var GAITS = [
        ["oodd",  "oodd",  "oodd"],
        ["ooddd", "oodd",  "ooddd"],
        ["ooddd", "ooddd", "ooddd"],
        ["oodd",  "ooddd", "oodd"],
        ["oodd",  "oodd",  "oodd"]
      ];
      var gait = GAITS[pose] || GAITS[0];
      for (var lg = 0; lg < 3; lg++) {
        var lr = mTop + lg;
        var ec = edgeOf(g, lr);
        if (ec >= 0) limb(g, lr, ec, gait[lg], 7);
      }
    }
  };

  /* --------------------------------------------------------------- MOTH
     Lepidoptera. Signature: broad patterned wings in two pairs, feathered
     antennae, fuzzy body. */
  SPECIES.moth = {
    label: "Moth",
    note: "Broad patterned wings, feathered antennae, fuzzy body",
    order: "Lepidoptera",
    hasWings: true, legCount: 6, antennae: "feathered",
    build: function (rnd, g, pose) {
      var headTop = 3;
      band(g, headTop, 1, 1);
      put(g, headTop, MID - 1, 2);

      /* FEATHERED ANTENNAE: a stalk with barbs either side. Four cells of
         detail that instantly say moth rather than butterfly. */
      for (var a = 1; a <= 3; a++) {
        var ar = headTop - a;
        if (ar < 0) break;
        put(g, ar, MID - 1 - Math.floor(a / 2), 1);
        put(g, ar, MID - 2 - Math.floor(a / 2), 4);
      }

      var thTop = headTop + 1;
      var thBot = thTop + 2;
      for (var tr = thTop; tr <= thBot; tr++) band(g, tr, 2, 1);
      put(g, thTop, MID - 2, 4);

      var abTop = thBot + 1;
      var abdLen = span(rnd, [4, 5]);
      for (var i = 0; i < abdLen; i++) {
        var rr = abTop + i;
        if (rr >= H) break;
        band(g, rr, Math.max(0, 2 - Math.floor(i / 2)), i % 2 === 1 ? 5 : 1);
      }

      /* Broad forewing and hindwing. These are the widest wings in the
         library and they carry the pattern. */
      /* POSE: the deepest travel in the library. A moth's flap is slow and
         wide, so it gets two rows rather than one, and the wing shortens
         noticeably at the top of the stroke as it angles toward the
         viewer. */
      /* Measured at 99 cells changed per step with a two-row travel, which
         reads as a glitch rather than a flap: the whole wing mass jumps.
         One row plus a small reach change gives the deep unhurried look
         without the sprite appearing to teleport. */
      /* The deepest arc in the library: a moth's flap is slow and wide, so
         it gets 1.5x the standard tilt at the tip. */
      /* 1.5x tilt measured at 36.5 cells per step. These are the widest
         wings here, so they need LESS tilt than average, not more: the
         travel at the tip is already large because the wing is long. */
      var mt = Math.round(wingTilt(pose) * 0.8);
      var mr = wingReach(pose);
      var fore = bladeWing(g, headTop, thBot + 2, 3,
        span(rnd, [7, 9]) + mr, 0.35, 3, mt);
      var hind = bladeWing(g, thBot + 1, Math.min(H - 2, abTop + abdLen), 3,
        span(rnd, [5, 7]) + mr, 0.5, 3, Math.round(mt * 0.7));

      /* Eyespot on the widest part of the forewing: the single most
         organic marking available and pure Lepidoptera. */
      var all = fore.concat(hind);
      if (all.length) {
        var widest = all.slice().sort(function (x, y) {
          return (y.outer - y.inner) - (x.outer - x.inner);
        })[0];
        var ec2 = Math.floor((widest.inner + widest.outer) / 2);
        [0, 1].forEach(function (dr) {
          [0, 1].forEach(function (dc) {
            if (at(g, widest.row + dr, MID - (ec2 + dc)) === 3) {
              put(g, widest.row + dr, MID - (ec2 + dc), 6);
            }
          });
        });
        if (at(g, widest.row, MID - ec2) === 6) put(g, widest.row, MID - ec2, 4);
      }

      /* Below the wings, which on a moth cover nearly the whole body. */
      for (var lg = 0; lg < 3; lg++) {
        var lr = abTop + lg;
        var ec = edgeOf(g, lr);
        if (ec >= 0) limb(g, lr, ec, "oddd", 7);
      }
    }
  };

  /* ----------------------------------------------------------- DAMSELFLY
     Zygoptera. The dragonfly's slighter cousin: eyes SEPARATED rather than
     touching, wings stalked and held back, an even thinner abdomen. */
  SPECIES.damselfly = {
    label: "Damselfly",
    note: "Separated eyes, stalked wings held back, hair-thin abdomen",
    order: "Odonata",
    hasWings: true, legCount: 6, antennae: "bristle",
    build: function (rnd, g, pose) {
      /* Eyes on stalks either side with a clear gap between them, which is
         the field mark that separates Zygoptera from Anisoptera. */
      var headTop = 2;
      band(g, headTop, 1, 1);
      put(g, headTop, MID - 3, 2);
      put(g, headTop, MID - 4, 2);
      put(g, headTop + 1, MID - 3, 8);
      band(g, headTop + 1, 1, 1);
      put(g, headTop - 1, MID - 4, 4);

      var thTop = headTop + 2;
      var thBot = thTop + 2;
      for (var tr = thTop; tr <= thBot; tr++) band(g, tr, 1, 1);

      /* Hair-thin abdomen running most of the height. */
      for (var rr = thBot + 1; rr < H - 1; rr++) {
        band(g, rr, 0, (rr - thBot) % 2 === 1 ? 5 : 1);
      }
      band(g, H - 1, 1, 4);

      /* Four narrow wings, stalked at the base, swept back rather than
         held flat. */
      var reach = span(rnd, [7, 9]);
      /* POSE: unlike the dragonfly, a damselfly's wings move together and
         slowly. Same lift on both pairs. */
      /* Unlike the dragonfly, a damselfly's pairs move together. */
      /* Measured at 55 cells per step at full tilt: a damselfly wing is one
         cell thick and 8 long, so the whole blade relocates. Half tilt
         keeps the flutter visible at a third of the cost. */
      /* Rounding half-tilt collapsed adjacent poses onto the same value,
         which produced 240 transitions that changed nothing. An explicit
         ladder guarantees every pose differs from its neighbour. */
      var dt = [-1, -1, 0, 1, 1][pose];
      if (dt == null) dt = 0;
      /* Reach carries the difference where tilt repeats, so no step is dead. */
      var dr = [-1, 0, 0, 0, -1][pose] || 0;
      var fore = straightWing(g, thTop, 2, reach + dr, 1, 3, dt);
      var hind = straightWing(g, thTop + 2, 2, reach - 1 + dr, 1, 3, dt);
      [fore, hind].forEach(function (set) {
        if (set.length) put(g, set[0].row, MID - set[0].outer, 6);
      });

      /* Legs below the wing rows, same reason as the dragonfly: a limb
         walker skips any cell that is already occupied, so legs sharing
         rows with wings simply vanish. */
      for (var lg = 0; lg < 3; lg++) {
        var lr = thBot + lg;
        var ec = edgeOf(g, lr);
        if (ec >= 0) limb(g, lr, ec, "oddd", 7);
      }
    }
  };

  var SPECIES_IDS = Object.keys(SPECIES);

  /* ------------------------------------------------- connectivity proof

     Every builder attaches its parts deliberately, but a limb can still be
     orphaned when two parts shift under each other. Rather than argue that
     it cannot happen, flood from the spine and walk anything unreached
     back to the mass. This is why the anatomy gate can hold at zero no
     matter what any future species does. */
  function weld(g) {
    /* Repair runs to a FIXED POINT, not once.

       The single-pass version measured its fragments, bridged them, and
       returned. But every write goes through put(), which mirrors, so a
       repair on the left half changes the right half underneath the pass.
       The `seen` map was computed before any of that and went stale the
       moment the first bridge landed. Nineteen moths came out in pieces
       with the bridge code running correctly on a map that no longer
       described the grid.

       Recomputing from scratch each round and repeating until nothing
       changes removes the whole class of ordering bug. It costs a few
       passes on a 23x19 grid, which is nothing, and it is provable rather
       than tuned: the loop cannot exit while a fragment remains bridgeable.

       MAX_FRAGMENT / MAX_BRIDGE keep the repair quiet. The version before
       this walked an orphan all the way to the centre column, filling body
       cells the whole way, which painted a solid rule across the bottom of
       the sprite. It showed up as a straight line across the bottom of the
       creature on one tick of the animation: a stranded bee leg tip
       produced a 23 cell bar spanning the entire sprite. The bar was never anatomy, it was the
       repair being louder than the damage. */
    var MAX_FRAGMENT = 3;   /* cells; at or under this, delete rather than bridge */
    var MAX_BRIDGE = 2;     /* cells; no connector may ever be longer */
    var deltas = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    for (var pass = 0; pass < 6; pass++) {
      /* Flood from the spine to find what is currently attached. */
      var seen = [];
      for (var r = 0; r < H; r++) seen.push(new Array(W).fill(false));

      var seedRow = -1;
      for (r = 0; r < H; r++) if (g[r][MID]) { seedRow = r; break; }
      if (seedRow < 0) return g;

      var stack = [[seedRow, MID]];
      seen[seedRow][MID] = true;
      while (stack.length) {
        var cur = stack.pop();
        for (var d = 0; d < 4; d++) {
          var nr = cur[0] + deltas[d][0], nc = cur[1] + deltas[d][1];
          if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
          if (!g[nr][nc] || seen[nr][nc]) continue;
          seen[nr][nc] = true;
          stack.push([nr, nc]);
        }
      }

      /* Gather the largest orphaned fragment, if any. Handling ONE per pass
         keeps every decision based on a map that is currently true. */
      var claimed = [];
      for (r = 0; r < H; r++) claimed.push(new Array(W).fill(false));

      var target = null;
      for (r = 0; r < H; r++) {
        for (var c = 0; c < W; c++) {
          if (!g[r][c] || seen[r][c] || claimed[r][c]) continue;
          var frag = [];
          var fstack = [[r, c]];
          claimed[r][c] = true;
          while (fstack.length) {
            var fc = fstack.pop();
            frag.push(fc);
            for (var fd = 0; fd < 4; fd++) {
              var fr2 = fc[0] + deltas[fd][0], fc2 = fc[1] + deltas[fd][1];
              if (fr2 < 0 || fr2 >= H || fc2 < 0 || fc2 >= W) continue;
              if (!g[fr2][fc2] || seen[fr2][fc2] || claimed[fr2][fc2]) continue;
              claimed[fr2][fc2] = true;
              fstack.push([fr2, fc2]);
            }
          }
          if (!target || frag.length > target.length) target = frag;
        }
      }

      if (!target) return g;          /* fully connected, done */

      /* Small fragment: delete rather than draw a connector to it. */
      if (target.length <= MAX_FRAGMENT) {
        for (var k = 0; k < target.length; k++) {
          g[target[k][0]][target[k][1]] = 0;
        }
        continue;
      }

      /* Shortest path from the fragment to anchored mass, through empty
         cells, in any direction. Ray casting missed the moth, whose leg
         cluster hangs below and outboard of the wing mass. */
      var dist = [];
      for (var dr = 0; dr < H; dr++) dist.push(new Array(W).fill(-1));
      var queue = [];
      for (var k2 = 0; k2 < target.length; k2++) {
        dist[target[k2][0]][target[k2][1]] = 0;
        queue.push(target[k2]);
      }

      var anchor = null, qi = 0;
      while (qi < queue.length && !anchor) {
        var q = queue[qi++];
        var qd = dist[q[0]][q[1]];
        if (qd > MAX_BRIDGE) break;
        for (var d2 = 0; d2 < 4; d2++) {
          var ar = q[0] + deltas[d2][0], ac = q[1] + deltas[d2][1];
          if (ar < 0 || ar >= H || ac < 0 || ac >= W) continue;
          if (dist[ar][ac] !== -1) continue;
          if (g[ar][ac] && seen[ar][ac]) { dist[ar][ac] = qd + 1; anchor = [ar, ac]; break; }
          if (g[ar][ac]) continue;                 /* another fragment */
          dist[ar][ac] = qd + 1;
          queue.push([ar, ac]);
        }
      }

      if (anchor) {
        /* Walk back to the fragment, filling empties. Writes are direct,
           NOT through put(): mirroring here is what corrupted the map the
           decision was made from. Symmetry is restored by the pass below. */
        var cur2 = anchor, guard = 0;
        while (dist[cur2[0]][cur2[1]] > 0 && guard++ < 8) {
          var want = dist[cur2[0]][cur2[1]] - 1;
          var moved = false;
          for (var d3 = 0; d3 < 4; d3++) {
            var pr = cur2[0] + deltas[d3][0], pc = cur2[1] + deltas[d3][1];
            if (pr < 0 || pr >= H || pc < 0 || pc >= W) continue;
            if (dist[pr][pc] !== want) continue;
            if (want > 0 && !g[pr][pc]) g[pr][pc] = 1;
            cur2 = [pr, pc];
            moved = true;
            break;
          }
          if (!moved) break;
        }
      } else {
        /* Nothing reachable within the cap. Drop it rather than draw a
           rule across the sprite. */
        for (var k3 = 0; k3 < target.length; k3++) {
          g[target[k3][0]][target[k3][1]] = 0;
        }
      }
    }

    return g;
  }

  /* Restore bilateral symmetry after repair.

     Repairs write directly rather than through put(), because mirroring
     mid-repair invalidates the connectivity map the repair is reading. The
     left half is taken as authoritative and copied across, which is also
     what every builder assumes. */
  function symmetrise(g) {
    for (var r = 0; r < H; r++) {
      for (var c = 0; c < MID; c++) {
        g[r][W - 1 - c] = g[r][c];
      }
    }
    return g;
  }

  function build(rnd, speciesId, pose) {
    var sp = SPECIES[speciesId];
    var g = canvas();
    sp.build(rnd, g, pose || 0);
    markings(rnd, g, sp);
    return symmetrise(weld(g));
  }

  /* ------------------------------------------------------------- motion

     WHY POSE FRAMES AND NOT TRANSFORMS
     These are pixel sprites. Rotating or scaling an SVG group resamples it
     at a fractional offset, so the crisp cell edges turn to mush and the
     whole reason for drawing on a grid is thrown away. Arcade sprites
     animate by SWAPPING DRAWN FRAMES, and so do these.

     WHY THE FIRST ATTEMPT LOOKED LIKE A STROBE
     The first version was rejected as too fast and not fluid. Both halves
     were real defects and they had different causes.

       TOO FAST. A bee at 7.5 Hz over a 4 step cycle is 30 frame changes a
       second. Wings genuinely beat that fast, but a 40px sprite changing
       30 times a second reads as noise, not as a wingbeat. Rates are now
       0.22 to 1.25 Hz over an 8 step cycle, which is 1.8 to 10 changes a
       second. The RELATIVE spread is preserved, so a bee is still visibly
       livelier than a mantis; the absolute range is now watchable.

       NOT FLUID. This was the deeper one. Three frames bouncing between
       two extremes is a toggle, and no rate makes a toggle fluid. Two
       changes fix it:

         1. MORE SAMPLES ALONG THE ARC. Five frames sampled from a sine,
            played as an 8 step ping-pong, so the wing passes through
            intermediate positions instead of snapping between extremes.
         2. PIVOT, NOT TRANSLATE. The old frames moved the whole wing band
            a full row, changing 50 to 90 cells in one step. A real wing
            pivots at the shoulder, so the root holds and only the tip
            travels. Same visible travel at the tip, a fraction of the
            cells changed per step, which is what smooth actually means
            here.

     THE ARC
     Frame index maps to a tilt in cells at the wingtip:

       frame   0    1    2    3    4
       tilt   -2   -1    0   +1   +2

     order [2,1,0,1,2,3,4,3] walks 0, up, top, up, 0, down, bottom, down,
     which is one full beat with no repeated step and no jump larger than
     one tilt unit. */

  /* Five tilt samples of a sine, in cells of travel at the wingtip. */
  var TILTS = [-2, -1, 0, 1, 2];

  /* One full beat: through the top, back through neutral, through the
     bottom, back. Adjacent entries never differ by more than one sample,
     which is the whole fluidity requirement. */
  var BEAT = [2, 1, 0, 1, 2, 3, 4, 3];

  /* A gentler beat for species whose wings barely move at rest. */
  var HALF_BEAT = [2, 1, 2, 3];

  /* Global speed multiplier for every species.

     One constant rather than nine edited numbers, so the ratios between
     species are preserved by construction. A bee must stay visibly livelier
     than a mantis no matter where the overall tempo lands, and hand editing
     nine rates loses that within a couple of rounds.

     HISTORY, BECAUSE THE RANGE HERE IS NARROWER THAN IT LOOKS
     v1 ran the bee at 7.5 Hz over a 4 step cycle, which is 30 frame changes
     a second, which reads as noise rather than as a wingbeat.
     v2 dropped to the base rates below, which he accepted as fluid and then
     asked to speed up "a bit".

     Why faster is safe now and was not then: the v1 frames MOVED A WHOLE
     WING BAND, changing 50 to 90 cells per step, so every step was a snap.
     The pivot rebuild cut that to 3 to 34 cells per step. Perceptual load is
     roughly cells changed per second, not steps per second, so the same
     tempo is a far smaller visual jolt than it used to be:

       v1 bee, rejected:  71 cells x 30 steps/s  = 2130 cells/s
       v2 bee, accepted:  28 cells x 8.8 steps/s =  246 cells/s
       this, at 1.6x:     28 cells x 14 steps/s  =  395 cells/s

     Still five times quieter than the version that read as a strobe, while
     being noticeably livelier than the one he asked to speed up. */
  var SPEED = 1.6;

  var MOTION = {
    bee:       { frames: 5, hz: 1.10 * SPEED, order: BEAT, note: "quick shallow beat, the liveliest flyer" },
    wasp:      { frames: 5, hz: 1.25 * SPEED, order: BEAT, note: "fastest here, tighter stroke than the bee" },
    dragonfly: { frames: 5, hz: 0.90 * SPEED, order: BEAT, note: "fore and hind wings beat out of phase" },
    damselfly: { frames: 5, hz: 0.70 * SPEED, order: BEAT, note: "slower, both pairs flutter together" },
    moth:      { frames: 5, hz: 0.50 * SPEED, order: BEAT, note: "deep unhurried flap, widest travel" },
    ant:       { frames: 5, hz: 0.60 * SPEED, order: BEAT, note: "antennae sweep, alternating tripod gait" },
    beetle:    { frames: 5, hz: 0.35 * SPEED, order: HALF_BEAT, note: "elytra are hardened cases: legs and antennae only" },
    spider:    { frames: 5, hz: 0.30 * SPEED, order: BEAT, note: "no wings: leg pairs feel forward in turn" },
    mantis:    { frames: 5, hz: 0.22 * SPEED, order: BEAT, note: "slowest, forelegs re-set and the body sways" }
  };

  /* Wingtip travel in cells for a pose. The root never moves. */
  function wingTilt(pose) {
    return TILTS[pose] == null ? 0 : TILTS[pose];
  }

  /* Foreshortening: a wing angled toward the viewer looks shorter, so reach
     drops at the extremes of the arc and is full at neutral. This is what
     stops the pivot reading as a flat windscreen wiper. */
  function wingReach(pose) {
    var t = wingTilt(pose);
    return -Math.abs(t) > -1 ? 0 : -1;
  }

  /* ------------------------------------------------------- individuality

     Each species builder draws its ORDER correctly, which is the point of
     this library, but that left every bee close to every other bee: the
     collision rate came back at 16.7 percent against roughly 1 percent for
     the older parametric family.

     The fix is not more anatomy randomness, because that is what makes a
     species stop reading as itself. It is markings, which is exactly how
     real individuals of one species differ: the same body, different
     pattern. Four patterns applied per individual, each one only ever
     REPLACING an existing body cell, so nothing here can change a
     silhouette or break connectivity. */
  function markings(rnd, g, sp) {
    var kind = Math.floor(rnd() * 4);
    var r, c;

    if (kind === 0) {
      /* Dorsal stripe down the spine. */
      for (r = 0; r < H; r++) {
        if (g[r][MID] === 1) put(g, r, MID, 10);
      }
    } else if (kind === 1) {
      /* Flank spots: one pair every third row on the body edge. */
      for (r = 0; r < H; r += 3) {
        var e = edgeOf(g, r);
        if (e >= 0 && g[r][e] === 1) put(g, r, e, 10);
      }
    } else if (kind === 2) {
      /* Chevrons: alternate rows tinted from the centre outward. */
      for (r = 0; r < H; r++) {
        if (r % 2) continue;
        for (c = MID; c >= MID - 2; c--) {
          if (g[r][c] === 1) put(g, r, c, 10);
        }
      }
    }
    /* kind 3 leaves the creature plain, which is a real outcome and keeps
       the set from looking uniformly busy. */

    /* An occasional bright shoulder flash, independent of the pattern. */
    if (rnd() < 0.35) {
      for (r = 0; r < H; r++) {
        var e2 = edgeOf(g, r);
        if (e2 >= 0 && g[r][e2] === 1) { put(g, r, e2, 4); break; }
      }
    }
  }

  global.FAInsects = {
    W: W, H: H, MID: MID,
    SPECIES: SPECIES,
    SPECIES_IDS: SPECIES_IDS,
    MOTION: MOTION,
    build: build
  };
})(typeof window !== "undefined" ? window : this);


/* -------------------------------------------------------------- render */

(function (global) {
  "use strict";

  var C = global.FACore;
  var FAMILIES = {};

  function svgWrap(size, inner, extra, box) {
    /* The viewBox tracks the CONTENT, not the grid.

       A fixed "0 0 100 100" box was correct when these were floating on a
       concept sheet with room around them. Dropped into a square avatar slot
       it renders the creature small and sitting high: a bee occupies about
       85 by 52 units of that box, so a third of the height is dead space
       below it and the visible creature is far smaller than the slot it was
       given.

       Fitting the box to the drawn extent makes the creature fill whatever
       size it is handed, which is what every caller already expects from an
       avatar. The pad keeps a cell of air so a wingtip does not touch the
       frame edge. */
    var vb = box || { x: 0, y: 0, w: 100, h: 100 };
    return '<svg viewBox="' + vb.x + " " + vb.y + " " + vb.w + " " + vb.h + '" ' +
      'width="' + size + '" height="' + size + '" ' +
      'aria-hidden="true" style="display:block;overflow:visible">' + (extra || "") + inner + "</svg>";
  }

  /* Bounds of the live cells, in the same units the cells are drawn in.

     Computed from the GRID rather than by parsing the emitted markup, so it
     costs nothing and cannot disagree with what was drawn.

     The box is the UNION ACROSS EVERY POSE, not the extent of the pose being
     drawn. A per-pose box measured 42.8 percent of creatures rescaling
     between frames, a spider by 25.5 percent, because a wing at full spread
     needs a wider box than the same wing folded. The creature would appear to
     pulse in and out as it animated, which is the opposite of an idle. */
  function contentBox(grid, cell, originX, originY, depth, pad) {
    var minR = null, maxR = 0, minC = null, maxC = 0;
    for (var r = 0; r < grid.length; r++) {
      for (var c = 0; c < grid[0].length; c++) {
        if (!grid[r][c]) continue;
        if (minR === null) minR = r;
        maxR = r;
        if (minC === null || c < minC) minC = c;
        if (c > maxC) maxC = c;
      }
    }
    if (minR === null) return null;

    var p = pad === undefined ? cell : pad;
    var x = originX + minC * cell - p;
    var y = originY + minR * cell - depth - p;
    var w = (maxC - minC + 1) * cell + depth + p * 2;
    var h = (maxR - minR + 1) * cell + depth + p * 2;

    /* Square the box so a wide creature is not stretched when the caller
       hands the svg equal width and height. Centre the shorter axis. */
    if (w > h) { y -= (w - h) / 2; h = w; }
    else if (h > w) { x -= (h - w) / 2; w = h; }

    return { x: r2(x), y: r2(y), w: r2(w), h: r2(h) };
  }

  /* Union of the content boxes of every pose of one creature. */
  function stableBox(rnd0, speciesId, seed, cell, originX, originY, depth, pad) {
    var m = I.MOTION[speciesId] || { frames: 1 };
    var box = null;
    for (var p = 0; p < m.frames; p++) {
      var g = I.build(C.rng(seed), speciesId, p);
      var b = contentBox(g, cell, originX, originY, depth, pad);
      if (!b) continue;
      if (!box) { box = b; continue; }
      var x0 = Math.min(box.x, b.x);
      var y0 = Math.min(box.y, b.y);
      var x1 = Math.max(box.x + box.w, b.x + b.w);
      var y1 = Math.max(box.y + box.h, b.y + b.h);
      box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    if (!box) return null;
    /* Re-square after the union. */
    if (box.w > box.h) { box.y -= (box.w - box.h) / 2; box.h = box.w; }
    else if (box.h > box.w) { box.x -= (box.h - box.w) / 2; box.w = box.h; }
    return { x: r2(box.x), y: r2(box.y), w: r2(box.w), h: r2(box.h) };
  }

  function r2(n) { return Math.round(n * 100) / 100; }

  function defsGrad(uid, m, cx, cy) {
    return '<radialGradient id="' + uid + '-g" cx="' + (cx || 34) + '%" cy="' + (cy || 24) + '%" r="82%">' +
      '<stop offset="0" stop-color="' + m.light + '"/>' +
      '<stop offset="1" stop-color="' + m.dark + '"/>' +
      "</radialGradient>";
  }

  function contactShadow(cy, rx, ry, op) {
    return '<ellipse cx="50" cy="' + cy + '" rx="' + rx + '" ry="' + ry + '" fill="#000" opacity="' + (op || 0.3) + '"/>';
  }

  /* ==================================================================
     FAMILY 1: THE SWARM
     Rebuilt three times. Galaga rather than Space Invaders,
     then finer pixels, then this: real insect orders with real anatomy.

     WHY THIS FAMILY NO LONGER GENERATES ITS OWN SHAPES
     The previous version had ONE body plan with numeric ranges per
     species, which is exactly why a bee and a moth came out looking like
     the same animal in different proportions. Real orders are different
     ARCHITECTURES, not different settings: a spider has no wings and two
     body sections, a dragonfly's eyes cover its whole head, a beetle's
     forewings are hardened into a seamed shell.

     So the anatomy moved to concepts/insects.js, where each species has
     its own builder. This file now does what it is actually for: taking a
     grid of anatomical regions and painting it with the harmony system.

     Nine species across six orders, each verified against its own
     declared anatomy by render/species_gate.js. */

  var I = global.FAInsects;

  FAMILIES.voxel = {
    id: "voxel",
    name: "The Swarm",
    axis: "silhouette",
    blurb: "Nine species across six orders. Real anatomy, not one shape with knobs.",
    dims: function () {
      return [
        { name: "species", n: I.SPECIES_IDS.length },
        { name: "harmony", n: C.HARMONY_IDS.length },
        { name: "hue pair", n: C.HUES.length },
        { name: "value pair", n: C.VALUE_PAIRS.length },
        { name: "proportions", n: "stochastic" }
      ];
    },
    _insects: I,
    /* Build every pose frame for one agent. The page swaps between these
       rather than transforming a single sprite, because transforming pixel
       art resamples it and destroys the grid. */
    frames: function (seed, size) {
      var probe = C.rng(seed);
      var speciesId = C.pick(probe, I.SPECIES_IDS);
      var m = I.MOTION[speciesId] || { frames: 1, hz: 1, order: [0] };
      var out = [];
      for (var f = 0; f < m.frames; f++) {
        /* Same seed for every frame: only the pose differs, so it stays the
           same individual moving rather than a different creature each
           step. */
        out.push(this.draw(seed, size, f));
      }
      return { svgs: out, motion: m, species: speciesId };
    },
    draw: function (seed, size, pose) {
      var r = C.rng(seed);
      var speciesId = C.pick(r, I.SPECIES_IDS);
      var h = C.harmony(r);
      var grid = I.build(r, speciesId, pose || 0);

      var mBody = C.material(h.body.hex);
      var mWing = C.material(h.wing.hex);

      var bodyHsl = C.hexToHsl(h.body.hex);
      var bandHex = C.hslToHex(bodyHsl.h, bodyHsl.s, Math.max(0.20, bodyHsl.l - 0.17));
      var legHex = C.hslToHex(bodyHsl.h, bodyHsl.s * 0.85, Math.max(0.26, bodyHsl.l - 0.10));
      var pupilHex = C.hslToHex(bodyHsl.h, Math.min(1, bodyHsl.s * 0.85), 0.16);
      var darkHex = C.hslToHex(bodyHsl.h, bodyHsl.s, 0.14);
      var markHex = C.hslToHex(C.hexToHsl(h.wing.hex).h, C.hexToHsl(h.wing.hex).s,
        Math.min(0.78, C.hexToHsl(h.wing.hex).l + 0.06));

      /* Cells are small: at 23 wide on a 100 unit viewBox the creature
         gets real detail without the sprite growing. */
      var cell = 3.7;
      var depth = cell * 0.30;
      var originX = 50 - (I.W * cell) / 2;
      var originY = 50 - (I.H * cell) / 2 + 1;

      /* The uid must include the POSE.

         Every pose frame of one agent shares a seed, so this used to emit
         the same gradient ids in all five frames. Duplicate ids in one
         document mean every url(#...) reference resolves to the FIRST
         match, which lives inside a frame that is display:none. A gradient
         in a hidden subtree paints nothing, so the flat cell faces lost
         their fill and only the top and side faces survived, since those
         carry literal hex colours. The creature rendered as a hollow
         outline and the body appeared to vanish mid-animation.

         It presented as most of the body disappearing during some of the
         animation, which is what a missing paint server looks like. */
      var uid = "vx" + (seed % 100000) + "p" + (pose || 0);

      var FILLS = {
        1: { flat: "url(#" + uid + "-g)", light: mBody.light, dark: mBody.dark },
        2: { flat: h.eyeHex, light: h.eyeHex, dark: C.darken(h.eyeHex, 0.26) },
        3: { flat: "url(#" + uid + "-w)", light: mWing.light, dark: mWing.dark },
        4: { flat: h.trimHex, light: C.withLightness(h.trimHex, 0.80), dark: C.withLightness(h.trimHex, 0.42) },
        5: { flat: bandHex, light: C.withLightness(bandHex, 0.50), dark: C.withLightness(bandHex, 0.20) },
        6: { flat: h.trimHex, light: C.withLightness(h.trimHex, 0.80), dark: C.withLightness(h.trimHex, 0.42) },
        7: { flat: legHex, light: C.withLightness(legHex, 0.50), dark: C.withLightness(legHex, 0.20) },
        8: { flat: pupilHex, light: C.withLightness(pupilHex, 0.28), dark: C.withLightness(pupilHex, 0.10) },
        9: { flat: darkHex, light: C.withLightness(darkHex, 0.26), dark: C.withLightness(darkHex, 0.09) },
        10: { flat: markHex, light: C.withLightness(markHex, 0.78), dark: C.withLightness(markHex, 0.40) }
      };

      var faces = [], tops = [], sides = [];

      for (var row = 0; row < I.H; row++) {
        for (var col = 0; col < I.W; col++) {
          var v = grid[row][col];
          if (!v) continue;
          var f = FILLS[v] || FILLS[1];
          var x = originX + col * cell;
          var y = originY + row * cell;

          if (row === 0 || !grid[row - 1][col]) {
            tops.push('<path d="M' + x + " " + y + " L" + (x + depth) + " " + (y - depth) +
              " L" + (x + cell + depth) + " " + (y - depth) + " L" + (x + cell) + " " + y +
              'Z" fill="' + f.light + '" opacity="0.95"/>');
          }
          if (col === I.W - 1 || !grid[row][col + 1]) {
            sides.push('<path d="M' + (x + cell) + " " + y + " L" + (x + cell + depth) + " " + (y - depth) +
              " L" + (x + cell + depth) + " " + (y + cell - depth) + " L" + (x + cell) + " " + (y + cell) +
              'Z" fill="' + f.dark + '"/>');
          }
          faces.push('<rect x="' + x + '" y="' + y + '" width="' + cell + '" height="' + cell +
            '" fill="' + f.flat + '"/>');
        }
      }

      var defs = "<defs>" + defsGrad(uid, mBody, 30, 20) +
        '<radialGradient id="' + uid + '-w" cx="30%" cy="20%" r="82%">' +
        '<stop offset="0" stop-color="' + mWing.light + '"/>' +
        '<stop offset="1" stop-color="' + mWing.dark + '"/></radialGradient></defs>';

      return svgWrap(size,
        contactShadow(originY + I.H * cell + 1, 20, 2.8, 0.28) +
        faces.join("") + tops.join("") + sides.join(""),
        defs,
        stableBox(null, speciesId, seed, cell, originX, originY, depth, cell * 1.2));
    }
  };

  global.FAFamilies = FAMILIES;
  global.FAFamilyIds = ["voxel", "sigil", "lantern", "filament", "carapace"];
})(typeof window !== "undefined" ? window : this);




/* ------------------------------------------------------------------ avatar

   The wireframe's contract for an avatar, kept exactly as it was.

   polish.js calls this for every [data-avatar] element, passing the DID and a
   pixel size. It used to reach FA.avatar; it now reaches this. The signature
   is unchanged so no caller had to learn anything new.

   The palette argument the old function took is deliberately NOT used.
   DESIGN.md section 2.4 states plainly that avatars are not from the agent
   palette: they are generated from the DID. The old implementation accepted a
   palette anyway and picked a hue from it by hash, which meant an avatar's
   colour came from a five-entry decoration list rather than from identity.
   Here the entire creature, colour included, is derived from the DID, so the
   rule holds by construction rather than by discipline.

   A pose argument is accepted for the animated case. Static avatars use pose
   0, which is the neutral rest stance and the same frame that shows under
   prefers-reduced-motion.
*/
(function (global) {
  "use strict";

  function avatar(did, size, pose) {
    var seed = global.FACore.hash(String(did));
    return global.FAFamilies.voxel.draw(seed, size || 48, pose || 0);
  }

  /* Every pose frame for one DID, for the animated case. Callers that want
     motion build these once and swap which is displayed, because these are
     pixel sprites: transforming one resamples it at a fractional offset and
     the crisp cell edges turn to mush. */
  function frames(did, size) {
    var seed = global.FACore.hash(String(did));
    return global.FAFamilies.voxel.frames(seed, size || 48);
  }

  function species(did) {
    var seed = global.FACore.hash(String(did));
    var r = global.FACore.rng(seed);
    return global.FACore.pick(r, global.FAInsects.SPECIES_IDS);
  }

  global.FASwarm = {
    avatar: avatar,
    frames: frames,
    species: species,
    SPECIES: global.FAInsects.SPECIES_IDS
  };
}(typeof window !== "undefined" ? window : this));
