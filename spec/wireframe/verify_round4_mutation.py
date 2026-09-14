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
  B  a new screen added to the directory and named nowhere     verify_sitemap
  C  population's partition made to overlap                    verify_coverage
  D  the evidence separator restored to a hairline "|" glyph   verify_ink
  E  verify_ink's scroll-in reveal removed                     verify_ink
  F  verify_ink's edge inset removed                           verify_ink

D through F are the three real instrument bugs this round found, each
mutated back to the exact shape it had when it was producing wrong numbers.

B is the one that matters most, because it is the defect rather than an
instance of it: a screen that exists and that nothing accounts for. It is
aimed at verify_sitemap rather than verify_coverage on purpose, and the
reason is worth reading. Under the derived arrangement the planted screen is
swept AUTOMATICALLY, because the general 320px population is the complement
of the payment one, so the coverage gates correctly report 34 of 34 and pass.
That is the fix working, not a hole. What still has to fail is the claim that
every served page is accounted for, and that is verify_sitemap's job.

The first version of this suite pointed B at verify_coverage and recorded a
MISS. The gate was right and the assertion was wrong.

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
    """Break the partition: the general sweep stops being the complement.

    Written WITHOUT inserting a screen name, so the failure is the partition
    check rather than the literal-list check. The first version subtracted
    {'browse.html'} and the gate caught it on "a gate names its own screens",
    which is a real finding about the mutated file and says nothing about
    whether the partition assertion works.
    """
    sub_once(POP, "return sorted(set(every_screen()) - set(payment_screens()))",
             "return sorted(set(every_screen()) - set(payment_screens())\n"
             "                  - set(every_screen()[:1]))")


def mut_d():
    """Put the hairline glyph back. The real D12 defect, verbatim."""
    sub_once(MARKET,
             ".acard-ev .sep {\n  width: 1px; height: 11px; flex: none;\n"
             "  background: var(--line-2);\n  border-radius: 1px;\n}",
             ".acard-ev .sep { color: var(--line-2); }")
    sub_once(BROWSE, '<span class="sep" aria-hidden="true"></span>',
             '<span class="sep">|</span>')


def mut_e():
    """Measure without revealing the scroll-in content.

    Aimed at the ORDER, not at one guard, and it took two tries to aim it
    right. Removing the ancestor-opacity check alone changes nothing now,
    because reveal_all puts the content into its finished state before
    anything is collected, so there is no invisible text left to catch.

    Skipping reveal_all alone was not enough either: settle_page then waits
    until the layout stops moving, and wireframe.js reveals everything
    unconditionally after 3 seconds, so the page reveals itself while the
    gate is waiting. The mutation has to remove BOTH the reveal and the wait
    to reproduce the state the gate was actually in, which is a photograph
    taken 0.6 seconds after load.

    That the page heals itself given three seconds is worth knowing: it means
    the old defect only ever showed up because the gate was fast, and a
    slower machine would have hidden it. Skipping the reveal without the wait
    is exactly the flaky-green case.
    """
    sub_once(INK, "                left = reveal_all(b)",
             "                left = 0  # mutation: skip the reveal")
    sub_once(INK, "                if not settle_page(b):",
             "                if False:  # mutation: and skip the wait")


def mut_f():
    """Remove the edge inset. The pane-rim false failure."""
    sub_once(INK, '    inset = 2.0 if it["w"] >= 6 else it["w"] / 2.0',
             '    inset = 1.0')


# name, the gate that must fail, the mutation, the screens to limit it to,
# and a fragment that MUST appear in the failure output.
#
# THE EXPECTED REASON IS NOT DECORATION. Mutation C broke population's
# partition and the gate exited 1, which reads as CAUGHT. It was failing on
# "a gate names its own screens" instead, because the mutation's own inserted
# literal tripped the earlier check. A mutation caught for the wrong reason
# proves nothing about the assertion it was written for, and it is invisible
# unless the suite reads the message.
MUTATIONS = [
    ("A  verify_ink SCREENS re-narrowed to 8 names", "verify_coverage.py",
     mut_a, None, "SCREENS is a literal list"),
    ("B  a screen on disk that nothing accounts for", "verify_sitemap.py",
     mut_b, None, "zz_ghost_screen.html"),
    ("C  population's partition made to overlap", "verify_coverage.py",
     mut_c, None, "partition misses"),
    ("D  the separator restored to a hairline glyph", "verify_ink.py",
     mut_d, ["browse.html"], "span.sep"),
    ("E  the scroll-in reveal skipped before measuring", "verify_ink.py",
     mut_e, ["browse.html"], "pverified"),
    ("F  verify_ink's edge inset removed", "verify_ink.py",
     mut_f, ["agreement.html"], "span.v"),
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

    caught, missed, wrong_reason = 0, [], []
    try:
        for name, gate, mutate, only, expect in MUTATIONS:
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
            reason_ok = expect.lower() in out.lower()
            verdict = "CAUGHT" if hit and reason_ok else (
                "REASON" if hit else "MISSED")
            print("  %-6s %-46s %-22s exit %d"
                  % (verdict, name, gate, code))
            if hit:
                for line in out.splitlines():
                    s = line.strip()
                    if s and (s.startswith(("FAIL", "FAILURES"))
                              or expect.lower() in s.lower()):
                        print("           %s" % s[:96])
                        break
            if hit and reason_ok:
                caught += 1
            elif hit:
                wrong_reason.append("%s: caught, but not for %r" % (name, expect))
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

    if missed or wrong_reason or not ok:
        print("\nMUTATION TEST FAILED: %d of %d caught for the right reason%s"
              % (caught, len(MUTATIONS),
                 "" if ok else ", and a gate does not pass clean"))
        for m in missed:
            print("  missed: %s" % m)
        for w in wrong_reason:
            print("  wrong reason: %s" % w)
        return 1

    print("\nMUTATION TEST PASSED: %d of %d mutations caught, each for the"
          % (caught, len(MUTATIONS)))
    print("reason it was written for, tree reverted clean, both gates green.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
