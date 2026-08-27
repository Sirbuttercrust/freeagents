/* FreeAgents wireframe: icon set.

   WHY A SET AND NOT A LIBRARY. base.css rule 4 bars "an icon that repeats what
   the adjacent word already said". So every icon here has to carry information
   the neighbouring text does not, and the set stays small enough to audit. No
   npm dependency, no external request, no 600KB bundle for eleven glyphs.

   Drawn in the Lucide register (24x24 box, 1.5 stroke, round caps, geometric)
   because that is the visual grammar developers already read fluently. Paths
   are ours.

   currentColor everywhere, so an icon inherits the meaning of the thing it
   sits in and the accent rule is impossible to violate by accident.

   USAGE
     <span class="ico" data-ico="shield-check"></span>

   If this script never runs the span stays empty and collapses. The adjacent
   text still says everything. That is the same safety argument base.css makes
   for reveals: every failure mode lands on readable content. */

(function () {
  "use strict";

  var P = {
    /* ---------------------------------------------------- evidence tiers
       These three are the most important icons on the site. They answer
       "how was this checked" at a glance, which is the product's whole
       claim, and none of them repeats its label. */

    /* Verified hire: we watched the whole thing. A shield with a tick. */
    "shield-check": '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',

    /* Verified prior work: two records pointing at each other. Not a tick,
       because nobody here watched it happen; the proof is the mutual link. */
    "link-2": '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><path d="M8 12h8"/>',

    /* Portfolio claim: a dashed page. Unproven, not bad. The broken outline
       is the message and it needs no colour to land. */
    "file-dash": '<path d="M14 2v6h6" stroke-dasharray="2 2"/><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke-dasharray="3 3"/>',

    /* ------------------------------------------------------------- git */
    "git-pr": '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v9"/>',
    "git-merge": '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
    "git-fork": '<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9"/><path d="M12 12v3"/>',
    "git-commit": '<circle cx="12" cy="12" r="3"/><path d="M3 12h6M15 12h6"/>',
    "github": '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5a4.3 4.3 0 0 0-1.2-3 4 4 0 0 0-.1-3S17.5 3 15 4.7a13 13 0 0 0-6 0C6.5 3 5.3 3 5.3 3a4 4 0 0 0-.1 3A4.3 4.3 0 0 0 4 9c0 3.5 3 5.5 6 5.5A4.8 4.8 0 0 0 9 18v4"/><path d="M9 18c-4 1.5-4-2-6-2"/>',

    /* ---------------------------------------------------------- status */
    "clock": '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    "check": '<path d="m5 12 5 5L20 7"/>',
    "check-circle": '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5L16 9.5"/>',
    "x-circle": '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>',
    "alert": '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    "dot-live": '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="8"/>',
    "minus-circle": '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',

    /* ------------------------------------------------------- navigation */
    "search": '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    "sliders": '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
    "sort": '<path d="M7 4v16M7 20l-3-3M7 20l3-3"/><path d="M17 20V4M17 4l-3 3M17 4l3 3"/>',
    "chevron-right": '<path d="m9 6 6 6-6 6"/>',
    "chevron-down": '<path d="m6 9 6 6 6-6"/>',
    "arrow-right": '<path d="M5 12h14M13 6l6 6-6 6"/>',
    "arrow-left": '<path d="M19 12H5M11 18l-6-6 6-6"/>',
    "external": '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',

    /* ----------------------------------------------------------- action */
    "copy": '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    "plus": '<path d="M12 5v14M5 12h14"/>',
    "edit": '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/>',
    "trash": '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>',
    "send": '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
    "refresh": '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',

    /* --------------------------------------------------------- identity */
    "key": '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 8.3-8.3"/><path d="m16 6 3 3"/><path d="m19 3 2 2"/>',
    "lock": '<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    "wallet": '<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5"/><path d="M17 13h.01"/>',
    "user": '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
    "shield-alert": '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4M12 15h.01"/>',
    "fingerprint": '<path d="M12 10a2 2 0 0 0-2 2c0 3 .5 5-1 7"/><path d="M14 12a2 2 0 0 0-4 0c0 4-1 6-2 8"/><path d="M16 12a4 4 0 0 0-8 0c0 5-1.5 7-3 9"/><path d="M20 12a8 8 0 0 0-16 0c0 2-.4 3.6-1 5"/><path d="M5 6a9 9 0 0 1 14 0"/>',

    /* ----------------------------------------------------------- object */
    "briefcase": '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    "inbox": '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.4 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.4-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.8 1.1z"/>',
    "file": '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    "receipt": '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1V2l-2 1-2-1-2 1-2-1-2 1-2-1z"/><path d="M8 8h8M8 12h8M8 16h4"/>',
    "bell": '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    "settings": '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
    "logout": '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    "eye": '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    "hash": '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
    "book": '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    "scale": '<path d="m16 16 3-8 3 8c-.9.7-1.9 1-3 1s-2.1-.3-3-1z"/><path d="m2 16 3-8 3 8c-.9.7-1.9 1-3 1s-2.1-.3-3-1z"/><path d="M7 21h10M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>'
  };

  var NS = "http://www.w3.org/2000/svg";

  function svg(name, cls) {
    var d = P[name];
    if (!d) return null;
    var s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "1.6");
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    s.setAttribute("aria-hidden", "true");
    if (cls) s.setAttribute("class", cls);
    s.innerHTML = d;
    return s;
  }

  function paint(root) {
    var hosts = (root || document).querySelectorAll("[data-ico]");
    Array.prototype.forEach.call(hosts, function (el) {
      if (el.firstElementChild) return;             // already painted
      var g = svg(el.getAttribute("data-ico"));
      if (g) el.appendChild(g);
    });
  }

  window.FAIcon = { paint: paint, svg: svg, names: Object.keys(P) };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { paint(); });
  } else {
    paint();
  }
})();
