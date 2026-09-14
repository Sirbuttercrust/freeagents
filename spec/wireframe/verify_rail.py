#!/usr/bin/env python3
"""Does the money on the deposit screen follow the rail the buyer picks?

WHY THIS IS ITS OWN GATE. The headline total and the pay button sit ABOVE the
rail selector, and the two rails cost different amounts (ABT 3 percent, USDC
6). A screenshot of the default state cannot answer this, because ABT is
preselected and every number on screen is correct for ABT. If the reveal were
broken the page would show $309 while the button charged $318, and it would
look perfect in the shot.

The whole mechanism is `body:has(#rail-usdc:checked) .amt-usdc { display:
inline }`. A relational selector degrades SILENTLY: unsupported, mis-scoped or
renamed, nothing throws and nothing logs, the number just stops following the
choice. Only real input on the real control finds that.

TWO THINGS THIS FILE LEARNED THE HARD WAY, both worth keeping:

  textContent is not what a person reads. The page keeps BOTH amounts in the
  DOM and reveals one, so `btn.textContent` returns "Pay $309.00$318.00 with
  your wallet" in either state. A first version of this gate read that and
  reported two failures against a page that was correct. Walk the text nodes
  and skip any whose parent chain is display:none, or measure the rect.

  Showing both amounts is CORRECT inside the rail selector. That is the
  comparison a buyer makes, so a blanket "the other rail's total must not
  appear" assertion fails on the one component that is supposed to show it.
  The check is scoped to everything OUTSIDE `.rails`.

    python3 verify_rail.py [base-url]
"""

import json
import os
import sys

# wirebrowse.py sits beside this file, in the repo, standard library only.
# No WEBGRAB_DIR, no pip install, no external checkout: a reviewer with a
# clone, python3 and any Chrome can run this gate and disagree with its
# result. That is the whole point of committing the driver.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wirebrowse import Browser, NoBrowser
import population

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3111"

# THE SCREENS THIS MEASURES ARE DERIVED, NOT PINNED. Round 5 of one defect:
# rounds 1 to 4 were an axis, a selector, the open states and a named SCREENS
# list, and each fix landed on the shape a reviewer named. This gate carried
# the same hole in the shape verify_coverage.py could not see, because the
# page was written inline in the goto rather than in a list it inspects.
#
# The needle is the rail radio itself. A screen cannot offer a choice of rail
# without it, so a second screen that grows a rail selector is measured the
# day it exists rather than the day somebody remembers this file.
SCREENS = population.screens_with_source("rail-usdc")

# Deposit is a quarter of a $1,200 price, so $300, and the fee rides on top.
EXPECT = {
    "abt": {"pct": 3, "fee": "$9.00", "total": "$309.00"},
    "usdc": {"pct": 6, "fee": "$18.00", "total": "$318.00"},
}

PROBE = """
(function () {
  // Text as PAINTED: skip any subtree that is display:none or hidden. The
  // page holds both rails' amounts in the DOM, so textContent lies here.
  function painted(node) {
    var out = "";
    (function walk(n) {
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) { out += c.nodeValue; continue; }
        if (c.nodeType !== 1) continue;
        var cs = getComputedStyle(c);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        if (parseFloat(cs.opacity) < 0.05) continue;
        walk(c);
      }
    })(node);
    return out.replace(/\\s+/g, " ").trim();
  }

  var checked = document.querySelector('input[name="rail"]:checked');
  var big = document.querySelector(".total .big");
  var btn = [].find.call(document.querySelectorAll("a,button"),
              function (e) { return /Pay\\s*\\$/.test(e.textContent); });

  // Every .amt-abt / .amt-usdc pair must reveal exactly one side. This is the
  // general assertion: it catches the :has() rule failing anywhere, including
  // in copy added later.
  //
  // An element inside a CLOSED dialog is legitimately not painted, so it is
  // reported separately rather than counted as a failure. The gate opens the
  // scan sheet in a second pass and requires it to pass there, because the
  // sentence telling a USDC buyer they will be asked to approve twice lives
  // inside that sheet and is the one place they learn it.
  var pairs = [];
  ["abt", "usdc"].forEach(function (r) {
    document.querySelectorAll(".amt-" + r).forEach(function (el) {
      var rect = el.getBoundingClientRect();
      var cs = getComputedStyle(el);
      var dlg = el.closest("dialog");
      pairs.push({
        rail: r,
        text: (el.textContent || "").trim().slice(0, 60),
        inClosedDialog: !!(dlg && !dlg.open),
        shown: rect.width > 0 && rect.height > 0 && cs.display !== "none"
      });
    });
  });

  // Money visible OUTSIDE the rail selector. Inside it, both amounts are
  // meant to show: that is the comparison.
  var outside = [];
  document.querySelectorAll("main *").forEach(function (el) {
    if (el.children.length) return;
    if (el.closest(".rails")) return;
    var t = painted(el);
    if (!t || t.indexOf("$") === -1) return;
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    outside.push(t);
  });

  return JSON.stringify({
    rail: checked ? checked.id : null,
    big: big ? painted(big) : null,
    button: btn ? painted(btn) : null,
    pairs: pairs,
    outside: outside,
    errors: window.__errs || []
  });
})()
"""

b = Browser(1280, 1400)
fails = []
seen = {}
scan = {}

# AN EMPTY POPULATION IS NOT A PASS. A derivation that matches nothing makes
# every assertion below vacuous, and a vacuous gate prints the same green as a
# working one. If the rail markup is renamed, this says so instead of quietly
# measuring no screens.
if not SCREENS:
    print("FAIL  no screen carries the rail selector (needle 'rail-usdc').")
    print("      Either the markup was renamed, in which case fix the needle,")
    print("      or the rail was removed, in which case this gate is retired.")
    sys.exit(1)

try:
    for screen in SCREENS:
        b.goto(BASE + "/" + screen)
        b.js("window.__errs=[];window.addEventListener('error',function(e){"
             "window.__errs.push(e.message+' @'+e.filename+':'+e.lineno)});")

        for rail in ("abt", "usdc"):
            hit = b.js("(function(){var e=document.getElementById('rail-%s');"
                       "if(!e)return 'missing';e.click();return 'ok';})()" % rail)
            if hit == "missing":
                fails.append("%s: no #rail-%s control on the page"
                             % (screen, rail))
                continue
            b.js("new Promise(function(r){setTimeout(r,250)})")
            s = json.loads(b.js(PROBE))
            seen[(screen, rail)] = s

            want = EXPECT[rail]["total"]
            other = "usdc" if rail == "abt" else "abt"
            stale = EXPECT[other]["total"]

            if s["rail"] != "rail-" + rail:
                fails.append("%s: clicked #rail-%s but %s is checked"
                             % (screen, rail, s["rail"]))
            if s["big"] != want:
                fails.append("%s, %s: headline total reads %r, expected %r"
                             % (screen, rail, s["big"], want))
            if not s["button"] or want not in s["button"]:
                fails.append("%s, %s: pay button reads %r, expected it to carry %s"
                             % (screen, rail, s["button"], want))
            if s["button"] and stale in s["button"]:
                fails.append("%s, %s: pay button also shows %s, the other rail's total"
                             % (screen, rail, stale))

            # Every pair reveals exactly its own side, nothing from the other.
            wrong = [p for p in s["pairs"] if p["shown"] and p["rail"] != rail]
            if wrong:
                fails.append("%s, %s: %d element(s) of the OTHER rail are painted: %s"
                             % (screen, rail, len(wrong),
                                [p["text"] for p in wrong][:3]))
            missing = [p for p in s["pairs"]
                       if not p["shown"] and p["rail"] == rail
                       and not p["inClosedDialog"]]
            if missing:
                fails.append("%s, %s: %d of its own element(s) are hidden: %s"
                             % (screen, rail, len(missing),
                                [p["text"] for p in missing][:3]))

            # Outside the comparison, the other rail's total must not appear.
            bleed = [t for t in s["outside"] if stale in t]
            if bleed:
                fails.append("%s, %s: %s leaks outside the rail selector: %s"
                             % (screen, rail, stale, bleed[:2]))
            if EXPECT[rail]["fee"] not in " ".join(s["outside"]):
                fails.append("%s, %s: fee %s is not visible"
                             % (screen, rail, EXPECT[rail]["fee"]))
            if s["errors"]:
                fails.append("%s: page errors: %s" % (screen, s["errors"]))

        # ------------------------------------------------------------ pass 2
        # The scan sheet, OPEN. The sentence a USDC buyer needs ("you will be
        # asked to approve twice") lives only here, so a gate that never opens
        # the dialog never checks the single most surprising thing on screen.
        for rail in ("abt", "usdc"):
            b.js("(function(){var e=document.getElementById('rail-%s');"
                 "if(e)e.click();})()" % rail)
            b.js("(function(){var d=document.getElementById('scan');"
                 "if(d&&!d.open){d.showModal?d.showModal():d.setAttribute('open','');}})()")
            b.js("new Promise(function(r){setTimeout(r,250)})")
            s = json.loads(b.js(PROBE))
            scan[(screen, rail)] = s

            inscan = [p for p in s["pairs"] if "approval" in p["text"].lower()]
            painted_here = [p for p in inscan if p["shown"]]
            if len(painted_here) != 1:
                fails.append("%s scan sheet, %s: %d approval sentences painted, expected 1"
                             % (screen, rail, len(painted_here)))
            elif painted_here[0]["rail"] != rail:
                fails.append("%s scan sheet, %s: the %s sentence is showing"
                             % (screen, rail, painted_here[0]["rail"]))
            else:
                got = painted_here[0]["text"].lower()
                need = "one approval" if rail == "abt" else "two approvals"
                if need not in got:
                    fails.append("%s scan sheet, %s: expected %r, got %r"
                                 % (screen, rail, need, painted_here[0]["text"]))
            # Close it again so the next iteration starts from a known state.
            b.js("(function(){var d=document.getElementById('scan');"
                 "if(d&&d.open){d.close?d.close():d.removeAttribute('open');}})()")
finally:
    b.close()

print("=" * 72)
print("RAIL / MONEY COHERENCE: " + BASE)
print("=" * 72)
print("\nscreens measured: %d of %d on disk, derived from the directory by the"
      % (len(SCREENS), len(population.every_screen())))
print("rail control itself: %s\n" % " ".join(SCREENS))
print("deposit is a quarter of $1,200 = $300.00, the fee rides on top\n")
print("%-14s %-6s %-5s %-8s %-10s %s"
      % ("screen", "rail", "fee%", "fee", "headline", "pay button, as painted"))
for screen in SCREENS:
    for rail in ("abt", "usdc"):
        s = seen.get((screen, rail))
        if not s:
            continue
        print("%-14s %-6s %-5s %-8s %-10s %s" % (
            screen, rail, "%d%%" % EXPECT[rail]["pct"], EXPECT[rail]["fee"],
            s["big"], s["button"]))

for screen in SCREENS:
    for rail in ("abt", "usdc"):
        s = seen.get((screen, rail))
        if not s:
            continue
        shown = sum(1 for p in s["pairs"] if p["shown"])
        closed = sum(1 for p in s["pairs"] if p["inClosedDialog"])
        print("\n%s %-5s rail-specific elements: %d of %d painted (all %s), "
              "%d behind the closed scan sheet"
              % (screen, rail, shown, len(s["pairs"]), rail, closed))

print("\nthe scan sheet, opened:")
for screen in SCREENS:
    for rail in ("abt", "usdc"):
        s = scan.get((screen, rail))
        if not s:
            continue
        line = [p["text"] for p in s["pairs"]
                if p["shown"] and "approval" in p["text"].lower()]
        print("  %s %-5s %s"
              % (screen, rail, line[0] if line else "(nothing painted)"))

print()
if fails:
    print("FAIL, %d" % len(fails))
    for f in fails:
        print("  " + f)
    sys.exit(1)
print("PASS  headline, fee, pay button and every rail-specific element follow")
print("      the selected rail. Both totals appear only inside the comparison.")
