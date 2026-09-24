#!/usr/bin/env python3
"""Hand-computed WCAG ratios for the two contrast questions on this branch.

Exists because a gate that reports a failure you believe is an artifact must
be answered with a NUMBER, never with an assertion. Two things get computed:

  1. The artifact. contrast_check.py samples the pixel BEHIND a text run, so
     on a filled button it reads the page rather than the button's own fill
     and reports about 1.01. The real ink-on-fill pair is computed here.
  2. The --fg-3 lift. Whether that token ever passed AA at 12 and 13px on
     these two surfaces, which is what decides if the lift was a fix or a
     preference.

Pure arithmetic over the tokens in base.css. No browser, no server.
"""

import os
import re
import sys


def channel(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def luminance(rgb):
    r, g, b = rgb
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def ratio(fg, bg):
    a, b = luminance(fg), luminance(bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


def rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


# Read off base.css :root. Kept as literals so this file can be rerun after a
# token change and disagree with the stylesheet loudly.
#
# IT DID NOT ACTUALLY DISAGREE. That was the intent and nothing enforced it, so
# when the polished pass lifted --fg-3 from #666B73 to #7C828C this file went
# on measuring the old value and printing a FAIL for a colour the tree no
# longer uses. A gate auditing a token that does not exist is worse than no
# gate: it produces a red line nobody can act on and teaches a reader to
# discount the output.
#
# The literals stay, because the point of this file is to compute the ratios
# by hand rather than trust a browser. What is added is the check the comment
# always promised: every literal below is compared against base.css :root, and
# any drift fails here rather than being discovered later.
# Since the league look (2026-09-23) the one accent is two tokens:
# --action, the blue every primary button fills with, and --check, the jade
# reserved for what was witnessed (DESIGN.md 2.1). Each has its own ink, and
# both ink-on-fill pairs are measured below.
TOK = {
    "--bg": "#0B0A12",
    "--bg-2": "#1B1829",
    "--fg": "#F5F3FB",
    "--fg-2": "#ABA6BF",
    "--fg-3": "#908BA6",
    "--action": "#2B8CFF",
    "--action-fg": "#0B0A12",
    "--check": "#46C39A",
    "--check-fg": "#05281C",
}

# --fg-3 BEFORE the 2026-08-27 lift, kept so section 2 can still show what the
# lift was worth. It is named as history rather than read as current.
FG3_BEFORE = "#666B73"


def tokens_from_base_css():
    """Every :root custom property base.css actually defines."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "base.css")
    src = open(path, encoding="utf-8").read()
    root = re.search(r":root\s*\{(.*?)\}", src, re.S)
    if not root:
        return {}
    return {m.group(1): m.group(2).strip().upper()
            for m in re.finditer(r"(--[a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6})\s*;",
                                 root.group(1))}


LIVE = tokens_from_base_css()
drift = [(name, want.upper(), LIVE.get(name, "absent"))
         for name, want in TOK.items()
         if LIVE.get(name, "absent") != want.upper()]
if drift:
    print("TOKEN DRIFT: this file and base.css :root disagree.")
    for name, want, got in drift:
        print("  %-12s this file says %s, base.css says %s" % (name, want, got))
    print("\nEvery ratio below would be computed for a colour the tree does not")
    print("use. Update the literals above, then rerun.")
    sys.exit(1)

AA = 4.5   # normal text, under 18.66px bold or 24px regular

print("=" * 66)
print("1. THE ARTIFACT, DISPROVED")
print("=" * 66)
print("The sampler paired --action-fg ink against --bg, because it reads the")
print("pixel behind the button instead of the button's own fill.\n")

fake = ratio(rgb(TOK["--action-fg"]), rgb(TOK["--bg"]))
real = ratio(rgb(TOK["--action-fg"]), rgb(TOK["--action"]))
check = ratio(rgb(TOK["--check-fg"]), rgb(TOK["--check"]))
print("  reported by the sampler   --action-fg on --bg      %5.2f   (artifact)" % fake)
print("  what a person sees        --action-fg on --action  %5.2f   %s"
      % (real, "PASS" if real >= AA else "FAIL"))
print("  the verified stamp        --check-fg on --check    %5.2f   %s"
      % (check, "PASS" if check >= AA else "FAIL"))

print()
print("=" * 66)
print("2. THE --fg-3 LIFT: WAS IT A FIX OR A PREFERENCE")
print("=" * 66)
print("The question is about the value --fg-3 USED TO HOLD, %s, so that is" % FG3_BEFORE)
print("what gets measured here. Reading the current token instead would ask")
print("whether the fix needed fixing, which is a different question and the")
print("one this section was accidentally answering.\n")

rows = [
    (FG3_BEFORE, "--bg", "12 and 13px prose on the page, BEFORE the lift"),
    (FG3_BEFORE, "--bg-2", "12 and 13px prose on a pane, BEFORE the lift"),
    (TOK["--fg-3"], "--bg", "the same text at today's --fg-3, on the page"),
    (TOK["--fg-3"], "--bg-2", "the same text at today's --fg-3, on a pane"),
    (TOK["--fg-2"], "--bg", "--fg-2, the token the worst cases were moved to"),
    (TOK["--fg-2"], "--bg-2", "--fg-2 on a pane"),
]
fails_before = 0
for fg, bg, what in rows:
    r = ratio(rgb(fg), rgb(TOK[bg]))
    ok = r >= AA
    if fg == FG3_BEFORE and not ok:
        fails_before += 1
    print("  %-9s on %-8s %5.2f   %s   %s"
          % (fg, bg, r, "PASS" if ok else "FAIL", what))

print()
if fails_before == 2:
    print("  The OLD --fg-3 failed AA on BOTH surfaces at these sizes. The lift")
    print("  was a fix, not a preference: that text was never legible where it")
    print("  was used.")

# The button ink passing on its own fill and --fg-2 clearing AA are the
# claims this file exists to back. Fail loudly if a later token edit breaks
# either, and hold the stamp's ink on --check to the same line.
bad = []
if real < AA:
    bad.append("--action-fg on --action is below AA")
if check < AA:
    bad.append("--check-fg on --check is below AA")
for bg in ("--bg", "--bg-2"):
    if ratio(rgb(TOK["--fg-2"]), rgb(TOK[bg])) < AA:
        bad.append("--fg-2 on %s is below AA" % bg)

# The lift has to have actually landed. If --fg-3 is ever set back to a value
# that fails on the page, the tree is back where it started and this file
# should say so rather than reporting the history and stopping.
if ratio(rgb(TOK["--fg-3"]), rgb(TOK["--bg"])) < AA:
    bad.append("--fg-3 is below AA on --bg again, the lift was reverted")

print()
if bad:
    for b in bad:
        print("FAIL " + b)
    raise SystemExit(1)
print("PASS  button ink clears AA on its own fill, and --fg-2 clears AA on both surfaces.")
