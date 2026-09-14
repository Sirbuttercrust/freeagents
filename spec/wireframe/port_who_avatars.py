#!/usr/bin/env python3
"""Put the identity line's avatar on the generated system, on every screen.

WHY: ten screens rendered a flat 32px disc (a data-URI SVG, one #7C7CFF fill,
no identity in it) inside .who, while six rendered the DID-derived creature.
A payment screen beside a profile page read as a different product.

WHAT: each <img src="data:image/svg+xml,...disc..."> inside a .who block
becomes <span class="av" data-avatar="did:abt:NAME">, where NAME is read from
the .who .n right beside it rather than assumed, so a screen naming a second
party gets that party's face and not the first one's.

The DID is derived, never invented: the same did:abt: prefix and the same bare
agent or operator name the rest of the set already uses for that identity.

Run from spec/wireframe. Idempotent: a screen already on the new markup is
skipped rather than double-patched.
"""
import glob
import os
import re
import sys

DISC = re.compile(
    r'<img src="data:image/svg\+xml,[^"]*?" alt="">'
)

# The .who block: the img, then within a few lines the name that identifies it.
WHO_NAME = re.compile(r'<div class="n">([^<]+?)(?:\s*<span|</div>)')


def did_for(name):
    """did:abt:<bare name>, matching what the rest of the tree already uses."""
    bare = name.strip().split()[0]
    bare = bare.replace(".dev", "")          # northline.dev -> northline
    return "did:abt:" + bare


def main():
    changed = []
    for path in sorted(glob.glob("*.html")):
        src = open(path).read()
        if not DISC.search(src):
            continue

        out = []
        pos = 0
        n_here = 0
        for m in DISC.finditer(src):
            # Look ahead for the name this avatar belongs to. Bounded window so
            # an unrelated .n further down the page cannot be picked up.
            window = src[m.end():m.end() + 400]
            nm = WHO_NAME.search(window)
            if not nm:
                print("SKIP %s: a disc at offset %d has no .who .n within 400 "
                      "chars, so its identity cannot be read" % (path, m.start()))
                continue
            did = did_for(nm.group(1))
            out.append(src[pos:m.start()])
            out.append('<span class="av" data-avatar="%s"></span>' % did)
            pos = m.end()
            n_here += 1
        out.append(src[pos:])

        if n_here:
            open(path, "w").write("".join(out))
            changed.append((path, n_here))

    for path, n in changed:
        print("%-22s %d avatar(s) on the generated system" % (path, n))
    print("\n%d screens changed, %d avatars" % (len(changed), sum(n for _, n in changed)))

    left = [p for p in sorted(glob.glob("*.html")) if DISC.search(open(p).read())]
    if left:
        print("STILL FLAT: %s" % left)
        return 1
    print("no flat identity discs remain in the set")
    return 0


if __name__ == "__main__":
    sys.exit(main())
