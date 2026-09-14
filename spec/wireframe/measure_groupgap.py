"""Does a facet group still read as a group after the 44px floor?

Scratch instrument. Raising eleven 29px labels to 44px closes the visual gap
between the last item of one group and the next group's heading, and a list
whose groups have stopped separating is a real defect that no tap-target gate
can see. The rule of thumb this checks: the space before a heading has to be
clearly larger than the space between two items in the same group, or the
heading reads as another row.

    python3 measure_groupgap.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from webgrab import Browser
except ImportError:
    from wirebrowse import Browser
import tapfloor

BASE = os.environ.get("WF_BASE", "http://127.0.0.1:3111/")

PROBE = """(function(){
  /* MEASURE TEXT TO TEXT, NOT BOX TO BOX.

     With a 44px floor the labels are contiguous, so a box-gap probe reports 0
     between every pair of items and any ratio built on it is meaningless. What
     a reader actually sees is the distance between one line of text and the
     next, so measure the TEXT NODE rects with a Range. Same reason the ink
     gate measures text nodes: an element box includes padding a reader cannot
     see. */
  function textRect(el) {
    var r = document.createRange();
    r.selectNodeContents(el);
    var rects = [].slice.call(r.getClientRects()).filter(function (x) {
      return x.width > 0 && x.height > 0;
    });
    r.detach && r.detach();
    if (!rects.length) return null;
    return {top: Math.min.apply(null, rects.map(function (x) { return x.top; })),
            bottom: Math.max.apply(null, rects.map(function (x) { return x.bottom; }))};
  }

  var out = [];
  document.querySelectorAll('.drawer > div').forEach(function (group) {
    var h = group.querySelector('h4');
    var labels = [].slice.call(group.querySelectorAll('label'));
    if (!h || labels.length < 2) return;
    var hr = textRect(h);
    var trs = labels.map(textRect).filter(Boolean);
    if (!hr || trs.length < 2) return;
    var gaps = [];
    for (var i = 1; i < trs.length; i++) {
      gaps.push(Math.round(trs[i].top - trs[i - 1].bottom));
    }
    out.push({
      heading: h.textContent.trim(),
      headToFirst: Math.round(trs[0].top - hr.bottom),
      itemGap: Math.round(gaps.reduce(function(a,b){return a+b;}) / gaps.length),
      labelH: Math.round(labels[0].getBoundingClientRect().height),
      lastBottom: Math.round(trs[trs.length - 1].bottom),
      headTop: Math.round(hr.top)
    });
  });
  return JSON.stringify(out);
})()"""

b = Browser(width=320, height=900)
try:
    tapfloor.touch(b, width=320, height=900)
    b.goto(BASE + "browse.html", wait=2.0)
    b.js(tapfloor.OPEN_JS)
    b.send("Runtime.evaluate", expression="new Promise(r=>setTimeout(r,400))",
           awaitPromise=True)
    groups = json.loads(b.js(PROBE))
finally:
    b.close()

print("%-22s %7s %8s %9s" % ("group", "labelH", "itemGap", "head gap"))
print("-" * 50)
prev_bottom = None
worst = None
for g in groups:
    before = g["headTop"] - prev_bottom if prev_bottom is not None else None
    print("%-22s %7d %8d %9s"
          % (g["heading"], g["labelH"], g["itemGap"],
             before if before is not None else "first"))
    if before is not None:
        ratio = before / max(g["itemGap"], 1)
        worst = min(worst, ratio) if worst is not None else ratio
    prev_bottom = g["lastBottom"]

print("\nA heading reads as a heading when the space before it clearly exceeds")
print("the space between two items in a group. Worst ratio here: %s"
      % ("%.1fx" % worst if worst is not None else "n/a"))
