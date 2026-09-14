#!/usr/bin/env python3
"""Measure the notes toggle at 320px on a real touch profile.

The mutation suite reports "notetoggle tap target MISSED", meaning the floor
can be deleted from base.css and every gate still passes. Before changing a
gate, this asks the browser what the control actually measures with the floor
in place and with it gone, because a mutation that introduces no defect is a
bad mutation rather than a gap in coverage.

    python3 measure_notetoggle.py [base-url]
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wirebrowse import Browser

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3111"

PROBE = """(function(){
  var b = document.querySelector('.notetoggle');
  if (!b) return JSON.stringify({missing: true});
  var r = b.getBoundingClientRect();
  var cs = getComputedStyle(b);
  return JSON.stringify({
    w: Math.round(r.width * 10) / 10,
    h: Math.round(r.height * 10) / 10,
    minHeight: cs.minHeight,
    tag: b.tagName.toLowerCase(),
    text: (b.textContent || '').trim().slice(0, 24)
  });
})()"""


def main():
    b = Browser(width=320, height=640)
    try:
        b.send("Emulation.setDeviceMetricsOverride", width=320, height=640,
               deviceScaleFactor=2, mobile=True)
        b.send("Emulation.setTouchEmulationEnabled", enabled=True, maxTouchPoints=5)
        for page in ("agreement.html", "deposit.html", "index.html"):
            b.goto(BASE + "/" + page, wait=1.8)
            d = json.loads(b.js(PROBE) or "{}")
            if d.get("missing"):
                print("%-18s no .notetoggle on this page" % page)
                continue
            verdict = "OK" if d["h"] >= 44 and d["w"] >= 44 else "UNDER THE 44px FLOOR"
            print("%-18s %sx%s  min-height:%s  %s  %r"
                  % (page, d["w"], d["h"], d["minHeight"], verdict, d["text"]))
    finally:
        b.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
