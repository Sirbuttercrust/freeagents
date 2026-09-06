/* Flow chrome. Wireframe-only, not product code.

   One job: open and close the sheets. Everything else on these screens is
   CSS and markup, because a wireframe that needs JavaScript to be legible is
   a wireframe that lies about how much of it exists.

   NATIVE <dialog>, DELIBERATELY. showModal() gives focus containment, Escape,
   the inert background and the ::backdrop for free. A hand-rolled overlay
   reimplements four things and gets at least one of them subtly wrong, and
   the one it gets wrong is usually focus, which is invisible until somebody
   tabs.

   The @media (max-width) branches of flow.css are the ones that matter for
   the sheets: they open at 320px too, and a sheet that overflows is worse
   than the screen it covers. */

(function () {
  "use strict";

  function ready(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn);
    } else {
      fn();
    }
  }

  ready(function () {

    /* Anything with data-opens="id" opens that dialog. Anything with
       data-closes inside a dialog closes its own.

       showModal is feature-detected rather than assumed. Where it is
       missing the dialog opens non-modally, which is a worse experience
       and not a broken one. */
    Array.prototype.forEach.call(document.querySelectorAll("[data-opens]"), function (btn) {
      btn.addEventListener("click", function () {
        var d = document.getElementById(btn.getAttribute("data-opens"));
        if (!d) return;
        if (typeof d.showModal === "function") { d.showModal(); }
        else { d.setAttribute("open", ""); }
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll("dialog [data-closes]"), function (btn) {
      btn.addEventListener("click", function () {
        var d = btn.closest("dialog");
        if (!d) return;
        if (typeof d.close === "function") { d.close(); }
        else { d.removeAttribute("open"); }
      });
    });

    /* Clicking the backdrop closes. The target of a click on the backdrop is
       the dialog element itself, because the backdrop is its pseudo-element;
       a click on any real content inside targets that content. So the
       identity test is the whole check, and it does not need a hit test
       against the padding box. */
    Array.prototype.forEach.call(document.querySelectorAll("dialog"), function (d) {
      d.addEventListener("click", function (e) {
        if (e.target === d && typeof d.close === "function") { d.close(); }
      });
    });
  });
})();
