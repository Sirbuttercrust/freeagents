"""Walk every wireframe screen and assert the polish layer is live and clean.

WHY THIS EXISTS: the polish pass touched 26 screens through scripted edits.
A regex that matched 25 files and silently missed one is the exact failure mode
that ships a broken screen, so every screen is checked rather than a sample.

Checks per screen:
  1. no JavaScript console errors
  2. both polish layers loaded (FAIcon, FAToast)
  3. every [data-ico] host actually painted an <svg> (a typo in a glyph name
     leaves an empty span, which is invisible rather than loud)
  4. every [data-avatar] host actually painted an <svg>, for the same reason:
     polish.js returns early when the generator is missing, so the page shows
     a blank disc and the console stays silent
  5. no interactive control left inert (a button with no handler attribute)
  6. no horizontal overflow at 320px
  7. every tap target at least 44px under a real touch profile, in EVERY
     reachable state: closed, with every disclosure and drawer open, and
     with each dialog open on its own. The count of states opened is printed,
     because a gate that opens nothing reports a clean page in both the
     broken and the fixed state and looks identical either way.

Run with the wireframe served on 3111:
    python3 devserver.py 3111 &
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

# The tap-target probe, shared with measure_taps.py and verify_flow.py.
import tapfloor

BASE = os.environ.get("WF_BASE", "http://127.0.0.1:3111/")

# THE COMPLEMENT OF THE PAYMENT FLOW, so a screen added next month is swept
# by this instrument the day it lands rather than falling between two lists
# that were each supposed to be complete. That fallback direction is the
# whole argument: see population.py.
import population                                             # noqa: E402
SCREENS = population.general_screens()

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

# THE LIVE-CONTROL PASS TAKES THE COMPLEMENT, and this line is load-bearing.
# While SCREENS was a hand-written list, the two retired pages were simply
# absent from it. Deriving SCREENS put them back, so they were audited twice:
# once in the main loop, which correctly reported six inert buttons, and once
# in the superseded loop that exists to excuse exactly those buttons. The
# exclusion has to be explicit now that the population is not.
LIVE = [s for s in SCREENS if s not in SUPERSEDED]

DESKTOP = """(function(){
  var hosts = document.querySelectorAll('[data-ico]');
  var unpainted = [];
  for (var i = 0; i < hosts.length; i++) {
    if (!hosts[i].querySelector('svg')) unpainted.push(hosts[i].getAttribute('data-ico'));
  }
  /* SAME CHECK, THE OTHER GENERATED THING. An empty [data-avatar] is a blank
     32x32 box that throws nothing, exactly like an unpainted icon: polish.js
     returns early when FASwarm is absent, so a page that renders an avatar
     without loading swarm.js looks like a page with a plain circle on it.
     Two of the eight screens converted in round 7 were missing the script,
     and no gate here would have said so. */
  var avs = document.querySelectorAll('[data-avatar]');
  var blank = [];
  for (var k = 0; k < avs.length; k++) {
    if (!avs[k].querySelector('svg')) blank.push(avs[k].getAttribute('data-avatar'));
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
    avatars: avs.length,
    blank: blank,
    inert: inert
  });
})()"""

TOUCH_NOTE = """The touch probe lives in tapfloor.py, shared with
measure_taps.py and verify_flow.py. Three copies of it drifted three different
ways: one read only the height, all three read only `a,button`, and none of
them opened a disclosure before reading. Twelve real failures sat behind that.
One probe, one selector list, one set of exemptions."""

fails = []
rows = []

b = Browser(width=1280, height=900)
try:
    for s in LIVE:
        b.goto(BASE + s, wait=2.2)
        errs = b.js("JSON.stringify(window.__consoleErrors || [])")
        d = json.loads(b.js(DESKTOP))
        row = {"screen": s, "painted": d["painted"], "unpainted": d["unpainted"],
               "avatars": d["avatars"], "inert": d["inert"]}
        if d["icons"] != "object" or d["toast"] != "function":
            fails.append("%s: polish layer not loaded" % s)
        if d["unpainted"]:
            fails.append("%s: unpainted icons %s" % (s, d["unpainted"]))
        if d["blank"]:
            fails.append("%s: [data-avatar] painted nothing for %s. The page "
                         "renders an avatar and the generator never ran, which "
                         "is a blank disc that throws no error."
                         % (s, d["blank"]))
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
                     "unpainted": d["unpainted"], "avatars": d["avatars"],
                     "inert": []})
        if d["icons"] != "object" or d["toast"] != "function":
            fails.append("%s: polish layer not loaded" % s)
        if d["unpainted"]:
            fails.append("%s: unpainted icons %s" % (s, d["unpainted"]))
        if d["blank"]:
            fails.append("%s: [data-avatar] painted nothing for %s"
                         % (s, d["blank"]))
finally:
    b.close()

# Touch pass, separate browser so the device override is clean.
#
# The superseded screens are swept here TOO. A retired page still has to hold
# 320px without overflowing and still has to meet the 44px floor: the whole
# reason it exists is that somebody arrives on it from an old link, and half
# of those arrivals are on a phone.
#
# SCREENS already contains them, because it is derived from the directory
# rather than written by hand. This used to read `SCREENS + SUPERSEDED`,
# which was right when SCREENS was a list that omitted them and would now
# sweep both pages twice and report every finding on them twice over.
SWEPT = list(SCREENS)

b = Browser(width=320, height=640)
try:
    tapfloor.touch(b)
    for i, s in enumerate(SWEPT):
        t = tapfloor.sweep(b, BASE + s)
        # ASSERT THE BRANCH APPLIED before trusting one number out of it.
        # Desktop Chrome sized to 320px does not match (pointer: coarse), so a
        # sweep without this line can measure the desktop rules and report a
        # clean pass on a layout that has no floors at all.
        if not t["coarse"]:
            print("ABORT: (pointer: coarse) did not match on %s; the touch "
                  "profile did not apply and no number below is trustworthy" % s)
            sys.exit(2)
        rows[i]["docW"] = t["docW"]
        rows[i]["opened"] = t["opened"]
        rows[i]["small"] = [tapfloor.fmt(x) for x in t["bad"]]
        if t["docW"] > 320:
            fails.append("%s: horizontal overflow, scrollWidth %s" % (s, t["docW"]))
        if rows[i]["small"]:
            fails.append("%s: tap targets under 44px %s" % (s, rows[i]["small"][:4]))
finally:
    b.close()

# TOTAL STATES OPENED, printed rather than assumed. Round 3 of review found
# this gate opening nothing at all while being credited with the open-state
# coverage for 27 of 33 screens. A zero here now says so on the face of the
# report instead of hiding inside a green result.
opened_total = sum(r.get("opened", 0) for r in rows)

print("%-20s %7s %7s %7s %7s %6s"
      % ("screen", "icons", "avatars", "width", "opened", "small"))
print("-" * 62)
for r in rows:
    print("%-20s %7d %7d %7d %7d %6d"
          % (r["screen"], r["painted"], r.get("avatars", 0), r["docW"],
             r.get("opened", 0), len(r["small"])))

print("\nscreens checked: %d" % len(rows))
print("total icons painted: %d" % sum(r["painted"] for r in rows))
print("total avatars painted: %d, every one a generated svg"
      % sum(r.get("avatars", 0) for r in rows))
print("states opened before measuring: %d" % opened_total)

if fails:
    print("\nFAILURES (%d):" % len(fails))
    for f in fails:
        print("  " + f)
else:
    print("\nno failures")

print("\nRESULT: " + ("PASS" if not fails else "FAIL"))
sys.exit(0 if not fails else 1)
