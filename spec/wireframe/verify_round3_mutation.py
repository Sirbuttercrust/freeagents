#!/usr/bin/env python3
"""verify_round3_mutation.py - prove the round-3 fixes catch their defects.

Round 1 found the tap-target probe blind on one AXIS. Round 2 fixed the axis
and left the SELECTOR and the open-state coverage blind. Round 3 found twelve
real under-floor controls behind that, plus an em-dash rule enforced on ten
files out of forty-plus.

The pattern that keeps costing is fixing the instance a reviewer named instead
of the class it belongs to, so the reviewer's own positive controls are
committed here as permanent mutations. If a later change re-narrows the
selector, drops the state opening, or re-scopes the em-dash sweep, this suite
says so.

The six mutations:

  1. a 20x20 <button> in browse's always-visible body      (the control that
                                                            already passed)
  2. a 20x20 <select> in the same position                 (SELECTOR blind)
  3. a 20x20 <button> inside the closed facet drawer       (STATE blind)
  4. a 20x20 <input type="text"> in the visible body       (SELECTOR blind)
  5. the .drawer label floor removed from both places      (the real D7 defect)
  6. a real U+2014 planted in notfound.html                (em-dash SCOPE)

Mutations 1 through 4 are the reviewer's controls, verbatim in shape. Each is
asserted ALIVE before the gate runs: the element is confirmed present and
measured at 20x20 with (pointer: coarse) true, so a mutation that silently
failed to apply cannot read as a gate catching something.

Every mutation is reverted from a copy held in memory, in a finally block, and
the tree is verified byte-identical at the end.

    python3 devserver.py 3111 &
    python3 verify_round3_mutation.py http://127.0.0.1:3111
"""

import hashlib
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3111"
sys.path.insert(0, HERE)

BROWSE = os.path.join(HERE, "browse.html")
SETTINGS = os.path.join(HERE, "settings.html")
POLISH = os.path.join(HERE, "polish.css")
NOTFOUND = os.path.join(HERE, "notfound.html")

FILES = [BROWSE, SETTINGS, POLISH, NOTFOUND]

# Where the controls go. An anchor that exists in the always-visible body of
# browse.html, above the results, and one inside the facet drawer which is
# `hidden` until the More filters button is clicked.
VISIBLE_ANCHOR = '  <!-- What an agent says when clicked. Reserved height so nothing jumps. -->'
DRAWER_ANCHOR = '      <h4>Language</h4>'

# 20x20 on both axes, forced past any floor, and marked so the revert check
# can prove none of it stayed behind.
STYLE = ('style="width:20px;height:20px;min-width:20px;min-height:20px;'
         'padding:0;border:0;display:inline-block" data-proofctl')


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


def run_gate(script):
    """Run a gate the way verify_all.py does: url in the environment.

    Neither gate here takes a positional url. verify_polish.py reads WF_BASE
    and verify_housestyle.py needs no server at all, so handing either one a
    positional argument would be silently ignored and could leave a gate
    auditing whatever happened to be on its default port.
    """
    env = dict(os.environ)
    env["WF_BASE"] = BASE if BASE.endswith("/") else BASE + "/"
    r = subprocess.run([sys.executable, os.path.join(HERE, script)],
                       capture_output=True, text=True, cwd=HERE, env=env)
    return r.returncode, r.stdout


def insert(path, anchor, markup):
    text = read(path)
    if anchor not in text:
        raise AssertionError("anchor not found in %s: %r"
                             % (os.path.basename(path), anchor[:50]))
    write(path, text.replace(anchor, markup + "\n" + anchor, 1))


def sub_once(path, old, new):
    text = read(path)
    if old not in text:
        raise AssertionError("mutation target not found in %s: %r"
                             % (os.path.basename(path), old[:60]))
    write(path, text.replace(old, new, 1))


# ---------------------------------------------------------------- the checks
#
# ALIVE CHECKS. A mutation that did not apply, or applied somewhere the
# element never renders, produces a MISSED that looks like a blind gate. Each
# control is measured through the same driver the gates use, before the gate
# runs, and the suite aborts if the shape is not what the mutation claims.

ALIVE_JS = """(function(){
  var e = document.querySelector('[data-proofctl]');
  if (!e) return JSON.stringify({found: false});
  var r = e.getBoundingClientRect();
  return JSON.stringify({
    found: true, tag: e.tagName, w: Math.round(r.width), h: Math.round(r.height),
    coarse: window.matchMedia('(pointer: coarse)').matches
  });
})()"""

OPEN_DRAWER_JS = """(function(){
  var b = document.querySelector('.more');
  if (b) b.click();
  return 1;
})()"""


def alive(page, open_drawer=False):
    """Measure the planted control the way the gate will see it."""
    import json
    try:
        from webgrab import Browser
    except ImportError:
        from wirebrowse import Browser
    import tapfloor

    b = Browser(width=320, height=640)
    try:
        tapfloor.touch(b)
        b.goto(BASE.rstrip("/") + "/" + page, wait=1.6)
        if open_drawer:
            b.js(OPEN_DRAWER_JS)
            b.send("Runtime.evaluate",
                   expression="new Promise(r=>setTimeout(r,160))", awaitPromise=True)
        return json.loads(b.js(ALIVE_JS))
    finally:
        b.close()


MUTATIONS = [
    ("A  20x20 button, browse visible body", "verify_polish.py",
     lambda: insert(BROWSE, VISIBLE_ANCHOR,
                    '  <button type="button" data-demo="x" %s></button>' % STYLE),
     lambda: alive("browse.html")),

    ("B  20x20 SELECT, same position", "verify_polish.py",
     lambda: insert(BROWSE, VISIBLE_ANCHOR,
                    '  <select %s><option>x</option></select>' % STYLE),
     lambda: alive("browse.html")),

    ("C  20x20 button INSIDE the closed drawer", "verify_polish.py",
     lambda: insert(BROWSE, DRAWER_ANCHOR,
                    '      <button type="button" data-demo="x" %s></button>' % STYLE),
     lambda: alive("browse.html", open_drawer=True)),

    ("D  20x20 text input, browse visible body", "verify_polish.py",
     lambda: insert(BROWSE, VISIBLE_ANCHOR,
                    '  <input type="text" %s>' % STYLE),
     lambda: alive("browse.html")),

    # The real defect, not a planted one: remove the label floor from BOTH
    # places it lives and the eleven facet labels drop back to 292x29.
    ("E  the .drawer label floor removed", "verify_polish.py",
     lambda: (sub_once(BROWSE, "    .drawer label { min-height: 44px; }",
                       "    .drawer label { /* removed */ }"),
              sub_once(POLISH, '  label:has(> input[type="checkbox"]),\n'
                               '  label:has(> input[type="radio"]) {\n'
                               '    min-height: 44px;\n  }',
                       "  /* removed */"),
              sub_once(POLISH, "  .drawer label,\n  .between label.row {\n"
                               "    min-height: 44px;\n  }",
                       "  /* removed */")),
     None),

    # SCOPE, not presence. The tree is clean; this proves the sweep reaches a
    # file that is not one of the eight payment screens.
    ("F  a real em dash in notfound.html", "verify_housestyle.py",
     lambda: sub_once(NOTFOUND, "<body>", "<body>\n<p>planted \u2014 here</p>"),
     None),
]


def main():
    before = digest(FILES)
    saved = dict((p, read(p)) for p in FILES)

    # A KILLED RUN POISONS THE NEXT ONE, SILENTLY. A suite killed after
    # mutating leaves the damage on disk; the next run snapshots the damaged
    # tree and "restores" the mutation back, then reports a revert failure for
    # a cause hours old. Name any dirty file at startup instead.
    dirty = subprocess.run(
        ["git", "status", "--porcelain", "--"] + FILES,
        capture_output=True, text=True, cwd=HERE).stdout.strip()
    if dirty:
        print("NOTE: mutation targets are dirty before this run started:")
        for line in dirty.splitlines():
            print("   " + line)
        print("If a previous run was killed mid-flight, the snapshot below is")
        print("of a DAMAGED tree and every result is suspect. git checkout the")
        print("files above first.\n")

    print("=" * 78)
    print("verify_round3_mutation.py   tree %s" % before)
    print("=" * 78)

    caught, missed = 0, []
    try:
        for name, gate, mutate, check in MUTATIONS:
            mutate()
            if check:
                a = check()
                if not a.get("found"):
                    print("  ABORT %-42s planted control never rendered" % name)
                    return 1
                if not a.get("coarse"):
                    print("  ABORT %-42s (pointer: coarse) false" % name)
                    return 1
                if a["w"] > 43 or a["h"] > 43:
                    print("  ABORT %-42s control measured %dx%d, not under the floor"
                          % (name, a["w"], a["h"]))
                    return 1
                shape = "%s %dx%d" % (a["tag"], a["w"], a["h"])
            else:
                shape = "real defect"

            code, out = run_gate(gate)
            for p, text in saved.items():
                write(p, text)

            if code == 3:
                print("  SKIP  %-42s (no browser)" % name)
                return 3
            hit = code == 1
            print("  %-6s %-42s %-22s exit %d   [%s]"
                  % ("CAUGHT" if hit else "MISSED", name, gate, code, shape))
            if hit:
                caught += 1
            else:
                missed.append(name)
    finally:
        for p, text in saved.items():
            write(p, text)

    after = digest(FILES)
    print("\n" + "-" * 78)
    print("tree after revert: %s  %s"
          % (after, "IDENTICAL" if after == before else "DIFFERS, INVESTIGATE"))
    left = [os.path.basename(p) for p in FILES if "data-proofctl" in read(p)]
    print("planted controls left behind: %s" % (left or "none"))

    if after != before or left:
        print("FAIL: the tree was not restored.")
        return 1

    print("\nre-running the gates on the reverted tree:")
    ok = True
    for gate in ("verify_polish.py", "verify_housestyle.py"):
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

    print("\nMUTATION TEST PASSED: %d of %d mutations caught, tree reverted clean,"
          % (caught, len(MUTATIONS)))
    print("both gates green on the restored tree.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
