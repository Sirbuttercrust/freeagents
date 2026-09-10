#!/usr/bin/env python3
"""Do the pickers agree with the agreement?

WHY. Two screens ask a buyer to cite an agreed line: the redo picker on
staged.html and the close picker on pullrequest.html. Both hardcode their own
copy of the criteria. Nothing ties either list to agreement.html, so they
agree only because someone typed them to agree, and the consequence of drift
is not cosmetic: a buyer cites line 04, and the operator reads a different
line 04.

Three checks:

  1  every picker row's number exists in the agreement
  2  every picker row's TEXT matches that agreement line, not just its number
  3  any line the agreement has and a picker omits is explained on screen

Check 3 is the one that found something a person would have asked about. The
redo picker runs 01, 02, 03, 04, 05, 07, and the close picker stops at 05.
Both omissions are correct, and neither said so, and a buyer who signed seven
lines and counts six has found a bug as far as they know.

Check 2 matters because numbers are the easy half. A renumbered or reworded
agreement line leaves the picker showing the old sentence under the right
digit, which is the drift that actually misroutes a dispute.

    python3 verify_pickers.py [base-url]
"""

import json
import os
import re
import sys

# wirebrowse.py sits beside this file, in the repo, standard library only.
# No WEBGRAB_DIR, no pip install, no external checkout: a reviewer with a
# clone, python3 and any Chrome can run this gate and disagree with its
# result. That is the whole point of committing the driver.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wirebrowse import Browser, NoBrowser
import population

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3111"

# DERIVED, NOT PINNED, ON BOTH SIDES. This gate carried the round-4 defect in
# the one shape verify_coverage.py cannot see: PICKERS was a list of TUPLES,
# so its literal-list detector read it as no screen list at all, and the
# agreement it compares against was written inline in a goto.
#
# The needles are the markup each side cannot exist without. A screen that
# grows a picker, or a second screen that draws the signed terms, joins the
# population the day it exists rather than the day somebody remembers.
PICKER_SCREENS = population.screens_with_source('class="picker"')
TERMS_SCREENS = population.screens_matching(r'<ul[^>]*class="[^"]*\bterms\b')

# The picker's own container is read from the page rather than named here: a
# selector per screen would be the same list by another road. Each picker sits
# in the dialog that owns it, and .pickernote sits beside it in that dialog.
PICKER_SEL = "ul.picker li"

AGREEMENT = """
(function(){
  /* THE MATRIX ROW SELECTOR MOVED, 2026-09-09.

     The September agreement drew each row as a .trow with a .line inside it.
     The reconciled agreement is the polished signature matrix: the rows are
     the <li> of ul.terms and the sentence is .txt. This gate reads the rows
     to check that every line a picker offers actually exists, so pointing it
     at the old selector made it report "the agreement has 0 lines" and then
     fail all eleven picker rows for referring to lines it could not see.

     Both selectors are accepted rather than only the new one, so the gate
     still runs against an older tree and says something true about it. */
  var rows = document.querySelectorAll('ul.terms > li');
  if (!rows.length) rows = document.querySelectorAll('.trow');

  return JSON.stringify([].map.call(rows, function(r){
    var n = r.querySelector('.num');
    var l = r.querySelector('.txt') || r.querySelector('.line');
    /* The label on a fixed term. September marked it with a <b>; the matrix
       marks it .term-label. The criteria rows have neither and their whole
       text is the sentence. */
    var b = r.querySelector('.term-label') || (l ? l.querySelector('b') : null);
    /* A term row keeps its label and value in siblings of .txt, so read the
       whole cell rather than .txt alone when there is no .txt.

       WALK TEXT NODES, NOT ELEMENTS. The label, the number and the unit are
       nested with no whitespace between them, so plain textContent returns
       "Delivery6days from funding" and a word test fails on a row that is
       correct. An element walk is not enough either: .term-value holds the
       bare number AND a nested .unit, so skipping elements that have
       children drops the "6". Collecting the text nodes themselves gets
       every word exactly once, in reading order. */
    var cell = l || r.querySelector('.term-line');
    var text = '';
    if (cell === l && l) {
      text = l.textContent.replace(/\\s+/g,' ').trim();
    } else if (cell) {
      var parts = [];
      var walk = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, null, false);
      var node;
      while ((node = walk.nextNode())) {
        var t = node.nodeValue.replace(/\\s+/g,' ').trim();
        if (t) parts.push(t);
      }
      text = parts.join(' ');
    }
    return {
      num: n ? n.textContent.trim() : '',
      label: b ? b.textContent.replace(/\\s+/g,' ').trim() : '',
      text: text
    };
  }));
})()
"""


def picker(sel):
    """Read every picker on the page, each scoped to the dialog that owns it.

    The note selector used to be built by string-slicing the caller's "#redo
    .picker li" down to "#redo .pickernote". That made the DIALOG ID part of
    the gate's configuration, which is a screen list wearing a selector's
    clothes: a third picker meant a third hardcoded id. The owning container
    is read from the DOM instead, so a picker in a dialog nobody has written
    yet is found with its own note.
    """
    return """
    (function(){
      var out = [];
      var lists = document.querySelectorAll('ul.picker');
      var groups = [];
      lists.forEach(function(ul){
        var rows = [];
        ul.querySelectorAll('li').forEach(function(li){
          var s = li.querySelector('span');
          rows.push(s ? s.textContent.replace(/\\s+/g,' ').trim() : '');
        });
        /* The note belongs to the picker's own scope. Walk out to the nearest
           dialog or section that contains this list rather than naming an id. */
        var scope = ul.closest('dialog') || ul.closest('section') || document;
        var note = scope.querySelector('.pickernote');
        groups.push({
          rows: rows,
          note: note ? note.textContent.replace(/\\s+/g,' ').trim() : '',
          scope: (scope.id || scope.tagName || '').toLowerCase()
        });
      });
      return JSON.stringify(groups);
    })()
    """


def words(s):
    """Comparable core of a sentence: lowercase alphanumerics only.

    Picker copy is allowed to be a shortened form of the agreement line (the
    picker drops "the change" from row 02, for instance) so the assertion is
    containment of the first clause rather than equality. Equality would fail
    on a legitimate abbreviation and teach the next person to delete the gate.
    """
    return re.sub(r"[^a-z0-9 ]", "", s.lower())


b = Browser(1280, 1400)
fails = []
report = []

# AN EMPTY POPULATION ON EITHER SIDE IS NOT A PASS. With no picker the loop
# runs zero times; with no terms screen every row fails for the wrong reason.
# Both print the same green as a working sweep unless they are named here.
if not PICKER_SCREENS:
    print("FAIL  no screen carries a ul.picker, so this gate measured nothing.")
    sys.exit(1)
if not TERMS_SCREENS:
    print("FAIL  no screen draws the signed terms (ul.terms), so there is")
    print("      nothing to check the picker rows against.")
    sys.exit(1)

try:
    # The agreement each picker refers to. Read from every screen that draws
    # the signed terms, so moving the matrix to another page is a design
    # decision the gate follows rather than a break it reports.
    lines = {}
    for screen in TERMS_SCREENS:
        b.goto(BASE + "/" + screen)
        for r in json.loads(b.js(AGREEMENT)):
            if r["num"]:
                lines[r["num"]] = r

    if not lines:
        print("FAIL  %s draws ul.terms but no row carried a line number, so"
              % " ".join(TERMS_SCREENS))
        print("      every picker row below would fail for the wrong reason.")
        sys.exit(1)

    for page in PICKER_SCREENS:
        b.goto(BASE + "/" + page)
        b.js("document.querySelectorAll('dialog').forEach(function(d){"
             "try{d.open||d.setAttribute('open','')}catch(e){}})")
        b.js("new Promise(function(r){setTimeout(r,200)})")
        groups = json.loads(b.js(picker(PICKER_SEL)))

        if not groups:
            fails.append("%s: source carries a ul.picker but none rendered"
                         % page)
            continue

        for group in groups:
            what = "%s picker" % (group["scope"] or page)
            offered = []
            for row in group["rows"]:
                m = re.match(r"^(\d{2})\s+(.*)$", row)
                if not m:
                    fails.append("%s: a row does not start with a line number: %r"
                                 % (what, row[:60]))
                    continue
                num, text = m.group(1), m.group(2)
                offered.append(num)

                if num not in lines:
                    fails.append("%s: offers line %s, which the agreement does not have"
                                 % (what, num))
                    continue

                # The agreement line's own sentence. On a FIXED TERM the <b>
                # label IS the headline ("Ready in 6 days") and the rest is a
                # footnote, so the picker legitimately shows the label.
                # Stripping it, as a first version did, compared the picker
                # against the footnote and reported a mismatch on correct
                # copy. Compare against the whole line and let containment do
                # the work.
                src = lines[num]
                body = src["text"]
                a, p = words(body), words(text)
                # EVERY word of the picker row must appear in the agreement
                # line, not just a prefix. A first version compared the first
                # six words and passed a mutation that changed word eleven
                # ("defined in two places" -> "three places"), which is
                # precisely the drift this gate exists to catch: the number a
                # dispute turns on sits at the END of a sentence.
                #
                # Still containment rather than equality, so a picker may
                # shorten an agreement line (row 02 drops "the change") but
                # may not introduce a word the agreement never said.
                av = set(a.split())
                extra = [w for w in p.split() if w not in av]
                if extra:
                    fails.append("%s line %s: says %s, which the agreement line "
                                 "does not.\n      picker:    %r\n      agreement: %r"
                                 % (what, num, extra, text[:70], body[:70]))

            missing = [n for n in sorted(lines) if n not in offered]
            note = group["note"]
            if missing and not note:
                fails.append("%s: omits line(s) %s and says nothing about why"
                             % (what, ", ".join(missing)))
            elif missing:
                # The note must ACCOUNT for each omission, and a bare digit is
                # the wrong test: "Line 06 is the price" names 06 explicitly,
                # while "the price and the delivery date are settled" accounts
                # for both 06 and 07 without printing either number. Matching
                # on the digit alone failed the second, correct, note. So
                # accept either the number or the line's own subject word.
                for n in missing:
                    subject = lines[n]["label"].split(":")[0].strip().lower()
                    # "Ready in 6 days" -> the concept a reader looks for.
                    keys = [n]
                    if subject:
                        keys.append(subject)
                        if subject.startswith("ready"):
                            keys += ["delivery", "delivery date", "when"]
                        if subject.startswith("price"):
                            keys += ["price", "cost"]
                    if not any(k and k in note.lower() for k in keys):
                        fails.append("%s: omits line %s and the note does not "
                                     "account for it. note: %r, looked for any of %s"
                                     % (what, n, note[:60], keys))

            report.append((what, page, offered, missing, note))
finally:
    b.close()

print("=" * 76)
print("PICKERS AGAINST THE AGREEMENT")
print("=" * 76)
print("\nscreens measured: %d picker screen(s) against %d terms screen(s), both"
      % (len(PICKER_SCREENS), len(TERMS_SCREENS)))
print("derived from the directory: pickers on %s, terms on %s"
      % (" ".join(PICKER_SCREENS), " ".join(TERMS_SCREENS)))
print("pickers found and read: %d" % len(report))
print("\nthe agreement has %d lines: %s" % (len(lines), ", ".join(sorted(lines))))
for what, page, offered, missing, note in report:
    print("\n%s (%s)" % (what, page))
    print("  offers:  %s" % ", ".join(offered))
    print("  omits:   %s" % (", ".join(missing) if missing else "nothing"))
    print("  note:    %s" % (note if note else "(none)"))

print()
if fails:
    print("FAIL, %d" % len(fails))
    for f in fails:
        print("  " + f)
    sys.exit(1)
print("PASS  every picker row traces to a real agreement line with matching")
print("      text, and every omitted line is accounted for on screen.")
