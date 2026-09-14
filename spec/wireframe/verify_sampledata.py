#!/usr/bin/env python3
"""Every screen showing sample data says it is sample data.

WHY THIS EXISTS. BUILD-STATE.md asserted "sample data is labelled as sample
data" across the set. Measured, it held on five screens out of the twenty-five
that show an invented name or a dollar figure. Three of those five said so in
a hand-written note, which is exactly why the claim was false while the
practice was real: a per-page note covers the pages somebody remembered.

DEFINITION, so the rule is not scoped to whichever pages a reviewer read: a
screen shows sample data if its rendered text carries one of the invented
identity names or a dollar figure. A screen that does is required to say so
somewhere a builder can read.

The marker is injected by wireframe.js on every screen, so this gate is mostly
guarding against that injection being removed or a screen being added that
does not load the file. It fails on either.

    python3 devserver.py 3111 &
    python3 verify_sampledata.py [base-url]
"""
import glob
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
_wg = os.environ.get("WEBGRAB_DIR")
if _wg and os.path.exists(os.path.join(_wg, "webgrab.py")):
    sys.path.insert(0, _wg)
try:
    from webgrab import Browser
except ImportError:
    from wirebrowse import Browser

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = (sys.argv[1] if len(sys.argv) > 1
        else os.environ.get("WF_BASE", "http://127.0.0.1:3111/"))
if not BASE.endswith("/"):
    BASE += "/"
SCREENS = sorted(os.path.basename(p) for p in glob.glob(os.path.join(HERE, "*.html")))

# The invented cast and the invented money. Nothing here names a real company,
# a real person or a real repository.
SAMPLE_TOKENS = ["axiom-ui", "tessellate", "northline", "northsound",
                 "design-tokens", "acme/", "did:abt:"]
MONEY = re.compile(r"\$[0-9][0-9,]*")

# What counts as saying so.
MARKERS = ["sample", "illustrative", "placeholder", "example data",
           "fictional", "invented", "made up", "not real"]

OPEN_ALL = """(function(){
  document.querySelectorAll('details').forEach(function(d){ d.open = true; });
  document.querySelectorAll('.detail').forEach(function(d){
    d.classList.add('is-open'); d.hidden = false;
    d.style.display = 'block'; d.style.maxHeight = 'none';
  });
  return '1';
})()"""

NOTES_ON = """(function(){
  document.body.classList.add('notes-on');
  return String(document.querySelectorAll('.note').length);
})()"""

TEXT = """(function(){
  return (document.body.innerText || '').replace(/\\s+/g, ' ');
})()"""

b = Browser(width=1280, height=900)
need = []
have = []
clean = []
try:
    for s in SCREENS:
        b.goto(BASE + s, wait=1.2)
        b.js(OPEN_ALL)
        buyer = b.js(TEXT) or ""
        b.js(NOTES_ON)
        builder = b.js(TEXT) or ""

        low_buyer = buyer.lower()
        toks = [t for t in SAMPLE_TOKENS if t in low_buyer]
        money = MONEY.findall(buyer)
        shows = bool(toks or money)
        marks = [m for m in MARKERS if m in builder.lower()]

        if not shows:
            clean.append(s)
        elif marks:
            have.append((s, toks[:3], len(money), marks))
        else:
            need.append((s, toks[:3], len(money)))
finally:
    b.close()

print("SHOWS SAMPLE DATA AND SAYS SO (%d)" % len(have))
for s, toks, n, marks in have:
    print("  %-22s tokens=%-34s money=%-3d marker=%s" % (s, ",".join(toks), n, marks[:2]))

print("\nSHOWS SAMPLE DATA AND DOES NOT SAY SO (%d)" % len(need))
for s, toks, n in need:
    print("  %-22s tokens=%-34s money=%d" % (s, ",".join(toks), n))

print("\nNO SAMPLE DATA ON SCREEN (%d)" % len(clean))
print("  " + ", ".join(clean))

print("\nscreens checked: %d" % len(SCREENS))
if need:
    print("\nFAILURES (%d):" % len(need))
    for s, toks, n in need:
        print("  %s shows sample data (%s%s) and never says it is sample data"
              % (s, ",".join(toks) or "no name", ", %d dollar figures" % n if n else ""))
    print("\nRESULT: FAIL")
    sys.exit(1)

print("\nno failures")
print("\nRESULT: PASS")
sys.exit(0)
