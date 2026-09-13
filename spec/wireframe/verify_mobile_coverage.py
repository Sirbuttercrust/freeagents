#!/usr/bin/env python3
"""Is every screen on disk swept at 320px, and swept with the SAME assertions?

WHY THIS EXISTS.

The card for this work asks for "mobile 320px with every open state, 44px
targets, no horizontal overflow, on all 33 screens". Two instruments do that
sweep: verify_flow.py walks the payment screens and opens every dialog,
verify_polish.py walks the rest on a real touch profile. Between them they
should cover the directory.

"Should" is the problem. A screen added later can be covered by neither, and
nothing fails, because an instrument that does not mention a file cannot fail
on it. That is the same class of defect as a gate documented but never run,
which verify_all.py already checks for in the other direction.

HOW THE POPULATION IS READ, AND WHY IT CHANGED IN ROUND 4

The first version read each instrument's SOURCE for quoted `foo.html`
strings. That worked while the instruments carried literal lists, and it
stopped working the moment they stopped: round 4 replaced every hardcoded
list with a derivation, so there were no names left in the source to scrape
and this gate reported 31 uncovered screens on a tree where all 33 are swept.

A source scrape was always the wrong instrument for the question. It measures
what a file SAYS, and the question is what a file DOES.

Importing the sweepers is not an option: both run their whole sweep at module
level, so an import launches Chrome and takes minutes. So this parses each
one, finds its SCREENS assignment, and EVALUATES that expression against
`population` with nothing else in scope. A literal list, a glob, or a
derivation all give their real value, and an expression reaching for anything
outside `population` fails loudly rather than guessing.

AND WHY IT CHANGED AGAIN IN ROUND 5: COUNTING SCREENS IS NOT COVERAGE

Round 5 of review found the element-level overflow check running on 8 of the
33 screens. The other 25 were swept by verify_polish.py, which asserted only
`document.documentElement.scrollWidth > 320`, and scrollWidth DOES NOT GROW
for an element hanging off the LEFT edge in an LTR document. So on 25 screens
nothing could fail on left-side overflow at any magnitude, and two screens
were shipping the builder-notes control at x=-20.

THIS GATE WAS GREEN THROUGHOUT, AND IT WAS CORRECT ABOUT WHAT IT MEASURED.
Both instruments really did visit all 33 screens between them. It asked which
SCREENS each one visits and never which ASSERTIONS each one makes, so a screen
swept by the weaker of two instruments read as covered. A count of names cannot
see that, which is why the same class of defect has now been found five times.

So the question this gate asks is now two questions:

  1. is every screen on disk visited by some sweeper           (round 4)
  2. does every sweeper consume every assertion the shared      (round 5)
     probe makes, so a visit means the same thing everywhere

Question 2 is answered against tapfloor.KINDS, which is the probe's own
declaration of what it measures. A sweeper must either handle every kind or
name the ones it drops in a HANDLED tuple this gate can read, and a kind in
neither place is reported. That makes an omission WRITTEN DOWN and auditable
instead of invisible, and it makes the safe direction the default: add a kind
to the shared probe, and every sweeper that has not been taught about it fails
here rather than quietly ignoring it.

No browser and no server needed.

    python3 verify_mobile_coverage.py
"""

import ast
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import population                                             # noqa: E402
import tapfloor                                               # noqa: E402

# The instruments that actually resize to 320px, set a touch profile, and
# assert on scrollWidth and tap-target size. A file that merely mentions a
# page name does not count, which is why these two are named explicitly.
SWEEPERS = ["verify_flow.py", "verify_polish.py"]


def screens_of(path):
    """The screens an instrument will actually visit.

    The SCREENS expression is evaluated with only `population` in scope, so a
    derivation gives its real value and anything reaching further afield
    raises rather than returning a plausible wrong answer.
    """
    tree = ast.parse(open(path, encoding="utf-8").read())
    expr = None
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "SCREENS"
                for t in node.targets):
            expr = node.value
    if expr is None:
        raise RuntimeError("no module-level SCREENS assignment")
    value = eval(compile(ast.Expression(expr), "<SCREENS>", "eval"),
                 {"__builtins__": {"sorted": sorted, "set": set,
                                   "list": list}},
                 {"population": population})
    return set(value)


def handled_of(path):
    """The finding kinds an instrument actually consumes.

    Read the same way SCREENS is: from the module-level HANDLED assignment,
    evaluated rather than pattern-matched, so a tuple built from
    tapfloor.KINDS gives its real value.

    A sweeper with no HANDLED binding is not given the benefit of the doubt.
    It returns None, and main() reports it as a sweeper whose assertion set
    cannot be determined, which is the honest answer and fails.
    """
    tree = ast.parse(open(path, encoding="utf-8").read())
    expr = None
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "HANDLED"
                for t in node.targets):
            expr = node.value
    if expr is None:
        return None
    value = eval(compile(ast.Expression(expr), "<HANDLED>", "eval"),
                 {"__builtins__": {"sorted": sorted, "set": set,
                                   "list": list, "tuple": tuple}},
                 {"tapfloor": tapfloor})
    return set(value)


def probe_kinds():
    """The kinds the shared probe can actually EMIT, read out of its source.

    tapfloor.KINDS is a declaration, and a declaration that nothing checks is
    how this class of defect keeps happening. The probe's JavaScript is the
    implementation, so the two are compared: a kind declared but never pushed
    is a coverage claim nothing backs, and a kind pushed but never declared is
    an assertion no sweeper will be told to handle.
    """
    src = tapfloor._PROBE_TEMPLATE
    out = set()
    for piece in src.split("kind: '")[1:]:
        out.add(piece.split("'")[0])
    return out


def main():
    on_disk = set(population.every_screen())

    covered = set()
    per_sweeper = {}
    handled = {}
    for name in SWEEPERS:
        path = os.path.join(HERE, name)
        if not os.path.exists(path):
            print("FAIL %s is missing from disk, so its sweep does not happen" % name)
            return 1
        try:
            found = screens_of(path) & on_disk
        except Exception as exc:                              # noqa: BLE001
            print("FAIL could not determine what %s sweeps: %s: %s"
                  % (name, type(exc).__name__, exc))
            return 1
        per_sweeper[name] = found
        covered |= found
        try:
            handled[name] = handled_of(path)
        except Exception as exc:                              # noqa: BLE001
            print("FAIL could not determine what %s asserts: %s: %s"
                  % (name, type(exc).__name__, exc))
            return 1

    declared = set(tapfloor.KINDS)
    emitted = probe_kinds()

    print("%-26s %-12s %s" % ("instrument", "screens", "assertions consumed"))
    print("-" * 72)
    for name in SWEEPERS:
        h = handled[name]
        print("%-26s %-12d %s"
              % (name, len(per_sweeper[name]),
                 "NONE DECLARED" if h is None else " ".join(sorted(h))))
    print("%-26s %-12d %s" % ("union", len(covered), ""))
    print("%-26s %-12d" % ("html files on disk", len(on_disk)))
    print("%-26s %-12s %s" % ("shared probe declares", "", " ".join(sorted(declared))))
    print("%-26s %-12s %s" % ("shared probe emits", "", " ".join(sorted(emitted))))

    fails = []

    missing = sorted(on_disk - covered)
    if missing:
        print("\nFAIL: %d screen(s) are in the directory and in no 320px sweep:"
              % len(missing))
        for m in missing:
            print("  " + m)
        print("\nA screen no instrument opens at 320px is a screen nobody")
        print("checked on a phone. The two sweeps are meant to partition the")
        print("directory: see population.py, where the general sweep is the")
        print("COMPLEMENT of the payment one for exactly this reason.")
        fails.append("screens in no sweep")

    # THE PROBE'S DECLARATION AGAINST THE PROBE'S CODE. Both directions.
    if declared != emitted:
        print("\nFAIL: tapfloor.KINDS and the probe disagree about what it measures:")
        for k in sorted(declared - emitted):
            print("  %-12s declared in KINDS, never pushed by the probe" % k)
        for k in sorted(emitted - declared):
            print("  %-12s pushed by the probe, not declared in KINDS" % k)
        fails.append("probe declaration out of step with the probe")

    # AND EVERY SWEEPER AGAINST THAT DECLARATION. This is the round-5 check:
    # two instruments visiting the same screen must make the same assertions,
    # or "covered" means two different things on two halves of the directory.
    for name in SWEEPERS:
        h = handled[name]
        if h is None:
            print("\nFAIL: %s declares no HANDLED, so what it asserts on the "
                  "%d screens it sweeps cannot be determined."
                  % (name, len(per_sweeper[name])))
            print("A sweeper states which finding kinds it consumes, so a kind")
            print("it drops is written down rather than invisible.")
            fails.append("%s has no HANDLED" % name)
            continue
        dropped = declared - h
        if dropped:
            print("\nFAIL: %s sweeps %d screens without asserting: %s"
                  % (name, len(per_sweeper[name]), " ".join(sorted(dropped))))
            print("Those screens are visited but not measured against that")
            print("law, which is how 25 screens went unchecked for left-edge")
            print("overflow while this gate reported full coverage.")
            fails.append("%s drops %s" % (name, ",".join(sorted(dropped))))
        unknown = h - declared
        if unknown:
            print("\nFAIL: %s claims to handle a kind the probe does not emit: %s"
                  % (name, " ".join(sorted(unknown))))
            fails.append("%s handles a phantom kind" % name)

    if fails:
        return 1

    overlap = per_sweeper[SWEEPERS[0]] & per_sweeper[SWEEPERS[1]]
    if overlap:
        print("\nNOTE: %d screen(s) swept twice: %s"
              % (len(overlap), " ".join(sorted(overlap))))

    print("\nPASS  all %d screens are swept at 320px, and every sweeper "
          "consumes all %d assertions (%s)."
          % (len(on_disk), len(declared), " ".join(sorted(declared))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
