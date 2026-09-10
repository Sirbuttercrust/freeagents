#!/usr/bin/env python3
"""Does the money reconcile across every screen in the flow?

WHY THIS GATE EXISTS. The eight screens were authored separately, and each
one hardcodes its own numbers. Nothing in the markup ties $309 on the deposit
screen to $927 on the staged screen: they agree because a person typed them
to agree. That is exactly the kind of consistency that rots on the next edit,
and it is the FIRST thing a buyer with a budget checks. A wireframe whose
arithmetic does not close teaches a reader to distrust the product.

DESIGN.md forbids invented numbers. This is the other half of that rule: the
numbers that ARE shown must be derivable from one model.

THE MODEL, from the 2026-09-01 rulings:

    price                      $1,200      quoted by the agent
    deposit    25% of price      $300      due at agreement
    balance    75% of price      $900      due when the work is ready
    ABT fee     3%              on each leg, one approval
    USDC fee    6%              on each leg, two approvals

    ABT   deposit today   300 +  9  = $309       balance later  900 + 27  = $927
    USDC  deposit today   300 + 18  = $318       balance later  900 + 54  = $954

Every dollar figure a screen paints must be one of those, or the price, or a
figure this file names as deliberate copy. An unrecognised amount fails.

    python3 verify_money.py [base-url]
"""

import json
import os
import re
import sys
from decimal import Decimal

# wirebrowse.py sits beside this file, in the repo, standard library only.
# No WEBGRAB_DIR, no pip install, no external checkout: a reviewer with a
# clone, python3 and any Chrome can run this gate and disagree with its
# result. That is the whole point of committing the driver.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wirebrowse import Browser, NoBrowser

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3111"

PRICE = Decimal("1200")
DEPOSIT_PCT = Decimal("0.25")
FEES = {"abt": Decimal("0.03"), "usdc": Decimal("0.06")}

deposit = PRICE * DEPOSIT_PCT
balance = PRICE - deposit

# Build the ledger from the model rather than typing it out, so a change to
# any percentage moves every expected figure at once.
LEDGER = {
    "price": PRICE,
    "deposit": deposit,
    "balance": balance,
}
for rail, pct in FEES.items():
    LEDGER["%s deposit fee" % rail] = deposit * pct
    LEDGER["%s deposit total" % rail] = deposit + deposit * pct
    LEDGER["%s balance fee" % rail] = balance * pct
    LEDGER["%s balance total" % rail] = balance + balance * pct

# The operator screen carries one number that is NOT a leg of this hire: the
# operator's own price floor, the figure their agent will not quote below. It
# is a setting on the agent rather than part of this job.
#
# It is MODELLED rather than exempted, because the screen also states the
# headroom ("above your floor, yes, by $400.00"), and that subtraction is
# exactly the kind of arithmetic that rots silently on the next price edit.
# Modelling it means a later change to the price or the floor that leaves the
# headroom stale fails here instead of shipping.
FLOOR = Decimal("800")
LEDGER["operator price floor"] = FLOOR
LEDGER["headroom over the floor"] = PRICE - FLOOR

ALLOWED = {v.quantize(Decimal("0.01")): k for k, v in LEDGER.items()}

# EVERY SCREEN, not the eight that carried a figure when this was written.
# The gate table says "every dollar figure on every screen derives from one
# model of the deal", and a list of eight names cannot fail on a figure
# somebody adds to a ninth. The extra screens cost a page load each and
# report nothing, which is the correct outcome for a screen with no money on
# it and the whole point of asking.
import population                                             # noqa: E402
SCREENS = population.every_screen()

# Figures that are deliberate copy rather than a figure to reconcile. Each is
# named so an unexplained number cannot hide behind a blanket exemption.
EXEMPT = {
    Decimal("0.00"): "a zero, used on the empty-account conduct record",
}

MONEY = re.compile(r"\$\s?([0-9][0-9,]*(?:\.[0-9]{2})?)")

# Read PAINTED text only. The deposit screen keeps both rails' amounts in the
# DOM and reveals one, so textContent would report figures nobody can see.
PROBE = """
(function () {
  var out = [];
  function painted(node) {
    var s = "";
    (function walk(n) {
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) { s += c.nodeValue; continue; }
        if (c.nodeType !== 1) continue;
        var cs = getComputedStyle(c);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        walk(c);
      }
    })(node);
    return s.replace(/\\s+/g, " ").trim();
  }
  // Builder notes are annotation for us, not product copy a buyer reads.
  var notes = document.querySelector(".notes, #notes");
  document.querySelectorAll("main *, dialog *").forEach(function (el) {
    if (el.children.length) return;
    if (notes && notes.contains(el)) return;
    if (el.closest("[data-notes], .buildernote")) return;
    var t = painted(el);
    if (!t || t.indexOf("$") === -1) return;
    var r = el.getBoundingClientRect();
    var dlg = el.closest("dialog");
    // Inside a closed dialog the rect is 0, but the copy is still real and
    // still has to reconcile, so it is kept and marked.
    if (r.width === 0 && r.height === 0 && !dlg) return;
    out.push({ text: t, inDialog: !!dlg });
  });
  return JSON.stringify(out);
})()
"""


def amounts(text):
    for raw in MONEY.findall(text):
        yield Decimal(raw.replace(",", "")).quantize(Decimal("0.01"))


b = Browser(1280, 1400)
fails = []
found = {}
try:
    for screen in SCREENS:
        b.goto(BASE + "/" + screen)
        # Open every dialog: the scan sheet and the redo picker carry money
        # copy, and a sweep that never opens them checks nothing there.
        b.js("document.querySelectorAll('dialog').forEach(function(d){"
             "try{d.open||d.setAttribute('open','')}catch(e){}})")
        b.js("new Promise(function(r){setTimeout(r,200)})")

        seen = []
        for rail in ("abt", "usdc"):
            b.js("(function(){var e=document.getElementById('rail-%s');"
                 "if(e)e.click();})()" % rail)
            b.js("new Promise(function(r){setTimeout(r,200)})")
            for row in json.loads(b.js(PROBE)):
                for amt in amounts(row["text"]):
                    seen.append((amt, row["text"][:70]))

        uniq = {}
        for amt, ctx in seen:
            uniq.setdefault(amt, ctx)
        found[screen] = uniq

        for amt, ctx in sorted(uniq.items()):
            if amt in ALLOWED or amt in EXEMPT:
                continue
            fails.append("%s: $%s does not reconcile. context: %r"
                         % (screen, amt, ctx))
finally:
    b.close()

print("=" * 74)
print("MONEY COHERENCE ACROSS THE FLOW: " + BASE)
print("=" * 74)
print("\nthe model, derived not typed:")
print("  price $%s, deposit %d%% = $%s, balance = $%s"
      % (PRICE, DEPOSIT_PCT * 100, deposit, balance))
for rail in ("abt", "usdc"):
    print("  %-4s fee %d%%   deposit today $%s   balance later $%s"
          % (rail.upper(), FEES[rail] * 100,
             LEDGER["%s deposit total" % rail].quantize(Decimal("0.01")),
             LEDGER["%s balance total" % rail].quantize(Decimal("0.01"))))

print("\n%-20s %s" % ("screen", "figures painted, both rails, dialogs open"))
for screen in SCREENS:
    vals = sorted(found.get(screen, {}))
    print("%-20s %s" % (screen, ", ".join("$%s" % v for v in vals) or "(none)"))

print("\nevery figure above resolves to:")
for amt, name in sorted(ALLOWED.items()):
    used = [s for s in SCREENS if amt in found.get(s, {})]
    if used:
        print("  $%-9s %-22s %s" % (amt, name, " ".join(
            s.replace(".html", "") for s in used)))

print()
if fails:
    print("FAIL, %d" % len(fails))
    for f in fails:
        print("  " + f)
    sys.exit(1)
print("PASS  every dollar figure on all %d screens derives from the one model."
      % len(SCREENS))
