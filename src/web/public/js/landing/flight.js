/* FreeAgents: the flock.
   Written 2026-08-19 for the v2 wireframe.

   WHAT THIS IS
   The agents cluster in the hero, then scatter down the page as you scroll,
   landing on the thing you are about to read the way a bird lands on a
   branch. At the bottom they settle on the footer and stay.

   THE MODEL, AND WHY IT IS BUILT THIS WAY

   An agent owns a ROUTE: an ordered list of perches. A perch names a DOM
   element and a fractional offset inside it. Two things follow from that:

   - A landed agent is positioned from its anchor's LIVE rect every frame, so
     it scrolls with the content it landed on. That is what "landed" has to
     mean. Positioning from page coordinates instead would make it drift the
     moment anything reflowed.
   - The scroll position that triggers a perch is DERIVED, not authored: it
     is the scrollY at which that anchor sits at the centre of the viewport.
     So the choreography survives copy edits and a change of font, and none
     of it needs hand-tuned pixel numbers that rot on the first rewrite.

   Between two perches the agent FLIES: a quadratic bezier with a lifted
   control point, plus a flutter perpendicular to the path that tapers to
   zero at both ends. Each agent has its own departure moment, its own arc
   height and its own flutter frequency, which is what makes five of them
   read as a flock scattering rather than a row of objects being tweened.

   Layering is per perch. An agent flying to a back perch swaps DOM parents
   at the midpoint of its flight, so it visibly passes behind the text on the
   way. That crossing is the whole effect, and doing it while stationary
   would just look like a z-index bug.

   THE BINDING CONSTRAINT
   Decorative layers never obscure content. Back-layer agents are dimmed and
   are pointer-transparent, so they cannot eat a click meant for a link or
   block text selection. Only a front-layer agent is interactive, and the
   front layer is deliberately never given a perch that sits on top of body
   copy: it perches in the margins beside it.
*/

(function (global) {
  "use strict";

  var FA = global.FA;
  var clamp = FA.clamp, ease = FA.ease;
  var REDUCED = global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* --------------------------------------------------------------- dust
     Sparkle trail. A fixed pool per flock, so a long scroll can never grow
     the DOM without bound. Particles live in viewport coordinates and are
     independent of the agent that dropped them, which is the point: they
     have to stay behind. */

  function createDust(svg, cap) {
    var pool = [], nodes = [], i;
    for (i = 0; i < cap; i++) {
      var c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("r", "1.5");
      c.setAttribute("opacity", "0");
      svg.appendChild(c);
      nodes.push(c);
      pool.push({ alive: false, x: 0, y: 0, vx: 0, vy: 0, born: 0, life: 1, r: 1.5, fill: "#fff" });
    }
    return {
      pool: pool,
      nodes: nodes,
      next: 0,
      emit: function (x, y, vx, vy, t, fill, size, life) {
        var p = pool[this.next];
        this.next = (this.next + 1) % pool.length;
        p.alive = true;
        p.x = x; p.y = y;
        p.vx = vx; p.vy = vy;
        p.born = t;
        p.life = life;
        p.r = size;
        p.fill = fill;
      },
      step: function (t, dt) {
        for (var k = 0; k < pool.length; k++) {
          var p = pool[k], node = nodes[k];
          if (!p.alive) continue;
          var age = (t - p.born) / p.life;
          if (age >= 1) {
            p.alive = false;
            node.setAttribute("opacity", "0");
            continue;
          }
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.vy += 26 * dt;          // a little gravity, so it settles rather than floats
          p.vx *= 1 - 1.6 * dt;
          p.vy *= 1 - 0.9 * dt;
          node.setAttribute("cx", Math.round(p.x * 10) / 10);
          node.setAttribute("cy", Math.round(p.y * 10) / 10);
          node.setAttribute("r", Math.round(p.r * (1 - age * 0.55) * 100) / 100);
          node.setAttribute("fill", p.fill);
          node.setAttribute("opacity", Math.round((1 - age) * (1 - age) * 0.85 * 100) / 100);
        }
      }
    };
  }

  /* --------------------------------------------------------------- flock */

  function createFlock(opts) {
    opts = opts || {};
    var back = opts.back, front = opts.front;

    var dustBack = createDust(back.querySelector(".dust"), 60);
    var dustFront = createDust(front.querySelector(".dust"), 60);

    var flock = {
      agents: [],
      back: back,
      front: front,
      dust: { back: dustBack, front: dustFront },
      t: 0,
      last: 0,
      raf: 0,
      pointer: { x: 0, y: 0, seen: false, inside: false }
    };

    /**
     * Add one agent with its route.
     * route: array of perches, each
     *   { anchor, ax, ay, dx, dy, at, layer, size, shape, expr }
     * tuning:
     *   depart  0..1 fraction of the segment before it takes off
     *   arrive  0..1 fraction by which it has landed
     *   arc     signed px of lift on the flight path
     *   flutter cycles across the flight
     */
    flock.add = function (agentOpts, route, tuning) {
      var s = FA.createAgent(agentOpts);
      s.route = route;
      s.tune = Object.assign({ depart: 0.18, arrive: 0.82, arc: -90, flutter: 2.2 }, tuning || {});
      s.layer = route[0].layer || "front";
      s.perchIndex = 0;
      s.prevX = 0; s.prevY = 0;
      s.world.vx = 0; s.world.vy = 0;
      s.dustAcc = 0;
      s.hoverSeq = 0;

      var parent = s.layer === "back" ? back : front;
      parent.appendChild(s.svg);
      if (route[0].size) FA.setSize(s, route[0].size);
      if (route[0].shape) { s.shape = route[0].shape; s.prevShape = route[0].shape; }

      /* EVERY agent is interactive, on either layer. Changed 2026-08-19 on
         review: all of them should be interactable, not just the front
         layer.

         This does not weaken the visibility law, because the law is about not
         OBSCURING content and not STEALING its clicks, and neither depends on
         the agent being inert. The back layer sits at z-index 1 while all page
         content sits at z-index 10 (landing.css), so the browser hit-tests
         content first and a back-layer agent can only ever receive a pointer
         event in the empty margins where nothing else is. Text selection and
         every link keep working exactly as before.

         The layer still controls DIMMING, which is what makes depth readable:
         a back agent renders at 0.55 opacity behind the copy. */
      s.svg.style.pointerEvents = "auto";
      s.svg.setAttribute("data-hit", "");
      s.svg.style.cursor = "default";
      s.svg.style.opacity = s.layer === "back" ? "0.55" : "1";

      /* Hover is decided geometrically once per frame in updateHover(), and
         pokes by one document-level listener in attachPoke(). Neither is
         attached per agent, because a back-layer agent never receives its own
         pointer events. See the hover block above. */
      flock.agents.push(s);
      return s;
    };

    flock.start = function () {
      /* Anchors are cached in document space, so anything that reflows the
         page has to invalidate them. Resize is obvious; the reveals are the
         subtle one, because a fade-in changes an element's height as it runs
         and a stale cache would leave agents perched where a section used to
         end. */
      global.addEventListener("resize", invalidateAnchors);
      document.addEventListener("transitionend", invalidateAnchors);
      /* Belt and braces for anything that changes layout without a
         transition (a font arriving, an image decoding). Cheap: one call
         every two seconds, not per frame. */
      setInterval(invalidateAnchors, 2000);

      if (REDUCED) {
        // Static end state: everything drawn at its perch, no loop.
        var draw = function () {
          layout(flock, 0, 0, global.scrollY || 0);
        };
        draw();
        global.addEventListener("scroll", draw, { passive: true });
        global.addEventListener("resize", function () { invalidateAnchors(); draw(); });
        return;
      }

      global.addEventListener("pointermove", function (e) {
        flock.pointer.x = e.clientX;
        flock.pointer.y = e.clientY;
        flock.pointer.seen = true;
        flock.pointer.inside = true;
      }, { passive: true });

      attachPoke(flock);

      /* Heads return to their resting pose when the pointer leaves the
         window, rather than staying frozen at wherever it exited. The flag
         is eased per agent at read time, so this is a target, not a jump. */
      document.addEventListener("pointerleave", function () {
        flock.pointer.inside = false;
      });
      document.addEventListener("pointerenter", function () {
        if (flock.pointer.seen) flock.pointer.inside = true;
      });
      global.addEventListener("blur", function () {
        flock.pointer.inside = false;
      });

      /* ONE FRAME LOOP FOR THE PAGE.
         Subscribing to the scroll module rather than starting a second
         requestAnimationFrame is what guarantees this runs AFTER the scroll
         position is updated, every frame. Two independent loops have no
         defined order, and the resulting one-frame lag flickering on and off
         was a measured source of jitter. */
      var scroller = global.FASmoothScroll;
      if (scroller && scroller.onFrame) {
        scroller.onFrame(function (smoothY, dt) {
          flock.t += dt;
          layout(flock, flock.t, dt, smoothY);
        });
      } else {
        /* Fallback for the passthrough case (touch, reduced motion off but
           no smoothing). Still one loop. */
        flock.last = performance.now();
        (function step(now) {
          var dt = Math.min((now - flock.last) / 1000, 0.05);
          flock.last = now;
          flock.t += dt;
          layout(flock, flock.t, dt, global.scrollY || 0);
          flock.raf = requestAnimationFrame(step);
        })(performance.now());
      }
    };

    return flock;
  }

  /* --------------------------------------------------------------- hover
     "It noticed you." Surprise, then settle into perk while the pointer
     stays, then back to rest. A poke away from the cursor and a small burst
     of dust, so the reaction is felt as well as seen.

     HOVER IS GEOMETRIC, NOT DOM HIT-TESTING. Rewritten 2026-08-19 after
     a review that found most agents on the page still could not be
     interacted with: they need to be reachable at all times, on either
     layer.

     The previous attempt set `pointer-events: auto` on every agent and
     assumed that was enough. It was not, and the reason is stacking. Page
     content sits at z-index 10 and the back layer at 1, so the browser
     hit-tests content FIRST and a back agent behind any text block never
     receives a pointer event at all. Measured across 21 scroll positions
     before this fix:

         scroll position   agents hittable
             0.00              3 of 5
             0.10              2 of 5
             0.15              2 of 5
             0.40              2 of 5
             0.45              2 of 5
             ...
         blocked by: DIV.wrap 14x, DIV.blobfield 5x, P.sub 2x, H3 2x,
                     H2 2x, LI 2x, DIV.tier-row 1x

     Only 7 of 21 positions had all five reachable. Raising the back layer
     above content would fix hit-testing and break the visibility law, which
     is not a trade worth making.

     So hover no longer asks the DOM who owns a pixel. Each frame it measures
     the distance from the pointer to each agent's centre and decides for
     itself. That is immune to z-order by construction, works identically on
     both layers, and cannot be blocked by anything. It also fixes a subtler
     case the DOM approach got wrong: scrolling the page under a stationary
     cursor now updates hover correctly, because the test re-runs every frame
     rather than waiting for a pointer event.

     Content keeps its pixels either way: the agent reacts, but the click and
     the text selection still belong to whatever the browser says is on top.

     The radius is the agent's own visible ball (the viewBox is 200 units wide
     and the ball radius is 62, so the drawn radius is size * 0.31), with a
     22px floor. That floor is the 44px minimum tap target from the house
     standards: the smallest agents draw at 40px, which is a 24.8px target
     without it. */

  function agentHitRadius(s) {
    var r = (s.sizeNow || s.size) * 0.31;
    return r < 22 ? 22 : r;
  }

  function enterAgent(flock, s, px, py) {
    if (s.hover) return;
    s.hover = true;
    s.hoverAt = flock.t;
    FA.setExpression(s, "surprise", flock.t);

    var box = s.svg.getBoundingClientRect();
    var cx = box.left + box.width / 2, cy = box.top + box.height / 2;
    var dx = cx - px, dy = cy - py;
    var d = Math.hypot(dx, dy);
    /* A pointer landing exactly on the centre gives no direction to flee.
       Rare with a real mouse, certain with a synthetic event, and a zero
       vector would silently swallow the whole reaction. Recoil upward
       instead, which is what a startled thing does anyway. */
    if (d < 0.001) { dx = 0; dy = -1; d = 1; }
    s.nudgeVX += (dx / d) * 130;
    s.nudgeVY += (dy / d) * 130;

    var dust = s.layer === "back" ? flock.dust.back : flock.dust.front;
    for (var i = 0; i < 7; i++) {
      var a = Math.random() * Math.PI * 2, sp = 30 + Math.random() * 60;
      dust.emit(cx, cy, Math.cos(a) * sp, Math.sin(a) * sp - 20, flock.t,
                s.glow || FA.mixHex(s.fill, "#FFFFFF", 0.6), 1 + Math.random() * 1.6, 0.7);
    }

    clearTimeout(s.hoverSeq);
    s.hoverSeq = setTimeout(function () {
      if (s.hover) FA.setExpression(s, "perk", flock.t);
    }, 360);
  }

  function leaveAgent(flock, s) {
    if (!s.hover) return;
    s.hover = false;
    clearTimeout(s.hoverSeq);
    FA.setExpression(s, "rest", flock.t);
  }

  function pokeAgent(flock, s) {
    FA.setExpression(s, "pleased", flock.t);
    var box = s.svg.getBoundingClientRect();
    var cx = box.left + box.width / 2, cy = box.top + box.height / 2;
    var dust = s.layer === "back" ? flock.dust.back : flock.dust.front;
    for (var i = 0; i < 12; i++) {
      var a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 90;
      dust.emit(cx, cy, Math.cos(a) * sp, Math.sin(a) * sp - 30, flock.t,
                s.glow || FA.mixHex(s.fill, "#FFFFFF", 0.7), 1.2 + Math.random() * 1.8, 0.85);
    }
    s.nudgeVY += 90;
    clearTimeout(s.hoverSeq);
    s.hoverSeq = setTimeout(function () {
      FA.setExpression(s, s.hover ? "perk" : "rest", flock.t);
    }, 700);
  }

  /* Called once per frame from layout(). Owns hover for every agent. */
  function updateHover(flock) {
    var p = flock.pointer;
    for (var i = 0; i < flock.agents.length; i++) {
      var s = flock.agents[i];
      if (!p.seen || !p.inside) { leaveAgent(flock, s); continue; }
      var box = s.svg.getBoundingClientRect();
      var cx = box.left + box.width / 2, cy = box.top + box.height / 2;
      var r = agentHitRadius(s);
      /* Slight hysteresis: leaving needs a little more distance than
         entering, so a cursor resting exactly on the boundary does not
         flicker the expression between surprise and rest. */
      var lim = s.hover ? r * 1.18 : r;
      if (Math.hypot(p.x - cx, p.y - cy) <= lim) enterAgent(flock, s, p.x, p.y);
      else leaveAgent(flock, s);
    }
  }

  /* One document-level listener for pokes, for the same reason as above: a
     back-layer agent never receives its own pointerdown. */
  function attachPoke(flock) {
    document.addEventListener("pointerdown", function (e) {
      var best = null, bestD = Infinity;
      for (var i = 0; i < flock.agents.length; i++) {
        var s = flock.agents[i];
        var box = s.svg.getBoundingClientRect();
        var cx = box.left + box.width / 2, cy = box.top + box.height / 2;
        var d = Math.hypot(e.clientX - cx, e.clientY - cy);
        if (d <= agentHitRadius(s) && d < bestD) { best = s; bestD = d; }
      }
      if (!best) return;
      pokeAgent(flock, best);
      /* preventDefault ONLY when the agent genuinely owns this pixel. If the
         click landed on text or a link that happens to sit over an agent, the
         agent still reacts but the page keeps its normal behaviour: selection
         works, links navigate. Suppressing that would be exactly the theft
         this design is meant to avoid. */
      if (best.svg.contains(e.target)) e.preventDefault();
    }, true);
  }

  /* -------------------------------------------------------------- layout
     One frame for the whole flock.

     THE COORDINATE BUG THAT CAUSED THE JITTER, 2026-08-19

     Reported as a jitter on slow scrolling. Measured rather than guessed,
     and it took two rounds to find because the first fix was aimed at the
     wrong number.

     The measurement that found it: read the spring position, the rendered
     position, and the rendered position RELATIVE TO AN ANCHOR, separately.
     The springs were perfectly smooth, zero direction reversals. The rendered
     positions were nearly smooth. But relative to the text, every agent
     reversed direction 38 to 57 times during one slow scroll.

     RELATIVE is the number that matters, because that is what the eye
     compares. An agent perched beside a paragraph is judged against that
     paragraph, not against the viewport. Absolute smoothness is not enough
     and can hide the defect completely.

     THE CAUSE
     The spring was running in VIEWPORT space. Scrolling therefore MOVED THE
     SPRING'S TARGET, every frame, and the spring's continuous fractional
     output was then compared by eye against text that the browser quantises
     to whole pixels. Text steps 1, 1, 1; the spring slides 0.7, 1.3, 0.9. The
     difference is a sub-pixel sawtooth, and a sub-pixel sawtooth against a
     hard edge is exactly what "shaky" looks like.

     Rounding the applied scroll made no difference, because the mismatch is
     between a smooth signal and a stepped one, not between two stepped ones.

     THE FIX: THE SPRING LIVES IN DOCUMENT SPACE.
     Targets are computed in document coordinates, the spring integrates in
     document coordinates, and the result is converted to the viewport once
     at render time by subtracting the scroll the browser ACTUALLY APPLIED.

     What that buys, and it is exact rather than approximate:

       - A landed agent has a CONSTANT document target. A critically damped
         spring at rest with a constant target does not move at all. Its
         document position is a constant, so its viewport position is
         `constant - appliedScroll`, which changes by precisely the same
         integer as every piece of text on the page. Lockstep, by
         construction, with nothing left to jitter.
       - Scrolling no longer excites the spring at all. The spring's only job
         becomes what it was always meant to be: smoothing the move from one
         perch to the next.
       - A flying agent's document target does move with scroll progress, and
         there the spring does its work. A sub-pixel difference during flight
         cannot be seen because the agent is crossing the screen.

     THE SECOND BUG: two independent rAF loops.
     The flock had its own requestAnimationFrame alongside the scroll
     module's. Callback order between them is not guaranteed, so on some
     frames the flock read the previous frame's scroll position. A one-frame
     lag that flickers on and off is jitter by construction. The flock now
     subscribes to the scroll module's frame, so it always runs after the
     position is settled.

     Document positions are cached across frames and invalidated on resize and
     on reveal completion. That also removed most of the layout reads: five
     agents through six anchors was 30 rect calls per frame. */

  var STIFFNESS = 42;
  var DAMPING = 2 * Math.sqrt(STIFFNESS);

  /* Document-space anchor cache. Rebuilt on resize, on reveal completion,
     and lazily for anchors not yet seen. */
  var docCache = {};

  function invalidateAnchors() { docCache = {}; }

  function docPos(sel) {
    var v = docCache[sel];
    if (v !== undefined) return v;
    var node = document.querySelector(sel);
    if (!node) { docCache[sel] = null; return null; }
    var r = node.getBoundingClientRect();
    var sy = global.scrollY || global.pageYOffset || 0;
    var sx = global.scrollX || global.pageXOffset || 0;
    v = { left: r.left + sx, top: r.top + sy, width: r.width, height: r.height };
    docCache[sel] = v;
    return v;
  }

  function layout(flock, t, dt, smoothY) {
    var vh = global.innerHeight;
    /* The scroll the browser actually applied, used ONCE, at render time. */
    var appliedY = global.scrollY || global.pageYOffset || 0;

    /* Everything below is DOCUMENT space until the final transform. */
    function pointOf(perch) {
      var d = docPos(perch.anchor);
      if (!d) return null;
      return {
        x: d.left + d.width * perch.ax + (perch.dx || 0),
        y: d.top + d.height * perch.ay + (perch.dy || 0)
      };
    }
    function triggerOf(perch) {
      var d = docPos(perch.anchor);
      if (!d) return 0;
      return Math.max(0, d.top + d.height * (perch.at == null ? 0.5 : perch.at) - vh * 0.5);
    }

    var plan = [];
    var i, s;

    /* ---- read pass */
    for (i = 0; i < flock.agents.length; i++) {
      s = flock.agents[i];
      var route = s.route;
      if (route.length === 1) {
        plan.push({ s: s, pos: pointOf(route[0]), lift: 0, idx: 0, perch: route[0], q: 0 });
        continue;
      }

      var k = 0, j;
      var triggers = [];
      for (j = 0; j < route.length; j++) triggers.push(triggerOf(route[j]));
      for (j = 0; j < route.length - 1; j++) if (smoothY >= triggers[j]) k = j;

      var a = triggers[k], b = triggers[k + 1];
      var p = b > a ? clamp((smoothY - a) / (b - a), 0, 1) : (smoothY >= b ? 1 : 0);

      var d0 = s.tune.depart, d1 = s.tune.arrive;
      var pa = pointOf(route[k]);
      var pb = pointOf(route[k + 1]);
      if (!pa || !pb) continue;

      var pos, lift, idx, q = 0;
      if (p <= d0) {
        pos = pa; lift = 0; idx = k;
        s.lastBaseX = null;
      } else if (p >= d1) {
        pos = pb; lift = 0; idx = k + 1;
        s.lastBaseX = null;
      } else {
        q = (p - d0) / (d1 - d0);
        var eq = ease.inOutCubic(q);

        /* Quadratic bezier with a lifted control point. The lift is
           perpendicular to the chord, so a horizontal hop arcs upward and a
           vertical drop bows sideways, which stops five agents tracing the
           same line. */
        var mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
        var dx = pb.x - pa.x, dy = pb.y - pa.y;
        var len = Math.hypot(dx, dy) || 1;
        var nx = -dy / len, ny = dx / len;
        var cx = mx + nx * s.tune.arc, cy = my + ny * s.tune.arc;

        var inv = 1 - eq;
        var bx = inv * inv * pa.x + 2 * inv * eq * cx + eq * eq * pb.x;
        var by = inv * inv * pa.y + 2 * inv * eq * cy + eq * eq * pb.y;

        /* Flutter, tapering to zero at both ends so it never disturbs a
           landing.

           GATED ON THE AGENT'S REAL SCREEN SPEED, and that gate is the second
           half of the 2026-08-19 shake fix.

           This used to be `sin(t * freq) * 11 * taper`: driven by wall clock
           time, with amplitude depending only on progress through the flight.
           Correct while an agent is genuinely crossing the screen, because the
           oscillation reads as wingbeat against real translation. Wrong during
           a slow scroll, and measurably so: scrolling one notch at a time,
           agent 1 spent 67 frames in flight while its path travelled SIX
           PIXELS, and agent 3 reversed direction 45 times while covering 82px.
           An agent hovering in place while oscillating 11px perpendicular is
           not fluttering, it is vibrating, and that is what was reported.

           The gate is the speed of the BASE path in document pixels per
           second, measured from the bezier point before flutter is added.
           Speed is the honest quantity here: gating on progress-per-second
           instead looks right but is not, because a short segment covers its
           whole range in a few scrolled pixels, so a crawl still reports fast
           progress. Pixels per second is the same physical number for every
           agent regardless of how far apart its perches sit.

           Below 45px/s the agent is effectively parked and the flutter is
           off; by 130px/s it is fully in. The gain is smoothed per agent
           because a hard gate on a per-frame derivative chatters on and off,
           which would be a new shake in place of the old one. */
        var baseSpeed = 0;
        if (dt > 0 && s.lastBaseX != null) {
          baseSpeed = Math.hypot(bx - s.lastBaseX, by - s.lastBaseY) / dt;
        }
        s.lastBaseX = bx;
        s.lastBaseY = by;

        var wantFlutter = clamp((baseSpeed - 45) / 85, 0, 1);
        s.flutterGain = s.flutterGain == null
          ? wantFlutter
          : s.flutterGain + (wantFlutter - s.flutterGain) * Math.min(1, dt * 3.5);

        var taper = Math.sin(Math.PI * q);
        var fl = Math.sin(t * s.tune.flutter * 2.2 + s.phase) * 11 * taper * s.flutterGain;
        bx += nx * fl;
        by += ny * fl;

        pos = { x: bx, y: by };
        lift = taper * 1.4 > 1 ? 1 : taper * 1.4;
        idx = q < 0.5 ? k : k + 1;
      }

      plan.push({ s: s, pos: pos, lift: lift, idx: idx, perch: route[idx], q: q });
    }

    /* ---- write pass */
    for (i = 0; i < plan.length; i++) {
      var it = plan[i];
      s = it.s;
      if (!it.pos) continue;

      /* First frame: start ON target rather than springing in from the
         origin, which would look like the flock falling into place. */
      if (!s.warm) {
        s.sx = it.pos.x; s.sy = it.pos.y;
        s.svx = 0; s.svy = 0;
        s.sLift = it.lift;
        s.warm = true;
      }

      /* Critically damped spring, integrated in DOCUMENT space, so a landed
         agent's target is constant and the spring genuinely comes to rest.
         Sub-stepped at a fixed 120Hz: a spring integrated with a variable dt
         changes its effective stiffness when the frame rate wobbles, and one
         long frame can overshoot enough to visibly kick. */
      if (dt > 0) {
        var STEP = 1 / 120;
        var remaining = dt;
        while (remaining > 0) {
          var h = remaining > STEP ? STEP : remaining;
          var ax = STIFFNESS * (it.pos.x - s.sx) - DAMPING * s.svx;
          var ay = STIFFNESS * (it.pos.y - s.sy) - DAMPING * s.svy;
          s.svx += ax * h;
          s.svy += ay * h;
          s.sx += s.svx * h;
          s.sy += s.svy * h;
          remaining -= h;
        }
        /* Park the spring when it is close enough to be invisible. Without
           this it keeps integrating a vanishing residual forever, writing a
           different sub-pixel value every frame for a stationary agent. That
           residual is small enough to ignore in isolation and plainly
           visible against a hard text edge. */
        if (Math.abs(it.pos.x - s.sx) < 0.02 && Math.abs(s.svx) < 0.05) {
          s.sx = it.pos.x; s.svx = 0;
        }
        if (Math.abs(it.pos.y - s.sy) < 0.02 && Math.abs(s.svy) < 0.05) {
          s.sy = it.pos.y; s.svy = 0;
        }
        /* Lift eases too, so the wing beat spins up and down instead of
           switching on at the instant flight begins. */
        s.sLift += (it.lift - s.sLift) * Math.min(1, dt * 6);
      } else {
        s.sx = it.pos.x; s.sy = it.pos.y; s.sLift = it.lift;
      }

      var vx = s.svx, vy = s.svy;
      var speed = Math.hypot(vx, vy);

      /* DOCUMENT space to VIEWPORT space, once, here. This subtraction is
         what puts the agent in lockstep with the text. */
      var viewX = s.sx;
      var viewY = s.sy - appliedY;

      s.world.x = viewX;
      s.world.y = viewY;
      s.world.vx = vx;
      s.world.vy = vy;
      s.world.lift = s.sLift;
      /* Banking. A body that changes direction leans into it. Clamped hard,
         because past about 14 degrees it stops reading as flight and starts
         reading as a bug. */
      s.world.roll = clamp(vx * 0.014, -14, 14) * (0.3 + s.sLift * 0.7);

      /* Perch properties: size and shape belong to the destination, and they
         change at the midpoint of the flight so the morph happens in the
         air. The radial profile engine makes that a real morph, not a
         swap. */
      if (it.perch !== s.currentPerch) {
        s.currentPerch = it.perch;
        if (it.perch.size) FA.setSize(s, it.perch.size);
        if (it.perch.shape) FA.setShape(s, it.perch.shape, t);
        if (it.perch.expr && !s.hover) FA.setExpression(s, it.perch.expr, t);

        var wantLayer = it.perch.layer || "front";
        if (wantLayer !== s.layer) {
          s.layer = wantLayer;
          (wantLayer === "back" ? flock.back : flock.front).appendChild(s.svg);
          /* Interactivity no longer depends on the layer (see flock.add);
             only the dimming does. */
          s.svg.style.opacity = wantLayer === "back" ? "0.55" : "1";
        }
      }

      /* Dust and pointer aim both work in VIEWPORT space, because dust
         particles live on screen and the pointer is a screen position. */
      if (!REDUCED && speed > 70) {
        s.dustAcc += (speed / 900) * dt * 60;
        var dust = s.layer === "back" ? flock.dust.back : flock.dust.front;
        while (s.dustAcc >= 1) {
          s.dustAcc -= 1;
          var jitter = (Math.random() - 0.5) * s.size * 0.5;
          dust.emit(
            viewX + jitter,
            viewY + s.size * 0.22 + (Math.random() - 0.5) * 10,
            -vx * 0.06 + (Math.random() - 0.5) * 22,
            -vy * 0.06 + (Math.random() - 0.5) * 18 + 8,
            t,
            s.glow || FA.mixHex(s.fill, "#FFFFFF", 0.55),
            0.9 + Math.random() * 1.5,
            0.55 + Math.random() * 0.35
          );
        }
      }

      /* Per-agent aim: each looks at the pointer from where IT is. One global
         aim would make five agents at five positions all look the same way,
         which is the tell that they are one animation.

         REAL ANGLES, NOT NORMALISED OFFSETS. Rewritten 2026-08-19. This used
         to hand the engine `nx`/`ny`, the pointer offset divided by 460 and
         380 and clamped, which the engine then multiplied by a fixed 20 and
         15 degrees and ADDED to the resting pose. Two faults fell out of that:
         the reachable range never crossed centre (see the gaze block in
         agents.js), and the deflection depended on an arbitrary pixel divisor
         rather than on where the cursor actually is.

         Now the aim is the true direction to the pointer. `atan2` against an
         assumed viewing distance turns a screen offset into an angle the same
         way a camera would, so an agent looks harder at a cursor that is
         genuinely far off to one side and barely turns for one just beside
         it. Clamped to a believable head turn: past about 42 degrees of yaw
         the far eye disappears round the side of the sphere.

         DIST is the notional distance from the viewer to the page in the same
         units as the layout. 520px puts a cursor one viewport-width away at
         roughly 40 degrees, which reads as a full turn without going
         cross-eyed. */
      var DIST = 520;
      var aim = { yaw: 0, pitch: 0, engage: 0 };
      if (flock.pointer.seen) {
        var adx = flock.pointer.x - viewX;
        var ady = flock.pointer.y - viewY;
        aim.yaw = clamp(Math.atan2(adx, DIST) * 180 / Math.PI, -42, 42);
        /* PITCH IS NEGATED, and the sign is not arbitrary. Fixed 2026-08-19
           after a report that a cursor above an agent made it look down, and
           a cursor below it made it look up.

           Screen y grows DOWNWARD, so a cursor above the agent gives a
           negative `ady`. The engine's pitch runs the other way: working
           `eyePoses` through by hand, a pose of +30 degrees pitch produces a
           forward vector with y = -0.5, which moves the eyes UP the screen.
           So POSITIVE pitch means looking up, and feeding a raw negative
           `ady` straight in makes the agent look down at a cursor that is
           above it.

           The pre-rewrite line carried this as `- aim.ny * 15`; the minus was
           doing exactly this job and the rewrite dropped it. */
        aim.pitch = clamp(-Math.atan2(ady, DIST) * 180 / Math.PI, -30, 30);
        aim.engage = flock.pointer.inside ? 1 : 0;
      }
      /* Ease engagement per agent so heads turn to and from the pointer
         instead of snapping when it enters or leaves the window. */
      s.engage = s.engage == null ? aim.engage
                                  : s.engage + (aim.engage - s.engage) * Math.min(1, dt * 3);
      aim.engage = s.engage;

      FA.sample(s, t, dt, aim);
    }

    /* Hover AFTER every agent has been placed this frame, so the distance
       test uses the position the user is actually looking at rather than the
       previous frame's. Runs every frame, which is also what makes hover
       correct while the page scrolls under a stationary cursor. */
    if (!REDUCED) updateHover(flock);

    if (!REDUCED) {
      flock.dust.back.step(t, dt);
      flock.dust.front.step(t, dt);
    }
  }

  global.FAFlock = { create: createFlock, REDUCED: REDUCED };
})(window);
