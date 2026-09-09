"""Every under-floor tap target on all 33 screens, in every reachable state.

Scratch instrument, and the one that prints the offenders. The assertion lives
in verify_polish.py; this is what you run to see WHAT to fix and WHERE.

The probe itself is in tapfloor.py, shared with verify_polish.py and
verify_flow.py, because three copies of it drifted three different ways: one
read only the height, all three read only `a,button`, and none of them opened
a disclosure. Round 3 of review found twelve real failures behind that. One
probe, one selector list, one set of exemptions.

    python3 devserver.py 3111 &
    python3 measure_taps.py
"""
import sys, os, glob

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from webgrab import Browser
except ImportError:
    from wirebrowse import Browser
import tapfloor

BASE = os.environ.get("WF_BASE", "http://127.0.0.1:3111/")
HERE = os.path.dirname(os.path.abspath(__file__))
SCREENS = sorted(os.path.basename(p) for p in glob.glob(os.path.join(HERE, "*.html")))

b = Browser(width=320, height=640)
total = 0
opened_total = 0
try:
    tapfloor.touch(b)
    for s in SCREENS:
        d = tapfloor.sweep(b, BASE + s)
        # ASSERT THE BRANCH APPLIED before trusting one number out of it.
        if not d["coarse"]:
            print("ABORT: (pointer: coarse) did not match on " + s)
            sys.exit(2)
        opened_total += d["opened"]
        if d["bad"]:
            print("===== %s   docW=%s   states opened=%d   dialogs=%d"
                  % (s, d["docW"], d["opened"], len(d["dialogs"])))
            for x in d["bad"]:
                print("   " + tapfloor.fmt(x))
            total += len(d["bad"])
finally:
    b.close()

print("\nstates opened across the sweep: %d" % opened_total)
print("total under-floor controls across %d screens: %d" % (len(SCREENS), total))
sys.exit(0 if total == 0 else 1)
