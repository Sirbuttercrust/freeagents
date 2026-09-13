#!/usr/bin/env python3
"""Positive controls for round 10: a law enforced in one STATE is not enforced.

ROUND 6 OF THE SCOPE-BLIND CLASS. Each round found the same defect one
question further in, and each previous answer was correct and incomplete.

    round 4   WHICH SCREENS does an instrument visit?      population.py
    round 5   WHICH KINDS does it consume on them?          HANDLED / KINDS
    round 10  IN WHICH STATES does it consume them?         this file

verify_flow.py declared `HANDLED = ("tap", "overflow", "chrome")`, truthfully,
and swept its 8 screens closed, then with disclosures open, then with each
dialog open. It then asserted `chrome` and the unhandled-kind backstop from
the CLOSED read alone, because those two lines sat above its own hand-rolled
dialog walk and read the variable from before it.

So the `.chrome` position contract had a real enforcement on six payment
screens as they load, and none at all inside their dialogs. Those dialogs are
where a person pays a balance, asks for a redo, and declines a job.

Isolated on the live tree at 2fb069e, one element, one screen, two states:

    plant in dialog #paybal on staged.html   verify_flow.py exit 0, never named
    the SAME element visible on load         verify_flow.py exit 1, named it

verify_mobile_coverage.py was green through both, and was correct about what
it measured: both sweepers visit all 33 screens and both declare all 3 kinds.
It asks which screens and which kinds, and a state is neither.

WHY THE FIX IS NOT A PER-STATE `HANDLED`. Enumerating states in a declaration
moves the hole to the next state nobody enumerated, which is exactly how this
class survived five rounds of widening lists. The fix is structural: an
instrument drives tapfloor.sweep, which opens every disclosure and each dialog
on its own, dedupes by DOM path across states, and tags every finding with the
state it was first reachable in. Any consumer of a sweep result therefore has
every kind from every state, or it reads the raw probe and owns a walk this
gate cannot see into, which is now a failure.

THE THREE CONTROL CLASSES, as round 9 established them:

    MUTATIONS   plant a DEFECT in the product, require the gate to FAIL
    BLINDINGS   plant a defect AND weaken the instrument, require it to go
                blind: a PASS with the defect still present is the finding
    NEGATIVES   plant legal code, require SILENCE

Run from the wireframe directory with the preview server up. Reverts on any
exit, including SIGTERM.

    python3 devserver.py 3911 &
    python3 verify_round10_mutation.py http://127.0.0.1:3911/
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

TAPFLOOR = os.path.join(HERE, "tapfloor.py")
FLOW = os.path.join(HERE, "verify_flow.py")
POLISH = os.path.join(HERE, "verify_polish.py")
STAGED = os.path.join(HERE, "staged.html")
# Exactly the files this suite mutates, no more. A path declared here and
# never written to is an exemption for a file nothing touches, which is how a
# real one gets waved through later.
FILES = [TAPFLOOR, FLOW, POLISH, STAGED]

# Every marker this suite writes to disk, for the stray check after the
# revert. `r10plant` appears nowhere else in the tree, so the check cannot
# fire on a document paragraph describing a previous round's plant.
R10_MARKERS = ("r10plant",)


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


def run_flow():
    return run("verify_flow.py", with_url=True)


def run_coverage():
    return run("verify_mobile_coverage.py")


def sub(path, old, new):
    """Replace and PROVE the replacement landed."""
    s = read(path)
    if old not in s:
        raise SystemExit("mutation target not found in %s:\n  %r"
                         % (os.path.basename(path), old[:90]))
    write(path, s.replace(old, new, 1))


# The anchor for a plant that is reachable ONLY once a dialog is open. Chosen
# rather than derived: the assertion is that the gate names staged.html, so a
# fixture picked at run time would leave nothing to expect. See the
# INLINE_WITH_REASON entry in verify_coverage.py.
PAYBAL = '<dialog class="sheet" id="paybal" aria-labelledby="payh">\n'


# ======================================================================
# THE DEFECTS.
#
# A and B are the bug itself: the same element, the same screen, the same law,
# differing only in the state it is reachable in. C and D break the ARRANGEMENT
# that is supposed to stop a seventh shape of this class.
# ======================================================================

def mut_chrome_static_in_dialog():
    """A .chrome element that does not position itself, INSIDE a dialog.

    The round-10 defect exactly. `.chrome` is a promise that the element
    positions itself, and that promise is what licenses base.css's perch lift
    to skip it. An element carrying the class while statically laid out is
    that promise broken, and before this round it was invisible to the gate
    that owns the payment screens whenever it sat inside a sheet.

    Fully inside the viewport on purpose: the contract check fires on POSITION
    alone, so a plant that also overflowed would be caught by the overflow
    check and this control would pass for the wrong reason.
    """
    sub(STAGED, PAYBAL,
        PAYBAL + '  <div class="chrome r10plant" style="position:relative;'
        'left:0;width:120px;height:44px">r10plant</div>\n')


def mut_chrome_static_on_load():
    """The identical element, rendered on load rather than in a dialog.

    The other half of the isolation. This one FAILED before the round-10 fix
    as well, which is what proves the difference between the two controls is
    the state and nothing else: not the element, not the screen, not the law.
    Kept so a later change that quietly narrows the walk back to dialogs only
    cannot pass by fixing the harder case alone.
    """
    sub(STAGED, "</main>",
        '<div class="chrome r10plant" style="position:relative;left:0;'
        'width:120px;height:44px">r10plant</div>\n</main>')


def mut_flow_walks_its_own_states():
    """verify_flow.py goes back to reading the raw probe with its own walk.

    THE GUARANTEE, not the bug. The gate still sweeps all 8 screens, still
    declares all 3 kinds, still prints its table. It simply reads the probe
    itself, which is the shape that let `chrome` be asserted closed and
    dropped everywhere else.

    verify_mobile_coverage.py must fail and NAME the instrument, because the
    thing to act on is "this gate owns a state walk nobody can audit".
    """
    sub(FLOW, "        t = tapfloor.sweep(b, url)",
        "        b.goto(url)\n"
        "        t = __import__('json').loads(b.js(tapfloor.PROBE_JS))\n"
        "        t = {'coarse': t['coarse'], 'docW': t['docW'],\n"
        "             'opened': 0, 'dialogs': [], 'bad': t['bad']}")


def mut_polish_walks_its_own_states():
    """The same defect in the other sweeper.

    Two instruments enforce this law and a check that only looks at one of
    them is the original defect wearing a third hat. Round 9's D and E controls
    made the same point about HANDLED by breaking each sweeper in turn.
    """
    sub(POLISH, "        t = tapfloor.sweep(b, BASE + s)",
        "        b.goto(BASE + s)\n"
        "        t = json.loads(b.js(tapfloor.PROBE_JS))\n"
        "        t = {'coarse': t['coarse'], 'docW': t['docW'],\n"
        "             'opened': 0, 'dialogs': [], 'bad': t['bad']}")


# ======================================================================
# THE BLINDING PAIR: is the shared state walk what CATCHES the dialog defect?
#
#   plant the defect, walk intact    -> gate FAILS, naming the plant
#   plant the defect, walk removed   -> gate PASSES, plant invisible
#
# Both halves are required. If the first does not fail, the walk is not what
# catches it. If the second does not pass, something else catches it and the
# walk is not load-bearing.
# ======================================================================

def weaken_sweep_skips_dialogs():
    """tapfloor.sweep stops opening dialogs.

    A weakening of the INSTRUMENT, so it plants no defect on its own and
    cannot be a fail-expecting control: on a clean tree there is nothing
    inside a dialog to miss. Paired with mut_chrome_static_in_dialog, which
    is visible to no other check in the suite.
    """
    sub(TAPFLOOR, '    out["dialogs"] = json.loads(b.js(DIALOG_IDS_JS))',
        '    out["dialogs"] = []')


# ======================================================================
# THE CONTROLS THAT MUST NOT FIRE.
#
# The walk now opens more states on more screens, so the things it must stay
# quiet about are ordinary patterns the tree already ships inside its sheets.
# The first false failure is when somebody stops reading this gate.
# ======================================================================

def neg_chrome_fixed_in_dialog():
    """A .chrome element inside a dialog that DOES position itself.

    The contract is "this element positions itself", not "this element is
    outside a dialog". Firing here would send somebody rewriting correct CSS,
    and it is the exact false positive the new state coverage could introduce.
    """
    sub(STAGED, PAYBAL,
        PAYBAL + '  <div class="chrome r10plant" style="position:fixed;'
        'left:10px;top:10px;width:100px;height:44px">r10plant</div>\n')


def neg_full_width_sheet_row():
    """A row spanning the sheet's CONTENT width, which is not overflow.

    The first version of this control planted `width: 320px` and was a FALSE
    ALARM, correctly: the sheet has 18px of padding, so a 320px child starts
    at x=18 and ends at 338, which really is 18px off the right edge. The gate
    was right and the control was wrong, which is the thing a negative control
    is for. `width: 100%` is what the tree's own sheet rows use, and it is the
    pattern that must stay quiet.
    """
    sub(STAGED, PAYBAL,
        PAYBAL + '  <div style="position:relative;width:100%;height:20px" '
        'class="r10plant">r10plant</div>\n')


def neg_hidden_subtree_in_open_dialog():
    """An off-screen element inside a hidden subtree inside an OPEN dialog.

    The first version of this control planted the element directly in #decline
    and called it "a dialog that is never opened". That was wrong about the
    instrument: the walk opens EACH dialog alone, #decline included, so the
    plant was reachable and genuinely off-screen and the gate named it. FALSE
    ALARM on my control, not on the gate.

    The real legal case is the round-9 negative one state deeper: the probe's
    reachability walk has to keep working inside a dialog, so a collapsed or
    template subtree in an open sheet stays quiet. Nobody can see it, and
    reporting it is noise that hides the real finding.
    """
    sub(STAGED, PAYBAL,
        PAYBAL + '  <div hidden><div style="position:relative;right:400px;'
        'width:100px;height:40px" class="r10plant">r10plant</div></div>\n')


def neg_tap_target_in_dialog():
    """A control inside a dialog that clears the floor on both axes.

    The walk now measures tap targets in more states on these screens, so a
    legal control in one must stay quiet, or the report fills with noise and
    real findings hide in it.
    """
    sub(STAGED, PAYBAL,
        PAYBAL + '  <button type="button" data-demo="ok" class="r10plant" '
        'style="width:120px;height:48px">r10plant</button>\n')


# name, mutate, the gate that must catch it, the file its output must name,
# a string that output must carry
MUTATIONS = [
    ("A  .chrome breaks its contract INSIDE a dialog", mut_chrome_static_in_dialog,
     run_flow, "staged.html", "r10plant"),
    ("B  the SAME element, visible on load", mut_chrome_static_on_load,
     run_flow, "staged.html", "r10plant"),
    ("C  the payment sweeper owns its state walk", mut_flow_walks_its_own_states,
     run_coverage, "verify_flow.py", "tapfloor.PROBE_JS"),
    ("D  the general sweeper owns its state walk", mut_polish_walks_its_own_states,
     run_coverage, "verify_polish.py", "tapfloor.PROBE_JS"),
]

# (name, weaken, plant, gate, marker the gate must name when the walk is intact)
BLINDINGS = [
    ("E  the dialog leg of the walk is load-bearing", weaken_sweep_skips_dialogs,
     mut_chrome_static_in_dialog, run_flow, "r10plant"),
]

NEGATIVES = [
    ("N1 .chrome positioning itself inside a dialog", neg_chrome_fixed_in_dialog,
     run_flow, "the contract is that it positions itself, not where it sits"),
    ("N2 a row as wide as the sheet's content box", neg_full_width_sheet_row,
     run_flow, "an element filling the sheet is correct; only 320px plus the "
     "sheet's own padding overflows, and that really is a defect"),
    ("N3 a hidden subtree inside an OPEN dialog", neg_hidden_subtree_in_open_dialog,
     run_flow, "reachability has to keep working one state deeper: nobody can "
     "see it, and reporting it hides the real finding"),
    ("N4 a 120x48 control inside a dialog", neg_tap_target_in_dialog,
     run_flow, "it clears the floor on both axes"),
]


def main():
    before = digest(FILES)
    saved = dict((p, read(p)) for p in FILES)

    mutationsafe.guard(FILES)

    def restore():
        for p, s in saved.items():
            write(p, s)

    mutationsafe.acquire(FILES, restore=restore)

    print("=" * 78)
    print("verify_round10_mutation.py   tree %s   %s" % (before, BASE))
    print("=" * 78)
    print("A and B are one element on one screen in two states, which is the")
    print("whole finding: before this round the gate could see it on load and")
    print("not inside the sheet. C and D break the arrangement that stops the")
    print("seventh shape, and each must fail NAMING the instrument.")
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
            # Half 1: the defect alone. The gate must SEE it, or this leg of
            # the walk was never what caught it and the pair proves nothing.
            plant()
            code_a, out_a = gate()
            named = [l.strip() for l in out_a.splitlines() if marker in l]
            for p, s in saved.items():
                write(p, s)

            # Half 2: the same defect with the dialog leg removed. A PASS here
            # is the finding: the instrument has gone blind to a defect that is
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
                           "the walk INTACT (exit %d), so this leg is not what "
                           "catches it" % code_a))
                print("  NOT BEARING  %-41s intact exit %d" % (name, code_a))
            else:
                not_bearing.append(
                    (name, "the gate still failed with the leg removed "
                           "(exit %d), so something else catches this and the "
                           "leg is not load-bearing" % code_b))
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
                       if "r10plant" in l]
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
    for marker in R10_MARKERS:
        for p in FILES:
            if marker in read(p):
                strays.append("%s in %s" % (marker, os.path.basename(p)))
    if strays:
        print("STRAY MUTATION MARKERS LEFT ON DISK:")
        for s in strays:
            print("   " + s)

    print("\nre-running both gates on the reverted tree:")
    ccode, cout = run_coverage()
    fcode, fout = run_flow()
    for label, code in (("verify_mobile_coverage.py", ccode),
                        ("verify_flow.py", fcode)):
        print("  %-26s exit %d  %s"
              % (label, code, "PASS" if code == 0 else "FAIL"))
    for line in cout.splitlines():
        if line.startswith("PASS"):
            print("    %s" % line.strip()[:92])

    ok = (not missed and not wrong_reason and not false_alarm
          and not not_bearing and not strays
          and after == before and ccode == 0 and fcode == 0)
    print()
    if ok:
        print("MUTATION TEST PASSED: %d of %d defects caught, %d of %d walks "
              "proved load-bearing," % (caught, len(MUTATIONS),
                                        load_bearing, len(BLINDINGS)))
        print("%d of %d legal patterns left alone, tree reverted clean, both "
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
