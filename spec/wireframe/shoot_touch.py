"""Screenshot a screen on a real touch profile, optionally with states opened.

Scratch instrument. The 44px floors are gated on (pointer: coarse), so a
desktop screenshot shows none of them and a desktop screenshot is what makes a
tap-target fix look like it changed nothing. This is what to look at after
raising a floor: the rows have to stay balanced at the size where the rule
applies.

    python3 shoot_touch.py settings.html /tmp/settings-touch.png
    python3 shoot_touch.py browse.html /tmp/browse-drawer.png --open
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from webgrab import Browser
except ImportError:
    from wirebrowse import Browser
import tapfloor

BASE = os.environ.get("WF_BASE", "http://127.0.0.1:3111/")
page = sys.argv[1] if len(sys.argv) > 1 else "settings.html"
out = sys.argv[2] if len(sys.argv) > 2 else "/tmp/touch.png"
open_states = "--open" in sys.argv

b = Browser(width=320, height=900)
try:
    tapfloor.touch(b, width=320, height=900)
    b.goto(BASE + page, wait=2.0)
    if open_states:
        n = b.js(tapfloor.OPEN_JS)
        b.send("Runtime.evaluate", expression="new Promise(r=>setTimeout(r,400))",
               awaitPromise=True)
        print("states opened: %s" % n)
    print("coarse: %s" % b.js("window.matchMedia('(pointer: coarse)').matches"))
    b.shot(out, full=True)
    print("wrote %s" % out)
finally:
    b.close()
