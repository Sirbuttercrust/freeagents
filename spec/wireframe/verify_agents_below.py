"""Prove no decorative agent ever covers text or a control.

THE LAW: decorative layers sit BELOW content, dimmed. An effect that competes
with content is a defect.

WHY A SCRIPT AND NOT A RULE: base.css already carried
`.perch-host > *:not(.perch-layer) { z-index: 2 }`, which protects the
content INSIDE the host box and does nothing for anything below it. The perch
layer is `overflow: visible`, so agents fly well past the host's bottom edge
and land on whatever section follows. On index.html they landed on the screen
cards, on top of their titles. A rule that was being followed in theory,
caught only by looking at pixels.

The test walks each screen carrying agents, reads every agent's live box, and
asserts that any text or control it overlaps is painted ABOVE it. Overlap
itself is fine and is the whole charm of the choreography; overlap that
obscures is the defect.

Run with the wireframe served on 8821:
    python3 verify_agents_below.py
"""
import sys, os, json, time

_wg = os.environ.get("WEBGRAB_DIR", os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _wg)
try:
    from webgrab import Browser
except ImportError:
    sys.exit("webgrab.py not found. Set WEBGRAB_DIR to the directory containing it.")

BASE = os.environ.get("WF_BASE", "http://127.0.0.1:3110/")
SCREENS = ["index.html", "browse.html"]

PROBE = """(function(){
  var layer = document.querySelector('.perch-layer');
  if (!layer) return JSON.stringify({ agents: 0, offenders: [] });

  var svgs = [].slice.call(layer.querySelectorAll('svg')).filter(function(s){
    return s.className.baseVal !== 'perch-dust';
  });

  /* Every element that carries words or is a control. */
  var content = [].slice.call(document.querySelectorAll(
    'h1,h2,h3,h4,p,a,button,label,input,li,dt,dd,span.name,.title,.desc'
  )).filter(function(e){
    if (layer.contains(e)) return false;
    var r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    return (e.textContent || '').trim().length > 0 || e.tagName === 'INPUT';
  });

  function paintedAbove(el, agent){
    /* Sample the centre of the overlap and ask the browser which element wins.
       elementsFromPoint returns front to back, so the content must appear
       before the agent's layer for the content to be on top. */
    var a = agent.getBoundingClientRect(), b = el.getBoundingClientRect();
    var x = (Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2;
    var y = (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return true;  // offscreen
    var stack = document.elementsFromPoint(x, y);
    var iContent = -1, iLayer = -1;
    for (var i = 0; i < stack.length; i++) {
      if (iContent < 0 && (stack[i] === el || el.contains(stack[i]))) iContent = i;
      if (iLayer < 0 && layer.contains(stack[i])) iLayer = i;
    }
    if (iLayer < 0) return true;        // agent not painted here at all
    if (iContent < 0) return false;     // agent covers it and content never surfaces
    return iContent < iLayer;           // content in front wins
  }

  var offenders = [];
  svgs.forEach(function(s){
    var a = s.getBoundingClientRect();
    if (a.width <= 0) return;
    content.forEach(function(e){
      var b = e.getBoundingClientRect();
      var over = !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
      if (!over) return;
      if (!paintedAbove(e, s)) {
        offenders.push({
          text: (e.textContent || '').trim().slice(0, 34) || e.tagName,
          tag: e.tagName
        });
      }
    });
  });

  return JSON.stringify({ agents: svgs.length, offenders: offenders.slice(0, 8) });
})()"""

fails = []
rows = []

b = Browser(width=1280, height=900)
try:
    for s in SCREENS:
        b.goto(BASE + s, wait=3.0)
        # Sample repeatedly: the agents move, so a single frame proves nothing.
        seen = []
        agents = 0
        for shot in range(6):
            b.js("window.scrollTo(0, %d)" % (shot * 260))
            time.sleep(0.7)
            d = json.loads(b.js(PROBE))
            agents = max(agents, d["agents"])
            for o in d["offenders"]:
                if o["text"] not in [x["text"] for x in seen]:
                    seen.append(o)
        rows.append((s, agents, len(seen)))
        if seen:
            fails.append("%s: agents cover content %s" % (s, [o["text"] for o in seen[:5]]))
finally:
    b.close()

print("%-16s %8s %10s" % ("screen", "agents", "covered"))
print("-" * 36)
for s, a, c in rows:
    print("%-16s %8d %10d" % (s, a, c))

if fails:
    print("\nFAILURES (%d):" % len(fails))
    for f in fails:
        print("  " + f)
else:
    print("\nno agent covers any text or control, across 6 scroll positions per screen")

print("\nRESULT: " + ("PASS" if not fails else "FAIL"))
sys.exit(0 if not fails else 1)
