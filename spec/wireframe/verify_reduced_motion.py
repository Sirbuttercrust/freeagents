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

Run it with the wireframe served. The default is http://127.0.0.1:3111/,
which is what `python3 devserver.py 3111` serves; WF_BASE names any other
server, trailing slash included:
    python3 devserver.py 3111
    python3 verify_reduced_motion.py
    WF_BASE=http://127.0.0.1:8080/ python3 verify_reduced_motion.py

It prints RESULT: FAIL and exits 1 on any of these, and exits 0 only when
none happened:
  1. nothing answers at WF_BASE: one line naming WF_BASE and the error, and
     no browser is started
  2. a screen did not load: no answer, a status other than 200, or a final
     URL other than the one requested (the line names the screen, the status
     and where it landed)
  3. an element is left stranded hidden: opacity under 0.99 or translated
     off its resting position
  4. the reduced-motion media query did not apply on a screen
  5. no element was measured across the whole run (one screen with none is
     fine, since not every screen carries these classes)
"""
import sys, json

import os
import urllib.error
import urllib.request

# THE DRIVER, WITHOUT AN ENVIRONMENT.
#
# wirebrowse.py is committed beside this file and exposes the same Browser
# API, so this gate runs from a clone with python3 and any Chrome. webgrab.py
# is an internal tool that lives outside this repository; if WEBGRAB_DIR names
# a directory that really holds it, it is used, and otherwise the committed
# driver is. DESIGN.md section 10: a gate a reviewer cannot run is a claim,
# not a check.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
_wg = os.environ.get("WEBGRAB_DIR")
if _wg and os.path.exists(os.path.join(_wg, "webgrab.py")):
    sys.path.insert(0, _wg)
try:
    from webgrab import Browser
except ImportError:
    from wirebrowse import Browser

BASE = os.environ.get("WF_BASE", "http://127.0.0.1:3111/")

# EVERY SCREEN. DESIGN.md section 6 states the reduced-motion rule of the
# whole set, and this used to name 26, so the seven payment screens drawn in
# September were never asked whether their motion has a dignified static end.
import population                                             # noqa: E402
SCREENS = population.every_screen()

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

# WHAT THE PAGE ACTUALLY LOADED AS. Browser.goto discards what Page.navigate
# answers, so the state is read from the page itself: the navigation entry's
# responseStatus (200 served, 404 missing, 0 on Chrome's error page) and the
# URL it ended at (chrome-error://chromewebdata/ when nothing answered).
LOADED = """(function(){
  var nav = performance.getEntriesByType('navigation')[0];
  return JSON.stringify({status: nav ? nav.responseStatus : 0,
                         url: location.href});
})()"""


def base_error():
    """None when something answers at BASE, else what went wrong.

    Any HTTP status counts as an answer here. A page the server lacks is
    reported per page, with its status, once the browser has been there.
    """
    try:
        urllib.request.urlopen(BASE, timeout=10).close()
    except urllib.error.HTTPError:
        return None
    except (urllib.error.URLError, OSError, ValueError) as e:
        return getattr(e, "reason", None) or e
    return None


err = base_error()
if err is not None:
    print("WF_BASE %s did not answer: %s. Start the wireframe server "
          "(python3 devserver.py 3111) or set WF_BASE to one that is "
          "running." % (BASE, err))
    print("RESULT: FAIL")
    sys.exit(1)

fails = []
rows = []

b = Browser(width=1280, height=900)
try:
    b.send("Emulation.setEmulatedMedia",
           features=[{"name": "prefers-reduced-motion", "value": "reduce"}])
    for s in SCREENS:
        b.goto(BASE + s, wait=1.8)
        loaded = json.loads(b.js(LOADED) or '{"status": 0, "url": "unreadable"}')
        if loaded["status"] != 200 or loaded["url"] != BASE + s:
            fails.append("%s: did not load (status %s, at %s)"
                         % (s, loaded["status"], loaded["url"]))
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

total = sum(r[1] for r in rows)
print("\nscreens: %d, elements checked: %d" % (len(rows), total))

if total == 0:
    fails.append("nothing was measured: 0 elements checked across %d screens"
                 % len(rows))

if fails:
    print("\nFAILURES (%d):" % len(fails))
    for f in fails:
        print("  " + f)
else:
    print("\nno content stranded hidden under reduced motion")

print("\nRESULT: " + ("PASS" if not fails else "FAIL"))
sys.exit(0 if not fails else 1)
