#!/usr/bin/env python3
"""verify_round4_mutation.py - prove the round-4 fixes catch their defects.

Round 4's defect was SCOPE: verify_ink.py named eight screens while three
documents asserted AA of all thirty-three, and the twenty-five it never
opened were invisible from a green table. Widening that one list would have
been the same mistake the previous three rounds made, so the fix was
structural: population.py derives every gate's scope from the directory and
verify_coverage.py fails any gate that goes back to naming its screens.

A gate written after a fix has never once seen the defect it claims to
catch. Green on a fixed tree proves the assertion runs, not that it
discriminates. So each fix is mutated back here and asserted to FAIL.

The mutations:

  A  verify_ink.py's SCREENS re-narrowed to a literal list     verify_coverage
  B  a new screen added to the directory and named nowhere     verify_coverage
  C  population's partition made to overlap                    verify_coverage
  D  the evidence separator restored to a hairline "|" glyph   verify_ink
  E  verify_ink's ancestor-opacity check removed               verify_ink
  F  verify_ink's edge inset removed                           verify_ink

D through F are the three real instrument bugs this round found, each
mutated back to the exact shape it had when it was producing wrong numbers.

B is the one that matters most, because it is the defect rather than an
instance of it: a screen that exists and that no gate has ever opened. Under
the old arrangement nothing failed. Here the coverage gate names it.

Every mutation is reverted from a copy held in memory, in a finally block,
and the tree is verified byte-identical at the end.

    python3 devserver.py 3111 &
    python3 verify_round4_mutation.py http://127.0.0.1:3111
"""

import hashlib
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3111"
sys.path.insert(0, HERE)

# The kill-lock and the dirty-tree warning, shared with the other suites.
import mutationsafe                                           # noqa: E402

INK = os.path.join(HERE, "verify_ink.py")
POP = os.path.join(HERE, "population.py")
MARKET = os.path.join(HERE, "market.css")
BROWSE = os.path.join(HERE, "browse.html")

FILES = [INK, POP, MARKET, BROWSE]

# A screen that exists on disk and is named in no gate. Created and deleted
# by mutation B rather than being a permanent file, because a screen nobody
# measures is exactly the thing this suite exists to forbid.
GHOST = os.path.join(HERE, "zz_ghost_screen.html")
GHOST_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ghost: FreeAgents</title>
<link rel="stylesheet" href="base.css">
<link rel="stylesheet" href="polish.css">
</head>
<body>
<main class="wrap section"><h1>Planted by verify_round4_mutation.py</h1></main>
</body>
</html>
"""


def read(p):
    with open(p, encoding="utf-8") as fh:
        return fh.read()


def write(p, text):
    with open(p, "w", encoding="utf-8") as fh:
        fh.write(text)


def digest(paths):
    h = hashlib.sha1()
    for p in sorted(paths):
        h.update(read(p).encode())
    return h.hexdigest()[:12]


def run_gate(script, screens=None):
    """Run one gate. WF_BASE for the polished ones, argv for the rest.

    WF_ONLY is set only when `screens` is given, and only verify_ink reads
    it. verify_coverage refuses to run with it set, on purpose, so it is
    never passed there.
    """
    env = dict(os.environ)
    env["WF_BASE"] = BASE if BASE.endswith("/") else BASE + "/"
    env.pop("WF_ONLY", None)
    if screens:
        env["WF_ONLY"] = ",".join(screens)
    r = subprocess.run([sys.executable, os.path.join(HERE, script), BASE],
                       capture_output=True, text=True, cwd=HERE, env=env)
    return r.returncode, r.stdout


def sub_once(path, old, new):
    text = read(path)
    if old not in text:
        raise AssertionError("mutation target not found in %s: %r"
                             % (os.path.basename(path), old[:70]))
    write(path, text.replace(old, new, 1))


# ------------------------------------------------------------- the mutations

def mut_a():
    """Re-narrow verify_ink to a literal list. The round-4 defect itself."""
    sub_once(INK, "SCREENS = population.every_screen()",
             'SCREENS = ["hire.html", "agreement.html", "deposit.html",\n'
             '           "staged.html", "pullrequest.html", "outcomes.html",\n'
             '           "operatorjob.html", "conduct.html"]')


def mut_b():
    """A screen on disk that no gate has ever opened."""
    write(GHOST, GHOST_HTML)


def mut_c():
    """Break the partition: the general sweep stops being the complement."""
    sub_once(POP, "return sorted(set(every_screen()) - set(payment_screens()))",
             "return sorted(set(every_screen()) - set(payment_screens())\n"
             "                  - {'browse.html'})")


def mut_d():
    """Put the hairline glyph back. The real D12 defect, verbatim."""
    sub_once(MARKET,
             ".acard-ev .sep {\n  width: 1px; height: 11px; flex: none;\n"
             "  background: var(--line-2);\n  border-radius: 1px;\n}",
             ".acard-ev .sep { color: var(--line-2); }")
    sub_once(BROWSE, '<span class="sep" aria-hidden="true"></span>',
             '<span class="sep">|</span>')


def mut_e():
    """Remove the ancestor-opacity check. Round 4's twelve wrong numbers."""
    sub_once(INK,
             "      var po = parseFloat(getComputedStyle(p).opacity);\n"
             "      if (!isNaN(po) && po < 0.05) { hidden = true; break; }",
             "      /* removed by mutation */")


def mut_f():
    """Remove the edge inset. The pane-rim false failure."""
    sub_once(INK, '    inset = 2.0 if it["w"] >= 6 else it["w"] / 2.0',
             '    inset = 1.0')


# name, the gate that must fail, the mutation, the screens to limit it to
MUTATIONS = [
    ("A  verify_ink SCREENS re-narrowed to 8 names", "verify_coverage.py",
     mut_a, None),
    ("B  a screen on disk that no gate opens", "verify_coverage.py",
     mut_b, None),
    ("C  population's partition made to overlap", "verify_coverage.py",
     mut_c, None),
    ("D  the separator restored to a hairline glyph", "verify_ink.py",
     mut_d, ["browse.html"]),
    ("E  verify_ink's ancestor-opacity check removed", "verify_ink.py",
     mut_e, ["browse.html"]),
    ("F  verify_ink's edge inset removed", "verify_ink.py",
     mut_f, ["agreement.html"]),
]


def main():
    before = digest(FILES)
    saved = dict((p, read(p)) for p in FILES)

    mutationsafe.guard(FILES)
    mutationsafe.acquire(FILES)

    print("=" * 78)
    print("verify_round4_mutation.py   tree %s" % before)
    print("=" * 78)
    print("Each fix is reverted, the gate run, and asserted to FAIL. A gate")
    print("that stays green here has never seen the bug it claims to catch.")
    print()

    caught, missed = 0, []
    try:
        for name, gate, mutate, only in MUTATIONS:
            mutate()
            code, out = run_gate(gate, only)
            # restore before judging, so a raised assertion cannot strand it
            for p, text in saved.items():
                write(p, text)
            if os.path.exists(GHOST):
                os.unlink(GHOST)

            if code == 3:
                print("  SKIP  %-46s (no browser)" % name)
                return 3
            hit = code == 1
            print("  %-6s %-46s %-22s exit %d"
                  % ("CAUGHT" if hit else "MISSED", name, gate, code))
            if hit:
                # the line that names the finding, so the proof is legible
                for line in out.splitlines():
                    if line.strip().startswith(("FAIL", "  verify_ink.py:",
                                                "  browse.html", "  agreement",
                                                "  zz_ghost")):
                        print("           %s" % line.strip()[:96])
                        break
                caught += 1
            else:
                missed.append(name)
    finally:
        for p, text in saved.items():
            write(p, text)
        if os.path.exists(GHOST):
            os.unlink(GHOST)
        mutationsafe.release()

    after = digest(FILES)
    print("\n" + "-" * 78)
    print("tree after revert: %s  %s"
          % (after, "IDENTICAL" if after == before else "DIFFERS, INVESTIGATE"))
    # A planted FILE is invisible to a digest of the files the suite edits, so
    # its absence is checked by name as well.
    print("planted screen left behind: %s"
          % ("zz_ghost_screen.html" if os.path.exists(GHOST) else "none"))

    if after != before or os.path.exists(GHOST):
        print("FAIL: the tree was not restored.")
        return 1

    print("\nre-running both gates on the reverted tree:")
    ok = True
    for gate in ("verify_coverage.py", "verify_ink.py"):
        code, _ = run_gate(gate)
        print("  %-24s exit %d  %s" % (gate, code, "PASS" if code == 0 else "FAIL"))
        ok = ok and code == 0

    if missed or not ok:
        print("\nMUTATION TEST FAILED: %d of %d caught%s"
              % (caught, len(MUTATIONS),
                 "" if ok else ", and a gate does not pass clean"))
        for m in missed:
            print("  missed: %s" % m)
        return 1

    print("\nMUTATION TEST PASSED: %d of %d mutations caught, tree reverted"
          % (caught, len(MUTATIONS)))
    print("clean, both gates green on the restored tree.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
