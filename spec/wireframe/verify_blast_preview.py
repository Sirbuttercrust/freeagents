"""Prove the blast-radius preview actually marks the signatures an edit clears.

WHY THIS EXISTS: the brief for the 2026-08-28 money model says "The UI should
make the blast radius of an edit obvious BEFORE it happens." A toast fired
after the click is too late, and a sentence under the list does not say which
marks are at risk. The preview is a :has() hover rule, which is exactly the
kind of thing that silently stops working after an unrelated selector change
and is invisible in a screenshot.

So this drives a real pointer onto a real edit control and reads the computed
style of the signature chips before and during the hover.

Run:  WEBGRAB_DIR=<path to webgrab dir> python3 verify_blast_preview.py
"""
import json
import os
import sys

WEBGRAB_DIR = os.environ.get("WEBGRAB_DIR")
if not WEBGRAB_DIR:
    print("set WEBGRAB_DIR to the directory holding webgrab.py")
    sys.exit(2)
sys.path.insert(0, os.path.expanduser(WEBGRAB_DIR))

from webgrab import Browser  # noqa: E402

BASE = os.environ.get("WF_BASE", "http://127.0.0.1:3110")

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
    b = Browser()
    failures = []
    try:
        b.goto(BASE + "/criteria.html", wait=3.0)

        resting = _read(b, READ)
        point = _read(b, HOVER)

        # A real pointer move, not a synthetic class swap. A synthetic class
        # would pass even if the :has() selector were broken.
        b.send("Input.dispatchMouseEvent", type="mouseMoved",
               x=point["x"], y=point["y"])
        b.send("Runtime.evaluate", expression="new Promise(r=>setTimeout(r,350))",
               awaitPromise=True)

        hovered = _read(b, READ)

        print("resting:", resting)
        print("hovered:", hovered)
        print()

        if hovered == resting:
            failures.append(
                "hovering the edit control changed nothing on the signature "
                "chips, so the blast radius is not previewed"
            )

        # The preview must land on the amber that the cleared state uses, not
        # on some other colour that merely differs from resting.
        if "224, 162, 78" not in hovered["background"] and \
           "224, 162, 78" not in hovered["border"]:
            failures.append(
                "preview colour is not the cleared-state amber: got border=%s "
                "background=%s" % (hovered["border"], hovered["background"])
            )

        # Moving away must restore it, or the page keeps a false warning up.
        b.send("Input.dispatchMouseEvent", type="mouseMoved", x=5, y=5)
        b.send("Runtime.evaluate", expression="new Promise(r=>setTimeout(r,350))",
               awaitPromise=True)
        restored = _read(b, READ)
        if restored != resting:
            failures.append(
                "preview did not clear when the pointer left: %s" % restored
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
