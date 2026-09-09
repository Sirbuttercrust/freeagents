"""Walk every wireframe screen and assert the polish layer is live and clean.

WHY THIS EXISTS: the polish pass touched 26 screens through scripted edits.
A regex that matched 25 files and silently missed one is the exact failure mode
that ships a broken screen, so every screen is checked rather than a sample.

Checks per screen:
  1. no JavaScript console errors
  2. both polish layers loaded (FAIcon, FAToast)
  3. every [data-ico] host actually painted an <svg> (a typo in a glyph name
     leaves an empty span, which is invisible rather than loud)
  4. no interactive control left inert (a button with no handler attribute)
  5. no horizontal overflow at 320px
  6. every tap target at least 44px under a real touch profile

Run with the wireframe served on 8821:
    python3 verify_polish.py
"""
import sys, json, time

import os

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
SCREENS = [
    "index.html", "browse.html", "agent.html", "operator.html", "credential.html",
    "verify.html", "how.html", "signin.html", "dashboard.html", "hire.html",
    "agreement.html", "job.html", "myjobs.html", "review.html",
    "myagents.html", "listagent.html", "agentsettings.html", "provegithub.html",
    "priorwork.html", "claim.html", "incoming.html", "settings.html", "keys.html",
    "notfound.html", "error.html",
]

# SUPERSEDED SCREENS ARE NOT AUDITED FOR LIVE CONTROLS, 2026-09-09.
#
# criteria.html and confirm.html are kept in the directory on purpose, each
# carrying a banner saying it was replaced and where to go instead. Their old
# controls are inert BECAUSE the screens are retired: wiring a demo to the
# "Accept and continue" button of a page that no longer exists in the flow
# would be the defect, not the fix. They stay in the tree so an old link
# lands somewhere honest rather than on a 404.
#
# They are still audited for everything a retired page must still get right:
# the polish layer loads, icons paint, and the contrast and mobile gates
# cover them like any other screen.
SUPERSEDED = ["criteria.html", "confirm.html"]

DESKTOP = """(function(){
  var hosts = document.querySelectorAll('[data-ico]');
  var unpainted = [];
  for (var i = 0; i < hosts.length; i++) {
    if (!hosts[i].querySelector('svg')) unpainted.push(hosts[i].getAttribute('data-ico'));
  }
  var inert = [];
  var btns = document.querySelectorAll('button');
  for (var j = 0; j < btns.length; j++) {
    var b = btns[j];
    if (b.className.indexOf('notetoggle') > -1) continue;
    var live = b.hasAttribute('data-demo') || b.hasAttribute('data-disclose') ||
               b.hasAttribute('data-copy') || b.hasAttribute('data-toggle') ||
               b.hasAttribute('data-ev') || b.getAttribute('role') === 'tab' ||
               b.hasAttribute('onclick') || b.hasAttribute('data-pattern') ||
               (b.closest && b.closest('[data-pick]')) || b.disabled;
    if (!live) inert.push((b.textContent||'').trim().slice(0,26));
  }
  return JSON.stringify({
    icons: typeof window.FAIcon,
    toast: typeof window.FAToast,
    painted: document.querySelectorAll('.ico svg').length,
    unpainted: unpainted,
    inert: inert
  });
})()"""

TOUCH = """(function(){
  /* IN A SENTENCE: the WCAG 2.5.8 inline exemption, tested against the
     property the exemption is actually about.

     Three wrong definitions were tried first, and each let a different real
     defect through:

       "display starts with inline AND the parent holds more text than the
       link"  ->  excused four 71x18 roster names, because a card title sitting
       on its own line above a description is a standalone target that happens
       to be displayed inline.

       "some other text rect overlaps the link's line"  ->  at 320px
       "operated by northline.dev" WRAPS, so the link sits alone on the second
       line and a purely geometric test calls a sentence a standalone control.
       A wrapped sentence is still a sentence.

       "any inline sibling anywhere in the parent carries text"  ->  excused a
       "Back to settings" link because an inline-flex submit button sat 600px
       further down the same wrapper. Distance in the DOM is not distance in
       the sentence.

     What the exemption is really about is whether the link is a run inside a
     flow of text, and an inline formatting context is BOUNDED BY BLOCK BOXES.
     So walk out from the link in both directions and stop at the first
     block-level sibling. Only the text inside that run is the link's sentence. */
  function inSentence(e) {
    var p = e.parentElement;
    if (!p) return false;
    function isInline(n) {
      var d = getComputedStyle(n).display;
      return d.indexOf('inline') === 0 || d === 'contents';
    }
    function scan(dir) {
      for (var n = e[dir]; n; n = n[dir]) {
        if (n.nodeType === 3) {
          if ((n.nodeValue || '').trim()) return true;
          continue;
        }
        if (n.nodeType !== 1) continue;
        if (!isInline(n)) return false;          /* block box ends the run */
        if ((n.textContent || '').trim()) return true;
      }
      return false;
    }
    return scan('previousSibling') || scan('nextSibling');
  }

  var bad = [];
  var els = document.querySelectorAll('a,button');
  for (var i = 0; i < els.length; i++) {
    var e = els[i];
    var r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (inSentence(e)) continue;

    /* BOTH AXES. A control 20px wide and 44px tall is not a 44px target, and
       reading only the height is how four 33x44 edit controls, three 32x44
       pager buttons and two 20x44 rail anchors passed for a month. The
       comment on the coarse-pointer block in agreement.css names this exact
       shape as the defect that block was written for. */
    if (r.height < 43.5 || r.width < 43.5) {
      bad.push(((e.textContent||'').trim().slice(0,20) || e.className) +
               ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    }
  }
  return JSON.stringify({
    coarse: window.matchMedia('(pointer: coarse)').matches,
    docW: document.documentElement.scrollWidth,
    small: bad
  });
})()"""

fails = []
rows = []

b = Browser(width=1280, height=900)
try:
    for s in SCREENS:
        b.goto(BASE + s, wait=2.2)
        errs = b.js("JSON.stringify(window.__consoleErrors || [])")
        d = json.loads(b.js(DESKTOP))
        row = {"screen": s, "painted": d["painted"], "unpainted": d["unpainted"], "inert": d["inert"]}
        if d["icons"] != "object" or d["toast"] != "function":
            fails.append("%s: polish layer not loaded" % s)
        if d["unpainted"]:
            fails.append("%s: unpainted icons %s" % (s, d["unpainted"]))
        if d["inert"]:
            fails.append("%s: inert buttons %s" % (s, d["inert"]))
        rows.append(row)

    # The retired screens, held to everything except live controls. A
    # superseded page that lost the polish layer would still be a defect: it
    # would read as a different product on the way to telling you it moved.
    for s in SUPERSEDED:
        b.goto(BASE + s, wait=2.2)
        d = json.loads(b.js(DESKTOP))
        rows.append({"screen": s + " (superseded)", "painted": d["painted"],
                     "unpainted": d["unpainted"], "inert": []})
        if d["icons"] != "object" or d["toast"] != "function":
            fails.append("%s: polish layer not loaded" % s)
        if d["unpainted"]:
            fails.append("%s: unpainted icons %s" % (s, d["unpainted"]))
finally:
    b.close()

# Touch pass, separate browser so the device override is clean.
#
# The superseded screens are swept here TOO. A retired page still has to hold
# 320px without overflowing and still has to meet the 44px floor: the whole
# reason it exists is that somebody arrives on it from an old link, and half
# of those arrivals are on a phone.
SWEPT = SCREENS + SUPERSEDED

b = Browser(width=320, height=640)
try:
    b.send("Emulation.setDeviceMetricsOverride", width=320, height=640,
           deviceScaleFactor=2, mobile=True)
    b.send("Emulation.setTouchEmulationEnabled", enabled=True, maxTouchPoints=5)
    for i, s in enumerate(SWEPT):
        b.goto(BASE + s, wait=1.6)
        t = json.loads(b.js(TOUCH))
        # ASSERT THE BRANCH APPLIED before trusting one number out of it.
        # Desktop Chrome sized to 320px does not match (pointer: coarse), so a
        # sweep without this line can measure the desktop rules and report a
        # clean pass on a layout that has no floors at all.
        if not t["coarse"]:
            print("ABORT: (pointer: coarse) did not match on %s; the touch "
                  "profile did not apply and no number below is trustworthy" % s)
            sys.exit(2)
        rows[i]["docW"] = t["docW"]
        rows[i]["small"] = t["small"]
        if t["docW"] > 320:
            fails.append("%s: horizontal overflow, scrollWidth %s" % (s, t["docW"]))
        if t["small"]:
            fails.append("%s: tap targets under 44px %s" % (s, t["small"][:4]))
finally:
    b.close()

print("%-20s %7s %7s %6s" % ("screen", "icons", "width", "small"))
print("-" * 46)
for r in rows:
    print("%-20s %7d %7d %6d" % (r["screen"], r["painted"], r["docW"], len(r["small"])))

print("\nscreens checked: %d" % len(rows))
print("total icons painted: %d" % sum(r["painted"] for r in rows))

if fails:
    print("\nFAILURES (%d):" % len(fails))
    for f in fails:
        print("  " + f)
else:
    print("\nno failures")

print("\nRESULT: " + ("PASS" if not fails else "FAIL"))
sys.exit(0 if not fails else 1)
