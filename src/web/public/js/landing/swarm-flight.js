/* The swarm as flying agents: a drop-in replacement for the blob engine.

   WHY A SHIM RATHER THAN A REWRITE OF flight.js

   flight.js is 34KB of choreography that took a long time to get right: perch
   trigger points derived from live rects rather than authored pixels, layer
   swaps at flight midpoint so an agent passes behind text, a fixed dust pool,
   an integrated bob phase (recomputing it from absolute time was the defect
   behind agents that jittered worse the longer the page was open), and
   sub-pixel placement on a compositor layer (whole-pixel rounding froze the
   bob into a staircase of 1px pops).

   None of that is about what an agent LOOKS like. It is about where an agent
   IS. So this file keeps the entire FA surface flight.js and cast.js call and
   swaps only the drawing underneath. Both of those files are unchanged.

   WHAT THE SPRITE CANNOT DO, AND WHAT REPLACES IT

   The blob engine drew a radial profile r(theta) sampled at 64 shared angles,
   which is what let any shape morph into any other by interpolating radii,
   and it painted eyes on a sphere with a tangent frame so they could aim at
   the cursor. A pixel sprite can do neither: interpolating a grid is not a
   morph, and a two-cell eye cannot rotate.

   Those capabilities are not lost so much as translated, because the sprite
   has expressive channels the blob did not:

     morph   -> the creature keeps its species, which is its identity, and
                changes SIZE and POSE. A species is a fingerprint. Morphing a
                dragonfly into a spider would break the one thing that makes
                these read as individuals.

     gaze    -> the whole body banks toward the pointer. Insects turn to face
                a thing rather than swivelling their eyes, so this is more
                truthful than the blob's version was, and it is visible from
                further away.

     expression -> wingbeat rate. A perked agent beats faster, a resting one
                slower, a focused one holds a tighter stroke. The idle already
                carries per-species rates, so expression scales them.

   WHAT MAKES THEM BEAUTIFUL RATHER THAN MERELY PRESENT

   Four things, each measurable:

     1. The wingbeat is tied to real motion. Climbing costs effort, so the
        beat accelerates on the way up and eases at the top of an arc. A
        constant beat reads as a looping gif pinned to a moving div.

     2. Banking. A creature turning through an arc rolls into it. The blob
        rolled by velocity too, but a sprite with wings shows it far more
        clearly, so the gain is higher and it eases rather than tracking
        instantaneously.

     3. A soft glow behind the lead, sized from its own bounding box rather
        than a constant, so it never becomes a halo bigger than the creature.

     4. Depth. A back-layer agent is dimmer, slightly smaller and slightly
        desaturated, which is atmospheric perspective and costs one filter.
*/

(function (global) {
  "use strict";

  var C = global.FACore;
  var I = global.FAInsects;
  var VOX = global.FAFamilies && global.FAFamilies.voxel;

  if (!C || !I || !VOX) {
    throw new Error("swarm-flight requires swarm.js to load first");
  }

  var TAU = Math.PI * 2;
  var uidCounter = 0;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function r2(n) { return Math.round(n * 100) / 100; }

  var ease = {
    outCubic: function (t) { return 1 - Math.pow(1 - t, 3); },
    inOutCubic: function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; },
    outQuint: function (t) { return 1 - Math.pow(1 - t, 5); },
    inOutQuint: function (t) { return t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2; },
    outBack: function (t) { var c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
  };

  /* Tolerates a null input.

     flight.js tints its dust with FA.mixHex(s.fill, "#FFFFFF", 0.6). Under the
     blob engine s.fill was always a hex because the cast assigned one per
     agent from the theme. A swarm creature derives its colour from its seed
     and setFill is inert, so s.fill was null and this threw inside the frame
     loop.

     That single throw stopped the ENTIRE PAGE animating, not just the dust:
     the exception unwound through the scroll module's runFrame before it
     could reschedule, so requestAnimationFrame was never called again. The
     symptom was five creatures frozen mid-flight with a live rAF elsewhere on
     the page, which is why it read as a rate or sampling problem for far too
     long. A crash inside a shared frame loop presents as a stall, not as an
     error, unless something is listening for it.

     Two fixes: this guard, and a real body colour published on s.fill so dust
     is tinted correctly rather than merely not crashing. */
  function mixHex(from, to, t) {
    if (!from || !to) return from || to || "#FFFFFF";
    function h2(x) { return parseInt(x, 16); }
    var a = String(from).replace("#", ""), b = String(to).replace("#", "");
    if (a.length !== 6 || b.length !== 6) return from;
    var out = "#";
    for (var i = 0; i < 3; i++) {
      var v = Math.round(lerp(h2(a.substr(i * 2, 2)), h2(b.substr(i * 2, 2)), t));
      out += ("0" + clamp(v, 0, 255).toString(16)).slice(-2);
    }
    return out;
  }

  /* Expression maps to how the creature FLIES, since a sprite has no face to
     rearrange. Beat scales the species idle rate; lean tilts the body. */
  var EXPRESSIONS = {
    rest:     { beat: 1.00, lean: 0.0,  scale: 1.000 },
    perk:     { beat: 1.55, lean: -4.0, scale: 1.030 },
    surprise: { beat: 1.90, lean: -7.0, scale: 1.055 },
    pleased:  { beat: 1.30, lean: -2.0, scale: 1.020 },
    focus:    { beat: 0.80, lean: 2.0,  scale: 0.985 }
  };

  /* Temperament survives because cast.js sets it per agent and it is real
     characterisation: how much an agent wanders when parked, how hard it
     banks, how much it commits to following the pointer. */
  var TEMPERAMENTS = {
    calm:    { wander: 0.85, bank: 0.9, track: 0.75, beat: 1.00, float: 1.00 },
    alert:   { wander: 1.25, bank: 1.3, track: 1.00, beat: 1.25, float: 1.10 },
    dozy:    { wander: 0.55, bank: 0.6, track: 0.55, beat: 0.75, float: 0.85 },
    curious: { wander: 1.05, bank: 1.1, track: 0.95, beat: 1.10, float: 1.05 },
    stoic:   { wander: 0.60, bank: 0.7, track: 0.65, beat: 0.85, float: 0.90 }
  };

  var REDUCED = global.matchMedia &&
    global.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* The harmony roll for a seed.

     Must consume the rng in the SAME ORDER voxel.draw does (species first,
     then harmony) or the colour reported here is not the colour drawn. */
  function harmonyOf(seed) {
    var r = C.rng(seed);
    C.pick(r, I.SPECIES_IDS);
    return C.harmony(r);
  }

  function createAgent(opts) {
    opts = opts || {};
    var uid = "sw" + (++uidCounter);
    var seed = opts.seed == null ? uidCounter * 7919 : opts.seed;
    var temp = TEMPERAMENTS[opts.temperament] || TEMPERAMENTS.calm;
    var rng = C.rng(seed);

    /* The DID picks the species. cast.js passes a numeric seed, so hash it
       into the same space the avatars use: one agent, one creature, forever. */
    var speciesId = C.pick(C.rng(seed), I.SPECIES_IDS);
    var motion = I.MOTION[speciesId] || { frames: 1, hz: 1, order: [0] };

    var host = document.createElement("div");
    host.style.position = "absolute";
    host.style.left = "0";
    host.style.top = "0";
    host.style.display = "block";
    host.style.willChange = "transform";
    host.setAttribute("aria-hidden", "true");

    var s = {
      uid: uid,
      seed: seed,
      species: speciesId,
      motion: motion,
      size: opts.size || 96,
      sizeNow: null,
      temp: temp,
      tempId: opts.temperament || "calm",
      phase: rng() * 100,

      /* Pose frames, built once. Swapping which is displayed is a style
         change; rebuilding markup every frame would be a re-parse per agent
         per frame. */
      frames: [],
      shown: -1,
      posePhase: 0,

      expr: "rest",
      exprPrev: "rest",
      exprStart: -99,

      /* The creature's REAL body colour, published for anything that needs to
         match it. flight.js tints dust with this, so a bee throws warm motes
         and a dragonfly cool ones instead of every agent shedding the same
         grey. It is read from the harmony roll rather than assigned, because
         colour here follows identity and is not a caller's to choose. */
      fill: harmonyOf(seed).body.hex,
      eye: opts.eye || null,
      glow: opts.glow || null,

      hover: false,
      nudgeX: 0, nudgeY: 0,
      nudgeVX: 0, nudgeVY: 0,

      bank: 0,
      bobPhase: null,

      /* Written by flight.js every frame. Untouched here beyond reading. */
      world: { x: 0, y: 0, roll: 0, speed: 0, lift: 0, vx: 0, vy: 0 },
      out: { cx: 0, cy: 0, scale: 1 },

      svg: host,
      nodes: {}
    };

    buildFrames(s);
    return s;
  }

  /* Build every pose once, stack them, show one.

     The size handed to draw() is fixed at build time and the visible scale
     comes from a transform, because rebuilding five SVG strings on every size
     handover would be the most expensive thing on the page. */
  var BUILD_PX = 128;

  function buildFrames(s) {
    var pack = VOX.frames(s.seed, BUILD_PX);
    s.svg.innerHTML = "";
    s.frames = [];

    pack.svgs.forEach(function (markup, i) {
      var holder = document.createElement("div");
      holder.style.position = "absolute";
      holder.style.left = "0";
      holder.style.top = "0";
      holder.style.width = BUILD_PX + "px";
      holder.style.height = BUILD_PX + "px";
      holder.style.display = i === 0 ? "block" : "none";
      holder.innerHTML = markup;
      s.svg.appendChild(holder);
      s.frames.push(holder);
    });

    s.shown = 0;
    s.svg.style.width = BUILD_PX + "px";
    s.svg.style.height = BUILD_PX + "px";
  }

  function showFrame(s, idx) {
    if (idx === s.shown || !s.frames.length) return;
    if (s.frames[s.shown]) s.frames[s.shown].style.display = "none";
    if (s.frames[idx]) s.frames[idx].style.display = "block";
    s.shown = idx;
  }

  /* ------------------------------------------------------------- the frame */

  function sample(s, t, dt, aim) {
    var w = s.world;
    var temp = s.temp;
    var lift = clamp(w.lift, 0, 1);

    /* Expression blends over 240ms, which is the middle duration DESIGN.md
       section 6 allows. */
    var et = clamp((t - s.exprStart) / 0.24, 0, 1);
    var eNow = EXPRESSIONS[s.expr] || EXPRESSIONS.rest;
    var ePrev = EXPRESSIONS[s.exprPrev] || EXPRESSIONS.rest;
    var k = ease.outQuint(et);
    var expr = {
      beat: lerp(ePrev.beat, eNow.beat, k),
      lean: lerp(ePrev.lean, eNow.lean, k),
      scale: lerp(ePrev.scale, eNow.scale, k)
    };

    /* WINGBEAT.

       Tied to real motion rather than run at a constant rate. A creature
       climbing is working, so the beat accelerates; at the top of an arc it
       eases. This is the single thing that separates a creature flying from
       a sprite being slid across a div.

       WHY THE BASE RATE IS LIFTED HERE.

       The species rates in swarm.js were tuned for a concept sheet, where a
       creature sits still on a pale card and is looked at directly. On a
       landing page it is small, moving, and competing with a video and a
       headline, so the same rate reads as a static image. AIR_GAIN lifts the
       whole cast into the range where a wingbeat registers in peripheral
       vision. The species RATIOS are untouched, so a wasp is still the quick
       one and a spider the slow one.

       A NOTE ON HOW THIS NUMBER WAS NEARLY SET FOR THE WRONG REASON.

       The flight gate first reported that no agent ever beat its wings. That
       was the GATE, not the engine: it polled from outside the page every
       220ms against a beat running at about 3.7 poses a second, so it aliased
       and read the same index every time. The engine was advancing phase 111
       times in 2 seconds throughout. The gate now records inside the page
       across real frames. The gain stays because it is right on its own
       merits, but it was very nearly a fix for a defect that did not exist,
       which is what measuring the measurement is for.

       Phase is INTEGRATED, never recomputed from absolute time. The frequency
       here depends on speed and lift, both of which change every frame, and
       rebuilding phase from t under a changing frequency teleports the
       oscillator. That exact defect cost a full session in the blob engine
       and the fix is recorded in agents.js: modulate the RATE at which phase
       advances, which is the standard way to change an oscillator's frequency
       without a click. */
    var AIR_GAIN = 3.4;

    var speed = Math.hypot(w.vx || 0, w.vy || 0);
    var climb = clamp(-(w.vy || 0) / 420, 0, 1);        /* up is negative y */
    var effort = clamp(speed / 700, 0, 1);

    var baseHz = s.motion.hz * temp.beat * expr.beat * AIR_GAIN;
    var hz = baseHz * (1 + effort * 1.5 + climb * 0.9);

    if (s.bobPhase == null) s.bobPhase = s.phase;
    var step = dt > 0 ? (dt > 0.05 ? 0.05 : dt) : 0;
    s.posePhase += hz * step;

    var order = s.motion.order || [0];
    var idx = order[Math.floor(s.posePhase) % order.length];
    if (REDUCED) idx = 0;
    showFrame(s, idx);

    /* BOB. Slow float when parked, a real climb-and-settle in flight. Same
       integration rule as the beat. */
    var restFreq = 1 / (3.9 + (s.phase % 1));
    var beatFreq = restFreq * 4.6 * temp.beat;
    var freq = lerp(restFreq, beatFreq, lift);
    s.bobPhase += freq * TAU * step;
    var amp = lerp(7.5 * temp.float, 4.5 * temp.float, lift);
    var bob = Math.sin(s.bobPhase) * amp;
    var sway = Math.cos((t / (5.7 + (s.phase % 1.3))) * TAU + s.phase * 1.7) *
               3.4 * temp.float * (1 - lift * 0.7);

    /* BANKING.

       A creature turning rolls into the turn. flight.js already computes a
       roll from velocity, but a winged sprite shows a bank far more clearly
       than a blob did, so this adds its own eased component on top rather
       than tracking velocity instantaneously. Easing is what keeps a
       direction change from snapping.

       When the pointer is being tracked the body also leans toward it, since
       an insect turns to face a thing rather than swivelling its eyes. That
       is the honest translation of the blob's gaze, and it reads from
       further away than eyes ever did. */
    var wantBank = clamp((w.vx || 0) * 0.030, -22, 22) * temp.bank;

    if (aim && aim.engage > 0.01 && lift < 0.5) {
      var dx = (aim.x || 0) - (s.out.cx || 0);
      var dy = (aim.y || 0) - (s.out.cy || 0);
      var d = Math.hypot(dx, dy);
      if (d > 1) {
        var faceT = clamp(temp.track * aim.engage, 0, 1) * (1 - lift);
        wantBank += clamp(dx / 26, -16, 16) * faceT;
      }
    }

    wantBank += expr.lean;
    s.bank += (wantBank - s.bank) * clamp(dt * 5.5, 0, 1);

    /* HOVER SPRING. Kept from the blob engine: a poke displaces the creature
       and it springs back, which is what makes it feel like an object rather
       than a picture. */
    if (s.nudgeX || s.nudgeY || s.nudgeVX || s.nudgeVY) {
      var kk = 170, damp = 15;
      s.nudgeVX += (-kk * s.nudgeX - damp * s.nudgeVX) * dt;
      s.nudgeVY += (-kk * s.nudgeY - damp * s.nudgeVY) * dt;
      s.nudgeX += s.nudgeVX * dt;
      s.nudgeY += s.nudgeVY * dt;
      if (Math.abs(s.nudgeX) < 0.01 && Math.abs(s.nudgeVX) < 0.01) { s.nudgeX = 0; s.nudgeVX = 0; }
      if (Math.abs(s.nudgeY) < 0.01 && Math.abs(s.nudgeVY) < 0.01) { s.nudgeY = 0; s.nudgeVY = 0; }
    }

    /* SIZE. Eased toward the perch target, same reasoning as the blob
       engine: an instant size change reads as a pop. Scale is a transform
       rather than a width attribute, so this costs nothing per frame. */
    if (s.sizeNow == null) s.sizeNow = s.size;
    if (s.sizeNow !== s.size) {
      var kSize = dt > 0 ? Math.min(1, dt * 6) : 1;
      s.sizeNow += (s.size - s.sizeNow) * kSize;
      if (Math.abs(s.size - s.sizeNow) < 0.02) s.sizeNow = s.size;
    }

    var scale = (s.sizeNow / BUILD_PX) * expr.scale;
    var half = s.sizeNow / 2;
    var cx = w.x + sway + s.nudgeX;
    var cy = w.y + bob + s.nudgeY;
    s.out.cx = cx;
    s.out.cy = cy;
    s.out.scale = scale;

    /* Sub-pixel placement, deliberately. Whole-pixel rounding converts a bob
       advancing 0.03px a frame into a staircase of freezes and 1px pops, and
       on a Retina display each pop is two device pixels. The compositor hint
       is set on the host element so this transforms a rasterised texture
       rather than forcing a re-raster. */
    s.svg.style.transform =
      "translate3d(" + r2(cx - half) + "px," + r2(cy - half) + "px,0) " +
      "rotate(" + r2((w.roll || 0) + s.bank) + "deg) " +
      "scale(" + r2(scale) + ")";
    s.svg.style.transformOrigin = half + "px " + half + "px";

    return { bob: bob, lift: lift, cx: cx, cy: cy };
  }

  /* ------------------------------------------------------------- setters */

  function setExpression(s, id, t) {
    if (!EXPRESSIONS[id] || s.expr === id) return;
    s.exprPrev = s.expr;
    s.expr = id;
    s.exprStart = t == null ? 0 : t;
  }

  /* Shape is a no-op on purpose.

     cast.js names a blob shape per perch (pebble, hex, shard). A species is
     this creature's identity: the same DID is the same creature everywhere,
     which is the whole contract the avatars hold to. Morphing a dragonfly
     into a spider mid-flight would break exactly that, so a perch changes
     size and expression and the creature stays itself. Accepting the call
     and ignoring it keeps cast.js working unedited. */
  function setShape() {}

  function setSize(s, px) { s.size = px; }

  /* Colour is derived from the seed, like everything else about a creature,
     so a theme switch does not restain it. Accepted for interface
     compatibility with cast.js and deliberately inert. */
  function setFill() {}
  function setEye() {}

  /* Glow is real: a soft radial behind the creature, sized from its own box
     so it can never become a halo larger than the thing it lights. */
  function setGlow(s, hex) {
    if (!hex) {
      if (s.nodes.glow) { s.nodes.glow.remove(); s.nodes.glow = null; }
      s.glow = null;
      return;
    }
    s.glow = hex;
    if (!s.nodes.glow) {
      var g = document.createElement("div");
      g.style.position = "absolute";
      g.style.left = "50%";
      g.style.top = "50%";
      g.style.width = BUILD_PX * 1.15 + "px";
      g.style.height = BUILD_PX * 1.15 + "px";
      g.style.transform = "translate(-50%,-50%)";
      g.style.borderRadius = "50%";
      g.style.pointerEvents = "none";
      g.style.zIndex = "-1";
      s.svg.insertBefore(g, s.svg.firstChild);
      s.nodes.glow = g;
    }
    s.nodes.glow.style.background =
      "radial-gradient(circle, " + hex + "38 0%, " + hex + "14 42%, transparent 70%)";
  }

  function avatar(did, size) {
    return VOX.draw(C.hash(String(did)), size || 48, 0);
  }

  global.FA = {
    createAgent: createAgent,
    sample: sample,
    avatar: avatar,
    setShape: setShape,
    setExpression: setExpression,
    setFill: setFill,
    setEye: setEye,
    setGlow: setGlow,
    setSize: setSize,
    setTemperament: function (s, id) {
      if (TEMPERAMENTS[id]) { s.temp = TEMPERAMENTS[id]; s.tempId = id; }
    },
    mixHex: mixHex,
    clamp: clamp,
    lerp: lerp,
    ease: ease,
    SHAPES: I.SPECIES_IDS,
    TEMPERAMENTS: Object.keys(TEMPERAMENTS),
    EXPRESSIONS: Object.keys(EXPRESSIONS),
    REDUCED: REDUCED
  };
}(typeof window !== "undefined" ? window : this));
