/* FreeAgents: smooth scrolling.
   Written 2026-08-19.

   THE PROBLEM
   A mouse wheel notch jumps the page about 100px instantly. Native scroll is a
   staircase, and everything driven off scroll position inherits that
   staircase, reported as very harsh movement.

   THE APPROACH, AND WHY THIS ONE
   Drive the REAL window scroll position via scrollTo, eased frame by frame,
   rather than translating a fake wrapper while pinning body scroll at zero.

   The fake-wrapper approach leaves `scrollY` pinned at 0 forever while the
   page visually moves by transform. Everything reading scroll position
   silently breaks, every IntersectionObserver needs rewiring to a custom
   root, position:fixed and sticky elements outside the wrapper fight it, and
   the native scrollbar disconnects from what is on screen. Driving the real
   position means `scrollY` IS the visual position on every frame, the flock
   keeps working unchanged, and the scrollbar stays real and draggable.

   THE TUNING IS NOT INVENTED
   `EASE` and `WHEEL_STEP` were tuned by hand over two rounds against the
   complaint that the first pass was still fast and jarring, rather than
   picked from a blog post. Two knobs matter and both are here: WHEEL_STEP
   shortens the distance one notch asks for so a flick does not fling the
   page, and EASE controls how lazily that distance closes. Cutting only the
   ease makes it float without ever feeling calm, because the target is still
   miles away.
   Below about 0.04 it stops feeling smooth and starts feeling broken, like
   the page is ignoring you.

   THE BUG THAT COST REAL TIME ON THE OTHER SITE, DO NOT REINTRODUCE IT
   `behavior: 'instant'` is REQUIRED, not decorative. A stylesheet setting
   `html { scroll-behavior: smooth }` applies to programmatic scrolls too, so
   every per-frame scrollTo would kick off the browser's own 300ms animation,
   and the next frame would interrupt it before it got anywhere. The measured
   result is a page that barely moves while the internal target races ahead.
   The two-argument `scrollTo(x, y)` form respects that CSS property as well,
   so the options object is the only safe call.

   WHAT IS LEFT ALONE:
     touch           entirely native. iOS momentum is better than this
     pinch zoom      ctrl+wheel untouched
     nested scrollers a modal body or code block keeps its own wheel handling
     reduced motion  disabled outright, native scroll restored
*/

(function (global) {
  "use strict";

  var REDUCED = global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var TOUCH = global.matchMedia && global.matchMedia("(pointer: coarse)").matches;

  var api = {
    enabled: false,
    y: global.scrollY || 0,
    velocity: 0,
    target: global.scrollY || 0
  };

  if (REDUCED || TOUCH) {
    /* Passthrough. Same surface, so no caller has to branch.
       `onFrame` still exists and still drives one loop, because the flock
       needs frames for its resting life even when nothing is smoothing the
       scroll. Two loops is the bug this whole module exists to avoid. */
    var subs = [];
    var passRaf = 0;
    var passLast = 0;

    global.addEventListener("scroll", function () {
      api.y = global.scrollY;
      api.target = api.y;
    }, { passive: true });

    api.scrollTo = function (y) { global.scrollTo(0, y); };
    api.scrollBy = function (d) { global.scrollTo(0, global.scrollY + d); };
    api.onFrame = function (fn) {
      subs.push(fn);
      if (!passRaf) {
        passLast = performance.now();
        passRaf = requestAnimationFrame(function step(now) {
          var dt = Math.min((now - passLast) / 1000, 0.05);
          passLast = now;
          api.y = global.scrollY;
          for (var i = 0; i < subs.length; i++) subs[i](api.y, dt, now);
          passRaf = requestAnimationFrame(step);
        });
      }
      return function () {
        var i = subs.indexOf(fn);
        if (i >= 0) subs.splice(i, 1);
      };
    };

    global.FASmoothScroll = api;
    return;
  }

  api.enabled = true;

  var EASE = 0.072;        // fraction of remaining distance per 60Hz frame
  var WHEEL_STEP = 0.62;   // one notch asks for 62% of its native distance
  var KEY_STEP = 110;
  var NAV_OFFSET = 78;     // sticky nav height, so anchors do not land under it

  var target = global.scrollY || 0;
  var current = target;
  var lastSet = Math.round(current);
  var raf = 0;
  var lastTime = 0;

  function maxScroll() {
    return Math.max(0, document.documentElement.scrollHeight - global.innerHeight);
  }
  function clamp(v) {
    var m = maxScroll();
    return v < 0 ? 0 : v > m ? m : v;
  }

  /* Walk up from a wheel target looking for a genuinely scrollable ancestor,
     or an explicit opt-out. Depth capped so this stays cheap during a fast
     wheel burst. */
  function scrollableAncestor(node) {
    var el = node, depth = 0;
    while (el && el !== document.documentElement && el !== document.body && depth < 8) {
      if (el.hasAttribute && el.hasAttribute("data-native-scroll")) return el;
      if (el.nodeType === 1) {
        var cs = global.getComputedStyle(el);
        if ((cs.overflowY === "auto" || cs.overflowY === "scroll") &&
            el.scrollHeight > el.clientHeight + 1) return el;
      }
      el = el.parentElement;
      depth++;
    }
    return null;
  }

  function apply(y) {
    /* NOT rounded.
       Rounding here produced a measured 1px staircase with 21 stall frames
       over a slow scroll: current going 100.4, 100.9, 101.4 rounds to 100,
       101, 101, so one frame does not move and the next moves 2px. Passing
       the fractional value lets the browser sub-pixel the scroll where it
       can, and where it cannot the agents no longer inherit the staircase
       because they work in document space (see flight.js). */
    global.scrollTo({ top: y, left: 0, behavior: "instant" });
    lastSet = y;
  }

  /* ------------------------------------------------------- the frame loop

     ONE rAF FOR THE WHOLE PAGE.

     The flock used to run its own requestAnimationFrame alongside this one.
     Two independent callbacks have no guaranteed order, so on some frames
     the flock read the scroll position BEFORE it was updated and on others
     after. A one-frame lag that flickers on and off is jitter by
     construction, and it is invisible in any screenshot.

     So this module owns the frame. Subscribers run after the scroll position
     is updated, every frame, in registration order. */

  var subscribers = [];

  function runFrame(now) {
    var dt = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 1 / 60;
    lastTime = now;

    target = clamp(target);
    var diff = target - current;

    if (Math.abs(diff) > 0.02) {
      /* Time corrected, so a 144Hz display and a 60Hz one settle over the
         same number of seconds. A raw per-frame lerp is twice as fast on a
         fast monitor, which is the usual bug in hand-rolled versions. */
      var k = 1 - Math.pow(1 - EASE, dt * 60);
      current += diff * k;
      apply(current);
    } else if (current !== target) {
      current = target;
      apply(current);
    }

    api.y = current;
    api.target = target;
    api.velocity = diff;

    for (var i = 0; i < subscribers.length; i++) subscribers[i](current, dt, now);

    /* Keep running while anything is moving or anyone is subscribed. The
       flock animates at rest (breathing, blinking, gaze), so it needs frames
       even when the scroll is parked. */
    if (subscribers.length || Math.abs(target - current) > 0.02) {
      raf = requestAnimationFrame(runFrame);
    } else {
      raf = 0;
      lastTime = 0;
    }
  }

  function wake() {
    api.target = target;
    if (!raf) {
      lastTime = 0;
      raf = requestAnimationFrame(runFrame);
    }
  }

  /* Subscribe to the page frame. Returns an unsubscribe function. The
     callback receives (smoothScrollY, dt, now) AFTER the scroll position has
     been updated for that frame. */
  api.onFrame = function (fn) {
    subscribers.push(fn);
    wake();
    return function () {
      var i = subscribers.indexOf(fn);
      if (i >= 0) subscribers.splice(i, 1);
    };
  };

  function scrollBy(delta) { target = clamp(target + delta); wake(); }
  function scrollToY(y) { target = clamp(y); wake(); }

  global.addEventListener("wheel", function (e) {
    if (e.ctrlKey) return;
    if (e.target && scrollableAncestor(e.target)) return;
    e.preventDefault();
    var d = e.deltaY;
    if (e.deltaMode === 1) d *= 16;                       // lines, Firefox
    else if (e.deltaMode === 2) d *= global.innerHeight;  // pages
    scrollBy(d * WHEEL_STEP);
  }, { passive: false });

  global.addEventListener("keydown", function (e) {
    var t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var handled = true;
    switch (e.key) {
      case "ArrowDown": scrollBy(KEY_STEP); break;
      case "ArrowUp":   scrollBy(-KEY_STEP); break;
      case "PageDown":  scrollBy(global.innerHeight * 0.85); break;
      case "PageUp":    scrollBy(-global.innerHeight * 0.85); break;
      case "Home":      scrollToY(0); break;
      case "End":       scrollToY(maxScroll()); break;
      case " ":         scrollBy(global.innerHeight * (e.shiftKey ? -0.85 : 0.85)); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  });

  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a) return;
    var id = a.getAttribute("href");
    if (!id || id === "#") return;
    var el = document.querySelector(id);
    if (!el) return;
    e.preventDefault();
    scrollToY(el.getBoundingClientRect().top + current - NAV_OFFSET);
  });

  /* Adopt anything that moved the real position without going through
     apply(): scrollbar drag, find-in-page, browser restoration. Without this
     the next wheel notch yanks the page back to a stale target.

     The threshold has to clear the browser's own sub-pixel rounding. We now
     ask for a fractional position, and the browser reports back the value it
     could actually use, which differs by up to a pixel. A tighter threshold
     here would treat that rounding as an outside scroll and reset the target
     every single frame, freezing the page. */
  global.addEventListener("scroll", function () {
    if (Math.abs(global.scrollY - lastSet) > 1.5) {
      current = target = global.scrollY;
      lastSet = current;
      api.y = current;
      api.target = target;
    }
  }, { passive: true });

  global.addEventListener("resize", function () {
    current = clamp(current);
    target = clamp(target);
    wake();
  });

  if ("scrollRestoration" in history) history.scrollRestoration = "manual";

  api.scrollTo = scrollToY;
  api.scrollBy = scrollBy;
  global.FASmoothScroll = api;
})(window);
