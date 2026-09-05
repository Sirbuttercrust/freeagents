#!/usr/bin/env python3
"""verify_round2_mutation.py - prove the two round-2 gates catch their defects.

A gate written AFTER a fix has never seen the bug it claims to guard. Green on
a corrected tree proves the assertion runs, not that it discriminates. So each
mutation below puts one defect back, runs the gate, and requires a FAIL; then
reverts and requires a PASS.

The five mutations are the exact defects review reported, plus the one this
round's own sweep found that review did not:

  1. .trow .act back to --fg-3        the `edit` control at 3.72:1
  2. .thead span back to --fg-3       the party headers at 3.72:1
  3. .trow .num back to --fg-3        the agreement row numbers
  4. .getlist .num back to --fg-3     deposit's page-local rule, found by the
                                      sweep and invisible to any flow.css
                                      exemption list
  5. strip the seven aria-labels      seven controls all named "edit"

Every mutation is applied to a real file on disk and reverted from a saved
copy in memory, so a crash cannot leave the tree modified: the revert runs in
a finally block and the tree is verified byte-identical at the end.

    python3 devserver.py 3111 &
    python3 verify_round2_mutation.py http://127.0.0.1:3111
"""

import hashlib
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3111"

FLOW = os.path.join(HERE, "flow.css")
DEPOSIT = os.path.join(HERE, "deposit.html")
AGREEMENT = os.path.join(HERE, "agreement.html")


def read(p):
    with open(p) as fh:
        return fh.read()


def write(p, text):
    with open(p, "w") as fh:
        fh.write(text)


def digest(paths):
    h = hashlib.sha1()
    for p in sorted(paths):
        h.update(read(p).encode())
    return h.hexdigest()[:12]


def run_gate(script):
    r = subprocess.run([sys.executable, os.path.join(HERE, script), BASE],
                       capture_output=True, text=True, cwd=HERE)
    return r.returncode, r.stdout


def sub_once(path, old, new):
    """Replace `old` with `new`, asserting it was actually present."""
    text = read(path)
    if old not in text:
        raise AssertionError("mutation target not found in %s: %r"
                             % (os.path.basename(path), old[:60]))
    write(path, text.replace(old, new, 1))


MUTATIONS = [
    ("edit control back to --fg-3", "verify_ink.py", FLOW,
     lambda: sub_once(FLOW,
                      ".trow .edit .act {\n  font-size: 13px; color: var(--fg-2);",
                      ".trow .edit .act {\n  font-size: 13px; color: var(--fg-3);")),

    ("party headers back to --fg-3", "verify_ink.py", FLOW,
     lambda: sub_once(FLOW,
                      ".thead span {\n  font-size: 12px; color: var(--fg-2);",
                      ".thead span {\n  font-size: 12px; color: var(--fg-3);")),

    ("agreement row numbers back to --fg-3", "verify_ink.py", FLOW,
     lambda: sub_once(FLOW,
                      ".trow .num { grid-column: 1; font-family: var(--mono); "
                      "font-size: 12px; color: var(--fg-2);",
                      ".trow .num { grid-column: 1; font-family: var(--mono); "
                      "font-size: 12px; color: var(--fg-3);")),

    ("deposit's page-local .num back to --fg-3", "verify_ink.py", DEPOSIT,
     lambda: sub_once(DEPOSIT,
                      ".getlist .num { font-family: var(--mono); "
                      "font-size: 12px; color: var(--fg-2); }",
                      ".getlist .num { font-family: var(--mono); "
                      "font-size: 12px; color: var(--fg-3); }")),

    ("strip the seven edit aria-labels", "verify_names.py", AGREEMENT,
     lambda: write(AGREEMENT, re.sub(
         r'<button class="act" type="button" aria-label="[^"]*">',
         '<button class="act" type="button">', read(AGREEMENT)))),
]


def main():
    files = [FLOW, DEPOSIT, AGREEMENT]
    before = digest(files)
    saved = dict((p, read(p)) for p in files)

    print("=" * 78)
    print("verify_round2_mutation.py   tree %s" % before)
    print("=" * 78)

    caught, missed = 0, []
    try:
        for name, gate, path, mutate in MUTATIONS:
            mutate()
            code, out = run_gate(gate)
            reverted = saved[path]
            write(path, reverted)

            if code == 3:
                print("  SKIP  %-42s (no browser)" % name)
                return 3
            hit = code == 1
            fails = re.search(r"FAILURES: (\d+)", out)
            print("  %-5s %-42s %s exit %d%s"
                  % ("CAUGHT" if hit else "MISSED", name, gate, code,
                     ", %s findings" % fails.group(1) if fails else ""))
            if hit:
                caught += 1
            else:
                missed.append(name)
    finally:
        for p, text in saved.items():
            write(p, text)

    after = digest(files)
    print("\n" + "-" * 78)
    print("tree after revert: %s  %s"
          % (after, "IDENTICAL" if after == before else "DIFFERS, INVESTIGATE"))

    if after != before:
        print("FAIL: the tree was not restored.")
        return 1

    # And the gates must pass on the clean tree, or "caught" means nothing.
    print("\nre-running both gates on the reverted tree:")
    ok = True
    for gate in ("verify_ink.py", "verify_names.py"):
        code, _ = run_gate(gate)
        print("  %-22s exit %d  %s" % (gate, code, "PASS" if code == 0 else "FAIL"))
        ok = ok and code == 0

    if missed or not ok:
        print("\nMUTATION TEST FAILED: %d of %d caught%s"
              % (caught, len(MUTATIONS),
                 "" if ok else ", and a gate does not pass clean"))
        for m in missed:
            print("  missed: %s" % m)
        return 1

    print("\nMUTATION TEST PASSED: %d of %d mutations caught, tree reverted clean,"
          % (caught, len(MUTATIONS)))
    print("both gates green on the restored tree.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
