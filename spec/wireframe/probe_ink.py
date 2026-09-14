#!/usr/bin/env python3
"""What is actually behind the agreement row text? Measured, not guessed.

verify_ink.py reported 14 failures on agreement.html, all the same run:
white .txt at 2.09:1 over rgb(224,162,78), the amber --sig-open. Amber
appears in exactly two places on this screen, so before changing a colour
this asks the page which one the sampler is standing on.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wirebrowse import Browser, NoBrowser

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3111"

PROBE = r"""
(function(){
  var out = [];
  document.querySelectorAll('ul.terms > li').forEach(function(li, i){
    var t = li.querySelector('.txt');
    if(!t) return;
    var r = t.getBoundingClientRect();
    var lcs = getComputedStyle(li);
    // The five x positions verify_ink samples across a run.
    var xs = [];
    for (var k = 0; k < 5; k++) xs.push(r.left + (r.width - 1) * (k / 4));
    var y = r.top + r.height / 2;
    var hits = xs.map(function(x){
      var el = document.elementFromPoint(x, y);
      return el ? (el.tagName.toLowerCase() + '.' + (el.className || '').toString().split(' ')[0]) : 'none';
    });
    out.push({
      row: i + 1,
      cleared: li.classList.contains('is-cleared'),
      borderLeft: lcs.borderLeftWidth + ' ' + lcs.borderLeftColor,
      paddingLeft: lcs.paddingLeft,
      marginLeft: lcs.marginLeft,
      txtLeft: Math.round(r.left),
      liLeft: Math.round(li.getBoundingClientRect().left),
      sampledElements: hits,
      text: t.textContent.replace(/\s+/g, ' ').trim().slice(0, 34)
    });
  });
  return JSON.stringify(out);
})()
"""


def main():
    try:
        b = Browser()
    except NoBrowser as e:
        print("no browser: %s" % e)
        return 3
    try:
        b.goto(BASE + "/agreement.html")
        rows = json.loads(b.js(PROBE) or "[]")
        for r in rows:
            print("row %s  cleared=%-5s  border-left: %s" % (r["row"], r["cleared"], r["borderLeft"]))
            print("        li.left=%s  txt.left=%s  padding-left=%s  margin-left=%s"
                  % (r["liLeft"], r["txtLeft"], r["paddingLeft"], r["marginLeft"]))
            print("        sampled: %s" % ", ".join(r["sampledElements"]))
            print("        %r" % r["text"])
            print()
    finally:
        b.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
