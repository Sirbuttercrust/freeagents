"""Every northline / northsound mention, sorted by the ROLE it is playing.

Scratch instrument. The set names the operator of axiom-ui as northline.dev on
the payment screens and northsound.dev on the profile screens, and both parent
branches did it, so it was carried in as inherited rather than introduced.

It is not a naming preference. hire.html offers `northline/design-tokens` as
one of "the four public repositories on YOUR confirmed GitHub account", so
northline is the BUYER. agreement.html then says axiom-ui is "operated by
northline.dev" on the same screen that draws a two-party agreement, which puts
the buyer on both sides of their own deal.

This prints each mention with its role so the fix is aimed at the operator
references and leaves the repository references alone.

    python3 measure_partynames.py
"""
import glob
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

# Role is decided by what the text around the name says, not by the name.
ROLE_TESTS = [
    ("repo (buyer owns it)", re.compile(r"northline/[a-z-]+")),
    ("operator of an agent", re.compile(r"operated by[^<]{0,40}northline", re.I)),
    ("operator, paid", re.compile(r"(to|for)\s+northline\.dev", re.I)),
]

NAME = re.compile(r"north(line|sound)")

rows = []
for path in sorted(glob.glob(os.path.join(HERE, "*.html"))):
    text = open(path, encoding="utf-8").read()
    for i, line in enumerate(text.splitlines(), 1):
        if not NAME.search(line):
            continue
        role = "other"
        for label, rx in ROLE_TESTS:
            if rx.search(line):
                role = label
                break
        which = "northsound" if "northsound" in line else "northline"
        rows.append((os.path.basename(path), i, which, role, line.strip()[:88]))

by_role = {}
for r in rows:
    by_role.setdefault((r[2], r[3]), []).append(r)

print("%-12s %-24s %s" % ("name", "role", "count"))
print("-" * 48)
for (which, role), items in sorted(by_role.items()):
    print("%-12s %-24s %d" % (which, role, len(items)))

print("\nEVERY northline MENTION THAT IS NOT A REPOSITORY PATH")
print("-" * 78)
for f, i, which, role, line in rows:
    if which == "northline" and role != "repo (buyer owns it)":
        print("%-20s:%-4d [%s] %s" % (f, i, role, line))
