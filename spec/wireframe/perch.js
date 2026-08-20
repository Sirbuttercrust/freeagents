/* Perched agents: the little characters that float in a page header.

   2026-08-19. The operator: "we should have our animated little agents at the top of
   the pages. They should still be interactable. You can click on them, but they
   can be static and floating in the space at the top. with the find-in agent
   section at the top there's some empty space on the right and the left."

   WHY THIS IS A SEPARATE MODULE FROM flight.js, AND NOT A SETTING ON IT

   flight.js exists to move agents ALONG A SCROLL-DRIVEN ROUTE. Every hard part
   of it, and every bug in it, comes from that one requirement: the spring, the
   document-space coordinates, the applied-versus-smooth scroll distinction, the
   shared frame loop. All of it is machinery for "the target moves while you
   read".

   Here the target never moves. An agent is parked in the header and stays
   there. Reusing flight.js would drag in the entire scroll-coupling apparatus
   to animate something that is, by definition, not scroll-coupled, and it would
   re-expose the jitter class we just spent a session removing. So this module
   positions absolutely inside a container, and scrolling is simply not one of
   its inputs.

   The engine (agents.js) is shared, because that is where the personality
   lives: radial shape profiles, temperaments, expressions, blinking, gaze, the
   eyefit solver. That part is identical whether an agent is flying or sitting.

   WHAT "STATIC" MEANS HERE
   Fixed POSITION, not a frozen picture. Each agent keeps breathing, blinking,
   drifting a pixel or two, and following the pointer with its eyes. A genuinely
   frozen agent reads as a broken image; a parked one that still looks around
   reads as alive and calm, which is what a page header needs.
*/

(function (global) {
  "use strict";

  var REDUCED = global.matchMedia &&
    global.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  /* ----------------------------------------------------------------- dust
     Ported verbatim in behaviour from the landing wireframe's flight.js, so
     poking an agent here feels identical to poking one there. The operator,
     2026-08-19: "You didn't put the same clickable animations on them as you
     did on the landing page."

     A FIXED POOL of circles, recycled round-robin. Creating and destroying
     SVG nodes per particle is what makes hand-rolled particle effects stutter,
     and a burst on every hover would do it many times a second. The pool is
     allocated once and never grows. */

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

  /* Anchors are given in PERCENT of the container box, so the arrangement
     survives every viewport width without a media query per agent. */
  function place(s, host, spot) {
    var w = host.clientWidth, h = host.clientHeight;
    return {
      x: (spot.x / 100) * w,
      y: (spot.y / 100) * h
    };
  }

  function create(hostSelector, cast, opts) {
    opts = opts || {};
    var host = document.querySelector(hostSelector);
    if (!host || !global.FA) return null;

    var layer = document.createElement("div");
    layer.className = "perch-layer";
    layer.setAttribute("aria-hidden", "true");
    host.appendChild(layer);

    /* One SVG behind every agent, holding the dust pool. Coordinates are
       viewport-relative because the burst is emitted from getBoundingClientRect
       values, and the layer already spans the header box. */
    var dustSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    dustSvg.setAttribute("class", "perch-dust");
    dustSvg.setAttribute("aria-hidden", "true");
    layer.appendChild(dustSvg);
    var dust = createDust(dustSvg, 90);

    var agents = [];
    var pointer = { x: 0, y: 0, seen: false, inside: false };
    var t = 0, last = 0, raf = 0;

    /* Bursts arrive in viewport coordinates; the dust SVG is positioned at the
       layer's top left, so convert once here rather than at every call site. */
    function burst(cx, cy, n, speed, s, size, life) {
      if (REDUCED) return;
      var box = layer.getBoundingClientRect();
      var x = cx - box.left, y = cy - box.top;
      var tint = s.glow || global.FA.mixHex(s.fill, "#FFFFFF", 0.65);
      for (var i = 0; i < n; i++) {
        var a = Math.random() * Math.PI * 2;
        var sp = speed + Math.random() * speed * 1.5;
        dust.emit(x, y, Math.cos(a) * sp, Math.sin(a) * sp - speed * 0.4,
                  t, tint, size + Math.random() * size, life);
      }
    }

    cast.forEach(function (c) {
      var s = global.FA.createAgent(c.opts);
      s.spot = c.spot;
      s.driftAmp = c.drift == null ? 4 : c.drift;
      s.driftRate = c.rate == null ? 0.22 : c.rate;
      s.colourVar = c.colour;
      s.wantsGlow = !!c.glow;
      s.baseExpr = c.opts.expression || "rest";
      /* Carried through explicitly. createAgent builds its own object from a
         known field list, so anything the caller wants to keep has to be
         attached to the RETURNED agent, not passed in opts. */
      s.line = c.line || "";

      /* Pointer events on the SVG only. The layer itself never intercepts,
         so a click that misses an agent still reaches the search field or a
         link underneath it. */
      s.svg.style.pointerEvents = "auto";
      s.svg.style.cursor = "pointer";
      /* No focus ring, ever. A browser draws one around a focusable element
         and the operator's rule is that nothing is drawn around the blob. The
         agents are decorative and every line they carry is also written in
         the page text, so removing them from the tab order costs a keyboard
         user nothing. */
      s.svg.style.outline = "none";

      layer.appendChild(s.svg);
      agents.push(s);

      attach(s);
    });

    /* ------------------------------------------------------------ hover
       "It noticed you." Matched to the landing page exactly: surprise on
       entry with a recoil and a small dust burst, settling to perk after
       360ms while the pointer stays, back to rest on leave. Pressing gives a
       bigger burst and a hop.

       The nudge is a spring offset the engine adds on top of position, so a
       poke never fights the parked location. */
    function attach(s) {
      s.svg.addEventListener("pointerenter", function (e) {
        if (REDUCED) return;
        s.hover = true;
        s.hoverAt = t;
        global.FA.setExpression(s, "surprise", t);

        var box = s.svg.getBoundingClientRect();
        var cx = box.left + box.width / 2, cy = box.top + box.height / 2;
        var dx = cx - e.clientX, dy = cy - e.clientY;
        var d = Math.hypot(dx, dy);
        /* A pointer landing exactly on the centre gives no direction to flee.
           Rare with a real mouse, certain with a synthetic event, and a zero
           vector would silently swallow the whole reaction. Recoil upward
           instead, which is what a startled thing does anyway. */
        if (d < 0.001) { dx = 0; dy = -1; d = 1; }
        s.nudgeVX += (dx / d) * 130;
        s.nudgeVY += (dy / d) * 130;

        burst(cx, cy, 7, 30, s, 1, 0.7);

        clearTimeout(s.hoverSeq);
        s.hoverSeq = setTimeout(function () {
          if (s.hover && !s.picked) global.FA.setExpression(s, "perk", t);
        }, 360);
      });

      s.svg.addEventListener("pointerleave", function () {
        s.hover = false;
        clearTimeout(s.hoverSeq);
        if (!s.picked) global.FA.setExpression(s, s.baseExpr, t);
      });

      /* pointerdown, not click, so the reaction fires the instant the button
         goes down rather than on release. That is what makes it feel like a
         physical poke instead of a UI event.

         `click` is bound as well, deliberately. pointerdown does not fire for
         assistive technology that synthesises a click, nor for a synthetic
         MouseEvent, so binding only pointerdown would make the agents
         unresponsive to anything that is not a real mouse. `fired` collapses
         the two so a real press does not trigger twice. */
      var fired = 0;
      function poke(e) {
        var now = (global.performance && performance.now()) || Date.now();
        if (now - fired < 350) return;
        fired = now;
        pick();
        if (e && e.preventDefault) e.preventDefault();
      }
      s.svg.addEventListener("pointerdown", poke);
      s.svg.addEventListener("click", poke);

      function pick() {
        s.picked = true;
        global.FA.setExpression(s, "pleased", t);

        var box = s.svg.getBoundingClientRect();
        burst(box.left + box.width / 2, box.top + box.height / 2, 12, 60, s, 1.2, 0.85);
        s.nudgeVY += 90;

        if (opts.onPick) opts.onPick(s);

        clearTimeout(s.hoverSeq);
        s.hoverSeq = setTimeout(function () {
          s.picked = false;
          global.FA.setExpression(s, s.hover ? "perk" : s.baseExpr, t);
        }, 700);
      }
    }

    host.addEventListener("pointermove", function (e) {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.seen = true;
    }, { passive: true });

    function frame(now) {
      var dt = last ? Math.min((now - last) / 1000, 0.05) : 1 / 60;
      last = now;
      t += dt;

      for (var i = 0; i < agents.length; i++) {
        var s = agents[i];
        var p = place(s, host, s.spot);

        /* The only motion: a slow figure-eight of a few pixels, unique per
           agent through its phase. Enough that the group never looks pasted
           on, small enough that nothing appears to be going anywhere. */
        var drift = REDUCED ? 0 : s.driftAmp;
        s.world.x = p.x + Math.sin(t * s.driftRate + s.phase) * drift;
        s.world.y = p.y + Math.cos(t * s.driftRate * 1.6 + s.phase * 1.3) * drift * 0.7;
        s.world.vx = 0;
        s.world.vy = 0;
        s.world.lift = 0;
        s.world.roll = Math.sin(t * s.driftRate * 0.8 + s.phase) * 2.5;

        var aim = { nx: 0, ny: 0, known: false };
        if (pointer.seen) {
          var r = s.svg.getBoundingClientRect();
          aim.nx = clamp((pointer.x - (r.left + r.width / 2)) / 420, -1, 1);
          aim.ny = clamp((pointer.y - (r.top + r.height / 2)) / 340, -1, 1);
          aim.known = true;
        }

        global.FA.sample(s, t, dt, aim);
      }

      /* Dust advances on the same clock as the agents, so a burst decays at
         the same rate the character that threw it is moving. */
      if (!REDUCED) dust.step(t, dt);

      raf = requestAnimationFrame(frame);
    }

    function recolour() {
      var cs = getComputedStyle(document.documentElement);
      agents.forEach(function (s) {
        var hex = cs.getPropertyValue(s.colourVar).trim();
        global.FA.setFill(s, hex);
        global.FA.setEye(s, cs.getPropertyValue("--eye").trim() || "#08090A");
        if (s.wantsGlow) global.FA.setGlow(s, hex);
      });
    }

    recolour();

    if (REDUCED) {
      /* One static frame at the parked position, no loop. A dignified end
         state: every agent is drawn and placed, it simply does not move. */
      var draw = function () {
        agents.forEach(function (s) {
          var p = place(s, host, s.spot);
          s.world.x = p.x; s.world.y = p.y; s.world.roll = 0;
          global.FA.sample(s, 0, 0, { nx: 0, ny: 0, known: false });
        });
      };
      draw();
      global.addEventListener("resize", draw);
    } else {
      raf = requestAnimationFrame(frame);
    }

    return { agents: agents, recolour: recolour, host: host };
  }

  global.FAPerch = { create: create, REDUCED: REDUCED };
})(window);
