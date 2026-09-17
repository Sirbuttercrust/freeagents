#!/usr/bin/env python3
"""No-em-dash check that CAN fail, with its own positive control.

The card documents `grep -c $'\\u2014' <files>`. That command is VACUOUS on
this machine: bash 3.2 does not expand \\u inside $'...', so it greps for six
literal characters and prints 0 whether or not a violation exists. Proven by
planting a real U+2014 in a file and getting 0 back.

This runs the check the way the rule means it, over the WHOLE directory
rather than a named list (a rule enforced on a list of files is not
enforced), and proves itself on a planted string before reporting.
"""
import os
import sys

DASHES = {"\u2014": "em dash", "\u2013": "en dash"}
ROOTS = ["src/web/pages", "src/web/public/js/pages", "src/web/public/css"]
ALLOW = {
    # api.js builds the shortened DID with a real ellipsis, which is UI, not
    # prose, and is not a dash.
}

# Positive control: the checker must see a dash it is handed.
probe = "a sentence \u2014 with one"
assert any(d in probe for d in DASHES), "checker cannot see an em dash"
print("positive control: checker detects a planted em dash  OK")

root = os.path.dirname(os.path.abspath(__file__))
os.chdir(os.path.join(root, "..", ".."))

hits, scanned = [], 0
for r in ROOTS:
    for dirpath, _dirs, files in os.walk(r):
        for f in sorted(files):
            if not f.endswith((".html", ".js", ".css")):
                continue
            p = os.path.join(dirpath, f)
            if p in ALLOW:
                continue
            scanned += 1
            with open(p, encoding="utf-8") as fh:
                for n, line in enumerate(fh, 1):
                    for d, name in DASHES.items():
                        if d in line:
                            hits.append((p, n, name, line.strip()[:90]))

print(f"files scanned: {scanned}")
print(f"violations:    {len(hits)}")
for p, n, name, line in hits:
    print(f"  {p}:{n}  {name}  {line}")

sys.exit(1 if hits else 0)
