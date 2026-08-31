/* The flock cast: five agents, five routes, five species.

   Every perch names a real element by id. Those ids are the contract between
   this file and the markup: #cluster, #headline, #how-title, #step-1..4,
   #record, #evidence-title, #tier-1..3, #never-title, #refuse, #empty and
   #foot-inner must exist on any page that loads this script. What is INSIDE
   them is free to change, which is the whole reason perches anchor to live
   rects instead of pixel numbers.

   SEEDS ARE CHOSEN FOR SPECIES, NOT LEFT TO CHANCE.

   Under the swarm engine the seed IS the species, so these five are SEARCHED
   against three constraints at once rather than invented:

     species   one each of moth, wasp, dragonfly, spider, bee
     hue       body hues at roughly 25, 81, 177, 270 and 339 degrees, so the
               cast spreads around the wheel instead of clustering. A first
               pass that only asked for species returned three green
               creatures out of five, which is a fair roll and a poor cast.
     contrast  both body and wing above 4.5:1 on the page background, which
               is headroom over the 3:1 floor DESIGN.md 2.5 sets

   The cast is chosen to look like a swarm rather than a taxonomy lesson: one
   heavy flyer to lead, two fast small ones, one slow drifter, and one
   wingless creature that reads completely differently in silhouette.

   SIZES ARE SET BY DRAWN MASS, NOT BY BOX SIZE. A sprite is mostly empty
   grid: a dragonfly at 92px has a body about 20px wide with thin limbs, so
   naive numbers read as scattered debris rather than as creatures. */

(function () {
  "use strict";

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  var CAST = [
    {
      name: "lead",
      glow: true,
      /* moth, orange body / cyan wing. The widest wing area in the set,
         which is what a lead needs. */
      opts: { temperament: "curious", size: 132, seed: 410 },
      tune: { depart: 0.10, arrive: 0.72, arc: -140, flutter: 2.4 },
      route: [
        { anchor: "#cluster",    ax: 0.42, ay: 0.34, layer: "front", size: 132, expr: "rest" },
        { anchor: "#how-title",  ax: 1.00, ay: 0.42, dx: 54, layer: "front", size: 88, expr: "perk" },
        { anchor: "#record",     ax: 1.00, ay: 0.22, dx: 62, layer: "front", size: 82, expr: "focus" },
        { anchor: "#tier-1",     ax: 0.00, ay: 0.5,  dx: -46, layer: "front", size: 76, expr: "perk" },
        { anchor: "#refuse",     ax: 1.00, ay: 0.14, dx: 66, layer: "front", size: 78, expr: "focus" },
        { anchor: "#foot-inner", ax: 0.72, ay: 0.5,  layer: "front", size: 106, expr: "pleased" }
      ]
    },
    {
      name: "scout",
      /* wasp, lime body / rose wing. The fastest beat in the set. */
      opts: { temperament: "alert", size: 92, seed: 438 },
      tune: { depart: 0.04, arrive: 0.60, arc: 120, flutter: 3.1 },
      route: [
        { anchor: "#cluster",    ax: 0.80, ay: 0.10, layer: "front", size: 92 },
        { anchor: "#step-1",     ax: 0.5,  ay: -0.1, layer: "back",  size: 66, expr: "focus" },
        { anchor: "#step-4",     ax: 0.5,  ay: -0.1, layer: "front", size: 68, expr: "perk" },
        { anchor: "#tier-3",     ax: 0.02, ay: 0.5,  dx: -40, layer: "back", size: 62, expr: "rest" },
        { anchor: "#never-title",ax: 1.00, ay: 0.3,  dx: 52, layer: "front", size: 70, expr: "focus" },
        { anchor: "#foot-inner", ax: 0.84, ay: 0.34, layer: "front", size: 74, expr: "rest" }
      ]
    },
    {
      name: "drift",
      /* dragonfly, cyan body / azure wing. Four wings beating out of phase,
         the slow hoverer, and the largest cell count in the cast. */
      opts: { temperament: "dozy", size: 108, seed: 208 },
      tune: { depart: 0.26, arrive: 0.94, arc: -70, flutter: 1.5 },
      route: [
        { anchor: "#cluster",    ax: 0.08, ay: 0.62, layer: "back",  size: 108 },
        { anchor: "#how-title",  ax: 0.10, ay: 1.9,  layer: "back",  size: 84, expr: "rest" },
        { anchor: "#record",     ax: 0.14, ay: -0.4, layer: "back",  size: 76, expr: "rest" },
        { anchor: "#evidence-title", ax: 0.96, ay: 0.2, dx: 40, layer: "back", size: 74, expr: "rest" },
        { anchor: "#refuse",     ax: 0.04, ay: 0.86, dx: -44, layer: "back", size: 70, expr: "rest" },
        { anchor: "#foot-inner", ax: 0.60, ay: 0.66, layer: "front", size: 88, expr: "rest" }
      ]
    },
    {
      name: "anchorite",
      /* spider, violet body / azure wing marking. No wings at all, so it
         reads as a different KIND of thing in silhouette rather than as
         another winged variant. */
      opts: { temperament: "stoic", size: 84, seed: 49 },
      tune: { depart: 0.34, arrive: 1.00, arc: 90, flutter: 1.1 },
      route: [
        { anchor: "#cluster",    ax: 0.66, ay: 0.74, layer: "front", size: 84 },
        { anchor: "#step-3",     ax: 0.5,  ay: -0.12, layer: "back", size: 60, expr: "rest" },
        { anchor: "#tier-2",     ax: 0.99, ay: 0.5,  dx: 44, layer: "front", size: 64, expr: "focus" },
        { anchor: "#tier-3",     ax: 0.99, ay: 0.5,  dx: 44, layer: "front", size: 62, expr: "rest" },
        { anchor: "#empty",      ax: 1.00, ay: 0.5,  dx: 54, layer: "front", size: 68, expr: "perk" },
        { anchor: "#foot-inner", ax: 0.92, ay: 0.62, layer: "front", size: 70, expr: "rest" }
      ]
    },
    {
      name: "tag",
      /* bee, rose body / cyan wing. The smallest and busiest, a quick
         shallow beat. */
      opts: { temperament: "calm", size: 70, seed: 7 },
      tune: { depart: 0.44, arrive: 1.00, arc: -190, flutter: 2.8 },
      route: [
        { anchor: "#cluster",    ax: 0.94, ay: 0.52, layer: "back",  size: 70 },
        { anchor: "#step-2",     ax: 0.5,  ay: -0.12, layer: "front", size: 58, expr: "perk" },
        { anchor: "#record",     ax: 0.5,  ay: 1.16, layer: "back",  size: 58, expr: "rest" },
        { anchor: "#tier-1",     ax: 0.99, ay: 0.5,  dx: 40, layer: "back", size: 56, expr: "rest" },
        { anchor: "#empty",      ax: 0.06, ay: 1.5,  layer: "front", size: 60, expr: "rest" },
        { anchor: "#foot-inner", ax: 0.52, ay: 0.4,  layer: "front", size: 64, expr: "perk" }
      ]
    }
  ];

  var back = document.getElementById("layer-back");
  var front = document.getElementById("layer-front");
  if (!back || !front) return;

  var flock = FAFlock.create({ back: back, front: front });

  var built = CAST.map(function (c) {
    var s = flock.add(c.opts, c.route, c.tune);
    s.wantsGlow = !!c.glow;
    return s;
  });

  /* Colour comes from the SEED, never from a theme and never from an
     operator. A swarm creature derives its whole two-tone harmony from its
     seed, which is the same rule the avatars hold to (ENT-2.3): identity is
     not a choice, and there is no upload path anywhere in this product.

     The glow still tracks the accent, because a glow is light rather than
     identity, and light is allowed to belong to the page. */
  built.forEach(function (s) {
    if (s.wantsGlow) FA.setGlow(s, cssVar("--accent"));
  });

  var mark = document.getElementById("navmark");
  if (mark) mark.innerHTML = FA.avatar("did:abt:freeagents", 22);

  flock.start();
  FAReveal.init();

  /* Below 900px the video is skipped by CSS, and under reduced motion it is
     skipped everywhere. Stop it downloading too: a paused 5MB background is
     still 5MB of somebody's data. */
  (function trimVideo() {
    var v = document.getElementById("herovid");
    if (!v) return;
    if (window.innerWidth < 900 || FAFlock.REDUCED) {
      v.pause();
      v.removeAttribute("autoplay");
      var src = v.querySelector("source");
      if (src) src.removeAttribute("src");
      v.load();
    }
  })();
})();
