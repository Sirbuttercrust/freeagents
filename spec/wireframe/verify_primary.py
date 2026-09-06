#!/usr/bin/env python3
"""One accent-filled primary VISIBLE at a time, on every surface.

DATA-CONTRACT 8.10 claims "one primary per surface, not per document", which
is how staged.html can carry three btn-primary elements without breaking the
one-button-system rule: one on the page, one in each dialog, and a dialog
covers the page behind it.

That is a claim about what a person can see at once, so counting the class in
the source cannot check it. This opens each dialog in turn and counts the
PAINTED accent fills, which is the number a person actually experiences.

    python3 verify_primary.py [base-url]
"""

import json
import os
import sys

# wirebrowse.py sits beside this file, in the repo, standard library only.
# No WEBGRAB_DIR, no pip install, no external checkout: a reviewer with a
# clone, python3 and any Chrome can run this gate and disagree with its
# result. That is the whole point of committing the driver.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wirebrowse import Browser, NoBrowser

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3111"
SCREENS = ["hire.html", "agreement.html", "deposit.html", "staged.html",
           "pullrequest.html", "outcomes.html", "operatorjob.html",
           "conduct.html"]

# Painted primaries, and which surface each sits on. A dialog that is open is
# the active surface; anything behind it is covered.
PROBE = """
(function(){
  var out = [];
  document.querySelectorAll('.btn-primary').forEach(function(el){
    var r = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    if (r.width === 0 || r.height === 0) return;
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    var dlg = el.closest('dialog');
    if (dlg && !dlg.open) return;
    out.push({
      surface: dlg ? ('dialog#' + dlg.id) : 'page',
      text: (el.textContent||'').replace(/\\s+/g,' ').trim().slice(0, 44)
    });
  });
  return JSON.stringify(out);
})()
"""

b = Browser(1280, 1400)
fails = []
report = []
try:
    for s in SCREENS:
        b.goto(BASE + "/" + s)
        dialogs = json.loads(b.js(
            "JSON.stringify([].map.call(document.querySelectorAll('dialog'),"
            "function(d){return d.id;}))"))

        # The page with every dialog closed, then each dialog alone.
        states = [(None, "page, nothing open")] + [(d, "dialog #" + d) for d in dialogs]
        for dlg, label in states:
            b.js("document.querySelectorAll('dialog').forEach(function(d){"
                 "try{d.open&&d.close()}catch(e){d.removeAttribute('open')}})")
            if dlg:
                b.js("(function(){var d=document.getElementById('%s');"
                     "try{d.showModal()}catch(e){d.setAttribute('open','')}})()" % dlg)
            b.js("new Promise(function(r){setTimeout(r,150)})")

            painted = json.loads(b.js(PROBE))
            # What the person sees: primaries on the active surface only.
            active = "dialog#" + dlg if dlg else "page"
            visible = [p for p in painted if p["surface"] == active]
            covered = [p for p in painted if p["surface"] != active]

            report.append((s, label, len(visible), len(covered),
                           [p["text"] for p in visible]))
            if len(visible) > 1:
                fails.append("%s, %s: %d primaries competing on one surface: %s"
                             % (s, label, len(visible),
                                [p["text"] for p in visible]))
finally:
    b.close()

print("=" * 78)
print("ONE PRIMARY PER SURFACE")
print("=" * 78)
print("\n%-18s %-22s %-9s %s" % ("screen", "surface", "visible", "the one primary"))
for s, label, nvis, ncov, texts in report:
    print("%-18s %-22s %-9s %s"
          % (s, label, nvis, texts[0] if texts else "(none)"))

print()
if fails:
    print("FAIL, %d" % len(fails))
    for f in fails:
        print("  " + f)
    sys.exit(1)
print("PASS  no surface ever shows two accent fills at once. A screen may")
print("      declare several primaries; a person only ever meets one.")
