#!/usr/bin/env python3
"""Positive controls for round 5's addition to verify_coverage.py.

A gate written after a fix has never seen the defect it claims to catch, so
each control below re-creates the round-5 defect in the exact shape it shipped
in, asserts verify_coverage FAILS naming that file, reverts, and asserts PASS.

Run from the wireframe directory. Reverts on any exit, including SIGTERM.
"""
import hashlib
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import mutationsafe                                           # noqa: E402

RAIL = os.path.join(HERE, "verify_rail.py")
PICKERS = os.path.join(HERE, "verify_pickers.py")
FLOWMO = os.path.join(HERE, "verify_flow_motion.py")
FILES = [RAIL, PICKERS, FLOWMO]


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


def run_coverage():
    p = subprocess.run([sys.executable, os.path.join(HERE, "verify_coverage.py")],
                       capture_output=True, text=True, cwd=HERE)
    return p.returncode, p.stdout + p.stderr


# Each mutation restores the pre-round-5 code exactly: the population line is
# replaced by the hardcoded page the gate used to carry.
def mut_rail():
    s = read(RAIL)
    s = s.replace('SCREENS = population.screens_with_source("rail-usdc")',
                  'SCREENS = ["deposit.html"]')
    write(RAIL, s)


def mut_rail_inline():
    """The harder shape: no list at all, the page written into the goto."""
    s = read(RAIL)
    s = s.replace('SCREENS = population.screens_with_source("rail-usdc")',
                  'SCREENS = population.screens_with_source("rail-usdc")\n'
                  '_OLD = "/deposit.html"')
    write(RAIL, s)


def mut_pickers_tuples():
    """Round 5's actual shape: screen names inside TUPLES in a list."""
    s = read(PICKERS)
    s = s.replace('PICKER_SCREENS = population.screens_with_source(\'class="picker"\')',
                  'PICKER_SCREENS = [("staged.html", "#redo .picker li"),\n'
                  '                  ("pullrequest.html", "#closepr .picker li")]')
    write(PICKERS, s)


def mut_flowmo_url():
    s = read(FLOWMO)
    s = s.replace('SCREENS = population.screens_with_source("flow-spark")',
                  'SCREENS = population.screens_with_source("flow-spark")\n'
                  'URL = BASE + "dashboard.html"')
    write(FLOWMO, s)


MUTATIONS = [
    ("A  verify_rail SCREENS back to a literal list", mut_rail,
     "verify_rail.py", "literal list"),
    ("B  verify_rail's page back inline, no list at all", mut_rail_inline,
     "verify_rail.py", "inline"),
    ("C  verify_pickers back to a list of TUPLES", mut_pickers_tuples,
     "verify_pickers.py", "literal list"),
    ("D  verify_flow_motion's page back in a URL constant", mut_flowmo_url,
     "verify_flow_motion.py", "inline"),
]


def main():
    before = digest(FILES)
    saved = dict((p, read(p)) for p in FILES)

    mutationsafe.guard(FILES)
    mutationsafe.acquire(FILES)

    print("=" * 78)
    print("verify_round5_mutation.py   tree %s" % before)
    print("=" * 78)
    print("Each round-5 fix is reverted to the exact shape it shipped in, and")
    print("verify_coverage is asserted to FAIL naming that file for the right")
    print("reason. A gate green here has never seen the bug it claims to catch.")
    print()

    caught, missed, wrong_reason = 0, [], []
    try:
        for name, mutate, gate_file, expect in MUTATIONS:
            mutate()
            code, out = run_coverage()
            # The failure must name the mutated FILE and the right kind of
            # scope problem. Exit 1 alone proves nothing: an unrelated check
            # could be failing, which is how a mutation passes for the wrong
            # reason and nobody notices.
            named = gate_file in out
            reasoned = expect in out
            if code != 0 and named and reasoned:
                caught += 1
                line = [l.strip() for l in out.splitlines()
                        if gate_file in l and ("names" in l or "literal" in l)]
                print("  CAUGHT %-46s exit %d" % (name, code))
                print("         %s" % (line[0][:96] if line else "(named)"))
            elif code != 0 and named:
                wrong_reason.append((name, "failed on %s but not for %r"
                                     % (gate_file, expect)))
                print("  WRONG REASON %-40s exit %d" % (name, code))
            elif code != 0:
                wrong_reason.append((name, "failed but never named %s"
                                     % gate_file))
                print("  WRONG REASON %-40s exit %d" % (name, code))
            else:
                missed.append(name)
                print("  MISSED %-46s exit %d" % (name, code))
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

    print("\nre-running verify_coverage on the reverted tree:")
    code, _ = run_coverage()
    print("  verify_coverage.py       exit %d  %s"
          % (code, "PASS" if code == 0 else "FAIL"))

    ok = (not missed and not wrong_reason and after == before and code == 0)
    print()
    if ok:
        print("MUTATION TEST PASSED: %d of %d mutations caught, each naming the"
              % (caught, len(MUTATIONS)))
        print("file and the reason, tree reverted clean, the gate green after.")
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
