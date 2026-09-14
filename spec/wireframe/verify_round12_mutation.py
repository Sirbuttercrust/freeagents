#!/usr/bin/env python3
"""Round 12: a gate that says it reads the browser, and reads the file.

Round 11 found this class in `verify_kept.py`: a docstring promising Chrome's
computed accessible name over a probe that read `getAttribute`. The fix closed
one instance. `verify_names.py` was the class's other half, and a bigger one:
it computed the accessible name for EVERY control on all 33 screens with a
hand-rolled JavaScript ladder, and that ladder ended in two rungs that name a
control with something a person cannot see.

  placeholder  painted only while the field is EMPTY, so a field shipping
               with a value never paints it at all
  title        needs a hover, and a touch device has none. Every mobile law
               in this set is measured under `(pointer: coarse)`.

Two controls were living there, found by measuring the source of all 574
names rather than by reading the eight screens a review had named:

  browse.html   the search field, announced "React components, Postgres
                migration, flaky tests", an example list rather than a name,
                on a field carrying value="React, accessibility"
  agent.html    the DID copy button, announced "Copy the DID" from a title

The gate reads `Accessibility.getFullAXTree` now, joined to the markup by
`backendDOMNodeId`, and fails any control whose WINNING source is a
placeholder or a title.

  M1  the search field loses its label      -> FAIL, names the placeholder
  M2  the copy button loses its label       -> FAIL, names the title
  M3  a nameless control                    -> FAIL, the older assertion,
                                               re-proved on the new reader
  B   the same defect, gate blinded          -> PASS, defect invisible.
      Removing the source read is what stops M1 being caught, which is the
      half that proves the source read is load-bearing rather than decorative.
  N1  a placeholder BESIDE a real label     -> quiet
  N2  a title BESIDE an aria-label          -> quiet
  N3  a placeholder on a field with a label -> quiet

The negative half matters more than usual here. A rule against placeholders
that fires on any placeholder would condemn every well-labelled field in the
set, and the first person to hit that stops reading the gate. What fails is a
name that EXISTS ONLY in an invisible source, which is why the assertion is
written against the winning source rather than against the attribute.

Run from the wireframe directory with the preview server up. Reverts on any
exit, including SIGTERM.

    python3 devserver.py 3111 &
    python3 verify_round12_mutation.py http://127.0.0.1:3111/
"""
import hashlib
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import mutationsafe                                             # noqa: E402

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3111/"
if not BASE.endswith("/"):
    BASE += "/"

BROWSE = os.path.join(HERE, "browse.html")
AGENT = os.path.join(HERE, "agent.html")
NAMES = os.path.join(HERE, "verify_names.py")
SETTINGS = os.path.join(HERE, "agentsettings.html")
STAGED = os.path.join(HERE, "staged.html")
# Exactly the files this suite writes to. A path declared and never written is
# an exemption for a file nothing touches, which is how a real one gets waved
# through later.
FILES = [BROWSE, AGENT, NAMES, SETTINGS, STAGED]

# Unique to this suite, so the stray check after the revert cannot fire on a
# document paragraph describing another round's plant.
MARKERS = ("r12ph", "r12ti")

# M1: the search field as it was before round 12, named by its placeholder.
SEARCH_FIXED = ('<input class="input" id="q" '
                'aria-label="Search agents by the work you need done" '
                'placeholder="React components, Postgres migration, flaky tests" '
                'value="React, accessibility">')
SEARCH_BROKEN = ('<input class="input" id="q" '
                 'placeholder="React components, Postgres migration, flaky tests" '
                 'value="React, accessibility">')

# M2: the DID copy button as it was, named by its title.
COPY_FIXED = ('<button class="copybtn" '
              'data-copy="did:abt:z1Mv4bTQ8kQx7Lp2Rn9Wd3Yc6Vf1Hs4Jm" '
              'aria-label="Copy the DID" title="Copy the DID">')
COPY_BROKEN = ('<button class="copybtn" '
               'data-copy="did:abt:z1Mv4bTQ8kQx7Lp2Rn9Wd3Yc6Vf1Hs4Jm" '
               'title="Copy the DID">')

# M3: a control with no name at all. An icon-only button with an aria-hidden
# glyph inside is the shape this really takes in a tree that uses an icon set,
# which is why the plant is that and not an empty <button>.
NAMELESS_ANCHOR = '<div class="searchrow">'
NAMELESS_PLANT = ('<div class="searchrow">\n'
                  '  <button class="r12nameless" type="button">'
                  '<span class="ico" data-ico="search" aria-hidden="true">'
                  '</span></button>\n')

# N1: a placeholder is legal beside a real name. Planted on a field that
# already carries a <label for>, it must stay silent. On agentsettings.html,
# because that is where a labelled text field lives; the first draft of this
# control aimed at browse.html and the suite refused to run rather than
# silently planting nothing, which is why sub() proves its target landed.
N1_FILE = os.path.join(HERE, "agentsettings.html")
N1_ANCHOR = '<input class="input" id="sk" value="React, TypeScript'
N1_PLANT = ('<input class="input" id="sk" placeholder="r12ph example" '
            'value="React, TypeScript')

# N3: a title on a control named by a WRAPPING label, inside a dialog. A
# different legal shape from N2 (which is a title beside an aria-label) and on
# a different screen, because a rule quiet on one legal instance and loud on
# another is worse than one loud on both. Inside a dialog also proves the
# source read survives the state walk.
N3_FILE = os.path.join(HERE, "staged.html")
N3_ANCHOR = '<li><label><input type="radio" name="rline"><span>01 &nbsp;'
N3_PLANT = ('<li><label><input type="radio" name="rline" '
            'title="r12ti pick this line"><span>01 &nbsp;')

# B: the blinding. The gate keeps reading the accessibility tree and stops
# reading WHICH source won, which is the single thing that separates a name
# a person can see from one they cannot.
SOURCE_READ = '        it["source"] = winning_source(nm)'
SOURCE_BLIND = '        it["source"] = ""'


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


def sub(path, old, new):
    """Replace and PROVE the replacement landed."""
    s = read(path)
    if old not in s:
        raise SystemExit("target not found in %s:\n  %r"
                         % (os.path.basename(path), old[:120]))
    write(path, s.replace(old, new, 1))


def run_names():
    env = dict(os.environ)
    env["WF_BASE"] = BASE
    p = subprocess.run([sys.executable, os.path.join(HERE, "verify_names.py"),
                        BASE], capture_output=True, text=True, cwd=HERE, env=env)
    return p.returncode, p.stdout + p.stderr


def names_line(out, screen, needle):
    """The FAILURE line, not any line mentioning the screen.

    Round 8's lesson, relearned in round 11: the report prints a row per
    screen whether or not anything failed, so matching "the screen appears in
    the output" passes on a gate that asserts nothing. The failure lines are
    the indented ones under FAILURES.
    """
    hits = []
    seen_header = False
    for line in out.splitlines():
        if line.startswith("FAILURES:"):
            seen_header = True
            continue
        if seen_header and line.startswith("  ") and screen in line and needle in line:
            hits.append(line.strip())
    return hits


def main():
    before = digest(FILES)
    saved = dict((p, read(p)) for p in FILES)

    mutationsafe.guard(FILES)

    def restore():
        for p, s in saved.items():
            write(p, s)

    mutationsafe.acquire(FILES, restore=restore)

    print("=" * 78)
    print("verify_round12_mutation.py   tree %s   %s" % (before, BASE))
    print("=" * 78)
    print("A name only a mouse user can reach is a name the screen does not")
    print("carry. M1 and M2 are the two this round found and fixed; B proves")
    print("the source read is what catches them; N1 to N3 prove the rule does")
    print("not condemn a placeholder or a title used correctly.")
    print()

    results = []
    try:
        # ------------------------------------------------------------- M1
        sub(BROWSE, SEARCH_FIXED, SEARCH_BROKEN)
        c1, out1 = run_names()
        named1 = names_line(out1, "browse.html", "placeholder")
        restore()
        ok1 = c1 != 0 and bool(named1)
        results.append(("M1 a field named only by its placeholder", ok1))
        print("M1  the search field loses its label")
        print("    verify_names.py  exit %d  %s"
              % (c1, (named1[0][:88] if named1 else "NOT NAMED")))

        # ------------------------------------------------------------- M2
        sub(AGENT, COPY_FIXED, COPY_BROKEN)
        c2, out2 = run_names()
        named2 = names_line(out2, "agent.html", "title")
        restore()
        ok2 = c2 != 0 and bool(named2)
        results.append(("M2 a button named only by its title", ok2))
        print()
        print("M2  the DID copy button loses its label")
        print("    verify_names.py  exit %d  %s"
              % (c2, (named2[0][:88] if named2 else "NOT NAMED")))

        # ------------------------------------------------------------- M3
        sub(BROWSE, NAMELESS_ANCHOR, NAMELESS_PLANT)
        c3, out3 = run_names()
        named3 = names_line(out3, "browse.html", "NO accessible name")
        restore()
        ok3 = c3 != 0 and bool(named3)
        results.append(("M3 a control with no name at all", ok3))
        print()
        print("M3  an icon-only button with an aria-hidden glyph")
        print("    verify_names.py  exit %d  %s"
              % (c3, (named3[0][:88] if named3 else "NOT NAMED")))

        # -------------------------------------------------------------- B
        # The blinding half. The defect is planted AND the gate is weakened,
        # and the required result is a PASS: that is what proves the clause
        # under test is the thing that catches M1, rather than something else
        # in the gate catching it for unrelated reasons.
        sub(BROWSE, SEARCH_FIXED, SEARCH_BROKEN)
        sub(NAMES, SOURCE_READ, SOURCE_BLIND)
        cb, outb = run_names()
        namedb = names_line(outb, "browse.html", "placeholder")
        restore()
        okb = cb == 0 and not namedb
        results.append(("B  the source read is load-bearing", okb))
        print()
        print("B   the same defect, with the winning-source read removed")
        print("    verify_names.py  exit %d  %s"
              % (cb, "silent" if not namedb else "still names it"))
        print("    a PASS here is the point: nothing else in the gate sees it")

        # ------------------------------------------------------------- N1
        sub(N1_FILE, N1_ANCHOR, N1_PLANT)
        n1c, n1out = run_names()
        restore()
        okn1 = n1c == 0
        results.append(("N1 a placeholder beside a real label", okn1))
        print()
        print("N1  a placeholder added to a field that HAS a label")
        print("    verify_names.py  exit %d  %s"
              % (n1c, "quiet" if okn1 else "FAILED on legal markup"))

        # ------------------------------------------------------------- N2
        # A title BESIDE an aria-label: the shape a tooltip takes on a control
        # that is also named properly. aria-label wins the name, so the title
        # is decoration and must not fail.
        sub(AGENT, 'aria-label="Copy the DID" title="Copy the DID"',
            'aria-label="Copy the DID" title="r12ti tooltip text"')
        n2c, n2out = run_names()
        restore()
        okn2 = n2c == 0
        results.append(("N2 a title beside an aria-label", okn2))
        print("N2  a tooltip title on a control that HAS an aria-label")
        print("    verify_names.py  exit %d  %s"
              % (n2c, "quiet" if okn2 else "FAILED on legal markup"))

        # ------------------------------------------------------------- N3
        sub(N3_FILE, N3_ANCHOR, N3_PLANT)
        n3c, n3out = run_names()
        restore()
        okn3 = n3c == 0
        results.append(("N3 a title on a control a label already names", okn3))
        print("N3  a title on a radio named by its wrapping label, in a dialog")
        print("    verify_names.py  exit %d  %s"
              % (n3c, "quiet" if okn3 else "FAILED on legal markup"))

    finally:
        restore()
        mutationsafe.release()

    after = digest(FILES)
    print()
    print("-" * 78)
    print("tree after revert: %s  %s"
          % (after, "IDENTICAL" if after == before else "DIFFERENT, INVESTIGATE"))

    # A planted ELEMENT that survives a botched revert is invisible to a
    # digest taken after that same botched revert, so grep for the markers too.
    stray = []
    for p in FILES:
        body = read(p)
        for m in MARKERS + ("r12nameless",):
            if m in body:
                stray.append("%s carries %s" % (os.path.basename(p), m))
    if stray:
        print("STRAY PLANTS LEFT IN THE TREE:")
        for s in stray:
            print("   " + s)

    cf, outf = run_names()
    print("reverted tree: verify_names.py exit %d" % cf)

    print()
    allok = all(ok for _, ok in results) and after == before and not stray and cf == 0
    for label, ok in results:
        print("  %-46s %s" % (label, "AS EXPECTED" if ok else "** WRONG **"))
    print()
    if allok:
        print("MUTATION TEST PASSED: 3 of 3 defects caught, 1 of 1 clauses proved")
        print("load-bearing, 3 of 3 legal patterns left alone, tree reverted clean.")
        return 0
    print("MUTATION TEST FAILED.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
