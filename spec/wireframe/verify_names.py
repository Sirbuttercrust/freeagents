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
where this hides. For each, THE NAME CHROME COMPUTES is read out of the
accessibility tree, along with the source that won it, and the results are
grouped.

A group of two or more identical names FAILS unless every member points at the
same destination, which is the one legitimate case: a card whose image and
title both link to the same page is one target described twice, not two
targets sharing a description.

The href/target comparison is what keeps this from being noise. Site
navigation repeats "Dashboard" on every screen and that is correct; those all
resolve to the same URL, so they collapse into one entry and never fail.

THE NAME COMES FROM THE BROWSER, AND IT DID NOT USED TO

For eleven rounds this file computed the name itself, with a JavaScript ladder
that read `aria-labelledby`, then `aria-label`, then a `label`, then the
control's own text, then `title`, then `placeholder`. That is the file, and
the browser is the thing that decides. Round 11 found the same defect in
verify_kept.py and fixed one instance; this is the class.

The ladder's last two rungs are what made it matter, because both name a
control with something A PERSON CANNOT SEE:

  placeholder  is painted only while the field is EMPTY. A field shipping
               with a value never paints it at all, so the name exists
               nowhere on the screen.
  title        needs a hover, and a touch device has no hover. Every mobile
               law in this set is measured under `(pointer: coarse)`, where
               a title is unreachable by construction.

THE CENSUS, AND HOW TO REPRODUCE IT

Run this gate and read the two blocks it prints under "the population,
reconciled" and "where the names come from". On the tree at round 13, all 33
screens with every dialog opened:

  markup controls collected        544
  checked against the name rules   544
  contents 433, aria-label 76, relatedElement 35

The pre-fix state is reproducible without editing a file: remove in the live
DOM the two `aria-label` attributes round 12 added (browse.html's `#q` and
agent.html's `.copybtn`) and the census comes back 433 / 74 / 35 plus one
`title` and one `placeholder`, which is the defect round 12 reported.

ROUND 13 CORRECTED THESE NUMBERS, AND THE CORRECTION IS THE INTERESTING PART.
This docstring, DESIGN.md and BUILD-STATE.md all said "574 controls: 460
contents, 66 aria-label, 46 an associated label". No counting method
reproduces 574, 460 or 46: not with dialog contents in the page scope, not
with them out, not before the fix and not after. Round 12's handoff reports
that its ad-hoc field probe was buggy and miscounted controls inside closed
dialogs, and those numbers are what it printed. The fix landed and the number
from the broken instrument stayed in the normative document, which is the
same defect as a stale token value: a reader cannot tell a measurement from a
leftover. Two of the five figures did reproduce exactly, `aria-label` 66 and
both invisible-source findings, so round 12's defects were real and only its
arithmetic was not.

SO A NUMBER IN THIS FILE NAMES THE COMMAND THAT PRINTS IT. Numbers copied out
of a run go stale the moment the tree moves, and there is no way to tell how
long ago it moved.

The gate reads `Accessibility.getFullAXTree` per scope and joins it to the
markup by `backendDOMNodeId`, and a control whose winning source is
`placeholder` or `title` FAILS with the source named. Both calls cost about
0.02s per scope, which is why one tree per scope replaced a call per node.
The markup's own answer is printed beside the computed one, because the
markup is what you edit when the computed name is wrong.

A ROLE STRING IS A POPULATION, AND THIS ONE WAS EIGHT SHORT

Round 13 found that `CONTROL_ROLES` listed `"disclosure triangle"` while
Chrome returns `DisclosureTriangle`. The strings never matched, so all eight
account-menu `<summary>` controls were collected by the markup selector,
dropped by the role filter, and checked for nothing. A reviewer's positive
control on a copy of this tree removed one of those `aria-label`s and the
gate passed at exit 0, on the promise that no control is nameless.

Two things changed, and the second matters more than the first:

  1. roles are compared through `role_key()`, so a role spelled CamelCase,
     spaced or hyphenated is one role. Adding the missing string alone would
     have closed this instance and left the next differently-spelled role to
     be dropped just as silently.
  2. the report prints what it COLLECTED beside what it CHECKED. A gate that
     prints only the second number reports the same green whether its
     population is whole or eight short. 544 against 536 is the line that
     would have shown this the day it opened.

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

Exit 0 clean, 1 a name defect or a control this gate could not check,
3 no browser.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wirebrowse import require_browser            # noqa: E402

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3111"

# EVERY SCREEN. "No two controls a person can reach at the same time answer
# to the same accessible name" is a rule about every surface, and a duplicate
# name is likeliest on the screens with the most controls, not on the eight
# this used to name.
import population                                             # noqa: E402
SCREENS = population.every_screen()

CONTROLS = "a[href], button, input, select, textarea, summary, [role=button]"

# The roles the accessibility tree gives the things in CONTROLS. Read from the
# tree rather than from the selector, because the tree is what a screen reader
# walks: a <summary> is a disclosure triangle there, and an element with
# role=button is a "button" whatever its tag.
#
# SPELLING IS NOT MEANING, and this list cost eight controls by pretending it
# was. It held `"disclosure triangle"`; Chrome returns `DisclosureTriangle`.
# The strings never matched, so all eight account-menu summaries were collected
# by the selector above, dropped here, and never checked for a name, a
# duplicate, or an invisible source. Every comparison goes through role_key()
# now, so the same role written CamelCase, spaced or hyphenated is one role.
CONTROL_ROLES = frozenset((
    "button", "link", "textbox", "searchbox", "combobox", "checkbox",
    "radio", "slider", "spinbutton", "listbox", "menuitem", "switch",
    "tab", "DisclosureTriangle",
))


def role_key(role):
    """One role, one key, whatever the browser calls it this version.

    `DisclosureTriangle`, `disclosure triangle` and `disclosure-triangle` are
    the same thing said three ways, and a frozenset compared by equality can
    only ever recognise the one spelling somebody typed.
    """
    return "".join(c for c in (role or "").lower() if c.isalnum())


CONTROL_ROLE_KEYS = frozenset(role_key(r) for r in CONTROL_ROLES)

# A name that exists only in one of these is a name nobody on the screen can
# read. See the module docstring: a placeholder is painted only while the
# field is empty, and a title needs a hover that a touch device does not have.
INVISIBLE_SOURCES = {
    "placeholder": "a placeholder is painted only while the field is empty",
    "title": "a title needs a hover, and a touch device has none",
}

# The markup facts, tagged with backendDOMNodeId's partner so the AX tree can
# be joined to them. Everything here is what you EDIT; the name itself comes
# from the browser.
MARKUP = r"""
(function (scopeSel) {
  document.querySelectorAll('details').forEach(function (d) { d.open = true; });

  var root = scopeSel ? document.querySelector(scopeSel) : document.body;
  if (!root) return [];

  function reachable(el) {
    for (var p = el; p; p = p.parentElement) if (p.hidden) return false;
    if (el.getClientRects().length === 0) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    return true;
  }

  var out = [];
  root.querySelectorAll(SELECTOR).forEach(function (el, i) {
    // A dialog's contents belong to the dialog's scope, not the page's.
    if (!scopeSel && el.closest('dialog')) return;
    if (!reachable(el)) return;
    if (el.type === 'hidden') return;
    el.setAttribute('data-namekey', String(i));
    out.push({
      key: String(i),
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


def winning_source(nm):
    """Which source actually produced the name Chrome computed.

    The AX node lists every source it considered, in spec order, each with the
    value it would have contributed. The first one carrying a non-empty value
    is the one that won. Reading `nm['value']` alone says what a person hears
    and not where it came from, and where it came from is the whole question:
    "Copy the DID" is a good name in a title and an unreachable one on a
    phone.
    """
    for s in nm.get("sources", []) or []:
        v = (s.get("value") or {}).get("value")
        if v and str(v).strip():
            return s.get("attribute") or s.get("type") or "?"
    return ""


def collect(b, scope=None):
    """Every reachable control in one scope, named by the BROWSER.

    Two CDP calls per scope, joined on backendDOMNodeId:

      DOM.getDocument            the markup, which is what you edit
      Accessibility.getFullAXTree the computed name and the source that won it

    A call per node was the obvious shape and is too slow at 544 controls;
    both of these cost about 0.02s for a whole document.

    RETURNS (admitted, unaccounted). The second half is the point. Until round
    13 this function returned the admitted list alone, so the eight controls
    its role filter dropped left no trace anywhere in the output: the gate
    collected 544 and reported on 536, and both numbers printed as the same
    green. Every element the selector collects now leaves this function in
    exactly one of the two lists, and the report prints both counts, so the
    next role Chrome spells differently moves a number on the face of the
    page instead of quietly shrinking the population.

    GROUPED PER ELEMENT, NOT PER AX NODE. Six controls in this set carry two
    AX nodes each, an ignored `none` beside the real one, so counting nodes
    would report 550 against 544 collected and the accounting would never
    balance. The live node is the one a screen reader reads.
    """
    items = b.js(MARKUP.replace("SCOPE", "'%s'" % scope if scope else "null"))
    if not items:
        return [], []
    by_key = dict((it["key"], it) for it in items)

    # markup key -> backendNodeId, walked from the document once
    doc = b.send("DOM.getDocument", depth=-1)
    backend = {}

    def walk(n):
        attrs = n.get("attributes") or []
        for i in range(0, len(attrs) - 1, 2):
            if attrs[i] == "data-namekey":
                backend[n.get("backendNodeId")] = attrs[i + 1]
                break
        for c in n.get("children") or []:
            walk(c)

    walk(doc["root"])

    tree = b.send("Accessibility.getFullAXTree")
    nodes = dict((k, []) for k in by_key)
    for n in tree.get("nodes", []):
        key = backend.get(n.get("backendDOMNodeId"))
        if key is not None and key in nodes:
            nodes[key].append(n)

    out, unaccounted = [], []
    for key in sorted(by_key, key=int):
        it = dict(by_key[key])
        live = [n for n in nodes[key] if not n.get("ignored")]
        if not live:
            # No node a screen reader reads. Either the tree has nothing for
            # this element, or every node it has is ignored, and the reason
            # Chrome gives is the useful half: `ariaHiddenSubtree` on a
            # control a mouse can still click is a real defect, and the gate
            # that silently dropped it could not have said so.
            why = []
            for n in nodes[key]:
                why += [r.get("name") for r in (n.get("ignoredReasons") or [])]
            it["why"] = ("ignored: " + ", ".join(sorted(set(w for w in why if w))
                                                 ) if why else
                         "no node in the accessibility tree")
            unaccounted.append(it)
            continue
        n = live[0]
        role = (n.get("role") or {}).get("value")
        if role_key(role) not in CONTROL_ROLE_KEYS:
            it["why"] = "role %r is not in CONTROL_ROLES" % role
            it["role"] = role
            unaccounted.append(it)
            continue
        nm = n.get("name") or {}
        it["name"] = (nm.get("value") or "").replace("\n", " ").strip()[:90]
        it["source"] = winning_source(nm)
        it["role"] = role
        out.append(it)
    return out, unaccounted


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
    print("verify_names.py  accessible names read from the browser, per scope")
    print("=" * 78)

    sources = {}
    roles = {}
    collected_total = 0
    admitted_total = 0
    dropped = []
    b = require_browser(width=1280, height=900)
    try:
        b.send("Accessibility.enable")
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
                items, skipped = collect(b, sel)
                collected_total += len(items) + len(skipped)
                admitted_total += len(items)
                total += len(items)
                for it in items:
                    key = it.get("source") or "(none)"
                    sources[key] = sources.get(key, 0) + 1
                    roles[it.get("role")] = roles.get(it.get("role"), 0) + 1
                for it in skipped:
                    dropped.append((s, label, it))

                # Nameless controls first. A button a screen reader announces
                # as bare "button" is worse than two buttons sharing a name,
                # and it is invisible to the duplicate check below because it
                # has no name to collide with.
                nameless = [i for i in items if not i.get("name")]
                if nameless:
                    bad += 1
                    where = ", ".join(
                        "%s.%s" % (m["tag"], m["cls"].split(" ")[0] or "-")
                        for m in nameless[:8])
                    fails.append("%s [%s]: %d control(s) with NO accessible name  [%s]"
                                 % (s, label, len(nameless), where))

                # A name only a sighted mouse user can reach is the same
                # defect one step less bad: the control HAS a name, and the
                # name is nowhere on the screen. Reported per control with the
                # source named, because the fix depends on which source it is.
                for it in items:
                    why = INVISIBLE_SOURCES.get(it.get("source"))
                    if not why or not it.get("name"):
                        continue
                    bad += 1
                    fails.append(
                        "%s [%s]: %s.%s is named by its %s, %r  (%s)"
                        % (s, label, it["tag"], it["cls"].split(" ")[0] or "-",
                           it["source"], it["name"][:52], why))

                for name, members in dupes_in([i for i in items if i.get("name")]):
                    bad += 1
                    where = ", ".join(
                        "%s.%s" % (m["tag"], m["cls"].split(" ")[0] or "-")
                        for m in members[:8])
                    fails.append("%s [%s]: %d controls all named %r  [%s]"
                                 % (s, label, len(members), name, where))
                if sel:
                    b.js("(function(){var d=document.querySelector('%s');"
                         "if(d&&d.open)d.close();return 1;})()" % sel)

            print("  %-20s %2d scope%s  %3d named controls   %d finding%s"
                  % (s, len(scopes), " " if len(scopes) == 1 else "s",
                     total, bad, "" if bad == 1 else "s"))
    finally:
        b.close()

    # THE TWO COUNTS, SIDE BY SIDE. This is the line that would have shown the
    # role-filter hole the day it opened: 544 collected, 536 checked. A gate
    # that prints only what it admitted reports the same green whether its
    # population is whole or eight short, and the difference is invisible
    # precisely because nothing ever names it.
    #
    # AND A PRINTED NUMBER NOBODY ASSERTS IS THE SAME DEFECT ONE LAYER OUT.
    # This directory has paid for a documented claim nothing checks four times
    # now, so the reconciliation FAILS rather than merely printing: every
    # element the markup selector collects is either checked against the name
    # rules or reported here by name. Both outcomes it can land in are real
    # findings and neither is this gate's business to wave through:
    #
    #   a role not in CONTROL_ROLES     the instrument cannot see a control a
    #                                   person can reach. Admit the role.
    #   every AX node ignored           the browser will not announce a control
    #                                   a mouse can still click, usually an
    #                                   `aria-hidden` ancestor. Fix the markup.
    print("\nthe population, reconciled:")
    print("  %-34s %4d" % ("markup controls collected", collected_total))
    print("  %-34s %4d" % ("checked against the name rules", admitted_total))
    print("  %-34s %4d" % ("collected and NOT checked", len(dropped)))
    if dropped:
        shown = {}
        for s, label, it in dropped:
            key = (it.get("why"), it["tag"], it["cls"].split(" ")[0] or "-")
            shown.setdefault(key, []).append("%s [%s]" % (s, label))
        for (why, tag, cls), where in sorted(shown.items()):
            print("    %s.%-14s %2d  %s" % (tag, cls, len(where), why))
            print("      %s" % ", ".join(where[:6]) +
                  (", and %d more" % (len(where) - 6) if len(where) > 6 else ""))
            fails.append(
                "%d control(s) reached by a person and checked by nothing: "
                "%s.%s\n      %s\n      [%s]"
                % (len(where), tag, cls, why,
                   ", ".join(where[:6]) +
                   (", and %d more" % (len(where) - 6) if len(where) > 6 else "")))

    # The name-source census, on the face of the report. A gate that stopped
    # reading the accessibility tree and went back to guessing would still
    # print a clean table; this line is what changes.
    print("\nwhere the names come from, as Chrome computes them:")
    for k, v in sorted(sources.items(), key=lambda kv: -kv[1]):
        mark = "   <- nobody can see this" if k in INVISIBLE_SOURCES else ""
        print("  %-18s %4d%s" % (k, v, mark))
    print("\nthe roles Chrome returned for them, as it spells them:")
    for k, v in sorted(roles.items(), key=lambda kv: -kv[1]):
        print("  %-22s %4d" % (k, v))

    print("\n" + "-" * 78)
    if fails:
        print("FAILURES: %d" % len(fails))
        for f in fails:
            print("  " + f)
        print("\nGive each control a name that says which thing it acts on,")
        print("in a source a person can actually reach.")
        return 1
    print("PASS: on all %d screens, no two controls a person can reach at the"
          % len(SCREENS))
    print("      same time answer to the same name unless they go to the same")
    print("      place, no control is nameless, and no name exists only in a")
    print("      placeholder or a title. Every name read from the browser,")
    print("      and every one of the %d controls the markup selector collected"
          % collected_total)
    print("      was checked: collected and checked are the same number.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(run())
    except SystemExit:
        raise
    except Exception as exc:                        # noqa: BLE001
        print("verify_names.py ERROR: %s: %s" % (type(exc).__name__, exc))
        sys.exit(2)
