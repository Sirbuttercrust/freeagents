#!/usr/bin/env python3
"""Check the rename table in RECONCILE-NOTES.md against the tree.

A rename claim is checkable: the old name is absent from the result, the new one
is present, and they appear on the SAME screens. A table of renames written from
reading a diff is a guess about each pair, and this tree has already paid for a
document whose prose reasoned from a value the tree had moved past.

Not part of verify_all.py: it checks a claim in a notes file, not a property of
the product. Run it when the table changes.

    python3 check_renames.py
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import reconcile_inventory as ri

POLISHED = "design/burnish-polished-2026-08-29"
MAIN = "971b97a"

# (old, new, parent the old name came from). Read off the notes table.
#
# THE PAIRS ARE MEASURED, NOT INFERRED. The first version of this table was
# written by reading the diff and guessing, and six of fifteen claims were
# wrong: the polished set does not use flat names like `.av` or `.n` on the
# marketplace and profile screens, it uses NAMESPACED components (`acard-*` for
# a browse card, `p*` for a profile header). Writing `.avatar -> .av` looked
# right and named a class that is not on that screen at all.
PAIRS = [
    (".edit", ".act", MAIN),
    # browse.html: the card became the `acard` component in market.css
    (".avatar", ".acard-av", MAIN),
    (".agent", ".acard-name", MAIN),
    (".name", ".acard-name", MAIN),
    (".desc", ".acard-desc", MAIN),
    (".proof", ".acard-proof", MAIN),
    # agent.html / operator.html: the social-style profile header
    (".pavatar", ".pav", MAIN),
    (".oav", ".pav", MAIN),
    (".ident", ".pname", MAIN),
    (".ohead", ".phead", MAIN),
    # agreement.html: the signature matrix
    (".thead", ".terms-head", MAIN),
    (".trow", ".term-line", MAIN),
    (".m-you", ".h-you", MAIN),
    (".m-them", ".h-them", MAIN),
    (".mark-on", ".sig", MAIN),
    (".mark-off", ".sig", MAIN),
]

res = {}
for p in ri.screens("HEAD"):
    name = p.split("/")[-1]
    with open(os.path.join(HERE, name), encoding="utf-8") as fh:
        res[name] = ri.vocabulary(fh.read())

fails = []
print("{0:12s} {1:13s} {2:30s} {3}".format("old", "new", "old was on", "new there now"))
print("-" * 78)
for old, new, parent in PAIRS:
    par = {}
    for p in ri.screens(parent):
        par[p.split("/")[-1]] = ri.vocabulary(ri.read(parent, p))
    had = sorted(s for s, v in par.items() if old in v)
    # The claim: on every screen that carried the old name, the new one is there.
    missing = [s for s in had if new not in res.get(s, set())]
    still = [s for s in res if old in res[s]]
    ok = bool(had) and not missing and not still
    print("{0:12s} {1:13s} {2:30s} {3}".format(
        old, new,
        ",".join(s.replace(".html", "") for s in had)[:29] or "NOWHERE",
        "yes" if ok else "NO"))
    if not had:
        fails.append("{0}: never appeared on {1}, so the rename claim is "
                     "unfounded".format(old, parent))
    if missing:
        fails.append("{0} -> {1}: new name absent from {2}".format(
            old, new, ", ".join(missing)))
    if still:
        fails.append("{0}: still present on {1}, so it was not renamed".format(
            old, ", ".join(still)))

print()
if fails:
    print("CLAIMS THAT DO NOT HOLD ({0}):".format(len(fails)))
    for f in fails:
        print("  - {0}".format(f))
    sys.exit(1)
print("every rename in the table holds: old name gone, new name on each screen "
      "that carried it")
