"""Probe the dashboard flow rail: does the motion actually run, and does the
rest state survive with animation off?

Written because a screenshot cannot tell the difference between "the light is
animating and this frame caught it at low opacity" and "the light never
painted". Both look like an empty line.

Checks, in both motion modes:
  1. the spark element exists on exactly the .is-now segment of each job
  2. under no-preference: an animation-name is bound and the transform
     actually CHANGES between two samples (a bound animation that is paused
     or zero-length is still a dead rail)
  3. under reduce: no animation is running AND the spark is still painted
     with a non-zero box, i.e. content did not vanish with the motion
  4. the standing ring on the current node is present in BOTH modes
"""
import sys, os, json, time

_wg = os.environ.get("WEBGRAB_DIR", os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _wg)
try:
    from webgrab import Browser
except ImportError:
    sys.exit("webgrab.py not found. Set WEBGRAB_DIR to the directory containing it.")

BASE = os.environ.get("WF_BASE", "http://127.0.0.1:3110/")
URL = BASE + "dashboard.html"

SHAPE = """(function(){
  var jobs = document.querySelectorAll('.jobrow');
  var out = [];
  for (var i = 0; i < jobs.length; i++) {
    var now = jobs[i].querySelector('.flow-step.is-now');
    var sparks = jobs[i].querySelectorAll('.flow-spark');
    var sparkInNow = now ? now.querySelectorAll('.flow-spark').length : 0;
    var r = null, anim = null, ring = null;
    if (sparks.length) {
      var s = sparks[0];
      var b = s.getBoundingClientRect();
      var cs = getComputedStyle(s);
      r = { w: Math.round(b.width), h: Math.round(b.height), op: cs.opacity };
      anim = { name: cs.animationName, play: cs.animationPlayState, dur: cs.animationDuration };
    }
    if (now) {
      var dot = now.querySelector('.flow-dot');
      var ca = getComputedStyle(dot, '::after');
      ring = { border: ca.borderTopWidth, name: ca.animationName, w: ca.width };
    }
    out.push({
      steps: jobs[i].querySelectorAll('.flow-step').length,
      done: jobs[i].querySelectorAll('.flow-step.is-done').length,
      sparks: sparks.length,
      sparkInNow: sparkInNow,
      rect: r, anim: anim, ring: ring,
      nowText: (jobs[i].querySelector('.flow-now') || {}).textContent ?
               jobs[i].querySelector('.flow-now').textContent.trim().slice(0, 60) : null
    });
  }
  return JSON.stringify(out);
})()"""

# Sample the live transform twice. A bound-but-dead animation reports a name
# and never moves, which is exactly the failure a screenshot hides.
SAMPLE = """(function(){
  var s = document.querySelector('.flow-spark');
  if (!s) return 'none';
  return getComputedStyle(s).transform;
})()"""

fails = []

print("=" * 62)
print("MOTION ON  (prefers-reduced-motion: no-preference)")
print("=" * 62)
b = Browser(width=1280, height=900)
try:
    b.goto(URL, wait=2.0)
    data = json.loads(b.js(SHAPE))
    for i, j in enumerate(data):
        print("job %d: steps=%d done=%d sparks=%d sparkInNow=%d"
              % (i, j["steps"], j["done"], j["sparks"], j["sparkInNow"]))
        print("        rect=%s" % j["rect"])
        print("        anim=%s" % j["anim"])
        print("        ring=%s" % j["ring"])
        print("        now: %s" % j["nowText"])
        if j["steps"] != 5:
            fails.append("job %d: expected 5 stages, found %d" % (i, j["steps"]))
        if j["sparks"] != 1:
            fails.append("job %d: expected exactly 1 spark, found %d" % (i, j["sparks"]))
        if j["sparkInNow"] != 1:
            fails.append("job %d: spark is not on the is-now segment" % i)
        if not j["anim"] or j["anim"]["name"] != "flow-run":
            fails.append("job %d: flow-run not bound (%s)" % (i, j["anim"]))
        if j["anim"] and j["anim"]["play"] != "running":
            fails.append("job %d: animation not running (%s)" % (i, j["anim"]["play"]))
        if not j["ring"] or j["ring"]["border"] in ("0px", ""):
            fails.append("job %d: no standing ring on current node" % i)

    # movement proof
    t1 = b.js(SAMPLE)
    time.sleep(0.45)
    t2 = b.js(SAMPLE)
    print("\ntransform sample 1: %s" % t1)
    print("transform sample 2: %s" % t2)
    if t1 == t2:
        fails.append("spark transform did not change over 450ms: rail is dead")
    else:
        print("-> transform CHANGED, the light is genuinely travelling")
finally:
    b.close()

print()
print("=" * 62)
print("MOTION OFF (prefers-reduced-motion: reduce)")
print("=" * 62)
b = Browser(width=1280, height=900)
try:
    b.send("Emulation.setEmulatedMedia",
           features=[{"name": "prefers-reduced-motion", "value": "reduce"}])
    b.goto(URL, wait=2.0)
    data = json.loads(b.js(SHAPE))
    for i, j in enumerate(data):
        print("job %d: sparks=%d" % (i, j["sparks"]))
        print("        rect=%s" % j["rect"])
        print("        anim=%s" % j["anim"])
        print("        ring=%s" % j["ring"])
        if j["anim"] and j["anim"]["name"] not in ("none", ""):
            fails.append("job %d: animation still bound under reduce (%s)"
                         % (i, j["anim"]["name"]))
        # the whole point: content must still be THERE
        if not j["rect"] or j["rect"]["w"] < 1 or j["rect"]["h"] < 1:
            fails.append("job %d: spark has no box under reduce, content vanished" % i)
        if j["rect"] and float(j["rect"]["op"]) < 0.99:
            fails.append("job %d: spark stranded at opacity %s under reduce"
                         % (i, j["rect"]["op"]))
        if not j["ring"] or j["ring"]["border"] in ("0px", ""):
            fails.append("job %d: standing ring missing under reduce" % i)

    t1 = b.js(SAMPLE)
    time.sleep(0.45)
    t2 = b.js(SAMPLE)
    print("\ntransform sample 1: %s" % t1)
    print("transform sample 2: %s" % t2)
    if t1 != t2:
        fails.append("spark still moving under reduced motion")
    else:
        print("-> transform HELD still, and the element is still painted")
finally:
    b.close()

print()
if fails:
    print("FAILURES (%d):" % len(fails))
    for f in fails:
        print("  " + f)
else:
    print("no failures")
print("\nRESULT: " + ("PASS" if not fails else "FAIL"))
sys.exit(0 if not fails else 1)
