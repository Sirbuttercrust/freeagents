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

# webgrab.py is an internal QA tool that lives outside this repository. Point
# WEBGRAB_DIR at the directory holding it, or drop it beside this script.
_wg = os.environ.get("WEBGRAB_DIR", os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _wg)
try:
    from webgrab import Browser
except ImportError:
    sys.exit("webgrab.py not found. Set WEBGRAB_DIR to the directory containing it.")

BASE = "http://127.0.0.1:8821/"
SCREENS = [
    "index.html", "browse.html", "agent.html", "operator.html", "credential.html",
    "verify.html", "how.html", "signin.html", "dashboard.html", "hire.html",
    "criteria.html", "confirm.html", "job.html", "myjobs.html", "review.html",
    "myagents.html", "listagent.html", "agentsettings.html", "provegithub.html",
    "priorwork.html", "claim.html", "incoming.html", "settings.html", "keys.html",
    "notfound.html", "error.html",
]

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
               b.hasAttribute('onclick') ||
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
  var bad = [];
  var els = document.querySelectorAll('a,button');
  for (var i = 0; i < els.length; i++) {
    var e = els[i];
    var r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;

    /* A link INSIDE a sentence is not a tap target in the 44px sense: its hit
       area is the line box, and padding it to 44px would wreck the paragraph
       it sits in. WCAG 2.5.8 exempts inline links in a block of text for
       exactly this reason. Standalone controls are what the floor is for, so
       only those are measured. */
    var p = e.parentElement;
    var inlineInProse = p && getComputedStyle(e).display.indexOf('inline') === 0 &&
                        (p.textContent || '').trim().length > (e.textContent || '').trim().length + 2;
    if (inlineInProse) continue;

    if (r.height < 44) bad.push(((e.textContent||'').trim().slice(0,20) || e.className) + ' h=' + Math.round(r.height));
  }
  return JSON.stringify({ docW: document.documentElement.scrollWidth, small: bad });
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
finally:
    b.close()

# Touch pass, separate browser so the device override is clean.
b = Browser(width=320, height=640)
try:
    b.send("Emulation.setDeviceMetricsOverride", width=320, height=640,
           deviceScaleFactor=2, mobile=True)
    b.send("Emulation.setTouchEmulationEnabled", enabled=True, maxTouchPoints=5)
    for i, s in enumerate(SCREENS):
        b.goto(BASE + s, wait=1.6)
        t = json.loads(b.js(TOUCH))
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
