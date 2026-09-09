"""The 44px floor, measured once, in one place, by every gate that claims it.

WHY THIS FILE EXISTS, and it is the third round of the same defect:

  round 1  verify_polish.py read `r.height` and never `r.width`, so a control
           20px wide and 44px tall passed. 13 real failures sat behind it.
  round 2  the axes were fixed and the SELECTOR was left at `a,button`, so no
           input, select, textarea or label was ever measured, and no gate
           opened a disclosure, a drawer or a details element before reading.
           12 more real failures sat behind THAT.

Both times the fix was applied to the instance the reviewer named while three
copies of the same probe, each with its own selector list and its own idea of
the WCAG exemption, stayed in the tree. So the probe now lives here and the
gates import it. There is one selector list, one set of exemptions, and one
definition of which states get opened before reading.

  verify_polish.py    imports it   (27 screens, the polished set)
  measure_taps.py     imports it   (all 33 screens, prints every offender)
  verify_flow.py      imports it   (the 8 payment screens)

WHAT IT MEASURES

  selector   a[href], button, input, select, textarea, summary, label,
             and anything carrying an interactive ARIA role or a positive
             tabindex. Not `a,button`.
  axes       BOTH. A floor on one axis is not a floor.
  states     closed, then every disclosure/details/aria-expanded control
             opened together, then each <dialog> opened on its own. Every
             offender is reported with the state it was found in, so the
             failure names how to reach it.
  profile    a real touch profile, asserted with matchMedia before any number
             is trusted. Desktop Chrome sized to 320px does not match
             (pointer: coarse) and returns a clean pass on a layout with no
             floors at all.

THE EXEMPTIONS ARE DESIGN.md 5.3, MEASURED RATHER THAN ASSUMED

  1. a link inside a sentence. WCAG 2.5.8 exempts it and padding it to 44px
     wrecks the paragraph. An inline formatting context is BOUNDED BY BLOCK
     BOXES, so the walk stops at the first block-level sibling. Three looser
     definitions were tried and each excused a real defect; they are listed on
     inSentence() below.
  2. a radio or checkbox whose label clears the floor ON BOTH AXES. The 13px
     dot is not the target, the label is. A label 292px wide and 29px tall
     does NOT clear it, which is the whole of round 3's D7: eleven facet
     checkboxes and a notification toggle were being read as exempt by a
     rule that only ever existed for labels like deposit's 292x133 rail rows.
  3. a field label above its control, where the control clears the floor. The
     label is a caption; giving a caption a 44px box puts dead space between
     every label and its field.

Nothing else. If it renders and it is interactive, it meets the floor.
"""

import json

FLOOR = 43.5   # 44px, with half a pixel for subpixel layout

# One selector list. Adding an interactive element type here covers every gate
# at once, which is the point.
SELECTOR = (
    'a[href], button, input, select, textarea, summary, label, '
    '[role="button"], [role="tab"], [role="switch"], [role="checkbox"], '
    '[role="radio"], [role="menuitem"], [role="link"], '
    '[tabindex]:not([tabindex="-1"])'
)

PROBE_JS = """(function(){
  var FLOOR = %(floor)s;

  /* IN A SENTENCE: WCAG 2.5.8, tested against the property the exemption is
     actually about. Three wrong definitions were tried first and each let a
     different real defect through:

       "display starts with inline AND the parent holds more text than the
       link"  ->  excused four 71x18 roster names, because a card title on its
       own line above a description is a standalone target that happens to be
       displayed inline.

       "some other text rect overlaps the link's line"  ->  at 320px
       "operated by northline.dev" WRAPS, so the link sits alone on the second
       line and a purely geometric test calls a sentence a standalone control.

       "any inline sibling anywhere in the parent carries text"  ->  excused a
       back link because an inline-flex submit button sat 600px further down
       the same wrapper. Distance in the DOM is not distance in the sentence.

     An inline formatting context is bounded by block boxes, so walk out in
     both directions and stop at the first block-level sibling. */
  function isInline(n) {
    var d = getComputedStyle(n).display;
    return d.indexOf('inline') === 0 || d === 'contents';
  }
  function inSentence(e) {
    if (!e.parentElement) return false;
    function scan(dir) {
      for (var n = e[dir]; n; n = n[dir]) {
        if (n.nodeType === 3) {
          if ((n.nodeValue || '').trim()) return true;
          continue;
        }
        if (n.nodeType !== 1) continue;
        if (!isInline(n)) return false;          /* block box ends the run */
        if ((n.textContent || '').trim()) return true;
      }
      return false;
    }
    return scan('previousSibling') || scan('nextSibling');
  }

  function box(e) { return e.getBoundingClientRect(); }
  function clears(r) { return !!r && r.height >= FLOOR && r.width >= FLOOR; }

  function reachable(e) {
    for (var n = e; n; n = n.parentElement) {
      if (n.hidden) return false;
      if (n.tagName === 'DIALOG' && !n.open) return false;
      var st = getComputedStyle(n);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
    }
    return true;
  }

  /* A STABLE IDENTITY THAT DOES NOT MUTATE THE PAGE.

     The sweep reads a screen closed, then opened, and has to tell "this is
     the same control I already reported" from "this is another one that looks
     identical". Keying on class plus size plus text collapsed eleven distinct
     facet checkboxes into one finding, because they share a class, a size and
     an empty text: an under-report inside the instrument written to fix an
     under-report. A DOM path is exact, and setting a data attribute to mark
     elements would edit the tree being measured. */
  function path(e) {
    var out = [];
    for (var n = e; n && n.parentElement; n = n.parentElement) {
      out.push(Array.prototype.indexOf.call(n.parentElement.children, n));
    }
    return out.reverse().join('/');
  }

  var bad = [];
  var els = document.querySelectorAll(%(selector)s);
  for (var i = 0; i < els.length; i++) {
    var e = els[i];
    if (e.type === 'hidden') continue;
    if (!reachable(e)) continue;
    var r = box(e);
    if (r.width <= 0 || r.height <= 0) continue;
    if (clears(r)) continue;
    if (e.tagName === 'A' && inSentence(e)) continue;

    /* EXEMPTION 2, both axes. DESIGN.md 5.3 names a 244x89 label as the case
       this covers. 292x29 is not that case.

       When the label does NOT clear, the label is still the target: it is
       what a finger lands on and what activates the control. So the finding
       is reported against the LABEL, once, rather than against the dot and
       the label as two separate defects. A checkbox with no label at all
       falls through and is reported on its own, because then the dot really
       is the only target. */
    if (e.tagName === 'INPUT' && (e.type === 'radio' || e.type === 'checkbox')) {
      var lab = e.closest('label') ||
                (e.id ? document.querySelector('label[for="' + e.id + '"]') : null);
      if (lab) continue;
    }

    /* EXEMPTION 3: a caption above a control that clears the floor itself.

       A <label> naming NOTHING is not exempt and not a caption, it is a
       defect: it announces itself as labelling a control that does not
       exist. agentsettings.html had one over a group of swatch buttons. The
       fix is the markup, not an exemption. */
    if (e.tagName === 'LABEL') {
      var f = e.getAttribute('for');
      var c = f ? document.getElementById(f)
                : e.querySelector('input, select, textarea');
      if (c && clears(box(c))) continue;
    }

    bad.push({
      t: (e.textContent || '').trim().slice(0, 24),
      c: (typeof e.className === 'string' && e.className) || e.tagName,
      tag: e.tagName.toLowerCase() + (e.type ? '[' + e.type + ']' : ''),
      p: path(e),
      w: Math.round(r.width), h: Math.round(r.height)
    });
  }
  return JSON.stringify({
    coarse: window.matchMedia('(pointer: coarse)').matches,
    docW: document.documentElement.scrollWidth,
    bad: bad
  });
})()""" % {"floor": FLOOR, "selector": json.dumps(SELECTOR)}


# Open everything a person can open without leaving the page, then report how
# many things actually opened so a gate can say "0 states opened" out loud
# instead of quietly measuring only the closed page.
OPEN_JS = """(function(){
  var n = 0;
  Array.prototype.forEach.call(
    document.querySelectorAll('.disclose, [data-disclose], [aria-expanded="false"], summary'),
    function (el) {
      if (el.tagName === 'SUMMARY') {
        var d = el.parentElement;
        if (d && d.tagName === 'DETAILS' && !d.open) { d.open = true; n++; }
        return;
      }
      el.click();
      n++;
    });
  Array.prototype.forEach.call(document.querySelectorAll('details'), function (d) {
    if (!d.open) { d.open = true; n++; }
  });
  return n;
})()"""

DIALOG_IDS_JS = """(function(){
  return JSON.stringify([].map.call(document.querySelectorAll('dialog'),
    function (d) { return d.id; }).filter(function (x) { return !!x; }));
})()"""


def touch(b, width=320, height=640):
    """Put a browser on a real touch profile. Width alone is not a phone."""
    b.send("Emulation.setDeviceMetricsOverride", width=width, height=height,
           deviceScaleFactor=2, mobile=True)
    b.send("Emulation.setTouchEmulationEnabled", enabled=True, maxTouchPoints=5)


def _settle(b, ms=140):
    b.send("Runtime.evaluate",
           expression="new Promise(r=>setTimeout(r,%d))" % ms, awaitPromise=True)


def sweep(b, url, wait=1.6):
    """Measure one screen in every state a person can reach.

    Returns {"coarse", "docW", "opened", "dialogs", "bad"} where each entry in
    "bad" carries the state it was found in. Raises nothing: a caller that
    wants to fail on `coarse` being false does so itself, loudly.
    """
    b.goto(url, wait=wait)
    first = json.loads(b.js(PROBE_JS))
    out = {"coarse": first["coarse"], "docW": first["docW"],
           "opened": 0, "dialogs": [], "bad": []}
    for x in first["bad"]:
        x["state"] = "closed"
        out["bad"].append(x)

    # every disclosure, drawer and details, together
    out["opened"] = int(b.js(OPEN_JS) or 0)
    if out["opened"]:
        _settle(b)
        after = json.loads(b.js(PROBE_JS))
        seen = set(x["p"] for x in out["bad"])
        for x in after["bad"]:
            if x["p"] in seen:
                continue
            seen.add(x["p"])
            x["state"] = "opened"
            out["bad"].append(x)
        # An open drawer can push the page wider. Report the worse of the two.
        out["docW"] = max(out["docW"], after["docW"])

    # each modal on its own: showModal makes the rest of the document inert,
    # so opening them together measures a state the product cannot produce.
    out["dialogs"] = json.loads(b.js(DIALOG_IDS_JS))
    for d in out["dialogs"]:
        b.js("(function(){var d=document.getElementById('%s');"
             "if(d&&!d.open&&d.showModal)d.showModal();return 1;})()" % d)
        _settle(b, 120)
        r = json.loads(b.js(PROBE_JS))
        for x in r["bad"]:
            x["state"] = "dialog #" + d
            out["bad"].append(x)
        b.js("(function(){var d=document.getElementById('%s');"
             "if(d&&d.open)d.close();return 1;})()" % d)

    return out


def fmt(x):
    """One offender, as a line a person can act on."""
    return "%s %s %dx%d \"%s\" [%s]" % (
        x.get("tag", "?"), (x.get("c") or "")[:26], x["w"], x["h"],
        (x.get("t") or "")[:24], x.get("state", "closed"))
