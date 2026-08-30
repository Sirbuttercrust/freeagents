/* FreeAgents: scroll-triggered text reveals.
   Written 2026-08-19.

   WHERE THIS COMES FROM
   Ported from a React implementation of the same three effects. This site has
   no build step and no React, so they are rewritten in plain DOM. The
   behaviour is deliberately identical, because it is already tuned and
   already approved.

   THE THREE EFFECTS, EACH WITH A JOB

     rise      words lift and settle, staggered. The house reveal. Every
               heading and every lede enters this way, so arriving at a
               section always feels the same.
     draw      a hairline draws itself in from the left. Separates sections
               without a hard border sitting there before you arrive.
     settle    characters resolve out of a scramble. Reserved for ONE line on
               the page, because the effect is literally what the product
               prevents: information that will not sit still. Used more than
               once it becomes decoration and stops meaning anything.

   THE WORD BOUNDARY LAW
   Per-word animation still wraps per WORD. Each word gets an inline-block
   with the moving span inside it, and the space between words is a real
   space outside the clipping box, so a headline never breaks mid-word and
   never loses its spacing.

   WHY IntersectionObserver AND NOT SCROLL POSITION
   These fire when the reader arrives rather than playing to an empty room,
   and an observer costs nothing per frame. The smooth-scroll module drives
   the real window scroll position, so the default viewport root is truthful
   and no custom root is needed.

   REDUCED MOTION
   Everything collapses to the finished state immediately. Nothing is hidden,
   nothing animates, and the page reads exactly as designed.
*/

(function (global) {
  "use strict";

  var REDUCED = global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Matches the CSS custom properties, kept in one place. The easing itself
     lives in landing.css: the transitions are declared there so the
     compositor runs them, and duplicating the curve here would give the two
     files a way to disagree. */
  var DUR = 0.72;
  var STAGGER = 0.048;

  function observe(el, onSeen, threshold) {
    if (REDUCED) { onSeen(); return; }
    var io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          onSeen();
          io.disconnect();
          return;
        }
      }
    }, { threshold: threshold == null ? 0.2 : threshold, rootMargin: "0px 0px -6% 0px" });
    io.observe(el);
  }

  /* ---------------------------------------------------------------- rise */

  function rise(el, opts) {
    opts = opts || {};
    var delay = opts.delay || 0;
    var stagger = opts.stagger == null ? STAGGER : opts.stagger;

    /* Split on whitespace but keep the original text, so a heading with a
       line break in the source still reads correctly. */
    var words = el.textContent.trim().split(/\s+/);
    el.textContent = "";
    el.style.setProperty("--rise-dur", DUR + "s");

    var spans = [];
    for (var i = 0; i < words.length; i++) {
      /* The clip box. overflow hidden is what makes the word rise out of
         nothing rather than sliding in from somewhere visible. */
      var clip = document.createElement("span");
      clip.className = "rise-clip";

      var inner = document.createElement("span");
      inner.className = "rise-word";
      inner.textContent = words[i];
      inner.style.transitionDelay = (delay + i * stagger) + "s";

      clip.appendChild(inner);
      el.appendChild(clip);

      /* A real space OUTSIDE the clip box. Putting it inside would let the
         clip swallow it and run the words together. */
      if (i < words.length - 1) el.appendChild(document.createTextNode(" "));
      spans.push(inner);
    }

    el.classList.add("rise-ready");
    observe(el, function () { el.classList.add("rise-in"); }, opts.threshold);
  }

  /* ---------------------------------------------------------------- draw */

  function draw(el) {
    el.classList.add("draw-ready");
    observe(el, function () { el.classList.add("draw-in"); }, 0.4);
  }

  /* -------------------------------------------------------------- settle */

  function settle(el, opts) {
    opts = opts || {};
    var text = el.textContent;
    if (REDUCED) return;

    /* Measured on the other site: a naive one-character-per-frame version
       took 3.0s, so the sharpest line on the page sat garbled the whole time
       a reader was looking at it. Two characters per frame at 22ms lands
       near 0.6s, which reads as the line assembling rather than as a glitch
       you wait out. */
    var GLYPHS = "$0123456789%/\\|<>=+-";
    var speed = opts.speed || 22;
    el.textContent = "\u00A0";

    observe(el, function () {
      var frame = 0;
      var total = text.length;
      (function step() {
        frame += 1;
        var settled = Math.floor(frame * 2);
        if (settled >= total) { el.textContent = text; return; }
        var s = "";
        for (var i = 0; i < total; i++) {
          var ch = text[i];
          /* Trailing punctuation never scrambles. A stray glyph where the
             period belongs makes the sentence look broken rather than
             resolving. */
          if (ch === " " || i === total - 1) { s += ch; continue; }
          if (i < settled) { s += ch; continue; }
          if (i < settled + 7) { s += GLYPHS[Math.floor(Math.random() * GLYPHS.length)]; continue; }
          s += "\u00A0";
        }
        el.textContent = s;
        setTimeout(step, speed);
      })();
    }, 0.45);
  }

  /* ----------------------------------------------------------------- fade
     For blocks that should not be split into words: list items, cards, the
     job record. Same trigger, simpler motion. */

  function fade(el, opts) {
    opts = opts || {};
    if (opts.delay) el.style.transitionDelay = opts.delay + "s";
    el.classList.add("fade-ready");
    observe(el, function () { el.classList.add("fade-in"); }, opts.threshold);
  }

  /* ------------------------------------------------------------------ run
     Declarative wiring: mark elements in the HTML and this picks them up, so
     the page stays readable and the effects are visible in the markup rather
     than buried in a script. */

  function init() {
    var i, list;

    list = document.querySelectorAll("[data-rise]");
    for (i = 0; i < list.length; i++) {
      rise(list[i], {
        delay: parseFloat(list[i].getAttribute("data-rise-delay")) || 0,
        stagger: parseFloat(list[i].getAttribute("data-rise-stagger")) || undefined
      });
    }

    list = document.querySelectorAll("[data-draw]");
    for (i = 0; i < list.length; i++) draw(list[i]);

    list = document.querySelectorAll("[data-settle]");
    for (i = 0; i < list.length; i++) settle(list[i]);

    /* Staggered groups: children of a [data-fade-group] fade in sequence, so
       four steps or three tier rows arrive as a run rather than at once. */
    list = document.querySelectorAll("[data-fade-group]");
    for (i = 0; i < list.length; i++) {
      var kids = list[i].children;
      var step = parseFloat(list[i].getAttribute("data-fade-group")) || 0.07;
      for (var k = 0; k < kids.length; k++) fade(kids[k], { delay: k * step });
    }

    list = document.querySelectorAll("[data-fade]");
    for (i = 0; i < list.length; i++) {
      fade(list[i], { delay: parseFloat(list[i].getAttribute("data-fade")) || 0 });
    }
  }

  global.FAReveal = { init: init, rise: rise, draw: draw, settle: settle, fade: fade, REDUCED: REDUCED };
})(window);
