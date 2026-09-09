#!/usr/bin/env python3
"""verify_housestyle.py - the house text rules, across the WHOLE directory.

WHY THIS EXISTS. The em-dash rule was enforced by verify_flow.py, which reads
the eight payment screens plus flow.css and flow.js. Ten files out of the
forty-three in this directory. A real U+2014 planted in notfound.html left
"PASS: 18 of 18 gates green" and exit 0, and three separate handoffs reported
"zero em dashes" on the strength of it.

Worse, the command the docs named as the enforcement could not fail on the
machine it was written on:

    grep -o $'\\u2014' *.html *.css *.js *.md | wc -l

bash 3.2 does not expand \\u inside $'...', so that greps for the six literal
characters backslash-u-2-0-1-4 and returns the lines quoting the command
itself, whether or not a real em dash exists anywhere. A check that prints the
same number in both states is not a check.

So: one gate, every file, no shell quoting in the way. No browser needed.

    python3 verify_housestyle.py

WHAT IT COVERS

  1. U+2014 EM DASH, zero anywhere. The house rule, and the one that has
     actually been violated.
  2. U+2013 EN DASH, zero anywhere, because it is the same tell wearing a
     shorter line and a find-and-replace of one usually leaves the other.
  3. The AI writing tells that survive a dash sweep: "not just X, it's Y",
     "it's not about X, it's about Y", and the marketing vocabulary list.
     Reported on PROSE files only (html, md), never on python or css, where
     "leverage" is a legitimate word about levers and a comment is written
     for an engineer.

WHAT IT DOES NOT COVER, and is judged by a person: rhythm. A sentence
rewritten to dodge a lint word while keeping the cadence of ad copy passes
this and still reads like a bot. Read it out loud.
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

EM = "\u2014"
EN = "\u2013"

# Everything in the directory, not a list that a new file can be absent from.
# THE FAILURE MODE THIS AVOIDS: verify_flow.py named its ten files explicitly,
# so every screen added after it was written was silently outside the rule.
SKIP_EXT = (".png", ".jpg", ".jpeg", ".gif", ".woff", ".woff2", ".ico", ".pdf")

# Files allowed to contain the characters, and only because they are ABOUT
# them. Each entry names the file and why. A file cannot be added here without
# a reason, and the reason is read by the next person.
ALLOWED = {
    "verify_housestyle.py": "this file defines the rule and has to name the characters",
    "DESIGN.md": "section 9 quotes the rule and shows the command that enforces it",
}

# Prose files only. A .py comment is written for an engineer and a .css value
# is not prose at all.
PROSE_EXT = (".html", ".md")

# The tells, as (regex, what to do instead). Ordered by how often they show up
# in real drafts here.
TELLS = [
    (r"\bnot just\b[^.]{0,60}\b(it'?s|but)\b",
     "negative parallelism, say the thing once"),
    (r"\bit'?s not about\b[^.]{0,60}\bit'?s about\b",
     "negative parallelism, say the thing once"),
    (r"\b(seamless(ly)?|robust|leverage|empower(ing|s)?|unlock(ing|s)?|"
     r"cutting-edge|game-?chang(er|ing)|world-class|showcase|foster(ing|s)?|"
     r"delve|underscore(s|d)?|pivotal|vibrant|tapestry)\b",
     "marketing vocabulary"),
    (r"\b(let'?s dive in|here'?s what you need to know|the real question is)\b",
     "signposting, just say the thing"),
]


def files():
    for name in sorted(os.listdir(HERE)):
        p = os.path.join(HERE, name)
        if not os.path.isfile(p):
            continue
        if name.lower().endswith(SKIP_EXT):
            continue
        yield name, p


def main():
    fails = []
    rows = []
    scanned = 0

    for name, path in files():
        try:
            text = open(path, encoding="utf-8").read()
        except UnicodeDecodeError:
            continue
        scanned += 1
        em = text.count(EM)
        en = text.count(EN)
        tells = []

        if name.lower().endswith(PROSE_EXT):
            for pattern, why in TELLS:
                for m in re.finditer(pattern, text, re.I):
                    line = text[:m.start()].count("\n") + 1
                    tells.append("%s:%d %r (%s)"
                                 % (name, line, m.group(0)[:40], why))

        if name in ALLOWED:
            # Counted and shown, never failed, with the reason on the row.
            rows.append((name, em, en, len(tells), "allowed: " + ALLOWED[name]))
            continue

        rows.append((name, em, en, len(tells), ""))
        if em:
            fails.append("%s: %d em dash(es) U+2014" % (name, em))
        if en:
            fails.append("%s: %d en dash(es) U+2013" % (name, en))
        fails.extend(tells)

    print("=" * 74)
    print("HOUSE STYLE, every file in %s" % os.path.basename(HERE))
    print("=" * 74)
    print("\n%-30s %6s %6s %6s  %s" % ("file", "emdash", "endash", "tells", "note"))
    for name, em, en, t, note in rows:
        if em or en or t or note:
            print("%-30s %6d %6d %6d  %s" % (name, em, en, t, note))
    print("\nfiles scanned: %d" % scanned)
    print("clean files are omitted from the table above")

    if fails:
        print("\nFAILURES (%d):" % len(fails))
        for f in fails:
            print("  " + f)
        print("\nRESULT: FAIL")
        return 1

    print("\nno findings")
    print("\nRESULT: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
