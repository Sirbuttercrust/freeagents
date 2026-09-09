#!/usr/bin/env python3
"""Every screen keeps the chrome and the facts a person needs to read.

WHY THIS EXISTS.

The round-1 handoff claimed nothing was lost in the reconcile, and backed it
with a FILE-level check: every file on either parent branch exists on this
branch. That claim was true and it was not the claim that mattered. A file can
survive while an element inside it leaves, and two did:

  - the September agreement's technical disclosure, so the signature scheme,
    what the fingerprint covers and when the job id is assigned rendered on NO
    screen in the set
  - aria-label="FreeAgents home" on four brand links, where the wordmark
    collapses to a 44px mark at 320px and the label is the only thing left
    naming where the link goes

Both were found by a reviewer reading rendered text, which is not a thing that
reruns. This gate is the rerunnable version.

Two assertions, and they are different in kind:

  1. ACCESSIBLE NAME OF THE BRAND, computed by Chrome at 320px, on every
     screen. Not "the attribute is in the file": the attribute could be there
     and overridden, or the collapse rule could change. Ask the browser what a
     screen reader would say. base.css sets .brand{font-size:0} below 420px,
     so the visible word is gone and the accessible name is all there is.

  2. FACTS THAT MUST RENDER SOMEWHERE, searched across the rendered text of
     every screen with disclosures OPENED. Scoped to the set, not to one page,
     so moving a fact to a better home is allowed and losing it is not. A
     closed disclosure hides its content legitimately, so a sweep that never
     opens one reports a clean page in both the broken and the fixed states.

Run with the wireframe served:

    python3 verify_kept.py [base-url]
"""
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

import glob

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = (sys.argv[1] if len(sys.argv) > 1
        else os.environ.get("WF_BASE", "http://127.0.0.1:3111/"))
if not BASE.endswith("/"):
    BASE += "/"

SCREENS = sorted(os.path.basename(p) for p in glob.glob(os.path.join(HERE, "*.html")))

# The brand link is a link home on all 33 screens and its word disappears at
# 320px. Whatever the markup does, this is what it has to announce.
BRAND_NAME = "FreeAgents home"

# Facts that must render on SOME screen in the set, with disclosures open.
# Each is (search string, tier, why it has to survive).
#
# TIER MATTERS, and a single-tier version of this gate would be worse than
# none. The builder notes are hidden behind a toggle, so a fact demoted from
# the product surface into a note is invisible to a buyer while still being
# "on the screen". Two corpora keep that honest:
#
#   buyer   = what body.innerText holds with the notes layer OFF, which is
#             what a person using the product can read
#   builder = the same with notes ON, which is what someone building from the
#             wireframe reads
#
# A buyer fact demoted to a note FAILS. A builder fact is allowed to live in
# either place. Matching is on rendered text with whitespace collapsed, so a
# reflow or a wrap does not break a gate.
FACTS = [
    ("Ed25519, one signature per party per line", "buyer",
     "the signature scheme: without it, 'signed' is a word rather than a "
     "checkable claim"),
    ("criteria, price, currency, delivery window, deposit share, redo "
     "allowance, cancellation terms", "buyer",
     "what the fingerprint covers: a commercial term outside the hash is a "
     "term either side can later claim was different"),
    ("assigned at the lock, and appears in the pull request title", "buyer",
     "when the job id exists, which is what ties the agreement to the work"),
    ("No accept-all control", "builder",
     "the refusal that fourteen separate signatures exist to enforce"),
    ("A venue that takes a percentage may not guide the number", "builder",
     "the reason there is no price guidance anywhere in the flow"),
    ("the lines would stop being the agreement", "builder",
     "why there is no messaging thread on a screen about a deal"),
]

NOTES_ON = """(function(){
  document.body.classList.add('notes-on');
  return String(document.querySelectorAll('.note').length);
})()"""

OPEN_ALL = """(function(){
  document.querySelectorAll('details').forEach(function(d){ d.open = true; });
  /* The tree's disclosures are a button plus a .detail div toggled by
     polish.js, not <details>. Reveal them the way the page does. */
  document.querySelectorAll('.detail').forEach(function(d){
    d.classList.add('is-open'); d.hidden = false;
    d.style.display = 'block'; d.style.maxHeight = 'none';
  });
  document.querySelectorAll('[aria-expanded]').forEach(function(b){
    b.setAttribute('aria-expanded', 'true');
  });
  return '1';
})()"""

TEXT = """(function(){
  return (document.body.innerText || '').replace(/\\s+/g, ' ');
})()"""

BRAND = """(function(){
  var a = document.querySelector('a.brand');
  if (!a) return JSON.stringify({found: false});
  return JSON.stringify({
    found: true,
    /* what a screen reader would announce, computed rather than read out of
       the markup: aria-label, then the text content. */
    name: (a.getAttribute('aria-label') || a.textContent || '').trim(),
    fontSize: getComputedStyle(a).fontSize,
    w: Math.round(a.getBoundingClientRect().width),
    h: Math.round(a.getBoundingClientRect().height)
  });
})()"""

fails = []
rows = []
buyer_text = {}
builder_text = {}

b = Browser(width=320, height=640)
try:
    b.send("Emulation.setDeviceMetricsOverride", width=320, height=640,
           deviceScaleFactor=2, mobile=True)
    b.send("Emulation.setTouchEmulationEnabled", enabled=True, maxTouchPoints=5)
    for s in SCREENS:
        b.goto(BASE + s, wait=1.3)
        d = json.loads(b.js(BRAND))
        if not d["found"]:
            fails.append("%s: no a.brand at all" % s)
            rows.append((s, "(none)", "-"))
            continue
        if d["name"] != BRAND_NAME:
            fails.append("%s: brand announces %r, wanted %r (the word is "
                         "%s at 320px, so the name is all there is)"
                         % (s, d["name"], BRAND_NAME, d["fontSize"]))
        rows.append((s, d["name"], d["fontSize"]))
        # Disclosures open, notes still OFF: this is the product surface.
        b.js(OPEN_ALL)
        buyer_text[s] = b.js(TEXT) or ""
        # Now the builder layer as well.
        b.js(NOTES_ON)
        builder_text[s] = b.js(TEXT) or ""
finally:
    b.close()

print("%-24s %-18s %s" % ("screen", "brand announces", "wordmark"))
print("-" * 56)
for s, name, fs in rows:
    print("%-24s %-18s %s" % (s, name, fs))

print("\n%-46s %-8s %s" % ("fact that must render somewhere", "tier", "where"))
print("-" * 78)
for text, tier, why in FACTS:
    want = " ".join(text.split())
    corpus = buyer_text if tier == "buyer" else builder_text
    where = sorted(s for s, t in corpus.items() if want in t)
    print("%-46s %-8s %s" % (want[:44], tier, ", ".join(where) if where else "NOWHERE"))
    if not where:
        # Say WHICH corpus missed it, because "in a note instead of on the
        # screen" and "gone entirely" need different fixes.
        demoted = tier == "buyer" and any(want in t for t in builder_text.values())
        fails.append(
            "%s fact %r renders on no screen%s. It carried: %s"
            % (tier, want[:56],
               " (it is in the builder notes, which a buyer never opens)" if demoted else "",
               why))

print("\nscreens checked: %d" % len(rows))
if fails:
    print("\nFAILURES (%d):" % len(fails))
    for f in fails:
        print("  " + f)
else:
    print("\nno failures")

print("\nRESULT: " + ("PASS" if not fails else "FAIL"))
sys.exit(0 if not fails else 1)
