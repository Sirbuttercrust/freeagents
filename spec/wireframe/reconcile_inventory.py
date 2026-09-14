#!/usr/bin/env python3
"""Element-level inventory diff between the two reconcile parents and the result.

WHY THIS EXISTS, AND WHY A FILE LIST WAS NOT ENOUGH.

The first version of the reconcile handoff claimed nothing was lost, and backed
it by comparing FILE lists: every file on either parent exists on the result.
That was true, and it was the wrong claim. A file survives while an element
inside it leaves, and two did: the September agreement's technical disclosure,
and the brand's accessible name on four screens. A seventeen gate suite was
green throughout, because every gate asked "is this page correct" and none asked
"does this page still say what it used to".

So this reads the MARKUP of every screen on three trees and diffs the vocabulary
each screen uses: class names, ids, and the data attributes the polished system
hangs behaviour on. A class present on a parent and absent from the result is a
component that left, and it is named here whether or not that was deliberate.

This is an inventory, not a verdict. A dropped class can be correct (a renamed
wrapper, a component folded into another) and this script cannot tell that from
a loss. That is exactly why the output is a list a person signs off in
RECONCILE-NOTES.md rather than an exit code: the reason is the part a script
cannot supply. `verify_kept.py` is the rerunnable half, which asserts that named
FACTS still render somewhere in the set.

Run from anywhere in the repo. Reads git, touches no working file.

    python3 reconcile_inventory.py
    python3 reconcile_inventory.py --ref <polished> --ref <main> --result HEAD
"""
import argparse
import collections
import re
import subprocess
import sys

POLISHED = "design/burnish-polished-2026-08-29"
MAINBASE = "971b97a"
DIR = "spec/wireframe"

# The attributes the polished visual system hangs identity and behaviour on.
# A screen losing one of these loses a treatment, not merely a string.
HOOKS = ("data-avatar", "data-ico", "data-tint", "aria-label", "aria-labelledby")


def git(*args):
    return subprocess.run(["git"] + list(args), capture_output=True, text=True,
                          check=True).stdout


def screens(ref):
    """Every html file under the wireframe directory on `ref`.

    TWO CWD TRAPS HERE, AND BOTH PRINTED GREEN RATHER THAN FAILING.

    The pathspec is rooted with `:/` because a bare `spec/wireframe` resolves
    RELATIVE TO THE CWD, so running this from inside the wireframe directory
    (the obvious place to run it from) asked git for spec/wireframe/spec/
    wireframe and matched nothing.

    `--full-name` is the second half, and it is the one that survived the first
    fix. `git ls-tree` prints paths relative to the CWD, so from the wireframe
    directory it returned `agent.html` where every other function in this file
    expects `spec/wireframe/agent.html`. Those names were then handed to
    `git show <ref>:agent.html`, which resolves from the repo ROOT, so every
    read failed and every screen compared as empty against empty. The sweep
    reported "none" for all 33 screens on a total visual system swap.
    """
    out = git("ls-tree", "-r", "--name-only", "--full-name", ref, "--",
              ":/" + DIR)
    return sorted(p for p in out.splitlines() if p.endswith(".html"))


def read(ref, path):
    """The bytes of `path` on `ref`.

    This used to swallow CalledProcessError and return "", which is what let
    the CWD bug above read as a clean reconcile: a failed read and a screen
    with no markup are indistinguishable downstream. A missing file is a fact
    this script needs to report, not recover from.
    """
    try:
        return git("show", "{0}:{1}".format(ref, path))
    except subprocess.CalledProcessError as exc:
        sys.stderr.write(
            "FAIL: cannot read {0}:{1}\n  {2}\n".format(
                ref, path, (exc.stderr or "").strip()))
        raise SystemExit(2)


def vocabulary(text):
    """The class names, ids and identity hooks a screen uses.

    Deliberately crude: a regex over attributes, not a parser. The question is
    "does this name appear on this screen at all", so a sloppy superset is the
    safe direction. Dropping a name that is genuinely gone is the failure that
    matters, and no amount of parsing precision changes whether a string is
    absent.
    """
    vocab = set()
    for m in re.finditer(r'class\s*=\s*"([^"]*)"', text):
        for cls in m.group(1).split():
            vocab.add("." + cls)
    for m in re.finditer(r'\bid\s*=\s*"([^"]+)"', text):
        vocab.add("#" + m.group(1))
    for hook in HOOKS:
        if re.search(r'\b' + re.escape(hook) + r'\s*=', text):
            vocab.add("[" + hook + "]")
    # The stylesheets and scripts a screen loads ARE part of its treatment: a
    # page that stops loading polish.css stops being on the polished system
    # however intact its markup looks.
    for m in re.finditer(r'(?:href|src)\s*=\s*"([^"]*\.(?:css|js))"', text):
        vocab.add("<" + m.group(1).split("/")[-1] + ">")
    return vocab


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", action="append", default=None,
                    help="a parent ref (repeatable); defaults to both parents")
    ap.add_argument("--result", default="HEAD")
    args = ap.parse_args()
    parents = args.ref or [POLISHED, MAINBASE]
    result = args.result

    res_screens = screens(result)
    if not res_screens:
        print("FAIL: no screens found on {0} under {1}".format(result, DIR))
        print("An empty population prints the same green as a working sweep.")
        return 1
    res_vocab = {p: vocabulary(read(result, p)) for p in res_screens}
    # A name that moved to another screen is a design decision, not a loss, so
    # the set-wide vocabulary is the denominator for "left the product".
    res_all = set().union(*res_vocab.values()) if res_vocab else set()

    total_gone = 0
    for parent in parents:
        label = git("rev-parse", "--short", parent).strip()
        print("=" * 72)
        print("parent {0}  ({1})".format(parent, label))
        print("=" * 72)
        par_screens = screens(parent)
        if not par_screens:
            print("FAIL: no screens on this parent. An empty population is not")
            print("a pass: it prints the same report as a clean reconcile.")
            return 1
        missing_files = [p for p in par_screens if p not in res_screens]
        print("screens on parent: {0}   files absent from result: {1}".format(
            len(par_screens), len(missing_files) or "none"))
        for p in missing_files:
            print("  FILE GONE  {0}".format(p))

        per_screen = collections.OrderedDict()
        gone_set_wide = collections.defaultdict(list)
        for path in par_screens:
            if path not in res_screens:
                continue
            par_v = vocabulary(read(parent, path))
            gone = sorted(par_v - res_vocab[path])
            if gone:
                per_screen[path] = gone
            for name in gone:
                if name not in res_all:
                    gone_set_wide[name].append(path.split("/")[-1])

        print("\n-- names absent from the SAME screen (moved or dropped) --")
        if not per_screen:
            print("  none")
        for path, gone in per_screen.items():
            print("  {0}".format(path.split("/")[-1]))
            print("      {0}".format(", ".join(gone)))

        print("\n-- names absent from the ENTIRE result set (left the product) --")
        if not gone_set_wide:
            print("  none")
        for name, where in sorted(gone_set_wide.items()):
            total_gone += 1
            print("  {0:28s} was on: {1}".format(name, ", ".join(sorted(where))))
        print()

    print("=" * 72)
    print("names that left the product entirely, across both parents: "
          "{0}".format(total_gone))
    print("Each one needs a line in RECONCILE-NOTES.md giving the reason, or")
    print("it is a silent deletion. This script cannot tell those apart.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
