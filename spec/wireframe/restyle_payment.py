#!/usr/bin/env python3
"""Restyle the payment screens onto the polished visual system.

WHAT THIS DOES, AND WHY IT IS A SCRIPT.

The eight payment screens were drawn in September on the earlier visual
system. The polished system is not a repaint of them: it is a set of shared
components (polish.css), an icon set (icons.js), and the behaviours that make
the wireframe demonstrate itself (polish.js). Putting the payment screens on
that system means four mechanical edits repeated across six files, and one
hand edit per screen that no script should attempt.

The mechanical four are here so they are applied identically everywhere and a
reviewer can read exactly what was done to every file rather than trusting six
similar diffs:

  1. load polish.css after base.css, so the shared components exist
  2. load icons.js and polish.js, so an icon renders and a control responds
  3. keep flow.css, which is the payment flow's own layer and collides with
     nothing in polish.css (checked: zero selector overlap)
  4. drop flow.js where polish.js supersedes it

The per-screen design work (icons chosen for meaning, the .pane treatment on
grouped sections, the reveal cadence) is done by hand in the files, because a
script cannot decide which icon carries information the adjacent word does
not, and base.css rule 4 bars an icon that repeats its label.

Run from spec/wireframe. Idempotent: running it twice changes nothing.
"""

import os
import re
import sys

SCREENS = [
    "deposit.html",
    "staged.html",
    "pullrequest.html",
    "outcomes.html",
    "operatorjob.html",
    "conduct.html",
]

HERE = os.path.dirname(os.path.abspath(__file__))


def restyle(path):
    src = open(path).read()
    before = src

    # 1. polish.css sits between base.css and flow.css. Order matters: base
    #    states the system, polish adds the shared components, flow adds the
    #    payment-flow layer on top of both.
    if 'href="polish.css"' not in src:
        src = src.replace(
            '<link rel="stylesheet" href="base.css">\n<link rel="stylesheet" href="flow.css">',
            '<link rel="stylesheet" href="base.css">\n'
            '<link rel="stylesheet" href="polish.css">\n'
            '<link rel="stylesheet" href="flow.css">',
        )

    # 2 and 4. polish.js supersedes flow.js: it carries the disclosure,
    #    counter, picker and toast behaviours flow.js had, plus the demo
    #    affordances the rest of the wireframe already uses. icons.js has to
    #    load before polish.js so a data-ico span is filled on first paint.
    if 'src="icons.js"' not in src:
        src = src.replace(
            '<script src="wireframe.js"></script>\n<script src="flow.js"></script>',
            '<script src="wireframe.js"></script>\n'
            '<script src="icons.js"></script>\n'
            '<script src="polish.js"></script>',
        )

    if src != before:
        open(path, "w").write(src)
        return True
    return False


def main():
    changed = []
    for name in SCREENS:
        path = os.path.join(HERE, name)
        if not os.path.exists(path):
            print("MISSING %s" % name)
            return 1
        if restyle(path):
            changed.append(name)

    for name in SCREENS:
        src = open(os.path.join(HERE, name)).read()
        for needed in ('href="base.css"', 'href="polish.css"',
                       'href="flow.css"', 'src="icons.js"', 'src="polish.js"'):
            if needed not in src:
                print("FAIL %s is missing %s" % (name, needed))
                return 1
        if 'src="flow.js"' in src:
            print("FAIL %s still loads flow.js" % name)
            return 1

    print("restyled: %s" % (", ".join(changed) if changed else "nothing, already applied"))
    print("all %d screens load base + polish + flow, icons and polish.js, no flow.js" % len(SCREENS))
    return 0


if __name__ == "__main__":
    sys.exit(main())
