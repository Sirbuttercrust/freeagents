#!/usr/bin/env python3
"""Make the polished gates run from a bare clone, like the September ones.

THE PROBLEM THIS FIXES.

The six gates that came from the polished pass import `webgrab.py`, an
internal QA tool that lives outside this repository, and they exit with
"webgrab.py not found" when it is absent. DESIGN.md section 10 is explicit
that this is the failure the September gates were rewritten to avoid:

    an earlier round of these gates imported a browser driver that lived on
    one machine, so every green result they printed was unreproducible by
    anybody else, and a real contrast defect shipped behind one.

A gate a reviewer cannot run is a claim, not a check. Now that all sixteen
gates run from one runner, six of them being unrunnable without a tool from
another machine would put the whole suite back in that state.

WHAT CHANGES.

`wirebrowse.py` is committed beside them and exposes the same Browser API
(goto, js, send, close, the same constructor keywords). So the import becomes:
prefer webgrab if WEBGRAB_DIR names a real one, otherwise use the committed
driver. Nobody has to set anything, and a machine that does have webgrab keeps
using it.

The default base url also moves from port 3110 to 3111, which is the port
DESIGN.md, README.md and verify_all.py all name. The mismatch was not
cosmetic: pointed at an empty port these gates reported "polish layer not
loaded" on all 26 screens, which reads exactly like a real regression.

Run from spec/wireframe. Idempotent.
"""

import os
import re
import sys

GATES = [
    "verify_polish.py",
    "verify_profile_header.py",
    "verify_agents_below.py",
    "verify_reduced_motion.py",
    "verify_flow_motion.py",
    "verify_blast_preview.py",
]

HERE = os.path.dirname(os.path.abspath(__file__))

NEW_IMPORT = '''# THE DRIVER, WITHOUT AN ENVIRONMENT.
#
# wirebrowse.py is committed beside this file and exposes the same Browser
# API, so this gate runs from a clone with python3 and any Chrome. webgrab.py
# is an internal tool that lives outside this repository; if WEBGRAB_DIR names
# a directory that really holds it, it is used, and otherwise the committed
# driver is. DESIGN.md section 10: a gate a reviewer cannot run is a claim,
# not a check.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
_wg = os.environ.get("WEBGRAB_DIR")
if _wg and os.path.exists(os.path.join(_wg, "webgrab.py")):
    sys.path.insert(0, _wg)
try:
    from webgrab import Browser
except ImportError:
    from wirebrowse import Browser
'''

OLD_IMPORT = re.compile(
    r"(?:# webgrab\.py is an internal QA tool[^\n]*\n"
    r"# WEBGRAB_DIR at the directory holding it[^\n]*\n)?"
    r"_wg = os\.environ\.get\(\"WEBGRAB_DIR\"[^\n]*\n"
    r"sys\.path\.insert\(0, _wg\)\n"
    r"try:\n"
    r"    from webgrab import Browser\n"
    r"except ImportError:\n"
    r"    sys\.exit\([^\n]*\n"
)

# verify_blast_preview.py refuses to start at all without the variable, which
# is the same defect in a louder form: it exits 2 before it can check anything.
OLD_HARD_EXIT = re.compile(
    r"WEBGRAB_DIR = os\.environ\.get\(\"WEBGRAB_DIR\"\)\n"
    r"if not WEBGRAB_DIR:\n"
    r"    print\([^\n]*\n"
    r"    sys\.exit\(2\)\n"
    r"sys\.path\.insert\(0, os\.path\.expanduser\(WEBGRAB_DIR\)\)\n"
    r"\n"
    r"from webgrab import Browser[^\n]*\n"
)


def main():
    changed = []
    for name in GATES:
        path = os.path.join(HERE, name)
        src = open(path).read()
        before = src

        src = OLD_IMPORT.sub(NEW_IMPORT, src)
        src = OLD_HARD_EXIT.sub(NEW_IMPORT, src)
        # The port every other instrument and document already names.
        src = src.replace('"WF_BASE", "http://127.0.0.1:3110/"',
                          '"WF_BASE", "http://127.0.0.1:3111/"')
        src = src.replace('"WF_BASE", "http://127.0.0.1:3110"',
                          '"WF_BASE", "http://127.0.0.1:3111"')
        # The docstring line telling a reader to set a variable they no longer
        # need. Left stale it teaches the opposite of what the code now does.
        src = src.replace(
            "Run:  WEBGRAB_DIR=<path to webgrab dir> python3 verify_blast_preview.py",
            "Run:  python3 verify_blast_preview.py [base-url]")

        if src != before:
            open(path, "w").write(src)
            changed.append(name)

    bad = 0
    for name in GATES:
        src = open(os.path.join(HERE, name)).read()
        if "from wirebrowse import Browser" not in src:
            print("FAIL %s has no committed-driver fallback" % name)
            bad += 1
        if "3110" in src:
            print("FAIL %s still defaults to port 3110" % name)
            bad += 1
        if "webgrab.py not found" in src:
            print("FAIL %s still exits when webgrab is absent" % name)
            bad += 1

    if bad:
        return 1
    print("rewired: %s" % (", ".join(changed) if changed else "nothing, already applied"))
    print("all %d gates fall back to the committed driver and default to 3111" % len(GATES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
