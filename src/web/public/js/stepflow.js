/* FreeAgents: the step flow. An animated workflow diagram, reusable.

   WHAT IT IS
   A row of steps, each a picture and a few words, joined by a line that
   draws itself from one step to the next. It replaces a paragraph that
   explains a process: the reader sees the order instead of reading it.

   THE CONTRACT IS THE MARKUP. A page writes an ordered list and this file
   only animates it, so the diagram is complete with no script at all:

     <ol class="stepflow" data-stepflow aria-label="How a hire works">
       <li class="sf-step">
         <span class="sf-node" aria-hidden="true"><svg>...</svg></span>
         <span class="sf-label">Find an agent</span>
       </li>
       ...
     </ol>

   Load /css/stepflow.css and this script, and every [data-stepflow] on the
   page is picked up. A page that would rather build it from data calls

     FAStepflow.render(target, [{ label: "Find an agent", icon: "search" }])

   where icon is a name from icons.js (FAIcon) or a string of SVG markup.

   HOW IT PLAYS
   Once, when the diagram scrolls into view. Each step lights in turn and
   the line draws on to the next one. Then it stops for good: a diagram
   that replays every time you pass it becomes noise.

   THE FINISHED DIAGRAM IS THE DEFAULT. stepflow.css draws every step lit
   and every line drawn. This script ARMS the diagram (hides the steps)
   only when it is about to animate them, so every way this can fail
   (no script, a throw, no IntersectionObserver, reduced motion) lands on
   the complete picture rather than an empty row.

   REDUCED MOTION shows the finished diagram at once, and a switch to
   reduced motion while it is playing jumps straight to the end.

   WHERE YOU ARE (the hire journey's small diagram)
   The same five steps the landing page draws, small, with one step lit.
   Every page a buyer walks through to hire carries it, so the process
   they saw on the landing page is the map they are standing on. A page
   writes an empty host and says which step it is:

     <div class="sf-where" data-stepflow-hire="2"></div>

   and init() draws the diagram into it. The value is a step number (1 to
   5) or "done" for a hire whose five steps are all behind it. A page that
   only learns the step from data (the job page reads the hire's status)
   leaves the value empty and calls FAStepflow.where(host, step) later;
   an empty host draws nothing, because an unlit map is a claim about
   where the reader is that nobody made.

   HIRE_STEPS is the single source of the five steps outside landing.html,
   and tests/web/hire-journey-simple.test.ts holds the two lists equal.
   The small diagram never plays: it is a "you are here" marker seen on
   every page of the journey, and a marker that animates on every load is
   noise. It is finished and still under every preference. */

(function (global) {
  "use strict";

  var BEAT = 620;   /* ms between one step lighting and the next */
  var TAIL = 900;   /* ms after the last step starts, until it has settled */

  var mq = global.matchMedia ? global.matchMedia("(prefers-reduced-motion: reduce)") : null;
  function reduced() { return !!(mq && mq.matches); }

  function each(list, fn) { Array.prototype.forEach.call(list, fn); }

  function finish(el) {
    if (el.__sfTimer) { clearTimeout(el.__sfTimer); el.__sfTimer = 0; }
    if (el.__sfIO) { el.__sfIO.disconnect(); el.__sfIO = null; }
    el.classList.remove("sf-armed", "sf-play");
    el.classList.add("sf-done");
  }

  function play(el) {
    var n = el.querySelectorAll(".sf-step").length;
    el.setAttribute("data-sf-plays", String((parseInt(el.getAttribute("data-sf-plays"), 10) || 0) + 1));
    el.classList.add("sf-play");
    el.__sfTimer = setTimeout(function () { finish(el); }, n * BEAT + TAIL);
  }

  function enhance(el) {
    if (el.__sf) return;
    el.__sf = true;
    el.style.setProperty("--sf-beat", BEAT + "ms");
    each(el.querySelectorAll(".sf-step"), function (step, i) {
      step.style.setProperty("--sf-i", String(i));
    });

    if (reduced() || typeof IntersectionObserver !== "function") {
      finish(el);
      return;
    }

    el.classList.add("sf-armed");
    /* "In view" means most of it: 60% of the diagram, or half the viewport
       when the diagram is taller than that (the vertical layout on a
       phone), where 60% of the diagram might never fit on screen at once.
       A diagram that starts playing while only its top edge peeks over the
       fold has played to nobody. */
    var io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e.isIntersecting) continue;
        var room = e.rootBounds ? e.rootBounds.height : global.innerHeight;
        if (e.intersectionRatio >= 0.6 || e.intersectionRect.height >= room * 0.5) {
          io.disconnect();
          el.__sfIO = null;
          play(el);
          return;
        }
      }
    }, { threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1], rootMargin: "0px 0px -8% 0px" });
    el.__sfIO = io;
    io.observe(el);

    if (mq) {
      var onChange = function () { if (mq.matches) finish(el); };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  function iconFor(icon) {
    if (!icon) return null;
    if (icon.charAt(0) === "<") {
      var box = document.createElement("span");
      box.innerHTML = icon;
      return box.firstElementChild;
    }
    return global.FAIcon ? global.FAIcon.svg(icon) : null;
  }

  function render(target, steps, label, opts) {
    var ol = document.createElement("ol");
    ol.className = "stepflow";
    if (!(opts && opts.still)) ol.setAttribute("data-stepflow", "");
    if (label) ol.setAttribute("aria-label", label);
    steps.forEach(function (s) {
      var li = document.createElement("li");
      li.className = "sf-step";
      if (s.id) li.id = s.id;
      var node = document.createElement("span");
      node.className = "sf-node";
      node.setAttribute("aria-hidden", "true");
      var svg = iconFor(s.icon);
      if (svg) node.appendChild(svg);
      var text = document.createElement("span");
      text.className = "sf-label";
      text.textContent = s.label;
      li.appendChild(node);
      li.appendChild(text);
      ol.appendChild(li);
    });
    target.appendChild(ol);
    /* opts.still: the finished diagram, never armed and never played. */
    if (opts && opts.still) ol.classList.add("sf-done");
    else enhance(ol);
    return ol;
  }

  /* The five steps of a hire, in the landing page's words and pictures. */
  var SVG_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">';
  var HIRE_STEPS = [
    { label: "Find an agent", icon: SVG_OPEN + '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' },
    { label: "Agree the job, pay 25%", icon: SVG_OPEN + '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="m9 15 2 2 4-4"/></svg>' },
    { label: "Agent works on a copy", icon: SVG_OPEN + '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' },
    { label: "You review the work", icon: SVG_OPEN + '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>' },
    { label: "Pay the rest", icon: SVG_OPEN + '<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5"/><path d="M17 13h.01"/></svg>' }
  ];

  /* "done" and anything past the last step both mean every step is behind
     the reader. Anything that is not a step number draws nothing. */
  function stepOf(value) {
    if (value === "done") return HIRE_STEPS.length + 1;
    var n = typeof value === "number" ? value : parseInt(value, 10);
    if (!isFinite(n) || n < 1) return 0;
    return Math.min(n, HIRE_STEPS.length + 1);
  }

  /* Lights one step. Steps before it are done, steps after it are ahead.
     The lit step carries aria-current="step" and the list's own label
     states the position in words, so a screen reader hears where the
     reader is, not only the five labels. */
  function setCurrent(ol, value) {
    var n = stepOf(value);
    var total = HIRE_STEPS.length;
    each(ol.querySelectorAll(".sf-step"), function (li, i) {
      var k = i + 1;
      li.classList.remove("sf-past", "sf-now", "sf-ahead");
      li.removeAttribute("aria-current");
      if (k < n) li.classList.add("sf-past");
      else if (k === n) { li.classList.add("sf-now"); li.setAttribute("aria-current", "step"); }
      else li.classList.add("sf-ahead");
    });
    ol.classList.toggle("sf-complete", n > total);
    ol.setAttribute("data-sf-current", n > total ? "done" : String(n));
    ol.setAttribute("aria-label", n > total
      ? "How a hire works: all " + total + " steps done"
      : "How a hire works: step " + n + " of " + total + ", " + HIRE_STEPS[n - 1].label);
  }

  /* Draws (once) or updates the small diagram in a host. Returns the list,
     or null when the value names no step, in which case the host is left
     empty and hidden. */
  function where(host, value) {
    if (!host) return null;
    var n = stepOf(value);
    var ol = host.querySelector("ol.stepflow");
    if (n === 0) {
      if (ol) host.removeChild(ol);
      host.hidden = true;
      return null;
    }
    if (!ol) {
      ol = render(host, HIRE_STEPS, "", { still: true });
      ol.classList.add("sf-small");
      /* Below 640px the five labels leave the screen (they stay in the
         accessibility tree) and this one line names the lit step. It is
         aria-hidden because the list already says the same thing. */
      var cap = document.createElement("p");
      cap.className = "sf-caption";
      cap.setAttribute("aria-hidden", "true");
      host.appendChild(cap);
    }
    setCurrent(ol, value);
    var caption = host.querySelector(".sf-caption");
    if (caption) {
      caption.textContent = n > HIRE_STEPS.length
        ? "All " + HIRE_STEPS.length + " steps done"
        : "Step " + n + " of " + HIRE_STEPS.length + ": " + HIRE_STEPS[n - 1].label;
    }
    host.hidden = false;
    return ol;
  }

  function init(root) {
    each((root || document).querySelectorAll("[data-stepflow]"), enhance);
    each((root || document).querySelectorAll("[data-stepflow-hire]"), function (host) {
      var value = host.getAttribute("data-stepflow-hire");
      if (value) where(host, value);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { init(); });
  } else {
    init();
  }

  global.FAStepflow = {
    init: init, enhance: enhance, render: render, finish: finish,
    where: where, HIRE_STEPS: HIRE_STEPS
  };
})(window);
