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
TOK = {
    "--bg": "#08090A",
    "--bg-2": "#141517",
    "--fg": "#F7F8F8",
    "--fg-2": "#9CA1AA",
    "--fg-3": "#666B73",
    "--accent": "#7C7CFF",
    "--accent-fg": "#0A0A16",
}

AA = 4.5   # normal text, under 18.66px bold or 24px regular

print("=" * 66)
print("1. THE ARTIFACT, DISPROVED")
print("=" * 66)
print("The sampler paired --accent-fg ink against --bg, because it reads the")
print("pixel behind the button instead of the button's own fill.\n")

fake = ratio(rgb(TOK["--accent-fg"]), rgb(TOK["--bg"]))
real = ratio(rgb(TOK["--accent-fg"]), rgb(TOK["--accent"]))
print("  reported by the sampler   --accent-fg on --bg      %5.2f   (artifact)" % fake)
print("  what a person sees        --accent-fg on --accent  %5.2f   %s"
      % (real, "PASS" if real >= AA else "FAIL"))

print()
print("=" * 66)
print("2. THE --fg-3 LIFT: WAS IT A FIX OR A PREFERENCE")
print("=" * 66)

rows = [
    ("--fg-3", "--bg", "12 and 13px prose on the page"),
    ("--fg-3", "--bg-2", "12 and 13px prose on a pane"),
    ("--fg-2", "--bg", "the same text after the lift, on the page"),
    ("--fg-2", "--bg-2", "the same text after the lift, on a pane"),
]
fails_before = 0
for fg, bg, what in rows:
    r = ratio(rgb(TOK[fg]), rgb(TOK[bg]))
    ok = r >= AA
    if fg == "--fg-3" and not ok:
        fails_before += 1
    print("  %-8s on %-8s %5.2f   %s   %s" % (fg, bg, r, "PASS" if ok else "FAIL", what))

print()
if fails_before == 2:
    print("  --fg-3 fails AA on BOTH surfaces at these sizes. The lift is a fix,")
    print("  not a preference: that text was never legible where it was used.")

# The accent artifact passing and --fg-2 clearing AA are the two claims this
# file exists to back. Fail loudly if a later token edit breaks either.
bad = []
if real < AA:
    bad.append("--accent-fg on --accent is below AA")
for bg in ("--bg", "--bg-2"):
    if ratio(rgb(TOK["--fg-2"]), rgb(TOK[bg])) < AA:
        bad.append("--fg-2 on %s is below AA" % bg)

print()
if bad:
    for b in bad:
        print("FAIL " + b)
    raise SystemExit(1)
print("PASS  button ink clears AA on its own fill, and --fg-2 clears AA on both surfaces.")
