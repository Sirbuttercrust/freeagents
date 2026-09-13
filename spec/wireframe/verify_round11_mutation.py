#!/usr/bin/env python3
"""Round 11: the limits DESIGN.md 10 NAMES are the limits the gate has.

Every previous suite here proves a gate CATCHES something. This one proves the
opposite claim, which round 11 of review is entirely about:

  A document that names a gap it does not have is the same defect as a
  document that names a detection it does not have.

D19 was the second kind. `DESIGN.md:870` said verify_mobile_coverage.py reports
a sweeper "that asserts it only before anything is opened", and it does not:
walk_of() reads which route a sweeper's SOURCE reaches for, and a sweeper can
drive the shared walk, receive every state, and filter the findings to the
closed read before asserting. The ruling was to weaken the sentence to what the
gate checks rather than to build a sixth instrument auditing the fifth.

Weakening a claim by hand is how the first kind happens. The first draft of
that weakened text named two limits and a control proved one of them wrong: a
probe fetched through getattr IS caught, by the gate's fallback direction. So
the three shapes are pinned here and run.

  L1  consumption   drive the shared walk, filter to the closed read
                    -> the defect goes unreported, coverage stays green
  L2  reachability  keep `if False: tapfloor.sweep(...)`, read the probe
                    another way in the live path
                    -> coverage prints tapfloor.sweep and stays green
  L3  third route   reach tapfloor through getattr
                    -> CAUGHT. Unrecognised is a failure, never a pass, and
                       that disposition is what makes L1 and L2 tolerable
  L4  the same audit, run over the other claim sentences in the documents,
      found two more. BUILD-STATE said a screen rendering [data-avatar]
      without swarm.js "paints an empty 32x32 box" and credited load_swarm.py
      with failing on it. Measured, neither was true. polish.js falls back to
      the older FA.avatar engine, so the page paints a DIFFERENT face, 12
      shapes against the swarm's 213, and load_swarm.py REPAIRS the page and
      exits 0 and is in no gate run. verify_polish.py now asserts the
      generator, and L4 is the ordinary mutation proving it fails.
  L5  verify_kept.py's own docstring said the brand's accessible name is
      "computed by Chrome... not 'the attribute is in the file'", while its
      probe read getAttribute('aria-label'). An aria-labelledby planted beside
      the untouched attribute made Chrome announce "Untitled page" with the
      gate green. It reads the accessibility tree now, and L5 proves it.

L1 and L2 assert a PASS on a tree carrying a real defect, which is the inverse
of a mutation control and the reason this file is separate from the others: a
green here means the documented limit is real. L3, L4 and L5 assert a failure.
If L3 ever starts passing, the fallback direction has been inverted and the
two named limits stop being tolerable, so the document has to change with it.

Run from the wireframe directory with the preview server up. Reverts on any
exit, including SIGTERM.

    python3 devserver.py 3111 &
    python3 verify_round11_mutation.py http://127.0.0.1:3111/
"""
import ast
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

FLOW = os.path.join(HERE, "verify_flow.py")
STAGED = os.path.join(HERE, "staged.html")
# The avatar fixture. Named rather than derived for the reason the dialog one
# is: the control asserts the gate names THIS screen back, so a fixture chosen
# at run time would leave nothing to expect. agentsettings.html renders one
# [data-avatar] host and loads swarm.js, which is exactly the pair the plant
# needs to break.
SETTINGS = os.path.join(HERE, "agentsettings.html")
# The brand-name fixture. notfound.html is the smallest screen in the set that
# carries a.brand, so the plant is unambiguous, and the assertion is that the
# gate names THIS screen back.
NOTFOUND = os.path.join(HERE, "notfound.html")
# Exactly the files this suite writes to. A path declared and never written is
# an exemption for a file nothing touches, which is how a real one gets waved
# through later.
FILES = [FLOW, STAGED, SETTINGS, NOTFOUND]

# Unique to this suite, so the stray check after the revert cannot fire on a
# document paragraph describing another round's plant.
MARKERS = ("r11probe", "r11hijack")

# The fixture is named rather than derived, for the reason round 10's was: the
# defect only exists inside a specific <dialog>, and a screen chosen at run
# time might have none. See INLINE_WITH_REASON in verify_coverage.py.
PAYBAL = '<dialog class="sheet" id="paybal" aria-labelledby="payh">\n'
PLANT = ('  <div class="chrome r11probe" style="position:relative;left:0;'
         'width:120px;height:44px">r11probe</div>\n')

SWEEP_CALL = "        t = tapfloor.sweep(b, url)"

# The avatar generator's script tag. Removing it is the whole L4 plant.
SWARM_TAG = '<script src="swarm.js"></script>\n'

# L5: the brand keeps its aria-label and gains a label pointing elsewhere. A
# related element WINS over aria-label in the accessible name calculation, so
# a screen reader announces the other text while the attribute is untouched.
BRAND_LABEL = 'aria-label="FreeAgents home"'
BRAND_HIJACK = ('aria-label="FreeAgents home" aria-labelledby="r11hijack"')
HIJACK_NODE = ('<span id="r11hijack" style="position:absolute;left:-9999px">'
               'Untitled page</span>\n</body>')

CHROME_READ = ('             "chrome": [tapfloor.fmt(x)\n'
               '                        for x in tapfloor.of_kind(t["bad"], "chrome")],\n')
CHROME_READ_FILTERED = (
    '             "chrome": [tapfloor.fmt(x)\n'
    '                        for x in tapfloor.of_kind(t["bad"], "chrome")\n'
    '                        if x.get("state") == "closed"],\n')

# L2: the sweep call survives in the source, in a branch that cannot execute.
DEAD_SWEEP_LIVE_RAW = (
    "        if False:\n"
    "            t = tapfloor.sweep(b, url)\n"
    "        b.goto(url)\n"
    "        _p = getattr(tapfloor, 'PROBE' + '_JS')\n"
    "        t = __import__('json').loads(b.js(_p))\n"
    "        t = {'coarse': t['coarse'], 'docW': t['docW'],\n"
    "             'opened': 0, 'dialogs': [], 'bad': t['bad']}")

# L3: no attribute access on tapfloor for either known route.
GETATTR_ONLY = (
    "        b.goto(url)\n"
    "        _p = getattr(tapfloor, 'PROBE' + '_JS')\n"
    "        t = __import__('json').loads(b.js(_p))\n"
    "        t = {'coarse': t['coarse'], 'docW': t['docW'],\n"
    "             'opened': 0, 'dialogs': [], 'bad': t['bad']}")


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


def run(gate, with_url=False):
    env = dict(os.environ)
    env["WF_BASE"] = BASE
    cmd = [sys.executable, os.path.join(HERE, gate)] + ([BASE] if with_url else [])
    p = subprocess.run(cmd, capture_output=True, text=True, cwd=HERE, env=env)
    return p.returncode, p.stdout + p.stderr


def coverage():
    """Exit code plus the sweeper's own row, which is where the claim shows."""
    code, out = run("verify_mobile_coverage.py")
    row = [l.strip() for l in out.splitlines() if l.startswith("verify_flow.py")]
    return code, (row[0] if row else "(no row for verify_flow.py)")


def attribute_routes(path):
    """Which tapfloor attributes a file's AST reaches for, if any.

    Read with the parser rather than with a substring search, because the gate
    under test reads an AST and a comment is not in one. The first version of
    L3 searched the source text for "tapfloor.sweep", matched a COMMENT in
    verify_flow.py explaining the round-10 fix, and reported the gate as
    behaving other than documented while the gate was correct.

    Returns (touches_neither_known_route, a description of what it found).
    """
    tree = ast.parse(read(path))
    found = set()
    for node in ast.walk(tree):
        if (isinstance(node, ast.Attribute)
                and isinstance(node.value, ast.Name)
                and node.value.id == "tapfloor"
                and node.attr in ("sweep", "PROBE_JS", "probe_js")):
            found.add("tapfloor." + node.attr)
    return (not found), " ".join(sorted(found))


def run_polish():
    return run("verify_polish.py")


def run_kept():
    return run("verify_kept.py", with_url=True)


def main():
    before = digest(FILES)
    saved = dict((p, read(p)) for p in FILES)

    mutationsafe.guard(FILES)

    def restore():
        for p, s in saved.items():
            write(p, s)

    mutationsafe.acquire(FILES, restore=restore)

    print("=" * 78)
    print("verify_round11_mutation.py   tree %s   %s" % (before, BASE))
    print("=" * 78)
    print("L1 and L2 assert a PASS on a tree that carries a real defect: they")
    print("prove the limits DESIGN.md 10 names are real. L3, L4 and L5 assert")
    print("a FAILURE, because unrecognised has to stay a failure for L1 and L2")
    print("to be tolerable at all.")
    print()

    results = []
    try:
        # ------------------------------------------------------------- L1
        # The reference reading first: with nothing weakened, the gate that
        # owns these screens fails and names the plant. Without this half the
        # PASS below would prove nothing, since a gate can be silent because
        # the plant never landed.
        sub(STAGED, PAYBAL, PAYBAL + PLANT)
        ref_code, ref_out = run("verify_flow.py", with_url=True)
        ref_named = [l.strip() for l in ref_out.splitlines() if "r11probe" in l]
        restore()

        sub(STAGED, PAYBAL, PAYBAL + PLANT)
        sub(FLOW, CHROME_READ, CHROME_READ_FILTERED)
        c1, row1 = coverage()
        f1, out1 = run("verify_flow.py", with_url=True)
        restore()

        ok1 = (ref_code != 0 and ref_named
               and c1 == 0 and f1 == 0 and "r11probe" not in out1)
        results.append(("L1 consumption is not read", ok1))
        print("L1  the gate does not read what a sweeper filters out")
        print("    reference, plant only     verify_flow.py  exit %d  %s"
              % (ref_code, (ref_named[0][:64] if ref_named else "NOT NAMED")))
        print("    plant + closed filter     verify_flow.py  exit %d  %s"
              % (f1, "silent" if "r11probe" not in out1 else "still names it"))
        print("                              coverage        exit %d" % c1)
        print("                              %s" % row1[:72])

        # ------------------------------------------------------------- L2
        sub(STAGED, PAYBAL, PAYBAL + PLANT)
        sub(FLOW, SWEEP_CALL, DEAD_SWEEP_LIVE_RAW)
        c2, row2 = coverage()
        f2, out2 = run("verify_flow.py", with_url=True)
        restore()
        ok2 = (c2 == 0 and "tapfloor.sweep" in row2
               and f2 == 0 and "r11probe" not in out2)
        results.append(("L2 the call is not checked for reachability", ok2))
        print()
        print("L2  a sweep call under `if False:` reads as a live one")
        print("    coverage        exit %d  %s" % (c2, row2[:72]))
        print("    verify_flow.py  exit %d  %s, defect still planted"
              % (f2, "silent" if "r11probe" not in out2 else "names it"))

        # ------------------------------------------------------------- L3
        sub(STAGED, PAYBAL, PAYBAL + PLANT)
        sub(FLOW, SWEEP_CALL, GETATTR_ONLY)
        # ASKED OF THE PARSER, NOT OF THE TEXT. The first version of this
        # control searched the source for "tapfloor.sweep" as a substring and
        # got a hit from a COMMENT, so it reported the gate as behaving other
        # than documented while the gate was right. walk_of reads an AST and
        # comments are not in one, so the control has to read it the same way
        # the gate does: the question is what the parser sees, and a text
        # search answers a different question.
        neither, why = attribute_routes(FLOW)
        c3, row3 = coverage()
        restore()
        ok3 = (neither and c3 != 0 and "own (" in row3)
        results.append(("L3 a third route is CAUGHT by the fallback", ok3))
        print()
        print("L3  reaching the probe by getattr touches neither known route")
        print("    tapfloor attribute access in the AST: %s" % (why or "none"))
        print("    coverage        exit %d  %s" % (c3, row3[:72]))

        # ------------------------------------------------------------- L4
        # A MUTATION, in the ordinary direction: plant a real defect and
        # require the gate to fail naming it. It lives in this suite because
        # the defect was FOUND by auditing a claim sentence, the same way D19
        # was, and because the sentence describing it was wrong in the same
        # way: BUILD-STATE said a screen missing swarm.js paints an empty box
        # and credited load_swarm.py with catching it. Neither held. polish.js
        # falls back to the older FA.avatar engine, so the page paints a
        # different face, and load_swarm.py repairs the page and exits 0.
        sub(SETTINGS, SWARM_TAG, "")
        renders = "data-avatar" in read(SETTINGS)
        p4, out4 = run_polish()
        named4 = [l.strip() for l in out4.splitlines()
                  if "agentsettings.html" in l and "swarm generator" in l]
        restore()
        ok4 = (renders and p4 != 0 and named4)
        results.append(("L4 an avatar with no swarm generator FAILS", ok4))
        print()
        print("L4  a screen renders [data-avatar] and does not load swarm.js")
        print("    still renders an avatar host: %s" % renders)
        print("    verify_polish.py exit %d  %s"
              % (p4, (named4[0][:80] if named4 else "does NOT name it")))

        # ------------------------------------------------------------- L5
        # The third claim sentence the survey caught, and the one with the
        # cheapest real fix. verify_kept.py's docstring says the brand's
        # accessible name is "computed by Chrome... not 'the attribute is in
        # the file'". Its probe read the attribute. An aria-labelledby beside
        # the untouched aria-label makes the two disagree, because a related
        # element wins the name calculation, and the old probe passed.
        sub(NOTFOUND, BRAND_LABEL, BRAND_HIJACK)
        sub(NOTFOUND, "</body>", HIJACK_NODE)
        still_labelled = BRAND_LABEL in read(NOTFOUND)
        p5, out5 = run_kept()
        # PIN THE FAILURE LINE, NOT THE REPORT TABLE. The first version of
        # this control matched any line holding the screen and the hijacked
        # name, and the gate's own table prints exactly that for every screen
        # whether or not it asserts anything. So the control would have passed
        # on a gate that printed the name and made no assertion, which is the
        # state this gate was in before round 11. "brand announces" appears
        # only in the failure.
        named5 = [l.strip() for l in out5.splitlines()
                  if "notfound.html" in l and "brand announces" in l
                  and "Untitled page" in l]
        restore()
        ok5 = (still_labelled and p5 != 0 and named5)
        results.append(("L5 the brand name is read from the a11y tree", ok5))
        print()
        print("L5  the brand keeps aria-label and gains a label pointing away")
        print("    the aria-label attribute is untouched: %s" % still_labelled)
        print("    verify_kept.py   exit %d  %s"
              % (p5, (named5[0][:80] if named5 else "does NOT name it")))
    finally:
        for p, s in saved.items():
            write(p, s)
        mutationsafe.release()

    after = digest(FILES)
    print()
    print("-" * 78)
    print("tree after revert: %s  %s"
          % (after, "IDENTICAL" if after == before else "DIFFERENT"))

    # A planted ELEMENT can survive a botched revert in a way a digest taken
    # after the same botched revert cannot see, so the markers are grepped by
    # name as well.
    strays = ["%s in %s" % (m, os.path.basename(p))
              for m in MARKERS for p in FILES if m in read(p)]
    if strays:
        print("STRAY MARKERS LEFT ON DISK:")
        for s in strays:
            print("   " + s)

    ccode, _ = coverage()
    fcode, _ = run("verify_flow.py", with_url=True)
    print("reverted tree: coverage exit %d, verify_flow.py exit %d" % (ccode, fcode))
    print()
    for label, ok in results:
        print("  %-46s %s" % (label, "AS DOCUMENTED" if ok else "NOT AS DOCUMENTED"))

    ok = (all(o for _, o in results) and after == before and not strays
          and ccode == 0 and fcode == 0)
    print()
    if ok:
        print("LIMITS TEST PASSED: %d of %d documented behaviours hold, tree "
              "reverted clean." % (sum(1 for _, o in results if o), len(results)))
        print("DESIGN.md 10 and the gate's PASS banner describe this gate.")
        return 0

    print("LIMITS TEST FAILED")
    for label, o in results:
        if not o:
            print("  %s" % label)
    print("A documented limit is not what the gate does. Fix the SENTENCE to")
    print("match the measurement, or the gate to match the sentence. A document")
    print("naming a gap it does not have is the same defect as one naming a")
    print("detection it does not have.")
    if after != before:
        print("  TREE NOT RESTORED")
    return 1


if __name__ == "__main__":
    sys.exit(main())
