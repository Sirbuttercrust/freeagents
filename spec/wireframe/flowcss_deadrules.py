#!/usr/bin/env python3
"""Which selectors in flow.css no markup uses any more.

The reconcile moved the payment screens onto the polished visual system and left
flow.css loaded by six of them, so the question for whoever folds that file is
which of its rules still govern anything. "A rule keyed on a class no markup uses
is dead and looks alive", and dead CSS in a file a later card is told to fold is
a trap for that card: it reads as a component to preserve.

Not a gate, and not in verify_all.py. Dead CSS is not a defect in the product, it
is a fact the payment restyle card needs. Run it when flow.css changes.

    python3 flowcss_deadrules.py
"""
import glob
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))

css = open(os.path.join(HERE, "flow.css"), encoding="utf-8").read()
# Strip comments first: a selector named in a comment is prose, not a rule.
css_nc = re.sub(r"/\*.*?\*/", " ", css, flags=re.S)

sels = set()
for blk in re.finditer(r"([^{}]+)\{", css_nc):
    for m in re.finditer(r"\.([A-Za-z][\w-]*)", blk.group(1)):
        sels.add(m.group(1))

used = set()
loaders = []
for path in sorted(glob.glob(os.path.join(HERE, "*.html"))):
    text = open(path, encoding="utf-8").read()
    if "flow.css" in text:
        loaders.append(os.path.basename(path))
    for m in re.finditer(r'class\s*=\s*"([^"]*)"', text):
        used.update(m.group(1).split())

dead = sorted(sels - used)
live = sorted(sels & used)

print("screens loading flow.css ({0}): {1}".format(len(loaders), ", ".join(loaders)))
print("class selectors in flow.css: {0}".format(len(sels)))
print("still used by markup ({0}): {1}".format(len(live), ", ".join(live)))
print()
print("DEAD, no markup anywhere ({0}):".format(len(dead)))
for i in range(0, len(dead), 8):
    print("  " + ", ".join(dead[i:i + 8]))
