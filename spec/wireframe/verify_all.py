#!/usr/bin/env python3
"""Run every gate in this directory and report one table.

Exists so a reviewer runs ONE command instead of nine, and so the list of what
is covered cannot drift from the list of what actually runs. A gate that is
not in this file does not get run, and a gate in this file that has rotted
fails here.

    WEBGRAB_DIR=<dir with webgrab.py> python3 verify_all.py [base-url]

Exit 0 only if every gate exits 0. The mutation test is NOT run here: it takes
several minutes and deliberately edits files, so it is run on its own.
"""

import os
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
    ("verify_contrast.py", False,
     "real rendered pixels behind text on all eight screens"),
    ("verify_money.py", True,
     "every dollar figure derives from one model of the deal"),
    ("verify_rail.py", True,
     "the total, fee and pay button follow the chosen rail"),
    ("verify_pickers.py", True,
     "picker rows trace to real agreement lines, omissions explained"),
    ("verify_primary.py", True,
     "no surface shows two accent-filled primaries at once"),
]

env = dict(os.environ)
if not env.get("WEBGRAB_DIR"):
    print("Set WEBGRAB_DIR to the directory holding webgrab.py")
    sys.exit(2)

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
    tail = [l for l in p.stdout.splitlines() if l.startswith(("PASS", "FAIL", "REAL FAILURES"))]
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
print("are distinguishable. Run verify_flow_mutation.py separately: it edits")
print("files and takes several minutes.")
