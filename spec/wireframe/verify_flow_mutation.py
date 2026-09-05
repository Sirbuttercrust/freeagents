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

# WEBGRAB_DIR comes from the environment with no default. This repository is
# public, so a hardcoded home path is a leak as well as a portability bug.
if not os.environ.get("WEBGRAB_DIR"):
    print("Set WEBGRAB_DIR to the directory holding webgrab.py")
    sys.exit(2)
ENV = dict(os.environ)


def run_gate():
    r = subprocess.run([sys.executable, os.path.join(HERE, "verify_flow.py"), BASE],
                       capture_output=True, text=True, env=ENV, cwd=HERE)
    tail = [l for l in r.stdout.splitlines() if l.startswith(("PASS", "FAIL", "  - "))]
    return r.returncode, tail


MUTATIONS = [
    ("base.css",
     "@media (pointer: coarse) {\n  .notetoggle { min-height: 44px; }\n}",
     "@media (pointer: coarse) {\n  /* mutated: floor removed */\n}",
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

    ("flow.css",
     ".mark-on  { background: var(--fg-2); }",
     ".mark-on  { background: var(--accent); }",
     "accent spent on a signature"),

    # The defect a screenshot found and no number would have: the parent stays
    # a grid in the narrow branch, so rows auto-place side by side and print
    # on top of each other while every element stays inside 320px.
    ("flow.css",
     "@media (max-width: 560px) {\n  .terms { display: block; }",
     "@media (max-width: 560px) {\n  .terms { grid-template-columns: 24px 1fr; }",
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
for fname, _, _, _ in MUTATIONS:
    p = os.path.join(HERE, fname)
    SNAPSHOT[p] = open(p, encoding="utf-8").read()


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
for fname, old, new, label in MUTATIONS:
    path = os.path.join(HERE, fname)
    original = open(path, encoding="utf-8").read()
    if old not in original:
        results.append((label, "SKIP", "anchor text not found, mutation is stale"))
        print(f"\n{label}: SKIP (anchor not found in {fname})")
        continue
    try:
        with open(LOCK, "w", encoding="utf-8") as fh:
            fh.write(f"{fname}\n{label}\n")
        open(path, "w", encoding="utf-8").write(original.replace(old, new, 1))
        code, tail = run_gate()
        caught = code != 0
        hit = next((t for t in tail if t.startswith("  - ")), "")
        results.append((label, "CAUGHT" if caught else "MISSED", hit.strip()))
        print(f"\n{label}")
        print(f"   mutated {fname}: exit {code} -> {'CAUGHT' if caught else 'MISSED'}")
        if hit:
            print(f"   {hit.strip()[:100]}")
    finally:
        open(path, "w", encoding="utf-8").write(original)
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
