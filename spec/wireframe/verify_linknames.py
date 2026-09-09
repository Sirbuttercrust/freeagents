#!/usr/bin/env python3
"""A link that names its destination must name it correctly.

WHY THIS EXISTS. The set linked to `operator.html` from six screens with the
label `northline.dev`, and `operator.html` is `northsound.dev`. Both parent
branches did it, so it arrived as inherited rather than introduced, and it
survived three rounds of review because no gate compared a link's TEXT against
the page it opens. Every gate asked whether a link resolves; none asked whether
it tells the truth about where it goes.

That was not a naming preference, which is why it is fixable without an
operator ruling. It was a contradiction the tree itself settles:

  hire.html offers `northline/design-tokens` as one of "the four public
  repositories on YOUR confirmed GitHub account", so northline is the BUYER.

  operatorjob.html says "A brief arrived from northline.dev", which is the
  buyer commissioning the work.

  deposit.html then said the buyer's money goes "straight from your wallet to
  northline.dev", which pays the buyer their own money, and six screens said
  axiom-ui was "operated by northline.dev", which puts the buyer on both sides
  of a two-party agreement.

The rule this gate enforces needs no ruling either: whatever the operator is
called, a link to `operator.html` has to say what `operator.html` says.

NOT A DEFECT, and deliberately not flagged: `conduct.html` shows northline.dev
with sections titled "When they hire" and "When their agents are hired". An
account being both a buyer and an operator is that screen's entire subject, so
it is excluded by name with this reason attached.

    python3 devserver.py 3111 &
    python3 verify_linknames.py [base-url]
"""
import glob
import json
import os
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

# destination page -> the selector holding the name that page calls itself.
# Read from the page rather than hardcoded, so renaming the operator is a
# one-file change and this gate follows it.
IDENTITY = {
    "operator.html": ".pname",
    "agent.html": ".pname",
}

# Screens excused, each with the reason on the line. An exemption without a
# reason is a place for a real defect to hide.
EXCUSED = {
    "conduct.html": "shows one account acting as BOTH buyer and operator, "
                    "which is the screen's subject",
}

NAME_JS = """(function(){
  var e = document.querySelector(%s);
  return e ? (e.textContent || '').trim().split('\\n')[0].trim() : '';
})()"""

LINKS_JS = """(function(){
  var out = [];
  document.querySelectorAll('a[href]').forEach(function (a) {
    var h = (a.getAttribute('href') || '').split('#')[0];
    if (!h || h.indexOf('.html') < 0) return;
    out.push({href: h, text: (a.textContent || '').trim().slice(0, 60)});
  });
  return JSON.stringify(out);
})()"""

fails = []
rows = []

b = Browser(width=1280, height=900)
try:
    # What each destination calls itself.
    names = {}
    for page, sel in IDENTITY.items():
        b.goto(BASE + page, wait=1.4)
        names[page] = b.js(NAME_JS % json.dumps(sel)) or ""
        print("%-18s calls itself %r" % (page, names[page]))
    print()

    for s in SCREENS:
        b.goto(BASE + s, wait=1.2)
        links = json.loads(b.js(LINKS_JS))
        for link in links:
            want = names.get(link["href"])
            if not want:
                continue
            text = link["text"]
            # Only links whose TEXT is a name are checked. "Their agents",
            # "Back to the profile" and the like name a destination by its
            # function, which is correct and is not a claim about identity.
            if "." not in text or " " in text:
                continue
            rows.append((s, link["href"], text, want))
            if text != want:
                if s in EXCUSED:
                    rows[-1] = (s, link["href"], text, want + "  (excused)")
                    continue
                fails.append("%s: a link to %s is labelled %r, but that page "
                             "calls itself %r" % (s, link["href"], text, want))
finally:
    b.close()

print("%-20s %-16s %-18s %s" % ("screen", "links to", "labelled", "destination says"))
print("-" * 76)
for s, href, text, want in rows:
    print("%-20s %-16s %-18s %s" % (s, href, text, want))

print("\nlinks checked: %d across %d screens" % (len(rows), len(SCREENS)))
for page, why in EXCUSED.items():
    print("excused: %s, %s" % (page, why))

if fails:
    print("\nFAILURES (%d):" % len(fails))
    for f in fails:
        print("  " + f)
    print("\nRESULT: FAIL")
    sys.exit(1)

print("\nno failures")
print("\nRESULT: PASS")
sys.exit(0)
