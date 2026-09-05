#!/usr/bin/env python3
"""Contrast across every flow screen, with the sampler's known artifact
separated from real findings.

The artifact: contrast_check.py samples the pixel behind a text run. On a
filled control it reads the PAGE behind the button rather than the button's own
fill, so accent-filled primary buttons report about 1.01 when the real ink-on-
fill ratio is 5.79. Detected here by recognising --accent-fg, which is used as
ink on an accent fill and nowhere else.
"""
import os
import subprocess
import sys

SCREENS = ["hire.html", "agreement.html", "deposit.html", "staged.html",
           "pullrequest.html", "outcomes.html", "operatorjob.html", "conduct.html"]
BASE = "http://127.0.0.1:3111"
BIN = os.environ.get("WEBGRAB_DIR", ".")

# --accent-fg #0A0A16. Ink on an accent fill, used nowhere else in the system.
ARTIFACT_FG = "(10, 10, 22)"

real, artifacts = [], []
for s in SCREENS:
    r = subprocess.run([sys.executable, os.path.join(BIN, "contrast_check.py"),
                        f"{BASE}/{s}", "2"],
                       capture_output=True, text=True)
    for line in r.stdout.splitlines():
        # "FAILURES: 3" is the tool's own summary line, not a finding. Matching
        # on startswith("FAIL") swallowed it and inflated every count by one
        # per screen, which made a clean run look like eight failures.
        if not line.startswith("FAIL "):
            continue
        if ARTIFACT_FG in line:
            artifacts.append((s, line.strip()))
        else:
            real.append((s, line.strip()))
    head = [l for l in r.stdout.splitlines() if l.startswith("sampled")]
    print(f"{s:<20} {head[0] if head else '?'}")

print(f"\n{'=' * 70}")
print(f"ARTIFACTS (button ink sampled against the page, not its own fill): {len(artifacts)}")
for s, line in artifacts:
    print(f"  {s}: {line[:96]}")

print(f"\nREAL FAILURES: {len(real)}")
for s, line in real:
    print(f"  {s}: {line[:96]}")

sys.exit(1 if real else 0)
