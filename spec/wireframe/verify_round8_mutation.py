#!/usr/bin/env python3
"""Positive controls for round 8: section 2.1 against the way a colour is TYPED.

ROUND 7 READ THE RULE IN THE RIGHT DIRECTION AND STILL ONLY SAW PART OF IT.

Round 7 built the first check that reads DESIGN.md 2.1 at screens rather than
at token definitions, and proved it with twelve controls. Round 8 asked the
next question, which is the one every gate in this directory has had to be
asked eventually: what shape of the SAME defect does the new gate still not
see? Eight plants, each a colour a person would see on a screen, went through
a green suite:

    a named keyword in a fill                      exit 0
    an 8 digit hex in a style attribute            exit 0
    a 4 digit hex in a fill                        exit 0
    oklch() in a stylesheet                        exit 0
    space separated rgb()                          exit 0
    a hex in an inline custom property             exit 0
    a hex in a page-local <style> block            exit 0
    a hex in a script the document calls a screen  exit 0

Two causes, and neither is the regex being short by one alternative.

FIRST: the classifier decided what owned a colour by reading the 120
characters in front of it. That is a guess about where a property name lives,
and it is answered by a long value. Two mask declarations identical in kind,
one with two gradient stops and one with eight, were classified differently:

    property to colour  57 chars   stencil, exempt
    property to colour 183 chars   PAINT, failed

A verdict that turns on the LENGTH of a value is not reading a position. The
classifier parses declarations now: every colour is the value of a named
property or of a named attribute, and the name is read rather than guessed.

SECOND: the population was "every file the browser loads" and the vocabulary
was hex, rgb and hsl. A page-local `<style>` block is neither a stylesheet nor
a text node, and all 33 screens have one. `oklch()` is a colour in every
browser this tree targets. `white` is a colour in a `fill` and is NOT one in
`white-space: nowrap`, which is why the vocabulary can only widen once
position is read properly: the two questions are the same question.

THE CONTROLS THAT MUST NOT FIRE ARE HALF OF THIS FILE, for the reason round 7
wrote down and this round tested harder. Widening a colour vocabulary is
exactly the change that starts condemning correct code: `white-space`,
`#4471` in a pull request link, `red` in a sentence about not using red, and
`url(white.png)` are all colour-shaped and none of them is paint.

Run from the wireframe directory. Reverts on any exit, including SIGTERM.

    python3 verify_round8_mutation.py
"""
import hashlib
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import mutationsafe                                             # noqa: E402

DOC = os.path.join(HERE, "DESIGN.md")
MARKET = os.path.join(HERE, "market.css")
CONDUCT = os.path.join(HERE, "conduct.html")
POLISH_JS = os.path.join(HERE, "polish.js")
SWARM = os.path.join(HERE, "swarm.js")
# Exactly the files this suite mutates, no more. A path declared here and
# never written to is a screen name the coverage gate has to be told to
# excuse, and an exemption for a file nothing touches is how a real one gets
# waved through later.
FILES = [DOC, MARKET, CONDUCT, POLISH_JS, SWARM]


def read(p):
    with open(p, encoding="utf-8") as fh:
        return fh.read()


def write(p, s):
    with open(p, "w", encoding="utf-8") as fh:
        fh.write(s)


def digest(paths):
    h = hashlib.sha256()
    for p in sorted(paths):
        h.update(read(p).encode("utf-8"))
    return h.hexdigest()[:12]


def run_gate():
    p = subprocess.run([sys.executable, os.path.join(HERE, "verify_designmd.py")],
                       capture_output=True, text=True, cwd=HERE)
    return p.returncode, p.stdout + p.stderr


def sub(path, old, new):
    """Replace and PROVE the replacement landed."""
    s = read(path)
    if old not in s:
        raise SystemExit("mutation target not found in %s:\n  %r"
                         % (os.path.basename(path), old[:90]))
    write(path, s.replace(old, new, 1))


# ======================================================================
# THE DEFECTS. Each is a colour on a screen, typed a way round 7 could not
# read. Every value below resolves to #D8D8D8 or near it, chosen by the audit
# in round 6 because it CLEARS AA at about 15:1 on --bg: the defect under
# test is that a screen introduced a colour, never that it introduced an
# unreadable one, and a contrast gate must not be able to catch it by luck.
# ======================================================================

def mut_named_keyword():
    """`fill="red"` on a screen.

    A keyword is a colour. 2.1 says a colour not in the table does not exist
    in the product, and `red` is not in the table.
    """
    sub(CONDUCT, "</main>",
        '<svg width="8" height="8" class="r8plant" aria-hidden="true">'
        '<circle cx="4" cy="4" r="4" fill="red"/></svg>\n</main>')


def mut_hex8():
    """`#D8D8D8FF`. The same colour as round 6's plant, four characters longer.

    CSS Color 4 has shipped `#RRGGBBAA` in every browser this tree targets
    since 2016. A vocabulary that stops at six digits is answered by typing
    two more.
    """
    sub(CONDUCT, "</main>",
        '<p class="r8plant" style="color:#D8D8D8FF">r8plant</p>\n</main>')


def mut_hex4():
    """`#D8DF`, the short form of the same value."""
    sub(CONDUCT, "</main>",
        '<svg width="8" height="8" class="r8plant" aria-hidden="true">'
        '<circle cx="4" cy="4" r="4" fill="#D8DF"/></svg>\n</main>')


def mut_oklch():
    """A modern colour function in a stylesheet.

    `oklch()` paints exactly like a hex. A rule about hexes is a rule about
    one spelling.
    """
    sub(MARKET, ".punverified {",
        ".r8plant-oklch { color: oklch(0.87 0.01 250); }\n.punverified {")


def mut_space_rgb():
    """`rgb(216 216 218)`, CSS Color 4 syntax for a colour no token defines."""
    sub(MARKET, ".punverified {",
        ".r8plant-modern { color: rgb(216 216 218); }\n.punverified {")


def mut_inline_custom_property():
    """`style="--id-hue: #D8D8D8"` on a card.

    This is not a hypothetical position. `market.css` paints the identity
    band, the avatar ring and the card rim from `var(--id-hue)`, and ten
    screens set that property in a style attribute. Setting it to a literal
    is the identity colour introduced on a screen, one level of indirection
    away from a fill.
    """
    sub(CONDUCT, "</main>",
        '<div class="idc r8plant" style="--id-hue: #D8D8D8">r8plant</div>\n</main>')


def mut_page_local_style():
    """A hex inside the screen's own `<style>` block.

    Every one of the 33 screens has one, and they are where a page-local
    component gets defined. Round 7 classified the contents of a `<style>`
    element as an HTML TEXT NODE, so this was the largest unread surface in
    the tree: not a stylesheet the gate globs, and not paint.
    """
    sub(CONDUCT, "</style>", "  .r8plant-local { color: #D8D8D8; }\n</style>")


def mut_undeclared_script():
    """A hex in `polish.js`, which paints a real element on every screen.

    2.1's position table declares three files as the generative renderer's
    colour space. Round 7's gate exempted EVERY script instead, so the
    document said three and the instrument meant seven. `polish.js` runs on
    all 33 screens and owns the dialogs, the toasts and the scroll spy.
    """
    sub(POLISH_JS, "(function () {",
        '(function () {\n  var R8PLANT = "#D8D8D8";\n'
        '  document.addEventListener("DOMContentLoaded", function () {\n'
        '    var h = document.querySelector("h1");\n'
        '    if (h) { h.style.color = R8PLANT; }\n  });')


def mut_long_mask():
    """The stencil exemption, given a value longer than round 7's window.

    Identical in kind to the three masks the tree already ships. Round 7 read
    back 120 characters for the property name, found gradient stops, and
    called it paint. The plant is legal CSS and the gate must not fire on the
    mask: what it must do is read the property rather than the distance.
    """
    sub(MARKET, ".wrap-wide {",
        ".r8plant-longmask { -webkit-mask-image: linear-gradient(to bottom, "
        "rgba(0,0,0,1) 0%, rgba(0,0,0,1) 20%, rgba(0,0,0,0.9) 35%, "
        "rgba(0,0,0,0.75) 50%, rgba(0,0,0,0.6) 62%, rgba(0,0,0,0.4) 74%, "
        "rgba(0,0,0,0.25) 86%, #000 100%); }\n.wrap-wide {")


def mut_renderer_undeclared():
    """DESIGN.md stops declaring `swarm.js` a renderer while it still is one.

    The exemption for the generative colour space is read FROM the document,
    so the document and the instrument cannot mean different sets. This is
    that read, proved in the direction nobody plants: delete the declaration
    and eighteen legal literals become failures, which is what tells you the
    exemption is live rather than hardcoded.
    """
    sub(DOC, "| a literal in `swarm.js`, `agents.js` or `perch.js` |",
        "| a literal in `agents.js` or `perch.js` |")


# ======================================================================
# THE CONTROLS THAT MUST NOT FIRE.
#
# Widening a colour vocabulary is the change that starts condemning correct
# code. Each of these is colour-shaped and legal, and three of them are
# patterns the tree already ships dozens of times.
# ======================================================================

def mut_white_space():
    """`white-space: nowrap`, which contains the colour `white` and is not one.

    The tree ships nine of these. A sweep that reads property names as values
    fails every one, and the first person to see that output stops reading
    this gate.
    """
    sub(MARKET, ".wrap-wide {",
        ".r8plant-nowrap { white-space: nowrap; overflow: hidden; }\n.wrap-wide {")


def mut_colour_word_in_prose():
    """A paragraph using the word `red`, on a screen that already does this.

    `staged.html` and `myjobs.html` both write "no red" in running text,
    explaining that a late job is not painted as a failure. A colour name in a
    sentence is a word.
    """
    sub(CONDUCT, "</main>",
        '<p class="r8plant">Nothing here is painted red, because a refusal '
        'is not a fault.</p>\n</main>')


def mut_fragment_href():
    """`href="#4471"`, which is a pull request number in an anchor.

    Five screens link to `vercel/commerce#4471`. An attribute that is not a
    paint attribute is not paint, whatever its value looks like.
    """
    sub(CONDUCT, "</main>",
        '<p class="r8plant"><a href="#4471">r8plant link</a></p>\n</main>')


def mut_url_asset():
    """`url(white.png)`, a file name that is a colour name.

    A value can contain a string and a url, and neither is a colour. The
    classifier strips both before it reads a value.
    """
    sub(MARKET, ".wrap-wide {",
        ".r8plant-url { background-image: url(white.png); }\n.wrap-wide {")


def mut_alpha_surface():
    """Section 2.6's recipe: a surface is an alpha over what sits beneath it."""
    sub(MARKET, ".wrap-wide {",
        ".r8plant-alpha { background: rgba(255,255,255,0.06); }\n.wrap-wide {")


def mut_renderer_hue():
    """A thirteenth arcade hue in a declared renderer. 2.4's subject, not 2.1's."""
    sub(SWARM, '{ id: "rose",    deg: 338, base: "#FF3D82" }',
        '{ id: "rose",    deg: 338, base: "#FF3D82" },\n'
        '    { id: "coral",   deg: 350, base: "#FF6B4A" }')


def mut_currentcolor():
    """`fill="currentColor"`, which introduces no colour at all.

    The icon sprite uses it throughout: the glyph takes the ink of whatever
    text it sits in, which is the opposite of introducing a colour.
    """
    sub(CONDUCT, "</main>",
        '<svg width="8" height="8" class="r8plant" aria-hidden="true">'
        '<circle cx="4" cy="4" r="4" fill="currentColor"/></svg>\n</main>')


# Every marker this suite writes to disk, for the stray check after the
# revert. Each is prefixed `r8plant` and appears nowhere in the tree, so the
# check cannot fire on a paragraph describing a previous round's plant.
R8_MARKERS = ("r8plant", "R8PLANT")


MUTATIONS = [
    ("A  a named keyword in a fill", mut_named_keyword,
     "conduct.html", "red"),
    ("B  an 8 digit hex in a style attribute", mut_hex8,
     "conduct.html", "#D8D8D8FF"),
    ("C  a 4 digit hex in a fill", mut_hex4,
     "conduct.html", "#D8DF"),
    ("D  oklch() in a stylesheet", mut_oklch,
     "market.css", "oklch("),
    ("E  space separated rgb()", mut_space_rgb,
     "market.css", "rgb(216 216 218)"),
    ("F  a hex in an inline custom property", mut_inline_custom_property,
     "conduct.html", "#D8D8D8"),
    ("G  a hex in a page-local <style> block", mut_page_local_style,
     "conduct.html", "#D8D8D8"),
    ("H  a hex in a script the document never declared", mut_undeclared_script,
     "polish.js", "#D8D8D8"),
    ("I  a renderer the document stops declaring", mut_renderer_undeclared,
     "swarm.js", "#FF2D2D"),
]

NEGATIVES = [
    ("N1 white-space: nowrap", mut_white_space,
     "a property name that contains a colour name"),
    ("N2 the word red in a sentence", mut_colour_word_in_prose,
     "a colour name in running text is a word"),
    ("N3 href=\"#4471\", a pull request number", mut_fragment_href,
     "an attribute that is not a paint attribute"),
    ("N4 url(white.png)", mut_url_asset,
     "a file name inside a url(), stripped before the value is read"),
    ("N5 an alpha over the surface beneath it", mut_alpha_surface,
     "section 2.6's recipe, not a palette entry"),
    ("N6 a thirteenth hue in a declared renderer", mut_renderer_hue,
     "section 2.4's colour space, not 2.1's palette"),
    ("N7 fill=\"currentColor\"", mut_currentcolor,
     "takes the ink of the text around it. It introduces nothing"),
    ("N8 a mask value longer than round 7's window", mut_long_mask,
     "a stencil is a stencil at any length. Round 7 called this one paint"),
]


def main():
    before = digest(FILES)
    saved = dict((p, read(p)) for p in FILES)

    mutationsafe.guard(FILES)
    mutationsafe.acquire(FILES)

    print("=" * 78)
    print("verify_round8_mutation.py   tree %s" % before)
    print("=" * 78)
    print("Each control types a colour onto a screen in a shape round 7's gate")
    print("could not read, and asserts verify_designmd FAILS naming the file and")
    print("the value. Exit 1 alone proves nothing: an unrelated check could be")
    print("failing, which is how a mutation passes for a cause it was not")
    print("written for.")
    print()
    print("The NEGATIVE controls plant something colour-shaped and LEGAL and")
    print("assert exit 0. Widening a colour vocabulary is exactly the change")
    print("that starts condemning correct code.")
    print()

    caught, missed, wrong_reason = 0, [], []
    clean, false_alarm = 0, []
    try:
        for name, mutate, where, expect in MUTATIONS:
            mutate()
            code, out = run_gate()
            # ONE LINE HAS TO CARRY BOTH the file and the value. Asking whether
            # each appears anywhere in the output passes when two unrelated
            # checks happen to print one each, which is how round 7's first
            # draft produced a line about base.css as its evidence for a swatch
            # planted in conduct.html.
            hit = [l.strip() for l in out.splitlines()
                   if where in l and expect in l]
            if code != 0 and hit:
                caught += 1
                print("  CAUGHT %-48s exit %d" % (name, code))
                print("         %s" % hit[0][:94])
            elif code != 0 and where in out:
                wrong_reason.append((name, "failed naming %s but no single "
                                     "line carried %r" % (where, expect)))
                print("  WRONG REASON %-42s exit %d" % (name, code))
            elif code != 0:
                wrong_reason.append((name, "failed but never named %s" % where))
                print("  WRONG REASON %-42s exit %d" % (name, code))
            else:
                missed.append(name)
                print("  MISSED %-48s exit %d" % (name, code))
            for p, s in saved.items():
                write(p, s)

        print()
        for name, mutate, why in NEGATIVES:
            mutate()
            code, out = run_gate()
            if code == 0:
                clean += 1
                print("  QUIET  %-48s exit 0" % name)
                print("         %s" % why)
            else:
                bad = [l.strip() for l in out.splitlines()
                       if "paints" in l or "introduces" in l or "no token" in l]
                false_alarm.append((name, bad[0][:90] if bad else "exit 1"))
                print("  FALSE ALARM %-43s exit %d" % (name, code))
                print("         %s" % (bad[0][:88] if bad else ""))
            for p, s in saved.items():
                write(p, s)
    finally:
        for p, s in saved.items():
            write(p, s)
        mutationsafe.release()

    after = digest(FILES)
    print()
    print("-" * 78)
    print("tree after revert: %s  %s"
          % (after, "IDENTICAL" if after == before else "DIFFERENT"))

    # A planted ELEMENT can survive a botched revert in a way a digest taken
    # after the same botched revert cannot see, so the markers are grepped for
    # by name as well.
    #
    # EVERY MARKER HERE IS UNIQUE TO THIS SUITE, which is not a detail. The
    # first draft grepped for the word "planted" and reported a stray in
    # DESIGN.md, where two paragraphs describe the swatch review planted in
    # round 6. A stray detector that fires on the documentation of a previous
    # round is the same defect as a gate that cries wolf: the next reader
    # learns to skim its output, and the run that really does leave damage on
    # disk says the same thing this one did.
    strays = []
    for marker in R8_MARKERS:
        for p in FILES:
            if marker in read(p):
                strays.append("%s in %s" % (marker, os.path.basename(p)))
    if strays:
        print("STRAY MUTATION MARKERS LEFT ON DISK:")
        for s in strays:
            print("   " + s)

    print("\nre-running verify_designmd on the reverted tree:")
    code, out = run_gate()
    checked = [l.strip() for l in out.splitlines()
               if l.startswith(("colour literals", "every shipped token",
                                "ratio claims", "declared renderers"))]
    print("  verify_designmd.py       exit %d  %s"
          % (code, "PASS" if code == 0 else "FAIL"))
    for c in checked:
        print("    %s" % c)

    ok = (not missed and not wrong_reason and not false_alarm and not strays
          and after == before and code == 0)
    print()
    if ok:
        print("MUTATION TEST PASSED: %d of %d defects caught naming the file and"
              % (caught, len(MUTATIONS)))
        print("the value, %d of %d legal colours left alone, tree reverted"
              % (clean, len(NEGATIVES)))
        print("clean, the gate green after.")
        return 0
    for n in missed:
        print("  MISSED: %s" % n)
    for n, why in wrong_reason:
        print("  WRONG REASON: %s: %s" % (n, why))
    for n, why in false_alarm:
        print("  FALSE ALARM: %s: %s" % (n, why))
    if after != before:
        print("  TREE NOT RESTORED")
    print("\nMUTATION TEST FAILED")
    return 1


if __name__ == "__main__":
    sys.exit(main())
