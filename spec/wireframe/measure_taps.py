"""Measure BOTH axes of every standalone tap target, on all 33 screens.

Scratch instrument written for D1 round 2. verify_polish.py's touch probe read
only r.height, so a control 20px wide and 44px tall passed. This one reads both
and prints every offender with its rect, so the fix can be aimed at the rule
rather than at whichever page happened to be open.
"""
import sys, json, os, glob

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from webgrab import Browser
except ImportError:
    from wirebrowse import Browser

BASE = os.environ.get("WF_BASE", "http://127.0.0.1:3111/")
HERE = os.path.dirname(os.path.abspath(__file__))
SCREENS = sorted(os.path.basename(p) for p in glob.glob(os.path.join(HERE, "*.html")))

PROBE = """(function(){
  var bad = [];
  var els = document.querySelectorAll('a,button');
  for (var i = 0; i < els.length; i++) {
    var e = els[i];
    var r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    var p = e.parentElement;
    var inlineInProse = p && getComputedStyle(e).display.indexOf('inline') === 0 &&
                        (p.textContent || '').trim().length > (e.textContent || '').trim().length + 2;
    if (inlineInProse) continue;
    if (r.height < 43.5 || r.width < 43.5) {
      bad.push({
        t: (e.textContent||'').trim().slice(0,22),
        c: e.className || e.tagName,
        w: Math.round(r.width), h: Math.round(r.height)
      });
    }
  }
  return JSON.stringify({
    coarse: window.matchMedia('(pointer: coarse)').matches,
    docW: document.documentElement.scrollWidth,
    bad: bad
  });
})()"""

b = Browser(width=320, height=640)
total = 0
try:
    b.send("Emulation.setDeviceMetricsOverride", width=320, height=640,
           deviceScaleFactor=2, mobile=True)
    b.send("Emulation.setTouchEmulationEnabled", enabled=True, maxTouchPoints=5)
    for s in SCREENS:
        b.goto(BASE + s, wait=1.6)
        d = json.loads(b.js(PROBE))
        if not d["coarse"]:
            print("ABORT: (pointer: coarse) did not match on " + s)
            sys.exit(2)
        if d["bad"]:
            print("===== %s   docW=%s" % (s, d["docW"]))
            for x in d["bad"]:
                print("   %-24s %-26s %dx%d" % (x["t"] or "(no text)", x["c"][:26], x["w"], x["h"]))
            total += len(d["bad"])
finally:
    b.close()

print("\ntotal under-floor controls across %d screens: %d" % (len(SCREENS), total))
sys.exit(0 if total == 0 else 1)
