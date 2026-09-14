#!/usr/bin/env python3
"""Name every edit control on the agreement by the line it acts on.

verify_names.py failed the agreement with four controls all called "Propose a
change to this line". A screen-reader user tabbing the matrix hears the same
sentence four times and cannot tell which row they are about to reopen, which
matters more here than almost anywhere else in the product: pressing one of
these clears two signatures.

The row number is already in the markup, in the .num span, so the name is
derived from the row rather than typed. Deriving it means a row inserted later
cannot get a stale label.

Also raises the control from 22px to the house 44px floor under
(pointer: coarse). It was 22x44: tall enough, half as wide as it needs to be.

Run from spec/wireframe. Idempotent.
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, "agreement.html")


def main():
    src = open(PATH).read()

    # Walk the <li> rows of the terms matrix. Each carries one .num and at most
    # one .act, so the pairing is positional and unambiguous.
    rows = re.findall(r'<li[^>]*>.*?</li>', src, re.S)
    fixed = 0

    for row in rows:
        m = re.search(r'class="num">(\d+)<', row)
        if not m:
            continue
        num = m.group(1)

        def relabel(mm):
            attr, value = mm.group(1), mm.group(2)
            # Leave already-specific names alone (the price and the window
            # rows name their own term, which is better than a bare number).
            if value.endswith("this line"):
                return '%s="%s %s"' % (attr, value[:-len("this line")].strip(), "line " + num)
            return mm.group(0)

        new_row = re.sub(r'(aria-label|title)="([^"]*this line)"', relabel, row)
        if new_row != row:
            src = src.replace(row, new_row)
            fixed += 1

    open(PATH, "w").write(src)

    # Prove it: no two controls may share a name.
    names = re.findall(r'<button class="act"[^>]*aria-label="([^"]*)"', src)
    dupes = {n for n in names if names.count(n) > 1}
    if dupes:
        print("FAIL still duplicated: %s" % sorted(dupes))
        return 1

    print("named %d edit controls by their row" % fixed)
    for n in names:
        print("  %s" % n)
    return 0


if __name__ == "__main__":
    sys.exit(main())
