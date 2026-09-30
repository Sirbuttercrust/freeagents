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
                  along a trunk) or rail (the phone form of fan)
   data-route-m   the route to use at 900px and under
   data-wd        seconds the light takes to run the wire (default 0.7)
   data-via       a label that sits on the wire ("Say nothing for 7 days")
   data-via-ico   the icon name beside it
   A .dg-coin with data-t fills in at that second. A .dg-strike with data-t
   draws its line across its plate.

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
   freezes every diagram at that many seconds into its own play. Neither is a
   reader-facing feature.

   Only transform and opacity move, plus colour on arrival and a stroke
   offset on the wires. */

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
      var d = it.kind === "dot" ? 0.35 : 0.9;
      if (it.t + d > last) last = it.t + d;
    });
    m.end = last + 0.8;
    return m;
  }

  /* Puts one diagram back on its finished picture: no wires, no labels on
     them, nothing dimmed, no Replay. The markup's own default. */
  function unbuild(m) {
    m.playing = false;
    if (m.svg && m.svg.parentNode) m.svg.parentNode.removeChild(m.svg);
    m.wires.forEach(function (w) { if (w.via && w.via.parentNode) w.via.parentNode.removeChild(w.via); });
    m.items.forEach(function (it) {
      var s = it.el.style;
      ["transform", "--flash", "--g", "--c"].forEach(function (p) { s.removeProperty(p); });
      it.el.classList.remove("is-wait");
      if (it.path) it.path.style.removeProperty("stroke-dashoffset");
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
     the step the wire lands on, to the right of the rail. */
  function viaAt(name, pts, nar, e) {
    var n = pts.length;
    if (nar) return { x: pts[0][0] + 14, y: e.y - 28, left: true };
    if (name === "fan") {
      var a = pts[n - 2], b = pts[n - 1];
      return { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 };
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
        w.via.classList.toggle("is-drop", name === "drop");
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

  /* --------------------------------------------------------------- start */

  function schedule() {
    if (freezeAt !== null && !isNaN(freezeAt)) {
      models.forEach(function (m) { m.armed = true; draw(m, clamp(freezeAt, 0, m.end + 10)); if (m.replay) m.replay.hidden = true; });
    } else if (reduced() || !window.IntersectionObserver) {
      models.forEach(finish);
    } else {
      /* Arm every diagram now, so one that is not on screen yet waits
         dimmed instead of sitting fully lit until it scrolls into view and
         then snapping dim to play. */
      models.forEach(arm);
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          io.unobserve(en.target);
          models.forEach(function (m) { if (m.root === en.target) play(m); });
        });
      }, { rootMargin: "0px 0px 120px 0px", threshold: 0 });
      models.forEach(function (m) { io.observe(m.root); });
    }
  }

  function init() {
    try {
      each(document.querySelectorAll("[data-diagram]"), build);
      if (!models.length) return;
      if (!models.every(measure)) { abandon(null); return; }
      if (window.FAIcon) window.FAIcon.paint();
      document.documentElement.classList.add("dg-js");
      schedule();
    } catch (e) {
      abandon(e);
      return;
    }

    var rt = 0;
    var again = function () {
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
    };
    window.addEventListener("resize", again);
    if (window.ResizeObserver) models.forEach(function (m) { new ResizeObserver(again).observe(m.stage); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(again);

    models.forEach(function (m) {
      if (m.replay) m.replay.addEventListener("click", function () { if (models.indexOf(m) >= 0) play(m); });
    });
    if (reduceQ && reduceQ.addEventListener) {
      reduceQ.addEventListener("change", function () { if (reduced()) models.forEach(finish); });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
