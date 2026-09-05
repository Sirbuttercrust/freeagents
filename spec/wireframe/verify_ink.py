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

DEPENDENCIES: none. Standard library, plus wirebrowse.py beside this file and
any Chrome. The PNG decoder below exists so that this gate does not need
Pillow, sharp, or npm. A reviewer with a clone and python3 can run it.

    python3 devserver.py 3111 &
    python3 verify_ink.py http://127.0.0.1:3111

Exit 0 all text passes, 1 a real failure, 3 no browser on this machine.
"""

import base64
import os
import struct
import sys
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wirebrowse import require_browser, NO_BROWSER_EXIT     # noqa: E402

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3111"

SCREENS = ["hire.html", "agreement.html", "deposit.html", "staged.html",
           "pullrequest.html", "outcomes.html", "operatorjob.html",
           "conduct.html"]

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

OPEN_ALL = r"""
(function () {
  document.querySelectorAll('details').forEach(function (d) { d.open = true; });
  return document.querySelectorAll('details').length;
})()
"""

DIALOG_IDS = "[].map.call(document.querySelectorAll('dialog')," \
             "function(d){return d.id;})"


def sample_points(it, ox, oy):
    """Five points along the run's middle line, in image coordinates."""
    cy = oy + it["y"] + it["h"] / 2.0
    x0, x1 = ox + it["x"] + 1, ox + it["x"] + it["w"] - 1
    if x1 <= x0:
        x1 = x0 + 1
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


def run():
    fails, checked, screens_done = [], 0, 0
    print("=" * 78)
    print("verify_ink.py  every rendered character against WCAG AA")
    print("=" * 78)

    for label, w, h, mobile in VIEWPORTS:
        b = require_browser(width=w, height=h, mobile=mobile, touch=mobile)
        try:
            for s in SCREENS:
                b.goto("%s/%s" % (BASE, s), wait=0.6)
                b.js(OPEN_ALL)

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
    print("text runs measured: %d across %d screen loads" % (checked, screens_done))
    if fails:
        print("\nFAILURES: %d" % len(fails))
        for f in fails:
            print("  " + f)
        print("\nEach line is ink composited over the pixel MEASURED behind it,")
        print("with glyphs made transparent before the capture. There is no")
        print("sampler guess here to disprove: fix the colour.")
        return 1
    print("PASS: every rendered character meets AA at both viewports,")
    print("      with all disclosures open and every dialog opened.")
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
