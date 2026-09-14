#!/usr/bin/env python3
"""Every local link in the wireframe resolves to a file that exists.

A dead internal link in a wireframe is worse than in a product: a reviewer
walking a flow hits a 404 and cannot tell whether the screen was never built or
the link is wrong. Run from spec/wireframe.

Also reports orphans: files nothing links to. An orphan is not automatically a
defect (a screen can be reachable only from the index), but a NEW screen that
nothing links to is almost always a missed wiring step.
"""
import glob
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__)) or "."
os.chdir(HERE)

pages = sorted(glob.glob("*.html"))
assets = set(glob.glob("*.css")) | set(glob.glob("*.js"))
existing = set(pages) | assets

HREF = re.compile(r'(?:href|src)="([^"#?]+)(?:[#?][^"]*)?"')

broken = []
linked_to = set()
outgoing = {}

for p in pages:
    text = open(p, encoding="utf-8").read()
    targets = set()
    for m in HREF.finditer(text):
        t = m.group(1)
        if t.startswith(("http://", "https://", "data:", "mailto:", "//")):
            continue
        if t in ("", "#"):
            continue
        targets.add(t)
        linked_to.add(t)
        if t not in existing:
            broken.append((p, t))
    outgoing[p] = targets

print("=" * 62)
print(f"LINK CHECK: {len(pages)} pages, {len(assets)} assets")
print("=" * 62)

if broken:
    print(f"\nBROKEN, {len(broken)}:")
    for src, target in broken:
        print(f"  {src} -> {target}")
else:
    print("\nno broken local links")

# SUPERSEDED pages are excluded from the "who links here" count, which is the
# case a naive orphan check misses. criteria.html looked reachable because
# confirm.html linked to it, and confirm.html is itself dead. A dead page
# linking to a dead page is not reachability, it is two orphans holding hands.
SUPERSEDED = {p for p in pages
              if "This screen was replaced" in open(p, encoding="utf-8").read()}

live_links = set()
for p, targets in outgoing.items():
    if p in SUPERSEDED:
        continue
    live_links |= targets

orphans = [p for p in pages
           if p not in live_links and p != "index.html" and p not in SUPERSEDED]

if SUPERSEDED:
    print(f"\nSUPERSEDED, {len(SUPERSEDED)} (kept as a record, carry a banner, "
          f"excluded from reachability):")
    for s in sorted(SUPERSEDED):
        print(f"  {s}")

if orphans:
    print(f"\nORPHANS, {len(orphans)} (no LIVE page links to these):")
    for o in orphans:
        print(f"  {o}")
else:
    print("\nevery live page is reachable from another live page")

print(f"\nlinks checked: {sum(len(v) for v in outgoing.values())}")

# A VERDICT LINE THE RUNNER CAN READ. This gate exited correctly all along
# but printed no PASS or FAIL, so verify_all's table showed "(no verdict
# line)" beside it: a green exit with no stated result, which is the shape a
# gate has on the day it stops asserting anything. verify_all now refuses a
# gate that says nothing.
if broken or orphans:
    print(f"\nFAIL: {len(broken)} broken link(s), {len(orphans)} orphan(s)")
else:
    print(f"\nPASS  every local link resolves and every live page is reachable")
sys.exit(1 if broken or orphans else 0)
