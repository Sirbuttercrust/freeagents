#!/usr/bin/env python3
"""Round 13: a gate that compares a browser's role name against a string it typed.

`verify_names.py` collected every control on all 33 screens with a markup
selector, then filtered by ROLE against a hand-written vocabulary. That
vocabulary held `"disclosure triangle"`. Chrome returns `DisclosureTriangle`.
The strings never matched, so all eight account-menu `<summary>` controls were
collected and dropped: never checked for a name, a duplicate name, or an
invisible name source, on a gate whose documented promise is that no control
is nameless.

A reviewer proved it on a COPY of the tree. Remove one of those `aria-label`s
and the gate passed at exit 0 with a genuinely nameless control on the page.

M1 REPRODUCES THAT EXACT POSITIVE CONTROL, in this tree, with the revert this
file guarantees. It is the defect a person reported, so it is the one they
will expect to stay fixed.

Two fixes landed, and they fail in different places, so each gets its own
blinding half:

  role_key()        normalises case, spaces and hyphens before comparing, so
                    one role spelled three ways is one role
  the reconciliation the report prints what it COLLECTED beside what it
                    CHECKED and FAILS when they differ, so a control that
                    falls out of the population moves a number

  M1  a summary with its aria-label removed   -> FAIL, nameless, on the role
                                                the gate used to drop
  M2  the role dropped from CONTROL_ROLES     -> FAIL, 8 collected and not
                                                checked, named
  M3  a control inside an aria-hidden subtree -> FAIL, a control a mouse can
                                                click and a screen reader
                                                cannot announce
  B1  M1's defect against the WHOLE pre-round-13 instrument, all three
      clauses reverted                        -> PASS, defect invisible. This
                                                is the reviewer's positive
                                                control, reproduced here
  B2  M2's defect, the reconciliation's fail removed
                                              -> PASS, defect invisible
  D1  M1's defect, role_key reverted and the reconciliation LEFT IN
                                              -> FAIL, and the nameless
                                                finding is gone while the
                                                population gap is named
  N1  the OLD spelling "disclosure triangle" restored in CONTROL_ROLES
                                              -> quiet, because role_key
                                                 normalises it. This is the
                                                 class claim, made falsifiable
  N2  a legal disclosure with a real name      -> quiet

D1 IS THE CONTROL THIS SUITE GOT WRONG ON ITS FIRST RUN, and the correction is
worth more than the control. B1 was originally written to revert `role_key`
alone and require a pass, on the reasoning that role_key is what admits the
control. It reported WRONG, and the reason is not a defect in either fix: with
the role comparison reverted, the eight summaries fall out of the population
and THE RECONCILIATION CATCHES THEM. The gate still exits 1, naming a
different finding.

A blinding half asserts a pass, so it is only valid when the defect is visible
to the clause under test and to nothing else. These two clauses overlap on
purpose: one keeps the control in the population, the other notices when
anything leaves it. So the pair is split. B1 blinds both and reproduces the
exit 0 a reviewer measured on a copy of this tree; D1 blinds one and asserts
the OTHER still speaks, which is the property that makes the second fix worth
having. Asserting a pass in D1's position would have asserted a blindness the
gate does not have.

N1 IS THE CONTROL THAT MATTERS MOST HERE, and it is the one a suite written in
a hurry leaves out. Adding `DisclosureTriangle` to the list would pass M1, M2
and M3 while leaving the next differently-spelled role to be dropped exactly
as silently. N1 asserts the spelling genuinely stopped mattering: put the
pre-fix string back and nothing changes, because nothing compares strings any
more.

B1 and B2 assert a PASS on a tree that carries a real defect. That is the half
which proves each clause is load-bearing rather than decorative: if the gate
still failed with the clause gone, something ELSE is catching the defect and
the clause is not what closes the hole. D1 is where that "something else" is
named instead of being hidden by a weaker assertion.

Run from the wireframe directory with the preview server up. Reverts on any
exit, including SIGTERM.

    python3 devserver.py 3111 &
    python3 verify_round13_mutation.py http://127.0.0.1:3111/
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

NAMES = os.path.join(HERE, "verify_names.py")
DASH = os.path.join(HERE, "dashboard.html")
NOTFOUND = os.path.join(HERE, "notfound.html")
# Exactly the files this suite writes to. A path declared and never written is
# an exemption for a file nothing touches, which is how a real one gets waved
# through later.
FILES = [NAMES, DASH, NOTFOUND]

# Unique to this suite, so the stray check after the revert cannot fire on a
# document paragraph describing another round's plant.
MARKERS = ("r13hidden", "r13legal")

# ---------------------------------------------------------------- the plants

# M1. The reviewer's positive control: the account-menu summary loses the only
# thing naming it. Its role is the one the pre-fix filter dropped, so before
# this round the gate had nothing to say about it.
M1_FIXED = '<summary class="avatarbtn" aria-label="Account menu">'
M1_BROKEN = '<summary class="avatarbtn">'

# M2. The role leaves the vocabulary entirely. This is what a browser
# respelling a role does to this gate from the outside, and it is the shape
# the reconciliation exists to catch: the controls are still collected, still
# reachable, and no name rule is applied to any of them.
M2_FIXED = '    "tab", "DisclosureTriangle",'
M2_BROKEN = '    "tab",'

# M3. A control a mouse can click sitting inside an `aria-hidden` subtree. The
# markup selector reaches it and the accessibility tree refuses to announce
# it, so it lands in the population with no live AX node at all. A different
# route into the unaccounted list than M2, and a real defect in its own right.
M3_ANCHOR = '    <div class="row wrapflex" style="justify-content:center;'
M3_PLANT = ('    <div aria-hidden="true">'
            '<button class="r13hidden" type="button">Send</button></div>\n'
            '    <div class="row wrapflex" style="justify-content:center;')

# B1. The instrument reverted to what it was before round 13, BOTH clauses: an
# equality test against the spelling somebody typed, and the pre-fix spelling
# in the vocabulary. This reproduces the reviewer's positive control exactly,
# where a genuinely nameless control passed at exit 0. The name rules all
# still run, the AX tree is still read, and the source is still checked.
B1_ROLE_FIXED = '        if role_key(role) not in CONTROL_ROLE_KEYS:'
B1_ROLE_BROKEN = '        if role not in CONTROL_ROLES:'
B1_SPELL_FIXED = '    "tab", "DisclosureTriangle",'
B1_SPELL_BROKEN = '    "tab", "disclosure triangle",'

# B2. The reconciliation still PRINTS both counts and stops asserting them.
# This is the more instructive blinding of the two: a gate that reports a
# number nobody checks is exactly the state four earlier rounds shipped.
B2_FIXED = """            fails.append(
                "%d control(s) reached by a person and checked by nothing: "
                "%s.%s\\n      %s\\n      [%s]"
                % (len(where), tag, cls, why,
                   ", ".join(where[:6]) +
                   (", and %d more" % (len(where) - 6) if len(where) > 6 else "")))"""
B2_BROKEN = """            pass"""

# N1. The pre-fix spelling, restored. Required result: silence. If this fails,
# the round fixed one string rather than the class.
N1_FIXED = '    "tab", "DisclosureTriangle",'
N1_BROKEN = '    "tab", "disclosure triangle",'

# N2. A legal disclosure with a name a person can read, on a screen that has
# none, so the gate meets a role it now admits in a shape it must not condemn.
N2_ANCHOR = '    <div class="row wrapflex" style="justify-content:center;'
N2_PLANT = ('    <details class="r13legal"><summary>More about this page'
            '</summary><p>Nothing else here.</p></details>\n'
            '    <div class="row wrapflex" style="justify-content:center;')


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
    """Replace and PROVE the replacement landed.

    A mutation that silently matches nothing asserts a failure against a tree
    carrying no defect, and reads as the gate being broken.
    """
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


def fail_line(out, needle):
    """A line under the FAILURES header, never any line mentioning the word.

    The report prints a row per screen whether or not anything failed, and it
    now prints a reconciliation block as well, so matching on the whole output
    would pass on a gate that asserts nothing.
    """
    hits = []
    seen = False
    for line in out.splitlines():
        if line.startswith("FAILURES:"):
            seen = True
            continue
        if seen and line.startswith("  ") and needle in line:
            hits.append(line.strip())
    return hits


def counts(out):
    """The collected and checked counts off the face of the report."""
    got = {}
    for line in out.splitlines():
        for key, label in (("collected", "markup controls collected"),
                           ("checked", "checked against the name rules"),
                           ("dropped", "collected and NOT checked")):
            if line.strip().startswith(label):
                got[key] = int(line.split()[-1])
    return got


def main():
    before = digest(FILES)
    saved = dict((p, read(p)) for p in FILES)

    mutationsafe.guard(FILES)

    def restore():
        for p, s in saved.items():
            write(p, s)

    mutationsafe.acquire(FILES, restore=restore)

    print("=" * 78)
    print("verify_round13_mutation.py   tree %s   %s" % (before, BASE))
    print("=" * 78)
    print("A role the browser spells its own way, and the eight controls that")
    print("fell out of the population behind it. M1 is the reviewer's positive")
    print("control, reproduced. B1 and B2 prove each fix catches its defect,")
    print("and D1 proves they catch it by different routes. N1 proves the")
    print("SPELLING stopped mattering, which is the difference between fixing")
    print("a class and widening a list by one name.")
    print()

    results = []
    try:
        # ------------------------------------------------------------- M1
        sub(DASH, M1_FIXED, M1_BROKEN)
        c1, out1 = run_names()
        named1 = fail_line(out1, "NO accessible name")
        restore()
        ok1 = c1 != 0 and any("dashboard.html" in h for h in named1)
        results.append(("M1 the account menu loses its only name", ok1))
        print("M1  dashboard.html's summary.avatarbtn loses its aria-label")
        print("    verify_names.py  exit %d  %s"
              % (c1, (named1[0][:88] if named1 else "NOT NAMED")))
        print("    this is the control that passed at exit 0 before round 13")

        # ------------------------------------------------------------- M2
        sub(NAMES, M2_FIXED, M2_BROKEN)
        c2, out2 = run_names()
        named2 = fail_line(out2, "checked by nothing")
        n2 = counts(out2)
        restore()
        ok2 = c2 != 0 and bool(named2) and n2.get("dropped") == 8
        results.append(("M2 a role the vocabulary no longer admits", ok2))
        print()
        print("M2  DisclosureTriangle removed from CONTROL_ROLES")
        print("    verify_names.py  exit %d  collected %s  checked %s  dropped %s"
              % (c2, n2.get("collected"), n2.get("checked"), n2.get("dropped")))
        print("    %s" % (named2[0][:88] if named2 else "NOT NAMED"))

        # ------------------------------------------------------------- M3
        sub(NOTFOUND, M3_ANCHOR, M3_PLANT)
        c3, out3 = run_names()
        named3 = fail_line(out3, "ariaHiddenSubtree")
        restore()
        ok3 = c3 != 0 and bool(named3)
        results.append(("M3 a clickable control the AX tree ignores", ok3))
        print()
        print("M3  a button inside an aria-hidden subtree on notfound.html")
        print("    verify_names.py  exit %d  %s"
              % (c3, (named3[0][:88] if named3 else "NOT NAMED")))

        # ------------------------------------------------------------- B1
        # The defect AND the whole pre-round-13 instrument. A PASS here is the
        # point, and it is the exit 0 a reviewer measured on a copy of this
        # tree with a genuinely nameless control sitting on the page.
        sub(DASH, M1_FIXED, M1_BROKEN)
        sub(NAMES, B1_ROLE_FIXED, B1_ROLE_BROKEN)
        sub(NAMES, B1_SPELL_FIXED, B1_SPELL_BROKEN)
        sub(NAMES, B2_FIXED, B2_BROKEN)
        cb1, outb1 = run_names()
        namedb1 = fail_line(outb1, "NO accessible name")
        n1b = counts(outb1)
        restore()
        okb1 = cb1 == 0 and not namedb1
        results.append(("B1 the round-13 fixes are what catch M1", okb1))
        print()
        print("B1  M1's defect against the pre-round-13 instrument, both")
        print("    clauses reverted")
        print("    verify_names.py  exit %d  collected %s  checked %s  %s"
              % (cb1, n1b.get("collected"), n1b.get("checked"),
                 "silent" if not namedb1 else "still names it"))
        print("    a PASS is the point: this is the reviewer's positive")
        print("    control, a nameless control passing at exit 0")

        # ------------------------------------------------------------- D1
        # Defence in depth, asserted rather than assumed. Only the role
        # comparison is reverted, so the eight summaries fall out of the
        # population and the reconciliation speaks up about the gap. The
        # nameless finding is gone, which is what makes this a different
        # verdict from B1 rather than a weaker version of it.
        sub(DASH, M1_FIXED, M1_BROKEN)
        sub(NAMES, B1_ROLE_FIXED, B1_ROLE_BROKEN)
        sub(NAMES, B1_SPELL_FIXED, B1_SPELL_BROKEN)
        cd1, outd1 = run_names()
        namedd1 = fail_line(outd1, "checked by nothing")
        namelessd1 = fail_line(outd1, "NO accessible name")
        nd1 = counts(outd1)
        restore()
        okd1 = cd1 != 0 and bool(namedd1) and not namelessd1
        results.append(("D1 the reconciliation still speaks when the role "
                        "test is blind", okd1))
        print()
        print("D1  the same, with the reconciliation left in")
        print("    verify_names.py  exit %d  collected %s  checked %s  dropped %s"
              % (cd1, nd1.get("collected"), nd1.get("checked"),
                 nd1.get("dropped")))
        print("    %s" % (namedd1[0][:88] if namedd1 else "NOT NAMED"))
        print("    the nameless finding is %s, so the two clauses catch this"
              % ("gone" if not namelessd1 else "STILL HERE"))
        print("    defect by different routes and neither is redundant")

        # ------------------------------------------------------------- B2
        sub(NAMES, M2_FIXED, M2_BROKEN)
        sub(NAMES, B2_FIXED, B2_BROKEN)
        cb2, outb2 = run_names()
        namedb2 = fail_line(outb2, "checked by nothing")
        n2b = counts(outb2)
        restore()
        okb2 = cb2 == 0 and not namedb2 and n2b.get("dropped") == 8
        results.append(("B2 the reconciliation is what catches M2", okb2))
        print()
        print("B2  M2's defect, with the reconciliation's assertion removed")
        print("    verify_names.py  exit %d  collected %s  checked %s  dropped %s"
              % (cb2, n2b.get("collected"), n2b.get("checked"),
                 n2b.get("dropped")))
        print("    the counts still PRINT and nothing asserts them, which is")
        print("    the state four earlier rounds of this suite shipped in")

        # ------------------------------------------------------------- N1
        sub(NAMES, N1_FIXED, N1_BROKEN)
        cn1, outn1 = run_names()
        n1c = counts(outn1)
        restore()
        okn1 = cn1 == 0 and n1c.get("dropped") == 0 and n1c.get("checked") == 544
        results.append(("N1 the pre-fix spelling still admits the role", okn1))
        print()
        print("N1  \"disclosure triangle\", the spelling that caused all of this")
        print("    verify_names.py  exit %d  collected %s  checked %s  dropped %s"
              % (cn1, n1c.get("collected"), n1c.get("checked"),
                 n1c.get("dropped")))
        print("    quiet is the point: the spelling stopped mattering")

        # ------------------------------------------------------------- N2
        sub(NOTFOUND, N2_ANCHOR, N2_PLANT)
        cn2, outn2 = run_names()
        restore()
        okn2 = cn2 == 0
        results.append(("N2 a legal disclosure with a real name", okn2))
        print()
        print("N2  a <details>/<summary> named by its own contents")
        print("    verify_names.py  exit %d  %s"
              % (cn2, "quiet" if okn2 else "FAILED on legal markup"))

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
        for m in MARKERS:
            if m in body:
                stray.append("%s carries %s" % (os.path.basename(p), m))
    if stray:
        print("STRAY PLANTS LEFT IN THE TREE:")
        for s in stray:
            print("   " + s)

    cf, outf = run_names()
    nf = counts(outf)
    print("reverted tree: verify_names.py exit %d, collected %s, checked %s"
          % (cf, nf.get("collected"), nf.get("checked")))

    print()
    allok = all(ok for _, ok in results) and after == before and not stray and cf == 0
    for label, ok in results:
        print("  %-46s %s" % (label, "AS EXPECTED" if ok else "** WRONG **"))
    print()
    if allok:
        print("MUTATION TEST PASSED: 3 of 3 defects caught, 2 of 2 clauses proved")
        print("load-bearing, 1 of 1 second line of defence proved to speak,")
        print("2 of 2 legal patterns left alone, tree reverted clean.")
        return 0
    print("MUTATION TEST FAILED.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
