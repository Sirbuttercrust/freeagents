#!/usr/bin/env python3
"""Positive controls for round 6's verify_designmd.py.

A gate written after a fix has never once seen the defect it claims to catch.
Green on a fixed tree proves the assertions run, not that they discriminate.
So each control below re-creates a round-6 defect in the exact shape it
shipped in, asserts verify_designmd FAILS naming the right thing, reverts, and
asserts PASS.

The mutations are aimed at DESIGN.md and at base.css alike, because the defect
is a DISAGREEMENT and either side can be the one that moves. A gate that only
notices a doc edit would go green the next time a token is lifted in the
stylesheet and not written down, which is precisely how this arrived.

Control F is the important one. It plants a value in a table cell and asserts
the ratio check catches it, because the first version of this gate read only
the prose sentence: moving the numbers into a table silently dropped its
coverage to zero while it went on printing PASS.

Run from the wireframe directory. Reverts on any exit, including SIGTERM.

    python3 verify_round6_mutation.py
"""
import hashlib
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import mutationsafe                                             # noqa: E402

DOC = os.path.join(HERE, "DESIGN.md")
BASE = os.path.join(HERE, "base.css")
MARKET = os.path.join(HERE, "market.css")
FILES = [DOC, BASE, MARKET]


def read(p):
    with open(p, encoding="utf-8") as fh:
        return fh.read()


def write(p, s):
    with open(p, "w", encoding="utf-8") as fh:
        fh.write(s)


def digest(paths):
    h = hashlib.sha256()
    for p in sorted(paths):
        h.update(read(p).encode("utf-8"))
    return h.hexdigest()[:12]


def run_gate():
    p = subprocess.run([sys.executable, os.path.join(HERE, "verify_designmd.py")],
                       capture_output=True, text=True, cwd=HERE)
    return p.returncode, p.stdout + p.stderr


def sub(path, old, new):
    """Replace and PROVE the replacement landed.

    A mutation whose substring no longer matches silently mutates nothing, and
    the gate then passes for the only reason that does not count. This tree
    has paid for a mutation caught for the wrong cause once already, so a
    no-op raises here rather than reporting MISSED.
    """
    s = read(path)
    if old not in s:
        raise SystemExit("mutation target not found in %s:\n  %r"
                         % (os.path.basename(path), old[:90]))
    write(path, s.replace(old, new, 1))


# ---- A. the exact defect round 5 planted and five gates read past ---------
def mut_doc_absurd():
    sub(DOC, "| `--fg-3` | `#7C828C` |", "| `--fg-3` | `#FF00FF` |")


# ---- B. the defect as it really arrived: the STYLESHEET moves -------------
def mut_css_reverts_lift():
    """The August lift undone in base.css, with DESIGN.md left correct.

    This is the direction that actually happened, in reverse. A gate that
    only reads the document would go green here.
    """
    sub(BASE, "  --fg-3:      #7C828C;", "  --fg-3:      #666B73;")


# ---- C. a new token shipped and never documented --------------------------
def mut_undocumented_token():
    sub(MARKET, "  --cat-frontend:  #6EA8FF;",
        "  --cat-frontend:  #6EA8FF;\n  --cat-mobile:    #FF8A4C;")


# ---- D. a documented token no stylesheet defines ---------------------------
def mut_ghost_token():
    sub(DOC, "| `--line` | `rgba(255,255,255,0.08)` |",
        "| `--ghost` | `#123456` | a token nothing defines |\n"
        "| `--line` | `rgba(255,255,255,0.08)` |")


# ---- E. a duration named in prose that nothing ships -----------------------
def mut_phantom_duration():
    sub(DOC, "entering or leaving. Anything slower",
        "entering or leaving, **800ms** for a shape morph. Anything slower")


# ---- F. a stale ratio in a TABLE CELL, not in prose ------------------------
def mut_table_ratio():
    """The shape the first version of this gate could not see.

    Round 6's fix moved the ratios out of a sentence and into a table, and the
    gate's prose-only reader immediately reported "ratio claims checked: 0"
    and passed. If this control ever stops failing, the table reader has gone
    vacuous and the numbers in 2.5 are unchecked again.
    """
    sub(DOC, "| `--fg-3` | 5.15 | 4.96 | 4.72 |",
        "| `--fg-3` | 3.72 | 4.96 | 4.72 |")


# ---- G. a stale ratio in the TINT table's last column ----------------------
def mut_tint_ratio():
    sub(DOC, "| `--cat-testing` | `#E4757F` | testing | 6.78 |",
        "| `--cat-testing` | `#E4757F` | testing | 4.10 |")


# ---- H. a script named as available that is not on disk -------------------
def mut_phantom_script():
    """Section 4.1's defect, restored.

    It said "`measure_density.py` in this directory measures a live page"
    while section 10 of the same file said the density scripts do not exist
    on this branch. The reader who starts at 4.1 never reaches 10.
    """
    sub(DOC, "**No instrument on this branch measures the budget.** "
             "`measure_density.py` and\n`calibrate_density.py` were written "
             "on an unmerged branch, so section 10 lists\nthem as absent",
        "`measure_density.py` in this directory measures a live page against "
        "these\nnumbers. Section 10 lists them")


# ---- I. a stale HISTORICAL ratio, stated against a literal hex -------------
def mut_historical_ratio():
    """The last unchecked number in the file, and it sat in 2.5.

    A ratio about a value the tree stopped using cannot be recomputed from
    the shipped tokens, so the token-based checks are structurally blind to
    it. A hex is still a hex: contrast(#666B73, --bg) is 3.72 today and
    forever, so the claim is verifiable and stays verified.
    """
    sub(DOC, "it measured 3.72:1 on `--bg` and 3.41:1 on `--bg-2`",
        "it measured 4.60:1 on `--bg` and 3.41:1 on `--bg-2`")


MUTATIONS = [
    ("A  an absurd value in the normative token row", mut_doc_absurd,
     "--fg-3", "documented as #FF00FF"),
    ("B  base.css reverts the lift, the doc left correct", mut_css_reverts_lift,
     "--fg-3", "ships #666B73"),
    ("C  a token shipped and never documented", mut_undocumented_token,
     "--cat-mobile", "neither states it nor excludes it"),
    ("D  a documented token nothing defines", mut_ghost_token,
     "--ghost", "NO stylesheet defines it"),
    ("E  a duration in prose that nothing ships", mut_phantom_duration,
     "800ms", "no stylesheet uses it"),
    ("F  a stale ratio in a TABLE cell, not in prose", mut_table_ratio,
     "--fg-3", "measures 5.15:1"),
    ("G  a stale ratio in the tint table's last column", mut_tint_ratio,
     "--cat-testing", "measures 6.78:1"),
    ("H  a script named as available that is not on disk", mut_phantom_script,
     "measure_density.py", "not in this directory"),
    ("I  a stale HISTORICAL ratio, against a literal hex", mut_historical_ratio,
     "#666B73", "measures 3.72:1"),
]


def main():
    before = digest(FILES)
    saved = dict((p, read(p)) for p in FILES)

    mutationsafe.guard(FILES)
    mutationsafe.acquire(FILES)

    print("=" * 78)
    print("verify_round6_mutation.py   tree %s" % before)
    print("=" * 78)
    print("Each control re-creates a round-6 defect and asserts verify_designmd")
    print("FAILS naming the token and the reason. Exit 1 alone proves nothing:")
    print("an unrelated check could be failing, which is how a mutation passes")
    print("for a cause it was not written for.")
    print()

    caught, missed, wrong_reason = 0, [], []
    try:
        for name, mutate, token, expect in MUTATIONS:
            mutate()
            code, out = run_gate()
            named = token in out
            reasoned = expect in out
            if code != 0 and named and reasoned:
                caught += 1
                line = [l.strip() for l in out.splitlines()
                        if token in l and expect.split()[0] in l]
                print("  CAUGHT %-48s exit %d" % (name, code))
                print("         %s" % (line[0][:94] if line else "(named)"))
            elif code != 0 and named:
                wrong_reason.append((name, "failed naming %s but not for %r"
                                     % (token, expect)))
                print("  WRONG REASON %-42s exit %d" % (name, code))
            elif code != 0:
                wrong_reason.append((name, "failed but never named %s" % token))
                print("  WRONG REASON %-42s exit %d" % (name, code))
            else:
                missed.append(name)
                print("  MISSED %-48s exit %d" % (name, code))
            for p, s in saved.items():
                write(p, s)
    finally:
        for p, s in saved.items():
            write(p, s)
        mutationsafe.release()

    after = digest(FILES)
    print()
    print("-" * 78)
    print("tree after revert: %s  %s"
          % (after, "IDENTICAL" if after == before else "DIFFERENT"))

    print("\nre-running verify_designmd on the reverted tree:")
    code, out = run_gate()
    checked = [l.strip() for l in out.splitlines()
               if l.startswith(("ratio claims", "duration claims",
                                "every shipped token"))]
    print("  verify_designmd.py       exit %d  %s"
          % (code, "PASS" if code == 0 else "FAIL"))
    for c in checked:
        print("    %s" % c)

    ok = (not missed and not wrong_reason and after == before and code == 0)
    print()
    if ok:
        print("MUTATION TEST PASSED: %d of %d mutations caught, each naming the"
              % (caught, len(MUTATIONS)))
        print("token and the reason, tree reverted clean, the gate green after.")
        return 0
    for n in missed:
        print("  MISSED: %s" % n)
    for n, why in wrong_reason:
        print("  WRONG REASON: %s: %s" % (n, why))
    if after != before:
        print("  TREE NOT RESTORED")
    print("\nMUTATION TEST FAILED")
    return 1


if __name__ == "__main__":
    sys.exit(main())
