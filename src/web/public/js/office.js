/* The office footer: agents at their desks, one walking between the
   whiteboard, a teammate's screen and the coffee machine.

   Built on the same bots every page draws (bots.js over the vendored
   bot-avatars core, MIT). The desks, screens, board and props are plain
   DOM and CSS, drawn here, so the scene costs one small script and no
   images.

   Three compositions, picked by the width the scene gets, each drawn on
   its own design width and scaled down uniformly when the space is
   narrower (never squashed):
     wide    1180 px: two desks, the whiteboard, the pair desk, coffee
     medium   760 px: the whiteboard, the pair desk, coffee
     small    420 px: the pair desk and coffee
   Everything in a scene is a pure function of one loop clock, so the loop
   has no seam and a paused scene resumes where it was.

   Motion: the loop runs only while the scene is on screen and the tab is
   visible, at 30 frames a second. Under prefers-reduced-motion it draws one
   composed still frame and nothing moves. The setting is followed live.

   Ported from the design board (look/shared/office.js) into the site
   (DESIGN.md 6.1). Two changes from the board: every colour is a token
   (office.css), and a page with no bots.js, or a DOM with no 2D canvas,
   gets the still room with no loop rather than an exception.

   Pages that draw no other bot do not load the avatar engine up front
   (the polished-page script lists hold them to that). On those pages this
   script fetches the vendored core and bots.js itself, once, when the
   footer comes within a screen of the viewport, and builds the room then.
   A page that already loads them pays nothing extra. */
(function (global) {
  "use strict";

  var ENGINE = ["/js/vendor/bot-avatars/bot-avatars.js", "/js/bots.js"];
  function whenEngine(done) {
    if (global.FABots) { done(); return; }
    var i = 0;
    (function next() {
      if (i >= ENGINE.length) { if (global.FABots) done(); return; }
      var src = ENGINE[i++];
      if (src === ENGINE[0] && global.BotAvatars) { next(); return; }
      var s = document.createElement("script");
      s.src = src;
      s.async = false;
      s.onload = next;
      document.head.appendChild(s);
    })();
  }
  function whenNear(root, done) {
    if (typeof IntersectionObserver !== "function") { done(); return; }
    var io = new IntersectionObserver(function (entries) {
      if (entries[entries.length - 1].isIntersecting) { io.disconnect(); done(); }
    }, { rootMargin: "100% 0px" });
    io.observe(root);
  }

  var B = null;
  var CAN_DRAW = typeof global.CanvasRenderingContext2D === "function";

  var FLOOR = 30;          // design px from the scene's bottom to the floor line
  var SEAT = 42;           // a seated body's bottom, above the floor line
  var LANE = 8;            // the front lane: standing bodies sit this far in front of the desks
  var SEAT_Y = SEAT + LANE; // a walker's lift when it sits down
  var FPS = 30;

  var SPECS = {
    lead:     { shape: "blob",   face: "eyes",  colour: "c11" },
    typistA:  { shape: "clover", face: "eyes",  colour: "c8" },
    pairSeat: { shape: "square", face: "mouth", colour: "c9" },
    helper:   { shape: "star",   face: "eyes",  colour: "c6" },
    typistB:  { shape: "cat",    face: "eyes",  colour: "c4" }
  };

  /* ------------------------------------------------------------ layouts */

  var COMPS = {
    wide: {
      w: 1180, h: 250, min: 900, period: 30, still: 11.6,
      plant: 30,
      lamps: [138, 660, 880],
      clock: 520,
      desks: [
        { id: "A", x: 138, w: 140, monitor: { x: 104, w: 60, h: 42, kind: "typing" } },
        { id: "P", x: 660, w: 190, monitor: { x: 694, w: 82, h: 54, kind: "review" } },
        { id: "B", x: 876, w: 150, monitor: { x: 836, w: 60, h: 42, kind: "typing" }, mug: 940 }
      ],
      board: 330,
      coffee: 1128,
      seated: [
        { name: "typistA", x: 178, size: 78, look: [-0.9, 0.3] },
        { name: "pairSeat", x: 612, size: 80, look: [0.9, 0.3] }
      ],
      standing: [
        { name: "helper", x: 792, size: 72, look: [-0.9, 0.1] }
      ],
      walkers: [
        {
          name: "lead", size: 82,
          keys: [
            [0, 436, -1], [7, 436, -1],
            [10, 540, 1], [13, 540, 1],
            [18, 1060, 1], [21, 1060, 1],
            [27, 436, -1], [30, 436, -1]
          ],
          mug: [[7, 27.3]],
          nudge: [0.8, 1.9, 3.0, 4.2]
        },
        {
          name: "typistB", size: 76,
          keys: [
            [0, 900, -1, SEAT_Y, 2], [1.0, 900, 1, SEAT_Y, 2],
            [1.9, 990, 1, 0, 2], [2.0, 990, 1, 0, 6],
            [3.4, 1060, 1], [5.6, 1060, 1],
            [7.0, 990, -1, 0, 6], [7.1, 990, -1, 0, 2],
            [8.0, 900, -1, SEAT_Y, 2], [30, 900, -1, SEAT_Y, 2]
          ],
          mug: [[1.0, 8.0]],
          nudge: [4.4]
        }
      ],
      strokes: [0.8, 1.9, 3.0, 4.2], wipe: 28.2, reset: 29.7,
      trayMug: [[27.3, 30], [0, 7]],
      check: [[11, 20]],
      pokes: [[11.2, ["pairSeat", "helper", "lead"]]],
      deskMug: { B: [[8.0, 30], [0, 1.0]] },
      glance: [["typistA", 1.5, 5.5, [0.9, 0.1]], ["helper", 9.5, 13, [-1, 0.2]], ["pairSeat", 10, 13, [-0.9, 0.1]]]
    },
    medium: {
      w: 760, h: 250, min: 560, period: 30, still: 11.6,
      plant: 24,
      lamps: [440],
      clock: 290,
      desks: [
        { id: "P", x: 440, w: 190, monitor: { x: 474, w: 82, h: 54, kind: "review" } }
      ],
      board: 150,
      coffee: 706,
      seated: [{ name: "pairSeat", x: 392, size: 80, look: [0.9, 0.3] }],
      standing: [{ name: "helper", x: 572, size: 72, look: [-0.9, 0.1] }],
      walkers: [
        {
          name: "lead", size: 82,
          keys: [
            [0, 256, -1], [7, 256, -1],
            [10, 318, 1], [13, 318, 1],
            [18, 638, 1], [21, 638, 1],
            [27, 256, -1], [30, 256, -1]
          ],
          mug: [[7, 27.3]],
          nudge: [0.8, 1.9, 3.0, 4.2]
        }
      ],
      strokes: [0.8, 1.9, 3.0, 4.2], wipe: 28.2, reset: 29.7,
      trayMug: [[27.3, 30], [0, 7]],
      check: [[11, 20]],
      pokes: [[11.2, ["pairSeat", "helper", "lead"]]],
      deskMug: {},
      glance: [["helper", 9.5, 13, [-1, 0.2]], ["pairSeat", 10, 13, [-0.9, 0.1]]]
    },
    small: {
      w: 420, h: 226, min: 0, period: 20, still: 3,
      plant: null,
      lamps: [252],
      clock: null,
      desks: [
        { id: "P", x: 252, w: 180, monitor: { x: 284, w: 78, h: 52, kind: "review" }, mug: 334 }
      ],
      board: null,
      coffee: 40,
      seated: [{ name: "pairSeat", x: 206, size: 78, look: [0.9, 0.3] }],
      standing: [],
      walkers: [
        {
          name: "lead", size: 78,
          keys: [
            [0, 380, -1], [5, 380, -1],
            [8.5, 112, -1], [11.5, 112, -1],
            [15, 380, -1], [20, 380, -1]
          ],
          mug: [[4.9, 15.3]]
        }
      ],
      strokes: [], wipe: null, reset: null,
      trayMug: [],
      check: [[1.5, 12]],
      pokes: [[1.7, ["pairSeat", "lead"]]],
      deskMug: { P: [[15.3, 20], [0, 4.9]] },
      glance: [["pairSeat", 1.5, 4.5, [0.9, 0.1]]]
    }
  };

  function compFor(width) {
    if (width >= COMPS.wide.min) return "wide";
    if (width >= COMPS.medium.min) return "medium";
    return "small";
  }

  /* -------------------------------------------------------------- helpers */

  function el(tag, cls, parent, style) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (style) for (var k in style) n.style[k] = style[k];
    if (parent) parent.appendChild(n);
    return n;
  }
  function px(v) { return Math.round(v * 10) / 10 + "px"; }
  function inAny(t, spans) {
    if (!spans) return false;
    for (var i = 0; i < spans.length; i++) if (t >= spans[i][0] && t < spans[i][1]) return true;
    return false;
  }
  function easeInOut(u) { return 0.5 - 0.5 * Math.cos(Math.PI * u); }
  function toggle(node, cls, on) {
    if (!node) return;
    if (node.classList.contains(cls) !== on) node.classList.toggle(cls, on);
  }

  function svg(markup, cls, parent) {
    var holder = document.createElement("div");
    holder.innerHTML = markup;
    var s = holder.firstChild;
    if (cls) s.setAttribute("class", cls);
    parent.appendChild(s);
    return s;
  }

  var reduceQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  function reduced() { return !!(reduceQuery && reduceQuery.matches); }

  /* ------------------------------------------------------------- building */

  function buildDesk(room, d) {
    var desk = el("div", "desk", room, { left: px(d.x - d.w / 2), width: px(d.w), bottom: px(FLOOR) });
    el("div", "desk__top", desk);
    el("div", "desk__panel", desk);

    var m = d.monitor;
    var mon = el("div", "monitor", room, {
      left: px(m.x - m.w / 2), width: px(m.w), height: px(m.h + 10), bottom: px(FLOOR + 49)
    });
    var bezel = el("div", "monitor__bezel", mon, { height: px(m.h) });
    var screen = el("div", "monitor__screen " + (m.kind === "typing" ? "typing" : "review"), bezel);
    var widths = m.kind === "typing" ? [0.72, 0.5, 0.86, 0.38, 0.64] : [0.8, 0.55, 0.7, 0.45, 0.62];
    var rows = m.kind === "typing" ? (m.h > 44 ? 5 : 4) : 5;
    for (var i = 0; i < rows; i++) el("span", "code", screen).style.setProperty("--w", String(widths[i]));
    el("div", "monitor__stand", mon);
    el("div", "monitor__foot", mon);

    var check = null;
    if (m.kind === "review") {
      check = el("div", "check", screen);
      check.innerHTML = '<svg viewBox="0 0 26 26" aria-hidden="true"><circle class="check-disc" cx="13" cy="13" r="12"/><path class="check-tick" d="M7.5 13.5l3.6 3.6 7.4-8" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    var mug = null;
    if (d.mug != null) {
      mug = el("div", "mug", room, { left: px(d.mug - 5), bottom: px(FLOOR + 50), zIndex: "4" });
    }
    return { screen: screen, check: check, mug: mug };
  }

  function buildBoard(room, x) {
    var w = 138, faceH = 86, legs = 66;
    var board = el("div", "board", room, { left: px(x - w / 2), width: px(w), height: px(legs + faceH), bottom: px(FLOOR) });
    var face = el("div", "board__face", board, { height: px(faceH) });
    el("div", "board__legs", board, { position: "absolute", left: "0", right: "0", bottom: "0", height: px(legs) });
    el("div", "board__tray", board, { bottom: px(legs - 6) });
    var s = svg(
      '<svg viewBox="0 0 120 70" aria-hidden="true">' +
        '<path class="ink" pathLength="1" d="M8 20h26v24H8z M12 56c5-4 9 4 14 0s9 4 14 0"/>' +
        '<path class="ink" pathLength="1" d="M37 32h14 M46 27l5 5-5 5"/>' +
        '<path class="ink ink--2" pathLength="1" d="M55 20h26v24H55z M59 28h18 M59 35h12"/>' +
        '<path class="ink ink--3" pathLength="1" d="M85 32h8 M90 27l5 5-5 5 M103 33l4 5 9-12"/>' +
      "</svg>",
      null, face
    );
    var trayMug = el("div", "mug", room, { left: px(x + 34), bottom: px(FLOOR + legs - 6 + 4), zIndex: "3" });
    return { strokes: Array.prototype.slice.call(s.querySelectorAll(".ink")), trayMug: trayMug };
  }

  function buildCoffee(room, x) {
    el("div", "counter", room, { left: px(x - 32), bottom: px(FLOOR) });
    el("div", "machine", room, { left: px(x - 20), bottom: px(FLOOR + 44) });
    el("div", "steam", room, { left: px(x - 10), bottom: px(FLOOR + 82) });
  }

  function buildPlant(room, x) {
    var p = el("div", "plant", room, { left: px(x - 20), bottom: px(FLOOR) });
    p.innerHTML =
      '<svg viewBox="0 0 40 78" aria-hidden="true">' +
        '<g class="plant__leaves" fill="var(--o-leaf)">' +
          '<path d="M20 58C14 44 6 40 3 30c9 2 15 10 17 28z"/>' +
          '<path d="M20 58c2-18 6-30 16-36-1 12-7 24-16 36z"/>' +
          '<path d="M20 58C18 40 17 26 21 12c5 14 3 30-1 46z" opacity="0.85"/>' +
        "</g>" +
        '<path d="M9 56h22l-3 22H12z" fill="var(--o-pot)"/>' +
        '<rect x="7" y="54" width="26" height="5" rx="2" fill="var(--o-pot)"/>' +
      "</svg>";
  }

  function buildLamp(room, x) {
    var l = el("div", "lamp", room, { left: px(x) });
    el("div", "lamp__cord", l);
    el("div", "lamp__shade", l);
    el("div", "lamp__bulb", l);
    el("div", "lamp__cone", l);
  }

  function buildClock(room, x) {
    var c = el("div", "clock", room, { left: px(x - 16), bottom: px(FLOOR + 132) });
    c.innerHTML =
      '<svg viewBox="0 0 32 32" aria-hidden="true">' +
        '<circle cx="16" cy="16" r="14.5" fill="var(--o-bezel)" stroke="var(--o-board-frame)" stroke-width="2"/>' +
        '<line class="clock__h" x1="16" y1="16" x2="16" y2="9" stroke="var(--o-board)" stroke-width="2.2" stroke-linecap="round"/>' +
        '<line class="clock__m" x1="16" y1="16" x2="16" y2="5.5" stroke="var(--o-board)" stroke-width="1.5" stroke-linecap="round"/>' +
        '<circle cx="16" cy="16" r="1.6" fill="var(--o-ink-2)"/>' +
      "</svg>";
    return c;
  }

  function botHost(room, size, z) {
    var host = el("div", "bot-host", room, { width: px(size), height: px(size), zIndex: String(z) });
    var canvas = el("canvas", null, host);
    canvas.setAttribute("aria-hidden", "true");
    return { host: host, canvas: canvas };
  }

  function shadow(room, size) {
    return el("div", "floor-shadow", room, { width: px(size * 0.62), marginLeft: px(-size * 0.31), bottom: px(FLOOR - LANE - 3) });
  }

  /* ----------------------------------------------------------------- scene */

  function Scene(root) {
    this.root = root;
    this.comp = null;
    this.t = 0;
    this.running = false;
    this.onScreen = true;
    this.raf = 0;
    this.last = 0;
    this.acc = 0;
    this.bots = {};
    this.parts = null;
    var layout = this.layout.bind(this);
    var sync = this.sync.bind(this);
    var seen = function (entries) {
      this.onScreen = entries[entries.length - 1].isIntersecting;
      this.sync();
    }.bind(this);

    root.classList.add("office");
    this.room = el("div", "office__room", root);

    this.layout();
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(function () { layout(); }).observe(root);
    } else {
      global.addEventListener("resize", function () { layout(); });
    }
    if (typeof IntersectionObserver === "function") {
      new IntersectionObserver(seen, { rootMargin: "80px" }).observe(root);
    }
    document.addEventListener("visibilitychange", function () { sync(); });
    if (reduceQuery) {
      var onChange = function () { sync(true); };
      if (reduceQuery.addEventListener) reduceQuery.addEventListener("change", onChange);
      else if (reduceQuery.addListener) reduceQuery.addListener(onChange);
    }
    this.sync(true);
  }

  Scene.prototype.layout = function () {
    var width = this.root.clientWidth || 1;
    var name = compFor(width);
    var C = COMPS[name];
    var scale = Math.min(1, width / C.w);
    this.root.style.height = px(C.h * scale);
    this.root.style.setProperty("--floor", px(FLOOR * scale));
    this.room.style.width = px(C.w);
    this.room.style.height = px(C.h);
    this.room.style.left = "50%";
    this.room.style.transform = "translateX(-50%) scale(" + scale + ")";
    this.room.style.transformOrigin = "50% 100%";
    this.room.style.top = "auto";
    this.room.style.bottom = "0";
    if (name !== this.comp) {
      this.comp = name;
      this.build(C);
      this.apply(this.t, true);
    }
  };

  Scene.prototype.build = function (C) {
    var room = this.room;
    room.textContent = "";
    var parts = { desks: {}, strokes: [], trayMug: null, clock: null, walkers: [], statics: [] };
    var i;

    for (i = 0; i < C.lamps.length; i++) buildLamp(room, C.lamps[i]);
    if (C.clock != null) parts.clock = buildClock(room, C.clock);
    if (C.plant != null) buildPlant(room, C.plant);
    for (i = 0; i < C.desks.length; i++) parts.desks[C.desks[i].id] = buildDesk(room, C.desks[i]);
    if (C.board != null) {
      var b = buildBoard(room, C.board);
      parts.strokes = b.strokes;
      parts.trayMug = b.trayMug;
    }
    buildCoffee(room, C.coffee);

    var prev = this.bots;
    var bots = this.bots = {};
    function bot(name, size, z) {
      var h = botHost(room, size, z);
      var sim = prev[name] && prev[name].sim;
      if (!sim && !reduced()) {
        sim = B.sim(((B.hash(name) % 1000) / 1000));
        if (sim) sim.setJump({ every: 0 });
      }
      var rec = { name: name, spec: SPECS[name], size: size, host: h.host, canvas: h.canvas, sim: sim, look: [0, 0] };
      bots[name] = rec;
      return rec;
    }

    for (i = 0; i < C.seated.length; i++) {
      var s = C.seated[i];
      var rs = bot(s.name, s.size, 2);
      rs.host.style.left = px(s.x - s.size / 2);
      rs.host.style.bottom = px(FLOOR + SEAT - s.size * 0.204);
      rs.baseLook = s.look;
      parts.statics.push(rs);
    }
    for (i = 0; i < C.standing.length; i++) {
      var st = C.standing[i];
      var rst = bot(st.name, st.size, 6);
      rst.host.style.left = px(st.x - st.size / 2);
      rst.host.style.bottom = px(FLOOR - LANE - st.size * 0.204);
      rst.baseLook = st.look;
      var sh = shadow(room, st.size);
      sh.style.left = px(st.x);
      parts.statics.push(rst);
    }
    for (i = 0; i < C.walkers.length; i++) {
      var w = C.walkers[i];
      var rw = bot(w.name, w.size, 6);
      rw.host.style.left = "0";
      rw.host.style.bottom = px(FLOOR - LANE - w.size * 0.204);
      rw.host.style.transformOrigin = "50% 85%";
      rw.mugEl = el("div", "mug", rw.host, { left: "50%", bottom: px(w.size * 0.3), marginLeft: px(w.size * 0.3) });
      rw.shadowEl = shadow(room, w.size);
      rw.shadowEl.style.left = "0";
      rw.def = w;
      parts.walkers.push(rw);
    }
    this.parts = parts;
    this.C = C;
    this.pokedAt = -1;
  };

  /* Where a walker is at loop time t: x, lift above its standing line, the
     layer it is drawn on, the way it faces, and whether it is walking. */
  function walkerAt(keys, t) {
    var k0 = keys[0], k1 = keys[keys.length - 1];
    for (var i = 0; i < keys.length - 1; i++) {
      if (t >= keys[i][0] && t < keys[i + 1][0]) { k0 = keys[i]; k1 = keys[i + 1]; break; }
    }
    var y0 = k0[3] || 0, y1 = k1[3] || 0;
    var z = k0[4] || 6;
    var span = k1[0] - k0[0];
    var u = span > 0 ? (t - k0[0]) / span : 0;
    if (k0[1] === k1[1] && y0 === y1) {
      return { x: k0[1], y: y0, z: z, look: k0[2], walking: false, hop: 0 };
    }
    var e = easeInOut(u);
    var x = k0[1] + (k1[1] - k0[1]) * e;
    var y = y0 + (y1 - y0) * e;
    var hop = 0;
    if (y0 !== y1) {
      hop = Math.sin(Math.PI * u) * 16;
      return { x: x, y: y + hop, z: z, look: k1[1] >= k0[1] ? 1 : -1, walking: false, hop: hop };
    }
    return { x: x, y: y, z: z, look: k1[1] >= k0[1] ? 1 : -1, walking: true, dist: Math.abs(x - k0[1]), hop: 0 };
  }

  Scene.prototype.apply = function (t, still) {
    var C = this.C, P = this.parts, i;
    if (!C) return;

    // the whiteboard: strokes draw one by one, then the board is wiped
    if (P.strokes.length) {
      var wiped = t >= C.wipe && t < C.reset;
      var resetting = P.wasWiped && !wiped;
      if (resetting) P.strokes.forEach(function (s) { s.style.transition = "none"; });
      for (i = 0; i < P.strokes.length; i++) {
        toggle(P.strokes[i], "is-drawn", t >= C.strokes[i] && t < C.reset);
        toggle(P.strokes[i], "is-wiped", wiped);
      }
      if (resetting) {
        void P.strokes[0].getBoundingClientRect();
        P.strokes.forEach(function (s) { s.style.transition = ""; });
      }
      P.wasWiped = wiped;
    }
    toggle(P.trayMug, "is-on", inAny(t, C.trayMug));

    for (var id in P.desks) {
      var d = P.desks[id];
      if (d.check) {
        var on = inAny(t, C.check);
        toggle(d.check, "is-on", on);
        toggle(d.screen, "is-checked", on);
      }
      if (d.mug) toggle(d.mug, "is-on", inAny(t, C.deskMug[id]));
    }

    // gaze of the bots that stay put
    for (i = 0; i < P.statics.length; i++) {
      var sb = P.statics[i];
      var look = sb.baseLook;
      for (var g = 0; g < C.glance.length; g++) {
        var gl = C.glance[g];
        if (gl[0] === sb.name && t >= gl[1] && t < gl[2]) look = gl[3];
      }
      sb.look = look;
    }

    // walkers
    for (i = 0; i < P.walkers.length; i++) {
      var w = P.walkers[i];
      var st = walkerAt(w.def.keys, t);
      var bob = 0, lean = 0, sy = 1;
      if (st.walking && !still) {
        var phase = st.dist / 26;
        var s = Math.abs(Math.sin(Math.PI * phase));
        bob = s * 5;
        sy = 1 - 0.05 * Math.pow(1 - s, 6);
        lean = st.look * 4;
      }
      var nudge = w.def.nudge || [];
      for (var q = 0; q < nudge.length; q++) {
        var dtn = t - nudge[q];
        if (dtn >= 0 && dtn < 0.6 && !still) lean += st.look * 7 * Math.sin(Math.PI * dtn / 0.6);
      }
      var gl2 = null;
      for (var g2 = 0; g2 < C.glance.length; g2++) {
        if (C.glance[g2][0] === w.name && t >= C.glance[g2][1] && t < C.glance[g2][2]) gl2 = C.glance[g2][3];
      }
      w.look = gl2 || [st.look * 0.9, st.walking ? 0.05 : 0.2];
      w.host.style.zIndex = String(st.z);
      w.host.style.transform =
        "translate3d(" + px(st.x - w.size / 2) + "," + px(-(st.y + bob)) + ",0) rotate(" + lean.toFixed(2) + "deg) scaleY(" + sy.toFixed(3) + ")";
      var lifted = st.y + bob;
      var seatedish = st.z < 6;
      w.shadowEl.style.opacity = seatedish ? "0" : String(Math.max(0, 0.9 - lifted / 30));
      w.shadowEl.style.transform = "translateX(" + px(st.x) + ") scale(" + (1 - Math.min(0.4, lifted / 40)).toFixed(3) + ")";
      toggle(w.mugEl, "is-on", inAny(t, w.def.mug));
    }

    if (P.clock) {
      var now = new Date();
      var m = now.getMinutes(), h = now.getHours() % 12;
      P.clock.querySelector(".clock__m").setAttribute("transform", "rotate(" + (m * 6) + " 16 16)");
      P.clock.querySelector(".clock__h").setAttribute("transform", "rotate(" + (h * 30 + m / 2) + " 16 16)");
    }
  };

  Scene.prototype.firePokes = function (from, to) {
    var C = this.C;
    for (var i = 0; i < C.pokes.length; i++) {
      var pt = C.pokes[i][0];
      var crossed = from <= to ? (pt > from && pt <= to) : (pt > from || pt <= to);
      if (!crossed) continue;
      var names = C.pokes[i][1];
      for (var j = 0; j < names.length; j++) {
        var b = this.bots[names[j]];
        if (b && b.sim) b.sim.poke();
      }
    }
  };

  Scene.prototype.paint = function (dt) {
    for (var name in this.bots) {
      var b = this.bots[name];
      if (b.sim) {
        b.sim.setPointer(b.look[0], b.look[1], 0.85);
        b.sim.update(dt);
        B.paintPose(b.canvas, b.size, b.spec, b.sim.pose);
      } else {
        B.paintPose(b.canvas, b.size, b.spec, null, true);
      }
    }
  };

  Scene.prototype.sync = function (motionChanged) {
    var still = reduced();
    this.root.classList.toggle("is-live", !still);
    var want = !still && CAN_DRAW && !!(global.BotAvatars && global.BotAvatars.subscribeBotAvatarTicker) &&
      this.onScreen && document.visibilityState !== "hidden";
    this.root.classList.toggle("is-paused", !want);

    if (still) {
      this.stop();
      for (var n in this.bots) this.bots[n].sim = null;
      this.t = this.C ? this.C.still : 0;
      this.apply(this.t, true);
      this.paint(0);
      return;
    }
    if (motionChanged) {
      for (var n2 in this.bots) {
        var b = this.bots[n2];
        if (!b.sim) {
          b.sim = B.sim((B.hash(n2) % 1000) / 1000);
          if (b.sim) b.sim.setJump({ every: 0 });
        }
      }
    }
    if (want && !this.running) {
      /* One frame loop for the page (DESIGN.md 6): the scene subscribes to
         the vendored core's shared ticker, the same one every avatar on
         the page rides, rather than running a requestAnimationFrame of
         its own. It still paints at 30 fps by skipping ticks. */
      this.running = true;
      this.acc = 0;
      var BA = global.BotAvatars;
      this.unsub = BA.subscribeBotAvatarTicker(this.tick.bind(this));
    } else if (!want) {
      this.stop();
    }
  };

  Scene.prototype.tick = function (dt) {
    if (!this.running) return;
    this.acc += dt;
    if (this.acc < 1 / FPS) return;
    var frame = this.acc;
    this.acc = 0;
    var before = this.t;
    this.t = (this.t + frame) % this.C.period;
    this.firePokes(before, this.t);
    this.apply(this.t, false);
    this.paint(frame);
  };

  Scene.prototype.stop = function () {
    this.running = false;
    if (this.unsub) this.unsub();
    this.unsub = null;
  };

  function mount(root) {
    if (!root || root.__faOffice) return root && root.__faOffice;
    if (!B) B = global.FABots || null;
    if (!B) return null;
    root.__faOffice = new Scene(root);
    return root.__faOffice;
  }

  global.FAOffice = { mount: mount, COMPS: COMPS };

  function boot() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-office]"), function (root) {
      if (global.FABots) { mount(root); return; }
      whenNear(root, function () { whenEngine(function () { mount(root); }); });
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(typeof window !== "undefined" ? window : this);
