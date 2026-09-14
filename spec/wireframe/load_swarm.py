#!/usr/bin/env python3
"""Load the avatar generator on the screens that now render a generated avatar.

WHY: port_who_avatars.py replaced ten flat discs with [data-avatar] spans, and
polish.js paints those by calling FASwarm.avatar. None of those ten pages
loaded swarm.js, so the hook found no generator and left the span EMPTY: a
32x32 box with zero <svg> children, which is a blank circle on the page and
throws nothing. A screenshot of a blank avatar and a working one differ by one
face, and nothing in the console says which you have.

Measured before this ran, on all five sampled payment screens:
    {"found":true,"w":32,"h":32,"svg":0,"swarm":"undefined"}

Insert order matches agent.html, the screen that already does this correctly:
wireframe.js, swarm.js, then icons.js and polish.js. polish.js must come after
swarm.js because it reads FASwarm at call time.

Idempotent: a page that already loads swarm.js is skipped.
"""
import glob
import re
import sys

NEEDS = '<script src="wireframe.js"></script>'
ADD = '<script src="wireframe.js"></script>\n<script src="swarm.js"></script>'


def main():
    changed = []
    for path in sorted(glob.glob("*.html")):
        src = open(path).read()
        if 'data-avatar' not in src:
            continue
        if 'swarm.js' in src:
            continue
        if NEEDS not in src:
            print("SKIP %s: no wireframe.js tag to anchor the insert" % path)
            continue
        open(path, "w").write(src.replace(NEEDS, ADD, 1))
        changed.append(path)

    for p in changed:
        print("%-22s now loads swarm.js" % p)
    print("\n%d screens changed" % len(changed))

    # Every page that renders an avatar must be able to generate one.
    bad = []
    for path in sorted(glob.glob("*.html")):
        src = open(path).read()
        if 'data-avatar' in src and 'swarm.js' not in src:
            bad.append(path)
    if bad:
        print("FAIL: these render [data-avatar] with no generator: %s" % bad)
        return 1
    print("every screen with a [data-avatar] loads the generator")
    return 0


if __name__ == "__main__":
    sys.exit(main())
