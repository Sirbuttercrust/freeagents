"""Measure VISIBLE prose density per screen, so a simplification pass targets
the worst pages instead of whichever one was looked at last.

Builder notes are hidden behind a toggle and must not count: they are for the
factory, not the end user. This walks the rendered page and reads only what a
person actually sees.

Reports, per screen:
  chars     total visible text
  words     visible word count
  para      paragraphs over 140 chars, the ones that read as a wall
  longest   the single longest run of prose
  blocks    how many separate text blocks carry the load

Run with the wireframe served on 3110:
    python3 measure_prose.py
"""
import sys, os, json

_wg = os.environ.get("WEBGRAB_DIR", os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _wg)
try:
    from webgrab import Browser
except ImportError:
    sys.exit("webgrab.py not found. Set WEBGRAB_DIR to the directory containing it.")

BASE = os.environ.get("WF_BASE", "http://127.0.0.1:3110/")
SCREENS = [
    "index.html", "browse.html", "agent.html", "operator.html", "credential.html",
    "verify.html", "how.html", "signin.html", "dashboard.html", "hire.html",
    "criteria.html", "confirm.html", "job.html", "myjobs.html", "review.html",
    "myagents.html", "listagent.html", "agentsettings.html", "provegithub.html",
    "priorwork.html", "claim.html", "incoming.html", "settings.html", "keys.html",
    "notfound.html", "error.html",
]

PROBE = """(function(){
  function visible(el){
    var s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.05) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /* Only leaf-ish text carriers, so a paragraph is not counted again through
     every ancestor that wraps it. */
  var nodes = [].slice.call(document.querySelectorAll('p, li, dd, .desc, .sub, .lede, .what, blockquote'));
  var blocks = [];
  nodes.forEach(function(el){
    if (!visible(el)) return;
    if (el.closest('.note')) return;          // builder notes: hidden, not user text
    var t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (t.length < 2) return;
    blocks.push(t);
  });

  var body = (document.body.innerText || '').replace(/\\s+/g, ' ').trim();
  var noteChars = 0;
  [].slice.call(document.querySelectorAll('.note')).forEach(function(n){
    noteChars += (n.innerText || '').length;
  });

  var longs = blocks.filter(function(t){ return t.length > 140; });
  return JSON.stringify({
    chars: blocks.reduce(function(a,b){ return a + b.length; }, 0),
    words: blocks.reduce(function(a,b){ return a + b.split(' ').length; }, 0),
    blocks: blocks.length,
    para140: longs.length,
    longest: blocks.length ? Math.max.apply(null, blocks.map(function(t){ return t.length; })) : 0,
    worst: longs.sort(function(a,b){ return b.length - a.length; }).slice(0,2).map(function(t){ return t.slice(0,120); })
  });
})()"""

rows = []
b = Browser(width=1280, height=900)
try:
    for s in SCREENS:
        b.goto(BASE + s, wait=1.6)
        d = json.loads(b.js(PROBE))
        d["screen"] = s
        rows.append(d)
finally:
    b.close()

rows.sort(key=lambda r: -r["chars"])

print("%-20s %7s %7s %7s %8s %8s" % ("screen", "chars", "words", "blocks", "para140", "longest"))
print("-" * 62)
for r in rows:
    print("%-20s %7d %7d %7d %8d %8d" % (
        r["screen"], r["chars"], r["words"], r["blocks"], r["para140"], r["longest"]))

print("\ntotal visible prose: %d chars across %d screens" % (
    sum(r["chars"] for r in rows), len(rows)))

print("\nWORST OFFENDERS (paragraphs over 140 chars):")
for r in rows[:8]:
    if r["worst"]:
        print("\n  %s  (%d long paragraphs)" % (r["screen"], r["para140"]))
        for w in r["worst"]:
            print("    %s..." % w)
