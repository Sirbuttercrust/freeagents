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

    WEBGRAB_DIR=<dir with webgrab.py> python3 verify_pickers.py [base-url]
"""

import json
import os
import re
import sys

sys.path.insert(0, os.environ.get("WEBGRAB_DIR", "."))
try:
    from webgrab import Browser
except ImportError:
    print("Set WEBGRAB_DIR to the directory holding webgrab.py")
    sys.exit(2)

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3111"

PICKERS = [
    ("staged.html", "#redo .picker li", "redo picker"),
    ("pullrequest.html", "#closepr .picker li", "close picker"),
]

AGREEMENT = """
(function(){
  return JSON.stringify([].map.call(document.querySelectorAll('.trow'), function(r){
    var n = r.querySelector('.num'), l = r.querySelector('.line');
    var b = l ? l.querySelector('b') : null;
    return {
      num: n ? n.textContent.trim() : '',
      // The <b> is the label on a fixed term (Price, Ready in N days); the
      // criteria rows have no <b> and their whole text is the sentence.
      label: b ? b.textContent.replace(/\\s+/g,' ').trim() : '',
      text: l ? l.textContent.replace(/\\s+/g,' ').trim() : ''
    };
  }));
})()
"""


def picker(sel):
    return """
    (function(){
      var out = [];
      document.querySelectorAll('%s').forEach(function(li){
        var s = li.querySelector('span');
        out.push(s ? s.textContent.replace(/\\s+/g,' ').trim() : '');
      });
      var note = document.querySelector('%s');
      return JSON.stringify({rows: out, note: note ? note.textContent.replace(/\\s+/g,' ').trim() : ''});
    })()
    """ % (sel, sel.split(" ")[0].replace("#", "#") + " .pickernote")


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
try:
    b.goto(BASE + "/agreement.html")
    lines = {r["num"]: r for r in json.loads(b.js(AGREEMENT)) if r["num"]}

    for page, sel, what in PICKERS:
        b.goto(BASE + "/" + page)
        b.js("document.querySelectorAll('dialog').forEach(function(d){"
             "try{d.open||d.setAttribute('open','')}catch(e){}})")
        b.js("new Promise(function(r){setTimeout(r,200)})")
        data = json.loads(b.js(picker(sel)))

        offered = []
        for row in data["rows"]:
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

            # The agreement line's own sentence. On a FIXED TERM the <b> label
            # IS the headline ("Ready in 6 days") and the rest is a footnote,
            # so the picker legitimately shows the label. Stripping it, as a
            # first version did, compared the picker against the footnote and
            # reported a mismatch on correct copy. Compare against the whole
            # line and let containment do the work.
            src = lines[num]
            body = src["text"]
            a, p = words(body), words(text)
            # EVERY word of the picker row must appear in the agreement line,
            # not just a prefix. A first version compared the first six words
            # and passed a mutation that changed word eleven ("defined in two
            # places" -> "three places"), which is precisely the drift this
            # gate exists to catch: the number a dispute turns on sits at the
            # END of a sentence, not the start.
            #
            # Still containment rather than equality, so a picker may shorten
            # an agreement line (row 02 drops "the change") but may not
            # introduce a word the agreement never said.
            av = set(a.split())
            extra = [w for w in p.split() if w not in av]
            if extra:
                fails.append("%s line %s: says %s, which the agreement line "
                             "does not.\n      picker:    %r\n      agreement: %r"
                             % (what, num, extra, text[:70], body[:70]))

        missing = [n for n in sorted(lines) if n not in offered]
        note = data["note"]
        if missing and not note:
            fails.append("%s: omits line(s) %s and says nothing about why"
                         % (what, ", ".join(missing)))
        elif missing:
            # The note must ACCOUNT for each omission, and a bare digit is the
            # wrong test: "Line 06 is the price" names 06 explicitly, while
            # "the price and the delivery date are settled" accounts for both
            # 06 and 07 without printing either number. Matching on the digit
            # alone failed the second, correct, note. So accept either the
            # number or the line's own subject word.
            for n in missing:
                subject = lines[n]["label"].split(":")[0].strip().lower()
                # "Ready in 6 days" -> the concept a reader would look for.
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
