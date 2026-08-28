/* FreeAgents: the agent engine.
   Written 2026-08-19 for the v2 wireframe.

   WHERE THE TECHNIQUE COMES FROM, AND WHAT IS OURS
   The approach is bloub's (github.com/jeremy-prt/bloub, MIT, Jeremy Perret).
   Its README says the licence "covers the code in this repository, not the
   design it recreates", because bloub recreates x.ai's Grok avatar. So the
   ENGINE travelled and the LOOK is ours: our own shape catalogue, our own
   face proportions, our own temperaments, our own palette.

   The four ideas worth taking, and why v1 looked dead without them:

   1. A shape is a radial profile r(theta) sampled at the SAME 64 angles as
      every other shape. Any two shapes therefore have points corresponding
      one to one, so a morph is a linear interpolation of radii. No path
      morphing library, and shape becomes something you can change at
      runtime. v1 hardcoded four SVG path strings and could not morph at all.

   2. The outline is Catmull-Rom through those points, so it stays smooth at
      any size instead of being a fixed set of hand-written bezier handles.

   3. The eyes are painted on a SPHERE, not laid flat. Each eye takes the
      tangent frame of the sphere at its position, projected orthographically.
      The compression and tilt of the far eye fall out of the geometry, and
      that is what reads as volume. v1 translated two ellipses toward the
      cursor, which is the flat version and looks like it.

   4. The eyes are clipped by the silhouette, so they crop themselves at the
      edge with no cropping code. bloub uses a mask so the eyes are real
      holes; we use a clipPath, because a hole would show the hero VIDEO
      through the eyes.

   `sample()` is a pure function of (time, pointer, flight state). No internal
   clock, no accumulating state, so a frozen frame is reproducible and
   prefers-reduced-motion can render frame zero and stop.
*/

(function (global) {
  "use strict";

  /* ------------------------------------------------------------- math */

  var TAU = Math.PI * 2;
  var N = 64;                       // profile samples, shared by every shape
  var COS = [], SIN = [];
  for (var i = 0; i < N; i++) {
    var a0 = (i / N) * TAU;
    COS.push(Math.cos(a0));
    SIN.push(Math.sin(a0));
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function r2(v) { return Math.round(v * 100) / 100; }
  function deg(d) { return (d * Math.PI) / 180; }

  var ease = {
    outCubic:   function (t) { return 1 - Math.pow(1 - t, 3); },
    inOutCubic: function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; },
    outQuint:   function (t) { return 1 - Math.pow(1 - t, 5); },
    inOutQuint: function (t) { return t < 0.5 ? 16 * Math.pow(t, 5) : 1 - Math.pow(-2 * t + 2, 5) / 2; },
    outBack:    function (t) { var c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }
  };

  /* Periodic 1D noise. Loops seamlessly on `period`, which is what stops the
     resting drift ever landing on a repeat the eye can catch. */
  function loopNoise(t, period, seed) {
    var p = (t / period) * TAU;
    return 0.55 * Math.sin(p + seed) +
           0.30 * Math.sin(2 * p + seed * 1.7 + 1.1) +
           0.15 * Math.sin(3 * p + seed * 2.3 + 2.4);
  }

  /* mulberry32. Deterministic, so an agent always blinks the same way. */
  function createRng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ----------------------------------------------------------- profiles */

  /* Ray cast from a centre against a polygon. The escape hatch for shapes
     that do not express naturally as r(theta). Runs once at load, never in
     the render loop. */
  function profileFromPolygon(poly, cx, cy) {
    var out = new Array(N).fill(0);
    for (var k = 0; k < N; k++) {
      var dx = COS[k], dy = SIN[k], best = 0;
      for (var j = 0; j < poly.length; j++) {
        var p = poly[j], q = poly[(j + 1) % poly.length];
        var ex = q.x - p.x, ey = q.y - p.y;
        var den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-9) continue;
        var px = p.x - cx, py = p.y - cy;
        var t = (px * ey - py * ex) / den;   // distance along the ray
        var u = (px * dy - py * dx) / den;   // position along the edge
        if (t > best && u >= 0 && u <= 1) best = t;
      }
      out[k] = best;
    }
    return out;
  }

  /* Minkowski sum with a disc: every edge pushes out by rc, every vertex
     becomes an arc. Vertices go in at the target radius MINUS rc.
     Expects clockwise winding in screen space, y down. */
  function roundedPolygon(verts, rc, steps) {
    steps = steps || 10;
    var out = [], n = verts.length;
    function normal(p, q) {
      var dx = q.x - p.x, dy = q.y - p.y;
      var len = Math.hypot(dx, dy) || 1;
      return Math.atan2(-dx / len, dy / len);
    }
    for (var i = 0; i < n; i++) {
      var prev = verts[(i - 1 + n) % n], cur = verts[i], next = verts[(i + 1) % n];
      var a0 = normal(prev, cur), a1 = normal(cur, next);
      var d = a1 - a0;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      for (var k = 0; k <= steps; k++) {
        var ang = a0 + (d * k) / steps;
        out.push({ x: cur.x + Math.cos(ang) * rc, y: cur.y + Math.sin(ang) * rc });
      }
    }
    return out;
  }

  function regularPolygonProfile(sides, radius, rc, rotationDeg) {
    var rot = deg(rotationDeg || 0), verts = [];
    for (var i = 0; i < sides; i++) {
      var ang = rot + (i / sides) * TAU;
      verts.push({ x: Math.cos(ang) * (radius - rc), y: Math.sin(ang) * (radius - rc) });
    }
    return profileFromPolygon(roundedPolygon(verts, rc), 0, 0);
  }

  /* |x/sx|^n + |y/sy|^n = 1. n=2 is an ellipse, n around 4 is a squircle. */
  function superellipseProfile(n, sx, sy) {
    sx = sx || 1; sy = sy || 1;
    var out = new Array(N);
    for (var i = 0; i < N; i++) {
      var c = Math.pow(Math.abs(COS[i] / sx), n);
      var s = Math.pow(Math.abs(SIN[i] / sy), n);
      out[i] = Math.pow(c + s, -1 / n);
    }
    return out;
  }

  /* Radial profile of a UNION of discs: the furthest ray/circle hit. Exact
     while the origin sits inside the union. Gives lobes with no path
     booleans. */
  function unionOfCirclesProfile(circles) {
    var out = new Array(N).fill(0);
    for (var i = 0; i < N; i++) {
      var dx = COS[i], dy = SIN[i], best = 0;
      for (var j = 0; j < circles.length; j++) {
        var c = circles[j];
        var b = dx * c.x + dy * c.y;
        var disc = b * b - (c.x * c.x + c.y * c.y - c.r * c.r);
        if (disc < 0) continue;
        var t = b + Math.sqrt(disc);
        if (t > best) best = t;
      }
      out[i] = best;
    }
    return out;
  }

  /* Convex hull of two circles. Capsules and teardrops. */
  function hullOfCircles(x1, y1, r1, x2, y2, r2v, steps) {
    steps = steps || 96;
    var dx = x2 - x1, dy = y2 - y1;
    var dist = Math.hypot(dx, dy) || 1e-6;
    var base = Math.atan2(dy, dx);
    var spread = Math.acos(clamp((r1 - r2v) / dist, -1, 1));
    var pts = [], k;
    for (k = 0; k <= steps / 2; k++) {
      var a1 = base + spread + ((TAU - 2 * spread) * k) / (steps / 2);
      pts.push({ x: x1 + Math.cos(a1) * r1, y: y1 + Math.sin(a1) * r1 });
    }
    for (k = 0; k <= steps / 2; k++) {
      var a2 = base - spread + (2 * spread * k) / (steps / 2);
      pts.push({ x: x2 + Math.cos(a2) * r2v, y: y2 + Math.sin(a2) * r2v });
    }
    return pts;
  }

  /* Bring the peak radius to `max` so every shape carries the same visual
     weight. Without this the hexagon reads smaller than the orb. */
  function normalize(radii, max) {
    var peak = Math.max.apply(null, radii);
    if (peak <= 0) return radii;
    var k = (max || 1) / peak;
    return radii.map(function (r) { return r * k; });
  }

  /* --------------------------------------------------------- silhouettes
     Ours, built analytically. Deliberately NOT variations on a ball: a
     hexagon and a shard read as different creatures, and a page full of
     near-identical circles is what "no personality" looks like. */

  var pebble = normalize((function () {
    var out = new Array(N);
    for (var i = 0; i < N; i++) {
      var a = (i / N) * TAU;
      out[i] = 1 + 0.075 * Math.cos(2 * a + 0.5) + 0.035 * Math.cos(3 * a + 2.1);
    }
    return out;
  })(), 1.02);

  var cloud = normalize(unionOfCirclesProfile([
    { x: -0.44, y:  0.20, r: 0.54 },
    { x:  0.46, y:  0.20, r: 0.50 },
    { x:  0.02, y:  0.30, r: 0.60 },
    { x: -0.24, y: -0.30, r: 0.48 },
    { x:  0.30, y: -0.24, r: 0.44 }
  ]), 1.02);

  var drop = normalize(profileFromPolygon(hullOfCircles(0, 0.28, 0.66, 0, -0.96, 0.05), 0, 0), 1.04);
  var capsule = profileFromPolygon(hullOfCircles(-0.40, 0, 0.62, 0.40, 0, 0.62), 0, 0);

  var SHAPES = {
    orb:      new Array(N).fill(1),
    pebble:   pebble,
    squircle: normalize(superellipseProfile(4.2), 1.15),
    capsule:  capsule,
    hex:      regularPolygonProfile(6, 1.04, 0.26, 0),
    shard:    regularPolygonProfile(3, 1.12, 0.34, -90),
    wedge:    regularPolygonProfile(5, 1.06, 0.30, -90),
    cloud:    cloud,
    drop:     drop
  };
  var SHAPE_IDS = Object.keys(SHAPES);

  function blendRadii(a, b, t, out) {
    out = out || new Array(N);
    for (var i = 0; i < N; i++) out[i] = lerp(a[i], b[i], t);
    return out;
  }

  function radiusAtAngle(radii, angle) {
    var t = ((((angle / TAU) % 1) + 1) % 1) * N;
    var i = Math.floor(t);
    return lerp(radii[i % N], radii[(i + 1) % N], t - i);
  }

  function toPoints(radii, scale, sx, sy, out) {
    out = out || [];
    for (var i = 0; i < N; i++) {
      out[i] = { x: radii[i] * COS[i] * sx * scale, y: radii[i] * SIN[i] * sy * scale };
    }
    out.length = N;
    return out;
  }

  /* Closed polyline to cubic Catmull-Rom. At 64 points centred tangents are
     smooth to the pixel even at 600px. */
  function closedPath(pts, tension) {
    tension = tension || 1 / 6;
    var n = pts.length;
    if (n < 3) return "";
    var d = "M" + r2(pts[0].x) + " " + r2(pts[0].y);
    for (var i = 0; i < n; i++) {
      var p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      d += "C" + r2(p1.x + (p2.x - p0.x) * tension) + " " + r2(p1.y + (p2.y - p0.y) * tension) +
           " " + r2(p2.x - (p3.x - p1.x) * tension) + " " + r2(p2.y - (p3.y - p1.y) * tension) +
           " " + r2(p2.x) + " " + r2(p2.y);
    }
    return d + "Z";
  }

  /* Stadium centred on the origin. The exact eye outline. */
  function capsulePath(w, h) {
    var hw = Math.max(w, 0.01) / 2, hh = Math.max(h, 0.01) / 2;
    var r = Math.min(hw, hh);
    return "M" + r2(-hw) + " " + r2(-hh + r) +
      "A" + r2(r) + " " + r2(r) + " 0 0 1 " + r2(-hw + r) + " " + r2(-hh) +
      "L" + r2(hw - r) + " " + r2(-hh) +
      "A" + r2(r) + " " + r2(r) + " 0 0 1 " + r2(hw) + " " + r2(-hh + r) +
      "L" + r2(hw) + " " + r2(hh - r) +
      "A" + r2(r) + " " + r2(r) + " 0 0 1 " + r2(hw - r) + " " + r2(hh) +
      "L" + r2(-hw + r) + " " + r2(hh) +
      "A" + r2(r) + " " + r2(r) + " 0 0 1 " + r2(-hw) + " " + r2(hh - r) + "Z";
  }

  /* ---------------------------------------------------------------- face
     Screen frame: x right, y down, z toward the viewer.
     Index 0 is the inner eye, index 1 the outer one. */

  function spin(u, v, angle) {
    var c = Math.cos(angle), s = Math.sin(angle);
    return [
      [u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s],
      [v[0] * c - u[0] * s, v[1] * c - u[1] * s, v[2] * c - u[2] * s]
    ];
  }

  function eyePoses(gaze, split) {
    var f = [0, 0, 1], right = [1, 0, 0], down = [0, 1, 0], p;
    p = spin(f, right, deg(gaze.yaw));     f = p[0]; right = p[1];
    p = spin(down, f, deg(gaze.pitch));    down = p[0]; f = p[1];
    p = spin(right, down, deg(gaze.roll)); right = p[0]; down = p[1];

    function build(side) {
      var q = spin(f, right, deg(split * side));
      var ef = q[0], er = q[1];
      return { x: ef[0], y: ef[1], a: er[0], b: er[1], c: down[0], d: down[1], depth: ef[2] };
    }
    return [build(-1), build(1)];
  }

  /* A blink is a VERTICAL squash in screen space around the eye centre, not
     a shrink along the capsule's tilted axis. Composed after the tangent
     matrix, touching only the y outputs. */
  function blinkScale(lid) { return 0.06 + 0.94 * clamp(lid, 0, 1); }

  /* --------------------------------------------------------------- eyefit

     THE PROBLEM
     The eyes live on a sphere of radius 1. On a shape that is NOT a circle
     they leave the silhouette and the clip cuts them: the teardrop is narrow
     at the top, the shard has slanted edges, and an eye placed at 0.62 of
     the radius sits outside an outline whose real edge is at 0.45 in that
     direction. Following the real radius (`radiusAtAngle`) places the eye's
     CENTRE correctly and is not enough, because the eye has a size and the
     margin in front of the edge scales down with the same pro rata.

     THE FIX, AND WHY IT IS A TABLE
     A common offset is added to BOTH eyes. A translation is an isometry, so
     spacing, sizes and tilts survive to the pixel: the face just sits a
     little lower on a body with no room up there, which is the adjustment a
     person would make by hand.

     It is solved ONCE at import, per (shape, temperament, expression), and
     merely looked up at runtime. bloub's architecture notes are emphatic
     about this and worth heeding: seven versions solved it inside the render
     loop and every one produced a visible artefact, because everything the
     solver reads moves at sixty frames per second. The failure modes have
     names: an ACTIVE SET CHANGE when the nearest edge switches, a
     NON-SMOOTH OBJECTIVE because `min` is C0 but not C1, and CHATTERING from
     a per-frame feedback loop. The defect was never in the geometry, it was
     in solving per frame.

     Because it does not run during the animation, the solver has no
     continuity requirement at all: it can sweep the whole gaze-drift range
     and take the worst case, which a per-frame version could not afford.

     What NOT to try, each measured and each broken:
       per-eye bounds      the two eyes aim differently, so the pair spreads
                           and a distorted face reads worse than the clipping
       radial retreat      travels a long diagonal for a little vertical room
                           and drags both eyes into the middle
       scaling the face    stable, but the eyes visibly shrink on a flat body
       worst of two eyes   `min` is a discrete choice, so the binding eye
                           changes and the push direction flips with it
  */

  var EYE_OUTLINE = 14;          // sample points around the eye capsule

  /* Sample the eye outline in body space, given a tangent frame. */
  function eyeSamples(w, h, p, tilt, offX, offY, out) {
    var hw = w / 2, hh = h / 2, r = Math.min(hw, hh);
    var ct = Math.cos(tilt), st = Math.sin(tilt);
    var a = p.a * ct + p.c * st, b = p.b * ct + p.d * st;
    var c = p.c * ct - p.a * st, d = p.d * ct - p.b * st;
    out = out || [];
    for (var i = 0; i < EYE_OUTLINE; i++) {
      var ang = (i / EYE_OUTLINE) * TAU;
      /* Point on the stadium outline: a rectangle of half extents
         (hw-r, hh-r) inflated by r. */
      var lx = clamp(Math.cos(ang) * hw, -(hw - r), hw - r) + Math.cos(ang) * r;
      var ly = clamp(Math.sin(ang) * hh, -(hh - r), hh - r) + Math.sin(ang) * r;
      out[i] = {
        x: a * lx + c * ly + p.x + offX,
        y: b * lx + d * ly + p.y + offY
      };
    }
    out.length = EYE_OUTLINE;
    return out;
  }

  /* How far outside the outline the worst point sits, in ball-radius units.
     Negative means clearance. */
  function overflow(radii, poses, w, h, tilt, offX, offY) {
    var worst = -9;
    for (var e = 0; e < 2; e++) {
      var p = poses[e];
      if (p.depth <= 0.02) continue;
      var pro = radiusAtAngle(radii, Math.atan2(p.y, p.x));
      /* The eye centre already follows the real radius, so the pose is
         pre-scaled the same way the renderer does it. */
      var scaled = { x: p.x * pro, y: p.y * pro, a: p.a, b: p.b, c: p.c, d: p.d, depth: p.depth };
      var pts = eyeSamples(w, h, scaled, tilt * (e === 0 ? 1 : -1), offX, offY);
      for (var i = 0; i < pts.length; i++) {
        var q = pts[i];
        var rad = Math.hypot(q.x, q.y);
        var edge = radiusAtAngle(radii, Math.atan2(q.y, q.x));
        var d = rad - edge;
        if (d > worst) worst = d;
      }
    }
    return worst;
  }

  /* The gaze range the solver has to cover: resting orientation plus the
     full amplitude of the drift, which is what carried an eye over the edge
     in bloub's own testing when only one instant was sampled. */
  function gazeCorners(temp, expr) {
    var out = [];
    var dy = 7.1 * temp.wander, dp = 5.5 * temp.wander, dr = 2.2 * temp.wander;
    for (var i = -1; i <= 1; i++) {
      for (var j = -1; j <= 1; j++) {
        out.push({
          yaw: temp.yaw + dy * i,
          pitch: temp.pitch + expr.pitch + dp * j,
          roll: temp.roll + dr * (i === j ? 1 : -1)
        });
      }
    }
    return out;
  }

  /* Solve one combination. Grid search, coarse then fine: the objective is
     not smooth, so a gradient method is the wrong tool and the search space
     is two dimensional and tiny. */
  function solveOffset(radii, temp, expr) {
    var w = temp.eyeW * expr.w, h = temp.eyeH * expr.h;
    var tilt = deg(expr.tilt);
    var split = 15.0 * expr.split;
    var gazes = gazeCorners(temp, expr);
    var poseSets = gazes.map(function (g) { return eyePoses(g, split); });

    /* The margin to aim for is the one a CIRCLE gives, not clearance. On a
       circle the outer eye already grazes the edge and that is deliberate,
       it is what gives the volume. Aiming for clearance leaves the eye
       exactly tangent, which shows. */
    var circle = new Array(N).fill(1);
    var target = -9;
    for (var g = 0; g < poseSets.length; g++) {
      var v = overflow(circle, poseSets[g], w, h, tilt, 0, 0);
      if (v > target) target = v;
    }

    function score(ox, oy) {
      var worst = -9;
      for (var k = 0; k < poseSets.length; k++) {
        var v = overflow(radii, poseSets[k], w, h, tilt, ox, oy);
        if (v > worst) worst = v;
      }
      /* Beyond the circle's own margin there is nothing left to win, so stop
         rewarding further retreat and start penalising displacement. That is
         what keeps the face where it was drawn on shapes that never had a
         problem. */
      return Math.max(worst - target, 0) * 100 + Math.hypot(ox, oy);
    }

    var best = { ox: 0, oy: 0, s: score(0, 0) };
    if (best.s <= 0.0001) return { x: 0, y: 0 };

    var span = 0.42, steps = 8;
    for (var pass = 0; pass < 3; pass++) {
      var cx = best.ox, cy = best.oy, found = best;
      for (var i = -steps; i <= steps; i++) {
        for (var j = -steps; j <= steps; j++) {
          var ox = cx + (i / steps) * span;
          var oy = cy + (j / steps) * span;
          var s = score(ox, oy);
          if (s < found.s) found = { ox: ox, oy: oy, s: s };
        }
      }
      best = found;
      span *= 0.35;
    }
    return { x: best.ox, y: best.oy };
  }

  /* The table itself. Built at import from pure data, the same nature as the
     pre-drawn blink schedule: deterministic and stateless, so sample() stays
     a pure function of time. */
  var EYEFIT = {};
  function eyefitKey(shape, tempId, exprId) { return shape + "|" + tempId + "|" + exprId; }

  function buildEyefit() {
    var shapes = Object.keys(SHAPES);
    var temps = Object.keys(TEMPERAMENTS);
    var exprs = Object.keys(EXPRESSIONS);
    for (var a = 0; a < shapes.length; a++) {
      for (var b = 0; b < temps.length; b++) {
        for (var c = 0; c < exprs.length; c++) {
          EYEFIT[eyefitKey(shapes[a], temps[b], exprs[c])] =
            solveOffset(SHAPES[shapes[a]], TEMPERAMENTS[temps[b]], EXPRESSIONS[exprs[c]]);
        }
      }
    }
  }

  function eyefit(shape, tempId, exprId) {
    return EYEFIT[eyefitKey(shape, tempId, exprId)] || { x: 0, y: 0 };
  }

  /* -------------------------------------------------------- temperaments
     Personality lives HERE, not in the colour. Each is a set of constants
     for the resting life: how far the gaze wanders, how often it blinks, how
     much the body floats, how eagerly it tracks the pointer. v1 gave every
     blob the same sine wave, which is exactly why they read as having no
     personality.

     `yaw` and `pitch` are the RESTING head orientation, and they are the
     single biggest thing separating a face from a colon. Eyes at dead centre
     read as blank; a head turned off axis reads as attentive, because the
     sphere projection then compresses the far eye and the pair gains depth.
     bloub's measured rest is yaw 28.5, pitch 28.6, roll -13, and it is worth
     that much. Ours vary per temperament so five agents in a row are not
     five copies of one stare.

     eyeH is deliberately larger than eyeW: a tall capsule reads as an eye, a
     round one reads as a dot, and the expression tilt is invisible on a
     circle. */

  var TEMPERAMENTS = {
    calm:    { wander: 0.75, blinkGap: [3.4, 2.6], float: 0.95, bob: 5.0, track: 0.85, eyeW: 0.20, eyeH: 0.40, yaw:  24, pitch: 24, roll:  -11, beat: 1.00 },
    alert:   { wander: 1.50, blinkGap: [1.6, 1.6], float: 0.60, bob: 3.2, track: 1.00, eyeW: 0.19, eyeH: 0.46, yaw:  30, pitch: 30, roll:  -14, beat: 1.35 },
    dozy:    { wander: 0.50, blinkGap: [4.6, 3.4], float: 1.25, bob: 7.5, track: 0.55, eyeW: 0.23, eyeH: 0.26, yaw:  19, pitch: 15, roll:   -7, beat: 0.72 },
    curious: { wander: 1.15, blinkGap: [2.4, 2.2], float: 1.05, bob: 5.8, track: 0.95, eyeW: 0.19, eyeH: 0.44, yaw: -26, pitch: 27, roll:   12, beat: 1.15 },
    stoic:   { wander: 0.35, blinkGap: [5.2, 3.0], float: 0.70, bob: 3.8, track: 0.70, eyeW: 0.22, eyeH: 0.34, yaw:  16, pitch: 20, roll:   -5, beat: 0.88 }
  };
  var TEMPERAMENT_IDS = Object.keys(TEMPERAMENTS);

  /* --------------------------------------------------------- expressions
     Multipliers on the temperament's resting eye, plus a pitch bias and a
     body scale. Kept as multipliers so a dozy agent stays recognisably
     dozy when it is surprised: the expression modulates a personality
     rather than replacing it.

     `tilt` is applied mirrored on the two eyes. It is only legible on an
     elongated eye, so the round expressions leave it at zero. */

  var EXPRESSIONS = {
    rest:     { w: 1.00, h: 1.00, tilt:  0, pitch:  0, scale: 1.00, split: 1.00 },
    perk:     { w: 1.02, h: 1.30, tilt:  0, pitch:  5, scale: 1.05, split: 1.02 },
    surprise: { w: 1.24, h: 1.42, tilt:  0, pitch:  8, scale: 1.09, split: 1.05 },
    pleased:  { w: 1.10, h: 0.40, tilt: 11, pitch: -2, scale: 1.03, split: 1.00 },
    focus:    { w: 0.88, h: 0.78, tilt: -7, pitch:  3, scale: 0.99, split: 0.97 }
  };
  var EXPR_DUR = 0.26;

  function blendExpr(a, b, t) {
    return {
      w:     lerp(a.w, b.w, t),
      h:     lerp(a.h, b.h, t),
      tilt:  lerp(a.tilt, b.tilt, t),
      pitch: lerp(a.pitch, b.pitch, t),
      scale: lerp(a.scale, b.scale, t),
      split: lerp(a.split, b.split, t)
    };
  }

  /* Pre-drawn blink schedule. Deterministic and stateless, so sample(t)
     stays a pure function of time. */
  function blinkSchedule(seed, gap) {
    var rng = createRng(seed), out = [], t = 0.6 + rng() * 2;
    while (t < 900) {
      out.push(t);
      t += gap[0] + rng() * gap[1];
      if (rng() < 0.16) { out.push(t); t += 0.24; }   // occasional double blink
    }
    return out;
  }

  var BLINK_DUR = 0.18;

  function blinkLid(schedule, t) {
    for (var i = 0; i < schedule.length; i++) {
      var start = schedule[i];
      if (t < start) break;
      var k = (t - start) / BLINK_DUR;
      if (k >= 0 && k <= 1) return k < 0.45 ? 1 - k / 0.45 : (k - 0.45) / 0.55;
    }
    return 1;
  }

  /* -------------------------------------------------------------- colour */

  function hexToRgb(h) {
    h = String(h).trim().replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var v = parseInt(h, 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  function rgbToHex(c) {
    return "#" + c.map(function (x) {
      return clamp(Math.round(x), 0, 255).toString(16).padStart(2, "0");
    }).join("");
  }
  function mixHex(from, to, t) {
    var a = hexToRgb(from), b = hexToRgb(to);
    return rgbToHex([lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]);
  }
  function relLum(hex) {
    var c = hexToRgb(hex).map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  /* ------------------------------------------------------------- agents */

  var SVG_NS = "http://www.w3.org/2000/svg";
  var VB = 100;      // viewBox half extent
  var BALL = 62;     // ball radius inside the viewBox, leaves room to float
  var uidCounter = 0;

  function el(name, attrs) {
    var node = document.createElementNS(SVG_NS, name);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) node.setAttribute(k, attrs[k]);
    return node;
  }

  /**
   * Build one agent. Returns a state object; the caller owns where it lives
   * in the DOM and, if it is flying, what its world position is.
   *
   * opts:
   *   shape        id from SHAPES
   *   fill         hex body colour
   *   eye          hex eye colour, defaults to a darkened body
   *   size         px
   *   temperament  id from TEMPERAMENTS
   *   seed         integer, drives blinks and drift phase
   *   glow         hex, adds a soft halo. The accent agent only
   */
  function createAgent(opts) {
    opts = opts || {};
    var uid = "fa" + (++uidCounter);
    var temp = TEMPERAMENTS[opts.temperament] || TEMPERAMENTS.calm;
    var seed = opts.seed == null ? uidCounter * 7919 : opts.seed;
    var rng = createRng(seed);

    var s = {
      uid: uid,
      size: opts.size || 96,
      temp: temp,
      tempId: opts.temperament || "calm",
      seed: seed,
      phase: rng() * 100,
      shape: opts.shape || "pebble",
      prevShape: opts.shape || "pebble",
      morphStart: -99,
      morphDur: 0.8,
      blinks: blinkSchedule(seed, temp.blinkGap),
      fill: opts.fill || "#2E3238",
      eye: opts.eye || null,
      glow: opts.glow || null,
      expr: "rest",
      exprPrev: "rest",
      exprStart: -99,
      hover: false,
      hoverAt: -99,
      nudgeX: 0, nudgeY: 0,     // spring offset from a hover poke
      nudgeVX: 0, nudgeVY: 0,
      radii: new Array(N),
      pts: [],
      /* Written by the flock each frame. The engine only ADDS its own life
         on top, so choreography and personality never fight for the same
         property. */
      world: { x: 0, y: 0, roll: 0, speed: 0, lift: 0 },
      out: { cx: 0, cy: 0, scale: 1 }
    };

    var svg = el("svg", {
      viewBox: -VB + " " + -VB + " " + VB * 2 + " " + VB * 2,
      width: s.size, height: s.size,
      "aria-hidden": "true"
    });
    svg.style.overflow = "visible";
    svg.style.display = "block";
    svg.style.position = "absolute";
    svg.style.left = "0";
    svg.style.top = "0";
    svg.style.willChange = "transform";

    var defs = el("defs");

    var clip = el("clipPath", { id: uid + "-clip" });
    var clipPath = el("path", {});
    clip.appendChild(clipPath);
    defs.appendChild(clip);

    /* One soft radial gradient. A flat fill on a dark page reads as a
       sticker; a single light source reads as an object. Two stops only. */
    var grad = el("radialGradient", { id: uid + "-g", cx: "34%", cy: "24%", r: "80%" });
    var stopA = el("stop", { offset: "0" });
    var stopB = el("stop", { offset: "1" });
    grad.appendChild(stopA); grad.appendChild(stopB);
    defs.appendChild(grad);
    svg.appendChild(defs);

    var halo = null;
    if (s.glow) {
      var filt = el("filter", { id: uid + "-blur", x: "-70%", y: "-70%", width: "240%", height: "240%" });
      filt.appendChild(el("feGaussianBlur", { stdDeviation: "12" }));
      defs.appendChild(filt);
      halo = el("path", { filter: "url(#" + uid + "-blur)", opacity: "0.45" });
      svg.appendChild(halo);
    }

    /* Contact shadow. Sells the landing: a soft ellipse under the body that
       tightens and darkens as the agent settles, and washes out in flight. */
    var shadow = el("ellipse", { cx: 0, rx: 40, ry: 7, fill: "#000", opacity: "0" });
    svg.appendChild(shadow);

    var body = el("path", { fill: "url(#" + uid + "-g)" });
    svg.appendChild(body);

    /* Rim light along the lit edge, clipped to the body. This is what stops
       a dark agent dissolving into a dark page. */
    var rimGroup = el("g", { "clip-path": "url(#" + uid + "-clip)" });
    var rim = el("path", { fill: "none", "stroke-width": "2.6" });
    rimGroup.appendChild(rim);
    svg.appendChild(rimGroup);

    var eyeGroup = el("g", { "clip-path": "url(#" + uid + "-clip)" });
    var eyes = [el("path", {}), el("path", {})];
    eyeGroup.appendChild(eyes[0]);
    eyeGroup.appendChild(eyes[1]);
    svg.appendChild(eyeGroup);

    /* NO HOVER RING. Removed 2026-08-19 on the operator's word: "all I should see
       is the little blob... There should be no circle around them." The
       reaction is carried by the expression change, the recoil and the dust
       burst, which are things the character DOES rather than a chrome
       annotation drawn around it. */

    s.svg = svg;
    s.nodes = {
      clipPath: clipPath, body: body, rim: rim, eyes: eyes,
      halo: halo, shadow: shadow, stopA: stopA, stopB: stopB
    };

    applyColour(s);
    return s;
  }

  function applyColour(s) {
    var base = s.fill;
    var light = mixHex(base, "#FFFFFF", relLum(base) < 0.18 ? 0.22 : 0.14);
    var dark = mixHex(base, "#000000", 0.32);
    s.nodes.stopA.setAttribute("stop-color", light);
    s.nodes.stopB.setAttribute("stop-color", dark);
    s.nodes.rim.setAttribute("stroke", mixHex(base, "#FFFFFF", 0.45));
    s.nodes.rim.setAttribute("opacity", "0.5");
    var eyeColour = s.eye || mixHex(base, "#000000", 0.74);
    s.nodes.eyes[0].setAttribute("fill", eyeColour);
    s.nodes.eyes[1].setAttribute("fill", eyeColour);
    if (s.nodes.halo) s.nodes.halo.setAttribute("fill", s.glow);
  }

  function setExpression(s, id, t) {
    if (!EXPRESSIONS[id] || id === s.expr) return;
    s.exprPrev = s.expr;
    s.expr = id;
    s.exprStart = t;
  }

  function setShape(s, id, t) {
    if (!SHAPES[id] || id === s.shape) return;
    s.prevShape = s.shape;
    s.shape = id;
    s.morphStart = t;
  }

  function setFill(s, hex) { s.fill = hex; applyColour(s); }
  function setEye(s, hex) { s.eye = hex; applyColour(s); }
  function setGlow(s, hex) {
    s.glow = hex;
    if (s.nodes.halo) s.nodes.halo.setAttribute("fill", hex);
  }
  function setTemperament(s, id) {
    if (!TEMPERAMENTS[id]) return;
    s.temp = TEMPERAMENTS[id];
    s.tempId = id;
    s.blinks = blinkSchedule(s.seed, s.temp.blinkGap);
  }
  function setSize(s, px) {
    s.size = px;
    s.svg.setAttribute("width", px);
    s.svg.setAttribute("height", px);
  }

  /* --------------------------------------------------------------- frame
     One frame of an agent.

     `world` is what the flock decided: position, roll from banking, speed in
     px/s, and lift (0 landed, 1 in flight). The engine adds the personality:
     idle bob, wing beat, gaze, blink, expression, squash.

     dt is passed only for the hover spring, which is the one genuinely
     stateful thing here and is deliberately fenced to two variables. */
  function sample(s, t, dt, aim) {
    var temp = s.temp;
    var w = s.world;

    /* Shape morph. Radii interpolate because every profile shares the same
       angular sampling, which is the entire point of the technique. */
    var mt = clamp((t - s.morphStart) / s.morphDur, 0, 1);
    var radii = mt >= 1
      ? (SHAPES[s.shape] || SHAPES.orb)
      : blendRadii(SHAPES[s.prevShape] || SHAPES.orb, SHAPES[s.shape] || SHAPES.orb, ease.outQuint(mt), s.radii);

    /* Expression blend. */
    var et = clamp((t - s.exprStart) / EXPR_DUR, 0, 1);
    var expr = et >= 1
      ? EXPRESSIONS[s.expr]
      : blendExpr(EXPRESSIONS[s.exprPrev], EXPRESSIONS[s.expr], ease.outQuint(et));

    /* Resting life. Coprime periods so the drift never visibly repeats, and
       a per-agent phase so a group never marches in step. */
    var ph = s.phase;
    var dYaw   = (loopNoise(t, 11.3, ph + 0.4) * 5.5 + loopNoise(t, 3.7, ph + 2.1) * 1.6) * temp.wander;
    var dPitch = (loopNoise(t, 9.1, ph + 1.3) * 4.2 + loopNoise(t, 4.3, ph + 0.7) * 1.3) * temp.wander;
    var dRoll  = loopNoise(t, 13.7, ph + 3.2) * 2.2 * temp.wander;
    var lid    = blinkLid(s.blinks, t + ph);

    /* Bob. Landed it is a slow float; in flight it becomes a wing beat,
       faster and with more amplitude. Blending the two by `lift` is what
       makes takeoff read as effort rather than as a slide. */
    var lift = clamp(w.lift, 0, 1);
    var restFreq = 1 / (3.9 + (ph % 1));
    var beatFreq = restFreq * (4.6 * temp.beat);
    var freq = lerp(restFreq, beatFreq, lift);
    var amp = lerp(temp.bob * temp.float, temp.bob * 0.62 * temp.float, lift);
    var bobPhase = (t * freq) * TAU + ph;
    var bob = Math.sin(bobPhase) * amp;
    var sway = Math.cos((t / (5.7 + (ph % 1.3))) * TAU + ph * 1.7) * temp.bob * 0.5 * temp.float * (1 - lift * 0.7);

    /* Squash and stretch from vertical velocity. Small, but it is the
       difference between floating and sliding. */
    var vy = Math.cos(bobPhase);
    var stretch = vy * (0.02 + 0.045 * lift);
    var breath = 1 + Math.sin((t / 3.4) * TAU + ph) * 0.012 * temp.float;

    /* Hover spring. A poke away from the cursor that settles back. Critically
       damped enough not to wobble, loose enough to be felt. */
    if (dt > 0) {
      var k = 190, damp = 17;
      s.nudgeVX += (-k * s.nudgeX - damp * s.nudgeVX) * dt;
      s.nudgeVY += (-k * s.nudgeY - damp * s.nudgeVY) * dt;
      s.nudgeX += s.nudgeVX * dt;
      s.nudgeY += s.nudgeVY * dt;
    }

    /* Gaze. Absolute angles, so a change of expression never makes the eyes
       jump. The resting orientation belongs to the temperament, and pointer
       tracking DISPLACES it rather than replacing it: an agent turns toward
       you from where its head already was. In flight it looks where it is
       going instead. */
    var track = aim.known ? temp.track : 0;
    var flightYaw = clamp(w.vx * 0.05, -26, 26);
    var yaw = temp.yaw + dYaw + lerp(aim.nx * 20 * track, flightYaw - temp.yaw, lift);
    var pitch = temp.pitch + expr.pitch + dPitch - aim.ny * 15 * track * (1 - lift);
    var roll = temp.roll + dRoll;

    var sx = (1 - stretch) * expr.scale;
    var sy = (1 + stretch) * breath * expr.scale;

    var pts = toPoints(radii, BALL, sx, sy, s.pts);
    var d = closedPath(pts);

    s.nodes.body.setAttribute("d", d);
    s.nodes.clipPath.setAttribute("d", d);
    s.nodes.rim.setAttribute("d", d);
    if (s.nodes.halo) s.nodes.halo.setAttribute("d", d);

    /* Contact shadow: tight and visible when landed, gone in flight. */
    var shadowOp = (1 - lift) * 0.34;
    s.nodes.shadow.setAttribute("opacity", r2(shadowOp));
    s.nodes.shadow.setAttribute("cy", r2(BALL + 16 + bob * 0.25));
    s.nodes.shadow.setAttribute("rx", r2(BALL * 0.62 * (1 - bob / 200)));
    s.nodes.shadow.setAttribute("ry", r2(6.5 * (1 - bob / 260)));

    /* Eyes on the sphere. The tangent frame gives the far eye its
       compression and tilt for free. */
    var poses = eyePoses({ yaw: yaw, pitch: pitch, roll: roll }, 15.0 * expr.split);
    var blink = blinkScale(lid);

    /* Eyefit offset, read on the BOUNDARIES of each morph and interpolated
       with that morph's own easing. Never on the interpolated value: during
       a shape morph the radii are a fresh array with no identity and the
       blended expression carries no id, so neither exists in the table.
       Feeding those to a solver is exactly what made the eyes tremble. */
    var fitA = eyefit(s.prevShape, s.tempId, s.exprPrev);
    var fitB = eyefit(s.shape, s.tempId, s.expr);
    var fitT = Math.min(mt >= 1 ? 1 : ease.outQuint(mt), et >= 1 ? 1 : ease.outQuint(et));
    if (mt >= 1 && et >= 1) fitT = 1;
    var fitX = lerp(fitA.x, fitB.x, fitT) * BALL;
    var fitY = lerp(fitA.y, fitB.y, fitT) * BALL;

    for (var i = 0; i < 2; i++) {
      var p = poses[i], node = s.nodes.eyes[i];
      if (p.depth <= 0.02) { node.setAttribute("opacity", "0"); continue; }

      /* Anything sitting ON the body has to follow its real radius, or a
         non-circular silhouette leaves the eye outside the outline and the
         clip cuts it. */
      var pro = radiusAtAngle(radii, Math.atan2(p.y, p.x));
      var ex = (p.x * BALL * pro + fitX) * sx;
      var ey = (p.y * BALL * pro + fitY) * sy;

      var ew = temp.eyeW * expr.w * BALL;
      var eh = temp.eyeH * expr.h * BALL;
      node.setAttribute("d", capsulePath(ew, eh));

      /* Expression tilt, mirrored, composed into the tangent frame. */
      var tl = deg(expr.tilt * (i === 0 ? 1 : -1));
      var ct = Math.cos(tl), st = Math.sin(tl);
      var a = p.a * ct + p.c * st;
      var b = p.b * ct + p.d * st;
      var c = p.c * ct - p.a * st;
      var dd = p.d * ct - p.b * st;

      node.setAttribute("transform",
        "matrix(" + r2(a) + " " + r2(b * blink) + " " + r2(c) + " " + r2(dd * blink) + " " + r2(ex) + " " + r2(ey) + ")");
      node.setAttribute("opacity", r2(clamp(p.depth * 4, 0, 1)));
    }

    /* Final placement. The flock's world position, plus this agent's own
       bob, sway, hover nudge, and banking roll.

       THE X AND Y ARE ROUNDED TO WHOLE PIXELS, and that is the last piece of
       the jitter fix, 2026-08-19.

       The page's text is rasterised at whole-pixel positions because the
       browser quantises the scroll it applies. An agent written at a
       fractional offset is resampled by the compositor every frame, so a
       stationary agent beside moving text shimmers against it: the text steps
       cleanly while the agent's edges are re-blended at a slightly different
       sub-pixel phase each frame.

       Rounding costs nothing visible. A whole-pixel step at 60fps is well
       below what reads as a step, and the bob, roll, breath and eye motion
       are all still continuous, so nothing looks locked to a grid.

       The rotation is deliberately NOT rounded: it is not what the eye
       compares against the text edge. */
    var half = s.size / 2;
    var cx = w.x + sway + s.nudgeX;
    var cy = w.y + bob + s.nudgeY;
    s.out.cx = cx;
    s.out.cy = cy;
    s.svg.style.transform =
      "translate3d(" + Math.round(cx - half) + "px," + Math.round(cy - half) + "px,0) rotate(" + r2(w.roll) + "deg)";

    return { bob: bob, lift: lift, cx: cx, cy: cy };
  }

  /* ---------------------------------------------------------- DID avatar
     A different job from the floating agents. This is a weak visual
     fingerprint of an identity, so the same DID must always render the same
     face and a different DID must not. Deterministic, no animation, and it
     returns a STRING so a profile page can carry its avatar with no client
     JavaScript at all.

     In production this is `blobatar`, rendered server side. This is the
     wireframe stand-in so a mockup does not pull a dependency it will not
     keep.

     UPGRADED 2026-08-27 to the same material as the landing page agents.
     This used to be a flat fill, which reads as a sticker on a dark page
     while the live agents read as objects. The difference was never the
     shape, it was the lighting, and all three parts of it are cheap and
     static:

       1. one radial gradient, light source up and to the left
       2. a rim light along the lit edge, clipped to the body, which is what
          stops a dark shape dissolving into a dark page
       3. a soft contact shadow underneath, so it sits on the surface rather
          than floating in front of it

     Still zero animation and still one string, so a profile, a card and a
     search result all cost the same as before.

     DESIGN.md 2.4 is unchanged and still binds: every visual property here is
     derived from the DID hash, never chosen. Two agents that pick the same
     name still get different faces, which is the whole point of a
     fingerprint. */
  function avatar(did, size, palette) {
    var h = 0;
    for (var i = 0; i < did.length; i++) h = (h * 31 + did.charCodeAt(i)) >>> 0;

    var radii = SHAPES[SHAPE_IDS[h % SHAPE_IDS.length]];
    var colours = palette || ["#3A3F47", "#4A5058", "#2E333A"];
    /* `>>` is a SIGNED shift, so a hash with the top bit set produces a
       negative index and colours[-1] is undefined. That fed an undefined
       fill straight into the SVG, which browsers render as black. It went
       unnoticed while the avatar was a flat shape on a near-black page and
       became obvious the moment it was lit. `>>>` keeps it unsigned.
       Caught on the avatar bench, 2026-08-27: 8 of 16 faces were black. */
    var fill = colours[(h >>> 5) % colours.length];
    var poses = eyePoses({ yaw: ((h >>> 9) % 40) - 20, pitch: ((h >>> 13) % 26) - 8, roll: 0 }, 15.0);
    var d = closedPath(toPoints(radii, BALL, 1, 1, []));
    var uid = "av" + (h % 100000);

    /* Same two-stop treatment applyColour uses on a live agent, so a static
       avatar and a floating one are recognisably the same material. */
    var light = mixHex(fill, "#FFFFFF", relLum(fill) < 0.18 ? 0.22 : 0.14);
    var dark = mixHex(fill, "#000000", 0.32);
    var rim = mixHex(fill, "#FFFFFF", 0.45);

    var eyeMarkup = "";
    for (var k = 0; k < 2; k++) {
      var p = poses[k];
      if (p.depth <= 0.02) continue;
      var pro = radiusAtAngle(radii, Math.atan2(p.y, p.x));
      eyeMarkup +=
        '<path d="' + capsulePath(0.20 * BALL, 0.30 * BALL) + '" fill="' + mixHex(fill, "#000000", 0.74) + '" ' +
        'transform="matrix(' + r2(p.a) + ' ' + r2(p.b) + ' ' + r2(p.c) + ' ' + r2(p.d) + ' ' +
        r2(p.x * BALL * pro) + ' ' + r2(p.y * BALL * pro) + ')"/>';
    }

    return '<svg viewBox="-100 -100 200 200" width="' + size + '" height="' + size + '" aria-hidden="true" ' +
      'style="display:block;overflow:visible">' +
      '<defs>' +
        '<clipPath id="' + uid + '-clip"><path d="' + d + '"/></clipPath>' +
        '<radialGradient id="' + uid + '-g" cx="34%" cy="24%" r="80%">' +
          '<stop offset="0" stop-color="' + light + '"/>' +
          '<stop offset="1" stop-color="' + dark + '"/>' +
        '</radialGradient>' +
      '</defs>' +
      '<ellipse cx="0" cy="' + r2(BALL * 0.98) + '" rx="' + r2(BALL * 0.62) + '" ry="' + r2(BALL * 0.13) + '" ' +
        'fill="#000" opacity="0.28"/>' +
      '<path d="' + d + '" fill="url(#' + uid + '-g)"/>' +
      '<g clip-path="url(#' + uid + '-clip)">' +
        '<path d="' + d + '" fill="none" stroke="' + rim + '" stroke-width="2.6" opacity="0.5"/>' +
        eyeMarkup +
      '</g></svg>';
  }

  /* Solve the eyefit table now that shapes, temperaments and expressions all
     exist. 9 shapes x 5 temperaments x 5 expressions = 225 entries, each a
     three-pass grid search over 9 gaze corners. Measured below 120ms on this
     machine, paid once at load rather than sixty times a second. */
  buildEyefit();

  global.FA = {
    createAgent: createAgent,
    sample: sample,
    avatar: avatar,
    setShape: setShape,
    setExpression: setExpression,
    setFill: setFill,
    setEye: setEye,
    setGlow: setGlow,
    setTemperament: setTemperament,
    setSize: setSize,
    SHAPES: SHAPE_IDS,
    TEMPERAMENTS: TEMPERAMENT_IDS,
    EXPRESSIONS: Object.keys(EXPRESSIONS),
    mixHex: mixHex,
    ease: ease,
    clamp: clamp,
    lerp: lerp,
    createRng: createRng,
    BALL: BALL,
    /* Exposed for the eyefit measurement script. It has to call the SHIPPED
       overflow function, not a reimplementation of it, or the test and the
       code can agree with each other while both are wrong. */
    __debug: {
      overflow: overflow,
      eyefit: eyefit,
      eyePoses: eyePoses,
      radii: SHAPES,
      temperaments: TEMPERAMENTS,
      expressions: EXPRESSIONS,
      gazeCorners: gazeCorners,
      deg: deg
    }
  };
})(window);
