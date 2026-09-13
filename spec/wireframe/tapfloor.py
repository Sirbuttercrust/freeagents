"""The mobile laws, measured once, in one place, by every gate that claims them.

WHY THIS FILE EXISTS, and it is the fifth round of the same defect:

  round 1  verify_polish.py read `r.height` and never `r.width`, so a control
           20px wide and 44px tall passed. 13 real failures sat behind it.
  round 2  the axes were fixed and the SELECTOR was left at `a,button`, so no
           input, select, textarea or label was ever measured, and no gate
           opened a disclosure, a drawer or a details element before reading.
           12 more real failures sat behind THAT.
  round 5  the TAP probe was unified here and the OVERFLOW probe was not.
           verify_flow.py kept an element-level check over 8 screens while
           verify_polish.py asserted only `scrollWidth > 320` over the other
           25. scrollWidth DOES NOT GROW for an element hanging off the LEFT
           edge in an LTR document, so on 25 screens nothing could fail on
           left-side overflow at any magnitude, and two screens were rendering
           the builder-notes control at x=-20 while every gate was green.

Rounds 1, 2 and 5 are one defect: a law asserted of the whole set, enforced by
two instruments, one of them weaker. The first two were fixed by unifying the
probe. Round 5 is what was left over BECAUSE only one of the two probes got
unified, so this module now owns both.

  verify_polish.py    imports it   (25 screens, the polished set)
  measure_taps.py     imports it   (all 33 screens, prints every offender)
  verify_flow.py      imports it   (the 8 payment screens)

ONE FINDINGS LIST, AND THE FALLBACK DIRECTION IS THE WHOLE ARGUMENT

Every assertion this module makes goes into ONE `findings` list, each entry
tagged with its `kind`. A gate fails on the list, not on a key it remembered
to read. So a NEW assertion added here is enforced on every screen every
consumer visits, the day it lands, whether or not anybody updates the gates.

That is population.py's safety argument moved from screens to assertions. A
partition whose fallback is "measured" cannot open a hole; one whose fallback
is "not measured" opens one silently the day somebody adds an assertion to the
instrument they happen to be reading. Opting out has to be WRITTEN DOWN, as a
kind filter that verify_mobile_coverage.py can see and report.

WHAT IT MEASURES

  selector   a[href], button, input, select, textarea, summary, label,
             and anything carrying an interactive ARIA role or a positive
             tabindex. Not `a,button`.
  axes       BOTH. A floor on one axis is not a floor.
  edges      BOTH. `right > W` and `left < 0` are one law, and only the first
             of them is visible in scrollWidth.
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

# The viewport the laws are stated at. Set by touch(), read by the probe
# builder, so a gate that sweeps at another width measures overflow against
# THAT width rather than against a number baked in here.
VIEWPORT = 320

# One selector list. Adding an interactive element type here covers every gate
# at once, which is the point.
SELECTOR = (
    'a[href], button, input, select, textarea, summary, label, '
    '[role="button"], [role="tab"], [role="switch"], [role="checkbox"], '
    '[role="radio"], [role="menuitem"], [role="link"], '
    '[tabindex]:not([tabindex="-1"])'
)

_PROBE_TEMPLATE = """(function(){
  var FLOOR = %(floor)s;
  var W = %(width)s;

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
      kind: 'tap',
      t: (e.textContent || '').trim().slice(0, 24),
      c: (typeof e.className === 'string' && e.className) || e.tagName,
      tag: e.tagName.toLowerCase() + (e.type ? '[' + e.type + ']' : ''),
      p: path(e),
      w: Math.round(r.width), h: Math.round(r.height)
    });
  }

  /* HORIZONTAL OVERFLOW, BOTH EDGES, IN THE SAME PASS AND THE SAME LIST.

     This used to live in verify_flow.py, which meant the 8 payment screens
     got an element-level check and the other 25 got `scrollWidth > 320`.
     scrollWidth does not grow for an element hanging off the LEFT edge in an
     LTR document, so the weaker half of the set could not fail on left
     overflow at any magnitude. Two screens were rendering a control at
     x=-20, reading as `uilder notes`, with every gate green.

     It is in THIS list, tagged, rather than in a second return key, so a gate
     that fails on findings gets it without being taught to look for it. */
  var offenders = document.querySelectorAll('body *');
  for (var j = 0; j < offenders.length; j++) {
    var o = offenders[j];
    var ro = box(o);
    if (ro.width === 0) continue;
    if (!reachable(o)) continue;
    if (ro.right <= W + 0.5) continue;
    bad.push({
      kind: 'overflow',
      t: (o.textContent || '').trim().slice(0, 24),
      c: (typeof o.className === 'string' && o.className) || o.tagName,
      tag: o.tagName.toLowerCase(),
      p: path(o),
      left: Math.round(ro.left), right: Math.round(ro.right),
      w: Math.round(ro.width), h: Math.round(ro.height)
    });
  }

  /* THE CHROME CONTRACT, checked rather than trusted.

     base.css lifts every later sibling of a .perch-host into its own stacking
     context, and page chrome appended to <body> is one of those siblings. That
     rule rewrote `position: fixed` to `relative` on the builder-notes toggle
     and put it at x=-20 on two screens. The fix excludes .chrome from the
     lift, which makes .chrome a promise: this element positions itself.

     A class that carries a promise nothing checks is the same defect one level
     up, so the promise is measured here on every screen every gate visits. Any
     .chrome element computing to static, relative or absolute means some rule
     captured it the way the perch lift did. */
  var chrome = document.querySelectorAll('.chrome');
  for (var k = 0; k < chrome.length; k++) {
    var c = chrome[k];
    if (!reachable(c)) continue;
    var pos = getComputedStyle(c).position;
    if (pos === 'fixed' || pos === 'sticky') continue;
    var rc = box(c);
    bad.push({
      kind: 'chrome',
      t: (c.textContent || '').trim().slice(0, 24),
      c: (typeof c.className === 'string' && c.className) || c.tagName,
      tag: c.tagName.toLowerCase(),
      p: path(c),
      pos: pos,
      left: Math.round(rc.left), right: Math.round(rc.right),
      w: Math.round(rc.width), h: Math.round(rc.height)
    });
  }

  return JSON.stringify({
    coarse: window.matchMedia('(pointer: coarse)').matches,
    docW: document.documentElement.scrollWidth,
    bad: bad
  });
})()"""


def probe_js(width=None):
    """The probe, built for a viewport width.

    A gate sweeping at 320 and a gate sweeping at 360 must use the same
    definition of overflow with a different edge, not two definitions.
    """
    return _PROBE_TEMPLATE % {"floor": FLOOR,
                              "width": VIEWPORT if width is None else width,
                              "selector": json.dumps(SELECTOR)}


# THE ASSERTIONS THIS MODULE MAKES, declared so something can check that a
# consumer receives all of them. verify_mobile_coverage.py reads this by
# importing the module, and reads each gate's filter from its source, so a
# screen swept by an instrument that drops an assertion is reported as the
# hole it is rather than counted as covered.
#
# Adding a kind here without adding it to the probe fails that gate too: the
# declaration and the implementation check each other.
KINDS = ("tap", "overflow", "chrome")

PROBE_JS = probe_js()


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
    "bad" carries the state it was found in and the `kind` of law it broke.
    Raises nothing: a caller that wants to fail on `coarse` being false does so
    itself, loudly.

    DEDUPED BY (kind, DOM path) ACROSS EVERY STATE, keeping the state a finding
    was FIRST reachable in. A page-level control is still measurable while a
    modal is open (showModal makes the rest inert, not invisible), so without
    this every page-level offender is re-reported once per dialog and the real
    finding inside the dialog hides in the repeats. Keying on class plus size
    plus text instead would collapse eleven distinct facet checkboxes into one,
    which is the under-report this instrument exists to prevent.
    """
    b.goto(url, wait=wait)
    first = json.loads(b.js(PROBE_JS))
    out = {"coarse": first["coarse"], "docW": first["docW"],
           "opened": 0, "dialogs": [], "bad": []}
    seen = set()

    def take(records, state):
        for x in records:
            key = (x.get("kind", "tap"), x["p"])
            if key in seen:
                continue
            seen.add(key)
            x["state"] = state
            out["bad"].append(x)

    take(first["bad"], "closed")

    # every disclosure, drawer and details, together
    out["opened"] = int(b.js(OPEN_JS) or 0)
    if out["opened"]:
        _settle(b)
        after = json.loads(b.js(PROBE_JS))
        take(after["bad"], "opened")
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
        take(r["bad"], "dialog #" + d)
        out["docW"] = max(out["docW"], r["docW"])
        b.js("(function(){var d=document.getElementById('%s');"
             "if(d&&d.open)d.close();return 1;})()" % d)

    return out


def of_kind(records, kind):
    """The findings of one kind. A gate that wants only one still says so."""
    return [x for x in records if x.get("kind", "tap") == kind]


def fmt(x):
    """One offender, as a line a person can act on.

    An overflow finding prints its EDGES, because -20..81 and 300..401 are
    different bugs and a width alone does not separate them.
    """
    if x.get("kind") == "overflow":
        return "%s %s @%d..%d [%s]" % (
            x.get("tag", "?"), (x.get("c") or "")[:26],
            x.get("left", 0), x.get("right", 0), x.get("state", "closed"))
    if x.get("kind") == "chrome":
        return "%s %s position:%s @%d..%d [%s]" % (
            x.get("tag", "?"), (x.get("c") or "")[:26], x.get("pos", "?"),
            x.get("left", 0), x.get("right", 0), x.get("state", "closed"))
    return "%s %s %dx%d \"%s\" [%s]" % (
        x.get("tag", "?"), (x.get("c") or "")[:26], x["w"], x["h"],
        (x.get("t") or "")[:24], x.get("state", "closed"))
