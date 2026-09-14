#!/usr/bin/env python3
"""Do the agreement rows actually overlap at 320px without the track pinning?

The mutation suite reports "agreement rows overlapping at 320px MISSED". Before
widening a gate, this asks the browser what the rows measure with the pinning
rule in place and with it removed. If nothing overlaps, the mutation introduces
no defect and the honest fix is a better mutation, not a looser gate.

Prints the vertical span of every row plus any pair that shares pixels, which
is the same arithmetic verify_flow.py's OVERLAP_JS does.

    python3 measure_agreement_rows.py [base-url]
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wirebrowse import Browser

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3111"

PROBE = """(() => {
  const rows = [...document.querySelectorAll('ul.terms > li')];
  const boxes = rows.map((r, i) => {
    const kids = [...r.children].map(k => k.getBoundingClientRect())
                                .filter(k => k.width > 0 || k.height > 0);
    const src = kids.length ? kids : [r.getBoundingClientRect()];
    return {i: i + 1,
            top: Math.round(Math.min(...src.map(k => k.top))),
            bottom: Math.round(Math.max(...src.map(k => k.bottom))),
            left: Math.round(Math.min(...src.map(k => k.left))),
            right: Math.round(Math.max(...src.map(k => k.right)))};
  });
  const laps = [];
  for (let a = 0; a < boxes.length; a++) {
    for (let c = a + 1; c < boxes.length; c++) {
      const A = boxes[a], C = boxes[c];
      const o = Math.min(A.bottom, C.bottom) - Math.max(A.top, C.top);
      if (o > 1) laps.push(`row ${A.i} and row ${C.i} share ${Math.round(o)}px`);
    }
  }
  return JSON.stringify({rows: boxes, laps: laps, docW: document.documentElement.scrollWidth});
})()"""


def main():
    b = Browser(width=320, height=640)
    try:
        b.send("Emulation.setDeviceMetricsOverride", width=320, height=640,
               deviceScaleFactor=2, mobile=True)
        b.send("Emulation.setTouchEmulationEnabled", enabled=True, maxTouchPoints=5)
        b.goto(BASE + "/agreement.html", wait=2.0)
        d = json.loads(b.js(PROBE) or "{}")
    finally:
        b.close()

    print("document scrollWidth: %s" % d.get("docW"))
    print("%-5s %-14s %s" % ("row", "vertical", "horizontal"))
    for r in d.get("rows", []):
        print("%-5s %-14s %s"
              % (r["i"], "%s..%s" % (r["top"], r["bottom"]),
                 "%s..%s" % (r["left"], r["right"])))
    laps = d.get("laps", [])
    print("\noverlapping pairs: %d" % len(laps))
    for l in laps:
        print("  " + l)
    return 0


if __name__ == "__main__":
    sys.exit(main())
