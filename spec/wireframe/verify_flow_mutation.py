#!/usr/bin/env python3
"""Mutation test for verify_flow.py.

A gate written after a fix has never once seen the defect it claims to catch.
Green on a fixed tree proves the assertion runs, not that it discriminates. So:
reintroduce each bug, run the gate, confirm FAIL, revert, confirm PASS.

Four mutations, one per defect this branch actually fixed:

  1  .notetoggle 44px floor removed          -> tap target finding on 8 screens
  2  the sheet's max-width removed           -> open-dialog overflow at 320px
  3  a data-copy value emptied               -> dead control finding
  4  an accent applied to a signature mark    -> accent discipline finding

Run from spec/wireframe with the preview server up.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3111"

# No environment setup: wirebrowse.py is committed beside the gates, so this
# runs from a clone. The repository is public, so a hardcoded home path would
# be a leak as well as a portability bug.
ENV = dict(os.environ)


def run_gate():
    r = subprocess.run([sys.executable, os.path.join(HERE, "verify_flow.py"), BASE],
                       capture_output=True, text=True, env=ENV, cwd=HERE)
    tail = [l for l in r.stdout.splitlines() if l.startswith(("PASS", "FAIL", "  - "))]
    return r.returncode, tail


MUTATIONS = [
    # RETARGETED 2026-09-09, and the reason is measured rather than asserted.
    #
    # This used to delete base.css's `.notetoggle { min-height: 44px }` alone
    # and expect a failure. On the reconciled tree that introduces NO defect,
    # because polish.css carries `.notetoggle { height: 44px }` in its own
    # coarse-pointer block and holds the floor by itself. Deleting either one
    # alone leaves the control at 44px, measured with measure_notetoggle.py at
    # 320px on a touch profile:
    #
    #     both rules present:              100.9x44
    #     base.css min-height deleted:     100.9x44   (polish.css holds it)
    #     polish.css height deleted:       100.9x44   (base.css holds it)
    #
    # Two rules doing one job is not a bug, it is the reason a single-rule
    # mutation could never fail. So the mutation removes the floor, which means
    # removing it from both places. A mutation that breaks nothing tests
    # nothing.
    ([("base.css",
       "@media (pointer: coarse) {\n  .notetoggle { min-height: 44px; }\n}",
       "@media (pointer: coarse) {\n  /* mutated: floor removed */\n}"),
      ("polish.css",
       "  .notetoggle { height: 44px; }",
       "  /* mutated: floor removed */")],
     "notetoggle tap target"),

    # WAS: width: min(520px, ...) -> width: 520px, labelled "sheet overflows".
    # That mutation is INVALID and the run correctly reported MISSED. Measured:
    # the UA stylesheet gives a modal <dialog> max-width: calc(100% - 36px), so
    # a fixed 520px still renders at 284px inside a 320px viewport. The
    # mutation introduced no defect, so nothing could catch it.
    #
    # What CAN overflow is content inside the sheet, which is the real risk and
    # the reason check 2 opens every dialog. Measured with this mutation
    # applied: the code renders at 38..438 against a 320 viewport.
    ("flow.css",
     "  width: 180px; height: 180px; margin: 0 auto;",
     "  width: 400px; height: 180px; margin: 0 auto;",
     "content overflowing inside an open sheet"),

    ("staged.html",
     'data-copy="c41f8a9d2b73e05614af8c3d99b7e2016fa4d825">Copy',
     'data-copy="">Copy',
     "dead copy button"),

    # RETARGETED 2026-09-09. Both of these used to mutate flow.css, which owned
    # the September agreement's `.trow` markup. The reconciled agreement is the
    # polished signature matrix in agreement.css, and NO page renders .trow or
    # .mark-on any more (checked: zero of 33 files). So both mutations were
    # editing rules that nothing on any screen matched, which is why they came
    # back MISSED. They now mutate the rules that actually paint the live
    # matrix.
    #
    # A signed mark is --fg, deliberately. Spending the reserved accent on a
    # signature would make every settled row compete with the one primary
    # action on the page, and DESIGN.md 2.2 does not list a signature among
    # the four things allowed to hold it.
    ("agreement.css",
     ".sig.is-signed .sigdot {\n  background: var(--fg); border-color: var(--fg); color: var(--bg);\n}",
     ".sig.is-signed .sigdot {\n  background: var(--accent); border-color: var(--accent); color: var(--bg);\n}",
     "accent spent on a signature"),

    # RETARGETED 2026-09-09, twice, and the second time for a better reason
    # than the first.
    #
    # This mutation used to remove the narrow-viewport `.terms { display:
    # block }` from flow.css and expect rows to auto-place beside each other.
    # That rule belonged to the September agreement, which no page renders any
    # more. Retargeting it at agreement.css was not enough either: the polished
    # matrix pins every cell to an explicit grid track AND row, so deleting any
    # single pinning rule changes nothing a person could see. Measured with
    # measure_agreement_rows.py at 320px, removing each of them in turn:
    #
    #     pinning intact:                 7 rows, 0 overlapping pairs
    #     .num unpinned:                  7 rows, 0 overlapping pairs
    #     .sigcell row unpinned:          7 rows, 0 overlapping pairs
    #     text cell unpinned:             7 rows, 0 overlapping pairs
    #     narrow grid reverted to wide:   7 rows, 0 overlapping pairs
    #
    # That robustness is the design working, and it is worth saying plainly:
    # the overlap class of defect was structural to the old row markup and the
    # matrix does not have it. So the mutation now takes the rows out of flow
    # entirely, which is the one edit that does reproduce overlapping rows:
    #
    #     row absolutely positioned:      13 overlapping pairs, up to 127px
    #
    # The anchor includes the `.terms > li {` line because the declaration
    # alone appears TWICE in agreement.css: .terms-head carries the identical
    # grid. A single-occurrence replace was silently mutating the HEADER, which
    # is one element and therefore cannot overlap itself, so the gate passed
    # and the mutation read as MISSED when the gate was in fact working.
    ("agreement.css",
     ".terms > li {\n  display: grid; grid-template-columns: 30px 1fr 74px 74px 40px; gap: 12px;",
     ".terms > li {\n  display: grid; grid-template-columns: 30px 1fr 74px 74px 40px; gap: 12px; position: absolute;",
     "agreement rows overlapping at 320px"),
]

print("=" * 74)
print("MUTATION TEST: does verify_flow.py catch the bugs it was written for?")
print("=" * 74)

# CRASH SAFETY. A mutation lives on disk while the gate runs, and the gate
# takes about a minute per run. If this process is killed in that window the
# mutation is left behind, which is a silently corrupted tree that looks like a
# design decision. This happened: a timeout during mutation 4 left the
# signature mark painted accent AND the notetoggle floor deleted AND a copy
# button emptied, and the only reason it surfaced was a later grep.
#
# Two layers, because they fail differently:
#
#   1  atexit plus SIGTERM/SIGINT handlers restore every file. This covers a
#      normal timeout, a Ctrl-C, and an uncaught exception.
#   2  a LOCK FILE written before the first mutation and removed after the
#      last restore. atexit cannot run under SIGKILL, so layer 1 has a hole
#      that nothing in-process can close. A leftover lock file is the signal
#      that the tree is dirty, and this script refuses to start on one.
#
# The whole point: a corrupted tree must ANNOUNCE itself rather than being
# discovered by whoever reads the CSS next.
LOCK = os.path.join(HERE, ".mutation-in-progress")
if os.path.exists(LOCK):
    print(f"\nREFUSING TO RUN: {LOCK} exists.\n"
          "A previous mutation run was killed before it could restore the tree.\n"
          "The files listed in it may still carry a mutation. Check them with\n"
          "  git diff spec/wireframe\n"
          "restore anything mutated, then delete the lock file.")
    sys.exit(2)

SNAPSHOT = {}
for _entry in MUTATIONS:
    _edits = _entry[0] if isinstance(_entry[0], list) else [_entry[:3]]
    for _fname, _, _ in _edits:
        p = os.path.join(HERE, _fname)
        SNAPSHOT[p] = open(p, encoding="utf-8").read()

# THE SNAPSHOT IS ONLY AS GOOD AS THE TREE IT WAS TAKEN FROM.
#
# Everything below restores files to SNAPSHOT, which is captured right here, at
# import. Start this suite on a tree that already carries a mutation and the
# "restore" writes that mutation back, the run ends with "reverted: FAIL", and
# the tree is left dirty in a way that looks like the gates broke.
#
# That is not hypothetical: a run killed mid-mutation on 2026-09-09 left a
# floor removed in two files, and the NEXT run snapshotted the damage and
# reported a failure that was three hours old. The lock file above catches a
# kill during THIS suite; this catches inheriting one from anything else.
#
# So ask git, which knows what the tree is supposed to look like. A dirty file
# is not always wrong (someone may be mid-edit), so this warns rather than
# refuses, and names the files, which is what turns a confusing red run into a
# one-line diagnosis.
try:
    _dirty = subprocess.run(
        ["git", "status", "--porcelain", "--"] + sorted(SNAPSHOT),
        cwd=HERE, capture_output=True, text=True, timeout=20).stdout.strip()
except Exception:
    _dirty = ""
if _dirty:
    print("WARNING: files this suite mutates have uncommitted changes:")
    for _line in _dirty.splitlines():
        print("   " + _line)
    print("   They will be restored to THIS state, not to the committed one.")
    print("   If a previous run was killed, revert them before trusting the")
    print("   result: git checkout -- <file> and delete .mutation-in-progress.\n")


def restore_all(*_a):
    for p, text in SNAPSHOT.items():
        if open(p, encoding="utf-8").read() != text:
            open(p, "w", encoding="utf-8").write(text)
            print(f"   restored {os.path.basename(p)}")
    if os.path.exists(LOCK):
        os.remove(LOCK)


import atexit
import signal

atexit.register(restore_all)
signal.signal(signal.SIGTERM, lambda *a: (restore_all(), sys.exit(3)))
signal.signal(signal.SIGINT, lambda *a: (restore_all(), sys.exit(3)))

code, tail = run_gate()
print(f"\nbaseline (clean tree): exit {code}  {tail[0] if tail else '?'}")
if code != 0:
    print("Tree is not clean, fix it before mutation testing.")
    sys.exit(2)

results = []
for entry in MUTATIONS:
    # A mutation is one or more edits applied together. Most are a single
    # (file, old, new) triple; a few have to touch two files at once, because
    # a rule held in two places is not removed by deleting one of them, and a
    # mutation that leaves the behaviour intact tests nothing.
    label = entry[-1]
    edits = entry[0] if isinstance(entry[0], list) else [entry[:3]]

    paths = [os.path.join(HERE, f) for f, _, _ in edits]
    originals = {p: open(p, encoding="utf-8").read() for p in paths}

    stale = [f for (f, old, _), p in zip(edits, paths) if old not in originals[p]]
    if stale:
        results.append((label, "SKIP", "anchor text not found, mutation is stale"))
        print(f"\n{label}: SKIP (anchor not found in {', '.join(stale)})")
        continue

    try:
        with open(LOCK, "w", encoding="utf-8") as fh:
            fh.write("%s\n%s\n" % (", ".join(f for f, _, _ in edits), label))
        for (fname, old, new), p in zip(edits, paths):
            open(p, "w", encoding="utf-8").write(originals[p].replace(old, new, 1))
        code, tail = run_gate()
        caught = code != 0
        hit = next((t for t in tail if t.startswith("  - ")), "")
        results.append((label, "CAUGHT" if caught else "MISSED", hit.strip()))
        print(f"\n{label}")
        print("   mutated %s: exit %s -> %s"
              % (", ".join(f for f, _, _ in edits), code, "CAUGHT" if caught else "MISSED"))
        if hit:
            print(f"   {hit.strip()[:100]}")
    finally:
        for p in paths:
            open(p, "w", encoding="utf-8").write(originals[p])
        if os.path.exists(LOCK):
            os.remove(LOCK)

code, tail = run_gate()
print(f"\nreverted: exit {code}  {tail[0] if tail else '?'}")

print("\n" + "=" * 74)
missed = [r for r in results if r[1] != "CAUGHT"]
for label, status, detail in results:
    print(f"  {status:<7} {label}")
if missed or code != 0:
    print(f"\nMUTATION TEST FAILED: {len(missed)} mutation(s) not caught")
    sys.exit(1)
print(f"\nMUTATION TEST PASSED: {len(results)} of {len(results)} mutations caught, "
      f"tree reverted clean")
