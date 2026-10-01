/* FreeAgents: animated diagrams. The behaviour half of css/diagrams.css.

   WHAT IT IS
   A page writes a diagram as markup: nodes carrying data-t (the second they
   arrive) and, where one node leads to another, data-from and data-route.
   This file measures where everything landed, draws the wires between them,
   and plays the diagram once as it scrolls into view: a node arrives, a light
   runs down the wire to the next, that node arrives. Then it stops for good.
   A diagram that replays every time you pass it becomes noise, so there is a
   Replay button and nothing automatic after the first play.

   THE MARKUP CONTRACT
     <section class="dg" data-diagram>
       <div class="dg-bar"><h2>...</h2><button class="dg-replay" hidden>...</button></div>
       <div class="dg-stage">
         <div class="dg-node dg-step pane" data-id="a" data-t="0.6">...</div>
         <div class="dg-node dg-step pane" data-id="b" data-t="2.1"
              data-from="a" data-route="drop" data-via="Pay the rest">...</div>
       </div>
     </section>
   data-t         when the node arrives, in seconds from the start of the play
   data-from      the data-id it hangs from; its wire finishes at data-t
   data-route     drop (straight down the rail), fan (out of the right edge,
                  along a trunk), rail (the phone form of fan), zig (from the
                  bottom middle of one node, across, down into the top
                  middle of the next: a step that changes lanes) or across
                  (right edge to left edge on one line; a zig when the two
                  sit on different lines because a row wrapped)
   data-route-m   the route to use at 900px and under
   data-wd        seconds the light takes to run the wire (default 0.7)
   data-via       a label that sits on the wire ("Say nothing for 7 days")
   data-via-ico   the icon name beside it
   A .dg-coin with data-t fills in at that second. A .dg-strike with data-t
   draws its line across its plate. An element with data-t and data-n
   shows no number until data-t, then counts from 0 up to data-n over
   data-d seconds (default 0.7), written with textContent only. data-n
   holds the final number, and so does the
   element's own text, which is the finished picture: the count rewrites
   the text only while a play runs, and every way out of a play (the end,
   reduced motion, any fallback) writes data-n back exactly.

   A DIAGRAM WHOSE NUMBERS ARRIVE LATE carries data-dg-wait on its section:
     <section class="dg" data-diagram data-dg-wait id="x">...</section>
   This file leaves it alone at load: nothing measured, dimmed or played,
   so it is only its markup (which the page keeps hidden until its data is
   in). Once the page has written every number (text and data-n) and shown
   the diagram, it calls, once:
     window.FADiagram.start(document.getElementById("x"))
   That measures the diagram where it now sits and schedules it like any
   other: finished at once under reduced motion or with no
   IntersectionObserver, frozen under ?t, otherwise armed and played as it
   scrolls into view. If it cannot be set up (no SVG geometry) it is left
   on its markup, and a throw is handled as in HOW IT FAILS below; either
   way the page's own numbers stand.

   Three forms are layout only (css/diagrams.css) and ride the same contract:
     .dg-lanes on the section, .dg-lane-l and .dg-lane-r on its steps: two
       lanes, you on the left and the agent on the right, joined by zig
       wires; on a phone one column, joined by drop wires on the rail.
     .dg-tiers holding .dg-tier-row nodes, each a .dg-tier-head, a
       .dg-graph of .dg-mini nodes joined by across wires, and a .dg-forge;
       .is-claim on the weakest row and its one mini.
     A record drawn as a tree: a .dg-root step, then .dg-cols holding one
       .dg-tree per branch, each a .dg-group-head (zig from the root; drop
       on a phone) over .dg-counts of .dg-leaf nodes (rail from the head),
       each leaf a number (.n, data-n) and its label (.l); .is-zero on a
       leaf whose number is 0. Side by side on a computer, stacked on a
       phone. .dg-three on a .dg-nopes gives three refusal plates a row.

   A GUIDE AGENT sits in a step's plate:
     <span class="dg-plate is-bot"><span class="dg-bot" data-shape="droid"
       data-colour="c9" data-face="eyes"><span class="ico" data-ico="..."></span></span></span>
   Until an agent is drawn the plate is an ordinary plate showing that
   icon, which is also its picture when the avatar core never loads. The
   agent is mounted through FABots.mount (js/bots.js), which draws it
   still under reduced motion and animates it on the core's shared ticker
   otherwise, so an agent never starts a frame loop of its own. This file
   never loads the core. A page whose agents should be alive at first view
   loads the vendored core and bots.js before this file, as /how does; on
   any other page the plates keep their icon until the core arrives (the
   office footer fetches it when the footer comes near), and the agents
   are mounted then.

   A NODE WAITING TO ARRIVE STAYS READABLE. Its surface (fill, rim, plate,
   coins) is dimmed and its text sits at --fg-3, which clears AA on every
   surface a diagram sits on; on arrival the surface comes up and the text
   brightens to its own colour. No word is ever faded by opacity, so a reader
   who scrolls ahead of the play reads every word at full contrast.

   HOW IT FAILS. The finished diagram is the markup's default: nothing is
   dimmed until a play is about to run. So no script, reduced motion, no
   IntersectionObserver, printing, and a browser with no SVG geometry (jsdom)
   all show the complete picture, the last with no wires, in which case every
   ending card states its condition in its own text. A throw anywhere in
   setup or in a frame puts every diagram back on its finished picture, with
   no wire left half built, and is then reported as an uncaught error.

   ONE FRAME LOOP FOR THE PAGE (DESIGN.md 6). When the vendored avatar core
   is on the page (the office footer loads it once the footer is near), the
   play rides the core's shared ticker. Before that it runs its own frame,
   and hands over at the next frame once the core arrives. Either way the
   loop stops when nothing is playing.

   TEST HOOKS. ?still shows every diagram's finished picture. ?t=<seconds>
   freezes every diagram at that many seconds into its own play (a
   data-dg-wait diagram from the moment it is started). Neither is a
   reader-facing feature.

   Only transform and opacity move, plus colour on arrival, a stroke
   offset on the wires and the digits of a count. */

(function () {
  "use strict";

  var SVGNS = "http://www.w3.org/2000/svg";
  var params = new URLSearchParams(window.location.search);
  var forceStill = params.has("still");
  var freezeAt = params.has("t") ? parseFloat(params.get("t")) : null;
  var reduceQ = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var narrowQ = window.matchMedia ? window.matchMedia("(max-width: 900px)") : null;
  var GHOST = 0.2;       // how strong a waiting node's surface is; never its text
  var models = [];
  var raf = 0, lastTs = 0, unsub = null;

  function reduced() { return forceStill || !!(reduceQ && reduceQ.matches); }
  function narrow() { return !!(narrowQ && narrowQ.matches); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function win(a, b, t) { return clamp((t - a) / (b - a), 0, 1); }
  function easeOut(u) { return 1 - Math.pow(1 - u, 3); }
  function easeInOut(u) { return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; }
  function each(list, fn) { Array.prototype.forEach.call(list, fn); }
  function attrNum(el, name, dflt) { var v = parseFloat(el.getAttribute(name)); return isNaN(v) ? dflt : v; }
  function svgEl(tag, cls, parent) {
    var e = document.createElementNS(SVGNS, tag);
    if (cls) e.setAttribute("class", cls);
    if (parent) parent.appendChild(e);
    return e;
  }

  /* ----------------------------------------------------------- building */

  function kindOf(e) {
    if (e.classList.contains("dg-coin")) return "dot";
    if (e.classList.contains("dg-strike")) return "strike";
    if (e.hasAttribute("data-n")) return "num";
    return "node";
  }

  function build(root) {
    var stage = root.querySelector(".dg-stage");
    if (!stage) return null;
    var m = {
      root: root, stage: stage, svg: null, items: [], wires: [], byId: {},
      T: 0, end: 0, playing: false, armed: false, done: false,
      replay: root.querySelector(".dg-replay")
    };
    models.push(m);
    each(stage.querySelectorAll("[data-id]"), function (e) { m.byId[e.getAttribute("data-id")] = e; });

    m.svg = svgEl("svg", "dg-wires");
    m.svg.setAttribute("aria-hidden", "true");
    stage.insertBefore(m.svg, stage.firstChild);

    each(stage.querySelectorAll("[data-t]"), function (e) {
      var it = { el: e, t: attrNum(e, "data-t", 0), kind: kindOf(e), key: null };
      if (it.kind === "strike") it.path = e.querySelector("path");
      if (it.kind === "num") {
        it.final = e.getAttribute("data-n");
        it.to = parseFloat(it.final);
        it.dur = attrNum(e, "data-d", 0.7);
      }
      m.items.push(it);

      var from = e.getAttribute("data-from");
      if (from && m.byId[from]) {
        var w = {
          from: m.byId[from], to: e, t1: it.t, dur: attrNum(e, "data-wd", 0.7),
          route: e.getAttribute("data-route") || "drop", routeM: e.getAttribute("data-route-m"),
          len: 0, key: null, via: null, pts: null
        };
        w.base = svgEl("path", "dg-wire-base", m.svg);
        w.line = svgEl("path", "dg-wire", m.svg);
        w.glow = svgEl("circle", "dg-head-glow", m.svg);
        w.head = svgEl("circle", "dg-head", m.svg);
        w.glow.setAttribute("r", "9");
        w.head.setAttribute("r", "3.5");
        w.glow.setAttribute("visibility", "hidden");
        w.head.setAttribute("visibility", "hidden");
        var label = e.getAttribute("data-via");
        if (label) {
          var v = document.createElement("span");
          v.className = "dg-via";
          v.setAttribute("aria-hidden", "true");
          var ico = e.getAttribute("data-via-ico");
          if (ico) { var s = document.createElement("span"); s.className = "ico"; s.setAttribute("data-ico", ico); v.appendChild(s); }
          v.appendChild(document.createTextNode(label));
          stage.appendChild(v);
          w.via = v;
        }
        m.wires.push(w);
      }
    });
    m.items.sort(function (a, b) { return a.t - b.t; });

    var last = 0;
    m.items.forEach(function (it) {
      var d = it.kind === "num" ? it.dur : it.kind === "dot" ? 0.35 : 0.9;
      if (it.t + d > last) last = it.t + d;
    });
    m.end = last + 0.8;
    return m;
  }

  /* Puts one diagram back on its finished picture: no wires, no labels on
     them, nothing dimmed, every count on its final number, no Replay. The
     markup's own default. */
  function unbuild(m) {
    m.playing = false;
    if (m.svg && m.svg.parentNode) m.svg.parentNode.removeChild(m.svg);
    m.wires.forEach(function (w) { if (w.via && w.via.parentNode) w.via.parentNode.removeChild(w.via); });
    m.items.forEach(function (it) {
      var s = it.el.style;
      ["transform", "--flash", "--g", "--c"].forEach(function (p) { s.removeProperty(p); });
      it.el.classList.remove("is-wait");
      if (it.path) it.path.style.removeProperty("stroke-dashoffset");
      if (it.kind === "num") it.el.textContent = it.final;
    });
    if (m.replay) m.replay.hidden = true;
  }

  /* Every failure lands here. The page is left complete, and a real throw is
     still reported rather than swallowed. */
  function abandon(err) {
    stopLoop();
    models.forEach(function (x) { try { unbuild(x); } catch (e) { /* keep going: the rest still come back */ } });
    models.length = 0;
    document.documentElement.classList.remove("dg-js");
    if (err) setTimeout(function () { throw err; }, 0);
  }

  /* ---------------------------------------------------------- measuring */

  function box(el, stage) {
    var x = 0, y = 0, e = el;
    while (e && e !== stage) { x += e.offsetLeft; y += e.offsetTop; e = e.offsetParent; }
    return { x: x, y: y, w: el.offsetWidth, h: el.offsetHeight };
  }

  var ROUTES = {
    drop: function (s, e, plx) { var x = s.x + plx; return [[x, s.y + s.h], [x, e.y]]; },
    fan: function (s, e) {
      var x0 = s.x + s.w, xt = x0 + 17, y0 = s.y + s.h / 2, y1 = e.y + e.h / 2;
      return [[x0, y0], [xt, y0], [xt, y1], [e.x, y1]];
    },
    rail: function (s, e, plx) {
      var x = s.x + plx, y1 = e.y + Math.min(e.h / 2, 27);
      return [[x, s.y + s.h], [x, y1], [e.x, y1]];
    },
    zig: function (s, e) {
      var x0 = s.x + s.w / 2, x1 = e.x + e.w / 2, y0 = s.y + s.h, y1 = e.y, ym = (y0 + y1) / 2;
      return [[x0, y0], [x0, ym], [x1, ym], [x1, y1]];
    },
    across: function (s, e) {
      var sy = s.y + s.h / 2, ey = e.y + e.h / 2;
      if (Math.abs(sy - ey) > 12) return ROUTES.zig(s, e);
      return [[s.x + s.w, sy], [e.x, ey]];
    }
  };

  function dist(a, b) { return Math.hypot(b[0] - a[0], b[1] - a[1]); }
  function simplify(pts) {
    var out = [pts[0]];
    for (var i = 1; i < pts.length; i++) { if (dist(out[out.length - 1], pts[i]) > 0.5) out.push(pts[i]); }
    return out;
  }
  function poly(pts, r) {
    var d = "M" + pts[0][0].toFixed(1) + " " + pts[0][1].toFixed(1);
    for (var i = 1; i < pts.length - 1; i++) {
      var p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
      var l1 = dist(p0, p1), l2 = dist(p1, p2), rr = Math.min(r, l1 / 2, l2 / 2);
      var ax = p1[0] + (p0[0] - p1[0]) * rr / l1, ay = p1[1] + (p0[1] - p1[1]) * rr / l1;
      var bx = p1[0] + (p2[0] - p1[0]) * rr / l2, by = p1[1] + (p2[1] - p1[1]) * rr / l2;
      d += " L" + ax.toFixed(1) + " " + ay.toFixed(1) + " Q" + p1[0].toFixed(1) + " " + p1[1].toFixed(1) + " " + bx.toFixed(1) + " " + by.toFixed(1);
    }
    var q = pts[pts.length - 1];
    return d + " L" + q[0].toFixed(1) + " " + q[1].toFixed(1);
  }

  /* Where a wire's label sits. On a phone only a drop keeps its label (the
     cards under a fan say "If you ..." themselves), and it goes just above
     the step the wire lands on, to the right of the rail. On a zig it sits
     on the run across between the two lanes, starting just right of its
     middle, as a label on a drop does. */
  function viaAt(name, pts, nar, e) {
    var n = pts.length;
    if (nar) return { x: pts[0][0] + 14, y: e.y - 28, left: true };
    if (name === "fan" || name === "across") {
      var a = pts[n - 2], b = pts[n - 1];
      return { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 };
    }
    if (name === "zig" && n >= 3) {
      var za = pts[1], zb = pts[2];
      return { x: (za[0] + zb[0]) / 2, y: (za[1] + zb[1]) / 2 };
    }
    var a2 = pts[0], b2 = pts[1] || pts[0];
    return { x: (a2[0] + b2[0]) / 2, y: (a2[1] + b2[1]) / 2 };
  }

  /* Returns false when the browser has no SVG geometry to measure a wire
     with, which is the caller's cue to leave the diagram finished. */
  function measure(m) {
    if (m.wires.length && typeof m.wires[0].line.getTotalLength !== "function") return false;
    var st = m.stage, sw = st.offsetWidth, sh = st.offsetHeight;
    m.svg.setAttribute("width", sw);
    m.svg.setAttribute("height", sh);
    m.svg.setAttribute("viewBox", "0 0 " + sw + " " + sh);
    var plx = parseFloat(getComputedStyle(m.root).getPropertyValue("--dg-plx")) || 34;
    var nar = narrow();
    m.wires.forEach(function (w) {
      var s = box(w.from, st), e = box(w.to, st);
      var name = nar && w.routeM ? w.routeM : w.route;
      var pts = simplify((ROUTES[name] || ROUTES.drop)(s, e, plx));
      w.pts = pts;
      var d = poly(pts, 12);
      w.base.setAttribute("d", d);
      w.line.setAttribute("d", d);
      w.len = w.line.getTotalLength() || 0;
      w.line.style.strokeDasharray = w.len + " " + w.len;
      w.key = null;
      if (w.via) {
        var at = viaAt(name, pts, nar, e);
        w.via.style.left = at.x.toFixed(1) + "px";
        w.via.style.top = at.y.toFixed(1) + "px";
        w.via.classList.toggle("is-left", !!at.left);
        w.via.classList.toggle("is-drop", name === "drop" || name === "zig");
        w.viaKey = null;
      }
    });
    return true;
  }

  /* ------------------------------------------------------------- drawing
     Every function here is pure in T. The last value written is remembered
     so a paused diagram costs nothing per frame. The key is exact at both
     ends (see keyOf): a value rounded to "1.000" while it is still 0.9999
     would cache as finished and skip the frame that actually finishes. */

  function keyOf(p) { return p >= 1 ? "end" : p <= 0 ? "start" : p.toFixed(3); }

  function drawNode(it, T) {
    var p = easeOut(win(it.t, it.t + 0.5, T));
    var f = win(it.t, it.t + 1.0, T);
    var flash = f > 0 && f < 1 ? Math.sin(Math.PI * f) : 0;
    var key = keyOf(p) + "|" + keyOf(f);
    if (it.key === key) return;
    it.key = key;
    var s = it.el.style;
    if (p >= 1 && flash === 0) {
      s.transform = ""; s.removeProperty("--flash"); s.removeProperty("--g");
      it.el.classList.remove("is-wait");
      return;
    }
    it.el.classList.toggle("is-wait", p < 1);
    s.setProperty("--g", (GHOST + (1 - GHOST) * p).toFixed(3));
    s.transform = "translateY(" + ((1 - p) * 10).toFixed(2) + "px)";
    s.setProperty("--flash", flash.toFixed(3));
  }

  function drawDot(it, T) {
    var p = win(it.t, it.t + 0.3, T);
    var key = keyOf(p);
    if (it.key === key) return;
    it.key = key;
    var s = it.el.style;
    if (p >= 1) { s.removeProperty("--c"); s.transform = ""; return; }
    s.setProperty("--c", easeOut(p).toFixed(3));
    s.transform = "scale(" + (1 + 0.35 * Math.sin(Math.PI * p)).toFixed(3) + ")";
  }

  function drawStrike(it, T) {
    var p = easeOut(win(it.t, it.t + 0.45, T));
    var key = keyOf(p);
    if (it.key === key || !it.path) return;
    it.key = key;
    if (p >= 1) { it.path.style.removeProperty("stroke-dashoffset"); return; }
    it.path.style.strokeDashoffset = (1 - p).toFixed(3);
  }

  /* A count climbs from 0 in whole steps, eased so it settles rather than
     stops, and ends on data-n exactly as the page wrote it. Until its
     count begins it shows no number at all: a leaf still waiting would
     otherwise read "0" to anyone who scrolls ahead of the play, which is
     a number the record does not hold. Only the text changes, so the
     number sits in the same box the whole way. */
  function drawNum(it, T) {
    var p = easeOut(win(it.t, it.t + it.dur, T));
    var txt = T < it.t ? "" : p >= 1 ? it.final : String(Math.round(it.to * p));
    if (it.key === txt) return;
    it.key = txt;
    it.el.textContent = txt;
  }

  /* A label waits on the wire's grey track at --fg-3 with its rim dimmed,
     and comes up with its wire. Like a node, it never fades its text. */
  function drawWire(w, T) {
    var p = easeInOut(win(w.t1 - w.dur, w.t1, T));
    var key = keyOf(p) + "|" + w.len.toFixed(0);
    if (w.key !== key) {
      w.key = key;
      w.line.style.strokeDashoffset = p >= 1 ? "0" : (w.len * (1 - p)).toFixed(1);
      if (p > 0 && p < 1 && w.len > 1) {
        var pt = w.line.getPointAtLength(w.len * p);
        w.head.setAttribute("cx", pt.x.toFixed(1)); w.head.setAttribute("cy", pt.y.toFixed(1));
        w.glow.setAttribute("cx", pt.x.toFixed(1)); w.glow.setAttribute("cy", pt.y.toFixed(1));
        w.head.setAttribute("visibility", "visible"); w.glow.setAttribute("visibility", "visible");
      } else {
        w.head.setAttribute("visibility", "hidden"); w.glow.setAttribute("visibility", "hidden");
      }
    }
    if (w.via) {
      var a = easeOut(win(w.t1 - w.dur * 0.75, w.t1 - w.dur * 0.35, T));
      var k = keyOf(a);
      if (w.viaKey !== k) {
        w.viaKey = k;
        var vs = w.via.style;
        if (a >= 1) { w.via.classList.remove("is-wait"); vs.removeProperty("--rise"); vs.removeProperty("--g"); }
        else {
          w.via.classList.add("is-wait");
          vs.setProperty("--g", (GHOST + (1 - GHOST) * a).toFixed(3));
          vs.setProperty("--rise", ((1 - a) * 6).toFixed(2) + "px");
        }
      }
    }
  }

  function draw(m, T) {
    m.T = T;
    m.items.forEach(function (it) {
      if (it.kind === "node") drawNode(it, T);
      else if (it.kind === "dot") drawDot(it, T);
      else if (it.kind === "num") drawNum(it, T);
      else drawStrike(it, T);
    });
    m.wires.forEach(function (w) { drawWire(w, T); });
  }

  /* ------------------------------------------------------------ playing */

  function arm(m) {
    if (m.armed) return;
    m.armed = true;
    draw(m, 0);
    if (m.replay) m.replay.hidden = true;
  }

  function finish(m) {
    m.playing = false;
    m.done = true;
    draw(m, m.end + 10);
    if (m.replay && !reduced()) m.replay.hidden = false;
  }

  function play(m) {
    if (reduced()) { finish(m); return; }
    m.armed = false;
    arm(m);
    m.done = false;
    m.playing = true;
    startLoop();
  }

  /* Wait for the next node to come into view before the clock moves on, so
     a tall diagram is never played to nobody. Scroll and it carries on. */
  function waiting(m) {
    for (var i = 0; i < m.items.length; i++) {
      var it = m.items[i];
      if (it.kind !== "node" || it.t < m.T - 0.05) continue;
      if (it.t > m.T + 1.2) return false;
      return it.el.getBoundingClientRect().top > window.innerHeight - 64;
    }
    return false;
  }

  /* One step of every playing diagram. Returns whether any still plays. */
  function step(dt) {
    var any = false;
    try {
      models.forEach(function (m) {
        if (!m.playing) return;
        if (!waiting(m)) m.T += dt;
        draw(m, m.T);
        if (m.T >= m.end) finish(m); else any = true;
      });
    } catch (e) {
      abandon(e);
      return false;
    }
    if (!any) stopLoop();
    return any;
  }

  function onShared(dt) { step(dt); }

  function frame(ts) {
    raf = 0;
    var dt = lastTs ? Math.min(0.12, (ts - lastTs) / 1000) : 0;   // a slow phone skips frames instead of playing in slow motion
    lastTs = ts;
    if (step(dt)) startLoop();
  }

  function startLoop() {
    if (unsub) return;
    var core = window.BotAvatars;
    if (core && typeof core.subscribeBotAvatarTicker === "function") {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      unsub = core.subscribeBotAvatarTicker(onShared);
      return;
    }
    if (!raf) { if (!lastTs) lastTs = 0; raf = requestAnimationFrame(frame); }
  }

  function stopLoop() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    lastTs = 0;
    if (unsub) { var u = unsub; unsub = null; u(); }
  }

  /* ------------------------------------------------------------- agents
     A guide agent is drawn by js/bots.js on the vendored core's shared
     ticker, still under reduced motion (bots.js reads the setting on every
     frame and follows it both ways). This file only asks for it, and never
     schedules a frame on its behalf. Until the core and bots.js are both
     on the page, and in a DOM that cannot draw at all, the plate keeps its
     icon. */

  var BOT_SIZE = 48;
  var botWait = null;

  function canDrawBots() {
    return !!(window.FABots && typeof window.FABots.mount === "function" && window.BotAvatars &&
      typeof window.CanvasRenderingContext2D === "function" && typeof window.Path2D === "function");
  }

  function mountBots() {
    each(document.querySelectorAll("[data-diagram] .dg-bot[data-shape]"), function (host) {
      if (host.__faBot) return;
      var spec = {
        shape: host.getAttribute("data-shape"),
        face: host.getAttribute("data-face") || "eyes",
        colour: host.getAttribute("data-colour") || "c1"
      };
      window.FABots.mount(host, "diagram-guide-" + spec.shape, { spec: spec, size: BOT_SIZE, follow: false, flips: false, still: forceStill });
      if (host.querySelector("canvas") && host.parentNode) host.parentNode.classList.add("has-bot");
    });
  }

  /* Mount now if the core is here. If not, listen for scripts arriving
     (office.js adds the core and bots.js to <head> when the footer comes
     near) and mount once both have loaded. A script's load event does not
     bubble, so the listener is on the capture phase. */
  function whenBots() {
    if (!document.querySelector("[data-diagram] .dg-bot[data-shape]")) return;
    if (canDrawBots()) { mountBots(); return; }
    if (botWait) return;
    botWait = function () {
      if (!canDrawBots()) return;
      document.removeEventListener("load", botWait, true);
      botWait = null;
      try { mountBots(); } catch (e) { setTimeout(function () { throw e; }, 0); }
    };
    document.addEventListener("load", botWait, true);
  }

  /* --------------------------------------------------------------- start */

  function schedule(list) {
    if (freezeAt !== null && !isNaN(freezeAt)) {
      list.forEach(function (m) { m.armed = true; draw(m, clamp(freezeAt, 0, m.end + 10)); if (m.replay) m.replay.hidden = true; });
    } else if (reduced() || !window.IntersectionObserver) {
      list.forEach(finish);
    } else {
      /* Arm every diagram now, so one that is not on screen yet waits
         dimmed instead of sitting fully lit until it scrolls into view and
         then snapping dim to play. */
      list.forEach(arm);
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          io.unobserve(en.target);
          models.forEach(function (m) { if (m.root === en.target) play(m); });
        });
      }, { rootMargin: "0px 0px 120px 0px", threshold: 0 });
      list.forEach(function (m) { io.observe(m.root); });
    }
  }

  var rt = 0;
  function again() {
    clearTimeout(rt);
    rt = setTimeout(function () {
      try {
        models.forEach(function (m) {
          measure(m);
          m.wires.forEach(function (w) { w.key = null; });
          draw(m, m.done || !m.armed ? m.end + 10 : m.T);
        });
      } catch (e) { abandon(e); }
    }, 120);
  }

  /* What every set-up diagram gets: a re-measure when its stage changes
     size, and its Replay. */
  function watch(m) {
    if (window.ResizeObserver) new ResizeObserver(again).observe(m.stage);
    if (m.replay) m.replay.addEventListener("click", function () { if (models.indexOf(m) >= 0) play(m); });
  }

  /* Sets up the diagrams in list, all or none: on a browser with no SVG
     geometry they are left on their markup, and a throw puts every diagram
     back on its finished picture. */
  function setUp(list) {
    try {
      list.forEach(function (root) { build(root); });
      var fresh = models.filter(function (m) { return list.indexOf(m.root) >= 0; });
      if (!fresh.length) return;
      if (!fresh.every(measure)) { abandon(null); return; }
      if (window.FAIcon) window.FAIcon.paint();
      document.documentElement.classList.add("dg-js");
      fresh.forEach(watch);
      schedule(fresh);
    } catch (e) {
      abandon(e);
    }
  }

  var ready = false, queued = [];

  /* The one public call (see THE MARKUP CONTRACT): starts a data-dg-wait
     diagram once its page has written its numbers. */
  function start(root) {
    if (!root || typeof root.hasAttribute !== "function" || !root.hasAttribute("data-dg-wait")) return;
    if (!ready) { if (queued.indexOf(root) < 0) queued.push(root); return; }
    for (var i = 0; i < models.length; i++) { if (models[i].root === root) return; }
    setUp([root]);
  }
  window.FADiagram = { start: start };

  function init() {
    /* The agents first, on their own: the finished picture shows them too,
       so a diagram that falls back below still gets its agents. A drawn
       agent's plate keeps the box an icon plate has, so nothing measured
       below moves. */
    try { whenBots(); } catch (e) { setTimeout(function () { throw e; }, 0); }
    setUp(Array.prototype.filter.call(document.querySelectorAll("[data-diagram]"), function (r) { return !r.hasAttribute("data-dg-wait"); }));

    window.addEventListener("resize", again);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(again);
    if (reduceQ && reduceQ.addEventListener) {
      reduceQ.addEventListener("change", function () { if (reduced()) models.forEach(finish); });
    }
    ready = true;
    queued.splice(0).forEach(start);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
