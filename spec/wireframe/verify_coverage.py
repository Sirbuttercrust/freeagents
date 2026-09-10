#!/usr/bin/env python3
"""No gate may name its own screens. The scope of every assertion is derived.

WHY THIS GATE EXISTS

Four review rounds found the same defect wearing four different shapes, and
the fourth is the reason this file is here:

  round 1  a probe read one axis            AXIS-blind      13 real failures
  round 2  a probe read `a,button` only     SELECTOR-blind  12 real failures
  round 3  no probe opened a drawer         STATE-blind     12 real failures
  round 4  verify_ink.py named 8 screens    SCOPE-blind     25 screens never
                                                            measured at all

Each time, the fix landed on the instance the reviewer named. Each time, the
same defect was already sitting somewhere else in the tree wearing different
clothes, and the next round found it.

Round 4's fix could have been "add twenty-five names to that list". That
would have been the same mistake again, because the defect is not the length
of the list. It is that a LIST cannot fail. A screen added next month is not
in it, and the gate table goes on asserting a property of the whole set while
the new screen has never been opened.

WHAT THIS CHECKS

`population.py` provides the derivations. This gate makes using them
compulsory: every gate's SCREENS must be computed at run time from the
directory, never written as a literal list of file names.

The one thing that made round 4 invisible was that a narrow scope and a
correct scope produce identical output. `verify_mobile_coverage.py` already
closes that hole for the 320px sweep. This closes it for every gate at once,
including gates nobody has written yet.

No browser and no server: this reads source.

    python3 verify_coverage.py
"""

import ast
import glob
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import population                                             # noqa: E402

# Files that are instruments rather than gates. The mutation suites carry
# lists of the exact screens they plant a control in, which is the point of
# them: a mutation is aimed at one known place.
NOT_GATES = {
    "verify_all.py": "the runner, it has a gate list rather than a screen list",
    "verify_coverage.py": "this file",
    "verify_flow_mutation.py": "a mutation suite: it names the screen it plants in",
    "verify_round2_mutation.py": "a mutation suite: it names the screen it plants in",
    "verify_round3_mutation.py": "a mutation suite: it names the screen it plants in",
    "verify_contrast.py": "superseded, exits 2",
}

# A gate may name screens ONLY where the name carries a reason that a
# derivation cannot express, and the reason has to be here where a reviewer
# reads it rather than in a comment nobody opens.
#
# THE DISTINCTION THAT MATTERS: a SCOPE decision (which screens does this
# assertion apply to) must be derived, because a name silently omits a screen
# added later. A SEMANTIC map (what does this particular page mean) is a fact
# about that page and cannot be derived from the directory at all. An
# exemption belongs here; a population never does.
NAMED_WITH_REASON = {
    ("verify_polish.py", "SUPERSEDED"):
        "criteria.html and confirm.html are retired pages kept so an old "
        "link lands somewhere honest. Their controls are inert BECAUSE they "
        "are retired, so the live-control audit skips them by name. They are "
        "still swept for polish, contrast and 320px like every other screen.",
    ("population.py", "FLOW_LAYOUT_IN_PAGE"):
        "hire.html and agreement.html carry the payment flow's layout in a "
        "page-local style block rather than in flow.css, so a stylesheet "
        "derivation alone under-counts the flow by exactly these two.",
    ("verify_linknames.py", "IDENTITY"):
        "a MAP, not a population: which selector on each destination page "
        "holds the name that page calls itself. Only a profile page has one, "
        "and which element carries it is a fact about that page's markup.",
    ("verify_linknames.py", "EXCUSED"):
        "conduct.html shows one account acting as BOTH buyer and operator, "
        "which is that screen's subject. An exemption is a judgement about "
        "one page and has to be written down where it can be argued with.",
    ("verify_sitemap.py", "SUPERSEDED"):
        "confirm.html and criteria.html carry a visible replaced-by banner "
        "and are excluded from the reachability sweep on purpose. Which "
        "pages are retired is a design decision, not a property of the "
        "directory.",
}


def _is_screen(v):
    """A real screen NAME, not the string '.html'.

    An extension constant is a file-type test, not a scope decision, and
    calling one a named screen list is the kind of noise that gets a gate
    switched off. The name has to be a file that exists.
    """
    return isinstance(v, str) and v.endswith(".html") and len(v) > len(".html")


def literal_lists(path):
    """Module-level assignments whose value is a literal list of .html names."""
    tree = ast.parse(open(path, encoding="utf-8").read())
    out = []
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if not isinstance(target, ast.Name):
                continue
            try:
                val = ast.literal_eval(node.value)
            except Exception:
                continue                       # computed, which is the point
            names = []
            if isinstance(val, (list, tuple, set)):
                names = [v for v in val if _is_screen(v)]
            elif isinstance(val, dict):
                names = [k for k in val if _is_screen(k)]
            if names:
                out.append((target.id, names, node.lineno))
    return out


def main():
    on_disk = population.every_screen()
    gates = sorted(os.path.basename(p)
                   for p in glob.glob(os.path.join(HERE, "verify_*.py")))

    fails, rows, excused = [], [], []
    for name in gates:
        if name in NOT_GATES:
            continue
        for var, names, lineno in literal_lists(os.path.join(HERE, name)):
            key = (name, var)
            if key in NAMED_WITH_REASON:
                excused.append((name, var, len(names)))
                continue
            fails.append(
                "%s:%d  %s is a literal list of %d screen name(s).\n"
                "      %s\n"
                "      Derive it: population.every_screen(), "
                "population.screens_with_source(...), or add it to\n"
                "      NAMED_WITH_REASON in this file WITH the reason."
                % (name, lineno, var, len(names), " ".join(names[:6])
                   + (" ..." if len(names) > 6 else "")))

    # And the derivations themselves have to still cover the directory. A
    # partition that drifts is the same hole arriving by another road.
    pay = set(population.payment_screens())
    gen = set(population.general_screens())
    if pay | gen != set(on_disk):
        missing = sorted(set(on_disk) - (pay | gen))
        fails.append("population's partition misses %d screen(s): %s"
                     % (len(missing), " ".join(missing)))
    if pay & gen:
        fails.append("population's partition overlaps: %s"
                     % " ".join(sorted(pay & gen)))

    # WF_ONLY exists so the mutation suite can plant a defect on one screen
    # and see it without paying for a 33-screen sweep. It is also a switch
    # that silently narrows a gate, which is this round's defect with a
    # different name, so it is refused anywhere except a mutation run.
    if os.environ.get("WF_ONLY"):
        fails.append(
            "WF_ONLY is set (%r). That narrows a gate's scope to named "
            "screens, which is exactly what this gate forbids. It is for "
            "the mutation suite only." % os.environ["WF_ONLY"])

    for name in gates:
        if name in NOT_GATES:
            continue
        src = open(os.path.join(HERE, name), encoding="utf-8").read()
        if "population." in src:
            how = "derived (population)"
        elif "glob(" in src and "*.html" in src:
            # Correct, and reported distinctly rather than as "no SCREENS":
            # a gate that globs the directory itself has the right property
            # already. Naming it that way stops a reader assuming the row is
            # a gap and stops the row hiding one.
            how = "derived (own glob)"
        elif "SCREENS" in src:
            how = "SCREENS present, NOT derived"
            fails.append("%s has a SCREENS binding that is neither derived "
                         "from population.py nor a directory glob." % name)
        else:
            how = "no screen loop"
        rows.append((name, how))

    print("=" * 78)
    print("verify_coverage.py  every gate's scope is derived, never named")
    print("=" * 78)
    print()
    print("%-30s %s" % ("gate", "screen population"))
    print("-" * 56)
    for name, how in rows:
        print("%-30s %s" % (name, how))

    print()
    print("html files on disk:      %d" % len(on_disk))
    print("payment screens:         %d  (loads flow.css, or named with a reason)"
          % len(pay))
    print("general screens:         %d  (the COMPLEMENT, so a new screen is"
          % len(gen))
    print("%-24s     swept by default rather than forgotten)" % "")
    if excused:
        print()
        print("named by hand, each with its reason recorded in this file:")
        for name, var, n in excused:
            print("  %s %s (%d)" % (name, var, n))

    if fails:
        print()
        # The header used to say "N gate(s) name their own screens" for every
        # entry in this list, including the partition failures, which made a
        # correctly-caught partition break read as a naming violation. A
        # failure message that misnames the failure sends the next reader to
        # the wrong file.
        print("FAIL: %d scope problem(s)." % len(fails))
        for f in fails:
            print("  " + f)
        print()
        print("A list of names cannot fail on a screen it does not mention.")
        print("That is how twenty-five screens went unmeasured against a rule")
        print("three documents asserted of all of them.")
        return 1

    print()
    print("PASS: no gate carries a literal screen list, and the population")
    print("      derivations cover the directory exactly once.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
