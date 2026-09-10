#!/usr/bin/env python3
"""Is every screen on disk actually swept at 320px by something?

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

No browser and no server needed.

    python3 verify_mobile_coverage.py
"""

import ast
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import population                                             # noqa: E402

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


def main():
    on_disk = set(population.every_screen())

    covered = set()
    per_sweeper = {}
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

    print("%-26s %s" % ("instrument", "screens swept at 320px"))
    print("-" * 52)
    for name in SWEEPERS:
        print("%-26s %d" % (name, len(per_sweeper[name])))
    print("%-26s %d" % ("union", len(covered)))
    print("%-26s %d" % ("html files on disk", len(on_disk)))

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
        return 1

    overlap = per_sweeper[SWEEPERS[0]] & per_sweeper[SWEEPERS[1]]
    if overlap:
        print("\nNOTE: %d screen(s) swept twice: %s"
              % (len(overlap), " ".join(sorted(overlap))))

    print("\nPASS  all %d screens are swept at 320px by at least one instrument."
          % len(on_disk))
    return 0


if __name__ == "__main__":
    sys.exit(main())
