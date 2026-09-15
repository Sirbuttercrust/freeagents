/* Shared behaviour for the marketplace pages.

   Three jobs, all of them progressive enhancement: the page is complete and
   readable with this file absent, blocked, or broken.

     disclosure  the "Show technical details" control (DESIGN.md 4.2)
     copy        a copy button beside a machine-checkable value (DESIGN 1.3)
     reveal      scroll-in, whose FINISHED STATE IS THE CSS DEFAULT

   DISCLOSURE STATE IS NEVER REMEMBERED ACROSS SESSIONS. Everyone gets the
   simple view first, every time. A remembered expansion means a returning
   person is greeted with the dense screen the design exists to avoid, which
   is the exact opposite of the intent. That is why there is no storage call
   anywhere in this file. */

(function () {
  "use strict";

  function init() {
    disclosures();
    copies();
    reveals();
  }

  /* ------------------------------------------------------- disclosures
     The control's label NAMES what is behind it, and swaps to the hide
     wording when open, so a person never expands something to find out what
     it was. */
  function disclosures() {
    var list = document.querySelectorAll("[data-disclose]");
    Array.prototype.forEach.call(list, function (btn) {
      var target = document.getElementById(btn.getAttribute("data-disclose"));
      if (!target) return;
      var open = false;
      var label = btn.textContent;
      var alt = btn.getAttribute("data-disclose-alt");
      btn.addEventListener("click", function () {
        open = !open;
        target.hidden = !open;
        btn.textContent = open ? (alt || label) : label;
        btn.setAttribute("aria-expanded", open ? "true" : "false");
      });
      target.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    });
  }

  /* --------------------------------------------------------------- copy
     Every exact term is copyable, because the people who want the identifier
     want to paste it somewhere. The value is read at CLICK TIME rather than
     bound at setup, so a control whose value a page script fills in later
     copies the real value instead of an empty placeholder.

     A .copybtn REPORTS THE RESULT WITH ITS ICON, so its text must stay put.
     The wireframe's own wireframe.js carries this guard (wireframe.js:80-83)
     and the port of that behaviour into this file dropped it, which is why
     the guard arrived here with the verify rebuild rather than with the
     first page to ship a .copybtn. Without it, textContent = "Copied"
     replaces the button's whole subtree: the .icoslot, both glyphs and the
     .lbl are destroyed on the first press and the restore puts back a bare
     word, permanently. Measured on the shipped markup shape: two glyphs and
     one label at rest, zero of each after one click, zero after the restore
     timer. It is invisible in a screenshot of a page nobody has clicked,
     which is how it shipped on the agent and operator profiles; both are
     repaired by this line as well. */
  function copies() {
    var list = document.querySelectorAll("[data-copy]");
    Array.prototype.forEach.call(list, function (btn) {
      btn.addEventListener("click", function () {
        var v = btn.getAttribute("data-copy");
        if (!v) return;
        if (navigator.clipboard) { navigator.clipboard.writeText(v).catch(function () {}); }
        if (btn.classList.contains("copybtn")) return;
        var restore = btn.textContent;
        btn.textContent = "Copied";
        setTimeout(function () { btn.textContent = restore; }, 1100);
      });
    });
  }

  /* ------------------------------------------------------------ reveals
     THE ORDER OF OPERATIONS HERE IS THE WHOLE SAFETY ARGUMENT.

     The CSS default is the FINISHED state. The hidden state only applies
     under `.js-reveal` on <html>, and this function adds that class only
     after it has confirmed it can also take elements out of the hidden
     state. So every failure mode lands on "content is visible":

       no JS at all            -> .js-reveal never added, CSS default shows all
       no IntersectionObserver -> we return before adding the class
       reduced motion          -> the whole hidden block sits inside a
                                  no-preference media query, so it never applies
       observer never fires    -> the timeout below reveals everything anyway

     That last one matters more than it looks. An element inside a hidden
     container, a print stylesheet, or a viewport that never scrolls can
     leave an observer silent forever, and invisible content on a page
     selling verified evidence is the worst possible failure. */
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
