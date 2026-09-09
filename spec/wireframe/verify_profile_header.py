"""Prove no profile text straddles the banner edge, and that badges are solid.

WHY THIS EXISTS: reported 2026-08-27 with a screenshot. The profile header sat
at margin-top -44px, which dragged the name and its verified badge up onto the
banner's bottom edge. Half of each element rendered over the banner and half
over the page, so both read as clipped.

The social-profile convention is that ONLY the avatar breaks that edge. This
asserts exactly that:

  1. every text element in the header starts at or below the banner's bottom
  2. the avatar DOES overlap, because an avatar that does not is just a
     picture sitting above a rectangle
  3. the verified badge is a solid fill, not a translucent wash. It is the
     product's one claim and it has to look like one, so the test fails if its
     background alpha drops below 1.

Run with the wireframe served on 3110:
    python3 verify_profile_header.py
"""
import sys, os, json

_wg = os.environ.get("WEBGRAB_DIR", os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _wg)
try:
    from webgrab import Browser
except ImportError:
    sys.exit("webgrab.py not found. Set WEBGRAB_DIR to the directory containing it.")

BASE = os.environ.get("WF_BASE", "http://127.0.0.1:3110/")
SCREENS = ["agent.html", "operator.html"]

PROBE = """(function(){
  var banner = document.querySelector('.pbanner');
  var head = document.querySelector('.phead');
  if (!banner || !head) return JSON.stringify({ skip: true });

  var edge = banner.getBoundingClientRect().bottom;

  /* Every text carrier in the header. The avatar is excluded on purpose: it
     is the one element that SHOULD cross the edge. */
  var straddling = [];
  var texts = head.querySelectorAll('.pname, .pby, .pverified, .punverified, .btn');
  for (var i = 0; i < texts.length; i++) {
    var r = texts[i].getBoundingClientRect();
    if (r.height <= 0) continue;
    /* Straddling means it starts above the edge and ends below it. */
    if (r.top < edge - 0.5 && r.bottom > edge + 0.5) {
      straddling.push({
        el: (texts[i].className || texts[i].tagName).toString().slice(0, 24),
        top: Math.round(r.top), bottom: Math.round(r.bottom)
      });
    }
  }

  var av = head.querySelector('.pav');
  var avOverlap = av ? Math.round(edge - av.getBoundingClientRect().top) : 0;

  var badge = document.querySelector('.pverified, .punverified');
  var bg = badge ? getComputedStyle(badge).backgroundColor : '';
  /* rgba(...) with a fourth component below 1 means translucent. */
  var m = bg.match(/rgba?\\(([^)]+)\\)/);
  var alpha = 1;
  if (m) {
    var parts = m[1].split(',');
    if (parts.length > 3) alpha = parseFloat(parts[3]);
  }

  return JSON.stringify({
    edge: Math.round(edge),
    straddling: straddling,
    avatarOverlap: avOverlap,
    badgeBg: bg,
    badgeAlpha: alpha
  });
})()"""

fails = []
rows = []

b = Browser(width=1440, height=900)
try:
    for s in SCREENS:
        b.goto(BASE + s, wait=2.5)
        d = json.loads(b.js(PROBE))
        if d.get("skip"):
            continue
        rows.append((s, len(d["straddling"]), d["avatarOverlap"], d["badgeAlpha"]))
        if d["straddling"]:
            fails.append("%s: text straddles the banner edge %s" % (s, d["straddling"]))
        if d["avatarOverlap"] < 8:
            fails.append("%s: avatar does not break the banner edge (overlap %spx)"
                         % (s, d["avatarOverlap"]))
        if d["badgeAlpha"] < 0.99:
            fails.append("%s: badge is translucent (alpha %s, background %s). The "
                         "verified badge is the product's one claim and must be solid."
                         % (s, d["badgeAlpha"], d["badgeBg"]))
finally:
    b.close()

print("%-16s %12s %10s %8s" % ("screen", "straddling", "avOverlap", "alpha"))
print("-" * 50)
for s, st, ov, al in rows:
    print("%-16s %12d %10d %8s" % (s, st, ov, al))

if fails:
    print("\nFAILURES (%d):" % len(fails))
    for f in fails:
        print("  " + f)
else:
    print("\nno text straddles a banner edge, avatars overlap, badges are solid")

print("\nRESULT: " + ("PASS" if not fails else "FAIL"))
sys.exit(0 if not fails else 1)
