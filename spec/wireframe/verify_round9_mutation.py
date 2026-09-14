#!/usr/bin/env python3
"""Positive controls for round 9: the mobile laws, and what enforces them WHERE.

ROUND 5 OF THE SCOPE-BLIND CLASS, AND THE FIRST ONE A COVERAGE GATE MISSED.

Every earlier round of this defect was a rule enforced on too few SCREENS, and
round 4 answered that with population.py plus verify_coverage.py: no gate names
its own screens. Round 9 of review found the same class wearing a shape those
two cannot see.

    verify_flow.py     element-level overflow, both edges      8 screens
    verify_polish.py   document.scrollWidth > 320             25 screens

Both instruments really did visit all 33 screens between them, so
verify_mobile_coverage.py was green and CORRECT about what it measured. But
`scrollWidth` does not grow for an element hanging off the LEFT edge in an LTR
document, so on 25 of the 33 screens nothing could fail on left-side overflow
at any magnitude. Two screens were rendering the builder-notes control at
x=-20, cut off and reading `uilder notes`, with every gate green.

A COUNT OF SCREEN NAMES CANNOT SEE A WEAKER ASSERTION. That is the lesson, and
it is why the fix is not "add the check to verify_polish.py". The fix is:

  1. one probe emits every mobile finding, tagged with its kind (tapfloor.py),
     so two instruments cannot hold two definitions of one law
  2. each sweeper declares the kinds it consumes in HANDLED, and reports
     anything else as unhandled rather than dropping it
  3. verify_mobile_coverage.py compares each sweeper's HANDLED against the
     probe's own KINDS, and the probe's KINDS against the kinds its JavaScript
     actually pushes

THE CONTROLS ARE AIMED AT THE GUARANTEE, NOT AT THE BUG.

Re-planting the x=-20 toggle proves one fix. It does not prove the arrangement
that stops the sixth shape of this defect. So most of what follows breaks the
MECHANISM: a sweeper that stops consuming a kind, a probe that declares a kind
it never emits, a kind emitted but declared nowhere. Each must fail, and each
must fail NAMING the instrument, because the failure a person has to act on is
"this gate is weaker than that one".

THERE ARE THREE KINDS OF CONTROL HERE, AND CONFLATING TWO OF THEM COST TWO
ROUNDS OF FALSE RED.

    MUTATIONS   plant a DEFECT in the product, require the gate to FAIL
    BLINDINGS   plant a defect AND weaken the instrument, require it to go
                blind: a PASS with the defect still present is the finding
    NEGATIVES   plant legal layout, require SILENCE

H and I began life in MUTATIONS and reported MISSED twice while both gates were
fine. Weakening an instrument on a tree with no defect in it cannot make any
gate fail: round 9 fixed the CSS that positioned the toggle at x=-20 AND the
probe clause that could see it, so with the clause removed there is nothing left
at the left edge to miss. The gate passed because the tree was correct.

    defect planted, probe intact      exit 1, names 'div r9plant @-40..80'
    defect planted, probe weakened    exit 0, r9plant invisible

I carried a second, independent error worth naming separately: it mutates the
probe's RUNTIME behaviour and was pointed at verify_mobile_coverage.py, which
reads the probe's SOURCE with `ast`. A clause that suppresses findings at run
time cannot move a gate that never executes the probe.

THE NEGATIVE CONTROLS ARE HALF OF THIS FILE. An overflow rule reads every
element on the page, so the things it must NOT fire on are ordinary layout: a
full-bleed section that legitimately spans the viewport, a decorative layer
that is allowed to overflow its host, an element positioned off-screen and
hidden, a zero-width node. The first false failure is when somebody stops
reading this gate.

Run from the wireframe directory, with the preview server up. Reverts on any
exit, including SIGTERM.

    python3 devserver.py 3911 &
    python3 verify_round9_mutation.py http://127.0.0.1:3911/
"""
import hashlib
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import mutationsafe                                             # noqa: E402

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3911/"
if not BASE.endswith("/"):
    BASE += "/"

BASECSS = os.path.join(HERE, "base.css")
TAPFLOOR = os.path.join(HERE, "tapfloor.py")
POLISH = os.path.join(HERE, "verify_polish.py")
FLOW = os.path.join(HERE, "verify_flow.py")
NOTFOUND = os.path.join(HERE, "notfound.html")
WIREJS = os.path.join(HERE, "wireframe.js")
# Exactly the files this suite mutates, no more. A path declared here and
# never written to is an exemption for a file nothing touches, which is how a
# real one gets waved through later.
FILES = [BASECSS, TAPFLOOR, POLISH, FLOW, NOTFOUND, WIREJS]


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


def run(gate, with_url=False):
    env = dict(os.environ)
    env["WF_BASE"] = BASE
    cmd = [sys.executable, os.path.join(HERE, gate)] + ([BASE] if with_url else [])
    p = subprocess.run(cmd, capture_output=True, text=True, cwd=HERE, env=env)
    return p.returncode, p.stdout + p.stderr


def run_coverage():
    return run("verify_mobile_coverage.py")


def run_polish():
    return run("verify_polish.py")


def sub(path, old, new):
    """Replace and PROVE the replacement landed."""
    s = read(path)
    if old not in s:
        raise SystemExit("mutation target not found in %s:\n  %r"
                         % (os.path.basename(path), old[:90]))
    write(path, s.replace(old, new, 1))


# ======================================================================
# THE DEFECTS.
#
# A, B and C are the bug itself, in the three places it could hide. D through
# H are the GUARANTEE: each breaks the arrangement that is supposed to stop
# this class recurring, and each must be caught by the gate that owns it.
# ======================================================================

def mut_left_overflow_real():
    """The inherited cause, restored: `.perch-host ~ *` recapturing chrome.

    This is the defect a person could see. base.css lifts every later sibling
    of the decorative host into its own stacking context, page chrome is
    appended to <body> and is therefore a sibling, and the lift overrides
    `position: fixed` at equal specificity from further down the file. The
    toggle lands at x=-20 on the two screens that declare a .perch-host.

    It must be caught by verify_polish.py, which owns those two screens and
    which could not fail on it before this round.
    """
    sub(BASECSS,
        ".perch-host ~ *:not(.chrome),\n"
        ".perch-host ~ *:not(.chrome) .pane { position: relative; z-index: 2; }",
        ".perch-host ~ *,\n"
        ".perch-host ~ * .pane { position: relative; z-index: 2; }")


def mut_left_overflow_plant():
    """A bare element hanging 40px off the left edge of a general screen.

    The reviewer's control, on the screen they used. `scrollWidth` is 320 with
    this present, which is the whole point: the document does not grow, so the
    only instrument that can see it is one that reads element rectangles.
    """
    sub(NOTFOUND, "</body>",
        '<div style="position:relative;right:40px;width:120px;height:50px"'
        ' class="r9plant">r9plant</div>\n</body>')


def mut_right_overflow_plant():
    """The same defect on the other edge, which scrollWidth CAN see.

    Kept because a fix aimed at the left edge must not quietly stop reading
    the right one. Both edges are one law.
    """
    sub(NOTFOUND, "</body>",
        '<div style="position:relative;left:240px;width:200px;height:50px"'
        ' class="r9plant">r9plant</div>\n</body>')


def mut_sweeper_drops_a_kind():
    """verify_polish.py stops consuming overflow findings.

    THE ROUND-9 DEFECT ITSELF, expressed exactly. The gate still sweeps all
    25 screens, still opens every state, still reports a table. It simply
    stops asserting one of the laws, which is the difference between
    "visited" and "measured" that a screen count cannot see.

    verify_mobile_coverage.py must fail and NAME the instrument and the kind.
    """
    sub(POLISH, 'HANDLED = ("tap", "overflow", "chrome")',
        'HANDLED = ("tap", "chrome")')


def mut_sweeper_has_no_handled():
    """A sweeper that declares nothing at all.

    The benefit of the doubt is what let this class run for five rounds, so
    an instrument whose assertion set cannot be determined is a failure and
    not a silence.
    """
    sub(FLOW, 'HANDLED = ("tap", "overflow", "chrome")',
        'HANDLED_KINDS_RENAMED = ("tap", "overflow", "chrome")')


def mut_declared_but_never_emitted():
    """tapfloor.KINDS claims a law the probe does not implement.

    A declaration that nothing checks is how this class keeps happening: the
    document says one thing, the instrument means another, and both look
    green. Here the sweepers would dutifully handle a kind that can never
    arrive, and the coverage table would read as fuller than the tree is.
    """
    sub(TAPFLOOR, 'KINDS = ("tap", "overflow", "chrome")',
        'KINDS = ("tap", "overflow", "chrome", "contrast")')


def mut_emitted_but_never_declared():
    """The probe pushes a kind KINDS does not mention.

    The other direction, and the more dangerous one: findings arrive that no
    sweeper has been told to handle, so each one is silently dropped by every
    consumer while the probe believes it is enforcing a law.
    """
    sub(TAPFLOOR, "      kind: 'overflow',",
        "      kind: 'edgebleed',")


def mut_one_edge_only():
    """The probe reads the right edge and forgets the left.

    NOT IN MUTATIONS. This is a BLINDING control, and it took two rounds of
    MISSED to see why it cannot be a fail-expecting one.

    A mutation control plants a DEFECT and requires the gate to fail. This
    plants no defect: it weakens the INSTRUMENT. Round 9 fixed two things
    together, the CSS that positioned the builder-notes toggle at x=-20 and the
    probe clause that could see it, so on a fixed tree there is nothing at the
    left edge to miss. Removing the clause correctly changes nothing, the gate
    correctly passes, and the suite called that MISSED for two rounds while
    printing "the probe reads one edge only" as though the gate were weak.

    Measured, with the clause removed and a real element planted at x=-40:

        defect planted, probe intact    exit 1, names 'div r9plant @-40..80'
        defect planted, probe weakened  exit 0, r9plant invisible

    The pair is the assertion. See BLINDINGS.
    """
    sub(TAPFLOOR, "if (ro.right <= W + 0.5 && ro.left >= -0.5) continue;",
        "if (ro.right <= W + 0.5) continue;")


def mut_chrome_contract_unchecked():
    """.chrome stops being a contract and becomes a name.

    NOT IN MUTATIONS, for a second reason worth keeping separate from the one
    above: this mutation changes the probe's RUNTIME behaviour, and it was
    pointed at verify_mobile_coverage.py, which reads the probe's SOURCE with
    `ast` for the kinds it pushes. A clause that suppresses findings at run time
    cannot move a gate that never executes the probe. The control asserted
    against an instrument that structurally cannot see it.

    As a blinding pair against verify_polish.py, which does run the probe, it
    says something true: break the position contract and every .chrome finding
    disappears.
    """
    sub(TAPFLOOR, "    if (pos === 'fixed' || pos === 'sticky') continue;",
        "    if (pos !== 'THIS-NEVER-MATCHES') continue;")


# ======================================================================
# THE CONTROLS THAT MUST NOT FIRE.
#
# An overflow rule reads every element on every screen, so ordinary layout is
# what it is most likely to condemn. Three of these are patterns the tree
# already ships.
# ======================================================================

def mut_full_bleed():
    """A section spanning exactly the viewport, which is not overflow.

    The tree ships several. An element whose right edge sits at 320.0 is
    correct, and a probe with an off-by-one tolerance fails all of them.
    """
    sub(NOTFOUND, "</body>",
        '<div style="position:relative;width:320px;height:20px" '
        'class="r9plant">r9plant</div>\n</body>')


def mut_offscreen_hidden():
    """An element parked off-screen inside a hidden subtree.

    A closed drawer, a dialog that has not been opened, a template. It is off
    the edge and nobody can see it, and reporting it is noise that hides the
    real finding. The probe's reachability walk is what must exclude it.
    """
    sub(NOTFOUND, "</body>",
        '<div hidden><div style="position:relative;right:400px;width:100px;'
        'height:40px" class="r9plant">r9plant</div></div>\n</body>')


def mut_zero_width():
    """A zero-width node at a negative offset.

    Collapsed wrappers and screen-reader spacers measure 0 wide. They paint
    nothing, and a probe that counts them reports offenders on every screen.
    """
    sub(NOTFOUND, "</body>",
        '<span style="position:relative;right:80px;width:0;height:0" '
        'class="r9plant"></span>\n</body>')


def mut_decorative_layer_overflow():
    """The perch layer overflowing its host on purpose.

    `.perch-layer` is `overflow: visible` precisely so an agent can fly out of
    the header and down the page, and it is `pointer-events: none` and below
    content. The agents are absolutely positioned inside it and the layer
    itself stays within the viewport, so this must stay quiet: a gate that
    fires here would be read as "the decoration is broken" and the real fix
    would be to delete the decoration.
    """
    sub(NOTFOUND, "</body>",
        '<div class="perch-host r9plant" style="position:relative">'
        '<div class="perch-layer" style="overflow:visible"></div>'
        '<p>r9plant</p></div>\n</body>')


def mut_chrome_sticky():
    """A .chrome element that positions itself as sticky rather than fixed.

    The contract is "this element positions itself", not "this element is
    fixed". A sticky header satisfies it, and a gate that demanded `fixed`
    exactly would send somebody rewriting correct CSS.
    """
    sub(NOTFOUND, "</body>",
        '<div class="chrome r9plant" style="position:sticky;top:0;'
        'width:100px;height:44px">r9plant</div>\n</body>')


def mut_chrome_static_onscreen():
    """A .chrome element that does NOT position itself.

    Control I's defect half, and it has to be a defect ONLY this check can see.
    Two earlier shapes were wrong:

      mut_chrome_sticky          a NEGATIVE. Sticky satisfies the contract and
                                 must stay quiet, so it cannot be the defect.
      the same div at right:60px  caught by the OVERFLOW check as well, so
                                 removing the contract check left the gate
                                 failing anyway and the pair read NOT BEARING.

    The contract check fires on POSITION alone and needs no overflow, so the
    plant sits fully inside the viewport. Then the only instrument that can see
    it is the one being tested, which is what makes the blinding half meaningful.

    `.chrome` is a promise that the element positions itself, and that promise is
    what licenses the perch lift to skip it. An element carrying the class while
    statically laid out is that promise broken.
    """
    sub(NOTFOUND, "</body>",
        '<div class="chrome r9plant" style="position:relative;left:0;'
        'width:120px;height:44px">r9plant</div>\n</body>')


# Every marker this suite writes to disk, for the stray check after the
# revert. `r9plant` appears nowhere else in the tree, so the check cannot fire
# on a document paragraph describing a previous round's plant.
R9_MARKERS = ("r9plant",)


# name, mutate, the gate that must catch it, the file its output must name,
# a string that output must carry
MUTATIONS = [
    ("A  the inherited perch lift recaptures chrome", mut_left_overflow_real,
     run_polish, "browse.html", "notetoggle"),
    ("B  an element 40px off the LEFT edge", mut_left_overflow_plant,
     run_polish, "notfound.html", "@-40"),
    ("C  an element off the RIGHT edge", mut_right_overflow_plant,
     run_polish, "notfound.html", "440"),
    ("D  a sweeper stops consuming a kind", mut_sweeper_drops_a_kind,
     run_coverage, "verify_polish.py", "overflow"),
    ("E  a sweeper declares no HANDLED at all", mut_sweeper_has_no_handled,
     run_coverage, "verify_flow.py", "HANDLED"),
    ("F  a kind declared but never emitted", mut_declared_but_never_emitted,
     run_coverage, "contrast", "declared"),
    ("G  a kind emitted but never declared", mut_emitted_but_never_declared,
     run_coverage, "edgebleed", "not declared"),
]

# ======================================================================
# BLINDING PAIRS: is this clause LOAD-BEARING?
#
# A third kind of control, and the reason H and I sat in MUTATIONS reporting
# MISSED for two rounds. A mutation plants a DEFECT and requires a failure. A
# negative plants legal code and requires silence. Neither shape fits "this
# clause in the instrument is what catches the defect", because weakening an
# instrument on a tree with no defect in it cannot make any gate fail.
#
# So the assertion is a pair, and the second half is a PASS that means blindness:
#
#   plant the defect, probe intact    -> gate FAILS, naming the plant
#   plant the defect, probe weakened  -> gate PASSES, plant invisible
#
# Both halves are required. If the first does not fail, the gate never caught it
# and the clause is not the reason. If the second does not pass, the clause is
# not what was doing the catching, and something else is.
#
# (name, weaken, plant, gate, marker the gate must name when the probe is intact)
# ======================================================================

BLINDINGS = [
    ("H  the left-edge clause is load-bearing", mut_one_edge_only,
     mut_left_overflow_plant, run_polish, "r9plant"),
    ("I  the .chrome position contract is load-bearing",
     mut_chrome_contract_unchecked, mut_chrome_static_onscreen, run_polish,
     "chrome r9plant"),
]

NEGATIVES = [
    ("N1 a full-bleed section exactly 320 wide", mut_full_bleed, run_polish,
     "an element whose edge sits at the viewport is correct"),
    ("N2 an off-screen element inside a hidden subtree", mut_offscreen_hidden,
     run_polish, "nobody can see it, and reporting it hides the real finding"),
    ("N3 a zero-width node at a negative offset", mut_zero_width, run_polish,
     "it paints nothing"),
    ("N4 the decorative layer overflowing its host", mut_decorative_layer_overflow,
     run_polish, "the layer is overflow: visible on purpose, below content"),
    ("N5 a .chrome element that is sticky, not fixed", mut_chrome_sticky,
     run_polish, "the contract is that it positions itself, not that it is fixed"),
]


def main():
    before = digest(FILES)
    saved = dict((p, read(p)) for p in FILES)

    mutationsafe.guard(FILES)

    def restore():
        for p, s in saved.items():
            write(p, s)

    # The suite's own revert, handed to the safety rail. A catchable kill
    # (SIGTERM from a runner, SIGINT from a person, a tool timeout) now puts
    # the tree back before it exits, instead of leaving a plant on disk and
    # deleting the lock that would have announced it.
    mutationsafe.acquire(FILES, restore=restore)

    print("=" * 78)
    print("verify_round9_mutation.py   tree %s   %s" % (before, BASE))
    print("=" * 78)
    print("A, B and C are the defect a person could see. D through I break the")
    print("ARRANGEMENT that is supposed to stop the sixth shape of it: a")
    print("sweeper that drops a law, a probe that declares one it does not")
    print("implement, a probe that emits one nobody declared, a check that")
    print("reads one edge. Each must fail NAMING the instrument, because the")
    print("thing to act on is 'this gate is weaker than that one'.")
    print()

    caught, missed, wrong_reason = 0, [], []
    clean, false_alarm = 0, []
    load_bearing, not_bearing = 0, []
    try:
        for name, mutate, gate, where, expect in MUTATIONS:
            mutate()
            code, out = gate()
            # ONE LINE HAS TO CARRY BOTH the subject and the evidence. Asking
            # whether each appears anywhere in the output passes when two
            # unrelated checks print one each, which is how a mutation passes
            # for a cause it was not written for.
            hit = [l.strip() for l in out.splitlines()
                   if where in l and expect in l]
            if code != 0 and hit:
                caught += 1
                print("  CAUGHT %-46s exit %d" % (name, code))
                print("         %s" % hit[0][:94])
            elif code != 0 and where in out:
                wrong_reason.append((name, "failed naming %s but no single "
                                     "line carried %r" % (where, expect)))
                print("  WRONG REASON %-40s exit %d" % (name, code))
            elif code != 0:
                wrong_reason.append((name, "failed but never named %s" % where))
                print("  WRONG REASON %-40s exit %d" % (name, code))
            else:
                missed.append(name)
                print("  MISSED %-46s exit %d" % (name, code))
            for p, s in saved.items():
                write(p, s)

        print()
        for name, weaken, plant, gate, marker in BLINDINGS:
            # Half 1: the defect alone. The gate must SEE it, or this clause
            # was never what caught it and the pair proves nothing.
            plant()
            code_a, out_a = gate()
            named = [l.strip() for l in out_a.splitlines() if marker in l]
            for p, s in saved.items():
                write(p, s)

            # Half 2: the same defect with the clause removed. A PASS here is
            # the finding: the instrument has gone blind to a defect that is
            # still on the page.
            plant()
            weaken()
            code_b, out_b = gate()
            blind = marker not in out_b
            for p, s in saved.items():
                write(p, s)

            if code_a != 0 and named and code_b == 0 and blind:
                load_bearing += 1
                print("  LOAD-BEARING %-41s intact exit %d, weakened exit %d"
                      % (name, code_a, code_b))
                print("         sees it:   %s" % named[0][:86])
                print("         blinded:   %s no longer reported" % marker)
            elif code_a == 0 or not named:
                not_bearing.append(
                    (name, "the gate did not fail on the planted defect with "
                           "the probe INTACT (exit %d), so this clause is not "
                           "what catches it" % code_a))
                print("  NOT BEARING  %-41s intact exit %d" % (name, code_a))
            else:
                not_bearing.append(
                    (name, "the gate still failed with the clause removed "
                           "(exit %d), so something else catches this and the "
                           "clause is not load-bearing" % code_b))
                print("  NOT BEARING  %-41s weakened exit %d" % (name, code_b))

        print()
        for name, mutate, gate, why in NEGATIVES:
            mutate()
            code, out = gate()
            if code == 0:
                clean += 1
                print("  QUIET  %-46s exit 0" % name)
                print("         %s" % why)
            else:
                bad = [l.strip() for l in out.splitlines()
                       if "overflow" in l or "chrome" in l or "unhandled" in l]
                false_alarm.append((name, bad[0][:90] if bad else "exit 1"))
                print("  FALSE ALARM %-41s exit %d" % (name, code))
                print("         %s" % (bad[0][:88] if bad else ""))
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

    # A planted ELEMENT can survive a botched revert in a way a digest taken
    # after the same botched revert cannot see, so the markers are grepped for
    # by name as well. Every marker here is unique to this suite.
    strays = []
    for marker in R9_MARKERS:
        for p in FILES:
            if marker in read(p):
                strays.append("%s in %s" % (marker, os.path.basename(p)))
    if strays:
        print("STRAY MUTATION MARKERS LEFT ON DISK:")
        for s in strays:
            print("   " + s)

    print("\nre-running both gates on the reverted tree:")
    ccode, cout = run_coverage()
    pcode, pout = run_polish()
    for label, code, out in (("verify_mobile_coverage.py", ccode, cout),
                             ("verify_polish.py", pcode, pout)):
        print("  %-26s exit %d  %s"
              % (label, code, "PASS" if code == 0 else "FAIL"))
    for line in cout.splitlines():
        if line.startswith("PASS"):
            print("    %s" % line.strip()[:92])

    ok = (not missed and not wrong_reason and not false_alarm
          and not not_bearing and not strays
          and after == before and ccode == 0 and pcode == 0)
    print()
    if ok:
        print("MUTATION TEST PASSED: %d of %d defects caught, %d of %d clauses "
              "proved load-bearing," % (caught, len(MUTATIONS),
                                        load_bearing, len(BLINDINGS)))
        print("%d of %d legal layouts left alone, tree reverted clean, both "
              "gates green." % (clean, len(NEGATIVES)))
        return 0

    print("MUTATION TEST FAILED")
    for n in missed:
        print("  MISSED       %s" % n)
    for n, why in wrong_reason:
        print("  WRONG REASON %s: %s" % (n, why))
    for n, why in not_bearing:
        print("  NOT BEARING  %s: %s" % (n, why))
    for n, why in false_alarm:
        print("  FALSE ALARM  %s: %s" % (n, why))
    if after != before:
        print("  TREE NOT RESTORED")
    return 1


if __name__ == "__main__":
    sys.exit(main())
