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
   reduced motion while it is playing jumps straight to the end. */

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

  function render(target, steps, label) {
    var ol = document.createElement("ol");
    ol.className = "stepflow";
    ol.setAttribute("data-stepflow", "");
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
    enhance(ol);
    return ol;
  }

  function init(root) {
    each((root || document).querySelectorAll("[data-stepflow]"), enhance);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { init(); });
  } else {
    init();
  }

  global.FAStepflow = { init: init, enhance: enhance, render: render, finish: finish };
})(window);
