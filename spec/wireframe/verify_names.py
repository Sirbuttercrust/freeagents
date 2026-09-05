#!/usr/bin/env python3
"""verify_names.py - no two controls on a screen answer to the same name.

WHY. The agreement shipped seven buttons whose entire accessible name was
"edit". Sighted, they are unambiguous: each sits at the end of its own row,
and the row says which line it belongs to. Through a screen reader, or in a
list of a page's controls, they are seven identical entries on the screen
where pressing the wrong one clears both signatures on a line of a paid
agreement. WCAG 2.4.6 asks that a label describe its purpose; a label shared
by seven different purposes cannot.

The screen already knew how to do this. The sign buttons in the same rows
carry "Sign line 6, the price", and every signature mark carries "axiom-ui has
signed line 3". One control was written without a name and inherited its text
instead, which is exactly the defect a person cannot see while looking at the
page, because on the page it is obvious.

WHAT IT MEASURES

Every control a person can reach: links, buttons, and form fields, including
the ones inside dialogs and behind disclosures, since a closed disclosure is
where this hides. For each, the accessible name is computed in the order the
spec uses (aria-labelledby, aria-label, an associated label, the control's own
text, then title), and the results are grouped.

A group of two or more identical names FAILS unless every member points at the
same destination, which is the one legitimate case: a card whose image and
title both link to the same page is one target described twice, not two
targets sharing a description.

The href/target comparison is what keeps this from being noise. Site
navigation repeats "Dashboard" on every screen and that is correct; those all
resolve to the same URL, so they collapse into one entry and never fail.

SCOPING, AND A BUG THIS GATE HAD ON ITS FIRST RUN

The first version opened every dialog at once and compared all the names on
the page together. It reported five failures that are not defects: three
buttons named "Cancel" on the staged screen, three named "Close", and the
operator's "Accept, and take 6 more days" appearing twice.

Every one of those is a state the product cannot produce. `showModal` makes
the rest of the document inert, and each trigger opens exactly one dialog, so
a person is never presented with two of those buttons at the same time. The
gate had invented a screen, then failed the page for it.

So names are grouped per SIMULTANEOUSLY REACHABLE SCOPE: the page with no
dialog open is one scope, and each dialog is another. A dialog's confirm
button is allowed to repeat the wording of the trigger that opened it, which
is the normal shape of a confirmation and reads correctly in sequence.

Worth stating plainly because the first result looked like five real finds,
and shipping them would have sent someone renaming buttons that are already
right. A gate that fabricates a state measures its own fiction.

DEPENDENCIES: none beyond wirebrowse.py beside this file and any Chrome.

    python3 devserver.py 3111 &
    python3 verify_names.py http://127.0.0.1:3111

Exit 0 clean, 1 duplicate names found, 3 no browser.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wirebrowse import require_browser            # noqa: E402

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3111"

SCREENS = ["hire.html", "agreement.html", "deposit.html", "staged.html",
           "pullrequest.html", "outcomes.html", "operatorjob.html",
           "conduct.html"]

CONTROLS = "a[href], button, input, select, textarea, summary, [role=button]"

COLLECT = r"""
(function (scopeSel) {
  document.querySelectorAll('details').forEach(function (d) { d.open = true; });

  var root = scopeSel ? document.querySelector(scopeSel) : document.body;
  if (!root) return [];

  function labelFor(el) {
    var by = el.getAttribute('aria-labelledby');
    if (by) {
      var names = by.split(/\s+/).map(function (id) {
        var t = document.getElementById(id);
        return t ? (t.innerText || t.textContent || '') : '';
      }).join(' ').trim();
      if (names) return names;
    }
    var al = el.getAttribute('aria-label');
    if (al && al.trim()) return al.trim();
    if (el.id) {
      var lab = document.querySelector('label[for="' + el.id + '"]');
      if (lab) {
        var t = (lab.innerText || lab.textContent || '').trim();
        if (t) return t;
      }
    }
    var wrap = el.closest('label');
    if (wrap) {
      var wt = (wrap.innerText || wrap.textContent || '').trim();
      if (wt) return wt;
    }
    var own = (el.innerText || el.textContent || '').trim();
    if (own) return own;
    if (el.getAttribute('title')) return el.getAttribute('title').trim();
    if (el.getAttribute('placeholder')) {
      return el.getAttribute('placeholder').trim();
    }
    return '';
  }

  function reachable(el) {
    for (var p = el; p; p = p.parentElement) if (p.hidden) return false;
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    return true;
  }

  var out = [];
  root.querySelectorAll(SELECTOR).forEach(function (el) {
    // A dialog's contents belong to the dialog's scope, not the page's.
    if (!scopeSel && el.closest('dialog')) return;
    if (!reachable(el)) return;
    if (el.type === 'hidden') return;
    var name = labelFor(el).replace(/\s+/g, ' ').slice(0, 90);
    // A control with NO name is a different defect and a different gate.
    if (!name) return;
    out.push({
      name: name,
      tag: el.tagName.toLowerCase(),
      target: el.getAttribute('href') || el.getAttribute('data-opens') ||
              el.getAttribute('value') || '',
      cls: (el.className && el.className.toString ?
            el.className.toString() : '').slice(0, 30)
    });
  });
  return out;
})(SCOPE)
""".replace("SELECTOR", "'%s'" % CONTROLS)

DIALOG_IDS = "[].map.call(document.querySelectorAll('dialog')," \
             "function(d){return d.id;}).filter(Boolean)"


def collect(b, scope=None):
    return b.js(COLLECT.replace("SCOPE", "'%s'" % scope if scope else "null"))


def dupes_in(items):
    """Names shared by controls that are NOT the same destination."""
    groups = {}
    for it in items:
        groups.setdefault(it["name"], []).append(it)
    found = []
    for name, members in sorted(groups.items()):
        if len(members) < 2:
            continue
        targets = set(m["target"] for m in members)
        if len(targets) == 1 and list(targets)[0]:
            continue
        found.append((name, members))
    return found


def run():
    fails = []
    print("=" * 78)
    print("verify_names.py  duplicate accessible names, per reachable scope")
    print("=" * 78)

    b = require_browser(width=1280, height=900)
    try:
        for s in SCREENS:
            b.goto("%s/%s" % (BASE, s), wait=0.5)

            scopes = [("page", None)]
            for did in (b.js(DIALOG_IDS) or []):
                scopes.append(("dialog #" + did, "#" + did))

            total, bad = 0, 0
            for label, sel in scopes:
                if sel:
                    b.js("(function(){var d=document.querySelector('%s');"
                         "if(d&&!d.open)d.showModal();return 1;})()" % sel)
                items = collect(b, sel) or []
                total += len(items)
                for name, members in dupes_in(items):
                    bad += 1
                    where = ", ".join(
                        "%s.%s" % (m["tag"], m["cls"].split(" ")[0] or "-")
                        for m in members[:8])
                    fails.append("%s [%s]: %d controls all named %r  [%s]"
                                 % (s, label, len(members), name, where))
                if sel:
                    b.js("(function(){var d=document.querySelector('%s');"
                         "if(d&&d.open)d.close();return 1;})()" % sel)

            print("  %-20s %2d scope%s  %3d named controls   %d duplicate%s"
                  % (s, len(scopes), " " if len(scopes) == 1 else "s",
                     total, bad, "" if bad == 1 else "s"))
    finally:
        b.close()

    print("\n" + "-" * 78)
    if fails:
        print("FAILURES: %d" % len(fails))
        for f in fails:
            print("  " + f)
        print("\nGive each control a name that says which thing it acts on.")
        return 1
    print("PASS: on all %d screens, no two controls a person can reach at the"
          % len(SCREENS))
    print("      same time answer to the same name, unless they go to the")
    print("      same place.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(run())
    except SystemExit:
        raise
    except Exception as exc:                        # noqa: BLE001
        print("verify_names.py ERROR: %s: %s" % (type(exc).__name__, exc))
        sys.exit(2)
