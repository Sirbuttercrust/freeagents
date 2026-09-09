"""Prove the polish layer's reduced-motion behaviour across the platform.

The design law: every animation gates on prefers-reduced-motion and leaves a
DIGNIFIED STATIC end state. "Gated" is not the same as "suppressed": an
element whose transition is switched off while it sits at its hidden starting
state renders as missing content, which is worse than the animation.

So this asserts the END STATE, not the absence of motion:
  1. every .reveal and .stagger child is fully visible (opacity 1, no offset)
  2. the tab underline and panels still resolve to a readable state
  3. no element is left at opacity 0 or translated off its resting position

base.css ends with a global `* { transition: none !important }` under reduce,
so this also confirms that blanket rule cannot strand anything hidden.

Run with the wireframe served on 8821:
    python3 verify_reduced_motion.py
"""
import sys, json

import os

# webgrab.py is an internal QA tool that lives outside this repository. Point
# WEBGRAB_DIR at the directory holding it, or drop it beside this script.
_wg = os.environ.get("WEBGRAB_DIR", os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _wg)
try:
    from webgrab import Browser
except ImportError:
    sys.exit("webgrab.py not found. Set WEBGRAB_DIR to the directory containing it.")

BASE = os.environ.get("WF_BASE", "http://127.0.0.1:3110/")
SCREENS = [
    "index.html", "browse.html", "agent.html", "operator.html", "credential.html",
    "verify.html", "how.html", "signin.html", "dashboard.html", "hire.html",
    "criteria.html", "confirm.html", "job.html", "myjobs.html", "review.html",
    "myagents.html", "listagent.html", "agentsettings.html", "provegithub.html",
    "priorwork.html", "claim.html", "incoming.html", "settings.html", "keys.html",
    "notfound.html", "error.html",
]

PROBE = """(function(){
  function hidden(el){
    var s = getComputedStyle(el);
    if (parseFloat(s.opacity) < 0.99) return 'opacity ' + s.opacity;
    var t = s.transform;
    if (t && t !== 'none') {
      var m = t.match(/matrix\\(([^)]+)\\)/);
      if (m) {
        var p = m[1].split(',').map(parseFloat);
        if (Math.abs(p[4]) > 0.5 || Math.abs(p[5]) > 0.5) return 'translated ' + p[4] + ',' + p[5];
      }
    }
    return null;
  }
  var bad = [];
  var nodes = document.querySelectorAll('.reveal, .stagger > *, .spy, .tabpanel:not([hidden]), .skel');
  for (var i = 0; i < nodes.length; i++) {
    var why = hidden(nodes[i]);
    if (why) bad.push((nodes[i].className || nodes[i].tagName).toString().slice(0, 30) + ': ' + why);
  }
  return JSON.stringify({
    reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    checked: nodes.length,
    hiddenContent: bad.slice(0, 6)
  });
})()"""

fails = []
rows = []

b = Browser(width=1280, height=900)
try:
    b.send("Emulation.setEmulatedMedia",
           features=[{"name": "prefers-reduced-motion", "value": "reduce"}])
    for s in SCREENS:
        b.goto(BASE + s, wait=1.8)
        d = json.loads(b.js(PROBE))
        rows.append((s, d["checked"], len(d["hiddenContent"])))
        if not d["reduced"]:
            fails.append("%s: reduced-motion media query did not apply" % s)
        if d["hiddenContent"]:
            fails.append("%s: content stranded hidden %s" % (s, d["hiddenContent"]))
finally:
    b.close()

print("%-20s %8s %8s" % ("screen", "checked", "hidden"))
print("-" * 38)
for s, c, h in rows:
    print("%-20s %8d %8d" % (s, c, h))

print("\nscreens: %d, elements checked: %d" % (len(rows), sum(r[1] for r in rows)))

if fails:
    print("\nFAILURES (%d):" % len(fails))
    for f in fails:
        print("  " + f)
else:
    print("\nno content stranded hidden under reduced motion")

print("\nRESULT: " + ("PASS" if not fails else "FAIL"))
sys.exit(0 if not fails else 1)
