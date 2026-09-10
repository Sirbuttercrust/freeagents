"""Prove the blast-radius preview actually marks the signatures an edit clears.

WHY THIS EXISTS: the brief for the 2026-08-28 money model says "The UI should
make the blast radius of an edit obvious BEFORE it happens." A toast fired
after the click is too late, and a sentence under the list does not say which
marks are at risk. The preview is a :has() hover rule, which is exactly the
kind of thing that silently stops working after an unrelated selector change
and is invisible in a screenshot.

So this drives a real pointer onto a real edit control and reads the computed
style of the signature chips before and during the hover.

Run:  python3 verify_blast_preview.py [base-url]
"""
import json
import os
import sys

# THE DRIVER, WITHOUT AN ENVIRONMENT.
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

BASE = os.environ.get("WF_BASE", "http://127.0.0.1:3111")

# DERIVED, NOT PINNED. This gate pinned agreement.html inline in its goto,
# which is a screen list of one written where verify_coverage.py cannot see
# it: that gate inspects assignments whose value is a literal LIST, so a bare
# string in a goto reads as "no screen loop" and the row looks clean.
#
# The needle is the signature chip the assertion reads. A screen cannot show a
# blast radius without one, so a second screen that grows a signature matrix
# joins the population on its own.
import population                                              # noqa: E402
SCREENS = population.screens_with_source('class="sig')

READ = """
(function () {
  var row = document.querySelectorAll('.terms > li')[0];
  var chip = row.querySelector('.sig.is-signed');
  var cs = getComputedStyle(chip);
  return JSON.stringify({
    border: cs.borderTopColor,
    colour: cs.color,
    background: cs.backgroundColor
  });
})()
"""

HOVER = """
(function () {
  var row = document.querySelectorAll('.terms > li')[0];
  var act = row.querySelector('.act');
  var r = act.getBoundingClientRect();
  return JSON.stringify({x: Math.round(r.left + r.width / 2),
                         y: Math.round(r.top + r.height / 2)});
})()
"""


def _read(b, expr):
    """b.js() may hand back a dict already or a JSON string, depending on how
    the value crosses the CDP boundary. Normalise rather than assume."""
    out = b.js(expr)
    while isinstance(out, str):
        out = json.loads(out)
    return out


def main():
    # AN EMPTY POPULATION IS NOT A PASS. With no screen carrying a signature
    # chip the loop below runs zero times and every assertion is vacuous.
    if not SCREENS:
        print("FAIL  no screen carries a signature chip (needle 'class=\"sig'),")
        print("      so this gate measured nothing. Fix the needle if the")
        print("      markup was renamed, or retire the gate.")
        return 1

    b = Browser()
    failures = []
    print("screens measured: %d of %d on disk, derived by the signature chip"
          % (len(SCREENS), len(population.every_screen())))
    print("itself: %s\n" % " ".join(SCREENS))
    try:
        for screen in SCREENS:
            # THE MATRIX MOVED, 2026-09-09. It was drawn on criteria.html and
            # the reconcile settled it at agreement.html, which is the URL
            # SITEMAP P-11 names. criteria.html is now the superseded stub
            # and has no .terms rows at all, so this gate read a null row and
            # died on a TypeError instead of reporting anything about the
            # blast preview. Deriving the population is what stops the next
            # such move breaking it silently.
            b.goto(BASE + "/" + screen, wait=3.0)

            resting = _read(b, READ)
            point = _read(b, HOVER)
            if not resting or not point:
                failures.append(
                    "%s: could not read the signature matrix. The page must "
                    "carry ul.terms rows with a .sig.is-signed and an .act"
                    % screen)
                continue

            # A real pointer move, not a synthetic class swap. A synthetic
            # class would pass even if the :has() selector were broken.
            b.send("Input.dispatchMouseEvent", type="mouseMoved",
                   x=point["x"], y=point["y"])
            b.send("Runtime.evaluate",
                   expression="new Promise(r=>setTimeout(r,350))",
                   awaitPromise=True)

            hovered = _read(b, READ)

            print("--- %s" % screen)
            print("resting:", resting)
            print("hovered:", hovered)
            print()

            # A NULL READ IS A FAILURE, NOT A CRASH. This file already died
            # once on a TypeError when the matrix moved and the row read null,
            # which reported nothing about the blast preview at all. If the
            # hover removes the chip, say so and move on.
            if not hovered:
                failures.append(
                    "%s: the signature chip could not be read while hovering "
                    "the edit control, so the preview cannot be judged" % screen
                )
                continue

            if hovered == resting:
                failures.append(
                    "%s: hovering the edit control changed nothing on the "
                    "signature chips, so the blast radius is not previewed"
                    % screen
                )

            # The preview must land on the amber that the cleared state uses,
            # not on some other colour that merely differs from resting.
            if "224, 162, 78" not in hovered["background"] and \
               "224, 162, 78" not in hovered["border"]:
                failures.append(
                    "%s: preview colour is not the cleared-state amber: got "
                    "border=%s background=%s"
                    % (screen, hovered["border"], hovered["background"])
                )

            # Moving away must restore it, or the page keeps a false warning
            # up.
            b.send("Input.dispatchMouseEvent", type="mouseMoved", x=5, y=5)
            b.send("Runtime.evaluate",
                   expression="new Promise(r=>setTimeout(r,350))",
                   awaitPromise=True)
            restored = _read(b, READ)
            if restored != resting:
                failures.append(
                    "%s: preview did not clear when the pointer left: %s"
                    % (screen, restored)
                )
    finally:
        b.close()

    if failures:
        print("FAILURES (%d):" % len(failures))
        for f in failures:
            print("  " + f)
        print("\nRESULT: FAIL")
        return 1

    print("blast radius previews on hover, in the cleared-state colour, "
          "and clears when the pointer leaves")
    print("\nRESULT: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
