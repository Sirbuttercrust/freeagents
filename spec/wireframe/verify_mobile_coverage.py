#!/usr/bin/env python3
"""Is every screen on disk actually swept at 320px by something?

WHY THIS EXISTS.

The card for this work asks for "mobile 320px with every open state, 44px
targets, no horizontal overflow, on all 33 screens". Two instruments do that
sweep: verify_flow.py walks the payment screens and opens every dialog,
verify_polish.py walks the rest on a real touch profile. Between them they
should cover the directory.

"Should" is the problem. Both carry hardcoded page lists, and a screen added
later is not covered by either, silently. Nothing fails, and the suite still
prints green, because a list that does not mention a file cannot fail on it.
That is the same class of defect as a gate documented but never run, which
verify_all.py already checks for in the other direction.

So this gate checks the coverage rather than the pages: every .html in this
directory must appear in at least one 320px sweep. It reads the page lists out
of the instruments themselves rather than restating them, because a third copy
of the list would be a third thing to forget.

No browser and no server needed.

    python3 verify_mobile_coverage.py
"""

import glob
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

# The instruments that actually resize to 320px, set a touch profile, and
# assert on scrollWidth and tap-target size. A file that merely mentions a
# page name does not count, which is why these two are named explicitly.
SWEEPERS = ["verify_flow.py", "verify_polish.py"]


def pages_named_in(path):
    """Every foo.html quoted in a source file."""
    with open(path) as fh:
        return set(re.findall(r'["\']([a-z0-9_-]+\.html)["\']', fh.read()))


def main():
    on_disk = {os.path.basename(p) for p in glob.glob(os.path.join(HERE, "*.html"))}

    covered = set()
    per_sweeper = {}
    for name in SWEEPERS:
        path = os.path.join(HERE, name)
        if not os.path.exists(path):
            print("FAIL %s is missing from disk, so its sweep does not happen" % name)
            return 1
        found = pages_named_in(path) & on_disk
        per_sweeper[name] = found
        covered |= found

    print("%-26s %s" % ("instrument", "screens swept at 320px"))
    print("-" * 52)
    for name in SWEEPERS:
        print("%-26s %d" % (name, len(per_sweeper[name])))
    print("%-26s %d" % ("union", len(covered)))
    print("%-26s %d" % ("html files on disk", len(on_disk)))

    missing = sorted(on_disk - covered)
    if missing:
        print("\nFAIL: %d screen(s) are in the directory and in no 320px sweep:" % len(missing))
        for m in missing:
            print("  " + m)
        print("\nAdd each to verify_flow.py or verify_polish.py. A screen no")
        print("instrument opens at 320px is a screen nobody checked on a phone.")
        return 1

    stale = sorted((per_sweeper[SWEEPERS[0]] | per_sweeper[SWEEPERS[1]]) - on_disk)
    if stale:
        print("\nFAIL: an instrument names a page that is not on disk: %s" % stale)
        return 1

    print("\nPASS  all %d screens are swept at 320px by at least one instrument." % len(on_disk))
    return 0


if __name__ == "__main__":
    sys.exit(main())
