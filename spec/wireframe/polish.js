/* FreeAgents wireframe: the interaction layer.

   Loaded after wireframe.js on every screen. wireframe.js owns the builder
   notes, the filter disclosure, copy buttons and scroll reveals. This file
   owns everything added in the polish pass and does not duplicate any of it.

   THE SAFETY ARGUMENT IS THE SAME ONE base.css MAKES FOR REVEALS: every
   enhancement here is additive, and the page is complete and usable if this
   file never runs. Nothing is hidden by CSS waiting for a callback that might
   not come. A tab panel starts visible and only becomes a panel once the
   script has confirmed it can also show it again.

   REDUCED MOTION is checked once and honoured in the behaviour as well as the
   styles: a spy that fires on a timer is still motion even when the CSS
   transition is suppressed. */

(function () {
  "use strict";

  var REDUCED = window.matchMedia &&
                window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function each(list, fn) { Array.prototype.forEach.call(list, fn); }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return (root || document).querySelectorAll(sel); }

  /* ------------------------------------------------------------ 1. toasts

     A wireframe has no backend, so an action that would normally produce a
     server response produces nothing at all and the screen looks broken. A
     toast is the smallest honest answer: it names what WOULD happen, which is
     what a builder reading this needs to know. */

  var toastHost = null;

  function toast(title, sub, icon) {
    if (!toastHost) {
      toastHost = document.createElement("div");
      toastHost.className = "toasts";
      toastHost.setAttribute("role", "status");
      toastHost.setAttribute("aria-live", "polite");
      document.body.appendChild(toastHost);
    }

    var t = document.createElement("div");
    t.className = "toast";

    var i = document.createElement("span");
    i.className = "ico";
    i.setAttribute("data-ico", icon || "check-circle");
    t.appendChild(i);

    var body = document.createElement("div");
    var b = document.createElement("b");
    b.textContent = title;
    body.appendChild(b);
    if (sub) {
      var s = document.createElement("span");
      s.className = "sub";
      s.textContent = sub;
      body.appendChild(s);
    }
    t.appendChild(body);
    toastHost.appendChild(t);

    if (window.FAIcon) FAIcon.paint(t);

    setTimeout(function () {
      t.classList.add("is-out");
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, REDUCED ? 0 : 240);
    }, 2600);
  }

  window.FAToast = toast;

  /* -------------------------------------------------- 2. button feedback

     The ripple originates at the pointer, so the feedback belongs to the
     click rather than to the button. Keyboard activation has no coordinates,
     so it falls back to the centre. */

  function hits() {
    document.addEventListener("pointerdown", function (e) {
      var b = e.target.closest && e.target.closest(".btn, .chip");
      if (!b || b.disabled) return;
      var r = b.getBoundingClientRect();
      b.style.setProperty("--px", ((e.clientX - r.left) / r.width * 100) + "%");
      b.style.setProperty("--py", ((e.clientY - r.top) / r.height * 100) + "%");
    }, { passive: true });

    document.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest(".btn, .chip");
      if (!b || b.disabled || REDUCED) return;
      b.classList.remove("is-hit");
      void b.offsetWidth;                       // restart the animation
      b.classList.add("is-hit");
      setTimeout(function () { b.classList.remove("is-hit"); }, 520);
    });
  }

  /* ---------------------------------------------------- 3. chip toggling

     Filter chips carried aria-pressed but nothing flipped it, so the filter
     rail looked live and was inert. Anything with [data-toggle] now toggles
     itself and reports the new result count, which is the thing a person
     actually wants to know after clicking a filter. */

  function chips() {
    each($$(".chip[data-toggle]"), function (c) {
      c.addEventListener("click", function () {
        var on = c.getAttribute("aria-pressed") === "true";
        c.setAttribute("aria-pressed", on ? "false" : "true");
        announceFilters();
      });
    });
  }

  function announceFilters() {
    var host = $("[data-filter-count]");
    if (!host) return;
    var on = $$('.chip[data-toggle][aria-pressed="true"]').length;
    host.textContent = on === 0
      ? "No filters"
      : (on === 1 ? "1 filter" : on + " filters");
  }

  /* ------------------------------------------------- 3b. single-select bars

     Sort bars, pagers and status filter pills are pick-one groups: the sort
     bar carried aria-pressed on one button and nothing moved it, and the
     pager marked page 1 current forever. Both looked live and were inert.

     [data-pick] on the container makes its buttons a radio group. The
     attribute that carries selection is whichever one the markup already
     used, so the CSS in base.css keeps working untouched. */

  function picks() {
    each($$("[data-pick]"), function (bar) {
      var attr = bar.getAttribute("data-pick") || "aria-pressed";
      var btns = $$("button", bar);
      each(btns, function (b) {
        b.addEventListener("click", function () {
          if (b.disabled) return;
          each(btns, function (x) {
            if (x.disabled) return;
            if (attr === "aria-current") {
              if (x === b) x.setAttribute("aria-current", "page");
              else x.removeAttribute("aria-current");
            } else {
              x.setAttribute(attr, x === b ? "true" : "false");
            }
          });
          var label = (b.textContent || "").trim();
          var msg = bar.getAttribute("data-pick-msg");
          if (msg) toast(msg.replace("%s", label), bar.getAttribute("data-pick-sub") || "", bar.getAttribute("data-pick-ico") || "sort");
        });
      });
    });
  }

  /* ------------------------------------------------ 3c. evidence filtering

     The agent profile's evidence chips genuinely filter the work history.
     They have to: a filter that does nothing, on the one page whose entire
     subject is checkable claims, is the worst possible place to fake an
     affordance.

     Rows carry data-ev, chips carry data-ev, and "all" shows everything. The
     count in the heading follows, so the number and the list can never
     disagree. */

  function evFilter() {
    var bar = $("#evfilter");
    if (!bar) return;
    var rows = $$("[data-ev]:not(button)");
    if (!rows.length) return;

    each($$("button[data-ev]", bar), function (b) {
      b.addEventListener("click", function () {
        var want = b.getAttribute("data-ev");
        var shown = 0;
        each(rows, function (r) {
          var on = want === "all" || r.getAttribute("data-ev") === want;
          r.hidden = !on;
          if (on) shown++;
        });
        var out = $("[data-ev-count]");
        if (out) out.textContent = shown + (shown === 1 ? " item" : " items");
      });
    });
  }

  /* ------------------------------------------------------------- 4. tabs

     agent.html shipped role="tablist" with no behaviour behind it. Tabs that
     look interactive and do nothing are worse than no tabs, because a person
     concludes the page is broken rather than that the feature is unbuilt.

     Panels are found by aria-controls. If a tab names no panel the tab still
     works as a visual selection, which is what the profile filters need. */

  function tabs() {
    each($$('[role="tablist"]'), function (list) {
      var btns = $$('[role="tab"], button', list);
      if (!btns.length) return;

      var line = document.createElement("span");
      line.className = "tabline";
      list.appendChild(line);

      function moveLine(el) {
        line.style.width = el.offsetWidth + "px";
        line.style.transform = "translateX(" + el.offsetLeft + "px)";
      }

      function select(el) {
        each(btns, function (b) {
          var on = b === el;
          b.setAttribute("aria-selected", on ? "true" : "false");
          b.setAttribute("tabindex", on ? "0" : "-1");
          var id = b.getAttribute("aria-controls");
          if (!id) return;
          var panel = document.getElementById(id);
          if (!panel) return;
          panel.hidden = !on;
          if (on && !REDUCED) {
            panel.classList.remove("is-swap");
            void panel.offsetWidth;
            panel.classList.add("is-swap");
          }
        });
        moveLine(el);
      }

      each(btns, function (b, i) {
        b.setAttribute("role", "tab");
        b.addEventListener("click", function () { select(b); });
        /* Arrow-key movement, which is what a tablist is expected to do. */
        b.addEventListener("keydown", function (e) {
          var d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
          if (!d) return;
          e.preventDefault();
          var next = btns[(i + d + btns.length) % btns.length];
          next.focus();
          select(next);
        });
      });

      var initial = list.querySelector('[aria-selected="true"]') || btns[0];
      select(initial);
      /* Fonts land after first paint and change the measurement. */
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function () { moveLine(list.querySelector('[aria-selected="true"]') || btns[0]); });
      }
      window.addEventListener("resize", function () {
        moveLine(list.querySelector('[aria-selected="true"]') || btns[0]);
      });
    });
  }

  /* -------------------------------------------------------- 5. scroll spy

     "Icons highlighting over sections when you scroll over it."

     A section is READ when it occupies the middle band of the viewport. The
     band, rather than a single line, stops the state flickering on and off
     while someone scrolls slowly across a boundary.

     NEUTRAL ONLY. Being under the reader's eye is not evidence of anything,
     and the accent means exactly one thing. */

  function spy() {
    var nodes = $$(".spy");
    if (!nodes.length || !("IntersectionObserver" in window)) return;

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        e.target.classList.toggle("is-read", e.isIntersecting);
      });
    }, {
      /* Middle band: ignore the top 42% and the bottom 42% of the viewport. */
      rootMargin: "-42% 0px -42% 0px",
      threshold: 0
    });

    each(nodes, function (n) { io.observe(n); });
  }

  /* ------------------------------------------------- 6. nav state + progress

     The nav detaches from the content once the page has moved, and long
     screens get a reading-progress hairline in the nav's own bottom edge so
     it never covers anything.

     Both run off one rAF-throttled scroll listener. */

  function navState() {
    var nav = $(".nav");
    if (!nav) return;

    var prog = null;
    if (document.documentElement.scrollHeight > window.innerHeight * 2.2) {
      prog = document.createElement("span");
      prog.className = "prog";
      nav.appendChild(prog);
    }

    var ticking = false;
    function update() {
      ticking = false;
      var y = window.scrollY || window.pageYOffset;
      nav.classList.toggle("is-stuck", y > 8);
      if (prog) {
        var max = document.documentElement.scrollHeight - window.innerHeight;
        prog.style.width = (max > 0 ? Math.min(1, y / max) * 100 : 0) + "%";
      }
    }
    window.addEventListener("scroll", function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    }, { passive: true });
    update();
  }

  /* ------------------------------------------------------- 7. disclosures

     wireframe.js toggles [hidden] on a drawer, which is correct and abrupt.
     Where the markup opts in with .reveal-h, animate the open instead. The
     hidden attribute is still the source of truth for anything without JS. */

  function discloseAnim() {
    each($$("[data-disclose]"), function (btn) {
      var target = document.getElementById(btn.getAttribute("data-disclose"));
      if (!target || !target.classList.contains("reveal-h")) return;
      btn.addEventListener("click", function () {
        /* wireframe.js has already flipped `hidden` by the time this runs. */
        requestAnimationFrame(function () {
          target.classList.toggle("is-open", !target.hidden);
        });
      });
    });
  }

  /* ------------------------------------------------------ 8. copy buttons

     wireframe.js handles the clipboard write and the label swap. This adds
     the tick morph for buttons that opt in with .copybtn, and nothing else,
     so the two never fight over the same element's text. */

  function copyMorph() {
    each($$(".copybtn"), function (b) {
      b.addEventListener("click", function () {
        b.classList.add("is-done");
        setTimeout(function () { b.classList.remove("is-done"); }, 1100);
      });
    });
  }

  /* ----------------------------------------------------------- 9. counters

     A textarea with a budget. The count is information the writer needs
     before they hit a limit, not after. */

  function counters() {
    each($$("[data-counter]"), function (ta) {
      var out = document.getElementById(ta.getAttribute("data-counter"));
      if (!out) return;
      var max = parseInt(ta.getAttribute("maxlength") || "0", 10) ||
                parseInt(ta.getAttribute("data-max") || "600", 10);
      function tick() {
        var n = ta.value.length;
        out.textContent = n + " / " + max;
        out.classList.toggle("is-over", n > max);
      }
      ta.addEventListener("input", tick);
      tick();
    });
  }

  /* -------------------------------------------------- 10. demo submissions

     Any control marked [data-demo] answers with a toast naming what the real
     action would do. This is what turns a static wireframe into something a
     person can walk through: every button does something, and what it does is
     honest about being a wireframe.

     [data-demo-busy] additionally shows the pending state for a beat, because
     the loading state is a real screen that a wireframe usually omits. */

  function demos() {
    each($$("[data-demo]"), function (el) {
      el.addEventListener("click", function (e) {
        if (el.tagName === "A" && el.getAttribute("href") &&
            el.getAttribute("href") !== "#") return;      // let real links go
        e.preventDefault();

        var title = el.getAttribute("data-demo");
        var sub = el.getAttribute("data-demo-sub") || "";
        var icon = el.getAttribute("data-demo-ico") || "check-circle";

        if (el.hasAttribute("data-demo-busy") && !REDUCED) {
          el.setAttribute("data-busy", "true");
          setTimeout(function () {
            el.removeAttribute("data-busy");
            toast(title, sub, icon);
          }, 700);
        } else {
          toast(title, sub, icon);
        }
      });
    });
  }

  /* ------------------------------------------------------ 11. field states

     Wireframe-level validation: enough to show the state exists and where it
     renders. A required field that has been touched and left empty shows its
     hint. Nothing here pretends to be real validation. */

  function fields() {
    each($$("[data-required]"), function (input) {
      var field = input.closest(".field");
      if (!field) return;
      input.addEventListener("blur", function () {
        var empty = !input.value.trim();
        field.classList.toggle("is-bad", empty);
        field.classList.toggle("is-ok", !empty);
      });
      input.addEventListener("input", function () {
        if (input.value.trim()) field.classList.remove("is-bad");
      });
    });
  }

  /* ------------------------------------------------------- 12. shortcuts

     One shortcut per screen, and only where it is the thing a repeat user
     does most. `/` focuses the search field, which is the convention every
     developer already has in their fingers from GitHub.

     Guarded so it never fires while someone is typing in another field. */

  function shortcuts() {
    var q = document.getElementById("q");
    if (!q) return;
    document.addEventListener("keydown", function (e) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      var a = document.activeElement;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)) return;
      e.preventDefault();
      q.focus();
      q.select();
    });
  }

  /* ------------------------------------------------------------- 13. init */

  function init() {
    if (window.FAIcon) FAIcon.paint();
    hits();
    chips();
    picks();
    evFilter();
    tabs();
    spy();
    navState();
    discloseAnim();
    copyMorph();
    counters();
    demos();
    fields();
    shortcuts();
    announceFilters();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
