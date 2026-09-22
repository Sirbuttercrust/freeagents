/* The flock as bots: the drawing underneath the landing page's flight.

   flight.js is 34KB of choreography (perches derived from live rects, layer
   swaps at a flight's midpoint, a fixed dust pool, an integrated bob phase,
   sub-pixel placement on a compositor layer). None of that is about what an
   agent LOOKS like; it is about where an agent IS. So this file keeps the
   entire FA surface flight.js and cast.js call and swaps only the drawing.
   flight.js is unchanged.

   It replaced swarm-flight.js, which drew the retired insect swarm. The bots
   are the same ones every other page draws (bots.js over the vendored
   bot-avatars core), so the landing page shows the agents the product
   actually has.

   WHAT EACH CALL NOW MEANS

     expression  surprise and pleased hop (the core's own poke); perk, rest
                 and focus leave the bot to its idle life. A bot has a face,
                 so a hovered one looks at the pointer instead of beating its
                 wings faster.
     gaze        flight.js hands in a yaw and pitch toward the pointer; the
                 core's own pointer follow turns the head and the eyes.
     shape       inert. A bot's shape is its look, and a perch does not
                 change it.
     glow        a soft radial behind the lead, sized from its own box.

   The bob, the sway, the bank into a turn and the poke spring are kept from
   the previous file, because they belong to the flight rather than to the
   drawing.

   REDUCED MOTION. flight.js already draws every agent parked at its perch
   with no loop. Here that means the still pose, drawn once per layout. */

(function (global) {
  "use strict";

  var B = global.FABots;
  if (!B) throw new Error("bot-flight requires bots.js to load first");

  var TAU = Math.PI * 2;

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

  /* Tolerates a null input. A throw here lands inside the shared frame loop
     and stops the whole page animating, so it must never throw. */
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

  var EXPRESSIONS = {
    rest:     { lean: 0.0,  scale: 1.000, hop: false },
    perk:     { lean: -4.0, scale: 1.030, hop: false },
    surprise: { lean: -7.0, scale: 1.055, hop: true },
    pleased:  { lean: -2.0, scale: 1.020, hop: true },
    focus:    { lean: 2.0,  scale: 0.985, hop: false }
  };

  var TEMPERAMENTS = {
    calm:    { wander: 0.85, bank: 0.9, track: 0.75, float: 1.00 },
    alert:   { wander: 1.25, bank: 1.3, track: 1.00, float: 1.10 },
    dozy:    { wander: 0.55, bank: 0.6, track: 0.55, float: 0.85 },
    curious: { wander: 1.05, bank: 1.1, track: 0.95, float: 1.05 },
    stoic:   { wander: 0.60, bank: 0.7, track: 0.65, float: 0.90 }
  };

  var REDUCED = B.reduced();

  /* Drawn at one size and scaled by a transform, so a size handover never
     resizes a backing store mid-flight. */
  var BUILD_PX = 128;
  var uidCounter = 0;

  function createAgent(opts) {
    opts = opts || {};
    var uid = "bf" + (++uidCounter);
    var spec = B.isValid(opts.spec) ? opts.spec : B.defaultAvatar(String(opts.seed == null ? uid : opts.seed));
    var temp = TEMPERAMENTS[opts.temperament] || TEMPERAMENTS.calm;
    var seed01 = (B.hash(uid + ":" + spec.shape) % 1000) / 1000;

    var host = document.createElement("div");
    host.style.position = "absolute";
    host.style.left = "0";
    host.style.top = "0";
    host.style.display = "block";
    host.style.width = BUILD_PX + "px";
    host.style.height = BUILD_PX + "px";
    host.style.willChange = "transform";
    host.setAttribute("aria-hidden", "true");

    var canvas = document.createElement("canvas");
    canvas.style.position = "absolute";
    canvas.style.left = "0";
    canvas.style.top = "0";
    canvas.style.width = BUILD_PX + "px";
    canvas.style.height = BUILD_PX + "px";
    host.appendChild(canvas);

    var s = {
      uid: uid,
      spec: spec,
      sim: REDUCED ? null : B.sim(seed01),
      canvas: canvas,
      size: opts.size || 96,
      sizeNow: null,
      temp: temp,
      tempId: opts.temperament || "calm",
      phase: seed01 * 100,
      expr: "rest",
      exprPrev: "rest",
      exprStart: -99,
      /* The bot's real body colour, published because flight.js tints its
         dust with it. */
      fill: B.COLOURS[spec.colour],
      glow: opts.glow || null,
      hover: false,
      nudgeX: 0, nudgeY: 0,
      nudgeVX: 0, nudgeVY: 0,
      bank: 0,
      bobPhase: null,
      world: { x: 0, y: 0, roll: 0, speed: 0, lift: 0, vx: 0, vy: 0 },
      out: { cx: 0, cy: 0, scale: 1 },
      svg: host,
      nodes: {}
    };
    if (s.sim) s.sim.setJump({ every: 0 });
    B.paintPose(canvas, BUILD_PX, spec, null);
    return s;
  }

  function sample(s, t, dt, aim) {
    var w = s.world;
    var temp = s.temp;
    var lift = clamp(w.lift, 0, 1);

    var et = clamp((t - s.exprStart) / 0.24, 0, 1);
    var eNow = EXPRESSIONS[s.expr] || EXPRESSIONS.rest;
    var ePrev = EXPRESSIONS[s.exprPrev] || EXPRESSIONS.rest;
    var k = ease.outQuint(et);
    var lean = lerp(ePrev.lean, eNow.lean, k);
    var escale = lerp(ePrev.scale, eNow.scale, k);

    var step = dt > 0 ? (dt > 0.05 ? 0.05 : dt) : 0;

    /* The bot itself: head, eyes, blinks, the hop. The pointer pull comes
       from the aim flight.js already computes. */
    if (s.sim) {
      if (aim && aim.engage > 0.01) {
        s.sim.setPointer(clamp((aim.yaw || 0) / 42, -1, 1), clamp(-(aim.pitch || 0) / 30, -1, 1),
          clamp(temp.track * aim.engage, 0, 1) * (1 - lift));
      } else {
        s.sim.setPointer(0, 0, 0);
      }
      s.sim.update(step);
      B.paintPose(s.canvas, BUILD_PX, s.spec, s.sim.pose);
    }

    /* BOB. Slow float when parked, a climb and settle in flight. Phase is
       integrated, never rebuilt from absolute time, so a frequency change
       never teleports the oscillator. */
    if (s.bobPhase == null) s.bobPhase = s.phase;
    var restFreq = 1 / (3.9 + (s.phase % 1));
    var freq = lerp(restFreq, restFreq * 4.6, lift);
    s.bobPhase += freq * TAU * step;
    var amp = lerp(7.5 * temp.float, 4.5 * temp.float, lift);
    var bob = Math.sin(s.bobPhase) * amp;
    var sway = Math.cos((t / (5.7 + (s.phase % 1.3))) * TAU + s.phase * 1.7) *
               3.4 * temp.float * (1 - lift * 0.7);

    /* BANK into a turn, eased so a change of direction never snaps. */
    var wantBank = clamp((w.vx || 0) * 0.030, -22, 22) * temp.bank + lean;
    s.bank += (wantBank - s.bank) * clamp(dt * 5.5, 0, 1);

    /* The poke spring: a nudge displaces the bot and it springs back. */
    if (s.nudgeX || s.nudgeY || s.nudgeVX || s.nudgeVY) {
      var kk = 170, damp = 15;
      s.nudgeVX += (-kk * s.nudgeX - damp * s.nudgeVX) * dt;
      s.nudgeVY += (-kk * s.nudgeY - damp * s.nudgeVY) * dt;
      s.nudgeX += s.nudgeVX * dt;
      s.nudgeY += s.nudgeVY * dt;
      if (Math.abs(s.nudgeX) < 0.01 && Math.abs(s.nudgeVX) < 0.01) { s.nudgeX = 0; s.nudgeVX = 0; }
      if (Math.abs(s.nudgeY) < 0.01 && Math.abs(s.nudgeVY) < 0.01) { s.nudgeY = 0; s.nudgeVY = 0; }
    }

    if (s.sizeNow == null) s.sizeNow = s.size;
    if (s.sizeNow !== s.size) {
      var kSize = dt > 0 ? Math.min(1, dt * 6) : 1;
      s.sizeNow += (s.size - s.sizeNow) * kSize;
      if (Math.abs(s.size - s.sizeNow) < 0.02) s.sizeNow = s.size;
    }

    var scale = (s.sizeNow / BUILD_PX) * escale;
    var half = BUILD_PX / 2;
    var cx = w.x + sway + s.nudgeX;
    var cy = w.y + bob + s.nudgeY;
    s.out.cx = cx;
    s.out.cy = cy;
    s.out.scale = scale;

    /* Sub-pixel placement on purpose: whole-pixel rounding turns a slow bob
       into a staircase of 1px pops. */
    s.svg.style.transform =
      "translate3d(" + r2(cx - half) + "px," + r2(cy - half) + "px,0) " +
      "rotate(" + r2((w.roll || 0) + s.bank) + "deg) " +
      "scale(" + r2(scale) + ")";
    s.svg.style.transformOrigin = half + "px " + half + "px";
    return { bob: bob, lift: lift, cx: cx, cy: cy };
  }

  function setExpression(s, id, t) {
    if (!EXPRESSIONS[id] || s.expr === id) return;
    s.exprPrev = s.expr;
    s.expr = id;
    s.exprStart = t == null ? 0 : t;
    if (EXPRESSIONS[id].hop && s.sim) s.sim.poke();
  }

  /* Inert on purpose: a bot's shape is its look, and a perch never changes
     it. Accepted so cast.js's perch table keeps working unedited. */
  function setShape() {}
  function setSize(s, px) { s.size = px; }
  function setFill() {}
  function setEye() {}

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

  global.FA = {
    createAgent: createAgent,
    sample: sample,
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
    SHAPES: B.SHAPES,
    TEMPERAMENTS: Object.keys(TEMPERAMENTS),
    EXPRESSIONS: Object.keys(EXPRESSIONS),
    REDUCED: REDUCED
  };
})(window);
