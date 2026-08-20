/* Wireframe chrome. Not product code.

   Two jobs: the builder-notes toggle, and the filter disclosure. Both are
   about keeping the default view of every page calm.

   The toggle state persists across pages, because a reviewer who turns notes
   on wants them on while they walk the whole flow. */

(function () {
  "use strict";

  var KEY = "fa-notes";

  function apply(on) {
    document.body.classList.toggle("notes-on", on);
    var b = document.getElementById("notetoggle");
    if (b) {
      b.textContent = on ? "Hide builder notes" : "Builder notes";
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  function init() {
    var on = false;
    try { on = localStorage.getItem(KEY) === "1"; } catch (e) {}

    var b = document.createElement("button");
    b.className = "notetoggle";
    b.id = "notetoggle";
    b.type = "button";
    document.body.appendChild(b);

    b.addEventListener("click", function () {
      on = !on;
      try { localStorage.setItem(KEY, on ? "1" : "0"); } catch (e) {}
      apply(on);
    });

    apply(on);

    /* Progressive disclosure for secondary filters. The rail shows the one
       facet a buyer always uses and hides the rest behind a single control,
       because a rail with twenty-five visible checkboxes is a form, and a
       form is what makes a browse page feel like work. */
    Array.prototype.forEach.call(document.querySelectorAll("[data-disclose]"), function (btn) {
      var target = document.getElementById(btn.getAttribute("data-disclose"));
      if (!target) return;
      var open = false;
      var label = btn.textContent;
      var alt = btn.getAttribute("data-disclose-alt");
      btn.addEventListener("click", function () {
        open = !open;
        target.hidden = !open;
        btn.textContent = open ? (alt || "Fewer filters") : label;
        btn.setAttribute("aria-expanded", open ? "true" : "false");
      });
      target.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    });

    /* Copy controls on machine-checkable values. Wireframe-only affordance:
       it proves the control exists and is reachable, which is what a builder
       needs to see. DESIGN.md 1.3 requires every exact term to be copyable,
       because the people who want the DID want to paste it somewhere. */
    Array.prototype.forEach.call(document.querySelectorAll("[data-copy]"), function (btn) {
      btn.addEventListener("click", function () {
        var v = btn.getAttribute("data-copy");
        var restore = btn.textContent;
        if (navigator.clipboard) { navigator.clipboard.writeText(v).catch(function () {}); }
        btn.textContent = "Copied";
        setTimeout(function () { btn.textContent = restore; }, 1100);
      });
    });

    reveals();
  }

  /* ------------------------------------------------------------ reveals
     Scroll-in for .reveal and .stagger.

     THE ORDER OF OPERATIONS HERE IS THE WHOLE SAFETY ARGUMENT.

     The CSS default is the FINISHED state. The hidden state only applies
     under `.js-reveal` on <html>, and this function adds that class only
     after it has confirmed it can also take elements out of the hidden
     state. So every failure mode lands on "content is visible":

       no JS at all          -> .js-reveal never added, CSS default shows all
       no IntersectionObserver -> we return before adding the class
       reduced motion         -> the whole hidden block is inside a
                                 no-preference media query, so it never applies
       observer never fires   -> the timeout below reveals everything anyway

     That last one matters more than it looks. An element inside a
     `hidden` container, a print stylesheet, or a viewport that never
     scrolls can leave an observer silent forever. Content that waits for
     a callback that never comes is invisible content, and invisible
     content on a page selling verified evidence is the worst possible
     failure. The 3 second belt-and-braces removes that class of bug
     entirely. */
  function reveals() {
    var nodes = document.querySelectorAll(".reveal, .stagger");
    if (!nodes.length) return;

    if (!("IntersectionObserver" in window)) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    document.documentElement.classList.add("js-reveal");

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add("is-in");
        io.unobserve(e.target);          // once only; this is an entrance
      });
    }, {
      /* Fire slightly before the element is fully on screen, so the motion
         finishes as it settles rather than starting after it has arrived. */
      rootMargin: "0px 0px -8% 0px",
      threshold: 0.05
    });

    Array.prototype.forEach.call(nodes, function (n) { io.observe(n); });

    /* Anything still hidden after 3 seconds is revealed unconditionally. */
    setTimeout(function () {
      Array.prototype.forEach.call(nodes, function (n) { n.classList.add("is-in"); });
    }, 3000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
