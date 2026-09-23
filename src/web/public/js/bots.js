/* FABots: the agent avatar on every page.

   An agent's avatar is a small glossy bot drawn by the vendored bot-avatars
   core (./vendor/bot-avatars/, MIT, window.BotAvatars). This file is the
   FreeAgents half: which bot a spec means, the palette, the DID default, and
   the one way every page mounts, animates and pauses one.

   WHAT A SPEC IS. { shape, face, colour }: one of 18 shapes, one of 2 faces,
   one of 12 colour KEYS (c1 to c12). Every agent response carries the
   resolved spec as `avatarSpec` (DATA-CONTRACT.md): the operator's choice if
   they made one, else the default derived from the DID. The default is
   derived here too, for a response that carries no spec, by the same
   function as src/domain/avatar-spec.ts's defaultAvatar: SHA-256 of the DID,
   byte 0 picks the shape, byte 1 the face, byte 2 the colour.
   tests/web/bots-client.test.ts runs this copy against AV1's own vectors and
   against the server's tables, so the two cannot drift apart silently.

   The avatar never carries identity on its own (ENT-2.3). Wherever one
   renders, the agent's name renders beside it, and the canvas is
   aria-hidden because that name already says who it is.

   MOTION. `working` only where a page knows the agent has a job in progress,
   `default` everywhere else, and never `sleeping`: this product does not say
   an agent is asleep. Under prefers-reduced-motion every bot is drawn once in
   the still pose of its state and nothing loops. The page follows the
   setting if it changes while open: tick() checks it every frame, so the
   switch to reduce lands on the next frame, and a media listener brings the
   bots back when it is turned off (tests/web/bots-motion.test.ts switches
   it both ways after load). A bot off screen, or inside a closed
   disclosure, stops its loop; the shared frame loop in the vendored core
   also stops while the tab is hidden. */
(function (global) {
  "use strict";

  /* The order IS the contract: defaultAvatar indexes into it by position,
     so reordering reassigns every agent's default. Same list, same order,
     as AVATAR_SHAPES in src/domain/avatar-spec.ts. */
  var SHAPES = [
    "clover", "flower", "triangle", "square", "blob", "ghost", "circle", "drop",
    "star", "droid", "mech", "alien", "hexagon", "cat", "cloud", "pill", "pebble", "puddle"
  ];
  var FACES = ["eyes", "mouth"];

  /* The palette. Identical to AVATAR_COLOURS in src/domain/avatar-spec.ts,
     and DESIGN.md 2.4 is where each value is justified. */
  var COLOURS = {
    c1: "#58B0E8", c2: "#46C39A", c3: "#E0A24E", c4: "#E4757F", c5: "#FF6A3D", c6: "#FFD32B",
    c7: "#9BE85A", c8: "#1CC4DA", c9: "#B06BFF", c10: "#F25CD4", c11: "#3D8BFF", c12: "#34C759"
  };
  var COLOUR_NAMES = {
    c1: "Sky", c2: "Jade", c3: "Amber", c4: "Rose", c5: "Vermilion", c6: "Yellow",
    c7: "Lime", c8: "Cyan", c9: "Violet", c10: "Orchid", c11: "Cobalt", c12: "Green"
  };
  var COLOUR_KEYS = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10", "c11", "c12"];
  var FACE_NAMES = { eyes: "Eyes", mouth: "Eyes and mouth" };

  /* ------------------------------------------------------------ SHA-256

     Synchronous, because a page mounts an avatar in the same breath it
     learns the DID. crypto.subtle is asynchronous and exists only in a
     secure context, which a LAN preview over plain http is not. */
  var K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function utf8(str) {
    if (typeof TextEncoder === "function") return new TextEncoder().encode(str);
    var bin = unescape(encodeURIComponent(str));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function sha256(str) {
    var msg = utf8(String(str));
    var len = msg.length;
    var total = ((len + 9 + 63) >> 6) << 6;
    var buf = new Uint8Array(total);
    buf.set(msg);
    buf[len] = 0x80;
    var bits = len * 8;
    buf[total - 4] = (bits >>> 24) & 255;
    buf[total - 3] = (bits >>> 16) & 255;
    buf[total - 2] = (bits >>> 8) & 255;
    buf[total - 1] = bits & 255;
    buf[total - 5] = Math.floor(len / 0x20000000) & 255;

    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Array(64);
    for (var off = 0; off < total; off += 64) {
      for (var t = 0; t < 16; t++) {
        var j = off + t * 4;
        w[t] = ((buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3]) | 0;
      }
      for (t = 16; t < 64; t++) {
        var a15 = w[t - 15], a2 = w[t - 2];
        var s0 = ((a15 >>> 7) | (a15 << 25)) ^ ((a15 >>> 18) | (a15 << 14)) ^ (a15 >>> 3);
        var s1 = ((a2 >>> 17) | (a2 << 15)) ^ ((a2 >>> 19) | (a2 << 13)) ^ (a2 >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var A = h[0], B = h[1], C = h[2], D = h[3], E = h[4], F = h[5], G = h[6], H = h[7];
      for (t = 0; t < 64; t++) {
        var S1 = ((E >>> 6) | (E << 26)) ^ ((E >>> 11) | (E << 21)) ^ ((E >>> 25) | (E << 7));
        var ch = (E & F) ^ (~E & G);
        var t1 = (H + S1 + ch + K256[t] + w[t]) | 0;
        var S0 = ((A >>> 2) | (A << 30)) ^ ((A >>> 13) | (A << 19)) ^ ((A >>> 22) | (A << 10));
        var maj = (A & B) ^ (A & C) ^ (B & C);
        var t2 = (S0 + maj) | 0;
        H = G; G = F; F = E; E = (D + t1) | 0; D = C; C = B; B = A; A = (t1 + t2) | 0;
      }
      h[0] = (h[0] + A) | 0; h[1] = (h[1] + B) | 0; h[2] = (h[2] + C) | 0; h[3] = (h[3] + D) | 0;
      h[4] = (h[4] + E) | 0; h[5] = (h[5] + F) | 0; h[6] = (h[6] + G) | 0; h[7] = (h[7] + H) | 0;
    }
    var out = new Uint8Array(32);
    for (var k = 0; k < 8; k++) {
      out[k * 4] = (h[k] >>> 24) & 255;
      out[k * 4 + 1] = (h[k] >>> 16) & 255;
      out[k * 4 + 2] = (h[k] >>> 8) & 255;
      out[k * 4 + 3] = h[k] & 255;
    }
    return out;
  }

  /* --------------------------------------------------------------- specs */

  function defaultAvatar(did) {
    var d = sha256(typeof did === "string" ? did : String(did));
    return {
      shape: SHAPES[d[0] % SHAPES.length],
      face: FACES[d[1] % FACES.length],
      colour: COLOUR_KEYS[d[2] % COLOUR_KEYS.length]
    };
  }

  function isValid(spec) {
    return !!spec && typeof spec === "object" &&
      SHAPES.indexOf(spec.shape) !== -1 &&
      FACES.indexOf(spec.face) !== -1 &&
      COLOUR_KEYS.indexOf(spec.colour) !== -1;
  }

  /* The spec a response carried if it is well formed, else the DID default.
     Never a spec outside the fixed sets. */
  function resolve(spec, did) {
    if (isValid(spec)) return { shape: spec.shape, face: spec.face, colour: spec.colour };
    return defaultAvatar(did);
  }

  /* FNV-1a, 32 bit. The hash the pages already key their identity banner
     tint on (--id-hue, one of the five --agent-* tokens), kept byte for
     byte so no banner changes colour when the old engine goes. */
  function hash(str) {
    var h = 0x811c9dc5;
    str = String(str);
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  /* ------------------------------------------------------------- drawing */

  var BA = global.BotAvatars || null;

  /* A DOM with no 2D canvas (jsdom in the web tests, a stripped embed) still
     gets the named host and its empty canvas. Calling getContext there logs
     a "not implemented" error on every mount, so ask once whether a 2D
     context can exist at all and skip the drawing when it cannot. */
  var CAN_DRAW = typeof global.CanvasRenderingContext2D === "function";
  function ctx2d(canvas) {
    return CAN_DRAW && canvas.getContext ? canvas.getContext("2d") : null;
  }

  /* How much of the host the body fills. The core draws on a canvas 1.5x
     the body with the body low in it, so a hop has room above. Here the
     canvas IS the host (every host is a fixed, clipped square or circle),
     the body is centred in it, and 0.74 keeps every one of the 18 outlines
     inside a circular host at rest, ears and antennae included. */
  var FILL = 0.74;
  var WORKING_FILL = 0.6;

  var paths = {};
  function pathFor(d) {
    if (typeof Path2D !== "function") return null;
    if (!paths[d]) paths[d] = new Path2D(d);
    return paths[d];
  }

  function colourOf(spec) { return COLOURS[spec.colour] || COLOURS.c1; }

  function cfgFor(spec) {
    if (!BA) return null;
    var preset = BA.botAvatarPresets[spec.shape];
    var path = pathFor(BA.botAvatarShapes[spec.shape]);
    if (!preset || !path) return null;
    var partsD = BA.botAvatarParts[spec.shape];
    var colour = colourOf(spec);
    var cfg = {
      path: path,
      face: spec.face,
      faceX: preset.faceX,
      faceY: preset.faceY,
      faceScale: preset.faceScale,
      color: colour,
      ink: BA.autoInk(colour),
      shading: "plastic",
      shadow: 0.35,
      highlight: 1.3,
      depth: 0.65,
      light: 265,
      rim: 0.5,
      spread: 1.55,
      typeKey: spec.shape,
      theme: "dark",
      still: false
    };
    if (partsD) cfg.parts = pathFor(partsD);
    return cfg;
  }

  var reduceQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  function reduced() { return !!(reduceQuery && reduceQuery.matches); }

  /* Paint one pose into a canvas that fills a host `size` css px square.
     A working bot hops, up to 26 body units on every third hop, so it is
     drawn smaller and lower to keep the whole arc inside a clipped host
     rather than let it leave the box and cross the text above. */
  function paintInto(canvas, size, pose, cfg, working) {
    if (!cfg || !size) return;
    var dpr = Math.min(2, (typeof devicePixelRatio === "number" && devicePixelRatio) || 1);
    var px = Math.max(1, Math.round(size * dpr));
    if (canvas.width !== px || canvas.height !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    var ctx = ctx2d(canvas);
    if (!ctx || !ctx.setTransform) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, px, px);
    var box = size * (working ? WORKING_FILL : FILL);
    var full = box * BA.BOT_AVATAR_OVERSCAN;
    var ox = size / 2 - full / 2;
    var oy = size / 2 - full / 2 - BA.BOT_AVATAR_RISE * box + (working ? size * 0.1 : 0);
    /* No cfg.dpr: the core then reads this transform back as its base,
       which carries the centring offset along with the device scale. */
    ctx.setTransform(dpr, 0, 0, dpr, ox * dpr, oy * dpr);
    BA.drawBotAvatarFrame(ctx, box, pose, cfg);
  }

  /* ------------------------------------------------------------ registry */

  var live = [];
  var observer = typeof IntersectionObserver === "function"
    ? new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          var bot = e.target.__faBot;
          if (!bot) return;
          bot.onScreen = e.isIntersecting;
          sync(bot);
        });
      })
    : null;

  function sizeOf(bot) {
    var w = bot.host.clientWidth;
    if (w > 0) bot.lastSize = w;
    return bot.lastSize || bot.size || 32;
  }

  /* A bot that is not moving is drawn in the rest pose of its state, never
     in whatever pose its sim was caught in: a switch to reduced motion must
     not freeze a bot mid-blink or mid-hop. */
  function paintBot(bot) {
    var moving = animating(bot);
    var pose = moving && bot.sim ? bot.sim.pose : BA.restPose(bot.state);
    bot.cfg.still = !moving;
    paintInto(bot.canvas, sizeOf(bot), pose, bot.cfg, bot.state === "working");
  }

  function animating(bot) {
    return !bot.still && !reduced() && bot.onScreen && bot.canvas.isConnected;
  }

  function tick(bot, dt) {
    if (!bot.canvas.isConnected) {
      forget(bot);
      return;
    }
    /* The frame path reads the setting itself rather than trusting the
       change event to arrive. In Chrome that event did not fire at all while
       bots held the frame loop (review round 1, emulated media switched after
       load), so every bot kept animating. Checking here costs one property
       read per bot per frame, and the first frame after the switch takes
       the bot off the loop and repaints it at rest. */
    if (reduced()) {
      sync(bot);
      return;
    }
    var s = bot.sim;
    var ptr = BA.botAvatarPointer;
    if (bot.follow && ptr && !isNaN(ptr.x)) {
      var r = bot.canvas.getBoundingClientRect();
      var unit = r.width * FILL || 1;
      var dx = (ptr.x - (r.left + r.width / 2)) / unit;
      var dy = (ptr.y - (r.top + r.height / 2)) / unit;
      var d = Math.sqrt(dx * dx + dy * dy);
      var pull = d < 1 ? 1 : d > 3 ? 0 : 1 - (d - 1) / 2;
      s.setPointer(dx / Math.max(1, d), dy / Math.max(1, d), pull);
    } else {
      s.setPointer(0, 0, 0);
    }
    s.update(dt);
    paintBot(bot);
  }

  function sync(bot) {
    if (animating(bot)) {
      if (!bot.sim) {
        bot.sim = new BA.BotAvatarSim(bot.seed, bot.state);
        /* The core's idle flip every eight seconds or so reads as fidgeting
           across a list of twenty cards. It stays on the one large avatar
           a page is about, and on the picker's preview. */
        bot.sim.setJump({ every: bot.flips ? 9 : 0 });
      }
      if (!bot.unsub) bot.unsub = BA.subscribeBotAvatarTicker(function (dt) { tick(bot, dt); });
    } else {
      if (bot.unsub) { bot.unsub(); bot.unsub = null; }
      paintBot(bot);
    }
    /* Whether this bot is on the frame loop right now. Read by the tests
       that prove an off-screen, reduced-motion or still bot costs nothing,
       and harmless to anything else. */
    if (bot.unsub) bot.host.setAttribute("data-avatar-live", "true");
    else bot.host.removeAttribute("data-avatar-live");
  }

  function forget(bot) {
    if (bot.unsub) { bot.unsub(); bot.unsub = null; }
    if (bot.host) bot.host.removeAttribute("data-avatar-live");
    if (observer) observer.unobserve(bot.canvas);
    var i = live.indexOf(bot);
    if (i !== -1) live.splice(i, 1);
  }

  /* The way back. Once reduced motion has taken every bot off the loop, no
     frame runs, so tick() cannot notice the setting being turned off again.
     This listener does: with the loop idle the change event is delivered.
     It also covers the forward switch on any browser that does deliver the
     event while frames are running. */
  if (reduceQuery) {
    var onMotionChange = function () { live.slice().forEach(sync); };
    if (reduceQuery.addEventListener) reduceQuery.addEventListener("change", onMotionChange);
    else if (reduceQuery.addListener) reduceQuery.addListener(onMotionChange);
  }

  if (typeof ResizeObserver === "function") {
    var resizer = new ResizeObserver(function (entries) {
      entries.forEach(function (e) {
        var bot = e.target.__faBot;
        if (bot && !bot.unsub) paintBot(bot);
      });
    });
  }

  /* Mount (or re-mount) the bot for `did` into `host`.

       opts.spec     the avatarSpec the response carried; resolved here, so a
                     missing or malformed one falls back to the DID default
       opts.state    "working" only when the page knows a job is in progress
       opts.size     css px, used until the host has been laid out
       opts.still    never animate (an operator's own mark, a thumbnail)
       opts.flips    allow the core's occasional idle flip
       opts.follow   eyes follow a nearby pointer (default true)

     A missing DID mounts nothing: an empty mount would be a face standing in
     for an identity nobody supplied. Returns the resolved spec, or null. */
  function mount(host, did, opts) {
    opts = opts || {};
    if (!host || typeof did !== "string" || did === "") return null;
    var spec = resolve(opts.spec, did);
    host.setAttribute("data-avatar", did);
    host.setAttribute("data-avatar-shape", spec.shape);
    host.setAttribute("data-avatar-face", spec.face);
    host.setAttribute("data-avatar-colour", spec.colour);
    host.removeAttribute("data-pending");

    var bot = host.__faBot;
    if (!bot || !bot.canvas.isConnected || bot.canvas.parentNode !== host) {
      if (bot) forget(bot);
      var canvas = document.createElement("canvas");
      canvas.className = "bot";
      canvas.setAttribute("aria-hidden", "true");
      canvas.style.display = "block";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      host.textContent = "";
      host.appendChild(canvas);
      bot = { host: host, canvas: canvas, sim: null, unsub: null, onScreen: !observer, lastSize: 0 };
      host.__faBot = bot;
      canvas.__faBot = bot;
    }
    var nextState = opts.state === "working" ? "working" : "default";
    bot.did = did;
    bot.spec = spec;
    bot.size = typeof opts.size === "number" ? opts.size : bot.size;
    bot.still = !!opts.still;
    bot.flips = !!opts.flips;
    bot.follow = opts.follow !== false;
    bot.seed = (hash(did) % 1000) / 1000;
    if (bot.sim && bot.state !== nextState) bot.sim.setState(nextState);
    bot.state = nextState;
    host.setAttribute("data-avatar-state", nextState);
    if (bot.still) host.setAttribute("data-avatar-still", "true");
    else host.removeAttribute("data-avatar-still");

    if (!BA) return spec;
    bot.cfg = cfgFor(spec);
    if (!bot.cfg) return spec;
    if (live.indexOf(bot) === -1) {
      live.push(bot);
      if (observer) observer.observe(bot.canvas);
      if (resizer) resizer.observe(host);
    }
    sync(bot);
    return spec;
  }

  /* A one-off still drawing, for the picker's shape tiles. */
  function still(canvas, spec, size) {
    if (!BA || !canvas) return;
    var cfg = cfgFor(spec);
    if (!cfg) return;
    cfg.still = true;
    paintInto(canvas, size, BA.restPose("default"), cfg, false);
  }

  /* A flat disc of one palette colour, for the picker's colour tiles. Drawn
     here so the palette's hex values live in the renderer and nowhere in a
     stylesheet (DESIGN.md 2.1). */
  function swatch(canvas, key, size) {
    if (!canvas || !COLOURS[key]) return;
    var dpr = Math.min(2, (typeof devicePixelRatio === "number" && devicePixelRatio) || 1);
    var px = Math.max(1, Math.round(size * dpr));
    canvas.width = px;
    canvas.height = px;
    var ctx = ctx2d(canvas);
    if (!ctx || !ctx.arc) return;
    ctx.clearRect(0, 0, px, px);
    ctx.beginPath();
    ctx.arc(px / 2, px / 2, px / 2, 0, Math.PI * 2);
    ctx.fillStyle = COLOURS[key];
    ctx.fill();
  }

  /* A little hop, for the picker's preview when a choice lands. */
  function poke(host) {
    var bot = host && host.__faBot;
    if (bot && bot.sim && bot.unsub) bot.sim.poke();
  }

  /* For a caller that runs its own frame loop (the landing page's flock):
     a sim for a spec, and a way to paint any pose of it into a canvas.
     The flock owns its timing, so it does not go through the registry. */
  var cfgCache = {};
  function paintPose(canvas, size, spec, pose, forceStill) {
    if (!BA || !canvas) return;
    var key = spec.shape + "|" + spec.face + "|" + spec.colour;
    var cfg = cfgCache[key] || (cfgCache[key] = cfgFor(spec));
    if (!cfg) return;
    /* still: the core builds the plastic material now rather than on idle
       time, because no later frame will repaint over its stand-in look. */
    cfg.still = !!forceStill || !pose || reduced();
    paintInto(canvas, size, pose || BA.restPose("default"), cfg, false);
  }
  function sim(seed) {
    return BA ? new BA.BotAvatarSim(seed, "default") : null;
  }

  /* The motion state a job's status earns. "working" means the next move is
     the agent's and the work is under way: exactly jobListBucketOf's
     inProgress bucket (src/domain/job-list.ts), confirmed and
     redo_requested. Everything else, including a status this file does not
     know, is "default". */
  var IN_PROGRESS = { confirmed: true, redo_requested: true };
  function stateForJob(status) {
    return typeof status === "string" && IN_PROGRESS[status] === true ? "working" : "default";
  }

  global.FABots = {
    SHAPES: SHAPES,
    FACES: FACES,
    FACE_NAMES: FACE_NAMES,
    COLOURS: COLOURS,
    COLOUR_NAMES: COLOUR_NAMES,
    COLOUR_KEYS: COLOUR_KEYS,
    sha256: sha256,
    defaultAvatar: defaultAvatar,
    isValid: isValid,
    resolve: resolve,
    hash: hash,
    mount: mount,
    still: still,
    swatch: swatch,
    poke: poke,
    paintPose: paintPose,
    sim: sim,
    reduced: reduced,
    stateForJob: stateForJob,
    shapeName: function (shape) {
      var p = BA && BA.botAvatarPresets[shape];
      return p ? p.label : shape.charAt(0).toUpperCase() + shape.slice(1);
    }
  };
})(typeof window !== "undefined" ? window : this);
