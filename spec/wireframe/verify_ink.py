#!/usr/bin/env python3
"""verify_ink.py - every character a person reads meets WCAG AA, measured.

WHY THIS GATE REPLACES AN EXEMPTION LIST
========================================

The previous contrast pass lifted the greys that a sampler reported, then
wrote an exemption in flow.css naming what was allowed to stay quiet: row
numbers, the `edit` control, the column headers. Review found the exemption
was too wide. `edit` is the only control that reopens a signed line of an
agreement, and the column headers name whose signature each column carries.
Neither is scaffolding, and both were sitting at 3.72:1 where AA needs 4.5.

An exemption list is a judgement call written down, so it fails the same way
every time: whoever writes it decides which text is "structural", and the next
reader disagrees. This gate deletes the argument by measuring the DEFINITION
instead:

    If it renders characters, it meets AA. If it renders no characters, it is
    not text and this gate ignores it.

A dashed ring, a rule, a disc, a border: no characters, not measured. "01",
"edit", "Term", "You": characters, measured, no exemption available.

HOW THE BACKGROUND IS OBTAINED, AND WHY THE OLD ARTIFACT CANNOT RECUR
=====================================================================

Reading a pixel where text is painted samples the glyph or its antialiasing,
not the surface behind it. That is what produced the two false alarms this
tree already argued about: a filled button reporting 1.01, and a translucent
accent row reporting 1.31 because its alpha was never composited.

Both are the same bug. The instrument guessed at the background.

So this gate does not guess and does not composite by hand. It makes every
glyph transparent, leaving every background, gradient, border and fill exactly
where it was, and photographs the page. The pixel where the text used to sit
IS the background, whatever produced it: a gradient, an ancestor's alpha, a
button's own fill, an image. Then the ink is composited over that measured
colour using its real alpha.

There is nothing left for the instrument to be wrong about, so no finding
from this gate needs a disproof, and no exemption is needed to silence one.

Five points are sampled across each text run and the WORST is kept, so a
gradient or a partial overlay is caught at its worst point rather than
averaged into a pass.

WHICH SCREENS: ALL OF THEM, DERIVED FROM THE DIRECTORY
======================================================

This gate used to name eight screens while DESIGN.md 2.5, BUILD-STATE.md and
the gate table all asserted AA of the whole set. Twenty-five screens on disk
had never been measured by it, and the hole was invisible from the green
table because a list that does not mention a file cannot fail on it.

`population.every_screen()` reads the directory, so a screen added next month
is measured the day it lands. See population.py for why a list of names was
the defect rather than a short list of names.

TWO STATES THIS GATE USED TO MEASURE WRONG, both found by widening it
=====================================================================

Both are the same mistake in different clothes: photographing a composite of
surfaces that a person never sees at the same time.

  1. CONTENT THAT HAS NOT REVEALED YET. wireframe.js hides `.reveal` and
     `.stagger` at opacity 0 until an IntersectionObserver fires, and this
     gate photographed 0.6 seconds after load. Everything below the first
     viewport was still invisible, so the photograph read the page background
     through an invisible card and reported a badge's dark ink at 1.01
     against it. Twelve findings on browse and operator were this.

     The COLLECT script skipped an element whose OWN opacity was under 0.05
     and never looked at an ancestor, which is why the text was collected
     while its card was invisible.

  2. AN OVERLAY PANEL FORCE-OPENED OVER THE PAGE. OPEN_ALL opened every
     <details>, which includes the header account menu, whose `.avatardrop`
     is `position: absolute` with a solid fill. The photograph then showed
     the panel sitting over the primary button behind it, and the gate
     composited the button's ink against the PANEL. A person opening the
     account menu is not simultaneously reading the button underneath it.

     Measured on myagents.html: menu closed, the button photographs
     rgb(124,124,255) and rates 5.79. Force-opened, rgb(14,15,17) and 1.03.

The rule both fixes share, and it is the same one `tapfloor.py` already
applies to dialogs: measure a state a person can actually be in. In-flow
disclosures push the page and can all be open together, so they are. An
out-of-flow panel covers what is behind it, so it is opened ALONE and
measured scoped to its own subtree, exactly like a modal.

DEPENDENCIES: none. Standard library, plus wirebrowse.py beside this file and
any Chrome. The PNG decoder below exists so that this gate does not need
Pillow, sharp, or npm. A reviewer with a clone and python3 can run it.

    python3 devserver.py 3111 &
    python3 verify_ink.py http://127.0.0.1:3111

Exit 0 all text passes, 1 a real failure, 3 no browser on this machine.
"""

import base64
import json
import os
import struct
import sys
import time
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import population                                             # noqa: E402
from wirebrowse import require_browser, NO_BROWSER_EXIT     # noqa: E402

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3111"

# Every screen on disk. Never a list: see the module docstring and
# population.py. verify_coverage.py fails this file if it becomes one again.
SCREENS = population.every_screen()

# WF_ONLY limits a run to named screens. For the mutation suite only, which
# plants a defect on one known page and would otherwise pay for a full
# 33-screen sweep to see it. Deliberately an environment variable rather than
# an argument: it must never look like a supported way to narrow the gate, and
# verify_all.py does not set it.
_only = [s.strip() for s in os.environ.get("WF_ONLY", "").split(",") if s.strip()]
if _only:
    SCREENS = [s for s in SCREENS if s in _only]

VIEWPORTS = [("desktop", 1280, 900, False), ("mobile", 320, 640, True)]


# ------------------------------------------------------------------ WCAG

def _chan(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def luminance(rgb):
    return (0.2126 * _chan(rgb[0]) + 0.7152 * _chan(rgb[1])
            + 0.0722 * _chan(rgb[2]))


def ratio(fg, bg):
    a, b = luminance(fg), luminance(bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


def over(fg_rgba, bg_rgb):
    """Source-over composite. Ink alpha against the measured background."""
    r, g, b, a = fg_rgba
    return (r * a + bg_rgb[0] * (1 - a),
            g * a + bg_rgb[1] * (1 - a),
            b * a + bg_rgb[2] * (1 - a))


def threshold(px, weight):
    """WCAG 1.4.3. Large text is 24px, or 18.66px when bold."""
    if px >= 24 or (px >= 18.66 and weight >= 700):
        return 3.0
    return 4.5


# ------------------------------------------------------- minimal PNG reader
# Chrome writes 8-bit non-interlaced RGB or RGBA. That is the only case
# handled, and anything else raises rather than returning a wrong pixel.

def png_decode(data):
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, idat, meta = 8, [], None
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if kind == b"IHDR":
            w, h, depth, colour, comp, filt, interlace = struct.unpack(
                ">IIBBBBB", body)
            if depth != 8 or colour not in (2, 6) or interlace != 0:
                raise ValueError(
                    "unsupported PNG: depth=%d colour=%d interlace=%d"
                    % (depth, colour, interlace))
            meta = (w, h, 4 if colour == 6 else 3)
        elif kind == b"IDAT":
            idat.append(body)
        elif kind == b"IEND":
            break
        pos += 12 + length
    if meta is None:
        raise ValueError("PNG had no IHDR")
    w, h, bpp = meta
    raw = zlib.decompress(b"".join(idat))
    stride = w * bpp
    out = bytearray(h * stride)
    prev = bytearray(stride)
    src = 0
    for y in range(h):
        ftype = raw[src]
        src += 1
        line = bytearray(raw[src:src + stride])
        src += stride
        if ftype == 1:                                   # Sub
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif ftype == 2:                                 # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:                                 # Average
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:                                 # Paeth
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        elif ftype != 0:
            raise ValueError("bad PNG filter %d" % ftype)
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, bpp, bytes(out)


class Image(object):
    def __init__(self, blob):
        self.w, self.h, self.bpp, self.px = png_decode(blob)

    def at(self, x, y):
        x, y = int(x), int(y)
        if not (0 <= x < self.w and 0 <= y < self.h):
            return None
        i = (y * self.w + x) * self.bpp
        return (self.px[i], self.px[i + 1], self.px[i + 2])


# ------------------------------------------------------------ page scripts

# Every element carrying at least one non-blank DIRECT text node, measured at
# the TEXT NODE's own rects rather than the element's box.
#
# WHY A RANGE AND NOT getBoundingClientRect. An element's box is not where its
# characters are. The brand link holds an accent-filled mark beside the word
# "FreeAgents", so sampling across the anchor's box reads the mark and reports
# white-on-accent at 3.19, which is a fact about the square and not about the
# word. Same trap on any row whose text sits beside a panel, an icon or a
# number. A Range around the text node returns the glyph boxes themselves, so
# every sample lands on a pixel the characters actually occupy.
#
# This is the same class of error as the two artifacts this tree already
# argued about, and it was caught by this gate reporting nonsense about its
# own page. An instrument gets audited before its findings do.
COLLECT = r"""
(function (scopeSel) {
  var out = [], root = scopeSel ? document.querySelector(scopeSel) : document.body;
  if (!root) return { items: [], docW: 0, docH: 0 };
  var all = root.querySelectorAll('*');
  var list = [root];
  for (var q = 0; q < all.length; q++) list.push(all[q]);
  for (var i = 0; i < list.length; i++) {
    var el = list[i];
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
    if (el.tagName === 'DIALOG' && !el.open) continue;
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (parseFloat(cs.opacity) < 0.05) continue;
    var fs = parseFloat(cs.fontSize);
    // font-size 0 renders no characters. The mobile brand does this to keep
    // the word in the accessibility tree while showing only the mark.
    if (!(fs > 0.5)) continue;
    var hidden = false;
    for (var p = el; p; p = p.parentElement) {
      if (p.hidden) { hidden = true; break; }
      if (p.tagName === 'DETAILS' && !p.open && !el.closest('summary')) {
        hidden = true; break;
      }
      // AN ANCESTOR'S OPACITY HIDES THIS TEXT TOO, and checking only the
      // element's own was this gate's largest wrong-number source. The
      // scroll-in system parks a whole card at opacity 0 until it reveals,
      // and its children each report opacity 1. Collected in that state, the
      // photograph reads the page background straight through the invisible
      // card and reports a badge's dark ink against it at 1.01.
      //
      // The sweep waits past the reveal before collecting, so this should
      // now find nothing. It stays because "should" is what round 4 was:
      // if a future element is invisible for any reason, its measurement is
      // a fact about a surface nobody can see.
      var po = parseFloat(getComputedStyle(p).opacity);
      if (!isNaN(po) && po < 0.05) { hidden = true; break; }
    }
    if (hidden) continue;
    var m = cs.color.match(/[\d.]+/g);
    if (!m) continue;
    for (var n = 0; n < el.childNodes.length; n++) {
      var node = el.childNodes[n];
      if (node.nodeType !== 3) continue;
      var words = node.nodeValue;
      if (!words.trim()) continue;
      var range = document.createRange();
      range.selectNodeContents(node);
      var rects = range.getClientRects();
      for (var k = 0; k < rects.length; k++) {
        var r = rects[k];
        if (r.width < 2 || r.height < 2) continue;
        out.push({
          tag: el.tagName,
          cls: (el.className && el.className.toString ?
                el.className.toString() : '').slice(0, 44),
          text: words.trim().replace(/\s+/g, ' ').slice(0, 34),
          color: [ +m[0], +m[1], +m[2], m.length > 3 ? +m[3] : 1 ],
          px: fs,
          weight: parseInt(cs.fontWeight, 10) || 400,
          x: r.left, y: r.top, w: r.width, h: r.height
        });
      }
    }
  }
  return { items: out,
           docW: document.documentElement.scrollWidth,
           docH: document.documentElement.scrollHeight };
})(SCOPE)
"""

# Glyphs vanish, everything that paints a surface stays. text-shadow too, or a
# glow would tint the pixel the gate is about to call a background.
HIDE_INK = r"""
(function () {
  var s = document.createElement('style');
  s.id = '__inkoff';
  s.textContent = '*,*::before,*::after{color:transparent!important;' +
    '-webkit-text-fill-color:transparent!important;' +
    'text-shadow:none!important;text-decoration-color:transparent!important;' +
    'caret-color:transparent!important}';
  document.head.appendChild(s);
  return 1;
})()
"""

SHOW_INK = "(function(){var s=document.getElementById('__inkoff');" \
           "if(s)s.remove();return 1;})()"

# OPEN_ALL used to force every <details> open, including the header account
# menu, whose panel is position:absolute over the page. That composited a
# panel onto the button behind it and produced two confident wrong numbers.
#
# So the disclosures are split by whether the panel is IN FLOW. Measured
# across the whole set before this was written: every out-of-flow panel
# leaves scrollHeight unchanged when it opens, and every in-flow one changes
# it, so this is a definition rather than a heuristic about class names.
#
#   in flow      pushes the page down, coexists with everything, and a
#                person can have them all open at once. Opened together.
#   out of flow  covers what is behind it. Opened ALONE, and measured
#                scoped to its own subtree, exactly as a <dialog> is.
OPEN_INFLOW = r"""
(function () {
  var n = 0;
  document.querySelectorAll('details').forEach(function (d) {
    var panel = null;
    for (var i = 0; i < d.children.length; i++) {
      if (d.children[i].tagName !== 'SUMMARY') { panel = d.children[i]; break; }
    }
    if (panel) {
      var pos = getComputedStyle(panel).position;
      if (pos === 'absolute' || pos === 'fixed') return;   // an overlay
    }
    if (!d.open) { d.open = true; n++; }
  });
  document.querySelectorAll('[data-disclose]').forEach(function (btn) {
    var t = document.getElementById(btn.getAttribute('data-disclose'));
    if (!t || !t.hidden) return;
    var pos = getComputedStyle(t).position;
    if (pos === 'absolute' || pos === 'fixed') return;
    btn.click(); n++;
  });
  return n;
})()
"""

# Each overlay disclosure, by a selector that opens exactly one of them.
OVERLAY_IDS = r"""
(function () {
  var out = [], i = 0;
  document.querySelectorAll('details').forEach(function (d) {
    var panel = null;
    for (var k = 0; k < d.children.length; k++) {
      if (d.children[k].tagName !== 'SUMMARY') { panel = d.children[k]; break; }
    }
    if (!panel) return;
    var pos = getComputedStyle(panel).position;
    if (pos !== 'absolute' && pos !== 'fixed') return;
    if (!panel.id) panel.id = '__ovl' + (i++);
    out.push({ panel: panel.id, cls: d.className || d.tagName });
  });
  return JSON.stringify(out);
})()
"""

OPEN_ONE_OVERLAY = """(function(id){
  var p = document.getElementById(id);
  if (!p) return 0;
  var d = p.closest('details');
  if (d) d.open = true;
  return 1;
})(%s)"""

CLOSE_ONE_OVERLAY = """(function(id){
  var p = document.getElementById(id);
  if (!p) return 0;
  var d = p.closest('details');
  if (d) d.open = false;
  return 1;
})(%s)"""

# Kept under its old name so nothing else in the tree silently loses its
# open-everything behaviour: only this gate needed the split.
OPEN_ALL = OPEN_INFLOW

DIALOG_IDS = "[].map.call(document.querySelectorAll('dialog')," \
             "function(d){return d.id;})"


def sample_points(it, ox, oy):
    """Five points along the run's middle line, in image coordinates.

    INSET FROM THE EDGES, and the number is not arbitrary. A Range's client
    rect ends at the text run's advance width, which for a right-aligned run
    is flush against its container's padding edge. Sampling at `x + w - 1`
    then lands on whatever draws that boundary, and `.pane` draws a 1px rim
    highlight there.

    That produced the last false failure this gate reported: the agreement's
    `$300 of $1,200` read 6.92, 6.99, 6.92, 6.99 at its first four points and
    3.64 at the fifth, which sat on the rim. Hand arithmetic from the tokens
    says --fg-2 on a pane is 6.95, so four points were right and the fifth was
    measuring a border.

    Two pixels of inset clears a 1px rim and its antialiasing while staying
    well inside any run wide enough to read. A run narrower than 6px is a
    single character or a fragment, and for those the mid point is the only
    honest sample there is.
    """
    cy = oy + it["y"] + it["h"] / 2.0
    inset = 2.0 if it["w"] >= 6 else it["w"] / 2.0
    x0, x1 = ox + it["x"] + inset, ox + it["x"] + it["w"] - inset
    if x1 <= x0:
        cx = ox + it["x"] + it["w"] / 2.0
        return [(cx, cy)]
    step = (x1 - x0) / 4.0
    return [(x0 + step * k, cy) for k in range(5)]


def measure(b, img, items, ox=0, oy=0):
    """Worst ratio per text run, against the pixel actually behind it."""
    rows = []
    for it in items:
        worst, bg_at = None, None
        for (px, py) in sample_points(it, ox, oy):
            bg = img.at(px, py)
            if bg is None:
                continue
            r = ratio(over(it["color"], bg), bg)
            if worst is None or r < worst:
                worst, bg_at = r, bg
        if worst is None:
            continue
        need = threshold(it["px"], it["weight"])
        rows.append((worst, need, it, bg_at))
    return rows


def capture_page(b, docW, docH):
    r = b.send("Page.captureScreenshot", format="png",
               captureBeyondViewport=True,
               clip={"x": 0, "y": 0, "width": docW,
                     "height": min(docH, 16000), "scale": 1})
    return Image(base64.b64decode(r["data"]))


def capture_viewport(b):
    r = b.send("Page.captureScreenshot", format="png")
    return Image(base64.b64decode(r["data"]))


def collect(b, scope=None):
    """Text runs, either page-wide or scoped to one open dialog's subtree."""
    expr = COLLECT.replace("SCOPE", "'%s'" % scope if scope else "null")
    return b.js(expr)


# Adding the finished-state class, and separately COUNTING what is still
# invisible. Two scripts on purpose, because the count has to happen after
# the page has settled.
#
# The first version did both in one call and reported 66 invisible text nodes
# on a page that had none: `.reveal` finishes over a 0.5s transition, so
# reading opacity in the same breath as adding the class measures the first
# frame of the reveal rather than its end. That is the same mistake as
# reading rects before the drawer finishes opening, one function apart.
REVEAL_JS = r"""
(function () {
  document.querySelectorAll('.reveal, .stagger').forEach(function (el) {
    el.classList.add('is-in');
  });
  return document.querySelectorAll('.reveal, .stagger').length;
})()
"""

# How much TEXT is still invisible when the sweep is about to photograph.
#
# COUNTING TEXT AND NOT ELEMENTS IS THE POINT. An earlier version counted any
# element under opacity 0.05 and returned 91 on browse.html: 90 decorative SVG
# particles in the ambient agent layer, which are transparent because they are
# mid-fade, plus one narration line. Not one renders a character, so not one is
# this gate's business, and failing on them would have made the assertion noise
# that the next person switches off.
#
# So it counts what verify_ink measures: a text node a person reads, sitting
# in a subtree the page has left invisible.
STILL_HIDDEN_JS = r"""
(function () {
  var hidden = 0;
  var walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var node;
  while ((node = walk.nextNode())) {
    if (!node.nodeValue.trim()) continue;
    var el = node.parentElement;
    if (!el || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
    var eff = 1;
    for (var p = el; p; p = p.parentElement) {
      var o = parseFloat(getComputedStyle(p).opacity);
      if (!isNaN(o)) eff *= o;
      if (eff < 0.05) break;
    }
    if (eff >= 0.05) continue;
    /* Legitimately not painted right now, and not a reveal that stalled:
       a closed dialog, a hidden subtree, a display:none branch. Those are
       already skipped by COLLECT and are not a measurement hazard. */
    var excused = false;
    for (var q = el; q; q = q.parentElement) {
      var cs = getComputedStyle(q);
      if (cs.display === 'none' || cs.visibility === 'hidden') { excused = true; break; }
      if (q.hidden) { excused = true; break; }
      if (q.tagName === 'DIALOG' && !q.open) { excused = true; break; }
      if (q.tagName === 'DETAILS' && !q.open) { excused = true; break; }
    }
    if (!excused) hidden++;
  }
  return hidden;
})()
"""


def reveal_all(b, settle=0.45):
    """Put the scroll-in content into its finished state before measuring.

    WHY A GATE HAS TO DO THIS, and it produced twelve wrong numbers before it
    was here. wireframe.js parks `.reveal` and `.stagger` at opacity 0 and
    reveals each as an IntersectionObserver fires, with a 3 second
    unconditional backstop. Photographing 0.6 seconds after load captures
    every card below the fold while it is still invisible, and a photograph
    of an invisible card is the page background, so the gate composited badge
    ink against `--bg` and reported 1.01 where the real value is 5.79.

    Adding the class rather than sleeping 3 seconds: this is 33 screens times
    2 viewports, so a sleep would add three and a half minutes to a suite a
    reviewer has to be willing to run. The class is the same one the page's
    own observer adds.

    The count is taken AFTER settling, not in the same call that adds the
    class. `.reveal` finishes over a 0.5s transition, so reading opacity
    immediately measures the first frame of the reveal and reports content as
    invisible when it is on its way in. Returns the number of text nodes a
    person still cannot see.
    """
    b.js(REVEAL_JS)
    settle_page(b, settle)
    return int(b.js(STILL_HIDDEN_JS) or 0)


# Is the layout STILL? Two reads of the same geometry, and they must agree.
LAYOUT_SIG = ("(document.documentElement.scrollHeight + 'x' + "
              "document.documentElement.scrollWidth + ':' + "
              "[].map.call(document.querySelectorAll("
              "'main *, .acard, .drawer, section'), function (e) {"
              "  var r = e.getBoundingClientRect();"
              "  return Math.round(r.top) + ',' + Math.round(r.height);"
              "}).join('|'))")


def settle_page(b, seconds=0.45):
    """Wait, then confirm nothing is still moving.

    A REPAIR THAT DOES NOT ASSERT ITS OWN EFFECT IS A HOPE. This was the
    largest wrong-number source left after the reveal fix, and a plain sleep
    would have looked identical whether or not it was long enough.

    `.drawer` is a `.reveal-h`, which opens by transitioning
    grid-template-rows from 0fr to 1fr. Opening it and reading immediately
    gives rects from a page mid-animation: measured on browse.html at 1280,
    the first card sat at y=446 when the rects were read and at y=623 when
    the photograph was taken, 177px later. Every sample below the drawer then
    landed on whatever had moved into that coordinate, which is how a card
    description got measured against an amber badge it does not touch.

    So this waits and then PROVES the page is still, by comparing two reads
    of the whole layout's geometry. Returns True when settled.
    """
    deadline = time.time() + max(seconds, 0.2) + 2.5
    b.send("Runtime.evaluate",
           expression="new Promise(r=>setTimeout(r,%d))" % int(seconds * 1000),
           awaitPromise=True)
    prev = b.js(LAYOUT_SIG)
    while time.time() < deadline:
        b.send("Runtime.evaluate",
               expression="new Promise(r=>setTimeout(r,120))", awaitPromise=True)
        now = b.js(LAYOUT_SIG)
        if now == prev:
            return True
        prev = now
    return False


def run():
    fails, checked, screens_done = [], 0, 0
    states, unrevealed = 0, 0
    unsettled = []
    print("=" * 78)
    print("verify_ink.py  every rendered character against WCAG AA")
    print("=" * 78)

    for label, w, h, mobile in VIEWPORTS:
        b = require_browser(width=w, height=h, mobile=mobile, touch=mobile)
        try:
            for s in SCREENS:
                b.goto("%s/%s" % (BASE, s), wait=0.6)
                left = reveal_all(b)
                unrevealed = max(unrevealed, left)
                opened = int(b.js(OPEN_INFLOW) or 0)
                states += opened
                # The drawer opens over ~300ms. Reading rects before it has
                # finished and photographing after gives two different pages.
                if not settle_page(b):
                    unsettled.append("%s [%s] after opening %d disclosure(s)"
                                     % (s, label, opened))

                info = collect(b)
                if not info or not info["items"]:
                    fails.append("%s [%s]: no text collected, page did not load"
                                 % (s, label))
                    continue
                items = info["items"]
                b.js(HIDE_INK)
                img = capture_page(b, info["docW"], info["docH"])
                b.js(SHOW_INK)

                rows = measure(b, img, items)
                checked += len(rows)
                worst_row = min(rows, key=lambda r: r[0]) if rows else None

                # An OUT-OF-FLOW disclosure panel covers the page behind it,
                # so it gets the same treatment as a modal: opened alone,
                # measured scoped to its own subtree. Opening it with the
                # page and photographing the composite is what reported a
                # correct 5.79 primary button as 1.03.
                for ov in json.loads(b.js(OVERLAY_IDS) or "[]"):
                    pid = ov["panel"]
                    b.js(OPEN_ONE_OVERLAY % json.dumps(pid))
                    states += 1
                    settle_page(b, 0.2)
                    oinfo = collect(b, scope="#" + pid)
                    oitems = oinfo["items"] if oinfo else []
                    b.js(HIDE_INK)
                    oimg = capture_viewport(b)
                    b.js(SHOW_INK)
                    orows = measure(b, oimg, oitems)
                    checked += len(orows)
                    for row in orows:
                        if row[0] + 0.005 < row[1]:
                            fails.append(_fmt(s, label + "/" + ov["cls"], row))
                    b.js(CLOSE_ONE_OVERLAY % json.dumps(pid))

                # Dialogs render in the TOP LAYER, positioned against the
                # viewport, so they get their own viewport-coordinate pass.
                #
                # Scoped to the dialog's own subtree on purpose. The page
                # behind an open modal sits under a ::backdrop that dims it,
                # and measuring it there reports a failure against text no
                # one can read or reach while the modal is up. That page was
                # already measured in its own right on the pass above.
                for did in (b.js(DIALOG_IDS) or []):
                    if not did:
                        continue
                    b.js("(function(){var d=document.getElementById('%s');"
                         "if(d&&!d.open)d.showModal();return 1;})()" % did)
                    states += 1
                    settle_page(b, 0.2)
                    dinfo = collect(b, scope="#" + did)
                    ditems = dinfo["items"] if dinfo else []
                    b.js(HIDE_INK)
                    dimg = capture_viewport(b)
                    b.js(SHOW_INK)
                    drows = measure(b, dimg, ditems)
                    checked += len(drows)
                    for row in drows:
                        if row[0] + 0.005 < row[1]:
                            fails.append(_fmt(s, label + "/" + did, row))
                    b.js("(function(){var d=document.getElementById('%s');"
                         "if(d&&d.open)d.close();return 1;})()" % did)

                for row in rows:
                    if row[0] + 0.005 < row[1]:
                        fails.append(_fmt(s, label, row))

                screens_done += 1
                wr = ("%.2f" % worst_row[0]) if worst_row else "n/a"
                print("  %-18s %-8s %3d runs   worst %s"
                      % (s, label, len(rows), wr))
        finally:
            b.close()

    print("\n" + "-" * 78)
    print("screens measured:   %d of %d on disk, derived from the directory"
          % (len(SCREENS), len(population.every_screen())))
    print("text runs measured: %d across %d screen loads" % (checked, screens_done))
    # STATES OPENED IS A FIRST-CLASS LINE ON PURPOSE. A gate that opens
    # nothing and a gate that opens everything print the same green result,
    # and this count is the only thing on the face of the output that
    # separates them. A zero here says so out loud.
    print("states opened:      %d (in-flow disclosures, overlay panels alone,"
          " each dialog alone)" % states)
    print("content still hidden after the reveal, worst screen: %d elements"
          % unrevealed)
    print("pages that would not settle:  %d" % len(unsettled))
    if unsettled:
        for u in unsettled:
            print("  " + u)
        print("\nFAIL: the layout was still moving when the rects were read, so")
        print("the rects and the photograph describe two different pages.")
        return 1
    if unrevealed:
        print("\nFAIL: content was still at opacity 0 when the page was")
        print("photographed, so every number above it is a measurement of the")
        print("page background rather than of a surface a person can see.")
        return 1
    if fails:
        print("\nFAILURES: %d" % len(fails))
        for f in fails:
            print("  " + f)
        print("\nEach line is ink composited over the pixel MEASURED behind it,")
        print("with glyphs made transparent before the capture. There is no")
        print("sampler guess here to disprove: fix the colour.")
        return 1
    print("PASS: every rendered character on every screen in this directory")
    print("      meets AA at both viewports, with the scroll-in content")
    print("      revealed, in-flow disclosures open, and each overlay panel")
    print("      and each dialog measured alone in its own scope.")
    return 0


def _fmt(screen, label, row):
    got, need, it, bg = row
    return ("%s [%s] %s.%s %.0fpx  %.2f < %.2f  ink=rgba%s bg=rgb%s  %r"
            % (screen, label, it["tag"].lower(), it["cls"].split(" ")[0],
               it["px"], got, need, tuple(it["color"]), bg, it["text"]))


if __name__ == "__main__":
    try:
        sys.exit(run())
    except SystemExit:
        raise
    except Exception as exc:                       # noqa: BLE001
        print("verify_ink.py ERROR: %s: %s" % (type(exc).__name__, exc))
        sys.exit(2)
