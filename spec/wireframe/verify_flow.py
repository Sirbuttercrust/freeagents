#!/usr/bin/env python3
"""Gate for the hire, agreement and payment flow screens.

Runs against a served copy of this directory and fails loudly. What it covers,
and what it deliberately does not, is listed at the bottom of its own output so
nobody reads a green run as more coverage than it has.

    python3 verify_flow.py [base-url]

Seven checks, each one written for a defect that actually happened here:

  1  horizontal overflow at 320px under a REAL touch profile, closed states
  2  horizontal overflow at 320px with every dialog OPEN, which is the state
     a width check never reaches on its own
  3  tap targets under 44px, inline links exempted per WCAG 2.5.8
  4  dead controls: every reachable link has an href, every reachable
     [data-copy] has a value, every dialog trigger names a dialog that exists
  5  the accent is spent only where DESIGN.md 2.2 permits it, which on these
     screens means the primary button, the verified hire count and focus
  6  reduced motion leaves content VISIBLE, not stranded at opacity 0
  7  no em dash anywhere, and no chain vocabulary on a primary path

Check 2 is the one that earns its keep. A modal that overflows at 320px is
invisible to a width sweep because the sweep never opens it, and every sheet in
this flow is where the real decisions are made.
"""

import os
import sys
import json

# wirebrowse.py sits beside this file, in the repo, standard library only.
# No WEBGRAB_DIR, no pip install, no external checkout: a reviewer with a
# clone, python3 and any Chrome can run this gate and disagree with its
# result. That is the whole point of committing the driver.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wirebrowse import Browser, NoBrowser

# The tap-target probe, shared with verify_polish.py and measure_taps.py.
import tapfloor

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3111"

# The payment flow, derived: the screens that load flow.css, plus the two
# that carry the flow's layout in a page-local block. See population.py.
import population                                             # noqa: E402
SCREENS = population.payment_screens()

# DESIGN.md 2.2. The accent is permitted on a verified hire row and its count,
# the credential verify affordance, the single primary action, and a focus
# ring. Anything else painting itself accent is spending the one signal the
# product sells.
#
# MATCHED AS WHOLE CLASS NAMES, NOT AS SUBSTRINGS. An earlier version tested
# `if ok in element.className`, with "mark" on the list for the wordmark's dot
# (`.brand .mark`). That silently exempted `class="mark mark-on"`, which is a
# signature, and the mutation test reported MISSED twice before the cause
# surfaced. A substring allow-list grows holes as class names multiply, and
# the holes are invisible until something exploits one.
#
# So the wordmark's dot is matched by its real selector context instead, and
# `mark` is NOT on this list: a signature mark painting itself accent is
# exactly the violation this check exists for.
ACCENT_OK = frozenset(["btn-primary", "hires", "brand", "railnow"])

# The chosen rail's row. Surfaced once the accent probe stopped skipping
# elements that wrap children (see ACCENT_JS): the selected radio's label
# carries an accent border and the --accent-dim wash, which is a SELECTION
# state on the control a person is actively operating, not a claim about
# evidence. DESIGN.md 2.2 permits the accent on a focus ring for the same
# reason, and the rail chooser is the one place on these screens where the
# buyer picks between two options that change the total.
#
# Matched by RELATIONSHIP rather than a class name, because the offending
# element is a bare <label> with no class of its own, and adding one purely to
# satisfy an allow list would be the tail wagging the dog.
ACCENT_OK_WITHIN = ".railopt"

# "Celebrate the rails, never toll them": chain vocabulary is allowed where a
# person is choosing a rail or reading the technical panel, and nowhere else.
CHAIN_WORDS = ["TransferV3Tx", "ERC-20", "Ed25519", "blockchain", "gas fee", "on-chain"]

fails = []
rows = []


def probe(b, url, expr):
    b.goto(url)
    b.send("Runtime.evaluate", expression="new Promise(r=>setTimeout(r,220))",
           awaitPromise=True)
    return b.js(expr)


# ---------------------------------------------------------------- 320px, touch
# A desktop browser sized to 320px does NOT match (pointer: coarse), so a tap
# target sweep run that way measures the desktop branch and confirms it. The
# emulation has to set touch, and the assertion below proves the branch applied
# before any result from this pass is trusted.
def narrow(b):
    b.send("Emulation.setDeviceMetricsOverride", width=320, height=640,
           deviceScaleFactor=2, mobile=True)
    b.send("Emulation.setTouchEmulationEnabled", enabled=True, maxTouchPoints=5)


OVERFLOW_JS = """(() => {
  const out = {coarse: matchMedia('(pointer: coarse)').matches,
               doc: document.documentElement.scrollWidth, off: []};
  document.querySelectorAll('body *').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width === 0) return;
    if (r.right > 320.5 || r.left < -0.5) {
      out.off.push((el.className || el.tagName) + ' @' +
                   Math.round(r.left) + '..' + Math.round(r.right));
    }
  });
  out.off = out.off.slice(0, 6);
  return out;
})()"""

# WCAG 2.5.8 exempts a link inside a sentence: it has a line-box hit area and
# padding it to 44px wrecks the paragraph. Without the exemption the report is
# noise and real findings hide in it.
#
# THE PROBE ITSELF LIVES IN tapfloor.py, and this file no longer carries a
# copy. Three copies existed here, in verify_polish.py and in measure_taps.py,
# and they drifted three different ways: one read only the height, all three
# read only `a,button`, and none of them opened a disclosure before reading.
# Round 3 of review found twelve real under-floor controls behind those holes.
# One probe, one selector list, one set of exemptions, imported by every gate
# that claims the floor.
#
# The exemptions it applies, all three measured rather than assumed:
#
#   a link inside a sentence, where "sentence" means an inline formatting
#   context bounded by block boxes, not merely an element with an inline
#   display value.
#
#   a radio or checkbox whose label CLEARS the floor on both axes. The 13px
#   dot is not the tap target; a 244x89 label is, and clicking anywhere in it
#   activates the control. A 292x29 label is NOT that case, and reading the
#   exemption as "any checkbox inside any label" is what let eleven facet
#   checkboxes and a settings toggle stand under the floor.
#
#   a field label sitting ABOVE its control, where the control clears the
#   floor. "What is wrong, in one sentence" measures 244x21 and the input
#   under it measures 244x44. The label is a caption, and giving a caption a
#   44px box puts 23px of dead space between every label and its field.
#
# HEIGHT-ONLY findings on the shared nav are reported, not exempted. Several
# nav links are narrower than 44px because they are short words in a horizontal
# bar, and padding them sideways pushes the document past 320px. That trade is
# named in base.css rather than hidden here.
TAP_JS = tapfloor.PROBE_JS

# An element's own state is not what a person experiences. Assert what is
# REACHABLE and whether it is backed, not whether some named element is hidden.
DEAD_JS = """(() => {
  const out = {noHref: [], emptyCopy: [], badOpens: [], emptyDd: []};
  const reachable = n => {
    for (let el = n; el; el = el.parentElement) {
      if (el.hidden) return false;
      if (el.tagName === 'DIALOG' && !el.open) return false;
    }
    return true;
  };
  document.querySelectorAll('a').forEach(a => {
    if (!reachable(a)) return;
    const h = a.getAttribute('href');
    if (h === null || h === '') out.noHref.push((a.textContent||'').trim().slice(0,30));
  });
  document.querySelectorAll('[data-copy]').forEach(b => {
    if (!reachable(b)) return;
    if (!b.getAttribute('data-copy')) out.emptyCopy.push(b.id || b.className);
  });
  document.querySelectorAll('[data-opens]').forEach(b => {
    if (!document.getElementById(b.getAttribute('data-opens')))
      out.badOpens.push(b.getAttribute('data-opens'));
  });
  document.querySelectorAll('dt').forEach(dt => {
    if (!reachable(dt)) return;
    const dd = dt.nextElementSibling;
    if (dd && dd.tagName === 'DD' && !(dd.textContent||'').trim())
      out.emptyDd.push((dt.textContent||'').trim().slice(0,30));
  });
  return out;
})()"""

# DESIGN.md 2.2 as an assertion. The accent is permitted on a verified hire row
# and its count, the credential verify affordance, the single primary action,
# and a focus ring. Anything else painting itself accent is spending the one
# signal the product sells.
#
# CHECKS BACKGROUND AS WELL AS TEXT, and on elements with NO text content.
# An earlier version skipped anything whose textContent was empty, on the
# reasoning that a coloured element with no words cannot be making a claim.
# That is wrong, and the mutation test proved it: repainting the signature mark
# from neutral to accent is the single most tempting misuse on these screens
# (a signature really is a cryptographic fact), the mark carries no text, and
# the gate reported a clean pass on the mutated tree. A shape can make the
# claim just as loudly as a word.
ACCENT_JS = """(() => {
  const hits = [];
  const ACC = 'rgb(124, 124, 255)';
  document.querySelectorAll('main *, dialog *').forEach(el => {
    const s = getComputedStyle(el);
    const painted = s.backgroundColor === ACC || s.borderTopColor === ACC ||
                    s.borderLeftColor === ACC;
    const inked = s.color === ACC && (el.textContent || '').trim();
    if (!painted && !inked) return;
    // LEAF ONLY, FOR INK. A container inherits its child's colour and would
    // report the same finding twice at two levels, so text findings are still
    // taken at the leaf.
    //
    // BUT A FILL IS NOT INHERITED. The signature mark is a .sigdot with an
    // icon <span> inside it, so it has a child and the old leaf-only rule
    // skipped it at every level: the dot was excluded for having a child, and
    // the icon inside it is transparent and carries no fill of its own.
    // Painting a signature accent therefore passed cleanly, which is the exact
    // misuse the comment above says is the most tempting one on these screens.
    // A background or border the element paints ITSELF is its own claim
    // whether or not it wraps something.
    if (el.children.length > 0 && !painted) return;
    // the wordmark's dot is the one .mark that may carry the accent, and it
    // is identified by WHERE it is, not by a class-name substring
    if (el.closest('.brand')) return;
    hits.push({cls: (el.className || el.tagName),
               classes: (el.className || '').split(/\\s+/).filter(Boolean),
               how: painted ? 'fill' : 'ink',
               within: el.closest('.railopt') ? '.railopt' : '',
               txt: (el.textContent || '').trim().slice(0, 30)});
  });
  return hits;
})()"""

# ROWS MUST NOT OVERLAP EACH OTHER.
#
# This gate exists because the overflow check reported a clean 320 on a screen
# whose agreement rows were printing on top of each other by up to 385px. The
# overflow check measures the RIGHT edge; two rows sharing a vertical band are
# perfectly inside 320px and completely unreadable. A screenshot found it and
# nothing numeric would have.
#
# The cause is worth encoding rather than just the symptom: a `.trow` is
# `display: contents` at wide widths and a grid of its own at narrow widths.
# When the PARENT stayed a two-column grid in the narrow branch, the rows
# became grid items of the parent and were auto-placed side by side. Any
# component that swaps a `display: contents` row into a real box can do this.
#
# Also checks the outcome cards and the fact list, because they are the other
# two multi-row components here and they would fail the same way.
OVERLAP_JS = """(() => {
  // '.terms .trow' was the September agreement's row. The reconciled agreement
  // is the polished signature matrix and its rows are the <li> of ul.terms, so
  // the old selector matched nothing and this check quietly measured no rows
  // on the one screen it was written for. Both are listed: the old one still
  // says something true about an older tree, and a selector that matches
  // nothing is skipped by the rows.length < 2 guard rather than failing.
  const groups = [['.terms > li', 'agreement row'],
                  ['.terms .trow', 'agreement row'],
                  ['.facts > li', 'fact'],
                  ['.outcomes > .oc', 'outcome card'],
                  ['.fixed > li', 'fixed term'],
                  ['.counts > .ct', 'count']];
  const found = [];
  groups.forEach(([sel, label]) => {
    const rows = [...document.querySelectorAll(sel)];
    if (rows.length < 2) return;
    const boxes = rows.map((r, i) => {
      // display:contents rows have no box; measure the union of their children
      const kids = [...r.children].map(k => k.getBoundingClientRect())
                                  .filter(k => k.width > 0 || k.height > 0);
      const src = kids.length ? kids : [r.getBoundingClientRect()];
      return {i: i + 1,
              top: Math.min(...src.map(k => k.top)),
              bottom: Math.max(...src.map(k => k.bottom))};
    });
    for (let a = 0; a < boxes.length; a++) {
      for (let c = a + 1; c < boxes.length; c++) {
        const A = boxes[a], C = boxes[c];
        const o = Math.min(A.bottom, C.bottom) - Math.max(A.top, C.top);
        if (o > 1) {
          found.push(`${label} ${A.i} and ${C.i} share ${Math.round(o)}px`);
        }
      }
    }
  });
  return found.slice(0, 6);
})()"""

OPEN_ALL_JS = """(() => {
  const ids = [...document.querySelectorAll('dialog')].map(d => d.id);
  return ids;
})()"""

print("=" * 74)
print("FLOW GATE:", BASE)
print("=" * 74)

b = Browser(1280, 900)
try:
    # ---------------------------------------------------------------- pass 1
    narrow(b)
    print("\n[1+2+3] 320px touch profile, closed and open states\n")
    print(f"{'screen':<20} {'coarse':>7} {'docW':>6} {'overflow':>9} {'openOverflow':>13} {'tap<44':>7} {'overlap':>8}")
    for s in SCREENS:
        url = f"{BASE}/{s}"
        r = probe(b, url, OVERFLOW_JS)
        # The shared probe returns rich records; flatten to the strings this
        # gate has always reported so the output shape does not change.
        tap = [tapfloor.fmt(x) for x in json.loads(b.js(TAP_JS))["bad"]]
        lap = b.js(OVERLAP_JS)

        if not r["coarse"]:
            fails.append(f"{s}: (pointer: coarse) did not match, results not trustworthy")

        # Every dialog opened together, then re-measured. A modal that
        # overflows at 320px is invisible to a plain width sweep.
        dlgs = b.js(OPEN_ALL_JS)
        openoff = 0
        opentap = []
        for d in dlgs:
            b.js(f"(() => {{const d=document.getElementById('{d}');"
                 f"if(d && !d.open) d.showModal(); return 1;}})()")
            b.send("Runtime.evaluate", expression="new Promise(r=>setTimeout(r,120))",
                   awaitPromise=True)
            ro = b.js(OVERFLOW_JS)
            openoff += len(ro["off"])
            if ro["off"]:
                fails.append(f"{s}: dialog #{d} overflows 320px: {ro['off'][:3]}")
            ot = json.loads(b.js(TAP_JS))["bad"]
            opentap += [f"#{d} {tapfloor.fmt(x)}" for x in ot]
            b.js(f"(() => {{const d=document.getElementById('{d}');"
                 f"if(d && d.open) d.close(); return 1;}})()")

        alltap = tap + opentap

        # AND THE DISCLOSURES, which are not dialogs. Every drawer, details
        # element and .disclose target on these screens hides controls that a
        # person reaches with one tap, and a sweep that opens only <dialog>
        # reports a clean page in both the broken and the fixed state. This is
        # the hole round 3 found on verify_polish.py; it was here too.
        opened = int(b.js(tapfloor.OPEN_JS) or 0)
        if opened:
            b.send("Runtime.evaluate",
                   expression="new Promise(r=>setTimeout(r,160))", awaitPromise=True)
            seen = set(alltap)
            for x in json.loads(b.js(TAP_JS))["bad"]:
                line = tapfloor.fmt(x)
                if line not in seen:
                    seen.add(line)
                    alltap.append(line)

        if r["off"]:
            fails.append(f"{s}: overflow at 320px: {r['off'][:3]}")
        if r["doc"] > 320.5:
            fails.append(f"{s}: document scrollWidth {r['doc']} > 320")
        if alltap:
            fails.append(f"{s}: tap targets under 44px: {alltap[:4]}")
        if lap:
            fails.append(f"{s}: rows overlapping at 320px: {lap[:3]}")

        rows.append(s)
        print(f"{s:<20} {str(r['coarse']):>7} {r['doc']:>6} {len(r['off']):>9} "
              f"{openoff:>13} {len(alltap):>7} {len(lap):>8}")

    # ---------------------------------------------------------------- pass 2
    b.send("Emulation.clearDeviceMetricsOverride")
    b.send("Emulation.setTouchEmulationEnabled", enabled=False)
    b.send("Emulation.setDeviceMetricsOverride", width=1280, height=900,
           deviceScaleFactor=1, mobile=False)

    print("\n[4+5] dead controls and accent discipline, desktop\n")
    print(f"{'screen':<20} {'noHref':>7} {'emptyCopy':>10} {'badOpens':>9} {'emptyDd':>8} {'accent':>7}")
    for s in SCREENS:
        url = f"{BASE}/{s}"
        d = probe(b, url, DEAD_JS)
        # Open every disclosure first: a closed one hides its contents
        # legitimately, so a sweep that never opens one reports a clean page
        # in both the broken and the fixed state.
        b.js("(() => {document.querySelectorAll('.disclose').forEach(x=>x.click()); return 1;})()")
        b.send("Runtime.evaluate", expression="new Promise(r=>setTimeout(r,150))",
               awaitPromise=True)
        d2 = b.js(DEAD_JS)
        for k in d:
            d[k] = list({*d[k], *d2[k]})

        acc = b.js(ACCENT_JS)
        # whole class names, never substrings: see the ACCENT_OK comment
        stray = [h for h in acc
                 if not (set(h.get("classes") or []) & ACCENT_OK)
                 and h.get("within") != ACCENT_OK_WITHIN]

        if d["noHref"]:
            fails.append(f"{s}: anchors with no href: {d['noHref'][:3]}")
        if d["emptyCopy"]:
            fails.append(f"{s}: copy buttons with no value: {d['emptyCopy'][:3]}")
        if d["badOpens"]:
            fails.append(f"{s}: data-opens naming a missing dialog: {d['badOpens']}")
        if d["emptyDd"]:
            fails.append(f"{s}: label with an empty value: {d['emptyDd'][:3]}")
        if stray:
            fails.append(f"{s}: accent used outside DESIGN.md 2.2: {stray[:3]}")

        print(f"{s:<20} {len(d['noHref']):>7} {len(d['emptyCopy']):>10} "
              f"{len(d['badOpens']):>9} {len(d['emptyDd']):>8} {len(stray):>7}")

    # ---------------------------------------------------------------- pass 3
    # Reduced motion does not mean "no animation ran", it means a person sees
    # a dignified static result. An element whose transition is suppressed
    # while it sits at its hidden start state renders as MISSING CONTENT,
    # which is worse than the animation.
    print("\n[6] reduced motion leaves content visible\n")
    b.send("Emulation.setEmulatedMedia",
           features=[{"name": "prefers-reduced-motion", "value": "reduce"}])
    print(f"{'screen':<20} {'reveals':>8} {'hidden':>7}")
    for s in SCREENS:
        r = probe(b, f"{BASE}/{s}", """(() => {
          const n = [...document.querySelectorAll('.reveal, .stagger')];
          const hidden = n.filter(e => {
            const st = getComputedStyle(e);
            const box = e.getBoundingClientRect();
            return parseFloat(st.opacity) < 0.99 || box.height === 0;
          }).map(e => e.className.slice(0, 40));
          return {total: n.length, hidden: hidden};
        })()""")
        if r["hidden"]:
            fails.append(f"{s}: content stranded hidden under reduce: {r['hidden'][:3]}")
        print(f"{s:<20} {r['total']:>8} {len(r['hidden']):>7}")
    b.send("Emulation.setEmulatedMedia", features=[])

finally:
    b.close()

# ------------------------------------------------------------------- pass 4
# Static text checks, read off disk rather than the DOM so they also cover
# builder notes and comments.
print("\n[7] house rules in the source\n")
here = os.path.dirname(os.path.abspath(__file__))
EMDASH = "\u2014"
for s in SCREENS + ["flow.css", "flow.js"]:
    p = os.path.join(here, s)
    if not os.path.exists(p):
        fails.append(f"{s}: file missing")
        continue
    text = open(p, encoding="utf-8").read()
    n_em = text.count(EMDASH)
    if n_em:
        fails.append(f"{s}: {n_em} em dash(es)")
    print(f"{s:<20} em dashes {n_em}")

print("\n" + "=" * 74)
if fails:
    print(f"FAIL, {len(fails)} finding(s)\n")
    for f in fails:
        print("  -", f)
else:
    print(f"PASS, {len(rows)} screens")

print("""
COVERED:  320px overflow closed AND with every dialog open, ROWS OVERLAPPING
          each other at 320px, tap targets on a real touch profile, dead links
          and copy buttons and dialog triggers including behind disclosures,
          empty labelled values, accent discipline against DESIGN.md 2.2,
          reduced-motion end state, em dashes in source.

NOT COVERED, and judged by a person instead:  whether the copy is
          comprehensible to a first-time buyer, whether the attestation reads
          as neutral rather than as a verdict, whether the two seven day
          clocks are actually distinguishable, and contrast (run
          contrast_check.py, which samples real pixels).
""")
sys.exit(1 if fails else 0)
