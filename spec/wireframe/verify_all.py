#!/usr/bin/env python3
"""Run every gate in this directory and report one table.

Exists so a reviewer runs ONE command instead of ten, and so the list of what
is covered cannot drift from the list of what actually runs. A gate that is
not in this file does not get run, and a gate in this file that has rotted
fails here.

    python3 devserver.py 3111 &
    python3 verify_all.py [base-url]

NO ENVIRONMENT SETUP. Round 2 of review found that most gates imported a
browser driver that was not in the repo, which made every green result here
unreproducible by anybody else. The driver (wirebrowse.py) and the preview
server (devserver.py) are now committed beside the gates and use the standard
library only, so a clone plus python3 plus any Chrome is the whole toolchain.

Exit 0 only if every gate exits 0.
Exit 3 if no browser could be found, which is not a pass and not a failure.
The mutation tests are NOT run here: they take several minutes and
deliberately edit files, so they are run on their own.
"""

import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3111"

# name, takes a base url, one line saying what it covers
GATES = [
    ("verify_flow.py", True,
     "320px overflow closed and open, row overlap, tap targets, dead controls, accent, reduced motion, em dashes"),
    ("verify_links.py", True,
     "every local link resolves, every live page reachable"),
    ("verify_sitemap.py", False,
     "SITEMAP build claims match the directory, no page served without an id"),
    ("verify_tokens.py", False,
     "WCAG ratios computed by hand, no browser"),
    ("verify_ink.py", True,
     "every rendered character against AA, ink composited over the pixel measured behind it"),
    ("verify_names.py", True,
     "no two controls reachable at once answer to the same name"),
    ("verify_money.py", True,
     "every dollar figure derives from one model of the deal"),
    ("verify_rail.py", True,
     "the total, fee and pay button follow the chosen rail"),
    ("verify_pickers.py", True,
     "picker rows trace to real agreement lines, omissions explained"),
    ("verify_primary.py", True,
     "no surface shows two accent-filled primaries at once"),

    # The six from the polished pass. They read the base url from WF_BASE
    # rather than argv, which is why they are marked as not taking a url:
    # handing them one positionally would be silently ignored and they would
    # audit whatever happened to be on their default port. WF_BASE is set
    # below from the same BASE every other gate gets.
    ("verify_polish.py", False,
     "the polish layer loads, icons paint, no inert buttons, 320px with 44px targets"),
    ("verify_profile_header.py", False,
     "the profile header never clips its banner, the verified badge reads as a stamp"),
    ("verify_agents_below.py", False,
     "decorative agents never paint over text, asked at six scroll positions"),
    ("verify_reduced_motion.py", False,
     "every animation has a static end state under prefers-reduced-motion"),
    ("verify_flow_motion.py", False,
     "the dashboard pipeline moves, and stops when reduced motion is asked for"),
    ("verify_blast_preview.py", False,
     "hovering an edit control previews the exact signatures it would clear"),
    ("verify_mobile_coverage.py", False,
     "every screen on disk is swept at 320px by at least one instrument"),
]

env = dict(os.environ)
# The polished gates take their url from the environment. Setting it here
# means one command audits one tree: without it they would default to their
# own port and could report a clean pass against a server that was not the
# one under test, or a wall of failures against nothing at all.
env["WF_BASE"] = BASE if BASE.endswith("/") else BASE + "/"

results = []
for name, takes_url, covers in GATES:
    path = os.path.join(HERE, name)
    if not os.path.exists(path):
        results.append((name, None, 0.0, "MISSING FROM DISK", covers))
        continue
    cmd = [sys.executable, path] + ([BASE] if takes_url else [])
    t0 = time.time()
    p = subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=HERE)
    dt = time.time() - t0
    # Exit 3 is "no browser on this machine". Reported as its own state, never
    # folded into pass or fail, so an unrunnable suite cannot read as green.
    if p.returncode == 3:
        print("NO BROWSER. %s could not start Chrome:" % name)
        print(p.stdout.strip()[:600])
        sys.exit(3)
    # The September gates open with PASS or FAIL; the polished ones end with
    # "RESULT: PASS" or a "FAILURES (n):" header. Both shapes are read so the
    # table reports a real verdict for every gate rather than "(no verdict
    # line)", which hides whether a gate said anything at all.
    tail = [l for l in p.stdout.splitlines()
            if l.startswith(("PASS", "FAIL", "REAL FAILURES", "RESULT:", "FAILURES ("))]
    results.append((name, p.returncode, dt, tail[-1][:52] if tail else "(no verdict line)", covers))

print("=" * 78)
print("EVERY GATE, %s" % BASE)
print("=" * 78)
print("\n%-22s %-6s %-7s %s" % ("gate", "exit", "secs", "verdict"))
for name, code, dt, verdict, _ in results:
    print("%-22s %-6s %-7.1f %s"
          % (name, "?" if code is None else code, dt, verdict))

print("\nwhat each one covers:")
for name, _, _, _, covers in results:
    print("  %-22s %s" % (name, covers))

bad = [r for r in results if r[1] != 0]

# The DESIGN.md table and this runner must list the same gates. Written as a
# check rather than a note, because "keep these in step" is a hope: a gate
# missing from the runner does not get run, and a gate listed in the doc that
# is not in the runner is a claim of coverage nothing backs. Both directions
# fail here.
design = os.path.join(HERE, "DESIGN.md")
if os.path.exists(design):
    text = open(design, encoding="utf-8").read()
    listed = set(re.findall(r"`(verify_[a-z_0-9]+\.py)`", text))
    # The mutation tests are deliberately outside verify_all.py.
    listed.discard("verify_flow_mutation.py")
    listed.discard("verify_round2_mutation.py")
    listed.discard("verify_all.py")
    # A gate the doc explicitly declares SUPERSEDED is not a coverage claim,
    # so it is allowed to be named without being run. Only that exact word
    # licenses the omission: mentioning a retired gate in passing still
    # fails, because a reader scanning this section for what is checked
    # cannot tell the difference between a gate that runs and one that used
    # to. The superseded file itself exits 2 rather than 0, so it cannot be
    # mistaken for a pass by anything that runs it directly either.
    superseded = set(re.findall(
        r"`(verify_[a-z_0-9]+\.py)` is \*\*superseded\*\*", text))
    listed -= superseded
    ours = {name for name, _, _ in GATES}
    only_doc = sorted(listed - ours)
    only_run = sorted(ours - listed)
    if only_doc or only_run:
        print("\nDESIGN.md section 10 and verify_all.py disagree:")
        for g in only_doc:
            print("  %s is documented but NOT run by verify_all.py" % g)
        for g in only_run:
            print("  %s is run but NOT documented in DESIGN.md" % g)
        bad.append(("DESIGN.md gate list", 1, 0.0, "out of step", ""))

print()
if bad:
    print("FAIL: %d of %d gates did not pass" % (len(bad), len(results)))
    for name, code, _, verdict, _ in bad:
        print("  %s exit=%s %s" % (name, code, verdict))
    sys.exit(1)
print("PASS: %d of %d gates green." % (len(results), len(results)))
print()
print("NOT COVERED HERE, and judged by a person:  whether the copy is")
print("comprehensible to a first-time buyer, whether the attestation reads as")
print("neutral rather than as a verdict, and whether the two seven day clocks")
print("are distinguishable. Run verify_flow_mutation.py and")
print("verify_round2_mutation.py separately: they edit files and take")
print("several minutes.")
